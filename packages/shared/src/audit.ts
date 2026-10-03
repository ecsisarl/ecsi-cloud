import { z } from 'zod';

/**
 * Journal d'audit persistant (Sprint 2). Chaque événement est inséré une seule fois,
 * jamais modifié ni supprimé, et chaîné par hachage SHA-256 (voir docs/SECURITY.md).
 */
export const AUDIT_RESULTS = ['SUCCESS', 'FAILURE', 'DENIED'] as const;
export type AuditResult = (typeof AUDIT_RESULTS)[number];

export const AUDIT_ACTOR_TYPES = ['USER', 'PLATFORM_ADMIN', 'SYSTEM', 'ANONYMOUS'] as const;
export type AuditActorType = (typeof AUDIT_ACTOR_TYPES)[number];

/** Clés jamais enregistrées dans les détails avant/après, à quelque profondeur que ce soit. */
export const AUDIT_FORBIDDEN_KEY =
  /(password|passwd|token|secret|cookie|totp|^otp|hash|private_?key|api_?key|encryption|recovery|credential)/i;

const isoDate = z.iso.datetime({ offset: true });

export const listAuditQuerySchema = z.strictObject({
  from: isoDate.optional(),
  to: isoDate.optional(),
  actorId: z.uuid().optional(),
  action: z
    .string()
    .trim()
    .max(80)
    .regex(/^[a-z0-9_.*]+$/)
    .optional(),
  resourceType: z
    .string()
    .trim()
    .max(40)
    .regex(/^[a-z_]+$/)
    .optional(),
  resourceId: z.uuid().optional(),
  siteId: z.uuid().optional(),
  result: z.enum(AUDIT_RESULTS).optional(),
  q: z.string().trim().max(100).optional(),
  /** Pagination par curseur (identifiant du dernier événement reçu). */
  cursor: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});
export type ListAuditQuery = z.infer<typeof listAuditQuerySchema>;

export const auditEventSchema = z.object({
  id: z.uuid(),
  occurredAt: z.string(),
  companyId: z.uuid().nullable(),
  companyName: z.string().nullable().optional(),
  actorType: z.enum(AUDIT_ACTOR_TYPES),
  actorId: z.uuid().nullable(),
  actorLabel: z.string().nullable(),
  actorRoles: z.array(z.string()),
  action: z.string(),
  resourceType: z.string(),
  resourceId: z.string().nullable(),
  siteId: z.uuid().nullable(),
  result: z.enum(AUDIT_RESULTS),
  ip: z.string().nullable(),
  userAgent: z.string().nullable(),
  requestId: z.string().nullable(),
  details: z.record(z.string(), z.unknown()),
  chainSeq: z.number(),
});
export type AuditEvent = z.infer<typeof auditEventSchema>;

export const auditPageSchema = z.object({
  data: z.array(auditEventSchema),
  nextCursor: z.uuid().nullable(),
});
export type AuditPage = z.infer<typeof auditPageSchema>;
