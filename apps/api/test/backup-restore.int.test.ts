/**
 * Sauvegarde et restauration réelles (Sprint S3H, étape H1) sur PostgreSQL 18 réel :
 * pg_dump -Fc de la base source (rôles réels, RLS, données de test chiffrées, journal
 * d'audit), pg_restore dans une AUTRE instance neuve initialisée par le même script de rôles,
 * puis comparaison complète (src/database/restore-check.ts, utilisé par ops/backup/).
 */
import { randomBytes } from 'node:crypto';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SecretBox } from '../src/auth/crypto/secret-box.js';
import { runMigrations } from '../src/database/migrate.js';
import {
  checkMigrationsUpToDate,
  compareWithManifest,
  type DatabaseState,
  inspectDatabase,
  parseManifest,
  selfChecks,
} from '../src/database/restore-check.js';
import { type SeedResult, seedDevData } from '../src/database/seed.js';
import { encryptRouterPassword } from '../src/routers/router-secret.js';
import { SEED_PASSWORD } from './helpers/app.js';
import { startInfra, startPostgres, TEST_PASSWORDS, type TestInfra } from './helpers/infra.js';

const KEY_K1 = randomBytes(32).toString('base64');
const box = new SecretBox(KEY_K1, { id: 'k1' });

let infra: TestInfra;
let target: StartedPostgreSqlContainer;
let seed: SeedResult;
let sourcePool: pg.Pool;
let targetPool: pg.Pool;
let source: DatabaseState;
let restored: DatabaseState;

const url = (c: StartedPostgreSqlContainer, user: string, password: string) =>
  `postgres://${user}:${password}@${c.getHost()}:${c.getPort()}/ecsi`;

async function exec(c: StartedPostgreSqlContainer, script: string) {
  const result = await c.exec(['sh', '-c', script]);
  if (result.exitCode !== 0) throw new Error(`${script.split(' ')[0]} : ${result.output}`);
  return result.output;
}

const statuses = (lines: { status: string }[]) => lines.map((l) => l.status);

beforeAll(async () => {
  [infra, target] = await Promise.all([startInfra(), startPostgres()]);
  await runMigrations(infra.urls.migrator);
  sourcePool = new pg.Pool({ connectionString: infra.urls.superuser, max: 2 });
  seed = await seedDevData(drizzle(sourcePool, { casing: 'snake_case' }), SEED_PASSWORD);

  // Routeurs avec mots de passe RouterOS chiffrés (liés au routeur), secret 2FA, audit.
  for (const [key, ip] of [
    ['A', '10.200.0.2'],
    ['B', '10.200.0.3'],
  ] as const) {
    const companyId = seed.companies[key];
    const { rows } = await sourcePool.query<{ id: string }>(
      `insert into routers (company_id, site_id, name, tunnel_ip, routeros_username,
         routeros_password_encrypted, transport)
       values ($1, $2, $3, $4, 'ecsi', 'v2:k1:x', 'API') returning id`,
      [companyId, seed.sites[key]['SITE-A'], `Routeur ${key}`, ip],
    );
    const routerId = rows[0]?.id ?? '';
    await sourcePool.query('update routers set routeros_password_encrypted = $1 where id = $2', [
      encryptRouterPassword(box, { companyId, routerId }, randomBytes(12).toString('hex')),
      routerId,
    ]);
  }
  const userId = seed.users['admin.a@ecsi.test'] ?? '';
  await sourcePool.query('insert into mfa_factors (user_id, secret_enc) values ($1, $2)', [
    userId,
    box.encrypt(randomBytes(20).toString('hex'), `mfa:user:${userId}`),
  ]);
  for (const action of ['test.first', 'test.second']) {
    await sourcePool.query(
      `insert into audit_events (company_id, chain_key, chain_seq, hash, actor_type, actor_id,
         action, resource_type, result)
       values ($1, 'x', 0, ''::bytea, 'USER', $2, $3, 'test', 'SUCCESS')`,
      [seed.companies.A, userId, action],
    );
  }

  // Sauvegarde (format personnalisé, comme ops/backup/pg-backup.sh) puis restauration dans
  // l'instance cible, par le réseau Docker entre les deux conteneurs.
  const host = infra.postgres.getIpAddress(infra.postgres.getNetworkNames()[0] ?? '');
  await exec(
    target,
    `PGPASSWORD='${TEST_PASSWORDS.superuser}' pg_dump -h ${host} -U postgres -d ecsi -Fc -f /tmp/ecsi.pgc` +
      ` && pg_restore --exit-on-error -U postgres -d ecsi /tmp/ecsi.pgc`,
  );
  targetPool = new pg.Pool({
    connectionString: url(target, 'postgres', TEST_PASSWORDS.superuser),
    max: 2,
  });
  source = await inspectDatabase(sourcePool, box);
  restored = await inspectDatabase(targetPool, box);
}, 240_000);

afterAll(async () => {
  await sourcePool.end();
  await targetPool.end();
  await Promise.all([infra.stop(), target.stop()]);
});

describe('restauration complète dans une instance neuve', () => {
  it('la base source est saine et contient les données de test', () => {
    expect(statuses(selfChecks(source))).not.toContain('ECHEC');
    expect(source.secrets.routers).toEqual({ total: 2, ok: 2, failed: 0, previousKey: 0 });
    expect(source.secrets.mfa).toEqual({ total: 1, ok: 1, failed: 0, previousKey: 0 });
    expect(source.audit).toEqual({ chains: 1, events: 2, broken: 0 });
    expect(source.roles).toEqual(['ecsi_app', 'ecsi_auth', 'ecsi_migrator', 'ecsi_worker']);
    expect(source.tables.find((t) => t.name === 'public.routers')).toMatchObject({
      rows: 2,
      rls: true,
    });
  });

  it('la copie restaurée est identique au manifeste : lignes, RLS, rôles, droits, audit, secrets', () => {
    const lines = compareWithManifest(restored, parseManifest(JSON.stringify(source)));
    expect(lines.filter((l) => l.status === 'ECHEC')).toEqual([]);
    expect(restored.tables).toEqual(source.tables);
    expect(restored.grantsDigest).toBe(source.grantsDigest);
  });

  it('les rôles applicatifs gardent leurs droits réels (RLS appliquée à ecsi_app)', async () => {
    const app = new pg.Pool({ connectionString: url(target, 'ecsi_app', TEST_PASSWORDS.app) });
    try {
      // Sans contexte d'entreprise, la RLS ne laisse voir aucun routeur.
      const { rows } = await app.query<{ n: number }>('select count(*)::int as n from routers');
      expect(rows[0]?.n).toBe(0);
    } finally {
      await app.end();
    }
  });

  it('aucune migration du code n’est à rejouer sur la copie restaurée', async () => {
    const count = async () =>
      (
        await targetPool.query<{ n: number }>(
          'select count(*)::int as n from drizzle.__drizzle_migrations',
        )
      ).rows[0]?.n ?? 0;
    const line = await checkMigrationsUpToDate(
      url(target, 'ecsi_migrator', TEST_PASSWORDS.migrator),
      count,
      runMigrations,
    );
    expect(line.status).toBe('OK');
  });
});

describe('cas négatifs', () => {
  it('mauvaise clé de chiffrement : échecs comptés, rien de déchiffré', async () => {
    const wrong = new SecretBox(randomBytes(32).toString('base64'), { id: 'k1' });
    const state = await inspectDatabase(targetPool, wrong);
    expect(state.secrets.routers).toMatchObject({ total: 2, ok: 0, failed: 2 });
    expect(state.secrets.mfa).toMatchObject({ total: 1, ok: 0, failed: 1 });
    const failed = selfChecks(state).filter((l) => l.status === 'ECHEC');
    expect(failed.map((l) => l.label).join('\n')).toMatch(/RouterOS : 0\/2 déchiffrés, 2 échec/);
  });

  it('ancienne clé seulement en clé précédente : déchiffrable, signalé « ancienne clé »', async () => {
    const rotated = new SecretBox(randomBytes(32).toString('base64'), {
      id: 'k2',
      previous: [{ id: 'k1', base64: KEY_K1 }],
    });
    const state = await inspectDatabase(targetPool, rotated);
    expect(state.secrets.routers).toEqual({ total: 2, ok: 2, failed: 0, previousKey: 2 });
    expect(statuses(selfChecks(state))).toContain('INFO');
  });

  it('ligne manquante et journal d’audit altéré : détectés', async () => {
    const client = await targetPool.connect();
    try {
      await client.query('begin');
      // Altération directe par le superutilisateur, déclencheurs contournés.
      await client.query("set local session_replication_role = 'replica'");
      await client.query(
        "update audit_events set action = 'test.tampered' where action = 'test.first'",
      );
      await client.query('delete from mfa_factors');
      const state = await inspectDatabase(client, box);
      await client.query('rollback');
      const failed = compareWithManifest(state, source)
        .filter((l) => l.status === 'ECHEC')
        .map((l) => l.label)
        .join('\n');
      expect(failed).toMatch(/maillon\(s\) rompu/);
      expect(failed).toMatch(/différent : public\.mfa_factors/);
      expect(failed).toMatch(/secrets mfa : 0 \(sauvegarde : 1\)/);
    } finally {
      client.release();
    }
  });

  it('manifeste d’un autre format : refusé', () => {
    expect(() => parseManifest(JSON.stringify({ ...source, format: 'autre' }))).toThrow(
      /Manifeste de sauvegarde invalide/,
    );
  });
});
