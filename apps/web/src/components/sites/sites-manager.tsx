'use client';

import { DEFAULT_TIMEZONE, type Site, type SiteGroup, SITE_STATUSES } from '@ecsi/shared';
import { Badge, type BadgeTone, Button, Card, CardContent, EmptyState, Input } from '@ecsi/ui';
import { MapPin, Plus } from 'lucide-react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
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
import { SiteForm } from './site-form';

export const SITE_STATUS_TONE: Record<Site['status'], BadgeTone> = {
  ACTIVE: 'success',
  MAINTENANCE: 'warning',
  INACTIVE: 'neutral',
};

/** Liste des sites visibles par l'utilisateur (toute l'entreprise ou ses sites). */
export function SitesManager() {
  const t = useTranslations('sites');
  const permissions = usePermissions();
  const problemMessage = useProblemMessage();
  const [sites, setSites] = useState<Site[] | null>(null);
  const [groups, setGroups] = useState<SiteGroup[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [filters, setFilters] = useState({ q: '', status: '', groupId: '' });
  const canReadGroups = permissions.any('site_groups.read');

  const load = useCallback(async () => {
    const params = new URLSearchParams();
    if (filters.q.trim()) params.set('q', filters.q.trim());
    if (filters.status) params.set('status', filters.status);
    if (filters.groupId) params.set('groupId', filters.groupId);
    const query = params.toString();
    const result = await api<Site[]>(`/sites${query ? `?${query}` : ''}`);
    if (result.ok) {
      setSites(result.data);
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
    if (!canReadGroups) return;
    void api<SiteGroup[]>('/site-groups').then((result) => {
      if (result.ok) setGroups(result.data);
    });
  }, [canReadGroups]);

  return (
    <div className="flex flex-col gap-4">
      <Toolbar>
        <div className="col-span-2 flex-1 sm:max-w-xs">
          <FieldShell id="site-search" label={t('search')}>
            <Input
              id="site-search"
              type="search"
              placeholder={t('searchPlaceholder')}
              value={filters.q}
              onChange={(event) => {
                setFilters({ ...filters, q: event.target.value });
              }}
            />
          </FieldShell>
        </div>
        <FieldShell id="site-status" label={t('form.status')}>
          <Select
            id="site-status"
            value={filters.status}
            onChange={(event) => {
              setFilters({ ...filters, status: event.target.value });
            }}
          >
            <option value="">{t('allStatuses')}</option>
            {SITE_STATUSES.map((status) => (
              <option key={status} value={status}>
                {t(`form.statuses.${status}`)}
              </option>
            ))}
          </Select>
        </FieldShell>
        {canReadGroups ? (
          <FieldShell id="site-group" label={t('group')}>
            <Select
              id="site-group"
              value={filters.groupId}
              onChange={(event) => {
                setFilters({ ...filters, groupId: event.target.value });
              }}
            >
              <option value="">{t('allGroups')}</option>
              {groups.map((group) => (
                <option key={group.id} value={group.id}>
                  {group.name}
                </option>
              ))}
            </Select>
          </FieldShell>
        ) : null}
        {permissions.companyWide('sites.create') && !creating ? (
          <Button
            className="col-span-2 sm:ml-auto"
            onClick={() => {
              setCreating(true);
            }}
          >
            <Plus className="size-4" aria-hidden /> {t('add')}
          </Button>
        ) : null}
      </Toolbar>

      {creating ? (
        <Card>
          <CardContent className="pt-5">
            <SiteForm
              defaultTimezone={DEFAULT_TIMEZONE}
              onCancel={() => {
                setCreating(false);
              }}
              onSaved={() => {
                setCreating(false);
                void load();
              }}
            />
          </CardContent>
        </Card>
      ) : null}

      {error ? <FormMessage tone="error">{error}</FormMessage> : null}

      {sites?.length === 0 ? (
        <EmptyState
          icon={<MapPin className="size-8" aria-hidden />}
          title={t('emptyTitle')}
          description={t('emptyDescription')}
        />
      ) : null}

      {sites && sites.length > 0 ? (
        <DataTable testId="sites-table">
          <thead>
            <tr>
              <Th>{t('form.name')}</Th>
              <Th>{t('form.code')}</Th>
              <Th>{t('form.city')}</Th>
              <Th>{t('form.status')}</Th>
              <Th>{t('groups')}</Th>
            </tr>
          </thead>
          <tbody>
            {sites.map((site) => (
              <tr key={site.id}>
                <Td>
                  <Link
                    href={`/sites/${site.id}`}
                    className="font-medium text-primary hover:underline"
                  >
                    {site.name}
                  </Link>
                </Td>
                <Td className="font-mono text-xs">{site.code}</Td>
                <Td>{site.city ?? '—'}</Td>
                <Td>
                  <Badge tone={SITE_STATUS_TONE[site.status]} dot>
                    {t(`form.statuses.${site.status}`)}
                  </Badge>
                </Td>
                <Td>
                  {site.groups.length === 0 ? (
                    <span className="text-muted">—</span>
                  ) : (
                    <span className="flex flex-wrap gap-1">
                      {site.groups.map((group) => (
                        <Badge key={group.id} tone="primary">
                          {group.name}
                        </Badge>
                      ))}
                    </span>
                  )}
                </Td>
              </tr>
            ))}
          </tbody>
        </DataTable>
      ) : null}
    </div>
  );
}
