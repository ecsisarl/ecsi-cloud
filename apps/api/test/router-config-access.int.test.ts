/**
 * Lot B — compte d'écriture ecsi-cfg et provisionnement Hotspot, sur PostgreSQL 18 réel, Redis
 * réel et rôles réels : migration 0009 (privileges par colonne, RLS, fonctions SECURITY
 * DEFINER), API GET/POST /routers/:id/config-access (permission, audit sans jeton), activation
 * par l'agent passerelle (ActivationServer + pgConfigActivationStore, rôle ecsi_worker), puis
 * réconciliation par le worker (HotspotProvisioner, rôle ecsi_worker) et entretien RADIUS.
 * Le routeur est SIMULÉ (faux REST à état, test/helpers/fake-routeros.ts) ; le même parcours
 * sur un vrai RouterOS : lab/routeros/resultats/2026-10-19-lot-b-provisioning.md.
 */
import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { PassThrough } from 'node:stream';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Router, RouterConfigAccess, RouterConfigAccessScript } from '@ecsi/shared';
import { SecretBox } from '../src/auth/crypto/secret-box.js';
import * as schema from '../src/database/schema/index.js';
import { nasSecret } from '../src/hotspot/radius-keys.js';
import { ActivationServer } from '../src/routers/gateway/activation-server.js';
import {
  pgActivationStore,
  pgConfigActivationStore,
} from '../src/routers/gateway/gateway.module.js';
import { HotspotProvisioner } from '../src/routers/provisioning/provisioner.js';
import {
  decryptRouterConfigPassword,
  rotateRouterConfigSecrets,
  rotateRouterSecrets,
} from '../src/routers/router-secret.js';
import { keyStatus, verifyEncryptionKeys } from '../src/auth/key-verification.js';
import { RestWriter, type WriterFactory } from '../src/routers/routeros/writer.js';
import { parseTunnelNetwork } from '../src/routers/tunnel-ip.js';
import {
  type FakeRestStore,
  makeCertificate,
  startFakeRestStore,
  type TestCertificate,
} from './helpers/fake-routeros.js';
import {
  enrollMfa,
  type HttpClient,
  loginAs,
  startTestApp,
  TEST_SECRETS,
  type TestApp,
} from './helpers/app.js';
import { startInfra, type TestInfra } from './helpers/infra.js';

const GW_PUBLIC_KEY = 'devonlyWireGuardPublicKeyForTests000000000A=';
const ROUTER_WG_KEY = `${'R'.repeat(42)}A=`;
const CFG_PASSWORD = 'devonly-cfg-password-0123456789abcdef';
const TUNNEL_IP = '10.200.0.21';
const network = parseTunnelNetwork('10.200.0.0/24', '10.200.0.1');
const box = new SecretBox(TEST_SECRETS.encryptionKey, { id: 'k1' });
// Clé NAS de test tirée à l'exécution (aucun secret dans le dépôt).
const NAS_KEY = randomBytes(32).toString('hex');

let infra: TestInfra;
let t: TestApp;
let adminA: HttpClient;
let gerantA: HttpClient;
let adminB: HttpClient;
let workerPool: pg.Pool;
let superPool: pg.Pool;
let routerId: string;
let bareRouterId: string;
let certificate: TestCertificate;
let store: FakeRestStore;
let gateway: ActivationServer;
let script: RouterConfigAccessScript;

const site = (code: string) => t.seed.sites.A[code] ?? '';
const tokenOf = (text: string) => /:local ecsiToken "([A-Za-z0-9_-]{43})"/.exec(text)?.[1] ?? '';

async function sqlError(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return (error as { code?: string }).code ?? 'inconnu';
  }
  return 'aucune erreur';
}

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
    return await work(client);
  } finally {
    await client.query('rollback').catch(() => undefined);
    client.release();
    await pool.end();
  }
}

/** Requête de l'agent passerelle telle qu'envoyée par /tool/fetch depuis l'adresse tunnel. */
async function activate(source: string, body: unknown) {
  const req = new PassThrough() as unknown as IncomingMessage & PassThrough;
  Object.assign(req, {
    method: 'POST',
    url: '/activate-config',
    headers: { 'content-type': 'application/json' },
    socket: { remoteAddress: source },
  });
  let status = 0;
  const res = {
    headersSent: false,
    writeHead(code: number) {
      status = code;
      res.headersSent = true;
      return res;
    },
    end() {
      return undefined;
    },
  };
  const done = gateway.handle(req, res as unknown as ServerResponse);
  req.end(JSON.stringify(body));
  await done;
  return status;
}

const auditRows = async (action: string) =>
  (
    await t.migrator.query<{ result: string; actor_type: string; details: unknown }>(
      'select result, actor_type, details from audit_events where action = $1 order by occurred_at',
      [action],
    )
  ).rows;

const hotspotRow = async (id: string) =>
  (
    await superPool.query<{
      sync_status: string;
      applied_version: number | null;
      config_version: number;
      last_error: string | null;
    }>(
      'select sync_status, applied_version, config_version, last_error from hotspots where id = $1',
      [id],
    )
  ).rows[0];

/** Fabrique de test : même RestWriter (liste blanche, épinglage), joint au faux routeur local. */
const localWriters: WriterFactory = (target, credentials) =>
  new RestWriter(
    { host: '127.0.0.1', port: store.port },
    target.tlsFingerprint ?? '',
    credentials,
    { network, routerTunnelIp: target.tunnelIp },
  );

function provisioner() {
  return new HotspotProvisioner(
    drizzle(workerPool, { schema, casing: 'snake_case' }),
    box,
    localWriters,
    network,
    NAS_KEY,
  );
}

beforeAll(async () => {
  infra = await startInfra();
  t = await startTestApp(infra, {
    WG_GATEWAY_PUBLIC_KEY: GW_PUBLIC_KEY,
    WG_GATEWAY_ENDPOINT: 'vpn.ecsi.test',
    ROUTER_ENROLL_PUBLIC_URL: 'https://cloud.ecsi.test/api/v1/routers/enroll',
  });
  adminA = await loginAs(t.app, 'admin.a@ecsi.test');
  await enrollMfa(adminA);
  adminB = await loginAs(t.app, 'admin.b@ecsi.test');
  await enrollMfa(adminB);
  gerantA = await loginAs(t.app, 'gerant.a@ecsi.test');
  workerPool = new pg.Pool({ connectionString: infra.urls.worker, max: 2 });
  superPool = new pg.Pool({ connectionString: infra.urls.superuser, max: 2 });
  certificate = makeCertificate();
  store = await startFakeRestStore({ username: 'ecsi-cfg', password: CFG_PASSWORD, certificate });
  gateway = new ActivationServer(
    pgActivationStore(workerPool),
    box,
    network,
    { log: () => undefined, warn: () => undefined },
    Date.now,
    pgConfigActivationStore(workerPool),
  );

  const create = async (name: string, tunnelIp: string) => {
    const response = await adminA.post('/routers', {
      siteId: site('SITE-A'),
      name,
      tunnelIp,
      transport: 'API',
      routerosUsername: 'ecsi-svc',
      routerosPassword: 'devonly-svc-password-0123456789',
    });
    expect(response.statusCode, response.body).toBe(201);
    return response.json<Router>().id;
  };
  routerId = await create('CHR-HOTSPOT', TUNNEL_IP);
  bareRouterId = await create('SANS-TUNNEL', '10.200.0.22');
  // Routeur enrôlé et en ligne (comme après l'enrôlement du Sprint 3B).
  await superPool.query(
    `update routers set wg_public_key = $2, tls_fingerprint = $3, status = 'ONLINE'
      where id = $1`,
    [routerId, ROUTER_WG_KEY, certificate.fingerprint],
  );
}, 180_000);

afterAll(async () => {
  await store.close();
  await workerPool.end();
  await superPool.end();
  await t.close();
  await infra.stop();
});

describe('API config-access', () => {
  it('état initial NONE', async () => {
    const response = await adminA.get(`/routers/${routerId}/config-access`);
    expect(response.statusCode).toBe(200);
    expect(response.json<RouterConfigAccess>()).toEqual({
      status: 'NONE',
      activatedAt: null,
      expiresAt: null,
    });
  });

  it('création réservée à routers.command.dangerous ; autre entreprise : 404', async () => {
    expect((await gerantA.post(`/routers/${routerId}/config-access`, {})).statusCode).toBe(403);
    expect((await adminB.post(`/routers/${routerId}/config-access`, {})).statusCode).toBe(404);
    expect((await adminB.get(`/routers/${routerId}/config-access`)).statusCode).toBe(404);
    // Routeur non enrôlé (pas de clé WireGuard) : 409.
    expect((await adminA.post(`/routers/${bareRouterId}/config-access`, {})).statusCode).toBe(409);
  });

  it('émet un script à usage unique ; état PENDING ; audit sans jeton ni script', async () => {
    const response = await adminA.post(`/routers/${routerId}/config-access`, {});
    expect(response.statusCode, response.body).toBe(201);
    script = response.json<RouterConfigAccessScript>();
    expect(Object.keys(script).sort()).toEqual(['expiresAt', 'script']);
    const token = tokenOf(script.script);
    expect(token).toHaveLength(43);
    expect(script.script).toContain(`:local tunnelAddress "${TUNNEL_IP}/24"`);
    expect(script.script).toContain('http://10.200.0.1:');
    const state = (
      await adminA.get(`/routers/${routerId}/config-access`)
    ).json<RouterConfigAccess>();
    expect(state).toEqual({ status: 'PENDING', activatedAt: null, expiresAt: script.expiresAt });
    const audits = await auditRows('routers.config_access.create');
    expect(audits.filter((a) => a.result === 'SUCCESS')).toHaveLength(1);
    expect(JSON.stringify(audits)).not.toContain(token);
    expect(JSON.stringify(audits)).toContain('read,write,api,rest-api');
    // Jeton stocké haché seulement.
    const row = (
      await superPool.query<{ token_hash: Buffer; password_encrypted: string | null }>(
        'select token_hash, password_encrypted from router_config_accounts where router_id = $1',
        [routerId],
      )
    ).rows[0];
    expect(row?.token_hash).toHaveLength(32);
    expect(row?.token_hash.toString('utf8')).not.toContain(token);
    expect(row?.password_encrypted).toBeNull();
  });
});

describe('migration 0009 : privilèges et isolation', () => {
  it('ecsi_app : ni chiffré ni empreinte de jeton, aucune fonction d’activation', async () => {
    const companyA = t.seed.companies.A;
    await as(infra.urls.app, companyA, async (c) => {
      expect(
        (
          await c.query(
            'select router_id, username, activated_at, token_expires_at from router_config_accounts',
          )
        ).rowCount,
      ).toBe(1);
      await c.query('savepoint s');
      expect(await sqlError(c.query('select password_encrypted from router_config_accounts'))).toBe(
        '42501',
      );
      await c.query('rollback to savepoint s');
      expect(await sqlError(c.query('select token_hash from router_config_accounts'))).toBe(
        '42501',
      );
      await c.query('rollback to savepoint s');
      expect(
        await sqlError(c.query("update router_config_accounts set password_encrypted = 'x'")),
      ).toBe('42501');
      await c.query('rollback to savepoint s');
      expect(
        await sqlError(
          c.query("select * from app.router_config_target('10.200.0.21'::inet, '\\x00'::bytea)"),
        ),
      ).toBe('42501');
    });
    await as(infra.urls.app, t.seed.companies.B, async (c) => {
      expect((await c.query('select router_id from router_config_accounts')).rowCount).toBe(0);
    });
    await as(infra.urls.auth, null, async (c) => {
      expect(await sqlError(c.query('select router_id from router_config_accounts'))).toBe('42501');
    });
    await as(infra.urls.radius, null, async (c) => {
      expect(await sqlError(c.query('select router_id from router_config_accounts'))).toBe('42501');
    });
  });

  it('ecsi_worker : aucune écriture directe, jeton jamais lisible', async () => {
    await as(infra.urls.worker, null, async (c) => {
      await c.query('savepoint s');
      expect(await sqlError(c.query('select token_hash from router_config_accounts'))).toBe(
        '42501',
      );
      await c.query('rollback to savepoint s');
      expect(await sqlError(c.query("update router_config_accounts set username = 'admin'"))).toBe(
        '42501',
      );
      await c.query('rollback to savepoint s');
      // Compte pas encore activé : invisible du worker.
      expect(
        (
          await c.query('select router_id from router_config_accounts where router_id = $1', [
            routerId,
          ])
        ).rowCount,
      ).toBe(0);
    });
  });
});

describe('activation par le tunnel (agent passerelle, rôle ecsi_worker)', () => {
  it('mauvaise source ou mauvais jeton : refus audité, rien activé', async () => {
    const token = tokenOf(script.script);
    const body = { token, user: 'ecsi-cfg', password: CFG_PASSWORD };
    expect(await activate('10.200.0.22', body)).toBe(409);
    expect(await activate(TUNNEL_IP, { ...body, token: 'Z'.repeat(43) })).toBe(409);
    const denied = await auditRows('router.config_access.activation');
    expect(denied.map((a) => a.result)).toEqual(['DENIED', 'DENIED']);
    expect(JSON.stringify(denied)).not.toContain(CFG_PASSWORD);
    expect(JSON.stringify(denied)).not.toContain(token);
  });

  it('active, chiffre pour ce routeur, consomme le jeton ; rejeu refusé', async () => {
    const body = { token: tokenOf(script.script), user: 'ecsi-cfg', password: CFG_PASSWORD };
    expect(await activate(`::ffff:${TUNNEL_IP}`, body)).toBe(200);
    const row = (
      await superPool.query<{
        username: string;
        password_encrypted: string;
        token_hash: Buffer | null;
        activated_at: Date | null;
      }>('select * from router_config_accounts where router_id = $1', [routerId])
    ).rows[0];
    expect(row?.username).toBe('ecsi-cfg');
    expect(row?.token_hash).toBeNull();
    expect(row?.activated_at).toBeInstanceOf(Date);
    expect(row?.password_encrypted).toMatch(/^v2:k1:/);
    expect(
      decryptRouterConfigPassword(
        box,
        { companyId: t.seed.companies.A, routerId },
        row?.password_encrypted ?? '',
      ),
    ).toBe(CFG_PASSWORD);
    expect(await activate(TUNNEL_IP, body)).toBe(409);
    const ok = await auditRows('router.config_access.activated');
    expect(ok).toEqual([expect.objectContaining({ result: 'SUCCESS', actor_type: 'SYSTEM' })]);
    expect(JSON.stringify(ok)).not.toContain(CFG_PASSWORD);
    const state = (
      await adminA.get(`/routers/${routerId}/config-access`)
    ).json<RouterConfigAccess>();
    expect(state.status).toBe('ACTIVE');
    expect(state.expiresAt).toBeNull();
  });

  it('ecsi_worker lit le compte d’un routeur actif, pas d’un routeur en PROVISIONING', async () => {
    const read = () =>
      workerPool.query(
        'select password_encrypted from router_config_accounts where router_id = $1',
        [routerId],
      );
    expect((await read()).rowCount).toBe(1);
    await superPool.query("update routers set status = 'PROVISIONING' where id = $1", [routerId]);
    expect((await read()).rowCount).toBe(0);
    await superPool.query("update routers set status = 'ONLINE' where id = $1", [routerId]);
  });
});

describe('provisionnement Hotspot par le worker (routeur REST simulé)', () => {
  let hotspotId: string;

  beforeAll(async () => {
    store.seed('interface', { name: 'ether1', type: 'ether' });
    store.seed('interface', { name: 'ether2', type: 'ether' });
    store.seed('interface', { name: 'ecsi-wg', type: 'wg' });
    store.seed('ip/route', {
      'dst-address': '0.0.0.0/0',
      gateway: '192.168.88.1',
      'immediate-gw': '192.168.88.1%ether1',
    });
    store.seed('ip/address', { address: '192.168.88.11/24', interface: 'ether1' });
    store.seed('ip/address', {
      address: `${TUNNEL_IP}/24`,
      interface: 'ecsi-wg',
      comment: 'ecsi-cloud',
    });
    const { rows } = await superPool.query<{ id: string }>(
      `insert into hotspots (company_id, site_id, router_id, name, interface, gateway_address,
                             pool_start, pool_end, dns_name)
       values ($1, $2, $3, 'Wifi clients', 'ether2', '10.5.50.1/24', '10.5.50.10', '10.5.50.200',
               'wifi.ecsi.lan')
       returning id`,
      [t.seed.companies.A, site('SITE-A'), routerId],
    );
    hotspotId = rows[0]?.id ?? '';
  });

  it('PENDING -> SYNCED : objets créés, secret RADIUS dérivé (jamais en base)', async () => {
    const results = await provisioner().runCycle();
    expect(results).toEqual([
      expect.objectContaining({ hotspotId, status: 'SYNCED', error: null }),
    ]);
    expect(results[0]?.report).toMatchObject({ added: 9, updated: 0, removed: 0 });
    expect(await hotspotRow(hotspotId)).toMatchObject({
      sync_status: 'SYNCED',
      applied_version: 1,
      last_error: null,
    });
    const radius = store.menus.get('radius') ?? [];
    expect(radius).toEqual([
      expect.objectContaining({ address: '10.200.0.1', 'src-address': TUNNEL_IP }),
    ]);
    expect(store.secrets.get(`radius/${radius[0]?.['.id'] ?? ''}`)).toBe(
      nasSecret(NAS_KEY, routerId, 1),
    );
    // Rien à faire au cycle suivant.
    expect(await provisioner().runCycle()).toEqual([]);
  });

  it('erreur de contrôle préalable : ERROR, message sans secret, rien écrit', async () => {
    const writes = store.writes().length;
    await superPool.query(
      `update hotspots set interface = 'ether1', sync_status = 'PENDING',
                           config_version = config_version + 1 where id = $1`,
      [hotspotId],
    );
    const [result] = await provisioner().runCycle();
    expect(result?.status).toBe('ERROR');
    const row = await hotspotRow(hotspotId);
    expect(row?.sync_status).toBe('ERROR');
    expect(row?.last_error).toContain('route par défaut');
    expect(row?.last_error).not.toContain(CFG_PASSWORD);
    expect(row?.last_error).not.toContain(nasSecret(NAS_KEY, routerId, 1));
    expect(store.writes().length).toBe(writes);
    // Pas de nouvelle tentative avant le délai.
    expect(await provisioner().runCycle()).toEqual([]);
  });

  it('identifiants refusés par le routeur : ERROR AUTH, mot de passe masqué', async () => {
    await store.close();
    store = await startFakeRestStore({
      username: 'ecsi-cfg',
      password: 'devonly-autre-mot-de-passe-0000',
      certificate,
    });
    await superPool.query(
      `update hotspots set interface = 'ether2', sync_status = 'PENDING',
                           config_version = config_version + 1 where id = $1`,
      [hotspotId],
    );
    const [result] = await provisioner().runCycle();
    expect(result?.status).toBe('ERROR');
    expect(result?.error).toMatch(/^AUTH:/);
    expect(result?.error).not.toContain(CFG_PASSWORD);
  });

  it('désactivation puis suppression : tout est retiré du routeur', async () => {
    await store.close();
    store = await startFakeRestStore({ username: 'ecsi-cfg', password: CFG_PASSWORD, certificate });
    store.seed('interface', { name: 'ether2', type: 'ether' });
    await superPool.query(
      `update hotspots set sync_status = 'PENDING', config_version = config_version + 1
        where id = $1`,
      [hotspotId],
    );
    expect((await provisioner().runCycle())[0]?.report).toMatchObject({ added: 9 });
    await superPool.query(
      `update hotspots set desired_state = 'DISABLED', deleted_at = now(), sync_status = 'PENDING',
                           config_version = config_version + 1 where id = $1`,
      [hotspotId],
    );
    const [result] = await provisioner().runCycle();
    expect(result?.report).toMatchObject({ added: 0, removed: 9 });
    const row = await hotspotRow(hotspotId);
    expect(row).toMatchObject({ sync_status: 'SYNCED' });
    expect(row?.applied_version).toBe(row?.config_version);
    for (const [menu, records] of store.menus) {
      if (menu !== 'interface') expect(records).toEqual([]);
    }
  });

  it('routeur sans compte ecsi-cfg actif : rien n’est réservé', async () => {
    await superPool.query(
      `update hotspots set deleted_at = null, desired_state = 'ENABLED', sync_status = 'PENDING'
        where id = $1`,
      [hotspotId],
    );
    await superPool.query("update routers set status = 'OFFLINE' where id = $1", [routerId]);
    expect(await provisioner().runCycle()).toEqual([]);
    expect((await hotspotRow(hotspotId))?.sync_status).toBe('PENDING');
  });

  it('entretien RADIUS (radius.housekeeping) exécutable par le worker', async () => {
    const counts = await provisioner().housekeeping();
    expect(Object.keys(counts).sort()).toEqual(['expired', 'purgedPostauth', 'staleSessions']);
    for (const value of Object.values(counts)) expect(Number.isInteger(value)).toBe(true);
  });
});

describe('rotation de la clé de chiffrement (comptes ecsi-cfg inclus)', () => {
  it('k1 n’est pas retirable tant qu’un mot de passe ecsi-cfg en dépend ; ré-enveloppe contrôlée', async () => {
    const K1 = { id: 'k1', base64: TEST_SECRETS.encryptionKey };
    const K2 = { id: 'k2', base64: randomBytes(32).toString('base64') };
    const owner = new pg.Pool({ connectionString: infra.urls.migrator, max: 1 });
    try {
      // Supervision ré-enveloppée seule : ecsi-cfg dépend encore de k1.
      const next = new SecretBox(K2.base64, { id: 'k2', previous: [K1] });
      await rotateRouterSecrets(drizzle(owner, { casing: 'snake_case' }), next);
      const before = await verifyEncryptionKeys(owner, { active: K2, previous: [K1] });
      expect(keyStatus(before, 'k1').retirable).toBe(false);
      expect(keyStatus(before, 'k1').routers).toBe(1);

      const report = await rotateRouterConfigSecrets(
        drizzle(owner, { casing: 'snake_case' }),
        next,
      );
      expect(report).toMatchObject({ total: 1, rewrapped: 1, failed: 0, skipped: 0 });
      const after = await verifyEncryptionKeys(owner, { active: K2, previous: [] });
      expect(after.routers.unreadable).toBe(0);
      expect(keyStatus(after, 'k1').routers).toBe(0);
      const row = (
        await superPool.query<{ password_encrypted: string }>(
          'select password_encrypted from router_config_accounts where router_id = $1',
          [routerId],
        )
      ).rows[0];
      expect(row?.password_encrypted).toMatch(/^v2:k2:/);
      expect(
        decryptRouterConfigPassword(
          new SecretBox(K2.base64, { id: 'k2' }),
          { companyId: t.seed.companies.A, routerId },
          row?.password_encrypted ?? '',
        ),
      ).toBe(CFG_PASSWORD);
    } finally {
      await owner.end();
    }
  });
});
