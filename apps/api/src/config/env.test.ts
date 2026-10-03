import { describe, expect, it } from 'vitest';
import { InvalidEnvironmentError, isApiDocsEnabled, parseEnv } from './env.js';

const base = {
  DATABASE_URL: 'postgres://ecsi_app:secret@localhost:5432/ecsi',
  REDIS_URL: 'redis://localhost:6379',
  S3_BUCKET: 'ecsi-dev',
  S3_ACCESS_KEY_ID: 'access',
  S3_SECRET_ACCESS_KEY: 'a-long-secret',
};

describe('parseEnv', () => {
  it('applique les valeurs par défaut', () => {
    const env = parseEnv(base);
    expect(env.NODE_ENV).toBe('development');
    expect(env.API_PORT).toBe(4000);
    expect(env.CORS_ORIGINS).toEqual([]);
    expect(isApiDocsEnabled(env)).toBe(true);
  });

  it('découpe les origines CORS', () => {
    const env = parseEnv({ ...base, CORS_ORIGINS: 'http://a.test, http://b.test,' });
    expect(env.CORS_ORIGINS).toEqual(['http://a.test', 'http://b.test']);
  });

  it('refuse une URL de base invalide sans divulguer le secret', () => {
    try {
      parseEnv({ ...base, DATABASE_URL: 'mysql://user:topsecret@host/db' });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidEnvironmentError);
      expect((error as Error).message).toContain('DATABASE_URL');
      expect((error as Error).message).not.toContain('topsecret');
    }
  });

  it('refuse les secrets de développement en production', () => {
    expect(() =>
      parseEnv({
        ...base,
        NODE_ENV: 'production',
        S3_SECRET_ACCESS_KEY: 'devonly-secret-key',
      }),
    ).toThrow(/S3_SECRET_ACCESS_KEY/);
  });

  it('refuse CORS « * » et la création automatique de bucket en production', () => {
    expect(() =>
      parseEnv({
        ...base,
        NODE_ENV: 'production',
        CORS_ORIGINS: '*',
        S3_AUTO_CREATE_BUCKET: 'true',
      }),
    ).toThrow(/CORS_ORIGINS[\s\S]*|S3_AUTO_CREATE_BUCKET/);
  });

  it('désactive la documentation OpenAPI par défaut en production', () => {
    expect(isApiDocsEnabled(parseEnv({ ...base, NODE_ENV: 'production' }))).toBe(false);
    expect(
      isApiDocsEnabled(parseEnv({ ...base, NODE_ENV: 'production', API_DOCS_ENABLED: 'true' })),
    ).toBe(true);
  });
});
