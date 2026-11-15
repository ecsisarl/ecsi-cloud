/**
 * Lot E1 — historique de supervision et alertes dans l'application, sur PostgreSQL 18 réel,
 * Redis réel et rôles réels (infra/postgres/init) : migration 0007, RLS et privilèges des
 * rôles ecsi_app / ecsi_auth / ecsi_worker, worker de supervision de bout en bout (mesures,
 * ouverture et résolution des alertes, purge) et API HTTP complète (sessions, permissions par
 * site, audit de l'acquittement). Le ROUTEUR est SIMULÉ (faux service API RouterOS,
 * test/helpers/fake-routeros.ts) : aucune commande RouterOS nouvelle n'est utilisée.
 */
import { randomBytes } from 'node:crypto';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Alert, AlertSummary, MonitoringOverview, Router, RouterMetrics } from '@ecsi/shared';
import { SecretBox } from '../src/auth/crypto/secret-box.js';
import * as schema from '../src/database/schema/index.js';
import { DEFAULT_ALERT_THRESHOLDS } from '../src/monitoring/alert-rules.js';
import { MonitoringRecorder } from '../src/monitoring/recorder.js';
import { ApiTransport } from '../src/routers/routeros/api-transport.js';
import { RouterOsError } from '../src/routers/routeros/errors.js';
import type { TransportFactory } from '../src/routers/routeros/factory.js';
import { RouterSupervisor } from '../src/routers/supervision/supervisor.js';
import { assertRouterTunnelIp, parseTunnelNetwork } from '../src/routers/tunnel-ip.js';
import { FAKE_RESOURCE, type FakeServer, startFakeApi } from './helpers/fake-routeros.js';
import {
  enrollMfa,
  type HttpClient,
  loginAs,
  startTestApp,
  TEST_SECRETS,
  type TestApp,
} from './helpers/app.js';
import { startInfra, type TestInfra } from './helpers/infra.js';

// Secret de test généré à l'exécution (jamais écrit dans le dépôt).
const ROUTEROS_PASSWORD = randomBytes(18).toString('base64url');
const network = parseTunnelNetwork('10.200.0.0/24', '10.200.0.1');
const box = new SecretBox(TEST_SECRETS.encryptionKey, { id: 'k1' });

let infra: TestInfra;
let t: TestApp;
let workerPool: pg.Pool;
let fake: FakeServer;
let adminA: HttpClient;
let adminB: HttpClient;
let gerantSiteA: HttpClient;
let vendeurSiteB: HttpClient;
/** R1 : SITE-A de A, joignable (faux service) ; R2 : SITE-B de A ; RB : entreprise B. */
let r1: Router;
let r2: Router;
let rb: Router;
let reachable = true;
let clock = new Date();
const logs: string[] = [];

const site = (key: 'A' | 'B', code: string) => t.seed.sites[key][code] ?? '';

/** Fabrique de test : valide l'adresse tunnel comme en production ; seul R1 répond. */
const factory: TransportFactory = (target, credentials) => {
  const ip = assertRouterTunnelIp(target.tunnelIp, network);
  if (!reachable || ip !== r1.tunnelIp) {
    return Promise.reject(new RouterOsError('UNREACHABLE', 'Délai dépassé (aucune réponse)'));
  }
  return ApiTransport.open({ host: '127.0.0.1', port: fake.port }, credentials, {
    connectMs: 2000,
    requestMs: 2000,
  });
};

const workerDb = () => drizzle(workerPool, { schema, casing: 'snake_case' });
const recorder = () => new MonitoringRecorder(workerDb());
const supervisor = () =>
  new RouterSupervisor(
    workerDb(),
    box,
    factory,
    {
      pollIntervalSeconds: 10,
      batchSize: 50,
      concurrency: 4,
      thresholds: { offlineAfterSeconds: 180, offlineMinFailures: 3 },
    },
    { log: (m) => logs.push(m), warn: (m) => logs.push(m), debug: (m) => logs.push(m) },
    () => clock,
    recorder(),
  );
/** Un cycle de supervision complet, comme le worker (tous les routeurs redeviennent dus). */
async function cycle() {
  await t.migrator.query('update routers set last_sync_at = null');
  return supervisor().runCycle();
}

const openAlerts = async (routerId: string) =>
  (
    await t.migrator.query<{ type: string }>(
      'select type from alerts where router_id = $1 and resolved_at is null order by type',
      [routerId],
    )
  ).rows.map((row) => row.type);

const auditCount = async (action: string, result: string, resourceId: string) =>
  Number(
    (
      await t.migrator.query<{ n: string }>(
        'select count(*) as n from audit_events where action = $1 and result = $2 and resource_id = $3',
        [action, result, resourceId],
      )
    ).rows[0]?.n ?? 0,
  );

/** Transaction annulée avec le rôle donné et, éventuellement, le contexte tenant. */
async function as<T>(
  url: string,
  context: { companyId: string; userId?: string } | null,
  work: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const pool = new pg.Pool({ connectionString: url, max: 1 });
  const client = await pool.connect();
  try {
    await client.query('begin');
    if (context) {
      await client.query(
        "select set_config('app.company_id', $1, true), set_config('app.user_id', $2, true)",
        [context.companyId, context.userId ?? ''],
      );
    }
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

async function createRouter(client: HttpClient, siteId: string, name: string, tunnelIp: string) {
  const response = await client.post('/routers', {
    siteId,
    name,
    tunnelIp,
    transport: 'API',
    routerosUsername: 'ecsi-cloud',
    routerosPassword: ROUTEROS_PASSWORD,
  });
  expect(response.statusCode, response.body).toBe(201);
  return response.json<Router>();
}

beforeAll(async () => {
  infra = await startInfra();
  t = await startTestApp(infra);
  workerPool = new pg.Pool({ connectionString: infra.urls.worker, max: 4 });
  fake = await startFakeApi({
    username: 'ecsi-cloud',
    password: ROUTEROS_PASSWORD,
    identity: 'chr-e1',
  });
  adminA = await loginAs(t.app, 'admin.a@ecsi.test');
  await enrollMfa(adminA);
  adminB = await loginAs(t.app, 'admin.b@ecsi.test');
  await enrollMfa(adminB);
  gerantSiteA = await loginAs(t.app, 'gerant.site-a@ecsi.test');
  vendeurSiteB = await loginAs(t.app, 'vendeur.site-b@ecsi.test');
  r1 = await createRouter(adminA, site('A', 'SITE-A'), 'R1 Riviera', '10.200.0.2');
  r2 = await createRouter(adminA, site('A', 'SITE-B'), 'R2 Selmer', '10.200.0.3');
  rb = await createRouter(adminB, site('B', 'SITE-A'), 'RB Plateau', '10.200.0.4');
}, 180_000);

afterAll(async () => {
  FAKE_RESOURCE['cpu-load'] = '7';
  await fake.close();
  await workerPool.end();
  await t.close();
  await infra.stop();
});

describe('migration 0007 : tables, RLS et privilèges', () => {
  it('crée router_metrics et alerts avec la RLS activée', async () => {
    const { rows } = await t.migrator.query<{ relname: string; relrowsecurity: boolean }>(
      "select relname, relrowsecurity from pg_class where relname in ('router_metrics', 'alerts') order by relname",
    );
    expect(rows).toEqual([
      { relname: 'alerts', relrowsecurity: true },
      { relname: 'router_metrics', relrowsecurity: true },
    ]);
  });

  it('ecsi_auth n’a aucun accès', async () => {
    for (const table of ['router_metrics', 'alerts']) {
      expect(
        await sqlError(as(infra.urls.auth, null, (c) => c.query(`select 1 from ${table}`))),
      ).toBe('42501');
    }
  });
});

describe('worker : mesures et alertes (rôle ecsi_worker, faux service RouterOS)', () => {
  it('premier cycle : mesure pour chaque routeur, R1 ONLINE, alerte OFFLINE pour les autres', async () => {
    const results = await cycle();
    expect(results.map((r) => [r.routerId, r.status]).sort()).toEqual(
      [
        [r1.id, 'ONLINE'],
        [r2.id, 'OFFLINE'],
        [rb.id, 'OFFLINE'],
      ].sort(),
    );
    const { rows } = await t.migrator.query<{
      router_id: string;
      status: string;
      cpu_load: number | null;
      total_memory: string | null;
      uptime_seconds: string | null;
    }>('select * from router_metrics order by sampled_at');
    expect(rows).toHaveLength(3);
    expect(rows.find((r) => r.router_id === r1.id)).toMatchObject({
      status: 'ONLINE',
      cpu_load: 7,
      total_memory: '1073741824',
      uptime_seconds: '788645',
    });
    expect(rows.find((r) => r.router_id === r2.id)).toMatchObject({
      status: 'OFFLINE',
      cpu_load: null,
    });
    expect(await openAlerts(r1.id)).toEqual([]);
    expect(await openAlerts(r2.id)).toEqual(['ROUTER_OFFLINE']);
    expect(await openAlerts(rb.id)).toEqual(['ROUTER_OFFLINE']);
    const { rows: details } = await t.migrator.query<{ severity: string; details: unknown }>(
      'select severity, details from alerts where router_id = $1',
      [r2.id],
    );
    expect(details[0]).toEqual({
      severity: 'CRITICAL',
      details: { consecutiveFailures: 1, lastError: 'UNREACHABLE: Délai dépassé (aucune réponse)' },
    });
  });

  it('cycles suivants : une seule alerte ouverte par routeur et par type', async () => {
    await cycle();
    await cycle();
    const { rows } = await t.migrator.query<{ n: string }>(
      'select count(*) as n from alerts where router_id = $1',
      [r2.id],
    );
    expect(Number(rows[0]?.n)).toBe(1);
    expect(Number((await t.migrator.query('select 1 from router_metrics')).rowCount)).toBe(9);
  });

  it('CPU élevé soutenu : CPU_HIGH ouverte après 3 mesures, résolue après la baisse', async () => {
    FAKE_RESOURCE['cpu-load'] = '97';
    await cycle();
    await cycle();
    expect(await openAlerts(r1.id)).toEqual([]); // 2 mesures élevées seulement
    await cycle();
    expect(await openAlerts(r1.id)).toEqual(['CPU_HIGH']);
    const { rows } = await t.migrator.query<{ details: unknown }>(
      "select details from alerts where router_id = $1 and type = 'CPU_HIGH'",
      [r1.id],
    );
    expect(rows[0]?.details).toEqual({
      cpuLoad: 97,
      threshold: DEFAULT_ALERT_THRESHOLDS.cpuHighPercent,
    });
    FAKE_RESOURCE['cpu-load'] = '85'; // sous le seuil mais dans l'hystérésis
    await cycle();
    expect(await openAlerts(r1.id)).toEqual(['CPU_HIGH']);
    FAKE_RESOURCE['cpu-load'] = '7';
    await cycle();
    expect(await openAlerts(r1.id)).toEqual([]);
    expect(logs.some((m) => m.includes('alerte CPU_HIGH ouverte'))).toBe(true);
    expect(logs.some((m) => m.includes('alerte CPU_HIGH résolue'))).toBe(true);
  });

  it('panne de R1 : DEGRADED après 3 échecs, OFFLINE après 180 s, tout résolu au retour', async () => {
    reachable = false;
    const lastSeen = (
      await t.migrator.query<{ last_seen_at: Date }>(
        'select last_seen_at from routers where id = $1',
        [r1.id],
      )
    ).rows[0]?.last_seen_at;
    const states: string[][] = [];
    for (const offset of [30, 60, 90, 200]) {
      clock = new Date((lastSeen?.getTime() ?? Date.now()) + offset * 1000);
      await cycle();
      states.push(await openAlerts(r1.id));
    }
    expect(states).toEqual([[], [], ['ROUTER_DEGRADED'], ['ROUTER_OFFLINE']]);
    reachable = true;
    clock = new Date();
    await cycle();
    expect(await openAlerts(r1.id)).toEqual([]);
    const { rows } = await t.migrator.query<{ type: string; resolved: boolean }>(
      "select type, resolved_at is not null as resolved from alerts where router_id = $1 and type like 'ROUTER_%' order by opened_at",
      [r1.id],
    );
    expect(rows).toEqual([
      { type: 'ROUTER_DEGRADED', resolved: true },
      { type: 'ROUTER_OFFLINE', resolved: true },
    ]);
  });

  it('aucun secret dans les mesures, les alertes ni les journaux', async () => {
    const dump = JSON.stringify([
      (await t.migrator.query('select * from router_metrics')).rows,
      (await t.migrator.query('select * from alerts')).rows,
      logs,
    ]);
    expect(dump).not.toContain(ROUTEROS_PASSWORD);
  });
});

describe('RLS et privilèges des nouvelles tables', () => {
  const ctxA = () => ({ companyId: t.seed.companies.A, userId: t.seed.users['admin.a@ecsi.test'] });
  const alertOf = async (routerId: string) =>
    (
      await t.migrator.query<{ id: string }>(
        'select id from alerts where router_id = $1 and resolved_at is null limit 1',
        [routerId],
      )
    ).rows[0]?.id ?? '';

  it('ecsi_app : chaque entreprise ne lit que ses mesures et ses alertes ; sans contexte, rien', async () => {
    await as(infra.urls.app, ctxA(), async (c) => {
      const metrics = (await c.query<{ router_id: string }>('select router_id from router_metrics'))
        .rows;
      const alertRows = (await c.query<{ router_id: string }>('select router_id from alerts')).rows;
      expect(metrics.length).toBeGreaterThan(0);
      expect(metrics.every((r) => r.router_id !== rb.id)).toBe(true);
      expect(alertRows.every((r) => r.router_id !== rb.id)).toBe(true);
    });
    await as(infra.urls.app, { companyId: t.seed.companies.B }, async (c) => {
      const ids = (await c.query<{ router_id: string }>('select router_id from alerts')).rows;
      expect(ids.map((r) => r.router_id)).toEqual([rb.id]);
    });
    await as(infra.urls.app, null, async (c) => {
      expect((await c.query('select 1 from router_metrics')).rowCount).toBe(0);
      expect((await c.query('select 1 from alerts')).rowCount).toBe(0);
    });
  });

  it('ecsi_app : ni écriture de mesure ou d’alerte, ni résolution, ni suppression', async () => {
    const alertId = await alertOf(r2.id);
    for (const statement of [
      [
        "insert into router_metrics (company_id, router_id, status) values ($1, $2, 'ONLINE')",
        [t.seed.companies.A, r2.id],
      ],
      [
        "insert into alerts (company_id, router_id, type, severity) values ($1, $2, 'CPU_HIGH', 'WARNING')",
        [t.seed.companies.A, r2.id],
      ],
      ['update alerts set resolved_at = now() where id = $1', [alertId]],
      ['delete from alerts where id = $1', [alertId]],
      ['delete from router_metrics where router_id = $1', [r2.id]],
    ] as const) {
      expect(
        await sqlError(as(infra.urls.app, ctxA(), (c) => c.query(statement[0], [...statement[1]]))),
        statement[0],
      ).toBe('42501');
    }
  });

  it('ecsi_app : acquittement au nom de l’utilisateur de la transaction seulement, une fois', async () => {
    const alertId = await alertOf(r2.id);
    const other = t.seed.users['gerant.a@ecsi.test'];
    expect(
      await sqlError(
        as(infra.urls.app, ctxA(), (c) =>
          c.query('update alerts set acknowledged_at = now(), acknowledged_by = $2 where id = $1', [
            alertId,
            other,
          ]),
        ),
      ),
    ).toBe('42501');
    await as(infra.urls.app, ctxA(), async (c) => {
      const ok = await c.query(
        'update alerts set acknowledged_at = now(), acknowledged_by = $2 where id = $1',
        [alertId, ctxA().userId],
      );
      expect(ok.rowCount).toBe(1);
      const again = await c.query(
        'update alerts set acknowledged_at = now(), acknowledged_by = $2 where id = $1',
        [alertId, ctxA().userId],
      );
      expect(again.rowCount).toBe(0);
    });
    // Alerte de B depuis le contexte A : invisible, aucune ligne modifiée.
    const alertB = await alertOf(rb.id);
    await as(infra.urls.app, ctxA(), async (c) => {
      const result = await c.query(
        'update alerts set acknowledged_at = now(), acknowledged_by = $2 where id = $1',
        [alertB, ctxA().userId],
      );
      expect(result.rowCount).toBe(0);
    });
  });

  it('ecsi_worker : écrit pour les routeurs supervisés seulement, n’acquitte ni ne rouvre', async () => {
    const alertId = await alertOf(r2.id);
    for (const [statement, params] of [
      // Horodatage imposé par la base (colonne non accordée).
      [
        "insert into router_metrics (company_id, router_id, status, sampled_at) values ($1, $2, 'ONLINE', now() - interval '30 days')",
        [t.seed.companies.A, r2.id],
      ],
      // Entreprise qui n'est pas celle du routeur.
      [
        "insert into router_metrics (company_id, router_id, status) values ($1, $2, 'ONLINE')",
        [t.seed.companies.B, r2.id],
      ],
      [
        "insert into alerts (company_id, router_id, type, severity, acknowledged_at) values ($1, $2, 'CPU_HIGH', 'WARNING', now())",
        [t.seed.companies.A, r2.id],
      ],
      ['update alerts set acknowledged_at = now() where id = $1', [alertId]],
      ['update alerts set opened_at = now() where id = $1', [alertId]],
    ] as const) {
      expect(
        await sqlError(as(infra.urls.worker, null, (c) => c.query(statement, [...params]))),
        statement,
      ).toBe('42501');
    }
    // Doublon d'alerte ouverte : refusé par l'index unique partiel.
    expect(
      await sqlError(
        as(infra.urls.worker, null, (c) =>
          c.query(
            "insert into alerts (company_id, router_id, type, severity) values ($1, $2, 'ROUTER_OFFLINE', 'CRITICAL')",
            [t.seed.companies.A, r2.id],
          ),
        ),
      ),
    ).toBe('23505');
    // Routeur supprimé (invisible pour le worker) : aucune écriture.
    await t.migrator.query('update routers set deleted_at = now() where id = $1', [r2.id]);
    try {
      expect(
        await sqlError(
          as(infra.urls.worker, null, (c) =>
            c.query(
              "insert into router_metrics (company_id, router_id, status) values ($1, $2, 'OFFLINE')",
              [t.seed.companies.A, r2.id],
            ),
          ),
        ),
      ).toBe('42501');
    } finally {
      await t.migrator.query('update routers set deleted_at = null where id = $1', [r2.id]);
    }
    await as(infra.urls.worker, null, async (c) => {
      // Une alerte résolue ne se rouvre pas ; une mesure récente ne se supprime pas.
      const reopened = await c.query(
        'update alerts set resolved_at = null where resolved_at is not null',
      );
      expect(reopened.rowCount).toBe(0);
      const deleted = await c.query('delete from router_metrics');
      expect(deleted.rowCount).toBe(0);
    });
  });

  it('purge : mesures et alertes résolues anciennes supprimées, données récentes conservées', async () => {
    const before = Number((await t.migrator.query('select 1 from router_metrics')).rowCount);
    await t.migrator.query(
      `insert into router_metrics (company_id, router_id, status, sampled_at)
       select $1, $2, 'ONLINE', now() - make_interval(days => 8) - make_interval(mins => g)
         from generate_series(1, 30) g`,
      [t.seed.companies.A, r1.id],
    );
    await t.migrator.query(
      `insert into alerts (company_id, router_id, type, severity, opened_at, resolved_at)
       values ($1, $2, 'MEMORY_HIGH', 'WARNING', now() - interval '120 days', now() - interval '100 days')`,
      [t.seed.companies.A, r1.id],
    );
    expect(await recorder().purge()).toEqual({ metrics: 30, alerts: 1 });
    expect(Number((await t.migrator.query('select 1 from router_metrics')).rowCount)).toBe(before);
    expect(await recorder().purge()).toEqual({ metrics: 0, alerts: 0 });
  });
});

describe('API /monitoring (sessions, permissions par site, audit)', () => {
  it('vue d’ensemble : routeurs et alertes de l’entreprise seulement', async () => {
    const response = await adminA.get('/monitoring/overview');
    expect(response.statusCode, response.body).toBe(200);
    const overview = response.json<MonitoringOverview>();
    expect(overview.routers).toMatchObject({ total: 2, ONLINE: 1, OFFLINE: 1 });
    expect(overview.items.map((i) => i.name)).toEqual(['R1 Riviera', 'R2 Selmer']);
    expect(overview.items.find((i) => i.id === r1.id)).toMatchObject({
      status: 'ONLINE',
      cpuLoad: 7,
      memoryUsedPercent: 16,
      openAlerts: 0,
    });
    expect(overview.items.find((i) => i.id === r2.id)?.openAlerts).toBe(1);
    // L'alerte de R2 a été acquittée par le test RLS (transaction annulée) : toujours ouverte.
    expect(overview.alerts).toEqual({ open: 1, unacknowledged: 1, critical: 1 });
    expect(JSON.stringify(overview)).not.toContain(rb.id);

    const b = (await adminB.get('/monitoring/overview')).json<MonitoringOverview>();
    expect(b.items.map((i) => i.id)).toEqual([rb.id]);
  });

  it('portée par site : un gérant de SITE-A ne voit que R1 ; sans monitoring.read : 403', async () => {
    const overview = (await gerantSiteA.get('/monitoring/overview')).json<MonitoringOverview>();
    expect(overview.items.map((i) => i.id)).toEqual([r1.id]);
    expect(overview.alerts.open).toBe(0);
    const alerts = (await gerantSiteA.get('/monitoring/alerts?state=all')).json<Alert[]>();
    expect(alerts.length).toBeGreaterThan(0);
    expect(alerts.every((a) => a.router.id === r1.id)).toBe(true);
    for (const url of [
      '/monitoring/overview',
      '/monitoring/alerts',
      '/monitoring/alerts/summary',
    ]) {
      expect((await vendeurSiteB.get(url)).statusCode, url).toBe(403);
    }
  });

  it('liste des alertes : ouvertes par défaut, filtres et validation', async () => {
    const open = (await adminA.get('/monitoring/alerts')).json<Alert[]>();
    expect(open.map((a) => [a.router.name, a.type, a.severity])).toEqual([
      ['R2 Selmer', 'ROUTER_OFFLINE', 'CRITICAL'],
    ]);
    expect(open[0]).toMatchObject({
      site: { code: 'SITE-B' },
      resolvedAt: null,
      acknowledgedAt: null,
      acknowledgedBy: null,
    });
    const resolved = (await adminA.get(`/monitoring/alerts?state=resolved&routerId=${r1.id}`)).json<
      Alert[]
    >();
    expect(resolved.map((a) => a.type).sort()).toEqual([
      'CPU_HIGH',
      'ROUTER_DEGRADED',
      'ROUTER_OFFLINE',
    ]);
    expect(resolved.every((a) => a.resolvedAt !== null)).toBe(true);
    expect((await adminA.get('/monitoring/alerts?state=bientot')).statusCode).toBe(422);
    expect((await adminA.get('/monitoring/alerts?limit=1000')).statusCode).toBe(422);
    expect((await adminA.get('/monitoring/alerts?companyId=x')).statusCode).toBe(422);
  });

  it('historique d’un routeur : points agrégés, portée vérifiée', async () => {
    const response = await adminA.get(`/monitoring/routers/${r1.id}/metrics?hours=1`);
    expect(response.statusCode, response.body).toBe(200);
    const metrics = response.json<RouterMetrics>();
    expect(metrics).toMatchObject({ routerId: r1.id, hours: 1, bucketSeconds: 60 });
    const samples = metrics.points.reduce((sum, p) => sum + p.samples, 0);
    expect(samples).toBeGreaterThanOrEqual(10);
    // Tous les cycles du test tombent dans le même intervalle d'une minute ou deux : moyennes.
    expect(metrics.points.some((p) => p.cpuLoad !== null && p.cpuLoad > 7)).toBe(true);
    expect(metrics.points.some((p) => p.memoryUsedPercent !== null)).toBe(true);
    expect(metrics.points.some((p) => p.availability !== null && p.availability < 1)).toBe(true);
    expect((await adminA.get(`/monitoring/routers/${r1.id}/metrics?hours=500`)).statusCode).toBe(
      422,
    );
    expect((await adminB.get(`/monitoring/routers/${r1.id}/metrics`)).statusCode).toBe(404);
    expect((await gerantSiteA.get(`/monitoring/routers/${r2.id}/metrics`)).statusCode).toBe(404);
    expect((await gerantSiteA.get(`/monitoring/routers/${r1.id}/metrics`)).statusCode).toBe(200);
  });

  it('acquittement : portée, permission, audit, une seule fois', async () => {
    const [alert] = (await adminA.get('/monitoring/alerts')).json<Alert[]>();
    if (!alert) throw new Error('alerte attendue');
    // Autre entreprise, autre site : 404 (comme une alerte inexistante) ; vendeur : 403.
    expect((await adminB.post(`/monitoring/alerts/${alert.id}/acknowledge`)).statusCode).toBe(404);
    expect((await gerantSiteA.post(`/monitoring/alerts/${alert.id}/acknowledge`)).statusCode).toBe(
      404,
    );
    expect((await vendeurSiteB.post(`/monitoring/alerts/${alert.id}/acknowledge`)).statusCode).toBe(
      403,
    );
    expect(await auditCount('monitoring.alert.acknowledge', 'DENIED', alert.id)).toBe(1);

    const response = await adminA.post(`/monitoring/alerts/${alert.id}/acknowledge`);
    expect(response.statusCode, response.body).toBe(200);
    const acknowledged = response.json<Alert>();
    expect(acknowledged.acknowledgedAt).not.toBeNull();
    expect(acknowledged.acknowledgedBy).toEqual({
      id: t.seed.users['admin.a@ecsi.test'],
      fullName: 'Awa Admin (A)',
    });
    expect(await auditCount('monitoring.alert.acknowledge', 'SUCCESS', alert.id)).toBe(1);
    const { rows } = await t.migrator.query<{ details: Record<string, unknown>; site_id: string }>(
      "select details, site_id from audit_events where action = 'monitoring.alert.acknowledge' and result = 'SUCCESS'",
    );
    expect(rows[0]).toMatchObject({
      site_id: site('A', 'SITE-B'),
      details: { type: 'ROUTER_OFFLINE', router: 'R2 Selmer', resolved: false },
    });

    const again = await adminA.post(`/monitoring/alerts/${alert.id}/acknowledge`);
    expect(again.statusCode).toBe(409);
    expect(await auditCount('monitoring.alert.acknowledge', 'SUCCESS', alert.id)).toBe(1);

    const summary = (await adminA.get('/monitoring/alerts/summary')).json<AlertSummary>();
    expect(summary).toEqual({ open: 1, unacknowledged: 0, critical: 1 });
  });

  it('acquittement sans jeton CSRF : refusé', async () => {
    const [alert] = (await adminB.get('/monitoring/alerts')).json<Alert[]>();
    const response = await adminB.post(
      `/monitoring/alerts/${alert?.id ?? ''}/acknowledge`,
      undefined,
      {
        csrf: false,
      },
    );
    expect(response.statusCode).toBe(403);
  });

  it('routeur retiré : ses alertes disparaissent de la supervision', async () => {
    expect((await adminA.delete(`/routers/${r2.id}`)).statusCode).toBe(204);
    const overview = (await adminA.get('/monitoring/overview')).json<MonitoringOverview>();
    expect(overview.items.map((i) => i.id)).toEqual([r1.id]);
    expect(overview.alerts).toEqual({ open: 0, unacknowledged: 0, critical: 0 });
    expect(
      (await adminA.get('/monitoring/alerts?state=all'))
        .json<Alert[]>()
        .every((a) => a.router.id === r1.id),
    ).toBe(true);
    expect((await adminA.get(`/monitoring/routers/${r2.id}/metrics`)).statusCode).toBe(404);
  });
});
