/**
 * Applique les migrations SQL versionnées (src/database/migrations) avec le rôle
 * propriétaire du schéma (DATABASE_MIGRATOR_URL). Idempotent : une migration déjà
 * appliquée n'est jamais rejouée. Synchronise ensuite le catalogue des permissions et les
 * rôles système des entreprises (src/database/catalog.ts). Exécuté par le service `migrate` de docker-compose
 * et par `pnpm db:migrate`.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { syncCatalog } from './catalog.js';

export const MIGRATIONS_FOLDER = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

export async function runMigrations(connectionString: string): Promise<void> {
  const pool = new pg.Pool({ connectionString, max: 1, application_name: 'ecsi-migrate' });
  try {
    const db = drizzle(pool, { casing: 'snake_case' });
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
    await db.transaction((tx) => syncCatalog(tx));
  } finally {
    await pool.end();
  }
}

const isEntrypoint = process.argv[1] === fileURLToPath(import.meta.url);
if (isEntrypoint) {
  const url = process.env.DATABASE_MIGRATOR_URL;
  if (!url) {
    process.stderr.write('DATABASE_MIGRATOR_URL est requis pour appliquer les migrations.\n');
    process.exit(1);
  }
  runMigrations(url)
    .then(() => {
      process.stdout.write('Migrations appliquées.\n');
    })
    .catch((error: unknown) => {
      process.stderr.write(
        `Échec des migrations : ${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exit(1);
    });
}
