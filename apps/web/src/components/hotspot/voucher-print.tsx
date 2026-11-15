'use client';

import { formatMoney, type VoucherPrintSheet } from '@ecsi/shared';
import { Button } from '@ecsi/ui';
import { ArrowLeft, Printer } from 'lucide-react';
import Link from 'next/link';
import { useFormatter, useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { FormMessage } from '@/components/auth/form';
import { useProblemMessage } from '@/components/admin/controls';
import { api } from '@/lib/client-api';
import { formatDuration, formatVolume, groupCode } from './format';

/**
 * Feuille d'impression des tickets (A4, grille de tickets découpables). Les codes ne sont
 * obtenus que par l'appel explicite d'impression (vouchers.export, audité, no-store), gardés
 * dans l'état de ce composant uniquement : jamais dans l'URL, le stockage local, un journal
 * ou le cache du navigateur. Ils disparaissent en quittant la page.
 */
export function VoucherPrint({ kind, id }: { kind: 'batch' | 'voucher'; id: string }) {
  const t = useTranslations('tickets.printSheet');
  const tCommon = useTranslations('common');
  const format = useFormatter();
  const problemMessage = useProblemMessage();
  const [sheet, setSheet] = useState<VoucherPrintSheet | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [onlyAvailable, setOnlyAvailable] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const request =
      kind === 'batch'
        ? api<VoucherPrintSheet>(`/voucher-batches/${id}/print`, { cache: 'no-store' })
        : api<VoucherPrintSheet>(`/vouchers/${id}/print`, {
            method: 'POST',
            body: {},
            cache: 'no-store',
          });
    void request.then((result) => {
      if (cancelled) return;
      if (result.ok) setSheet(result.data);
      else setError(problemMessage(result.status, result.problem));
    });
    return () => {
      cancelled = true;
      setSheet(null);
    };
  }, [kind, id, problemMessage]);

  const back = kind === 'batch' ? '/tickets' : `/tickets/${id}`;
  if (error) {
    return (
      <div className="mx-auto flex max-w-xl flex-col gap-4 p-6">
        <FormMessage tone="error">{error}</FormMessage>
        <Link href={back} className="text-sm text-primary hover:underline">
          {t('back')}
        </Link>
      </div>
    );
  }
  if (!sheet) return <p className="p-6 text-sm text-muted">{tCommon('loading')}</p>;

  const vouchers =
    kind === 'batch' && onlyAvailable
      ? sheet.vouchers.filter((voucher) => voucher.state === 'AVAILABLE')
      : sheet.vouchers;
  const plan = sheet.plan;
  const limits = [
    plan.validitySeconds ? t('validity', { duration: formatDuration(plan.validitySeconds) }) : null,
    plan.sessionTimeSeconds
      ? t('sessionTime', { duration: formatDuration(plan.sessionTimeSeconds) })
      : null,
    plan.dataQuotaBytes ? t('quota', { volume: formatVolume(plan.dataQuotaBytes) }) : null,
  ].filter((item): item is string => item !== null);

  return (
    <div className="voucher-print mx-auto max-w-[210mm] p-4 print:max-w-none print:p-0">
      <div className="mb-4 flex flex-col gap-3 print:hidden">
        <Link href={back} className="flex items-center gap-1 text-sm text-primary hover:underline">
          <ArrowLeft className="size-4" aria-hidden /> {t('back')}
        </Link>
        <h1 className="text-xl font-semibold text-foreground">
          {t('title', { plan: plan.name, site: sheet.site.name })}
        </h1>
        <p className="text-sm text-muted">{t('warning')}</p>
        <div className="flex flex-wrap items-center gap-4">
          <Button
            onClick={() => {
              window.print();
            }}
          >
            <Printer className="size-4" aria-hidden /> {t('print')}
          </Button>
          {kind === 'batch' ? (
            <label className="flex items-center gap-2 text-sm text-foreground">
              <input
                type="checkbox"
                checked={onlyAvailable}
                onChange={(event) => {
                  setOnlyAvailable(event.target.checked);
                }}
              />
              {t('onlyAvailable')}
            </label>
          ) : null}
          <span className="text-sm text-muted">{t('count', { count: vouchers.length })}</span>
        </div>
      </div>
      <ul
        data-testid="print-sheet"
        className="grid grid-cols-2 gap-2 sm:grid-cols-3 print:grid-cols-3 print:gap-[2mm]"
      >
        {vouchers.map((voucher) => (
          <li
            key={voucher.id}
            data-testid="printed-ticket"
            className="voucher-ticket flex flex-col gap-1 rounded-md border border-dashed border-border bg-surface p-3 text-foreground print:border-black print:bg-white print:text-black"
          >
            <div className="flex items-baseline justify-between gap-2 text-[11px]">
              <span className="truncate font-semibold">{sheet.company.name}</span>
              <span className="whitespace-nowrap">{t('serial', { serial: voucher.serial })}</span>
            </div>
            <p className="text-sm font-semibold">{plan.name}</p>
            <p className="text-[11px]">{t('codeLabel')}</p>
            <p
              data-testid="ticket-code"
              className="font-mono text-2xl font-bold tracking-[0.15em] whitespace-nowrap"
            >
              {groupCode(voucher.code)}
            </p>
            <p className="text-sm font-semibold">{formatMoney(plan.priceMinor, plan.currency)}</p>
            {limits.length > 0 ? <p className="text-[11px]">{limits.join(' · ')}</p> : null}
            <p className="text-[11px]">
              {sheet.site.name}
              {sheet.batch
                ? ` · ${format.dateTime(new Date(sheet.batch.createdAt), { dateStyle: 'short' })}`
                : ''}
            </p>
            {voucher.state !== 'AVAILABLE' ? (
              <p className="text-[11px] font-semibold">{t(`state.${voucher.state}`)}</p>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
