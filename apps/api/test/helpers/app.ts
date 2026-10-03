/**
 * Démarre l'API complète (vrais PostgreSQL, Redis, S3) pour les tests d'intégration, avec
 * un client HTTP qui gère les cookies et le jeton CSRF comme un navigateur.
 * Seuls les e-mails sont capturés en mémoire (le flux Mailpit réel est couvert par l'E2E).
 */
import { randomInt } from 'node:crypto';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { AUTH_COOKIES, CSRF_HEADER } from '@ecsi/shared';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { createApp } from '../../src/app.factory.js';
import { parseEnv } from '../../src/config/env.js';
import { runMigrations } from '../../src/database/migrate.js';
import { totp } from '../../src/auth/crypto/totp.js';
import { type SeedResult, seedDevData } from '../../src/database/seed.js';
import type { MailTransport, OutgoingMail } from '../../src/mail/mail.service.js';
import { S3_TEST_CREDENTIALS, type TestInfra } from './infra.js';

export const SEED_PASSWORD = 'test-Motdepasse-ecsi-2026';

export const TEST_SECRETS = {
  jwt: 'test-jwt-access-secret-0123456789abcdef',
  encryptionKey: Buffer.alloc(32, 9).toString('base64'),
};

export function testEnv(infra: TestInfra, overrides: Record<string, string> = {}) {
  return parseEnv({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATABASE_URL: infra.urls.app,
    DATABASE_AUTH_URL: infra.urls.auth,
    REDIS_URL: infra.urls.redis,
    S3_ENDPOINT: infra.urls.s3,
    S3_BUCKET: 'ecsi-test',
    S3_ACCESS_KEY_ID: S3_TEST_CREDENTIALS.accessKeyId,
    S3_SECRET_ACCESS_KEY: S3_TEST_CREDENTIALS.secretAccessKey,
    S3_AUTO_CREATE_BUCKET: 'true',
    CORS_ORIGINS: 'http://localhost:3000',
    JWT_ACCESS_SECRET: TEST_SECRETS.jwt,
    ENCRYPTION_KEY: TEST_SECRETS.encryptionKey,
    WEB_PUBLIC_URL: 'http://localhost:8080',
    ...overrides,
  });
}

export class MailCapture implements MailTransport {
  readonly sent: OutgoingMail[] = [];

  sendMail(mail: OutgoingMail): Promise<void> {
    this.sent.push(mail);
    return Promise.resolve();
  }

  /** Attend le dernier e-mail adressé à `to` (envoi asynchrone) et en extrait le jeton. */
  async tokenFor(to: string, path: string): Promise<string> {
    for (let attempt = 0; attempt < 50; attempt++) {
      const mail = [...this.sent].reverse().find((m) => m.to === to);
      const match = mail?.text.match(new RegExp(`${path}\\?token=([A-Za-z0-9_-]{43})`));
      if (match?.[1]) return match[1];
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`Aucun e-mail ${path} pour ${to}`);
  }
}

export interface TestApp {
  app: NestFastifyApplication;
  mails: MailCapture;
  seed: SeedResult;
  migrator: pg.Pool;
  close(): Promise<void>;
}

export async function startTestApp(
  infra: TestInfra,
  envOverrides: Record<string, string> = {},
  logDestination?: { write(message: string): void },
) {
  await runMigrations(infra.urls.migrator);
  const migrator = new pg.Pool({ connectionString: infra.urls.migrator, max: 2 });
  const seed = await seedDevData(drizzle(migrator, { casing: 'snake_case' }), SEED_PASSWORD);
  const mails = new MailCapture();
  const app = await createApp(testEnv(infra, envOverrides), {
    mailTransport: mails,
    ...(logDestination ? { logDestination } : {}),
  });
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return {
    app,
    mails,
    seed,
    migrator,
    async close() {
      await app.close();
      await migrator.end();
    },
  } satisfies TestApp;
}

const randomIp = () => `10.${randomInt(256)}.${randomInt(256)}.${1 + randomInt(254)}`;

interface RequestOptions {
  body?: unknown;
  headers?: Record<string, string>;
  /** false : n'envoie pas l'en-tête CSRF (tests de protection). */
  csrf?: boolean;
}

/** Client HTTP « navigateur » : jar de cookies, en-tête CSRF recopié du cookie, IP propre. */
export class HttpClient {
  readonly cookies = new Map<string, string>();

  constructor(
    private readonly app: NestFastifyApplication,
    readonly ip = randomIp(),
  ) {}

  async request(
    method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
    url: string,
    options: RequestOptions = {},
  ) {
    const headers: Record<string, string> = { ...options.headers };
    if (this.cookies.size > 0) {
      headers.cookie = [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; ');
    }
    const csrf = this.cookies.get(AUTH_COOKIES.csrf);
    if (method !== 'GET' && options.csrf !== false && csrf) headers[CSRF_HEADER] = csrf;
    const hasBody = options.body !== undefined;
    if (hasBody && !headers['content-type']) headers['content-type'] = 'application/json';
    const response = await this.app.inject({
      method,
      url: `/api/v1${url}`,
      headers,
      remoteAddress: this.ip,
      ...(hasBody
        ? {
            payload: typeof options.body === 'string' ? options.body : JSON.stringify(options.body),
          }
        : {}),
    });
    for (const cookie of response.cookies as {
      name: string;
      value: string;
      maxAge?: number;
      expires?: Date;
    }[]) {
      const expired =
        cookie.value === '' ||
        cookie.maxAge === 0 ||
        (cookie.expires !== undefined && cookie.expires.getTime() <= Date.now());
      if (expired) this.cookies.delete(cookie.name);
      else this.cookies.set(cookie.name, cookie.value);
    }
    return response;
  }

  get(url: string, options?: RequestOptions) {
    return this.request('GET', url, options);
  }

  post(url: string, body?: unknown, options?: RequestOptions) {
    return this.request('POST', url, { ...options, body });
  }

  patch(url: string, body?: unknown, options?: RequestOptions) {
    return this.request('PATCH', url, { ...options, body });
  }

  put(url: string, body?: unknown, options?: RequestOptions) {
    return this.request('PUT', url, { ...options, body });
  }

  delete(url: string, options?: RequestOptions) {
    return this.request('DELETE', url, options);
  }
}

/**
 * Configure la 2FA d'un compte connecté (prefix « /auth » ou « /platform/auth »). Retourne
 * le secret et un générateur de codes successifs : chaque code TOTP n'est accepté qu'une
 * fois (anti-rejeu), on avance donc d'un pas de 30 s à chaque appel.
 */
export async function enrollMfa(client: HttpClient, prefix = '/auth') {
  const setup = await client.post(`${prefix}/mfa/setup`, {});
  if (setup.statusCode !== 200)
    throw new Error(`Configuration 2FA : ${setup.statusCode} ${setup.body}`);
  const { secret } = setup.json<{ secret: string }>();
  const confirm = await client.post(`${prefix}/mfa/confirm`, { code: totp(secret, Date.now()) });
  if (confirm.statusCode !== 200)
    throw new Error(`Confirmation 2FA : ${confirm.statusCode} ${confirm.body}`);
  let step = 0;
  return {
    secret,
    /** Code du pas suivant (fenêtre de tolérance ±1 pas côté serveur). */
    nextCode: () => {
      step += 1;
      if (step > 1) throw new Error('Un seul code « futur » est utilisable par test (anti-rejeu)');
      return totp(secret, Date.now() + 30_000);
    },
  };
}

export async function loginAs(
  app: NestFastifyApplication,
  email: string,
  password = SEED_PASSWORD,
) {
  const client = new HttpClient(app);
  const response = await client.post('/auth/login', { email, password });
  if (response.statusCode !== 200) {
    throw new Error(`Connexion impossible pour ${email} : ${response.statusCode} ${response.body}`);
  }
  return client;
}
