'use client';

import {
  DISABLEABLE_VOUCHER_STATES,
  formatMoney,
  type Voucher,
  type VoucherBatch,
  type VoucherDetail,
  type VoucherState,
  VOUCHER_STATES,
} from '@ecsi/shared';
import { Badge, type BadgeTone, Button, buttonClasses, Card, CardContent, Input } from '@ecsi/ui';
import { ArrowLeft, Printer } from 'lucide-react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useState } from 'react';
import { FormMessage } from '@/components/auth/form';
import { ConfirmPanel, DataTable, Td, Th, useProblemMessage } from '@/components/admin/controls';
import { usePermissions } from '@/components/me-context';
import { api } from '@/lib/client-api';

export const VOUCHER_STATE_TONE: Record<VoucherState, BadgeTone> = {
  AVAILABLE: 'success',
  ASSIGNED: 'primary',
  SOLD: 'primary',
  ACTIVE: 'warning',
  EXPIRED: 'neutral',
  DISABLED: 'danger',
};

const PAGE = 200;
const dateTime = (iso: string) =>
  new Intl.DateTimeFormat('fr-FR', { dateStyle: 'short', timeStyle: 'short' }).format(
    new Date(iso),
  );

/** Fiche d'un lot : résumé, tickets (codes masqués), désactivation, accès à l'impression. */
export function BatchDetail({ batchId }: { batchId: string }) {
  const t = useTranslations('tickets');
  const tCommon = useTranslations('common');
  const permissions = usePermissions();
  const problemMessage = useProblemMessage();
  const highlighted = useSearchParams().get('ticket');
  const [batch, setBatch] = useState<VoucherBatch | null>(null);
  const [vouchers, setVouchers] = useState<Voucher[]>([]);
  const [limit, setLimit] = useState(PAGE);
  const [state, setState] = useState<VoucherState | ''>('');
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<VoucherDetail | null>(null);
  const [disabling, setDisabling] = useState<'batch' | 'voucher' | null>(null);
  const [reason, setReason] = useState('');

  const load = useCallback(async () => {
    const [batchResult, listResult] = await Promise.all([
      api<VoucherBatch>(`/voucher-batches/${batchId}`),
      api<Voucher[]>(
        `/vouchers?batchId=${batchId}&limit=${String(limit)}${state ? `&state=${state}` : ''}`,
      ),
    ]);
    if (batchResult.ok) setBatch(batchResult.data);
    else setError(problemMessage(batchResult.status, batchResult.problem));
    if (listResult.ok) setVouchers(listResult.data);
  }, [batchId, limit, state, problemMessage]);

  const open = useCallback(async (voucherId: string) => {
    const result = await api<VoucherDetail>(`/vouchers/${voucherId}`);
    if (result.ok) setSelected(result.data);
  }, []);

  useEffect(() => {
    // Chargement initial (et après chaque changement de filtre).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  useEffect(() => {
    // Ticket trouvé par la recherche exacte : sa fiche s'ouvre directement.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (highlighted) void open(highlighted);
  }, [highlighted, open]);

  async function disable() {
    const target =
      disabling === 'batch'
        ? `/voucher-batches/${batchId}/disable`
        : `/vouchers/${selected?.id ?? ''}/disable`;
    const result = await api(target, { method: 'POST', body: { reason: reason.trim() } });
    if (!result.ok) {
      setError(problemMessage(result.status, result.problem));
      return;
    }
    setDisabling(null);
    setReason('');
    if (disabling === 'voucher' && selected) await open(selected.id);
    void load();
  }

  if (!batch) {
    return error ? <FormMessage tone="error">{error}</FormMessage> : <p>{tCommon('loading')}</p>;
  }
  const canDisable = permissions.any('vouchers.disable');
  const usable = DISABLEABLE_VOUCHER_STATES.reduce((sum, s) => sum + batch.counts[s], 0);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <Link href="/tickets" className={buttonClasses('ghost', 'sm')}>
          <ArrowLeft className="size-4" aria-hidden /> {t('batch.back')}
        </Link>
        {permissions.any('vouchers.export') ? (
          <Link
            href={`/tickets/lots/${batch.id}/impression`}
            className={buttonClasses('primary', 'sm')}
          >
            <Printer className="size-4" aria-hidden /> {t('batch.print')}
          </Link>
        ) : null}
        {canDisable && usable > 0 ? (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              setDisabling('batch');
            }}
          >
            {t('batch.disableAll')}
          </Button>
        ) : null}
      </div>

      {error ? <FormMessage tone="error">{error}</FormMessage> : null}

      {disabling ? (
        <ConfirmPanel
          title={disabling === 'batch' ? t('batch.disableAll') : t('batch.disable')}
          description={
            disabling === 'batch' ? t('batch.disableAllConfirm') : t('batch.disableConfirm')
          }
        >
          <Input
            aria-label={t('batch.reason')}
            placeholder={t('batch.reasonPlaceholder')}
            value={reason}
            maxLength={200}
            onChange={(event) => {
              setReason(event.target.value);
            }}
          />
          <div className="flex gap-2">
            <Button
              variant="danger"
              size="sm"
              disabled={reason.trim().length < 3}
              onClick={() => void disable()}
            >
              {t('batch.disable')}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setDisabling(null);
              }}
            >
              {tCommon('cancel')}
            </Button>
          </div>
        </ConfirmPanel>
      ) : null}

      <Card>
        <CardContent className="grid grid-cols-2 gap-4 pt-5 text-sm md:grid-cols-4">
          <Info label={t('columns.label')} value={batch.label ?? '—'} />
          <Info label={t('columns.plan')} value={batch.plan.name} />
          <Info label={t('columns.site')} value={`${batch.site.name} (${batch.site.code})`} />
          <Info label={t('batch.unitPrice')} value={formatMoney(batch.unitPrice, batch.currency)} />
          <Info
            label={t('batch.format')}
            value={`${t(`form.authModes.${batch.authMode}`)} · ${t(`form.charsets.${batch.charset}`).split(' (')[0] ?? ''} · ${String(batch.length)}${batch.prefix ? ` · ${batch.prefix}…` : ''}`}
          />
          <Info
            label={t('batch.value')}
            value={formatMoney(batch.unitPrice * batch.counts.AVAILABLE, batch.currency)}
          />
          <Info
            label={t('columns.createdAt')}
            value={`${dateTime(batch.createdAt)}${batch.createdBy ? ` · ${batch.createdBy}` : ''}`}
          />
          <div className="col-span-2 flex flex-wrap gap-1 md:col-span-4">
            {VOUCHER_STATES.filter((s) => batch.counts[s] > 0).map((s) => (
              <Badge key={s} tone={VOUCHER_STATE_TONE[s]}>
                {t(`states.${s}`)} : {batch.counts[s]}
              </Badge>
            ))}
          </div>
          <p className="col-span-2 text-xs text-muted md:col-span-4">{t('batch.notYet')}</p>
        </CardContent>
      </Card>

      {selected ? (
        <Card>
          <CardContent className="flex flex-col gap-3 pt-5 text-sm">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="font-semibold">
                {t('batch.serial')} {selected.serial} ·{' '}
                <span className="font-mono">{selected.maskedCode}</span>{' '}
                <Badge tone={VOUCHER_STATE_TONE[selected.state]}>
                  {t(`states.${selected.state}`)}
                </Badge>
              </p>
              <div className="flex gap-2">
                {canDisable && DISABLEABLE_VOUCHER_STATES.includes(selected.state) ? (
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => {
                      setDisabling('voucher');
                    }}
                  >
                    {t('batch.disable')}
                  </Button>
                ) : null}
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setSelected(null);
                  }}
                >
                  {tCommon('close')}
                </Button>
              </div>
            </div>
            <p className="font-medium">{t('batch.history')}</p>
            <ol className="flex flex-col gap-1">
              {selected.events.map((event, index) => (
                <li key={index} className="text-muted">
                  {dateTime(event.occurredAt)} — {t(`states.${event.toState}`)}
                  {event.actor ? ` · ${event.actor}` : ''}
                  {event.reason ? ` · ${event.reason}` : ''}
                </li>
              ))}
            </ol>
          </CardContent>
        </Card>
      ) : null}

      <div className="flex items-center gap-2">
        <select
          aria-label={t('batch.state')}
          className="h-9 rounded-md border border-border bg-surface px-2 text-sm"
          value={state}
          onChange={(event) => {
            setState(event.target.value as VoucherState | '');
          }}
        >
          <option value="">{t('batch.state')}</option>
          {VOUCHER_STATES.map((s) => (
            <option key={s} value={s}>
              {t(`states.${s}`)}
            </option>
          ))}
        </select>
      </div>

      <DataTable testId="vouchers-table">
        <thead>
          <tr>
            <Th>{t('batch.serial')}</Th>
            <Th>{t('batch.code')}</Th>
            <Th>{t('batch.state')}</Th>
            <Th />
          </tr>
        </thead>
        <tbody>
          {vouchers.map((voucher) => (
            <tr key={voucher.id} className={voucher.id === selected?.id ? 'bg-primary/5' : ''}>
              <Td>{voucher.serial}</Td>
              <Td className="font-mono">{voucher.maskedCode}</Td>
              <Td>
                <Badge tone={VOUCHER_STATE_TONE[voucher.state]} dot>
                  {t(`states.${voucher.state}`)}
                </Badge>
              </Td>
              <Td className="text-right">
                <Button variant="ghost" size="sm" onClick={() => void open(voucher.id)}>
                  {t('batch.history')}
                </Button>
              </Td>
            </tr>
          ))}
        </tbody>
      </DataTable>
      {vouchers.length === limit ? (
        <div>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              setLimit(Math.min(limit + PAGE, 1000));
            }}
          >
            {t('batch.showMore')}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs text-muted">{label}</p>
      <p className="font-medium text-foreground">{value}</p>
    </div>
  );
}
