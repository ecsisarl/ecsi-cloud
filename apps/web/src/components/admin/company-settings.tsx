'use client';

import {
  COMPANY_CURRENCIES,
  type CompanyProfile,
  COUNTRIES,
  LOGO_CONTENT_TYPES,
  LOGO_MAX_BYTES,
  SUPPORTED_LOCALES,
} from '@ecsi/shared';
import { Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle } from '@ecsi/ui';
import { ImageUp } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { type ChangeEvent, type SubmitEvent, useCallback, useEffect, useState } from 'react';
import { Field, FormMessage, fieldValue } from '@/components/auth/form';
import { FieldShell, Select, Textarea, useProblemMessage } from './controls';
import { usePermissions } from '@/components/me-context';
import { api } from '@/lib/client-api';

type Message = { tone: 'error' | 'success'; text: string } | null;

/** Lecture d'un fichier en base64 (sans l'en-tête « data:… »). */
function toBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : '';
      resolve(result.slice(result.indexOf(',') + 1));
    };
    reader.onerror = () => {
      reject(new Error('Lecture impossible'));
    };
    reader.readAsDataURL(file);
  });
}

export function CompanySettings() {
  const t = useTranslations('company');
  const tCommon = useTranslations('common');
  const permissions = usePermissions();
  const problemMessage = useProblemMessage();
  const canEdit = permissions.companyWide('companies.update');
  const canSettings = permissions.companyWide('settings.manage');
  const [company, setCompany] = useState<CompanyProfile | null>(null);
  const [logoVersion, setLogoVersion] = useState(0);
  const [profileMessage, setProfileMessage] = useState<Message>(null);
  const [logoMessage, setLogoMessage] = useState<Message>(null);
  const [settingsMessage, setSettingsMessage] = useState<Message>(null);

  const load = useCallback(async () => {
    const result = await api<CompanyProfile>('/company');
    if (result.ok) setCompany(result.data);
    else setProfileMessage({ tone: 'error', text: problemMessage(result.status, result.problem) });
  }, [problemMessage]);

  useEffect(() => {
    // Chargement du profil de l'entreprise courante.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  async function saveProfile(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const text = (name: string) => fieldValue(form, name).trim();
    const result = await api<CompanyProfile>('/company', {
      method: 'PATCH',
      body: {
        name: text('name'),
        legalName: text('legalName'),
        phone: text('phone'),
        whatsapp: text('whatsapp'),
        email: text('email'),
        address: text('address'),
        city: text('city'),
        country: text('country'),
        currency: text('currency'),
        locale: text('locale'),
        timezone: text('timezone'),
      },
    });
    if (result.ok) {
      setCompany(result.data);
      setProfileMessage({ tone: 'success', text: tCommon('saved') });
    } else
      setProfileMessage({ tone: 'error', text: problemMessage(result.status, result.problem) });
  }

  async function uploadLogo(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (!(LOGO_CONTENT_TYPES as readonly string[]).includes(file.type)) {
      setLogoMessage({ tone: 'error', text: t('logoType') });
      return;
    }
    if (file.size > LOGO_MAX_BYTES) {
      setLogoMessage({ tone: 'error', text: t('logoSize') });
      return;
    }
    const result = await api<CompanyProfile>('/company/logo', {
      method: 'PUT',
      body: { contentType: file.type, data: await toBase64(file) },
    });
    if (result.ok) {
      setCompany(result.data);
      setLogoVersion((v) => v + 1);
      setLogoMessage({ tone: 'success', text: t('logoSaved') });
    } else setLogoMessage({ tone: 'error', text: problemMessage(result.status, result.problem) });
  }

  async function deleteLogo() {
    const result = await api<CompanyProfile>('/company/logo', { method: 'DELETE' });
    if (result.ok) {
      setCompany(result.data);
      setLogoMessage({ tone: 'success', text: t('logoDeleted') });
    } else setLogoMessage({ tone: 'error', text: problemMessage(result.status, result.problem) });
  }

  async function saveSettings(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const result = await api<CompanyProfile>('/company/settings', {
      method: 'PUT',
      body: {
        dateFormat: fieldValue(form, 'dateFormat'),
        weekStartsOn: fieldValue(form, 'weekStartsOn'),
        supportMessage: fieldValue(form, 'supportMessage'),
      },
    });
    if (result.ok) {
      setCompany(result.data);
      setSettingsMessage({ tone: 'success', text: tCommon('saved') });
    } else
      setSettingsMessage({ tone: 'error', text: problemMessage(result.status, result.problem) });
  }

  if (!company) {
    return profileMessage ? (
      <FormMessage tone="error">{profileMessage.text}</FormMessage>
    ) : (
      <p className="text-sm text-muted">{tCommon('loading')}</p>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
      <Card className="xl:col-span-2">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            {t('profileTitle')}
            <Badge tone={company.status === 'ACTIVE' ? 'success' : 'danger'} dot>
              {t(`statuses.${company.status}`)}
            </Badge>
          </CardTitle>
          <CardDescription>{canEdit ? t('profileSubtitle') : t('readOnly')}</CardDescription>
        </CardHeader>
        <CardContent>
          <form
            onSubmit={(event) => void saveProfile(event)}
            className="flex flex-col gap-4"
            noValidate
          >
            {profileMessage ? (
              <FormMessage tone={profileMessage.tone}>{profileMessage.text}</FormMessage>
            ) : null}
            <fieldset disabled={!canEdit} className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <Field
                id="name"
                label={t('name')}
                defaultValue={company.name}
                required
                maxLength={120}
              />
              <Field
                id="legalName"
                label={t('legalName')}
                defaultValue={company.legalName ?? ''}
                maxLength={200}
              />
              <Field
                id="phone"
                label={t('phone')}
                type="tel"
                hint={t('phoneHint')}
                defaultValue={company.phone ?? ''}
              />
              <Field
                id="whatsapp"
                label={t('whatsapp')}
                type="tel"
                defaultValue={company.whatsapp ?? ''}
              />
              <Field
                id="email"
                label={t('email')}
                type="email"
                defaultValue={company.email ?? ''}
              />
              <Field id="city" label={t('city')} defaultValue={company.city ?? ''} />
              <div className="md:col-span-2">
                <Field
                  id="address"
                  label={t('address')}
                  defaultValue={company.address ?? ''}
                  maxLength={300}
                />
              </div>
              <FieldShell id="country" label={t('country')}>
                <Select id="country" name="country" defaultValue={company.country}>
                  {Object.entries(COUNTRIES).map(([code, name]) => (
                    <option key={code} value={code}>
                      {name}
                    </option>
                  ))}
                </Select>
              </FieldShell>
              <FieldShell id="currency" label={t('currency')}>
                <Select id="currency" name="currency" defaultValue={company.currency}>
                  {COMPANY_CURRENCIES.map((code) => (
                    <option key={code} value={code}>
                      {t(`currencies.${code}`)}
                    </option>
                  ))}
                </Select>
              </FieldShell>
              <FieldShell id="locale" label={t('locale')}>
                <Select id="locale" name="locale" defaultValue={company.locale}>
                  {SUPPORTED_LOCALES.map((code) => (
                    <option key={code} value={code}>
                      {t(`locales.${code}`)}
                    </option>
                  ))}
                </Select>
              </FieldShell>
              <Field
                id="timezone"
                label={t('timezone')}
                hint={t('timezoneHint')}
                defaultValue={company.timezone}
              />
            </fieldset>
            {canEdit ? (
              <Button type="submit" className="self-start">
                {tCommon('save')}
              </Button>
            ) : null}
          </form>
        </CardContent>
      </Card>

      <div className="flex flex-col gap-6">
        <Card>
          <CardHeader>
            <CardTitle>{t('logoTitle')}</CardTitle>
            <CardDescription>{t('logoHint')}</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {logoMessage ? (
              <FormMessage tone={logoMessage.tone}>{logoMessage.text}</FormMessage>
            ) : null}
            <div className="flex h-28 items-center justify-center rounded-md border border-dashed border-border bg-surface-muted">
              {company.hasLogo ? (
                // Logo privé servi par l'API (cookies de session), jamais une URL publique.
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={`/api/v1/company/logo?v=${String(logoVersion)}-${company.updatedAt}`}
                  alt={t('logoAlt', { name: company.name })}
                  className="max-h-24 max-w-full object-contain"
                />
              ) : (
                <span className="text-sm text-muted">{t('noLogo')}</span>
              )}
            </div>
            {canEdit ? (
              <div className="flex flex-wrap gap-2">
                <label className="inline-flex h-8 cursor-pointer items-center gap-2 rounded-md border border-border bg-surface px-3 text-sm font-medium hover:bg-surface-muted">
                  <ImageUp className="size-4" aria-hidden /> {t('logoUpload')}
                  <input
                    type="file"
                    accept={LOGO_CONTENT_TYPES.join(',')}
                    className="sr-only"
                    data-testid="logo-input"
                    onChange={(event) => void uploadLogo(event)}
                  />
                </label>
                {company.hasLogo ? (
                  <Button size="sm" variant="ghost" onClick={() => void deleteLogo()}>
                    {tCommon('delete')}
                  </Button>
                ) : null}
              </div>
            ) : null}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{t('settingsTitle')}</CardTitle>
            <CardDescription>{t('settingsSubtitle')}</CardDescription>
          </CardHeader>
          <CardContent>
            <form
              onSubmit={(event) => void saveSettings(event)}
              className="flex flex-col gap-4"
              noValidate
            >
              {settingsMessage ? (
                <FormMessage tone={settingsMessage.tone}>{settingsMessage.text}</FormMessage>
              ) : null}
              <fieldset disabled={!canSettings} className="flex flex-col gap-4">
                <FieldShell id="dateFormat" label={t('dateFormat')}>
                  <Select
                    id="dateFormat"
                    name="dateFormat"
                    defaultValue={company.settings.dateFormat}
                  >
                    <option value="DD/MM/YYYY">JJ/MM/AAAA</option>
                    <option value="YYYY-MM-DD">AAAA-MM-JJ</option>
                  </Select>
                </FieldShell>
                <FieldShell id="weekStartsOn" label={t('weekStartsOn')}>
                  <Select
                    id="weekStartsOn"
                    name="weekStartsOn"
                    defaultValue={company.settings.weekStartsOn}
                  >
                    <option value="MONDAY">{t('monday')}</option>
                    <option value="SUNDAY">{t('sunday')}</option>
                  </Select>
                </FieldShell>
                <FieldShell
                  id="supportMessage"
                  label={t('supportMessage')}
                  hint={t('supportMessageHint')}
                >
                  <Textarea
                    id="supportMessage"
                    name="supportMessage"
                    maxLength={500}
                    defaultValue={company.settings.supportMessage}
                  />
                </FieldShell>
              </fieldset>
              {canSettings ? (
                <Button type="submit" className="self-start">
                  {tCommon('save')}
                </Button>
              ) : null}
            </form>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
