import { z } from 'zod';

/**
 * Routeurs MikroTik (Sprint 3B) : hiérarchie Super Admin ECSI → Entreprise → Site → Routeur.
 * Aucun secret ne figure dans ces types : ni mot de passe RouterOS, ni clé privée WireGuard,
 * ni empreinte de jeton. Le jeton d'enrôlement n'apparaît qu'UNE fois, dans la réponse de
 * création de l'enrôlement (script à coller dans le routeur).
 */
export const ROUTER_STATUSES = ['PROVISIONING', 'ONLINE', 'DEGRADED', 'OFFLINE'] as const;
export type RouterStatus = (typeof ROUTER_STATUSES)[number];

export const ROUTER_TRANSPORTS = ['REST_HTTPS', 'API'] as const;
export type RouterTransport = (typeof ROUTER_TRANSPORTS)[number];

const routerName = z.string().trim().min(2).max(128);
/** Compte de service RouterOS : lettres, chiffres, point, tiret, souligné. */
export const routerosUsernameSchema = z.string().regex(/^[A-Za-z0-9._-]{1,64}$/, {
  message: 'Nom de compte RouterOS invalide',
});
export const routerosPasswordSchema = z.string().min(12).max(256);
/** Empreinte SHA-256 du certificat (64 hexadécimaux, « : » tolérés). */
export const tlsFingerprintSchema = z
  .string()
  .trim()
  .transform((value) => value.toLowerCase().replace(/:/g, ''))
  .pipe(z.string().regex(/^[0-9a-f]{64}$/, { message: 'Empreinte SHA-256 hexadécimale attendue' }));

/** Enregistrement manuel (routeur déjà configuré à la main, ex. CHR-LAB du Sprint 3A). */
export const registerRouterRequestSchema = z.strictObject({
  siteId: z.uuid(),
  name: routerName,
  tunnelIp: z.string().trim().max(18),
  transport: z.enum(ROUTER_TRANSPORTS),
  routerosUsername: routerosUsernameSchema,
  routerosPassword: routerosPasswordSchema,
  tlsFingerprint: tlsFingerprintSchema.nullable().optional(),
});
export type RegisterRouterRequest = z.infer<typeof registerRouterRequestSchema>;

/** « Ajouter un routeur » : le cloud attribue l'adresse tunnel et génère le script. */
export const createEnrollmentRequestSchema = z.strictObject({
  siteId: z.uuid(),
  name: routerName,
});
export type CreateEnrollmentRequest = z.infer<typeof createEnrollmentRequestSchema>;

export const updateRouterRequestSchema = z
  .strictObject({ name: routerName.optional(), siteId: z.uuid().optional() })
  .refine((value) => value.name !== undefined || value.siteId !== undefined, {
    message: 'Rien à modifier',
  });
export type UpdateRouterRequest = z.infer<typeof updateRouterRequestSchema>;

export const routerCredentialsRequestSchema = z.strictObject({
  routerosUsername: routerosUsernameSchema,
  routerosPassword: routerosPasswordSchema,
  tlsFingerprint: tlsFingerprintSchema.nullable().optional(),
});
export type RouterCredentialsRequest = z.infer<typeof routerCredentialsRequestSchema>;

export const listRoutersQuerySchema = z.strictObject({
  siteId: z.uuid().optional(),
  status: z.enum(ROUTER_STATUSES).optional(),
  q: z.string().trim().max(100).optional(),
});
export type ListRoutersQuery = z.infer<typeof listRoutersQuerySchema>;

/** Requête publique du routeur (étape 6 du script) : jeton et clé publique, rien d'autre. */
export const WIREGUARD_PUBLIC_KEY = /^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw480]=$/;
export const enrollRequestSchema = z.strictObject({
  token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  publicKey: z.string().regex(WIREGUARD_PUBLIC_KEY),
});
export type EnrollRequest = z.infer<typeof enrollRequestSchema>;

export interface RouterInterface {
  name: string;
  type: string | null;
  running: boolean | null;
  disabled: boolean | null;
  mtu: number | null;
  macAddress: string | null;
  rxByte: number | null;
  txByte: number | null;
  linkDowns: number | null;
}

/** Vue d'un routeur renvoyée par l'API : aucun secret. */
export interface Router {
  id: string;
  siteId: string;
  site: { id: string; name: string; code: string };
  name: string;
  status: RouterStatus;
  transport: RouterTransport;
  tunnelIp: string;
  /** Clé publique WireGuard du routeur (publique par nature), si enrôlé par ECSI CLOUD. */
  wgPublicKey: string | null;
  /** Le mot de passe n'est jamais renvoyé : seulement le fait qu'il existe. */
  hasCredentials: boolean;
  routerosUsername: string | null;
  tlsFingerprint: string | null;
  identity: string | null;
  routerosVersion: string | null;
  boardName: string | null;
  architecture: string | null;
  uptimeSeconds: number | null;
  cpu: string | null;
  cpuCount: number | null;
  cpuLoad: number | null;
  totalMemory: number | null;
  freeMemory: number | null;
  consecutiveFailures: number;
  lastSeenAt: string | null;
  lastSyncAt: string | null;
  lastError: string | null;
  enrolledAt: string | null;
  activatedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RouterDetail extends Router {
  interfaces: RouterInterface[];
  enrollment: {
    /** Jeton en cours (jamais sa valeur) : expiration et état. */
    expiresAt: string | null;
    usedAt: string | null;
  } | null;
}

/** Réponse de création d'enrôlement : le script contient le jeton, affiché une seule fois. */
export interface EnrollmentCreated {
  router: Router;
  script: string;
  expiresAt: string;
}

/** Console plateforme (Super Admin ECSI) : routeurs d'une entreprise, lecture seule, sans secret. */
export interface PlatformRouter {
  id: string;
  site: { id: string; name: string; code: string };
  name: string;
  status: RouterStatus;
  transport: RouterTransport;
  tunnelIp: string;
  routerosVersion: string | null;
  boardName: string | null;
  identity: string | null;
  uptimeSeconds: number | null;
  cpuLoad: number | null;
  totalMemory: number | null;
  freeMemory: number | null;
  lastSeenAt: string | null;
  lastError: string | null;
  enrolledAt: string | null;
  activatedAt: string | null;
  createdAt: string;
}
