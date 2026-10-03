import { z } from 'zod';
import { ROLE_SCOPES } from './roles.js';

/**
 * Contrats de l'API d'authentification (/api/v1/auth/*), partagés par l'API et le dashboard.
 * Tous les schémas sont stricts : une clé inconnue (par exemple companyId) est refusée.
 */

/** Longueur minimale recommandée par l'ANSSI / NIST SP 800-63B ; borne haute anti-DoS Argon2. */
export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;

export const emailSchema = z.string().trim().toLowerCase().pipe(z.email().max(254));
export const passwordSchema = z.string().min(PASSWORD_MIN_LENGTH).max(PASSWORD_MAX_LENGTH);
/** Mot de passe saisi à la connexion : aucune règle de complexité révélée, borne anti-DoS. */
const loginPasswordSchema = z.string().min(1).max(PASSWORD_MAX_LENGTH);
export const totpCodeSchema = z.string().regex(/^\d{6}$/);
export const recoveryCodeSchema = z
  .string()
  .regex(/^[A-Za-z0-9]{5}-?[A-Za-z0-9]{5}$/)
  .transform((value) => value.replace('-', '').toUpperCase());
/** Jetons opaques (réinitialisation, invitation) : 32 octets en base64url. */
export const opaqueTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

export const loginRequestSchema = z.strictObject({
  email: emailSchema,
  password: loginPasswordSchema,
});
export type LoginRequest = z.infer<typeof loginRequestSchema>;

export const mfaVerifyRequestSchema = z.union([
  z.strictObject({ code: totpCodeSchema }),
  z.strictObject({ recoveryCode: recoveryCodeSchema }),
]);
export type MfaVerifyRequest = z.infer<typeof mfaVerifyRequestSchema>;

export const mfaConfirmRequestSchema = z.strictObject({ code: totpCodeSchema });

export const switchCompanyRequestSchema = z.strictObject({ companyId: z.uuid() });

export const forgotPasswordRequestSchema = z.strictObject({ email: emailSchema });

export const resetPasswordRequestSchema = z.strictObject({
  token: opaqueTokenSchema,
  password: passwordSchema,
});

export const acceptInvitationRequestSchema = z.strictObject({
  token: opaqueTokenSchema,
  /** Requis pour un nouveau compte, ignoré si l'adresse possède déjà un compte. */
  fullName: z.string().trim().min(2).max(120).optional(),
  password: z.string().min(1).max(PASSWORD_MAX_LENGTH),
});
export type AcceptInvitationRequest = z.infer<typeof acceptInvitationRequestSchema>;

export const MFA_STATES = ['NOT_REQUIRED', 'VERIFIED', 'SETUP_REQUIRED'] as const;
export type MfaState = (typeof MFA_STATES)[number];

export const loginResponseSchema = z.object({
  status: z.enum(['AUTHENTICATED', 'MFA_REQUIRED']),
  mfaState: z.enum(MFA_STATES).optional(),
});
export type LoginResponse = z.infer<typeof loginResponseSchema>;

export const companySummarySchema = z.object({
  id: z.uuid(),
  name: z.string(),
  slug: z.string(),
});
export type CompanySummary = z.infer<typeof companySummarySchema>;

export const meResponseSchema = z.object({
  realm: z.literal('user'),
  user: z.object({
    id: z.uuid(),
    email: z.string(),
    fullName: z.string(),
    locale: z.string(),
  }),
  company: companySummarySchema.nullable(),
  companies: z.array(companySummarySchema),
  roles: z.array(z.string()),
  /** Permissions détenues sur au moins un site ou sur toute l'entreprise. */
  permissions: z.array(z.string()),
  /** Permissions détenues pour toute l'entreprise (création de site, groupes…). */
  companyPermissions: z.array(z.string()),
  mfa: z.object({ enabled: z.boolean(), required: z.boolean(), state: z.enum(MFA_STATES) }),
});
export type MeResponse = z.infer<typeof meResponseSchema>;

export const sessionSummarySchema = z.object({
  id: z.uuid(),
  current: z.boolean(),
  ip: z.string().nullable(),
  userAgent: z.string().nullable(),
  createdAt: z.string(),
  lastUsedAt: z.string(),
});
export type SessionSummary = z.infer<typeof sessionSummarySchema>;

export const mfaSetupResponseSchema = z.object({
  secret: z.string(),
  otpauthUri: z.string(),
});
export type MfaSetupResponse = z.infer<typeof mfaSetupResponseSchema>;

export const recoveryCodesResponseSchema = z.object({ recoveryCodes: z.array(z.string()) });
export type RecoveryCodesResponse = z.infer<typeof recoveryCodesResponseSchema>;

export const invitationPreviewSchema = z.object({
  companyName: z.string(),
  email: z.string(),
  existingAccount: z.boolean(),
  expiresAt: z.string(),
});
export type InvitationPreview = z.infer<typeof invitationPreviewSchema>;

/** Attribution d'un rôle lors d'une invitation : portée entreprise ou liste de sites. */
export const roleAssignmentSchema = z
  .strictObject({
    roleId: z.uuid(),
    scope: z.enum(ROLE_SCOPES).default('COMPANY'),
    siteIds: z.array(z.uuid()).max(500).default([]),
  })
  .refine((value) => (value.scope === 'SITES') === value.siteIds.length > 0, {
    message: 'siteIds est requis pour la portée SITES et interdit pour la portée COMPANY',
    path: ['siteIds'],
  });
export type RoleAssignment = z.infer<typeof roleAssignmentSchema>;

export const createInvitationRequestSchema = z.strictObject({
  email: emailSchema,
  roles: z.array(roleAssignmentSchema).min(1).max(10),
});
export type CreateInvitationRequest = z.infer<typeof createInvitationRequestSchema>;

export const updateMemberStatusRequestSchema = z.strictObject({
  status: z.enum(['ACTIVE', 'DISABLED']),
});

/** Noms des cookies posés par l'API (même origine que le dashboard). */
export const AUTH_COOKIES = {
  access: 'ecsi_at',
  refresh: 'ecsi_rt',
  csrf: 'ecsi_csrf',
  mfaChallenge: 'ecsi_mfa',
} as const;
export const CSRF_HEADER = 'x-csrf-token';
