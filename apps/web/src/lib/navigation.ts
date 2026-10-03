import {
  Activity,
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
  Settings,
  Store,
  Ticket,
  Users,
  UserSquare2,
  Wifi,
} from 'lucide-react';

export interface NavItem {
  /** Clé de traduction sous « nav ». */
  key: string;
  href: string;
  icon: LucideIcon;
  /** Sprint de livraison prévu (affiché tant que le module n'existe pas). */
  plannedSprint?: string;
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
      { key: 'sites', href: '/sites', icon: MapPin, plannedSprint: 'S2' },
      { key: 'reports', href: '/rapports', icon: BarChart3, plannedSprint: 'S9' },
    ],
  },
  {
    key: 'network',
    items: [
      { key: 'mikrotik', href: '/reseau/mikrotik', icon: Router, plannedSprint: 'S3' },
      { key: 'hotspots', href: '/reseau/hotspots', icon: Wifi, plannedSprint: 'S5' },
      { key: 'monitoring', href: '/reseau/monitoring', icon: Activity, plannedSprint: 'S4' },
    ],
  },
  {
    key: 'admin',
    items: [
      { key: 'users', href: '/administration/utilisateurs', icon: Users, plannedSprint: 'S2' },
      {
        key: 'notifications',
        href: '/administration/notifications',
        icon: Bell,
        plannedSprint: 'V1.1',
      },
      { key: 'audit', href: '/administration/audit', icon: ScrollText, plannedSprint: 'S2' },
      { key: 'settings', href: '/administration/parametres', icon: Settings, plannedSprint: 'S2' },
      { key: 'designSystem', href: '/design-system', icon: Palette },
    ],
  },
];

export function findNavItem(pathname: string): NavItem | undefined {
  return NAVIGATION.flatMap((group) => group.items).find((item) => item.href === pathname);
}

export function isActive(pathname: string, href: string): boolean {
  return href === '/' ? pathname === '/' : pathname === href || pathname.startsWith(`${href}/`);
}
