'use client';

import { emailSchema } from '@ecsi/shared';
import { Button } from '@ecsi/ui';
import { useTranslations } from 'next-intl';
import { type SubmitEvent, useState } from 'react';
import { api } from '@/lib/client-api';
import { Field, FormMessage, fieldValue } from './form';

export function ForgotPasswordForm() {
  const t = useTranslations('auth');
  const [state, setState] = useState<'idle' | 'pending' | 'sent' | 'invalid' | 'error' | 'limited'>(
    'idle',
  );

  async function submit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const parsed = emailSchema.safeParse(fieldValue(new FormData(event.currentTarget), 'email'));
    if (!parsed.success) {
      setState('invalid');
      return;
    }
    setState('pending');
    const email = parsed.data;
    const result = await api('/auth/password/forgot', {
      method: 'POST',
      body: { email },
      retryOnUnauthorized: false,
    });
    // Réponse identique que le compte existe ou non (anti-énumération) ; 422 ne dépend
    // que du format de l'adresse.
    setState(
      result.ok
        ? 'sent'
        : result.status === 422
          ? 'invalid'
          : result.status === 429
            ? 'limited'
            : 'error',
    );
  }

  if (state === 'sent') return <FormMessage tone="success">{t('forgotPage.sent')}</FormMessage>;

  return (
    <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-4" noValidate>
      {state === 'error' ? <FormMessage tone="error">{t('genericError')}</FormMessage> : null}
      {state === 'invalid' ? (
        <FormMessage tone="error">{t('forgotPage.invalidEmail')}</FormMessage>
      ) : null}
      {state === 'limited' ? <FormMessage tone="error">{t('tooMany')}</FormMessage> : null}
      <Field id="email" label={t('email')} type="email" autoComplete="email" autoFocus required />
      <Button type="submit" disabled={state === 'pending'}>
        {t('forgotPage.submit')}
      </Button>
    </form>
  );
}
