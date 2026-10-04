/**
 * Faux services RouterOS pour les tests (SIMULATION, pas un routeur) : ils reproduisent le
 * format documenté et observé sur CHR (réponses REST en texte, protocole API par mots), afin
 * de tester les transports et la supervision sans matériel. Les tests réels sont ceux du
 * laboratoire (lab/routeros) et la validation OVH RouterOS 7.23.7.
 */
import { execFileSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  decodeSentences,
  encodeSentence,
  parseAttribute,
} from '../../src/routers/routeros/api-protocol.js';

export const FAKE_RESOURCE: Record<string, string> = {
  uptime: '1w2d3h4m5s',
  version: '7.23.7 (long-term)',
  'build-time': '2026-01-01 00:00:00',
  'free-memory': '900000000',
  'total-memory': '1073741824',
  cpu: 'QEMU',
  'cpu-count': '2',
  'cpu-load': '7',
  'architecture-name': 'x86_64',
  'board-name': 'CHR QEMU Standard PC (i440FX + PIIX, 1996)',
  platform: 'MikroTik',
};

export const FAKE_INTERFACES: Record<string, string>[] = [
  {
    '.id': '*1',
    name: 'ether1',
    type: 'ether',
    running: 'true',
    disabled: 'false',
    mtu: '1500',
    'mac-address': '0C:00:00:00:00:01',
    'rx-byte': '123456',
    'tx-byte': '654321',
    'link-downs': '0',
  },
  { '.id': '*2', name: 'wg-ecsi', type: 'wg', running: 'true', disabled: 'false', mtu: '1420' },
];

export interface FakeRouterOptions {
  username: string;
  password: string;
  identity?: string;
}

export interface FakeServer {
  readonly port: number;
  /** Commandes reçues (API : premier mot ; REST : méthode et chemin). */
  readonly received: string[];
  /** Tout ce qui a été reçu, brut (recherche de secrets). */
  readonly raw: () => string;
  close(): Promise<void>;
}

function listen(server: Server | HttpsServer): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve(typeof address === 'object' && address ? address.port : 0);
    });
  });
}

/** Faux service API RouterOS (TCP), d'après la documentation officielle du protocole. */
export async function startFakeApi(options: FakeRouterOptions): Promise<FakeServer> {
  const received: string[] = [];
  const raw: Buffer[] = [];
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    let buffer = Buffer.alloc(0);
    let authenticated = false;
    socket.on('data', (chunk: Buffer) => {
      raw.push(chunk);
      buffer = Buffer.concat([buffer, chunk]);
      const { sentences, consumed } = decodeSentences(buffer);
      buffer = buffer.subarray(consumed);
      for (const sentence of sentences) {
        const [command = '', ...words] = sentence;
        received.push(command);
        const attrs = Object.fromEntries(
          words.map((w) => parseAttribute(w)).filter((a): a is [string, string] => a !== null),
        );
        const reply = (...sentencesOut: string[][]) => {
          for (const out of sentencesOut) socket.write(encodeSentence(out));
        };
        if (command === '/login') {
          if (attrs.name === options.username && attrs.password === options.password) {
            authenticated = true;
            reply(['!done']);
          } else {
            reply(['!trap', '=message=invalid user name or password (6)'], ['!done']);
          }
          continue;
        }
        if (!authenticated) {
          reply(['!fatal', 'not logged in']);
          socket.end();
          continue;
        }
        const toWords = (record: Record<string, string>) =>
          Object.entries(record).map(([k, v]) => `=${k}=${v}`);
        switch (command) {
          case '/system/identity/print':
            reply(['!re', ...toWords({ name: options.identity ?? 'chr-ovh' })], ['!done']);
            break;
          case '/system/resource/print':
            reply(['!re', ...toWords(FAKE_RESOURCE)], ['!done']);
            break;
          case '/interface/print':
            reply(...FAKE_INTERFACES.map((i) => ['!re', ...toWords(i)]), ['!done']);
            break;
          default:
            reply(['!trap', '=message=no such command prefix'], ['!done']);
        }
      }
    });
  });
  const port = await listen(server);
  return {
    port,
    received,
    raw: () => Buffer.concat(raw).toString('utf8'),
    close: () =>
      new Promise((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => {
          resolve();
        });
      }),
  };
}

export interface TestCertificate {
  key: string;
  cert: string;
  /** SHA-256 du certificat DER, hexadécimal minuscule (format de routers.tls_fingerprint). */
  fingerprint: string;
}

/** Certificat autosigné de test (openssl), comme le certificat www-ssl d'un routeur. */
export function makeCertificate(): TestCertificate {
  const dir = mkdtempSync(join(tmpdir(), 'ecsi-cert-'));
  try {
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'ec',
        '-pkeyopt',
        'ec_paramgen_curve:prime256v1',
        '-nodes',
        '-keyout',
        join(dir, 'key.pem'),
        '-out',
        join(dir, 'cert.pem'),
        '-days',
        '1',
        '-subj',
        '/CN=router',
      ],
      { stdio: 'ignore' },
    );
    const cert = readFileSync(join(dir, 'cert.pem'), 'utf8');
    return {
      key: readFileSync(join(dir, 'key.pem'), 'utf8'),
      cert,
      fingerprint: new X509Certificate(cert).fingerprint256.replace(/:/g, '').toLowerCase(),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Faux service REST RouterOS (HTTPS, Basic), réponses au format observé sur CHR 7.24.5. */
export async function startFakeRest(
  options: FakeRouterOptions & { certificate: TestCertificate },
): Promise<FakeServer> {
  const received: string[] = [];
  const raw: string[] = [];
  const expected = `Basic ${Buffer.from(`${options.username}:${options.password}`).toString('base64')}`;
  const server = createHttpsServer(
    { key: options.certificate.key, cert: options.certificate.cert },
    (req, res) => {
      received.push(`${req.method ?? ''} ${req.url ?? ''}`);
      raw.push(JSON.stringify(req.headers), req.url ?? '');
      const send = (status: number, body: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      if (req.headers.authorization !== expected) {
        send(401, { error: 401, message: 'Unauthorized' });
        return;
      }
      const path = (req.url ?? '').split('?')[0];
      if (req.method !== 'GET') send(400, { error: 400, message: 'Bad Request' });
      else if (path === '/rest/system/identity') send(200, { name: options.identity ?? 'chr-lab' });
      else if (path === '/rest/system/resource') send(200, FAKE_RESOURCE);
      else if (path === '/rest/interface') send(200, FAKE_INTERFACES);
      else send(400, { detail: 'no such command', error: 400, message: 'Bad Request' });
    },
  );
  const port = await listen(server);
  return {
    port,
    received,
    raw: () => raw.join('\n'),
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
}
