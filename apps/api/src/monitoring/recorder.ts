import { memoryUsedPercent, type AlertType } from '@ecsi/shared';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { alerts, routerMetrics, type SampleStatus } from '../database/schema/index.js';
import {
  type AlertChanges,
  type AlertThresholds,
  DEFAULT_ALERT_THRESHOLDS,
  evaluateAlerts,
} from './alert-rules.js';

export interface MonitoringOptions {
  /** Conservation des mesures (jours). */
  readonly metricsRetentionDays: number;
  /** Conservation des alertes résolues (jours). */
  readonly alertsRetentionDays: number;
  readonly thresholds: AlertThresholds;
}

export const DEFAULT_MONITORING_OPTIONS: MonitoringOptions = {
  metricsRetentionDays: 7,
  alertsRetentionDays: 90,
  thresholds: DEFAULT_ALERT_THRESHOLDS,
};

/** Résultat d'une collecte, tel que la supervision vient de l'enregistrer. */
export interface PollRecord {
  readonly routerId: string;
  readonly companyId: string;
  readonly status: SampleStatus;
  readonly consecutiveFailures: number;
  readonly lastError: string | null;
  /** Valeurs collectées (collecte réussie), sinon null. */
  readonly metrics: {
    readonly cpuLoad: number | null;
    readonly totalMemory: number | null;
    readonly freeMemory: number | null;
    readonly uptimeSeconds: number | null;
  } | null;
}

const PURGE_BATCH = 5_000;
const PURGE_MAX_BATCHES = 50;

/**
 * Historique et alertes côté worker (rôle ecsi_worker, migration 0007). Pour chaque collecte :
 * une mesure, puis la réconciliation des alertes (evaluateAlerts), dans une transaction.
 * La base n'accepte d'écriture que pour un routeur supervisé par le worker (politiques
 * worker_insert) et refuse toute réouverture d'alerte résolue (worker_resolve).
 */
export class MonitoringRecorder {
  constructor(
    private readonly db: NodePgDatabase<Record<string, unknown>>,
    private readonly options: MonitoringOptions = DEFAULT_MONITORING_OPTIONS,
  ) {}

  record(poll: PollRecord): Promise<AlertChanges> {
    return this.db.transaction(async (tx) => {
      // SQL explicite : seules les colonnes accordées à ecsi_worker sont nommées (Drizzle
      // nommerait aussi id et sampled_at, dont la valeur est imposée par la base).
      const m = poll.metrics;
      await tx.execute(sql`
        insert into router_metrics
          (company_id, router_id, status, cpu_load, total_memory, free_memory, uptime_seconds)
        values (${poll.companyId}, ${poll.routerId}, ${poll.status}, ${m?.cpuLoad ?? null},
                ${m?.totalMemory ?? null}, ${m?.freeMemory ?? null}, ${m?.uptimeSeconds ?? null})`);

      const recent = poll.metrics
        ? (
            await tx
              .select({
                cpuLoad: routerMetrics.cpuLoad,
                totalMemory: routerMetrics.totalMemory,
                freeMemory: routerMetrics.freeMemory,
              })
              .from(routerMetrics)
              .where(
                and(eq(routerMetrics.routerId, poll.routerId), eq(routerMetrics.status, 'ONLINE')),
              )
              .orderBy(desc(routerMetrics.sampledAt), desc(routerMetrics.id))
              .limit(this.options.thresholds.sustainSamples)
          ).map((row) => ({
            cpuLoad: row.cpuLoad,
            memoryUsedPercent: memoryUsedPercent(row.totalMemory, row.freeMemory),
          }))
        : [];

      const openRows = await tx
        .select({ type: alerts.type })
        .from(alerts)
        .where(and(eq(alerts.routerId, poll.routerId), isNull(alerts.resolvedAt)));

      const changes = evaluateAlerts(
        {
          status: poll.status,
          consecutiveFailures: poll.consecutiveFailures,
          lastError: poll.lastError,
          recent,
          open: new Set<AlertType>(openRows.map((row) => row.type)),
        },
        this.options.thresholds,
      );

      for (const alert of changes.open) {
        // Idempotent : une alerte déjà ouverte (autre worker, rejeu) n'est pas dupliquée.
        await tx.execute(sql`
          insert into alerts (company_id, router_id, type, severity, details)
          values (${poll.companyId}, ${poll.routerId}, ${alert.type}, ${alert.severity},
                  ${JSON.stringify(alert.details)}::jsonb)
          on conflict (router_id, type) where resolved_at is null do nothing`);
      }
      if (changes.resolve.length > 0) {
        await tx
          .update(alerts)
          .set({ resolvedAt: sql`now()` })
          .where(
            and(
              eq(alerts.routerId, poll.routerId),
              inArray(alerts.type, changes.resolve),
              isNull(alerts.resolvedAt),
            ),
          );
      }
      return changes;
    });
  }

  /**
   * Purge des mesures plus anciennes que la conservation et des alertes résolues depuis
   * plus longtemps que la leur, par lots (verrous courts). Renvoie le nombre de lignes.
   */
  async purge(): Promise<{ metrics: number; alerts: number }> {
    let metrics = 0;
    for (let batch = 0; batch < PURGE_MAX_BATCHES; batch++) {
      const result = await this.db.execute(sql`
        delete from router_metrics where id in (
          select id from router_metrics
           where sampled_at < now() - make_interval(days => ${this.options.metricsRetentionDays})
           limit ${PURGE_BATCH})`);
      metrics += result.rowCount ?? 0;
      if ((result.rowCount ?? 0) < PURGE_BATCH) break;
    }
    const resolved = await this.db.execute(sql`
      delete from alerts
       where resolved_at is not null
         and resolved_at < now() - make_interval(days => ${this.options.alertsRetentionDays})`);
    return { metrics, alerts: resolved.rowCount ?? 0 };
  }
}

/**
 * Message d'une erreur de base pour les journaux : celui de PostgreSQL (et son code), jamais
 * la requête ni ses paramètres que Drizzle ajoute à son propre message.
 */
export function databaseErrorMessage(error: unknown): string {
  const cause = (error as { cause?: unknown }).cause;
  const source = cause instanceof Error ? cause : error instanceof Error ? error : null;
  if (!source) return 'erreur inconnue';
  const code = (source as { code?: unknown }).code;
  return typeof code === 'string' ? `${code} ${source.message}` : source.message;
}
