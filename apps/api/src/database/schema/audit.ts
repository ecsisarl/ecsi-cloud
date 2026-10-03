import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { bytea, id } from './columns.js';

/**
 * Journal d'audit (Sprint 2). Table en ajout seul :
 *  - aucun compte applicatif n'a UPDATE, DELETE ni TRUNCATE ; un déclencheur refuse toute
 *    modification ou suppression, même pour le propriétaire ;
 *  - chaque événement est chaîné au précédent de sa chaîne (une par entreprise, plus la
 *    chaîne « platform ») par un hachage SHA-256 calculé en base (déclencheur) :
 *    toute altération directe en base est détectable (app.audit_verify_chain).
 *
 * Pas de clé étrangère vers les acteurs ou les entreprises : le journal survit aux
 * suppressions et reste la trace de ce qui a existé.
 */
export const auditEvents = pgTable(
  'audit_events',
  {
    id: id(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
    /** Entreprise concernée (NULL : événement de la plateforme ou sans entreprise connue). */
    companyId: uuid('company_id'),
    /** company_id, ou « platform » : renseigné par le déclencheur. */
    chainKey: text('chain_key').notNull(),
    chainSeq: bigint('chain_seq', { mode: 'number' }).notNull(),
    actorType: text('actor_type').notNull(),
    actorId: uuid('actor_id'),
    /** Libellé lisible de l'acteur au moment de l'action (nom et adresse e-mail). */
    actorLabel: text('actor_label'),
    actorRoles: text('actor_roles')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    action: text('action').notNull(),
    resourceType: text('resource_type').notNull(),
    resourceId: text('resource_id'),
    siteId: uuid('site_id'),
    result: text('result').notNull(),
    ip: text('ip'),
    userAgent: text('user_agent'),
    requestId: text('request_id'),
    /** Avant/après et précisions, nettoyés de tout secret avant écriture. */
    details: jsonb('details').$type<Record<string, unknown>>().notNull().default({}),
    prevHash: bytea('prev_hash'),
    hash: bytea('hash').notNull(),
  },
  (t) => [
    uniqueIndex('audit_events_chain_key').on(t.chainKey, t.chainSeq),
    index('audit_events_company_time_idx').on(t.companyId, t.occurredAt.desc(), t.id.desc()),
    index('audit_events_chain_time_idx').on(t.chainKey, t.occurredAt.desc()),
    index('audit_events_actor_idx').on(t.companyId, t.actorId),
    index('audit_events_resource_idx').on(t.companyId, t.resourceType, t.resourceId),
    index('audit_events_site_idx').on(t.companyId, t.siteId),
    check(
      'audit_events_actor_type_check',
      sql`${t.actorType} in ('USER', 'PLATFORM_ADMIN', 'SYSTEM', 'ANONYMOUS')`,
    ),
    check('audit_events_result_check', sql`${t.result} in ('SUCCESS', 'FAILURE', 'DENIED')`),
    check('audit_events_action_check', sql`${t.action} ~ '^[a-z0-9_]+(\\.[a-z0-9_]+)+$'`),
  ],
);
