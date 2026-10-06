import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { SecretBox } from '../../auth/crypto/secret-box.js';
import { encryptRouterPassword } from '../router-secret.js';
import { assertRouterTunnelIp, type TunnelNetwork } from '../tunnel-ip.js';

/** Accès base de l'activation : fonctions SECURITY DEFINER de la migration 0006. */
export interface ActivationStore {
  target(tunnelIp: string): Promise<{ routerId: string; companyId: string } | null>;
  activate(input: {
    routerId: string;
    companyId: string;
    username: string;
    passwordEncrypted: string;
    tlsFingerprint: string;
  }): Promise<boolean>;
  denied(tunnelIp: string, reason: ActivationDenial): Promise<void>;
}

export type ActivationDenial =
  'NOT_PROVISIONING' | 'INVALID_BODY' | 'UNKNOWN_SOURCE' | 'RATE_LIMITED';

export interface ActivationLogger {
  log(message: string): void;
  warn(message: string): void;
}

const MAX_BODY = 4096;
const USERNAME = /^[A-Za-z0-9._-]{1,64}$/;
/** Empreinte RouterOS (/certificate fingerprint) : SHA-256 hexadécimal, « : » tolérés. */
const FINGERPRINT = /^[0-9a-f]{64}$/;
const RATE = { limit: 10, windowMs: 60_000 };

/**
 * Activation d'un routeur PAR LE TUNNEL (étape 9 du script, PROTOCOLE-PROVISIONNEMENT.md) :
 * POST http://<passerelle>:8081/activate {user, password, tlsFingerprint}.
 *
 *  - Le serveur n'écoute QUE sur l'adresse tunnel de la passerelle : injoignable d'Internet.
 *  - L'adresse SOURCE identifie le routeur : WireGuard n'accepte de cette adresse que les
 *    paquets signés par la clé enregistrée à l'enrôlement (pair /32).
 *  - Seul un routeur PROVISIONING enrôlé peut s'activer, une seule fois.
 *  - Le mot de passe (tiré au hasard par le routeur) est chiffré aussitôt (AAD liée au
 *    routeur) et n'est jamais journalisé ; la réponse ne contient rien.
 */
export class ActivationServer {
  private server: Server | null = null;
  private readonly hits = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly store: ActivationStore,
    private readonly box: SecretBox,
    private readonly network: TunnelNetwork,
    private readonly logger: ActivationLogger,
    private readonly clock: () => number = Date.now,
  ) {}

  listen(host: string, port: number): Promise<Server> {
    return new Promise((resolve, reject) => {
      const server = createServer((req, res) => {
        this.handle(req, res).catch(() => {
          send(res, 500, 'Erreur interne');
        });
      });
      server.requestTimeout = 10_000;
      server.headersTimeout = 5_000;
      server.once('error', (err: NodeJS.ErrnoException) => {
        reject(err.code === 'EADDRINUSE' ? new Error(addressInUseMessage(host, port)) : err);
      });
      server.listen(port, host, () => {
        this.server = server;
        resolve(server);
      });
    });
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.server) {
        resolve();
        return;
      }
      this.server.close(() => {
        resolve();
      });
      this.server = null;
    });
  }

  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const source = (req.socket.remoteAddress ?? '').replace(/^::ffff:/, '');
    let tunnelIp: string;
    try {
      tunnelIp = assertRouterTunnelIp(source, this.network);
    } catch {
      req.resume();
      send(res, 403, 'Source refusée');
      return;
    }
    if (req.method !== 'POST' || (req.url ?? '').split('?')[0] !== '/activate') {
      req.resume();
      send(res, 404, 'Introuvable');
      return;
    }
    if (!this.allow(tunnelIp)) {
      req.resume();
      await this.store.denied(tunnelIp, 'RATE_LIMITED');
      send(res, 429, 'Trop de tentatives');
      return;
    }
    const target = await this.store.target(tunnelIp);
    if (!target) {
      req.resume();
      await this.store.denied(tunnelIp, 'NOT_PROVISIONING');
      this.logger.warn(`Activation refusée depuis ${tunnelIp} : aucun routeur en attente`);
      send(res, 409, 'Aucun routeur en attente d’activation à cette adresse');
      return;
    }
    const body = await readJson(req);
    const parsed = body ? parseActivation(body) : null;
    if (!parsed) {
      await this.store.denied(tunnelIp, 'INVALID_BODY');
      this.logger.warn(`Activation refusée depuis ${tunnelIp} : requête invalide`);
      send(res, 400, 'Requête invalide');
      return;
    }
    const activated = await this.store.activate({
      routerId: target.routerId,
      companyId: target.companyId,
      username: parsed.username,
      passwordEncrypted: encryptRouterPassword(
        this.box,
        { companyId: target.companyId, routerId: target.routerId },
        parsed.password,
      ),
      tlsFingerprint: parsed.tlsFingerprint,
    });
    if (!activated) {
      await this.store.denied(tunnelIp, 'NOT_PROVISIONING');
      send(res, 409, 'Aucun routeur en attente d’activation à cette adresse');
      return;
    }
    this.logger.log(`Routeur ${target.routerId} activé depuis ${tunnelIp}`);
    send(res, 200, 'Activé');
  }

  private allow(ip: string): boolean {
    const now = this.clock();
    const entry = this.hits.get(ip);
    if (!entry || entry.resetAt <= now) {
      this.hits.set(ip, { count: 1, resetAt: now + RATE.windowMs });
      return true;
    }
    entry.count += 1;
    return entry.count <= RATE.limit;
  }
}

/** Corps strict : user, password (20 à 256, sans caractère de contrôle), tlsFingerprint. */
export function parseActivation(
  body: unknown,
): { username: string; password: string; tlsFingerprint: string } | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const record = body as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.join(',') !== 'password,tlsFingerprint,user') return null;
  const { user, password, tlsFingerprint } = record;
  if (typeof user !== 'string' || !USERNAME.test(user)) return null;
  if (typeof password !== 'string' || password.length < 20 || password.length > 256) return null;
  if (/\p{Cc}/u.test(password)) return null;
  if (typeof tlsFingerprint !== 'string') return null;
  const fingerprint = tlsFingerprint.toLowerCase().replace(/:/g, '');
  if (!FINGERPRINT.test(fingerprint)) return null;
  return { username: user, password, tlsFingerprint: fingerprint };
}

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    const type = req.headers['content-type'] ?? '';
    if (!/^application\/json(;|$)/i.test(type)) {
      req.resume();
      resolve(null);
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        done = true;
        req.destroy();
        resolve(null);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (done) return;
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        resolve(null);
      }
    });
    req.on('error', () => {
      resolve(null);
    });
  });
}

function send(res: ServerResponse, status: number, message: string): void {
  if (res.headersSent) return;
  res.writeHead(status, { 'content-type': 'application/json', connection: 'close' });
  res.end(JSON.stringify({ status, message }));
}

/**
 * Un port publié par Docker sur 0.0.0.0 (Nginx du Compose : 8080, 8081) occupe aussi l'adresse
 * tunnel de l'hôte : l'agent ne peut alors pas écouter dessus (constaté en CI, S3B-RC2).
 */
export function addressInUseMessage(host: string, port: number): string {
  return (
    `Port d'activation ${host}:${port} déjà utilisé. Un service de la même machine écoute sur ` +
    `toutes les adresses (0.0.0.0:${port}), par exemple Nginx du Compose publié sans adresse : ` +
    `fixez NGINX_BIND_ADDRESS (127.0.0.1 ou l'adresse publique) ou changez ROUTER_ACTIVATION_PORT.`
  );
}
