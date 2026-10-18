import { z } from 'zod';
import { DEV_ONLY_MARKER, envSchema, InvalidEnvironmentError } from './env.js';
import { refineRouterNetwork, routerNetworkShape } from './router-network.js';

/**
 * Configuration du worker de supervision (`pnpm start:worker`). Volontairement réduite : le
 * worker ne reçoit NI les connexions ecsi_app / ecsi_auth, NI le secret JWT, NI Redis/S3 ;
 * seulement sa connexion ecsi_worker et les clés du SecretBox (déchiffrement des mots de
 * passe RouterOS).
 */
export const workerEnvSchema = envSchema
  .pick({
    NODE_ENV: true,
    APP_VERSION: true,
    LOG_LEVEL: true,
    LOG_PRETTY: true,
    ENCRYPTION_KEY: true,
    ENCRYPTION_KEY_ID: true,
    ENCRYPTION_PREVIOUS_KEYS: true,
  })
  .extend({
    /** Rôle ecsi_worker : routers (0005), router_metrics et alerts (0007) uniquement. */
    DATABASE_WORKER_URL: z.url({ protocol: /^postgres(ql)?$/ }),
    ...routerNetworkShape,
    ROUTER_POLL_INTERVAL_SECONDS: z.coerce.number().int().min(10).max(3600).default(60),
    ROUTER_POLL_CONCURRENCY: z.coerce.number().int().min(1).max(100).default(10),
    ROUTER_POLL_BATCH_SIZE: z.coerce.number().int().min(1).max(1000).default(100),
    ROUTER_OFFLINE_AFTER_SECONDS: z.coerce.number().int().min(30).max(86_400).default(180),
    ROUTER_OFFLINE_MIN_FAILURES: z.coerce.number().int().min(1).max(100).default(3),
    // Historique et alertes de supervision (lot E1, migration 0007).
    MONITORING_METRICS_RETENTION_DAYS: z.coerce.number().int().min(1).max(90).default(7),
    MONITORING_ALERTS_RETENTION_DAYS: z.coerce.number().int().min(7).max(730).default(90),
    MONITORING_CPU_HIGH_PERCENT: z.coerce.number().int().min(50).max(100).default(90),
    MONITORING_MEMORY_HIGH_PERCENT: z.coerce.number().int().min(50).max(100).default(90),
    MONITORING_SUSTAIN_SAMPLES: z.coerce.number().int().min(1).max(30).default(3),
    MONITORING_DEGRADED_MIN_FAILURES: z.coerce.number().int().min(1).max(100).default(3),
  })
  .superRefine(refineRouterNetwork);

export type WorkerEnv = z.infer<typeof workerEnvSchema>;

export function parseWorkerEnv(source: Record<string, string | undefined>): WorkerEnv {
  const result = workerEnvSchema.safeParse(source);
  if (!result.success) {
    throw new InvalidEnvironmentError(
      result.error.issues.map((issue) => `${issue.path.join('.')} : ${issue.message}`),
    );
  }
  const env = result.data;
  if (env.NODE_ENV === 'production') {
    const issues: string[] = [];
    for (const key of ['DATABASE_WORKER_URL', 'ENCRYPTION_KEY', 'ENCRYPTION_PREVIOUS_KEYS']) {
      if (source[key]?.toLowerCase().includes(DEV_ONLY_MARKER)) {
        issues.push(`${key} : valeur de développement interdite en production`);
      }
    }
    if (env.LOG_PRETTY)
      issues.push('LOG_PRETTY : interdit en production (journaux JSON obligatoires)');
    if (issues.length > 0) throw new InvalidEnvironmentError(issues);
  }
  return env;
}
