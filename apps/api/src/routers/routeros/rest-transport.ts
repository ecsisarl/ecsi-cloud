import { createHash } from 'node:crypto';
import { request } from 'node:http';
import { connect as tlsConnect, type TLSSocket } from 'node:tls';
import { fromNetworkError, RouterOsError, sanitizeDetail } from './errors.js';
import {
  assertProplist,
  DEFAULT_TIMEOUTS,
  MAX_RESPONSE_BYTES,
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
    if (!/^[0-9a-f]{64}$/.test(fingerprint)) {
      throw new RouterOsError('TLS_PINNING', 'Empreinte TLS absente ou invalide : REST refusé');
    }
    this.authorization = `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`, 'utf8').toString('base64')}`;
  }

  async print(menu: RouterOsMenu, proplist?: readonly string[]): Promise<RouterOsRecord[]> {
    let path = `/rest/${menu}`;
    if (proplist?.length) {
      assertProplist(proplist);
      path += `?.proplist=${proplist.join(',')}`;
    }
    const socket = await this.connectPinned();
    const { status, body } = await this.get(socket, path);
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

  private connectPinned(): Promise<TLSSocket> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const socket = tlsConnect({
        host: this.target.host,
        port: this.target.port,
        // Remplacé par l'épinglage ci-dessous (aucune AC ne signe le certificat RouterOS).
        rejectUnauthorized: false,
      });
      const timer = setTimeout(() => {
        settled = true;
        socket.destroy();
        reject(fromNetworkError(undefined, true));
      }, this.timeouts.connectMs);
      socket.once('secureConnect', () => {
        clearTimeout(timer);
        if (settled) return;
        settled = true;
        const der = socket.getPeerCertificate(false).raw as Buffer | undefined;
        const presented = der ? createHash('sha256').update(der).digest('hex') : '';
        if (presented !== this.fingerprint) {
          socket.destroy();
          reject(
            new RouterOsError(
              'TLS_PINNING',
              `Certificat inattendu (empreinte ${presented.slice(0, 16) || 'absente'}…) : connexion coupée`,
            ),
          );
          return;
        }
        resolve(socket);
      });
      socket.once('error', (error) => {
        clearTimeout(timer);
        if (settled) return;
        settled = true;
        const code = (error as NodeJS.ErrnoException).code ?? '';
        reject(
          code.startsWith('ERR_SSL') || code.startsWith('EPROTO')
            ? new RouterOsError('PROTOCOL', 'Échec de la négociation TLS')
            : fromNetworkError(error, false),
        );
      });
    });
  }

  private get(socket: TLSSocket, path: string): Promise<{ status: number; body: Buffer }> {
    return new Promise((resolve, reject) => {
      let done = false;
      const finish = (error: RouterOsError | null, value?: { status: number; body: Buffer }) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        socket.destroy();
        if (error) reject(error);
        else if (value) resolve(value);
      };
      const timer = setTimeout(() => {
        finish(fromNetworkError(undefined, true));
      }, this.timeouts.requestMs);
      const req = request({
        host: this.target.host,
        port: this.target.port,
        method: 'GET',
        path,
        headers: { authorization: this.authorization, accept: 'application/json' },
        // Connexion déjà établie ET vérifiée : rien n'est envoyé avant l'épinglage. (Ne pas
        // ajouter « agent: false » : Node ouvrirait alors sa propre connexion TCP, sans TLS.)
        createConnection: () => socket,
      });
      req.on('socket', (used) => {
        if (used !== socket) {
          req.destroy();
          finish(new RouterOsError('PROTOCOL', 'Connexion non épinglée refusée'));
        }
      });
      req.on('response', (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_RESPONSE_BYTES) {
            finish(new RouterOsError('PROTOCOL', 'Réponse REST trop volumineuse'));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          finish(null, { status: res.statusCode ?? 0, body: Buffer.concat(chunks) });
        });
        res.on('error', (error) => {
          finish(fromNetworkError(error, false));
        });
      });
      req.on('error', (error) => {
        finish(fromNetworkError(error, false));
      });
      req.end();
    });
  }
}

function toRecord(item: unknown): RouterOsRecord {
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
