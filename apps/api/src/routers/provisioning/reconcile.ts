import { parseIpv4 } from '../tunnel-ip.js';
import { RouterOsError } from '../routeros/errors.js';
import type { RouterOsRecord } from '../routeros/transport.js';
import {
  hotspotObjectName,
  hotspotTag,
  NAME_OWNED_MENUS,
  type ReadableMenu,
  type RouterOsWriter,
  TUNNEL_INTERFACE,
  type WriteMenu,
} from '../routeros/writer.js';
import {
  APPLY_ORDER,
  type DesiredObject,
  desiredObjects,
  hotspotNetwork,
  type HotspotSpec,
  normalize,
} from './desired.js';

/**
 * Réconciliation de la configuration Hotspot d'UN routeur (lot B) : lecture des objets
 * étiquetés « ecsi-cloud:hs:<hotspot> », calcul de l'écart avec la configuration voulue,
 * écriture des seules différences, relecture de confirmation. Les objets d'un autre
 * propriétaire ne sont jamais modifiés (garantie aussi portée par RouterOsWriter) ; des
 * contrôles préalables refusent toute configuration qui toucherait l'accès de gestion.
 */

export type ReconcileAction =
  | { readonly kind: 'add'; readonly menu: WriteMenu }
  | {
      readonly kind: 'set';
      readonly menu: WriteMenu;
      readonly id: string;
      readonly props: string[];
    }
  | { readonly kind: 'remove'; readonly menu: WriteMenu; readonly id: string };

export interface ReconcileReport {
  readonly added: number;
  readonly updated: number;
  readonly removed: number;
  readonly actions: readonly ReconcileAction[];
}

/** Erreur de contrôle préalable : rien n'a été écrit, message sans secret. */
export class PreconditionError extends RouterOsError {
  constructor(message: string) {
    super('CONFIG', message);
    this.name = 'PreconditionError';
  }
}

const BASE_PROPS = ['.id', 'comment'];

/** Propriétés lues par menu : celles comparées et celles utiles aux contrôles préalables. */
const READ_PROPS: Readonly<Record<WriteMenu, readonly string[]>> = {
  'ip/address': ['address', 'interface', 'dynamic'],
  'ip/pool': ['name', 'ranges'],
  'ip/dhcp-server/network': ['address', 'gateway', 'dns-server'],
  'ip/dhcp-server': ['name', 'interface', 'address-pool', 'disabled'],
  radius: [
    'service',
    'address',
    'src-address',
    'authentication-port',
    'accounting-port',
    'protocol',
    'require-message-auth',
    'secret',
    'disabled',
  ],
  'ip/hotspot/profile': [
    'name',
    'hotspot-address',
    'dns-name',
    'use-radius',
    'radius-accounting',
    'radius-interim-update',
    'login-by',
  ],
  'ip/hotspot': ['name', 'interface', 'address-pool', 'profile', 'addresses-per-mac', 'disabled'],
  'ip/firewall/nat': [
    'chain',
    'action',
    'src-address',
    'src-address-list',
    'out-interface',
    'disabled',
    'dynamic',
  ],
  'ip/firewall/filter': ['chain', 'action', 'src-address', 'out-interface'],
};

type Snapshot = Map<WriteMenu, RouterOsRecord[]>;

/** Propriété d'un enregistrement pour CE Hotspot : étiquette, ou nom réservé (menus sans comment). */
export function ownedBy(menu: WriteMenu, record: RouterOsRecord, hotspotId: string): boolean {
  return NAME_OWNED_MENUS.has(menu)
    ? record.name === hotspotObjectName(hotspotId)
    : record.comment === hotspotTag(hotspotId);
}

async function readAll(writer: RouterOsWriter, menus: readonly WriteMenu[]): Promise<Snapshot> {
  const snapshot: Snapshot = new Map();
  for (const menu of menus) {
    snapshot.set(menu, await writer.list(menu, [...BASE_PROPS, ...READ_PROPS[menu]]));
  }
  return snapshot;
}

const isTrue = (value: string | undefined) => normalize(value) === 'true';

/**
 * Masquerade nécessaire si aucune règle srcnat existante (non dynamique, active) ne traduit
 * déjà tout le trafic sortant (masquerade sans restriction de source).
 */
export function natNeeded(nat: readonly RouterOsRecord[], hotspotId: string): boolean {
  return !nat.some(
    (rule) =>
      !ownedBy('ip/firewall/nat', rule, hotspotId) &&
      rule.chain === 'srcnat' &&
      rule.action === 'masquerade' &&
      !isTrue(rule.disabled) &&
      !isTrue(rule.dynamic) &&
      !rule['src-address'] &&
      !rule['src-address-list'],
  );
}

function overlaps(a: string, b: string): boolean {
  const parse = (value: string) => {
    const [ip, prefix] = value.split('/');
    const address = ip === undefined ? null : parseIpv4(ip);
    const length = prefix === undefined ? 32 : Number(prefix);
    return address === null || !Number.isInteger(length) ? null : { address, length };
  };
  const x = parse(a);
  const y = parse(b);
  if (!x || !y) return false;
  const common = Math.min(x.length, y.length);
  const mask = common === 0 ? 0 : (0xffffffff << (32 - common)) >>> 0;
  return (x.address & mask) >>> 0 === (y.address & mask) >>> 0;
}

/**
 * Contrôles AVANT toute écriture (Hotspot activé). Refus si la configuration voulue pourrait
 * couper la gestion du routeur ou entrer en conflit avec une configuration existante :
 *  - interface absente, interface WireGuard, ou interface de la route par défaut (WAN) ;
 *  - adresse IP d'un autre propriétaire sur l'interface (WAN, LAN existant, client DHCP) ;
 *  - réseau du Hotspot chevauchant une adresse existante (dont le tunnel) ;
 *  - serveur DHCP ou Hotspot d'un autre propriétaire sur l'interface ;
 *  - client RADIUS « hotspot » d'un autre propriétaire (il serait consulté avant le nôtre) ;
 *  - objet d'un autre propriétaire portant l'un de nos noms.
 */
export async function checkPreconditions(
  writer: RouterOsWriter,
  spec: HotspotSpec,
  snapshot: Snapshot,
): Promise<void> {
  const name = hotspotObjectName(spec.hotspotId);
  const net = hotspotNetwork(spec.gatewayAddress);
  const foreign = (menu: WriteMenu) =>
    (snapshot.get(menu) ?? []).filter((record) => !ownedBy(menu, record, spec.hotspotId));

  if (spec.interface.toLowerCase() === TUNNEL_INTERFACE) {
    throw new PreconditionError(`Interface ${TUNNEL_INTERFACE} interdite (tunnel de gestion)`);
  }
  const interfaces = await writer.list('interface' satisfies ReadableMenu, ['name', 'type']);
  const target = interfaces.find((record) => record.name === spec.interface);
  if (!target) throw new PreconditionError(`Interface ${spec.interface} absente du routeur`);
  if (target.type === 'wg') {
    throw new PreconditionError(`Interface ${spec.interface} : WireGuard, refusée`);
  }
  const routes = await writer.list('ip/route', [
    'dst-address',
    'gateway',
    'immediate-gw',
    'active',
  ]);
  const wan = routes.some(
    (route) =>
      route['dst-address'] === '0.0.0.0/0' &&
      (route.gateway === spec.interface ||
        (route['immediate-gw'] ?? '').split('%')[1] === spec.interface),
  );
  if (wan) {
    throw new PreconditionError(
      `Interface ${spec.interface} : porte la route par défaut (WAN), refusée`,
    );
  }
  for (const address of foreign('ip/address')) {
    if (address.interface === spec.interface) {
      throw new PreconditionError(
        `Interface ${spec.interface} : déjà adressée (${address.address ?? '?'}), refusée`,
      );
    }
    if (address.address && overlaps(address.address, net.network)) {
      throw new PreconditionError(
        `Réseau ${net.network} : chevauche ${address.address} (${address.interface ?? '?'})`,
      );
    }
  }
  if (foreign('ip/dhcp-server').some((server) => server.interface === spec.interface)) {
    throw new PreconditionError(`Interface ${spec.interface} : serveur DHCP existant, refusée`);
  }
  if (foreign('ip/hotspot').some((server) => server.interface === spec.interface)) {
    throw new PreconditionError(`Interface ${spec.interface} : Hotspot existant, refusée`);
  }
  if (foreign('radius').some((client) => (client.service ?? '').split(',').includes('hotspot'))) {
    throw new PreconditionError(
      'Client RADIUS « hotspot » existant sur le routeur : le retirer avant la synchronisation',
    );
  }
  for (const menu of ['ip/pool', 'ip/dhcp-server', 'ip/hotspot/profile', 'ip/hotspot'] as const) {
    if (foreign(menu).some((record) => record.name === name)) {
      throw new PreconditionError(`${menu} : le nom ${name} est déjà pris par un autre objet`);
    }
  }
}

/** Propriétés à corriger sur un objet existant (secret exclu sauf s'il est lisible). */
export function changedProps(existing: RouterOsRecord, desired: DesiredObject): string[] {
  const changed = Object.entries(desired.values)
    .filter(([key, value]) => normalize(existing[key]) !== normalize(value))
    .map(([key]) => key);
  for (const [key, value] of Object.entries(desired.ifPresent ?? {})) {
    if (key in existing && normalize(existing[key]) !== normalize(value)) changed.push(key);
  }
  return changed;
}

/**
 * Le secret RADIUS est une propriété « sensitive » : sans la politique sensitive (refusée au
 * compte ecsi-cfg), RouterOS ne la renvoie pas. Lisible : comparé ; illisible : réaffirmé à
 * chaque synchronisation (une écriture idempotente, valeur identique).
 */
function secretToWrite(existing: RouterOsRecord, desired: DesiredObject): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(desired.writeOnly ?? {})) {
    if (!(key in existing) || existing[key] === '' || existing[key] !== value) out[key] = value;
  }
  return out;
}

/** Plan d'écart : actions dans l'ordre d'exécution. */
export function plan(desired: readonly DesiredObject[], owned: Snapshot): ReconcileAction[] {
  const adds: ReconcileAction[] = [];
  const removes: ReconcileAction[] = [];
  for (const menu of APPLY_ORDER) {
    const want = desired.find((object) => object.menu === menu);
    const have = owned.get(menu) ?? [];
    const [first, ...extra] = have;
    if (want && !first) adds.push({ kind: 'add', menu });
    if (want && first) {
      const props = [...changedProps(first, want), ...Object.keys(secretToWrite(first, want))];
      if (props.length > 0) adds.push({ kind: 'set', menu, id: first['.id'] ?? '', props });
    }
    for (const record of want ? extra : have) {
      removes.push({ kind: 'remove', menu, id: record['.id'] ?? '' });
    }
  }
  // Retraits d'abord, dans l'ordre inverse d'application (dépendances : Hotspot avant profil…).
  return [...removes.reverse(), ...adds];
}

function ownedOnly(snapshot: Snapshot, hotspotId: string): Snapshot {
  const owned: Snapshot = new Map();
  for (const [menu, records] of snapshot) {
    owned.set(
      menu,
      records.filter((record) => ownedBy(menu, record, hotspotId)),
    );
  }
  return owned;
}

async function execute(
  writer: RouterOsWriter,
  actions: readonly ReconcileAction[],
  desired: readonly DesiredObject[],
): Promise<void> {
  for (const action of actions) {
    const want = desired.find((object) => object.menu === action.menu);
    if (action.kind === 'remove') {
      await writer.remove(action.menu, action.id);
    } else if (action.kind === 'add' && want) {
      await writer.add(action.menu, { ...want.values, ...(want.writeOnly ?? {}) });
    } else if (action.kind === 'set' && want) {
      const all = { ...want.values, ...(want.ifPresent ?? {}), ...(want.writeOnly ?? {}) };
      const values = Object.fromEntries(action.props.map((key) => [key, all[key] ?? '']));
      await writer.set(action.menu, action.id, values);
    }
  }
}

const count = (actions: readonly ReconcileAction[], kind: ReconcileAction['kind']) =>
  actions.filter((action) => action.kind === kind).length;

/**
 * Applique la configuration voulue (enabled) ou retire tout (disabled / supprimé), puis relit
 * pour confirmer. Lève RouterOsError (message sans secret) si la confirmation échoue.
 */
export async function reconcileHotspot(
  writer: RouterOsWriter,
  spec: HotspotSpec,
  enabled: boolean,
): Promise<ReconcileReport> {
  const snapshot = await readAll(writer, APPLY_ORDER);
  let desired: DesiredObject[] = [];
  if (enabled) {
    await checkPreconditions(writer, spec, snapshot);
    desired = desiredObjects(
      spec,
      natNeeded(snapshot.get('ip/firewall/nat') ?? [], spec.hotspotId),
    );
  }
  const actions = plan(desired, ownedOnly(snapshot, spec.hotspotId));
  await execute(writer, actions, desired);

  // Confirmation : plus aucun écart (le secret illisible n'est pas comparable, il vient
  // d'être réaffirmé).
  const after = ownedOnly(await readAll(writer, APPLY_ORDER), spec.hotspotId);
  const remaining = plan(
    desired.map((object) => ({ ...object, writeOnly: undefined })),
    after,
  );
  if (remaining.length > 0) {
    const first = remaining[0];
    throw new RouterOsError(
      'API_ERROR',
      `Configuration non confirmée après écriture (${remaining.length} écart(s), premier : ${first?.kind ?? '?'} ${first?.menu ?? '?'})`,
    );
  }
  return {
    added: count(actions, 'add'),
    updated: count(actions, 'set'),
    removed: count(actions, 'remove'),
    actions,
  };
}
