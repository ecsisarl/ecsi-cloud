import { sql } from 'drizzle-orm';
import {
  check,
  doublePrecision,
  foreignKey,
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { citext, createdAt, deletedAt, id, updatedAt } from './columns.js';
import { companies } from './tenancy.js';

/**
 * Sites WiFi : emplacements d'exploitation d'une entreprise.
 *
 * Relations futures (non créées au Sprint 2) : routeurs MikroTik, hotspots, vendeurs,
 * forfaits, tickets, ventes et supervision référenceront un site par la clé composite
 * (company_id, site_id) -> sites (company_id, id), qui garantit qu'un objet ne peut jamais
 * être rattaché au site d'une autre entreprise.
 */
export const sites = pgTable(
  'sites',
  {
    id: id(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** Code interne, unique dans l'entreprise parmi les sites non supprimés. */
    code: citext('code').notNull(),
    description: text('description'),
    address: text('address'),
    city: text('city'),
    country: text('country').notNull(),
    latitude: doublePrecision('latitude'),
    longitude: doublePrecision('longitude'),
    timezone: text('timezone').notNull(),
    phone: text('phone'),
    contactName: text('contact_name'),
    status: text('status').notNull().default('ACTIVE'),
    metadata: jsonb('metadata').$type<Record<string, string>>().notNull().default({}),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (t) => [
    unique('sites_company_id_key').on(t.companyId, t.id),
    uniqueIndex('sites_company_code_key')
      .on(t.companyId, t.code)
      .where(sql`${t.deletedAt} is null`),
    index('sites_company_name_idx').on(t.companyId, t.name),
    check('sites_status_check', sql`${t.status} in ('ACTIVE', 'MAINTENANCE', 'INACTIVE')`),
    check('sites_country_check', sql`${t.country} ~ '^[A-Z]{2}$'`),
    check(
      'sites_coordinates_check',
      sql`(${t.latitude} is null) = (${t.longitude} is null)
        and (${t.latitude} is null or ${t.latitude} between -90 and 90)
        and (${t.longitude} is null or ${t.longitude} between -180 and 180)`,
    ),
  ],
);

/**
 * Groupes de sites (ECSI Roaming, portée GROUPE des tickets au Sprint 11). Un site peut
 * appartenir à plusieurs groupes.
 */
export const siteGroups = pgTable(
  'site_groups',
  {
    id: id(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    code: citext('code').notNull(),
    description: text('description'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('site_groups_company_id_key').on(t.companyId, t.id),
    unique('site_groups_company_code_key').on(t.companyId, t.code),
  ],
);

export const siteGroupMembers = pgTable(
  'site_group_members',
  {
    companyId: uuid('company_id').notNull(),
    groupId: uuid('group_id').notNull(),
    siteId: uuid('site_id').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.groupId, t.siteId] }),
    // Clés composites : un groupe et ses sites appartiennent toujours à la même entreprise.
    foreignKey({
      name: 'site_group_members_group_fk',
      columns: [t.companyId, t.groupId],
      foreignColumns: [siteGroups.companyId, siteGroups.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'site_group_members_site_fk',
      columns: [t.companyId, t.siteId],
      foreignColumns: [sites.companyId, sites.id],
    }).onDelete('cascade'),
    index('site_group_members_site_idx').on(t.companyId, t.siteId),
  ],
);
