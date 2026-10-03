import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { healthResponseSchema } from '@ecsi/shared';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.factory.js';
import { runMigrations } from '../src/database/migrate.js';
import { testEnv } from './helpers/app.js';
import { startInfra, type TestInfra } from './helpers/infra.js';

let infra: TestInfra;

async function query<T extends pg.QueryResultRow>(url: string, sql: string): Promise<T[]> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return (await client.query<T>(sql)).rows;
  } finally {
    await client.end();
  }
}

beforeAll(async () => {
  infra = await startInfra();
});

afterAll(async () => {
  await infra.stop();
});

describe('migrations', () => {
  it('s’appliquent puis sont idempotentes', async () => {
    await runMigrations(infra.urls.migrator);
    await runMigrations(infra.urls.migrator);
    const rows = await query<{ count: string }>(
      infra.urls.migrator,
      'select count(*) from drizzle.__drizzle_migrations',
    );
    expect(Number(rows[0]?.count)).toBe(5);
  });

  it('installent les fonctions de contexte tenant', async () => {
    const rows = await query<{ company: string | null; admin: boolean }>(
      infra.urls.app,
      'select app.current_company_id() as company, app.is_platform_admin() as admin',
    );
    expect(rows[0]).toEqual({ company: null, admin: false });
  });
});

describe('rôles PostgreSQL (fondation de l’isolation des tenants)', () => {
  it('le rôle applicatif ne peut pas contourner la RLS ni administrer', async () => {
    const rows = await query<{
      rolsuper: boolean;
      rolbypassrls: boolean;
      rolcreaterole: boolean;
      rolcreatedb: boolean;
    }>(
      infra.urls.superuser,
      "select rolsuper, rolbypassrls, rolcreaterole, rolcreatedb from pg_roles where rolname = 'ecsi_app'",
    );
    expect(rows[0]).toEqual({
      rolsuper: false,
      rolbypassrls: false,
      rolcreaterole: false,
      rolcreatedb: false,
    });
  });

  it('le rôle applicatif ne peut pas créer de table', async () => {
    await expect(query(infra.urls.app, 'create table intrusion (id int)')).rejects.toThrow(
      /permission denied/,
    );
  });

  it('le rôle applicatif lit et écrit les tables créées par les migrations, sans DDL', async () => {
    await query(infra.urls.migrator, 'create table s0_probe (id int primary key)');
    await query(infra.urls.app, 'insert into s0_probe values (1)');
    expect(await query(infra.urls.app, 'select id from s0_probe')).toEqual([{ id: 1 }]);
    await expect(query(infra.urls.app, 'drop table s0_probe')).rejects.toThrow(/must be owner/);
    await expect(query(infra.urls.app, 'truncate s0_probe')).rejects.toThrow(/permission denied/);
    await query(infra.urls.migrator, 'drop table s0_probe');
  });
});

describe('API', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    app = await createApp(testEnv(infra));
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /api/v1/health : tous les services sont joignables', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/health' });
    expect(response.statusCode).toBe(200);
    const body = healthResponseSchema.parse(response.json());
    expect(body.status).toBe('ok');
    expect(body.checks.database?.status).toBe('ok');
    expect(body.checks.redis?.status).toBe('ok');
    expect(body.checks.storage?.status).toBe('ok');
  });

  it('GET /api/v1/health/live répond sans dépendance', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/health/live' });
    expect(response.json()).toEqual({ status: 'ok' });
  });

  it('renvoie les erreurs au format problem+json avec un identifiant de requête', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/inexistant',
      headers: { 'x-request-id': 'test-request-0001' },
    });
    expect(response.statusCode).toBe(404);
    expect(response.headers['content-type']).toContain('application/problem+json');
    expect(response.headers['x-request-id']).toBe('test-request-0001');
    expect(response.json()).toMatchObject({ status: 404, requestId: 'test-request-0001' });
  });

  it('applique les en-têtes de sécurité et la politique CORS', async () => {
    const allowed = await app.inject({
      method: 'GET',
      url: '/api/v1/health/live',
      headers: { origin: 'http://localhost:3000' },
    });
    expect(allowed.headers['x-content-type-options']).toBe('nosniff');
    expect(allowed.headers['access-control-allow-origin']).toBe('http://localhost:3000');

    const denied = await app.inject({
      method: 'GET',
      url: '/api/v1/health/live',
      headers: { origin: 'https://malveillant.example' },
    });
    expect(denied.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('publie le document OpenAPI hors production', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/docs/openapi.json' });
    expect(response.statusCode).toBe(200);
    expect(response.json<{ paths: Record<string, unknown> }>().paths).toHaveProperty(
      '/api/v1/health',
    );
  });
});
