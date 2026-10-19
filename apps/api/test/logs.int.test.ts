/**
 * Les journaux ne doivent contenir ni mot de passe, ni jeton, ni secret, ni adresse e-mail.
 * Fichier séparé : nestjs-pino crée un journaliseur unique par processus de test.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HttpClient, SEED_PASSWORD, startTestApp, type TestApp } from './helpers/app.js';
import { startInfra, type TestInfra } from './helpers/infra.js';

let infra: TestInfra;
let t: TestApp;
const lines: string[] = [];

beforeAll(async () => {
  infra = await startInfra();
  t = await startTestApp(
    infra,
    { LOG_LEVEL: 'trace' },
    {
      write: (message: string) => {
        lines.push(message);
      },
    },
  );
}, 180_000);

afterAll(async () => {
  await t.close();
  await infra.stop();
});

describe('journaux', () => {
  it('ne contiennent ni mot de passe, ni jeton, ni secret', async () => {
    const client = new HttpClient(t.app);
    await client.post('/auth/login', {
      email: 'gerant.b@ecsi.test',
      password: 'mot-de-passe-faux-123',
    });
    await client.post('/auth/login', { email: 'gerant.b@ecsi.test', password: SEED_PASSWORD });
    await client.post('/auth/refresh');
    await client.post('/auth/password/forgot', { email: 'gerant.b@ecsi.test' });
    const token = await t.mails.tokenFor('gerant.b@ecsi.test', '/reinitialisation');
    await client.get(`/auth/invitations/preview?token=${token}`);
    await client.post('/auth/password/reset', { token, password: 'nouvelle phrase de passe' });

    const output = lines.join('');
    expect(output).toContain('auth.login_failed');
    expect(output).toContain('auth.password_reset_completed');
    const secrets = [
      SEED_PASSWORD,
      'mot-de-passe-faux-123',
      'nouvelle phrase de passe',
      token,
      ...client.cookies.values(),
      'gerant.b@ecsi.test',
    ];
    for (const secret of secrets) expect(output).not.toContain(secret);
  });

  it('une erreur SQL (500) est journalisée sans ses paramètres', async () => {
    // Toute écriture sur user_credentials échoue : la réinitialisation déclenche une erreur Drizzle dont
    // les paramètres contiennent le nouveau haché Argon2id.
    await t.migrator.query(
      'alter table user_credentials add constraint h7_test_refus check (false) not valid',
    );
    try {
      const client = new HttpClient(t.app);
      await client.post('/auth/password/forgot', { email: 'gerant.a@ecsi.test' });
      const token = await t.mails.tokenFor('gerant.a@ecsi.test', '/reinitialisation');
      const from = lines.length;
      const response = await client.post('/auth/password/reset', {
        token,
        password: 'phrase de passe journal h7',
      });
      expect(response.statusCode).toBe(500);
      expect(response.json()).not.toHaveProperty('detail');
      const output = lines.slice(from).join('');
      expect(output).toContain('Erreur non gérée');
      expect(output).toContain('params: [masqués]');
      expect(output).toContain('h7_test_refus');
      expect(output).not.toContain('$argon2id$');
      expect(output).not.toContain('gerant.a@ecsi.test');
      expect(output).not.toContain(token);
    } finally {
      await t.migrator.query('alter table user_credentials drop constraint h7_test_refus');
    }
  });
});
