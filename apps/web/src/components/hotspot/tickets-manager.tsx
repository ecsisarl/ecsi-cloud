'use client';

import {
  MAX_BATCH_QUANTITY,
  type Page,
  type Plan,
  type Site,
  type Voucher,
  type VoucherBatch,
  VOUCHER_STATES,
} from '@ecsi/shared';
import {
  Badge,
  Button,
  buttonClasses,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  EmptyState,
  Input,
} from '@ecsi/ui';
import { Plus, Printer, Ticket } from 'lucide-react';
import Link from 'next/link';
import { useFormatter, useTranslations } from 'next-intl';
import { type SubmitEvent, useCallback, useEffect, useState } from 'react';
import { Field, FormMessage, fieldValue } from '@/components/auth/form';
import {
  DataTable,
  FieldShell,
  Select,
  Td,
  Th,
  Toolbar,
  useProblemMessage,
} from '@/components/admin/controls';
import { usePermissions } from '@/components/me-context';
import { api } from '@/lib/client-api';
import { VOUCHER_STATE_TONE } from './format';

const PAGE_SIZE = 25;

function GenerateForm({
  plans,
  sites,
  onGenerated,
  onCancel,
}: {
  plans: Plan[];
  sites: Site[];
  onGenerated: (batch: VoucherBatch) => void;
  onCancel: () => void;
}) {
  const t = useTranslations('tickets');
  const tCommon = useTranslations('common');
  const problemMessage = useProblemMessage();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const active = plans.filter((plan) => plan.status === 'ACTIVE');

  async function submit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setPending(true);
    setError(null);
    const result = await api<VoucherBatch>('/voucher-batches', {
      method: 'POST',
      body: {
        planId: fieldValue(form, 'planId'),
        siteId: fieldValue(form, 'siteId'),
        quantity: Number(fieldValue(form, 'quantity')),
        label: fieldValue(form, 'label').trim(),
      },
    });
    setPending(false);
    if (result.ok) onGenerated(result.data);
    else setError(problemMessage(result.status, result.problem));
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('generate.title')}</CardTitle>
      </CardHeader>
      <CardContent>
        <form
          onSubmit={(event) => void submit(event)}
          className="flex flex-col gap-4"
          noValidate
          data-testid="generate-form"
        >
          {error ? <FormMessage tone="error">{error}</FormMessage> : null}
          <p className="text-sm text-muted">{t('generate.intro')}</p>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <FieldShell id="planId" label={t('generate.plan')}>
              <Select id="planId" name="planId" required defaultValue="">
                <option value="" disabled>
                  {t('generate.choosePlan')}
                </option>
                {active.map((plan) => (
                  <option key={plan.id} value={plan.id}>
                    {plan.name}
                  </option>
                ))}
              </Select>
            </FieldShell>
            <FieldShell id="siteId" label={t('generate.site')}>
              <Select id="siteId" name="siteId" required defaultValue="">
                <option value="" disabled>
                  {t('generate.chooseSite')}
                </option>
                {sites.map((site) => (
                  <option key={site.id} value={site.id}>
                    {site.name} ({site.code})
                  </option>
                ))}
              </Select>
            </FieldShell>
            <Field
              id="quantity"
              label={t('generate.quantity')}
              hint={t('generate.quantityHint', { max: MAX_BATCH_QUANTITY })}
              type="number"
              min={1}
              max={MAX_BATCH_QUANTITY}
              required
              defaultValue="10"
            />
            <Field
              id="label"
              label={t('generate.label')}
              hint={t('generate.labelHint')}
              maxLength={80}
            />
          </div>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={pending}>
              {pending ? t('generate.pending') : t('generate.submit')}
            </Button>
            <Button variant="secondary" onClick={onCancel}>
              {tCommon('cancel')}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

/** Lien vers la feuille d'impression : le code ne figure jamais dans l'URL (seul l'identifiant). */
export function PrintLink({ href, label }: { href: string; label: string }) {
  return (
    <Link href={href} className={buttonClasses('secondary', 'sm')} prefetch={false}>
      <Printer className="size-4" aria-hidden /> {label}
    </Link>
  );
}

/** Activité → Tickets : lots, génération, liste filtrable des tickets (jamais leur code). */
export function TicketsManager() {
  const t = useTranslations('tickets');
  const tCommon = useTranslations('common');
  const format = useFormatter();
  const permissions = usePermissions();
  const problemMessage = useProblemMessage();
  const [plans, setPlans] = useState<Plan[]>([]);
  const [sites, setSites] = useState<Site[]>([]);
  const [batches, setBatches] = useState<Page<VoucherBatch> | null>(null);
  const [vouchers, setVouchers] = useState<Page<Voucher> | null>(null);
  const [generating, setGenerating] = useState(false);
  const [message, setMessage] = useState<{ tone: 'error' | 'success'; text: string } | null>(null);
  const [filters, setFilters] = useState({
    state: '',
    batchId: '',
    siteId: '',
    planId: '',
    serial: '',
  });
  const [offset, setOffset] = useState(0);
  const canPrint = permissions.any('vouchers.export');

  const loadBatches = useCallback(async () => {
    const result = await api<Page<VoucherBatch>>('/voucher-batches?limit=20');
    if (result.ok) setBatches(result.data);
    else setMessage({ tone: 'error', text: problemMessage(result.status, result.problem) });
  }, [problemMessage]);

  const loadVouchers = useCallback(async () => {
    const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset) });
    for (const [key, value] of Object.entries(filters))
      if (value.trim()) params.set(key, value.trim());
    const result = await api<Page<Voucher>>(`/vouchers?${params.toString()}`);
    if (result.ok) setVouchers(result.data);
    else setMessage({ tone: 'error', text: problemMessage(result.status, result.problem) });
  }, [filters, offset, problemMessage]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadBatches();
    void api<Plan[]>('/plans').then((result) => {
      if (result.ok) setPlans(result.data);
    });
    void api<Site[]>('/sites').then((result) => {
      if (result.ok) setSites(result.data.filter((site) => site.status !== 'INACTIVE'));
    });
  }, [loadBatches]);

  useEffect(() => {
    const timer = setTimeout(() => void loadVouchers(), 250);
    return () => {
      clearTimeout(timer);
    };
  }, [loadVouchers]);

  const setFilter = (key: keyof typeof filters, value: string) => {
    setFilters({ ...filters, [key]: value });
    setOffset(0);
  };

  return (
    <div className="flex flex-col gap-6">
      {permissions.any('vouchers.generate') && !generating ? (
        <div>
          <Button
            onClick={() => {
              setGenerating(true);
              setMessage(null);
            }}
          >
            <Plus className="size-4" aria-hidden /> {t('generate.open')}
          </Button>
        </div>
      ) : null}
      {generating ? (
        <GenerateForm
          plans={plans}
          sites={sites}
          onCancel={() => {
            setGenerating(false);
          }}
          onGenerated={(batch) => {
            setGenerating(false);
            setMessage({
              tone: 'success',
              text: t('generate.done', { count: batch.quantity, plan: batch.plan.name }),
            });
            void loadBatches();
            void loadVouchers();
          }}
        />
      ) : null}
      {message ? <FormMessage tone={message.tone}>{message.text}</FormMessage> : null}

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold text-foreground">{t('batches.title')}</h2>
        {batches?.items.length === 0 ? (
          <EmptyState
            icon={<Ticket className="size-8" aria-hidden />}
            title={t('batches.emptyTitle')}
            description={t('batches.emptyDescription')}
          />
        ) : null}
        {batches && batches.items.length > 0 ? (
          <DataTable testId="batches-table">
            <thead>
              <tr>
                <Th>{t('batches.columns.created')}</Th>
                <Th>{t('batches.columns.label')}</Th>
                <Th>{t('batches.columns.plan')}</Th>
                <Th>{t('batches.columns.site')}</Th>
                <Th>{t('batches.columns.quantity')}</Th>
                <Th>{t('batches.columns.states')}</Th>
                <Th>{t('batches.columns.actions')}</Th>
              </tr>
            </thead>
            <tbody>
              {batches.items.map((batch) => (
                <tr key={batch.id}>
                  <Td className="whitespace-nowrap">
                    {format.dateTime(new Date(batch.createdAt), {
                      dateStyle: 'short',
                      timeStyle: 'short',
                    })}
                    {batch.createdBy?.fullName ? (
                      <span className="block text-xs text-muted">{batch.createdBy.fullName}</span>
                    ) : null}
                  </Td>
                  <Td>{batch.label ?? '—'}</Td>
                  <Td>{batch.plan.name}</Td>
                  <Td>{batch.site.name}</Td>
                  <Td>{batch.quantity}</Td>
                  <Td className="text-xs">
                    {VOUCHER_STATES.filter((state) => batch.states[state] > 0).map((state) => (
                      <span key={state} className="block">
                        {t(`states.${state}`)} : {batch.states[state]}
                      </span>
                    ))}
                  </Td>
                  <Td>
                    <div className="flex flex-wrap gap-2">
                      {canPrint ? (
                        <PrintLink href={`/tickets/impression/${batch.id}`} label={t('print')} />
                      ) : null}
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          setFilter('batchId', batch.id);
                        }}
                      >
                        {t('batches.showVouchers')}
                      </Button>
                    </div>
                  </Td>
                </tr>
              ))}
            </tbody>
          </DataTable>
        ) : null}
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold text-foreground">{t('list.title')}</h2>
        <Toolbar>
          <FieldShell id="voucher-state" label={t('list.state')}>
            <Select
              id="voucher-state"
              value={filters.state}
              onChange={(event) => {
                setFilter('state', event.target.value);
              }}
            >
              <option value="">{t('list.allStates')}</option>
              {VOUCHER_STATES.map((state) => (
                <option key={state} value={state}>
                  {t(`states.${state}`)}
                </option>
              ))}
            </Select>
          </FieldShell>
          <FieldShell id="voucher-plan" label={t('list.plan')}>
            <Select
              id="voucher-plan"
              value={filters.planId}
              onChange={(event) => {
                setFilter('planId', event.target.value);
              }}
            >
              <option value="">{t('list.allPlans')}</option>
              {plans.map((plan) => (
                <option key={plan.id} value={plan.id}>
                  {plan.name}
                </option>
              ))}
            </Select>
          </FieldShell>
          <FieldShell id="voucher-site" label={t('list.site')}>
            <Select
              id="voucher-site"
              value={filters.siteId}
              onChange={(event) => {
                setFilter('siteId', event.target.value);
              }}
            >
              <option value="">{t('list.allSites')}</option>
              {sites.map((site) => (
                <option key={site.id} value={site.id}>
                  {site.name}
                </option>
              ))}
            </Select>
          </FieldShell>
          <FieldShell id="voucher-batch" label={t('list.batch')}>
            <Select
              id="voucher-batch"
              value={filters.batchId}
              onChange={(event) => {
                setFilter('batchId', event.target.value);
              }}
            >
              <option value="">{t('list.allBatches')}</option>
              {batches?.items.map((batch) => (
                <option key={batch.id} value={batch.id}>
                  {batch.label ?? batch.plan.name} ·{' '}
                  {format.dateTime(new Date(batch.createdAt), { dateStyle: 'short' })}
                </option>
              ))}
            </Select>
          </FieldShell>
          <div className="w-32">
            <FieldShell id="voucher-serial" label={t('list.serial')}>
              <Input
                id="voucher-serial"
                inputMode="numeric"
                value={filters.serial}
                onChange={(event) => {
                  setFilter('serial', event.target.value.replace(/\D/g, ''));
                }}
              />
            </FieldShell>
          </div>
        </Toolbar>
        {vouchers?.items.length === 0 ? (
          <p className="text-sm text-muted">{t('list.empty')}</p>
        ) : null}
        {vouchers && vouchers.items.length > 0 ? (
          <>
            <DataTable testId="vouchers-table">
              <thead>
                <tr>
                  <Th>{t('list.columns.serial')}</Th>
                  <Th>{t('list.columns.plan')}</Th>
                  <Th>{t('list.columns.site')}</Th>
                  <Th>{t('list.columns.state')}</Th>
                  <Th>{t('list.columns.created')}</Th>
                  <Th>{t('list.columns.activated')}</Th>
                  <Th>{t('list.columns.expires')}</Th>
                </tr>
              </thead>
              <tbody>
                {vouchers.items.map((voucher) => (
                  <tr key={voucher.id}>
                    <Td>
                      <Link
                        href={`/tickets/${voucher.id}`}
                        className="font-medium text-primary hover:underline"
                      >
                        {t('serial', { serial: voucher.serial })}
                      </Link>
                      {voucher.batchLabel ? (
                        <span className="block text-xs text-muted">{voucher.batchLabel}</span>
                      ) : null}
                    </Td>
                    <Td>{voucher.plan.name}</Td>
                    <Td>{voucher.site.name}</Td>
                    <Td>
                      <Badge tone={VOUCHER_STATE_TONE[voucher.state]} dot>
                        {t(`states.${voucher.state}`)}
                      </Badge>
                    </Td>
                    <Td className="whitespace-nowrap">
                      {format.dateTime(new Date(voucher.createdAt), { dateStyle: 'short' })}
                    </Td>
                    <Td className="whitespace-nowrap">
                      {voucher.activatedAt
                        ? format.dateTime(new Date(voucher.activatedAt), {
                            dateStyle: 'short',
                            timeStyle: 'short',
                          })
                        : '—'}
                    </Td>
                    <Td className="whitespace-nowrap">
                      {voucher.expiresAt
                        ? format.dateTime(new Date(voucher.expiresAt), {
                            dateStyle: 'short',
                            timeStyle: 'short',
                          })
                        : '—'}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </DataTable>
            <div className="flex items-center justify-between text-sm text-muted">
              <span>
                {t('list.range', {
                  from: vouchers.offset + 1,
                  to: vouchers.offset + vouchers.items.length,
                  total: vouchers.total,
                })}
              </span>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={offset === 0}
                  onClick={() => {
                    setOffset(Math.max(0, offset - PAGE_SIZE));
                  }}
                >
                  {tCommon('previous')}
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={offset + PAGE_SIZE >= vouchers.total}
                  onClick={() => {
                    setOffset(offset + PAGE_SIZE);
                  }}
                >
                  {tCommon('next')}
                </Button>
              </div>
            </div>
          </>
        ) : null}
      </section>
    </div>
  );
}
