import { z } from 'zod';

/**
 * Marqueur présent dans toutes les valeurs par défaut de développement
 * (docker-compose.yml, .env.example). En production, toute variable qui le contient
 * est refusée : l'API ne démarre pas avec un secret de démonstration.
 */
export const DEV_ONLY_MARKER = 'devonly';

const booleanFromString = z
  .enum(['true', 'false', '1', '0'])
  .transform((value) => value === 'true' || value === '1');

const csv = z.string().transform((value) =>
  value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0),
);

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  APP_VERSION: z.string().default('0.1.0'),
  API_HOST: z.string().default('0.0.0.0'),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  /** Journaux lisibles (pino-pretty) pour `pnpm dev`. JSON structuré sinon (Docker, production). */
  LOG_PRETTY: booleanFromString.default(false),
  /** Nombre de proxys de confiance devant l'API (Nginx = 1) pour déterminer l'IP client. */
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(1),
  /** Origines autorisées pour CORS (dashboard, portail), séparées par des virgules. */
  CORS_ORIGINS: csv.default([]),
  /** Active la documentation OpenAPI sur /api/docs (désactivée par défaut en production). */
  API_DOCS_ENABLED: booleanFromString.optional(),
  /** Connexion de l'application : rôle sans privilège, soumis à la RLS. */
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  /** Connexion des migrations : rôle propriétaire du schéma. */
  DATABASE_MIGRATOR_URL: z.url({ protocol: /^postgres(ql)?$/ }).optional(),
  /** Connexion du module d'authentification : rôle ecsi_auth (identifiants, sessions, jetons). */
  DATABASE_AUTH_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
  REDIS_URL: z.url({ protocol: /^rediss?$/ }),
  S3_ENDPOINT: z.url().optional(),
  S3_REGION: z.string().default('us-east-1'),
  S3_BUCKET: z.string().min(3),
  S3_ACCESS_KEY_ID: z.string().min(1),
  S3_SECRET_ACCESS_KEY: z.string().min(8),
  S3_FORCE_PATH_STYLE: booleanFromString.default(true),
  /** Crée le bucket au démarrage s'il n'existe pas (développement uniquement). */
  S3_AUTO_CREATE_BUCKET: booleanFromString.default(false),
  /** Secret de signature des jetons d'accès (HS256), 32 caractères minimum. */
  JWT_ACCESS_SECRET: z.string().min(32),
  /**
   * Clé maîtresse ACTIVE du chiffrement enveloppe des secrets stockés (TOTP) : 32 octets en
   * base64. Rotation : voir docs/SECURITY.md (ENCRYPTION_KEY_ID, ENCRYPTION_PREVIOUS_KEYS).
   */
  ENCRYPTION_KEY: z.string().refine((value) => Buffer.from(value, 'base64').length === 32, {
    message: 'doit contenir 32 octets encodés en base64 (openssl rand -base64 32)',
  }),
  /**
   * Connexions autorisées par adresse IP et par 15 minutes (anti force brute). 20 par défaut ;
   * relevé uniquement pour les tests de bout en bout, qui se connectent tous depuis la même IP.
   */
  RATE_LIMIT_LOGIN_PER_IP: z.coerce.number().int().min(5).max(1000).default(20),
  /** Identifiant de version de la clé active, inscrit dans chaque chiffré. */
  ENCRYPTION_KEY_ID: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{0,15}$/, { message: 'minuscules, chiffres, tirets (16 max.)' })
    .default('k1'),
  /** Anciennes clés, encore nécessaires en lecture pendant une rotation : « id:base64,… ». */
  ENCRYPTION_PREVIOUS_KEYS: z
    .string()
    .optional()
    .refine(
      (value) =>
        !value?.trim() ||
        value.split(',').every((entry) => {
          const index = entry.indexOf(':');
          return (
            index > 0 &&
            /^[a-z0-9][a-z0-9-]{0,15}$/.test(entry.slice(0, index).trim()) &&
            Buffer.from(entry.slice(index + 1).trim(), 'base64').length === 32
          );
        }),
      { message: 'format « id:base64,… » attendu, chaque clé de 32 octets' },
    ),
  /** Cookies « Secure » (HTTPS). Obligatoire en production. */
  COOKIE_SECURE: booleanFromString.optional(),
  /** URL publique du dashboard, utilisée dans les liens envoyés par e-mail. */
  WEB_PUBLIC_URL: z.url().default('http://localhost:8080'),
  SMTP_HOST: z.string().min(1).default('localhost'),
  SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(1025),
  SMTP_SECURE: booleanFromString.default(false),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  SMTP_FROM: z.string().min(3).default('ECSI CLOUD <no-reply@ecsi.local>'),
});

export type Env = z.infer<typeof envSchema>;

export class InvalidEnvironmentError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Configuration invalide :\n- ${issues.join('\n- ')}`);
    this.name = 'InvalidEnvironmentError';
  }
}

/** Valide les variables d'environnement. Les valeurs des secrets ne sont jamais incluses dans les erreurs. */
export function parseEnv(source: Record<string, string | undefined>): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    throw new InvalidEnvironmentError(
      result.error.issues.map((issue) => `${issue.path.join('.')} : ${issue.message}`),
    );
  }
  const env = result.data;

  if (env.NODE_ENV === 'production') {
    const issues: string[] = [];
    for (const key of Object.keys(envSchema.shape)) {
      if (source[key]?.toLowerCase().includes(DEV_ONLY_MARKER)) {
        issues.push(`${key} : valeur de développement interdite en production`);
      }
    }
    if (env.LOG_PRETTY) {
      issues.push('LOG_PRETTY : interdit en production (journaux JSON obligatoires)');
    }
    if (env.S3_AUTO_CREATE_BUCKET) {
      issues.push('S3_AUTO_CREATE_BUCKET : interdit en production');
    }
    if (env.COOKIE_SECURE === false) {
      issues.push('COOKIE_SECURE : les cookies doivent être « Secure » en production');
    }
    if (!env.WEB_PUBLIC_URL.startsWith('https://')) {
      issues.push('WEB_PUBLIC_URL : HTTPS obligatoire en production');
    }
    if (env.CORS_ORIGINS.some((origin) => origin === '*')) {
      issues.push('CORS_ORIGINS : le joker « * » est interdit en production');
    }
    if (issues.length > 0) {
      throw new InvalidEnvironmentError(issues);
    }
  }

  return env;
}

export function isCookieSecure(env: Env): boolean {
  return env.COOKIE_SECURE ?? env.NODE_ENV === 'production';
}

export function isApiDocsEnabled(env: Env): boolean {
  return env.API_DOCS_ENABLED ?? env.NODE_ENV !== 'production';
}
