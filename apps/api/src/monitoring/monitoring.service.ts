import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  type Alert,
  type AlertSummary,
  type ListAlertsQuery,
  memoryUsedPercent,
  type MonitoredRouter,
  type MonitoringOverview,
  ROUTER_STATUSES,
  type RouterMetrics,
  type RouterMetricsQuery,
  type RouterStatus,
} from '@ecsi/shared';
import { and, asc, desc, eq, inArray, isNotNull, isNull, type SQL, sql } from 'drizzle-orm';
import { AuditService } from '../audit/audit.service.js';
import { alerts, routers, sites, users } from '../database/schema/index.js';
import type { Grants } from '../tenancy/access.service.js';
import {
  type TenantContext,
  TenantDatabase,
  type TenantTransaction,
} from '../tenancy/tenant-database.js';

export const ALERT_NOT_FOUND = 'Alerte introuvable';
const ROUTER_NOT_FOUND = 'Routeur introuvable';
/** Nombre de points visés pour un historique (lisible sur un petit graphique). */
const TARGET_POINTS = 240;

const iso = (value: Date | null) => (value ? value.toISOString() : null);

const alertSelection = {
  id: alerts.id,
  type: alerts.type,
  severity: alerts.severity,
  details: alerts.details,
  openedAt: alerts.openedAt,
  resolvedAt: alerts.resolvedAt,
  acknowledgedAt: alerts.acknowledgedAt,
  acknowledgedBy: alerts.acknowledgedBy,
  acknowledgedByName: users.fullName,
  routerId: routers.id,
  routerName: routers.name,
  routerStatus: routers.status,
  siteId: sites.id,
  siteName: sites.name,
  siteCode: sites.code,
};

function alertQuery(tx: TenantTransaction) {
  return tx
    .select(alertSelection)
    .from(alerts)
    .innerJoin(
      routers,
      and(eq(routers.companyId, alerts.companyId), eq(routers.id, alerts.routerId)),
    )
    .innerJoin(sites, and(eq(sites.companyId, routers.companyId), eq(sites.id, routers.siteId)))
    .leftJoin(users, eq(users.id, alerts.acknowledgedBy))
    .$dynamic();
}

type AlertRow = Awaited<ReturnType<typeof alertQuery>>[number];

function toAlert(row: AlertRow): Alert {
  return {
    id: row.id,
    type: row.type,
    severity: row.severity,
    router: { id: row.routerId, name: row.routerName, status: row.routerStatus },
    site: { id: row.siteId, name: row.siteName, code: row.siteCode },
    details: row.details,
    openedAt: row.openedAt.toISOString(),
    resolvedAt: iso(row.resolvedAt),
    acknowledgedAt: iso(row.acknowledgedAt),
    acknowledgedBy: row.acknowledgedBy
      ? { id: row.acknowledgedBy, fullName: row.acknowledgedByName }
      : null,
  };
}

/**
 * Supervision et alertes (lot E1), rôle ecsi_app sous RLS. Portée par site, comme les
 * routeurs : seuls les routeurs (et leurs alertes) des sites où l'utilisateur détient
 * monitoring.read sont visibles ; une alerte ou un routeur hors de cette portée, supprimé
 * ou d'une autre entreprise répond 404. L'acquittement exige monitoring.acknowledge sur le
 * site du routeur et est audité dans la même transaction.
 */
@Injectable()
export class MonitoringService {
  constructor(
    private readonly tenantDb: TenantDatabase,
    private readonly audit: AuditService,
  ) {}

  overview(ctx: TenantContext, grants: Grants): Promise<MonitoringOverview> {
    const scope = grants.sitesFor('monitoring.read');
    return this.tenantDb.run(ctx, async (tx) => {
      const counts = Object.fromEntries(ROUTER_STATUSES.map((s) => [s, 0])) as Record<
        RouterStatus,
        number
      >;
      if (scope !== 'ALL' && scope.length === 0) {
        return {
          routers: { ...counts, total: 0 },
          alerts: { open: 0, unacknowledged: 0, critical: 0 },
          items: [],
          generatedAt: new Date().toISOString(),
        };
      }
      const openAlerts = tx
        .select({ routerId: alerts.routerId, count: sql<number>`count(*)::int`.as('count') })
        .from(alerts)
        .where(and(eq(alerts.companyId, ctx.companyId), isNull(alerts.resolvedAt)))
        .groupBy(alerts.routerId)
        .as('open_alerts');
      const rows = await tx
        .select({
          id: routers.id,
          name: routers.name,
          status: routers.status,
          cpuLoad: routers.cpuLoad,
          totalMemory: routers.totalMemory,
          freeMemory: routers.freeMemory,
          uptimeSeconds: routers.uptimeSeconds,
          lastSeenAt: routers.lastSeenAt,
          siteId: sites.id,
          siteName: sites.name,
          siteCode: sites.code,
          openAlerts: sql<number>`coalesce(${openAlerts.count}, 0)::int`,
        })
        .from(routers)
        .innerJoin(sites, and(eq(sites.companyId, routers.companyId), eq(sites.id, routers.siteId)))
        .leftJoin(openAlerts, eq(openAlerts.routerId, routers.id))
        .where(and(...this.routerScope(ctx, scope)))
        .orderBy(asc(sites.name), asc(routers.name));
      const items: MonitoredRouter[] = rows.map((row) => ({
        id: row.id,
        name: row.name,
        site: { id: row.siteId, name: row.siteName, code: row.siteCode },
        status: row.status,
        cpuLoad: row.cpuLoad,
        memoryUsedPercent: memoryUsedPercent(row.totalMemory, row.freeMemory),
        uptimeSeconds: row.uptimeSeconds,
        lastSeenAt: iso(row.lastSeenAt),
        openAlerts: row.openAlerts,
      }));
      for (const item of items) counts[item.status] += 1;
      return {
        routers: { ...counts, total: items.length },
        alerts: await this.countOpen(tx, ctx, scope),
        items,
        generatedAt: new Date().toISOString(),
      };
    });
  }

  summary(ctx: TenantContext, grants: Grants): Promise<AlertSummary> {
    const scope = grants.sitesFor('monitoring.read');
    if (scope !== 'ALL' && scope.length === 0) {
      return Promise.resolve({ open: 0, unacknowledged: 0, critical: 0 });
    }
    return this.tenantDb.run(ctx, (tx) => this.countOpen(tx, ctx, scope));
  }

  listAlerts(ctx: TenantContext, grants: Grants, query: ListAlertsQuery): Promise<Alert[]> {
    const scope = grants.sitesFor('monitoring.read');
    if (scope !== 'ALL' && scope.length === 0) return Promise.resolve([]);
    return this.tenantDb.run(ctx, async (tx) => {
      const filters: (SQL | undefined)[] = [
        ...this.routerScope(ctx, scope),
        eq(alerts.companyId, ctx.companyId),
        query.state === 'open' ? isNull(alerts.resolvedAt) : undefined,
        query.state === 'resolved' ? isNotNull(alerts.resolvedAt) : undefined,
        query.siteId ? eq(routers.siteId, query.siteId) : undefined,
        query.routerId ? eq(alerts.routerId, query.routerId) : undefined,
      ];
      const rows = await alertQuery(tx)
        .where(and(...filters))
        // Ouvertes d'abord (critiques en tête), puis les plus récentes.
        .orderBy(
          sql`${alerts.resolvedAt} is not null`,
          sql`${alerts.severity} = 'CRITICAL' desc`,
          desc(alerts.openedAt),
        )
        .limit(query.limit);
      return rows.map((row) => toAlert(row));
    });
  }

  routerMetrics(
    ctx: TenantContext,
    grants: Grants,
    routerId: string,
    query: RouterMetricsQuery,
  ): Promise<RouterMetrics> {
    return this.tenantDb.run(ctx, async (tx) => {
      const [router] = await tx
        .select({ siteId: routers.siteId })
        .from(routers)
        .where(
          and(
            eq(routers.id, routerId),
            eq(routers.companyId, ctx.companyId),
            isNull(routers.deletedAt),
          ),
        );
      if (!router || !grants.hasForSite('monitoring.read', router.siteId)) {
        throw new NotFoundException(ROUTER_NOT_FOUND);
      }
      const bucketSeconds = Math.max(60, Math.ceil((query.hours * 3600) / TARGET_POINTS / 60) * 60);
      const result = await tx.execute<{
        bucket: Date | string;
        cpu: string | null;
        memory: string | null;
        availability: string | null;
        samples: string | number;
      }>(sql`
        select date_bin(make_interval(secs => ${bucketSeconds}), sampled_at,
                        timestamptz '2000-01-01 00:00:00+00') as bucket,
               avg(cpu_load) as cpu,
               avg(case when total_memory > 0 and free_memory between 0 and total_memory
                        then (total_memory - free_memory) * 100.0 / total_memory end) as memory,
               avg(case when status = 'ONLINE' then 1.0 else 0.0 end) as availability,
               count(*) as samples
          from router_metrics
         where company_id = ${ctx.companyId}
           and router_id = ${routerId}
           and sampled_at >= now() - make_interval(hours => ${query.hours})
         group by 1
         order by 1`);
      const round = (value: string | null, digits: number) =>
        value === null ? null : Number(Number(value).toFixed(digits));
      return {
        routerId,
        hours: query.hours,
        bucketSeconds,
        points: result.rows.map((row) => ({
          at: new Date(row.bucket).toISOString(),
          cpuLoad: round(row.cpu, 1),
          memoryUsedPercent: round(row.memory, 1),
          availability: round(row.availability, 3),
          samples: Number(row.samples),
        })),
      };
    });
  }

  acknowledge(ctx: TenantContext, grants: Grants, alertId: string): Promise<Alert> {
    return this.tenantDb.run(ctx, async (tx) => {
      const [before] = await alertQuery(tx).where(
        and(eq(alerts.id, alertId), eq(alerts.companyId, ctx.companyId), isNull(routers.deletedAt)),
      );
      if (!before || !grants.hasForSite('monitoring.read', before.siteId)) {
        throw new NotFoundException(ALERT_NOT_FOUND);
      }
      if (!grants.hasForSite('monitoring.acknowledge', before.siteId)) {
        throw new ForbiddenException(
          "Vous n'avez pas la permission d'acquitter les alertes de ce site",
        );
      }
      if (before.acknowledgedAt) throw new ConflictException('Alerte déjà acquittée');
      const updated = await tx
        .update(alerts)
        .set({ acknowledgedAt: sql`now()`, acknowledgedBy: ctx.userId })
        .where(
          and(
            eq(alerts.id, alertId),
            eq(alerts.companyId, ctx.companyId),
            isNull(alerts.acknowledgedAt),
          ),
        )
        .returning({ id: alerts.id });
      // Acquittement simultané par quelqu'un d'autre : la politique RLS refuse le second.
      if (updated.length === 0) throw new ConflictException('Alerte déjà acquittée');
      await this.audit.write(tx, ctx.companyId, {
        action: 'monitoring.alert.acknowledge',
        resourceType: 'alert',
        resourceId: alertId,
        siteId: before.siteId,
        details: {
          type: before.type,
          severity: before.severity,
          router: before.routerName,
          routerId: before.routerId,
          openedAt: before.openedAt.toISOString(),
          resolved: before.resolvedAt !== null,
        },
      });
      const [after] = await alertQuery(tx).where(eq(alerts.id, alertId));
      if (!after) throw new NotFoundException(ALERT_NOT_FOUND);
      return toAlert(after);
    });
  }

  // ---------------------------------------------------------------------------------

  private routerScope(ctx: TenantContext, scope: 'ALL' | string[]): (SQL | undefined)[] {
    return [
      eq(routers.companyId, ctx.companyId),
      isNull(routers.deletedAt),
      scope === 'ALL' ? undefined : inArray(routers.siteId, scope),
    ];
  }

  private async countOpen(
    tx: TenantTransaction,
    ctx: TenantContext,
    scope: 'ALL' | string[],
  ): Promise<AlertSummary> {
    const [row] = await tx
      .select({
        open: sql<number>`count(*)::int`,
        unacknowledged: sql<number>`(count(*) filter (where ${alerts.acknowledgedAt} is null))::int`,
        critical: sql<number>`(count(*) filter (where ${alerts.severity} = 'CRITICAL'))::int`,
      })
      .from(alerts)
      .innerJoin(
        routers,
        and(eq(routers.companyId, alerts.companyId), eq(routers.id, alerts.routerId)),
      )
      .where(
        and(
          eq(alerts.companyId, ctx.companyId),
          isNull(alerts.resolvedAt),
          ...this.routerScope(ctx, scope),
        ),
      );
    return {
      open: row?.open ?? 0,
      unacknowledged: row?.unacknowledged ?? 0,
      critical: row?.critical ?? 0,
    };
  }
}
