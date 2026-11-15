import type {
  PlanStatus,
  VoucherAuthMode,
  VoucherCharset,
  VoucherScope,
  VoucherState,
} from '@ecsi/shared';
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
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
import { sites } from './sites.js';
import { companies } from './tenancy.js';

/**
 * Forfaits (Sprint 6) : ce que le client achète. Montants en unités mineures (entiers).
 * Les limites (temps, validité, débit, quota, appareils, MAC) seront appliquées par le
 * RADIUS central (Sprint 5, fonction radius.authorize) et non recopiées sur les routeurs.
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
    priceAmount: bigint('price_amount', { mode: 'number' }).notNull(),
    currency: text('currency').notNull().default('XOF'),
    sessionTimeSeconds: integer('session_time_seconds'),
    validitySeconds: integer('validity_seconds'),
    rateDownKbps: integer('rate_down_kbps'),
    rateUpKbps: integer('rate_up_kbps'),
    dataQuotaBytes: bigint('data_quota_bytes', { mode: 'number' }),
    maxDevices: smallint('max_devices').notNull().default(1),
    macBinding: boolean('mac_binding').notNull().default(false),
    defaultScope: text('default_scope').$type<VoucherScope>().notNull().default('LOCAL'),
    sortOrder: integer('sort_order').notNull().default(0),
    isPublic: boolean('is_public').notNull().default(false),
    status: text('status').$type<PlanStatus>().notNull().default('ACTIVE'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (t) => [
    unique('plans_company_id_key').on(t.companyId, t.id),
    uniqueIndex('plans_company_name_key')
      .on(t.companyId, t.name)
      .where(sql`${t.deletedAt} is null`),
    check('plans_price_check', sql`${t.priceAmount} >= 0`),
    check('plans_currency_check', sql`${t.currency} ~ '^[A-Z]{3}$'`),
    check(
      'plans_limits_check',
      sql`coalesce(${t.sessionTimeSeconds}, 1) > 0 and coalesce(${t.validitySeconds}, 1) > 0
        and coalesce(${t.rateDownKbps}, 1) > 0 and coalesce(${t.rateUpKbps}, 1) > 0
        and coalesce(${t.dataQuotaBytes}, 1) > 0 and ${t.maxDevices} between 1 and 20`,
    ),
    check('plans_scope_check', sql`${t.defaultScope} in ('LOCAL', 'GROUP', 'GLOBAL')`),
    check('plans_status_check', sql`${t.status} in ('ACTIVE', 'INACTIVE')`),
  ],
);

/**
 * Lots de tickets : une génération (Mikhmon : un « comment » de génération). Le prix est
 * FIGÉ à la génération ; le format des codes est conservé pour l'historique.
 */
export const voucherBatches = pgTable(
  'voucher_batches',
  {
    id: id(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    /** Numéro lisible du lot, séquentiel dans l'entreprise (« Lot n° 12 »). */
    number: integer('number').notNull(),
    planId: uuid('plan_id').notNull(),
    siteId: uuid('site_id').notNull(),
    label: text('label'),
    quantity: integer('quantity').notNull(),
    authMode: text('auth_mode').$type<VoucherAuthMode>().notNull(),
    charset: text('charset').$type<VoucherCharset>().notNull(),
    codeLength: smallint('code_length').notNull(),
    prefix: text('prefix').notNull().default(''),
    scopeType: text('scope_type').$type<VoucherScope>().notNull().default('LOCAL'),
    unitPrice: bigint('unit_price', { mode: 'number' }).notNull(),
    currency: text('currency').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [
    unique('voucher_batches_company_id_key').on(t.companyId, t.id),
    unique('voucher_batches_company_number_key').on(t.companyId, t.number),
    foreignKey({
      name: 'voucher_batches_plan_fk',
      columns: [t.companyId, t.planId],
      foreignColumns: [plans.companyId, plans.id],
    }),
    foreignKey({
      name: 'voucher_batches_site_fk',
      columns: [t.companyId, t.siteId],
      foreignColumns: [sites.companyId, sites.id],
    }),
    index('voucher_batches_company_created_idx').on(t.companyId, t.createdAt),
    check('voucher_batches_quantity_check', sql`${t.quantity} between 1 and 1000`),
    check('voucher_batches_auth_mode_check', sql`${t.authMode} in ('CODE', 'USER_PASS')`),
    check(
      'voucher_batches_charset_check',
      sql`${t.charset} in ('DIGITS', 'UPPER', 'LOWER', 'UPPER_DIGITS', 'MIXED')`,
    ),
    check('voucher_batches_length_check', sql`${t.codeLength} between 4 and 16`),
    check('voucher_batches_scope_check', sql`${t.scopeType} in ('LOCAL', 'GROUP', 'GLOBAL')`),
  ],
);

/**
 * Tickets. Le code (et le mot de passe en mode USER_PASS) est un titre au porteur stocké
 * en clair, comme l'exige l'authentification CHAP du Hotspot côté RADIUS (dossier v0.1,
 * note « stockage des codes ») : il n'est jamais renvoyé en masse par l'API hors
 * impression autorisée et auditée.
 */
export const vouchers = pgTable(
  'vouchers',
  {
    id: id(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    batchId: uuid('batch_id').notNull(),
    planId: uuid('plan_id').notNull(),
    siteId: uuid('site_id').notNull(),
    serial: integer('serial').notNull(),
    code: text('code').notNull(),
    password: text('password'),
    state: text('state').$type<VoucherState>().notNull().default('AVAILABLE'),
    soldAt: timestamp('sold_at', { withTimezone: true }),
    activatedAt: timestamp('activated_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    disabledAt: timestamp('disabled_at', { withTimezone: true }),
    disabledBy: uuid('disabled_by').references(() => users.id, { onDelete: 'set null' }),
    disabledReason: text('disabled_reason'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('vouchers_company_id_key').on(t.companyId, t.id),
    // Un code est unique dans l'entreprise : c'est l'identifiant RADIUS du client WiFi.
    unique('vouchers_company_code_key').on(t.companyId, t.code),
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
    }),
    index('vouchers_company_state_idx').on(t.companyId, t.state),
    index('vouchers_batch_idx').on(t.batchId, t.serial),
    check(
      'vouchers_state_check',
      sql`${t.state} in ('AVAILABLE', 'ASSIGNED', 'SOLD', 'ACTIVE', 'EXPIRED', 'DISABLED')`,
    ),
    check('vouchers_code_check', sql`${t.code} ~ '^[A-Za-z2-9]{4,24}$'`),
    check(
      'vouchers_disabled_check',
      sql`(${t.state} = 'DISABLED') = (${t.disabledAt} is not null)`,
    ),
  ],
);

/** Historique complet du cycle de vie d'un ticket (ajout seul). */
export const voucherEvents = pgTable(
  'voucher_events',
  {
    id: id(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    voucherId: uuid('voucher_id').notNull(),
    fromState: text('from_state').$type<VoucherState>(),
    toState: text('to_state').$type<VoucherState>().notNull(),
    actorUserId: uuid('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
    actorType: text('actor_type').notNull().default('USER'),
    reason: text('reason'),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: 'voucher_events_voucher_fk',
      columns: [t.companyId, t.voucherId],
      foreignColumns: [vouchers.companyId, vouchers.id],
    }).onDelete('cascade'),
    index('voucher_events_voucher_idx').on(t.voucherId, t.occurredAt),
    check('voucher_events_actor_check', sql`${t.actorType} in ('USER', 'SYSTEM', 'RADIUS')`),
  ],
);
