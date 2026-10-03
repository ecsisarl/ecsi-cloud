import { z } from 'zod';
import { COMPANY_STATUSES, companyProfileSchema } from './company.js';

/** Console des super administrateurs ECSI (domaine plateforme, Sprint 2). */
export const listPlatformCompaniesQuerySchema = z.strictObject({
  q: z.string().trim().max(100).optional(),
  status: z.enum(COMPANY_STATUSES).optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});
export type ListPlatformCompaniesQuery = z.infer<typeof listPlatformCompaniesQuerySchema>;

export const platformCompanySummarySchema = z.object({
  id: z.uuid(),
  name: z.string(),
  slug: z.string(),
  country: z.string(),
  currency: z.string(),
  status: z.enum(COMPANY_STATUSES),
  memberCount: z.number().int(),
  siteCount: z.number().int(),
  createdAt: z.string(),
});
export type PlatformCompanySummary = z.infer<typeof platformCompanySummarySchema>;

export const platformCompanyPageSchema = z.object({
  data: z.array(platformCompanySummarySchema),
  total: z.number().int(),
  page: z.number().int(),
  limit: z.number().int(),
});
export type PlatformCompanyPage = z.infer<typeof platformCompanyPageSchema>;

export const platformCompanyDetailSchema = companyProfileSchema.extend({
  memberCount: z.number().int(),
  siteCount: z.number().int(),
  pendingInvitations: z.number().int(),
  suspendedAt: z.string().nullable(),
  suspensionReason: z.string().nullable(),
  admins: z.array(z.object({ id: z.uuid(), fullName: z.string(), email: z.string() })),
});
export type PlatformCompanyDetail = z.infer<typeof platformCompanyDetailSchema>;

export const searchPlatformUsersQuerySchema = z.strictObject({
  q: z.string().trim().min(3).max(100),
});
export type SearchPlatformUsersQuery = z.infer<typeof searchPlatformUsersQuerySchema>;

export const platformUserSchema = z.object({
  id: z.uuid(),
  email: z.string(),
  fullName: z.string(),
  status: z.string(),
  mfaEnabled: z.boolean(),
  companies: z.array(z.object({ id: z.uuid(), name: z.string() })),
});
export type PlatformUser = z.infer<typeof platformUserSchema>;
