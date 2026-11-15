'use client';

import { type Alert, ALERT_STATES, type AlertState, type MonitoringOverview } from '@ecsi/shared';
import {
  Badge,
  type BadgeTone,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  EmptyState,
  StatCard,
} from '@ecsi/ui';
import { Activity, AlertTriangle, BellOff, CheckCircle2, Router, WifiOff } from 'lucide-react';
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
  useProblemMessage,
} from '@/components/admin/controls';
import { usePermissions } from '@/components/me-context';
import { formatUptime, ROUTER_STATUS_TONE } from '@/components/routers/format';
import { api } from '@/lib/client-api';
import { RouterHistory } from './router-history';
import { notifyAlertsChanged } from './use-alert-summary';

/** Rafraîchissement de la page (le worker collecte chaque routeur toutes les 60 s). */
const REFRESH_MS = 60_000;

const SEVERITY_TONE: Record<Alert['severity'], BadgeTone> = {
  CRITICAL: 'danger',
  WARNING: 'warning',
};

/**
 * Réseau → Monitoring (lot E1) : compteurs, alertes (avec acquittement), routeurs supervisés
 * et historique du routeur choisi. Données du worker de supervision uniquement ; la page se
 * rafraîchit toutes les minutes.
 */
export function MonitoringDashboard() {
  const t = useTranslations('monitoring');
  const tRouters = useTranslations('routers');
  const format = useFormatter();
  const permissions = usePermissions();
  const problemMessage = useProblemMessage();
  const [overview, setOverview] = useState<MonitoringOverview | null>(null);
  const [alerts, setAlerts] = useState<Alert[] | null>(null);
  const [state, setState] = useState<AlertState>('open');
  const [selected, setSelected] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: 'error' | 'success'; text: string } | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const canAcknowledge = permissions.any('monitoring.acknowledge');
  const canOpenRouter = permissions.any('routers.read');

  const load = useCallback(async () => {
    const [overviewResult, alertsResult] = await Promise.all([
      api<MonitoringOverview>('/monitoring/overview'),
      api<Alert[]>(`/monitoring/alerts?state=${state}&limit=100`),
    ]);
    if (overviewResult.ok) {
      setOverview(overviewResult.data);
      setSelected((current) => current ?? overviewResult.data.items[0]?.id ?? null);
    } else {
      setMessage({
        tone: 'error',
        text: problemMessage(overviewResult.status, overviewResult.problem),
      });
    }
    if (alertsResult.ok) setAlerts(alertsResult.data);
  }, [state, problemMessage]);

  useEffect(() => {
    // Chargement initial puis rafraîchissement périodique (onglet visible seulement).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') {
        void load();
        setRefreshKey((key) => key + 1);
      }
    }, REFRESH_MS);
    return () => {
      clearInterval(timer);
    };
  }, [load]);

  async function acknowledge(alert: Alert) {
    const result = await api<Alert>(`/monitoring/alerts/${alert.id}/acknowledge`, {
      method: 'POST',
    });
    if (result.ok || result.status === 409) {
      setMessage(result.ok ? { tone: 'success', text: t('alerts.acknowledgedMessage') } : null);
      notifyAlertsChanged();
      void load();
    } else setMessage({ tone: 'error', text: problemMessage(result.status, result.problem) });
  }

  if (!overview) {
    return message ? (
      <FormMessage tone="error">{message.text}</FormMessage>
    ) : (
      <p className="text-sm text-muted">{t('loading')}</p>
    );
  }

  const relative = (iso: string | null) => (iso ? format.relativeTime(new Date(iso)) : '—');
  const dateTime = (iso: string) =>
    format.dateTime(new Date(iso), { dateStyle: 'medium', timeStyle: 'short' });
  const percent = (value: number | null) => (value === null ? '—' : `${String(value)} %`);
  const selectedRouter = overview.items.find((item) => item.id === selected) ?? null;
  const detail = (alert: Alert): string | null => {
    const d = alert.details;
    if (d.cpuLoad !== undefined)
      return t('alerts.detailCpu', { value: d.cpuLoad, threshold: d.threshold ?? 0 });
    if (d.memoryUsedPercent !== undefined) {
      return t('alerts.detailMemory', { value: d.memoryUsedPercent, threshold: d.threshold ?? 0 });
    }
    if (d.consecutiveFailures !== undefined) {
      return t('alerts.detailFailures', { count: d.consecutiveFailures });
    }
    return null;
  };

  return (
    <div className="flex flex-col gap-6">
      <section className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label={t('kpi.online')}
          value={`${String(overview.routers.ONLINE)} / ${String(overview.routers.total)}`}
          icon={<Router className="size-5" aria-hidden />}
          hint={
            overview.routers.PROVISIONING > 0
              ? t('kpi.provisioning', { count: overview.routers.PROVISIONING })
              : undefined
          }
        />
        <StatCard
          label={t('kpi.degraded')}
          value={String(overview.routers.DEGRADED)}
          icon={<Activity className="size-5" aria-hidden />}
        />
        <StatCard
          label={t('kpi.offline')}
          value={String(overview.routers.OFFLINE)}
          icon={<WifiOff className="size-5" aria-hidden />}
        />
        <StatCard
          label={t('kpi.openAlerts')}
          value={String(overview.alerts.open)}
          icon={<AlertTriangle className="size-5" aria-hidden />}
          hint={t('kpi.alertsHint', {
            critical: overview.alerts.critical,
            unacknowledged: overview.alerts.unacknowledged,
          })}
        />
      </section>

      {message ? <FormMessage tone={message.tone}>{message.text}</FormMessage> : null}

      <section className="flex flex-col gap-3" aria-labelledby="alerts-title">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 id="alerts-title" className="text-lg font-semibold text-foreground">
              {t('alerts.title')}
            </h2>
            <p className="text-sm text-muted">{t('alerts.description')}</p>
          </div>
          <div className="w-48">
            <FieldShell id="alert-state" label={t('alerts.filter')}>
              <Select
                id="alert-state"
                value={state}
                onChange={(event) => {
                  setState(event.target.value as AlertState);
                }}
              >
                {ALERT_STATES.map((value) => (
                  <option key={value} value={value}>
                    {t(`alerts.states.${value}`)}
                  </option>
                ))}
              </Select>
            </FieldShell>
          </div>
        </div>
        {alerts?.length === 0 ? (
          <EmptyState
            icon={<CheckCircle2 className="size-8" aria-hidden />}
            title={state === 'open' ? t('alerts.emptyOpenTitle') : t('alerts.emptyTitle')}
            description={t('alerts.emptyDescription')}
          />
        ) : null}
        {alerts && alerts.length > 0 ? (
          <DataTable testId="alerts-table">
            <thead>
              <tr>
                <Th>{t('alerts.columns.severity')}</Th>
                <Th>{t('alerts.columns.type')}</Th>
                <Th>{t('alerts.columns.router')}</Th>
                <Th>{t('alerts.columns.opened')}</Th>
                <Th>{t('alerts.columns.state')}</Th>
                <Th>{t('alerts.columns.acknowledgement')}</Th>
              </tr>
            </thead>
            <tbody>
              {alerts.map((alert) => (
                <tr key={alert.id}>
                  <Td>
                    <Badge tone={alert.resolvedAt ? 'neutral' : SEVERITY_TONE[alert.severity]} dot>
                      {t(`severities.${alert.severity}`)}
                    </Badge>
                  </Td>
                  <Td>
                    <span className="font-medium text-foreground">{t(`types.${alert.type}`)}</span>
                    {detail(alert) ? (
                      <span className="block text-xs text-muted">{detail(alert)}</span>
                    ) : null}
                  </Td>
                  <Td>
                    {canOpenRouter ? (
                      <Link
                        href={`/reseau/routeurs/${alert.router.id}`}
                        className="font-medium text-primary hover:underline"
                      >
                        {alert.router.name}
                      </Link>
                    ) : (
                      <span className="font-medium">{alert.router.name}</span>
                    )}
                    <span className="block text-xs text-muted">{alert.site.name}</span>
                  </Td>
                  <Td>
                    <span title={dateTime(alert.openedAt)}>{relative(alert.openedAt)}</span>
                  </Td>
                  <Td>
                    {alert.resolvedAt ? (
                      <span className="text-muted" title={dateTime(alert.resolvedAt)}>
                        {t('alerts.resolvedAt', { when: relative(alert.resolvedAt) })}
                      </span>
                    ) : (
                      <span className="font-medium text-foreground">{t('alerts.ongoing')}</span>
                    )}
                  </Td>
                  <Td>
                    {alert.acknowledgedAt ? (
                      <span className="text-xs text-muted" title={dateTime(alert.acknowledgedAt)}>
                        {t('alerts.acknowledgedBy', {
                          name: alert.acknowledgedBy?.fullName ?? t('alerts.formerMember'),
                          when: relative(alert.acknowledgedAt),
                        })}
                      </span>
                    ) : canAcknowledge ? (
                      <Button size="sm" variant="secondary" onClick={() => void acknowledge(alert)}>
                        <BellOff className="size-4" aria-hidden /> {t('alerts.acknowledge')}
                      </Button>
                    ) : (
                      <span className="text-xs text-muted">{t('alerts.notAcknowledged')}</span>
                    )}
                  </Td>
                </tr>
              ))}
            </tbody>
          </DataTable>
        ) : null}
      </section>

      <section className="flex flex-col gap-3" aria-labelledby="routers-title">
        <div>
          <h2 id="routers-title" className="text-lg font-semibold text-foreground">
            {t('routers.title')}
          </h2>
          <p className="text-sm text-muted">{t('routers.description')}</p>
        </div>
        {overview.items.length === 0 ? (
          <EmptyState
            icon={<Router className="size-8" aria-hidden />}
            title={t('routers.emptyTitle')}
            description={t('routers.emptyDescription')}
          />
        ) : (
          <DataTable testId="monitoring-routers-table">
            <thead>
              <tr>
                <Th>{tRouters('columns.name')}</Th>
                <Th>{tRouters('columns.status')}</Th>
                <Th>{tRouters('columns.cpu')}</Th>
                <Th>{tRouters('columns.memory')}</Th>
                <Th>{tRouters('columns.uptime')}</Th>
                <Th>{tRouters('columns.lastSeen')}</Th>
                <Th>{t('routers.openAlerts')}</Th>
              </tr>
            </thead>
            <tbody>
              {overview.items.map((item) => (
                <tr
                  key={item.id}
                  className={item.id === selected ? 'bg-primary-soft/40' : undefined}
                >
                  <Td>
                    <button
                      type="button"
                      className="text-left font-medium text-primary hover:underline"
                      aria-pressed={item.id === selected}
                      onClick={() => {
                        setSelected(item.id);
                      }}
                    >
                      {item.name}
                    </button>
                    <span className="block text-xs text-muted">{item.site.name}</span>
                  </Td>
                  <Td>
                    <Badge tone={ROUTER_STATUS_TONE[item.status]} dot>
                      {tRouters(`statuses.${item.status}`)}
                    </Badge>
                  </Td>
                  <Td className="tabular-nums">{percent(item.cpuLoad)}</Td>
                  <Td className="tabular-nums">{percent(item.memoryUsedPercent)}</Td>
                  <Td>{formatUptime(item.uptimeSeconds)}</Td>
                  <Td>{item.lastSeenAt ? relative(item.lastSeenAt) : tRouters('never')}</Td>
                  <Td>
                    {item.openAlerts > 0 ? (
                      <Badge tone="danger">{item.openAlerts}</Badge>
                    ) : (
                      <span className="text-muted">0</span>
                    )}
                  </Td>
                </tr>
              ))}
            </tbody>
          </DataTable>
        )}
      </section>

      {selectedRouter ? (
        <Card>
          <CardHeader>
            <CardTitle>{t('history.title', { name: selectedRouter.name })}</CardTitle>
            <CardDescription>{t('history.description')}</CardDescription>
          </CardHeader>
          <CardContent>
            <RouterHistory routerId={selectedRouter.id} refreshKey={refreshKey} />
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
