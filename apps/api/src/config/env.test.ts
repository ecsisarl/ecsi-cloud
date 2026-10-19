import { describe, expect, it } from 'vitest';
import {
  InvalidEnvironmentError,
  isApiDocsEnabled,
  isCookieSecure,
  isSmtpTlsRequired,
  parseEnv,
} from './env.js';

const base = {
  DATABASE_URL: 'postgres://ecsi_app:secret@localhost:5432/ecsi',
  REDIS_URL: 'redis://localhost:6379',
  S3_BUCKET: 'ecsi-dev',
  S3_ACCESS_KEY_ID: 'access',
  S3_SECRET_ACCESS_KEY: 'a-long-secret',
  DATABASE_AUTH_URL: 'postgres://ecsi_auth:secret@localhost:5432/ecsi',
  JWT_ACCESS_SECRET: 'x'.repeat(32),
  ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
};

const production = { ...base, NODE_ENV: 'production', WEB_PUBLIC_URL: 'https://app.ecsi.test' };

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

  it('désactive la documentation OpenAPI en production (et refuse de l’activer : CSP)', () => {
    expect(isApiDocsEnabled(parseEnv(production))).toBe(false);
    expect(() => parseEnv({ ...production, API_DOCS_ENABLED: 'true' })).toThrow(/API_DOCS_ENABLED/);
    expect(isApiDocsEnabled(parseEnv({ ...base, API_DOCS_ENABLED: 'false' }))).toBe(false);
  });

  it('production : origines CORS https uniquement, proxy de confiance obligatoire', () => {
    expect(parseEnv({ ...production, CORS_ORIGINS: 'https://app.ecsi.test' }).CORS_ORIGINS).toEqual(
      ['https://app.ecsi.test'],
    );
    expect(() =>
      parseEnv({ ...production, CORS_ORIGINS: 'https://app.ecsi.test,http://localhost:3000' }),
    ).toThrow(/CORS_ORIGINS/);
    expect(() => parseEnv({ ...production, TRUST_PROXY_HOPS: '0' })).toThrow(/TRUST_PROXY_HOPS/);
    expect(parseEnv({ ...base, TRUST_PROXY_HOPS: '0' }).TRUST_PROXY_HOPS).toBe(0);
  });

  it('SMTP : STARTTLS exigé en production sauf TLS implicite, jamais d’envoi en clair', () => {
    expect(isSmtpTlsRequired(parseEnv(production))).toBe(true);
    expect(isSmtpTlsRequired(parseEnv({ ...production, SMTP_SECURE: 'true' }))).toBe(false);
    expect(isSmtpTlsRequired(parseEnv(base))).toBe(false);
    expect(isSmtpTlsRequired(parseEnv({ ...base, SMTP_REQUIRE_TLS: 'true' }))).toBe(true);
    expect(() => parseEnv({ ...production, SMTP_REQUIRE_TLS: 'false' })).toThrow(
      /SMTP_REQUIRE_TLS/,
    );
  });

  it('exige des secrets d’authentification valides', () => {
    expect(() => parseEnv({ ...base, JWT_ACCESS_SECRET: 'court' })).toThrow(/JWT_ACCESS_SECRET/);
    expect(() => parseEnv({ ...base, ENCRYPTION_KEY: 'abcd' })).toThrow(/ENCRYPTION_KEY/);
  });

  it('impose des cookies Secure et un lien HTTPS en production', () => {
    expect(isCookieSecure(parseEnv(base))).toBe(false);
    expect(isCookieSecure(parseEnv(production))).toBe(true);
    expect(() => parseEnv({ ...production, COOKIE_SECURE: 'false' })).toThrow(/COOKIE_SECURE/);
    expect(() => parseEnv({ ...production, WEB_PUBLIC_URL: 'http://app.ecsi.test' })).toThrow(
      /WEB_PUBLIC_URL/,
    );
  });

  it('enrôlement des routeurs : valeurs publiques validées, AC de laboratoire interdite en production', () => {
    const env = parseEnv(base);
    expect(env.WG_GATEWAY_PORT).toBe(51820);
    expect(env.ROUTER_ACTIVATION_PORT).toBe(8081);
    expect(env.ROUTER_ENROLL_TOKEN_TTL_MINUTES).toBe(30);
    expect(env.WG_GATEWAY_PUBLIC_KEY).toBeUndefined();
    expect(() => parseEnv({ ...base, WG_GATEWAY_PUBLIC_KEY: 'pas-une-cle' })).toThrow(
      /WG_GATEWAY_PUBLIC_KEY/,
    );
    expect(() => parseEnv({ ...base, WG_GATEWAY_ENDPOINT: 'vpn.ecsi.test"; :put x' })).toThrow(
      /WG_GATEWAY_ENDPOINT/,
    );
    expect(() =>
      parseEnv({ ...base, ROUTER_ENROLL_PUBLIC_URL: 'http://cloud.ecsi.test/enroll' }),
    ).toThrow(/ROUTER_ENROLL_PUBLIC_URL/);
    expect(() => parseEnv({ ...base, ROUTER_ENROLL_CA_URL: 'https://lab.test/ca.pem' })).toThrow(
      /ROUTER_ENROLL_CA_URL/,
    );
    const lab = {
      ROUTER_ENROLL_CA_URL: 'https://lab.test/ca.pem',
      ROUTER_ENROLL_CA_FINGERPRINT: 'ab'.repeat(32),
    };
    expect(parseEnv({ ...base, ...lab }).ROUTER_ENROLL_CA_FINGERPRINT).toBe('ab'.repeat(32));
    expect(() => parseEnv({ ...production, ...lab })).toThrow(/ROUTER_ENROLL_CA_URL/);
  });

  it('enrôlement : une variable vide (Compose « ${X:-} ») vaut « non configurée »', () => {
    const env = parseEnv({
      ...base,
      ROUTER_ENROLL_PUBLIC_URL: '',
      ROUTER_ENROLL_CA_URL: '',
      ROUTER_ENROLL_CA_FINGERPRINT: '',
      WG_GATEWAY_PUBLIC_KEY: '',
      WG_GATEWAY_ENDPOINT: '',
    });
    expect(env.ROUTER_ENROLL_PUBLIC_URL).toBeUndefined();
    expect(env.ROUTER_ENROLL_CA_URL).toBeUndefined();
    expect(env.ROUTER_ENROLL_CA_FINGERPRINT).toBeUndefined();
    expect(env.WG_GATEWAY_PUBLIC_KEY).toBeUndefined();
    expect(env.WG_GATEWAY_ENDPOINT).toBeUndefined();
  });

  it('WG_GATEWAY_ENDPOINT : hôte ou IPv4 seul, le port va dans WG_GATEWAY_PORT', () => {
    expect(parseEnv({ ...base, WG_GATEWAY_ENDPOINT: '203.0.113.10' }).WG_GATEWAY_ENDPOINT).toBe(
      '203.0.113.10',
    );
    expect(parseEnv({ ...base, WG_GATEWAY_ENDPOINT: 'vpn.ecsi.test' }).WG_GATEWAY_ENDPOINT).toBe(
      'vpn.ecsi.test',
    );
    for (const endpoint of ['203.0.113.10:51820', 'vpn.ecsi.test:51820']) {
      expect(() => parseEnv({ ...base, WG_GATEWAY_ENDPOINT: endpoint })).toThrow(
        /WG_GATEWAY_ENDPOINT : .*sans « :port »/,
      );
    }
  });
});
