import type { CompanySystemRole } from './roles.js';

/**
 * Catalogue des permissions granulaires « ressource.action » (cahier des charges §5).
 *
 * Le catalogue est la source de vérité : `pnpm db:migrate` le synchronise dans la table
 * `permissions`, puis recalcule les permissions des rôles système de chaque entreprise.
 * Les permissions des modules futurs sont déclarées dès maintenant (sprint indiqué) afin
 * que les rôles personnalisés puissent être préparés ; elles ne protègent encore aucune route.
 */
export interface PermissionDefinition {
  readonly code: string;
  readonly module: string;
  readonly description: string;
  /** Action sensible : confirmation renforcée et audit systématique. */
  readonly dangerous?: boolean;
  /** Sprint qui livre la fonctionnalité protégée (information). */
  readonly sprint: number;
}

export const PERMISSIONS = [
  // Entreprise et utilisateurs (Sprint 1)
  { code: 'companies.read', module: 'companies', description: "Voir l'entreprise", sprint: 1 },
  {
    code: 'companies.update',
    module: 'companies',
    description: "Modifier l'entreprise",
    sprint: 2,
  },
  { code: 'users.read', module: 'users', description: 'Voir les utilisateurs', sprint: 1 },
  { code: 'users.invite', module: 'users', description: 'Inviter des utilisateurs', sprint: 1 },
  {
    code: 'users.update',
    module: 'users',
    description: 'Modifier les rôles des utilisateurs',
    sprint: 1,
  },
  {
    code: 'users.disable',
    module: 'users',
    description: 'Désactiver des utilisateurs',
    dangerous: true,
    sprint: 1,
  },
  {
    code: 'users.remove',
    module: 'users',
    description: "Retirer l'accès d'un utilisateur à l'entreprise",
    dangerous: true,
    sprint: 2,
  },
  {
    code: 'users.mfa.reset',
    module: 'users',
    description: "Réinitialiser la double authentification d'un utilisateur",
    dangerous: true,
    sprint: 2,
  },
  { code: 'roles.read', module: 'roles', description: 'Voir les rôles et permissions', sprint: 1 },
  {
    code: 'roles.manage',
    module: 'roles',
    description: 'Gérer les rôles personnalisés',
    dangerous: true,
    sprint: 2,
  },
  // Sites et réseau
  { code: 'sites.read', module: 'sites', description: 'Voir les sites', sprint: 2 },
  { code: 'sites.create', module: 'sites', description: 'Créer des sites', sprint: 2 },
  { code: 'sites.update', module: 'sites', description: 'Modifier des sites', sprint: 2 },
  {
    code: 'sites.delete',
    module: 'sites',
    description: 'Supprimer des sites',
    dangerous: true,
    sprint: 2,
  },
  {
    code: 'site_groups.read',
    module: 'site_groups',
    description: 'Voir les groupes de sites',
    sprint: 2,
  },
  {
    code: 'site_groups.manage',
    module: 'site_groups',
    description: 'Gérer les groupes de sites',
    sprint: 2,
  },
  { code: 'routers.read', module: 'routers', description: 'Voir les routeurs', sprint: 3 },
  { code: 'routers.create', module: 'routers', description: 'Enrôler des routeurs', sprint: 3 },
  { code: 'routers.update', module: 'routers', description: 'Modifier des routeurs', sprint: 3 },
  {
    code: 'routers.delete',
    module: 'routers',
    description: 'Retirer des routeurs',
    dangerous: true,
    sprint: 3,
  },
  {
    code: 'routers.command',
    module: 'routers',
    description: 'Exécuter des commandes de diagnostic',
    sprint: 3,
  },
  {
    code: 'routers.command.dangerous',
    module: 'routers',
    description: 'Exécuter des commandes sensibles (redémarrage, configuration)',
    dangerous: true,
    sprint: 3,
  },
  { code: 'hotspots.read', module: 'hotspots', description: 'Voir les hotspots', sprint: 4 },
  {
    code: 'hotspots.manage',
    module: 'hotspots',
    description: 'Configurer les hotspots et le portail',
    sprint: 4,
  },
  { code: 'monitoring.read', module: 'monitoring', description: 'Voir la supervision', sprint: 3 },
  // Offres, tickets, clients
  { code: 'plans.read', module: 'plans', description: 'Voir les forfaits', sprint: 4 },
  { code: 'plans.manage', module: 'plans', description: 'Gérer les forfaits', sprint: 4 },
  { code: 'vouchers.read', module: 'vouchers', description: 'Voir les tickets', sprint: 5 },
  { code: 'vouchers.generate', module: 'vouchers', description: 'Générer des tickets', sprint: 5 },
  {
    code: 'vouchers.assign',
    module: 'vouchers',
    description: 'Attribuer des tickets aux vendeurs',
    sprint: 5,
  },
  {
    code: 'vouchers.disable',
    module: 'vouchers',
    description: 'Désactiver des tickets',
    dangerous: true,
    sprint: 5,
  },
  {
    code: 'vouchers.export',
    module: 'vouchers',
    description: 'Exporter et imprimer des tickets',
    sprint: 5,
  },
  {
    code: 'clients.read',
    module: 'clients',
    description: 'Voir les clients et sessions',
    sprint: 5,
  },
  {
    code: 'clients.disconnect',
    module: 'clients',
    description: 'Déconnecter un client',
    sprint: 5,
  },
  // Ventes et finances
  { code: 'vendors.read', module: 'vendors', description: 'Voir les vendeurs', sprint: 6 },
  { code: 'vendors.manage', module: 'vendors', description: 'Gérer les vendeurs', sprint: 6 },
  { code: 'sales.read', module: 'sales', description: 'Voir les ventes', sprint: 6 },
  { code: 'sales.create', module: 'sales', description: 'Enregistrer des ventes', sprint: 6 },
  {
    code: 'sales.cancel',
    module: 'sales',
    description: 'Annuler des ventes',
    dangerous: true,
    sprint: 6,
  },
  { code: 'cash.close', module: 'cash', description: 'Clôturer une caisse', sprint: 6 },
  {
    code: 'cash.validate',
    module: 'cash',
    description: 'Valider une clôture de caisse',
    sprint: 6,
  },
  { code: 'payments.read', module: 'payments', description: 'Voir les paiements', sprint: 8 },
  {
    code: 'payments.refund',
    module: 'payments',
    description: 'Rembourser un paiement',
    dangerous: true,
    sprint: 8,
  },
  // Pilotage et administration
  { code: 'reports.read', module: 'reports', description: 'Voir les rapports', sprint: 7 },
  { code: 'reports.export', module: 'reports', description: 'Exporter les rapports', sprint: 7 },
  {
    code: 'notifications.manage',
    module: 'notifications',
    description: 'Gérer les notifications',
    sprint: 7,
  },
  { code: 'audit.read', module: 'audit', description: "Consulter le journal d'audit", sprint: 2 },
  { code: 'settings.read', module: 'settings', description: 'Voir les paramètres', sprint: 2 },
  {
    code: 'settings.manage',
    module: 'settings',
    description: 'Modifier les paramètres',
    dangerous: true,
    sprint: 2,
  },
] as const satisfies readonly PermissionDefinition[];

export type Permission = (typeof PERMISSIONS)[number]['code'];

export const PERMISSION_CODES: readonly Permission[] = PERMISSIONS.map((p) => p.code);

export function isPermission(code: string): code is Permission {
  return (PERMISSION_CODES as readonly string[]).includes(code);
}

const ALL = PERMISSION_CODES;
const readOnly = (prefixes: readonly string[]): Permission[] =>
  ALL.filter((code) => code.endsWith('.read') && prefixes.some((p) => code.startsWith(`${p}.`)));

/**
 * Matrice par défaut des rôles système d'entreprise. Ces rôles ne sont pas modifiables par
 * les entreprises (is_system) ; les rôles personnalisés arrivent avec roles.manage.
 */
export const DEFAULT_ROLE_PERMISSIONS: Readonly<Record<CompanySystemRole, readonly Permission[]>> =
  {
    ADMIN_ENTREPRISE: ALL,
    GERANT: ALL.filter(
      (code) =>
        ![
          'companies.update',
          'roles.manage',
          'settings.manage',
          'payments.refund',
          'routers.command.dangerous',
          'routers.delete',
          'sites.delete',
          'users.mfa.reset',
        ].includes(code),
    ),
    TECHNICIEN: [
      ...readOnly([
        'sites',
        'site_groups',
        'routers',
        'hotspots',
        'monitoring',
        'plans',
        'clients',
        'vouchers',
      ]),
      'routers.create',
      'routers.update',
      'routers.command',
      'hotspots.manage',
      'clients.disconnect',
    ],
    VENDEUR: [
      'sites.read',
      'vouchers.read',
      'sales.read',
      'sales.create',
      'cash.close',
      'clients.read',
      'plans.read',
    ],
    COMPTABLE: [
      ...readOnly([
        'sales',
        'payments',
        'reports',
        'vendors',
        'vouchers',
        'plans',
        'sites',
        'site_groups',
      ]),
      'cash.validate',
      'reports.export',
      'audit.read',
    ],
    SUPPORT: [
      ...readOnly([
        'users',
        'sites',
        'site_groups',
        'routers',
        'hotspots',
        'monitoring',
        'clients',
        'vouchers',
        'plans',
      ]),
      'clients.disconnect',
    ],
  };

/** Libellés français des rôles système (l'interface passe par l'i18n). */
export const ROLE_LABELS: Readonly<Record<CompanySystemRole, string>> = {
  ADMIN_ENTREPRISE: 'Administrateur entreprise',
  GERANT: 'Gérant',
  TECHNICIEN: 'Technicien',
  VENDEUR: 'Vendeur',
  COMPTABLE: 'Comptable',
  SUPPORT: 'Support',
};
