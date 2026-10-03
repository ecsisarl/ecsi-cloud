import { Injectable } from '@nestjs/common';
import { isPermission, type Permission } from '@ecsi/shared';
import { and, eq, inArray } from 'drizzle-orm';
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
   * Anti-escalade appliquée à un autre membre : on ne peut agir sur lui que si l'on détient
   * chacune de ses permissions, sur la même portée (entreprise, ou chacun de ses sites).
   */
  covers(target: Grants): boolean {
    for (const permission of target.companyWide) {
      if (!this.hasCompanyWide(permission)) return false;
    }
    for (const [site, set] of target.bySite) {
      for (const permission of set) if (!this.hasForSite(permission, site)) return false;
    }
    return true;
  }

  /**
   * Permission d'agir sur un membre (ex. users.update) : pour toute l'entreprise si le membre
   * a une portée entreprise (ou aucun droit), sinon sur chacun des sites où il intervient.
   */
  hasOverMember(permission: Permission, target: Grants): boolean {
    if (this.hasCompanyWide(permission)) return true;
    if (target.companyWide.size > 0 || target.bySite.size === 0) return false;
    return [...target.bySite.keys()].every((site) => this.hasForSite(permission, site));
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
  /**
   * Droits de plusieurs membres (gestion des utilisateurs), quel que soit leur statut : un
   * membre désactivé conserve ses rôles, et l'anti-escalade doit en tenir compte.
   */
  async resolveMany(
    tx: TenantTransaction,
    companyId: string,
    userIds?: readonly string[],
  ): Promise<Map<string, Grants>> {
    const rows = await tx
      .select({
        userId: memberships.userId,
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
          eq(memberships.companyId, companyId),
          userIds ? inArray(memberships.userId, [...userIds]) : undefined,
        ),
      );
    const siteRows = await tx
      .select({
        membershipRoleId: membershipRoleSites.membershipRoleId,
        siteId: membershipRoleSites.siteId,
      })
      .from(membershipRoleSites)
      .where(eq(membershipRoleSites.companyId, companyId));
    const sitesByAssignment = new Map<string, string[]>();
    for (const row of siteRows) {
      const list = sitesByAssignment.get(row.membershipRoleId) ?? [];
      list.push(row.siteId);
      sitesByAssignment.set(row.membershipRoleId, list);
    }
    const byUser = new Map<string, typeof rows>();
    for (const row of rows) {
      const list = byUser.get(row.userId) ?? [];
      list.push(row);
      byUser.set(row.userId, list);
    }
    const result = new Map<string, Grants>();
    for (const [userId, userRows] of byUser) {
      result.set(userId, buildGrants(userRows, sitesByAssignment));
    }
    for (const userId of userIds ?? []) if (!result.has(userId)) result.set(userId, Grants.empty());
    return result;
  }

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

    return buildGrants(rows, sitesByAssignment);
  }
}

function buildGrants(
  rows: readonly {
    membershipRoleId: string;
    roleCode: string;
    scope: string;
    permission: string | null;
  }[],
  sitesByAssignment: ReadonlyMap<string, string[]>,
): Grants {
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
