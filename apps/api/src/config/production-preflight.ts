import { InvalidEnvironmentError, parseEnv } from './env.js';

/**
 * Contrôle AVANT déploiement (S3H-H7) : la configuration d'une API en service passerait-elle
 * les garde-fous de production de cette version ? Seuls des noms de variables et des
 * messages génériques sont produits, jamais une valeur.
 */
export interface PreflightReport {
  /** NODE_ENV de la configuration contrôlée (telle qu'elle tourne aujourd'hui). */
  readonly currentNodeEnv: string;
  /** Refus de démarrage de cette version en production (à corriger avant le déploiement). */
  readonly blocking: readonly string[];
  /** Écarts non bloquants (corrigés par la surcouche Compose de cette version, ou conseils). */
  readonly warnings: readonly string[];
}

/** Variables que l'API ne doit plus recevoir (séparation des rôles, S3H-H7). */
const RUNTIME_FORBIDDEN = ['DATABASE_MIGRATOR_URL', 'DATABASE_WORKER_URL'] as const;

/** Lit la sortie de `env` / `printenv` (une variable par ligne, « NOM=valeur »). */
export function parseEnvLines(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const index = line.indexOf('=');
    if (index > 0 && /^[A-Za-z_][A-Za-z0-9_]*$/.test(line.slice(0, index))) {
      result[line.slice(0, index)] = line.slice(index + 1);
    }
  }
  return result;
}

export function productionPreflight(source: Record<string, string | undefined>): PreflightReport {
  const blocking: string[] = [];
  const warnings: string[] = [];
  try {
    parseEnv({ ...source, NODE_ENV: 'production' });
  } catch (error) {
    if (error instanceof InvalidEnvironmentError) blocking.push(...error.issues);
    else throw error;
  }
  for (const key of RUNTIME_FORBIDDEN) {
    if (source[key]) {
      warnings.push(
        `${key} : présente dans l'API, retirée par le Compose H7 (rôle non nécessaire)`,
      );
    }
  }
  const loginPerIp = Number(source.RATE_LIMIT_LOGIN_PER_IP ?? 20);
  if (loginPerIp > 100) {
    warnings.push('RATE_LIMIT_LOGIN_PER_IP : valeur de test (> 100) ; 20 conseillé en production');
  }
  return { currentNodeEnv: source.NODE_ENV ?? '(absent : development)', blocking, warnings };
}
