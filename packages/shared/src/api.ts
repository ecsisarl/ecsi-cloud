import { z } from 'zod';

/** Préfixe de toutes les routes de l'API publique (voir docs/API.md). */
export const API_PREFIX = 'api/v1';

/**
 * Format d'erreur unique de l'API, inspiré de la RFC 9457 (Problem Details).
 * Aucune information interne (pile d'appels, requête SQL) n'y figure.
 */
export const problemDetailsSchema = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number().int(),
  detail: z.string().optional(),
  instance: z.string().optional(),
  requestId: z.string().optional(),
  errors: z
    .array(
      z.object({
        path: z.string(),
        message: z.string(),
      }),
    )
    .optional(),
});
export type ProblemDetails = z.infer<typeof problemDetailsSchema>;

export const healthStatusSchema = z.enum(['ok', 'degraded', 'down']);
export type HealthStatus = z.infer<typeof healthStatusSchema>;

export const healthCheckSchema = z.object({
  status: healthStatusSchema,
  latencyMs: z.number().nonnegative().optional(),
  error: z.string().optional(),
});

export const healthResponseSchema = z.object({
  status: healthStatusSchema,
  service: z.string(),
  version: z.string(),
  uptimeSeconds: z.number().nonnegative(),
  checks: z.record(z.string(), healthCheckSchema),
});
export type HealthResponse = z.infer<typeof healthResponseSchema>;
