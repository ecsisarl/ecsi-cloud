import type { Permission } from '@ecsi/shared';
import {
  Activity,
  Building2,
  BarChart3,
  Bell,
  CreditCard,
  LayoutDashboard,
  type LucideIcon,
  MapPin,
  Palette,
  Receipt,
  Router,
  ScrollText,
  Store,
  Ticket,
  Users,
  UserSquare2,
  Waypoints,
  Wifi,
} from 'lucide-react';

export interface NavItem {
  /** Clé de traduction sous « nav ». */
  key: string;
  href: string;
  icon: LucideIcon;
  /** Sprint de livraison prévu (affiché tant que le module n'existe pas). */
  plannedSprint?: string;
  /** Permission nécessaire (sur au moins un site) pour afficher l'entrée. */
  permission?: Permission;
}

export interface NavGroup {
  key: 'main' | 'network' | 'admin';
  items: NavItem[];
}

/**
 * Navigation principale. Les fonctions du quotidien (exploitant non technicien) sont
 * dans « Activité » ; les fonctions techniques sont regroupées dans « Réseau » et
 * « Administration ».
 */
export const NAVIGATION: NavGroup[] = [
  {
    key: 'main',
    items: [
      { key: 'dashboard', href: '/', icon: LayoutDashboard },
      { key: 'sales', href: '/ventes', icon: Receipt, plannedSprint: 'S8' },
      { key: 'tickets', href: '/tickets', icon: Ticket, plannedSprint: 'S6' },
      { key: 'plans', href: '/forfaits', icon: CreditCard, plannedSprint: 'S6' },
      { key: 'vendors', href: '/vendeurs', icon: Store, plannedSprint: 'S8' },
      { key: 'clients', href: '/clients', icon: UserSquare2, plannedSprint: 'S7' },
      { key: 'sites', href: '/sites', icon: MapPin, permission: 'sites.read' },
      {
        key: 'siteGroups',
        href: '/groupes-de-sites',
        icon: Waypoints,
        permission: 'site_groups.read',
      },
      { key: 'reports', href: '/rapports', icon: BarChart3, plannedSprint: 'S9' },
    ],
  },
  {
    key: 'network',
    items: [
      { key: 'routers', href: '/reseau/routeurs', icon: Router, permission: 'routers.read' },
      { key: 'hotspots', href: '/reseau/hotspots', icon: Wifi, plannedSprint: 'S5' },
      { key: 'monitoring', href: '/reseau/monitoring', icon: Activity, plannedSprint: 'S4' },
    ],
  },
  {
    key: 'admin',
    items: [
      {
        key: 'company',
        href: '/administration/entreprise',
        icon: Building2,
        permission: 'companies.read',
      },
      { key: 'users', href: '/administration/utilisateurs', icon: Users, permission: 'users.read' },
      {
        key: 'notifications',
        href: '/administration/notifications',
        icon: Bell,
        plannedSprint: 'V1.1',
      },
      { key: 'audit', href: '/administration/audit', icon: ScrollText, permission: 'audit.read' },
      { key: 'designSystem', href: '/design-system', icon: Palette },
    ],
  },
];

/** Navigation filtrée selon les permissions de l'utilisateur (groupes vides retirés). */
export function visibleNavigation(permissions: readonly string[]): NavGroup[] {
  const granted = new Set(permissions);
  return NAVIGATION.map((group) => ({
    ...group,
    items: group.items.filter((item) => !item.permission || granted.has(item.permission)),
  })).filter((group) => group.items.length > 0);
}

export function findNavItem(pathname: string): NavItem | undefined {
  return NAVIGATION.flatMap((group) => group.items).find((item) => item.href === pathname);
}

export function isActive(pathname: string, href: string): boolean {
  return href === '/' ? pathname === '/' : pathname === href || pathname.startsWith(`${href}/`);
}
