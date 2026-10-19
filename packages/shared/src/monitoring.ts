import { z } from 'zod';
import type { RouterStatus } from './routers.js';

/**
 * Supervision et alertes dans l'application (lot E1). Uniquement des données déjà collectées
 * par le worker de supervision (system/resource, statut ONLINE / DEGRADED / OFFLINE) : aucune
 * nouvelle commande RouterOS. Aucun secret ne figure dans ces types.
 */
export const ALERT_TYPES = [
  'ROUTER_OFFLINE',
  'ROUTER_DEGRADED',
  'CPU_HIGH',
  'MEMORY_HIGH',
] as const;
export type AlertType = (typeof ALERT_TYPES)[number];

export const ALERT_SEVERITIES = ['WARNING', 'CRITICAL'] as const;
export type AlertSeverity = (typeof ALERT_SEVERITIES)[number];

/** Gravité fixe par type : un routeur hors ligne est critique, le reste est un avertissement. */
export const ALERT_SEVERITY: Readonly<Record<AlertType, AlertSeverity>> = {
  ROUTER_OFFLINE: 'CRITICAL',
  ROUTER_DEGRADED: 'WARNING',
  CPU_HIGH: 'WARNING',
  MEMORY_HIGH: 'WARNING',
};

export const ALERT_STATES = ['open', 'resolved', 'all'] as const;
export type AlertState = (typeof ALERT_STATES)[number];

export const listAlertsQuerySchema = z.strictObject({
  state: z.enum(ALERT_STATES).default('open'),
  siteId: z.uuid().optional(),
  routerId: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type ListAlertsQuery = z.infer<typeof listAlertsQuerySchema>;

/** Historique d'un routeur : 1 h à 7 jours (durée de conservation par défaut des mesures). */
export const MONITORING_MAX_HOURS = 168;
export const routerMetricsQuerySchema = z.strictObject({
  hours: z.coerce.number().int().min(1).max(MONITORING_MAX_HOURS).default(24),
});
export type RouterMetricsQuery = z.infer<typeof routerMetricsQuerySchema>;

/** Valeurs relevées à l'ouverture d'une alerte (jamais de secret). */
export interface AlertDetails {
  /** CPU_HIGH : charge processeur (%) et seuil. */
  cpuLoad?: number;
  /** MEMORY_HIGH : mémoire utilisée (%) et seuil. */
  memoryUsedPercent?: number;
  threshold?: number;
  /** ROUTER_OFFLINE / ROUTER_DEGRADED : échecs consécutifs et dernière erreur de collecte. */
  consecutiveFailures?: number;
  lastError?: string;
}

export interface Alert {
  id: string;
  type: AlertType;
  severity: AlertSeverity;
  router: { id: string; name: string; status: RouterStatus };
  site: { id: string; name: string; code: string };
  details: AlertDetails;
  openedAt: string;
  resolvedAt: string | null;
  acknowledgedAt: string | null;
  /** Nom absent si la personne n'est plus membre de l'entreprise. */
  acknowledgedBy: { id: string; fullName: string | null } | null;
}

export interface AlertSummary {
  /** Alertes ouvertes (non résolues). */
  open: number;
  /** Ouvertes et non acquittées : l'indicateur de l'en-tête. */
  unacknowledged: number;
  /** Ouvertes et critiques. */
  critical: number;
}

export interface MonitoredRouter {
  id: string;
  name: string;
  site: { id: string; name: string; code: string };
  status: RouterStatus;
  cpuLoad: number | null;
  memoryUsedPercent: number | null;
  uptimeSeconds: number | null;
  lastSeenAt: string | null;
  openAlerts: number;
}

export interface MonitoringOverview {
  routers: Record<RouterStatus, number> & { total: number };
  alerts: AlertSummary;
  items: MonitoredRouter[];
  generatedAt: string;
}

/** Point d'historique agrégé sur un intervalle (moyennes ; disponibilité de 0 à 1). */
export interface MetricPoint {
  at: string;
  cpuLoad: number | null;
  memoryUsedPercent: number | null;
  availability: number | null;
  samples: number;
}

export interface RouterMetrics {
  routerId: string;
  hours: number;
  bucketSeconds: number;
  points: MetricPoint[];
}

/** Mémoire utilisée en pourcentage entier, ou null si la mesure est absente ou incohérente. */
export function memoryUsedPercent(total: number | null, free: number | null): number | null {
  if (total === null || free === null || total <= 0 || free < 0 || free > total) return null;
  return Math.round(((total - free) / total) * 100);
}
