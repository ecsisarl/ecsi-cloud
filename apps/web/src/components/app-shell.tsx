'use client';

import type { MeResponse } from '@ecsi/shared';
import { cn, Logo } from '@ecsi/ui';
import { Bell, Menu, X } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { type ReactNode, useState } from 'react';
import { isActive, visibleNavigation } from '@/lib/navigation';
import { MeProvider } from './me-context';
import { useAlertSummary } from './monitoring/use-alert-summary';
import { UserPanel } from './user-panel';

/** Pastille du nombre d'alertes non acquittées (indicateur de l'entrée Monitoring). */
function AlertCount({ count, className }: { count: number; className?: string }) {
  const t = useTranslations('nav');
  if (count <= 0) return null;
  return (
    <span
      data-testid="alerts-indicator"
      aria-label={t('alertsBadge', { count })}
      title={t('alertsBadge', { count })}
      className={cn(
        'ml-auto inline-flex min-w-5 items-center justify-center rounded-full bg-danger px-1.5 text-xs leading-5 font-semibold text-white tabular-nums',
        className,
      )}
    >
      {count > 99 ? '99+' : count}
    </span>
  );
}

function Sidebar({
  permissions,
  alerts,
  onNavigate,
}: {
  permissions: string[];
  alerts: number;
  onNavigate?: () => void;
}) {
  const t = useTranslations('nav');
  const pathname = usePathname();

  return (
    <nav
      aria-label="Navigation principale"
      className="flex flex-1 flex-col gap-6 overflow-y-auto px-3 py-4"
    >
      {visibleNavigation(permissions).map((group) => (
        <div key={group.key}>
          <p className="px-3 pb-2 text-xs font-semibold tracking-wide text-sidebar-muted uppercase">
            {t(`groups.${group.key}`)}
          </p>
          <ul className="flex flex-col gap-0.5">
            {group.items.map((item) => {
              const active = isActive(pathname, item.href);
              const Icon = item.icon;
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    onClick={onNavigate}
                    aria-current={active ? 'page' : undefined}
                    className={cn(
                      'flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors',
                      active
                        ? 'bg-sidebar-active font-medium text-white'
                        : 'text-sidebar-foreground/85 hover:bg-white/5 hover:text-white',
                    )}
                  >
                    <Icon className="size-4 shrink-0" aria-hidden />
                    {t(item.key)}
                    {item.key === 'monitoring' ? <AlertCount count={alerts} /> : null}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}

export function AppShell({ me, children }: { me: MeResponse; children: ReactNode }) {
  const t = useTranslations('nav');
  const [open, setOpen] = useState(false);
  const summary = useAlertSummary(me.permissions.includes('monitoring.read'));
  const alerts = summary?.unacknowledged ?? 0;

  return (
    <div className="min-h-dvh lg:pl-64">
      {/* Barre latérale fixe sur grand écran */}
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-64 flex-col bg-sidebar text-sidebar-foreground lg:flex">
        <div className="flex h-16 items-center px-6">
          <Logo className="text-white" />
        </div>
        <Sidebar permissions={me.permissions} alerts={alerts} />
        <UserPanel me={me} />
      </aside>

      {/* Tiroir sur mobile et tablette */}
      {open ? (
        <div className="fixed inset-0 z-40 lg:hidden">
          <button
            type="button"
            aria-label={t('closeMenu')}
            className="absolute inset-0 bg-black/40"
            onClick={() => {
              setOpen(false);
            }}
          />
          <aside className="relative flex h-full w-72 max-w-[85vw] flex-col bg-sidebar text-sidebar-foreground">
            <div className="flex h-16 items-center justify-between px-5">
              <Logo className="text-white" />
              <button
                type="button"
                aria-label={t('closeMenu')}
                className="rounded-md p-2 hover:bg-white/10"
                onClick={() => {
                  setOpen(false);
                }}
              >
                <X className="size-5" aria-hidden />
              </button>
            </div>
            <Sidebar
              permissions={me.permissions}
              alerts={alerts}
              onNavigate={() => {
                setOpen(false);
              }}
            />
            <UserPanel me={me} />
          </aside>
        </div>
      ) : null}

      <header className="sticky top-0 z-20 flex h-16 items-center gap-3 border-b border-border bg-surface/90 px-4 backdrop-blur lg:hidden">
        <button
          type="button"
          aria-label={t('openMenu')}
          className="rounded-md p-2 hover:bg-surface-muted"
          onClick={() => {
            setOpen(true);
          }}
        >
          <Menu className="size-5" aria-hidden />
        </button>
        <Logo />
        {alerts > 0 ? (
          <Link
            href="/reseau/monitoring"
            className="ml-auto flex items-center gap-1 rounded-md p-2 text-danger hover:bg-surface-muted"
            aria-label={t('alertsBadge', { count: alerts })}
          >
            <Bell className="size-5" aria-hidden />
            <AlertCount count={alerts} className="ml-0" />
          </Link>
        ) : null}
      </header>

      <main className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
        <MeProvider me={me}>{children}</MeProvider>
      </main>
    </div>
  );
}
