import { sql } from 'drizzle-orm';
import { customType, timestamp, uuid } from 'drizzle-orm/pg-core';

/** Texte insensible à la casse (extension citext) : adresses e-mail, slugs. */
export const citext = customType<{ data: string }>({
  dataType: () => 'citext',
});

/** Octets bruts : empreintes SHA-256 des jetons (jamais le jeton lui-même). */
export const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => 'bytea',
});

/** Clé primaire UUID v7 générée par PostgreSQL 18 (triable dans le temps). */
export const id = () =>
  uuid('id')
    .primaryKey()
    .default(sql`uuidv7()`);

export const createdAt = () =>
  timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
export const updatedAt = () =>
  timestamp('updated_at', { withTimezone: true }).notNull().defaultNow();
export const deletedAt = () => timestamp('deleted_at', { withTimezone: true });
