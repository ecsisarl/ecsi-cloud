'use client';

import type { SessionSummary } from '@ecsi/shared';
import { Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle } from '@ecsi/ui';
import { Monitor } from 'lucide-react';
import { useFormatter, useTranslations } from 'next-intl';
import { useCallback, useEffect, useState } from 'react';
import { FormMessage } from '@/components/auth/form';
import { api, hardNavigate } from '@/lib/client-api';
import { describeUserAgent } from './user-agent';

export function SessionsManager() {
  const t = useTranslations('security.sessions');
  const tAuth = useTranslations('auth');
  const format = useFormatter();
  const [sessions, setSessions] = useState<SessionSummary[] | null>(null);
  const [message, setMessage] = useState<{ tone: 'error' | 'success'; text: string } | null>(null);

  const load = useCallback(async () => {
    const result = await api<SessionSummary[]>('/auth/sessions');
    if (result.ok) setSessions(result.data);
    else if (result.status === 401) hardNavigate('/connexion');
    else setMessage({ tone: 'error', text: tAuth('genericError') });
  }, [tAuth]);

  useEffect(() => {
    // Chargement initial des sessions depuis l'API.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  async function revoke(session: SessionSummary) {
    const result = await api(`/auth/sessions/${session.id}`, { method: 'DELETE' });
    if (session.current && result.ok) {
      hardNavigate('/connexion');
      return;
    }
    if (!result.ok) setMessage({ tone: 'error', text: tAuth('genericError') });
    await load();
  }

  async function revokeOthers() {
    const result = await api<{ revoked: number }>('/auth/sessions/revoke-others', {
      method: 'POST',
      body: {},
    });
    setMessage(
      result.ok
        ? { tone: 'success', text: t('revokedOthers', { count: result.data.revoked }) }
        : { tone: 'error', text: tAuth('genericError') },
    );
    await load();
  }

  const date = (iso: string) =>
    format.dateTime(new Date(iso), { dateStyle: 'medium', timeStyle: 'short' });

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('title')}</CardTitle>
        <CardDescription>{t('subtitle')}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {message ? <FormMessage tone={message.tone}>{message.text}</FormMessage> : null}
        {sessions?.length === 0 ? <p className="text-sm text-muted">{t('empty')}</p> : null}
        <ul className="flex flex-col divide-y divide-border" data-testid="sessions-list">
          {sessions?.map((session) => (
            <li key={session.id} className="flex flex-wrap items-center gap-3 py-3">
              <Monitor className="size-5 shrink-0 text-muted" aria-hidden />
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="flex items-center gap-2 text-sm font-medium text-foreground">
                  {describeUserAgent(session.userAgent) ?? t('unknownDevice')}
                  {session.current ? <Badge tone="success">{t('current')}</Badge> : null}
                </span>
                <span className="text-xs text-muted">
                  {session.ip ?? '—'} · {t('lastActive', { date: date(session.lastUsedAt) })} ·{' '}
                  {t('started', { date: date(session.createdAt) })}
                </span>
              </div>
              <Button variant="secondary" size="sm" onClick={() => void revoke(session)}>
                {t('revoke')}
              </Button>
            </li>
          ))}
        </ul>
        {sessions && sessions.length > 1 ? (
          <Button variant="danger" className="self-start" onClick={() => void revokeOthers()}>
            {t('revokeOthers')}
          </Button>
        ) : null}
      </CardContent>
    </Card>
  );
}
