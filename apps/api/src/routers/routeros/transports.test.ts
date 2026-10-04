import { createServer } from 'node:net';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  type FakeServer,
  makeCertificate,
  startFakeApi,
  startFakeRest,
  type TestCertificate,
} from '../../../test/helpers/fake-routeros.js';
import { parseTunnelNetwork } from '../tunnel-ip.js';
import { decodeLength, decodeSentences, encodeLength, encodeSentence } from './api-protocol.js';
import { ApiTransport } from './api-transport.js';
import { RouterOsError } from './errors.js';
import { tunnelTransportFactory } from './factory.js';
import { RestTransport } from './rest-transport.js';

const USER = 'ecsi-cloud';
const PASSWORD = 'S3cret-RouterOS-Pass!';
let server: FakeServer | null = null;
let certificate: TestCertificate;

beforeAll(() => {
  certificate = makeCertificate();
});

afterEach(async () => {
  await server?.close();
  server = null;
});

async function rejection(promise: Promise<unknown>): Promise<RouterOsError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(RouterOsError);
    return error as RouterOsError;
  }
  throw new Error('rejet attendu');
}

describe('protocole API RouterOS (codage documenté)', () => {
  it.each([
    [0, [0x00]],
    [0x7f, [0x7f]],
    [0x80, [0x80, 0x80]],
    [0x3fff, [0xbf, 0xff]],
    [0x4000, [0xc0, 0x40, 0x00]],
    [0x1fffff, [0xdf, 0xff, 0xff]],
    [0x200000, [0xe0, 0x20, 0x00, 0x00]],
    [0xfffffff, [0xef, 0xff, 0xff, 0xff]],
    [0x10000000, [0xf0, 0x10, 0x00, 0x00, 0x00]],
  ])('longueur %i', (length, bytes) => {
    const encoded = encodeLength(length);
    expect([...encoded]).toEqual(bytes);
    expect(decodeLength(encoded, 0)).toEqual([length, bytes.length]);
  });

  it('découpe des phrases arrivées par morceaux', () => {
    const data = Buffer.concat([
      encodeSentence(['!re', `=name=${'x'.repeat(200)}`]),
      encodeSentence(['!done']),
    ]);
    const partial = decodeSentences(data.subarray(0, 50));
    expect(partial.sentences).toEqual([]);
    expect(partial.consumed).toBe(0);
    const full = decodeSentences(data);
    expect(full.sentences).toEqual([['!re', `=name=${'x'.repeat(200)}`], ['!done']]);
    expect(full.consumed).toBe(data.length);
  });
});

describe('transport API (TCP 8728) contre un faux service', () => {
  it('se connecte et lit en print avec .proplist, sans aucune commande d’écriture', async () => {
    server = await startFakeApi({ username: USER, password: PASSWORD });
    const api = await ApiTransport.open(
      { host: '127.0.0.1', port: server.port },
      { username: USER, password: PASSWORD },
    );
    const [resource] = await api.print('system/resource');
    expect(resource?.version).toBe('7.23.7 (long-term)');
    const interfaces = await api.print('interface', ['name', 'running']);
    expect(interfaces.map((i) => i.name)).toEqual(['ether1', 'wg-ecsi']);
    await api.close();
    expect(server.received).toEqual(['/login', '/system/resource/print', '/interface/print']);
    expect(server.raw()).toContain('=.proplist=name,running');
  });

  it('identifiants refusés : AUTH, sans le mot de passe dans le message', async () => {
    server = await startFakeApi({ username: USER, password: 'autre-mot-de-passe' });
    const error = await rejection(
      ApiTransport.open(
        { host: '127.0.0.1', port: server.port },
        { username: USER, password: PASSWORD },
      ),
    );
    expect(error.code).toBe('AUTH');
    expect(error.message).toContain('invalid user name or password');
    expect(error.message).not.toContain(PASSWORD);
  });

  it('erreur RouterOS sur une commande : API_ERROR', async () => {
    server = await startFakeApi({ username: USER, password: PASSWORD });
    const api = await ApiTransport.open(
      { host: '127.0.0.1', port: server.port },
      { username: USER, password: PASSWORD },
    );
    const error = await rejection(api.print('system/health'));
    expect(error.code).toBe('API_ERROR');
    await api.close();
  });

  it('port fermé : SERVICE_UNAVAILABLE (l’hôte répond, tunnel actif)', async () => {
    const probe = createServer();
    const port = await new Promise<number>((resolve) => {
      probe.listen(0, '127.0.0.1', () => {
        const a = probe.address();
        resolve(typeof a === 'object' && a ? a.port : 0);
      });
    });
    await new Promise((resolve) => probe.close(resolve));
    const error = await rejection(
      ApiTransport.open({ host: '127.0.0.1', port }, { username: USER, password: PASSWORD }),
    );
    expect(error.code).toBe('SERVICE_UNAVAILABLE');
    expect(error.unreachable).toBe(false);
  });

  it('service muet : UNREACHABLE après le délai', async () => {
    const silent = createServer(() => undefined);
    const port = await new Promise<number>((resolve) => {
      silent.listen(0, '127.0.0.1', () => {
        const a = silent.address();
        resolve(typeof a === 'object' && a ? a.port : 0);
      });
    });
    try {
      const error = await rejection(
        ApiTransport.open(
          { host: '127.0.0.1', port },
          { username: USER, password: PASSWORD },
          { connectMs: 500, requestMs: 300 },
        ),
      );
      expect(error.code).toBe('UNREACHABLE');
    } finally {
      silent.close();
    }
  });
});

describe('transport REST HTTPS épinglé contre un faux service', () => {
  it('lit les menus quand l’empreinte correspond (GET seulement)', async () => {
    server = await startFakeRest({ username: USER, password: PASSWORD, certificate });
    const rest = new RestTransport(
      { host: '127.0.0.1', port: server.port },
      certificate.fingerprint,
      {
        username: USER,
        password: PASSWORD,
      },
    );
    const [identity] = await rest.print('system/identity');
    expect(identity?.name).toBe('chr-lab');
    const interfaces = await rest.print('interface', ['name', 'type']);
    expect(interfaces).toHaveLength(2);
    expect(server.received).toEqual([
      'GET /rest/system/identity',
      'GET /rest/interface?.proplist=name,type',
    ]);
  });

  it('certificat différent : TLS_PINNING, AUCUNE requête (ni identifiants) envoyée', async () => {
    server = await startFakeRest({ username: USER, password: PASSWORD, certificate });
    const other = makeCertificate();
    const rest = new RestTransport({ host: '127.0.0.1', port: server.port }, other.fingerprint, {
      username: USER,
      password: PASSWORD,
    });
    const error = await rejection(rest.print('system/identity'));
    expect(error.code).toBe('TLS_PINNING');
    expect(server.received).toEqual([]);
  });

  it('refuse de fonctionner sans empreinte', () => {
    expect(
      () =>
        new RestTransport({ host: '127.0.0.1', port: 443 }, '', {
          username: USER,
          password: PASSWORD,
        }),
    ).toThrow(RouterOsError);
  });

  it('HTTP 401 : AUTH sans fuite du mot de passe', async () => {
    server = await startFakeRest({ username: USER, password: 'autre', certificate });
    const rest = new RestTransport(
      { host: '127.0.0.1', port: server.port },
      certificate.fingerprint,
      {
        username: USER,
        password: PASSWORD,
      },
    );
    const error = await rejection(rest.print('system/resource'));
    expect(error.code).toBe('AUTH');
    expect(error.message).not.toContain(PASSWORD);
    expect(error.message).not.toContain(Buffer.from(PASSWORD).toString('base64'));
  });

  it('erreur RouterOS (400) : API_ERROR avec le message nettoyé', async () => {
    server = await startFakeRest({ username: USER, password: PASSWORD, certificate });
    const rest = new RestTransport(
      { host: '127.0.0.1', port: server.port },
      certificate.fingerprint,
      {
        username: USER,
        password: PASSWORD,
      },
    );
    const error = await rejection(rest.print('system/health'));
    expect(error.code).toBe('API_ERROR');
    expect(error.message).toContain('HTTP 400');
  });
});

describe('fabrique de transport : seule l’adresse tunnel est contactée', () => {
  const factory = tunnelTransportFactory(parseTunnelNetwork('10.200.0.0/24', '10.200.0.1'), {
    connectMs: 200,
    requestMs: 200,
  });

  it.each(['127.0.0.1', '8.8.8.8', '192.168.88.1', '10.200.0.1', '169.254.169.254'])(
    'refuse %s avant toute connexion (CONFIG)',
    async (ip) => {
      const error = await rejection(
        factory(
          { transport: 'API', tunnelIp: ip, tlsFingerprint: null },
          { username: USER, password: PASSWORD },
        ),
      );
      expect(error.code).toBe('CONFIG');
    },
  );

  it('refuse le REST sans empreinte', async () => {
    const error = await rejection(
      factory(
        { transport: 'REST_HTTPS', tunnelIp: '10.200.0.2', tlsFingerprint: null },
        { username: USER, password: PASSWORD },
      ),
    );
    expect(error.code).toBe('TLS_PINNING');
  });
});
