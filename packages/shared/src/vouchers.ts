import { z } from 'zod';
import { isSupportedCurrency } from './money.js';

/**
 * Forfaits et tickets (Sprint 6, épopée E9 du dossier v0.1).
 *
 * Reprend les fonctions « tickets » de Mikhmon (profils avec prix, durée et débit ;
 * génération en masse avec préfixe, longueur et type de caractères ; mode code unique ou
 * identifiant + mot de passe ; commentaire de lot ; impression avec QR) dans le modèle
 * d'ECSI CLOUD : les tickets sont stockés dans le cloud et appliqués par le RADIUS central
 * (Sprint 5), jamais recopiés comme utilisateurs Hotspot sur chaque routeur.
 */

// --- Forfaits -----------------------------------------------------------------

export const PLAN_STATUSES = ['ACTIVE', 'INACTIVE'] as const;
export type PlanStatus = (typeof PLAN_STATUSES)[number];

/** Portées d'un ticket. Seule LOCAL est utilisable au MVP technique (GROUPE/GLOBAL : S11). */
export const VOUCHER_SCOPES = ['LOCAL', 'GROUP', 'GLOBAL'] as const;
export type VoucherScope = (typeof VOUCHER_SCOPES)[number];

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((value) => (value === '' ? null : value))
    .nullable()
    .optional();

/** Entier positif facultatif : null = illimité. */
const optionalPositive = (max: number) => z.number().int().positive().max(max).nullable();

const ONE_YEAR = 366 * 24 * 3600;

const planFields = {
  name: z.string().trim().min(2).max(80),
  description: optionalText(500),
  /** Montant en unités mineures (XOF : 500 = 500 FCFA). */
  priceAmount: z.number().int().min(0).max(100_000_000),
  currency: z
    .string()
    .trim()
    .toUpperCase()
    .refine(isSupportedCurrency, { message: 'Devise non prise en charge' })
    .default('XOF'),
  /** Temps de connexion cumulé (Mikhmon : « limit-uptime »). null = illimité. */
  sessionTimeSeconds: optionalPositive(ONE_YEAR).default(null),
  /** Validité après la première connexion (Mikhmon : « validity »). null = illimitée. */
  validitySeconds: optionalPositive(ONE_YEAR).default(null),
  /** Débits en kbit/s (Mikhmon : « rate-limit » rx/tx). null = sans limite. */
  rateDownKbps: optionalPositive(10_000_000).default(null),
  rateUpKbps: optionalPositive(10_000_000).default(null),
  /** Quota de données en octets (Mikhmon : « limit-bytes-total »). null = illimité. */
  dataQuotaBytes: optionalPositive(Number.MAX_SAFE_INTEGER).default(null),
  /** Appareils simultanés (Mikhmon : « shared-users »). */
  maxDevices: z.number().int().min(1).max(20).default(1),
  /** Liaison à la première adresse MAC (Mikhmon : « lock user »). Au mieux, voir R11. */
  macBinding: z.boolean().default(false),
  sortOrder: z.number().int().min(0).max(10_000).default(0),
  /** Visible au portail captif pour l'achat en ligne (Sprint 12). */
  isPublic: z.boolean().default(false),
  status: z.enum(PLAN_STATUSES).default('ACTIVE'),
};

export const createPlanRequestSchema = z.strictObject(planFields);
export type CreatePlanRequest = z.infer<typeof createPlanRequestSchema>;

/** Modification partielle : sans valeurs par défaut (voir updateSiteRequestSchema). */
export const updatePlanRequestSchema = z
  .strictObject({
    ...planFields,
    currency: z
      .string()
      .trim()
      .toUpperCase()
      .refine(isSupportedCurrency, { message: 'Devise non prise en charge' }),
    sessionTimeSeconds: optionalPositive(ONE_YEAR),
    validitySeconds: optionalPositive(ONE_YEAR),
    rateDownKbps: optionalPositive(10_000_000),
    rateUpKbps: optionalPositive(10_000_000),
    dataQuotaBytes: optionalPositive(Number.MAX_SAFE_INTEGER),
    maxDevices: z.number().int().min(1).max(20),
    macBinding: z.boolean(),
    sortOrder: z.number().int().min(0).max(10_000),
    isPublic: z.boolean(),
    status: z.enum(PLAN_STATUSES),
  })
  .partial();
export type UpdatePlanRequest = z.infer<typeof updatePlanRequestSchema>;

export const planSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  description: z.string().nullable(),
  priceAmount: z.number().int(),
  currency: z.string(),
  sessionTimeSeconds: z.number().int().nullable(),
  validitySeconds: z.number().int().nullable(),
  rateDownKbps: z.number().int().nullable(),
  rateUpKbps: z.number().int().nullable(),
  dataQuotaBytes: z.number().int().nullable(),
  maxDevices: z.number().int(),
  macBinding: z.boolean(),
  defaultScope: z.enum(VOUCHER_SCOPES),
  sortOrder: z.number().int(),
  isPublic: z.boolean(),
  status: z.enum(PLAN_STATUSES),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Plan = z.infer<typeof planSchema>;

// --- Codes des tickets ----------------------------------------------------------

/**
 * Jeux de caractères (Mikhmon : « character »). Les caractères ambigus à l'impression et
 * à la saisie sur téléphone (0/O, 1/I/l) sont retirés de tous les jeux.
 */
export const VOUCHER_CHARSETS = ['DIGITS', 'UPPER', 'LOWER', 'UPPER_DIGITS', 'MIXED'] as const;
export type VoucherCharset = (typeof VOUCHER_CHARSETS)[number];

const DIGITS = '23456789';
const UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const LOWER = 'abcdefghijkmnopqrstuvwxyz';

export const VOUCHER_ALPHABETS: Readonly<Record<VoucherCharset, string>> = {
  DIGITS,
  UPPER,
  LOWER,
  UPPER_DIGITS: UPPER + DIGITS,
  MIXED: UPPER + LOWER + DIGITS,
};

/**
 * Mode d'authentification (Mikhmon : « user mode ») : CODE = un seul code, identifiant et
 * mot de passe identiques ; USER_PASS = identifiant et mot de passe distincts.
 */
export const VOUCHER_AUTH_MODES = ['CODE', 'USER_PASS'] as const;
export type VoucherAuthMode = (typeof VOUCHER_AUTH_MODES)[number];

/**
 * Entropie minimale de la partie aléatoire d'un code (risque R8 : force brute). 24 bits,
 * soit au moins 8 chiffres, 6 caractères majuscules + chiffres, ou 5 caractères mixtes.
 */
export const MIN_VOUCHER_ENTROPY_BITS = 24;

export function voucherEntropyBits(charset: VoucherCharset, length: number): number {
  return length * Math.log2(VOUCHER_ALPHABETS[charset].length);
}

/** Longueur minimale de la partie aléatoire pour un jeu de caractères. */
export function minVoucherLength(charset: VoucherCharset): number {
  return Math.ceil(MIN_VOUCHER_ENTROPY_BITS / Math.log2(VOUCHER_ALPHABETS[charset].length));
}

/** Préfixe facultatif (Mikhmon : « prefix ») : identifie le lot ou le site à l'œil nu. */
export const voucherPrefixSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z2-9]{0,6}$/, {
    message: '6 lettres ou chiffres au plus (sans 0 ni 1)',
  });

/**
 * Code d'un ticket : alphabet sans ambiguïté, utilisable tel quel comme identifiant
 * RADIUS. Sert aussi à la recherche exacte d'un ticket par le support.
 */
export const voucherCodeSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z2-9]{4,24}$/, { message: 'Code de ticket invalide' });

// --- Lots de tickets -----------------------------------------------------------

/** Quantité maximale d'un lot (critère du Sprint 6 : 1 000 tickets). */
export const MAX_BATCH_QUANTITY = 1000;

export const generateVoucherBatchRequestSchema = z
  .strictObject({
    planId: z.uuid(),
    /** Site d'émission (portée LOCAL : le ticket n'est valable que sur ce site). */
    siteId: z.uuid(),
    quantity: z.number().int().min(1).max(MAX_BATCH_QUANTITY),
    authMode: z.enum(VOUCHER_AUTH_MODES).default('CODE'),
    charset: z.enum(VOUCHER_CHARSETS).default('DIGITS'),
    length: z.number().int().min(4).max(16).default(8),
    prefix: voucherPrefixSchema.default(''),
    /** Commentaire du lot (Mikhmon : « comment »), ex. « Marché du lundi ». */
    label: optionalText(80),
    /** Date limite de vente du stock non vendu (facultative). */
    expiresAt: z.iso
      .datetime({ offset: true })
      .nullable()
      .optional()
      .transform((value) => value ?? null),
  })
  .refine((value) => value.length >= minVoucherLength(value.charset), {
    message: `Code trop court : au moins ${String(MIN_VOUCHER_ENTROPY_BITS)} bits d'entropie requis`,
    path: ['length'],
  })
  .refine((value) => value.prefix.length + value.length <= 20, {
    message: 'Préfixe et code : 20 caractères au plus',
    path: ['prefix'],
  });
export type GenerateVoucherBatchRequest = z.infer<typeof generateVoucherBatchRequestSchema>;

/** États du cycle de vie (dossier v0.1 §16). */
export const VOUCHER_STATES = [
  'AVAILABLE',
  'ASSIGNED',
  'SOLD',
  'ACTIVE',
  'EXPIRED',
  'DISABLED',
] as const;
export type VoucherState = (typeof VOUCHER_STATES)[number];

/** États depuis lesquels un ticket peut encore être désactivé. */
export const DISABLEABLE_VOUCHER_STATES: readonly VoucherState[] = [
  'AVAILABLE',
  'ASSIGNED',
  'SOLD',
  'ACTIVE',
];

export const voucherStateCountsSchema = z.record(z.enum(VOUCHER_STATES), z.number().int());
export type VoucherStateCounts = Record<VoucherState, number>;

export const voucherBatchSchema = z.object({
  id: z.uuid(),
  number: z.number().int(),
  label: z.string().nullable(),
  plan: z.object({ id: z.uuid(), name: z.string() }),
  site: z.object({ id: z.uuid(), name: z.string(), code: z.string() }),
  quantity: z.number().int(),
  authMode: z.enum(VOUCHER_AUTH_MODES),
  charset: z.enum(VOUCHER_CHARSETS),
  length: z.number().int(),
  prefix: z.string(),
  scope: z.enum(VOUCHER_SCOPES),
  /** Prix unitaire figé à la génération (le forfait peut changer ensuite). */
  unitPrice: z.number().int(),
  currency: z.string(),
  expiresAt: z.string().nullable(),
  createdBy: z.string().nullable(),
  createdAt: z.string(),
  counts: voucherStateCountsSchema,
});
export type VoucherBatch = z.infer<typeof voucherBatchSchema>;

export const listVoucherBatchesQuerySchema = z.strictObject({
  siteId: z.uuid().optional(),
  planId: z.uuid().optional(),
});
export type ListVoucherBatchesQuery = z.infer<typeof listVoucherBatchesQuerySchema>;

// --- Tickets ---------------------------------------------------------------------

/**
 * Ticket tel que listé : le code est MASQUÉ (titre au porteur). Le code complet n'est
 * renvoyé que par l'impression d'un lot (vouchers.export, auditée) ou par une recherche
 * exacte, qui prouve déjà sa connaissance.
 */
export const voucherSchema = z.object({
  id: z.uuid(),
  batchId: z.uuid(),
  serial: z.number().int(),
  maskedCode: z.string(),
  state: z.enum(VOUCHER_STATES),
  plan: z.object({ id: z.uuid(), name: z.string() }),
  site: z.object({ id: z.uuid(), name: z.string() }),
  soldAt: z.string().nullable(),
  activatedAt: z.string().nullable(),
  expiresAt: z.string().nullable(),
  disabledAt: z.string().nullable(),
  disabledReason: z.string().nullable(),
  createdAt: z.string(),
});
export type Voucher = z.infer<typeof voucherSchema>;

export const voucherEventSchema = z.object({
  fromState: z.enum(VOUCHER_STATES).nullable(),
  toState: z.enum(VOUCHER_STATES),
  actor: z.string().nullable(),
  reason: z.string().nullable(),
  occurredAt: z.string(),
});
export type VoucherEvent = z.infer<typeof voucherEventSchema>;

export type VoucherDetail = Voucher & { events: VoucherEvent[] };

export const listVouchersQuerySchema = z.strictObject({
  batchId: z.uuid().optional(),
  state: z.enum(VOUCHER_STATES).optional(),
  /** Recherche EXACTE d'un code (support) ; aucune recherche partielle. */
  code: voucherCodeSchema.optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(200),
});
export type ListVouchersQuery = z.infer<typeof listVouchersQuerySchema>;

export const disableVouchersRequestSchema = z.strictObject({
  reason: z.string().trim().min(3).max(200),
});
export type DisableVouchersRequest = z.infer<typeof disableVouchersRequestSchema>;

/** Ticket imprimable : seule réponse de l'API qui contient les codes en clair. */
export const printableVoucherSchema = z.object({
  serial: z.number().int(),
  username: z.string(),
  /** null en mode CODE (identifiant = mot de passe). */
  password: z.string().nullable(),
  state: z.enum(VOUCHER_STATES),
});
export type PrintableVoucher = z.infer<typeof printableVoucherSchema>;

export interface VoucherBatchPrint {
  batch: VoucherBatch;
  plan: Plan;
  company: { name: string; phone: string | null; whatsapp: string | null };
  vouchers: PrintableVoucher[];
}

/** Masque un code : « 4829••••61 ». Le préfixe éventuel reste lisible. */
export function maskVoucherCode(code: string, prefixLength = 0): string {
  const prefix = code.slice(0, prefixLength);
  const rest = code.slice(prefixLength);
  if (rest.length <= 4) return `${prefix}${'•'.repeat(rest.length)}`;
  return `${prefix}${rest.slice(0, 2)}${'•'.repeat(rest.length - 4)}${rest.slice(-2)}`;
}

/** Durée lisible en français : 3600 → « 1 h », 90 000 → « 1 j 1 h ». */
export function formatDuration(seconds: number | null): string {
  if (seconds === null) return 'Illimité';
  const units: [number, string][] = [
    [86_400, 'j'],
    [3600, 'h'],
    [60, 'min'],
  ];
  const parts: string[] = [];
  let rest = seconds;
  for (const [size, label] of units) {
    const count = Math.floor(rest / size);
    if (count > 0) {
      parts.push(`${String(count)} ${label}`);
      rest -= count * size;
    }
  }
  if (rest > 0 || parts.length === 0) parts.push(`${String(rest)} s`);
  return parts.slice(0, 2).join(' ');
}

/** Volume lisible : 1 073 741 824 → « 1 Go ». */
export function formatBytes(bytes: number | null): string {
  if (bytes === null) return 'Illimité';
  const units = ['o', 'Ko', 'Mo', 'Go', 'To'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded = Math.round(value * 10) / 10;
  return `${String(rounded).replace('.', ',')} ${units[unit] ?? 'o'}`;
}

/** Débit lisible : 2000 → « 2 Mbit/s », 512 → « 512 kbit/s ». */
export function formatRate(kbps: number | null): string {
  if (kbps === null) return 'Illimité';
  if (kbps >= 1000 && kbps % 1000 === 0) return `${String(kbps / 1000)} Mbit/s`;
  if (kbps >= 1000) return `${String(Math.round(kbps / 100) / 10).replace('.', ',')} Mbit/s`;
  return `${String(kbps)} kbit/s`;
}
