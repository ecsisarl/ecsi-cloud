import { Injectable } from '@nestjs/common';
import { isPermission, type Permission } from '@ecsi/shared';
import { and, eq } from 'drizzle-orm';
import {
  membershipRoleSites,
  membershipRoles,
  memberships,
  rolePermissions,
  roles,
} from '../database/schema/index.js';
import type { TenantContext, TenantTransaction } from './tenant-database.js';

/**
 * Droits effectifs d'un membre dans l'entreprise courante : permissions accordées à toute
 * l'entreprise, et permissions accordées site par site (portée SITES).
 */
export class Grants {
  constructor(
    readonly roles: readonly string[],
    readonly companyWide: ReadonlySet<Permission>,
    readonly bySite: ReadonlyMap<string, ReadonlySet<Permission>>,
  ) {}

  static empty(): Grants {
    return new Grants([], new Set(), new Map());
  }

  /** Permission valable pour toute l'entreprise. */
  hasCompanyWide(permission: Permission): boolean {
    return this.companyWide.has(permission);
  }

  /** Permission valable pour un site donné (portée entreprise ou portée incluant ce site). */
  hasForSite(permission: Permission, siteId: string): boolean {
    return this.companyWide.has(permission) || (this.bySite.get(siteId)?.has(permission) ?? false);
  }

  /** Sites sur lesquels la permission s'applique : 'ALL' ou liste d'identifiants. */
  sitesFor(permission: Permission): 'ALL' | string[] {
    if (this.companyWide.has(permission)) return 'ALL';
    return [...this.bySite].filter(([, set]) => set.has(permission)).map(([site]) => site);
  }

  /** Ensemble de toutes les permissions détenues, quelle que soit la portée. */
  all(): Permission[] {
    const result = new Set(this.companyWide);
    for (const set of this.bySite.values()) for (const p of set) result.add(p);
    return [...result].sort();
  }

  /**
   * Règle anti-escalade : un membre ne peut accorder que des permissions qu'il détient
   * lui-même, sur la même portée (entreprise, ou chacun des sites demandés).
   */
  canGrant(permissions: Iterable<string>, scope: 'COMPANY' | 'SITES', siteIds: string[]): boolean {
    for (const code of permissions) {
      if (!isPermission(code)) return false;
      if (scope === 'COMPANY' && !this.hasCompanyWide(code)) return false;
      if (scope === 'SITES' && !siteIds.every((site) => this.hasForSite(code, site))) return false;
    }
    return true;
  }
}

@Injectable()
export class AccessService {
  /** Lit les droits dans la transaction tenant (donc sous RLS) de la requête. */
  async resolve(tx: TenantTransaction, context: TenantContext): Promise<Grants> {
    const rows = await tx
      .select({
        membershipRoleId: membershipRoles.id,
        roleCode: roles.code,
        scope: membershipRoles.scope,
        permission: rolePermissions.permissionCode,
      })
      .from(membershipRoles)
      .innerJoin(memberships, eq(memberships.id, membershipRoles.membershipId))
      .innerJoin(roles, eq(roles.id, membershipRoles.roleId))
      .leftJoin(rolePermissions, eq(rolePermissions.roleId, roles.id))
      .where(
        and(
          eq(memberships.userId, context.userId),
          eq(memberships.companyId, context.companyId),
          eq(memberships.status, 'ACTIVE'),
        ),
      );
    if (rows.length === 0) return Grants.empty();

    const siteRows = await tx
      .select({
        membershipRoleId: membershipRoleSites.membershipRoleId,
        siteId: membershipRoleSites.siteId,
      })
      .from(membershipRoleSites)
      .innerJoin(membershipRoles, eq(membershipRoles.id, membershipRoleSites.membershipRoleId))
      .innerJoin(memberships, eq(memberships.id, membershipRoles.membershipId))
      .where(
        and(eq(memberships.userId, context.userId), eq(memberships.companyId, context.companyId)),
      );
    const sitesByAssignment = new Map<string, string[]>();
    for (const row of siteRows) {
      const list = sitesByAssignment.get(row.membershipRoleId) ?? [];
      list.push(row.siteId);
      sitesByAssignment.set(row.membershipRoleId, list);
    }

    const roleCodes = new Set<string>();
    const companyWide = new Set<Permission>();
    const bySite = new Map<string, Set<Permission>>();
    for (const row of rows) {
      roleCodes.add(row.roleCode);
      if (!row.permission || !isPermission(row.permission)) continue;
      if (row.scope === 'COMPANY') {
        companyWide.add(row.permission);
      } else {
        for (const site of sitesByAssignment.get(row.membershipRoleId) ?? []) {
          const set = bySite.get(site) ?? new Set<Permission>();
          set.add(row.permission);
          bySite.set(site, set);
        }
      }
    }
    return new Grants([...roleCodes].sort(), companyWide, bySite);
  }
}
