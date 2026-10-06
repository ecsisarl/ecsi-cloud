/**
 * Surcouche de production (S3H, étape H0) : docker-compose.prod.yml doit rendre obligatoires
 * tous les secrets que le Compose de développement fournit avec une valeur « devonly », passer
 * les processus en production et ne publier que Nginx :80 (et PostgreSQL sur 127.0.0.1).
 */
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { DEV_ONLY_MARKER, parseEnv } from './env.js';
import { parseGatewayEnv } from './gateway-env.js';
import { parseWorkerEnv } from './worker-env.js';

type Env = Record<string, string | number>;
interface Service {
  environment?: Env;
  ports?: string[];
  profiles?: string[];
  command?: string[];
  depends_on?: Record<string, unknown>;
}
interface ComposeFile {
  services: Record<string, Service>;
  'x-prod-env'?: Env;
}

const read = (name: string) =>
  readFileSync(new URL(`../../../../${name}`, import.meta.url), 'utf8');
const prodText = read('docker-compose.prod.yml');
/** Les balises Compose « !reset » / « !override » remplacent la valeur héritée : on les relève. */
const tagged = (tag: string) =>
  new Set(
    [
      ...prodText.matchAll(new RegExp(`^ {2}(\\w+):\\n(?:^ {4}.*\\n)*?^ {4}(\\w+): ${tag}`, 'gm')),
    ].map((m) => `${m[1]}.${m[2]}`),
  );
const resets = tagged('!reset');
const overrides = tagged('!override');
const base = parse(read('docker-compose.yml'), { merge: true }) as ComposeFile;
const prod = parse(prodText.replaceAll(/ !(reset|override)\b/g, ''), {
  merge: true,
}) as ComposeFile;

const service = (file: ComposeFile, name: string): Service => {
  const found = file.services[name];
  if (!found) throw new Error(`service ${name} absent`);
  return found;
};

/** Interpolation Compose : « ${X:-défaut} », « ${X:?message} » (erreur si X absent), « $$ ». */
function interpolate(env: Env = {}, values: Record<string, string> = {}): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).map(([key, value]) => [
      key,
      String(value)
        .replace(
          /\$\{([A-Z0-9_]+)(?::([-?])([^}]*))?\}/g,
          (_m, name: string, op: string | undefined, arg: string | undefined) => {
            const provided = values[name];
            if (provided !== undefined && provided !== '') return provided;
            if (op === '?') throw new Error(`required variable ${name} : ${arg ?? ''}`);
            return op === '-' ? (arg ?? '') : '';
          },
        )
        .replaceAll('$$', '$'),
    ]),
  );
}

/** Clés dont la valeur par défaut de développement contient « devonly ». */
const devOnlyKeys = (env: Env = {}) =>
  Object.entries(env)
    .filter(([, value]) => String(value).toLowerCase().includes(DEV_ONLY_MARKER))
    .map(([key]) => key);

const requiredOnly = (value: string | number | undefined) => {
  const refs = [...String(value).matchAll(/\$\{([A-Z0-9_]+)(:[-?])?/g)];
  return refs.length > 0 && refs.every((ref) => ref[2] === ':?' || ref[1] === 'POSTGRES_DB');
};

/** Valeurs de test aléatoires (jamais « devonly », jamais écrites dans le dépôt). */
const random = (bytes = 24) => randomBytes(bytes).toString('hex');
const VALUES: Record<string, string> = {
  POSTGRES_PASSWORD: random(),
  ECSI_DB_MIGRATOR_PASSWORD: random(),
  ECSI_DB_APP_PASSWORD: random(),
  ECSI_DB_AUTH_PASSWORD: random(),
  ECSI_DB_WORKER_PASSWORD: random(),
  REDIS_PASSWORD: random(),
  S3_BUCKET: 'ecsi-prod-test',
  S3_ACCESS_KEY_ID: `ecsi-${random(8)}`,
  S3_SECRET_ACCESS_KEY: random(),
  JWT_ACCESS_SECRET: random(32),
  ENCRYPTION_KEY: randomBytes(32).toString('base64'),
  ENCRYPTION_KEY_ID: 'k1',
  WEB_PUBLIC_URL: 'https://app.example.test',
  CORS_ORIGINS: 'https://app.example.test',
  SMTP_HOST: 'smtp.example.test',
  SMTP_PORT: '587',
  SMTP_FROM: 'ECSI CLOUD <no-reply@example.test>',
};

/** Environnement effectif d'un service : Compose de base puis surcouche (clé par clé). */
const merged = (name: string, values = VALUES) => ({
  ...interpolate(service(base, name).environment, values),
  ...interpolate(service(prod, name).environment, values),
});

describe('docker-compose.prod.yml (surcouche de production)', () => {
  it('aucune valeur « devonly » dans la surcouche', () => {
    expect(prodText.toLowerCase()).not.toContain(DEV_ONLY_MARKER);
  });

  it('chaque secret « devonly » du Compose de base est rendu obligatoire (${X:?…})', () => {
    for (const name of ['api', 'migrate', 'worker', 'gateway', 'postgres', 'redis', 's3']) {
      const overlay = service(prod, name).environment ?? {};
      for (const key of devOnlyKeys(service(base, name).environment)) {
        expect(overlay, `${name}.${key}`).toHaveProperty(key);
        expect(requiredOnly(overlay[key]), `${name}.${key} doit être obligatoire`).toBe(true);
      }
    }
    expect(service(prod, 'redis').command?.join(' ')).toContain('${REDIS_PASSWORD:?');
  });

  it('API, migrations, worker et passerelle en production', () => {
    for (const name of ['api', 'migrate', 'worker', 'gateway']) {
      expect(merged(name).NODE_ENV, name).toBe('production');
    }
    expect(merged('api').COOKIE_SECURE).toBe('true');
    expect(merged('api').S3_AUTO_CREATE_BUCKET).toBe('false');
  });

  it('les environnements effectifs passent les garde-fous de production du code', () => {
    expect(() => parseEnv(merged('api'))).not.toThrow();
    expect(() => parseEnv(merged('migrate'))).not.toThrow();
    expect(() => parseWorkerEnv(merged('worker'))).not.toThrow();
    expect(() => parseGatewayEnv(merged('gateway'))).not.toThrow();
  });

  it('une variable obligatoire absente bloque la configuration, sans valeur affichée', () => {
    const { JWT_ACCESS_SECRET: _omitted, ...rest } = VALUES;
    expect(() => merged('api', rest)).toThrow(/JWT_ACCESS_SECRET : JWT_ACCESS_SECRET obligatoire/);
  });

  it('ports : seul Nginx :80 est publié (PostgreSQL reste sur 127.0.0.1 pour la passerelle)', () => {
    for (const name of ['redis', 's3', 'mailpit', 'api', 'web', 'portal']) {
      expect(resets.has(`${name}.ports`), name).toBe(true);
      expect(service(prod, name).ports, name).toEqual([]);
    }
    expect(overrides.has('nginx.ports')).toBe(true);
    expect(service(prod, 'nginx').ports).toEqual(['80:8080']);
    expect(service(prod, 'postgres').ports).toBeUndefined();
    for (const port of service(base, 'postgres').ports ?? [])
      expect(port).toMatch(/^127\.0\.0\.1:/);
  });

  it('Mailpit retiré : profil dédié et plus de dépendance de l’API', () => {
    expect(service(prod, 'mailpit').profiles).toEqual(['dev-mail']);
    expect(overrides.has('api.depends_on')).toBe(true);
    expect(Object.keys(service(prod, 'api').depends_on ?? {})).not.toContain('mailpit');
  });

  it('le Compose de développement garde ses valeurs (NODE_ENV=development)', () => {
    expect(interpolate(service(base, 'api').environment).NODE_ENV).toBe('development');
    expect(service(base, 'mailpit').profiles).toBeUndefined();
  });
});
