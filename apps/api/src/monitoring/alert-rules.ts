import { ALERT_SEVERITY, type AlertSeverity, type AlertType } from '@ecsi/shared';
import type { AlertDetailsRow, SampleStatus } from '../database/schema/index.js';

/**
 * Règles d'ouverture et de résolution des alertes (lot E1). Fonction PURE : le worker lui
 * donne l'état de la collecte qui vient d'avoir lieu et les alertes déjà ouvertes, elle
 * renvoie les SEULS changements à appliquer. Rejouer la même entrée ne produit donc aucun
 * changement de plus (idempotence), et l'index unique partiel alerts_open_key garantit en
 * base qu'il n'existe jamais deux alertes ouvertes du même type pour un routeur.
 *
 *  - ROUTER_OFFLINE  (critique) : ouverte tant que le routeur est OFFLINE (au sens de la
 *    supervision S3A : 180 s sans réponse ET 3 échecs, routers/supervision/status.ts),
 *    résolue dès qu'il ne l'est plus.
 *  - ROUTER_DEGRADED (avertissement) : ouverte quand le routeur est DEGRADED depuis au moins
 *    `degradedMinFailures` collectes consécutives (une erreur isolée n'alerte pas), résolue
 *    dès qu'il n'est plus DEGRADED (rétabli, ou passé OFFLINE : l'alerte OFFLINE prend le
 *    relais).
 *  - CPU_HIGH / MEMORY_HIGH (avertissement) : ouvertes quand les `sustainSamples` dernières
 *    collectes RÉUSSIES dépassent toutes le seuil (pas d'alerte sur un pic isolé), résolues
 *    quand la mesure redescend sous « seuil − hystérésis » (pas d'oscillation autour du
 *    seuil). Sans mesure fraîche (collecte en échec), rien ne change, sauf hors ligne : sans
 *    aucune mesure, une alerte de charge n'a plus de fondement et ROUTER_OFFLINE la remplace.
 */
export interface AlertThresholds {
  readonly cpuHighPercent: number;
  readonly memoryHighPercent: number;
  readonly hysteresisPercent: number;
  readonly sustainSamples: number;
  readonly degradedMinFailures: number;
}

export const DEFAULT_ALERT_THRESHOLDS: AlertThresholds = {
  cpuHighPercent: 90,
  memoryHighPercent: 90,
  hysteresisPercent: 10,
  sustainSamples: 3,
  degradedMinFailures: 3,
};

export interface MetricReading {
  readonly cpuLoad: number | null;
  readonly memoryUsedPercent: number | null;
}

export interface AlertEvaluationInput {
  /** Statut décidé par la supervision pour cette collecte. */
  readonly status: SampleStatus;
  readonly consecutiveFailures: number;
  /** Dernière erreur de collecte (déjà nettoyée de tout secret par la supervision). */
  readonly lastError: string | null;
  /**
   * Mesures des dernières collectes réussies, la plus récente d'abord. Vide si la collecte
   * courante a échoué (aucune mesure fraîche).
   */
  readonly recent: readonly MetricReading[];
  /** Types d'alertes actuellement ouvertes pour ce routeur. */
  readonly open: ReadonlySet<AlertType>;
}

export interface AlertToOpen {
  readonly type: AlertType;
  readonly severity: AlertSeverity;
  readonly details: AlertDetailsRow;
}

export interface AlertChanges {
  readonly open: AlertToOpen[];
  readonly resolve: AlertType[];
}

const MAX_ERROR_LENGTH = 200;

export function evaluateAlerts(
  input: AlertEvaluationInput,
  thresholds: AlertThresholds = DEFAULT_ALERT_THRESHOLDS,
): AlertChanges {
  const changes: { open: AlertToOpen[]; resolve: AlertType[] } = { open: [], resolve: [] };
  const want = (type: AlertType, active: boolean, details: () => AlertDetailsRow) => {
    if (active && !input.open.has(type)) {
      changes.open.push({ type, severity: ALERT_SEVERITY[type], details: details() });
    } else if (!active && input.open.has(type)) {
      changes.resolve.push(type);
    }
  };
  const failureDetails = (): AlertDetailsRow => ({
    consecutiveFailures: input.consecutiveFailures,
    ...(input.lastError ? { lastError: input.lastError.slice(0, MAX_ERROR_LENGTH) } : {}),
  });

  want('ROUTER_OFFLINE', input.status === 'OFFLINE', failureDetails);
  want(
    'ROUTER_DEGRADED',
    input.status === 'DEGRADED' &&
      (input.open.has('ROUTER_DEGRADED') ||
        input.consecutiveFailures >= thresholds.degradedMinFailures),
    failureDetails,
  );

  const metric = (
    type: 'CPU_HIGH' | 'MEMORY_HIGH',
    pick: (reading: MetricReading) => number | null,
    threshold: number,
    key: 'cpuLoad' | 'memoryUsedPercent',
  ) => {
    if (input.status === 'OFFLINE') {
      want(type, false, () => ({}));
      return;
    }
    const current = input.recent[0] ? pick(input.recent[0]) : null;
    if (current === null) return; // aucune mesure fraîche : état inchangé
    if (input.open.has(type)) {
      want(type, current >= threshold - thresholds.hysteresisPercent, () => ({}));
      return;
    }
    const window = input.recent.slice(0, thresholds.sustainSamples);
    const sustained =
      window.length >= thresholds.sustainSamples &&
      window.every((reading) => {
        const value = pick(reading);
        return value !== null && value >= threshold;
      });
    want(type, sustained, () => ({ [key]: current, threshold }));
  };
  metric('CPU_HIGH', (r) => r.cpuLoad, thresholds.cpuHighPercent, 'cpuLoad');
  metric(
    'MEMORY_HIGH',
    (r) => r.memoryUsedPercent,
    thresholds.memoryHighPercent,
    'memoryUsedPercent',
  );
  return changes;
}
