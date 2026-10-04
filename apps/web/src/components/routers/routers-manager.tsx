'use client';

import { type EnrollmentCreated, ROUTER_STATUSES, type Router, type Site } from '@ecsi/shared';
import { Badge, Button, EmptyState, Input } from '@ecsi/ui';
import { Plus, Router as RouterIcon } from 'lucide-react';
import Link from 'next/link';
import { useFormatter, useTranslations } from 'next-intl';
import { useCallback, useEffect, useState } from 'react';
import { FormMessage } from '@/components/auth/form';
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
import { EnrollmentForm, EnrollmentScript } from './enrollment-panel';
import { formatMemory, formatUptime, ROUTER_STATUS_TONE } from './format';

/** Réseau → Routeurs : routeurs des sites visibles par l'utilisateur. */
export function RoutersManager() {
  const t = useTranslations('routers');
  const format = useFormatter();
  const permissions = usePermissions();
  const problemMessage = useProblemMessage();
  const [routers, setRouters] = useState<Router[] | null>(null);
  const [sites, setSites] = useState<Site[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [enrollment, setEnrollment] = useState<EnrollmentCreated | null>(null);
  const [filters, setFilters] = useState({ q: '', status: '', siteId: '' });

  const load = useCallback(async () => {
    const params = new URLSearchParams();
    if (filters.q.trim()) params.set('q', filters.q.trim());
    if (filters.status) params.set('status', filters.status);
    if (filters.siteId) params.set('siteId', filters.siteId);
    const query = params.toString();
    const result = await api<Router[]>(`/routers${query ? `?${query}` : ''}`);
    if (result.ok) {
      setRouters(result.data);
      setError(null);
    } else setError(problemMessage(result.status, result.problem));
  }, [filters, problemMessage]);

  useEffect(() => {
    const timer = setTimeout(() => void load(), 250);
    return () => {
      clearTimeout(timer);
    };
  }, [load]);

  useEffect(() => {
    void api<Site[]>('/sites').then((result) => {
      if (result.ok) setSites(result.data);
    });
  }, []);

  return (
    <div className="flex flex-col gap-4">
      <Toolbar>
        <div className="col-span-2 flex-1 sm:max-w-xs">
          <FieldShell id="router-search" label={t('search')}>
            <Input
              id="router-search"
              type="search"
              placeholder={t('searchPlaceholder')}
              value={filters.q}
              onChange={(event) => {
                setFilters({ ...filters, q: event.target.value });
              }}
            />
          </FieldShell>
        </div>
        <FieldShell id="router-site" label={t('columns.site')}>
          <Select
            id="router-site"
            value={filters.siteId}
            onChange={(event) => {
              setFilters({ ...filters, siteId: event.target.value });
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
        <FieldShell id="router-status" label={t('columns.status')}>
          <Select
            id="router-status"
            value={filters.status}
            onChange={(event) => {
              setFilters({ ...filters, status: event.target.value });
            }}
          >
            <option value="">{t('allStatuses')}</option>
            {ROUTER_STATUSES.map((status) => (
              <option key={status} value={status}>
                {t(`statuses.${status}`)}
              </option>
            ))}
          </Select>
        </FieldShell>
        {permissions.any('routers.create') && !adding && !enrollment ? (
          <Button
            className="col-span-2 sm:ml-auto"
            onClick={() => {
              setAdding(true);
            }}
          >
            <Plus className="size-4" aria-hidden /> {t('add')}
          </Button>
        ) : null}
      </Toolbar>

      {adding ? (
        <EnrollmentForm
          onCancel={() => {
            setAdding(false);
          }}
          onCreated={(created) => {
            setAdding(false);
            setEnrollment(created);
            void load();
          }}
        />
      ) : null}
      {enrollment ? (
        <EnrollmentScript
          enrollment={enrollment}
          onDone={() => {
            setEnrollment(null);
          }}
        />
      ) : null}

      {error ? <FormMessage tone="error">{error}</FormMessage> : null}

      {routers?.length === 0 ? (
        <EmptyState
          icon={<RouterIcon className="size-8" aria-hidden />}
          title={t('emptyTitle')}
          description={t('emptyDescription')}
        />
      ) : null}

      {routers && routers.length > 0 ? (
        <DataTable testId="routers-table">
          <thead>
            <tr>
              <Th>{t('columns.name')}</Th>
              <Th>{t('columns.site')}</Th>
              <Th>{t('columns.board')}</Th>
              <Th>{t('columns.version')}</Th>
              <Th>{t('columns.tunnelIp')}</Th>
              <Th>{t('columns.status')}</Th>
              <Th>{t('columns.lastSeen')}</Th>
              <Th>{t('columns.cpu')}</Th>
              <Th>{t('columns.memory')}</Th>
              <Th>{t('columns.uptime')}</Th>
            </tr>
          </thead>
          <tbody>
            {routers.map((router) => (
              <tr key={router.id}>
                <Td>
                  <Link
                    href={`/reseau/routeurs/${router.id}`}
                    className="font-medium text-primary hover:underline"
                  >
                    {router.name}
                  </Link>
                  {router.identity && router.identity !== router.name ? (
                    <span className="block text-xs text-muted">{router.identity}</span>
                  ) : null}
                </Td>
                <Td>{router.site.name}</Td>
                <Td>{router.boardName ?? '—'}</Td>
                <Td>{router.routerosVersion ?? '—'}</Td>
                <Td className="font-mono text-xs">{router.tunnelIp}</Td>
                <Td>
                  <Badge tone={ROUTER_STATUS_TONE[router.status]} dot>
                    {t(`statuses.${router.status}`)}
                  </Badge>
                </Td>
                <Td>
                  {router.lastSeenAt
                    ? format.relativeTime(new Date(router.lastSeenAt))
                    : t('never')}
                </Td>
                <Td>{router.cpuLoad === null ? '—' : `${String(router.cpuLoad)} %`}</Td>
                <Td>{formatMemory(router.totalMemory, router.freeMemory)}</Td>
                <Td>{formatUptime(router.uptimeSeconds)}</Td>
              </tr>
            ))}
          </tbody>
        </DataTable>
      ) : null}
    </div>
  );
}
