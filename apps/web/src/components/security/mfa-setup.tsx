'use client';

import type { MfaSetupResponse, RecoveryCodesResponse } from '@ecsi/shared';
import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle } from '@ecsi/ui';
import { ShieldCheck } from 'lucide-react';
import { useTranslations } from 'next-intl';
import QRCode from 'qrcode';
import { type SubmitEvent, useEffect, useState } from 'react';
import { Field, FormMessage, fieldValue } from '@/components/auth/form';
import { api, hardNavigate } from '@/lib/client-api';

interface Props {
  /** '/auth' (utilisateurs) ou '/platform/auth' (super administrateurs). */
  base: '/auth' | '/platform/auth';
  enabled: boolean;
  required: boolean;
  /** Destination après activation et sauvegarde des codes. */
  doneHref: string;
}

/** Activation de la 2FA TOTP : QR code, confirmation par un premier code, codes de récupération. */
export function MfaSetup({ base, enabled, required, doneHref }: Props) {
  const t = useTranslations('security.mfa');
  const tAuth = useTranslations('auth');
  const [setup, setSetup] = useState<MfaSetupResponse | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!setup) return;
    void QRCode.toDataURL(setup.otpauthUri, { margin: 1, width: 220 }).then(setQr);
  }, [setup]);

  async function start() {
    setPending(true);
    setError(null);
    const result = await api<MfaSetupResponse>(`${base}/mfa/setup`, { method: 'POST', body: {} });
    setPending(false);
    if (result.ok) setSetup(result.data);
    else setError(tAuth('genericError'));
  }

  async function confirm(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const code = fieldValue(new FormData(event.currentTarget), 'code').replace(/\s/g, '');
    setPending(true);
    setError(null);
    const endpoint = enabled ? '/auth/mfa/recovery-codes' : `${base}/mfa/confirm`;
    const result = await api<RecoveryCodesResponse>(endpoint, { method: 'POST', body: { code } });
    setPending(false);
    if (result.ok) setCodes(result.data.recoveryCodes);
    else setError(tAuth('mfa.invalid'));
  }

  if (codes) {
    const text = codes.join('\n');
    return (
      <Card>
        <CardHeader>
          <CardTitle>{t('recoveryTitle')}</CardTitle>
          <CardDescription>{t('recoveryHelp')}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <ul
            data-testid="recovery-codes"
            className="grid grid-cols-2 gap-2 rounded-md bg-surface-muted p-4 font-mono text-sm"
          >
            {codes.map((code) => (
              <li key={code}>{code}</li>
            ))}
          </ul>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="secondary"
              onClick={() => {
                void navigator.clipboard.writeText(text).then(() => {
                  setCopied(true);
                });
              }}
            >
              {copied ? t('copied') : t('copy')}
            </Button>
            <a
              className="inline-flex h-10 items-center rounded-md border border-border px-4 text-sm"
              href={`data:text/plain;charset=utf-8,${encodeURIComponent(text)}`}
              download="ecsi-cloud-codes-recuperation.txt"
            >
              {t('download')}
            </a>
            <Button
              onClick={() => {
                hardNavigate(doneHref);
              }}
            >
              {t('continue')}
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('title')}</CardTitle>
        <CardDescription>{t('subtitle')}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {required && !enabled ? <FormMessage tone="error">{t('required')}</FormMessage> : null}
        {error ? <FormMessage tone="error">{error}</FormMessage> : null}

        {enabled ? (
          <>
            <p className="flex items-center gap-2 text-sm font-medium text-success">
              <ShieldCheck className="size-4" aria-hidden /> {t('enabled')}
            </p>
            {base === '/auth' ? (
              <form
                onSubmit={(event) => void confirm(event)}
                className="flex flex-col gap-3 sm:max-w-sm"
                noValidate
              >
                <p className="text-sm text-muted">{t('regenerateHelp')}</p>
                <Field
                  id="code"
                  label={tAuth('mfa.code')}
                  inputMode="numeric"
                  maxLength={6}
                  required
                />
                <Button type="submit" variant="secondary" disabled={pending}>
                  {t('regenerate')}
                </Button>
              </form>
            ) : null}
          </>
        ) : !setup ? (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-foreground">{t('step1')}</p>
            <Button onClick={() => void start()} disabled={pending} className="self-start">
              {t('start')}
            </Button>
          </div>
        ) : (
          <form
            onSubmit={(event) => void confirm(event)}
            className="flex flex-col gap-4"
            noValidate
          >
            <p className="text-sm text-foreground">{t('step1')}</p>
            <p className="text-sm text-foreground">{t('step2')}</p>
            {qr ? (
              // eslint-disable-next-line @next/next/no-img-element -- image générée localement (data URI)
              <img
                src={qr}
                alt="QR code"
                width={220}
                height={220}
                className="rounded-md border border-border"
              />
            ) : null}
            <details className="text-sm">
              <summary className="cursor-pointer text-primary">{t('manual')}</summary>
              <code
                data-testid="totp-secret"
                className="mt-2 block break-all rounded bg-surface-muted p-2 font-mono"
              >
                {setup.secret}
              </code>
            </details>
            <p className="text-sm text-foreground">{t('step3')}</p>
            <div className="sm:max-w-xs">
              <Field
                id="code"
                label={tAuth('mfa.code')}
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                autoFocus
                required
              />
            </div>
            <Button type="submit" disabled={pending} className="self-start">
              {t('confirm')}
            </Button>
          </form>
        )}
      </CardContent>
    </Card>
  );
}
