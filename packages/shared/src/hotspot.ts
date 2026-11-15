import { z } from 'zod';
import type { RouterStatus } from './routers.js';

/**
 * Lot B : forfaits, tickets (lots), hotspots et sessions RADIUS. Les limites reprennent
 * EXACTEMENT les contraintes CHECK de la migration 0008 (plans_values_check, plans_limits_check,
 * hotspots_network_check…) : une saisie refusée par la base l'est d'abord ici, avec un message
 * lisible.
 *
 * Un code de ticket est un secret au porteur : AUCUN de ces types ne le contient, sauf
 * PrintableVoucher (réponse explicite d'impression, permission vouchers.export, auditée).
 */

// --- Forfaits -----------------------------------------------------------------------

export const PLAN_STATUSES = ['ACTIVE', 'DISABLED'] as const;
export type PlanStatus = (typeof PLAN_STATUSES)[number];

/** Bornes des contraintes plans_values_check (secondes, kbit/s, octets). */
export const PLAN_LIMITS = {
  minSeconds: 60,
  /** 366 jours. */
  maxSeconds: 31_622_400,
  minRateKbps: 8,
  maxRateKbps: 10_000_000,
  /** 1 Mio. */
  minQuotaBytes: 1_048_576,
  /** 100 Tio. */
  maxQuotaBytes: 109_951_162_777_600,
  minDevices: 1,
  maxDevices: 10,
  minIdleSeconds: 60,
  maxIdleSeconds: 86_400,
  defaultIdleSeconds: 300,
} as const;

const duration = z
  .number()
  .int()
  .min(PLAN_LIMITS.minSeconds, { message: 'Une minute au moins' })
  .max(PLAN_LIMITS.maxSeconds, { message: '366 jours au plus' });
const rate = z
  .number()
  .int()
  .min(PLAN_LIMITS.minRateKbps, { message: '8 kbit/s au moins' })
  .max(PLAN_LIMITS.maxRateKbps, { message: '10 Gbit/s au plus' });
const quota = z
  .number()
  .int()
  .min(PLAN_LIMITS.minQuotaBytes, { message: '1 Mo au moins' })
  .max(PLAN_LIMITS.maxQuotaBytes, { message: '100 To au plus' });
const devices = z
  .number()
  .int()
  .min(PLAN_LIMITS.minDevices)
  .max(PLAN_LIMITS.maxDevices, { message: '10 appareils au plus' });
const idle = z
  .number()
  .int()
  .min(PLAN_LIMITS.minIdleSeconds, { message: 'Une minute au moins' })
  .max(PLAN_LIMITS.maxIdleSeconds, { message: '24 heures au plus' });

const planName = z.string().trim().min(1, { message: 'Nom obligatoire' }).max(80);
const planDescription = z
  .string()
  .trim()
  .max(500)
  .transform((value) => (value === '' ? null : value))
  .nullable();
const priceMinor = z.number().int().min(0, { message: 'Prix positif ou nul' }).max(1_000_000_000);

export interface PlanLimitsInput {
  validitySeconds?: number | null;
  sessionTimeSeconds?: number | null;
  dataQuotaBytes?: number | null;
}

/** plans_limits_check : au moins une limite (validité, temps de connexion ou volume). */
export function planHasLimit(value: PlanLimitsInput): boolean {
  return (
    value.validitySeconds != null ||
    value.sessionTimeSeconds != null ||
    value.dataQuotaBytes != null
  );
}

export const PLAN_LIMIT_MESSAGE =
  'Indiquez au moins une limite : validité, durée de connexion ou volume de données';

export const createPlanRequestSchema = z
  .strictObject({
    name: planName,
    description: planDescription.optional(),
    priceMinor,
    validitySeconds: duration.nullable().optional(),
    sessionTimeSeconds: duration.nullable().optional(),
    rateUpKbps: rate.nullable().optional(),
    rateDownKbps: rate.nullable().optional(),
    dataQuotaBytes: quota.nullable().optional(),
    maxDevices: devices.default(1),
    idleTimeoutSeconds: idle.default(PLAN_LIMITS.defaultIdleSeconds),
  })
  .refine(planHasLimit, { message: PLAN_LIMIT_MESSAGE, path: ['validitySeconds'] });
export type CreatePlanRequest = z.infer<typeof createPlanRequestSchema>;

/**
 * Modification partielle, SANS valeurs par défaut (Zod 4 les appliquerait sous .partial()).
 * La règle « au moins une limite » est revérifiée par l'API sur le forfait fusionné.
 */
export const updatePlanRequestSchema = z
  .strictObject({
    name: planName.optional(),
    description: planDescription.optional(),
    priceMinor: priceMinor.optional(),
    validitySeconds: duration.nullable().optional(),
    sessionTimeSeconds: duration.nullable().optional(),
    rateUpKbps: rate.nullable().optional(),
    rateDownKbps: rate.nullable().optional(),
    dataQuotaBytes: quota.nullable().optional(),
    maxDevices: devices.optional(),
    idleTimeoutSeconds: idle.optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: 'Rien à modifier',
  });
export type UpdatePlanRequest = z.infer<typeof updatePlanRequestSchema>;

export const listPlansQuerySchema = z.strictObject({
  status: z.enum(PLAN_STATUSES).optional(),
});
export type ListPlansQuery = z.infer<typeof listPlansQuerySchema>;

export interface Plan {
  id: string;
  name: string;
  description: string | null;
  priceMinor: number;
  currency: string;
  validitySeconds: number | null;
  sessionTimeSeconds: number | null;
  /** Débit montant : envoi du client vers Internet (kbit/s). */
  rateUpKbps: number | null;
  /** Débit descendant : réception par le client (kbit/s). */
  rateDownKbps: number | null;
  dataQuotaBytes: number | null;
  maxDevices: number;
  idleTimeoutSeconds: number;
  status: PlanStatus;
  createdAt: string;
  updatedAt: string;
}

// --- Lots et tickets -------------------------------------------------------------------

export const VOUCHER_STATES = ['AVAILABLE', 'ACTIVE', 'EXHAUSTED', 'EXPIRED', 'DISABLED'] as const;
export type VoucherState = (typeof VOUCHER_STATES)[number];

export const MAX_BATCH_QUANTITY = 1000;

export const createVoucherBatchRequestSchema = z.strictObject({
  planId: z.uuid(),
  siteId: z.uuid(),
  quantity: z
    .number()
    .int()
    .min(1, { message: 'Un ticket au moins' })
    .max(MAX_BATCH_QUANTITY, { message: '1 000 tickets au plus par lot' }),
  label: z
    .string()
    .trim()
    .max(80)
    .transform((value) => (value === '' ? null : value))
    .nullable()
    .optional(),
});
export type CreateVoucherBatchRequest = z.infer<typeof createVoucherBatchRequestSchema>;

const limit = z.coerce.number().int().min(1).max(200).default(50);
const offset = z.coerce.number().int().min(0).max(1_000_000).default(0);

export const listVoucherBatchesQuerySchema = z.strictObject({
  siteId: z.uuid().optional(),
  planId: z.uuid().optional(),
  limit,
  offset,
});
export type ListVoucherBatchesQuery = z.infer<typeof listVoucherBatchesQuerySchema>;

export const listVouchersQuerySchema = z.strictObject({
  state: z.enum(VOUCHER_STATES).optional(),
  batchId: z.uuid().optional(),
  siteId: z.uuid().optional(),
  planId: z.uuid().optional(),
  /** Numéro de série exact (référence non secrète imprimée sur le ticket). */
  serial: z.coerce.number().int().min(1).max(MAX_BATCH_QUANTITY).optional(),
  limit,
  offset,
});
export type ListVouchersQuery = z.infer<typeof listVouchersQuerySchema>;

export const disableVoucherRequestSchema = z.strictObject({
  reason: z
    .string()
    .trim()
    .max(200)
    .transform((value) => (value === '' ? null : value))
    .nullable()
    .optional(),
});
export type DisableVoucherRequest = z.infer<typeof disableVoucherRequestSchema>;

export interface Page<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

interface Ref {
  id: string;
  name: string;
}
interface SiteRef extends Ref {
  code: string;
}

export interface VoucherBatch {
  id: string;
  plan: Ref;
  site: SiteRef;
  quantity: number;
  label: string | null;
  createdAt: string;
  createdBy: { id: string; fullName: string | null } | null;
  /** Nombre de tickets par état. */
  states: Record<VoucherState, number>;
}

/** Ticket sans son code : listes et détail. */
export interface Voucher {
  id: string;
  serial: number;
  batchId: string;
  batchLabel: string | null;
  plan: Ref;
  site: SiteRef;
  state: VoucherState;
  priceMinor: number;
  currency: string;
  validitySeconds: number | null;
  sessionTimeSeconds: number | null;
  rateUpKbps: number | null;
  rateDownKbps: number | null;
  dataQuotaBytes: number | null;
  maxDevices: number;
  idleTimeoutSeconds: number;
  usedSeconds: number;
  usedBytes: number;
  activatedAt: string | null;
  expiresAt: string | null;
  lastUsedAt: string | null;
  disabledAt: string | null;
  disabledReason: string | null;
  createdAt: string;
}

export interface VoucherRemaining {
  /** Temps de connexion restant (null : illimité). */
  sessionSeconds: number | null;
  /** Volume restant (null : illimité). */
  bytes: number | null;
  /** Temps calendaire restant avant expiration (null : pas encore activé ou sans validité). */
  validitySeconds: number | null;
}

export interface VoucherAuthAttempt {
  at: string;
  result: 'ACCEPT' | 'REJECT';
  reason: string | null;
  callingStationId: string | null;
  router: Ref | null;
}

export interface VoucherDetail extends Voucher {
  remaining: VoucherRemaining;
  disabledBy: { id: string; fullName: string | null } | null;
  sessions: RadiusSession[];
  authAttempts: VoucherAuthAttempt[];
}

/** Consommation restante d'un ticket à l'instant `now` (jamais négative). */
export function voucherRemaining(
  voucher: Pick<
    Voucher,
    'sessionTimeSeconds' | 'usedSeconds' | 'dataQuotaBytes' | 'usedBytes' | 'expiresAt'
  >,
  now: Date = new Date(),
): VoucherRemaining {
  const positive = (value: number) => Math.max(0, value);
  return {
    sessionSeconds:
      voucher.sessionTimeSeconds === null
        ? null
        : positive(voucher.sessionTimeSeconds - voucher.usedSeconds),
    bytes:
      voucher.dataQuotaBytes === null ? null : positive(voucher.dataQuotaBytes - voucher.usedBytes),
    validitySeconds:
      voucher.expiresAt === null
        ? null
        : positive(Math.floor((new Date(voucher.expiresAt).getTime() - now.getTime()) / 1000)),
  };
}

/** Ticket imprimable : SEULE structure portant le code (réponse d'impression, no-store). */
export interface PrintableVoucher {
  id: string;
  serial: number;
  code: string;
  state: VoucherState;
}

export interface VoucherPrintSheet {
  batch: { id: string; label: string | null; quantity: number; createdAt: string } | null;
  plan: {
    id: string;
    name: string;
    priceMinor: number;
    currency: string;
    validitySeconds: number | null;
    sessionTimeSeconds: number | null;
    dataQuotaBytes: number | null;
    rateUpKbps: number | null;
    rateDownKbps: number | null;
    maxDevices: number;
  };
  site: SiteRef;
  company: { name: string };
  vouchers: PrintableVoucher[];
}

// --- Hotspots ----------------------------------------------------------------------------

export const HOTSPOT_DESIRED_STATES = ['ENABLED', 'DISABLED'] as const;
export type HotspotDesiredState = (typeof HOTSPOT_DESIRED_STATES)[number];
export const HOTSPOT_SYNC_STATUSES = ['PENDING', 'APPLYING', 'SYNCED', 'ERROR'] as const;
export type HotspotSyncStatus = (typeof HOTSPOT_SYNC_STATUSES)[number];

/** Nom d'interface RouterOS (hotspots_interface_check). */
export const HOTSPOT_INTERFACE_PATTERN = /^[A-Za-z0-9._-]{1,40}$/;
/** hotspots_dns_name_check : nom DNS en minuscules, au moins deux labels. */
export const HOTSPOT_DNS_PATTERN =
  /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;

const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

/** Adresse IPv4 en notation pointée -> entier non signé, ou null si invalide. */
export function parseIpv4(value: string): number | null {
  if (!IPV4.test(value)) return null;
  return value.split('.').reduce((acc, part) => acc * 256 + Number(part), 0);
}

export function formatIpv4(value: number): string {
  return [24, 16, 8, 0].map((shift) => Math.floor(value / 2 ** shift) % 256).join('.');
}

export interface Ipv4Network {
  /** Adresse saisie (hôte). */
  address: number;
  prefix: number;
  network: number;
  broadcast: number;
}

/** « 10.5.50.1/24 » -> réseau, ou null si la notation est invalide. */
export function parseIpv4Cidr(value: string): Ipv4Network | null {
  const [ip, prefixText, extra] = value.split('/');
  if (ip === undefined || prefixText === undefined || extra !== undefined) return null;
  if (!/^\d{1,2}$/.test(prefixText)) return null;
  const prefix = Number(prefixText);
  const address = parseIpv4(ip);
  if (address === null || prefix > 32) return null;
  const size = 2 ** (32 - prefix);
  const network = Math.floor(address / size) * size;
  return { address, prefix, network, broadcast: network + size - 1 };
}

const PRIVATE_RANGES: readonly (readonly [string, number])[] = [
  ['10.0.0.0', 8],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
];

/** Le réseau entier est-il dans une plage privée RFC 1918 ? */
export function isRfc1918Network(net: Pick<Ipv4Network, 'network' | 'broadcast'>): boolean {
  return PRIVATE_RANGES.some(([base, prefix]) => {
    const range = parseIpv4Cidr(`${base}/${String(prefix)}`);
    return range !== null && net.network >= range.network && net.broadcast <= range.broadcast;
  });
}

/** Deux réseaux se chevauchent-ils ? */
export function networksOverlap(
  a: Pick<Ipv4Network, 'network' | 'broadcast'>,
  b: Pick<Ipv4Network, 'network' | 'broadcast'>,
): boolean {
  return a.network <= b.broadcast && b.network <= a.broadcast;
}

export interface HotspotNetworkInput {
  gatewayAddress: string;
  poolStart: string;
  poolEnd: string;
}

export interface HotspotNetworkIssue {
  path: keyof HotspotNetworkInput;
  message: string;
}

/**
 * Contrôles du réseau Hotspot (plus stricts que hotspots_network_check) : IPv4 privée
 * RFC 1918, masque /16 à /30, passerelle ni adresse de réseau ni de diffusion, plage
 * d'adresses clientes dans le réseau (hors réseau et diffusion), début ≤ fin, passerelle
 * hors de la plage.
 */
export function hotspotNetworkIssues(input: HotspotNetworkInput): HotspotNetworkIssue[] {
  const issues: HotspotNetworkIssue[] = [];
  const net = parseIpv4Cidr(input.gatewayAddress.trim());
  if (!net) {
    return [{ path: 'gatewayAddress', message: 'Adresse avec masque attendue (ex. 10.5.50.1/24)' }];
  }
  if (net.prefix < 16 || net.prefix > 30) {
    issues.push({ path: 'gatewayAddress', message: 'Masque de /16 à /30 attendu' });
  } else if (!isRfc1918Network(net)) {
    issues.push({
      path: 'gatewayAddress',
      message: 'Réseau privé attendu (10.0.0.0/8, 172.16.0.0/12 ou 192.168.0.0/16)',
    });
  } else if (net.address === net.network || net.address === net.broadcast) {
    issues.push({
      path: 'gatewayAddress',
      message: 'La passerelle ne peut être ni l’adresse du réseau ni celle de diffusion',
    });
  }
  const start = parseIpv4(input.poolStart.trim());
  const end = parseIpv4(input.poolEnd.trim());
  const inside = (ip: number) => ip > net.network && ip < net.broadcast;
  if (start === null) issues.push({ path: 'poolStart', message: 'Adresse IPv4 attendue' });
  else if (!inside(start)) issues.push({ path: 'poolStart', message: 'Hors du réseau Hotspot' });
  if (end === null) issues.push({ path: 'poolEnd', message: 'Adresse IPv4 attendue' });
  else if (!inside(end)) issues.push({ path: 'poolEnd', message: 'Hors du réseau Hotspot' });
  if (start !== null && end !== null && inside(start) && inside(end)) {
    if (start > end) {
      issues.push({ path: 'poolEnd', message: 'La fin de plage doit suivre le début' });
    } else if (net.address >= start && net.address <= end) {
      issues.push({
        path: 'poolStart',
        message: 'La passerelle doit être en dehors de la plage d’adresses clientes',
      });
    }
  }
  return issues;
}

const hotspotName = z.string().trim().min(1, { message: 'Nom obligatoire' }).max(80);
const hotspotInterface = z.string().trim().regex(HOTSPOT_INTERFACE_PATTERN, {
  message: 'Nom d’interface RouterOS invalide (lettres, chiffres, « . », « _ », « - »)',
});
const ipText = z.string().trim().max(18);
const dnsName = z
  .string()
  .trim()
  .toLowerCase()
  .max(253)
  .transform((value) => (value === '' ? null : value))
  .pipe(
    z
      .string()
      .regex(HOTSPOT_DNS_PATTERN, { message: 'Nom DNS invalide (ex. wifi.example.net)' })
      .nullable(),
  )
  .nullable();

const refineNetwork = (value: Partial<HotspotNetworkInput>, ctx: z.RefinementCtx) => {
  if (
    value.gatewayAddress === undefined &&
    value.poolStart === undefined &&
    value.poolEnd === undefined
  ) {
    return;
  }
  if (
    value.gatewayAddress === undefined ||
    value.poolStart === undefined ||
    value.poolEnd === undefined
  ) {
    ctx.addIssue({
      code: 'custom',
      path: ['gatewayAddress'],
      message: 'Adresse, début et fin de plage vont ensemble',
    });
    return;
  }
  for (const issue of hotspotNetworkIssues(value as HotspotNetworkInput)) {
    ctx.addIssue({ code: 'custom', path: [issue.path], message: issue.message });
  }
};

export const createHotspotRequestSchema = z
  .strictObject({
    routerId: z.uuid(),
    name: hotspotName,
    interface: hotspotInterface,
    gatewayAddress: ipText,
    poolStart: ipText,
    poolEnd: ipText,
    dnsName: dnsName.optional(),
  })
  .superRefine(refineNetwork);
export type CreateHotspotRequest = z.infer<typeof createHotspotRequestSchema>;

/** Le réseau (adresse et plage) se modifie d'un bloc : trois champs ensemble ou aucun. */
export const updateHotspotRequestSchema = z
  .strictObject({
    name: hotspotName.optional(),
    interface: hotspotInterface.optional(),
    gatewayAddress: ipText.optional(),
    poolStart: ipText.optional(),
    poolEnd: ipText.optional(),
    dnsName: dnsName.optional(),
  })
  .superRefine(refineNetwork)
  .refine((value) => Object.keys(value).length > 0, {
    message: 'Rien à modifier',
  });
export type UpdateHotspotRequest = z.infer<typeof updateHotspotRequestSchema>;

export const listHotspotsQuerySchema = z.strictObject({
  siteId: z.uuid().optional(),
  routerId: z.uuid().optional(),
});
export type ListHotspotsQuery = z.infer<typeof listHotspotsQuerySchema>;

export interface Hotspot {
  id: string;
  router: { id: string; name: string; status: RouterStatus; tunnelIp: string };
  site: SiteRef;
  name: string;
  interface: string;
  gatewayAddress: string;
  poolStart: string;
  poolEnd: string;
  dnsName: string | null;
  desiredState: HotspotDesiredState;
  syncStatus: HotspotSyncStatus;
  configVersion: number;
  appliedVersion: number | null;
  lastSyncAt: string | null;
  /** Dernière erreur d'application (déjà nettoyée par le worker). */
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

// --- Sessions RADIUS -----------------------------------------------------------------------

export const listRadiusSessionsQuerySchema = z.strictObject({
  active: z
    .enum(['true', 'false'])
    .transform((value) => value === 'true')
    .optional(),
  siteId: z.uuid().optional(),
  routerId: z.uuid().optional(),
  voucherId: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});
export type ListRadiusSessionsQuery = z.infer<typeof listRadiusSessionsQuerySchema>;

export interface RadiusSession {
  id: string;
  voucher: { id: string; serial: number; batchId: string };
  router: Ref;
  site: SiteRef;
  /** Adresse MAC du client (Calling-Station-Id). */
  macAddress: string | null;
  framedIp: string | null;
  startedAt: string;
  updatedAt: string;
  stoppedAt: string | null;
  durationSeconds: number;
  /** Octets envoyés par le client (Acct-Input). */
  bytesUp: number;
  /** Octets reçus par le client (Acct-Output). */
  bytesDown: number;
  terminateCause: string | null;
}
