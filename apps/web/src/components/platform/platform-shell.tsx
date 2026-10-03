'use client';

import { cn, Logo } from '@ecsi/ui';
import { Building2, LifeBuoy, LogOut, ScrollText } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import type { ReactNode } from 'react';
import { api, hardNavigate } from '@/lib/client-api';

const LINKS = [
  { href: '/plateforme', key: 'companies', icon: Building2 },
  { href: '/plateforme/audit', key: 'audit', icon: ScrollText },
  { href: '/plateforme/support', key: 'support', icon: LifeBuoy },
] as const;

/**
 * Console SUPER_ADMIN : espace visuellement distinct du dashboard des entreprises
 * (bandeau « Plateforme ECSI »), pour ne jamais confondre les deux domaines.
 */
export function PlatformShell({ adminName, children }: { adminName: string; children: ReactNode }) {
  const t = useTranslations('platformConsole');
  const pathname = usePathname();

  async function logout() {
    await api('/auth/logout', { method: 'POST', retryOnUnauthorized: false });
    hardNavigate('/plateforme/connexion');
  }

  return (
    <div className="min-h-dvh">
      <header className="border-b border-border bg-sidebar text-sidebar-foreground">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3 sm:px-6">
          <div className="flex items-center gap-3">
            <Logo className="text-white" />
            <span className="rounded bg-warning px-2 py-0.5 text-xs font-semibold text-black">
              {t('badge')}
            </span>
          </div>
          <nav aria-label={t('navLabel')} className="flex flex-wrap gap-1">
            {LINKS.map((link) => {
              const active =
                link.href === '/plateforme'
                  ? pathname === '/plateforme' || pathname.startsWith('/plateforme/entreprises')
                  : pathname.startsWith(link.href);
              const Icon = link.icon;
              return (
                <Link
                  key={link.href}
                  href={link.href}
                  aria-current={active ? 'page' : undefined}
                  className={cn(
                    'flex items-center gap-2 rounded-md px-3 py-1.5 text-sm',
                    active
                      ? 'bg-sidebar-active text-white'
                      : 'text-sidebar-foreground/85 hover:bg-white/10',
                  )}
                >
                  <Icon className="size-4" aria-hidden /> {t(`nav.${link.key}`)}
                </Link>
              );
            })}
          </nav>
          <div className="ml-auto flex items-center gap-3 text-sm">
            <span className="hidden text-sidebar-muted sm:inline">{adminName}</span>
            <button
              type="button"
              onClick={() => void logout()}
              className="flex items-center gap-1 rounded-md px-2 py-1 hover:bg-white/10"
            >
              <LogOut className="size-4" aria-hidden /> {t('logout')}
            </button>
          </div>
        </div>
      </header>
      <main className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-6 lg:py-8">{children}</main>
    </div>
  );
}
