import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { SecretBox } from '../../auth/crypto/secret-box.js';
import { decryptRouterConfigPassword, decryptRouterPassword } from '../router-secret.js';
import { parseTunnelNetwork } from '../tunnel-ip.js';
import {
  ActivationServer,
  type ActivationStore,
  type ConfigActivationStore,
  hashConfigToken,
  parseActivation,
  parseConfigActivation,
} from './activation-server.js';

const network = parseTunnelNetwork('10.200.0.0/24', '10.200.0.1');
const box = new SecretBox(randomBytes(32).toString('base64'), { id: 'k2' });
const PASSWORD = 'devonly-motdepasse-routeur-0123456';
const FP = 'ab'.repeat(32);
const ROUTER = {
  routerId: '0199b000-0000-7000-8000-000000000001',
  companyId: '0199b000-0000-7000-8000-0000000000aa',
};

function fakeStore(initial: Record<string, typeof ROUTER>) {
  const pending = new Map(Object.entries(initial));
  const activated: Parameters<ActivationStore['activate']>[0][] = [];
  const denied: string[] = [];
  const store: ActivationStore = {
    target: (ip) => Promise.resolve(pending.get(ip) ?? null),
    activate: (input) => {
      activated.push(input);
      const ip = [...pending].find(([, r]) => r.routerId === input.routerId)?.[0];
      if (ip) pending.delete(ip);
      return Promise.resolve(Boolean(ip));
    },
    denied: (ip, reason) => {
      denied.push(`${ip} ${reason}`);
      return Promise.resolve();
    },
  };
  return { store, activated, denied };
}

async function call(
  server: ActivationServer,
  source: string,
  body: unknown,
  { method = 'POST', url = '/activate', type = 'application/json' } = {},
) {
  const req = new PassThrough() as unknown as IncomingMessage & PassThrough;
  Object.assign(req, {
    method,
    url,
    headers: { 'content-type': type },
    socket: { remoteAddress: source },
  });
  let status = 0;
  let payload = '';
  const res = {
    headersSent: false,
    writeHead(code: number) {
      status = code;
      res.headersSent = true;
      return res;
    },
    end(data: string) {
      payload = data;
    },
  };
  const done = server.handle(req, res as unknown as ServerResponse);
  req.end(typeof body === 'string' ? body : JSON.stringify(body));
  await done;
  return { status, payload };
}

const logger = { log: () => undefined, warn: () => undefined };
const valid = { user: 'ecsi-svc', password: PASSWORD, tlsFingerprint: FP.toUpperCase() };

describe('activation par le tunnel (agent passerelle)', () => {
  it('active le routeur PROVISIONING de l’adresse source, mot de passe chiffré lié au routeur', async () => {
    const f = fakeStore({ '10.200.0.3': { ...ROUTER } });
    const server = new ActivationServer(f.store, box, network, logger);
    const response = await call(server, '::ffff:10.200.0.3', valid);
    expect(response.status).toBe(200);
    expect(response.payload).not.toContain(PASSWORD);
    const [input] = f.activated;
    expect(input?.tlsFingerprint).toBe(FP);
    expect(input?.passwordEncrypted).toMatch(/^v2:k2:/);
    expect(input?.passwordEncrypted).not.toContain(PASSWORD);
    expect(decryptRouterPassword(box, ROUTER, input?.passwordEncrypted ?? '')).toBe(PASSWORD);
    // Une seule fois : un second appel est refusé.
    expect((await call(server, '10.200.0.3', valid)).status).toBe(409);
    expect(f.denied).toEqual(['10.200.0.3 NOT_PROVISIONING']);
  });

  it.each([
    ['203.0.113.7', 'IP publique'],
    ['10.200.0.1', 'passerelle'],
    ['127.0.0.1', 'boucle locale'],
    ['10.0.0.5', 'réseau du cloud'],
  ])('refuse une source hors tunnel : %s (%s)', async (source) => {
    const f = fakeStore({ [source]: { ...ROUTER } });
    const server = new ActivationServer(f.store, box, network, logger);
    expect((await call(server, source, valid)).status).toBe(403);
    expect(f.activated).toEqual([]);
  });

  it('refuse une adresse tunnel sans routeur en attente (autre routeur, déjà actif)', async () => {
    const f = fakeStore({ '10.200.0.3': { ...ROUTER } });
    const server = new ActivationServer(f.store, box, network, logger);
    expect((await call(server, '10.200.0.4', valid)).status).toBe(409);
    expect(f.activated).toEqual([]);
    expect(f.denied).toEqual(['10.200.0.4 NOT_PROVISIONING']);
  });

  it('refuse les requêtes invalides et ne journalise jamais le mot de passe', async () => {
    const f = fakeStore({ '10.200.0.3': { ...ROUTER } });
    const warnings: string[] = [];
    const server = new ActivationServer(f.store, box, network, {
      log: () => undefined,
      warn: (m) => warnings.push(m),
    });
    for (const body of [
      { ...valid, password: 'court' },
      { ...valid, tlsFingerprint: 'pas-hex' },
      { ...valid, user: 'admin; /system/reset' },
      { ...valid, extra: 1 },
      '{pas du json',
    ]) {
      expect((await call(server, '10.200.0.3', body)).status).toBe(400);
    }
    expect((await call(server, '10.200.0.3', valid, { type: 'text/plain' })).status).toBe(400);
    expect((await call(server, '10.200.0.3', valid, { method: 'GET' })).status).toBe(404);
    expect(f.activated).toEqual([]);
    expect(warnings.join('\n')).not.toContain(PASSWORD);
  });

  it('limite les tentatives par adresse', async () => {
    const f = fakeStore({});
    const server = new ActivationServer(f.store, box, network, logger, () => 1_000);
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) statuses.push((await call(server, '10.200.0.7', valid)).status);
    expect(statuses.slice(0, 10).every((s) => s === 409)).toBe(true);
    expect(statuses.slice(10)).toEqual([429, 429]);
  });

  it('schéma strict du corps', () => {
    expect(parseActivation({ ...valid, tlsFingerprint: FP.match(/../g)?.join(':') })).toEqual({
      username: 'ecsi-svc',
      password: PASSWORD,
      tlsFingerprint: FP,
    });
    expect(parseActivation({ ...valid, password: `${PASSWORD}\n` })).toBeNull();
    expect(parseActivation([valid])).toBeNull();
  });

  it('port déjà occupé sur toutes les adresses : erreur explicite, sans écoute partielle', async () => {
    const squatter: Server = createServer();
    await new Promise<void>((resolve) => squatter.listen(0, '0.0.0.0', resolve));
    const address = squatter.address();
    if (address === null || typeof address === 'string') throw new Error('adresse inattendue');
    const server = new ActivationServer(fakeStore({}).store, box, network, logger);
    try {
      await expect(server.listen('127.0.0.1', address.port)).rejects.toThrow(
        `Port d'activation 127.0.0.1:${address.port} déjà utilisé`,
      );
      await expect(server.listen('127.0.0.1', address.port)).rejects.toThrow(
        /NGINX_BIND_ADDRESS.*ROUTER_ACTIVATION_PORT/,
      );
    } finally {
      await server.close();
      await new Promise((resolve) => squatter.close(resolve));
    }
  });
});

describe('activation du compte de configuration ecsi-cfg (lot B)', () => {
  const TOKEN = 'T'.repeat(43);
  const CFG_PASSWORD = 'devonly-motdepasse-cfg-0123456789ab';
  const config = { token: TOKEN, user: 'ecsi-cfg', password: CFG_PASSWORD };

  /** Imite app.router_config_target / activate : jeton lié à une adresse source, usage unique. */
  function fakeConfigStore(source: string, token: string) {
    let tokenHash: Buffer | null = hashConfigToken(token);
    const activated: Parameters<ConfigActivationStore['activate']>[0][] = [];
    const denied: string[] = [];
    const store: ConfigActivationStore = {
      target: (ip, hash) => {
        if (ip !== source) {
          return Promise.resolve({ outcome: 'UNKNOWN_SOURCE', routerId: null, companyId: null });
        }
        if (!tokenHash?.equals(hash)) {
          return Promise.resolve({ outcome: 'INVALID_TOKEN', routerId: null, companyId: null });
        }
        return Promise.resolve({ outcome: 'OK', ...ROUTER });
      },
      activate: (input) => {
        activated.push(input);
        const ok = tokenHash?.equals(input.tokenHash) ?? false;
        tokenHash = null;
        return Promise.resolve(ok);
      },
      denied: (ip, reason) => {
        denied.push(`${ip} ${reason}`);
        return Promise.resolve();
      },
    };
    return { store, activated, denied };
  }

  const server = (configStore: ConfigActivationStore | null, warn?: (m: string) => void) =>
    new ActivationServer(
      fakeStore({}).store,
      box,
      network,
      { log: () => undefined, warn: warn ?? (() => undefined) },
      Date.now,
      configStore,
    );

  it('chiffre le mot de passe pour CE routeur (AAD distincte de ecsi-svc), jeton à usage unique', async () => {
    const f = fakeConfigStore('10.200.0.3', TOKEN);
    const s = server(f.store);
    const response = await call(s, '::ffff:10.200.0.3', config, { url: '/activate-config' });
    expect(response.status).toBe(200);
    expect(response.payload).not.toContain(CFG_PASSWORD);
    const [input] = f.activated;
    expect(input?.username).toBe('ecsi-cfg');
    expect(input?.tokenHash.equals(hashConfigToken(TOKEN))).toBe(true);
    expect(input?.passwordEncrypted).toMatch(/^v2:k2:/);
    expect(decryptRouterConfigPassword(box, ROUTER, input?.passwordEncrypted ?? '')).toBe(
      CFG_PASSWORD,
    );
    // Le chiffré du compte d'écriture n'est pas utilisable comme mot de passe ecsi-svc.
    expect(() => decryptRouterPassword(box, ROUTER, input?.passwordEncrypted ?? '')).toThrow();
    // Rejeu du même script : refusé.
    expect((await call(s, '10.200.0.3', config, { url: '/activate-config' })).status).toBe(409);
    expect(f.denied).toEqual(['10.200.0.3 INVALID_TOKEN']);
  });

  it('jeton d’un autre routeur ou source inconnue : 409, rien activé, rien journalisé du secret', async () => {
    const warnings: string[] = [];
    const f = fakeConfigStore('10.200.0.3', TOKEN);
    const s = server(f.store, (m) => warnings.push(m));
    expect((await call(s, '10.200.0.4', config, { url: '/activate-config' })).status).toBe(409);
    expect(
      (
        await call(
          s,
          '10.200.0.3',
          { ...config, token: 'U'.repeat(43) },
          { url: '/activate-config' },
        )
      ).status,
    ).toBe(409);
    expect(f.activated).toEqual([]);
    expect(f.denied).toEqual(['10.200.0.4 UNKNOWN_SOURCE', '10.200.0.3 INVALID_TOKEN']);
    expect(warnings.join('\n')).not.toContain(CFG_PASSWORD);
    expect(warnings.join('\n')).not.toContain(TOKEN);
  });

  it('source hors tunnel refusée, corps strict', async () => {
    const f = fakeConfigStore('203.0.113.7', TOKEN);
    const s = server(f.store);
    expect((await call(s, '203.0.113.7', config, { url: '/activate-config' })).status).toBe(403);
    for (const body of [
      { ...config, user: 'ecsi-svc' },
      { ...config, user: 'admin' },
      { ...config, token: 'court' },
      { ...config, password: 'court' },
      { ...config, password: `${CFG_PASSWORD}\r` },
      { ...config, extra: true },
    ]) {
      expect(parseConfigActivation(body)).toBeNull();
    }
    expect(parseConfigActivation(config)).toEqual({
      token: TOKEN,
      username: 'ecsi-cfg',
      password: CFG_PASSWORD,
    });
    expect(f.activated).toEqual([]);
  });

  it('corps invalide : 400 et refus journalisé en base', async () => {
    const f = fakeConfigStore('10.200.0.3', TOKEN);
    const s = server(f.store);
    expect(
      (await call(s, '10.200.0.3', { ...config, user: 'admin' }, { url: '/activate-config' }))
        .status,
    ).toBe(400);
    expect(f.denied).toEqual(['10.200.0.3 INVALID_BODY']);
  });

  it('agent sans le lot B (pas de magasin) : /activate-config inexistant', async () => {
    const s = server(null);
    expect((await call(s, '10.200.0.3', config, { url: '/activate-config' })).status).toBe(404);
  });
});
