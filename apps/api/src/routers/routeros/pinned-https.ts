import { createHash } from 'node:crypto';
import { request } from 'node:http';
import { connect as tlsConnect, type TLSSocket } from 'node:tls';
import { fromNetworkError, RouterOsError } from './errors.js';
import { MAX_RESPONSE_BYTES, type TransportTimeouts } from './transport.js';

/**
 * Requête HTTPS vers le service www-ssl d'un routeur, certificat ÉPINGLÉ (commune au
 * transport de lecture REST et au transport d'écriture) :
 *  - le certificat est autosigné : AUCUNE autorité n'est approuvée ; le SHA-256 du certificat
 *    DER présenté est comparé à l'empreinte enregistrée à l'enrôlement. En cas d'écart, la
 *    connexion est coupée AVANT tout envoi d'identifiants ;
 *  - une connexion par requête, aucune redirection suivie, réponse bornée en taille et durée.
 */
export interface PinnedTarget {
  readonly host: string;
  readonly port: number;
}

export interface PinnedRequest {
  readonly method: 'GET' | 'PUT' | 'PATCH' | 'DELETE' | 'POST';
  readonly path: string;
  readonly authorization: string;
  readonly body?: string;
}

export interface PinnedResponse {
  readonly status: number;
  readonly body: Buffer;
}

export function assertFingerprint(fingerprint: string): void {
  if (!/^[0-9a-f]{64}$/.test(fingerprint)) {
    throw new RouterOsError('TLS_PINNING', 'Empreinte TLS absente ou invalide : REST refusé');
  }
}

export async function pinnedRequest(
  target: PinnedTarget,
  fingerprint: string,
  timeouts: TransportTimeouts,
  req: PinnedRequest,
): Promise<PinnedResponse> {
  const socket = await connectPinned(target, fingerprint, timeouts);
  return send(socket, target, timeouts, req);
}

function connectPinned(
  target: PinnedTarget,
  fingerprint: string,
  timeouts: TransportTimeouts,
): Promise<TLSSocket> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const socket = tlsConnect({
      host: target.host,
      port: target.port,
      // Remplacé par l'épinglage ci-dessous (aucune AC ne signe le certificat RouterOS).
      rejectUnauthorized: false,
    });
    const timer = setTimeout(() => {
      settled = true;
      socket.destroy();
      reject(fromNetworkError(undefined, true));
    }, timeouts.connectMs);
    socket.once('secureConnect', () => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      const der = socket.getPeerCertificate(false).raw as Buffer | undefined;
      const presented = der ? createHash('sha256').update(der).digest('hex') : '';
      if (presented !== fingerprint) {
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

function send(
  socket: TLSSocket,
  target: PinnedTarget,
  timeouts: TransportTimeouts,
  input: PinnedRequest,
): Promise<PinnedResponse> {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (error: RouterOsError | null, value?: PinnedResponse) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else if (value) resolve(value);
    };
    const timer = setTimeout(() => {
      finish(fromNetworkError(undefined, true));
    }, timeouts.requestMs);
    const headers: Record<string, string> = {
      authorization: input.authorization,
      accept: 'application/json',
    };
    if (input.body !== undefined) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = String(Buffer.byteLength(input.body, 'utf8'));
    }
    const req = request({
      host: target.host,
      port: target.port,
      method: input.method,
      path: input.path,
      headers,
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
    req.end(input.body);
  });
}
