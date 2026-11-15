import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  foreignKey,
  index,
  inet,
  integer,
  pgTable,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { createdAt, deletedAt, id, updatedAt } from './columns.js';
import { users } from './identity.js';
import { routers } from './routers.js';
import { sites } from './sites.js';
import { companies } from './tenancy.js';

/**
 * Lot B (Hotspot, FreeRADIUS, forfaits, tickets). Conventions : docs/DATABASE.md ; décisions
 * et limites : docs/RADIUS.md.
 *
 * Aucun secret n'est stocké ici : un ticket est retrouvé par l'empreinte HMAC de son code
 * (clé RADIUS_VOUCHER_LOOKUP_KEY, connue de l'API et de FreeRADIUS) ; le code imprimable est
 * dérivé par l'API d'une autre clé (VOUCHER_CODE_KEY) ; le secret RADIUS d'un routeur est
 * dérivé de RADIUS_NAS_KEY. La base ne contient donc ni code ni secret réutilisable.
 */

export const PLAN_STATUSES = ['ACTIVE', 'DISABLED'] as const;
export type PlanStatus = (typeof PLAN_STATUSES)[number];

/**
 * Forfait : prix et limites appliquées par RADIUS/RouterOS. Au moins une limite parmi la
 * validité calendaire, le temps de connexion et le volume de données.
 */
export const plans = pgTable(
  'plans',
  {
    id: id(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description'),
    /** Montant en unités mineures de la devise (money.ts). */
    priceMinor: bigint('price_minor', { mode: 'number' }).notNull(),
    currency: text('currency').notNull(),
    /** Validité calendaire à partir de la première connexion acceptée (null : aucune). */
    validitySeconds: integer('validity_seconds'),
    /** Temps de connexion cumulé autorisé (null : illimité). */
    sessionTimeSeconds: integer('session_time_seconds'),
    /** Débit montant (envoi du client), en kbit/s (null : non limité). */
    rateUpKbps: integer('rate_up_kbps'),
    /** Débit descendant (réception du client), en kbit/s (null : non limité). */
    rateDownKbps: integer('rate_down_kbps'),
    /** Volume cumulé montant + descendant, en octets (null : illimité). */
    dataQuotaBytes: bigint('data_quota_bytes', { mode: 'number' }),
    maxDevices: smallint('max_devices').notNull().default(1),
    idleTimeoutSeconds: integer('idle_timeout_seconds').notNull().default(300),
    status: text('status').$type<PlanStatus>().notNull().default('ACTIVE'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (t) => [
    unique('plans_company_id_key').on(t.companyId, t.id),
    uniqueIndex('plans_company_name_key')
      .on(t.companyId, sql`lower(${t.name})`)
      .where(sql`${t.deletedAt} is null`),
    check('plans_status_check', sql`${t.status} in ('ACTIVE', 'DISABLED')`),
    check('plans_name_check', sql`char_length(${t.name}) between 1 and 80`),
    check('plans_price_check', sql`${t.priceMinor} >= 0`),
    check('plans_currency_check', sql`${t.currency} ~ '^[A-Z]{3}$'`),
    check(
      'plans_limits_check',
      sql`${t.validitySeconds} is not null or ${t.sessionTimeSeconds} is not null or ${t.dataQuotaBytes} is not null`,
    ),
    check(
      'plans_values_check',
      sql`(${t.validitySeconds} is null or ${t.validitySeconds} between 60 and 31622400)
        and (${t.sessionTimeSeconds} is null or ${t.sessionTimeSeconds} between 60 and 31622400)
        and (${t.rateUpKbps} is null or ${t.rateUpKbps} between 8 and 10000000)
        and (${t.rateDownKbps} is null or ${t.rateDownKbps} between 8 and 10000000)
        and (${t.dataQuotaBytes} is null or ${t.dataQuotaBytes} between 1048576 and 109951162777600)
        and ${t.maxDevices} between 1 and 10
        and ${t.idleTimeoutSeconds} between 60 and 86400`,
    ),
  ],
);

/** Lot de tickets généré en une fois pour un forfait et un site d'émission (portée LOCAL). */
export const voucherBatches = pgTable(
  'voucher_batches',
  {
    id: id(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    planId: uuid('plan_id').notNull(),
    siteId: uuid('site_id').notNull(),
    quantity: integer('quantity').notNull(),
    scopeType: text('scope_type').notNull().default('LOCAL'),
    label: text('label'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [
    unique('voucher_batches_company_id_key').on(t.companyId, t.id),
    foreignKey({
      name: 'voucher_batches_plan_fk',
      columns: [t.companyId, t.planId],
      foreignColumns: [plans.companyId, plans.id],
    }),
    foreignKey({
      name: 'voucher_batches_site_fk',
      columns: [t.companyId, t.siteId],
      foreignColumns: [sites.companyId, sites.id],
    }).onDelete('cascade'),
    index('voucher_batches_company_created_idx').on(t.companyId, t.createdAt),
    check('voucher_batches_quantity_check', sql`${t.quantity} between 1 and 1000`),
    // Portée GROUPE / GLOBAL : modèle prévu (dossier §8), refusée tant qu'elle n'est pas
    // validée sur plusieurs routeurs réels (MVP commercial).
    check('voucher_batches_scope_check', sql`${t.scopeType} = 'LOCAL'`),
    check(
      'voucher_batches_label_check',
      sql`${t.label} is null or char_length(${t.label}) between 1 and 80`,
    ),
  ],
);

export const VOUCHER_STATES = ['AVAILABLE', 'ACTIVE', 'EXHAUSTED', 'EXPIRED', 'DISABLED'] as const;
export type VoucherState = (typeof VOUCHER_STATES)[number];

/**
 * Ticket. Les limites du forfait sont COPIÉES à la génération : modifier un forfait ne change
 * pas les tickets déjà émis (vendus). La consommation est tenue par l'accounting RADIUS.
 */
export const vouchers = pgTable(
  'vouchers',
  {
    id: id(),
    companyId: uuid('company_id').notNull(),
    batchId: uuid('batch_id').notNull(),
    planId: uuid('plan_id').notNull(),
    siteId: uuid('site_id').notNull(),
    /** Numéro dans le lot (1..quantité) : référence non secrète pour le support. */
    serial: integer('serial').notNull(),
    /** HMAC-SHA1 hexadécimal du code en minuscules : seule trace du code en base. */
    codeLookup: text('code_lookup').notNull(),
    /** Version de RADIUS_VOUCHER_LOOKUP_KEY ayant produit code_lookup (rotation). */
    lookupKeyVersion: smallint('lookup_key_version').notNull().default(1),
    /** Version de VOUCHER_CODE_KEY qui dérive le code imprimable (réimpression). */
    codeKeyVersion: smallint('code_key_version').notNull().default(1),
    state: text('state').$type<VoucherState>().notNull().default('AVAILABLE'),
    priceMinor: bigint('price_minor', { mode: 'number' }).notNull(),
    currency: text('currency').notNull(),
    validitySeconds: integer('validity_seconds'),
    sessionTimeSeconds: integer('session_time_seconds'),
    rateUpKbps: integer('rate_up_kbps'),
    rateDownKbps: integer('rate_down_kbps'),
    dataQuotaBytes: bigint('data_quota_bytes', { mode: 'number' }),
    maxDevices: smallint('max_devices').notNull(),
    idleTimeoutSeconds: integer('idle_timeout_seconds').notNull(),
    /** Première connexion acceptée : début de la validité calendaire. */
    activatedAt: timestamp('activated_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    usedSeconds: bigint('used_seconds', { mode: 'number' }).notNull().default(0),
    usedBytes: bigint('used_bytes', { mode: 'number' }).notNull().default(0),
    disabledAt: timestamp('disabled_at', { withTimezone: true }),
    disabledBy: uuid('disabled_by').references(() => users.id, { onDelete: 'set null' }),
    disabledReason: text('disabled_reason'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('vouchers_company_id_key').on(t.companyId, t.id),
    unique('vouchers_company_lookup_key').on(t.companyId, t.codeLookup),
    unique('vouchers_batch_serial_key').on(t.batchId, t.serial),
    foreignKey({
      name: 'vouchers_batch_fk',
      columns: [t.companyId, t.batchId],
      foreignColumns: [voucherBatches.companyId, voucherBatches.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'vouchers_plan_fk',
      columns: [t.companyId, t.planId],
      foreignColumns: [plans.companyId, plans.id],
    }),
    foreignKey({
      name: 'vouchers_site_fk',
      columns: [t.companyId, t.siteId],
      foreignColumns: [sites.companyId, sites.id],
    }).onDelete('cascade'),
    index('vouchers_company_state_idx').on(t.companyId, t.state),
    index('vouchers_company_site_idx').on(t.companyId, t.siteId),
    index('vouchers_expires_at_idx')
      .on(t.expiresAt)
      .where(sql`${t.state} = 'ACTIVE'`),
    check(
      'vouchers_state_check',
      sql`${t.state} in ('AVAILABLE', 'ACTIVE', 'EXHAUSTED', 'EXPIRED', 'DISABLED')`,
    ),
    check('vouchers_lookup_check', sql`${t.codeLookup} ~ '^[0-9a-f]{40}$'`),
    check(
      'vouchers_key_versions_check',
      sql`${t.lookupKeyVersion} between 1 and 999 and ${t.codeKeyVersion} between 1 and 999`,
    ),
    check('vouchers_serial_check', sql`${t.serial} between 1 and 1000`),
    check('vouchers_usage_check', sql`${t.usedSeconds} >= 0 and ${t.usedBytes} >= 0`),
    check(
      'vouchers_disabled_check',
      sql`(${t.state} = 'DISABLED') = (${t.disabledAt} is not null)`,
    ),
    check(
      'vouchers_disabled_reason_check',
      sql`${t.disabledReason} is null or char_length(${t.disabledReason}) <= 200`,
    ),
  ],
);

export const HOTSPOT_DESIRED_STATES = ['ENABLED', 'DISABLED'] as const;
export type HotspotDesiredState = (typeof HOTSPOT_DESIRED_STATES)[number];
export const HOTSPOT_SYNC_STATUSES = ['PENDING', 'APPLYING', 'SYNCED', 'ERROR'] as const;
export type HotspotSyncStatus = (typeof HOTSPOT_SYNC_STATUSES)[number];

/**
 * Hotspot d'un routeur (un seul par routeur dans ce lot). Configuration voulue, appliquée par
 * le worker avec le compte RouterOS d'écriture ecsi-cfg ; le routeur est aussi le NAS RADIUS
 * (identifié par son adresse tunnel, secret dérivé de RADIUS_NAS_KEY et de nas_secret_version).
 */
export const hotspots = pgTable(
  'hotspots',
  {
    id: id(),
    companyId: uuid('company_id').notNull(),
    siteId: uuid('site_id').notNull(),
    routerId: uuid('router_id').notNull(),
    name: text('name').notNull(),
    /** Interface RouterOS côté clients (ex. ether2, bridge-hotspot). */
    interface: text('interface').notNull(),
    /** Adresse du routeur sur le réseau Hotspot, avec masque (ex. 10.5.50.1/24). */
    gatewayAddress: inet('gateway_address').notNull(),
    poolStart: inet('pool_start').notNull(),
    poolEnd: inet('pool_end').notNull(),
    dnsName: text('dns_name'),
    desiredState: text('desired_state').$type<HotspotDesiredState>().notNull().default('ENABLED'),
    syncStatus: text('sync_status').$type<HotspotSyncStatus>().notNull().default('PENDING'),
    configVersion: integer('config_version').notNull().default(1),
    appliedVersion: integer('applied_version'),
    nasSecretVersion: integer('nas_secret_version').notNull().default(1),
    lastSyncAt: timestamp('last_sync_at', { withTimezone: true }),
    lastError: text('last_error'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (t) => [
    unique('hotspots_company_id_key').on(t.companyId, t.id),
    foreignKey({
      name: 'hotspots_router_fk',
      columns: [t.companyId, t.routerId],
      foreignColumns: [routers.companyId, routers.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'hotspots_site_fk',
      columns: [t.companyId, t.siteId],
      foreignColumns: [sites.companyId, sites.id],
    }).onDelete('cascade'),
    uniqueIndex('hotspots_router_key')
      .on(t.routerId)
      .where(sql`${t.deletedAt} is null`),
    check('hotspots_desired_state_check', sql`${t.desiredState} in ('ENABLED', 'DISABLED')`),
    check(
      'hotspots_sync_status_check',
      sql`${t.syncStatus} in ('PENDING', 'APPLYING', 'SYNCED', 'ERROR')`,
    ),
    check('hotspots_name_check', sql`char_length(${t.name}) between 1 and 80`),
    check('hotspots_interface_check', sql`${t.interface} ~ '^[A-Za-z0-9._-]{1,40}$'`),
    check(
      'hotspots_network_check',
      sql`family(${t.gatewayAddress}) = 4 and masklen(${t.gatewayAddress}) between 16 and 30
        and ${t.poolStart} << network(${t.gatewayAddress}) and ${t.poolEnd} << network(${t.gatewayAddress})
        and ${t.poolStart} <= ${t.poolEnd}
        and not (host(${t.gatewayAddress})::inet between ${t.poolStart} and ${t.poolEnd})`,
    ),
    check(
      'hotspots_dns_name_check',
      sql`${t.dnsName} is null or ${t.dnsName} ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$'`,
    ),
    check('hotspots_versions_check', sql`${t.configVersion} >= 1 and ${t.nasSecretVersion} >= 1`),
  ],
);

/**
 * Session RADIUS (accounting Start / Interim-Update / Stop) écrite par FreeRADIUS au travers
 * des fonctions radius.* (rôle ecsi_radius). Lecture seule pour l'API.
 */
export const radiusSessions = pgTable(
  'radius_sessions',
  {
    id: id(),
    companyId: uuid('company_id').notNull(),
    siteId: uuid('site_id').notNull(),
    routerId: uuid('router_id').notNull(),
    voucherId: uuid('voucher_id').notNull(),
    acctSessionId: text('acct_session_id').notNull(),
    acctUniqueId: text('acct_unique_id').notNull(),
    callingStationId: text('calling_station_id'),
    framedIp: inet('framed_ip'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    stoppedAt: timestamp('stopped_at', { withTimezone: true }),
    sessionSeconds: bigint('session_seconds', { mode: 'number' }).notNull().default(0),
    inputBytes: bigint('input_bytes', { mode: 'number' }).notNull().default(0),
    outputBytes: bigint('output_bytes', { mode: 'number' }).notNull().default(0),
    terminateCause: text('terminate_cause'),
  },
  (t) => [
    unique('radius_sessions_company_id_key').on(t.companyId, t.id),
    unique('radius_sessions_unique_id_key').on(t.routerId, t.acctUniqueId),
    foreignKey({
      name: 'radius_sessions_voucher_fk',
      columns: [t.companyId, t.voucherId],
      foreignColumns: [vouchers.companyId, vouchers.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'radius_sessions_router_fk',
      columns: [t.companyId, t.routerId],
      foreignColumns: [routers.companyId, routers.id],
    }).onDelete('cascade'),
    index('radius_sessions_voucher_idx').on(t.voucherId, t.startedAt),
    index('radius_sessions_open_idx')
      .on(t.routerId)
      .where(sql`${t.stoppedAt} is null`),
    index('radius_sessions_company_started_idx').on(t.companyId, t.startedAt),
  ],
);

export const POSTAUTH_RESULTS = ['ACCEPT', 'REJECT'] as const;
export type PostauthResult = (typeof POSTAUTH_RESULTS)[number];

/** Résultat des authentifications (jamais le code saisi). Rétention bornée (worker). */
export const radiusPostauth = pgTable(
  'radius_postauth',
  {
    id: id(),
    companyId: uuid('company_id').references(() => companies.id, { onDelete: 'cascade' }),
    routerId: uuid('router_id'),
    voucherId: uuid('voucher_id'),
    nasIp: inet('nas_ip').notNull(),
    result: text('result').$type<PostauthResult>().notNull(),
    reason: text('reason'),
    callingStationId: text('calling_station_id'),
    createdAt: createdAt(),
  },
  (t) => [
    index('radius_postauth_company_created_idx').on(t.companyId, t.createdAt),
    index('radius_postauth_voucher_idx').on(t.voucherId),
    index('radius_postauth_created_idx').on(t.createdAt),
    check('radius_postauth_result_check', sql`${t.result} in ('ACCEPT', 'REJECT')`),
  ],
);
