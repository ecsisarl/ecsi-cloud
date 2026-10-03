import { z } from 'zod';
import { roleAssignmentSchema, totpCodeSchema } from './auth.js';

/** Gestion des membres d'une entreprise (Sprint 2). */
export const MEMBER_STATUSES = ['ACTIVE', 'DISABLED'] as const;

export const listMembersQuerySchema = z.strictObject({
  q: z.string().trim().max(100).optional(),
  status: z.enum(MEMBER_STATUSES).optional(),
  roleId: z.uuid().optional(),
  siteId: z.uuid().optional(),
});
export type ListMembersQuery = z.infer<typeof listMembersQuerySchema>;

/** Remplace l'ensemble des rôles d'un membre (au moins un). */
export const replaceMemberRolesRequestSchema = z.strictObject({
  roles: z.array(roleAssignmentSchema).min(1).max(10),
});
export type ReplaceMemberRolesRequest = z.infer<typeof replaceMemberRolesRequestSchema>;

/**
 * Récupération administrative de la 2FA : l'administrateur confirme avec SON propre code
 * TOTP et indique un motif (journal d'audit). L'ancien secret n'est jamais révélé : il est
 * supprimé, l'utilisateur en configure un nouveau à sa prochaine connexion.
 */
export const resetMemberMfaRequestSchema = z.strictObject({
  code: totpCodeSchema,
  reason: z.string().trim().min(10).max(500),
});
export type ResetMemberMfaRequest = z.infer<typeof resetMemberMfaRequestSchema>;

export const memberRoleSchema = z.object({
  id: z.uuid(),
  code: z.string(),
  name: z.string(),
  scope: z.enum(['COMPANY', 'SITES']),
  sites: z.array(z.object({ id: z.uuid(), name: z.string(), code: z.string() })),
});
export type MemberRole = z.infer<typeof memberRoleSchema>;

export const memberSchema = z.object({
  id: z.uuid(),
  email: z.string(),
  fullName: z.string(),
  status: z.enum(MEMBER_STATUSES),
  roles: z.array(memberRoleSchema),
  mfaEnabled: z.boolean(),
  lastLoginAt: z.string().nullable(),
  joinedAt: z.string(),
  /** Le membre appartient aussi à d'autres entreprises (la récupération 2FA revient alors à ECSI). */
  otherCompanies: z.boolean(),
});
export type Member = z.infer<typeof memberSchema>;
