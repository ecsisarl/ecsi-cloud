/**
 * Synchronisation du catalogue des permissions (packages/shared) et des rôles système de
 * chaque entreprise. Exécutée avec le rôle propriétaire après chaque migration : la table
 * `permissions` et les rôles système reflètent toujours le code déployé.
 */
import {
  COMPANY_SYSTEM_ROLES,
  DEFAULT_ROLE_PERMISSIONS,
  PERMISSIONS,
  PERMISSION_CODES,
  ROLE_LABELS,
} from '@ecsi/shared';
import { and, eq, notInArray, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { companies, permissions, rolePermissions, roles } from './schema/index.js';

type Db = Pick<
  NodePgDatabase<Record<string, unknown>>,
  'insert' | 'select' | 'delete' | 'update' | 'execute'
>;

export async function syncPermissionCatalog(db: Db): Promise<void> {
  await db
    .insert(permissions)
    .values(
      PERMISSIONS.map((p) => ({
        code: p.code,
        module: p.module,
        description: p.description,
        isDangerous: 'dangerous' in p ? p.dangerous : false,
      })),
    )
    .onConflictDoUpdate({
      target: permissions.code,
      set: {
        module: sql`excluded.module`,
        description: sql`excluded.description`,
        isDangerous: sql`excluded.is_dangerous`,
      },
    });
}

/** Crée ou met à jour les rôles système d'une entreprise et leurs permissions par défaut. */
export async function ensureSystemRoles(
  db: Db,
  companyId: string,
): Promise<Record<string, string>> {
  const ids: Record<string, string> = {};
  for (const code of COMPANY_SYSTEM_ROLES) {
    const [role] = await db
      .insert(roles)
      .values({ companyId, code, name: ROLE_LABELS[code], isSystem: true })
      .onConflictDoUpdate({
        target: [roles.companyId, roles.code],
        set: { name: ROLE_LABELS[code], isSystem: true },
      })
      .returning({ id: roles.id });
    if (!role) throw new Error(`Rôle ${code} introuvable`);
    ids[code] = role.id;

    const expected = [...DEFAULT_ROLE_PERMISSIONS[code]];
    await db
      .delete(rolePermissions)
      .where(
        and(
          eq(rolePermissions.roleId, role.id),
          notInArray(rolePermissions.permissionCode, expected),
        ),
      );
    await db
      .insert(rolePermissions)
      .values(expected.map((permissionCode) => ({ companyId, roleId: role.id, permissionCode })))
      .onConflictDoNothing();
  }
  return ids;
}

export async function syncCatalog(db: Db): Promise<{ permissions: number; companies: number }> {
  await syncPermissionCatalog(db);
  const all = await db.select({ id: companies.id }).from(companies);
  for (const company of all) await ensureSystemRoles(db, company.id);
  return { permissions: PERMISSION_CODES.length, companies: all.length };
}
