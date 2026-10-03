import 'server-only';
import {
  API_PREFIX,
  AUTH_COOKIES,
  type HealthResponse,
  healthResponseSchema,
  type MeResponse,
} from '@ecsi/shared';
import { cookies, headers } from 'next/headers';

/**
 * URL de l'API vue depuis le serveur Next.js (réseau Docker interne en développement).
 * Le navigateur, lui, passe par Nginx (/api/v1) ou par la réécriture /api de Next.js.
 */
export function apiBaseUrl(): string {
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

/** Dernière adresse ajoutée par le proxy de confiance (Nginx), transmise à l'API. */
export function clientIpFrom(forwardedFor: string | null): string | undefined {
  const last = forwardedFor?.split(',').pop()?.trim();
  return last && last.length > 0 ? last : undefined;
}

/**
 * Appel de l'API depuis un composant serveur, avec les cookies d'authentification du
 * navigateur (jamais exposés au JavaScript client : ils sont httpOnly).
 */
async function serverApi(path: string): Promise<Response> {
  const jar = await cookies();
  const incoming = await headers();
  const cookieHeader = [AUTH_COOKIES.access, AUTH_COOKIES.refresh]
    .map((name) => {
      const value = jar.get(name)?.value;
      return value ? `${name}=${value}` : null;
    })
    .filter(Boolean)
    .join('; ');
  const ip = clientIpFrom(incoming.get('x-forwarded-for'));
  return fetch(`${apiBaseUrl()}/${API_PREFIX}${path}`, {
    cache: 'no-store',
    signal: AbortSignal.timeout(5_000),
    headers: {
      ...(cookieHeader ? { cookie: cookieHeader } : {}),
      ...(ip ? { 'x-forwarded-for': ip } : {}),
    },
  });
}

export type SessionLookup<T> =
  | { readonly kind: 'ok'; readonly data: T }
  | { readonly kind: 'unauthenticated' }
  | { readonly kind: 'forbidden' };

async function lookup<T>(path: string): Promise<SessionLookup<T>> {
  const response = await serverApi(path);
  if (response.status === 401) return { kind: 'unauthenticated' };
  if (response.status === 403) return { kind: 'forbidden' };
  if (!response.ok) throw new Error(`API ${path} : HTTP ${String(response.status)}`);
  return { kind: 'ok', data: (await response.json()) as T };
}

export function getMe(): Promise<SessionLookup<MeResponse>> {
  return lookup<MeResponse>('/auth/me');
}

export interface PlatformMe {
  realm: 'platform';
  admin: { id: string; email: string; fullName: string };
  mfa: { state: 'NOT_REQUIRED' | 'VERIFIED' | 'SETUP_REQUIRED' };
}

export function getPlatformMe(): Promise<SessionLookup<PlatformMe>> {
  return lookup<PlatformMe>('/platform/auth/me');
}
