import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  foreignKey,
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { bytea, citext, createdAt, deletedAt, id, updatedAt } from './columns.js';
import { users } from './identity.js';
import { sites } from './sites.js';

/**
 * Entreprises (tenants) : profil, préférences régionales et paramètres généraux.
 * Valeurs par défaut ECSI CLOUD : français, XOF, Côte d'Ivoire, Africa/Abidjan.
 * Le statut (ACTIVE / SUSPENDED) n'est modifiable que par un super administrateur.
 */
export const companies = pgTable(
  'companies',
  {
    id: id(),
    /** Nom commercial. */
    name: text('name').notNull(),
    slug: citext('slug').notNull().unique(),
    /** Raison sociale. */
    legalName: text('legal_name'),
    phone: text('phone'),
    whatsapp: text('whatsapp'),
    email: citext('email'),
    address: text('address'),
    city: text('city'),
    country: text('country').notNull().default('CI'),
    currency: text('currency').notNull().default('XOF'),
    locale: text('locale').notNull().default('fr'),
    timezone: text('timezone').notNull().default('Africa/Abidjan'),
    /** Clé de l'objet S3 du logo (fichier privé, servi par l'API). */
    logoObjectKey: text('logo_object_key'),
    logoContentType: text('logo_content_type'),
    settings: jsonb('settings').$type<Record<string, unknown>>().notNull().default({}),
    status: text('status').notNull().default('ACTIVE'),
    suspendedAt: timestamp('suspended_at', { withTimezone: true }),
    suspensionReason: text('suspension_reason'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (t) => [
    check('companies_status_check', sql`${t.status} in ('ACTIVE', 'SUSPENDED')`),
    check('companies_country_check', sql`${t.country} ~ '^[A-Z]{2}$'`),
    check('companies_currency_check', sql`${t.currency} ~ '^[A-Z]{3}$'`),
    check('companies_locale_check', sql`${t.locale} in ('fr', 'en')`),
  ],
);

/** Appartenance d'un utilisateur (identité globale) à une entreprise. */
export const memberships = pgTable(
  'memberships',
  {
    id: id(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    status: text('status').notNull().default('ACTIVE'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('memberships_company_user_key').on(t.companyId, t.userId),
    unique('memberships_company_id_key').on(t.companyId, t.id),
    index('memberships_user_idx').on(t.userId),
    check('memberships_status_check', sql`${t.status} in ('ACTIVE', 'DISABLED')`),
  ],
);

/** Catalogue global des permissions, synchronisé depuis packages/shared à chaque migration. */
export const permissions = pgTable('permissions', {
  code: text('code').primaryKey(),
  module: text('module').notNull(),
  description: text('description').notNull(),
  isDangerous: boolean('is_dangerous').notNull().default(false),
  createdAt: createdAt(),
});

/** Rôles d'une entreprise : modèles système copiés à la création de l'entreprise, puis rôles personnalisés. */
export const roles = pgTable(
  'roles',
  {
    id: id(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    code: text('code').notNull(),
    name: text('name').notNull(),
    isSystem: boolean('is_system').notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('roles_company_code_key').on(t.companyId, t.code),
    unique('roles_company_id_key').on(t.companyId, t.id),
  ],
);

export const rolePermissions = pgTable(
  'role_permissions',
  {
    companyId: uuid('company_id').notNull(),
    roleId: uuid('role_id').notNull(),
    permissionCode: text('permission_code')
      .notNull()
      .references(() => permissions.code, { onDelete: 'cascade' }),
  },
  (t) => [
    primaryKey({ columns: [t.roleId, t.permissionCode] }),
    // Clé composite : un rôle ne peut recevoir de permission que dans sa propre entreprise.
    foreignKey({
      name: 'role_permissions_role_fk',
      columns: [t.companyId, t.roleId],
      foreignColumns: [roles.companyId, roles.id],
    }).onDelete('cascade'),
  ],
);

/** Attribution d'un rôle à un membre, pour toute l'entreprise ou pour certains sites. */
export const membershipRoles = pgTable(
  'membership_roles',
  {
    id: id(),
    companyId: uuid('company_id').notNull(),
    membershipId: uuid('membership_id').notNull(),
    roleId: uuid('role_id').notNull(),
    scope: text('scope').notNull().default('COMPANY'),
    createdAt: createdAt(),
  },
  (t) => [
    unique('membership_roles_membership_role_key').on(t.membershipId, t.roleId),
    unique('membership_roles_company_id_key').on(t.companyId, t.id),
    foreignKey({
      name: 'membership_roles_membership_fk',
      columns: [t.companyId, t.membershipId],
      foreignColumns: [memberships.companyId, memberships.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'membership_roles_role_fk',
      columns: [t.companyId, t.roleId],
      foreignColumns: [roles.companyId, roles.id],
    }).onDelete('cascade'),
    check('membership_roles_scope_check', sql`${t.scope} in ('COMPANY', 'SITES')`),
  ],
);

/** Sites couverts par une attribution de portée SITES (clé composite : même entreprise). */
export const membershipRoleSites = pgTable(
  'membership_role_sites',
  {
    companyId: uuid('company_id').notNull(),
    membershipRoleId: uuid('membership_role_id').notNull(),
    siteId: uuid('site_id').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.membershipRoleId, t.siteId] }),
    foreignKey({
      name: 'membership_role_sites_membership_role_fk',
      columns: [t.companyId, t.membershipRoleId],
      foreignColumns: [membershipRoles.companyId, membershipRoles.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'membership_role_sites_site_fk',
      columns: [t.companyId, t.siteId],
      foreignColumns: [sites.companyId, sites.id],
    }).onDelete('cascade'),
    index('membership_role_sites_site_idx').on(t.companyId, t.siteId),
  ],
);

export const invitations = pgTable(
  'invitations',
  {
    id: id(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    email: citext('email').notNull(),
    tokenHash: bytea('token_hash').notNull().unique(),
    invitedByUserId: uuid('invited_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    status: text('status').notNull().default('PENDING'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    acceptedUserId: uuid('accepted_user_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [
    unique('invitations_company_id_key').on(t.companyId, t.id),
    uniqueIndex('invitations_pending_email_key')
      .on(t.companyId, t.email)
      .where(sql`${t.status} = 'PENDING'`),
    check('invitations_status_check', sql`${t.status} in ('PENDING', 'ACCEPTED', 'REVOKED')`),
  ],
);

export const invitationRoles = pgTable(
  'invitation_roles',
  {
    companyId: uuid('company_id').notNull(),
    invitationId: uuid('invitation_id').notNull(),
    roleId: uuid('role_id').notNull(),
    scope: text('scope').notNull().default('COMPANY'),
    siteIds: uuid('site_ids')
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
  },
  (t) => [
    primaryKey({ columns: [t.invitationId, t.roleId] }),
    foreignKey({
      name: 'invitation_roles_invitation_fk',
      columns: [t.companyId, t.invitationId],
      foreignColumns: [invitations.companyId, invitations.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'invitation_roles_role_fk',
      columns: [t.companyId, t.roleId],
      foreignColumns: [roles.companyId, roles.id],
    }).onDelete('cascade'),
    check('invitation_roles_scope_check', sql`${t.scope} in ('COMPANY', 'SITES')`),
  ],
);
