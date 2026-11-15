import { Injectable } from '@nestjs/common';
import type { ListRadiusSessionsQuery, RadiusSession } from '@ecsi/shared';
import { and, desc, eq, inArray, isNotNull, isNull, type SQL } from 'drizzle-orm';
import { radiusSessions, routers, sites, vouchers } from '../database/schema/index.js';
import type { Grants } from '../tenancy/access.service.js';
import {
  type TenantContext,
  TenantDatabase,
  type TenantTransaction,
} from '../tenancy/tenant-database.js';

const iso = (value: Date | null) => (value ? value.toISOString() : null);

/**
 * Sessions RADIUS (accounting écrit par FreeRADIUS, lecture seule pour l'API). Portée par
 * site : clients.read sur le site du routeur qui porte la session. Le code du ticket n'existe
 * pas en base : une session est rattachée au ticket par son identifiant et son numéro de série.
 */
@Injectable()
export class RadiusSessionsService {
  constructor(private readonly tenantDb: TenantDatabase) {}

  list(
    ctx: TenantContext,
    grants: Grants,
    query: ListRadiusSessionsQuery,
  ): Promise<RadiusSession[]> {
    const scope = grants.sitesFor('clients.read');
    if (scope !== 'ALL' && scope.length === 0) return Promise.resolve([]);
    return this.tenantDb.run(ctx, (tx) =>
      this.query(
        tx,
        ctx,
        [
          scope === 'ALL' ? undefined : inArray(radiusSessions.siteId, scope),
          query.active === true ? isNull(radiusSessions.stoppedAt) : undefined,
          query.active === false ? isNotNull(radiusSessions.stoppedAt) : undefined,
          query.siteId ? eq(radiusSessions.siteId, query.siteId) : undefined,
          query.routerId ? eq(radiusSessions.routerId, query.routerId) : undefined,
          query.voucherId ? eq(radiusSessions.voucherId, query.voucherId) : undefined,
        ],
        query.limit,
      ),
    );
  }

  /** Dernières sessions d'un ticket déjà contrôlé par l'appelant (détail d'un ticket). */
  forVoucher(
    tx: TenantTransaction,
    ctx: TenantContext,
    voucherId: string,
    limit = 20,
  ): Promise<RadiusSession[]> {
    return this.query(tx, ctx, [eq(radiusSessions.voucherId, voucherId)], limit);
  }

  private async query(
    tx: TenantTransaction,
    ctx: TenantContext,
    filters: (SQL | undefined)[],
    limit: number,
  ): Promise<RadiusSession[]> {
    const rows = await tx
      .select({
        id: radiusSessions.id,
        voucherId: radiusSessions.voucherId,
        serial: vouchers.serial,
        batchId: vouchers.batchId,
        routerId: routers.id,
        routerName: routers.name,
        siteId: sites.id,
        siteName: sites.name,
        siteCode: sites.code,
        callingStationId: radiusSessions.callingStationId,
        framedIp: radiusSessions.framedIp,
        startedAt: radiusSessions.startedAt,
        updatedAt: radiusSessions.updatedAt,
        stoppedAt: radiusSessions.stoppedAt,
        sessionSeconds: radiusSessions.sessionSeconds,
        inputBytes: radiusSessions.inputBytes,
        outputBytes: radiusSessions.outputBytes,
        terminateCause: radiusSessions.terminateCause,
      })
      .from(radiusSessions)
      .innerJoin(
        vouchers,
        and(
          eq(vouchers.companyId, radiusSessions.companyId),
          eq(vouchers.id, radiusSessions.voucherId),
        ),
      )
      .innerJoin(
        routers,
        and(
          eq(routers.companyId, radiusSessions.companyId),
          eq(routers.id, radiusSessions.routerId),
        ),
      )
      .innerJoin(
        sites,
        and(eq(sites.companyId, radiusSessions.companyId), eq(sites.id, radiusSessions.siteId)),
      )
      .where(and(eq(radiusSessions.companyId, ctx.companyId), ...filters))
      .orderBy(desc(radiusSessions.startedAt))
      .limit(limit);
    return rows.map((row) => ({
      id: row.id,
      voucher: { id: row.voucherId, serial: row.serial, batchId: row.batchId },
      router: { id: row.routerId, name: row.routerName },
      site: { id: row.siteId, name: row.siteName, code: row.siteCode },
      macAddress: row.callingStationId,
      framedIp: row.framedIp,
      startedAt: row.startedAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      stoppedAt: iso(row.stoppedAt),
      durationSeconds: row.sessionSeconds,
      bytesUp: row.inputBytes,
      bytesDown: row.outputBytes,
      terminateCause: row.terminateCause,
    }));
  }
}
