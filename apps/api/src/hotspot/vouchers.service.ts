import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  type CreateVoucherBatchRequest,
  type DisableVoucherRequest,
  type ListVoucherBatchesQuery,
  type ListVouchersQuery,
  type Page,
  type Permission,
  type PrintableVoucher,
  type Voucher,
  type VoucherBatch,
  type VoucherDetail,
  type VoucherPrintSheet,
  voucherRemaining,
  VOUCHER_STATES,
  type VoucherState,
} from '@ecsi/shared';
import { and, asc, desc, eq, inArray, isNull, type SQL, sql } from 'drizzle-orm';
import { AuditService } from '../audit/audit.service.js';
import {
  companies,
  plans,
  radiusPostauth,
  routers,
  sites,
  users,
  voucherBatches,
  vouchers,
} from '../database/schema/index.js';
import type { Grants } from '../tenancy/access.service.js';
import {
  type TenantContext,
  TenantDatabase,
  type TenantTransaction,
} from '../tenancy/tenant-database.js';
import { PlansService } from './plans.service.js';
import { RadiusSessionsService } from './sessions.service.js';
import { VoucherKeys } from './voucher-keys.js';

export const VOUCHER_NOT_FOUND = 'Ticket introuvable';
export const BATCH_NOT_FOUND = 'Lot de tickets introuvable';
const SITE_NOT_FOUND = 'Site introuvable';
/** Tirages d'identifiants en cas de collision d'empreinte (31^8 codes : pratiquement jamais). */
const MAX_ATTEMPTS = 5;

const iso = (value: Date | null) => (value ? value.toISOString() : null);

const voucherSelection = {
  id: vouchers.id,
  serial: vouchers.serial,
  batchId: vouchers.batchId,
  batchLabel: voucherBatches.label,
  planId: plans.id,
  planName: plans.name,
  siteId: sites.id,
  siteName: sites.name,
  siteCode: sites.code,
  state: vouchers.state,
  priceMinor: vouchers.priceMinor,
  currency: vouchers.currency,
  validitySeconds: vouchers.validitySeconds,
  sessionTimeSeconds: vouchers.sessionTimeSeconds,
  rateUpKbps: vouchers.rateUpKbps,
  rateDownKbps: vouchers.rateDownKbps,
  dataQuotaBytes: vouchers.dataQuotaBytes,
  maxDevices: vouchers.maxDevices,
  idleTimeoutSeconds: vouchers.idleTimeoutSeconds,
  usedSeconds: vouchers.usedSeconds,
  usedBytes: vouchers.usedBytes,
  activatedAt: vouchers.activatedAt,
  expiresAt: vouchers.expiresAt,
  lastUsedAt: vouchers.lastUsedAt,
  disabledAt: vouchers.disabledAt,
  disabledBy: vouchers.disabledBy,
  disabledReason: vouchers.disabledReason,
  codeKeyVersion: vouchers.codeKeyVersion,
  createdAt: vouchers.createdAt,
};

function voucherQuery(tx: TenantTransaction) {
  return tx
    .select(voucherSelection)
    .from(vouchers)
    .innerJoin(
      voucherBatches,
      and(
        eq(voucherBatches.companyId, vouchers.companyId),
        eq(voucherBatches.id, vouchers.batchId),
      ),
    )
    .innerJoin(plans, and(eq(plans.companyId, vouchers.companyId), eq(plans.id, vouchers.planId)))
    .innerJoin(sites, and(eq(sites.companyId, vouchers.companyId), eq(sites.id, vouchers.siteId)))
    .$dynamic();
}

type VoucherRow = Awaited<ReturnType<typeof voucherQuery>>[number];

function toVoucher(row: VoucherRow): Voucher {
  return {
    id: row.id,
    serial: row.serial,
    batchId: row.batchId,
    batchLabel: row.batchLabel,
    plan: { id: row.planId, name: row.planName },
    site: { id: row.siteId, name: row.siteName, code: row.siteCode },
    state: row.state,
    priceMinor: row.priceMinor,
    currency: row.currency,
    validitySeconds: row.validitySeconds,
    sessionTimeSeconds: row.sessionTimeSeconds,
    rateUpKbps: row.rateUpKbps,
    rateDownKbps: row.rateDownKbps,
    dataQuotaBytes: row.dataQuotaBytes,
    maxDevices: row.maxDevices,
    idleTimeoutSeconds: row.idleTimeoutSeconds,
    usedSeconds: row.usedSeconds,
    usedBytes: row.usedBytes,
    activatedAt: iso(row.activatedAt),
    expiresAt: iso(row.expiresAt),
    lastUsedAt: iso(row.lastUsedAt),
    disabledAt: iso(row.disabledAt),
    disabledReason: row.disabledReason,
    createdAt: row.createdAt.toISOString(),
  };
}

const batchSelection = {
  id: voucherBatches.id,
  quantity: voucherBatches.quantity,
  label: voucherBatches.label,
  createdAt: voucherBatches.createdAt,
  createdBy: voucherBatches.createdBy,
  createdByName: users.fullName,
  planId: plans.id,
  planName: plans.name,
  siteId: sites.id,
  siteName: sites.name,
  siteCode: sites.code,
};

function batchQuery(tx: TenantTransaction) {
  return tx
    .select(batchSelection)
    .from(voucherBatches)
    .innerJoin(
      plans,
      and(eq(plans.companyId, voucherBatches.companyId), eq(plans.id, voucherBatches.planId)),
    )
    .innerJoin(
      sites,
      and(eq(sites.companyId, voucherBatches.companyId), eq(sites.id, voucherBatches.siteId)),
    )
    .leftJoin(users, eq(users.id, voucherBatches.createdBy))
    .$dynamic();
}

type BatchRow = Awaited<ReturnType<typeof batchQuery>>[number];

const emptyStates = () =>
  Object.fromEntries(VOUCHER_STATES.map((state) => [state, 0])) as Record<VoucherState, number>;

/**
 * Lots et tickets (lot B), rôle ecsi_app sous RLS, portée par site : un utilisateur ne voit
 * et n'agit que sur les lots et tickets des sites où il détient la permission (Grants).
 *
 * AUCUN SECRET EN BASE : un ticket n'est stocké que par l'empreinte HMAC de son code
 * (code_lookup). Le code est dérivé de l'identifiant (VOUCHER_CODE_KEY) au seul moment de
 * l'impression (vouchers.export, auditée avec un simple nombre de tickets). Aucun code ne
 * figure dans une liste, un détail, une erreur, un journal ou un événement d'audit.
 */
@Injectable()
export class VouchersService {
  constructor(
    private readonly tenantDb: TenantDatabase,
    private readonly audit: AuditService,
    private readonly plans: PlansService,
    private readonly sessions: RadiusSessionsService,
    @Inject(VoucherKeys) private readonly keys: VoucherKeys,
  ) {}

  // --- Lots ------------------------------------------------------------------------

  /**
   * Génère un lot : un forfait actif, un site (vouchers.generate), 1 à 1 000 tickets. Les
   * limites et le prix du forfait sont COPIÉS dans chaque ticket (modifier le forfait ne
   * change pas les tickets vendus). Une seule transaction : lot, tickets et audit.
   */
  generate(
    ctx: TenantContext,
    grants: Grants,
    input: CreateVoucherBatchRequest,
  ): Promise<VoucherBatch> {
    if (!grants.hasForSite('vouchers.generate', input.siteId)) {
      return Promise.reject(new NotFoundException(SITE_NOT_FOUND));
    }
    this.keys.assertConfigured();
    return this.tenantDb.run(ctx, async (tx) => {
      const [site] = await tx
        .select({ id: sites.id })
        .from(sites)
        .where(
          and(
            eq(sites.id, input.siteId),
            eq(sites.companyId, ctx.companyId),
            isNull(sites.deletedAt),
          ),
        );
      if (!site) throw new NotFoundException(SITE_NOT_FOUND);
      const plan = await this.plans.byId(tx, ctx, input.planId);
      if (plan.status !== 'ACTIVE') {
        throw new ConflictException('Forfait désactivé : réactivez-le pour générer des tickets');
      }
      const [batch] = await tx
        .insert(voucherBatches)
        .values({
          companyId: ctx.companyId,
          planId: plan.id,
          siteId: site.id,
          quantity: input.quantity,
          label: input.label ?? null,
          createdBy: ctx.userId,
        })
        .returning({ id: voucherBatches.id });
      if (!batch) throw new Error('Lot non créé');

      const versions = this.keys.versions();
      let pending = Array.from({ length: input.quantity }, (_, index) => index + 1);
      for (let attempt = 0; attempt < MAX_ATTEMPTS && pending.length > 0; attempt += 1) {
        const ids = await newIds(tx, pending.length);
        const values = pending.map((serial, index) => {
          const id = ids[index] ?? '';
          // Seule l'empreinte est conservée : le code n'est jamais stocké.
          const { lookup } = this.keys.issue(id);
          return sql`(${id}::uuid, ${ctx.companyId}::uuid, ${batch.id}::uuid, ${plan.id}::uuid,
            ${site.id}::uuid, ${serial}, ${lookup}, ${versions.lookupKeyVersion},
            ${versions.codeKeyVersion}, ${plan.priceMinor}, ${plan.currency},
            ${plan.validitySeconds}::integer, ${plan.sessionTimeSeconds}::integer,
            ${plan.rateUpKbps}::integer, ${plan.rateDownKbps}::integer,
            ${plan.dataQuotaBytes}::bigint, ${plan.maxDevices}, ${plan.idleTimeoutSeconds})`;
        });
        // INSERT limité aux colonnes accordées à ecsi_app (migration 0008). Collision
        // d'empreinte dans l'entreprise (vouchers_company_lookup_key) : le ticket n'est pas
        // inséré et reçoit un nouvel identifiant (donc un nouveau code) au tour suivant.
        const inserted = await tx.execute<{ serial: number }>(sql`
          insert into vouchers (id, company_id, batch_id, plan_id, site_id, serial, code_lookup,
            lookup_key_version, code_key_version, price_minor, currency, validity_seconds,
            session_time_seconds, rate_up_kbps, rate_down_kbps, data_quota_bytes, max_devices,
            idle_timeout_seconds)
          values ${sql.join(values, sql`, `)}
          on conflict (company_id, code_lookup) do nothing
          returning serial`);
        const done = new Set(inserted.rows.map((row) => row.serial));
        pending = pending.filter((serial) => !done.has(serial));
      }
      if (pending.length > 0) throw new Error('Génération des tickets impossible (collisions)');

      await this.audit.write(tx, ctx.companyId, {
        action: 'vouchers.generate',
        resourceType: 'voucher_batch',
        resourceId: batch.id,
        siteId: site.id,
        // Jamais de code : un nombre et des identifiants.
        details: { batchId: batch.id, planId: plan.id, siteId: site.id, count: input.quantity },
      });
      return this.batchView(tx, ctx, batch.id);
    });
  }

  listBatches(
    ctx: TenantContext,
    grants: Grants,
    query: ListVoucherBatchesQuery,
  ): Promise<Page<VoucherBatch>> {
    const scope = grants.sitesFor('vouchers.read');
    const empty = { items: [], total: 0, limit: query.limit, offset: query.offset };
    if (scope !== 'ALL' && scope.length === 0) return Promise.resolve(empty);
    return this.tenantDb.run(ctx, async (tx) => {
      const filters: (SQL | undefined)[] = [
        eq(voucherBatches.companyId, ctx.companyId),
        scope === 'ALL' ? undefined : inArray(voucherBatches.siteId, scope),
        query.siteId ? eq(voucherBatches.siteId, query.siteId) : undefined,
        query.planId ? eq(voucherBatches.planId, query.planId) : undefined,
      ];
      const [count] = await tx
        .select({ total: sql<number>`count(*)::int` })
        .from(voucherBatches)
        .where(and(...filters));
      const rows = await batchQuery(tx)
        .where(and(...filters))
        .orderBy(desc(voucherBatches.createdAt), desc(voucherBatches.id))
        .limit(query.limit)
        .offset(query.offset);
      return {
        items: await this.withStates(tx, ctx, rows),
        total: count?.total ?? 0,
        limit: query.limit,
        offset: query.offset,
      };
    });
  }

  getBatch(ctx: TenantContext, grants: Grants, batchId: string): Promise<VoucherBatch> {
    return this.tenantDb.run(ctx, async (tx) => {
      await this.batchInScope(tx, ctx, grants, batchId, 'vouchers.read');
      return this.batchView(tx, ctx, batchId);
    });
  }

  /** Feuille d'impression d'un lot : SEULE réponse portant les codes (no-store, auditée). */
  printBatch(ctx: TenantContext, grants: Grants, batchId: string): Promise<VoucherPrintSheet> {
    this.keys.assertConfigured();
    return this.tenantDb.run(ctx, async (tx) => {
      const batch = await this.batchInScope(tx, ctx, grants, batchId, 'vouchers.export');
      const rows = await voucherQuery(tx)
        .where(and(eq(vouchers.companyId, ctx.companyId), eq(vouchers.batchId, batchId)))
        .orderBy(asc(vouchers.serial));
      return this.sheet(
        tx,
        ctx,
        rows,
        {
          id: batch.id,
          label: batch.label,
          quantity: batch.quantity,
          createdAt: batch.createdAt.toISOString(),
        },
        { type: 'voucher_batch', id: batch.id },
      );
    });
  }

  // --- Tickets -------------------------------------------------------------------------

  list(ctx: TenantContext, grants: Grants, query: ListVouchersQuery): Promise<Page<Voucher>> {
    const scope = grants.sitesFor('vouchers.read');
    const empty = { items: [], total: 0, limit: query.limit, offset: query.offset };
    if (scope !== 'ALL' && scope.length === 0) return Promise.resolve(empty);
    return this.tenantDb.run(ctx, async (tx) => {
      const filters: (SQL | undefined)[] = [
        eq(vouchers.companyId, ctx.companyId),
        scope === 'ALL' ? undefined : inArray(vouchers.siteId, scope),
        query.state ? eq(vouchers.state, query.state) : undefined,
        query.batchId ? eq(vouchers.batchId, query.batchId) : undefined,
        query.siteId ? eq(vouchers.siteId, query.siteId) : undefined,
        query.planId ? eq(vouchers.planId, query.planId) : undefined,
        query.serial ? eq(vouchers.serial, query.serial) : undefined,
      ];
      const [count] = await tx
        .select({ total: sql<number>`count(*)::int` })
        .from(vouchers)
        .where(and(...filters));
      const rows = await voucherQuery(tx)
        .where(and(...filters))
        .orderBy(desc(vouchers.createdAt), asc(vouchers.serial))
        .limit(query.limit)
        .offset(query.offset);
      return {
        items: rows.map(toVoucher),
        total: count?.total ?? 0,
        limit: query.limit,
        offset: query.offset,
      };
    });
  }

  get(ctx: TenantContext, grants: Grants, voucherId: string): Promise<VoucherDetail> {
    return this.tenantDb.run(ctx, async (tx) => {
      const row = await this.inScope(tx, ctx, grants, voucherId, 'vouchers.read');
      return this.detail(tx, ctx, row);
    });
  }

  /** Impression d'un seul ticket (réimpression) : mêmes règles que celle d'un lot. */
  printOne(ctx: TenantContext, grants: Grants, voucherId: string): Promise<VoucherPrintSheet> {
    this.keys.assertConfigured();
    return this.tenantDb.run(ctx, async (tx) => {
      const row = await this.inScope(tx, ctx, grants, voucherId, 'vouchers.export');
      const [batch] = await tx
        .select({
          id: voucherBatches.id,
          label: voucherBatches.label,
          quantity: voucherBatches.quantity,
          createdAt: voucherBatches.createdAt,
        })
        .from(voucherBatches)
        .where(
          and(eq(voucherBatches.companyId, ctx.companyId), eq(voucherBatches.id, row.batchId)),
        );
      return this.sheet(
        tx,
        ctx,
        [row],
        batch ? { ...batch, createdAt: batch.createdAt.toISOString() } : null,
        { type: 'voucher', id: row.id },
      );
    });
  }

  /**
   * Désactivation définitive (vouchers.disable, permission sensible) : RADIUS refuse ensuite
   * toute nouvelle connexion avec ce ticket. La politique RLS impose disabled_by = utilisateur.
   */
  disable(
    ctx: TenantContext,
    grants: Grants,
    voucherId: string,
    input: DisableVoucherRequest,
  ): Promise<VoucherDetail> {
    return this.tenantDb.run(ctx, async (tx) => {
      const before = await this.inScope(tx, ctx, grants, voucherId, 'vouchers.disable');
      if (before.state === 'DISABLED') throw new ConflictException('Ticket déjà désactivé');
      const reason = input.reason ?? null;
      const updated = await tx
        .update(vouchers)
        .set({
          state: 'DISABLED',
          disabledAt: new Date(),
          disabledBy: ctx.userId,
          disabledReason: reason,
        })
        .where(
          and(
            eq(vouchers.id, voucherId),
            eq(vouchers.companyId, ctx.companyId),
            sql`${vouchers.state} <> 'DISABLED'`,
          ),
        )
        .returning({ id: vouchers.id });
      if (updated.length === 0) throw new ConflictException('Ticket déjà désactivé');
      await this.audit.write(tx, ctx.companyId, {
        action: 'vouchers.disable',
        resourceType: 'voucher',
        resourceId: voucherId,
        siteId: before.siteId,
        details: {
          batchId: before.batchId,
          serial: before.serial,
          state: { before: before.state, after: 'DISABLED' },
          reason,
        },
      });
      const [row] = await voucherQuery(tx).where(
        and(eq(vouchers.companyId, ctx.companyId), eq(vouchers.id, voucherId)),
      );
      if (!row) throw new NotFoundException(VOUCHER_NOT_FOUND);
      return this.detail(tx, ctx, row);
    });
  }

  // ---------------------------------------------------------------------------------------

  private async inScope(
    tx: TenantTransaction,
    ctx: TenantContext,
    grants: Grants,
    voucherId: string,
    permission: Permission,
  ): Promise<VoucherRow> {
    const [row] = await voucherQuery(tx).where(
      and(eq(vouchers.companyId, ctx.companyId), eq(vouchers.id, voucherId)),
    );
    if (!row || !grants.hasForSite('vouchers.read', row.siteId)) {
      throw new NotFoundException(VOUCHER_NOT_FOUND);
    }
    if (!grants.hasForSite(permission, row.siteId)) {
      throw new ForbiddenException(
        "Vous n'avez pas la permission d'effectuer cette action sur ce ticket",
      );
    }
    return row;
  }

  private async batchInScope(
    tx: TenantTransaction,
    ctx: TenantContext,
    grants: Grants,
    batchId: string,
    permission: Permission,
  ): Promise<BatchRow> {
    const [row] = await batchQuery(tx).where(
      and(eq(voucherBatches.companyId, ctx.companyId), eq(voucherBatches.id, batchId)),
    );
    if (!row || !grants.hasForSite('vouchers.read', row.siteId)) {
      throw new NotFoundException(BATCH_NOT_FOUND);
    }
    if (!grants.hasForSite(permission, row.siteId)) {
      throw new ForbiddenException(
        "Vous n'avez pas la permission d'effectuer cette action sur ce lot",
      );
    }
    return row;
  }

  private async batchView(
    tx: TenantTransaction,
    ctx: TenantContext,
    batchId: string,
  ): Promise<VoucherBatch> {
    const rows = await batchQuery(tx).where(
      and(eq(voucherBatches.companyId, ctx.companyId), eq(voucherBatches.id, batchId)),
    );
    const [view] = await this.withStates(tx, ctx, rows);
    if (!view) throw new NotFoundException(BATCH_NOT_FOUND);
    return view;
  }

  private async withStates(
    tx: TenantTransaction,
    ctx: TenantContext,
    rows: BatchRow[],
  ): Promise<VoucherBatch[]> {
    if (rows.length === 0) return [];
    const counts = await tx
      .select({
        batchId: vouchers.batchId,
        state: vouchers.state,
        count: sql<number>`count(*)::int`,
      })
      .from(vouchers)
      .where(
        and(
          eq(vouchers.companyId, ctx.companyId),
          inArray(
            vouchers.batchId,
            rows.map((row) => row.id),
          ),
        ),
      )
      .groupBy(vouchers.batchId, vouchers.state);
    return rows.map((row) => {
      const states = emptyStates();
      for (const count of counts) if (count.batchId === row.id) states[count.state] = count.count;
      return {
        id: row.id,
        plan: { id: row.planId, name: row.planName },
        site: { id: row.siteId, name: row.siteName, code: row.siteCode },
        quantity: row.quantity,
        label: row.label,
        createdAt: row.createdAt.toISOString(),
        createdBy: row.createdBy ? { id: row.createdBy, fullName: row.createdByName } : null,
        states,
      };
    });
  }

  private async detail(
    tx: TenantTransaction,
    ctx: TenantContext,
    row: VoucherRow,
  ): Promise<VoucherDetail> {
    const voucher = toVoucher(row);
    let disabledBy: VoucherDetail['disabledBy'] = null;
    if (row.disabledBy) {
      const [user] = await tx
        .select({ fullName: users.fullName })
        .from(users)
        .where(eq(users.id, row.disabledBy));
      disabledBy = { id: row.disabledBy, fullName: user?.fullName ?? null };
    }
    const attempts = await tx
      .select({
        at: radiusPostauth.createdAt,
        result: radiusPostauth.result,
        reason: radiusPostauth.reason,
        callingStationId: radiusPostauth.callingStationId,
        routerId: routers.id,
        routerName: routers.name,
      })
      .from(radiusPostauth)
      .leftJoin(
        routers,
        and(
          eq(routers.companyId, radiusPostauth.companyId),
          eq(routers.id, radiusPostauth.routerId),
        ),
      )
      .where(and(eq(radiusPostauth.companyId, ctx.companyId), eq(radiusPostauth.voucherId, row.id)))
      .orderBy(desc(radiusPostauth.createdAt))
      .limit(20);
    return {
      ...voucher,
      remaining: voucherRemaining(voucher),
      disabledBy,
      sessions: await this.sessions.forVoucher(tx, ctx, row.id),
      authAttempts: attempts.map((attempt) => ({
        at: attempt.at.toISOString(),
        result: attempt.result,
        reason: attempt.reason,
        callingStationId: attempt.callingStationId,
        router:
          attempt.routerId && attempt.routerName
            ? { id: attempt.routerId, name: attempt.routerName }
            : null,
      })),
    };
  }

  /**
   * Feuille d'impression : codes redérivés (jamais lus en base), limites COPIÉES dans les
   * tickets (et non celles, peut-être modifiées depuis, du forfait). Audit : un nombre.
   */
  private async sheet(
    tx: TenantTransaction,
    ctx: TenantContext,
    rows: VoucherRow[],
    batch: VoucherPrintSheet['batch'],
    target: { type: 'voucher' | 'voucher_batch'; id: string },
  ): Promise<VoucherPrintSheet> {
    const first = rows[0];
    if (!first) throw new NotFoundException(BATCH_NOT_FOUND);
    const [company] = await tx
      .select({ name: companies.name })
      .from(companies)
      .where(eq(companies.id, ctx.companyId));
    const printable: PrintableVoucher[] = rows.map((row) => ({
      id: row.id,
      serial: row.serial,
      code: this.keys.codeOf(row.id, row.codeKeyVersion),
      state: row.state,
    }));
    await this.audit.write(tx, ctx.companyId, {
      action: 'vouchers.export',
      resourceType: target.type,
      resourceId: target.id,
      siteId: first.siteId,
      details: {
        batchId: first.batchId,
        planId: first.planId,
        siteId: first.siteId,
        count: printable.length,
      },
    });
    return {
      batch,
      plan: {
        id: first.planId,
        name: first.planName,
        priceMinor: first.priceMinor,
        currency: first.currency,
        validitySeconds: first.validitySeconds,
        sessionTimeSeconds: first.sessionTimeSeconds,
        dataQuotaBytes: first.dataQuotaBytes,
        rateUpKbps: first.rateUpKbps,
        rateDownKbps: first.rateDownKbps,
        maxDevices: first.maxDevices,
      },
      site: { id: first.siteId, name: first.siteName, code: first.siteCode },
      company: { name: company?.name ?? '' },
      vouchers: printable,
    };
  }
}

/** Identifiants uuidv7() tirés par PostgreSQL AVANT l'insertion (le code en est dérivé). */
async function newIds(tx: TenantTransaction, count: number): Promise<string[]> {
  const result = await tx.execute<{ id: string }>(
    sql`select uuidv7() as id from generate_series(1, ${count})`,
  );
  return result.rows.map((row) => row.id);
}
