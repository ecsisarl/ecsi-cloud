import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  foreignKey,
  index,
  jsonb,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { id, updatedAt } from './columns.js';
import { users } from './identity.js';
import { routers } from './routers.js';

/** Statuts mesurés (un routeur en cours d'enrôlement n'est jamais collecté). */
export const SAMPLE_STATUSES = ['ONLINE', 'DEGRADED', 'OFFLINE'] as const;
export type SampleStatus = (typeof SAMPLE_STATUSES)[number];

export const ALERT_TYPES = [
  'ROUTER_OFFLINE',
  'ROUTER_DEGRADED',
  'CPU_HIGH',
  'MEMORY_HIGH',
] as const;
export type AlertType = (typeof ALERT_TYPES)[number];
export const ALERT_SEVERITIES = ['WARNING', 'CRITICAL'] as const;
export type AlertSeverity = (typeof ALERT_SEVERITIES)[number];

/** Valeurs relevées à l'ouverture d'une alerte (nombres et dernière erreur nettoyée). */
export type AlertDetailsRow = Record<string, number | string>;

/**
 * Historique de supervision (lot E1) : une mesure par collecte, écrite par le worker
 * (rôle ecsi_worker), conservée un nombre de jours borné (purge par le worker). Seules les
 * valeurs DÉJÀ collectées par la supervision S3A y figurent (system/resource) ; une collecte
 * en échec est enregistrée sans valeurs, pour la disponibilité.
 */
export const routerMetrics = pgTable(
  'router_metrics',
  {
    id: id(),
    companyId: uuid('company_id').notNull(),
    routerId: uuid('router_id').notNull(),
    sampledAt: timestamp('sampled_at', { withTimezone: true }).notNull().defaultNow(),
    status: text('status').$type<SampleStatus>().notNull(),
    cpuLoad: smallint('cpu_load'),
    totalMemory: bigint('total_memory', { mode: 'number' }),
    freeMemory: bigint('free_memory', { mode: 'number' }),
    uptimeSeconds: bigint('uptime_seconds', { mode: 'number' }),
  },
  (t) => [
    foreignKey({
      name: 'router_metrics_router_fk',
      columns: [t.companyId, t.routerId],
      foreignColumns: [routers.companyId, routers.id],
    }).onDelete('cascade'),
    index('router_metrics_router_time_idx').on(t.routerId, t.sampledAt),
    index('router_metrics_sampled_at_idx').on(t.sampledAt),
    check('router_metrics_status_check', sql`${t.status} in ('ONLINE', 'DEGRADED', 'OFFLINE')`),
    check(
      'router_metrics_cpu_load_check',
      sql`${t.cpuLoad} is null or ${t.cpuLoad} between 0 and 100`,
    ),
  ],
);

/**
 * Alertes de supervision (lot E1), ouvertes et résolues par le worker sur changement d'état,
 * acquittées par un utilisateur (API, auditée). Au plus UNE alerte ouverte par routeur et
 * par type (index unique partiel) : l'ouverture est idempotente. Le site affiché est celui
 * du routeur (pas de copie qui deviendrait fausse après un déplacement).
 */
export const alerts = pgTable(
  'alerts',
  {
    id: id(),
    companyId: uuid('company_id').notNull(),
    routerId: uuid('router_id').notNull(),
    type: text('type').$type<AlertType>().notNull(),
    severity: text('severity').$type<AlertSeverity>().notNull(),
    details: jsonb('details').$type<AlertDetailsRow>().notNull().default({}),
    openedAt: timestamp('opened_at', { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    acknowledgedAt: timestamp('acknowledged_at', { withTimezone: true }),
    acknowledgedBy: uuid('acknowledged_by').references(() => users.id, { onDelete: 'set null' }),
    updatedAt: updatedAt(),
  },
  (t) => [
    foreignKey({
      name: 'alerts_router_fk',
      columns: [t.companyId, t.routerId],
      foreignColumns: [routers.companyId, routers.id],
    }).onDelete('cascade'),
    uniqueIndex('alerts_open_key')
      .on(t.routerId, t.type)
      .where(sql`${t.resolvedAt} is null`),
    index('alerts_company_opened_idx').on(t.companyId, t.openedAt),
    index('alerts_resolved_at_idx')
      .on(t.resolvedAt)
      .where(sql`${t.resolvedAt} is not null`),
    check(
      'alerts_type_check',
      sql`${t.type} in ('ROUTER_OFFLINE', 'ROUTER_DEGRADED', 'CPU_HIGH', 'MEMORY_HIGH')`,
    ),
    check('alerts_severity_check', sql`${t.severity} in ('WARNING', 'CRITICAL')`),
    check(
      'alerts_resolved_check',
      sql`${t.resolvedAt} is null or ${t.resolvedAt} >= ${t.openedAt}`,
    ),
    check(
      'alerts_acknowledged_check',
      sql`${t.acknowledgedBy} is null or ${t.acknowledgedAt} is not null`,
    ),
  ],
);
