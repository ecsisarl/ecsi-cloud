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
interface Volume {
  type: string;
  source: string;
  target: string;
  read_only?: boolean;
}
interface Service {
  image?: string;
  volumes?: (string | Volume)[];
  environment?: Env;
  entrypoint?: string[];
  pull_policy?: string;
  ports?: string[];
  profiles?: string[];
  command?: string[];
  depends_on?: Record<string, unknown>;
}
interface ComposeFile {
  services: Record<string, Service>;
  volumes?: Record<string, unknown>;
  'x-prod-env'?: Env;
}

const read = (name: string) =>
  readFileSync(new URL(`../../../../${name}`, import.meta.url), 'utf8');
const prodText = read('docker-compose.prod.yml');
/** Les balises Compose « !reset » / « !override » remplacent la valeur héritée : on les relève. */
const tagged = (tag: string) => {
  const found = new Set<string>();
  // Chaque service (indentation 2), puis chacune de ses clés balisées (indentation 4).
  for (const block of prodText.matchAll(/^ {2}([\w-]+):\n((?:^(?: {4}.*)?\n)*)/gm)) {
    for (const key of (block[2] ?? '').matchAll(new RegExp(`^ {4}(\\w+): ${tag}`, 'gm'))) {
      found.add(`${block[1]}.${key[1]}`);
    }
  }
  return found;
};
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
  ECSI_DB_RADIUS_PASSWORD: random(),
  REDIS_PASSWORD: random(),
  S3_BUCKET: 'ecsi-prod-test',
  S3_ACCESS_KEY_ID: `ecsi-${random(8)}`,
  S3_SECRET_ACCESS_KEY: random(),
  JWT_ACCESS_SECRET: random(32),
  ENCRYPTION_KEY: randomBytes(32).toString('base64'),
  ENCRYPTION_KEY_ID: 'k1',
  WEB_PUBLIC_URL: 'https://app.mytikcentral.com',
  CORS_ORIGINS: 'https://app.mytikcentral.com',
  ROUTER_ENROLL_PUBLIC_URL: 'https://enroll.mytikcentral.com/api/v1/routers/enroll',
  SMTP_HOST: 'smtp.example.test',
  SMTP_PORT: '587',
  SMTP_FROM: 'ECSI CLOUD <no-reply@example.test>',
};

/** Environnement effectif d'un service : Compose de base puis surcouche (clé par clé). */
const merged = (name: string, values = VALUES) => ({
  ...interpolate(service(base, name).environment, values),
  ...interpolate(service(prod, name).environment, values),
});

const parseEnvForService = (name: string, env: Record<string, string>) => {
  if (name === 'worker' || name === 'keys-rotate') return parseWorkerEnv(env);
  if (name === 'gateway') return parseGatewayEnv(env);
  return parseEnv(env);
};

describe('docker-compose.prod.yml (surcouche de production)', () => {
  it('aucune valeur « devonly » dans la surcouche', () => {
    expect(prodText.toLowerCase()).not.toContain(DEV_ONLY_MARKER);
  });

  it('chaque secret « devonly » du Compose de base est rendu obligatoire (${X:?…})', () => {
    for (const name of [
      'api',
      'migrate',
      'worker',
      'gateway',
      'keys-rotate',
      'postgres',
      'redis',
      's3',
    ]) {
      const overlay = service(prod, name).environment ?? {};
      for (const key of devOnlyKeys(service(base, name).environment)) {
        expect(overlay, `${name}.${key}`).toHaveProperty(key);
        expect(requiredOnly(overlay[key]), `${name}.${key} doit être obligatoire`).toBe(true);
      }
    }
    // Redis : mot de passe obligatoire par l'environnement ; la commande vient du Compose de base.
    expect(service(prod, 'redis').command).toBeUndefined();
  });

  it('API, migrations, worker et passerelle en production', () => {
    for (const name of ['api', 'migrate', 'worker', 'gateway', 'keys-rotate']) {
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

  it('ports : seul Nginx :80 et :443 est publié (PostgreSQL reste sur 127.0.0.1 pour la passerelle)', () => {
    for (const name of ['redis', 's3', 'mailpit', 'api', 'web', 'portal']) {
      expect(resets.has(`${name}.ports`), name).toBe(true);
      expect(service(prod, name).ports, name).toEqual([]);
    }
    expect(overrides.has('nginx.ports')).toBe(true);
    expect(service(prod, 'nginx').ports).toEqual(['80:8080', '443:8443']);
    for (const [name, svc] of Object.entries(prod.services)) {
      if (!['nginx', 'redis', 's3', 'mailpit', 'api', 'web', 'portal'].includes(name)) {
        expect(svc.ports, `${name} ne publie aucun port`).toBeUndefined();
      }
    }
    expect(service(prod, 'postgres').ports).toBeUndefined();
    for (const port of service(base, 'postgres').ports ?? [])
      expect(port).toMatch(/^127\.0\.0\.1:/);
  });

  it('Mailpit retiré : profil dédié et plus de dépendance de l’API', () => {
    expect(service(prod, 'mailpit').profiles).toEqual(['dev-mail']);
    expect(overrides.has('api.depends_on')).toBe(true);
    expect(Object.keys(service(prod, 'api').depends_on ?? {})).not.toContain('mailpit');
  });

  it('service d’exploitation keys-rotate (S3H-H2) : profil ops, sans port ni dépendance', () => {
    const ops = service(base, 'keys-rotate');
    expect(ops.profiles).toEqual(['ops']);
    expect(ops.ports).toBeUndefined();
    expect(ops.depends_on).toBeUndefined();
    expect(ops.pull_policy).toBe('never');
    expect(ops.entrypoint).toEqual(['node', 'dist/cli/rotate-encryption-keys.js']);
    const env = merged('keys-rotate');
    for (const key of ['DATABASE_MIGRATOR_URL', 'DATABASE_AUTH_URL', 'DATABASE_WORKER_URL']) {
      expect(env[key], key).toMatch(/^postgres:\/\/ecsi_\w+:[0-9a-f]{48}@postgres:5432\/ecsi$/);
    }
    // Aucun autre secret applicatif que ceux nécessaires à la rotation.
    expect(Object.keys(env).sort()).toEqual(
      [
        'DATABASE_AUTH_URL',
        'DATABASE_MIGRATOR_URL',
        'DATABASE_WORKER_URL',
        'ENCRYPTION_KEY',
        'ENCRYPTION_KEY_ID',
        'ENCRYPTION_PREVIOUS_KEYS',
        'NODE_ENV',
      ].sort(),
    );
  });

  it('ancienne clé (ENCRYPTION_PREVIOUS_KEYS) transmise à tous les processus qui déchiffrent', () => {
    const previous = `k2:${randomBytes(32).toString('base64')}`;
    for (const name of ['api', 'migrate', 'worker', 'gateway', 'keys-rotate']) {
      expect(
        merged(name, { ...VALUES, ENCRYPTION_PREVIOUS_KEYS: previous }).ENCRYPTION_PREVIOUS_KEYS,
        name,
      ).toBe(previous);
    }
  });

  it('ancienne clé k2 conservée après fusion, avec plusieurs anciennes clés', () => {
    const previous = `k3:${randomBytes(32).toString('base64')},k2:${randomBytes(32).toString('base64')}`;
    for (const name of ['api', 'migrate', 'worker', 'gateway', 'keys-rotate']) {
      const env = merged(name, { ...VALUES, ENCRYPTION_PREVIOUS_KEYS: previous });
      expect(env.ENCRYPTION_PREVIOUS_KEYS, name).toBe(previous);
      expect(() => parseEnvForService(name, env), name).not.toThrow();
    }
  });

  it('le Compose de développement garde ses valeurs (NODE_ENV=development)', () => {
    expect(interpolate(service(base, 'api').environment).NODE_ENV).toBe('development');
    expect(service(base, 'mailpit').profiles).toBeUndefined();
  });
});

const nginxDir = 'infra/nginx/production';
const nginxConf = (name: string) => read(`${nginxDir}/${name}`);
/** Blocs « server { … } » de premier niveau du bloc http (indentation de 2 espaces). */
const serverBlocks = (text: string) =>
  [...text.matchAll(/^ {2}server \{\n([\s\S]*?)^ {2}\}$/gm)].map((m) => m[1] ?? '');

describe('S3H-H4 : HTTPS public (Nginx de production, certbot)', () => {
  it('Nginx : configuration de production choisie par ECSI_NGINX_MODE (https par défaut)', () => {
    const command = service(prod, 'nginx').command ?? [];
    expect(command).toEqual([
      'nginx',
      '-c',
      '/etc/nginx/ecsi/${ECSI_NGINX_MODE:-https}.conf',
      '-g',
      'daemon off;',
    ]);
    expect(interpolate({ c: command[2] ?? '' }).c).toBe('/etc/nginx/ecsi/https.conf');
    expect(nginxConf('https.conf')).toContain('listen 8443 ssl');
    expect(nginxConf('acme-bootstrap.conf')).not.toContain('8443');
  });

  it('Nginx : certificats et défis ACME en lecture seule, configuration de développement non montée', () => {
    expect(overrides.has('nginx.volumes')).toBe(true);
    const volumes = (service(prod, 'nginx').volumes ?? []) as Volume[];
    expect(volumes).toEqual([
      {
        type: 'bind',
        source: './infra/nginx/production',
        target: '/etc/nginx/ecsi',
        read_only: true,
      },
      { type: 'volume', source: 'letsencrypt', target: '/etc/letsencrypt', read_only: true },
      { type: 'volume', source: 'acme-webroot', target: '/var/www/acme', read_only: true },
    ]);
    expect(Object.keys(prod.volumes ?? {}).sort()).toEqual(['acme-webroot', 'letsencrypt']);
  });

  it('portail captif non requis : ni dépendance de Nginx, ni démarrage par défaut', () => {
    expect(overrides.has('nginx.depends_on')).toBe(true);
    expect(service(prod, 'nginx').depends_on).toEqual(['api', 'web']);
    expect(service(prod, 'portal').profiles).toEqual(['portail']);
    for (const file of ['https.conf', 'acme-bootstrap.conf']) {
      expect(nginxConf(file)).not.toMatch(/portal:|ecsi_portal|3001/);
    }
  });

  it('certbot : à la demande (profil tls), image figée, aucun port ni dépendance', () => {
    const certbot = service(prod, 'certbot');
    expect(certbot.profiles).toEqual(['tls']);
    expect(certbot.image).toMatch(/^certbot\/certbot:v\d+\.\d+\.\d+$/);
    expect(certbot.ports).toBeUndefined();
    expect(certbot.depends_on).toBeUndefined();
    expect(certbot.volumes).toEqual(['letsencrypt:/etc/letsencrypt', 'acme-webroot:/var/www/acme']);
  });

  it('variables de production H4 acceptées par le code, AC privée neutralisée', () => {
    const env = merged('api', {
      ...VALUES,
      ROUTER_ENROLL_CA_URL: 'https://ca.lab.example/ecsi-ca.pem',
      ROUTER_ENROLL_CA_FINGERPRINT: 'a'.repeat(64),
    });
    expect(env).toMatchObject({
      WEB_PUBLIC_URL: 'https://app.mytikcentral.com',
      CORS_ORIGINS: 'https://app.mytikcentral.com',
      ROUTER_ENROLL_PUBLIC_URL: 'https://enroll.mytikcentral.com/api/v1/routers/enroll',
      COOKIE_SECURE: 'true',
      LOG_PRETTY: 'false',
      S3_AUTO_CREATE_BUCKET: 'false',
      ROUTER_ENROLL_CA_URL: '',
      ROUTER_ENROLL_CA_FINGERPRINT: '',
    });
    const parsed = parseEnv(env);
    expect(parsed.ROUTER_ENROLL_CA_URL).toBeUndefined();
    expect(parsed.ROUTER_ENROLL_PUBLIC_URL).toBe(
      'https://enroll.mytikcentral.com/api/v1/routers/enroll',
    );
  });

  it('HSTS et en-têtes de sécurité seulement dans les blocs HTTPS ; défi ACME seulement en HTTP', () => {
    const blocks = serverBlocks(nginxConf('https.conf'));
    expect(blocks).toHaveLength(5);
    for (const block of blocks) {
      if (block.includes('listen 8080')) {
        expect(block).not.toMatch(/security-headers|Strict-Transport-Security|ssl/);
      } else {
        expect(block).toMatch(/listen 8443 ssl/);
        expect(block).not.toContain('acme-challenge');
        for (const location of block.split(/^ {4}location /m).slice(1)) {
          expect(location).toContain('security-headers.conf');
        }
      }
    }
    for (const block of serverBlocks(nginxConf('acme-bootstrap.conf'))) {
      expect(block).not.toMatch(/security-headers|ssl|proxy_pass/);
    }
    const headers = nginxConf('snippets/security-headers.conf');
    expect(headers).toMatch(/add_header Strict-Transport-Security "max-age=\d+" always;/);
    expect(headers).toContain('proxy_hide_header Strict-Transport-Security;');
  });

  it('enroll : POST /api/v1/routers/enroll exact seulement, tout le reste refusé', () => {
    const enroll = serverBlocks(nginxConf('https.conf')).find((b) =>
      b.includes('server_name enroll.mytikcentral.com'),
    );
    expect(enroll).toBeDefined();
    const locations = (enroll ?? '').match(/^ {4}location [^{]+/gm) ?? [];
    expect(locations.map((l) => l.trim())).toEqual([
      'location = /api/v1/routers/enroll',
      'location /',
    ]);
    expect(enroll).toContain('if ($request_uri != "/api/v1/routers/enroll")');
    expect(enroll).toContain('if ($request_method != POST)');
    expect(enroll).toContain('proxy_pass http://ecsi_api/api/v1/routers/enroll;');
    expect((enroll ?? '').match(/proxy_pass/g)).toHaveLength(1);
  });

  it('S3H-H7 : en production, seul « migrate » reçoit le propriétaire du schéma', () => {
    const api = merged('api');
    expect(api).not.toHaveProperty('DATABASE_MIGRATOR_URL');
    expect(api).not.toHaveProperty('DATABASE_WORKER_URL');
    expect(merged('migrate').DATABASE_MIGRATOR_URL).toContain('ecsi_migrator:');
    expect(merged('migrate').DATABASE_MIGRATOR_URL).not.toContain('devonly');
  });
});
