import { describe, expect, it } from 'vitest';
import { parseEnvLines, productionPreflight } from './production-preflight.js';

const secret = `s-${Math.random().toString(36).slice(2)}-${Date.now()}`;
const running = {
  NODE_ENV: 'production',
  DATABASE_URL: `postgres://ecsi_app:${secret}@postgres:5432/ecsi`,
  DATABASE_AUTH_URL: `postgres://ecsi_auth:${secret}@postgres:5432/ecsi`,
  REDIS_URL: `redis://:${secret}@redis:6379`,
  S3_BUCKET: 'ecsi-prod',
  S3_ACCESS_KEY_ID: 'ecsi-prod',
  S3_SECRET_ACCESS_KEY: secret,
  JWT_ACCESS_SECRET: secret.padEnd(40, 'x'),
  ENCRYPTION_KEY: Buffer.alloc(32, 3).toString('base64'),
  WEB_PUBLIC_URL: 'https://app.mytikcentral.com',
  CORS_ORIGINS: 'https://app.mytikcentral.com',
  COOKIE_SECURE: 'true',
};

describe('productionPreflight', () => {
  it('accepte une configuration de production conforme', () => {
    expect(productionPreflight(running)).toEqual({
      currentNodeEnv: 'production',
      blocking: [],
      warnings: [],
    });
  });

  it('liste les refus de cette version et les écarts, sans jamais afficher une valeur', () => {
    const report = productionPreflight({
      ...running,
      NODE_ENV: 'development',
      CORS_ORIGINS: 'https://app.mytikcentral.com,http://localhost:3000',
      SMTP_REQUIRE_TLS: 'false',
      DATABASE_MIGRATOR_URL: `postgres://ecsi_migrator:${secret}@postgres:5432/ecsi`,
      RATE_LIMIT_LOGIN_PER_IP: '200',
    });
    expect(report.currentNodeEnv).toBe('development');
    expect(report.blocking.join('\n')).toMatch(/CORS_ORIGINS[\s\S]*SMTP_REQUIRE_TLS/);
    expect(report.warnings.join('\n')).toMatch(/DATABASE_MIGRATOR_URL[\s\S]*RATE_LIMIT/);
    expect(JSON.stringify(report)).not.toContain(secret);
  });

  it('lit la sortie de « env » (valeurs contenant « = »)', () => {
    expect(parseEnvLines('A=1\nB=x=y\n\nignoré\n1X=z\n')).toEqual({ A: '1', B: 'x=y' });
  });
});
