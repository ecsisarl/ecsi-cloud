'use client';

import {
  formatBytes,
  formatDuration,
  formatMoney,
  formatRate,
  type PrintableVoucher,
  type VoucherBatchPrint,
} from '@ecsi/shared';
import { Button, buttonClasses, cn, Input } from '@ecsi/ui';
import { ArrowLeft, Printer } from 'lucide-react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import QRCode from 'qrcode';
import { useEffect, useRef, useState } from 'react';
import { FormMessage } from '@/components/auth/form';
import { FieldShell, Select, useProblemMessage } from '@/components/admin/controls';
import { api } from '@/lib/client-api';

const TEMPLATES = ['standard', 'compact', 'thermal'] as const;
type Template = (typeof TEMPLATES)[number];

/**
 * Contenu du QR code (Mikhmon : QR de connexion). Avec l'adresse du hotspot, le QR ouvre
 * la page de connexion avec les identifiants en paramètres (login?username=…&password=…,
 * comme Mikhmon). Cela suppose la méthode de connexion HTTP PAP du Hotspot : NON validé
 * sur CHR ni sur matériel (à faire avec le portail captif, Sprint 7). Sans adresse, le QR
 * ne contient que le code.
 */
export function qrPayload(voucher: PrintableVoucher, loginUrl: string): string {
  const password = voucher.password ?? voucher.username;
  const url = loginUrl.trim();
  if (!/^https?:\/\/[^\s]+$/i.test(url)) return voucher.username;
  const separator = url.includes('?') ? '&' : '?';
  return `${url}${separator}username=${encodeURIComponent(voucher.username)}&password=${encodeURIComponent(password)}`;
}

/**
 * Impression d'un lot (Mikhmon : « Print » / « Quick print »). Les codes en clair ne sont
 * demandés à l'API qu'à l'ouverture de cette page (action auditée) et ne sont jamais
 * conservés dans le navigateur au-delà de la page.
 */
export function BatchPrint({ batchId }: { batchId: string }) {
  const t = useTranslations('tickets.print');
  const problemMessage = useProblemMessage();
  const [data, setData] = useState<VoucherBatchPrint | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [template, setTemplate] = useState<Template>('standard');
  const [loginUrl, setLoginUrl] = useState('');
  const [qr, setQr] = useState<Record<number, string>>({});
  const requested = useRef(false);

  useEffect(() => {
    // Une seule demande (l'impression est auditée), même en double rendu de développement.
    if (requested.current) return;
    requested.current = true;
    void api<VoucherBatchPrint>(`/voucher-batches/${batchId}/print`, { method: 'POST' }).then(
      (result) => {
        if (result.ok) setData(result.data);
        else setError(problemMessage(result.status, result.problem));
      },
    );
  }, [batchId, problemMessage]);

  useEffect(() => {
    if (!data || template === 'compact') return;
    let cancelled = false;
    void Promise.all(
      data.vouchers.map(
        async (voucher) =>
          [
            voucher.serial,
            await QRCode.toDataURL(qrPayload(voucher, loginUrl), { margin: 0, width: 160 }),
          ] as const,
      ),
    ).then((entries) => {
      if (!cancelled) setQr(Object.fromEntries(entries));
    });
    return () => {
      cancelled = true;
    };
  }, [data, template, loginUrl]);

  if (error) return <FormMessage tone="error">{error}</FormMessage>;
  if (!data) return <p className="text-sm text-muted">{t('loading')}</p>;

  const { batch, plan, company } = data;
  const price = formatMoney(batch.unitPrice, batch.currency);
  const contact = company.whatsapp ?? company.phone;
  const limits = [
    plan.sessionTimeSeconds
      ? `${t('duration')} : ${formatDuration(plan.sessionTimeSeconds)}`
      : null,
    plan.validitySeconds ? `${t('validity')} : ${formatDuration(plan.validitySeconds)}` : null,
    plan.dataQuotaBytes ? formatBytes(plan.dataQuotaBytes) : null,
    plan.rateDownKbps ? formatRate(plan.rateDownKbps) : null,
  ].filter(Boolean);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-4 print:hidden">
        <div className="flex flex-wrap items-end gap-3">
          <Link href={`/tickets/lots/${batch.id}`} className={buttonClasses('ghost', 'sm')}>
            <ArrowLeft className="size-4" aria-hidden /> {t('back')}
          </Link>
          <FieldShell id="template" label={t('template')}>
            <Select
              id="template"
              value={template}
              onChange={(event) => {
                setTemplate(event.target.value as Template);
              }}
            >
              {TEMPLATES.map((value) => (
                <option key={value} value={value}>
                  {t(`templates.${value}`)}
                </option>
              ))}
            </Select>
          </FieldShell>
          <div className="min-w-64 flex-1">
            <FieldShell id="loginUrl" label={t('loginUrl')} hint={t('loginUrlHint')}>
              <Input
                id="loginUrl"
                type="url"
                placeholder="http://wifi.local/login"
                value={loginUrl}
                onChange={(event) => {
                  setLoginUrl(event.target.value);
                }}
              />
            </FieldShell>
          </div>
          <Button
            onClick={() => {
              window.print();
            }}
            disabled={data.vouchers.length === 0}
          >
            <Printer className="size-4" aria-hidden /> {t('print')}
          </Button>
        </div>
        <p className="text-xs text-muted">{t('notice')}</p>
      </div>

      {data.vouchers.length === 0 ? <p className="text-sm text-muted">{t('empty')}</p> : null}

      <div
        data-testid="print-sheet"
        className={cn(
          'grid gap-2 bg-white text-black',
          template === 'thermal'
            ? 'w-[58mm] grid-cols-1'
            : template === 'compact'
              ? 'grid-cols-3 sm:grid-cols-4 print:grid-cols-5'
              : 'grid-cols-2 sm:grid-cols-3 print:grid-cols-4',
        )}
      >
        {data.vouchers.map((voucher) => (
          <div
            key={voucher.serial}
            className={cn(
              'flex break-inside-avoid flex-col gap-1 border border-dashed border-black/50 p-2 text-[11px] leading-tight',
              template === 'thermal' && 'items-center border-x-0 border-t-0 text-center',
            )}
          >
            <div className="flex items-center justify-between gap-1 font-semibold">
              <span className="truncate">{company.name}</span>
              <span>{price}</span>
            </div>
            <div className={cn('flex gap-2', template === 'thermal' && 'flex-col items-center')}>
              {template !== 'compact' && qr[voucher.serial] ? (
                // eslint-disable-next-line @next/next/no-img-element -- data: URL générée localement
                <img src={qr[voucher.serial]} alt="" className="size-16 shrink-0" />
              ) : null}
              <div className="flex min-w-0 flex-col justify-center gap-0.5">
                <span className="text-[10px] text-black/60">
                  {voucher.password ? t('username') : t('code')}
                </span>
                <span className="font-mono text-sm font-bold tracking-wider">
                  {voucher.username}
                </span>
                {voucher.password ? (
                  <>
                    <span className="text-[10px] text-black/60">{t('password')}</span>
                    <span className="font-mono text-sm font-bold tracking-wider">
                      {voucher.password}
                    </span>
                  </>
                ) : null}
              </div>
            </div>
            <div className="text-[10px] text-black/70">
              {plan.name}
              {limits.length ? ` · ${limits.join(' · ')}` : ''}
            </div>
            <div className="flex justify-between text-[9px] text-black/50">
              <span>
                {batch.number}-{voucher.serial}
              </span>
              {contact ? <span>{contact}</span> : null}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
