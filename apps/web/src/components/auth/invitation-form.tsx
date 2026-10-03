'use client';

import type { InvitationPreview } from '@ecsi/shared';
import { PASSWORD_MIN_LENGTH } from '@ecsi/shared';
import { Button, buttonClasses } from '@ecsi/ui';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { type SubmitEvent, useEffect, useState } from 'react';
import { api } from '@/lib/client-api';
import { Field, FormMessage, fieldValue } from './form';
import { passwordProblem } from './reset-form';

export function InvitationForm({ token }: { token: string }) {
  const t = useTranslations('auth');
  const [preview, setPreview] = useState<InvitationPreview | null | 'invalid'>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    let active = true;
    void api<InvitationPreview>(`/auth/invitations/preview?token=${encodeURIComponent(token)}`, {
      retryOnUnauthorized: false,
    }).then((result) => {
      if (active) setPreview(result.ok ? result.data : 'invalid');
    });
    return () => {
      active = false;
    };
  }, [token]);

  if (preview === null) return <p className="text-sm text-muted">{t('invitation.loading')}</p>;
  if (preview === 'invalid')
    return <FormMessage tone="error">{t('invitation.invalid')}</FormMessage>;

  if (done) {
    return (
      <div className="flex flex-col gap-4">
        <FormMessage tone="success">{t('invitation.done')}</FormMessage>
        <Link href="/connexion" className={buttonClasses()}>
          {t('submit')}
        </Link>
      </div>
    );
  }

  const invitation = preview;

  async function submit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const password = fieldValue(form, 'password');
    if (!invitation.existingAccount) {
      const problem = passwordProblem(password, fieldValue(form, 'confirmation'));
      if (problem) {
        setError(t(problem));
        return;
      }
    }
    setPending(true);
    setError(null);
    const result = await api('/auth/invitations/accept', {
      method: 'POST',
      body: invitation.existingAccount
        ? { token, password }
        : { token, password, fullName: fieldValue(form, 'fullName').trim() },
      retryOnUnauthorized: false,
    });
    setPending(false);
    if (result.ok) setDone(true);
    else if (result.status === 401) setError(t('invalidCredentials'));
    else if (result.status === 429) setError(t('tooMany'));
    else if (result.status === 422) setError(result.problem?.detail ?? t('genericError'));
    else setError(t('invitation.invalid'));
  }

  return (
    <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-4" noValidate>
      <p className="text-sm text-foreground">
        {t('invitation.subtitle', { company: invitation.companyName })}{' '}
        {invitation.existingAccount
          ? t('invitation.existing', { email: invitation.email })
          : t('invitation.create', { email: invitation.email })}
      </p>
      {error ? <FormMessage tone="error">{error}</FormMessage> : null}
      {invitation.existingAccount ? (
        <Field
          id="password"
          label={t('password')}
          type="password"
          autoComplete="current-password"
          required
        />
      ) : (
        <>
          <Field id="fullName" label={t('fullName')} autoComplete="name" minLength={2} required />
          <Field
            id="password"
            label={t('newPassword')}
            type="password"
            autoComplete="new-password"
            hint={t('passwordHint')}
            minLength={PASSWORD_MIN_LENGTH}
            required
          />
          <Field
            id="confirmation"
            label={t('confirmPassword')}
            type="password"
            autoComplete="new-password"
            required
          />
        </>
      )}
      <Button type="submit" disabled={pending}>
        {t('invitation.accept')}
      </Button>
    </form>
  );
}
