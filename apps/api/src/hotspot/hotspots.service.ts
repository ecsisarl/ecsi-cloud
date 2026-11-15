import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  type CreateHotspotRequest,
  type Hotspot,
  type HotspotDesiredState,
  type ListHotspotsQuery,
  networksOverlap,
  parseIpv4Cidr,
  type Permission,
  type UpdateHotspotRequest,
} from '@ecsi/shared';
import { and, asc, eq, inArray, isNull, type SQL, sql } from 'drizzle-orm';
import { AuditService } from '../audit/audit.service.js';
import { ENV } from '../config/config.module.js';
import type { Env } from '../config/env.js';
import { hotspots, routers, sites } from '../database/schema/index.js';
import { hostOf } from '../routers/router-view.js';
import { isUniqueViolation } from '../routers/routers.service.js';
import type { Grants } from '../tenancy/access.service.js';
import {
  type TenantContext,
  TenantDatabase,
  type TenantTransaction,
} from '../tenancy/tenant-database.js';

export const HOTSPOT_NOT_FOUND = 'Hotspot introuvable';
const ROUTER_NOT_FOUND = 'Routeur introuvable';
const ROUTER_HAS_HOTSPOT = 'Ce routeur porte déjà un hotspot';

const iso = (value: Date | null) => (value ? value.toISOString() : null);

const selection = {
  id: hotspots.id,
  name: hotspots.name,
  interface: hotspots.interface,
  gatewayAddress: hotspots.gatewayAddress,
  poolStart: hotspots.poolStart,
  poolEnd: hotspots.poolEnd,
  dnsName: hotspots.dnsName,
  desiredState: hotspots.desiredState,
  syncStatus: hotspots.syncStatus,
  configVersion: hotspots.configVersion,
  appliedVersion: hotspots.appliedVersion,
  lastSyncAt: hotspots.lastSyncAt,
  lastError: hotspots.lastError,
  createdAt: hotspots.createdAt,
  updatedAt: hotspots.updatedAt,
  routerId: routers.id,
  routerName: routers.name,
  routerStatus: routers.status,
  routerTunnelIp: routers.tunnelIp,
  siteId: sites.id,
  siteName: sites.name,
  siteCode: sites.code,
};

function hotspotQuery(tx: TenantTransaction) {
  return tx
    .select(selection)
    .from(hotspots)
    .innerJoin(
      routers,
      and(eq(routers.companyId, hotspots.companyId), eq(routers.id, hotspots.routerId)),
    )
    .innerJoin(sites, and(eq(sites.companyId, hotspots.companyId), eq(sites.id, hotspots.siteId)))
    .$dynamic();
}

type HotspotRow = Awaited<ReturnType<typeof hotspotQuery>>[number];

function toHotspot(row: HotspotRow): Hotspot {
  return {
    id: row.id,
    router: {
      id: row.routerId,
      name: row.routerName,
      status: row.routerStatus,
      tunnelIp: hostOf(row.routerTunnelIp),
    },
    site: { id: row.siteId, name: row.siteName, code: row.siteCode },
    name: row.name,
    interface: row.interface,
    gatewayAddress: row.gatewayAddress,
    poolStart: hostOf(row.poolStart),
    poolEnd: hostOf(row.poolEnd),
    dnsName: row.dnsName,
    desiredState: row.desiredState,
    syncStatus: row.syncStatus,
    configVersion: row.configVersion,
    appliedVersion: row.appliedVersion,
    lastSyncAt: iso(row.lastSyncAt),
    lastError: row.lastError,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Champs de configuration comparés pour l'audit (aucun secret dans un hotspot). */
const CONFIG_FIELDS = [
  'name',
  'interface',
  'gatewayAddress',
  'poolStart',
  'poolEnd',
  'dnsName',
] as const;

/**
 * Hotspots (lot B) : configuration VOULUE d'un hotspot par routeur, appliquée par le worker
 * (compte RouterOS d'écriture). L'API n'écrit jamais l'état de synchronisation, sauf le
 * retour à PENDING avec une nouvelle version de configuration (politique RLS tenant_update).
 * Portée : site du routeur (hotspots.read / hotspots.manage) ; le site du hotspot est
 * TOUJOURS celui du routeur (contrôlé ici et par le déclencheur hotspots_check_site).
 */
@Injectable()
export class HotspotsService {
  private readonly tunnel: ReturnType<typeof parseIpv4Cidr>;

  constructor(
    private readonly tenantDb: TenantDatabase,
    private readonly audit: AuditService,
    @Inject(ENV) env: Env,
  ) {
    this.tunnel = parseIpv4Cidr(env.ROUTER_TUNNEL_CIDR);
  }

  list(ctx: TenantContext, grants: Grants, query: ListHotspotsQuery = {}): Promise<Hotspot[]> {
    const scope = grants.sitesFor('hotspots.read');
    if (scope !== 'ALL' && scope.length === 0) return Promise.resolve([]);
    return this.tenantDb.run(ctx, async (tx) => {
      const filters: (SQL | undefined)[] = [
        eq(hotspots.companyId, ctx.companyId),
        isNull(hotspots.deletedAt),
        isNull(routers.deletedAt),
        scope === 'ALL' ? undefined : inArray(hotspots.siteId, scope),
        query.siteId ? eq(hotspots.siteId, query.siteId) : undefined,
        query.routerId ? eq(hotspots.routerId, query.routerId) : undefined,
      ];
      const rows = await hotspotQuery(tx)
        .where(and(...filters))
        .orderBy(asc(sites.name), asc(routers.name));
      return rows.map(toHotspot);
    });
  }

  get(ctx: TenantContext, grants: Grants, hotspotId: string): Promise<Hotspot> {
    return this.tenantDb.run(ctx, async (tx) =>
      toHotspot(await this.inScope(tx, ctx, grants, hotspotId, 'hotspots.read')),
    );
  }

  create(ctx: TenantContext, grants: Grants, input: CreateHotspotRequest): Promise<Hotspot> {
    this.assertOutsideTunnel(input.gatewayAddress);
    return this.tenantDb.run(ctx, async (tx) => {
      const [router] = await tx
        .select({ id: routers.id, siteId: routers.siteId, name: routers.name })
        .from(routers)
        .where(
          and(
            eq(routers.id, input.routerId),
            eq(routers.companyId, ctx.companyId),
            isNull(routers.deletedAt),
          ),
        );
      if (!router || !grants.hasForSite('hotspots.read', router.siteId)) {
        throw new NotFoundException(ROUTER_NOT_FOUND);
      }
      if (!grants.hasForSite('hotspots.manage', router.siteId)) {
        throw new ForbiddenException(
          "Vous n'avez pas la permission de configurer un hotspot sur ce routeur",
        );
      }
      let id: string | undefined;
      try {
        // INSERT limité aux colonnes accordées à ecsi_app (migration 0008).
        const inserted = await tx.execute<{ id: string }>(sql`
          insert into hotspots (company_id, site_id, router_id, name, interface, gateway_address,
            pool_start, pool_end, dns_name, desired_state)
          values (${ctx.companyId}::uuid, ${router.siteId}::uuid, ${router.id}::uuid, ${input.name},
            ${input.interface}, ${input.gatewayAddress}::inet, ${input.poolStart}::inet,
            ${input.poolEnd}::inet, ${input.dnsName ?? null}, 'ENABLED')
          returning id`);
        id = inserted.rows[0]?.id;
      } catch (error) {
        if (isUniqueViolation(error)) throw new ConflictException(ROUTER_HAS_HOTSPOT);
        throw error;
      }
      if (!id) throw new Error('Hotspot non créé');
      const row = await this.byId(tx, ctx, id);
      await this.audit.write(tx, ctx.companyId, {
        action: 'hotspots.create',
        resourceType: 'hotspot',
        resourceId: id,
        siteId: row.siteId,
        details: { router: router.name, ...configOf(toHotspot(row)) },
      });
      return toHotspot(row);
    });
  }

  update(
    ctx: TenantContext,
    grants: Grants,
    hotspotId: string,
    input: UpdateHotspotRequest,
  ): Promise<Hotspot> {
    if (input.gatewayAddress !== undefined) this.assertOutsideTunnel(input.gatewayAddress);
    return this.tenantDb.run(ctx, async (tx) => {
      const before = toHotspot(await this.inScope(tx, ctx, grants, hotspotId, 'hotspots.manage'));
      const after = { ...configOf(before), ...definedOnly(input) };
      const changes: Record<string, { before: unknown; after: unknown }> = {};
      for (const field of CONFIG_FIELDS) {
        const previous = configOf(before)[field];
        if ((after[field] ?? null) !== previous) {
          changes[field] = { before: previous, after: after[field] ?? null };
        }
      }
      if (Object.keys(changes).length === 0) return before;
      return this.apply(tx, ctx, before, 'hotspots.update', {
        set: {
          name: after.name,
          interface: after.interface,
          gatewayAddress: after.gatewayAddress,
          poolStart: after.poolStart,
          poolEnd: after.poolEnd,
          dnsName: after.dnsName ?? null,
        },
        details: { changes },
      });
    });
  }

  setDesiredState(
    ctx: TenantContext,
    grants: Grants,
    hotspotId: string,
    desiredState: HotspotDesiredState,
  ): Promise<Hotspot> {
    return this.tenantDb.run(ctx, async (tx) => {
      const before = toHotspot(await this.inScope(tx, ctx, grants, hotspotId, 'hotspots.manage'));
      return this.apply(
        tx,
        ctx,
        before,
        desiredState === 'ENABLED' ? 'hotspots.enable' : 'hotspots.disable',
        {
          set: { desiredState },
          details: { desiredState: { before: before.desiredState, after: desiredState } },
        },
      );
    });
  }

  /** Nouvelle application de la configuration voulue (aucune modification). */
  sync(ctx: TenantContext, grants: Grants, hotspotId: string): Promise<Hotspot> {
    return this.tenantDb.run(ctx, async (tx) => {
      const before = toHotspot(await this.inScope(tx, ctx, grants, hotspotId, 'hotspots.manage'));
      return this.apply(tx, ctx, before, 'hotspots.sync', {
        set: {},
        details: { syncStatus: before.syncStatus },
      });
    });
  }

  /**
   * Suppression logique : le hotspot disparaît de l'API ; desired_state passe à DISABLED et
   * une nouvelle version est publiée pour que le worker retire la configuration du routeur.
   */
  remove(ctx: TenantContext, grants: Grants, hotspotId: string): Promise<void> {
    return this.tenantDb.run(ctx, async (tx) => {
      const before = toHotspot(await this.inScope(tx, ctx, grants, hotspotId, 'hotspots.manage'));
      await this.apply(tx, ctx, before, 'hotspots.delete', {
        set: { desiredState: 'DISABLED', deletedAt: new Date() },
        details: { ...configOf(before), desiredState: before.desiredState },
      });
    });
  }

  // ---------------------------------------------------------------------------------------

  /** Mise à jour + config_version + 1 + PENDING (seule valeur admise par la RLS), audit. */
  private async apply(
    tx: TenantTransaction,
    ctx: TenantContext,
    before: Hotspot,
    action: string,
    change: {
      set: Partial<{
        name: string;
        interface: string;
        gatewayAddress: string;
        poolStart: string;
        poolEnd: string;
        dnsName: string | null;
        desiredState: HotspotDesiredState;
        deletedAt: Date;
      }>;
      details: Record<string, unknown>;
    },
  ): Promise<Hotspot> {
    const updated = await tx
      .update(hotspots)
      .set({
        ...change.set,
        syncStatus: 'PENDING',
        configVersion: sql`${hotspots.configVersion} + 1`,
      })
      .where(
        and(
          eq(hotspots.id, before.id),
          eq(hotspots.companyId, ctx.companyId),
          isNull(hotspots.deletedAt),
        ),
      )
      .returning({ configVersion: hotspots.configVersion });
    if (updated.length === 0) throw new NotFoundException(HOTSPOT_NOT_FOUND);
    await this.audit.write(tx, ctx.companyId, {
      action,
      resourceType: 'hotspot',
      resourceId: before.id,
      siteId: before.site.id,
      details: {
        hotspot: before.name,
        router: before.router.name,
        configVersion: updated[0]?.configVersion ?? null,
        ...change.details,
      },
    });
    return toHotspot(await this.byId(tx, ctx, before.id));
  }

  private async inScope(
    tx: TenantTransaction,
    ctx: TenantContext,
    grants: Grants,
    hotspotId: string,
    permission: Permission,
  ): Promise<HotspotRow> {
    const [row] = await hotspotQuery(tx).where(
      and(
        eq(hotspots.id, hotspotId),
        eq(hotspots.companyId, ctx.companyId),
        isNull(hotspots.deletedAt),
        isNull(routers.deletedAt),
      ),
    );
    if (!row || !grants.hasForSite('hotspots.read', row.siteId)) {
      throw new NotFoundException(HOTSPOT_NOT_FOUND);
    }
    if (!grants.hasForSite(permission, row.siteId)) {
      throw new ForbiddenException(
        "Vous n'avez pas la permission d'effectuer cette action sur ce hotspot",
      );
    }
    return row;
  }

  private async byId(tx: TenantTransaction, ctx: TenantContext, id: string): Promise<HotspotRow> {
    const [row] = await hotspotQuery(tx).where(
      and(eq(hotspots.id, id), eq(hotspots.companyId, ctx.companyId)),
    );
    if (!row) throw new NotFoundException(HOTSPOT_NOT_FOUND);
    return row;
  }

  /** Le réseau Hotspot ne doit pas chevaucher le réseau tunnel des routeurs. */
  private assertOutsideTunnel(gatewayAddress: string): void {
    const net = parseIpv4Cidr(gatewayAddress.trim());
    if (net && this.tunnel && networksOverlap(net, this.tunnel)) {
      throw new UnprocessableEntityException(
        'Le réseau Hotspot chevauche le réseau tunnel des routeurs',
      );
    }
  }
}

function configOf(hotspot: Hotspot) {
  return {
    name: hotspot.name,
    interface: hotspot.interface,
    gatewayAddress: hotspot.gatewayAddress,
    poolStart: hotspot.poolStart,
    poolEnd: hotspot.poolEnd,
    dnsName: hotspot.dnsName,
  };
}

function definedOnly<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined),
  ) as Partial<T>;
}
