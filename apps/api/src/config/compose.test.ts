/**
 * Garde-fou du packaging (rapport de validation S3B, §6.1 et §6.2) : docker-compose.yml doit
 * transmettre à chaque processus TOUTES les variables qu'il lit, avec des valeurs par défaut
 * acceptées par sa validation, et le worker doit avoir son propre healthcheck.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { parseEnv } from './env.js';
import { parseGatewayEnv } from './gateway-env.js';
import { routerEnrollmentShape } from './router-enrollment.js';
import { routerNetworkShape } from './router-network.js';
import { parseWorkerEnv } from './worker-env.js';

interface ComposeService {
  environment?: Record<string, string | number>;
  healthcheck?: { test: string[] };
  build?: { target?: string };
  network_mode?: string;
  cap_add?: string[];
  cap_drop?: string[];
  profiles?: string[];
  ports?: string[];
}
const compose = parse(
  readFileSync(new URL('../../../../docker-compose.yml', import.meta.url), 'utf8'),
  {
    merge: true,
  },
) as { services: Record<string, ComposeService> };

/** Interpolation de Compose avec un .env vide : « ${X:-défaut} » → défaut, « $$ » → « $ ». */
function interpolate(environment: Record<string, string | number> = {}): Record<string, string> {
  return Object.fromEntries(
    Object.entries(environment).map(([key, value]) => [
      key,
      String(value)
        .replace(
          /\$\{[A-Z0-9_]+(?::-([^}]*))?\}/g,
          (_m, fallback: string | undefined) => fallback ?? '',
        )
        .replaceAll('$$', '$'),
    ]),
  );
}

const service = (name: string): ComposeService => {
  const found = compose.services[name];
  if (!found) throw new Error(`service ${name} absent de docker-compose.yml`);
  return found;
};

describe('docker-compose.yml', () => {
  it('API : toutes les variables d’enrôlement et du réseau tunnel sont transmises', () => {
    const env = service('api').environment ?? {};
    for (const key of [...Object.keys(routerEnrollmentShape), ...Object.keys(routerNetworkShape)]) {
      expect(env, key).toHaveProperty(key);
    }
  });

  it('API : les valeurs par défaut démarrent (enrôlement non configuré, pas d’erreur)', () => {
    const env = parseEnv(interpolate(service('api').environment));
    expect(env.WG_GATEWAY_PUBLIC_KEY).toBeUndefined();
    expect(env.WG_GATEWAY_ENDPOINT).toBeUndefined();
    expect(env.WG_GATEWAY_PORT).toBe(51820);
    expect(env.ROUTER_TUNNEL_CIDR).toBe('10.200.0.0/24');
  });

  it('API : les valeurs fournies par .env sont bien acheminées', () => {
    const environment = service('api').environment ?? {};
    const values: Record<string, string> = {
      WG_GATEWAY_PUBLIC_KEY: 'devonlyWireGuardPublicKeyForTests000000000A=',
      WG_GATEWAY_ENDPOINT: 'vpn.ecsi.test',
      WG_GATEWAY_PORT: '51821',
      ROUTER_ENROLL_PUBLIC_URL: 'https://cloud.ecsi.test/api/v1/routers/enroll',
    };
    const resolved = Object.fromEntries(
      Object.entries(environment).map(([key, value]) => [
        key,
        String(value).replace(
          /\$\{([A-Z0-9_]+)(?::-([^}]*))?\}/g,
          (_m, name: string, fallback?: string) => values[name] ?? fallback ?? '',
        ),
      ]),
    );
    const env = parseEnv(resolved);
    expect(env).toMatchObject({
      WG_GATEWAY_PUBLIC_KEY: values.WG_GATEWAY_PUBLIC_KEY,
      WG_GATEWAY_ENDPOINT: 'vpn.ecsi.test',
      WG_GATEWAY_PORT: 51821,
      ROUTER_ENROLL_PUBLIC_URL: values.ROUTER_ENROLL_PUBLIC_URL,
    });
  });

  it('worker : configuration valide et healthcheck propre (pas celui HTTP de l’API)', () => {
    expect(() => parseWorkerEnv(interpolate(service('worker').environment))).not.toThrow();
    expect(service('worker').healthcheck?.test).toEqual([
      'CMD',
      'node',
      'dist/healthcheck.js',
      'worker',
    ]);
  });

  it('passerelle : profil dédié, réseau de l’hôte, seule capacité NET_ADMIN, configuration valide', () => {
    const gateway = service('gateway');
    expect(gateway.profiles).toEqual(['gateway']);
    expect(gateway.build?.target).toBe('gateway');
    expect(gateway.network_mode).toBe('host');
    expect(gateway.cap_drop).toEqual(['ALL']);
    expect(gateway.cap_add).toEqual(['NET_ADMIN']);
    const env = parseGatewayEnv(interpolate(gateway.environment));
    expect(env.ROUTER_TUNNEL_GATEWAY).toBe('10.200.0.1');
    // Jamais de secret de l'API (JWT, connexions ecsi_app / ecsi_auth) dans la passerelle.
    for (const key of ['JWT_ACCESS_SECRET', 'DATABASE_URL', 'DATABASE_AUTH_URL', 'REDIS_URL']) {
      expect(gateway.environment, key).not.toHaveProperty(key);
    }
  });

  it('Nginx : toutes les interfaces par défaut, adresse fixable pour libérer l’adresse tunnel', () => {
    const ports = service('nginx').ports ?? [];
    expect(ports).toEqual([
      '${NGINX_BIND_ADDRESS:-0.0.0.0}:8080:8080',
      '${NGINX_BIND_ADDRESS:-0.0.0.0}:8081:8081',
    ]);
    expect(Object.values(interpolate(Object.fromEntries(ports.entries())))).toEqual([
      '0.0.0.0:8080:8080',
      '0.0.0.0:8081:8081',
    ]);
  });
});
