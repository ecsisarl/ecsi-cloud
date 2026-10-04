/**
 * Sprint 3B — la migration 0006 est ADDITIVE : appliquée sur une installation S3A existante
 * (migrations 0000 à 0005 et un routeur CHR-LAB enregistré à la main, comme sur le VPS OVH),
 * elle conserve le routeur, son mot de passe chiffré (clé k2) et sa supervision. PostgreSQL
 * 18 réel, rôles réels.
 */
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SecretBox } from '../src/auth/crypto/secret-box.js';
import { syncCatalog } from '../src/database/catalog.js';
import { MIGRATIONS_FOLDER, runMigrations } from '../src/database/migrate.js';
import { seedDevData } from '../src/database/seed.js';
import { decryptRouterPassword, encryptRouterPassword } from '../src/routers/router-secret.js';
import { SEED_PASSWORD } from './helpers/app.js';
import { startInfra, type TestInfra } from './helpers/infra.js';

let infra: TestInfra;
let migrator: pg.Pool;
let folder: string;
const box = new SecretBox(Buffer.alloc(32, 7).toString('base64'), { id: 'k2' });
const CHR_ID = '0199b000-0000-7000-8000-00000000c4a1';

beforeAll(async () => {
  infra = await startInfra();
  // Installation S3A : journal limité aux migrations 0000 à 0005.
  folder = mkdtempSync(join(tmpdir(), 'ecsi-s3a-'));
  cpSync(MIGRATIONS_FOLDER, folder, { recursive: true });
  const journalPath = join(folder, 'meta', '_journal.json');
  const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: { tag: string }[] };
  journal.entries = journal.entries.filter((e) => !e.tag.startsWith('0006'));
  writeFileSync(journalPath, JSON.stringify(journal));
  migrator = new pg.Pool({ connectionString: infra.urls.migrator, max: 1 });
  const db = drizzle(migrator, { casing: 'snake_case' });
  await migrate(db, { migrationsFolder: folder });
  await db.transaction((tx) => syncCatalog(tx));
}, 180_000);

afterAll(async () => {
  rmSync(folder, { recursive: true, force: true });
  await migrator.end();
  await infra.stop();
});

describe('migration 0006 sur une installation S3A existante', () => {
  it('conserve CHR-LAB, son chiffré k2 et sa supervision ; le worker continue de le voir', async () => {
    const seed = await seedDevData(drizzle(migrator, { casing: 'snake_case' }), SEED_PASSWORD);
    const companyId = seed.companies.A;
    const secret = encryptRouterPassword(box, { companyId, routerId: CHR_ID }, 'Chr-Lab-Pass-0001');
    await migrator.query(
      `insert into routers (id, company_id, site_id, name, tunnel_ip, transport, routeros_username,
         routeros_password_encrypted, status, identity, routeros_version, last_seen_at)
       values ($1, $2, $3, 'CHR-LAB', '10.200.0.2', 'API', 'ecsi-cloud', $4, 'ONLINE', 'CHR-LAB',
         '7.23.7 (long-term)', now())`,
      [CHR_ID, companyId, seed.sites.A['SITE-A'], secret],
    );
    const before =
      (
        await migrator.query<Record<string, unknown>>('select * from routers where id = $1', [
          CHR_ID,
        ])
      ).rows[0] ?? {};

    await runMigrations(infra.urls.migrator); // applique 0006 (et rien d'autre)

    const migrations = await migrator.query(
      'select count(*)::int as n from drizzle.__drizzle_migrations',
    );
    expect(migrations.rows[0]).toEqual({ n: 7 });
    const after =
      (
        await migrator.query<Record<string, unknown>>('select * from routers where id = $1', [
          CHR_ID,
        ])
      ).rows[0] ?? {};
    for (const column of Object.keys(before)) {
      if (column === 'updated_at') continue;
      expect(after[column], column).toEqual(before[column]);
    }
    expect(after).toMatchObject({ wg_public_key: null, enrolled_at: null, activated_at: null });
    expect(
      decryptRouterPassword(
        box,
        { companyId, routerId: CHR_ID },
        String(after.routeros_password_encrypted),
      ),
    ).toBe('Chr-Lab-Pass-0001');
    const worker = new pg.Pool({ connectionString: infra.urls.worker, max: 1 });
    try {
      const rows = (await worker.query<{ id: string }>('select id from routers')).rows;
      expect(rows.map((r) => r.id)).toEqual([CHR_ID]);
      expect(
        (await worker.query("update routers set status = 'DEGRADED' where id = $1", [CHR_ID]))
          .rowCount,
      ).toBe(1);
    } finally {
      await worker.end();
    }
  });
});
