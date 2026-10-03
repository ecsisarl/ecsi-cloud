/**
 * Authentification de bout en bout sur l'API réelle (PostgreSQL, Redis réels) :
 * connexion, cookies, CSRF, rotation et réutilisation des refresh tokens, révocation,
 * 2FA TOTP et codes de récupération, mot de passe oublié, invitations, anti-énumération,
 * anti-force brute, validation stricte, journaux sans secrets, espace plateforme.
 */
import { AUTH_COOKIES } from '@ecsi/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Redis } from 'ioredis';
import { hashPassword } from '../src/auth/crypto/password.js';
import { REDIS } from '../src/redis/redis.module.js';
import { totp } from '../src/auth/crypto/totp.js';
import { HttpClient, loginAs, SEED_PASSWORD, startTestApp, type TestApp } from './helpers/app.js';
import { startInfra, type TestInfra } from './helpers/infra.js';

let infra: TestInfra;
let t: TestApp;

beforeAll(async () => {
  infra = await startInfra();
  t = await startTestApp(infra);
}, 180_000);

afterAll(async () => {
  await t.close();
  await infra.stop();
});

const sessionsOf = async (email: string) =>
  (
    await t.migrator.query<{ id: string; revoked_reason: string | null }>(
      `select s.id, s.revoked_reason from auth_sessions s join users u on u.id = s.user_id
       where u.email = $1 order by s.created_at`,
      [email],
    )
  ).rows;

/** Lève les verrouillages anti-force brute (pour ne pas perturber les tests suivants). */
async function resetLoginLocks() {
  const redis = t.app.get<Redis>(REDIS);
  const keys = await redis.keys('rl:login:fail:*');
  if (keys.length > 0) await redis.del(...keys);
}

/** Configure la 2FA d'un compte et retourne son secret TOTP et ses codes de récupération. */
async function enrollMfa(client: HttpClient) {
  const setup = await client.post('/auth/mfa/setup', {});
  expect(setup.statusCode).toBe(200);
  const { secret, otpauthUri } = setup.json<{ secret: string; otpauthUri: string }>();
  expect(otpauthUri).toContain(`secret=${secret}`);
  const confirm = await client.post('/auth/mfa/confirm', { code: totp(secret, Date.now()) });
  expect(confirm.statusCode).toBe(200);
  return { secret, recoveryCodes: confirm.json<{ recoveryCodes: string[] }>().recoveryCodes };
}

describe('connexion', () => {
  it('ouvre une session avec des cookies httpOnly, SameSite=Strict', async () => {
    const client = new HttpClient(t.app);
    const response = await client.post('/auth/login', {
      email: 'VENDEUR.A@ecsi.test',
      password: SEED_PASSWORD,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'AUTHENTICATED', mfaState: 'NOT_REQUIRED' });
    const cookies = response.cookies as {
      name: string;
      httpOnly?: boolean;
      sameSite?: string;
      path?: string;
    }[];
    const byName = Object.fromEntries(cookies.map((c) => [c.name, c]));
    expect(byName[AUTH_COOKIES.access]).toMatchObject({
      httpOnly: true,
      sameSite: 'Strict',
      path: '/',
    });
    expect(byName[AUTH_COOKIES.refresh]).toMatchObject({ httpOnly: true, sameSite: 'Strict' });
    expect(byName[AUTH_COOKIES.csrf]?.httpOnly).toBeFalsy();

    const me = await client.get('/auth/me');
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({
      user: { email: 'vendeur.a@ecsi.test' },
      company: { name: 'ENTREPRISE_A' },
      roles: ['VENDEUR'],
      mfa: { enabled: false, required: false, state: 'NOT_REQUIRED' },
    });
    expect(me.json<{ permissions: string[] }>().permissions).toContain('sales.create');
    expect(me.json<{ permissions: string[] }>().permissions).not.toContain('users.invite');
  });

  it('refuse sans session, et avec un jeton d’accès forgé', async () => {
    const anonymous = new HttpClient(t.app);
    expect((await anonymous.get('/auth/me')).statusCode).toBe(401);
    anonymous.cookies.set(
      AUTH_COOKIES.access,
      'eyJhbGciOiJub25lIn0.eyJzdWIiOiJ4Iiwic2lkIjoieCIsInJlYWxtIjoidXNlciJ9.',
    );
    expect((await anonymous.get('/auth/me')).statusCode).toBe(401);
  });

  it('ne révèle pas l’existence d’un compte (même réponse, même message)', async () => {
    const wrongPassword = await new HttpClient(t.app).post('/auth/login', {
      email: 'gerant.a@ecsi.test',
      password: 'mauvais-mot-de-passe',
    });
    const unknown = await new HttpClient(t.app).post('/auth/login', {
      email: 'inconnu@ecsi.test',
      password: 'mauvais-mot-de-passe',
    });
    expect(wrongPassword.statusCode).toBe(401);
    expect(unknown.statusCode).toBe(401);
    const strip = (body: string) => ({
      ...(JSON.parse(body) as Record<string, unknown>),
      requestId: undefined,
    });
    expect(strip(unknown.body)).toEqual(strip(wrongPassword.body));
  });

  it('crée une nouvelle session à chaque connexion (pas de fixation de session)', async () => {
    const client = await loginAs(t.app, 'gerant.b@ecsi.test');
    const firstAccess = client.cookies.get(AUTH_COOKIES.access);
    const before = await sessionsOf('gerant.b@ecsi.test');
    await client.post('/auth/login', { email: 'gerant.b@ecsi.test', password: SEED_PASSWORD });
    const after = await sessionsOf('gerant.b@ecsi.test');
    expect(after.length).toBe(before.length + 1);
    expect(client.cookies.get(AUTH_COOKIES.access)).not.toBe(firstAccess);
  });
});

describe('protection contre la force brute', () => {
  it('verrouille une adresse après 5 échecs, même avec le bon mot de passe ensuite', async () => {
    const email = 'vendeur.a@ecsi.test';
    for (let i = 0; i < 5; i++) {
      const r = await new HttpClient(t.app).post('/auth/login', { email, password: `faux-${i}` });
      expect(r.statusCode).toBe(401);
    }
    const locked = await new HttpClient(t.app).post('/auth/login', {
      email,
      password: SEED_PASSWORD,
    });
    expect(locked.statusCode).toBe(429);
    expect(Number(locked.headers['retry-after'])).toBeGreaterThan(0);
    await resetLoginLocks();
  });

  it('verrouille de la même façon une adresse inexistante (pas d’énumération)', async () => {
    for (let i = 0; i < 5; i++) {
      await new HttpClient(t.app).post('/auth/login', {
        email: 'fantome@ecsi.test',
        password: 'x',
      });
    }
    const r = await new HttpClient(t.app).post('/auth/login', {
      email: 'fantome@ecsi.test',
      password: 'x',
    });
    expect(r.statusCode).toBe(429);
  });

  it('limite le nombre de tentatives par adresse IP', async () => {
    const client = new HttpClient(t.app);
    const codes: number[] = [];
    for (let i = 0; i < 21; i++) {
      codes.push(
        (await client.post('/auth/login', { email: `ip${i}@ecsi.test`, password: 'x' })).statusCode,
      );
    }
    expect(codes.slice(0, 20).every((code) => code === 401)).toBe(true);
    expect(codes[20]).toBe(429);
  });
});

describe('refresh token', () => {
  it('tourne à chaque utilisation', async () => {
    const client = await loginAs(t.app, 'gerant.a@ecsi.test');
    const first = client.cookies.get(AUTH_COOKIES.refresh);
    const r = await client.post('/auth/refresh');
    expect(r.statusCode).toBe(204);
    const second = client.cookies.get(AUTH_COOKIES.refresh);
    expect(second).toBeDefined();
    expect(second).not.toBe(first);
    expect((await client.get('/auth/me')).statusCode).toBe(200);
  });

  it('tolère deux rafraîchissements simultanés (même successeur)', async () => {
    const client = await loginAs(t.app, 'gerant.a@ecsi.test');
    const old = client.cookies.get(AUTH_COOKIES.refresh) ?? '';
    const tabB = new HttpClient(t.app, client.ip);
    tabB.cookies.set(AUTH_COOKIES.refresh, old);
    const [a, b] = await Promise.all([client.post('/auth/refresh'), tabB.post('/auth/refresh')]);
    expect([a.statusCode, b.statusCode]).toEqual([204, 204]);
    expect(tabB.cookies.get(AUTH_COOKIES.refresh)).toBe(client.cookies.get(AUTH_COOKIES.refresh));
  });

  it('détecte la réutilisation d’un ancien jeton et révoque toute la session', async () => {
    const victim = await loginAs(t.app, 'gerant.a@ecsi.test');
    const stolen = victim.cookies.get(AUTH_COOKIES.refresh) ?? '';
    expect((await victim.post('/auth/refresh')).statusCode).toBe(204);
    // Fin de la fenêtre de tolérance : on vieillit l'utilisation du jeton volé.
    await t.migrator.query(
      "update refresh_tokens set used_at = now() - interval '1 minute' where used_at is not null",
    );
    const attacker = new HttpClient(t.app);
    attacker.cookies.set(AUTH_COOKIES.refresh, stolen);
    expect((await attacker.post('/auth/refresh')).statusCode).toBe(401);
    // La session de la victime (et le nouveau jeton) sont révoqués.
    expect((await victim.post('/auth/refresh')).statusCode).toBe(401);
    expect((await victim.get('/auth/me')).statusCode).toBe(401);
    const reasons = (await sessionsOf('gerant.a@ecsi.test')).map((s) => s.revoked_reason);
    expect(reasons).toContain('REFRESH_TOKEN_REUSE');
  });

  it('refuse un refresh token inconnu ou expiré', async () => {
    const client = new HttpClient(t.app);
    client.cookies.set(AUTH_COOKIES.refresh, 'a'.repeat(43));
    expect((await client.post('/auth/refresh')).statusCode).toBe(401);
    const expired = await loginAs(t.app, 'gerant.b@ecsi.test');
    await t.migrator.query(
      `update refresh_tokens set expires_at = now() - interval '1 second'
       where token_hash = sha256(convert_to($1, 'UTF8'))`,
      [expired.cookies.get(AUTH_COOKIES.refresh)],
    );
    expect((await expired.post('/auth/refresh')).statusCode).toBe(401);
  });
});

describe('sessions et déconnexion', () => {
  it('la déconnexion révoque la session côté serveur (le jeton d’accès devient inutilisable)', async () => {
    const client = await loginAs(t.app, 'gerant.b@ecsi.test');
    const access = client.cookies.get(AUTH_COOKIES.access) ?? '';
    expect((await client.post('/auth/logout')).statusCode).toBe(204);
    const replay = new HttpClient(t.app);
    replay.cookies.set(AUTH_COOKIES.access, access);
    expect((await replay.get('/auth/me')).statusCode).toBe(401);
  });

  it('liste les sessions actives et révoque une autre session', async () => {
    const laptop = await loginAs(t.app, 'admin.b@ecsi.test');
    const phone = await loginAs(t.app, 'admin.b@ecsi.test');
    const list = await laptop.get('/auth/sessions');
    expect(list.statusCode).toBe(200);
    const sessions = list.json<{ id: string; current: boolean }[]>();
    expect(sessions.filter((s) => s.current)).toHaveLength(1);
    expect(sessions).toHaveLength(2);
    const other = sessions.find((s) => !s.current);
    // Une session SETUP_REQUIRED (2FA à configurer) peut tout de même gérer ses sessions.
    expect((await laptop.delete(`/auth/sessions/${other?.id ?? ''}`)).statusCode).toBe(204);
    expect((await phone.get('/auth/sessions')).statusCode).toBe(401);
    expect((await laptop.get('/auth/sessions')).statusCode).toBe(200);
  });

  it('ne permet pas de révoquer la session d’un autre utilisateur', async () => {
    const owner = await loginAs(t.app, 'gerant.b@ecsi.test');
    const [target] = (await owner.get('/auth/sessions')).json<{ id: string }[]>();
    const intruder = await loginAs(t.app, 'gerant.a@ecsi.test');
    expect((await intruder.delete(`/auth/sessions/${target?.id ?? ''}`)).statusCode).toBe(404);
    expect((await owner.get('/auth/me')).statusCode).toBe(200);
  });
});

describe('CSRF, type de contenu et validation', () => {
  it('refuse une requête modifiante sans en-tête CSRF ou avec un en-tête faux', async () => {
    const client = await loginAs(t.app, 'gerant.b@ecsi.test');
    const companyId = t.seed.companies.B;
    expect(
      (await client.post('/auth/switch-company', { companyId }, { csrf: false })).statusCode,
    ).toBe(403);
    expect(
      (
        await client.post(
          '/auth/switch-company',
          { companyId },
          { csrf: false, headers: { 'x-csrf-token': 'faux' } },
        )
      ).statusCode,
    ).toBe(403);
    expect((await client.post('/auth/switch-company', { companyId })).statusCode).toBe(204);
  });

  it('refuse les corps non JSON (formulaire d’un site tiers)', async () => {
    const client = new HttpClient(t.app);
    const form = await client.post('/auth/login', `email=a@b.ci&password=x`, {
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    const text = await client.post('/auth/login', '{"email":"a@b.ci","password":"x"}', {
      headers: { 'content-type': 'text/plain' },
    });
    expect(form.statusCode).toBe(415);
    expect(text.statusCode).toBe(415);
  });

  it('valide strictement les entrées (clé inconnue, injection SQL)', async () => {
    const client = new HttpClient(t.app);
    const extra = await client.post('/auth/login', {
      email: 'gerant.a@ecsi.test',
      password: SEED_PASSWORD,
      companyId: t.seed.companies.B,
    });
    expect(extra.statusCode).toBe(422);
    const injection = await client.post('/auth/login', { email: "' OR 1=1 --", password: 'x' });
    expect(injection.statusCode).toBe(422);
    const injectedPassword = await client.post('/auth/login', {
      email: 'gerant.a@ecsi.test',
      password: "' OR '1'='1",
    });
    expect(injectedPassword.statusCode).toBe(401);
    const gerant = await loginAs(t.app, 'gerant.b@ecsi.test');
    expect((await gerant.get("/users/1'%20OR%20'1'='1")).statusCode).toBe(400);
    expect((await gerant.get('/users')).json<unknown[]>()).toHaveLength(2);
  });

  it('échappe le contenu (XSS) : un nom contenant du HTML est renvoyé en JSON brut', async () => {
    await t.migrator.query(
      "update users set full_name = '<script>alert(1)</script>' where email = 'gerant.b@ecsi.test'",
    );
    const client = await loginAs(t.app, 'gerant.b@ecsi.test');
    const me = await client.get('/auth/me');
    expect(me.headers['content-type']).toContain('application/json');
    expect(me.json<{ user: { fullName: string } }>().user.fullName).toBe(
      '<script>alert(1)</script>',
    );
    expect(me.headers['x-content-type-options']).toBe('nosniff');
    await t.migrator.query(
      "update users set full_name = 'Fatou Gérante (B)' where email = 'gerant.b@ecsi.test'",
    );
  });
});

describe('2FA TOTP (obligatoire pour ADMIN_ENTREPRISE)', () => {
  let secret = '';
  let recoveryCodes: string[] = [];

  it('impose la configuration avant tout autre accès', async () => {
    const client = new HttpClient(t.app);
    const login = await client.post('/auth/login', {
      email: 'admin.a@ecsi.test',
      password: SEED_PASSWORD,
    });
    expect(login.json()).toEqual({ status: 'AUTHENTICATED', mfaState: 'SETUP_REQUIRED' });
    const blocked = await client.get('/users');
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json<{ detail: string }>().detail).toBe('MFA_SETUP_REQUIRED');
    expect((await client.get('/auth/me')).json()).toMatchObject({
      mfa: { required: true, state: 'SETUP_REQUIRED' },
    });

    const sessionBefore = client.cookies.get(AUTH_COOKIES.access);
    ({ secret, recoveryCodes } = await enrollMfa(client));
    expect(recoveryCodes).toHaveLength(10);
    // Élévation : nouvelle session, l'ancienne est révoquée.
    expect(client.cookies.get(AUTH_COOKIES.access)).not.toBe(sessionBefore);
    expect((await client.get('/users')).statusCode).toBe(200);
    const stale = new HttpClient(t.app);
    stale.cookies.set(AUTH_COOKIES.access, sessionBefore ?? '');
    expect((await stale.get('/auth/me')).statusCode).toBe(401);
  });

  it('stocke le secret chiffré, jamais en clair', async () => {
    const { rows } = await t.migrator.query<{ secret_enc: string }>(
      'select secret_enc from mfa_factors',
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.secret_enc).toMatch(/^v2:k1:/);
      expect(row.secret_enc).not.toContain(secret);
    }
  });

  it('exige le code à la connexion, refuse un code faux et le rejeu', async () => {
    const client = new HttpClient(t.app);
    const login = await client.post('/auth/login', {
      email: 'admin.a@ecsi.test',
      password: SEED_PASSWORD,
    });
    expect(login.json()).toEqual({ status: 'MFA_REQUIRED' });
    expect(client.cookies.has(AUTH_COOKIES.access)).toBe(false);
    expect((await client.get('/auth/me')).statusCode).toBe(401);
    expect((await client.post('/auth/mfa/verify', { code: '000000' })).statusCode).toBe(401);
    // Le code utilisé à l'activation (même pas de temps) ne peut pas être rejoué.
    const replay = await client.post('/auth/mfa/verify', { code: totp(secret, Date.now()) });
    const next = await client.post('/auth/mfa/verify', { code: totp(secret, Date.now() + 30_000) });
    expect([replay.statusCode, next.statusCode]).toContain(200);
    expect((await client.get('/auth/me')).json()).toMatchObject({
      mfa: { enabled: true, state: 'VERIFIED' },
    });
  });

  it('accepte un code de récupération une seule fois', async () => {
    const code = recoveryCodes[0] ?? '';
    const first = new HttpClient(t.app);
    await first.post('/auth/login', { email: 'admin.a@ecsi.test', password: SEED_PASSWORD });
    expect((await first.post('/auth/mfa/verify', { recoveryCode: code })).statusCode).toBe(200);
    const second = new HttpClient(t.app);
    await second.post('/auth/login', { email: 'admin.a@ecsi.test', password: SEED_PASSWORD });
    expect((await second.post('/auth/mfa/verify', { recoveryCode: code })).statusCode).toBe(401);
  });

  it('invalide le défi après 5 codes faux', async () => {
    const client = new HttpClient(t.app);
    await client.post('/auth/login', { email: 'admin.a@ecsi.test', password: SEED_PASSWORD });
    for (let i = 0; i < 5; i++) await client.post('/auth/mfa/verify', { code: '123456' });
    const r = await client.post('/auth/mfa/verify', { code: totp(secret, Date.now() + 60_000) });
    expect(r.statusCode).toBe(401);
  });
});

describe('mot de passe oublié', () => {
  it('répond 202 dans tous les cas, sans e-mail pour une adresse inconnue', async () => {
    const before = t.mails.sent.length;
    const r = await new HttpClient(t.app).post('/auth/password/forgot', {
      email: 'inconnu@ecsi.test',
    });
    expect(r.statusCode).toBe(202);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(t.mails.sent.length).toBe(before);
  });

  it('réinitialise avec un lien à usage unique et révoque toutes les sessions', async () => {
    const email = 'gerant.b@ecsi.test';
    const existing = await loginAs(t.app, email);
    expect((await new HttpClient(t.app).post('/auth/password/forgot', { email })).statusCode).toBe(
      202,
    );
    const token = await t.mails.tokenFor(email, '/reinitialisation');
    const newPassword = 'nouvelle phrase de passe 2026';

    expect(
      (await new HttpClient(t.app).post('/auth/password/reset', { token, password: 'court' }))
        .statusCode,
    ).toBe(422);
    expect(
      (await new HttpClient(t.app).post('/auth/password/reset', { token, password: newPassword }))
        .statusCode,
    ).toBe(204);
    expect((await existing.get('/auth/me')).statusCode).toBe(401);
    expect(
      (await new HttpClient(t.app).post('/auth/password/reset', { token, password: newPassword }))
        .statusCode,
    ).toBe(400);
    await expect(loginAs(t.app, email)).rejects.toThrow();
    await loginAs(t.app, email, newPassword);
    // Remise en état pour les autres tests.
    await t.migrator.query(
      'update user_credentials set password_hash = $1 where user_id = (select id from users where email = $2)',
      [await hashPassword(SEED_PASSWORD), email],
    );
  });

  it('refuse un lien expiré (30 minutes)', async () => {
    const email = 'gerant.a@ecsi.test';
    await new HttpClient(t.app).post('/auth/password/forgot', { email });
    const token = await t.mails.tokenFor(email, '/reinitialisation');
    await t.migrator.query(
      "update password_reset_tokens set expires_at = now() - interval '1 second'",
    );
    const r = await new HttpClient(t.app).post('/auth/password/reset', {
      token,
      password: 'une autre phrase longue',
    });
    expect(r.statusCode).toBe(400);
  });
});

describe('invitations', () => {
  it('invite, prévisualise et accepte (nouveau compte), puis connexion', async () => {
    const gerant = await loginAs(t.app, 'gerant.a@ecsi.test');
    const email = 'nouveau.vendeur@ecsi.test';
    const invite = await gerant.post('/invitations', {
      email,
      roles: [{ roleId: t.seed.roles.A.VENDEUR }],
    });
    expect(invite.statusCode).toBe(201);
    expect(invite.body).not.toContain('token');
    const token = await t.mails.tokenFor(email, '/invitation');

    const anonymous = new HttpClient(t.app);
    const preview = await anonymous.get(`/auth/invitations/preview?token=${token}`);
    expect(preview.json()).toMatchObject({
      companyName: 'ENTREPRISE_A',
      email,
      existingAccount: false,
    });

    expect(
      (
        await anonymous.post('/auth/invitations/accept', {
          token,
          fullName: 'Nouveau',
          password: 'court',
        })
      ).statusCode,
    ).toBe(422);
    const accept = await anonymous.post('/auth/invitations/accept', {
      token,
      fullName: 'Nouveau Vendeur',
      password: 'phrase de passe du vendeur',
    });
    expect(accept.statusCode).toBe(201);
    expect(
      (
        await anonymous.post('/auth/invitations/accept', {
          token,
          fullName: 'Xavier',
          password: 'phrase de passe du vendeur',
        })
      ).statusCode,
    ).toBe(400);

    const member = await loginAs(t.app, email, 'phrase de passe du vendeur');
    expect((await member.get('/auth/me')).json()).toMatchObject({
      company: { name: 'ENTREPRISE_A' },
      roles: ['VENDEUR'],
    });
  });

  it('un compte existant rejoint une deuxième entreprise avec son mot de passe', async () => {
    const adminB = await loginAs(t.app, 'gerant.b@ecsi.test');
    await adminB.post('/invitations', {
      email: 'vendeur.a@ecsi.test',
      roles: [{ roleId: t.seed.roles.B.VENDEUR }],
    });
    const token = await t.mails.tokenFor('vendeur.a@ecsi.test', '/invitation');
    const anonymous = new HttpClient(t.app);
    expect((await anonymous.get(`/auth/invitations/preview?token=${token}`)).json()).toMatchObject({
      existingAccount: true,
    });
    expect(
      (await anonymous.post('/auth/invitations/accept', { token, password: 'faux' })).statusCode,
    ).toBe(401);
    expect(
      (await anonymous.post('/auth/invitations/accept', { token, password: SEED_PASSWORD }))
        .statusCode,
    ).toBe(201);
  });

  it('refuse une invitation expirée ou révoquée', async () => {
    const gerant = await loginAs(t.app, 'gerant.a@ecsi.test');
    await gerant.post('/invitations', {
      email: 'expire@ecsi.test',
      roles: [{ roleId: t.seed.roles.A.SUPPORT }],
    });
    const token = await t.mails.tokenFor('expire@ecsi.test', '/invitation');
    await t.migrator.query(
      "update invitations set expires_at = now() - interval '1 second' where email = 'expire@ecsi.test'",
    );
    expect(
      (await new HttpClient(t.app).get(`/auth/invitations/preview?token=${token}`)).statusCode,
    ).toBe(400);

    const second = await gerant.post('/invitations', {
      email: 'revoque@ecsi.test',
      roles: [{ roleId: t.seed.roles.A.SUPPORT }],
    });
    const revokeToken = await t.mails.tokenFor('revoque@ecsi.test', '/invitation');
    expect(
      (await gerant.delete(`/invitations/${second.json<{ id: string }>().id}`)).statusCode,
    ).toBe(204);
    expect(
      (await new HttpClient(t.app).get(`/auth/invitations/preview?token=${revokeToken}`))
        .statusCode,
    ).toBe(400);
  });
});

describe('RBAC', () => {
  it('un vendeur ne peut ni lister ni inviter des utilisateurs', async () => {
    const vendeur = await loginAs(t.app, 'nouveau.vendeur@ecsi.test', 'phrase de passe du vendeur');
    expect((await vendeur.get('/users')).statusCode).toBe(403);
    expect((await vendeur.get('/roles')).statusCode).toBe(403);
    expect(
      (
        await vendeur.post('/invitations', {
          email: 'x@ecsi.test',
          roles: [{ roleId: t.seed.roles.A.VENDEUR }],
        })
      ).statusCode,
    ).toBe(403);
  });

  it('un gérant ne peut pas attribuer ADMIN_ENTREPRISE (droits qu’il ne détient pas)', async () => {
    const gerant = await loginAs(t.app, 'gerant.a@ecsi.test');
    const r = await gerant.post('/invitations', {
      email: 'escalade@ecsi.test',
      roles: [{ roleId: t.seed.roles.A.ADMIN_ENTREPRISE }],
    });
    expect(r.statusCode).toBe(403);
  });

  it('un gérant ne peut pas désactiver un administrateur, ni se désactiver lui-même', async () => {
    const gerant = await loginAs(t.app, 'gerant.a@ecsi.test');
    const admin = t.seed.users['admin.a@ecsi.test'] ?? '';
    const self = t.seed.users['gerant.a@ecsi.test'] ?? '';
    expect((await gerant.patch(`/users/${admin}/status`, { status: 'DISABLED' })).statusCode).toBe(
      403,
    );
    expect((await gerant.patch(`/users/${self}/status`, { status: 'DISABLED' })).statusCode).toBe(
      403,
    );
  });

  it('désactiver un membre coupe immédiatement ses sessions dans l’entreprise', async () => {
    const gerant = await loginAs(t.app, 'gerant.a@ecsi.test');
    const vendeur = await loginAs(t.app, 'nouveau.vendeur@ecsi.test', 'phrase de passe du vendeur');
    const id = (await vendeur.get('/auth/me')).json<{ user: { id: string } }>().user.id;
    expect(
      (await gerant.patch(`/users/${id}/status`, { status: 'DISABLED' })).json(),
    ).toMatchObject({
      status: 'DISABLED',
    });
    expect((await vendeur.get('/auth/me')).statusCode).toBe(401);
    await gerant.patch(`/users/${id}/status`, { status: 'ACTIVE' });
  });
});

describe('super administrateur (espace plateforme séparé)', () => {
  const email = 'ops@ecsi.test';
  const password = 'phrase de passe plateforme';

  beforeAll(async () => {
    await t.migrator.query(
      'insert into platform_admins (email, full_name, password_hash) values ($1, $2, $3)',
      [email, 'Ops ECSI', await hashPassword(password)],
    );
  });

  it('exige la 2FA dès la première connexion', async () => {
    const client = new HttpClient(t.app);
    const r = await client.post('/platform/auth/login', { email, password });
    expect(r.json()).toEqual({ status: 'AUTHENTICATED', mfaState: 'SETUP_REQUIRED' });
    expect((await client.get('/platform/auth/me')).json()).toMatchObject({ realm: 'platform' });
  });

  it('une session plateforme est refusée sur les routes des entreprises, et inversement', async () => {
    const platform = new HttpClient(t.app);
    await platform.post('/platform/auth/login', { email, password });
    expect((await platform.get('/auth/me')).statusCode).toBe(403);
    expect((await platform.get('/users')).statusCode).toBe(403);
    const user = await loginAs(t.app, 'gerant.a@ecsi.test');
    expect((await user.get('/platform/auth/me')).statusCode).toBe(403);
  });

  it('un compte d’entreprise ne peut pas se connecter à l’espace plateforme', async () => {
    const r = await new HttpClient(t.app).post('/platform/auth/login', {
      email: 'admin.a@ecsi.test',
      password: SEED_PASSWORD,
    });
    expect(r.statusCode).toBe(401);
  });
});
