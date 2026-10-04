import { connect, type Socket } from 'node:net';
import { decodeSentences, encodeSentence, parseAttribute } from './api-protocol.js';
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

export const API_PORT = 8728;

/**
 * Transport API RouterOS (TCP 8728), documentation officielle « API » :
 *  - connexion « post-v6.43 » : /login =name= =password= ; le mot de passe circule en clair
 *    dans la session API, d'où l'obligation de passer par le tunnel WireGuard (chiffré) et
 *    jamais par Internet (/ip service api limité à la passerelle, validation OVH 7.23.7) ;
 *  - lecture : /<menu>/print avec =.proplist= ; réponses !re (données), !done (fin), !trap
 *    (erreur), !empty (aucune donnée, RouterOS ≥ 7.18), !fatal (connexion fermée).
 * Une commande à la fois (pas de .tag) : la supervision lit les menus l'un après l'autre.
 */
export class ApiTransport implements RouterOsTransport {
  readonly kind = 'API' as const;
  private socket: Socket | null = null;
  private buffer = Buffer.alloc(0);
  private pending: {
    replies: string[][];
    resolve: (replies: string[][]) => void;
    reject: (error: RouterOsError) => void;
  } | null = null;
  private failure: RouterOsError | null = null;

  private constructor(
    private readonly host: string,
    private readonly port: number,
    private readonly timeouts: TransportTimeouts,
  ) {}

  /** Ouvre la connexion et s'authentifie. `host` : adresse tunnel déjà validée. */
  static async open(
    target: { host: string; port: number },
    credentials: RouterOsCredentials,
    timeouts: TransportTimeouts = DEFAULT_TIMEOUTS,
  ): Promise<ApiTransport> {
    const transport = new ApiTransport(target.host, target.port, timeouts);
    await transport.connect();
    try {
      const replies = await transport.command([
        '/login',
        `=name=${credentials.username}`,
        `=password=${credentials.password}`,
      ]);
      const trap = replies.find((reply) => reply[0] === '!trap');
      if (trap) {
        throw new RouterOsError(
          'AUTH',
          `Connexion API refusée : ${sanitizeDetail(attributes(trap).message ?? 'raison inconnue', [credentials.password])}`,
        );
      }
    } catch (error) {
      await transport.close();
      if (error instanceof RouterOsError && error.code === 'SERVICE_UNAVAILABLE') {
        // Connexion coupée pendant l'authentification : RouterOS ferme la session en cas
        // d'échec répété ; on le signale comme un refus d'authentification probable.
        throw new RouterOsError('AUTH', 'Connexion API fermée pendant l’authentification');
      }
      throw error;
    }
    return transport;
  }

  async print(menu: RouterOsMenu, proplist?: readonly string[]): Promise<RouterOsRecord[]> {
    const words = [`/${menu}/print`];
    if (proplist?.length) {
      assertProplist(proplist);
      words.push(`=.proplist=${proplist.join(',')}`);
    }
    const replies = await this.command(words);
    const trap = replies.find((reply) => reply[0] === '!trap');
    if (trap) {
      const message = sanitizeDetail(attributes(trap).message ?? 'erreur inconnue');
      // « not enough permissions » : politique RouterOS manquante pour ce menu.
      throw new RouterOsError(
        /permission/i.test(message) ? 'PERMISSION' : 'API_ERROR',
        `Lecture ${menu} refusée par RouterOS : ${message}`,
      );
    }
    return replies.filter((reply) => reply[0] === '!re').map((reply) => attributes(reply));
  }

  close(): Promise<void> {
    const socket = this.socket;
    this.socket = null;
    if (!socket || socket.destroyed) return Promise.resolve();
    return new Promise((resolve) => {
      socket.once('close', () => {
        resolve();
      });
      socket.destroy();
    });
  }

  private connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = connect({ host: this.host, port: this.port });
      socket.setNoDelay(true);
      let connected = false;
      const timer = setTimeout(() => {
        socket.destroy();
        reject(fromNetworkError(undefined, true));
      }, this.timeouts.connectMs);
      socket.once('connect', () => {
        connected = true;
        clearTimeout(timer);
        this.socket = socket;
        resolve();
      });
      socket.on('data', (chunk: Buffer) => {
        this.onData(chunk);
      });
      socket.on('error', (error) => {
        clearTimeout(timer);
        const failure = fromNetworkError(error, false);
        if (!connected) reject(failure);
        else this.fail(failure);
      });
      socket.on('close', () => {
        this.fail(new RouterOsError('SERVICE_UNAVAILABLE', 'Connexion API fermée par le routeur'));
      });
    });
  }

  private command(words: readonly string[]): Promise<string[][]> {
    if (this.failure) return Promise.reject(this.failure);
    const socket = this.socket;
    if (!socket)
      return Promise.reject(new RouterOsError('SERVICE_UNAVAILABLE', 'Connexion API fermée'));
    if (this.pending) return Promise.reject(new Error('Une commande API est déjà en cours'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending = null;
        socket.destroy();
        reject(fromNetworkError(undefined, true));
      }, this.timeouts.requestMs);
      this.pending = {
        replies: [],
        resolve: (replies) => {
          clearTimeout(timer);
          resolve(replies);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      };
      socket.write(encodeSentence(words));
    });
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (this.buffer.length > MAX_RESPONSE_BYTES) {
      this.fail(new RouterOsError('PROTOCOL', 'Réponse API trop volumineuse'));
      this.socket?.destroy();
      return;
    }
    let decoded: ReturnType<typeof decodeSentences>;
    try {
      decoded = decodeSentences(this.buffer);
    } catch {
      this.fail(new RouterOsError('PROTOCOL', 'Réponse API illisible'));
      this.socket?.destroy();
      return;
    }
    this.buffer = this.buffer.subarray(decoded.consumed);
    for (const sentence of decoded.sentences) {
      const pending = this.pending;
      if (sentence[0] === '!fatal') {
        this.fail(
          new RouterOsError(
            'SERVICE_UNAVAILABLE',
            `Session API fermée par RouterOS : ${sanitizeDetail(sentence.slice(1).join(' '))}`,
          ),
        );
        return;
      }
      if (!pending) continue;
      pending.replies.push(sentence);
      if (sentence[0] === '!done') {
        this.pending = null;
        pending.resolve(pending.replies);
      }
    }
  }

  private fail(error: RouterOsError): void {
    this.failure ??= error;
    const pending = this.pending;
    this.pending = null;
    pending?.reject(error);
  }
}

function attributes(sentence: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const word of sentence.slice(1)) {
    const attribute = parseAttribute(word);
    if (attribute) out[attribute[0]] = attribute[1];
  }
  return out;
}
