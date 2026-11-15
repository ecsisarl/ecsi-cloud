import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { CreatePlanRequest, Plan, UpdatePlanRequest } from '@ecsi/shared';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { AuditService } from '../audit/audit.service.js';
import { diff } from '../audit/sanitize.js';
import { plans } from '../database/schema/index.js';
import {
  type TenantContext,
  TenantDatabase,
  type TenantTransaction,
} from '../tenancy/tenant-database.js';

export const PLAN_NOT_FOUND = 'Forfait introuvable';

const PLAN_FIELDS = [
  'name',
  'description',
  'priceAmount',
  'currency',
  'sessionTimeSeconds',
  'validitySeconds',
  'rateDownKbps',
  'rateUpKbps',
  'dataQuotaBytes',
  'maxDevices',
  'macBinding',
  'sortOrder',
  'isPublic',
  'status',
] as const;

export type PlanRow = typeof plans.$inferSelect;

export function planView(row: PlanRow): Plan {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    priceAmount: row.priceAmount,
    currency: row.currency,
    sessionTimeSeconds: row.sessionTimeSeconds,
    validitySeconds: row.validitySeconds,
    rateDownKbps: row.rateDownKbps,
    rateUpKbps: row.rateUpKbps,
    dataQuotaBytes: row.dataQuotaBytes,
    maxDevices: row.maxDevices,
    macBinding: row.macBinding,
    defaultScope: row.defaultScope,
    sortOrder: row.sortOrder,
    isPublic: row.isPublic,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Forfaits de l'entreprise (Mikhmon : « profils utilisateur » avec prix). Les forfaits
 * sont communs à toute l'entreprise ; leur gestion exige plans.manage sur l'entreprise.
 */
@Injectable()
export class PlansService {
  constructor(
    private readonly tenantDb: TenantDatabase,
    private readonly audit: AuditService,
  ) {}

  list(ctx: TenantContext): Promise<Plan[]> {
    return this.tenantDb.run(ctx, async (tx) => {
      const rows = await tx
        .select()
        .from(plans)
        .where(and(eq(plans.companyId, ctx.companyId), isNull(plans.deletedAt)))
        .orderBy(asc(plans.sortOrder), asc(plans.priceAmount), asc(plans.name));
      return rows.map(planView);
    });
  }

  get(ctx: TenantContext, planId: string): Promise<Plan> {
    return this.tenantDb.run(ctx, async (tx) => planView(await this.row(tx, ctx, planId)));
  }

  create(ctx: TenantContext, input: CreatePlanRequest): Promise<Plan> {
    return this.tenantDb.run(ctx, async (tx) => {
      const row = await uniqueName(() =>
        tx
          .insert(plans)
          .values({ ...input, companyId: ctx.companyId })
          .returning()
          .then((rows) => rows[0]),
      );
      if (!row) throw new Error('Création du forfait impossible');
      await this.audit.write(tx, ctx.companyId, {
        action: 'plans.create',
        resourceType: 'plan',
        resourceId: row.id,
        details: { after: pick(row, PLAN_FIELDS) },
      });
      return planView(row);
    });
  }

  update(ctx: TenantContext, planId: string, input: UpdatePlanRequest): Promise<Plan> {
    return this.tenantDb.run(ctx, async (tx) => {
      const before = await this.row(tx, ctx, planId);
      const row = await uniqueName(() =>
        tx
          .update(plans)
          .set(input)
          .where(and(eq(plans.id, planId), eq(plans.companyId, ctx.companyId)))
          .returning()
          .then((rows) => rows[0]),
      );
      if (!row) throw new NotFoundException(PLAN_NOT_FOUND);
      const changes = diff(before, row, PLAN_FIELDS);
      if (Object.keys(changes).length > 0) {
        await this.audit.write(tx, ctx.companyId, {
          action: 'plans.update',
          resourceType: 'plan',
          resourceId: planId,
          details: { plan: row.name, changes },
        });
      }
      return planView(row);
    });
  }

  /**
   * Suppression logique : les tickets déjà générés gardent leur forfait (prix figé dans le
   * lot) ; le forfait n'est plus proposé pour de nouvelles générations.
   */
  remove(ctx: TenantContext, planId: string): Promise<void> {
    return this.tenantDb.run(ctx, async (tx) => {
      const before = await this.row(tx, ctx, planId);
      await tx
        .update(plans)
        .set({ deletedAt: new Date(), status: 'INACTIVE' })
        .where(and(eq(plans.id, planId), eq(plans.companyId, ctx.companyId)));
      await this.audit.write(tx, ctx.companyId, {
        action: 'plans.delete',
        resourceType: 'plan',
        resourceId: planId,
        details: { before: pick(before, PLAN_FIELDS) },
      });
    });
  }

  async row(tx: TenantTransaction, ctx: TenantContext, planId: string): Promise<PlanRow> {
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

async function uniqueName<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    const cause = (error as { cause?: { code?: string }; code?: string } | undefined) ?? {};
    if (cause.code === '23505' || cause.cause?.code === '23505') {
      throw new ConflictException('Un forfait porte déjà ce nom dans votre entreprise');
    }
    throw error;
  }
}

function pick(row: Record<string, unknown>, fields: readonly string[]) {
  return Object.fromEntries(fields.map((field) => [field, row[field]]));
}
