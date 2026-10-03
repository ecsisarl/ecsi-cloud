'use client';

import type { LoginResponse } from '@ecsi/shared';
import { Button } from '@ecsi/ui';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { type SubmitEvent, useState } from 'react';
import { api, hardNavigate, safeNextPath } from '@/lib/client-api';
import { Field, FormMessage, fieldValue } from './form';

type Realm = 'user' | 'platform';

const ENDPOINTS: Record<Realm, { login: string; verify: string; home: string; setup: string }> = {
  user: { login: '/auth/login', verify: '/auth/mfa/verify', home: '/', setup: '/securite/2fa' },
  platform: {
    login: '/platform/auth/login',
    verify: '/platform/auth/mfa/verify',
    home: '/plateforme',
    setup: '/plateforme',
  },
};

/**
 * Connexion en deux étapes : identifiants, puis code 2FA si le compte l'a activée.
 * Navigation complète après succès pour que le serveur lise les nouveaux cookies.
 */
export function LoginFlow({ realm, next }: { realm: Realm; next?: string | undefined }) {
  const t = useTranslations('auth');
  const endpoints = ENDPOINTS[realm];
  const [step, setStep] = useState<'credentials' | 'mfa'>('credentials');
  const [useRecovery, setUseRecovery] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const errorFor = (status: number, fallback: string) =>
    status === 0 ? t('networkError') : status === 429 ? t('tooMany') : fallback;

  const finish = (response: LoginResponse) => {
    const target =
      response.mfaState === 'SETUP_REQUIRED'
        ? endpoints.setup
        : realm === 'user'
          ? safeNextPath(next)
          : endpoints.home;
    hardNavigate(target);
  };

  async function submitCredentials(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setPending(true);
    setError(null);
    const result = await api<LoginResponse>(endpoints.login, {
      method: 'POST',
      body: { email: fieldValue(form, 'email'), password: fieldValue(form, 'password') },
      retryOnUnauthorized: false,
    });
    setPending(false);
    if (!result.ok) {
      setError(errorFor(result.status, t('invalidCredentials')));
      return;
    }
    if (result.data.status === 'MFA_REQUIRED') {
      setStep('mfa');
      return;
    }
    finish(result.data);
  }

  async function submitMfa(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = fieldValue(new FormData(event.currentTarget), 'code').trim();
    setPending(true);
    setError(null);
    const result = await api<LoginResponse>(endpoints.verify, {
      method: 'POST',
      body: useRecovery ? { recoveryCode: value } : { code: value.replace(/\s/g, '') },
      retryOnUnauthorized: false,
    });
    setPending(false);
    if (!result.ok) {
      const expired = result.problem?.detail?.includes('reconnectez') ?? false;
      if (expired) setStep('credentials');
      setError(errorFor(result.status, expired ? t('mfa.expired') : t('mfa.invalid')));
      return;
    }
    finish(result.data);
  }

  if (step === 'mfa') {
    return (
      <form onSubmit={(event) => void submitMfa(event)} className="flex flex-col gap-4" noValidate>
        <div className="flex flex-col gap-1">
          <h2 className="text-base font-semibold text-foreground">{t('mfa.title')}</h2>
          <p className="text-sm text-muted">{t('mfa.subtitle')}</p>
        </div>
        {error ? <FormMessage tone="error">{error}</FormMessage> : null}
        <Field
          key={useRecovery ? 'recovery' : 'totp'}
          id="code"
          label={useRecovery ? t('mfa.recoveryCode') : t('mfa.code')}
          autoComplete="one-time-code"
          inputMode={useRecovery ? 'text' : 'numeric'}
          pattern={useRecovery ? undefined : '[0-9]*'}
          maxLength={useRecovery ? 11 : 6}
          autoFocus
          required
        />
        <Button type="submit" disabled={pending}>
          {t('mfa.verify')}
        </Button>
        <button
          type="button"
          className="text-sm text-primary hover:underline"
          onClick={() => {
            setUseRecovery((value) => !value);
            setError(null);
          }}
        >
          {useRecovery ? t('mfa.useTotp') : t('mfa.useRecovery')}
        </button>
      </form>
    );
  }

  return (
    <form
      onSubmit={(event) => void submitCredentials(event)}
      className="flex flex-col gap-4"
      noValidate
    >
      {error ? <FormMessage tone="error">{error}</FormMessage> : null}
      <Field
        id="email"
        label={t('email')}
        type="email"
        autoComplete="username"
        autoFocus
        required
      />
      <Field
        id="password"
        label={t('password')}
        type="password"
        autoComplete="current-password"
        required
      />
      <Button type="submit" disabled={pending}>
        {pending ? t('submitting') : t('submit')}
      </Button>
      {realm === 'user' ? (
        <Link
          href="/mot-de-passe-oublie"
          className="text-center text-sm text-primary hover:underline"
        >
          {t('forgot')}
        </Link>
      ) : null}
    </form>
  );
}
