'use client';

import { PASSWORD_MIN_LENGTH } from '@ecsi/shared';
import { Button, buttonClasses } from '@ecsi/ui';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { type SubmitEvent, useState } from 'react';
import { api } from '@/lib/client-api';
import { Field, FormMessage, fieldValue } from './form';

/** Vérifie la saisie côté client (confort) ; l'API applique les mêmes règles (sécurité). */
export function passwordProblem(
  password: string,
  confirmation: string,
): 'passwordTooShort' | 'passwordMismatch' | null {
  if (password.length < PASSWORD_MIN_LENGTH) return 'passwordTooShort';
  if (password !== confirmation) return 'passwordMismatch';
  return null;
}

export function ResetPasswordForm({ token }: { token: string }) {
  const t = useTranslations('auth');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [pending, setPending] = useState(false);

  async function submit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const password = fieldValue(form, 'password');
    const problem = passwordProblem(password, fieldValue(form, 'confirmation'));
    if (problem) {
      setError(t(problem));
      return;
    }
    setPending(true);
    setError(null);
    const result = await api('/auth/password/reset', {
      method: 'POST',
      body: { token, password },
      retryOnUnauthorized: false,
    });
    setPending(false);
    if (result.ok) setDone(true);
    else setError(result.status === 429 ? t('tooMany') : t('reset.invalidLink'));
  }

  if (done) {
    return (
      <div className="flex flex-col gap-4">
        <FormMessage tone="success">{t('reset.done')}</FormMessage>
        <Link href="/connexion" className={buttonClasses()}>
          {t('submit')}
        </Link>
      </div>
    );
  }

  return (
    <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-4" noValidate>
      {error ? <FormMessage tone="error">{error}</FormMessage> : null}
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
      <Button type="submit" disabled={pending}>
        {t('reset.submit')}
      </Button>
    </form>
  );
}
