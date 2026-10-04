import { describe, expect, it } from 'vitest';
import { parseEnv } from './env.js';
import { parseWorkerEnv } from './worker-env.js';

const base = {
  DATABASE_WORKER_URL: 'postgres://ecsi_worker:x@localhost:5432/ecsi',
  ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
};

describe('configuration du worker', () => {
  it('ne demande que sa connexion ecsi_worker et les clés du SecretBox', () => {
    const env = parseWorkerEnv(base);
    expect(env.ROUTER_TUNNEL_CIDR).toBe('10.200.0.0/24');
    expect(env.ROUTER_OFFLINE_AFTER_SECONDS).toBe(180);
    expect(env.ROUTER_OFFLINE_MIN_FAILURES).toBe(3);
    expect(Object.keys(env)).not.toContain('JWT_ACCESS_SECRET');
    expect(Object.keys(env)).not.toContain('DATABASE_URL');
  });

  it('refuse une plage tunnel publique ou trop large, et l’absence de connexion', () => {
    expect(() => parseWorkerEnv({ ...base, ROUTER_TUNNEL_CIDR: '0.0.0.0/0' })).toThrow(
      /ROUTER_TUNNEL_CIDR/,
    );
    expect(() =>
      parseWorkerEnv({
        ...base,
        ROUTER_TUNNEL_CIDR: '8.8.8.0/24',
        ROUTER_TUNNEL_GATEWAY: '8.8.8.1',
      }),
    ).toThrow(/ROUTER_TUNNEL_CIDR/);
    expect(() => parseWorkerEnv({ ENCRYPTION_KEY: base.ENCRYPTION_KEY })).toThrow(
      /DATABASE_WORKER_URL/,
    );
  });

  it('refuse les valeurs de développement en production', () => {
    expect(() =>
      parseWorkerEnv({
        ...base,
        NODE_ENV: 'production',
        DATABASE_WORKER_URL: 'postgres://ecsi_worker:devonly@db/ecsi',
      }),
    ).toThrow(/DATABASE_WORKER_URL/);
  });

  it('l’API valide aussi la plage tunnel', () => {
    expect(() =>
      parseEnv({
        DATABASE_URL: 'postgres://a:b@h/d',
        DATABASE_AUTH_URL: 'postgres://a:b@h/d',
        REDIS_URL: 'redis://h',
        S3_BUCKET: 'bucket',
        S3_ACCESS_KEY_ID: 'k',
        S3_SECRET_ACCESS_KEY: 'secret-key',
        JWT_ACCESS_SECRET: 'x'.repeat(32),
        ENCRYPTION_KEY: base.ENCRYPTION_KEY,
        ROUTER_TUNNEL_CIDR: '127.0.0.0/24',
        ROUTER_TUNNEL_GATEWAY: '127.0.0.1',
      }),
    ).toThrow(/ROUTER_TUNNEL_CIDR/);
  });
});

describe('configuration de l’agent passerelle', () => {
  it('connexion ecsi_worker, interface et binaire wg validés ; aucun secret d’API', async () => {
    const { parseGatewayEnv } = await import('./gateway-env.js');
    const env = parseGatewayEnv(base);
    expect(env).toMatchObject({
      WG_INTERFACE: 'wg0',
      WG_COMMAND: 'wg',
      ROUTER_ACTIVATION_PORT: 8081,
    });
    expect(Object.keys(env)).not.toContain('JWT_ACCESS_SECRET');
    expect(() => parseGatewayEnv({ ...base, WG_INTERFACE: 'wg0; reboot' })).toThrow(/WG_INTERFACE/);
    expect(() => parseGatewayEnv({ ...base, WG_COMMAND: 'wg && rm' })).toThrow(/WG_COMMAND/);
  });
});
