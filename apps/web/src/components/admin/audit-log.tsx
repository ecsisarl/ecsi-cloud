'use client';

import { AUDIT_RESULTS, type AuditEvent, type AuditPage, type Site } from '@ecsi/shared';
import {
  Badge,
  type BadgeTone,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Input,
} from '@ecsi/ui';
import { X } from 'lucide-react';
import { useFormatter, useTranslations } from 'next-intl';
import { useCallback, useEffect, useState } from 'react';
import { FormMessage } from '@/components/auth/form';
import { api } from '@/lib/client-api';
import { DataTable, FieldShell, Select, Td, Th, Toolbar, useProblemMessage } from './controls';

const RESULT_TONE: Record<AuditEvent['result'], BadgeTone> = {
  SUCCESS: 'success',
  FAILURE: 'warning',
  DENIED: 'danger',
};

interface Filters {
  q: string;
  from: string;
  to: string;
  action: string;
  resourceType: string;
  siteId: string;
  result: string;
  actorId: string;
  companyId: string;
}

const EMPTY: Filters = {
  q: '',
  from: '',
  to: '',
  action: '',
  resourceType: '',
  siteId: '',
  result: '',
  actorId: '',
  companyId: '',
};

/**
 * Journal d'audit : entreprise courante (/audit) ou console plateforme (/platform/audit,
 * toutes les entreprises). Pagination par curseur, filtres, détail d'un événement.
 * Les détails ont été nettoyés de tout secret à l'écriture.
 */
export function AuditLog({
  endpoint,
  sites = [],
  companies,
  companyId,
}: {
  endpoint: '/audit' | '/platform/audit';
  sites?: Site[];
  companies?: { id: string; name: string }[];
  /** Console plateforme : journal limité à une entreprise. */
  companyId?: string;
}) {
  const t = useTranslations('audit');
  const tCommon = useTranslations('common');
  const format = useFormatter();
  const problemMessage = useProblemMessage();
  const [filters, setFilters] = useState<Filters>(EMPTY);
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [selected, setSelected] = useState<AuditEvent | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fetchPage = useCallback(
    async (after: string | null) => {
      const params = new URLSearchParams({ limit: '25' });
      for (const [key, value] of Object.entries(filters) as [keyof Filters, string][]) {
        const trimmed = value.trim();
        if (!trimmed) continue;
        // Dates locales du formulaire -> instants ISO (fin de journée incluse pour « au »).
        if (key === 'from') params.set(key, new Date(`${trimmed}T00:00:00`).toISOString());
        else if (key === 'to') params.set(key, new Date(`${trimmed}T23:59:59.999`).toISOString());
        else params.set(key, trimmed);
      }
      if (companyId) params.set('companyId', companyId);
      if (after) params.set('cursor', after);
      const result = await api<AuditPage>(`${endpoint}?${params.toString()}`);
      if (!result.ok) {
        setError(problemMessage(result.status, result.problem));
        return;
      }
      setError(null);
      setEvents((current) => (after ? [...current, ...result.data.data] : result.data.data));
      setCursor(result.data.nextCursor);
      setLoaded(true);
    },
    [endpoint, filters, problemMessage, companyId],
  );

  useEffect(() => {
    const timer = setTimeout(() => void fetchPage(null), 300);
    return () => {
      clearTimeout(timer);
    };
  }, [fetchPage]);

  const set = (key: keyof Filters) => (value: string) => {
    setFilters((current) => ({ ...current, [key]: value }));
  };
  const date = (iso: string) =>
    format.dateTime(new Date(iso), { dateStyle: 'short', timeStyle: 'medium' });

  return (
    <div className="flex flex-col gap-4">
      <Toolbar>
        <div className="col-span-2 flex-1 sm:max-w-xs">
          <FieldShell id="audit-q" label={t('search')}>
            <Input
              id="audit-q"
              type="search"
              placeholder={t('searchPlaceholder')}
              value={filters.q}
              onChange={(event) => {
                set('q')(event.target.value);
              }}
            />
          </FieldShell>
        </div>
        <FieldShell id="audit-from" label={t('from')}>
          <Input
            id="audit-from"
            type="date"
            value={filters.from}
            onChange={(event) => {
              set('from')(event.target.value);
            }}
          />
        </FieldShell>
        <FieldShell id="audit-to" label={t('to')}>
          <Input
            id="audit-to"
            type="date"
            value={filters.to}
            onChange={(event) => {
              set('to')(event.target.value);
            }}
          />
        </FieldShell>
        <FieldShell id="audit-action" label={t('action')}>
          <Input
            id="audit-action"
            placeholder="sites.*"
            value={filters.action}
            onChange={(event) => {
              set('action')(event.target.value);
            }}
          />
        </FieldShell>
        <FieldShell id="audit-resource" label={t('resource')}>
          <Input
            id="audit-resource"
            placeholder="site"
            value={filters.resourceType}
            onChange={(event) => {
              set('resourceType')(event.target.value);
            }}
          />
        </FieldShell>
        <FieldShell id="audit-result" label={t('result')}>
          <Select
            id="audit-result"
            value={filters.result}
            onChange={(event) => {
              set('result')(event.target.value);
            }}
          >
            <option value="">{t('allResults')}</option>
            {AUDIT_RESULTS.map((result) => (
              <option key={result} value={result}>
                {t(`results.${result}`)}
              </option>
            ))}
          </Select>
        </FieldShell>
        {sites.length > 0 ? (
          <FieldShell id="audit-site" label={t('site')}>
            <Select
              id="audit-site"
              value={filters.siteId}
              onChange={(event) => {
                set('siteId')(event.target.value);
              }}
            >
              <option value="">{t('allSites')}</option>
              {sites.map((site) => (
                <option key={site.id} value={site.id}>
                  {site.name}
                </option>
              ))}
            </Select>
          </FieldShell>
        ) : null}
        {companies ? (
          <FieldShell id="audit-company" label={t('company')}>
            <Select
              id="audit-company"
              value={filters.companyId}
              onChange={(event) => {
                set('companyId')(event.target.value);
              }}
            >
              <option value="">{t('allCompanies')}</option>
              {companies.map((company) => (
                <option key={company.id} value={company.id}>
                  {company.name}
                </option>
              ))}
            </Select>
          </FieldShell>
        ) : null}
        {filters.actorId ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              set('actorId')('');
            }}
          >
            <X className="size-4" aria-hidden /> {t('clearActor')}
          </Button>
        ) : null}
      </Toolbar>

      {error ? <FormMessage tone="error">{error}</FormMessage> : null}

      {selected ? (
        <Card data-testid="audit-detail">
          <CardHeader>
            <CardTitle className="flex items-center justify-between gap-2">
              <span className="font-mono text-sm">{selected.action}</span>
              <Button
                variant="ghost"
                size="sm"
                aria-label={tCommon('close')}
                onClick={() => {
                  setSelected(null);
                }}
              >
                <X className="size-4" aria-hidden />
              </Button>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
              {(
                [
                  [t('date'), date(selected.occurredAt)],
                  [t('actor'), selected.actorLabel ?? t(`actorTypes.${selected.actorType}`)],
                  [t('roles'), selected.actorRoles.join(', ') || '—'],
                  [t('result'), t(`results.${selected.result}`)],
                  [
                    t('resource'),
                    `${selected.resourceType}${selected.resourceId ? ` · ${selected.resourceId}` : ''}`,
                  ],
                  [t('company'), selected.companyName ?? selected.companyId ?? t('platform')],
                  [t('ip'), selected.ip ?? '—'],
                  [t('userAgent'), selected.userAgent ?? '—'],
                  [t('requestId'), selected.requestId ?? '—'],
                  [t('sequence'), String(selected.chainSeq)],
                ] as const
              ).map(([label, value]) => (
                <div key={label}>
                  <dt className="text-muted">{label}</dt>
                  <dd className="break-all">{value}</dd>
                </div>
              ))}
            </dl>
            <p className="mt-4 mb-1 text-sm text-muted">{t('details')}</p>
            <pre className="max-h-80 overflow-auto rounded-md bg-surface-muted p-3 text-xs">
              {JSON.stringify(selected.details, null, 2)}
            </pre>
          </CardContent>
        </Card>
      ) : null}

      <DataTable testId="audit-table">
        <thead>
          <tr>
            <Th>{t('date')}</Th>
            <Th>{t('actor')}</Th>
            <Th>{t('action')}</Th>
            <Th>{t('resource')}</Th>
            {companies ? <Th>{t('company')}</Th> : null}
            <Th>{t('result')}</Th>
          </tr>
        </thead>
        <tbody>
          {loaded && events.length === 0 ? (
            <tr>
              <Td className="text-muted">{t('empty')}</Td>
            </tr>
          ) : null}
          {events.map((event) => (
            <tr
              key={event.id}
              className="cursor-pointer hover:bg-surface-muted"
              onClick={() => {
                setSelected(event);
              }}
            >
              <Td className="text-xs whitespace-nowrap">{date(event.occurredAt)}</Td>
              <Td className="text-xs">
                {event.actorId ? (
                  <button
                    type="button"
                    className="text-left hover:underline"
                    title={t('filterByActor')}
                    onClick={(click) => {
                      click.stopPropagation();
                      set('actorId')(event.actorId ?? '');
                    }}
                  >
                    {event.actorLabel ?? event.actorId}
                  </button>
                ) : (
                  t(`actorTypes.${event.actorType}`)
                )}
              </Td>
              <Td className="font-mono text-xs">{event.action}</Td>
              <Td className="text-xs">{event.resourceType}</Td>
              {companies ? <Td className="text-xs">{event.companyName ?? t('platform')}</Td> : null}
              <Td>
                <Badge tone={RESULT_TONE[event.result]}>{t(`results.${event.result}`)}</Badge>
              </Td>
            </tr>
          ))}
        </tbody>
      </DataTable>
      {cursor ? (
        <Button variant="secondary" className="self-center" onClick={() => void fetchPage(cursor)}>
          {t('more')}
        </Button>
      ) : null}
    </div>
  );
}
