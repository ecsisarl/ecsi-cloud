/**
 * Routeurs MikroTik (Sprint 3A) sur PostgreSQL 18 réel, rôles réels (infra/postgres/init) :
 * clé composite entreprise/site, RLS ENTREPRISE_A / _B, droits minimaux du rôle ecsi_worker,
 * chiffrement du mot de passe RouterOS lié au routeur, et supervision de bout en bout contre
 * un FAUX service RouterOS (simulation, test/helpers/fake-routeros.ts).
 */
import { randomBytes } from 'node:crypto';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AuditService } from '../src/audit/audit.service.js';
import { SecretBox } from '../src/auth/crypto/secret-box.js';
import type { Env } from '../src/config/env.js';
import { runMigrations } from '../src/database/migrate.js';
import * as schema from '../src/database/schema/index.js';
import { type SeedResult, seedDevData } from '../src/database/seed.js';
import { decryptRouterPassword, rotateRouterSecrets } from '../src/routers/router-secret.js';
import { ApiTransport } from '../src/routers/routeros/api-transport.js';
import { RouterOsError } from '../src/routers/routeros/errors.js';
import { type TransportFactory, tunnelTransportFactory } from '../src/routers/routeros/factory.js';
import { RoutersService } from '../src/routers/routers.service.js';
import { RouterSupervisor } from '../src/routers/supervision/supervisor.js';
import { assertRouterTunnelIp, parseTunnelNetwork } from '../src/routers/tunnel-ip.js';
import { TenantDatabase } from '../src/tenancy/tenant-database.js';
import { type FakeServer, startFakeApi } from './helpers/fake-routeros.js';
import { SEED_PASSWORD } from './helpers/app.js';
import { startInfra, type TestInfra } from './helpers/infra.js';

const ROUTEROS_PASSWORD = 'Rtr-Secret-Pass-0042!';
const network = parseTunnelNetwork('10.200.0.0/24', '10.200.0.1');

let infra: TestInfra;
let seed: SeedResult;
const KEY_K1 = randomBytes(32).toString('base64');
let box: SecretBox;
let migrator: pg.Pool;
let appPool: pg.Pool;
let workerPool: pg.Pool;
let service: RoutersService;
// Le contexte utilisateur n'intervient pas dans la RLS des routeurs (entreprise seule).
const ctx = (key: 'A' | 'B') => ({
  companyId: seed.companies[key],
  userId: Object.values(seed.users)[0] ?? '',
});

async function as<T>(
  url: string,
  companyId: string | null,
  work: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const pool = new pg.Pool({ connectionString: url, max: 1 });
  const client = await pool.connect();
  try {
    await client.query('begin');
    if (companyId) await client.query("select set_config('app.company_id', $1, true)", [companyId]);
    const result = await work(client);
    await client.query('rollback');
    return result;
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

async function sqlError(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return (error as { code?: string }).code ?? 'inconnu';
  }
  return 'aucune erreur';
}

beforeAll(async () => {
  infra = await startInfra();
  await runMigrations(infra.urls.migrator);
  migrator = new pg.Pool({ connectionString: infra.urls.migrator, max: 1 });
  seed = await seedDevData(drizzle(migrator, { casing: 'snake_case' }), SEED_PASSWORD);
  box = new SecretBox(KEY_K1, { id: 'k1' });
  appPool = new pg.Pool({ connectionString: infra.urls.app, max: 2 });
  workerPool = new pg.Pool({ connectionString: infra.urls.worker, max: 2 });
  service = new RoutersService(
    new TenantDatabase(drizzle(appPool, { schema, casing: 'snake_case' })),
    box,
    { ROUTER_TUNNEL_CIDR: '10.200.0.0/24', ROUTER_TUNNEL_GATEWAY: '10.200.0.1' } as Env,
    // register / setCredentials (outils internes) n'écrivent pas d'audit utilisateur ; les
    // routes HTTP auditées sont couvertes par test/routers-api.int.test.ts (Sprint 3B).
    {} as AuditService,
  );
}, 180_000);

afterAll(async () => {
  await migrator.end();
  await appPool.end();
  await workerPool.end();
  await infra.stop();
});

const insertSql = `insert into routers (company_id, site_id, name, tunnel_ip, routeros_username,
  routeros_password_encrypted, transport) values ($1, $2, 'r', $3, 'ecsi', 'v2:k1:x', 'API') returning id`;

describe('clé composite entreprise / site', () => {
  it('refuse un routeur de l’entreprise A rattaché à un site de B, même pour le propriétaire', async () => {
    const code = await sqlError(
      as(infra.urls.migrator, null, (c) =>
        c.query(insertSql, [seed.companies.A, seed.sites.B['SITE-A'], '10.200.0.90']),
      ),
    );
    expect(code).toBe('23503'); // violation de clé étrangère
  });

  it('ecsi_app (contexte A) ne peut ni viser un site de B, ni écrire pour B', async () => {
    expect(
      await sqlError(
        as(infra.urls.app, seed.companies.A, (c) =>
          c.query(insertSql, [seed.companies.A, seed.sites.B['SITE-A'], '10.200.0.91']),
        ),
      ),
    ).toBe('23503');
    expect(
      await sqlError(
        as(infra.urls.app, seed.companies.A, (c) =>
          c.query(insertSql, [seed.companies.B, seed.sites.B['SITE-A'], '10.200.0.92']),
        ),
      ),
    ).toBe('42501'); // RLS : WITH CHECK
  });

  it('refuse une adresse tunnel non /32 et un transport REST sans empreinte (contraintes)', async () => {
    expect(
      await sqlError(
        as(infra.urls.migrator, null, (c) =>
          c.query(insertSql, [seed.companies.A, seed.sites.A['SITE-A'], '10.200.0.0/24']),
        ),
      ),
    ).toBe('23514');
    expect(
      await sqlError(
        as(infra.urls.migrator, null, (c) =>
          c.query(insertSql.replace("'API'", "'REST_HTTPS'"), [
            seed.companies.A,
            seed.sites.A['SITE-A'],
            '10.200.0.93',
          ]),
        ),
      ),
    ).toBe('23514');
  });
});

describe('enregistrement et chiffrement (RoutersService, rôle ecsi_app)', () => {
  let routerA: string;
  let routerB: string;

  beforeAll(async () => {
    routerA = (
      await service.register(ctx('A'), {
        siteId: seed.sites.A['SITE-A'] ?? '',
        name: 'Routeur A',
        tunnelIp: '10.200.0.2',
        transport: 'API',
        routerosUsername: 'ecsi-cloud',
        routerosPassword: ROUTEROS_PASSWORD,
      })
    ).id;
    routerB = (
      await service.register(ctx('B'), {
        siteId: seed.sites.B['SITE-A'] ?? '',
        name: 'Routeur B',
        tunnelIp: '10.200.0.3',
        transport: 'REST_HTTPS',
        routerosUsername: 'ecsi-svc',
        routerosPassword: ROUTEROS_PASSWORD,
        tlsFingerprint: 'AB'.repeat(32),
      })
    ).id;
  });

  it('stocke un chiffré v2 lié au routeur, jamais le mot de passe en clair', async () => {
    const row = await as(
      infra.urls.migrator,
      null,
      async (c) =>
        (
          await c.query<{ secret: string; fp: string }>(
            'select routeros_password_encrypted as secret, tls_fingerprint as fp from routers where id = $1',
            [routerB],
          )
        ).rows[0],
    );
    expect(row?.secret.startsWith('v2:')).toBe(true);
    expect(row?.secret).not.toContain(ROUTEROS_PASSWORD);
    expect(row?.fp).toBe('ab'.repeat(32));
    expect(
      decryptRouterPassword(
        box,
        { companyId: seed.companies.B, routerId: routerB },
        row?.secret ?? '',
      ),
    ).toBe(ROUTEROS_PASSWORD);
    const dump = await as(infra.urls.migrator, null, async (c) =>
      JSON.stringify((await c.query('select * from routers')).rows),
    );
    expect(dump).not.toContain(ROUTEROS_PASSWORD);
    // Aucune colonne de clé privée WireGuard.
    const columns = await as(infra.urls.migrator, null, async (c) =>
      (
        await c.query<{ column_name: string }>(
          "select column_name from information_schema.columns where table_name = 'routers'",
        )
      ).rows.map((r) => r.column_name),
    );
    expect(columns.some((name) => /private|wg_key|wireguard/i.test(name))).toBe(false);
  });

  it('un chiffré copié sur un autre routeur est inutilisable', async () => {
    const secretA = await as(
      infra.urls.migrator,
      null,
      async (c) =>
        (
          await c.query<{ s: string }>(
            'select routeros_password_encrypted as s from routers where id = $1',
            [routerA],
          )
        ).rows[0]?.s ?? '',
    );
    expect(() =>
      decryptRouterPassword(box, { companyId: seed.companies.B, routerId: routerB }, secretA),
    ).toThrow();
    expect(() =>
      decryptRouterPassword(box, { companyId: seed.companies.A, routerId: routerB }, secretA),
    ).toThrow();
  });

  it('refuse les adresses tunnel hors plage (anti-SSRF) et les doublons', async () => {
    for (const ip of [
      '8.8.8.8',
      '127.0.0.1',
      '192.168.88.1',
      '10.200.0.1',
      '169.254.169.254',
      '10.200.0.255',
    ]) {
      await expect(
        service.register(ctx('A'), {
          siteId: seed.sites.A['SITE-A'] ?? '',
          name: 'x',
          tunnelIp: ip,
          transport: 'API',
          routerosUsername: 'ecsi',
          routerosPassword: ROUTEROS_PASSWORD,
        }),
      ).rejects.toMatchObject({ status: 422 });
    }
    // Adresse déjà utilisée par l'entreprise B : refusée, sans révéler de donnée de B.
    await expect(
      service.register(ctx('A'), {
        siteId: seed.sites.A['SITE-A'] ?? '',
        name: 'x',
        tunnelIp: '10.200.0.3',
        transport: 'API',
        routerosUsername: 'ecsi',
        routerosPassword: ROUTEROS_PASSWORD,
      }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('refuse le site d’une autre entreprise (404, comme un site inexistant)', async () => {
    await expect(
      service.register(ctx('A'), {
        siteId: seed.sites.B['SITE-A'] ?? '',
        name: 'x',
        tunnelIp: '10.200.0.50',
        transport: 'API',
        routerosUsername: 'ecsi',
        routerosPassword: ROUTEROS_PASSWORD,
      }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('RLS : A ne voit, ne modifie ni ne supprime les routeurs de B', async () => {
    await as(infra.urls.app, seed.companies.A, async (c) => {
      const ids = (await c.query<{ id: string }>('select id from routers')).rows.map((r) => r.id);
      expect(ids).toContain(routerA);
      expect(ids).not.toContain(routerB);
      expect(
        (await c.query("update routers set name = 'pirate' where id = $1", [routerB])).rowCount,
      ).toBe(0);
    });
    // Sprint 3B : suppression logique seulement, ecsi_app n'a plus le droit DELETE.
    expect(
      await sqlError(
        as(infra.urls.app, seed.companies.A, (c) =>
          c.query('delete from routers where id = $1', [routerB]),
        ),
      ),
    ).toBe('42501');
    await as(infra.urls.app, null, async (c) => {
      expect((await c.query('select id from routers')).rowCount).toBe(0); // sans contexte : rien
    });
    await expect(
      service.setCredentials(ctx('A'), routerB, {
        routerosUsername: 'x',
        routerosPassword: ROUTEROS_PASSWORD,
      }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('ecsi_auth n’a aucun accès aux routeurs', async () => {
    expect(
      await sqlError(as(infra.urls.auth, null, (c) => c.query('select id from routers'))),
    ).toBe('42501');
  });

  it('ecsi_worker : lecture de tous les routeurs actifs, écriture des seules colonnes de supervision', async () => {
    await as(infra.urls.worker, null, async (c) => {
      const ids = (await c.query<{ id: string }>('select id from routers')).rows.map((r) => r.id);
      expect(ids).toEqual(expect.arrayContaining([routerA, routerB]));
      expect(
        (await c.query("update routers set status = 'DEGRADED' where id = $1", [routerA])).rowCount,
      ).toBe(1);
    });
    for (const statement of [
      "update routers set tunnel_ip = '8.8.8.8' where id = $1",
      'update routers set company_id = company_id where id = $1',
      'update routers set site_id = site_id where id = $1',
      "update routers set routeros_username = 'admin' where id = $1",
      'update routers set tls_fingerprint = null where id = $1',
      'update routers set deleted_at = now() where id = $1',
      'delete from routers where id = $1',
    ]) {
      expect(
        await sqlError(as(infra.urls.worker, null, (c) => c.query(statement, [routerA]))),
      ).toBe('42501');
    }
    for (const table of [
      'sites',
      'companies',
      'users',
      'user_credentials',
      'mfa_factors',
      'audit_events',
    ]) {
      expect(
        await sqlError(
          as(infra.urls.worker, null, (c) => c.query(`select 1 from ${table} limit 1`)),
        ),
      ).toBe('42501');
    }
    expect(
      await sqlError(
        as(infra.urls.worker, null, (c) =>
          c.query(insertSql, [seed.companies.A, seed.sites.A['SITE-A'], '10.200.0.94']),
        ),
      ),
    ).toBe('42501');
  });

  it('ecsi_worker ne voit pas les routeurs supprimés', async () => {
    await migrator.query('update routers set deleted_at = now() where id = $1', [routerB]);
    const ids = await as(infra.urls.worker, null, async (c) =>
      (await c.query<{ id: string }>('select id from routers')).rows.map((r) => r.id),
    );
    await migrator.query('update routers set deleted_at = null where id = $1', [routerB]);
    expect(ids).toContain(routerA);
    expect(ids).not.toContain(routerB);
  });
});

describe('supervision de bout en bout (rôle ecsi_worker, faux service API RouterOS)', () => {
  let fake: FakeServer;
  let routerId: string;
  const logs: string[] = [];
  const logger = {
    log: (m: string) => logs.push(m),
    warn: (m: string) => logs.push(m),
    debug: (m: string) => logs.push(m),
  };
  let reachable = true;
  let clock = new Date();
  /** Fabrique de test : valide l'adresse tunnel comme en production, puis joint le faux service local. */
  const factory: TransportFactory = (target, credentials) => {
    assertRouterTunnelIp(target.tunnelIp, network);
    if (!reachable)
      return Promise.reject(new RouterOsError('UNREACHABLE', 'Délai dépassé (aucune réponse)'));
    return ApiTransport.open({ host: '127.0.0.1', port: fake.port }, credentials, {
      connectMs: 2000,
      requestMs: 2000,
    });
  };
  const supervisor = () =>
    new RouterSupervisor(
      drizzle(workerPool, { schema, casing: 'snake_case' }),
      box,
      factory,
      {
        pollIntervalSeconds: 10,
        batchSize: 50,
        concurrency: 4,
        thresholds: { offlineAfterSeconds: 180, offlineMinFailures: 3 },
      },
      logger,
      () => clock,
    );
  const read = () =>
    as(
      infra.urls.migrator,
      null,
      async (c) =>
        (
          await c.query<{
            status: string;
            identity: string | null;
            routeros_version: string | null;
            uptime_seconds: string | null;
            cpu_load: number | null;
            consecutive_failures: number;
            last_error: string | null;
            last_seen_at: Date | null;
            interfaces: { name: string }[] | null;
          }>('select * from routers where id = $1', [routerId])
        ).rows[0],
    );
  const resetSync = () => migrator.query('update routers set last_sync_at = null');

  beforeAll(async () => {
    fake = await startFakeApi({
      username: 'ecsi-cloud',
      password: ROUTEROS_PASSWORD,
      identity: 'chr-ovh',
    });
    routerId = (
      await service.register(ctx('A'), {
        siteId: seed.sites.A['SITE-B'] ?? '',
        name: 'CHR supervision',
        tunnelIp: '10.200.0.20',
        transport: 'API',
        routerosUsername: 'ecsi-cloud',
        routerosPassword: ROUTEROS_PASSWORD,
      })
    ).id;
    // Les autres routeurs de test n'ont pas de service : on ne garde que celui-ci.
    await migrator.query('update routers set deleted_at = now() where id <> $1', [routerId]);
  });

  afterAll(async () => {
    await fake.close();
  });

  it('collecte réussie : ONLINE et données de supervision enregistrées', async () => {
    const results = await supervisor().runCycle();
    expect(results).toEqual([{ routerId, status: 'ONLINE', outcome: 'success', error: null }]);
    const row = await read();
    expect(row).toMatchObject({
      status: 'ONLINE',
      identity: 'chr-ovh',
      routeros_version: '7.23.7 (long-term)',
      cpu_load: 7,
      consecutive_failures: 0,
      last_error: null,
    });
    expect(Number(row?.uptime_seconds)).toBe(788645);
    expect(row?.interfaces?.map((i) => i.name)).toEqual(['ether1', 'wg-ecsi']);
    expect(row?.last_seen_at).not.toBeNull();
    // Lecture seule : aucune commande autre que login et print.
    expect(fake.received.every((cmd) => cmd === '/login' || cmd.endsWith('/print'))).toBe(true);
  });

  it('un routeur déjà collecté n’est pas repris avant l’intervalle', async () => {
    expect(await supervisor().runCycle()).toEqual([]);
  });

  it('timeouts : DEGRADED, puis OFFLINE seulement après 180 s ET 3 échecs', async () => {
    reachable = false;
    const lastSeen = (await read())?.last_seen_at ?? new Date();
    const statuses: string[] = [];
    for (const offset of [30, 60, 90, 200]) {
      clock = new Date(lastSeen.getTime() + offset * 1000);
      await resetSync();
      const [result] = await supervisor().runCycle();
      statuses.push(result?.status ?? '?');
    }
    expect(statuses).toEqual(['DEGRADED', 'DEGRADED', 'DEGRADED', 'OFFLINE']);
    expect((await read())?.consecutive_failures).toBe(4);
    reachable = true;
    await resetSync();
    const [back] = await supervisor().runCycle();
    expect(back?.status).toBe('ONLINE');
  });

  it('mot de passe refusé : DEGRADED, sans le mot de passe dans last_error ni les journaux', async () => {
    await fake.close();
    fake = await startFakeApi({ username: 'ecsi-cloud', password: 'un-autre-mot-de-passe' });
    await migrator.query('update routers set last_sync_at = null');
    const [result] = await supervisor().runCycle();
    expect(result?.status).toBe('DEGRADED');
    expect(result?.error).toMatch(/^AUTH: /);
    const row = await read();
    expect(row?.last_error).toMatch(/^AUTH: /);
    expect(row?.last_error).not.toContain(ROUTEROS_PASSWORD);
    expect(logs.join('\n')).not.toContain(ROUTEROS_PASSWORD);
    expect(logs.join('\n')).not.toContain(Buffer.from(ROUTEROS_PASSWORD).toString('base64'));
  });

  it('chiffré copié depuis un autre routeur : refus (CONFIG), aucune connexion', async () => {
    const other = await service.register(ctx('A'), {
      siteId: seed.sites.A['SITE-A'] ?? '',
      name: 'Autre',
      tunnelIp: '10.200.0.21',
      transport: 'API',
      routerosUsername: 'ecsi-cloud',
      routerosPassword: ROUTEROS_PASSWORD,
    });
    await migrator.query(
      `update routers set routeros_password_encrypted =
        (select routeros_password_encrypted from routers where id = $1) where id = $2`,
      [other.id, routerId],
    );
    await migrator.query('update routers set deleted_at = now() where id = $1', [other.id]);
    await migrator.query('update routers set last_sync_at = null');
    const before = fake.received.length;
    const [result] = await supervisor().runCycle();
    expect(result?.error).toMatch(/^CONFIG: Mot de passe RouterOS indéchiffrable/);
    expect(fake.received.length).toBe(before);
  });

  it('adresse tunnel altérée en base (IP publique) : jamais contactée', async () => {
    await service.setCredentials(ctx('A'), routerId, {
      routerosUsername: 'ecsi-cloud',
      routerosPassword: ROUTEROS_PASSWORD,
    });
    await migrator.query(
      "update routers set tunnel_ip = '8.8.8.8', last_sync_at = null where id = $1",
      [routerId],
    );
    const real = tunnelSupervisor();
    const [result] = await real.runCycle();
    expect(result?.error).toMatch(/^CONFIG: Adresse tunnel refusée/);
    await migrator.query("update routers set tunnel_ip = '10.200.0.20' where id = $1", [routerId]);
  });

  it('rotation de clé : les mots de passe RouterOS sont ré-enveloppés par ecsi_worker', async () => {
    const rotated = new SecretBox(randomBytes(32).toString('base64'), {
      id: 'k2',
      previous: [{ id: 'k1', base64: KEY_K1 }],
    });
    const report = await rotateRouterSecrets(
      drizzle(workerPool, { casing: 'snake_case' }),
      rotated,
    );
    expect(report).toMatchObject({ total: 1, rewrapped: 1, failed: 0 });
    const secret =
      (
        await migrator.query<{ s: string }>(
          'select routeros_password_encrypted as s from routers where id = $1',
          [routerId],
        )
      ).rows[0]?.s ?? '';
    expect(secret.startsWith('v2:k2:')).toBe(true);
    expect(decryptRouterPassword(rotated, { companyId: seed.companies.A, routerId }, secret)).toBe(
      ROUTEROS_PASSWORD,
    );
    expect(
      await rotateRouterSecrets(drizzle(workerPool, { casing: 'snake_case' }), rotated),
    ).toMatchObject({ rewrapped: 0 });
  });
});

/** Supervision avec la VRAIE fabrique de transport (validation de l'adresse avant connexion). */
function tunnelSupervisor(): RouterSupervisor {
  return new RouterSupervisor(
    drizzle(workerPool, { schema, casing: 'snake_case' }),
    box,
    tunnelTransportFactory(network, { connectMs: 300, requestMs: 300 }),
  );
}
