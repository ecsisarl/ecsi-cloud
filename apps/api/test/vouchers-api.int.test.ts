/**
 * Sprint 6 — forfaits et tickets, sur PostgreSQL 18 réel et rôles réels : API HTTP complète
 * (sessions, CSRF, permissions par site, audit), RLS, clés composites, privilèges de
 * colonnes et déclencheur de cycle de vie de la migration 0007. Le RADIUS (application
 * des limites, passage à ACTIVE/EXPIRED) n'existe pas encore : il n'est PAS testé ici.
 */
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Plan, Voucher, VoucherBatch, VoucherBatchPrint, VoucherDetail } from '@ecsi/shared';
import { enrollMfa, type HttpClient, loginAs, startTestApp, type TestApp } from './helpers/app.js';
import { startInfra, type TestInfra } from './helpers/infra.js';

let infra: TestInfra;
let t: TestApp;
let adminA: HttpClient;
let adminB: HttpClient;
let gerantA: HttpClient;
let gerantSiteA: HttpClient;
let vendeurSiteB: HttpClient;
let plan: Plan;

const site = (key: 'A' | 'B', code: string) => t.seed.sites[key][code] ?? '';
const companyA = () => t.seed.companies.A;

const auditCount = async (action: string, resourceId?: string) =>
  Number(
    (
      await t.migrator.query<{ n: string }>(
        `select count(*) as n from audit_events where action = $1 and result = 'SUCCESS'
           and ($2::text is null or resource_id = $2)`,
        [action, resourceId ?? null],
      )
    ).rows[0]?.n ?? 0,
  );

async function asApp<T>(companyId: string, work: (client: pg.PoolClient) => Promise<T>) {
  const pool = new pg.Pool({ connectionString: infra.urls.app, max: 1 });
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query("select set_config('app.company_id', $1, true)", [companyId]);
    return await work(client);
  } finally {
    await client.query('rollback').catch(() => undefined);
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

async function generate(client: HttpClient, body: Record<string, unknown>) {
  return client.post('/voucher-batches', { planId: plan.id, siteId: site('A', 'SITE-A'), ...body });
}

beforeAll(async () => {
  infra = await startInfra();
  t = await startTestApp(infra);
  adminA = await loginAs(t.app, 'admin.a@ecsi.test');
  await enrollMfa(adminA);
  adminB = await loginAs(t.app, 'admin.b@ecsi.test');
  await enrollMfa(adminB);
  gerantA = await loginAs(t.app, 'gerant.a@ecsi.test');
  gerantSiteA = await loginAs(t.app, 'gerant.site-a@ecsi.test');
  vendeurSiteB = await loginAs(t.app, 'vendeur.site-b@ecsi.test');
}, 240_000);

afterAll(async () => {
  await t.close();
  await infra.stop();
});

describe('forfaits', () => {
  it("l'administrateur crée un forfait (montant entier, XOF par défaut), audité", async () => {
    const response = await adminA.post('/plans', {
      name: '1 heure',
      priceAmount: 200,
      sessionTimeSeconds: 3600,
      rateDownKbps: 2000,
      rateUpKbps: 1000,
    });
    expect(response.statusCode, response.body).toBe(201);
    plan = response.json<Plan>();
    expect(plan).toMatchObject({ currency: 'XOF', maxDevices: 1, defaultScope: 'LOCAL' });
    expect(await auditCount('plans.create', plan.id)).toBe(1);
  });

  it('nom unique dans l’entreprise, mais réutilisable par une autre entreprise', async () => {
    expect((await adminA.post('/plans', { name: '1 heure', priceAmount: 100 })).statusCode).toBe(
      409,
    );
    expect((await adminB.post('/plans', { name: '1 heure', priceAmount: 100 })).statusCode).toBe(
      201,
    );
  });

  it('le vendeur lit les forfaits mais ne peut pas les gérer', async () => {
    const list = await vendeurSiteB.get('/plans');
    expect(list.statusCode).toBe(200);
    expect(list.json<Plan[]>().map((p) => p.name)).toContain('1 heure');
    expect((await vendeurSiteB.patch(`/plans/${plan.id}`, { priceAmount: 1 })).statusCode).toBe(
      403,
    );
  });

  it("un forfait d'une autre entreprise est introuvable", async () => {
    expect((await adminB.get(`/plans/${plan.id}`)).statusCode).toBe(404);
    expect((await adminB.patch(`/plans/${plan.id}`, { priceAmount: 1 })).statusCode).toBe(404);
  });
});

describe('génération de tickets', () => {
  let batch: VoucherBatch;

  it('génère 1 000 tickets uniques en une transaction, avec historique et audit', async () => {
    const response = await generate(gerantA, { quantity: 1000, label: 'Marché du lundi' });
    expect(response.statusCode, response.body).toBe(201);
    batch = response.json<VoucherBatch>();
    expect(batch).toMatchObject({
      number: 1,
      quantity: 1000,
      unitPrice: 200,
      currency: 'XOF',
      scope: 'LOCAL',
      label: 'Marché du lundi',
    });
    expect(batch.counts.AVAILABLE).toBe(1000);
    const stats = await t.migrator.query<{ n: string; codes: string; serials: number }>(
      `select count(*) as n, count(distinct code) as codes, max(serial) as serials
         from vouchers where batch_id = $1`,
      [batch.id],
    );
    expect(stats.rows[0]).toEqual({ n: '1000', codes: '1000', serials: 1000 });
    const events = await t.migrator.query<{ n: string }>(
      `select count(*) as n from voucher_events e join vouchers v on v.id = e.voucher_id
        where v.batch_id = $1 and e.to_state = 'AVAILABLE'`,
      [batch.id],
    );
    expect(events.rows[0]?.n).toBe('1000');
    expect(await auditCount('vouchers.generate', batch.id)).toBe(1);
  }, 60_000);

  it('le prix est figé dans le lot même si le forfait change ensuite', async () => {
    await adminA.patch(`/plans/${plan.id}`, { priceAmount: 250 });
    const response = await gerantA.get(`/voucher-batches/${batch.id}`);
    expect(response.json<VoucherBatch>().unitPrice).toBe(200);
    await adminA.patch(`/plans/${plan.id}`, { priceAmount: 200 });
  });

  it('mode identifiant + mot de passe avec préfixe et majuscules', async () => {
    const response = await generate(gerantA, {
      quantity: 5,
      authMode: 'USER_PASS',
      charset: 'UPPER_DIGITS',
      length: 6,
      prefix: 'WZ',
    });
    expect(response.statusCode, response.body).toBe(201);
    const created = response.json<VoucherBatch>();
    const rows = await t.migrator.query<{ code: string; password: string | null }>(
      'select code, password from vouchers where batch_id = $1',
      [created.id],
    );
    for (const row of rows.rows) {
      expect(row.code).toMatch(/^WZ[A-HJ-NP-Z2-9]{6}$/);
      expect(row.password).toMatch(/^[A-HJ-NP-Z2-9]{6}$/);
    }
  });

  it('refuse un code trop faible, un forfait inactif ou un site hors portée', async () => {
    expect((await generate(gerantA, { quantity: 1, length: 6 })).statusCode).toBe(422);
    expect(
      (await generate(gerantSiteA, { quantity: 1, siteId: site('A', 'SITE-B') })).statusCode,
    ).toBe(404);
    expect((await generate(vendeurSiteB, { quantity: 1 })).statusCode).toBe(403);
    const inactive = await adminA.post('/plans', {
      name: 'Ancien',
      priceAmount: 100,
      status: 'INACTIVE',
    });
    expect(
      (await generate(gerantA, { quantity: 1, planId: inactive.json<Plan>().id })).statusCode,
    ).toBe(422);
  });

  it("le site d'une autre entreprise est introuvable", async () => {
    const response = await adminB.post('/voucher-batches', {
      planId: plan.id,
      siteId: site('A', 'SITE-A'),
      quantity: 1,
    });
    expect(response.statusCode).toBe(404);
  });

  it('les listes masquent les codes ; la recherche exacte retrouve un ticket', async () => {
    const list = await gerantA.get(`/vouchers?batchId=${batch.id}&limit=5`);
    expect(list.statusCode).toBe(200);
    const items = list.json<Voucher[]>();
    expect(items).toHaveLength(5);
    expect(list.body).not.toMatch(/"code"|"password"/);
    expect(items[0]?.maskedCode).toMatch(/^\d{2}•{4}\d{2}$/);

    const [{ code } = { code: '' }] = (
      await t.migrator.query<{ code: string }>(
        'select code from vouchers where batch_id = $1 and serial = 7',
        [batch.id],
      )
    ).rows;
    const found = await gerantA.get(`/vouchers?code=${code}`);
    expect(found.json<Voucher[]>().map((v) => v.serial)).toEqual([7]);
    // Un autre utilisateur hors du site ne trouve rien.
    expect((await vendeurSiteB.get(`/vouchers?code=${code}`)).json<Voucher[]>()).toEqual([]);
    expect((await adminB.get(`/vouchers?code=${code}`)).json<Voucher[]>()).toEqual([]);
  });

  it('impression : codes en clair, permission vouchers.export, auditée', async () => {
    // Sans vouchers.export nulle part : refus du garde. Hors du site du lot : introuvable.
    expect((await vendeurSiteB.post(`/voucher-batches/${batch.id}/print`)).statusCode).toBe(403);
    expect((await vendeurSiteB.get(`/voucher-batches/${batch.id}`)).statusCode).toBe(404);
    const response = await gerantA.post(`/voucher-batches/${batch.id}/print`);
    expect(response.statusCode, response.body).toBe(200);
    const print = response.json<VoucherBatchPrint>();
    expect(print.vouchers).toHaveLength(1000);
    expect(print.vouchers[0]).toMatchObject({ serial: 1, password: null });
    expect(print.vouchers[0]?.username).toMatch(/^[2-9]{8}$/);
    expect(print.plan.name).toBe('1 heure');
    expect(await auditCount('vouchers.export', batch.id)).toBe(1);
    const audit = await t.migrator.query<{ details: string }>(
      `select details::text from audit_events where action = 'vouchers.export'`,
    );
    expect(audit.rows[0]?.details).not.toContain(print.vouchers[0]?.username ?? '§');
  });

  it('désactivation unitaire puis du lot ; un ticket désactivé ne revient jamais', async () => {
    const [first] = (await gerantA.get(`/vouchers?batchId=${batch.id}&limit=1`)).json<Voucher[]>();
    if (!first) throw new Error('aucun ticket');
    const one = await gerantA.post(`/vouchers/${first.id}/disable`, { reason: 'Ticket perdu' });
    expect(one.statusCode, one.body).toBe(200);
    const detail = one.json<VoucherDetail>();
    expect(detail.state).toBe('DISABLED');
    expect(detail.events.map((e) => e.toState)).toEqual(['AVAILABLE', 'DISABLED']);
    expect(
      (await gerantA.post(`/vouchers/${first.id}/disable`, { reason: 'Encore' })).statusCode,
    ).toBe(422);

    const all = await gerantA.post(`/voucher-batches/${batch.id}/disable`, {
      reason: 'Carnet volé',
    });
    expect(all.statusCode, all.body).toBe(200);
    expect(all.json<VoucherBatch>().counts).toMatchObject({ AVAILABLE: 0, DISABLED: 1000 });
    const print = await gerantA.post(`/voucher-batches/${batch.id}/print`);
    expect(print.json<VoucherBatchPrint>().vouchers).toHaveLength(0);

    // Déclencheur : même le rôle applicatif ne peut pas réactiver un ticket.
    const code = await asApp(companyA(), (client) =>
      sqlError(
        client.query(
          `update vouchers set state = 'AVAILABLE', disabled_at = null
        where id = $1`,
          [first.id],
        ),
      ),
    );
    expect(code).toBe('23514');
  }, 60_000);
});

describe('base de données', () => {
  it("ecsi_app ne peut ni modifier un code ni supprimer un ticket, un lot ou l'historique", async () => {
    const [row] = (
      await t.migrator.query<{ id: string; batch_id: string }>(
        'select id, batch_id from vouchers limit 1',
      )
    ).rows;
    if (!row) throw new Error('aucun ticket');
    const errors = await asApp(companyA(), async (client) => {
      const result: string[] = [];
      for (const statement of [
        `update vouchers set code = 'AAAAAAAA' where id = '${row.id}'`,
        `delete from vouchers where id = '${row.id}'`,
        `update voucher_batches set unit_price = 0 where id = '${row.batch_id}'`,
        `delete from voucher_events where voucher_id = '${row.id}'`,
        `delete from plans`,
      ]) {
        await client.query('savepoint s');
        result.push(await sqlError(client.query(statement)));
        await client.query('rollback to savepoint s');
      }
      return result;
    });
    expect(errors).toEqual(['42501', '42501', '42501', '42501', '42501']);
  });

  it("RLS : l'entreprise B ne voit aucun ticket de A", async () => {
    const counts = await asApp(
      t.seed.companies.B,
      async (client) =>
        (await client.query<{ n: string }>('select count(*) as n from vouchers')).rows[0]?.n,
    );
    expect(counts).toBe('0');
  });
});
