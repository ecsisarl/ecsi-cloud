/**
 * Sprint 2 — console SUPER_ADMIN (domaine plateforme). Démontre : les entreprises sont
 * gérées depuis la plateforme uniquement, chaque action est auditée, les deux domaines
 * restent séparés, et toute altération du journal est détectée.
 */
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SEED_PLATFORM_ADMIN } from '../src/database/seed.js';
import {
  enrollMfa,
  HttpClient,
  loginAs,
  SEED_PASSWORD,
  startTestApp,
  type TestApp,
} from './helpers/app.js';
import { startInfra, type TestInfra } from './helpers/infra.js';

let infra: TestInfra;
let t: TestApp;
let platform: HttpClient;
let platformMfa: Awaited<ReturnType<typeof enrollMfa>>;
let adminA: HttpClient;

interface PlatformEvent {
  action: string;
  result: string;
  companyId: string | null;
  companyName: string | null;
  actorType: string;
  actorId: string | null;
  actorRoles: string[];
  resourceId: string | null;
  details: Record<string, unknown>;
}

const platformAudit = async (query: string) => {
  const response = await platform.get(`/platform/audit?${query}`);
  expect(response.statusCode).toBe(200);
  return response.json<{ data: PlatformEvent[] }>().data;
};

beforeAll(async () => {
  infra = await startInfra();
  t = await startTestApp(infra);
  platform = new HttpClient(t.app);
  const login = await platform.post('/platform/auth/login', {
    email: SEED_PLATFORM_ADMIN.email,
    password: SEED_PASSWORD,
  });
  expect(login.statusCode).toBe(200);
  platformMfa = await enrollMfa(platform, '/platform/auth');
  adminA = await loginAs(t.app, 'admin.a@ecsi.test');
  await enrollMfa(adminA);
}, 180_000);

afterAll(async () => {
  await t.close();
  await infra.stop();
});

describe('séparation des domaines plateforme / entreprise', () => {
  it('une session d’entreprise est refusée sur la console, même ADMIN_ENTREPRISE', async () => {
    for (const url of [
      '/platform/companies',
      `/platform/companies/${t.seed.companies.A}`,
      '/platform/audit',
    ]) {
      expect((await adminA.get(url)).statusCode, url).toBe(403);
    }
    const create = await adminA.post('/platform/companies', {
      name: 'Pirate',
      adminEmail: 'p@ecsi.test',
    });
    expect(create.statusCode).toBe(403);
  });

  it('une session plateforme est refusée sur les routes d’entreprise', async () => {
    for (const url of ['/company', '/sites', '/users', '/audit', '/site-groups']) {
      expect((await platform.get(url)).statusCode, url).toBe(403);
    }
  });

  it('la console exige la 2FA du super administrateur', async () => {
    const fresh = new HttpClient(t.app);
    await fresh.post('/platform/auth/login', {
      email: SEED_PLATFORM_ADMIN.email,
      password: SEED_PASSWORD,
    });
    // 2FA configurée : la connexion attend le code, aucune session n'est ouverte.
    expect((await fresh.get('/platform/companies')).statusCode).toBe(401);
  });
});

describe('gestion des entreprises', () => {
  it('liste, recherche et filtre les entreprises avec leurs compteurs réels', async () => {
    const page = (await platform.get('/platform/companies')).json<{
      data: { slug: string; memberCount: number; siteCount: number }[];
      total: number;
    }>();
    expect(page.total).toBeGreaterThanOrEqual(2);
    const a = page.data.find((c) => c.slug === 'entreprise-a');
    expect(a).toMatchObject({ memberCount: 5, siteCount: 2 });
    const search = (await platform.get('/platform/companies?q=entreprise-b')).json<{
      data: { slug: string }[];
    }>();
    expect(search.data.map((c) => c.slug)).toEqual(['entreprise-b']);
    expect(
      (await platform.get('/platform/companies?q=%25')).json<{ data: unknown[] }>().data,
    ).toEqual([]);
  });

  it('consulte une entreprise (administrateurs, compteurs)', async () => {
    const detail = await platform.get(`/platform/companies/${t.seed.companies.A}`);
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({
      name: 'ENTREPRISE_A',
      memberCount: 5,
      siteCount: 2,
      admins: [{ email: 'admin.a@ecsi.test' }],
    });
    expect(
      (await platform.get('/platform/companies/0190a0f0-0000-7000-8000-000000000000')).statusCode,
    ).toBe(404);
  });

  it('crée une entreprise (rôles système, invitation du premier administrateur) et l’audite', async () => {
    const created = await platform.post('/platform/companies', {
      name: 'Wifi Zone Bouaké',
      adminEmail: 'patron@bouake.ci',
    });
    expect(created.statusCode).toBe(201);
    const company = created.json<{
      id: string;
      slug: string;
      country: string;
      currency: string;
      pendingInvitations: number;
    }>();
    expect(company).toMatchObject({
      slug: 'wifi-zone-bouake',
      country: 'CI',
      currency: 'XOF',
      pendingInvitations: 1,
    });
    const roles = await t.migrator.query(
      'select code from roles where company_id = $1 order by code',
      [company.id],
    );
    expect(roles.rows.map((r: { code: string }) => r.code)).toEqual([
      'ADMIN_ENTREPRISE',
      'COMPTABLE',
      'GERANT',
      'SUPPORT',
      'TECHNICIEN',
      'VENDEUR',
    ]);
    const token = await t.mails.tokenFor('patron@bouake.ci', '/invitation');
    expect(token).toHaveLength(43);
    // L'invité devient ADMIN_ENTREPRISE de la nouvelle entreprise.
    const accept = await new HttpClient(t.app).post('/auth/invitations/accept', {
      token,
      fullName: 'Patron Bouaké',
      password: 'Un-mot-de-passe-solide-2026',
    });
    expect(accept.statusCode).toBeLessThan(300);
    const admins = (await platform.get(`/platform/companies/${company.id}`)).json<{
      admins: { email: string }[];
    }>();
    expect(admins.admins.map((a) => a.email)).toEqual(['patron@bouake.ci']);

    const events = await platformAudit(`action=platform.companies.create&companyId=${company.id}`);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      result: 'SUCCESS',
      actorType: 'PLATFORM_ADMIN',
      actorRoles: ['SUPER_ADMIN'],
      companyName: 'Wifi Zone Bouaké',
      details: { adminEmail: 'patron@bouake.ci' },
    });
    expect(
      (
        await platform.post('/platform/companies', {
          name: 'Autre',
          slug: 'wifi-zone-bouake',
          adminEmail: 'x@y.ci',
        })
      ).statusCode,
    ).toBe(409);
  });

  it('suspend une entreprise : sessions coupées immédiatement, accès refusé ; puis réactive', async () => {
    const gerantB = await loginAs(t.app, 'gerant.b@ecsi.test');
    expect((await gerantB.get('/sites')).statusCode).toBe(200);
    const id = t.seed.companies.B;
    expect(
      (
        await platform.patch(`/platform/companies/${id}/status`, {
          status: 'SUSPENDED',
          reason: 'x',
        })
      ).statusCode,
    ).toBe(422); // motif obligatoire
    const suspended = await platform.patch(`/platform/companies/${id}/status`, {
      status: 'SUSPENDED',
      reason: 'Abonnement impayé',
    });
    expect(suspended.statusCode).toBe(200);
    expect(suspended.json()).toMatchObject({
      status: 'SUSPENDED',
      suspensionReason: 'Abonnement impayé',
    });
    expect((await gerantB.get('/sites')).statusCode).toBe(401);
    const sessions = await t.migrator.query(
      'select 1 from auth_sessions where company_id = $1 and revoked_at is null',
      [id],
    );
    expect(sessions.rowCount).toBe(0);
    // Une nouvelle connexion n'ouvre aucun accès à l'entreprise suspendue.
    const again = new HttpClient(t.app);
    await again.post('/auth/login', { email: 'gerant.b@ecsi.test', password: SEED_PASSWORD });
    expect((await again.get('/sites')).statusCode).not.toBe(200);
    // ENTREPRISE_A n'est pas affectée.
    expect((await adminA.get('/company')).statusCode).toBe(200);

    expect(
      (
        await platform.patch(`/platform/companies/${id}/status`, {
          status: 'SUSPENDED',
          reason: 'Encore',
        })
      ).statusCode,
    ).toBe(409);
    const reactivated = await platform.patch(`/platform/companies/${id}/status`, {
      status: 'ACTIVE',
      reason: 'Paiement reçu',
    });
    expect(reactivated.json()).toMatchObject({ status: 'ACTIVE', suspendedAt: null });
    expect(
      (await loginAs(t.app, 'gerant.b@ecsi.test').then((c) => c.get('/sites'))).statusCode,
    ).toBe(200);

    const events = await platformAudit(`companyId=${id}&action=platform.companies.*`);
    expect(events.map((e) => e.action)).toEqual([
      'platform.companies.reactivate',
      'platform.companies.suspend',
    ]);
  });

  it('l’entreprise voit dans son propre journal les interventions du super administrateur', async () => {
    const adminB = await loginAs(t.app, 'admin.b@ecsi.test');
    await enrollMfa(adminB);
    const own = (await adminB.get('/audit?action=platform.companies.*')).json<{
      data: PlatformEvent[];
    }>().data;
    expect(own.map((e) => e.action)).toEqual([
      'platform.companies.reactivate',
      'platform.companies.suspend',
    ]);
    expect(own.every((e) => e.actorType === 'PLATFORM_ADMIN')).toBe(true);
  });
});

describe('récupération 2FA par le support ECSI', () => {
  it('recherche un compte puis réinitialise sa 2FA avec le code du super administrateur', async () => {
    const found = (await platform.get('/platform/users?q=admin.a@')).json<
      { id: string; email: string; mfaEnabled: boolean; companies: { name: string }[] }[]
    >();
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      email: 'admin.a@ecsi.test',
      mfaEnabled: true,
      companies: [{ name: 'ENTREPRISE_A' }],
    });
    const target = found[0]?.id ?? '';
    const reason = { reason: 'Demande vérifiée par le support ECSI' };
    expect(
      (await platform.post(`/platform/users/${target}/mfa/reset`, { code: '000000', ...reason }))
        .statusCode,
    ).toBe(422);
    const ok = await platform.post(`/platform/users/${target}/mfa/reset`, {
      code: platformMfa.nextCode(),
      ...reason,
    });
    expect(ok.statusCode).toBe(204);
    expect((await adminA.get('/company')).statusCode).toBe(401);
    const companyChain = await platformAudit(
      `action=platform.users.mfa_reset&companyId=${t.seed.companies.A}&result=SUCCESS`,
    );
    expect(companyChain).toHaveLength(1);
    expect(JSON.stringify(companyChain)).not.toMatch(/secret_enc|v2:k1/);
  });
});

describe('intégrité du journal', () => {
  it('vérifie les chaînes, puis détecte une altération faite directement en base', async () => {
    const ok = (await platform.get(`/platform/audit/verify/${t.seed.companies.A}`)).json<{
      valid: boolean;
      checked: number;
    }>();
    expect(ok.valid).toBe(true);
    expect(ok.checked).toBeGreaterThan(0);
    expect(
      (await platform.get('/platform/audit/verify/platform')).json<{ valid: boolean }>().valid,
    ).toBe(true);
    expect((await platform.get('/platform/audit/verify/pas-une-chaine')).statusCode).toBe(422);

    // Un administrateur de base malveillant désactive les protections et réécrit un événement.
    const superuser = new pg.Pool({ connectionString: infra.urls.superuser, max: 1 });
    try {
      await superuser.query('alter table audit_events disable trigger user');
      await superuser.query(
        `update audit_events set details = '{"falsifié": true}'
         where id = (select id from audit_events where company_id = $1 order by chain_seq limit 1)`,
        [t.seed.companies.A],
      );
      await superuser.query('alter table audit_events enable trigger user');
    } finally {
      await superuser.end();
    }
    const broken = (await platform.get(`/platform/audit/verify/${t.seed.companies.A}`)).json<{
      valid: boolean;
      brokenSeqs: number[];
    }>();
    expect(broken.valid).toBe(false);
    expect(broken.brokenSeqs[0]).toBe(1);
  });
});
