'use client';

import { Badge, type BadgeTone, Button } from '@ecsi/ui';
import { Check, Copy, KeyRound } from 'lucide-react';
import { useFormatter, useTranslations } from 'next-intl';
import { useCallback, useEffect, useState } from 'react';
import { FormMessage } from '@/components/auth/form';
import { useProblemMessage } from '@/components/admin/controls';
import { usePermissions } from '@/components/me-context';
import { api } from '@/lib/client-api';

/**
 * Contrat du module routeurs (GET / POST /routers/:id/config-access) : mêmes formes que
 * RouterConfigAccess / RouterConfigAccessScript de @ecsi/shared (branche RouterOS) ; à
 * remplacer par l'import partagé lors de la fusion.
 */
type ConfigAccessStatus = 'NONE' | 'PENDING' | 'ACTIVE';
interface ConfigAccess {
  status: ConfigAccessStatus;
  activatedAt: string | null;
  expiresAt: string | null;
}
interface ConfigAccessScript {
  script: string;
  expiresAt: string;
}

const TONE: Record<ConfigAccessStatus, BadgeTone> = {
  NONE: 'neutral',
  PENDING: 'warning',
  ACTIVE: 'success',
};

/**
 * Accès de configuration du routeur (compte RouterOS d'écriture utilisé par le worker pour
 * appliquer le hotspot). Le script à coller dans le terminal RouterOS est affiché UNE seule
 * fois, gardé dans l'état de ce composant seulement, et disparaît à la fermeture.
 */
export function ConfigAccessPanel({ routerId }: { routerId: string }) {
  const t = useTranslations('hotspots.access');
  const format = useFormatter();
  const permissions = usePermissions();
  const problemMessage = useProblemMessage();
  const [access, setAccess] = useState<ConfigAccess | 'unavailable' | null>(null);
  const [script, setScript] = useState<ConfigAccessScript | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const load = useCallback(async () => {
    const result = await api<ConfigAccess>(`/routers/${routerId}/config-access`);
    if (result.ok) setAccess(result.data);
    else if (result.status === 404 || result.status === 501) setAccess('unavailable');
    else setError(problemMessage(result.status, result.problem));
  }, [routerId, problemMessage]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  async function generate() {
    setPending(true);
    setError(null);
    const result = await api<ConfigAccessScript>(`/routers/${routerId}/config-access`, {
      method: 'POST',
      cache: 'no-store',
    });
    setPending(false);
    if (result.ok) {
      setScript(result.data);
      setCopied(false);
      void load();
    } else if (result.status === 404) setAccess('unavailable');
    else setError(problemMessage(result.status, result.problem));
  }

  async function copy() {
    if (!script) return;
    await navigator.clipboard.writeText(script.script);
    setCopied(true);
  }

  const date = (value: string | null) =>
    value ? format.dateTime(new Date(value), { dateStyle: 'short', timeStyle: 'short' }) : '—';

  return (
    <div
      className="flex flex-col gap-3 rounded-md border border-border p-3 text-sm"
      data-testid="config-access"
    >
      <div className="flex flex-wrap items-center gap-2">
        <KeyRound className="size-4 text-muted" aria-hidden />
        <span className="font-medium text-foreground">{t('title')}</span>
        {access === 'unavailable' ? (
          <Badge tone="neutral">{t('unavailable')}</Badge>
        ) : access ? (
          <Badge tone={TONE[access.status]} dot>
            {t(`statuses.${access.status}`)}
          </Badge>
        ) : null}
      </div>
      {access === 'unavailable' ? (
        <p className="text-muted">{t('unavailableDescription')}</p>
      ) : access ? (
        <>
          <p className="text-muted">{t(`descriptions.${access.status}`)}</p>
          {access.activatedAt ? (
            <p className="text-muted">{t('activatedAt', { at: date(access.activatedAt) })}</p>
          ) : null}
          {access.expiresAt ? (
            <p className="text-muted">{t('expiresAt', { at: date(access.expiresAt) })}</p>
          ) : null}
        </>
      ) : null}
      {error ? <FormMessage tone="error">{error}</FormMessage> : null}
      {access !== 'unavailable' && permissions.any('routers.command.dangerous') && !script ? (
        <div>
          <Button size="sm" variant="secondary" disabled={pending} onClick={() => void generate()}>
            {access && access.status !== 'NONE' ? t('regenerate') : t('generate')}
          </Button>
        </div>
      ) : null}
      {script ? (
        <div className="flex flex-col gap-2">
          <FormMessage tone="success">
            {t('scriptOnce', { expiresAt: date(script.expiresAt) })}
          </FormMessage>
          <pre
            data-testid="config-access-script"
            className="max-h-72 overflow-auto rounded-md border border-border bg-surface-muted p-3 font-mono text-xs whitespace-pre-wrap break-all"
          >
            {script.script}
          </pre>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="secondary" onClick={() => void copy()}>
              {copied ? (
                <Check className="size-4" aria-hidden />
              ) : (
                <Copy className="size-4" aria-hidden />
              )}
              {copied ? t('copied') : t('copy')}
            </Button>
            <Button
              size="sm"
              onClick={() => {
                setScript(null);
              }}
            >
              {t('done')}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
