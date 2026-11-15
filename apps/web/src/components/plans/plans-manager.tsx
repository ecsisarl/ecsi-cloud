'use client';

import {
  formatBytes,
  formatDuration,
  formatMoney,
  formatRate,
  type Plan,
  PLAN_STATUSES,
} from '@ecsi/shared';
import { Badge, Button, Card, CardContent, EmptyState } from '@ecsi/ui';
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
  Toolbar,
  useProblemMessage,
} from '@/components/admin/controls';
import { usePermissions } from '@/components/me-context';
import { api } from '@/lib/client-api';

const TIME_UNITS = { minutes: 60, hours: 3600, days: 86_400 } as const;
type TimeUnit = keyof typeof TIME_UNITS;
const BYTE_UNITS = { mb: 1024 ** 2, gb: 1024 ** 3 } as const;
type ByteUnit = keyof typeof BYTE_UNITS;

/** Décompose une durée en (valeur, unité) la plus lisible pour le formulaire. */
function splitDuration(seconds: number | null): [string, TimeUnit] {
  if (seconds === null) return ['', 'hours'];
  if (seconds % 86_400 === 0) return [String(seconds / 86_400), 'days'];
  if (seconds % 3600 === 0) return [String(seconds / 3600), 'hours'];
  return [String(Math.round(seconds / 60)), 'minutes'];
}

function splitBytes(bytes: number | null): [string, ByteUnit] {
  if (bytes === null) return ['', 'gb'];
  if (bytes % BYTE_UNITS.gb === 0) return [String(bytes / BYTE_UNITS.gb), 'gb'];
  return [String(Math.round(bytes / BYTE_UNITS.mb)), 'mb'];
}

const decimal = (value: string) => Number(value.replace(',', '.'));
const orNull = (value: string, factor: number) =>
  value.trim() === '' ? null : Math.round(decimal(value) * factor);

/** Forfaits (Mikhmon : profils utilisateur avec prix). */
export function PlansManager() {
  const t = useTranslations('plans');
  const tCommon = useTranslations('common');
  const permissions = usePermissions();
  const problemMessage = useProblemMessage();
  const [plans, setPlans] = useState<Plan[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Plan | 'new' | null>(null);
  const [deleting, setDeleting] = useState<Plan | null>(null);
  const canManage = permissions.companyWide('plans.manage');

  const load = useCallback(async () => {
    const result = await api<Plan[]>('/plans');
    if (result.ok) {
      setPlans(result.data);
      setError(null);
    } else setError(problemMessage(result.status, result.problem));
  }, [problemMessage]);

  useEffect(() => {
    // Chargement initial (et après chaque changement de filtre).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  async function remove(plan: Plan) {
    const result = await api(`/plans/${plan.id}`, { method: 'DELETE' });
    setDeleting(null);
    if (result.ok) void load();
    else setError(problemMessage(result.status, result.problem));
  }

  return (
    <div className="flex flex-col gap-4">
      {canManage ? (
        editing === null ? (
          <Toolbar>
            <Button
              className="col-span-2 sm:ml-auto"
              onClick={() => {
                setEditing('new');
              }}
            >
              <Plus className="size-4" aria-hidden /> {t('add')}
            </Button>
          </Toolbar>
        ) : (
          <Card>
            <CardContent className="pt-5">
              <PlanForm
                key={editing === 'new' ? 'new' : editing.id}
                plan={editing === 'new' ? undefined : editing}
                onCancel={() => {
                  setEditing(null);
                }}
                onSaved={() => {
                  setEditing(null);
                  void load();
                }}
              />
            </CardContent>
          </Card>
        )
      ) : (
        <p className="text-sm text-muted">{t('readOnly')}</p>
      )}

      {error ? <FormMessage tone="error">{error}</FormMessage> : null}

      {deleting ? (
        <ConfirmPanel title={`${deleting.name} — ${t('delete')}`} description={t('deleteConfirm')}>
          <div className="flex gap-2">
            <Button variant="danger" size="sm" onClick={() => void remove(deleting)}>
              {t('delete')}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setDeleting(null);
              }}
            >
              {tCommon('cancel')}
            </Button>
          </div>
        </ConfirmPanel>
      ) : null}

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
              <Th>{t('columns.time')}</Th>
              <Th>{t('columns.validity')}</Th>
              <Th>{t('columns.rate')}</Th>
              <Th>{t('columns.quota')}</Th>
              <Th>{t('columns.devices')}</Th>
              <Th>{t('columns.status')}</Th>
              {canManage ? <Th /> : null}
            </tr>
          </thead>
          <tbody>
            {plans.map((plan) => (
              <tr key={plan.id}>
                <Td className="font-medium">{plan.name}</Td>
                <Td>{formatMoney(plan.priceAmount, plan.currency)}</Td>
                <Td>{formatDuration(plan.sessionTimeSeconds)}</Td>
                <Td>{formatDuration(plan.validitySeconds)}</Td>
                <Td>
                  {formatRate(plan.rateDownKbps)} / {formatRate(plan.rateUpKbps)}
                </Td>
                <Td>{formatBytes(plan.dataQuotaBytes)}</Td>
                <Td>{plan.maxDevices}</Td>
                <Td>
                  <Badge tone={plan.status === 'ACTIVE' ? 'success' : 'neutral'} dot>
                    {t(`form.statuses.${plan.status}`)}
                  </Badge>
                </Td>
                {canManage ? (
                  <Td className="text-right whitespace-nowrap">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setEditing(plan);
                      }}
                    >
                      {t('edit')}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setDeleting(plan);
                      }}
                    >
                      {t('delete')}
                    </Button>
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

function PlanForm({
  plan,
  onSaved,
  onCancel,
}: {
  plan?: Plan;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const t = useTranslations('plans.form');
  const tCommon = useTranslations('common');
  const problemMessage = useProblemMessage();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [time, timeUnit] = splitDuration(plan?.sessionTimeSeconds ?? null);
  const [validity, validityUnit] = splitDuration(plan?.validitySeconds ?? null);
  const [quota, quotaUnit] = splitBytes(plan?.dataQuotaBytes ?? null);

  async function submit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const unit = (name: string) => TIME_UNITS[fieldValue(form, name) as TimeUnit];
    const description = fieldValue(form, 'description').trim();
    const body = {
      name: fieldValue(form, 'name').trim(),
      description: description === '' ? null : description,
      priceAmount: Math.round(decimal(fieldValue(form, 'priceAmount'))),
      currency: fieldValue(form, 'currency') || 'XOF',
      sessionTimeSeconds: orNull(fieldValue(form, 'sessionTime'), unit('sessionTimeUnit')),
      validitySeconds: orNull(fieldValue(form, 'validity'), unit('validityUnit')),
      rateDownKbps: orNull(fieldValue(form, 'rateDown'), 1000),
      rateUpKbps: orNull(fieldValue(form, 'rateUp'), 1000),
      dataQuotaBytes: orNull(
        fieldValue(form, 'quota'),
        BYTE_UNITS[fieldValue(form, 'quotaUnit') as ByteUnit],
      ),
      maxDevices: Number(fieldValue(form, 'maxDevices') || '1'),
      macBinding: form.get('macBinding') === 'on',
      sortOrder: Number(fieldValue(form, 'sortOrder') || '0'),
      status: fieldValue(form, 'status'),
    };
    setPending(true);
    setError(null);
    const result = plan
      ? await api<Plan>(`/plans/${plan.id}`, { method: 'PATCH', body })
      : await api<Plan>('/plans', { method: 'POST', body });
    setPending(false);
    if (result.ok) onSaved();
    else setError(problemMessage(result.status, result.problem));
  }

  const unitSelect = (name: string, value: TimeUnit) => (
    <Select id={name} name={name} defaultValue={value} className="w-32" aria-label={name}>
      {(Object.keys(TIME_UNITS) as TimeUnit[]).map((unit) => (
        <option key={unit} value={unit}>
          {t(`units.${unit}`)}
        </option>
      ))}
    </Select>
  );

  return (
    <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-4" noValidate>
      {error ? <FormMessage tone="error">{error}</FormMessage> : null}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <Field
          id="name"
          label={t('name')}
          placeholder={t('namePlaceholder')}
          required
          defaultValue={plan?.name}
          maxLength={80}
        />
        <Field
          id="priceAmount"
          label={t('price')}
          inputMode="numeric"
          required
          defaultValue={plan ? String(plan.priceAmount) : ''}
        />
        <FieldShell id="currency" label={t('currency')}>
          <Select id="currency" name="currency" defaultValue={plan?.currency ?? 'XOF'}>
            {['XOF', 'XAF', 'GNF', 'EUR', 'USD', 'GHS', 'NGN'].map((code) => (
              <option key={code} value={code}>
                {code === 'XOF' ? 'FCFA (XOF)' : code}
              </option>
            ))}
          </Select>
        </FieldShell>
        <FieldShell id="sessionTime" label={t('sessionTime')} hint={t('sessionTimeHint')}>
          <div className="flex gap-2">
            <input
              id="sessionTime"
              name="sessionTime"
              inputMode="numeric"
              defaultValue={time}
              className="h-10 w-full rounded-md border border-border bg-surface px-3 text-sm"
            />
            {unitSelect('sessionTimeUnit', timeUnit)}
          </div>
        </FieldShell>
        <FieldShell id="validity" label={t('validity')} hint={t('validityHint')}>
          <div className="flex gap-2">
            <input
              id="validity"
              name="validity"
              inputMode="numeric"
              defaultValue={validity}
              className="h-10 w-full rounded-md border border-border bg-surface px-3 text-sm"
            />
            {unitSelect('validityUnit', validityUnit)}
          </div>
        </FieldShell>
        <FieldShell id="quota" label={t('quota')} hint={t('quotaHint')}>
          <div className="flex gap-2">
            <input
              id="quota"
              name="quota"
              inputMode="decimal"
              defaultValue={quota}
              className="h-10 w-full rounded-md border border-border bg-surface px-3 text-sm"
            />
            <Select
              id="quotaUnit"
              name="quotaUnit"
              defaultValue={quotaUnit}
              className="w-24"
              aria-label="quotaUnit"
            >
              <option value="mb">{t('units.mb')}</option>
              <option value="gb">{t('units.gb')}</option>
            </Select>
          </div>
        </FieldShell>
        <Field
          id="rateDown"
          label={t('rateDown')}
          hint={t('rateHint')}
          inputMode="decimal"
          defaultValue={plan?.rateDownKbps ? String(plan.rateDownKbps / 1000) : ''}
        />
        <Field
          id="rateUp"
          label={t('rateUp')}
          hint={t('rateHint')}
          inputMode="decimal"
          defaultValue={plan?.rateUpKbps ? String(plan.rateUpKbps / 1000) : ''}
        />
        <Field
          id="maxDevices"
          label={t('maxDevices')}
          type="number"
          min={1}
          max={20}
          defaultValue={String(plan?.maxDevices ?? 1)}
        />
        <Field
          id="sortOrder"
          label={t('sortOrder')}
          type="number"
          min={0}
          defaultValue={String(plan?.sortOrder ?? 0)}
        />
        <FieldShell id="status" label={t('status')}>
          <Select id="status" name="status" defaultValue={plan?.status ?? 'ACTIVE'}>
            {PLAN_STATUSES.map((status) => (
              <option key={status} value={status}>
                {t(`statuses.${status}`)}
              </option>
            ))}
          </Select>
        </FieldShell>
        <Field
          id="description"
          label={t('description')}
          defaultValue={plan?.description ?? ''}
          maxLength={500}
        />
      </div>
      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          name="macBinding"
          defaultChecked={plan?.macBinding ?? false}
          className="mt-1"
        />
        <span>
          {t('macBinding')}
          <span className="block text-xs text-muted">{t('macBindingHint')}</span>
        </span>
      </label>
      <div className="flex gap-2">
        <Button type="submit" disabled={pending}>
          {pending ? tCommon('saving') : tCommon('save')}
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel}>
          {tCommon('cancel')}
        </Button>
      </div>
    </form>
  );
}
