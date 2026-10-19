/**
 * Lot B (application) — forfaits, lots et tickets, impression, hotspots et sessions RADIUS,
 * sur PostgreSQL 18, Redis et S3 réels et les rôles réels (infra/postgres/init) : RLS entre
 * entreprises, portée par site, privilèges d'ecsi_app (aucun code en base, aucune écriture de
 * consommation), dérivation des codes, audit sans code, 503 sans clés, version de
 * configuration des hotspots. FreeRADIUS est SIMULÉ par des appels directs aux fonctions
 * radius.* avec le rôle ecsi_radius (mêmes appels que rlm_sql) ; aucun routeur réel.
 */
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  Hotspot,
  Page,
  Plan,
  RadiusSession,
  Router,
  Voucher,
  VoucherBatch,
  VoucherDetail,
  VoucherPrintSheet,
} from '@ecsi/shared';
import { deriveVoucherCode, voucherLookup } from '../src/hotspot/radius-keys.js';
import { enrollMfa, type HttpClient, loginAs, startTestApp, type TestApp } from './helpers/app.js';
import { startInfra, type TestInfra } from './helpers/infra.js';

// Clés et mot de passe de test tirés à l'exécution (jamais écrits dans le dépôt).
const CODE_KEY = randomBytes(32).toString('hex');
const LOOKUP_KEY = randomBytes(32).toString('hex');
const ROUTEROS_PASSWORD = randomBytes(18).toString('base64url');

let infra: TestInfra;
let t: TestApp;
let adminA: HttpClient;
let adminB: HttpClient;
let gerantA: HttpClient;
let gerantSiteA: HttpClient;
let vendeurSiteB: HttpClient;
let r1: Router;
let r2: Router;
let rb: Router;
let plan: Plan;
let batch: VoucherBatch;
let sheet: VoucherPrintSheet;
const logs: string[] = [];
/** Tous les codes imprimés pendant le test : ne doivent apparaître nulle part ailleurs. */
const codes = new Set<string>();
/** Corps des réponses autres que l'impression, relus à la fin. */
const bodies: string[] = [];

const site = (key: 'A' | 'B', code: string) => t.seed.sites[key][code] ?? '';

/** Requête qui conserve le corps de la réponse pour le contrôle final « aucun code ». */
async function call(
  client: HttpClient,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  body?: unknown,
) {
  const response = await client.request(method, url, body === undefined ? {} : { body });
  bodies.push(response.body);
  return response;
}

/** Événements d'audit réussis d'une action (les refus et échecs sont aussi tracés). */
const auditRows = async (action: string) =>
  (
    await t.migrator.query<{
      result: string;
      resource_type: string;
      resource_id: string | null;
      site_id: string | null;
      details: Record<string, unknown>;
    }>(
      "select result, resource_type, resource_id, site_id, details from audit_events where action = $1 and result = 'SUCCESS' order by chain_seq",
      [action],
    )
  ).rows;

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

/** Appel validé (commit) avec le rôle ecsi_radius, comme FreeRADIUS. */
async function radius(query: string, params: unknown[]) {
  const pool = new pg.Pool({ connectionString: infra.urls.radius, max: 1 });
  try {
    return await pool.query<Record<string, unknown>>(query, params);
  } finally {
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

const planBody = {
  name: 'Pass 1 heure',
  description: 'Une heure de connexion',
  priceMinor: 200,
  validitySeconds: 86_400,
  sessionTimeSeconds: 3600,
  rateUpKbps: 1024,
  rateDownKbps: 4096,
  dataQuotaBytes: 1_073_741_824,
  maxDevices: 2,
  idleTimeoutSeconds: 600,
};

beforeAll(async () => {
  infra = await startInfra();
  t = await startTestApp(
    infra,
    { LOG_LEVEL: 'trace', VOUCHER_CODE_KEY: CODE_KEY, RADIUS_VOUCHER_LOOKUP_KEY: LOOKUP_KEY },
    { write: (message: string) => logs.push(message) },
  );
  adminA = await loginAs(t.app, 'admin.a@ecsi.test');
  await enrollMfa(adminA);
  adminB = await loginAs(t.app, 'admin.b@ecsi.test');
  await enrollMfa(adminB);
  gerantA = await loginAs(t.app, 'gerant.a@ecsi.test');
  gerantSiteA = await loginAs(t.app, 'gerant.site-a@ecsi.test');
  vendeurSiteB = await loginAs(t.app, 'vendeur.site-b@ecsi.test');
  r1 = await createRouter(gerantA, site('A', 'SITE-A'), 'R1 Riviera', '10.200.0.2');
  r2 = await createRouter(gerantA, site('A', 'SITE-B'), 'R2 Selmer', '10.200.0.3');
  rb = await createRouter(adminB, site('B', 'SITE-A'), 'RB Plateau', '10.200.0.4');
}, 180_000);

afterAll(async () => {
  await t.close();
  await infra.stop();
});

describe('forfaits', () => {
  it('création : devise de l’entreprise, valeurs par défaut, audit', async () => {
    const response = await call(gerantA, 'POST', '/plans', planBody);
    expect(response.statusCode, response.body).toBe(201);
    plan = response.json<Plan>();
    expect(plan).toMatchObject({ ...planBody, currency: 'XOF', status: 'ACTIVE' });
    const minimal = await call(gerantA, 'POST', '/plans', {
      name: 'Jour 500 Mo',
      priceMinor: 500,
      dataQuotaBytes: 524_288_000,
    });
    expect(minimal.json<Plan>()).toMatchObject({ maxDevices: 1, idleTimeoutSeconds: 300 });
    const [event] = await auditRows('plans.create');
    expect(event).toMatchObject({ result: 'SUCCESS', resource_id: plan.id });
    expect(event?.details).toMatchObject({ name: 'Pass 1 heure', priceMinor: 200 });
  });

  it('validation identique aux contraintes de la base', async () => {
    const none = await call(gerantA, 'POST', '/plans', { name: 'Illimité', priceMinor: 0 });
    expect(none.statusCode).toBe(422);
    expect(none.body).toContain('au moins une limite');
    for (const change of [
      { maxDevices: 11 },
      { rateUpKbps: 4 },
      { dataQuotaBytes: 1000 },
      { idleTimeoutSeconds: 10 },
      { currency: 'EUR' },
    ]) {
      expect((await call(gerantA, 'POST', '/plans', { ...planBody, ...change })).statusCode).toBe(
        422,
      );
    }
    // Nom déjà pris (insensible à la casse).
    const duplicate = await call(gerantA, 'POST', '/plans', { ...planBody, name: 'PASS 1 HEURE' });
    expect(duplicate.statusCode).toBe(409);
  });

  it('modification partielle : la règle « au moins une limite » porte sur le forfait fusionné', async () => {
    const removeAll = await call(gerantA, 'PATCH', `/plans/${plan.id}`, {
      validitySeconds: null,
      sessionTimeSeconds: null,
      dataQuotaBytes: null,
    });
    expect(removeAll.statusCode).toBe(422);
    const ok = await call(gerantA, 'PATCH', `/plans/${plan.id}`, { priceMinor: 250 });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json<Plan>().priceMinor).toBe(250);
    const [event] = await auditRows('plans.update');
    expect(event?.details).toMatchObject({ changes: { priceMinor: { before: 200, after: 250 } } });
  });

  it('portée : lecture pour un vendeur de site, gestion réservée à l’échelle de l’entreprise', async () => {
    const list = await call(vendeurSiteB, 'GET', '/plans');
    expect(list.statusCode).toBe(200);
    expect(list.json<Plan[]>().map((p) => p.name)).toContain('Pass 1 heure');
    // GERANT limité à SITE-A : plans.manage n'est pas détenue pour toute l'entreprise.
    expect((await call(gerantSiteA, 'POST', '/plans', { ...planBody, name: 'X' })).statusCode).toBe(
      403,
    );
    expect(
      (await call(vendeurSiteB, 'PATCH', `/plans/${plan.id}`, { priceMinor: 1 })).statusCode,
    ).toBe(403);
  });

  it('isolation entre entreprises (RLS et contrôle applicatif)', async () => {
    expect((await call(adminB, 'GET', '/plans')).json<Plan[]>()).toEqual([]);
    expect((await call(adminB, 'GET', `/plans/${plan.id}`)).statusCode).toBe(404);
    expect((await call(adminB, 'PATCH', `/plans/${plan.id}`, { priceMinor: 1 })).statusCode).toBe(
      404,
    );
    const visible = await as(infra.urls.app, { companyId: t.seed.companies.B }, (c) =>
      c.query('select id from plans'),
    );
    expect(visible.rows).toEqual([]);
  });

  it('désactivation, réactivation et suppression logique', async () => {
    const extra = (
      await call(gerantA, 'POST', '/plans', {
        name: 'Temporaire',
        priceMinor: 100,
        validitySeconds: 3600,
      })
    ).json<Plan>();
    expect((await call(gerantA, 'POST', `/plans/${extra.id}/disable`)).json<Plan>().status).toBe(
      'DISABLED',
    );
    expect(
      (await call(gerantA, 'GET', '/plans?status=DISABLED')).json<Plan[]>().map((p) => p.id),
    ).toEqual([extra.id]);
    expect((await call(gerantA, 'POST', `/plans/${extra.id}/enable`)).json<Plan>().status).toBe(
      'ACTIVE',
    );
    expect((await call(gerantA, 'DELETE', `/plans/${extra.id}`)).statusCode).toBe(204);
    expect((await call(gerantA, 'GET', `/plans/${extra.id}`)).statusCode).toBe(404);
    const { rows } = await t.migrator.query<{ deleted: boolean }>(
      'select deleted_at is not null as deleted from plans where id = $1',
      [extra.id],
    );
    expect(rows[0]?.deleted).toBe(true);
    for (const action of ['plans.disable', 'plans.enable', 'plans.delete']) {
      expect((await auditRows(action)).length, action).toBeGreaterThan(0);
    }
    // ecsi_app n'a jamais DELETE sur les forfaits.
    expect(
      await sqlError(
        as(infra.urls.app, { companyId: t.seed.companies.A }, (c) =>
          c.query('delete from plans where id = $1', [extra.id]),
        ),
      ),
    ).toBe('42501');
  });
});

describe('lots et tickets', () => {
  it('génération : N tickets, limites et prix copiés du forfait, audit sans code', async () => {
    const response = await call(gerantA, 'POST', '/voucher-batches', {
      planId: plan.id,
      siteId: site('A', 'SITE-A'),
      quantity: 25,
      label: 'Lot test',
    });
    expect(response.statusCode, response.body).toBe(201);
    batch = response.json<VoucherBatch>();
    expect(batch).toMatchObject({
      quantity: 25,
      label: 'Lot test',
      plan: { id: plan.id, name: plan.name },
      site: { id: site('A', 'SITE-A') },
    });
    expect(batch.states.AVAILABLE).toBe(25);
    const { rows } = await t.migrator.query<Record<string, unknown>>(
      `select serial, state, price_minor, currency, validity_seconds, session_time_seconds,
              rate_up_kbps, rate_down_kbps, data_quota_bytes, max_devices, idle_timeout_seconds,
              code_key_version, lookup_key_version
         from vouchers where batch_id = $1 order by serial`,
      [batch.id],
    );
    expect(rows.map((row) => row.serial)).toEqual(Array.from({ length: 25 }, (_, i) => i + 1));
    expect(rows[0]).toEqual({
      serial: 1,
      state: 'AVAILABLE',
      price_minor: '250',
      currency: 'XOF',
      validity_seconds: 86_400,
      session_time_seconds: 3600,
      rate_up_kbps: 1024,
      rate_down_kbps: 4096,
      data_quota_bytes: '1073741824',
      max_devices: 2,
      idle_timeout_seconds: 600,
      code_key_version: 1,
      lookup_key_version: 1,
    });
    const [event] = await auditRows('vouchers.generate');
    expect(event).toMatchObject({
      result: 'SUCCESS',
      resource_type: 'voucher_batch',
      resource_id: batch.id,
      site_id: site('A', 'SITE-A'),
    });
    expect(event?.details).toEqual({
      batchId: batch.id,
      planId: plan.id,
      siteId: site('A', 'SITE-A'),
      count: 25,
    });
  });

  it('modifier le forfait ne change pas les tickets émis', async () => {
    await call(gerantA, 'PATCH', `/plans/${plan.id}`, { priceMinor: 300, maxDevices: 1 });
    const { rows } = await t.migrator.query<{ price_minor: string; max_devices: number }>(
      'select distinct price_minor, max_devices from vouchers where batch_id = $1',
      [batch.id],
    );
    expect(rows).toEqual([{ price_minor: '250', max_devices: 2 }]);
  });

  it('impression : codes redérivés, empreinte en base, no-store, audit avec un nombre', async () => {
    const response = await gerantA.get(`/voucher-batches/${batch.id}/print`);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers.pragma).toBe('no-cache');
    sheet = response.json<VoucherPrintSheet>();
    expect(sheet.vouchers).toHaveLength(25);
    expect(sheet).toMatchObject({
      batch: { id: batch.id, label: 'Lot test', quantity: 25 },
      plan: { id: plan.id, priceMinor: 250, maxDevices: 2, sessionTimeSeconds: 3600 },
      site: { id: site('A', 'SITE-A'), name: 'Cocody Riviera' },
      company: { name: 'ENTREPRISE_A' },
    });
    const { rows } = await t.migrator.query<{ id: string; code_lookup: string }>(
      'select id, code_lookup from vouchers where batch_id = $1',
      [batch.id],
    );
    const lookups = new Map(rows.map((row) => [row.id, row.code_lookup]));
    for (const voucher of sheet.vouchers) {
      expect(voucher.code).toMatch(/^[23456789abcdefghjkmnpqrstuvwxyz]{8}$/);
      expect(voucher.code).toBe(deriveVoucherCode(CODE_KEY, voucher.id));
      expect(voucherLookup(LOOKUP_KEY, voucher.code)).toBe(lookups.get(voucher.id));
      // Saisie en majuscules : même empreinte (normalisation identique à FreeRADIUS).
      expect(voucherLookup(LOOKUP_KEY, voucher.code.toUpperCase())).toBe(lookups.get(voucher.id));
      codes.add(voucher.code);
    }
    expect(codes.size).toBe(25);
    // Réimpression : mêmes codes (dérivation déterministe, rien n'est stocké).
    const again = (
      await gerantA.get(`/voucher-batches/${batch.id}/print`)
    ).json<VoucherPrintSheet>();
    expect(again.vouchers.map((v) => v.code)).toEqual(sheet.vouchers.map((v) => v.code));
    const exports = await auditRows('vouchers.export');
    expect(exports).toHaveLength(2);
    expect(exports[0]).toMatchObject({ resource_type: 'voucher_batch', resource_id: batch.id });
    expect(exports[0]?.details).toEqual({
      batchId: batch.id,
      planId: plan.id,
      siteId: site('A', 'SITE-A'),
      count: 25,
    });
  });

  it('impression d’un seul ticket (POST, no-store, auditée)', async () => {
    const first = sheet.vouchers[0];
    const response = await gerantA.post(`/vouchers/${first?.id ?? ''}/print`, {});
    expect(response.statusCode, response.body).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    const single = response.json<VoucherPrintSheet>();
    expect(single.vouchers).toEqual([first]);
    const [, , event] = await auditRows('vouchers.export');
    expect(event).toMatchObject({ resource_type: 'voucher', resource_id: first?.id });
    expect(event?.details).toMatchObject({ count: 1 });
  });

  it('refus : forfait désactivé, quantité, portée par site, permissions', async () => {
    await call(gerantA, 'POST', `/plans/${plan.id}/disable`);
    const disabled = await call(gerantA, 'POST', '/voucher-batches', {
      planId: plan.id,
      siteId: site('A', 'SITE-A'),
      quantity: 1,
    });
    expect(disabled.statusCode).toBe(409);
    await call(gerantA, 'POST', `/plans/${plan.id}/enable`);
    expect(
      (
        await call(gerantA, 'POST', '/voucher-batches', {
          planId: plan.id,
          siteId: site('A', 'SITE-A'),
          quantity: 1001,
        })
      ).statusCode,
    ).toBe(422);
    // GERANT de SITE-A : génération sur SITE-B refusée comme un site inconnu.
    expect(
      (
        await call(gerantSiteA, 'POST', '/voucher-batches', {
          planId: plan.id,
          siteId: site('A', 'SITE-B'),
          quantity: 1,
        })
      ).statusCode,
    ).toBe(404);
    // VENDEUR : ni génération ni impression (vouchers.generate / vouchers.export absentes).
    expect(
      (
        await call(vendeurSiteB, 'POST', '/voucher-batches', {
          planId: plan.id,
          siteId: site('A', 'SITE-B'),
          quantity: 1,
        })
      ).statusCode,
    ).toBe(403);
    expect((await vendeurSiteB.get(`/voucher-batches/${batch.id}/print`)).statusCode).toBe(403);
    // Forfait d'une autre entreprise.
    expect(
      (
        await call(adminB, 'POST', '/voucher-batches', {
          planId: plan.id,
          siteId: site('B', 'SITE-A'),
          quantity: 1,
        })
      ).statusCode,
    ).toBe(404);
  });

  it('listes et détails filtrés par site et par entreprise, sans code', async () => {
    const own = await call(gerantSiteA, 'GET', '/voucher-batches');
    expect(own.json<Page<VoucherBatch>>().items.map((b) => b.id)).toContain(batch.id);
    const other = await call(vendeurSiteB, 'GET', '/voucher-batches');
    expect(other.json<Page<VoucherBatch>>().items.map((b) => b.id)).not.toContain(batch.id);
    expect((await call(vendeurSiteB, 'GET', `/voucher-batches/${batch.id}`)).statusCode).toBe(404);
    const voucherId = sheet.vouchers[0]?.id ?? '';
    expect((await call(vendeurSiteB, 'GET', `/vouchers/${voucherId}`)).statusCode).toBe(404);
    expect((await call(adminB, 'GET', `/vouchers/${voucherId}`)).statusCode).toBe(404);
    expect((await call(adminB, 'GET', '/vouchers')).json<Page<Voucher>>().total).toBe(0);

    const page = await call(gerantA, 'GET', `/vouchers?batchId=${batch.id}&limit=10&offset=10`);
    const vouchers = page.json<Page<Voucher>>();
    expect(vouchers.total).toBe(25);
    expect(vouchers.items).toHaveLength(10);
    expect(vouchers.items.map((v) => v.serial)).toEqual(
      Array.from({ length: 10 }, (_, i) => i + 11),
    );
    const bySerial = await call(gerantA, 'GET', `/vouchers?batchId=${batch.id}&serial=7`);
    expect(bySerial.json<Page<Voucher>>().items.map((v) => v.serial)).toEqual([7]);
    expect((await call(gerantA, 'GET', '/vouchers?state=ACTIVE')).json<Page<Voucher>>().total).toBe(
      0,
    );
    expect((await call(gerantA, 'GET', `/vouchers?code=abc`)).statusCode).toBe(422);
  });
});

describe('privilèges d’ecsi_app sur les tickets', () => {
  it('aucune colonne de code, consommation et activation non modifiables', async () => {
    const ctx = { companyId: t.seed.companies.A, userId: t.seed.users['gerant.a@ecsi.test'] ?? '' };
    expect(
      await sqlError(as(infra.urls.app, ctx, (c) => c.query('select code from vouchers'))),
    ).toBe('42703');
    for (const statement of [
      'update vouchers set used_seconds = 0',
      'update vouchers set used_bytes = 0',
      'update vouchers set activated_at = now()',
      'update vouchers set expires_at = now()',
      'update vouchers set code_lookup = code_lookup',
      'delete from vouchers',
      'delete from voucher_batches',
      'update voucher_batches set quantity = 1',
    ]) {
      expect(await sqlError(as(infra.urls.app, ctx, (c) => c.query(statement))), statement).toBe(
        '42501',
      );
    }
    // Seule la désactivation est admise (politique tenant_disable).
    expect(
      await sqlError(
        as(infra.urls.app, ctx, (c) => c.query("update vouchers set state = 'ACTIVE'")),
      ),
    ).toBe('42501');
    // Aucune ligne d'une autre entreprise.
    const other = await as(infra.urls.app, { companyId: t.seed.companies.B }, (c) =>
      c.query('select count(*)::int as n from vouchers'),
    );
    expect(other.rows[0]).toEqual({ n: 0 });
  });

  it('aucun code en base : seules les empreintes HMAC sont stockées', async () => {
    const { rows } = await t.migrator.query<{ dump: string }>(
      'select row_to_json(v)::text as dump from vouchers v',
    );
    const dump = rows.map((row) => row.dump).join('\n');
    for (const code of codes) expect(dump).not.toContain(code);
  });
});

describe('consommation (FreeRADIUS simulé) et détail d’un ticket', () => {
  it('acceptation puis accounting : ticket actif, session visible par son numéro de série', async () => {
    const voucher = sheet.vouchers[1];
    if (!voucher) throw new Error('ticket absent');
    const lookup = voucherLookup(LOOKUP_KEY, voucher.code);
    await radius('select radius.postauth($1, $2, $3, $4, $5)', [
      r1.tunnelIp,
      lookup,
      'ACCEPT',
      '',
      'AA:BB:CC:DD:EE:01',
    ]);
    await radius(
      'select radius.accounting($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)',
      [
        r1.tunnelIp,
        'Interim-Update',
        lookup,
        '81a00001',
        'u-0001',
        'AA:BB:CC:DD:EE:01',
        '10.5.50.20',
        '120',
        '1000',
        '0',
        '5000',
        '0',
        '',
      ],
    );
    await radius('select radius.postauth($1, $2, $3, $4, $5)', [
      r1.tunnelIp,
      lookup,
      'REJECT',
      'TOO_MANY_DEVICES',
      'AA:BB:CC:DD:EE:02',
    ]);
    const response = await call(gerantA, 'GET', `/vouchers/${voucher.id}`);
    expect(response.statusCode).toBe(200);
    const detail = response.json<VoucherDetail>();
    expect(detail).toMatchObject({
      serial: 2,
      state: 'ACTIVE',
      usedSeconds: 120,
      usedBytes: 6000,
      remaining: { sessionSeconds: 3480, bytes: 1_073_741_824 - 6000 },
    });
    expect(detail.activatedAt).not.toBeNull();
    expect(detail.expiresAt).not.toBeNull();
    expect(detail.remaining.validitySeconds).toBeGreaterThan(86_000);
    expect(detail.sessions).toHaveLength(1);
    expect(detail.sessions[0]).toMatchObject({
      voucher: { id: voucher.id, serial: 2, batchId: batch.id },
      router: { id: r1.id, name: 'R1 Riviera' },
      macAddress: 'AA:BB:CC:DD:EE:01',
      framedIp: '10.5.50.20',
      durationSeconds: 120,
      bytesUp: 1000,
      bytesDown: 5000,
      stoppedAt: null,
    });
    expect(detail.authAttempts.map((a) => [a.result, a.reason])).toEqual([
      ['REJECT', 'TOO_MANY_DEVICES'],
      ['ACCEPT', null],
    ]);
  });

  it('sessions actives : portée par site (clients.read)', async () => {
    const own = await call(gerantSiteA, 'GET', '/radius-sessions?active=true');
    expect(own.statusCode).toBe(200);
    const sessions = own.json<RadiusSession[]>();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ router: { name: 'R1 Riviera' }, voucher: { serial: 2 } });
    expect((await call(vendeurSiteB, 'GET', '/radius-sessions')).json<RadiusSession[]>()).toEqual(
      [],
    );
    expect((await call(adminB, 'GET', '/radius-sessions')).json<RadiusSession[]>()).toEqual([]);
    expect(
      (await call(gerantA, 'GET', `/radius-sessions?active=false&routerId=${r1.id}`)).json<
        RadiusSession[]
      >(),
    ).toEqual([]);
  });
});

describe('désactivation d’un ticket', () => {
  it('permission sensible, portée, motif, audit, définitive', async () => {
    const voucher = sheet.vouchers[2];
    if (!voucher) throw new Error('ticket absent');
    // VENDEUR : vouchers.disable absente.
    expect(
      (await call(vendeurSiteB, 'POST', `/vouchers/${voucher.id}/disable`, {})).statusCode,
    ).toBe(403);
    expect((await call(adminB, 'POST', `/vouchers/${voucher.id}/disable`, {})).statusCode).toBe(
      404,
    );
    const response = await call(gerantSiteA, 'POST', `/vouchers/${voucher.id}/disable`, {
      reason: 'Ticket perdu par le client',
    });
    expect(response.statusCode, response.body).toBe(200);
    const detail = response.json<VoucherDetail>();
    expect(detail).toMatchObject({
      state: 'DISABLED',
      disabledReason: 'Ticket perdu par le client',
      disabledBy: { id: t.seed.users['gerant.site-a@ecsi.test'] },
    });
    expect(
      (await call(gerantSiteA, 'POST', `/vouchers/${voucher.id}/disable`, {})).statusCode,
    ).toBe(409);
    const [event] = await auditRows('vouchers.disable');
    expect(event).toMatchObject({ resource_id: voucher.id, site_id: site('A', 'SITE-A') });
    expect(event?.details).toMatchObject({ serial: 3, reason: 'Ticket perdu par le client' });
  });
});

describe('hotspots', () => {
  const valid = {
    name: 'Hotspot Riviera',
    interface: 'ether2',
    gatewayAddress: '10.5.50.1/24',
    poolStart: '10.5.50.10',
    poolEnd: '10.5.50.254',
    dnsName: 'wifi.riviera.example',
  };
  let hotspot: Hotspot;

  it('validation du réseau et de l’interface', async () => {
    for (const change of [
      { gatewayAddress: '8.8.8.1/24', poolStart: '8.8.8.10', poolEnd: '8.8.8.20' },
      { poolStart: '10.5.50.1' },
      { poolEnd: '10.5.51.10' },
      { gatewayAddress: '10.5.50.1/31' },
      { interface: 'ether 2' },
      { dnsName: 'pas un nom' },
      { authentication: 'pap' },
    ]) {
      const response = await call(gerantA, 'POST', '/hotspots', {
        routerId: r1.id,
        ...valid,
        ...change,
      });
      expect(response.statusCode, JSON.stringify(change)).toBe(422);
    }
    // Chevauchement du réseau tunnel des routeurs (10.200.0.0/24).
    const tunnel = await call(gerantA, 'POST', '/hotspots', {
      routerId: r1.id,
      ...valid,
      gatewayAddress: '10.200.0.129/25',
      poolStart: '10.200.0.130',
      poolEnd: '10.200.0.140',
    });
    expect(tunnel.statusCode).toBe(422);
    expect(tunnel.body).toContain('réseau tunnel');
  });

  it('création : site du routeur, PENDING, version 1, audit', async () => {
    const response = await call(gerantA, 'POST', '/hotspots', { routerId: r1.id, ...valid });
    expect(response.statusCode, response.body).toBe(201);
    hotspot = response.json<Hotspot>();
    expect(hotspot).toMatchObject({
      ...valid,
      router: { id: r1.id, tunnelIp: '10.200.0.2' },
      site: { id: site('A', 'SITE-A') },
      desiredState: 'ENABLED',
      syncStatus: 'PENDING',
      configVersion: 1,
      appliedVersion: null,
    });
    expect((await auditRows('hotspots.create'))[0]).toMatchObject({
      resource_id: hotspot.id,
      site_id: site('A', 'SITE-A'),
    });
    // FreeRADIUS (rôle ecsi_radius) : le routeur est désormais un NAS connu ; l'empreinte
    // d'un code imprimé est acceptée, celle du ticket désactivé est refusée.
    const decision = async (code: string) =>
      (
        await radius('select value from radius.authorize_check($1, $2, $3)', [
          r1.tunnelIp,
          voucherLookup(LOOKUP_KEY, code),
          'AA:BB:CC:DD:EE:09',
        ])
      ).rows[0]?.value as string;
    expect(await decision(sheet.vouchers[4]?.code ?? '')).toBe('ACCEPT');
    expect(await decision(sheet.vouchers[2]?.code ?? '')).toBe('DISABLED');
    expect(await decision('zzzzzzzz')).toBe('UNKNOWN');
    // Un seul hotspot par routeur.
    expect(
      (await call(gerantA, 'POST', '/hotspots', { routerId: r1.id, ...valid })).statusCode,
    ).toBe(409);
  });

  it('portée : routeur d’un autre site ou d’une autre entreprise, permissions', async () => {
    expect(
      (await call(gerantSiteA, 'POST', '/hotspots', { routerId: r2.id, ...valid })).statusCode,
    ).toBe(404);
    expect(
      (await call(gerantA, 'POST', '/hotspots', { routerId: rb.id, ...valid })).statusCode,
    ).toBe(404);
    expect((await call(vendeurSiteB, 'GET', '/hotspots')).statusCode).toBe(403);
    expect((await call(adminB, 'GET', `/hotspots/${hotspot.id}`)).statusCode).toBe(404);
    expect((await call(adminB, 'GET', '/hotspots')).json<Hotspot[]>()).toEqual([]);
    expect(
      (await call(gerantSiteA, 'GET', '/hotspots')).json<Hotspot[]>().map((h) => h.id),
    ).toEqual([hotspot.id]);
  });

  it('modification : nouvelle version, retour à PENDING après une synchronisation', async () => {
    // Le worker a appliqué la version 1.
    const worker = new pg.Pool({ connectionString: infra.urls.worker, max: 1 });
    await worker.query(
      "update hotspots set sync_status = 'SYNCED', applied_version = 1, last_sync_at = now() where id = $1",
      [hotspot.id],
    );
    await worker.end();
    const partial = await call(gerantA, 'PATCH', `/hotspots/${hotspot.id}`, {
      poolStart: '10.5.50.20',
    });
    expect(partial.statusCode).toBe(422);
    const response = await call(gerantA, 'PATCH', `/hotspots/${hotspot.id}`, {
      name: 'Hotspot Riviera 2',
      gatewayAddress: '10.5.60.1/24',
      poolStart: '10.5.60.10',
      poolEnd: '10.5.60.200',
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json<Hotspot>()).toMatchObject({
      name: 'Hotspot Riviera 2',
      gatewayAddress: '10.5.60.1/24',
      syncStatus: 'PENDING',
      configVersion: 2,
      appliedVersion: 1,
    });
    const [event] = await auditRows('hotspots.update');
    expect(event?.details).toMatchObject({
      configVersion: 2,
      changes: { poolEnd: { before: '10.5.50.254', after: '10.5.60.200' } },
    });
  });

  it('désactivation, activation, synchronisation : version incrémentée, PENDING', async () => {
    const disabled = (
      await call(gerantA, 'POST', `/hotspots/${hotspot.id}/disable`)
    ).json<Hotspot>();
    expect(disabled).toMatchObject({
      desiredState: 'DISABLED',
      configVersion: 3,
      syncStatus: 'PENDING',
    });
    const enabled = (await call(gerantA, 'POST', `/hotspots/${hotspot.id}/enable`)).json<Hotspot>();
    expect(enabled).toMatchObject({ desiredState: 'ENABLED', configVersion: 4 });
    const synced = (await call(gerantA, 'POST', `/hotspots/${hotspot.id}/sync`)).json<Hotspot>();
    expect(synced).toMatchObject({ configVersion: 5, syncStatus: 'PENDING' });
    for (const action of ['hotspots.disable', 'hotspots.enable', 'hotspots.sync']) {
      expect((await auditRows(action)).length, action).toBe(1);
    }
  });

  it('ecsi_app ne peut écrire ni l’état de synchronisation ni une autre valeur que PENDING', async () => {
    const ctx = { companyId: t.seed.companies.A };
    expect(
      await sqlError(
        as(infra.urls.app, ctx, (c) => c.query("update hotspots set sync_status = 'SYNCED'")),
      ),
    ).toBe('42501');
    for (const statement of [
      'update hotspots set applied_version = 9',
      'update hotspots set last_error = null',
      'update hotspots set site_id = site_id',
      'delete from hotspots',
    ]) {
      expect(await sqlError(as(infra.urls.app, ctx, (c) => c.query(statement))), statement).toBe(
        '42501',
      );
    }
  });

  it('suppression logique : invisible, désactivée, nouvelle version pour le worker', async () => {
    expect((await call(gerantA, 'DELETE', `/hotspots/${hotspot.id}`)).statusCode).toBe(204);
    expect((await call(gerantA, 'GET', `/hotspots/${hotspot.id}`)).statusCode).toBe(404);
    expect((await call(gerantA, 'GET', '/hotspots')).json<Hotspot[]>()).toEqual([]);
    const { rows } = await t.migrator.query(
      'select desired_state, sync_status, config_version, deleted_at is not null as deleted from hotspots where id = $1',
      [hotspot.id],
    );
    expect(rows[0]).toEqual({
      desired_state: 'DISABLED',
      sync_status: 'PENDING',
      config_version: 6,
      deleted: true,
    });
    // Un nouveau hotspot peut ensuite être créé sur le même routeur.
    expect(
      (await call(gerantA, 'POST', '/hotspots', { routerId: r1.id, ...valid })).statusCode,
    ).toBe(201);
  });
});

describe('aucun code hors de l’impression', () => {
  it('ni dans les journaux, ni dans le journal d’audit, ni dans les autres réponses', async () => {
    expect(codes.size).toBe(25);
    const output = logs.join('');
    expect(output.length).toBeGreaterThan(0);
    const { rows } = await t.migrator.query<{ dump: string }>(
      'select row_to_json(a)::text as dump from audit_events a',
    );
    const audit = rows.map((row) => row.dump).join('\n');
    expect(audit).toContain('vouchers.export');
    const responses = bodies.join('\n');
    for (const code of codes) {
      expect(output).not.toContain(code);
      expect(audit).not.toContain(code);
      expect(responses).not.toContain(code);
    }
  });
});

describe('clés de tickets absentes', () => {
  it('génération et impression : 503 explicite ; le reste fonctionne', async () => {
    const other = await startTestApp(infra);
    try {
      const gerant = await loginAs(other.app, 'gerant.a@ecsi.test');
      const generate = await gerant.post('/voucher-batches', {
        planId: plan.id,
        siteId: other.seed.sites.A['SITE-A'],
        quantity: 1,
      });
      expect(generate.statusCode).toBe(503);
      expect(generate.json<{ detail: string }>().detail).toBe('Clés de tickets non configurées');
      const print = await gerant.get(`/voucher-batches/${batch.id}/print`);
      expect(print.statusCode).toBe(503);
      expect(print.body).not.toContain(sheet.vouchers[0]?.code ?? '-');
      expect(
        (await gerant.post(`/vouchers/${sheet.vouchers[0]?.id ?? ''}/print`, {})).statusCode,
      ).toBe(503);
      expect((await gerant.get('/plans')).statusCode).toBe(200);
      expect((await gerant.get(`/vouchers/${sheet.vouchers[0]?.id ?? ''}`)).statusCode).toBe(200);
      expect((await gerant.get('/hotspots')).statusCode).toBe(200);
    } finally {
      await other.app.close();
      await other.migrator.end();
    }
  });
});
