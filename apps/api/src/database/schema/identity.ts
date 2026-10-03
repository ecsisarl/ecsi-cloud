import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { bytea, citext, createdAt, deletedAt, id, updatedAt } from './columns.js';
import { companies } from './tenancy.js';

/** Identité globale d'une personne (peut appartenir à plusieurs entreprises). */
export const users = pgTable(
  'users',
  {
    id: id(),
    email: citext('email').notNull().unique(),
    fullName: text('full_name').notNull(),
    locale: text('locale').notNull().default('fr'),
    status: text('status').notNull().default('ACTIVE'),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (t) => [check('users_status_check', sql`${t.status} in ('ACTIVE', 'DISABLED')`)],
);

/** Empreinte Argon2id du mot de passe. Table réservée au rôle ecsi_auth. */
export const userCredentials = pgTable('user_credentials', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  passwordHash: text('password_hash').notNull(),
  passwordChangedAt: timestamp('password_changed_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/**
 * Super administrateurs ECSI : table distincte des utilisateurs des entreprises.
 * Aucune route de l'API ne crée de super administrateur (création par commande d'exploitation uniquement).
 */
export const platformAdmins = pgTable(
  'platform_admins',
  {
    id: id(),
    email: citext('email').notNull().unique(),
    fullName: text('full_name').notNull(),
    passwordHash: text('password_hash').notNull(),
    status: text('status').notNull().default('ACTIVE'),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [check('platform_admins_status_check', sql`${t.status} in ('ACTIVE', 'DISABLED')`)],
);

/** Exactement un des deux propriétaires (utilisateur d'entreprise ou super administrateur). */
const onePrincipal = (userId: unknown, adminId: unknown) =>
  sql`(${userId} is null) <> (${adminId} is null)`;

export const mfaFactors = pgTable(
  'mfa_factors',
  {
    id: id(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    platformAdminId: uuid('platform_admin_id').references(() => platformAdmins.id, {
      onDelete: 'cascade',
    }),
    /** Secret TOTP chiffré (AES-256-GCM), jamais en clair. */
    secretEnc: text('secret_enc').notNull(),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
    /** Dernier pas de temps TOTP accepté : empêche le rejeu d'un code. */
    lastUsedStep: bigint('last_used_step', { mode: 'number' }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('mfa_factors_user_key')
      .on(t.userId)
      .where(sql`${t.userId} is not null`),
    uniqueIndex('mfa_factors_admin_key')
      .on(t.platformAdminId)
      .where(sql`${t.platformAdminId} is not null`),
    check('mfa_factors_principal_check', onePrincipal(t.userId, t.platformAdminId)),
  ],
);

export const mfaRecoveryCodes = pgTable(
  'mfa_recovery_codes',
  {
    id: id(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    platformAdminId: uuid('platform_admin_id').references(() => platformAdmins.id, {
      onDelete: 'cascade',
    }),
    codeHash: text('code_hash').notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    index('mfa_recovery_codes_user_idx').on(t.userId),
    index('mfa_recovery_codes_admin_idx').on(t.platformAdminId),
    check('mfa_recovery_codes_principal_check', onePrincipal(t.userId, t.platformAdminId)),
  ],
);

/** Session de connexion = famille de refresh tokens. */
export const authSessions = pgTable(
  'auth_sessions',
  {
    id: id(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    platformAdminId: uuid('platform_admin_id').references(() => platformAdmins.id, {
      onDelete: 'cascade',
    }),
    companyId: uuid('company_id').references(() => companies.id, { onDelete: 'cascade' }),
    mfaState: text('mfa_state').notNull(),
    ip: text('ip'),
    userAgent: text('user_agent'),
    createdAt: createdAt(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedReason: text('revoked_reason'),
  },
  (t) => [
    index('auth_sessions_user_idx').on(t.userId),
    index('auth_sessions_admin_idx').on(t.platformAdminId),
    check('auth_sessions_principal_check', onePrincipal(t.userId, t.platformAdminId)),
    check(
      'auth_sessions_mfa_state_check',
      sql`${t.mfaState} in ('NOT_REQUIRED', 'VERIFIED', 'SETUP_REQUIRED')`,
    ),
  ],
);

export const refreshTokens = pgTable(
  'refresh_tokens',
  {
    id: id(),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => authSessions.id, { onDelete: 'cascade' }),
    tokenHash: bytea('token_hash').notNull().unique(),
    createdAt: createdAt(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
  },
  (t) => [index('refresh_tokens_session_idx').on(t.sessionId)],
);

export const passwordResetTokens = pgTable(
  'password_reset_tokens',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: bytea('token_hash').notNull().unique(),
    createdAt: createdAt(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
  },
  (t) => [index('password_reset_tokens_user_idx').on(t.userId)],
);
