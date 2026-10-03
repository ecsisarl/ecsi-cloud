import { z } from 'zod';
import { DEFAULT_CURRENCY, isSupportedCurrency } from './money.js';
import { DEFAULT_LOCALE, SUPPORTED_LOCALES } from './i18n.js';

/**
 * Profil et paramètres d'une entreprise (Sprint 2). Valeurs ECSI CLOUD par défaut :
 * français, franc CFA (XOF), Côte d'Ivoire, fuseau Africa/Abidjan (configurable).
 */
export const DEFAULT_COUNTRY = 'CI';
export const DEFAULT_TIMEZONE = 'Africa/Abidjan';

/** Pays proposés dans l'interface (ISO 3166-1 alpha-2). Liste extensible sans migration. */
export const COUNTRIES = {
  CI: "Côte d'Ivoire",
  SN: 'Sénégal',
  ML: 'Mali',
  BF: 'Burkina Faso',
  NE: 'Niger',
  TG: 'Togo',
  BJ: 'Bénin',
  GW: 'Guinée-Bissau',
  GN: 'Guinée',
  GH: 'Ghana',
  LR: 'Liberia',
  SL: 'Sierra Leone',
  NG: 'Nigeria',
  MR: 'Mauritanie',
  CM: 'Cameroun',
  GA: 'Gabon',
  CG: 'Congo',
  CD: 'RD Congo',
  TD: 'Tchad',
  CF: 'Centrafrique',
  MA: 'Maroc',
  FR: 'France',
  BE: 'Belgique',
  CA: 'Canada',
  US: 'États-Unis',
} as const satisfies Record<string, string>;
export type CountryCode = keyof typeof COUNTRIES;
export const COUNTRY_CODES = Object.keys(COUNTRIES) as CountryCode[];

/** Devises proposées (doivent être prises en charge par money.ts). */
export const COMPANY_CURRENCIES = ['XOF', 'XAF', 'GNF', 'GHS', 'NGN', 'EUR', 'USD'] as const;

let timezones: Set<string> | undefined;
/** Fuseau IANA reconnu par le moteur JavaScript (Node.js 22 et navigateurs récents). */
export function isValidTimezone(value: string): boolean {
  if (value === 'UTC') return true;
  timezones ??= new Set(Intl.supportedValuesOf('timeZone'));
  return timezones.has(value);
}

export const countrySchema = z.enum(COUNTRY_CODES as [CountryCode, ...CountryCode[]]);
export const timezoneSchema = z
  .string()
  .max(64)
  .refine(isValidTimezone, { message: 'Fuseau horaire inconnu' });
export const currencySchema = z
  .enum(COMPANY_CURRENCIES)
  .refine(isSupportedCurrency, { message: 'Devise non prise en charge' });

/** Téléphone au format international E.164 (+225…), espaces tolérés à la saisie. */
export const phoneSchema = z
  .string()
  .trim()
  .transform((value) => value.replace(/[\s.-]/g, ''))
  .pipe(z.string().regex(/^\+[1-9]\d{6,14}$/, { message: 'Format international attendu (+225…)' }));

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((value) => (value === '' ? null : value))
    .nullable();

const optionalPhone = z
  .union([z.literal(''), phoneSchema])
  .transform((value) => (value === '' ? null : value))
  .nullable();

/** Paramètres généraux (JSON validé) : uniquement des préférences d'affichage pour l'instant. */
export const companySettingsSchema = z.strictObject({
  dateFormat: z.enum(['DD/MM/YYYY', 'YYYY-MM-DD']).default('DD/MM/YYYY'),
  weekStartsOn: z.enum(['MONDAY', 'SUNDAY']).default('MONDAY'),
  /** Message affiché aux équipes (support, horaires) ; texte brut. */
  supportMessage: z.string().trim().max(500).default(''),
});
export type CompanySettings = z.infer<typeof companySettingsSchema>;
export const DEFAULT_COMPANY_SETTINGS: CompanySettings = companySettingsSchema.parse({});

export const COMPANY_STATUSES = ['ACTIVE', 'SUSPENDED'] as const;
export type CompanyStatus = (typeof COMPANY_STATUSES)[number];

export const companyProfileSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  slug: z.string(),
  legalName: z.string().nullable(),
  phone: z.string().nullable(),
  whatsapp: z.string().nullable(),
  email: z.string().nullable(),
  address: z.string().nullable(),
  city: z.string().nullable(),
  country: z.string(),
  currency: z.string(),
  locale: z.string(),
  timezone: z.string(),
  status: z.enum(COMPANY_STATUSES),
  hasLogo: z.boolean(),
  settings: companySettingsSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type CompanyProfile = z.infer<typeof companyProfileSchema>;

/** Modification du profil par l'entreprise (le statut est réservé au super administrateur). */
export const updateCompanyProfileRequestSchema = z.strictObject({
  name: z.string().trim().min(2).max(120),
  legalName: optionalText(200),
  phone: optionalPhone,
  whatsapp: optionalPhone,
  email: z
    .union([z.literal(''), z.string().trim().toLowerCase().pipe(z.email().max(254))])
    .transform((value) => (value === '' ? null : value))
    .nullable(),
  address: optionalText(300),
  city: optionalText(120),
  country: countrySchema,
  currency: currencySchema,
  locale: z.enum(SUPPORTED_LOCALES),
  timezone: timezoneSchema,
});
export type UpdateCompanyProfileRequest = z.infer<typeof updateCompanyProfileRequestSchema>;

export const updateCompanySettingsRequestSchema = companySettingsSchema;

/** Logos acceptés : PNG, JPEG, WebP (jamais SVG, qui peut contenir du script). */
export const LOGO_MAX_BYTES = 512 * 1024;
export const LOGO_CONTENT_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;
export const uploadLogoRequestSchema = z.strictObject({
  contentType: z.enum(LOGO_CONTENT_TYPES),
  /** Contenu du fichier en base64 (corps JSON : seul type de contenu accepté par l'API). */
  data: z
    .string()
    .max(Math.ceil((LOGO_MAX_BYTES * 4) / 3) + 4)
    .regex(/^[A-Za-z0-9+/]+={0,2}$/),
});
export type UploadLogoRequest = z.infer<typeof uploadLogoRequestSchema>;

export const COMPANY_DEFAULTS = {
  country: DEFAULT_COUNTRY,
  currency: DEFAULT_CURRENCY,
  locale: DEFAULT_LOCALE,
  timezone: DEFAULT_TIMEZONE,
} as const;

/** Création d'une entreprise par un super administrateur ECSI. */
export const createCompanyRequestSchema = z.strictObject({
  name: z.string().trim().min(2).max(120),
  legalName: optionalText(200).optional(),
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9](?:[a-z0-9-]{0,48}[a-z0-9])?$/, {
      message: 'Lettres minuscules, chiffres et tirets uniquement',
    })
    .optional(),
  country: countrySchema.default(DEFAULT_COUNTRY),
  currency: currencySchema.default(DEFAULT_CURRENCY),
  locale: z.enum(SUPPORTED_LOCALES).default(DEFAULT_LOCALE),
  timezone: timezoneSchema.default(DEFAULT_TIMEZONE),
  /** Premier administrateur : reçoit une invitation ADMIN_ENTREPRISE. */
  adminEmail: z.string().trim().toLowerCase().pipe(z.email().max(254)),
});
export type CreateCompanyRequest = z.infer<typeof createCompanyRequestSchema>;

export const setCompanyStatusRequestSchema = z.strictObject({
  status: z.enum(COMPANY_STATUSES),
  reason: z.string().trim().min(5).max(500),
});
export type SetCompanyStatusRequest = z.infer<typeof setCompanyStatusRequestSchema>;

/** Identifiant lisible dérivé d'un nom : « Wifi Zone Cocody » -> « wifi-zone-cocody ». */
export function slugify(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50)
    .replace(/-+$/g, '');
}
