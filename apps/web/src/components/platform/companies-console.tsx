'use client';

import {
  COMPANY_CURRENCIES,
  COUNTRIES,
  type PlatformCompanyDetail,
  type PlatformCompanyPage,
} from '@ecsi/shared';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
} from '@ecsi/ui';
import { Plus } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
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
import { api } from '@/lib/client-api';

/** Entreprises clientes : recherche, filtre par statut, création. */
export function CompaniesConsole() {
  const t = useTranslations('platformConsole.companies');
  const tCompany = useTranslations('company');
  const tCommon = useTranslations('common');
  const format = useFormatter();
  const router = useRouter();
  const problemMessage = useProblemMessage();
  const [page, setPage] = useState<PlatformCompanyPage | null>(null);
  const [filters, setFilters] = useState({ q: '', status: '', page: 1 });
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const params = new URLSearchParams({ page: String(filters.page) });
    if (filters.q.trim()) params.set('q', filters.q.trim());
    if (filters.status) params.set('status', filters.status);
    const result = await api<PlatformCompanyPage>(`/platform/companies?${params.toString()}`);
    if (result.ok) {
      setPage(result.data);
      setError(null);
    } else setError(problemMessage(result.status, result.problem));
  }, [filters, problemMessage]);

  useEffect(() => {
    const timer = setTimeout(() => void load(), 250);
    return () => {
      clearTimeout(timer);
    };
  }, [load]);

  async function create(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const text = (name: string) => fieldValue(form, name).trim();
    const result = await api<PlatformCompanyDetail>('/platform/companies', {
      method: 'POST',
      body: {
        name: text('name'),
        ...(text('legalName') ? { legalName: text('legalName') } : {}),
        ...(text('slug') ? { slug: text('slug') } : {}),
        country: text('country'),
        currency: text('currency'),
        timezone: text('timezone'),
        adminEmail: text('adminEmail'),
      },
    });
    if (result.ok) router.push(`/plateforme/entreprises/${result.data.id}`);
    else setError(problemMessage(result.status, result.problem));
  }

  const pages = page ? Math.max(1, Math.ceil(page.total / page.limit)) : 1;

  return (
    <div className="flex flex-col gap-4">
      <Toolbar>
        <div className="col-span-2 flex-1 sm:max-w-xs">
          <FieldShell id="company-search" label={t('search')}>
            <Input
              id="company-search"
              type="search"
              placeholder={t('searchPlaceholder')}
              value={filters.q}
              onChange={(event) => {
                setFilters({ ...filters, q: event.target.value, page: 1 });
              }}
            />
          </FieldShell>
        </div>
        <FieldShell id="company-status" label={t('status')}>
          <Select
            id="company-status"
            value={filters.status}
            onChange={(event) => {
              setFilters({ ...filters, status: event.target.value, page: 1 });
            }}
          >
            <option value="">{t('allStatuses')}</option>
            <option value="ACTIVE">{tCompany('statuses.ACTIVE')}</option>
            <option value="SUSPENDED">{tCompany('statuses.SUSPENDED')}</option>
          </Select>
        </FieldShell>
        {!creating ? (
          <Button
            className="col-span-2 sm:ml-auto"
            onClick={() => {
              setCreating(true);
            }}
          >
            <Plus className="size-4" aria-hidden /> {t('create')}
          </Button>
        ) : null}
      </Toolbar>

      {error ? <FormMessage tone="error">{error}</FormMessage> : null}

      {creating ? (
        <Card>
          <CardHeader>
            <CardTitle>{t('createTitle')}</CardTitle>
            <CardDescription>{t('createSubtitle')}</CardDescription>
          </CardHeader>
          <CardContent>
            <form
              onSubmit={(event) => void create(event)}
              className="flex flex-col gap-4"
              noValidate
            >
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                <Field id="name" label={tCompany('name')} required maxLength={120} />
                <Field id="legalName" label={tCompany('legalName')} maxLength={200} />
                <Field id="slug" label={t('slug')} hint={t('slugHint')} maxLength={50} />
                <Field
                  id="adminEmail"
                  label={t('adminEmail')}
                  hint={t('adminEmailHint')}
                  type="email"
                  required
                />
                <FieldShell id="country" label={tCompany('country')}>
                  <Select id="country" name="country" defaultValue="CI">
                    {Object.entries(COUNTRIES).map(([code, name]) => (
                      <option key={code} value={code}>
                        {name}
                      </option>
                    ))}
                  </Select>
                </FieldShell>
                <FieldShell id="currency" label={tCompany('currency')}>
                  <Select id="currency" name="currency" defaultValue="XOF">
                    {COMPANY_CURRENCIES.map((code) => (
                      <option key={code} value={code}>
                        {tCompany(`currencies.${code}`)}
                      </option>
                    ))}
                  </Select>
                </FieldShell>
                <Field id="timezone" label={tCompany('timezone')} defaultValue="Africa/Abidjan" />
              </div>
              <div className="flex gap-2">
                <Button type="submit">{t('createSubmit')}</Button>
                <Button
                  variant="secondary"
                  onClick={() => {
                    setCreating(false);
                  }}
                >
                  {tCommon('cancel')}
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      ) : null}

      {page ? (
        <>
          <DataTable testId="companies-table">
            <thead>
              <tr>
                <Th>{tCompany('name')}</Th>
                <Th>{t('slug')}</Th>
                <Th>{tCompany('country')}</Th>
                <Th>{t('members')}</Th>
                <Th>{t('sites')}</Th>
                <Th>{t('status')}</Th>
                <Th>{t('createdAt')}</Th>
              </tr>
            </thead>
            <tbody>
              {page.data.length === 0 ? (
                <tr>
                  <Td className="text-muted">{t('empty')}</Td>
                </tr>
              ) : null}
              {page.data.map((company) => (
                <tr key={company.id}>
                  <Td>
                    <Link
                      href={`/plateforme/entreprises/${company.id}`}
                      className="font-medium text-primary hover:underline"
                    >
                      {company.name}
                    </Link>
                  </Td>
                  <Td className="font-mono text-xs">{company.slug}</Td>
                  <Td>{company.country}</Td>
                  <Td>{company.memberCount}</Td>
                  <Td>{company.siteCount}</Td>
                  <Td>
                    <Badge tone={company.status === 'ACTIVE' ? 'success' : 'danger'} dot>
                      {tCompany(`statuses.${company.status}`)}
                    </Badge>
                  </Td>
                  <Td className="text-xs text-muted">
                    {format.dateTime(new Date(company.createdAt), { dateStyle: 'medium' })}
                  </Td>
                </tr>
              ))}
            </tbody>
          </DataTable>
          <div className="flex items-center justify-between text-sm text-muted">
            <span>{t('total', { count: page.total })}</span>
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="secondary"
                disabled={filters.page <= 1}
                onClick={() => {
                  setFilters({ ...filters, page: filters.page - 1 });
                }}
              >
                {tCommon('previous')}
              </Button>
              <span>
                {filters.page} / {pages}
              </span>
              <Button
                size="sm"
                variant="secondary"
                disabled={filters.page >= pages}
                onClick={() => {
                  setFilters({ ...filters, page: filters.page + 1 });
                }}
              >
                {tCommon('next')}
              </Button>
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}
