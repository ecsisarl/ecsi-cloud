/**
 * Rôles système d'ECSI CLOUD (cahier des charges §5). Les permissions associées
 * et la portée par site sont définies au Sprint 1 (RBAC).
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

/** Rôles pour lesquels l'authentification à deux facteurs est obligatoire. */
export const MFA_REQUIRED_ROLES: readonly SystemRole[] = ['SUPER_ADMIN', 'ADMIN_ENTREPRISE'];
