'use client';

import {
  formatMoney,
  MAX_BATCH_QUANTITY,
  minVoucherLength,
  type Plan,
  type Site,
  type Voucher,
  VOUCHER_ALPHABETS,
  VOUCHER_AUTH_MODES,
  VOUCHER_CHARSETS,
  type VoucherBatch,
  type VoucherCharset,
} from '@ecsi/shared';
import { Badge, Button, Card, CardContent, EmptyState, Input } from '@ecsi/ui';
import { Plus, Ticket } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { type SubmitEvent, useCallback, useEffect, useMemo, useState } from 'react';
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

const dateTime = (iso: string) =>
  new Intl.DateTimeFormat('fr-FR', { dateStyle: 'short', timeStyle: 'short' }).format(
    new Date(iso),
  );

/** Exemple de code affiché sous le formulaire (aperçu local, jamais un vrai code). */
function exampleCode(charset: VoucherCharset, length: number, prefix: string) {
  const alphabet = VOUCHER_ALPHABETS[charset];
  let code = prefix;
  for (let i = 0; i < length; i += 1) code += alphabet.charAt((i * 7 + 3) % alphabet.length);
  return code;
}

/** Tickets : lots générés, génération en masse et recherche exacte d'un code. */
export function VouchersManager() {
  const t = useTranslations('tickets');
  const permissions = usePermissions();
  const problemMessage = useProblemMessage();
  const router = useRouter();
  const [batches, setBatches] = useState<VoucherBatch[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [code, setCode] = useState('');
  const [searchMessage, setSearchMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    const result = await api<VoucherBatch[]>('/voucher-batches');
    if (result.ok) {
      setBatches(result.data);
      setError(null);
    } else setError(problemMessage(result.status, result.problem));
  }, [problemMessage]);

  useEffect(() => {
    // Chargement initial (et après chaque changement de filtre).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  async function search(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!code.trim()) return;
    const result = await api<Voucher[]>(`/vouchers?code=${encodeURIComponent(code.trim())}`);
    const [found] = result.ok ? result.data : [];
    if (found) router.push(`/tickets/lots/${found.batchId}?ticket=${found.id}`);
    else setSearchMessage(t('searchNone'));
  }

  return (
    <div className="flex flex-col gap-4">
      <Toolbar>
        <form onSubmit={(event) => void search(event)} className="col-span-2 flex-1 sm:max-w-xs">
          <FieldShell id="ticket-search" label={t('search')}>
            <Input
              id="ticket-search"
              type="search"
              autoComplete="off"
              placeholder={t('searchPlaceholder')}
              value={code}
              onChange={(event) => {
                setCode(event.target.value);
                setSearchMessage(null);
              }}
            />
          </FieldShell>
        </form>
        {permissions.any('vouchers.generate') && !creating ? (
          <Button
            className="col-span-2 sm:ml-auto"
            onClick={() => {
              setCreating(true);
            }}
          >
            <Plus className="size-4" aria-hidden /> {t('generate')}
          </Button>
        ) : null}
      </Toolbar>
      {searchMessage ? <FormMessage tone="error">{searchMessage}</FormMessage> : null}

      {creating ? (
        <Card>
          <CardContent className="pt-5">
            <GenerateForm
              onCancel={() => {
                setCreating(false);
              }}
              onGenerated={(batch) => {
                setCreating(false);
                router.push(`/tickets/lots/${batch.id}`);
              }}
            />
          </CardContent>
        </Card>
      ) : null}

      {error ? <FormMessage tone="error">{error}</FormMessage> : null}

      {batches?.length === 0 ? (
        <EmptyState
          icon={<Ticket className="size-8" aria-hidden />}
          title={t('emptyTitle')}
          description={t('emptyDescription')}
        />
      ) : null}

      {batches && batches.length > 0 ? (
        <DataTable testId="batches-table">
          <thead>
            <tr>
              <Th>{t('columns.number')}</Th>
              <Th>{t('columns.label')}</Th>
              <Th>{t('columns.plan')}</Th>
              <Th>{t('columns.site')}</Th>
              <Th>{t('columns.quantity')}</Th>
              <Th>{t('columns.available')}</Th>
              <Th>{t('columns.disabled')}</Th>
              <Th>{t('columns.value')}</Th>
              <Th>{t('columns.createdAt')}</Th>
            </tr>
          </thead>
          <tbody>
            {batches.map((batch) => (
              <tr key={batch.id}>
                <Td>
                  <Link
                    href={`/tickets/lots/${batch.id}`}
                    className="font-medium text-primary hover:underline"
                  >
                    {t('batch.title', { number: batch.number })}
                  </Link>
                </Td>
                <Td>{batch.label ?? <span className="text-muted">—</span>}</Td>
                <Td>{batch.plan.name}</Td>
                <Td>{batch.site.name}</Td>
                <Td>{batch.quantity}</Td>
                <Td>
                  <Badge tone="success">{batch.counts.AVAILABLE}</Badge>
                </Td>
                <Td>
                  {batch.counts.DISABLED > 0 ? (
                    <Badge tone="neutral">{batch.counts.DISABLED}</Badge>
                  ) : (
                    <span className="text-muted">0</span>
                  )}
                </Td>
                <Td>{formatMoney(batch.unitPrice * batch.counts.AVAILABLE, batch.currency)}</Td>
                <Td className="whitespace-nowrap">
                  {dateTime(batch.createdAt)}
                  {batch.createdBy ? (
                    <span className="block text-xs text-muted">{batch.createdBy}</span>
                  ) : null}
                </Td>
              </tr>
            ))}
          </tbody>
        </DataTable>
      ) : null}
    </div>
  );
}

function GenerateForm({
  onGenerated,
  onCancel,
}: {
  onGenerated: (batch: VoucherBatch) => void;
  onCancel: () => void;
}) {
  const t = useTranslations('tickets.form');
  const tTickets = useTranslations('tickets');
  const tCommon = useTranslations('common');
  const problemMessage = useProblemMessage();
  const [plans, setPlans] = useState<Plan[]>([]);
  const [sites, setSites] = useState<Site[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [charset, setCharset] = useState<VoucherCharset>('DIGITS');
  const [length, setLength] = useState(8);
  const [prefix, setPrefix] = useState('');
  const minLength = minVoucherLength(charset);
  const example = useMemo(
    () => exampleCode(charset, Math.max(length, 1), prefix),
    [charset, length, prefix],
  );

  useEffect(() => {
    void api<Plan[]>('/plans').then((result) => {
      if (result.ok) setPlans(result.data.filter((plan) => plan.status === 'ACTIVE'));
    });
    void api<Site[]>('/sites?status=ACTIVE').then((result) => {
      if (result.ok) setSites(result.data);
    });
  }, []);

  async function submit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const expires = fieldValue(form, 'expiresAt');
    const label = fieldValue(form, 'label').trim();
    const body = {
      planId: fieldValue(form, 'planId'),
      siteId: fieldValue(form, 'siteId'),
      quantity: Number(fieldValue(form, 'quantity')),
      authMode: fieldValue(form, 'authMode'),
      charset,
      length,
      prefix: prefix.trim(),
      label: label === '' ? null : label,
      expiresAt: expires ? new Date(`${expires}T23:59:59`).toISOString() : null,
    };
    setPending(true);
    setError(null);
    const result = await api<VoucherBatch>('/voucher-batches', { method: 'POST', body });
    setPending(false);
    if (result.ok) onGenerated(result.data);
    else setError(problemMessage(result.status, result.problem));
  }

  if (plans.length === 0) {
    return (
      <div className="flex flex-col gap-3">
        <p className="text-sm text-muted">{tTickets('noPlan')}</p>
        <div>
          <Link href="/forfaits" className="text-sm font-medium text-primary hover:underline">
            → /forfaits
          </Link>
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-4" noValidate>
      <h2 className="text-base font-semibold">{tTickets('generateTitle')}</h2>
      {error ? <FormMessage tone="error">{error}</FormMessage> : null}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <FieldShell id="planId" label={t('plan')}>
          <Select id="planId" name="planId" required>
            {plans.map((plan) => (
              <option key={plan.id} value={plan.id}>
                {plan.name} — {formatMoney(plan.priceAmount, plan.currency)}
              </option>
            ))}
          </Select>
        </FieldShell>
        <FieldShell id="siteId" label={t('site')} hint={t('siteHint')}>
          <Select id="siteId" name="siteId" required>
            {sites.map((site) => (
              <option key={site.id} value={site.id}>
                {site.name} ({site.code})
              </option>
            ))}
          </Select>
        </FieldShell>
        <Field
          id="quantity"
          label={t('quantity')}
          hint={t('quantityHint')}
          type="number"
          min={1}
          max={MAX_BATCH_QUANTITY}
          defaultValue="50"
          required
        />
        <FieldShell id="authMode" label={t('authMode')}>
          <Select id="authMode" name="authMode" defaultValue="CODE">
            {VOUCHER_AUTH_MODES.map((mode) => (
              <option key={mode} value={mode}>
                {t(`authModes.${mode}`)}
              </option>
            ))}
          </Select>
        </FieldShell>
        <FieldShell id="charset" label={t('charset')}>
          <Select
            id="charset"
            value={charset}
            onChange={(event) => {
              const next = event.target.value as VoucherCharset;
              setCharset(next);
              setLength((current) => Math.max(current, minVoucherLength(next)));
            }}
          >
            {VOUCHER_CHARSETS.map((value) => (
              <option key={value} value={value}>
                {t(`charsets.${value}`)}
              </option>
            ))}
          </Select>
        </FieldShell>
        <FieldShell id="length" label={t('length')} hint={t('lengthHint', { min: minLength })}>
          <Input
            id="length"
            type="number"
            min={minLength}
            max={16}
            value={length}
            onChange={(event) => {
              setLength(Number(event.target.value));
            }}
          />
        </FieldShell>
        <FieldShell id="prefix" label={t('prefix')} hint={t('prefixHint')}>
          <Input
            id="prefix"
            maxLength={6}
            autoComplete="off"
            value={prefix}
            onChange={(event) => {
              setPrefix(event.target.value.replace(/[^A-Za-z2-9]/g, ''));
            }}
          />
        </FieldShell>
        <Field id="label" label={t('label')} placeholder={t('labelPlaceholder')} maxLength={80} />
        <Field id="expiresAt" label={t('expiresAt')} hint={t('expiresAtHint')} type="date" />
      </div>
      <p className="text-sm text-muted">
        {t('preview', { example })}{' '}
        <span className="font-mono text-foreground" aria-hidden>
          ✓
        </span>
      </p>
      <div className="flex gap-2">
        <Button type="submit" disabled={pending || sites.length === 0}>
          {pending ? tTickets('generating') : tTickets('generate')}
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel}>
          {tCommon('cancel')}
        </Button>
      </div>
    </form>
  );
}
