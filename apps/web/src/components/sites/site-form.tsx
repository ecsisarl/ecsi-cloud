'use client';

import { COUNTRIES, type Site, SITE_STATUSES } from '@ecsi/shared';
import { Button } from '@ecsi/ui';
import { useTranslations } from 'next-intl';
import { type SubmitEvent, useState } from 'react';
import { Field, FormMessage, fieldValue } from '@/components/auth/form';
import { FieldShell, Select, Textarea, useProblemMessage } from '@/components/admin/controls';
import { api } from '@/lib/client-api';

const nullable = (value: string) => (value.trim() === '' ? null : value.trim());
const coordinate = (value: string) =>
  value.trim() === '' ? null : Number(value.replace(',', '.'));

/**
 * Formulaire de site (création ou modification). Le code est unique dans l'entreprise ;
 * la latitude et la longitude sont facultatives mais vont ensemble.
 */
export function SiteForm({
  site,
  defaultTimezone,
  onSaved,
  onCancel,
}: {
  site?: Site;
  defaultTimezone: string;
  onSaved: (site: Site) => void;
  onCancel?: () => void;
}) {
  const t = useTranslations('sites.form');
  const tCommon = useTranslations('common');
  const problemMessage = useProblemMessage();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const latitude = coordinate(fieldValue(form, 'latitude'));
    const longitude = coordinate(fieldValue(form, 'longitude'));
    if ((latitude === null) !== (longitude === null)) {
      setError(t('coordinatesTogether'));
      return;
    }
    const body = {
      name: fieldValue(form, 'name').trim(),
      code: fieldValue(form, 'code').trim(),
      description: nullable(fieldValue(form, 'description')),
      address: nullable(fieldValue(form, 'address')),
      city: nullable(fieldValue(form, 'city')),
      country: fieldValue(form, 'country'),
      timezone: fieldValue(form, 'timezone').trim(),
      phone: nullable(fieldValue(form, 'phone')),
      contactName: nullable(fieldValue(form, 'contactName')),
      status: fieldValue(form, 'status'),
      latitude,
      longitude,
    };
    setPending(true);
    setError(null);
    const result = site
      ? await api<Site>(`/sites/${site.id}`, { method: 'PATCH', body })
      : await api<Site>('/sites', { method: 'POST', body });
    setPending(false);
    if (result.ok) onSaved(result.data);
    else setError(problemMessage(result.status, result.problem));
  }

  return (
    <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-4" noValidate>
      {error ? <FormMessage tone="error">{error}</FormMessage> : null}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Field id="name" label={t('name')} required defaultValue={site?.name} maxLength={120} />
        <Field
          id="code"
          label={t('code')}
          hint={t('codeHint')}
          required
          defaultValue={site?.code}
          maxLength={32}
          className="uppercase"
        />
        <Field id="city" label={t('city')} defaultValue={site?.city ?? ''} maxLength={120} />
        <Field
          id="address"
          label={t('address')}
          defaultValue={site?.address ?? ''}
          maxLength={300}
        />
        <FieldShell id="country" label={t('country')}>
          <Select id="country" name="country" defaultValue={site?.country ?? 'CI'}>
            {Object.entries(COUNTRIES).map(([code, name]) => (
              <option key={code} value={code}>
                {name}
              </option>
            ))}
          </Select>
        </FieldShell>
        <Field
          id="timezone"
          label={t('timezone')}
          hint={t('timezoneHint')}
          required
          defaultValue={site?.timezone ?? defaultTimezone}
          maxLength={64}
        />
        <Field
          id="phone"
          label={t('phone')}
          hint={t('phoneHint')}
          type="tel"
          defaultValue={site?.phone ?? ''}
        />
        <Field id="contactName" label={t('contactName')} defaultValue={site?.contactName ?? ''} />
        <Field
          id="latitude"
          label={t('latitude')}
          inputMode="decimal"
          defaultValue={site?.latitude ?? ''}
        />
        <Field
          id="longitude"
          label={t('longitude')}
          inputMode="decimal"
          defaultValue={site?.longitude ?? ''}
        />
        <FieldShell id="status" label={t('status')}>
          <Select id="status" name="status" defaultValue={site?.status ?? 'ACTIVE'}>
            {SITE_STATUSES.map((status) => (
              <option key={status} value={status}>
                {t(`statuses.${status}`)}
              </option>
            ))}
          </Select>
        </FieldShell>
      </div>
      <FieldShell id="description" label={t('description')}>
        <Textarea
          id="description"
          name="description"
          defaultValue={site?.description ?? ''}
          maxLength={1000}
        />
      </FieldShell>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={pending}>
          {pending ? tCommon('saving') : site ? tCommon('save') : t('create')}
        </Button>
        {onCancel ? (
          <Button variant="secondary" onClick={onCancel}>
            {tCommon('cancel')}
          </Button>
        ) : null}
      </div>
    </form>
  );
}
