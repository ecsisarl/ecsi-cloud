import { z } from 'zod';
import { DEV_ONLY_MARKER, envSchema, InvalidEnvironmentError } from './env.js';
import { refineRouterNetwork, routerNetworkShape } from './router-network.js';

/**
 * Agent passerelle WireGuard (`pnpm start:gateway`, Sprint 3B), exécuté SUR L'HÔTE de la
 * passerelle (il pilote l'interface WireGuard avec wg(8), il lui faut CAP_NET_ADMIN). Même
 * périmètre que le worker : connexion ecsi_worker (fonctions dédiées de la migration 0006) et
 * clés du SecretBox (chiffrement du mot de passe reçu à l'activation). La clé PRIVÉE de la
 * passerelle reste dans la configuration WireGuard de l'hôte : l'agent ne la lit jamais.
 */
export const gatewayEnvSchema = envSchema
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
    DATABASE_WORKER_URL: z.url({ protocol: /^postgres(ql)?$/ }),
    ...routerNetworkShape,
    /** Interface WireGuard de la passerelle (adresse ROUTER_TUNNEL_GATEWAY). */
    WG_INTERFACE: z
      .string()
      .regex(/^[A-Za-z0-9_.-]{1,15}$/, { message: 'nom d’interface invalide' })
      .default('wg0'),
    /** Binaire wg(8) : « wg » (PATH) ou chemin absolu. */
    WG_COMMAND: z
      .string()
      .regex(/^(wg|\/[A-Za-z0-9_./-]+)$/, { message: '« wg » ou chemin absolu attendu' })
      .default('wg'),
    GATEWAY_SYNC_INTERVAL_SECONDS: z.coerce.number().int().min(2).max(300).default(5),
    /** Port HTTP d'activation, écouté sur ROUTER_TUNNEL_GATEWAY uniquement. */
    ROUTER_ACTIVATION_PORT: z.coerce.number().int().min(1).max(65535).default(8081),
  })
  .superRefine(refineRouterNetwork);

export type GatewayEnv = z.infer<typeof gatewayEnvSchema>;

export function parseGatewayEnv(source: Record<string, string | undefined>): GatewayEnv {
  const result = gatewayEnvSchema.safeParse(source);
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
