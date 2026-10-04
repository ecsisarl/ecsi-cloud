import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  foreignKey,
  index,
  inet,
  integer,
  jsonb,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { createdAt, deletedAt, id, updatedAt } from './columns.js';
import { sites } from './sites.js';
import { companies } from './tenancy.js';

export const ROUTER_STATUSES = ['ONLINE', 'DEGRADED', 'OFFLINE'] as const;
export type RouterStatus = (typeof ROUTER_STATUSES)[number];

/** Accès RouterOS, toujours par l'adresse tunnel WireGuard (docs/MIKROTIK.md). */
export const ROUTER_TRANSPORTS = ['REST_HTTPS', 'API'] as const;
export type RouterTransportKind = (typeof ROUTER_TRANSPORTS)[number];

/** Instantané d'une interface lu par la supervision (pas une série temporelle). */
export interface RouterInterfaceSnapshot {
  name: string;
  type: string | null;
  running: boolean | null;
  disabled: boolean | null;
  mtu: number | null;
  macAddress: string | null;
  rxByte: number | null;
  txByte: number | null;
  linkDowns: number | null;
}

/**
 * Routeurs MikroTik supervisés (Sprint 3A).
 *
 *  - (company_id, site_id) -> sites (company_id, id) : un routeur ne peut jamais être
 *    rattaché au site d'une autre entreprise, quelle que soit la requête.
 *  - tunnel_ip : adresse WireGuard du routeur (/32), SEULE adresse jamais contactée par le
 *    worker ; unique parmi les routeurs non supprimés (le plan d'adressage du tunnel est
 *    global à la passerelle). La plage autorisée est validée par l'application
 *    (routers/tunnel-ip.ts) à l'écriture ET avant chaque connexion.
 *  - routeros_password_encrypted : chiffré SecretBox lié au routeur (routers/router-secret.ts).
 *    Jamais de mot de passe en clair ; jamais de clé privée WireGuard du routeur (elle ne
 *    quitte pas le routeur, PROTOCOLE-PROVISIONNEMENT.md).
 *  - tls_fingerprint : SHA-256 (hex) du certificat DER présenté par le service www-ssl,
 *    obligatoire pour le transport REST_HTTPS (épinglage).
 *  - last_sync_at : dernière tentative de collecte ; last_seen_at : dernière collecte réussie.
 */
export const routers = pgTable(
  'routers',
  {
    id: id(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    siteId: uuid('site_id').notNull(),
    name: text('name').notNull(),
    status: text('status').$type<RouterStatus>().notNull().default('OFFLINE'),
    transport: text('transport').$type<RouterTransportKind>().notNull().default('REST_HTTPS'),
    tunnelIp: inet('tunnel_ip').notNull(),
    routerosUsername: text('routeros_username').notNull(),
    routerosPasswordEncrypted: text('routeros_password_encrypted').notNull(),
    tlsFingerprint: text('tls_fingerprint'),
    identity: text('identity'),
    routerosVersion: text('routeros_version'),
    boardName: text('board_name'),
    architecture: text('architecture'),
    uptimeSeconds: bigint('uptime_seconds', { mode: 'number' }),
    cpu: text('cpu'),
    cpuCount: smallint('cpu_count'),
    cpuLoad: smallint('cpu_load'),
    totalMemory: bigint('total_memory', { mode: 'number' }),
    freeMemory: bigint('free_memory', { mode: 'number' }),
    interfaces: jsonb('interfaces').$type<RouterInterfaceSnapshot[]>(),
    consecutiveFailures: integer('consecutive_failures').notNull().default(0),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
    lastSyncAt: timestamp('last_sync_at', { withTimezone: true }),
    lastError: text('last_error'),
    metadata: jsonb('metadata').$type<Record<string, string>>().notNull().default({}),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (t) => [
    foreignKey({
      name: 'routers_site_fk',
      columns: [t.companyId, t.siteId],
      foreignColumns: [sites.companyId, sites.id],
    }).onDelete('cascade'),
    uniqueIndex('routers_tunnel_ip_key')
      .on(t.tunnelIp)
      .where(sql`${t.deletedAt} is null`),
    index('routers_company_site_idx').on(t.companyId, t.siteId),
    index('routers_poll_idx')
      .on(t.lastSyncAt)
      .where(sql`${t.deletedAt} is null`),
    check('routers_status_check', sql`${t.status} in ('ONLINE', 'DEGRADED', 'OFFLINE')`),
    check('routers_transport_check', sql`${t.transport} in ('REST_HTTPS', 'API')`),
    check(
      'routers_tunnel_ip_check',
      sql`family(${t.tunnelIp}) = 4 and masklen(${t.tunnelIp}) = 32`,
    ),
    check(
      'routers_tls_fingerprint_check',
      sql`${t.tlsFingerprint} is null or ${t.tlsFingerprint} ~ '^[0-9a-f]{64}$'`,
    ),
    // Le REST n'est jamais utilisé sans épinglage du certificat.
    check(
      'routers_rest_pinned_check',
      sql`${t.transport} <> 'REST_HTTPS' or ${t.tlsFingerprint} is not null`,
    ),
    check('routers_password_format_check', sql`${t.routerosPasswordEncrypted} like 'v2:%'`),
    check('routers_cpu_load_check', sql`${t.cpuLoad} is null or ${t.cpuLoad} between 0 and 100`),
    check('routers_failures_check', sql`${t.consecutiveFailures} >= 0`),
  ],
);
