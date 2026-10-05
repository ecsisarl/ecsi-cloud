'use client';

import type { EnrollmentCreated, RouterDetail as RouterDetailView, Site } from '@ecsi/shared';
import { Badge, Button, Card, CardContent, CardHeader, CardTitle, EmptyState } from '@ecsi/ui';
import { ArrowLeft, RouterIcon } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
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
import { PageHeader } from '@/components/page-header';
import { api } from '@/lib/client-api';
import { EnrollmentScript, RemovalScript } from './enrollment-panel';
import { formatBytes, formatMemory, formatUptime, ROUTER_STATUS_TONE } from './format';

function Row({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div className="grid grid-cols-3 gap-2 py-2 text-sm">
      <dt className="text-muted">{label}</dt>
      <dd className="col-span-2 break-all text-foreground">
        {value && value !== '' ? value : '—'}
      </dd>
    </div>
  );
}

type Panel = 'edit' | 'credentials' | 'delete' | null;

/**
 * Détail d'un routeur : identité, système, interfaces, supervision, tunnel. Aucune donnée
 * secrète n'est reçue de l'API (seulement « identifiants enregistrés : oui / non »).
 */
export function RouterDetail({ id }: { id: string }) {
  const t = useTranslations('routers');
  const tCommon = useTranslations('common');
  const format = useFormatter();
  const navigation = useRouter();
  const permissions = usePermissions();
  const problemMessage = useProblemMessage();
  const [router, setRouter] = useState<RouterDetailView | null>(null);
  const [sites, setSites] = useState<Site[]>([]);
  const [missing, setMissing] = useState(false);
  const [panel, setPanel] = useState<Panel>(null);
  const [enrollment, setEnrollment] = useState<EnrollmentCreated | null>(null);
  const [message, setMessage] = useState<{ tone: 'error' | 'success'; text: string } | null>(null);

  const load = useCallback(async () => {
    const result = await api<RouterDetailView>(`/routers/${id}`);
    if (result.ok) setRouter(result.data);
    else if (result.status === 404) setMissing(true);
    else setMessage({ tone: 'error', text: problemMessage(result.status, result.problem) });
  }, [id, problemMessage]);

  useEffect(() => {
    // Chargement du routeur depuis l'API (404 si hors de la portée de l'utilisateur).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  useEffect(() => {
    if (panel !== 'edit') return;
    void api<Site[]>('/sites').then((result) => {
      if (result.ok) setSites(result.data);
    });
  }, [panel]);

  async function save(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const result = await api(`/routers/${id}`, {
      method: 'PATCH',
      body: { name: fieldValue(form, 'name').trim(), siteId: fieldValue(form, 'siteId') },
    });
    if (result.ok) {
      setPanel(null);
      setMessage({ tone: 'success', text: tCommon('saved') });
      void load();
    } else setMessage({ tone: 'error', text: problemMessage(result.status, result.problem) });
  }

  async function saveCredentials(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const fingerprint = fieldValue(form, 'tlsFingerprint').trim();
    const result = await api(`/routers/${id}/credentials`, {
      method: 'PUT',
      body: {
        routerosUsername: fieldValue(form, 'routerosUsername').trim(),
        routerosPassword: fieldValue(form, 'routerosPassword'),
        ...(fingerprint ? { tlsFingerprint: fingerprint } : {}),
      },
    });
    event.currentTarget.reset();
    if (result.ok) {
      setPanel(null);
      setMessage({ tone: 'success', text: t('credentials.saved') });
      void load();
    } else setMessage({ tone: 'error', text: problemMessage(result.status, result.problem) });
  }

  async function renew() {
    const result = await api<EnrollmentCreated>(`/routers/${id}/enrollment`, { method: 'POST' });
    if (result.ok) setEnrollment(result.data);
    else setMessage({ tone: 'error', text: problemMessage(result.status, result.problem) });
  }

  async function remove() {
    const result = await api(`/routers/${id}`, { method: 'DELETE' });
    if (result.ok) navigation.push('/reseau/routeurs');
    else setMessage({ tone: 'error', text: problemMessage(result.status, result.problem) });
  }

  if (missing) {
    return (
      <EmptyState
        icon={<RouterIcon className="size-8" aria-hidden />}
        title={t('notFoundTitle')}
        description={t('notFoundDescription')}
      />
    );
  }
  if (!router) return <p className="text-sm text-muted">{tCommon('loading')}</p>;

  const date = (value: string | null) =>
    value ? format.dateTime(new Date(value), { dateStyle: 'medium', timeStyle: 'short' }) : null;
  const provisioning = router.status === 'PROVISIONING';

  return (
    <div className="flex flex-col gap-6">
      <Link
        href="/reseau/routeurs"
        className="flex items-center gap-1 text-sm text-primary hover:underline"
      >
        <ArrowLeft className="size-4" aria-hidden /> {t('back')}
      </Link>
      <PageHeader
        title={router.name}
        subtitle={`${router.site.name} · ${router.tunnelIp}`}
        actions={
          <div className="flex flex-wrap gap-2">
            {permissions.any('routers.update') ? (
              <Button
                variant="secondary"
                onClick={() => {
                  setPanel('edit');
                }}
              >
                {tCommon('edit')}
              </Button>
            ) : null}
            {permissions.any('routers.update') && !provisioning ? (
              <Button
                variant="secondary"
                onClick={() => {
                  setPanel('credentials');
                }}
              >
                {t('credentials.change')}
              </Button>
            ) : null}
            {permissions.any('routers.create') && provisioning && !router.wgPublicKey ? (
              <Button variant="secondary" onClick={() => void renew()}>
                {t('enroll.renew')}
              </Button>
            ) : null}
            {permissions.any('routers.delete') ? (
              <Button
                variant="danger"
                onClick={() => {
                  setPanel('delete');
                }}
              >
                {t('delete')}
              </Button>
            ) : null}
          </div>
        }
      />
      {message ? <FormMessage tone={message.tone}>{message.text}</FormMessage> : null}
      {enrollment ? (
        <EnrollmentScript
          enrollment={enrollment}
          onDone={() => {
            setEnrollment(null);
            void load();
          }}
        />
      ) : null}

      {panel === 'delete' ? (
        <ConfirmPanel
          title={t('deleteTitle', { name: router.name })}
          description={t('deleteDescription')}
        >
          <RemovalScript />
          <div className="flex gap-2">
            <Button variant="danger" onClick={() => void remove()}>
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

      {panel === 'edit' ? (
        <Card>
          <CardContent className="pt-5">
            <form onSubmit={(event) => void save(event)} className="flex flex-col gap-4" noValidate>
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                <Field
                  id="name"
                  label={t('columns.name')}
                  required
                  minLength={2}
                  maxLength={128}
                  defaultValue={router.name}
                />
                <FieldShell id="siteId" label={t('columns.site')}>
                  <Select id="siteId" name="siteId" defaultValue={router.siteId}>
                    {(sites.length ? sites : [router.site]).map((site) => (
                      <option key={site.id} value={site.id}>
                        {site.name} ({site.code})
                      </option>
                    ))}
                  </Select>
                </FieldShell>
              </div>
              <div className="flex gap-2">
                <Button type="submit">{tCommon('save')}</Button>
                <Button
                  variant="secondary"
                  onClick={() => {
                    setPanel(null);
                  }}
                >
                  {tCommon('cancel')}
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      ) : null}

      {panel === 'credentials' ? (
        <Card>
          <CardHeader>
            <CardTitle>{t('credentials.title')}</CardTitle>
          </CardHeader>
          <CardContent>
            <form
              onSubmit={(event) => void saveCredentials(event)}
              className="flex flex-col gap-4"
              autoComplete="off"
              noValidate
            >
              <p className="text-sm text-muted">{t('credentials.intro')}</p>
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                <Field
                  id="routerosUsername"
                  label={t('credentials.username')}
                  required
                  defaultValue={router.routerosUsername ?? ''}
                  maxLength={64}
                />
                <Field
                  id="routerosPassword"
                  label={t('credentials.password')}
                  hint={t('credentials.passwordHint')}
                  type="password"
                  autoComplete="new-password"
                  required
                  minLength={12}
                  maxLength={256}
                />
                <Field
                  id="tlsFingerprint"
                  label={t('credentials.fingerprint')}
                  hint={t('credentials.fingerprintHint')}
                  maxLength={95}
                />
              </div>
              <div className="flex gap-2">
                <Button type="submit">{tCommon('save')}</Button>
                <Button
                  variant="secondary"
                  onClick={() => {
                    setPanel(null);
                  }}
                >
                  {tCommon('cancel')}
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      ) : null}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>{t('detail.system')}</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="divide-y divide-border">
              <Row label={t('detail.identity')} value={router.identity} />
              <Row label={t('columns.board')} value={router.boardName} />
              <Row label={t('columns.version')} value={router.routerosVersion} />
              <Row label={t('detail.architecture')} value={router.architecture} />
              <Row
                label={t('detail.cpu')}
                value={
                  router.cpu
                    ? `${router.cpu}${router.cpuCount ? ` × ${String(router.cpuCount)}` : ''}${
                        router.cpuLoad === null ? '' : ` · ${String(router.cpuLoad)} %`
                      }`
                    : null
                }
              />
              <Row
                label={t('columns.memory')}
                value={formatMemory(router.totalMemory, router.freeMemory)}
              />
              <Row label={t('columns.uptime')} value={formatUptime(router.uptimeSeconds)} />
            </dl>
          </CardContent>
        </Card>
        <div className="flex flex-col gap-6">
          <Card>
            <CardHeader>
              <CardTitle>{t('detail.supervision')}</CardTitle>
            </CardHeader>
            <CardContent>
              <dl className="divide-y divide-border">
                <div className="grid grid-cols-3 gap-2 py-2 text-sm">
                  <dt className="text-muted">{t('columns.status')}</dt>
                  <dd className="col-span-2">
                    <Badge tone={ROUTER_STATUS_TONE[router.status]} dot>
                      {t(`statuses.${router.status}`)}
                    </Badge>
                  </dd>
                </div>
                <Row label={t('columns.lastSeen')} value={date(router.lastSeenAt) ?? t('never')} />
                <Row label={t('detail.lastSync')} value={date(router.lastSyncAt)} />
                <Row label={t('detail.failures')} value={String(router.consecutiveFailures)} />
                <Row label={t('detail.lastError')} value={router.lastError} />
              </dl>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>{t('detail.tunnel')}</CardTitle>
            </CardHeader>
            <CardContent>
              <dl className="divide-y divide-border">
                <Row label={t('columns.tunnelIp')} value={router.tunnelIp} />
                <Row label={t('detail.transport')} value={t(`transports.${router.transport}`)} />
                <Row label={t('detail.wgPublicKey')} value={router.wgPublicKey} />
                <Row label={t('detail.tlsFingerprint')} value={router.tlsFingerprint} />
                <Row
                  label={t('detail.credentials')}
                  value={
                    router.hasCredentials
                      ? t('detail.credentialsSet')
                      : t('detail.credentialsMissing')
                  }
                />
                <Row label={t('credentials.username')} value={router.routerosUsername} />
                <Row label={t('detail.enrolledAt')} value={date(router.enrolledAt)} />
                <Row label={t('detail.activatedAt')} value={date(router.activatedAt)} />
                {provisioning && router.enrollment ? (
                  <Row
                    label={t('detail.tokenExpires')}
                    value={
                      router.enrollment.usedAt
                        ? t('detail.tokenUsed', { at: date(router.enrollment.usedAt) ?? '' })
                        : date(router.enrollment.expiresAt)
                    }
                  />
                ) : null}
              </dl>
            </CardContent>
          </Card>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{t('detail.interfaces')}</CardTitle>
        </CardHeader>
        <CardContent>
          {router.interfaces.length === 0 ? (
            <p className="text-sm text-muted">{t('detail.noInterfaces')}</p>
          ) : (
            <DataTable testId="router-interfaces">
              <thead>
                <tr>
                  <Th>{t('detail.interface')}</Th>
                  <Th>{t('detail.type')}</Th>
                  <Th>{t('columns.status')}</Th>
                  <Th>MAC</Th>
                  <Th>MTU</Th>
                  <Th>RX</Th>
                  <Th>TX</Th>
                </tr>
              </thead>
              <tbody>
                {router.interfaces.map((item) => (
                  <tr key={item.name}>
                    <Td className="font-mono text-xs">{item.name}</Td>
                    <Td>{item.type ?? '—'}</Td>
                    <Td>
                      <Badge
                        tone={item.disabled ? 'neutral' : item.running ? 'success' : 'warning'}
                        dot
                      >
                        {item.disabled
                          ? t('detail.disabled')
                          : item.running
                            ? t('detail.running')
                            : t('detail.down')}
                      </Badge>
                    </Td>
                    <Td className="font-mono text-xs">{item.macAddress ?? '—'}</Td>
                    <Td>{item.mtu ?? '—'}</Td>
                    <Td>{formatBytes(item.rxByte)}</Td>
                    <Td>{formatBytes(item.txByte)}</Td>
                  </tr>
                ))}
              </tbody>
            </DataTable>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
