'use client';

import { formatMoney, type VoucherDetail as VoucherDetailView } from '@ecsi/shared';
import { Badge, Button, Card, CardContent, CardHeader, CardTitle, EmptyState } from '@ecsi/ui';
import { ArrowLeft, Ticket } from 'lucide-react';
import Link from 'next/link';
import { useFormatter, useTranslations } from 'next-intl';
import { useCallback, useEffect, useState } from 'react';
import { FormMessage } from '@/components/auth/form';
import {
  ConfirmPanel,
  DataTable,
  FieldShell,
  Td,
  Textarea,
  Th,
  useProblemMessage,
} from '@/components/admin/controls';
import { usePermissions } from '@/components/me-context';
import { PageHeader } from '@/components/page-header';
import { api } from '@/lib/client-api';
import { formatBytes } from '@/components/routers/format';
import { formatDuration, formatRate, formatVolume, VOUCHER_STATE_TONE } from './format';
import { PrintLink } from './tickets-manager';

function Row({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div className="grid grid-cols-2 gap-2 py-2 text-sm">
      <dt className="text-muted">{label}</dt>
      <dd className="text-foreground">{value && value !== '' ? value : '—'}</dd>
    </div>
  );
}

/**
 * Détail d'un ticket : état, dates, consommation, sessions et refus récents. Le code n'est
 * jamais reçu ici : seule l'impression explicite (permission dédiée, auditée) l'affiche.
 */
export function VoucherDetail({ id }: { id: string }) {
  const t = useTranslations('tickets');
  const tCommon = useTranslations('common');
  const format = useFormatter();
  const permissions = usePermissions();
  const problemMessage = useProblemMessage();
  const [voucher, setVoucher] = useState<VoucherDetailView | null>(null);
  const [missing, setMissing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [reason, setReason] = useState('');
  const [message, setMessage] = useState<{ tone: 'error' | 'success'; text: string } | null>(null);

  const load = useCallback(async () => {
    const result = await api<VoucherDetailView>(`/vouchers/${id}`);
    if (result.ok) setVoucher(result.data);
    else if (result.status === 404) setMissing(true);
    else setMessage({ tone: 'error', text: problemMessage(result.status, result.problem) });
  }, [id, problemMessage]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  async function disable() {
    const result = await api<VoucherDetailView>(`/vouchers/${id}/disable`, {
      method: 'POST',
      body: { reason: reason.trim() },
    });
    if (result.ok) {
      setVoucher(result.data);
      setConfirming(false);
      setReason('');
      setMessage({ tone: 'success', text: t('detail.disabledDone') });
    } else setMessage({ tone: 'error', text: problemMessage(result.status, result.problem) });
  }

  if (missing) {
    return (
      <EmptyState
        icon={<Ticket className="size-8" aria-hidden />}
        title={t('detail.notFoundTitle')}
        description={t('detail.notFoundDescription')}
      />
    );
  }
  if (!voucher) return <p className="text-sm text-muted">{tCommon('loading')}</p>;

  const date = (value: string | null) =>
    value ? format.dateTime(new Date(value), { dateStyle: 'medium', timeStyle: 'short' }) : null;
  const unlimited = t('detail.unlimited');

  return (
    <div className="flex flex-col gap-6">
      <Link
        href="/tickets"
        className="flex items-center gap-1 text-sm text-primary hover:underline"
      >
        <ArrowLeft className="size-4" aria-hidden /> {t('detail.back')}
      </Link>
      <PageHeader
        title={t('serial', { serial: voucher.serial })}
        subtitle={`${voucher.plan.name} · ${voucher.site.name}${
          voucher.batchLabel ? ` · ${voucher.batchLabel}` : ''
        }`}
        actions={
          <div className="flex flex-wrap gap-2">
            {permissions.any('vouchers.export') ? (
              <PrintLink href={`/tickets/impression/ticket/${voucher.id}`} label={t('print')} />
            ) : null}
            {permissions.any('vouchers.disable') && voucher.state !== 'DISABLED' ? (
              <Button
                variant="danger"
                onClick={() => {
                  setConfirming(true);
                }}
              >
                {t('detail.disable')}
              </Button>
            ) : null}
          </div>
        }
      />
      {message ? <FormMessage tone={message.tone}>{message.text}</FormMessage> : null}
      {confirming ? (
        <ConfirmPanel
          title={t('detail.disableTitle', { serial: voucher.serial })}
          description={t('detail.disableDescription')}
        >
          <FieldShell id="disable-reason" label={t('detail.reason')}>
            <Textarea
              id="disable-reason"
              maxLength={200}
              value={reason}
              onChange={(event) => {
                setReason(event.target.value);
              }}
            />
          </FieldShell>
          <div className="flex gap-2">
            <Button variant="danger" onClick={() => void disable()}>
              {t('detail.disableConfirm')}
            </Button>
            <Button
              variant="secondary"
              onClick={() => {
                setConfirming(false);
              }}
            >
              {tCommon('cancel')}
            </Button>
          </div>
        </ConfirmPanel>
      ) : null}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>{t('detail.status')}</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="divide-y divide-border" data-testid="voucher-status">
              <div className="grid grid-cols-2 gap-2 py-2 text-sm">
                <dt className="text-muted">{t('detail.state')}</dt>
                <dd>
                  <Badge tone={VOUCHER_STATE_TONE[voucher.state]} dot>
                    {t(`states.${voucher.state}`)}
                  </Badge>
                </dd>
              </div>
              <Row label={t('detail.created')} value={date(voucher.createdAt)} />
              <Row
                label={t('detail.activated')}
                value={date(voucher.activatedAt) ?? t('detail.notUsed')}
              />
              <Row label={t('detail.expires')} value={date(voucher.expiresAt)} />
              <Row label={t('detail.lastUsed')} value={date(voucher.lastUsedAt)} />
              {voucher.state === 'DISABLED' ? (
                <>
                  <Row label={t('detail.disabledAt')} value={date(voucher.disabledAt)} />
                  <Row label={t('detail.disabledBy')} value={voucher.disabledBy?.fullName} />
                  <Row label={t('detail.reason')} value={voucher.disabledReason} />
                </>
              ) : null}
            </dl>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>{t('detail.usage')}</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="divide-y divide-border">
              <Row
                label={t('detail.price')}
                value={formatMoney(voucher.priceMinor, voucher.currency)}
              />
              <Row
                label={t('detail.timeUsed')}
                value={`${formatDuration(voucher.usedSeconds)} / ${
                  voucher.sessionTimeSeconds
                    ? formatDuration(voucher.sessionTimeSeconds)
                    : unlimited
                }`}
              />
              <Row
                label={t('detail.timeLeft')}
                value={
                  voucher.remaining.sessionSeconds === null
                    ? unlimited
                    : formatDuration(voucher.remaining.sessionSeconds)
                }
              />
              <Row
                label={t('detail.dataUsed')}
                value={`${formatBytes(voucher.usedBytes)} / ${
                  voucher.dataQuotaBytes ? formatVolume(voucher.dataQuotaBytes) : unlimited
                }`}
              />
              <Row
                label={t('detail.validity')}
                value={
                  voucher.validitySeconds
                    ? voucher.remaining.validitySeconds === null
                      ? t('detail.validityFromFirstUse', {
                          duration: formatDuration(voucher.validitySeconds),
                        })
                      : t('detail.validityLeft', {
                          duration: formatDuration(voucher.remaining.validitySeconds),
                        })
                    : unlimited
                }
              />
              <Row
                label={t('detail.rate')}
                value={`↑ ${voucher.rateUpKbps ? formatRate(voucher.rateUpKbps) : unlimited} · ↓ ${
                  voucher.rateDownKbps ? formatRate(voucher.rateDownKbps) : unlimited
                }`}
              />
              <Row label={t('detail.devices')} value={String(voucher.maxDevices)} />
            </dl>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{t('detail.sessions')}</CardTitle>
        </CardHeader>
        <CardContent>
          {voucher.sessions.length === 0 ? (
            <p className="text-sm text-muted">{t('detail.noSessions')}</p>
          ) : (
            <DataTable testId="voucher-sessions">
              <thead>
                <tr>
                  <Th>{t('sessions.started')}</Th>
                  <Th>{t('sessions.router')}</Th>
                  <Th>{t('sessions.device')}</Th>
                  <Th>{t('sessions.duration')}</Th>
                  <Th>{t('sessions.data')}</Th>
                  <Th>{t('sessions.end')}</Th>
                </tr>
              </thead>
              <tbody>
                {voucher.sessions.map((session) => (
                  <tr key={session.id}>
                    <Td className="whitespace-nowrap">{date(session.startedAt)}</Td>
                    <Td>{session.router.name}</Td>
                    <Td className="font-mono text-xs">{session.macAddress ?? '—'}</Td>
                    <Td>{formatDuration(session.durationSeconds)}</Td>
                    <Td className="text-xs whitespace-nowrap">
                      ↑ {formatBytes(session.bytesUp)} · ↓ {formatBytes(session.bytesDown)}
                    </Td>
                    <Td>{session.stoppedAt ? date(session.stoppedAt) : t('sessions.ongoing')}</Td>
                  </tr>
                ))}
              </tbody>
            </DataTable>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('detail.attempts')}</CardTitle>
        </CardHeader>
        <CardContent>
          {voucher.authAttempts.length === 0 ? (
            <p className="text-sm text-muted">{t('detail.noAttempts')}</p>
          ) : (
            <ul className="flex flex-col divide-y divide-border text-sm">
              {voucher.authAttempts.map((attempt) => (
                <li key={`${attempt.at}-${attempt.result}`} className="flex flex-wrap gap-3 py-2">
                  <span className="text-muted">{date(attempt.at)}</span>
                  <Badge tone={attempt.result === 'ACCEPT' ? 'success' : 'danger'}>
                    {attempt.result === 'ACCEPT'
                      ? t('detail.accepted')
                      : t.has(`reasons.${attempt.reason ?? ''}`)
                        ? t(`reasons.${attempt.reason ?? ''}`)
                        : t('detail.rejected')}
                  </Badge>
                  {attempt.router ? <span>{attempt.router.name}</span> : null}
                  {attempt.callingStationId ? (
                    <span className="font-mono text-xs text-muted">{attempt.callingStationId}</span>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
