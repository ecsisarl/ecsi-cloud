import {
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  DISABLEABLE_VOUCHER_STATES,
  type GenerateVoucherBatchRequest,
  type ListVoucherBatchesQuery,
  type ListVouchersQuery,
  maskVoucherCode,
  type Permission,
  type Voucher,
  type VoucherBatch,
  type VoucherBatchPrint,
  type VoucherDetail,
  VOUCHER_STATES,
  type VoucherStateCounts,
} from '@ecsi/shared';
import { and, asc, count, desc, eq, inArray, isNull, type SQL, sql } from 'drizzle-orm';
import { AuditService } from '../audit/audit.service.js';
import {
  companies,
  plans,
  sites,
  users,
  voucherBatches,
  voucherEvents,
  vouchers,
} from '../database/schema/index.js';
import type { Grants } from '../tenancy/access.service.js';
import {
  type TenantContext,
  TenantDatabase,
  type TenantTransaction,
} from '../tenancy/tenant-database.js';
import { PlansService, planView } from './plans.service.js';
import { randomCode, uniqueCodes } from './voucher-codes.js';

const BATCH_NOT_FOUND = 'Lot de tickets introuvable';
const VOUCHER_NOT_FOUND = 'Ticket introuvable';
const SITE_NOT_FOUND = 'Site introuvable';
/** Insertion par paquets : 1 000 tickets restent bien en deçà de la limite de paramètres. */
const INSERT_CHUNK = 250;

type BatchRow = typeof voucherBatches.$inferSelect;

const emptyCounts = (): VoucherStateCounts =>
  Object.fromEntries(VOUCHER_STATES.map((state) => [state, 0])) as VoucherStateCounts;

/**
 * Tickets WiFi (Sprint 6) : génération par lots, consultation, impression, désactivation.
 *
 * Portée par site : un lot appartient au site d'émission ; lire, générer, imprimer ou
 * désactiver exige la permission correspondante sur CE site. Hors portée : 404, comme un
 * lot inexistant ou d'une autre entreprise (que la RLS masque de toute façon).
 *
 * Les codes en clair ne sortent que par l'impression (vouchers.export, auditée) ; les
 * listes renvoient des codes masqués.
 *
 * Non couvert ici (sprints suivants) : application des limites par le RADIUS central et
 * passage à ACTIVE/EXPIRED (S5), attribution aux vendeurs et ventes (S8), portées GROUPE
 * et GLOBAL (S11).
 */
@Injectable()
export class VouchersService {
  constructor(
    private readonly tenantDb: TenantDatabase,
    private readonly audit: AuditService,
    private readonly plans: PlansService,
  ) {}

  // --- Lots -----------------------------------------------------------------

  listBatches(
    ctx: TenantContext,
    grants: Grants,
    query: ListVoucherBatchesQuery = {},
  ): Promise<VoucherBatch[]> {
    const scope = grants.sitesFor('vouchers.read');
    if (scope !== 'ALL' && scope.length === 0) return Promise.resolve([]);
    return this.tenantDb.run(ctx, async (tx) => {
      const filters: (SQL | undefined)[] = [
        eq(voucherBatches.companyId, ctx.companyId),
        scope === 'ALL' ? undefined : inArray(voucherBatches.siteId, scope),
        query.siteId ? eq(voucherBatches.siteId, query.siteId) : undefined,
        query.planId ? eq(voucherBatches.planId, query.planId) : undefined,
      ];
      const rows = await tx
        .select()
        .from(voucherBatches)
        .where(and(...filters))
        .orderBy(desc(voucherBatches.number))
        .limit(500);
      return this.batchViews(tx, rows);
    });
  }

  getBatch(ctx: TenantContext, grants: Grants, batchId: string): Promise<VoucherBatch> {
    return this.tenantDb.run(ctx, async (tx) => {
      const row = await this.batchInScope(tx, ctx, grants, batchId, 'vouchers.read');
      const [view] = await this.batchViews(tx, [row]);
      if (!view) throw new NotFoundException(BATCH_NOT_FOUND);
      return view;
    });
  }

  /**
   * Génération d'un lot (Mikhmon : « Generate »). Codes tirés par un générateur
   * cryptographique, uniques dans l'entreprise (contrainte en base, nouveau tirage en cas
   * de collision), insérés dans UNE transaction avec leur historique et l'audit.
   */
  generate(
    ctx: TenantContext,
    grants: Grants,
    input: GenerateVoucherBatchRequest,
  ): Promise<VoucherBatch> {
    return this.tenantDb.run(ctx, async (tx) => {
      await this.siteInScope(tx, ctx, grants, input.siteId, 'vouchers.generate');
      const plan = await this.plans.row(tx, ctx, input.planId);
      if (plan.status !== 'ACTIVE') {
        throw new UnprocessableEntityException('Ce forfait est désactivé');
      }
      if (input.expiresAt && new Date(input.expiresAt).getTime() <= Date.now()) {
        throw new UnprocessableEntityException('La date limite de vente doit être future');
      }

      // Numéro de lot séquentiel : verrou transactionnel par entreprise.
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${`voucher_batches:${ctx.companyId}`}))`,
      );
      const [last] = await tx
        .select({ max: sql<number | null>`max(${voucherBatches.number})` })
        .from(voucherBatches)
        .where(eq(voucherBatches.companyId, ctx.companyId));
      const number = (last?.max ?? 0) + 1;

      const [batch] = await tx
        .insert(voucherBatches)
        .values({
          companyId: ctx.companyId,
          number,
          planId: plan.id,
          siteId: input.siteId,
          label: input.label ?? null,
          quantity: input.quantity,
          authMode: input.authMode,
          charset: input.charset,
          codeLength: input.length,
          prefix: input.prefix,
          scopeType: 'LOCAL',
          unitPrice: plan.priceAmount,
          currency: plan.currency,
          expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
          createdBy: ctx.userId,
        })
        .returning();
      if (!batch) throw new Error('Création du lot impossible');

      const format = { charset: input.charset, length: input.length, prefix: input.prefix };
      const inserted: { id: string }[] = [];
      let serial = 0;
      let missing = input.quantity;
      // Les collisions avec les codes existants sont absorbées par ON CONFLICT DO NOTHING
      // puis retirées : quelques tours suffisent avec 24 bits d'entropie au moins.
      const taken = new Set<string>();
      for (let round = 0; missing > 0; round += 1) {
        if (round >= 8) {
          throw new UnprocessableEntityException(
            'Trop de codes déjà utilisés avec ce format : allongez le code ou changez de préfixe',
          );
        }
        const codes = uniqueCodes(format, missing, taken);
        for (const code of codes) taken.add(code);
        for (let i = 0; i < codes.length; i += INSERT_CHUNK) {
          const values = codes.slice(i, i + INSERT_CHUNK).map((code) => {
            serial += 1;
            return {
              companyId: ctx.companyId,
              batchId: batch.id,
              planId: plan.id,
              siteId: input.siteId,
              serial,
              code,
              password:
                input.authMode === 'USER_PASS' ? randomCode({ ...format, prefix: '' }) : null,
              expiresAt: batch.expiresAt,
            };
          });
          const rows = await tx
            .insert(vouchers)
            .values(values)
            .onConflictDoNothing({ target: [vouchers.companyId, vouchers.code] })
            .returning({ id: vouchers.id });
          inserted.push(...rows);
        }
        missing = input.quantity - inserted.length;
      }
      // Numéros de série contigus 1..n malgré d'éventuelles collisions écartées.
      if (serial !== input.quantity) {
        await tx.execute(sql`
          update vouchers v set serial = r.n
          from (select id, row_number() over (order by serial) as n
                from vouchers where batch_id = ${batch.id}) r
          where v.id = r.id and v.serial <> r.n`);
      }

      for (let i = 0; i < inserted.length; i += INSERT_CHUNK) {
        await tx.insert(voucherEvents).values(
          inserted.slice(i, i + INSERT_CHUNK).map((row) => ({
            companyId: ctx.companyId,
            voucherId: row.id,
            fromState: null,
            toState: 'AVAILABLE' as const,
            actorUserId: ctx.userId,
            reason: `Génération du lot n° ${String(number)}`,
          })),
        );
      }

      await this.audit.write(tx, ctx.companyId, {
        action: 'vouchers.generate',
        resourceType: 'voucher_batch',
        resourceId: batch.id,
        siteId: input.siteId,
        details: {
          number,
          plan: plan.name,
          quantity: input.quantity,
          authMode: input.authMode,
          charset: input.charset,
          length: input.length,
          prefix: input.prefix,
          unitPrice: plan.priceAmount,
          currency: plan.currency,
        },
      });
      const [view] = await this.batchViews(tx, [batch]);
      if (!view) throw new Error('Lot introuvable après création');
      return view;
    });
  }

  /**
   * Impression d'un lot (Mikhmon : « Print »). SEULE réponse contenant les codes en clair :
   * permission vouchers.export sur le site du lot, audit systématique. Les tickets
   * désactivés ou expirés ne sont pas imprimés.
   */
  printBatch(ctx: TenantContext, grants: Grants, batchId: string): Promise<VoucherBatchPrint> {
    return this.tenantDb.run(ctx, async (tx) => {
      const row = await this.batchInScope(tx, ctx, grants, batchId, 'vouchers.export');
      const [batch] = await this.batchViews(tx, [row]);
      if (!batch) throw new NotFoundException(BATCH_NOT_FOUND);
      const [planRow] = await tx.select().from(plans).where(eq(plans.id, row.planId));
      const [company] = await tx
        .select({ name: companies.name, phone: companies.phone, whatsapp: companies.whatsapp })
        .from(companies)
        .where(eq(companies.id, ctx.companyId));
      if (!planRow || !company) throw new NotFoundException(BATCH_NOT_FOUND);
      const list = await tx
        .select({
          serial: vouchers.serial,
          username: vouchers.code,
          password: vouchers.password,
          state: vouchers.state,
        })
        .from(vouchers)
        .where(
          and(
            eq(vouchers.batchId, batchId),
            inArray(vouchers.state, ['AVAILABLE', 'ASSIGNED', 'SOLD']),
          ),
        )
        .orderBy(asc(vouchers.serial));
      await this.audit.write(tx, ctx.companyId, {
        action: 'vouchers.export',
        resourceType: 'voucher_batch',
        resourceId: batchId,
        siteId: row.siteId,
        details: { number: row.number, printed: list.length },
      });
      return { batch, plan: planView(planRow), company, vouchers: list };
    });
  }

  /** Désactivation de tous les tickets encore utilisables d'un lot (perte, vol, erreur). */
  disableBatch(
    ctx: TenantContext,
    grants: Grants,
    batchId: string,
    reason: string,
  ): Promise<VoucherBatch> {
    return this.tenantDb.run(ctx, async (tx) => {
      const row = await this.batchInScope(tx, ctx, grants, batchId, 'vouchers.disable');
      const disabled = await this.disableWhere(
        tx,
        ctx,
        and(eq(vouchers.batchId, batchId), inArray(vouchers.state, DISABLEABLE_VOUCHER_STATES)),
        reason,
      );
      await this.audit.write(tx, ctx.companyId, {
        action: 'vouchers.disable_batch',
        resourceType: 'voucher_batch',
        resourceId: batchId,
        siteId: row.siteId,
        details: { number: row.number, disabled, reason },
      });
      const [view] = await this.batchViews(tx, [row]);
      if (!view) throw new NotFoundException(BATCH_NOT_FOUND);
      return view;
    });
  }

  // --- Tickets --------------------------------------------------------------

  listVouchers(ctx: TenantContext, grants: Grants, query: ListVouchersQuery): Promise<Voucher[]> {
    const scope = grants.sitesFor('vouchers.read');
    if (scope !== 'ALL' && scope.length === 0) return Promise.resolve([]);
    return this.tenantDb.run(ctx, async (tx) => {
      const rows = await this.voucherRows(
        tx,
        and(
          eq(vouchers.companyId, ctx.companyId),
          scope === 'ALL' ? undefined : inArray(vouchers.siteId, scope),
          query.batchId ? eq(vouchers.batchId, query.batchId) : undefined,
          query.state ? eq(vouchers.state, query.state) : undefined,
          query.code ? eq(vouchers.code, query.code) : undefined,
        ),
        query.limit,
      );
      return rows.map(voucherView);
    });
  }

  getVoucher(ctx: TenantContext, grants: Grants, voucherId: string): Promise<VoucherDetail> {
    return this.tenantDb.run(ctx, async (tx) => {
      const row = await this.voucherInScope(tx, ctx, grants, voucherId, 'vouchers.read');
      const events = await tx
        .select({
          fromState: voucherEvents.fromState,
          toState: voucherEvents.toState,
          actor: users.fullName,
          actorType: voucherEvents.actorType,
          reason: voucherEvents.reason,
          occurredAt: voucherEvents.occurredAt,
        })
        .from(voucherEvents)
        .leftJoin(users, eq(users.id, voucherEvents.actorUserId))
        .where(eq(voucherEvents.voucherId, voucherId))
        .orderBy(asc(voucherEvents.occurredAt), asc(voucherEvents.id));
      return {
        ...voucherView(row),
        events: events.map((event) => ({
          fromState: event.fromState,
          toState: event.toState,
          actor: event.actor ?? (event.actorType === 'USER' ? null : event.actorType),
          reason: event.reason,
          occurredAt: event.occurredAt.toISOString(),
        })),
      };
    });
  }

  disableVoucher(
    ctx: TenantContext,
    grants: Grants,
    voucherId: string,
    reason: string,
  ): Promise<VoucherDetail> {
    return this.tenantDb
      .run(ctx, async (tx) => {
        const { voucher: row } = await this.voucherInScope(
          tx,
          ctx,
          grants,
          voucherId,
          'vouchers.disable',
        );
        if (!DISABLEABLE_VOUCHER_STATES.includes(row.state)) {
          throw new UnprocessableEntityException('Ce ticket ne peut plus être désactivé');
        }
        await this.disableWhere(tx, ctx, eq(vouchers.id, voucherId), reason);
        await this.audit.write(tx, ctx.companyId, {
          action: 'vouchers.disable',
          resourceType: 'voucher',
          resourceId: voucherId,
          siteId: row.siteId,
          details: { serial: row.serial, from: row.state, reason },
        });
        return row;
      })
      .then(() => this.getVoucher(ctx, grants, voucherId));
  }

  // --- Interne --------------------------------------------------------------

  private async disableWhere(
    tx: TenantTransaction,
    ctx: TenantContext,
    where: SQL | undefined,
    reason: string,
  ): Promise<number> {
    const before = await tx
      .select({ id: vouchers.id, state: vouchers.state })
      .from(vouchers)
      .where(and(eq(vouchers.companyId, ctx.companyId), where))
      .for('update');
    if (before.length === 0) return 0;
    const now = new Date();
    await tx
      .update(vouchers)
      .set({ state: 'DISABLED', disabledAt: now, disabledBy: ctx.userId, disabledReason: reason })
      .where(
        inArray(
          vouchers.id,
          before.map((v) => v.id),
        ),
      );
    for (let i = 0; i < before.length; i += INSERT_CHUNK) {
      await tx.insert(voucherEvents).values(
        before.slice(i, i + INSERT_CHUNK).map((v) => ({
          companyId: ctx.companyId,
          voucherId: v.id,
          fromState: v.state,
          toState: 'DISABLED' as const,
          actorUserId: ctx.userId,
          reason,
          occurredAt: now,
        })),
      );
    }
    return before.length;
  }

  private voucherRows(tx: TenantTransaction, where: SQL | undefined, limit = 1) {
    return tx
      .select({
        voucher: vouchers,
        prefixLength: sql<number>`length(${voucherBatches.prefix})`,
        planName: plans.name,
        siteName: sites.name,
      })
      .from(vouchers)
      .innerJoin(voucherBatches, eq(voucherBatches.id, vouchers.batchId))
      .innerJoin(plans, eq(plans.id, vouchers.planId))
      .innerJoin(sites, eq(sites.id, vouchers.siteId))
      .where(where)
      .orderBy(desc(voucherBatches.number), asc(vouchers.serial))
      .limit(limit);
  }

  private async voucherInScope(
    tx: TenantTransaction,
    ctx: TenantContext,
    grants: Grants,
    voucherId: string,
    permission: Permission,
  ) {
    const [row] = await this.voucherRows(
      tx,
      and(eq(vouchers.id, voucherId), eq(vouchers.companyId, ctx.companyId)),
    );
    if (!row || !grants.hasForSite('vouchers.read', row.voucher.siteId)) {
      throw new NotFoundException(VOUCHER_NOT_FOUND);
    }
    forbidUnless(grants, permission, row.voucher.siteId);
    return row;
  }

  private async batchInScope(
    tx: TenantTransaction,
    ctx: TenantContext,
    grants: Grants,
    batchId: string,
    permission: Permission,
  ): Promise<BatchRow> {
    const [row] = await tx
      .select()
      .from(voucherBatches)
      .where(and(eq(voucherBatches.id, batchId), eq(voucherBatches.companyId, ctx.companyId)));
    if (!row || !grants.hasForSite('vouchers.read', row.siteId)) {
      throw new NotFoundException(BATCH_NOT_FOUND);
    }
    forbidUnless(grants, permission, row.siteId);
    return row;
  }

  private async siteInScope(
    tx: TenantTransaction,
    ctx: TenantContext,
    grants: Grants,
    siteId: string,
    permission: Permission,
  ) {
    const [row] = await tx
      .select({ id: sites.id, status: sites.status })
      .from(sites)
      .where(
        and(eq(sites.id, siteId), eq(sites.companyId, ctx.companyId), isNull(sites.deletedAt)),
      );
    if (!row || !grants.hasForSite('sites.read', siteId)) {
      throw new NotFoundException(SITE_NOT_FOUND);
    }
    forbidUnless(grants, permission, siteId);
    if (row.status === 'INACTIVE') {
      throw new UnprocessableEntityException('Ce site est inactif');
    }
    return row;
  }

  private async batchViews(tx: TenantTransaction, rows: BatchRow[]): Promise<VoucherBatch[]> {
    if (rows.length === 0) return [];
    const ids = rows.map((row) => row.id);
    const creatorIds = [...new Set(rows.flatMap((row) => (row.createdBy ? [row.createdBy] : [])))];
    const planRows = await tx
      .select({ id: plans.id, name: plans.name })
      .from(plans)
      .where(inArray(plans.id, [...new Set(rows.map((row) => row.planId))]));
    const siteRows = await tx
      .select({ id: sites.id, name: sites.name, code: sites.code })
      .from(sites)
      .where(inArray(sites.id, [...new Set(rows.map((row) => row.siteId))]));
    const userRows = creatorIds.length
      ? await tx
          .select({ id: users.id, name: users.fullName })
          .from(users)
          .where(inArray(users.id, creatorIds))
      : [];
    const countRows = await tx
      .select({ batchId: vouchers.batchId, state: vouchers.state, n: count() })
      .from(vouchers)
      .where(inArray(vouchers.batchId, ids))
      .groupBy(vouchers.batchId, vouchers.state);
    const planById = new Map(planRows.map((p) => [p.id, p]));
    const siteById = new Map(siteRows.map((s) => [s.id, s]));
    const userById = new Map(userRows.map((u) => [u.id, u.name]));
    const counts = new Map<string, VoucherStateCounts>();
    for (const row of countRows) {
      const entry = counts.get(row.batchId) ?? emptyCounts();
      entry[row.state] = row.n;
      counts.set(row.batchId, entry);
    }
    return rows.map((row) => ({
      id: row.id,
      number: row.number,
      label: row.label,
      plan: planById.get(row.planId) ?? { id: row.planId, name: '—' },
      site: siteById.get(row.siteId) ?? { id: row.siteId, name: '—', code: '—' },
      quantity: row.quantity,
      authMode: row.authMode,
      charset: row.charset,
      length: row.codeLength,
      prefix: row.prefix,
      scope: row.scopeType,
      unitPrice: row.unitPrice,
      currency: row.currency,
      expiresAt: row.expiresAt?.toISOString() ?? null,
      createdBy: row.createdBy ? (userById.get(row.createdBy) ?? null) : null,
      createdAt: row.createdAt.toISOString(),
      counts: counts.get(row.id) ?? emptyCounts(),
    }));
  }
}

function forbidUnless(grants: Grants, permission: Permission, siteId: string) {
  // Ressource visible mais action non autorisée sur ce site : 403 (existence déjà connue).
  if (!grants.hasForSite(permission, siteId)) {
    throw new ForbiddenException(
      "Vous n'avez pas la permission d'effectuer cette action sur ce site",
    );
  }
}

function voucherView(row: {
  voucher: typeof vouchers.$inferSelect;
  prefixLength: number;
  planName: string;
  siteName: string;
}): Voucher {
  const v = row.voucher;
  return {
    id: v.id,
    batchId: v.batchId,
    serial: v.serial,
    maskedCode: maskVoucherCode(v.code, row.prefixLength),
    state: v.state,
    plan: { id: v.planId, name: row.planName },
    site: { id: v.siteId, name: row.siteName },
    soldAt: v.soldAt?.toISOString() ?? null,
    activatedAt: v.activatedAt?.toISOString() ?? null,
    expiresAt: v.expiresAt?.toISOString() ?? null,
    disabledAt: v.disabledAt?.toISOString() ?? null,
    disabledReason: v.disabledReason,
    createdAt: v.createdAt.toISOString(),
  };
}
