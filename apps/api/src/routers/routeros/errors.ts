/**
 * Erreurs d'accès RouterOS. Leur message est construit par le code (jamais à partir des
 * identifiants) et, quand il reprend un texte renvoyé par le routeur, celui-ci est nettoyé,
 * tronqué, et toute occurrence d'un secret connu est masquée : un message d'erreur peut
 * être journalisé et stocké dans routers.last_error sans risque de fuite.
 */
export const ROUTEROS_ERROR_CODES = [
  /** Aucune réponse (délai dépassé, hôte ou réseau injoignable) : tunnel probablement coupé. */
  'UNREACHABLE',
  /** L'hôte répond mais le service refuse ou coupe la connexion (RST) : tunnel actif. */
  'SERVICE_UNAVAILABLE',
  /** Certificat présenté différent de l'empreinte enregistrée (ou absence d'empreinte). */
  'TLS_PINNING',
  /** Identifiants refusés. */
  'AUTH',
  /** Compte authentifié mais droits insuffisants (politique RouterOS manquante). */
  'PERMISSION',
  /** Erreur renvoyée par RouterOS pour une commande. */
  'API_ERROR',
  /** Réponse illisible ou trop volumineuse. */
  'PROTOCOL',
  /** Configuration côté cloud refusée (adresse tunnel hors plage, secret illisible). */
  'CONFIG',
] as const;
export type RouterOsErrorCode = (typeof ROUTEROS_ERROR_CODES)[number];

export class RouterOsError extends Error {
  constructor(
    readonly code: RouterOsErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'RouterOsError';
  }

  /** Vrai si l'échec ne prouve pas que le routeur est joignable (cf. supervision). */
  get unreachable(): boolean {
    return this.code === 'UNREACHABLE';
  }
}

const MAX_DETAIL = 160;

/**
 * Nettoie un texte venu du routeur ou du système : caractères de contrôle retirés, longueur
 * bornée, secrets masqués (y compris s'ils apparaissent encodés en base64, cas d'un en-tête
 * Basic renvoyé en écho).
 */
export function sanitizeDetail(text: string, secrets: readonly string[] = []): string {
  let out = text.replace(/\p{Cc}+/gu, ' ').trim();
  for (const secret of secrets) {
    if (!secret) continue;
    for (const form of [secret, Buffer.from(secret, 'utf8').toString('base64')]) {
      out = out.split(form).join('[masqué]');
    }
  }
  return out.length > MAX_DETAIL ? `${out.slice(0, MAX_DETAIL)}…` : out;
}

/** Erreur réseau Node.js -> erreur RouterOS (aucun secret dans ces messages). */
export function fromNetworkError(error: unknown, timedOut: boolean): RouterOsError {
  if (timedOut) return new RouterOsError('UNREACHABLE', 'Délai dépassé (aucune réponse)');
  const code = (error as NodeJS.ErrnoException | undefined)?.code ?? '';
  switch (code) {
    case 'ECONNREFUSED':
      return new RouterOsError('SERVICE_UNAVAILABLE', 'Connexion refusée par le routeur');
    case 'ECONNRESET':
    case 'EPIPE':
      return new RouterOsError('SERVICE_UNAVAILABLE', 'Connexion interrompue par le routeur');
    case 'ETIMEDOUT':
    case 'EHOSTUNREACH':
    case 'ENETUNREACH':
    case 'EHOSTDOWN':
      return new RouterOsError('UNREACHABLE', `Routeur injoignable (${code})`);
    default:
      return new RouterOsError(
        'UNREACHABLE',
        `Erreur réseau${code ? ` (${sanitizeDetail(code)})` : ''}`,
      );
  }
}
