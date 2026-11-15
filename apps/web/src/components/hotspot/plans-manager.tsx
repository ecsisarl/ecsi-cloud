'use client';

import {
  type CreatePlanRequest,
  DEFAULT_CURRENCY,
  formatMoney,
  type Plan,
  PLAN_LIMITS,
  planHasLimit,
  toMinorUnits,
  fromMinorUnits,
} from '@ecsi/shared';
import { Badge, Button, Card, CardContent, CardHeader, CardTitle, EmptyState } from '@ecsi/ui';
import { CreditCard, Plus } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { type SubmitEvent, useCallback, useEffect, useState } from 'react';
import { Field, FormMessage, fieldValue } from '@/components/auth/form';
import {
  ConfirmPanel,
  DataTable,
  FieldShell,
  Select,
  Td,
  Th,
  Textarea,
  useProblemMessage,
} from '@/components/admin/controls';
import { usePermissions } from '@/components/me-context';
import { api } from '@/lib/client-api';
import {
  DURATION_UNITS,
  type DurationUnit,
  formatDuration,
  formatRate,
  formatVolume,
  fromParts,
  QUOTA_UNITS,
  type QuotaUnit,
  RATE_UNITS,
  type RateUnit,
  toParts,
} from './format';

/** Champ numérique + unité (durée, volume, débit). */
function AmountField<U extends string>({
  id,
  label,
  hint,
  units,
  unitLabels,
  initial,
}: {
  id: string;
  label: string;
  hint?: string;
  units: Readonly<Record<U, number>>;
  unitLabels: Record<U, string>;
  initial: { value: string; unit: U };
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium text-foreground">
        {label}
      </label>
      <div className="flex gap-2">
        <input
          id={id}
          name={id}
          inputMode="decimal"
          defaultValue={initial.value}
          aria-describedby={hint ? `${id}-hint` : undefined}
          className="h-10 w-full min-w-0 rounded-md border border-border bg-surface px-3 text-sm text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring"
        />
        <Select
          name={`${id}Unit`}
          aria-label={`${label} (unité)`}
          defaultValue={initial.unit}
          className="w-32 shrink-0"
        >
          {(Object.keys(units) as U[]).map((unit) => (
            <option key={unit} value={unit}>
              {unitLabels[unit]}
            </option>
          ))}
        </Select>
      </div>
      {hint ? (
        <p id={`${id}-hint`} className="text-xs text-muted">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

function PlanForm({
  plan,
  currency,
  onSaved,
  onCancel,
}: {
  plan: Plan | null;
  currency: string;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const t = useTranslations('plans');
  const tCommon = useTranslations('common');
  const problemMessage = useProblemMessage();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const durationLabels = {
    MINUTES: t('units.minutes'),
    HOURS: t('units.hours'),
    DAYS: t('units.days'),
  };
  const quotaLabels = { MB: 'Mo', GB: 'Go' };
  const rateLabels = { KBPS: 'kbit/s', MBPS: 'Mbit/s' };

  async function submit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const read = <U extends string>(name: string, units: Readonly<Record<U, number>>) =>
      fromParts(fieldValue(form, name), fieldValue(form, `${name}Unit`) as U, units);
    const price = Number(fieldValue(form, 'price').trim().replace(',', '.') || 'NaN');
    const body = {
      name: fieldValue(form, 'name').trim(),
      description: fieldValue(form, 'description').trim(),
      priceMinor: Number.isFinite(price) && price >= 0 ? toMinorUnits(price, currency) : -1,
      validitySeconds: read<DurationUnit>('validity', DURATION_UNITS),
      sessionTimeSeconds: read<DurationUnit>('sessionTime', DURATION_UNITS),
      rateUpKbps: read<RateUnit>('rateUp', RATE_UNITS),
      rateDownKbps: read<RateUnit>('rateDown', RATE_UNITS),
      dataQuotaBytes: read<QuotaUnit>('quota', QUOTA_UNITS),
      maxDevices: Number(fieldValue(form, 'maxDevices')),
      idleTimeoutSeconds: Number(fieldValue(form, 'idleMinutes')) * 60,
    } satisfies Record<keyof CreatePlanRequest, unknown>;
    if (Object.values(body).some((value) => Number.isNaN(value)) || body.priceMinor < 0) {
      setError(t('invalidNumber'));
      return;
    }
    if (!planHasLimit(body)) {
      setError(t('limitRequired'));
      return;
    }
    setPending(true);
    setError(null);
    const result = plan
      ? await api<Plan>(`/plans/${plan.id}`, { method: 'PATCH', body })
      : await api<Plan>('/plans', { method: 'POST', body });
    setPending(false);
    if (result.ok) onSaved();
    else setError(problemMessage(result.status, result.problem));
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{plan ? t('editTitle', { name: plan.name }) : t('createTitle')}</CardTitle>
      </CardHeader>
      <CardContent>
        <form
          onSubmit={(event) => void submit(event)}
          className="flex flex-col gap-4"
          noValidate
          data-testid="plan-form"
        >
          {error ? <FormMessage tone="error">{error}</FormMessage> : null}
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <Field
              id="name"
              label={t('fields.name')}
              required
              maxLength={80}
              defaultValue={plan?.name ?? ''}
            />
            <Field
              id="price"
              label={t('fields.price', { currency: currency === 'XOF' ? 'FCFA' : currency })}
              inputMode="decimal"
              required
              defaultValue={plan ? String(fromMinorUnits(plan.priceMinor, plan.currency)) : ''}
            />
            <div className="md:col-span-2">
              <FieldShell id="description" label={t('fields.description')}>
                <Textarea
                  id="description"
                  name="description"
                  maxLength={500}
                  defaultValue={plan?.description ?? ''}
                />
              </FieldShell>
            </div>
          </div>
          <p className="text-sm text-muted">{t('limitsIntro')}</p>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
            <AmountField
              id="validity"
              label={t('fields.validity')}
              hint={t('hints.validity')}
              units={DURATION_UNITS}
              unitLabels={durationLabels}
              initial={toParts(plan?.validitySeconds ?? null, DURATION_UNITS, 'DAYS')}
            />
            <AmountField
              id="sessionTime"
              label={t('fields.sessionTime')}
              hint={t('hints.sessionTime')}
              units={DURATION_UNITS}
              unitLabels={durationLabels}
              initial={toParts(plan?.sessionTimeSeconds ?? null, DURATION_UNITS, 'HOURS')}
            />
            <AmountField
              id="quota"
              label={t('fields.quota')}
              hint={t('hints.quota')}
              units={QUOTA_UNITS}
              unitLabels={quotaLabels}
              initial={toParts(plan?.dataQuotaBytes ?? null, QUOTA_UNITS, 'MB')}
            />
            <AmountField
              id="rateUp"
              label={t('fields.rateUp')}
              hint={t('hints.rate')}
              units={RATE_UNITS}
              unitLabels={rateLabels}
              initial={toParts(plan?.rateUpKbps ?? null, RATE_UNITS, 'MBPS')}
            />
            <AmountField
              id="rateDown"
              label={t('fields.rateDown')}
              hint={t('hints.rate')}
              units={RATE_UNITS}
              unitLabels={rateLabels}
              initial={toParts(plan?.rateDownKbps ?? null, RATE_UNITS, 'MBPS')}
            />
            <Field
              id="maxDevices"
              label={t('fields.maxDevices')}
              hint={t('hints.maxDevices')}
              type="number"
              min={PLAN_LIMITS.minDevices}
              max={PLAN_LIMITS.maxDevices}
              defaultValue={String(plan?.maxDevices ?? 1)}
            />
            <Field
              id="idleMinutes"
              label={t('fields.idle')}
              hint={t('hints.idle')}
              type="number"
              min={1}
              max={1440}
              defaultValue={String(
                (plan?.idleTimeoutSeconds ?? PLAN_LIMITS.defaultIdleSeconds) / 60,
              )}
            />
          </div>
          {plan ? <p className="text-xs text-muted">{t('editNotice')}</p> : null}
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={pending}>
              {pending ? tCommon('saving') : plan ? tCommon('save') : t('create')}
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

/** Activité → Forfaits : forfaits de l'entreprise (prix, durée, débit, volume). */
export function PlansManager() {
  const t = useTranslations('plans');
  const tCommon = useTranslations('common');
  const permissions = usePermissions();
  const problemMessage = useProblemMessage();
  const [plans, setPlans] = useState<Plan[] | null>(null);
  const [editing, setEditing] = useState<Plan | 'new' | null>(null);
  const [deleting, setDeleting] = useState<Plan | null>(null);
  const [message, setMessage] = useState<{ tone: 'error' | 'success'; text: string } | null>(null);
  const canManage = permissions.companyWide('plans.manage');
  const [companyCurrency, setCompanyCurrency] = useState<string | null>(null);
  const currency = plans?.[0]?.currency ?? companyCurrency ?? DEFAULT_CURRENCY;

  const load = useCallback(async () => {
    const result = await api<Plan[]>('/plans');
    if (result.ok) setPlans(result.data);
    else setMessage({ tone: 'error', text: problemMessage(result.status, result.problem) });
  }, [problemMessage]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  // Devise de l'entreprise (le prix est saisi dans cette devise) ; XOF par défaut.
  useEffect(() => {
    if (!canManage) return;
    void api<{ currency: string }>('/company').then((result) => {
      if (result.ok) setCompanyCurrency(result.data.currency);
    });
  }, [canManage]);

  async function act(path: string, method: 'POST' | 'DELETE', success: string) {
    const result = await api(path, { method });
    if (result.ok) {
      setMessage({ tone: 'success', text: success });
      setDeleting(null);
      void load();
    } else setMessage({ tone: 'error', text: problemMessage(result.status, result.problem) });
  }

  return (
    <div className="flex flex-col gap-4">
      {canManage && editing === null ? (
        <div>
          <Button
            onClick={() => {
              setEditing('new');
              setMessage(null);
            }}
          >
            <Plus className="size-4" aria-hidden /> {t('add')}
          </Button>
        </div>
      ) : null}
      {editing !== null ? (
        <PlanForm
          plan={editing === 'new' ? null : editing}
          currency={editing === 'new' ? currency : editing.currency}
          onCancel={() => {
            setEditing(null);
          }}
          onSaved={() => {
            setEditing(null);
            setMessage({ tone: 'success', text: tCommon('saved') });
            void load();
          }}
        />
      ) : null}
      {message ? <FormMessage tone={message.tone}>{message.text}</FormMessage> : null}
      {deleting ? (
        <ConfirmPanel
          title={t('deleteTitle', { name: deleting.name })}
          description={t('deleteDescription')}
        >
          <div className="flex gap-2">
            <Button
              variant="danger"
              onClick={() => void act(`/plans/${deleting.id}`, 'DELETE', t('deleted'))}
            >
              {t('deleteConfirm')}
            </Button>
            <Button
              variant="secondary"
              onClick={() => {
                setDeleting(null);
              }}
            >
              {tCommon('cancel')}
            </Button>
          </div>
        </ConfirmPanel>
      ) : null}

      {plans === null ? <p className="text-sm text-muted">{tCommon('loading')}</p> : null}
      {plans?.length === 0 ? (
        <EmptyState
          icon={<CreditCard className="size-8" aria-hidden />}
          title={t('emptyTitle')}
          description={t('emptyDescription')}
        />
      ) : null}
      {plans && plans.length > 0 ? (
        <DataTable testId="plans-table">
          <thead>
            <tr>
              <Th>{t('columns.name')}</Th>
              <Th>{t('columns.price')}</Th>
              <Th>{t('columns.validity')}</Th>
              <Th>{t('columns.sessionTime')}</Th>
              <Th>{t('columns.quota')}</Th>
              <Th>{t('columns.rate')}</Th>
              <Th>{t('columns.devices')}</Th>
              <Th>{t('columns.status')}</Th>
              {canManage ? <Th>{t('columns.actions')}</Th> : null}
            </tr>
          </thead>
          <tbody>
            {plans.map((plan) => (
              <tr key={plan.id}>
                <Td>
                  <span className="font-medium text-foreground">{plan.name}</span>
                  {plan.description ? (
                    <span className="block text-xs text-muted">{plan.description}</span>
                  ) : null}
                </Td>
                <Td className="whitespace-nowrap">{formatMoney(plan.priceMinor, plan.currency)}</Td>
                <Td>{plan.validitySeconds ? formatDuration(plan.validitySeconds) : t('none')}</Td>
                <Td>
                  {plan.sessionTimeSeconds
                    ? formatDuration(plan.sessionTimeSeconds)
                    : t('unlimited')}
                </Td>
                <Td>{plan.dataQuotaBytes ? formatVolume(plan.dataQuotaBytes) : t('unlimited')}</Td>
                <Td className="whitespace-nowrap text-xs">
                  <span className="block">
                    ↑ {plan.rateUpKbps ? formatRate(plan.rateUpKbps) : t('unlimited')}
                  </span>
                  <span className="block">
                    ↓ {plan.rateDownKbps ? formatRate(plan.rateDownKbps) : t('unlimited')}
                  </span>
                </Td>
                <Td>{plan.maxDevices}</Td>
                <Td>
                  <Badge tone={plan.status === 'ACTIVE' ? 'success' : 'neutral'} dot>
                    {t(`statuses.${plan.status}`)}
                  </Badge>
                </Td>
                {canManage ? (
                  <Td>
                    <div className="flex flex-wrap gap-2">
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => {
                          setEditing(plan);
                          setMessage(null);
                        }}
                      >
                        {tCommon('edit')}
                      </Button>
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() =>
                          void act(
                            `/plans/${plan.id}/${plan.status === 'ACTIVE' ? 'disable' : 'enable'}`,
                            'POST',
                            plan.status === 'ACTIVE' ? t('disabled') : t('enabled'),
                          )
                        }
                      >
                        {plan.status === 'ACTIVE' ? t('disable') : t('enable')}
                      </Button>
                      <Button
                        size="sm"
                        variant="danger"
                        onClick={() => {
                          setDeleting(plan);
                        }}
                      >
                        {tCommon('delete')}
                      </Button>
                    </div>
                  </Td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </DataTable>
      ) : null}
    </div>
  );
}
