'use client';

import type { PlatformUser } from '@ecsi/shared';
import { Badge, Button, Card, CardContent, Input } from '@ecsi/ui';
import { useTranslations } from 'next-intl';
import { type SubmitEvent, useState } from 'react';
import { Field, FormMessage, fieldValue } from '@/components/auth/form';
import { ConfirmPanel, FieldShell, Textarea, useProblemMessage } from '@/components/admin/controls';
import { api } from '@/lib/client-api';

/**
 * Support ECSI : récupération de la 2FA d'un utilisateur (notamment s'il appartient à
 * plusieurs entreprises). Confirmée par le code TOTP du super administrateur, motivée,
 * auditée ; l'ancien secret est supprimé, jamais affiché.
 */
export function SupportConsole() {
  const t = useTranslations('platformConsole.support');
  const tCommon = useTranslations('common');
  const problemMessage = useProblemMessage();
  const [query, setQuery] = useState('');
  const [users, setUsers] = useState<PlatformUser[] | null>(null);
  const [target, setTarget] = useState<PlatformUser | null>(null);
  const [message, setMessage] = useState<{ tone: 'error' | 'success'; text: string } | null>(null);

  async function search(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    if (query.trim().length < 3) return;
    const result = await api<PlatformUser[]>(
      `/platform/users?q=${encodeURIComponent(query.trim())}`,
    );
    if (result.ok) setUsers(result.data);
    else setMessage({ tone: 'error', text: problemMessage(result.status, result.problem) });
  }

  async function reset(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!target) return;
    const form = new FormData(event.currentTarget);
    const result = await api(`/platform/users/${target.id}/mfa/reset`, {
      method: 'POST',
      body: {
        code: fieldValue(form, 'code').replace(/\s/g, ''),
        reason: fieldValue(form, 'reason').trim(),
      },
    });
    if (result.ok) {
      setMessage({ tone: 'success', text: t('done', { email: target.email }) });
      setUsers(
        (list) => list?.map((u) => (u.id === target.id ? { ...u, mfaEnabled: false } : u)) ?? null,
      );
      setTarget(null);
    } else setMessage({ tone: 'error', text: problemMessage(result.status, result.problem) });
  }

  return (
    <div className="flex max-w-3xl flex-col gap-4">
      {message ? <FormMessage tone={message.tone}>{message.text}</FormMessage> : null}
      <form
        onSubmit={(event) => void search(event)}
        className="flex flex-col gap-2 sm:flex-row sm:items-end"
      >
        <div className="flex-1">
          <FieldShell id="user-search" label={t('search')}>
            <Input
              id="user-search"
              type="search"
              minLength={3}
              placeholder={t('searchPlaceholder')}
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
              }}
            />
          </FieldShell>
        </div>
        <Button type="submit" variant="secondary">
          {t('searchButton')}
        </Button>
      </form>

      {users?.length === 0 ? <p className="text-sm text-muted">{t('noResult')}</p> : null}
      <ul className="flex flex-col gap-3">
        {users?.map((user) => (
          <li key={user.id}>
            <Card>
              <CardContent className="flex flex-col gap-3 pt-5">
                <div className="flex flex-wrap items-center gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="font-medium">{user.fullName}</p>
                    <p className="text-sm text-muted">{user.email}</p>
                    <p className="text-xs text-muted">
                      {user.companies.map((company) => company.name).join(' · ') || t('noCompany')}
                    </p>
                  </div>
                  <Badge tone={user.mfaEnabled ? 'success' : 'neutral'}>
                    {user.mfaEnabled ? t('mfaOn') : t('mfaOff')}
                  </Badge>
                  {user.mfaEnabled ? (
                    <Button
                      size="sm"
                      variant="danger"
                      onClick={() => {
                        setTarget(user);
                      }}
                    >
                      {t('reset')}
                    </Button>
                  ) : null}
                </div>
                {target?.id === user.id ? (
                  <ConfirmPanel
                    title={t('resetTitle', { email: user.email })}
                    description={t('resetDescription')}
                  >
                    <form
                      onSubmit={(event) => void reset(event)}
                      className="flex flex-col gap-3"
                      noValidate
                    >
                      <FieldShell id="reason" label={t('reason')}>
                        <Textarea
                          id="reason"
                          name="reason"
                          required
                          minLength={10}
                          maxLength={500}
                        />
                      </FieldShell>
                      <Field
                        id="code"
                        label={t('code')}
                        inputMode="numeric"
                        autoComplete="one-time-code"
                        maxLength={6}
                      />
                      <div className="flex gap-2">
                        <Button type="submit" variant="danger">
                          {t('confirm')}
                        </Button>
                        <Button
                          variant="secondary"
                          onClick={() => {
                            setTarget(null);
                          }}
                        >
                          {tCommon('cancel')}
                        </Button>
                      </div>
                    </form>
                  </ConfirmPanel>
                ) : null}
              </CardContent>
            </Card>
          </li>
        ))}
      </ul>
    </div>
  );
}
