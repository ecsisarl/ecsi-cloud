'use client';

import type { MeResponse } from '@ecsi/shared';
import { ChevronUp, KeyRound, LogOut, MonitorSmartphone } from 'lucide-react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { api, hardNavigate } from '@/lib/client-api';

/** Compte connecté (bas de la barre latérale) : entreprise active, sécurité, déconnexion. */
export function UserPanel({ me }: { me: MeResponse }) {
  const t = useTranslations('userMenu');
  const [open, setOpen] = useState(false);

  async function logout() {
    await api('/auth/logout', { method: 'POST', retryOnUnauthorized: false });
    hardNavigate('/connexion');
  }

  async function switchCompany(companyId: string) {
    const result = await api('/auth/switch-company', { method: 'POST', body: { companyId } });
    if (result.ok) hardNavigate('/');
  }

  return (
    <div className="border-t border-white/10 p-3">
      {open ? (
        <div className="mb-2 flex flex-col gap-1 rounded-md bg-white/5 p-2 text-sm">
          {me.companies.length > 1 ? (
            <label className="flex flex-col gap-1 px-2 py-1 text-xs text-sidebar-muted">
              {t('switchCompany')}
              <select
                className="rounded bg-sidebar px-2 py-1 text-sm text-white"
                value={me.company?.id ?? ''}
                onChange={(event) => void switchCompany(event.target.value)}
              >
                {me.companies.map((company) => (
                  <option key={company.id} value={company.id}>
                    {company.name}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <Link
            href="/securite/2fa"
            className="flex items-center gap-2 rounded px-2 py-1.5 hover:bg-white/10"
          >
            <KeyRound className="size-4" aria-hidden /> {t('security2fa')}
          </Link>
          <Link
            href="/securite/sessions"
            className="flex items-center gap-2 rounded px-2 py-1.5 hover:bg-white/10"
          >
            <MonitorSmartphone className="size-4" aria-hidden /> {t('sessions')}
          </Link>
          <button
            type="button"
            onClick={() => void logout()}
            className="flex items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-white/10"
          >
            <LogOut className="size-4" aria-hidden /> {t('logout')}
          </button>
        </div>
      ) : null}
      <button
        type="button"
        aria-expanded={open}
        aria-label={t('open')}
        onClick={() => {
          setOpen((value) => !value);
        }}
        className="flex w-full items-center gap-3 rounded-md px-2 py-2 text-left hover:bg-white/5"
      >
        <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary text-sm font-semibold text-white">
          {me.user.fullName.slice(0, 1).toUpperCase()}
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-sm font-medium text-white" data-testid="user-name">
            {me.user.fullName}
          </span>
          <span className="truncate text-xs text-sidebar-muted" data-testid="company-name">
            {me.company?.name ?? '—'}
          </span>
        </span>
        <ChevronUp
          className={`size-4 transition-transform ${open ? '' : 'rotate-180'}`}
          aria-hidden
        />
      </button>
    </div>
  );
}
