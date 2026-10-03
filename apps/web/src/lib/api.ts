import 'server-only';
import { API_PREFIX, type HealthResponse, healthResponseSchema } from '@ecsi/shared';

/**
 * URL de l'API vue depuis le serveur Next.js (réseau Docker interne en développement).
 * Le navigateur, lui, passe par Nginx (/api/v1).
 */
function apiBaseUrl(): string {
  return process.env.API_INTERNAL_URL ?? 'http://localhost:4000';
}

export async function fetchHealth(): Promise<HealthResponse | null> {
  try {
    const response = await fetch(`${apiBaseUrl()}/${API_PREFIX}/health`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(3_000),
    });
    // 503 renvoie aussi un corps de santé valide (service indisponible).
    return healthResponseSchema.parse(await response.json());
  } catch {
    return null;
  }
}
