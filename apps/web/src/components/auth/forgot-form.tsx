'use client';

import { Button } from '@ecsi/ui';
import { useTranslations } from 'next-intl';
import { type SubmitEvent, useState } from 'react';
import { api } from '@/lib/client-api';
import { Field, FormMessage, fieldValue } from './form';

export function ForgotPasswordForm() {
  const t = useTranslations('auth');
  const [state, setState] = useState<'idle' | 'pending' | 'sent' | 'error' | 'limited'>('idle');

  async function submit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    setState('pending');
    const email = fieldValue(new FormData(event.currentTarget), 'email');
    const result = await api('/auth/password/forgot', {
      method: 'POST',
      body: { email },
      retryOnUnauthorized: false,
    });
    // Réponse identique que le compte existe ou non (anti-énumération).
    setState(
      result.ok || result.status === 422 ? 'sent' : result.status === 429 ? 'limited' : 'error',
    );
  }

  if (state === 'sent') return <FormMessage tone="success">{t('forgotPage.sent')}</FormMessage>;

  return (
    <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-4" noValidate>
      {state === 'error' ? <FormMessage tone="error">{t('genericError')}</FormMessage> : null}
      {state === 'limited' ? <FormMessage tone="error">{t('tooMany')}</FormMessage> : null}
      <Field id="email" label={t('email')} type="email" autoComplete="email" autoFocus required />
      <Button type="submit" disabled={state === 'pending'}>
        {t('forgotPage.submit')}
      </Button>
    </form>
  );
}
