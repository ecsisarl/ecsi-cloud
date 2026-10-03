/**
 * Rôles d'ECSI CLOUD (cahier des charges §5).
 *
 * SUPER_ADMIN est un rôle de la PLATEFORME ECSI : il n'existe pas dans les entreprises
 * (table platform_admins séparée, connexion distincte). Aucun utilisateur d'entreprise ne
 * peut l'obtenir par invitation ou par attribution de rôle.
 */
export const SYSTEM_ROLES = [
  'SUPER_ADMIN',
  'ADMIN_ENTREPRISE',
  'GERANT',
  'TECHNICIEN',
  'VENDEUR',
  'COMPTABLE',
  'SUPPORT',
] as const;
export type SystemRole = (typeof SYSTEM_ROLES)[number];

/** Rôles système créés dans chaque entreprise (tous sauf SUPER_ADMIN). */
export const COMPANY_SYSTEM_ROLES = [
  'ADMIN_ENTREPRISE',
  'GERANT',
  'TECHNICIEN',
  'VENDEUR',
  'COMPTABLE',
  'SUPPORT',
] as const satisfies readonly SystemRole[];
export type CompanySystemRole = (typeof COMPANY_SYSTEM_ROLES)[number];

/** Rôles pour lesquels l'authentification à deux facteurs est obligatoire. */
export const MFA_REQUIRED_ROLES: readonly SystemRole[] = ['SUPER_ADMIN', 'ADMIN_ENTREPRISE'];

/** Portée d'une attribution de rôle : toute l'entreprise ou une liste de sites. */
export const ROLE_SCOPES = ['COMPANY', 'SITES'] as const;
export type RoleScope = (typeof ROLE_SCOPES)[number];

export function isCompanySystemRole(code: string): code is CompanySystemRole {
  return (COMPANY_SYSTEM_ROLES as readonly string[]).includes(code);
}
