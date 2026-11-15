import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  type FakeRestStore,
  makeCertificate,
  startFakeRestStore,
  type TestCertificate,
} from '../../../test/helpers/fake-routeros.js';
import { parseTunnelNetwork } from '../tunnel-ip.js';
import { RouterOsError } from './errors.js';
import {
  assertWritable,
  hotspotObjectName,
  hotspotTag,
  isEcsiOwned,
  RestWriter,
  tunnelWriterFactory,
  type WriterScope,
} from './writer.js';

const USER = 'ecsi-cfg';
const PASSWORD = 'devonly-cfg-test-password-1234';
const HOTSPOT = '01a15492-3257-77fa-973f-0235931d6bdf';
const TAG = `ecsi-cloud:hs:${HOTSPOT}`;
const NAME = 'ecsi-hs-0235931d6bdf';
const SECRET = 'a'.repeat(40);
const network = parseTunnelNetwork('10.200.0.0/24', '10.200.0.1');
const scope: WriterScope = { network, routerTunnelIp: '10.200.0.2' };

let certificate: TestCertificate;
let store: FakeRestStore | null = null;

beforeAll(() => {
  certificate = makeCertificate();
});

afterEach(async () => {
  await store?.close();
  store = null;
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

function refusal(fn: () => void): RouterOsError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(RouterOsError);
    expect((error as RouterOsError).code).toBe('CONFIG');
    return error as RouterOsError;
  }
  throw new Error('refus attendu');
}

async function writer(password = PASSWORD, fingerprint?: string): Promise<RestWriter> {
  store = await startFakeRestStore({ username: USER, password: PASSWORD, certificate });
  return new RestWriter(
    { host: '127.0.0.1', port: store.port },
    fingerprint ?? certificate.fingerprint,
    { username: USER, password },
    scope,
  );
}

describe('marques de propriété', () => {
  it('étiquette et nom réservé dérivés de l’identifiant du Hotspot', () => {
    expect(hotspotTag(HOTSPOT)).toBe(TAG);
    expect(hotspotObjectName(HOTSPOT)).toBe(NAME);
    expect(() => hotspotTag('pas-un-uuid')).toThrow(RouterOsError);
  });

  it('propriété par commentaire, ou par nom pour /ip/hotspot et son profil', () => {
    expect(isEcsiOwned('ip/address', { comment: TAG })).toBe(true);
    expect(isEcsiOwned('ip/address', { comment: 'defconf' })).toBe(false);
    expect(isEcsiOwned('ip/address', { comment: `${TAG} ` })).toBe(false);
    expect(isEcsiOwned('ip/hotspot', { name: NAME })).toBe(true);
    expect(isEcsiOwned('ip/hotspot/profile', { name: 'default' })).toBe(false);
  });
});

describe('liste blanche des écritures (avant tout envoi)', () => {
  it.each([
    ['system/script', { name: 'x', comment: TAG }],
    ['user', { name: 'x', comment: TAG }],
    ['ip/service', { disabled: 'yes', comment: TAG }],
    ['interface/wireguard', { comment: TAG }],
    ['execute', { script: '/system/reboot', comment: TAG }],
  ])('menu %s refusé', (menu, values) => {
    expect(
      refusal(() => {
        assertWritable(menu, values, scope, 'add');
      }).message,
    ).toContain('hors liste blanche');
  });

  it('propriété hors liste refusée', () => {
    refusal(() => {
      assertWritable(
        'ip/address',
        { address: '10.5.50.1/24', network: 'x', comment: TAG },
        scope,
        'add',
      );
    });
    // comment n'existe pas sur /ip/hotspot (CHR 7.24.5) : jamais envoyé.
    refusal(() => {
      assertWritable('ip/hotspot', { name: NAME, comment: TAG }, scope, 'add');
    });
    refusal(() => {
      assertWritable('ip/firewall/nat', { 'to-addresses': '1.2.3.4' }, scope, 'set');
    });
  });

  it.each([
    ['ip/address', { address: '10.200.0.5/24', interface: 'ether2', comment: TAG }],
    ['ip/address', { address: '10.200.0.5/16', interface: 'ether2', comment: TAG }],
    ['ip/address', { address: '10.5.50.1/24', interface: 'ecsi-wg', comment: TAG }],
    ['ip/address', { address: '10.5.50.1/24', interface: 'ECSI-WG', comment: TAG }],
    ['ip/address', { address: '10.5.50.1/8', interface: 'ether2', comment: TAG }],
    ['ip/pool', { name: NAME, ranges: '10.200.0.10-10.200.0.20', comment: TAG }],
    ['ip/dhcp-server', { name: NAME, interface: 'ecsi-wg', comment: TAG }],
    ['ip/dhcp-server/network', { address: '10.5.50.1/24', comment: TAG }],
    ['ip/hotspot', { name: NAME, interface: 'ecsi-wg' }],
    ['ip/hotspot/profile', { name: NAME, 'login-by': 'http-pap' }],
    ['ip/hotspot/profile', { name: NAME, 'login-by': 'http-chap,cookie' }],
    ['ip/hotspot/profile', { name: NAME, 'hotspot-address': '10.200.0.1' }],
    ['radius', { address: '203.0.113.5', comment: TAG }],
    ['radius', { 'src-address': '10.200.0.3', comment: TAG }],
    ['radius', { 'authentication-port': '1645', comment: TAG }],
    ['radius', { 'require-message-auth': 'no', comment: TAG }],
    ['ip/firewall/nat', { chain: 'dstnat', comment: TAG }],
    ['ip/firewall/nat', { 'out-interface': 'ether1', comment: TAG }],
    ['ip/firewall/nat', { 'src-address': '0.0.0.0/0', comment: TAG }],
    ['ip/firewall/filter', { chain: 'input', comment: TAG }],
    ['ip/firewall/filter', { action: 'accept', comment: TAG }],
    ['ip/address', { address: '10.5.50.1/24', interface: 'ether2', comment: 'ecsi-cloud' }],
    ['ip/pool', { name: 'pool1', comment: TAG }],
  ])('valeur refusée : %s %j', (menu, values) => {
    refusal(() => {
      assertWritable(menu, values, scope, 'set');
    });
  });

  it('une valeur de secret refusée n’apparaît jamais dans le message', () => {
    const bad = 'Secret-Visible-Nulle-Part';
    const error = refusal(() => {
      assertWritable('radius', { secret: bad }, scope, 'set');
    });
    expect(error.message).not.toContain(bad);
    expect(error.message).toContain('[masqué]');
  });

  it('création : marque ECSI et propriétés obligatoires exigées', () => {
    refusal(() => {
      assertWritable('ip/address', { address: '10.5.50.1/24', interface: 'ether2' }, scope, 'add');
    });
    refusal(() => {
      assertWritable('ip/hotspot', { interface: 'ether2' }, scope, 'add');
    });
    refusal(() => {
      assertWritable(
        'ip/firewall/nat',
        { chain: 'srcnat', action: 'masquerade', 'src-address': '10.5.50.0/24', comment: TAG },
        scope,
        'add',
      );
    });
    refusal(() => {
      assertWritable(
        'radius',
        { service: 'hotspot', address: '10.200.0.1', 'src-address': '10.200.0.2', comment: TAG },
        scope,
        'add',
      );
    });
    expect(() => {
      assertWritable(
        'radius',
        {
          service: 'hotspot',
          address: '10.200.0.1',
          'src-address': '10.200.0.2',
          secret: SECRET,
          comment: TAG,
        },
        scope,
        'add',
      );
    }).not.toThrow();
    expect(() => {
      assertWritable(
        'ip/hotspot/profile',
        { name: NAME, 'login-by': 'http-chap', 'use-radius': 'yes' },
        scope,
        'add',
      );
    }).not.toThrow();
  });
});

describe('RestWriter (faux routeur REST à état, SIMULATION)', () => {
  it('add, set et remove sur un objet étiqueté', async () => {
    const w = await writer();
    const created = await w.add('ip/address', {
      address: '10.5.50.1/24',
      interface: 'ether2',
      comment: TAG,
    });
    const id = created['.id'] ?? '';
    expect(id).toMatch(/^\*[0-9A-F]+$/);
    await w.set('ip/address', id, { address: '10.5.60.1/24' });
    expect(store?.menus.get('ip/address')?.[0]?.address).toBe('10.5.60.1/24');
    const listed = await w.list('ip/address', ['.id', 'address', 'comment']);
    expect(listed).toEqual([{ '.id': id, address: '10.5.60.1/24', comment: TAG }]);
    await w.remove('ip/address', id);
    expect(store?.menus.get('ip/address')).toEqual([]);
    expect(store?.writes()).toEqual([
      'PUT /rest/ip/address',
      `PATCH /rest/ip/address/${id}`,
      `DELETE /rest/ip/address/${id}`,
    ]);
  });

  it('un objet d’un autre propriétaire n’est ni modifié ni supprimé', async () => {
    const w = await writer();
    const lan = store?.seed('ip/address', {
      address: '192.168.88.1/24',
      interface: 'ether2',
      comment: 'defconf',
    });
    const profile = store?.seed('ip/hotspot/profile', { name: 'default', 'login-by': 'cookie' });
    expect(
      (await rejection(w.set('ip/address', lan ?? '', { address: '10.5.50.1/24' }))).code,
    ).toBe('CONFIG');
    expect((await rejection(w.remove('ip/address', lan ?? ''))).message).toContain('intouchable');
    expect(
      (await rejection(w.set('ip/hotspot/profile', profile ?? '', { 'login-by': 'http-chap' })))
        .message,
    ).toContain('intouchable');
    expect(store?.writes()).toEqual([]);
  });

  it('la marque d’un objet ne peut pas être changée ; identifiant invalide refusé', async () => {
    const w = await writer();
    const id = store?.seed('ip/pool', {
      name: NAME,
      ranges: '10.5.50.10-10.5.50.20',
      comment: TAG,
    });
    const other = `ecsi-cloud:hs:${HOTSPOT.slice(0, -1)}0`;
    expect((await rejection(w.set('ip/pool', id ?? '', { comment: other }))).code).toBe('CONFIG');
    expect((await rejection(w.remove('ip/pool', '1; /system/reboot'))).code).toBe('CONFIG');
    expect(store?.writes()).toEqual([]);
  });

  it('le secret est envoyé mais jamais relu ni cité', async () => {
    const w = await writer();
    const created = await w.add('radius', {
      service: 'hotspot',
      address: '10.200.0.1',
      'src-address': '10.200.0.2',
      secret: SECRET,
      comment: TAG,
    });
    expect(created.secret).toBeUndefined();
    expect(store?.secrets.get(`radius/${created['.id'] ?? ''}`)).toBe(SECRET);
  });

  it('lecture limitée aux menus de la liste', async () => {
    const w = await writer();
    await expect(w.list('user' as never, ['name'])).rejects.toThrow(RouterOsError);
    await expect(w.list('interface', [])).rejects.toThrow(RouterOsError);
    expect(store?.received).toEqual([]);
  });

  it('objet disparu : erreur RouterOS (HTTP 404), rien supprimé', async () => {
    const w = await writer();
    const id = store?.seed('ip/pool', { name: NAME, comment: TAG }) ?? '';
    store?.menus.set('ip/pool', []);
    const error = await rejection(w.remove('ip/pool', id));
    expect(error.code).toBe('API_ERROR');
    expect(error.message).toContain('HTTP 404');
  });

  it('identifiants refusés : AUTH, rien écrit', async () => {
    const w = await writer('mauvais-mot-de-passe');
    const error = await rejection(
      w.add('ip/address', { address: '10.5.50.1/24', interface: 'ether2', comment: TAG }),
    );
    expect(error.code).toBe('AUTH');
    expect(store?.menus.get('ip/address')).toEqual([]);
  });

  it('certificat différent de l’empreinte : refus AVANT tout envoi', async () => {
    const w = await writer(PASSWORD, 'f'.repeat(64));
    const error = await rejection(
      w.add('ip/address', { address: '10.5.50.1/24', interface: 'ether2', comment: TAG }),
    );
    expect(error.code).toBe('TLS_PINNING');
    expect(store?.received).toEqual([]);
  });
});

describe('tunnelWriterFactory', () => {
  const factory = tunnelWriterFactory(network);
  const credentials = { username: USER, password: PASSWORD };

  it.each(['10.200.0.1', '10.200.0.0', '10.200.0.255', '127.0.0.1', '192.168.88.1', '010.200.0.2'])(
    'adresse %s refusée',
    (tunnelIp) => {
      expect(() =>
        factory({ tunnelIp, tlsFingerprint: certificate.fingerprint }, credentials),
      ).toThrow(RouterOsError);
    },
  );

  it('empreinte obligatoire (pas de repli)', () => {
    try {
      factory({ tunnelIp: '10.200.0.2', tlsFingerprint: null }, credentials);
      throw new Error('refus attendu');
    } catch (error) {
      expect((error as RouterOsError).code).toBe('TLS_PINNING');
    }
    expect(() => factory({ tunnelIp: '10.200.0.2', tlsFingerprint: 'abc' }, credentials)).toThrow(
      RouterOsError,
    );
  });

  it('adresse tunnel valide : transport créé', () => {
    expect(
      factory({ tunnelIp: '10.200.0.2', tlsFingerprint: certificate.fingerprint }, credentials),
    ).toBeInstanceOf(RestWriter);
  });
});
