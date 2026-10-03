'use client';

import type { Site, SiteGroup } from '@ecsi/shared';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  EmptyState,
} from '@ecsi/ui';
import { Plus, Waypoints, X } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { type SubmitEvent, useCallback, useEffect, useState } from 'react';
import { Field, FormMessage, fieldValue } from '@/components/auth/form';
import {
  ConfirmPanel,
  FieldShell,
  Select,
  Textarea,
  useProblemMessage,
} from '@/components/admin/controls';
import { usePermissions } from '@/components/me-context';
import { api, type ApiResult } from '@/lib/client-api';

/**
 * Groupes de sites (base du roaming ECSI : un ticket « GROUPE » sera valable sur tous les
 * sites du groupe, au sprint dédié). Un site peut appartenir à plusieurs groupes.
 */
export function SiteGroupsManager() {
  const t = useTranslations('siteGroups');
  const tCommon = useTranslations('common');
  const permissions = usePermissions();
  const problemMessage = useProblemMessage();
  const canManage = permissions.companyWide('site_groups.manage');
  const [groups, setGroups] = useState<SiteGroup[] | null>(null);
  const [sites, setSites] = useState<Site[]>([]);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: 'error' | 'success'; text: string } | null>(null);

  const load = useCallback(async () => {
    const [groupList, siteList] = await Promise.all([
      api<SiteGroup[]>('/site-groups'),
      api<Site[]>('/sites'),
    ]);
    if (groupList.ok) setGroups(groupList.data);
    else setMessage({ tone: 'error', text: problemMessage(groupList.status, groupList.problem) });
    if (siteList.ok) setSites(siteList.data);
  }, [problemMessage]);

  useEffect(() => {
    // Chargement initial des groupes et des sites.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  async function run(request: Promise<ApiResult<unknown>>) {
    const result = await request;
    if (!result.ok)
      setMessage({ tone: 'error', text: problemMessage(result.status, result.problem) });
    else setMessage(null);
    await load();
    return result.ok;
  }

  async function create(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const description = fieldValue(form, 'description').trim();
    const ok = await run(
      api('/site-groups', {
        method: 'POST',
        body: {
          name: fieldValue(form, 'name').trim(),
          code: fieldValue(form, 'code').trim(),
          description: description === '' ? null : description,
          siteIds: form.getAll('siteIds').filter((v): v is string => typeof v === 'string'),
        },
      }),
    );
    if (ok) setCreating(false);
  }

  return (
    <div className="flex flex-col gap-4">
      {message ? <FormMessage tone={message.tone}>{message.text}</FormMessage> : null}
      {canManage && !creating ? (
        <Button
          className="self-start"
          onClick={() => {
            setCreating(true);
          }}
        >
          <Plus className="size-4" aria-hidden /> {t('add')}
        </Button>
      ) : null}

      {creating ? (
        <Card>
          <CardContent className="pt-5">
            <form
              onSubmit={(event) => void create(event)}
              className="flex flex-col gap-4"
              noValidate
            >
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                <Field id="name" label={t('name')} required maxLength={120} />
                <Field id="code" label={t('code')} hint={t('codeHint')} required maxLength={32} />
              </div>
              <FieldShell id="description" label={t('description')}>
                <Textarea id="description" name="description" maxLength={500} />
              </FieldShell>
              <fieldset className="flex flex-col gap-2">
                <legend className="mb-1 text-sm font-medium">{t('sites')}</legend>
                <div className="grid grid-cols-1 gap-1 sm:grid-cols-2">
                  {sites.map((site) => (
                    <label key={site.id} className="flex items-center gap-2 text-sm">
                      <input type="checkbox" name="siteIds" value={site.id} className="size-4" />
                      {site.name} <span className="font-mono text-xs text-muted">{site.code}</span>
                    </label>
                  ))}
                </div>
              </fieldset>
              <div className="flex gap-2">
                <Button type="submit">{t('create')}</Button>
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

      {groups?.length === 0 ? (
        <EmptyState
          icon={<Waypoints className="size-8" aria-hidden />}
          title={t('emptyTitle')}
          description={t('emptyDescription')}
        />
      ) : null}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2" data-testid="site-groups">
        {groups?.map((group) => {
          const available = sites.filter(
            (site) => !group.sites.some((member) => member.id === site.id),
          );
          return (
            <Card key={group.id} data-testid={`group-${group.code}`}>
              <CardHeader>
                <CardTitle className="flex items-center justify-between gap-2">
                  <span>
                    {group.name} <span className="font-mono text-xs text-muted">{group.code}</span>
                  </span>
                  {canManage ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setDeleting(group.id);
                      }}
                    >
                      {tCommon('delete')}
                    </Button>
                  ) : null}
                </CardTitle>
                {group.description ? <CardDescription>{group.description}</CardDescription> : null}
              </CardHeader>
              <CardContent className="flex flex-col gap-3">
                {deleting === group.id ? (
                  <ConfirmPanel
                    title={t('deleteTitle', { name: group.name })}
                    description={t('deleteDescription')}
                  >
                    <div className="flex gap-2">
                      <Button
                        variant="danger"
                        size="sm"
                        onClick={() =>
                          void run(api(`/site-groups/${group.id}`, { method: 'DELETE' })).then(
                            () => {
                              setDeleting(null);
                            },
                          )
                        }
                      >
                        {tCommon('delete')}
                      </Button>
                      <Button
                        variant="secondary"
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
                <p className="text-xs text-muted">
                  {t('siteCount', { count: group.sites.length })}
                </p>
                <ul className="flex flex-wrap gap-1.5">
                  {group.sites.map((site) => (
                    <li key={site.id}>
                      <Badge tone="primary">
                        {site.name}
                        {canManage ? (
                          <button
                            type="button"
                            aria-label={t('removeSite', { name: site.name })}
                            className="ml-1 rounded-full hover:bg-white/40"
                            onClick={() =>
                              void run(
                                api(`/site-groups/${group.id}/sites/remove`, {
                                  method: 'POST',
                                  body: { siteIds: [site.id] },
                                }),
                              )
                            }
                          >
                            <X className="size-3" aria-hidden />
                          </button>
                        ) : null}
                      </Badge>
                    </li>
                  ))}
                </ul>
                {canManage && available.length > 0 ? (
                  <form
                    className="flex flex-col gap-2 sm:flex-row sm:items-end"
                    onSubmit={(event) => {
                      event.preventDefault();
                      const siteId = fieldValue(new FormData(event.currentTarget), 'siteId');
                      if (siteId) {
                        void run(
                          api(`/site-groups/${group.id}/sites`, {
                            method: 'POST',
                            body: { siteIds: [siteId] },
                          }),
                        );
                      }
                    }}
                  >
                    <FieldShell id={`add-${group.id}`} label={t('addSite')}>
                      <Select id={`add-${group.id}`} name="siteId">
                        {available.map((site) => (
                          <option key={site.id} value={site.id}>
                            {site.name} ({site.code})
                          </option>
                        ))}
                      </Select>
                    </FieldShell>
                    <Button type="submit" variant="secondary">
                      {t('addSiteButton')}
                    </Button>
                  </form>
                ) : null}
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
