import {
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  type CreatePlanRequest,
  type ListPlansQuery,
  type Plan,
  PLAN_LIMIT_MESSAGE,
  planHasLimit,
  type UpdatePlanRequest,
} from '@ecsi/shared';
import { and, asc, eq, isNull, type SQL } from 'drizzle-orm';
import { AuditService } from '../audit/audit.service.js';
import { diff } from '../audit/sanitize.js';
import { companies, plans } from '../database/schema/index.js';
import { isUniqueViolation } from '../routers/routers.service.js';
import {
  type TenantContext,
  TenantDatabase,
  type TenantTransaction,
} from '../tenancy/tenant-database.js';

export const PLAN_NOT_FOUND = 'Forfait introuvable';
const PLAN_NAME_TAKEN = 'Un forfait porte déjà ce nom';

type PlanRow = typeof plans.$inferSelect;

/** Champs comparés pour l'audit d'une modification (valeurs publiques, aucun secret). */
const AUDITED_FIELDS = [
  'name',
  'description',
  'priceMinor',
  'validitySeconds',
  'sessionTimeSeconds',
  'rateUpKbps',
  'rateDownKbps',
  'dataQuotaBytes',
  'maxDevices',
  'idleTimeoutSeconds',
] as const;

export function toPlan(row: PlanRow): Plan {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    priceMinor: row.priceMinor,
    currency: row.currency,
    validitySeconds: row.validitySeconds,
    sessionTimeSeconds: row.sessionTimeSeconds,
    rateUpKbps: row.rateUpKbps,
    rateDownKbps: row.rateDownKbps,
    dataQuotaBytes: row.dataQuotaBytes,
    maxDevices: row.maxDevices,
    idleTimeoutSeconds: row.idleTimeoutSeconds,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

const summary = (row: PlanRow) => ({
  name: row.name,
  priceMinor: row.priceMinor,
  currency: row.currency,
  status: row.status,
});

/**
 * Forfaits de l'entreprise (rôle ecsi_app, RLS). Ressource d'entreprise : lecture avec
 * plans.read (sur au moins un site), modification avec plans.manage pour toute l'entreprise.
 * Pas de suppression physique : un forfait supprimé (deleted_at) reste référencé par les
 * tickets déjà émis, qui gardent leurs propres limites (copiées à la génération).
 */
@Injectable()
export class PlansService {
  constructor(
    private readonly tenantDb: TenantDatabase,
    private readonly audit: AuditService,
  ) {}

  list(ctx: TenantContext, query: ListPlansQuery = {}): Promise<Plan[]> {
    return this.tenantDb.run(ctx, async (tx) => {
      const filters: (SQL | undefined)[] = [
        eq(plans.companyId, ctx.companyId),
        isNull(plans.deletedAt),
        query.status ? eq(plans.status, query.status) : undefined,
      ];
      const rows = await tx
        .select()
        .from(plans)
        .where(and(...filters))
        .orderBy(asc(plans.priceMinor), asc(plans.name));
      return rows.map(toPlan);
    });
  }

  get(ctx: TenantContext, planId: string): Promise<Plan> {
    return this.tenantDb.run(ctx, async (tx) => toPlan(await this.byId(tx, ctx, planId)));
  }

  create(ctx: TenantContext, input: CreatePlanRequest): Promise<Plan> {
    return this.tenantDb.run(ctx, async (tx) => {
      // Devise de l'entreprise (jamais saisie) : les montants restent cohérents.
      const [company] = await tx
        .select({ currency: companies.currency })
        .from(companies)
        .where(eq(companies.id, ctx.companyId));
      if (!company) throw new NotFoundException('Entreprise introuvable');
      let row: PlanRow | undefined;
      try {
        [row] = await tx
          .insert(plans)
          .values({
            companyId: ctx.companyId,
            name: input.name,
            description: input.description ?? null,
            priceMinor: input.priceMinor,
            currency: company.currency,
            validitySeconds: input.validitySeconds ?? null,
            sessionTimeSeconds: input.sessionTimeSeconds ?? null,
            rateUpKbps: input.rateUpKbps ?? null,
            rateDownKbps: input.rateDownKbps ?? null,
            dataQuotaBytes: input.dataQuotaBytes ?? null,
            maxDevices: input.maxDevices,
            idleTimeoutSeconds: input.idleTimeoutSeconds,
          })
          .returning();
      } catch (error) {
        if (isUniqueViolation(error)) throw new ConflictException(PLAN_NAME_TAKEN);
        throw error;
      }
      if (!row) throw new Error('Forfait non créé');
      await this.audit.write(tx, ctx.companyId, {
        action: 'plans.create',
        resourceType: 'plan',
        resourceId: row.id,
        details: {
          ...summary(row),
          ...Object.fromEntries(AUDITED_FIELDS.map((field) => [field, row[field]])),
        },
      });
      return toPlan(row);
    });
  }

  update(ctx: TenantContext, planId: string, input: UpdatePlanRequest): Promise<Plan> {
    return this.tenantDb.run(ctx, async (tx) => {
      const before = await this.byId(tx, ctx, planId);
      const merged = { ...before, ...definedOnly(input) };
      if (!planHasLimit(merged)) throw new UnprocessableEntityException(PLAN_LIMIT_MESSAGE);
      const changes = diff(before, merged, AUDITED_FIELDS);
      if (Object.keys(changes).length === 0) return toPlan(before);
      let row: PlanRow | undefined;
      try {
        [row] = await tx
          .update(plans)
          .set(definedOnly(input))
          .where(
            and(eq(plans.id, planId), eq(plans.companyId, ctx.companyId), isNull(plans.deletedAt)),
          )
          .returning();
      } catch (error) {
        if (isUniqueViolation(error)) throw new ConflictException(PLAN_NAME_TAKEN);
        throw error;
      }
      if (!row) throw new NotFoundException(PLAN_NOT_FOUND);
      await this.audit.write(tx, ctx.companyId, {
        action: 'plans.update',
        resourceType: 'plan',
        resourceId: planId,
        // Les tickets déjà émis gardent les limites copiées à leur génération.
        details: { plan: before.name, changes },
      });
      return toPlan(row);
    });
  }

  setStatus(ctx: TenantContext, planId: string, status: Plan['status']): Promise<Plan> {
    return this.tenantDb.run(ctx, async (tx) => {
      const before = await this.byId(tx, ctx, planId);
      if (before.status === status) return toPlan(before);
      const [row] = await tx
        .update(plans)
        .set({ status })
        .where(and(eq(plans.id, planId), eq(plans.companyId, ctx.companyId)))
        .returning();
      if (!row) throw new NotFoundException(PLAN_NOT_FOUND);
      await this.audit.write(tx, ctx.companyId, {
        action: status === 'ACTIVE' ? 'plans.enable' : 'plans.disable',
        resourceType: 'plan',
        resourceId: planId,
        details: { plan: before.name, status: { before: before.status, after: status } },
      });
      return toPlan(row);
    });
  }

  /** Suppression logique : le forfait disparaît des listes ; les tickets émis restent valables. */
  remove(ctx: TenantContext, planId: string): Promise<void> {
    return this.tenantDb.run(ctx, async (tx) => {
      const before = await this.byId(tx, ctx, planId);
      await tx
        .update(plans)
        .set({ deletedAt: new Date(), status: 'DISABLED' })
        .where(and(eq(plans.id, planId), eq(plans.companyId, ctx.companyId)));
      await this.audit.write(tx, ctx.companyId, {
        action: 'plans.delete',
        resourceType: 'plan',
        resourceId: planId,
        details: summary(before),
      });
    });
  }

  /** Forfait non supprimé de l'entreprise courante ; sinon 404. */
  async byId(tx: TenantTransaction, ctx: TenantContext, planId: string): Promise<PlanRow> {
    const [row] = await tx
      .select()
      .from(plans)
      .where(
        and(eq(plans.id, planId), eq(plans.companyId, ctx.companyId), isNull(plans.deletedAt)),
      );
    if (!row) throw new NotFoundException(PLAN_NOT_FOUND);
    return row;
  }
}

function definedOnly<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined),
  ) as Partial<T>;
}
