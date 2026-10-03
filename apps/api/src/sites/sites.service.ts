import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type {
  CreateSiteGroupRequest,
  CreateSiteRequest,
  ListSitesQuery,
  Site,
  SiteGroup,
  UpdateSiteGroupRequest,
  UpdateSiteRequest,
} from '@ecsi/shared';
import { and, asc, eq, ilike, inArray, isNull, or, type SQL, sql } from 'drizzle-orm';
import { AuditService } from '../audit/audit.service.js';
import { diff } from '../audit/sanitize.js';
import {
  membershipRoleSites,
  siteGroupMembers,
  siteGroups,
  sites,
} from '../database/schema/index.js';
import type { Grants } from '../tenancy/access.service.js';
import {
  type TenantContext,
  TenantDatabase,
  type TenantTransaction,
} from '../tenancy/tenant-database.js';

const SITE_NOT_FOUND = 'Site introuvable';
const GROUP_NOT_FOUND = 'Groupe de sites introuvable';
const SITE_FIELDS = [
  'name',
  'code',
  'description',
  'address',
  'city',
  'country',
  'latitude',
  'longitude',
  'timezone',
  'phone',
  'contactName',
  'status',
  'metadata',
] as const;

type SiteRow = typeof sites.$inferSelect;

/**
 * Sites WiFi et groupes de sites de l'entreprise courante.
 *
 * Portée par site (RBAC) : la liste ne contient que les sites où l'utilisateur détient
 * sites.read ; lire, modifier ou supprimer un site hors de sa portée répond 404, comme un
 * site inexistant ou appartenant à une autre entreprise (la RLS l'aurait de toute façon
 * masqué). L'identifiant reçu dans l'URL n'est jamais une source de droits : il est
 * toujours confronté aux droits de la session.
 *
 * Groupes : ils structurent l'entreprise (ECSI Roaming) ; leur gestion exige des droits sur
 * toute l'entreprise (site_groups.manage).
 */
@Injectable()
export class SitesService {
  constructor(
    private readonly tenantDb: TenantDatabase,
    private readonly audit: AuditService,
  ) {}

  listSites(ctx: TenantContext, grants: Grants, query: ListSitesQuery = {}): Promise<Site[]> {
    const scope = grants.sitesFor('sites.read');
    if (scope !== 'ALL' && scope.length === 0) return Promise.resolve([]);
    return this.tenantDb.run(ctx, async (tx) => {
      const filters: (SQL | undefined)[] = [
        eq(sites.companyId, ctx.companyId),
        isNull(sites.deletedAt),
        scope === 'ALL' ? undefined : inArray(sites.id, scope),
        query.status ? eq(sites.status, query.status) : undefined,
      ];
      if (query.q) {
        const pattern = `%${query.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
        filters.push(
          or(ilike(sites.name, pattern), ilike(sites.code, pattern), ilike(sites.city, pattern)),
        );
      }
      if (query.groupId) {
        const members = await tx
          .select({ siteId: siteGroupMembers.siteId })
          .from(siteGroupMembers)
          .where(eq(siteGroupMembers.groupId, query.groupId));
        filters.push(
          members.length
            ? inArray(
                sites.id,
                members.map((m) => m.siteId),
              )
            : sql`false`,
        );
      }
      const rows = await tx
        .select()
        .from(sites)
        .where(and(...filters))
        .orderBy(asc(sites.name));
      return this.withGroups(tx, rows);
    });
  }

  getSite(ctx: TenantContext, grants: Grants, siteId: string): Promise<Site> {
    return this.tenantDb.run(ctx, async (tx) => {
      const row = await this.siteInScope(tx, ctx, grants, siteId, 'sites.read');
      const [site] = await this.withGroups(tx, [row]);
      if (!site) throw new NotFoundException(SITE_NOT_FOUND);
      return site;
    });
  }

  createSite(ctx: TenantContext, input: CreateSiteRequest): Promise<Site> {
    return this.tenantDb.run(ctx, async (tx) => {
      const row = await uniqueCode(() =>
        tx
          .insert(sites)
          .values({ ...input, companyId: ctx.companyId })
          .returning()
          .then((rows) => rows[0]),
      );
      if (!row) throw new Error('Création du site impossible');
      await this.audit.write(tx, ctx.companyId, {
        action: 'sites.create',
        resourceType: 'site',
        resourceId: row.id,
        siteId: row.id,
        details: { after: pick(row, SITE_FIELDS) },
      });
      const [site] = await this.withGroups(tx, [row]);
      if (!site) throw new Error('Site introuvable après création');
      return site;
    });
  }

  updateSite(
    ctx: TenantContext,
    grants: Grants,
    siteId: string,
    input: UpdateSiteRequest,
  ): Promise<Site> {
    return this.tenantDb.run(ctx, async (tx) => {
      const before = await this.siteInScope(tx, ctx, grants, siteId, 'sites.update');
      const latitude = input.latitude === undefined ? before.latitude : input.latitude;
      const longitude = input.longitude === undefined ? before.longitude : input.longitude;
      if ((latitude == null) !== (longitude == null)) {
        throw new UnprocessableEntityException('Latitude et longitude vont ensemble');
      }
      const row = await uniqueCode(() =>
        tx
          .update(sites)
          .set(input)
          .where(and(eq(sites.id, siteId), eq(sites.companyId, ctx.companyId)))
          .returning()
          .then((rows) => rows[0]),
      );
      if (!row) throw new NotFoundException(SITE_NOT_FOUND);
      const changes = diff(before, row, SITE_FIELDS);
      if (Object.keys(changes).length > 0) {
        await this.audit.write(tx, ctx.companyId, {
          action: 'sites.update',
          resourceType: 'site',
          resourceId: siteId,
          siteId,
          details: { site: row.code, changes },
        });
      }
      const [site] = await this.withGroups(tx, [row]);
      if (!site) throw new NotFoundException(SITE_NOT_FOUND);
      return site;
    });
  }

  /**
   * Suppression logique (la trace reste dans le journal d'audit) : le site disparaît des
   * groupes et des portées de rôles ; son code redevient disponible.
   */
  deleteSite(ctx: TenantContext, grants: Grants, siteId: string): Promise<void> {
    return this.tenantDb.run(ctx, async (tx) => {
      const before = await this.siteInScope(tx, ctx, grants, siteId, 'sites.delete');
      await tx.delete(siteGroupMembers).where(eq(siteGroupMembers.siteId, siteId));
      await tx.delete(membershipRoleSites).where(eq(membershipRoleSites.siteId, siteId));
      await tx
        .update(sites)
        .set({ deletedAt: new Date(), status: 'INACTIVE' })
        .where(and(eq(sites.id, siteId), eq(sites.companyId, ctx.companyId)));
      await this.audit.write(tx, ctx.companyId, {
        action: 'sites.delete',
        resourceType: 'site',
        resourceId: siteId,
        siteId,
        details: { before: pick(before, SITE_FIELDS) },
      });
    });
  }

  // --- Groupes de sites -------------------------------------------------------

  listGroups(ctx: TenantContext): Promise<SiteGroup[]> {
    return this.tenantDb.run(ctx, async (tx) => {
      const rows = await tx
        .select()
        .from(siteGroups)
        .where(eq(siteGroups.companyId, ctx.companyId))
        .orderBy(asc(siteGroups.name));
      return this.groupViews(tx, rows);
    });
  }

  getGroup(ctx: TenantContext, groupId: string): Promise<SiteGroup> {
    return this.tenantDb.run(ctx, async (tx) => {
      const row = await this.group(tx, ctx, groupId);
      const [view] = await this.groupViews(tx, [row]);
      if (!view) throw new NotFoundException(GROUP_NOT_FOUND);
      return view;
    });
  }

  createGroup(ctx: TenantContext, input: CreateSiteGroupRequest): Promise<SiteGroup> {
    return this.tenantDb.run(ctx, async (tx) => {
      const row = await uniqueCode(() =>
        tx
          .insert(siteGroups)
          .values({
            companyId: ctx.companyId,
            name: input.name,
            code: input.code,
            description: input.description ?? null,
          })
          .returning()
          .then((rows) => rows[0]),
      );
      if (!row) throw new Error('Création du groupe impossible');
      const added = await this.addMembers(tx, ctx, row.id, input.siteIds);
      await this.audit.write(tx, ctx.companyId, {
        action: 'site_groups.create',
        resourceType: 'site_group',
        resourceId: row.id,
        details: { name: row.name, code: row.code, sites: added },
      });
      const [view] = await this.groupViews(tx, [row]);
      if (!view) throw new Error('Groupe introuvable après création');
      return view;
    });
  }

  updateGroup(
    ctx: TenantContext,
    groupId: string,
    input: UpdateSiteGroupRequest,
  ): Promise<SiteGroup> {
    return this.tenantDb.run(ctx, async (tx) => {
      const before = await this.group(tx, ctx, groupId);
      const row = await uniqueCode(() =>
        tx
          .update(siteGroups)
          .set(input)
          .where(and(eq(siteGroups.id, groupId), eq(siteGroups.companyId, ctx.companyId)))
          .returning()
          .then((rows) => rows[0]),
      );
      if (!row) throw new NotFoundException(GROUP_NOT_FOUND);
      await this.audit.write(tx, ctx.companyId, {
        action: 'site_groups.update',
        resourceType: 'site_group',
        resourceId: groupId,
        details: { changes: diff(before, row, ['name', 'code', 'description']) },
      });
      const [view] = await this.groupViews(tx, [row]);
      if (!view) throw new NotFoundException(GROUP_NOT_FOUND);
      return view;
    });
  }

  deleteGroup(ctx: TenantContext, groupId: string): Promise<void> {
    return this.tenantDb.run(ctx, async (tx) => {
      const before = await this.group(tx, ctx, groupId);
      await tx
        .delete(siteGroups)
        .where(and(eq(siteGroups.id, groupId), eq(siteGroups.companyId, ctx.companyId)));
      await this.audit.write(tx, ctx.companyId, {
        action: 'site_groups.delete',
        resourceType: 'site_group',
        resourceId: groupId,
        details: { name: before.name, code: before.code },
      });
    });
  }

  addGroupSites(ctx: TenantContext, groupId: string, siteIds: string[]): Promise<SiteGroup> {
    return this.tenantDb.run(ctx, async (tx) => {
      const group = await this.group(tx, ctx, groupId);
      const added = await this.addMembers(tx, ctx, groupId, siteIds);
      await this.audit.write(tx, ctx.companyId, {
        action: 'site_groups.add_sites',
        resourceType: 'site_group',
        resourceId: groupId,
        details: { group: group.code, sites: added },
      });
      const [view] = await this.groupViews(tx, [group]);
      if (!view) throw new NotFoundException(GROUP_NOT_FOUND);
      return view;
    });
  }

  removeGroupSites(ctx: TenantContext, groupId: string, siteIds: string[]): Promise<SiteGroup> {
    return this.tenantDb.run(ctx, async (tx) => {
      const group = await this.group(tx, ctx, groupId);
      const removed = await tx
        .delete(siteGroupMembers)
        .where(
          and(
            eq(siteGroupMembers.companyId, ctx.companyId),
            eq(siteGroupMembers.groupId, groupId),
            inArray(siteGroupMembers.siteId, siteIds),
          ),
        )
        .returning({ siteId: siteGroupMembers.siteId });
      await this.audit.write(tx, ctx.companyId, {
        action: 'site_groups.remove_sites',
        resourceType: 'site_group',
        resourceId: groupId,
        details: { group: group.code, sites: removed.map((r) => r.siteId) },
      });
      const [view] = await this.groupViews(tx, [group]);
      if (!view) throw new NotFoundException(GROUP_NOT_FOUND);
      return view;
    });
  }

  // ---------------------------------------------------------------------------

  /** Site de l'entreprise, non supprimé, dans la portée de la permission ; sinon 404. */
  private async siteInScope(
    tx: TenantTransaction,
    ctx: TenantContext,
    grants: Grants,
    siteId: string,
    permission: 'sites.read' | 'sites.update' | 'sites.delete',
  ): Promise<SiteRow> {
    const [row] = await tx
      .select()
      .from(sites)
      .where(
        and(eq(sites.id, siteId), eq(sites.companyId, ctx.companyId), isNull(sites.deletedAt)),
      );
    if (!row || !grants.hasForSite('sites.read', siteId)) {
      throw new NotFoundException(SITE_NOT_FOUND);
    }
    // Site visible mais action non autorisée sur ce site : 403 (l'existence est déjà connue).
    if (!grants.hasForSite(permission, siteId)) {
      throw new ForbiddenException(
        "Vous n'avez pas la permission d'effectuer cette action sur ce site",
      );
    }
    return row;
  }

  private async group(tx: TenantTransaction, ctx: TenantContext, groupId: string) {
    const [row] = await tx
      .select()
      .from(siteGroups)
      .where(and(eq(siteGroups.id, groupId), eq(siteGroups.companyId, ctx.companyId)));
    if (!row) throw new NotFoundException(GROUP_NOT_FOUND);
    return row;
  }

  /** Ajoute des sites (existants, de l'entreprise) à un groupe ; doublons ignorés. */
  private async addMembers(
    tx: TenantTransaction,
    ctx: TenantContext,
    groupId: string,
    siteIds: string[],
  ): Promise<string[]> {
    const unique = [...new Set(siteIds)];
    if (unique.length === 0) return [];
    const found = await tx
      .select({ id: sites.id })
      .from(sites)
      .where(
        and(eq(sites.companyId, ctx.companyId), inArray(sites.id, unique), isNull(sites.deletedAt)),
      );
    if (found.length !== unique.length) throw new UnprocessableEntityException('Site inconnu');
    await tx
      .insert(siteGroupMembers)
      .values(unique.map((siteId) => ({ companyId: ctx.companyId, groupId, siteId })))
      .onConflictDoNothing();
    return unique;
  }

  private async withGroups(tx: TenantTransaction, rows: SiteRow[]): Promise<Site[]> {
    const ids = rows.map((row) => row.id);
    const memberships = ids.length
      ? await tx
          .select({ siteId: siteGroupMembers.siteId, id: siteGroups.id, name: siteGroups.name })
          .from(siteGroupMembers)
          .innerJoin(siteGroups, eq(siteGroups.id, siteGroupMembers.groupId))
          .where(inArray(siteGroupMembers.siteId, ids))
          .orderBy(asc(siteGroups.name))
      : [];
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      code: row.code,
      description: row.description,
      address: row.address,
      city: row.city,
      country: row.country,
      latitude: row.latitude,
      longitude: row.longitude,
      timezone: row.timezone,
      phone: row.phone,
      contactName: row.contactName,
      status: row.status as Site['status'],
      metadata: row.metadata,
      groups: memberships.filter((m) => m.siteId === row.id).map(({ id, name }) => ({ id, name })),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    }));
  }

  private async groupViews(
    tx: TenantTransaction,
    rows: (typeof siteGroups.$inferSelect)[],
  ): Promise<SiteGroup[]> {
    const ids = rows.map((row) => row.id);
    const members = ids.length
      ? await tx
          .select({
            groupId: siteGroupMembers.groupId,
            id: sites.id,
            name: sites.name,
            code: sites.code,
          })
          .from(siteGroupMembers)
          .innerJoin(sites, eq(sites.id, siteGroupMembers.siteId))
          .where(and(inArray(siteGroupMembers.groupId, ids), isNull(sites.deletedAt)))
          .orderBy(asc(sites.name))
      : [];
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      code: row.code,
      description: row.description,
      sites: members
        .filter((m) => m.groupId === row.id)
        .map(({ id, name, code }) => ({ id, name, code })),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    }));
  }
}

/** Traduit la violation d'unicité du code en 409 explicite. */
async function uniqueCode<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    const cause = (error as { cause?: { code?: string }; code?: string } | undefined) ?? {};
    if (cause.code === '23505' || cause.cause?.code === '23505') {
      throw new ConflictException('Ce code est déjà utilisé dans votre entreprise');
    }
    throw error;
  }
}

function pick(row: Record<string, unknown>, fields: readonly string[]) {
  return Object.fromEntries(fields.map((field) => [field, row[field]]));
}
