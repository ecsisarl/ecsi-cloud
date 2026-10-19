'use client';

import {
  type Hotspot,
  hotspotNetworkIssues,
  HOTSPOT_INTERFACE_PATTERN,
  type RadiusSession,
  type Router,
} from '@ecsi/shared';
import { Badge, Button, Card, CardContent, CardHeader, CardTitle, EmptyState } from '@ecsi/ui';
import { Plus, Wifi } from 'lucide-react';
import { useFormatter, useTranslations } from 'next-intl';
import { type SubmitEvent, useCallback, useEffect, useState } from 'react';
import { Field, FormMessage, fieldValue } from '@/components/auth/form';
import {
  ConfirmPanel,
  DataTable,
  FieldShell,
  Select,
  Td,
  Th,
  useProblemMessage,
} from '@/components/admin/controls';
import { usePermissions } from '@/components/me-context';
import { formatBytes } from '@/components/routers/format';
import { api } from '@/lib/client-api';
import { ConfigAccessPanel } from './config-access-panel';
import { formatDuration, SYNC_STATUS_TONE } from './format';

function HotspotForm({
  hotspot,
  routers,
  onSaved,
  onCancel,
}: {
  hotspot: Hotspot | null;
  routers: Router[];
  onSaved: () => void;
  onCancel: () => void;
}) {
  const t = useTranslations('hotspots');
  const tCommon = useTranslations('common');
  const problemMessage = useProblemMessage();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const network = {
      gatewayAddress: fieldValue(form, 'gatewayAddress').trim(),
      poolStart: fieldValue(form, 'poolStart').trim(),
      poolEnd: fieldValue(form, 'poolEnd').trim(),
    };
    const iface = fieldValue(form, 'interface').trim();
    // Mêmes contrôles que l'API (schémas partagés), pour un message immédiat.
    const issues = hotspotNetworkIssues(network).map((issue) => issue.message);
    if (!HOTSPOT_INTERFACE_PATTERN.test(iface)) issues.unshift(t('invalidInterface'));
    if (issues.length > 0) {
      setError(issues.join(' · '));
      return;
    }
    const body = {
      name: fieldValue(form, 'name').trim(),
      interface: iface,
      ...network,
      dnsName: fieldValue(form, 'dnsName').trim(),
    };
    setPending(true);
    setError(null);
    const result = hotspot
      ? await api<Hotspot>(`/hotspots/${hotspot.id}`, { method: 'PATCH', body })
      : await api<Hotspot>('/hotspots', {
          method: 'POST',
          body: { ...body, routerId: fieldValue(form, 'routerId') },
        });
    setPending(false);
    if (result.ok) onSaved();
    else setError(problemMessage(result.status, result.problem));
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{hotspot ? t('editTitle', { name: hotspot.name }) : t('createTitle')}</CardTitle>
      </CardHeader>
      <CardContent>
        <form
          onSubmit={(event) => void submit(event)}
          className="flex flex-col gap-4"
          noValidate
          data-testid="hotspot-form"
        >
          {error ? <FormMessage tone="error">{error}</FormMessage> : null}
          <p className="text-sm text-muted">{t('formIntro')}</p>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            {hotspot ? null : (
              <FieldShell id="routerId" label={t('fields.router')}>
                <Select id="routerId" name="routerId" required defaultValue="">
                  <option value="" disabled>
                    {t('chooseRouter')}
                  </option>
                  {routers.map((router) => (
                    <option key={router.id} value={router.id}>
                      {router.name} · {router.site.name}
                    </option>
                  ))}
                </Select>
              </FieldShell>
            )}
            <Field
              id="name"
              label={t('fields.name')}
              required
              maxLength={80}
              defaultValue={hotspot?.name ?? ''}
            />
            <Field
              id="interface"
              label={t('fields.interface')}
              hint={t('hints.interface')}
              required
              maxLength={40}
              defaultValue={hotspot?.interface ?? ''}
            />
            <Field
              id="gatewayAddress"
              label={t('fields.gatewayAddress')}
              hint={t('hints.gatewayAddress')}
              required
              placeholder="10.5.50.1/24"
              defaultValue={hotspot?.gatewayAddress ?? ''}
            />
            <Field
              id="poolStart"
              label={t('fields.poolStart')}
              required
              placeholder="10.5.50.10"
              defaultValue={hotspot?.poolStart ?? ''}
            />
            <Field
              id="poolEnd"
              label={t('fields.poolEnd')}
              required
              placeholder="10.5.50.254"
              defaultValue={hotspot?.poolEnd ?? ''}
            />
            <Field
              id="dnsName"
              label={t('fields.dnsName')}
              hint={t('hints.dnsName')}
              maxLength={253}
              defaultValue={hotspot?.dnsName ?? ''}
            />
          </div>
          <p className="text-xs text-muted">{t('chapOnly')}</p>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={pending}>
              {pending ? tCommon('saving') : hotspot ? tCommon('save') : t('create')}
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

function ActiveSessions() {
  const t = useTranslations('hotspots.sessions');
  const format = useFormatter();
  const [sessions, setSessions] = useState<RadiusSession[] | null>(null);

  useEffect(() => {
    const load = () =>
      void api<RadiusSession[]>('/radius-sessions?active=true').then((result) => {
        if (result.ok) setSessions(result.data);
      });
    load();
    const timer = setInterval(load, 60_000);
    return () => {
      clearInterval(timer);
    };
  }, []);

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('title')}</CardTitle>
      </CardHeader>
      <CardContent>
        {sessions === null || sessions.length === 0 ? (
          <p className="text-sm text-muted">{t('empty')}</p>
        ) : (
          <DataTable testId="active-sessions">
            <thead>
              <tr>
                <Th>{t('voucher')}</Th>
                <Th>{t('router')}</Th>
                <Th>{t('mac')}</Th>
                <Th>{t('ip')}</Th>
                <Th>{t('started')}</Th>
                <Th>{t('duration')}</Th>
                <Th>{t('up')}</Th>
                <Th>{t('down')}</Th>
              </tr>
            </thead>
            <tbody>
              {sessions.map((session) => (
                <tr key={session.id}>
                  <Td>{t('serial', { serial: session.voucher.serial })}</Td>
                  <Td>
                    {session.router.name}
                    <span className="block text-xs text-muted">{session.site.name}</span>
                  </Td>
                  <Td className="font-mono text-xs">{session.macAddress ?? '—'}</Td>
                  <Td className="font-mono text-xs">{session.framedIp ?? '—'}</Td>
                  <Td className="whitespace-nowrap">
                    {format.dateTime(new Date(session.startedAt), {
                      dateStyle: 'short',
                      timeStyle: 'short',
                    })}
                  </Td>
                  <Td>{formatDuration(session.durationSeconds)}</Td>
                  <Td>{formatBytes(session.bytesUp)}</Td>
                  <Td>{formatBytes(session.bytesDown)}</Td>
                </tr>
              ))}
            </tbody>
          </DataTable>
        )}
      </CardContent>
    </Card>
  );
}

type Panel =
  { kind: 'create' } | { kind: 'edit'; hotspot: Hotspot } | { kind: 'delete'; hotspot: Hotspot };

/** Réseau → Hotspots : configuration voulue par routeur et état de synchronisation. */
export function HotspotsManager() {
  const t = useTranslations('hotspots');
  const tCommon = useTranslations('common');
  const format = useFormatter();
  const permissions = usePermissions();
  const problemMessage = useProblemMessage();
  const [hotspots, setHotspots] = useState<Hotspot[] | null>(null);
  const [routers, setRouters] = useState<Router[]>([]);
  const [panel, setPanel] = useState<Panel | null>(null);
  const [accessFor, setAccessFor] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: 'error' | 'success'; text: string } | null>(null);
  const canManage = permissions.any('hotspots.manage');

  const load = useCallback(async () => {
    const result = await api<Hotspot[]>('/hotspots');
    if (result.ok) setHotspots(result.data);
    else setMessage({ tone: 'error', text: problemMessage(result.status, result.problem) });
  }, [problemMessage]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
    if (permissions.any('routers.read')) {
      void api<Router[]>('/routers').then((result) => {
        if (result.ok) setRouters(result.data);
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- chargement initial
  }, [load]);

  async function act(hotspot: Hotspot, action: 'enable' | 'disable' | 'sync' | 'delete') {
    const result =
      action === 'delete'
        ? await api(`/hotspots/${hotspot.id}`, { method: 'DELETE' })
        : await api(`/hotspots/${hotspot.id}/${action}`, { method: 'POST' });
    if (result.ok) {
      setPanel(null);
      setMessage({ tone: 'success', text: t(`done.${action}`, { name: hotspot.name }) });
      void load();
    } else setMessage({ tone: 'error', text: problemMessage(result.status, result.problem) });
  }

  const withHotspot = new Set(hotspots?.map((hotspot) => hotspot.router.id) ?? []);
  const available = routers.filter(
    (router) => router.status !== 'PROVISIONING' && !withHotspot.has(router.id),
  );
  const date = (value: string | null) =>
    value ? format.dateTime(new Date(value), { dateStyle: 'short', timeStyle: 'short' }) : '—';

  return (
    <div className="flex flex-col gap-6">
      {canManage && panel === null ? (
        <div>
          <Button
            onClick={() => {
              setPanel({ kind: 'create' });
              setMessage(null);
            }}
          >
            <Plus className="size-4" aria-hidden /> {t('add')}
          </Button>
        </div>
      ) : null}
      {panel?.kind === 'create' || panel?.kind === 'edit' ? (
        <HotspotForm
          hotspot={panel.kind === 'edit' ? panel.hotspot : null}
          routers={available}
          onCancel={() => {
            setPanel(null);
          }}
          onSaved={() => {
            setPanel(null);
            setMessage({ tone: 'success', text: t('saved') });
            void load();
          }}
        />
      ) : null}
      {panel?.kind === 'delete' ? (
        <ConfirmPanel
          title={t('deleteTitle', { name: panel.hotspot.name })}
          description={t('deleteDescription')}
        >
          <div className="flex gap-2">
            <Button variant="danger" onClick={() => void act(panel.hotspot, 'delete')}>
              {t('deleteConfirm')}
            </Button>
            <Button
              variant="secondary"
              onClick={() => {
                setPanel(null);
              }}
            >
              {tCommon('cancel')}
            </Button>
          </div>
        </ConfirmPanel>
      ) : null}
      {message ? <FormMessage tone={message.tone}>{message.text}</FormMessage> : null}

      {hotspots === null ? <p className="text-sm text-muted">{tCommon('loading')}</p> : null}
      {hotspots?.length === 0 ? (
        <EmptyState
          icon={<Wifi className="size-8" aria-hidden />}
          title={t('emptyTitle')}
          description={t('emptyDescription')}
        />
      ) : null}
      {hotspots && hotspots.length > 0 ? (
        <DataTable testId="hotspots-table">
          <thead>
            <tr>
              <Th>{t('columns.router')}</Th>
              <Th>{t('columns.name')}</Th>
              <Th>{t('columns.network')}</Th>
              <Th>{t('columns.state')}</Th>
              <Th>{t('columns.sync')}</Th>
              <Th>{t('columns.actions')}</Th>
            </tr>
          </thead>
          <tbody>
            {hotspots.map((hotspot) => (
              <tr key={hotspot.id}>
                <Td>
                  <span className="font-medium text-foreground">{hotspot.router.name}</span>
                  <span className="block text-xs text-muted">
                    {hotspot.site.name} · {hotspot.router.tunnelIp}
                  </span>
                </Td>
                <Td>
                  {hotspot.name}
                  <span className="block font-mono text-xs text-muted">{hotspot.interface}</span>
                  {hotspot.dnsName ? (
                    <span className="block font-mono text-xs text-muted">{hotspot.dnsName}</span>
                  ) : null}
                </Td>
                <Td className="font-mono text-xs">
                  <span className="block">{hotspot.gatewayAddress}</span>
                  <span className="block text-muted">
                    {hotspot.poolStart} – {hotspot.poolEnd}
                  </span>
                </Td>
                <Td>
                  <Badge tone={hotspot.desiredState === 'ENABLED' ? 'success' : 'neutral'} dot>
                    {t(`desired.${hotspot.desiredState}`)}
                  </Badge>
                </Td>
                <Td>
                  <Badge tone={SYNC_STATUS_TONE[hotspot.syncStatus]} dot>
                    {t(`sync.${hotspot.syncStatus}`)}
                  </Badge>
                  <span className="block text-xs text-muted">
                    {t('versions', {
                      applied: hotspot.appliedVersion ?? '—',
                      wanted: hotspot.configVersion,
                    })}
                  </span>
                  <span className="block text-xs text-muted">
                    {t('lastSync', { at: date(hotspot.lastSyncAt) })}
                  </span>
                  {hotspot.lastError ? (
                    <span className="block max-w-xs text-xs break-words text-danger">
                      {hotspot.lastError}
                    </span>
                  ) : null}
                </Td>
                <Td>
                  <div className="flex flex-wrap gap-2">
                    {canManage ? (
                      <>
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() => {
                            setPanel({ kind: 'edit', hotspot });
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
                              hotspot,
                              hotspot.desiredState === 'ENABLED' ? 'disable' : 'enable',
                            )
                          }
                        >
                          {hotspot.desiredState === 'ENABLED' ? t('disable') : t('enable')}
                        </Button>
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() => void act(hotspot, 'sync')}
                        >
                          {t('syncNow')}
                        </Button>
                        <Button
                          size="sm"
                          variant="danger"
                          onClick={() => {
                            setPanel({ kind: 'delete', hotspot });
                          }}
                        >
                          {tCommon('delete')}
                        </Button>
                      </>
                    ) : null}
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setAccessFor(accessFor === hotspot.router.id ? null : hotspot.router.id);
                      }}
                    >
                      {t('access.toggle')}
                    </Button>
                  </div>
                  {accessFor === hotspot.router.id ? (
                    <div className="mt-3">
                      <ConfigAccessPanel routerId={hotspot.router.id} />
                    </div>
                  ) : null}
                </Td>
              </tr>
            ))}
          </tbody>
        </DataTable>
      ) : null}

      {available.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>{t('access.routersTitle')}</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <p className="text-sm text-muted">{t('access.routersIntro')}</p>
            <ul className="flex flex-col divide-y divide-border">
              {available.map((router) => (
                <li key={router.id} className="flex flex-col gap-2 py-2">
                  <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
                    <span>
                      <span className="font-medium text-foreground">{router.name}</span>{' '}
                      <span className="text-muted">· {router.site.name}</span>
                    </span>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setAccessFor(accessFor === router.id ? null : router.id);
                      }}
                    >
                      {t('access.toggle')}
                    </Button>
                  </div>
                  {accessFor === router.id ? <ConfigAccessPanel routerId={router.id} /> : null}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      ) : null}

      {permissions.any('clients.read') ? <ActiveSessions /> : null}
    </div>
  );
}
