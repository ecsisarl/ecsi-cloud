import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  type FakeRestStore,
  makeCertificate,
  startFakeRestStore,
  type TestCertificate,
} from '../../../test/helpers/fake-routeros.js';
import { RouterOsError } from '../routeros/errors.js';
import { RestWriter, type RouterOsWriter } from '../routeros/writer.js';
import { parseTunnelNetwork } from '../tunnel-ip.js';
import { desiredObjects, type HotspotSpec } from './desired.js';
import { natNeeded, PreconditionError, reconcileHotspot } from './reconcile.js';

/**
 * Réconciliation contre un faux routeur REST à état (SIMULATION ; le même scénario a été joué
 * sur CHR 7.24.5 : lab/routeros/resultats/2026-10-19-lot-b-provisioning.md). Toutes les
 * écritures passent par le vrai RestWriter, donc par sa liste blanche.
 */

const USER = 'ecsi-cfg';
const PASSWORD = 'devonly-cfg-test-password-1234';
const HOTSPOT = '01a15492-3257-77fa-973f-0235931d6bdf';
const TAG = `ecsi-cloud:hs:${HOTSPOT}`;
const NAME = 'ecsi-hs-0235931d6bdf';
const network = parseTunnelNetwork('10.200.0.0/24', '10.200.0.1');

const spec: HotspotSpec = {
  hotspotId: HOTSPOT,
  interface: 'ether2',
  gatewayAddress: '10.5.50.1/24',
  poolStart: '10.5.50.10',
  poolEnd: '10.5.50.200',
  dnsName: 'wifi.ecsi.lan',
  radiusServer: '10.200.0.1',
  routerTunnelIp: '10.200.0.2',
  radiusSecret: 'b'.repeat(40),
};

let certificate: TestCertificate;
let store: FakeRestStore;
let writer: RestWriter;

beforeAll(() => {
  certificate = makeCertificate();
});

beforeEach(async () => {
  store = await startFakeRestStore({ username: USER, password: PASSWORD, certificate });
  // Routeur après enrôlement (export observé sur CHR au lot B, simplifié).
  store.seed('interface', { name: 'ether1', type: 'ether' });
  store.seed('interface', { name: 'ether2', type: 'ether' });
  store.seed('interface', { name: 'ether3', type: 'ether' });
  store.seed('interface', { name: 'ecsi-wg', type: 'wg' });
  store.seed('ip/route', {
    'dst-address': '0.0.0.0/0',
    gateway: '192.168.88.1',
    'immediate-gw': '192.168.88.1%ether1',
    active: 'true',
  });
  store.seed('ip/address', { address: '192.168.88.11/24', interface: 'ether1', dynamic: 'false' });
  store.seed('ip/address', {
    address: '10.200.0.2/24',
    interface: 'ecsi-wg',
    comment: 'ecsi-cloud',
    dynamic: 'false',
  });
  store.seed('ip/firewall/filter', {
    chain: 'input',
    action: 'accept',
    'in-interface': 'ecsi-wg',
    comment: 'ecsi-cloud: API REST depuis la passerelle',
  });
  writer = new RestWriter(
    { host: '127.0.0.1', port: store.port },
    certificate.fingerprint,
    { username: USER, password: PASSWORD },
    { network, routerTunnelIp: spec.routerTunnelIp },
  );
});

afterEach(async () => {
  await store.close();
});

const tagged = (menu: string) =>
  (store.menus.get(menu) ?? []).filter((r) => r.comment === TAG || r.name === NAME);

async function precondition(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(PreconditionError);
    return (error as Error).message;
  }
  throw new Error('refus attendu');
}

describe('réconciliation Hotspot', () => {
  it('depuis zéro : 9 objets créés, contenu voulu', async () => {
    const report = await reconcileHotspot(writer, spec, true);
    expect(report).toMatchObject({ added: 9, updated: 0, removed: 0 });
    expect(tagged('ip/address')).toEqual([
      expect.objectContaining({ address: '10.5.50.1/24', interface: 'ether2' }),
    ]);
    expect(tagged('ip/pool')).toEqual([
      expect.objectContaining({ name: NAME, ranges: '10.5.50.10-10.5.50.200' }),
    ]);
    expect(tagged('ip/dhcp-server/network')).toEqual([
      expect.objectContaining({
        address: '10.5.50.0/24',
        gateway: '10.5.50.1',
        'dns-server': '10.5.50.1',
      }),
    ]);
    expect(tagged('radius')).toEqual([
      expect.objectContaining({
        service: 'hotspot',
        address: '10.200.0.1',
        'src-address': '10.200.0.2',
        'authentication-port': '1812',
        'accounting-port': '1813',
      }),
    ]);
    expect(tagged('ip/hotspot/profile')).toEqual([
      expect.objectContaining({
        'login-by': 'http-chap',
        'use-radius': 'true',
        'dns-name': 'wifi.ecsi.lan',
        'hotspot-address': '10.5.50.1',
      }),
    ]);
    expect(tagged('ip/hotspot')).toEqual([
      expect.objectContaining({ interface: 'ether2', profile: NAME, 'address-pool': NAME }),
    ]);
    expect(tagged('ip/firewall/nat')).toEqual([
      expect.objectContaining({
        chain: 'srcnat',
        action: 'masquerade',
        'src-address': '10.5.50.0/24',
        'out-interface': '!ecsi-wg',
      }),
    ]);
    expect(tagged('ip/firewall/filter')).toEqual([
      expect.objectContaining({ chain: 'forward', action: 'drop', 'out-interface': 'ecsi-wg' }),
    ]);
    const radiusId = tagged('radius')[0]?.['.id'] ?? '';
    expect(store.secrets.get(`radius/${radiusId}`)).toBe(spec.radiusSecret);
    // Ordre d'application : adresse, pool, réseau DHCP, serveur DHCP, RADIUS, profil, Hotspot.
    expect(store.writes()).toEqual([
      'PUT /rest/ip/address',
      'PUT /rest/ip/pool',
      'PUT /rest/ip/dhcp-server/network',
      'PUT /rest/ip/dhcp-server',
      'PUT /rest/radius',
      'PUT /rest/ip/hotspot/profile',
      'PUT /rest/ip/hotspot',
      'PUT /rest/ip/firewall/nat',
      'PUT /rest/ip/firewall/filter',
    ]);
  });

  it('idempotente : seconde passe = seul le secret illisible est réaffirmé', async () => {
    await reconcileHotspot(writer, spec, true);
    const before = JSON.stringify([...store.menus]);
    const report = await reconcileHotspot(writer, spec, true);
    expect(report).toMatchObject({ added: 0, updated: 1, removed: 0 });
    expect(report.actions).toEqual([
      expect.objectContaining({ kind: 'set', menu: 'radius', props: ['secret'] }),
    ]);
    expect(JSON.stringify([...store.menus])).toBe(before);
  });

  it('masquerade générale existante : pas de NAT ajouté', async () => {
    store.seed('ip/firewall/nat', {
      chain: 'srcnat',
      action: 'masquerade',
      'out-interface': 'ether1',
      disabled: 'false',
      dynamic: 'false',
    });
    const report = await reconcileHotspot(writer, spec, true);
    expect(report.added).toBe(8);
    expect(tagged('ip/firewall/nat')).toEqual([]);
  });

  it('changement de réseau : modifications en place, rien recréé', async () => {
    await reconcileHotspot(writer, spec, true);
    const ids = tagged('ip/address').map((r) => r['.id']);
    const report = await reconcileHotspot(
      writer,
      { ...spec, gatewayAddress: '10.5.60.1/24', poolStart: '10.5.60.10', poolEnd: '10.5.60.200' },
      true,
    );
    expect(report).toMatchObject({ added: 0, updated: 7, removed: 0 });
    expect(tagged('ip/address').map((r) => r['.id'])).toEqual(ids);
    expect(tagged('ip/address')[0]?.address).toBe('10.5.60.1/24');
    expect(tagged('ip/firewall/filter')[0]?.['src-address']).toBe('10.5.60.0/24');
  });

  it('dérive corrigée (login-by modifié à la main)', async () => {
    await reconcileHotspot(writer, spec, true);
    const profile = tagged('ip/hotspot/profile')[0];
    if (profile) profile['login-by'] = 'http-pap,cookie';
    const report = await reconcileHotspot(writer, spec, true);
    expect(report.actions).toContainEqual(
      expect.objectContaining({ kind: 'set', menu: 'ip/hotspot/profile', props: ['login-by'] }),
    );
    expect(tagged('ip/hotspot/profile')[0]?.['login-by']).toBe('http-chap');
  });

  it('doublon étiqueté supprimé', async () => {
    await reconcileHotspot(writer, spec, true);
    store.seed('ip/pool', { name: 'autre', ranges: '10.5.50.201-10.5.50.210', comment: TAG });
    const report = await reconcileHotspot(writer, spec, true);
    expect(report.removed).toBe(1);
    expect(tagged('ip/pool')).toHaveLength(1);
  });

  it('désactivation : tout retiré dans l’ordre inverse, le reste intact', async () => {
    const foreignPool = store.seed('ip/pool', {
      name: 'dhcp_pool1',
      ranges: '192.168.88.10-192.168.88.20',
    });
    await reconcileHotspot(writer, spec, true);
    const writesBefore = store.writes().length;
    const report = await reconcileHotspot(writer, spec, false);
    expect(report).toMatchObject({ added: 0, updated: 0, removed: 9 });
    const removals = store.writes().slice(writesBefore);
    expect(removals.map((line) => line.replace(/\/\*[0-9A-F]+$/, ''))).toEqual([
      'DELETE /rest/ip/firewall/filter',
      'DELETE /rest/ip/firewall/nat',
      'DELETE /rest/ip/hotspot',
      'DELETE /rest/ip/hotspot/profile',
      'DELETE /rest/radius',
      'DELETE /rest/ip/dhcp-server',
      'DELETE /rest/ip/dhcp-server/network',
      'DELETE /rest/ip/pool',
      'DELETE /rest/ip/address',
    ]);
    for (const menu of store.menus.keys()) expect(tagged(menu)).toEqual([]);
    expect(store.menus.get('ip/pool')?.map((r) => r['.id'])).toEqual([foreignPool]);
    expect(store.menus.get('ip/address')).toHaveLength(2);
    expect(store.menus.get('ip/firewall/filter')).toHaveLength(1);
    // Déjà retiré : rien à faire.
    expect(await reconcileHotspot(writer, spec, false)).toMatchObject({ removed: 0 });
  });

  it('confirmation : une écriture ignorée par le routeur est détectée', async () => {
    const lossy: RouterOsWriter = {
      list: (menu, props) => writer.list(menu, props),
      add: (menu, values) =>
        menu === 'ip/pool' ? Promise.resolve({ '.id': '*FFFF' }) : writer.add(menu, values),
      set: (menu, id, values) => writer.set(menu, id, values),
      remove: (menu, id) => writer.remove(menu, id),
    };
    const error = await reconcileHotspot(lossy, spec, true).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RouterOsError);
    expect((error as RouterOsError).message).toContain('non confirmée');
    expect((error as RouterOsError).message).not.toContain(spec.radiusSecret);
  });
});

describe('contrôles préalables (rien n’est écrit)', () => {
  const cases: [string, Partial<HotspotSpec>, (() => void) | null, string][] = [
    ['WAN', { interface: 'ether1' }, null, 'route par défaut'],
    ['tunnel', { interface: 'ecsi-wg' }, null, 'tunnel de gestion'],
    ['absente', { interface: 'ether9' }, null, 'absente'],
    [
      'déjà adressée',
      {},
      () => store.seed('ip/address', { address: '192.168.50.1/24', interface: 'ether2' }),
      'déjà adressée',
    ],
    [
      'chevauchement',
      {},
      () => store.seed('ip/address', { address: '10.5.0.1/16', interface: 'ether3' }),
      'chevauche',
    ],
    [
      'chevauchement du tunnel',
      { gatewayAddress: '10.200.0.1/16', poolStart: '10.200.1.10', poolEnd: '10.200.1.20' },
      null,
      'chevauche',
    ],
    [
      'serveur DHCP',
      {},
      () => store.seed('ip/dhcp-server', { name: 'dhcp1', interface: 'ether2' }),
      'serveur DHCP',
    ],
    [
      'Hotspot existant',
      {},
      () => store.seed('ip/hotspot', { name: 'hotspot1', interface: 'ether2' }),
      'Hotspot existant',
    ],
    [
      'client RADIUS',
      {},
      () => store.seed('radius', { service: 'ppp,hotspot', address: '192.0.2.1' }),
      'RADIUS',
    ],
    [
      'nom pris',
      {},
      () => store.seed('ip/pool', { name: NAME, ranges: '172.16.0.10-172.16.0.20' }),
      'déjà pris',
    ],
  ];

  it.each(cases)('%s', async (_label, override, setup, message) => {
    setup?.();
    const before = JSON.stringify([...store.menus]);
    expect(await precondition(reconcileHotspot(writer, { ...spec, ...override }, true))).toContain(
      message,
    );
    expect(store.writes()).toEqual([]);
    expect(JSON.stringify([...store.menus])).toBe(before);
  });

  it('WAN reconnu par la passerelle immédiate (route par interface)', async () => {
    store.seed('ip/route', { 'dst-address': '0.0.0.0/0', gateway: 'ether3', active: 'true' });
    expect(
      await precondition(reconcileHotspot(writer, { ...spec, interface: 'ether3' }, true)),
    ).toContain('WAN');
  });

  it('désactivation sans contrôle préalable (retrait toujours possible)', async () => {
    store.seed('ip/address', { address: '10.5.50.1/24', interface: 'ether2', comment: TAG });
    expect(await reconcileHotspot(writer, { ...spec, interface: 'ether1' }, false)).toMatchObject({
      removed: 1,
    });
  });
});

describe('natNeeded et objets voulus', () => {
  it('masquerade restreinte, désactivée ou dynamique : NAT nécessaire', () => {
    expect(natNeeded([], HOTSPOT)).toBe(true);
    expect(
      natNeeded(
        [{ chain: 'srcnat', action: 'masquerade', 'src-address': '192.168.88.0/24' }],
        HOTSPOT,
      ),
    ).toBe(true);
    expect(natNeeded([{ chain: 'srcnat', action: 'masquerade', disabled: 'true' }], HOTSPOT)).toBe(
      true,
    );
    expect(natNeeded([{ chain: 'srcnat', action: 'masquerade', dynamic: 'true' }], HOTSPOT)).toBe(
      true,
    );
    expect(natNeeded([{ chain: 'srcnat', action: 'masquerade', comment: TAG }], HOTSPOT)).toBe(
      true,
    );
    expect(
      natNeeded([{ chain: 'srcnat', action: 'masquerade', 'out-interface': 'ether1' }], HOTSPOT),
    ).toBe(false);
  });

  it('aucun CoA, aucun /radius incoming, CHAP seulement', () => {
    const objects = desiredObjects(spec, true);
    expect(objects.map((o) => o.menu)).not.toContain('radius/incoming');
    const profile = objects.find((o) => o.menu === 'ip/hotspot/profile');
    expect(profile?.values['login-by']).toBe('http-chap');
    const radius = objects.find((o) => o.menu === 'radius');
    expect(radius?.values.secret).toBeUndefined();
    expect(radius?.writeOnly?.secret).toBe(spec.radiusSecret);
  });
});
