/**
 * Isolation des entreprises AU NIVEAU DE L'API : ENTREPRISE_A et ENTREPRISE_B, chacune avec
 * ses utilisateurs, rôles et invitations. Un membre de A ne peut ni lire, ni modifier, ni
 * supprimer les données de B : ni en changeant un UUID, ni en injectant un companyId dans
 * le corps, la requête ou un en-tête, ni en changeant d'entreprise sans en être membre.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HttpClient, loginAs, SEED_PASSWORD, startTestApp, type TestApp } from './helpers/app.js';
import { startInfra, type TestInfra } from './helpers/infra.js';
import { SEED_USERS } from '../src/database/seed.js';

/** Compte de l'entreprise : jeu de démonstration ou créé par ce test (suffixe .a@ / .b@). */
const belongsTo = (key: 'A' | 'B', email: string) =>
  SEED_USERS.some((u) => u.email === email && u.company === key) ||
  email.endsWith(`.${key.toLowerCase()}@ecsi.test`);

let infra: TestInfra;
let t: TestApp;
let gerantA: HttpClient;
let gerantB: HttpClient;
let invitationA: string;
let invitationB: string;

beforeAll(async () => {
  infra = await startInfra();
  t = await startTestApp(infra);
  gerantA = await loginAs(t.app, 'gerant.a@ecsi.test');
  gerantB = await loginAs(t.app, 'gerant.b@ecsi.test');
  const a = await gerantA.post('/invitations', {
    email: 'candidat.a@ecsi.test',
    roles: [{ roleId: t.seed.roles.A.VENDEUR }],
  });
  const b = await gerantB.post('/invitations', {
    email: 'candidat.b@ecsi.test',
    roles: [{ roleId: t.seed.roles.B.VENDEUR }],
  });
  invitationA = a.json<{ id: string }>().id;
  invitationB = b.json<{ id: string }>().id;
}, 180_000);

afterAll(async () => {
  await t.close();
  await infra.stop();
});

const ids = () => ({
  adminB: t.seed.users['admin.b@ecsi.test'] ?? '',
  gerantB: t.seed.users['gerant.b@ecsi.test'] ?? '',
  adminA: t.seed.users['admin.a@ecsi.test'] ?? '',
});

const dbState = async () => ({
  memberships: (
    await t.migrator.query<{ email: string; status: string }>(
      `select u.email, m.status from memberships m join users u on u.id = m.user_id
       where m.company_id = $1 order by u.email`,
      [t.seed.companies.B],
    )
  ).rows,
  invitation: (
    await t.migrator.query<{ status: string }>('select status from invitations where id = $1', [
      invitationB,
    ])
  ).rows[0]?.status,
});

describe.each([
  ['A', () => gerantA, () => t.seed.companies.B],
  ['B', () => gerantB, () => t.seed.companies.A],
] as const)('lecture : un gérant de %s ne voit que son entreprise', (key, client, otherCompany) => {
  it('liste des utilisateurs, rôles et invitations', async () => {
    const own = key === 'A' ? 'a' : 'b';
    const users = (await client().get('/users')).json<{ email: string }[]>();
    expect(users.length).toBeGreaterThan(0);
    expect(users.every((u) => belongsTo(key, u.email))).toBe(true);

    const roles = (await client().get('/roles')).json<{ id: string }[]>();
    const ownRoles = Object.values(t.seed.roles[key]);
    expect(roles.map((r) => r.id).sort()).toEqual([...ownRoles].sort());

    const invitations = (await client().get('/invitations')).json<{ email: string }[]>();
    expect(invitations.map((i) => i.email)).toEqual([`candidat.${own}@ecsi.test`]);

    const me = (await client().get('/auth/me')).json<{
      company: { id: string };
      companies: { id: string }[];
    }>();
    expect(me.company.id).not.toBe(otherCompany());
    expect(me.companies.map((c) => c.id)).not.toContain(otherCompany());
  });
});

describe('ENTREPRISE_A ne peut pas atteindre ENTREPRISE_B en changeant un UUID', () => {
  it('lecture d’un utilisateur de B : 404 (même réponse qu’un identifiant inexistant)', async () => {
    const foreign = await gerantA.get(`/users/${ids().adminB}`);
    const missing = await gerantA.get('/users/0190a0f0-0000-7000-8000-000000000000');
    expect(foreign.statusCode).toBe(404);
    expect(missing.statusCode).toBe(404);
    expect(foreign.json<{ detail: string }>().detail).toBe(
      missing.json<{ detail: string }>().detail,
    );
    expect(foreign.body).not.toContain('admin.b@ecsi.test');
  });

  it('modification du statut d’un membre de B : 404, B inchangée', async () => {
    const before = await dbState();
    const r = await gerantA.patch(`/users/${ids().gerantB}/status`, { status: 'DISABLED' });
    expect(r.statusCode).toBe(404);
    expect(await dbState()).toEqual(before);
    expect((await gerantB.get('/auth/me')).statusCode).toBe(200);
  });

  it('suppression (révocation) d’une invitation de B : 404, B inchangée', async () => {
    const r = await gerantA.delete(`/invitations/${invitationB}`);
    expect(r.statusCode).toBe(404);
    expect((await dbState()).invitation).toBe('PENDING');
  });

  it('attribution d’un rôle de B dans une invitation de A : refusée', async () => {
    const r = await gerantA.post('/invitations', {
      email: 'pirate@ecsi.test',
      roles: [{ roleId: t.seed.roles.B.VENDEUR }],
    });
    expect(r.statusCode).toBe(422);
    const { rows } = await t.migrator.query(
      "select 1 from invitations where email = 'pirate@ecsi.test'",
    );
    expect(rows).toEqual([]);
  });
});

describe('ENTREPRISE_A ne peut pas atteindre ENTREPRISE_B en manipulant la requête', () => {
  it('companyId dans le corps : refusé (schéma strict)', async () => {
    const r = await gerantA.post('/invitations', {
      email: 'pirate2@ecsi.test',
      companyId: t.seed.companies.B,
      roles: [{ roleId: t.seed.roles.A.VENDEUR }],
    });
    expect(r.statusCode).toBe(422);
    const status = await gerantA.patch(`/users/${ids().gerantB}/status`, {
      status: 'DISABLED',
      companyId: t.seed.companies.B,
    });
    expect(status.statusCode).toBe(422);
  });

  it('companyId dans l’URL ou dans des en-têtes : ignoré', async () => {
    const headers = {
      'x-company-id': t.seed.companies.B,
      'x-tenant-id': t.seed.companies.B,
      'x-forwarded-host': 'entreprise-b.ecsi.test',
    };
    // Paramètre inconnu dans la requête : refusé (schéma strict), jamais interprété.
    const withQuery = await gerantA.get(
      `/users?companyId=${t.seed.companies.B}&company_id=${t.seed.companies.B}`,
      { headers },
    );
    expect(withQuery.statusCode).toBe(422);
    // En-têtes : ignorés, l'entreprise vient de la session.
    const users = await gerantA.get('/users', { headers });
    expect(users.statusCode).toBe(200);
    expect(users.json<{ email: string }[]>().every((u) => belongsTo('A', u.email))).toBe(true);
    const foreign = await gerantA.get(`/users/${ids().adminB}`, { headers });
    expect(foreign.statusCode).toBe(404);
  });

  it('changement d’entreprise vers B sans en être membre : 403, contexte inchangé', async () => {
    const r = await gerantA.post('/auth/switch-company', { companyId: t.seed.companies.B });
    expect(r.statusCode).toBe(403);
    const me = (await gerantA.get('/auth/me')).json<{ company: { id: string } }>();
    expect(me.company.id).toBe(t.seed.companies.A);
  });

  it('un membre des deux entreprises ne voit que l’entreprise active, et bascule explicitement', async () => {
    // gerant.a devient aussi membre de B (invitation acceptée) avec le rôle SUPPORT (users.read).
    const invite = await gerantB.post('/invitations', {
      email: 'gerant.a@ecsi.test',
      roles: [{ roleId: t.seed.roles.B.SUPPORT }],
    });
    expect(invite.statusCode).toBe(201);
    const token = await t.mails.tokenFor('gerant.a@ecsi.test', '/invitation');
    const accept = await new HttpClient(t.app).post('/auth/invitations/accept', {
      token,
      password: SEED_PASSWORD,
    });
    expect(accept.statusCode).toBe(201);

    const dual = await loginAs(t.app, 'gerant.a@ecsi.test');
    const before = (await dual.get('/users')).json<{ email: string }[]>();
    expect(before.every((u) => u.email !== 'admin.b@ecsi.test')).toBe(true);
    expect(
      (await dual.post('/auth/switch-company', { companyId: t.seed.companies.B })).statusCode,
    ).toBe(204);
    const after = (await dual.get('/users')).json<{ email: string }[]>();
    expect(after.map((u) => u.email)).toContain('admin.b@ecsi.test');
    expect(after.map((u) => u.email)).not.toContain('vendeur.a@ecsi.test');
    // Dans B, son rôle SUPPORT ne permet pas d'inviter : les droits de A ne « débordent » pas.
    const invite2 = await dual.post('/invitations', {
      email: 'x@ecsi.test',
      roles: [{ roleId: t.seed.roles.B.VENDEUR }],
    });
    expect(invite2.statusCode).toBe(403);
  });
});

describe('ENTREPRISE_B ne peut pas atteindre ENTREPRISE_A (symétrie)', () => {
  it('lecture, modification et suppression refusées', async () => {
    expect((await gerantB.get(`/users/${ids().adminA}`)).statusCode).toBe(404);
    expect(
      (await gerantB.patch(`/users/${ids().adminA}/status`, { status: 'DISABLED' })).statusCode,
    ).toBe(404);
    expect((await gerantB.delete(`/invitations/${invitationA}`)).statusCode).toBe(404);
    const { rows } = await t.migrator.query<{ status: string }>(
      'select status from invitations where id = $1',
      [invitationA],
    );
    expect(rows[0]?.status).toBe('PENDING');
  });
});
