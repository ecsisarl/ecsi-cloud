import {
  Badge,
  type BadgeTone,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  StatCard,
} from '@ecsi/ui';
import type { HealthStatus } from '@ecsi/shared';
import { Activity, AlertTriangle, Banknote, Router, Ticket, Users, Wallet } from 'lucide-react';
import { getTranslations } from 'next-intl/server';
import { PageHeader } from '@/components/page-header';
import { fetchHealth } from '@/lib/api';

// Toujours rendu à la demande : l'état de la plateforme doit être réel.
export const dynamic = 'force-dynamic';

const STATUS_TONE: Record<HealthStatus, BadgeTone> = {
  ok: 'success',
  degraded: 'warning',
  down: 'danger',
};

export default async function DashboardPage() {
  const t = await getTranslations('dashboard');
  const health = await fetchHealth();

  // Aucun chiffre n'est simulé : chaque indicateur affiche « — » jusqu'à la livraison de son module.
  const kpis = [
    { key: 'revenueToday', icon: <Banknote className="size-5" />, sprint: '9' },
    { key: 'revenueMonth', icon: <Wallet className="size-5" />, sprint: '9' },
    { key: 'ticketsSold', icon: <Ticket className="size-5" />, sprint: '8' },
    { key: 'connectedClients', icon: <Users className="size-5" />, sprint: '7' },
    { key: 'routersOnline', icon: <Router className="size-5" />, sprint: '4' },
    { key: 'openAlerts', icon: <AlertTriangle className="size-5" />, sprint: '4' },
  ] as const;

  return (
    <>
      <PageHeader title={t('title')} subtitle={t('subtitle')} />

      <section className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {kpis.map((kpi) => (
          <StatCard
            key={kpi.key}
            label={t(`kpi.${kpi.key}`)}
            value={null}
            icon={kpi.icon}
            hint={t('availableAt', { sprint: kpi.sprint })}
          />
        ))}
      </section>

      <section className="mt-6">
        <Card>
          <CardHeader className="flex-row items-start justify-between">
            <div>
              <CardTitle className="flex items-center gap-2">
                <Activity className="size-4 text-primary" aria-hidden />
                {t('platform.title')}
              </CardTitle>
              <CardDescription>{t('platform.description')}</CardDescription>
            </div>
            {health ? (
              <Badge tone={STATUS_TONE[health.status]} dot>
                {t(`platform.status.${health.status}`)}
              </Badge>
            ) : (
              <Badge tone="danger" dot>
                {t('platform.unreachable')}
              </Badge>
            )}
          </CardHeader>
          {health ? (
            <CardContent>
              <ul className="divide-y divide-border">
                {(['database', 'redis', 'storage'] as const).map((name) => {
                  const check = health.checks[name];
                  const status = check?.status ?? 'down';
                  return (
                    <li key={name} className="flex items-center justify-between py-3 text-sm">
                      <span className="text-foreground">{t(`platform.checks.${name}`)}</span>
                      <span className="flex items-center gap-3">
                        {check?.latencyMs !== undefined ? (
                          <span className="text-xs text-muted tabular-nums">
                            {check.latencyMs} ms
                          </span>
                        ) : null}
                        <Badge tone={STATUS_TONE[status]} dot>
                          {t(`platform.status.${status}`)}
                        </Badge>
                      </span>
                    </li>
                  );
                })}
              </ul>
              <p className="mt-3 text-xs text-muted">
                {t('platform.version', { version: health.version })}
              </p>
            </CardContent>
          ) : null}
        </Card>
      </section>
    </>
  );
}
