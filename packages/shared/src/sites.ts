import { z } from 'zod';
import { countrySchema, phoneSchema, timezoneSchema } from './company.js';

/**
 * Sites WiFi : emplacements d'exploitation d'une entreprise (ex. « Abidjan Cocody »).
 * Les routeurs, hotspots, vendeurs, forfaits, tickets, ventes et la supervision s'y
 * rattacheront aux sprints suivants par la clé composite (company_id, site_id).
 */
export const SITE_STATUSES = ['ACTIVE', 'MAINTENANCE', 'INACTIVE'] as const;
export type SiteStatus = (typeof SITE_STATUSES)[number];

/** Code interne court, unique dans l'entreprise : « ABJ-COCODY », « KHG-01 ». */
export const siteCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9](?:[A-Z0-9_-]{0,30}[A-Z0-9])?$/, {
    message: 'Lettres, chiffres, tirets et soulignés (32 caractères au plus)',
  });

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((value) => (value === '' ? null : value))
    .nullable()
    .optional();

const coordinate = (limit: number) => z.number().min(-limit).max(limit).nullable().optional();

/** Métadonnées libres : paires clé/valeur textuelles courtes (pas d'objet imbriqué). */
export const siteMetadataSchema = z
  .record(
    z
      .string()
      .regex(/^[a-zA-Z][a-zA-Z0-9_]{0,39}$/)
      .refine((key) => !/(password|secret|token|key)/i.test(key), {
        message: 'Aucun secret dans les métadonnées',
      }),
    z.string().max(200),
  )
  .refine((value) => Object.keys(value).length <= 20, { message: '20 entrées au plus' });

const siteFields = {
  name: z.string().trim().min(2).max(120),
  code: siteCodeSchema,
  description: optionalText(1000),
  address: optionalText(300),
  city: optionalText(120),
  country: countrySchema,
  latitude: coordinate(90),
  longitude: coordinate(180),
  timezone: timezoneSchema,
  phone: z
    .union([z.literal(''), phoneSchema])
    .transform((value) => (value === '' ? null : value))
    .nullable()
    .optional(),
  contactName: optionalText(120),
  status: z.enum(SITE_STATUSES).default('ACTIVE'),
  metadata: siteMetadataSchema.default({}),
};

const coordinatesTogether = (value: { latitude?: number | null; longitude?: number | null }) =>
  (value.latitude == null) === (value.longitude == null);
const coordinatesMessage = {
  message: 'Latitude et longitude vont ensemble',
  path: ['longitude'],
};

export const createSiteRequestSchema = z
  .strictObject(siteFields)
  .refine(coordinatesTogether, coordinatesMessage);
export type CreateSiteRequest = z.infer<typeof createSiteRequestSchema>;

/**
 * Modification partielle : SANS valeurs par défaut (avec Zod 4, un `.default()` resterait
 * appliqué sous `.partial()` et remettrait silencieusement le statut et les métadonnées).
 */
export const updateSiteRequestSchema = z
  .strictObject({
    ...siteFields,
    status: z.enum(SITE_STATUSES),
    metadata: siteMetadataSchema,
  })
  .partial()
  .refine(coordinatesTogether, coordinatesMessage);
export type UpdateSiteRequest = z.infer<typeof updateSiteRequestSchema>;

export const siteSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  code: z.string(),
  description: z.string().nullable(),
  address: z.string().nullable(),
  city: z.string().nullable(),
  country: z.string(),
  latitude: z.number().nullable(),
  longitude: z.number().nullable(),
  timezone: z.string(),
  phone: z.string().nullable(),
  contactName: z.string().nullable(),
  status: z.enum(SITE_STATUSES),
  metadata: z.record(z.string(), z.string()),
  groups: z.array(z.object({ id: z.uuid(), name: z.string() })),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Site = z.infer<typeof siteSchema>;

export const listSitesQuerySchema = z.strictObject({
  q: z.string().trim().max(100).optional(),
  status: z.enum(SITE_STATUSES).optional(),
  groupId: z.uuid().optional(),
});
export type ListSitesQuery = z.infer<typeof listSitesQuerySchema>;

/**
 * Groupes de sites (ECSI Roaming) : un site peut appartenir à plusieurs groupes. Les tickets
 * de portée GROUPE (Sprint 11) seront valables sur tous les sites d'un groupe.
 */
export const createSiteGroupRequestSchema = z.strictObject({
  name: z.string().trim().min(2).max(120),
  code: siteCodeSchema,
  description: optionalText(500),
  siteIds: z.array(z.uuid()).max(500).default([]),
});
export type CreateSiteGroupRequest = z.infer<typeof createSiteGroupRequestSchema>;

export const updateSiteGroupRequestSchema = z.strictObject({
  name: z.string().trim().min(2).max(120).optional(),
  code: siteCodeSchema.optional(),
  description: optionalText(500),
});
export type UpdateSiteGroupRequest = z.infer<typeof updateSiteGroupRequestSchema>;

export const siteGroupMembersRequestSchema = z.strictObject({
  siteIds: z.array(z.uuid()).min(1).max(500),
});

export const siteGroupSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  code: z.string(),
  description: z.string().nullable(),
  sites: z.array(z.object({ id: z.uuid(), name: z.string(), code: z.string() })),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type SiteGroup = z.infer<typeof siteGroupSchema>;
