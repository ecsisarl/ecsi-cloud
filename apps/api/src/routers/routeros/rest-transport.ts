import { RouterOsError, sanitizeDetail } from './errors.js';
import { assertFingerprint, pinnedRequest } from './pinned-https.js';
import {
  assertProplist,
  DEFAULT_TIMEOUTS,
  type RouterOsCredentials,
  type RouterOsMenu,
  type RouterOsRecord,
  type RouterOsTransport,
  type TransportTimeouts,
} from './transport.js';

export const REST_PORT = 443;

/**
 * Transport REST HTTPS (cible de production), repris du prototype lab/routeros/chr/probe.py :
 *  - le certificat du service www-ssl est autosigné : AUCUNE autorité n'est approuvée ; le
 *    SHA-256 du certificat DER présenté est comparé à l'empreinte enregistrée à l'enrôlement
 *    (épinglage). En cas d'écart, la connexion est coupée AVANT tout envoi d'identifiants ;
 *  - lecture seule : GET /rest/<menu>[?.proplist=…] ;
 *  - aucune redirection suivie, réponse bornée en taille et en durée.
 * Compte de service : politiques read, api, rest-api (validé sur CHR 7.24.5).
 */
export class RestTransport implements RouterOsTransport {
  readonly kind = 'REST_HTTPS' as const;
  private readonly authorization: string;

  constructor(
    private readonly target: { host: string; port: number },
    private readonly fingerprint: string,
    credentials: RouterOsCredentials,
    private readonly timeouts: TransportTimeouts = DEFAULT_TIMEOUTS,
  ) {
    assertFingerprint(fingerprint);
    this.authorization = `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`, 'utf8').toString('base64')}`;
  }

  async print(menu: RouterOsMenu, proplist?: readonly string[]): Promise<RouterOsRecord[]> {
    let path = `/rest/${menu}`;
    if (proplist?.length) {
      assertProplist(proplist);
      path += `?.proplist=${proplist.join(',')}`;
    }
    const { status, body } = await pinnedRequest(this.target, this.fingerprint, this.timeouts, {
      method: 'GET',
      path,
      authorization: this.authorization,
    });
    if (status === 401)
      throw new RouterOsError('AUTH', 'Identifiants refusés par RouterOS (HTTP 401)');
    if (status === 403) {
      throw new RouterOsError('PERMISSION', `Lecture ${menu} interdite au compte (HTTP 403)`);
    }
    let payload: unknown;
    try {
      payload = JSON.parse(body.toString('utf8'));
    } catch {
      throw new RouterOsError('PROTOCOL', `Réponse REST illisible (HTTP ${status})`);
    }
    if (status !== 200) {
      const detail =
        payload && typeof payload === 'object' && 'message' in payload
          ? String(payload.message)
          : '';
      throw new RouterOsError(
        'API_ERROR',
        `Lecture ${menu} refusée par RouterOS (HTTP ${status})${detail ? ` : ${sanitizeDetail(detail)}` : ''}`,
      );
    }
    // Les menus à élément unique (system/identity, system/resource) renvoient un objet.
    const items = Array.isArray(payload) ? payload : [payload];
    return items.map((item) => toRecord(item));
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

export function toRecord(item: unknown): RouterOsRecord {
  if (!item || typeof item !== 'object' || Array.isArray(item)) {
    throw new RouterOsError('PROTOCOL', 'Réponse REST inattendue (objet attendu)');
  }
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(item as Record<string, unknown>)) {
    if (typeof value === 'string') out[key] = value;
    else if (typeof value === 'number' || typeof value === 'boolean') out[key] = String(value);
  }
  return out;
}
