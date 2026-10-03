/**
 * Sprint 2 — administration d'une entreprise : profil, logo, membres (anti-escalade,
 * dernier administrateur), récupération 2FA, journal d'audit, rotation des clés.
 */
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { totp } from '../src/auth/crypto/totp.js';
import { SecretBox } from '../src/auth/crypto/secret-box.js';
import { rotateEncryptionKeys } from '../src/auth/key-rotation.js';
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

let infra: TestInfra;
let t: TestApp;
let adminA: HttpClient;
let adminMfa: Awaited<ReturnType<typeof enrollMfa>>;
let gerantA: HttpClient;
let adminB: HttpClient;

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('IHDR-donnees-de-test'),
]);
const userId = (email: string) => t.seed.users[email] ?? '';

interface AuditEventView {
  id: string;
  action: string;
  result: string;
  companyId: string | null;
  actorId: string | null;
  actorType: string;
  actorRoles: string[];
  resourceId: string | null;
  ip: string | null;
  userAgent: string | null;
  requestId: string | null;
  details: Record<string, unknown>;
}

const auditEvents = async (client: HttpClient, query: string) => {
  const response = await client.get(`/audit?${query}`);
  expect(response.statusCode).toBe(200);
  return response.json<{ data: AuditEventView[]; nextCursor: string | null }>();
};

const PROFILE = {
  name: 'ENTREPRISE_A',
  legalName: 'Entreprise A SARL',
  phone: '+2250700000001',
  whatsapp: '+2250700000002',
  email: 'contact@entreprise-a.ci',
  address: 'Rue des Jardins',
  city: 'Abidjan',
  country: 'CI',
  currency: 'XOF',
  locale: 'fr',
  timezone: 'Africa/Abidjan',
};

beforeAll(async () => {
  infra = await startInfra();
  t = await startTestApp(infra);
  adminA = await loginAs(t.app, 'admin.a@ecsi.test');
  adminMfa = await enrollMfa(adminA);
  gerantA = await loginAs(t.app, 'gerant.a@ecsi.test');
  adminB = await loginAs(t.app, 'admin.b@ecsi.test');
  await enrollMfa(adminB);
}, 180_000);

afterAll(async () => {
  await t.close();
  await infra.stop();
});

describe('profil de l’entreprise', () => {
  it('valeurs par défaut : Côte d’Ivoire, XOF (FCFA), français, Africa/Abidjan', async () => {
    const company = (await gerantA.get('/company')).json<Record<string, unknown>>();
    expect(company).toMatchObject({
      id: t.seed.companies.A,
      country: 'CI',
      currency: 'XOF',
      locale: 'fr',
      timezone: 'Africa/Abidjan',
      status: 'ACTIVE',
      hasLogo: false,
    });
  });

  it('modifie le profil (droit companies.update) et trace avant/après dans l’audit', async () => {
    expect((await gerantA.patch('/company', PROFILE)).statusCode).toBe(403);
    const updated = await adminA.patch('/company', PROFILE, {
      headers: { 'user-agent': 'ecsi-test-agent' },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({ legalName: 'Entreprise A SARL', city: 'Abidjan' });

    const { data } = await auditEvents(adminA, 'action=company.update');
    const event = data[0];
    expect(event).toMatchObject({
      result: 'SUCCESS',
      companyId: t.seed.companies.A,
      actorId: userId('admin.a@ecsi.test'),
      actorType: 'USER',
      resourceId: t.seed.companies.A,
      userAgent: 'ecsi-test-agent',
    });
    expect(event?.actorRoles).toContain('ADMIN_ENTREPRISE');
    expect(event?.ip).toBeTruthy();
    expect(event?.requestId).toBeTruthy();
    expect(event?.details).toMatchObject({
      changes: { legalName: { before: null, after: 'Entreprise A SARL' } },
    });
  });

  it('refuse un statut, un fuseau, une devise ou un pays invalides et toute modification du statut', async () => {
    for (const patch of [
      { timezone: 'Europe/Nulle-Part' },
      { currency: 'ABC' },
      { country: 'ZZ' },
      { phone: '0700' },
      { status: 'SUSPENDED' },
      { slug: 'autre' },
    ]) {
      expect(
        (await adminA.patch('/company', { ...PROFILE, ...patch })).statusCode,
        JSON.stringify(patch),
      ).toBe(422);
    }
  });

  it('paramètres généraux : droit settings.manage', async () => {
    const settings = {
      dateFormat: 'YYYY-MM-DD',
      weekStartsOn: 'SUNDAY',
      supportMessage: 'Appelez-nous',
    };
    expect((await gerantA.put('/company/settings', settings)).statusCode).toBe(403);
    const r = await adminA.put('/company/settings', settings);
    expect(r.statusCode).toBe(200);
    expect(r.json<{ settings: unknown }>().settings).toEqual(settings);
  });

  it('logo : PNG vérifié par signature, servi par l’API, SVG refusé, isolé par entreprise', async () => {
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    );
    expect(
      (
        await adminA.put('/company/logo', {
          contentType: 'image/png',
          data: svg.toString('base64'),
        })
      ).statusCode,
    ).toBe(422);
    const upload = await adminA.put('/company/logo', {
      contentType: 'image/png',
      data: PNG.toString('base64'),
    });
    expect(upload.statusCode).toBe(200);
    expect(upload.json<{ hasLogo: boolean }>().hasLogo).toBe(true);
    const logo = await gerantA.get('/company/logo');
    expect(logo.statusCode).toBe(200);
    expect(logo.headers['content-type']).toBe('image/png');
    expect(logo.headers['content-security-policy']).toContain('sandbox');
    expect(logo.rawPayload.equals(PNG)).toBe(true);
    // ENTREPRISE_B n'obtient que SON logo (aucun) : l'identifiant vient de la session.
    expect(
      (await adminB.get('/company/logo', { headers: { 'x-company-id': t.seed.companies.A } }))
        .statusCode,
    ).toBe(404);
    expect((await adminA.delete('/company/logo')).statusCode).toBe(200);
    expect((await gerantA.get('/company/logo')).statusCode).toBe(404);
  });
});

describe('membres : rôles, anti-escalade, désactivation, retrait', () => {
  it('liste, recherche et filtre les membres', async () => {
    const all = (await gerantA.get('/users')).json<{ email: string }[]>();
    expect(all.length).toBeGreaterThanOrEqual(5);
    const search = (await gerantA.get('/users?q=vendeuse')).json<{ email: string }[]>();
    expect(search.map((m) => m.email).sort()).toEqual([
      'vendeur.a@ecsi.test',
      'vendeur.site-b@ecsi.test',
    ]);
    // Membres ayant accès à SITE_B : portée entreprise ou portée incluant SITE_B.
    const bySite = (await gerantA.get(`/users?siteId=${t.seed.sites.A['SITE-B']}`)).json<
      { email: string }[]
    >();
    expect(bySite.map((m) => m.email)).toContain('vendeur.site-b@ecsi.test');
    expect(bySite.map((m) => m.email)).not.toContain('gerant.site-a@ecsi.test');
    const byRole = (await gerantA.get(`/users?roleId=${t.seed.roles.A.ADMIN_ENTREPRISE}`)).json<
      { email: string }[]
    >();
    expect(byRole.map((m) => m.email)).toEqual(['admin.a@ecsi.test']);
  });

  it('un GERANT ne peut jamais accorder un rôle plus puissant que le sien', async () => {
    const target = userId('vendeur.a@ecsi.test');
    const escalate = await gerantA.put(`/users/${target}/roles`, {
      roles: [{ roleId: t.seed.roles.A.ADMIN_ENTREPRISE }],
    });
    expect(escalate.statusCode).toBe(403);
    // Ni à lui-même.
    const self = await gerantA.put(`/users/${userId('gerant.a@ecsi.test')}/roles`, {
      roles: [{ roleId: t.seed.roles.A.ADMIN_ENTREPRISE }],
    });
    expect(self.statusCode).toBe(403);
    // Ni agir sur l'administrateur (dont il ne couvre pas les droits).
    expect(
      (await gerantA.patch(`/users/${userId('admin.a@ecsi.test')}/status`, { status: 'DISABLED' }))
        .statusCode,
    ).toBe(403);
    const roles = await t.migrator.query(
      `select r.code from membership_roles mr join roles r on r.id = mr.role_id
       join memberships m on m.id = mr.membership_id where m.user_id = $1`,
      [target],
    );
    expect(roles.rows).toEqual([{ code: 'VENDEUR' }]);
  });

  it('modifie les rôles d’un membre (portée site) et révoque ses sessions dans l’entreprise', async () => {
    const vendeur = await loginAs(t.app, 'vendeur.a@ecsi.test');
    const target = userId('vendeur.a@ecsi.test');
    const r = await gerantA.put(`/users/${target}/roles`, {
      roles: [
        { roleId: t.seed.roles.A.TECHNICIEN, scope: 'SITES', siteIds: [t.seed.sites.A['SITE-A']] },
      ],
    });
    expect(r.statusCode).toBe(200);
    expect((await vendeur.get('/auth/me')).statusCode).toBe(401);
    const { data } = await auditEvents(gerantA, `action=users.roles_update&resourceId=${target}`);
    expect(data[0]?.details).toMatchObject({
      roles: { before: ['VENDEUR (entreprise)'], after: ['TECHNICIEN (SITE-A)'] },
    });
  });

  it('un membre ne peut ni se désactiver, ni changer ses rôles, ni retirer son propre accès', async () => {
    const admin = userId('admin.a@ecsi.test');
    expect((await adminA.patch(`/users/${admin}/status`, { status: 'DISABLED' })).statusCode).toBe(
      403,
    );
    expect(
      (await adminA.put(`/users/${admin}/roles`, { roles: [{ roleId: t.seed.roles.A.GERANT }] }))
        .statusCode,
    ).toBe(403);
    expect((await adminA.delete(`/users/${admin}`)).statusCode).toBe(403);
  });

  it('désactive puis réactive un membre ; le membre désactivé perd l’accès', async () => {
    const client = await loginAs(t.app, 'gerant.site-a@ecsi.test');
    const target = userId('gerant.site-a@ecsi.test');
    expect(
      (await gerantA.patch(`/users/${target}/status`, { status: 'DISABLED' })).statusCode,
    ).toBe(200);
    expect((await client.get('/sites')).statusCode).toBe(401);
    expect((await gerantA.patch(`/users/${target}/status`, { status: 'ACTIVE' })).statusCode).toBe(
      200,
    );
    expect(
      (await loginAs(t.app, 'gerant.site-a@ecsi.test').then((c) => c.get('/sites'))).statusCode,
    ).toBe(200);
  });

  it('retire l’accès d’un membre à l’entreprise (compte conservé) et l’audite', async () => {
    const victim = await loginAs(t.app, 'vendeur.site-b@ecsi.test');
    const target = userId('vendeur.site-b@ecsi.test');
    expect((await gerantA.delete(`/users/${target}`)).statusCode).toBe(204);
    expect((await victim.get('/sites')).statusCode).toBe(401);
    expect((await gerantA.get(`/users/${target}`)).statusCode).toBe(404);
    const account = await t.migrator.query('select status from users where id = $1', [target]);
    expect(account.rows).toEqual([{ status: 'ACTIVE' }]);
    expect(
      (await auditEvents(gerantA, `action=users.remove&resourceId=${target}`)).data,
    ).toHaveLength(1);
  });

  it('ENTREPRISE_B ne peut agir sur aucun membre d’ENTREPRISE_A', async () => {
    const target = userId('gerant.a@ecsi.test');
    expect((await adminB.get(`/users/${target}`)).statusCode).toBe(404);
    expect((await adminB.patch(`/users/${target}/status`, { status: 'DISABLED' })).statusCode).toBe(
      404,
    );
    expect((await adminB.delete(`/users/${target}`)).statusCode).toBe(404);
    expect(
      (await adminB.put(`/users/${target}/roles`, { roles: [{ roleId: t.seed.roles.B.VENDEUR }] }))
        .statusCode,
    ).toBe(404);
  });
});

describe('récupération administrative de la 2FA', () => {
  it('exige la permission dédiée, le code TOTP de l’administrateur et un motif ; révoque les sessions', async () => {
    const gerant = await loginAs(t.app, 'gerant.a@ecsi.test');
    const gerantMfa = await enrollMfa(gerant);
    const target = userId('gerant.a@ecsi.test');
    const body = (code: string) => ({
      code,
      reason: 'Téléphone perdu, identité vérifiée par appel',
    });

    // GERANT : pas de users.mfa.reset.
    expect(
      (await gerant.post(`/users/${userId('vendeur.a@ecsi.test')}/mfa/reset`, body('123456')))
        .statusCode,
    ).toBe(403);
    // Code de l'administrateur erroné ou motif absent.
    expect((await adminA.post(`/users/${target}/mfa/reset`, body('000000'))).statusCode).toBe(422);
    expect((await adminA.post(`/users/${target}/mfa/reset`, { code: '123456' })).statusCode).toBe(
      422,
    );
    // Une autre entreprise ne peut pas.
    expect((await adminB.post(`/users/${target}/mfa/reset`, body('123456'))).statusCode).toBe(404);

    const reset = await adminA.post(`/users/${target}/mfa/reset`, body(adminMfa.nextCode()));
    expect(reset.statusCode).toBe(204);
    expect((await gerant.get('/auth/me')).statusCode).toBe(401);
    const factor = await t.migrator.query('select 1 from mfa_factors where user_id = $1', [target]);
    expect(factor.rowCount).toBe(0);

    // Les deux tentatives invalides sont tracées en échec, la réussite une seule fois.
    const failures = await auditEvents(
      adminA,
      `action=users.mfa_reset&resourceId=${target}&result=FAILURE`,
    );
    expect(failures.data).toHaveLength(2);
    const { data } = await auditEvents(
      adminA,
      `action=users.mfa_reset&resourceId=${target}&result=SUCCESS`,
    );
    expect(data).toHaveLength(1);
    const serialized = JSON.stringify(data[0]);
    expect(serialized).not.toContain(gerantMfa.secret);
    expect(data[0]?.details).toMatchObject({
      hadMfa: true,
      reason: 'Téléphone perdu, identité vérifiée par appel',
    });
    await expect
      .poll(() =>
        t.mails.sent.some(
          (m) => m.to === 'gerant.a@ecsi.test' && /authentification/i.test(m.subject),
        ),
      )
      .toBe(true);
  });
});

describe('journal d’audit', () => {
  it('pagine par curseur et filtre par action, utilisateur, ressource et résultat', async () => {
    const first = await auditEvents(adminA, 'limit=2');
    expect(first.data).toHaveLength(2);
    expect(first.nextCursor).toBeTruthy();
    const second = await auditEvents(adminA, `limit=2&cursor=${first.nextCursor ?? ''}`);
    expect(second.data.map((e) => e.id)).not.toContain(first.data[0]?.id);
    const byPrefix = await auditEvents(adminA, 'action=users.*&limit=100');
    expect(byPrefix.data.every((e) => e.action.startsWith('users.'))).toBe(true);
    const byActor = await auditEvents(adminA, `actorId=${userId('admin.a@ecsi.test')}&limit=100`);
    expect(byActor.data.every((e) => e.actorId === userId('admin.a@ecsi.test'))).toBe(true);
    const denied = await auditEvents(adminA, 'result=DENIED&limit=100');
    expect(denied.data.length).toBeGreaterThan(0);
    expect(denied.data.every((e) => e.result === 'DENIED')).toBe(true);
    expect((await adminA.get('/audit?limit=1000')).statusCode).toBe(422);
  });

  it('chaque entreprise ne voit que son journal, y compris par identifiant', async () => {
    const own = await auditEvents(adminB, 'limit=100');
    expect(own.data.every((e) => e.companyId === t.seed.companies.B)).toBe(true);
    const foreign = (await auditEvents(adminA, 'limit=1')).data[0]?.id ?? '';
    expect((await adminB.get(`/audit/${foreign}`)).statusCode).toBe(404);
    expect((await adminA.get(`/audit/${foreign}`)).statusCode).toBe(200);
  });

  it('les connexions (réussies et échouées) sont journalisées', async () => {
    await new HttpClient(t.app).post('/auth/login', {
      email: 'gerant.a@ecsi.test',
      password: 'mauvais-mot-de-passe',
    });
    const failures = await t.migrator.query<{ details: Record<string, unknown> }>(
      "select details from audit_events where action = 'auth.login' and result = 'FAILURE'",
    );
    expect(failures.rowCount).toBeGreaterThan(0);
    expect(JSON.stringify(failures.rows)).not.toContain('mauvais-mot-de-passe');
    const logins = await auditEvents(adminA, 'action=auth.login&result=SUCCESS&limit=100');
    expect(logins.data.length).toBeGreaterThan(0);
  });

  it('ne contient jamais de mot de passe, jeton, cookie ni secret TOTP', async () => {
    const all = await t.migrator.query<{ row: unknown }>(
      'select to_jsonb(e) as row from audit_events e',
    );
    const text = JSON.stringify(all.rows);
    expect(text).not.toContain(SEED_PASSWORD);
    expect(text).not.toContain(adminMfa.secret);
    for (const cookie of adminA.cookies.values()) expect(text).not.toContain(cookie);
    expect(text).not.toMatch(/"(password|token|cookie|secret)[^"]*":\s*"(?!\[masqué\])/i);
  });

  it('un administrateur supprime un site : action auditée, site retiré des groupes', async () => {
    const created = await adminA.post('/sites', {
      name: 'À supprimer',
      code: 'SITE-DEL',
      country: 'CI',
      timezone: 'Africa/Abidjan',
    });
    const id = created.json<{ id: string }>().id;
    await adminA.post(`/site-groups/${t.seed.groupId}/sites`, { siteIds: [id] });
    expect((await adminA.delete(`/sites/${id}`)).statusCode).toBe(204);
    expect((await adminA.get(`/sites/${id}`)).statusCode).toBe(404);
    const members = await t.migrator.query('select 1 from site_group_members where site_id = $1', [
      id,
    ]);
    expect(members.rowCount).toBe(0);
    const { data } = await auditEvents(adminA, `action=sites.delete&resourceId=${id}`);
    expect(data).toHaveLength(1);
  });
});

describe('rotation de la clé de chiffrement (ENCRYPTION_KEY)', () => {
  it('ré-enveloppe tous les secrets 2FA avec la nouvelle clé ; l’ancienne peut ensuite être retirée', async () => {
    const k1 = TEST_SECRETS.encryptionKey;
    const k2 = Buffer.alloc(32, 7).toString('base64');
    const pool = new pg.Pool({ connectionString: infra.urls.auth, max: 1 });
    const db = drizzle(pool, { casing: 'snake_case' });
    try {
      const rotating = new SecretBox(k2, { id: 'k2', previous: [{ id: 'k1', base64: k1 }] });
      const dry = await rotateEncryptionKeys(db, rotating, { dryRun: true });
      expect(dry.rewrapped).toBeGreaterThan(0);
      const report = await rotateEncryptionKeys(db, rotating);
      expect(report).toMatchObject({ failed: 0, rewrapped: dry.rewrapped });
      expect((await rotateEncryptionKeys(db, rotating)).rewrapped).toBe(0); // idempotent

      const { rows } = await pool.query<{ secret_enc: string }>(
        'select secret_enc from mfa_factors where user_id = $1',
        [userId('admin.a@ecsi.test')],
      );
      const stored = rows[0]?.secret_enc ?? '';
      expect(stored).toMatch(/^v2:k2:/);
      // La nouvelle clé seule suffit : l'ancienne peut être retirée de la configuration.
      const k2Only = new SecretBox(k2, { id: 'k2' });
      const secret = k2Only.decrypt(stored, `mfa:user:${userId('admin.a@ecsi.test')}`);
      expect(secret).toBe(adminMfa.secret);
      expect(totp(secret, Date.now())).toMatch(/^\d{6}$/);
      expect(report.recoveryCodesByKey.length).toBeGreaterThan(0);
    } finally {
      await pool.end();
    }
  });
});
