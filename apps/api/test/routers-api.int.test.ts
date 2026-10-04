/**
 * Sprint 3B — gestion et enrôlement des routeurs MikroTik, sur PostgreSQL 18 réel, Redis réel
 * et rôles réels (infra/postgres/init) : API HTTP complète (sessions, CSRF, permissions par
 * site, audit), fonctions SECURITY DEFINER de la migration 0006, droits des rôles ecsi_app /
 * ecsi_auth / ecsi_worker. Aucune base simulée : RLS, clés étrangères et privilèges sont ceux
 * de PostgreSQL. Le routeur lui-même est SIMULÉ ici (appels HTTP du script, fonctions de
 * l'agent passerelle) ; le parcours sur un vrai RouterOS est décrit dans le rapport S3B.
 */
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { EnrollmentCreated, PlatformRouter, Router, RouterDetail } from '@ecsi/shared';
import { SEED_PLATFORM_ADMIN } from '../src/database/seed.js';
import { SecretBox } from '../src/auth/crypto/secret-box.js';
import { encryptRouterPassword, decryptRouterPassword } from '../src/routers/router-secret.js';
import { pgActivationStore, pgGatewayPeers } from '../src/routers/gateway/gateway.module.js';
import {
  enrollMfa,
  HttpClient,
  loginAs,
  SEED_PASSWORD,
  startTestApp,
  TEST_SECRETS,
  type TestApp,
} from './helpers/app.js';
import { startInfra, type TestInfra } from './helpers/infra.js';

const GW_PUBLIC_KEY = 'devonlyWireGuardPublicKeyForTests000000000A=';
const ROUTEROS_PASSWORD = 'Rtr-Secret-Pass-0042!';
const NEW_PASSWORD = 'Nouveau-Secret-RouterOS-77';
const FP = 'cd'.repeat(32);
/** Clés publiques WireGuard de test (format valide, aucune clé privée n'existe côté cloud). */
const wgKey = (c: string) => `${c.repeat(42)}A=`;

let infra: TestInfra;
let t: TestApp;
let adminA: HttpClient;
let gerantA: HttpClient;
let gerantSiteA: HttpClient;
let vendeurSiteB: HttpClient;
let adminB: HttpClient;
let router: HttpClient; // le routeur : aucune session, aucun cookie
let workerPool: pg.Pool;
let chrLab: Router; // routeur du Sprint 3A, enregistré à la main sur 10.200.0.2

const box = new SecretBox(TEST_SECRETS.encryptionKey, { id: 'k1' });
const site = (key: 'A' | 'B', code: string) => t.seed.sites[key][code] ?? '';

const routerRow = async (id: string) =>
  (
    await t.migrator.query<{
      status: string;
      name: string;
      site_id: string;
      company_id: string;
      tunnel_ip: string;
      deleted_at: Date | null;
      routeros_username: string | null;
      routeros_password_encrypted: string | null;
      tls_fingerprint: string | null;
      wg_public_key: string | null;
    }>('select *, host(tunnel_ip) as tunnel_ip from routers where id = $1', [id])
  ).rows[0];

const auditCount = async (action: string, result: string, resourceId?: string) =>
  Number(
    (
      await t.migrator.query<{ n: string }>(
        `select count(*) as n from audit_events where action = $1 and result = $2
           and ($3::text is null or resource_id = $3)`,
        [action, result, resourceId ?? null],
      )
    ).rows[0]?.n ?? 0,
  );

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

const tokenOf = (script: string) =>
  /:local ecsiToken "([A-Za-z0-9_-]{43})"/.exec(script)?.[1] ?? '';

async function enrollment(client: HttpClient, siteId: string, name: string) {
  const response = await client.post('/routers/enrollments', { siteId, name });
  expect(response.statusCode, response.body).toBe(201);
  return response.json<EnrollmentCreated>();
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
  gerantSiteA = await loginAs(t.app, 'gerant.site-a@ecsi.test');
  vendeurSiteB = await loginAs(t.app, 'vendeur.site-b@ecsi.test');
  router = new HttpClient(t.app);
  workerPool = new pg.Pool({ connectionString: infra.urls.worker, max: 2 });
  // CHR-LAB (Sprint 3A) : routeur configuré à la main, enregistré avec son adresse tunnel.
  const created = await adminA.post('/routers', {
    siteId: site('A', 'SITE-A'),
    name: 'CHR-LAB',
    tunnelIp: '10.200.0.2',
    transport: 'API',
    routerosUsername: 'ecsi-cloud',
    routerosPassword: ROUTEROS_PASSWORD,
  });
  expect(created.statusCode, created.body).toBe(201);
  chrLab = created.json<Router>();
}, 180_000);

afterAll(async () => {
  await workerPool.end();
  await t.close();
  await infra.stop();
});

describe('enregistrement manuel et adresses tunnel', () => {
  it('ne renvoie jamais le mot de passe ; le stocke chiffré, lié au routeur', async () => {
    expect(chrLab).toMatchObject({
      tunnelIp: '10.200.0.2',
      status: 'OFFLINE',
      hasCredentials: true,
    });
    expect(JSON.stringify(chrLab)).not.toContain(ROUTEROS_PASSWORD);
    expect(chrLab).not.toHaveProperty('routerosPasswordEncrypted');
    const row = await routerRow(chrLab.id);
    expect(row?.routeros_password_encrypted).toMatch(/^v2:k1:/);
    expect(row?.routeros_password_encrypted).not.toContain(ROUTEROS_PASSWORD);
    expect(
      decryptRouterPassword(
        box,
        { companyId: t.seed.companies.A, routerId: chrLab.id },
        row?.routeros_password_encrypted ?? '',
      ),
    ).toBe(ROUTEROS_PASSWORD);
    expect(await auditCount('routers.create', 'SUCCESS', chrLab.id)).toBe(1);
  });

  it.each([
    ['10.200.0.2', 409, 'adresse déjà utilisée'],
    ['10.200.0.1', 422, 'passerelle'],
    ['10.200.0.0', 422, 'adresse de réseau'],
    ['10.200.0.255', 422, 'diffusion'],
    ['8.8.8.8', 422, 'IP publique'],
    ['192.168.88.1', 422, 'LAN hors plage'],
    ['010.200.0.3', 422, 'notation ambiguë'],
  ])('refuse %s (%s)', async (tunnelIp, status) => {
    const response = await adminA.post('/routers', {
      siteId: site('A', 'SITE-A'),
      name: 'Doublon',
      tunnelIp,
      transport: 'API',
      routerosUsername: 'ecsi-cloud',
      routerosPassword: ROUTEROS_PASSWORD,
    });
    expect(response.statusCode).toBe(status);
    expect(response.body).not.toContain(ROUTEROS_PASSWORD);
  });

  it('refuse le site d’une autre entreprise (enregistrement, enrôlement, déplacement)', async () => {
    const siteB = site('B', 'SITE-A');
    const manual = await adminA.post('/routers', {
      siteId: siteB,
      name: 'Intrus',
      tunnelIp: '10.200.0.60',
      transport: 'API',
      routerosUsername: 'ecsi-cloud',
      routerosPassword: ROUTEROS_PASSWORD,
    });
    expect(manual.statusCode).toBe(404);
    expect(
      (await adminA.post('/routers/enrollments', { siteId: siteB, name: 'Intrus' })).statusCode,
    ).toBe(404);
    expect((await adminA.patch(`/routers/${chrLab.id}`, { siteId: siteB })).statusCode).toBe(404);
    expect((await routerRow(chrLab.id))?.site_id).toBe(site('A', 'SITE-A'));
  });
});

describe('isolation entre entreprises', () => {
  it('B ne voit, ne modifie, ne supprime ni ne change les identifiants des routeurs de A', async () => {
    const list = await adminB.get('/routers');
    expect(list.statusCode).toBe(200);
    expect(list.json<Router[]>().map((r) => r.id)).not.toContain(chrLab.id);
    expect((await adminB.get(`/routers/${chrLab.id}`)).statusCode).toBe(404);
    expect((await adminB.patch(`/routers/${chrLab.id}`, { name: 'Piraté' })).statusCode).toBe(404);
    expect(
      (
        await adminB.put(`/routers/${chrLab.id}/credentials`, {
          routerosUsername: 'admin',
          routerosPassword: NEW_PASSWORD,
        })
      ).statusCode,
    ).toBe(404);
    expect((await adminB.delete(`/routers/${chrLab.id}`)).statusCode).toBe(404);
    expect((await adminB.post(`/routers/${chrLab.id}/enrollment`, {})).statusCode).toBe(404);
    const row = await routerRow(chrLab.id);
    expect(row).toMatchObject({
      name: 'CHR-LAB',
      routeros_username: 'ecsi-cloud',
      deleted_at: null,
    });
    // En-têtes forgés : jamais utilisés comme contexte.
    const spoofed = await adminB.get(`/routers/${chrLab.id}`, {
      headers: { 'x-company-id': t.seed.companies.A, 'x-tenant-id': t.seed.companies.A },
    });
    expect(spoofed.statusCode).toBe(404);
    expect(await auditCount('routers.update', 'FAILURE', chrLab.id)).toBeGreaterThanOrEqual(1);
  });

  it('RLS reste la dernière barrière : ecsi_app sous le contexte de B ne lit aucun routeur ni jeton de A', async () => {
    await as(infra.urls.app, t.seed.companies.B, async (c) => {
      expect((await c.query('select id from routers where id = $1', [chrLab.id])).rowCount).toBe(0);
      expect((await c.query('select id from router_enrollment_tokens')).rowCount).toBe(0);
      expect(
        (await c.query("update routers set name = 'x' where id = $1", [chrLab.id])).rowCount,
      ).toBe(0);
    });
  });
});

describe('permissions par rôle et par site', () => {
  it('VENDEUR : aucun accès aux routeurs', async () => {
    expect((await vendeurSiteB.get('/routers')).statusCode).toBe(403);
    expect(
      (
        await vendeurSiteB.post('/routers/enrollments', {
          siteId: site('A', 'SITE-B'),
          name: 'Intrus',
        })
      ).statusCode,
    ).toBe(403);
  });

  it('GERANT_SITE_A : routeurs de SITE-A seulement, aucun enrôlement sur SITE-B', async () => {
    const onB = await enrollment(adminA, site('A', 'SITE-B'), 'Routeur Yopougon');
    const list = await gerantSiteA.get('/routers');
    expect(list.json<Router[]>().map((r) => r.site.code)).toEqual(['SITE-A']);
    expect((await gerantSiteA.get(`/routers/${onB.router.id}`)).statusCode).toBe(404);
    expect(
      (
        await gerantSiteA.post('/routers/enrollments', {
          siteId: site('A', 'SITE-B'),
          name: 'Intrus',
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (await gerantSiteA.patch(`/routers/${chrLab.id}`, { siteId: site('A', 'SITE-B') }))
        .statusCode,
    ).toBe(404);
  });

  it('GERANT : pas de suppression (routers.delete)', async () => {
    expect((await gerantA.delete(`/routers/${chrLab.id}`)).statusCode).toBe(403);
    expect((await routerRow(chrLab.id))?.deleted_at).toBeNull();
    expect(await auditCount('routers.delete', 'DENIED', chrLab.id)).toBeGreaterThanOrEqual(1);
  });
});

describe('enrôlement', () => {
  let created: EnrollmentCreated;
  const key = wgKey('E');

  it('« Ajouter un routeur » : PROVISIONING, adresse attribuée par le cloud, script avec jeton', async () => {
    created = await enrollment(adminA, site('A', 'SITE-A'), 'Riviera hAP ax3');
    expect(created.router).toMatchObject({
      status: 'PROVISIONING',
      transport: 'REST_HTTPS',
      hasCredentials: false,
      wgPublicKey: null,
    });
    // Ni .0 (réseau), ni .1 (passerelle), ni .2 (CHR-LAB) : première adresse libre.
    expect(created.router.tunnelIp).toMatch(
      /^10\.200\.0\.([3-9]|[1-9][0-9]|1[0-9]{2}|2[0-4][0-9]|25[0-4])$/,
    );
    const token = tokenOf(created.script);
    expect(token).toHaveLength(43);
    expect(created.script).toContain(`:local tunnelAddress "${created.router.tunnelIp}/24"`);
    expect(created.script).toContain(`:local gwPublicKey "${GW_PUBLIC_KEY}"`);
    expect(created.script).toContain(':local ecsiActivateUrl "http://10.200.0.1:8081/activate"');
    // Jeton stocké HACHÉ uniquement.
    const tokens = await t.migrator.query<{ token_hash: Buffer }>(
      'select token_hash from router_enrollment_tokens where router_id = $1',
      [created.router.id],
    );
    expect(tokens.rows).toHaveLength(1);
    expect(tokens.rows[0]?.token_hash).toHaveLength(32);
    const dump = JSON.stringify(
      (await t.migrator.query('select * from router_enrollment_tokens')).rows,
    );
    expect(dump).not.toContain(token);
    // Le détail ne renvoie jamais le jeton ni le script.
    const detail = await adminA.get(`/routers/${created.router.id}`);
    expect(detail.body).not.toContain(token);
    expect(detail.json<RouterDetail>().enrollment?.usedAt).toBeNull();
    expect(await auditCount('routers.enrollment.create', 'SUCCESS', created.router.id)).toBe(1);
    const audit = await t.migrator.query<{ details: unknown }>(
      "select details from audit_events where action = 'routers.enrollment.create' and resource_id = $1",
      [created.router.id],
    );
    expect(JSON.stringify(audit.rows)).not.toContain(token);
  });

  it('le worker de supervision ne voit pas un routeur en cours d’enrôlement', async () => {
    const ids = (await workerPool.query<{ id: string }>('select id from routers')).rows.map(
      (r) => r.id,
    );
    expect(ids).toContain(chrLab.id);
    expect(ids).not.toContain(created.router.id);
  });

  it('jeton invalide, clé invalide, champ en trop : refusés', async () => {
    const bad = await router.post('/routers/enroll', { token: 'x'.repeat(43), publicKey: key });
    expect(bad.statusCode).toBe(410);
    expect(
      (await router.post('/routers/enroll', { token: tokenOf(created.script), publicKey: 'abc' }))
        .statusCode,
    ).toBe(422);
    expect(
      (
        await router.post('/routers/enroll', {
          token: tokenOf(created.script),
          publicKey: key,
          tunnelIp: '10.200.0.99',
        })
      ).statusCode,
    ).toBe(422);
    expect((await routerRow(created.router.id))?.wg_public_key).toBeNull();
  });

  it('jeton valide : clé publique enregistrée, puis tout rejeu est refusé (410)', async () => {
    const token = tokenOf(created.script);
    const ok = await router.post('/routers/enroll', { token, publicKey: key });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json()).toEqual({ status: 'enrolled' });
    expect((await routerRow(created.router.id))?.wg_public_key).toBe(key);
    const replay = await router.post('/routers/enroll', { token, publicKey: wgKey('R') });
    expect(replay.statusCode).toBe(410);
    expect(replay.body).not.toContain('REPLAY');
    expect((await routerRow(created.router.id))?.wg_public_key).toBe(key);
    expect(await auditCount('routers.enroll', 'SUCCESS', created.router.id)).toBe(1);
    expect(await auditCount('routers.enroll', 'DENIED', created.router.id)).toBeGreaterThanOrEqual(
      1,
    );
    // Déjà enrôlé : plus de nouveau jeton.
    expect((await adminA.post(`/routers/${created.router.id}/enrollment`, {})).statusCode).toBe(
      409,
    );
  });

  it('jeton expiré : refusé', async () => {
    const pending = await enrollment(adminA, site('A', 'SITE-A'), 'Expiré');
    await t.migrator.query(
      "update router_enrollment_tokens set expires_at = now() - interval '1 second' where router_id = $1",
      [pending.router.id],
    );
    const response = await router.post('/routers/enroll', {
      token: tokenOf(pending.script),
      publicKey: wgKey('X'),
    });
    expect(response.statusCode).toBe(410);
    expect((await routerRow(pending.router.id))?.wg_public_key).toBeNull();
  });

  it('nouveau jeton : l’ancien est révoqué ; une clé déjà utilisée est refusée', async () => {
    const pending = await enrollment(adminA, site('A', 'SITE-A'), 'Renouvelé');
    const renewed = await adminA.post(`/routers/${pending.router.id}/enrollment`, {});
    expect(renewed.statusCode).toBe(201);
    const next = renewed.json<EnrollmentCreated>();
    expect(next.router.tunnelIp).toBe(pending.router.tunnelIp);
    expect(
      (
        await router.post('/routers/enroll', {
          token: tokenOf(pending.script),
          publicKey: wgKey('Y'),
        })
      ).statusCode,
    ).toBe(410);
    // Clé publique d'un autre routeur actif : refus, jeton non consommé.
    expect(
      (await router.post('/routers/enroll', { token: tokenOf(next.script), publicKey: key }))
        .statusCode,
    ).toBe(410);
    const accepted = await router.post('/routers/enroll', {
      token: tokenOf(next.script),
      publicKey: wgKey('Y'),
    });
    expect(accepted.statusCode).toBe(200);
  });

  it('enrôlements simultanés : adresses toutes différentes (verrou d’attribution)', async () => {
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        adminA.post('/routers/enrollments', {
          siteId: site('A', 'SITE-B'),
          name: `Parallèle ${i}`,
        }),
      ),
    );
    expect(results.map((r) => r.statusCode)).toEqual(Array(6).fill(201));
    const ips = results.map((r) => r.json<EnrollmentCreated>().router.tunnelIp);
    expect(new Set(ips).size).toBe(6);
  });

  it('limite les tentatives d’enrôlement par adresse IP', async () => {
    const attacker = new HttpClient(t.app);
    const statuses: number[] = [];
    for (let i = 0; i < 32; i++) {
      statuses.push(
        (await attacker.post('/routers/enroll', { token: 'z'.repeat(43), publicKey: wgKey('Z') }))
          .statusCode,
      );
    }
    expect(statuses.slice(0, 30).every((s) => s === 410)).toBe(true);
    expect(statuses.slice(30)).toEqual([429, 429]);
  });

  it('activation par le tunnel (agent passerelle, rôle ecsi_worker) puis visible du worker', async () => {
    const store = pgActivationStore(workerPool);
    // Autre adresse tunnel : rien à activer.
    expect(await store.target('10.200.0.250')).toBeNull();
    const target = await store.target(created.router.tunnelIp);
    expect(target).toEqual({ routerId: created.router.id, companyId: t.seed.companies.A });
    const encrypted = encryptRouterPassword(
      box,
      { companyId: t.seed.companies.A, routerId: created.router.id },
      'Mot-de-passe-tire-par-le-routeur-32',
    );
    expect(
      await store.activate({
        routerId: created.router.id,
        companyId: t.seed.companies.A,
        username: 'ecsi-svc',
        passwordEncrypted: encrypted,
        tlsFingerprint: FP,
      }),
    ).toBe(true);
    // Une seule fois.
    expect(
      await store.activate({
        routerId: created.router.id,
        companyId: t.seed.companies.A,
        username: 'ecsi-svc',
        passwordEncrypted: encrypted,
        tlsFingerprint: FP,
      }),
    ).toBe(false);
    expect(await store.target(created.router.tunnelIp)).toBeNull();
    const row = await routerRow(created.router.id);
    expect(row).toMatchObject({
      status: 'OFFLINE',
      routeros_username: 'ecsi-svc',
      tls_fingerprint: FP,
    });
    const ids = (await workerPool.query<{ id: string }>('select id from routers')).rows.map(
      (r) => r.id,
    );
    expect(ids).toContain(created.router.id);
    const audit = await t.migrator.query<{ actor_type: string; company_id: string }>(
      "select actor_type, company_id from audit_events where action = 'router.activated' and resource_id = $1",
      [created.router.id],
    );
    expect(audit.rows).toEqual([{ actor_type: 'SYSTEM', company_id: t.seed.companies.A }]);
    await store.denied('10.200.0.250', 'NOT_PROVISIONING');
    expect(await auditCount('router.activation', 'DENIED')).toBeGreaterThanOrEqual(1);
    // L'agent passerelle reçoit la clé publique et l'adresse, rien d'autre.
    const peers = await pgGatewayPeers(workerPool);
    expect(peers).toContainEqual({
      publicKey: key,
      tunnelIp: created.router.tunnelIp,
      active: true,
    });
    expect(Object.keys(peers[0] ?? {}).sort()).toEqual(['active', 'publicKey', 'tunnelIp']);
  });
});

describe('modification, identifiants, suppression logique', () => {
  it('renomme et déplace un routeur entre sites de l’entreprise (audité)', async () => {
    const response = await adminA.patch(`/routers/${chrLab.id}`, {
      name: 'CHR-LAB OVH',
      siteId: site('A', 'SITE-B'),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json<Router>()).toMatchObject({
      name: 'CHR-LAB OVH',
      site: { code: 'SITE-B' },
    });
    expect(await auditCount('routers.update', 'SUCCESS', chrLab.id)).toBe(1);
    await adminA.patch(`/routers/${chrLab.id}`, { siteId: site('A', 'SITE-A') });
  });

  it('change les identifiants : nouveau chiffré, ancien remplacé, rien renvoyé, audité', async () => {
    const before = (await routerRow(chrLab.id))?.routeros_password_encrypted;
    const response = await adminA.put(`/routers/${chrLab.id}/credentials`, {
      routerosUsername: 'ecsi-svc2',
      routerosPassword: NEW_PASSWORD,
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain(NEW_PASSWORD);
    const row = await routerRow(chrLab.id);
    expect(row?.routeros_username).toBe('ecsi-svc2');
    expect(row?.routeros_password_encrypted).not.toBe(before);
    expect(
      decryptRouterPassword(
        box,
        { companyId: t.seed.companies.A, routerId: chrLab.id },
        row?.routeros_password_encrypted ?? '',
      ),
    ).toBe(NEW_PASSWORD);
    const audit = await t.migrator.query<{ details: unknown }>(
      "select details from audit_events where action = 'routers.credentials.update' and resource_id = $1 and result = 'SUCCESS'",
      [chrLab.id],
    );
    expect(audit.rows).toHaveLength(1);
    expect(JSON.stringify(audit.rows)).not.toContain(NEW_PASSWORD);
    // Un routeur en cours d'enrôlement reçoit ses identifiants du script, pas de l'API.
    const pending = await enrollment(adminA, site('A', 'SITE-A'), 'En attente');
    expect(
      (
        await adminA.put(`/routers/${pending.router.id}/credentials`, {
          routerosUsername: 'x',
          routerosPassword: NEW_PASSWORD,
        })
      ).statusCode,
    ).toBe(409);
  });

  it('suppression logique : invisible de l’API, du worker, retirée de la passerelle, jetons révoqués', async () => {
    const pending = await enrollment(adminA, site('A', 'SITE-A'), 'À supprimer');
    const enrolled = await router.post('/routers/enroll', {
      token: tokenOf(pending.script),
      publicKey: wgKey('S'),
    });
    expect(enrolled.statusCode).toBe(200);
    await t.migrator.query(
      "update routers set status = 'OFFLINE', routeros_username = 'ecsi-svc', routeros_password_encrypted = 'v2:k1:x', tls_fingerprint = $2 where id = $1",
      [pending.router.id, FP],
    );
    const removal = await adminA.delete(`/routers/${pending.router.id}`);
    expect(removal.statusCode).toBe(204);
    expect((await routerRow(pending.router.id))?.deleted_at).not.toBeNull();
    expect((await adminA.get(`/routers/${pending.router.id}`)).statusCode).toBe(404);
    expect((await adminA.get('/routers')).json<Router[]>().map((r) => r.id)).not.toContain(
      pending.router.id,
    );
    const ids = (await workerPool.query<{ id: string }>('select id from routers')).rows.map(
      (r) => r.id,
    );
    expect(ids).not.toContain(pending.router.id);
    expect(await pgGatewayPeers(workerPool)).toContainEqual({
      publicKey: wgKey('S'),
      tunnelIp: pending.router.tunnelIp,
      active: false,
    });
    expect(await auditCount('routers.delete', 'SUCCESS', pending.router.id)).toBe(1);
    // Quarantaine : l'adresse n'est pas réattribuée tout de suite.
    const next = await enrollment(adminA, site('A', 'SITE-A'), 'Après suppression');
    expect(next.router.tunnelIp).not.toBe(pending.router.tunnelIp);
    // Le jeton non utilisé d'un routeur supprimé est révoqué.
    const other = await enrollment(adminA, site('A', 'SITE-A'), 'Supprimé avant usage');
    expect((await adminA.delete(`/routers/${other.router.id}`)).statusCode).toBe(204);
    expect(
      (
        await router.post('/routers/enroll', {
          token: tokenOf(other.script),
          publicKey: wgKey('T'),
        })
      ).statusCode,
    ).toBe(410);
  });
});

describe('attribution des adresses (app.router_allocate_tunnel_ip)', () => {
  const allocate = (cidr: string, gw: string) =>
    as(infra.urls.app, t.seed.companies.B, async (c) => {
      const { rows } = await c.query<{ ip: string }>(
        'select host(app.router_allocate_tunnel_ip($1::cidr, $2::inet)) as ip',
        [cidr, gw],
      );
      return rows[0]?.ip;
    });

  it('voit les adresses de toutes les entreprises sans en révéler les données', async () => {
    // Contexte B : les adresses de A (dont 10.200.0.2) restent exclues.
    const ip = await allocate('10.200.0.0/24', '10.200.0.1');
    const used = (
      await t.migrator.query<{ ip: string }>('select host(tunnel_ip) as ip from routers')
    ).rows.map((r) => r.ip);
    expect(used).not.toContain(ip);
    expect(['10.200.0.0', '10.200.0.1', '10.200.0.255']).not.toContain(ip);
  });

  it('plage /30 : seule l’adresse hors passerelle est attribuable, puis plage épuisée', async () => {
    expect(await allocate('10.201.0.0/30', '10.201.0.1')).toBe('10.201.0.2');
    expect(await allocate('10.201.0.0/30', '10.201.0.2')).toBe('10.201.0.1');
    await t.migrator.query(
      `insert into routers (company_id, site_id, name, tunnel_ip, routeros_username,
         routeros_password_encrypted, transport) values ($1, $2, 'plein', '10.201.0.2', 'e', 'v2:k1:x', 'API')`,
      [t.seed.companies.B, site('B', 'SITE-A')],
    );
    expect(await sqlError(allocate('10.201.0.0/30', '10.201.0.1'))).toBe('EC001');
  });

  it('refuse une plage ou une passerelle incohérente', async () => {
    expect(await sqlError(allocate('10.200.0.0/24', '10.9.9.1'))).toBe('22023');
    expect(await sqlError(allocate('10.0.0.0/8', '10.0.0.1'))).toBe('22023');
  });
});

describe('droits des rôles PostgreSQL (migration 0006)', () => {
  const fn = {
    allocate: "select app.router_allocate_tunnel_ip('10.200.0.0/24', '10.200.0.1')",
    consume: "select * from app.router_consume_enrollment('\\x00', 'x')",
    peers: 'select * from app.gateway_peers()',
    target: "select * from app.router_activation_target('10.200.0.3')",
    activate:
      "select app.router_activate('0199b000-0000-7000-8000-000000000001', '0199b000-0000-7000-8000-000000000001', 'a', 'v2:x', 'ab')",
    denied: "select app.router_activation_denied('10.200.0.3', 'INVALID_BODY')",
    platform: "select * from app.platform_company_routers('0199b000-0000-7000-8000-000000000001')",
  };

  it('ecsi_app : ni consommation de jeton, ni fonctions passerelle ou plateforme, ni DELETE', async () => {
    for (const statement of [
      fn.consume,
      fn.peers,
      fn.target,
      fn.activate,
      fn.denied,
      fn.platform,
    ]) {
      expect(
        await sqlError(as(infra.urls.app, t.seed.companies.A, (c) => c.query(statement))),
      ).toBe('42501');
    }
    for (const statement of [
      'delete from routers where id = $1',
      'delete from router_enrollment_tokens where router_id = $1',
      "update routers set tunnel_ip = '10.200.0.99' where id = $1",
      'update routers set wg_public_key = null where id = $1',
      "update routers set status = 'ONLINE' where id = $1",
      'update routers set company_id = company_id where id = $1',
      'update router_enrollment_tokens set used_at = null where router_id = $1',
    ]) {
      expect(
        await sqlError(
          as(infra.urls.app, t.seed.companies.A, (c) => c.query(statement, [chrLab.id])),
        ),
        statement,
      ).toBe('42501');
    }
  });

  it('ecsi_auth : aucune table de routeur, seulement la consommation et la lecture plateforme', async () => {
    for (const statement of [
      'select id from routers',
      'select id from router_enrollment_tokens',
      fn.allocate,
      fn.peers,
      fn.activate,
    ]) {
      expect(await sqlError(as(infra.urls.auth, null, (c) => c.query(statement))), statement).toBe(
        '42501',
      );
    }
    const consumed = await as(infra.urls.auth, null, (c) => c.query(fn.consume));
    expect(consumed.rows).toEqual([
      { outcome: 'INVALID_KEY', router_id: null, company_id: null, site_id: null, tunnel_ip: null },
    ]);
  });

  it('ecsi_worker : ni jetons, ni consommation, ni attribution, ni lecture plateforme', async () => {
    for (const statement of [
      'select id from router_enrollment_tokens',
      fn.consume,
      fn.allocate,
      fn.platform,
      'select 1 from audit_events limit 1',
      "update routers set status = 'PROVISIONING' where id = $1",
    ]) {
      const params = statement.includes('$1') ? [chrLab.id] : [];
      expect(
        await sqlError(as(infra.urls.worker, null, (c) => c.query(statement, params))),
        statement,
      ).toBe('42501');
    }
  });
});

describe('console plateforme (Super Admin ECSI)', () => {
  it('lit les routeurs d’une entreprise, sans aucun secret', async () => {
    const platform = new HttpClient(t.app);
    const login = await platform.post('/platform/auth/login', {
      email: SEED_PLATFORM_ADMIN.email,
      password: SEED_PASSWORD,
    });
    expect(login.statusCode).toBe(200);
    await enrollMfa(platform, '/platform/auth');
    const response = await platform.get(`/platform/companies/${t.seed.companies.A}/routers`);
    expect(response.statusCode, response.body).toBe(200);
    const list = response.json<PlatformRouter[]>();
    expect(list.map((r) => r.id)).toContain(chrLab.id);
    expect(response.body).not.toContain('v2:');
    expect(response.body).not.toContain('routerosUsername');
    expect(response.body).not.toContain(NEW_PASSWORD);
    // Une session d'entreprise n'y a pas accès.
    expect((await adminA.get(`/platform/companies/${t.seed.companies.A}/routers`)).statusCode).toBe(
      403,
    );
    const unknown = randomUUID();
    expect((await platform.get(`/platform/companies/${unknown}/routers`)).statusCode).toBe(404);
  });
});

describe('configuration absente', () => {
  it('sans passerelle WireGuard configurée, l’enrôlement répond 503 (le reste fonctionne)', async () => {
    const other = await startTestApp(infra);
    try {
      const admin = await loginAs(other.app, 'gerant.a@ecsi.test');
      const response = await admin.post('/routers/enrollments', {
        siteId: other.seed.sites.A['SITE-A'],
        name: 'Sans passerelle',
      });
      expect(response.statusCode).toBe(503);
      expect((await admin.get('/routers')).statusCode).toBe(200);
    } finally {
      await other.app.close();
      await other.migrator.end();
    }
  });
});
