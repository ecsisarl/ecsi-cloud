import { WIREGUARD_PUBLIC_KEY } from '@ecsi/shared';
import { z } from 'zod';

/** Nom d'hôte DNS ou IPv4 : seuls caractères admis dans le script RouterOS (anti-injection). */
const HOST =
  /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}[A-Za-z0-9])?)*$/;
/** URL HTTPS sans caractère interprétable par la console RouterOS (" $ \ ; espace…). */
const SCRIPT_SAFE_URL = /^https:\/\/[A-Za-z0-9.-]+(?::[0-9]{1,5})?(?:\/[A-Za-z0-9._~/-]*)?$/;

const port = (fallback: number) => z.coerce.number().int().min(1).max(65535).default(fallback);

/**
 * Enrôlement des routeurs (Sprint 3B). Toutes ces valeurs sont PUBLIQUES (elles figurent dans
 * le script collé dans le routeur) : clé publique et point d'accès de la passerelle WireGuard,
 * URL d'enrôlement. Aucune clé privée n'est jamais configurée côté API : la clé privée de la
 * passerelle reste sur son hôte (wg), celle du routeur sur le routeur.
 *
 * Sans WG_GATEWAY_PUBLIC_KEY / WG_GATEWAY_ENDPOINT, la création d'un enrôlement répond 503
 * (le reste de l'API fonctionne).
 */
export const routerEnrollmentShape = {
  /** URL publique de POST /routers/enroll (défaut : WEB_PUBLIC_URL + /api/v1/routers/enroll). */
  ROUTER_ENROLL_PUBLIC_URL: z
    .string()
    .regex(SCRIPT_SAFE_URL, { message: 'URL HTTPS simple attendue' })
    .optional(),
  WG_GATEWAY_PUBLIC_KEY: z
    .string()
    .regex(WIREGUARD_PUBLIC_KEY, { message: 'clé publique WireGuard attendue' })
    .optional(),
  /** Adresse PUBLIQUE de la passerelle (nom DNS ou IPv4) jointe par les routeurs en UDP. */
  WG_GATEWAY_ENDPOINT: z.string().regex(HOST, { message: 'nom d’hôte ou IPv4 attendu' }).optional(),
  WG_GATEWAY_PORT: port(51820),
  /** Port HTTP d'activation, écouté par l'agent passerelle sur son adresse tunnel uniquement. */
  ROUTER_ACTIVATION_PORT: port(8081),
  ROUTER_ENROLL_TOKEN_TTL_MINUTES: z.coerce.number().int().min(5).max(1440).default(30),
  /**
   * Laboratoire seulement : AC privée de l'API publique, téléchargée par le routeur puis
   * vérifiée par son empreinte SHA-256 (étape 2 du script). En production, l'API présente un
   * certificat d'AC publique et ces deux variables restent vides.
   */
  ROUTER_ENROLL_CA_URL: z
    .string()
    .regex(SCRIPT_SAFE_URL, { message: 'URL HTTPS simple attendue' })
    .optional(),
  ROUTER_ENROLL_CA_FINGERPRINT: z
    .string()
    .regex(/^[0-9a-f]{64}$/, { message: 'SHA-256 hexadécimal (minuscules) attendu' })
    .optional(),
};

export function refineRouterEnrollment(
  value: { ROUTER_ENROLL_CA_URL?: string; ROUTER_ENROLL_CA_FINGERPRINT?: string },
  ctx: z.RefinementCtx,
): void {
  if (!value.ROUTER_ENROLL_CA_URL !== !value.ROUTER_ENROLL_CA_FINGERPRINT) {
    ctx.addIssue({
      code: 'custom',
      path: ['ROUTER_ENROLL_CA_URL'],
      message: 'ROUTER_ENROLL_CA_URL et ROUTER_ENROLL_CA_FINGERPRINT vont ensemble',
    });
  }
}
