'use client';

import type { MonitoringOverview } from '@ecsi/shared';
import { StatCard } from '@ecsi/ui';
import { AlertTriangle, Router } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { usePermissions } from '@/components/me-context';
import { api } from '@/lib/client-api';

/**
 * Indicateurs « Routeurs en ligne » et « Alertes ouvertes » du tableau de bord (lot E1),
 * lus dans la supervision. Sans monitoring.read, ou si l'API ne répond pas : « — ».
 */
export function MonitoringKpis() {
  const t = useTranslations('dashboard');
  const permissions = usePermissions();
  const allowed = permissions.any('monitoring.read');
  const [overview, setOverview] = useState<MonitoringOverview | null>(null);

  useEffect(() => {
    if (!allowed) return;
    void api<MonitoringOverview>('/monitoring/overview').then((result) => {
      if (result.ok) setOverview(result.data);
    });
  }, [allowed]);

  const hint = allowed ? t('monitoringHint') : t('monitoringNoAccess');
  return (
    <>
      <StatCard
        label={t('kpi.routersOnline')}
        value={
          overview ? `${String(overview.routers.ONLINE)} / ${String(overview.routers.total)}` : null
        }
        icon={<Router className="size-5" />}
        hint={hint}
      />
      <StatCard
        label={t('kpi.openAlerts')}
        value={overview ? String(overview.alerts.open) : null}
        icon={<AlertTriangle className="size-5" />}
        hint={
          overview
            ? t('alertsHint', {
                critical: overview.alerts.critical,
                unacknowledged: overview.alerts.unacknowledged,
              })
            : hint
        }
      />
    </>
  );
}
