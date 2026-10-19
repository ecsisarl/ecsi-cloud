import {
  assertRouterTunnelIp,
  formatIpv4,
  parseIpv4,
  TunnelIpError,
  type TunnelNetwork,
} from '../tunnel-ip.js';
import { RouterOsError, sanitizeDetail } from './errors.js';
import { assertFingerprint, pinnedRequest } from './pinned-https.js';
import { REST_PORT, toRecord } from './rest-transport.js';
import {
  assertProplist,
  DEFAULT_TIMEOUTS,
  type RouterOsCredentials,
  type RouterOsRecord,
  type TransportTimeouts,
} from './transport.js';

/**
 * Transport RouterOS en ÉCRITURE (lot B, provisionnement du Hotspot), SÉPARÉ du transport de
 * lecture de la supervision (transport.ts reste en lecture seule). REST HTTPS uniquement, même
 * épinglage TLS et même validation d'adresse tunnel que la lecture (pinned-https.ts,
 * tunnelWriterFactory). Compte dédié ecsi-cfg (groupe ecsi-rw), distinct de ecsi-svc.
 *
 * Liste blanche STRICTE (REST API, help.mikrotik.com/docs/spaces/ROS/pages/47579162) :
 *  - lecture : GET /rest/<menu>?.proplist=… (print) sur les seuls menus de READABLE_MENUS ;
 *  - add : PUT /rest/<menu> ; set : PATCH /rest/<menu>/<.id> ; remove : DELETE /rest/<menu>/<.id>
 *    sur les seuls menus de WRITE_MENUS ;
 *  - AUCUNE commande libre (POST /rest/execute, /system/script, /user, /ip/service,
 *    /interface/wireguard, /ip/firewall/filter hors règle étiquetée… : impossibles, le menu
 *    n'est pas dans la liste) ;
 *  - chaque propriété écrite est dans la liste du menu et sa valeur passe une expression
 *    stricte (ou une valeur fixe) ; toute autre propriété est refusée AVANT l'envoi ;
 *  - un objet créé porte TOUJOURS le commentaire « ecsi-cloud:hs:<uuid> » (ou, pour
 *    /ip/hotspot et /ip/hotspot/profile qui n'ont PAS de propriété comment — constaté sur CHR
 *    7.24.5 : « bad parameter comment » —, le nom réservé ecsi-hs-<12 hex>) ; set et remove
 *    relisent d'abord l'objet et refusent s'il ne porte pas cette marque : un objet que nous
 *    n'avons pas créé ne peut être ni modifié ni supprimé ;
 *  - aucune adresse de la plage tunnel ne peut être posée sur une interface, servie en DHCP ou
 *    traduite ; l'interface WireGuard ecsi-wg ne peut être ni la cible d'une adresse, ni d'un
 *    serveur DHCP, ni d'un Hotspot ; la règle de filtrage autorisée est un DROP limité au
 *    réseau Hotspot vers le tunnel (elle ne peut pas couper l'administration).
 * Ces garanties tiennent quel que soit l'appelant (réconciliateur ou code futur).
 */

/** Interface WireGuard créée par l'enrôlement (enrollment-script.ts). */
export const TUNNEL_INTERFACE = 'ecsi-wg';

export const WRITE_MENUS = [
  'ip/address',
  'ip/pool',
  'ip/dhcp-server/network',
  'ip/dhcp-server',
  'radius',
  'ip/hotspot/profile',
  'ip/hotspot',
  'ip/firewall/nat',
  'ip/firewall/filter',
] as const;
export type WriteMenu = (typeof WRITE_MENUS)[number];

/** Menus lisibles par le compte d'écriture (diff, contrôles préalables). */
export const READABLE_MENUS = [...WRITE_MENUS, 'interface', 'ip/route', 'system/resource'] as const;
export type ReadableMenu = (typeof READABLE_MENUS)[number];

/** Étiquette de propriété : commentaire de chaque objet créé pour un Hotspot. */
export const HOTSPOT_TAG_PREFIX = 'ecsi-cloud:hs:';
export const HOTSPOT_TAG =
  /^ecsi-cloud:hs:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Nom des objets nommés (pool, serveur DHCP, profil, Hotspot) : ecsi-hs-<12 hex>. */
export const HOTSPOT_NAME = /^ecsi-hs-[0-9a-f]{12}$/;

/** Menus sans propriété comment (CHR 7.24.5) : propriété établie par le nom réservé. */
export const NAME_OWNED_MENUS: ReadonlySet<string> = new Set(['ip/hotspot', 'ip/hotspot/profile']);

/** Marque de propriété générique (tout Hotspot ECSI) d'un enregistrement lu. */
export function isEcsiOwned(menu: string, record: Readonly<Record<string, string>>): boolean {
  return NAME_OWNED_MENUS.has(menu)
    ? HOTSPOT_NAME.test(record.name ?? '')
    : HOTSPOT_TAG.test(record.comment ?? '');
}

export function hotspotTag(hotspotId: string): string {
  const tag = `${HOTSPOT_TAG_PREFIX}${hotspotId}`;
  if (!HOTSPOT_TAG.test(tag)) throw new RouterOsError('CONFIG', 'Identifiant de Hotspot invalide');
  return tag;
}

/** Nom des objets nommés : les 12 derniers chiffres (partie aléatoire d'un UUID v7). */
export function hotspotObjectName(hotspotId: string): string {
  hotspotTag(hotspotId);
  return `ecsi-hs-${hotspotId.slice(-12)}`;
}

const ID = /^\*[0-9A-F]{1,8}$/;
/** Nom d'interface RouterOS (même contrainte que hotspots.interface en base). */
const INTERFACE = /^[A-Za-z0-9._-]{1,40}$/;
const DNS_NAME = /^$|^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;
const RADIUS_SECRET = /^[0-9a-f]{40}$/;
const YES_NO = /^(yes|no)$/;

export class WriterRefusal extends RouterOsError {
  constructor(message: string) {
    super('CONFIG', `Écriture RouterOS refusée : ${message}`);
    this.name = 'WriterRefusal';
  }
}

/** Contexte immuable du routeur cible : plage tunnel, adresse tunnel du routeur. */
export interface WriterScope {
  readonly network: TunnelNetwork;
  readonly routerTunnelIp: string;
}

type Validator = (value: string, scope: WriterScope) => boolean;

const mask = (prefix: number) => (prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0);

function outsideTunnel(address: number, prefix: number, scope: WriterScope): boolean {
  const common = Math.min(prefix, scope.network.prefix);
  return (address & mask(common)) >>> 0 !== (scope.network.network & mask(common)) >>> 0;
}

/** a.b.c.d (hors plage tunnel). */
const hostIp: Validator = (value, scope) => {
  const ip = parseIpv4(value);
  return ip !== null && outsideTunnel(ip, 32, scope);
};

/** a.b.c.d/nn, /16 à /30, hors plage tunnel ; network=true : adresse de réseau exigée. */
function cidr(network: boolean): Validator {
  return (value, scope) => {
    const [base, prefixText, ...rest] = value.split('/');
    const ip = base === undefined ? null : parseIpv4(base);
    if (ip === null || rest.length > 0 || !prefixText || !/^[0-9]{2}$/.test(prefixText)) {
      return false;
    }
    const prefix = Number(prefixText);
    if (prefix < 16 || prefix > 30) return false;
    if (network && (ip & mask(prefix)) >>> 0 !== ip) return false;
    return outsideTunnel(ip, prefix, scope);
  };
}

/** a.b.c.d-e.f.g.h, même /16, hors plage tunnel. */
const ipRange: Validator = (value, scope) => {
  const [from, to, ...rest] = value.split('-');
  const a = from === undefined ? null : parseIpv4(from);
  const b = to === undefined ? null : parseIpv4(to);
  return (
    a !== null &&
    b !== null &&
    rest.length === 0 &&
    a <= b &&
    b - a < 65536 &&
    outsideTunnel(a, 32, scope) &&
    outsideTunnel(b, 32, scope)
  );
};

const matches =
  (pattern: RegExp): Validator =>
  (value) =>
    pattern.test(value);
const exactly =
  (...allowed: string[]): Validator =>
  (value) =>
    allowed.includes(value);
const clientInterface: Validator = (value) =>
  INTERFACE.test(value) && value.toLowerCase() !== TUNNEL_INTERFACE;
const gatewayIp: Validator = (value, scope) => value === formatIpv4(scope.network.gateway);
const routerIp: Validator = (value, scope) => {
  try {
    return value === assertRouterTunnelIp(scope.routerTunnelIp, scope.network);
  } catch (error) {
    if (error instanceof TunnelIpError) return false;
    throw error;
  }
};

const tag = matches(HOTSPOT_TAG);
const name = matches(HOTSPOT_NAME);

/**
 * Propriétés écrivables par menu et validation de leur valeur. Sources (help.mikrotik.com,
 * espace ROS) : IP Addressing, IP Pools, DHCP (pages « DHCP Server » et « Network »), RADIUS
 * (« RADIUS Client »), HotSpot (« /ip/hotspot » et « HotSpot Profile »), Firewall NAT et Filter.
 * docs/MIKROTIK.md (« Provisionnement Hotspot ») donne la page et la vérification CHR de chaque
 * propriété.
 */
export const WRITABLE_PROPERTIES: Readonly<Record<WriteMenu, Readonly<Record<string, Validator>>>> =
  {
    'ip/address': { address: cidr(false), interface: clientInterface, comment: tag },
    'ip/pool': { name, ranges: ipRange, comment: tag },
    'ip/dhcp-server/network': {
      address: cidr(true),
      gateway: hostIp,
      'dns-server': hostIp,
      comment: tag,
    },
    'ip/dhcp-server': {
      name,
      interface: clientInterface,
      'address-pool': name,
      disabled: matches(YES_NO),
      comment: tag,
    },
    radius: {
      service: exactly('hotspot'),
      address: gatewayIp,
      'src-address': routerIp,
      secret: matches(RADIUS_SECRET),
      'authentication-port': exactly('1812'),
      'accounting-port': exactly('1813'),
      protocol: exactly('udp'),
      'require-message-auth': exactly('yes-for-request-resp'),
      comment: tag,
    },
    'ip/hotspot/profile': {
      name,
      'hotspot-address': hostIp,
      'dns-name': matches(DNS_NAME),
      'use-radius': exactly('yes'),
      'radius-accounting': exactly('yes'),
      'radius-interim-update': exactly('received'),
      // Décision du propriétaire : CHAP seulement (jamais http-pap, cookie ni mac-cookie).
      'login-by': exactly('http-chap'),
    },
    'ip/hotspot': {
      name,
      interface: clientInterface,
      'address-pool': name,
      profile: name,
      'addresses-per-mac': matches(/^[1-9]$/),
      disabled: matches(YES_NO),
    },
    'ip/firewall/nat': {
      chain: exactly('srcnat'),
      action: exactly('masquerade'),
      'src-address': cidr(true),
      'out-interface': exactly(`!${TUNNEL_INTERFACE}`),
      comment: tag,
    },
    'ip/firewall/filter': {
      chain: exactly('forward'),
      action: exactly('drop'),
      'src-address': cidr(true),
      'out-interface': exactly(TUNNEL_INTERFACE),
      comment: tag,
    },
  };

/** Propriétés OBLIGATOIRES à la création (règles : forme imposée, jamais plus large). */
const REQUIRED_ON_ADD: Readonly<Partial<Record<WriteMenu, readonly string[]>>> = {
  'ip/firewall/nat': ['chain', 'action', 'src-address', 'out-interface', 'comment'],
  'ip/firewall/filter': ['chain', 'action', 'src-address', 'out-interface', 'comment'],
  radius: ['service', 'address', 'src-address', 'secret', 'comment'],
};

/** Propriétés dont la valeur ne doit jamais apparaître dans un message (secret). */
const SECRET_PROPERTIES = new Set(['secret']);

export function isWriteMenu(menu: string): menu is WriteMenu {
  return (WRITE_MENUS as readonly string[]).includes(menu);
}

export function isReadableMenu(menu: string): menu is ReadableMenu {
  return (READABLE_MENUS as readonly string[]).includes(menu);
}

/** Valide un jeu de propriétés pour un menu ; lève WriterRefusal sans jamais citer un secret. */
export function assertWritable(
  menu: string,
  values: Readonly<Record<string, string>>,
  scope: WriterScope,
  mode: 'add' | 'set',
): asserts menu is WriteMenu {
  if (!isWriteMenu(menu)) throw new WriterRefusal(`menu ${menu.slice(0, 40)} hors liste blanche`);
  const allowed = WRITABLE_PROPERTIES[menu];
  const keys = Object.keys(values);
  if (keys.length === 0) throw new WriterRefusal(`${menu} : aucune propriété`);
  for (const key of keys) {
    const validate = allowed[key];
    if (!validate) throw new WriterRefusal(`${menu} : propriété ${key.slice(0, 40)} interdite`);
    const value = values[key];
    if (typeof value !== 'string' || !validate(value, scope)) {
      const shown = SECRET_PROPERTIES.has(key) ? '[masqué]' : sanitizeDetail(String(value));
      throw new WriterRefusal(`${menu} : valeur refusée pour ${key} (${shown})`);
    }
  }
  if (mode === 'add') {
    if (
      NAME_OWNED_MENUS.has(menu)
        ? !HOTSPOT_NAME.test(values.name ?? '')
        : !HOTSPOT_TAG.test(values.comment ?? '')
    ) {
      throw new WriterRefusal(
        `${menu} : un objet créé doit porter la marque ECSI (étiquette ou nom)`,
      );
    }
    for (const key of REQUIRED_ON_ADD[menu] ?? []) {
      if (!(key in values)) throw new WriterRefusal(`${menu} : propriété ${key} obligatoire`);
    }
  }
}

export interface RouterOsWriter {
  /** Lecture (print) d'un menu de la liste ; proplist : propriétés à renvoyer. */
  list(menu: ReadableMenu, proplist: readonly string[]): Promise<RouterOsRecord[]>;
  /** add : crée un objet étiqueté ; renvoie l'objet créé (avec .id). */
  add(menu: WriteMenu, values: Readonly<Record<string, string>>): Promise<RouterOsRecord>;
  /** set : modifie un objet étiqueté (relu avant : refus s'il n'est pas à nous). */
  set(menu: WriteMenu, id: string, values: Readonly<Record<string, string>>): Promise<void>;
  /** remove : supprime un objet étiqueté (relu avant : refus s'il n'est pas à nous). */
  remove(menu: WriteMenu, id: string): Promise<void>;
}

/**
 * Implémentation REST HTTPS épinglée. Une requête = une connexion TLS (comme la lecture).
 * Les messages d'erreur ne reprennent jamais le corps envoyé (qui peut contenir le secret
 * RADIUS) ; le texte renvoyé par RouterOS est nettoyé et les secrets connus masqués.
 */
export class RestWriter implements RouterOsWriter {
  private readonly authorization: string;
  private readonly secrets: string[];

  constructor(
    private readonly target: { host: string; port: number },
    private readonly fingerprint: string,
    credentials: RouterOsCredentials,
    private readonly scope: WriterScope,
    private readonly timeouts: TransportTimeouts = DEFAULT_TIMEOUTS,
  ) {
    assertFingerprint(fingerprint);
    this.authorization = `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`, 'utf8').toString('base64')}`;
    this.secrets = [credentials.password];
  }

  async list(menu: ReadableMenu, proplist: readonly string[]): Promise<RouterOsRecord[]> {
    if (!isReadableMenu(menu)) throw new WriterRefusal(`lecture ${String(menu)} hors liste`);
    assertProplist(proplist);
    if (proplist.length === 0) throw new WriterRefusal('proplist obligatoire');
    const payload = await this.call('GET', `/rest/${menu}?.proplist=${proplist.join(',')}`, menu);
    const items = Array.isArray(payload) ? payload : [payload];
    return items.map((item) => toRecord(item));
  }

  async add(menu: WriteMenu, values: Readonly<Record<string, string>>): Promise<RouterOsRecord> {
    assertWritable(menu, values, this.scope, 'add');
    const payload = await this.call('PUT', `/rest/${menu}`, menu, values);
    return toRecord(payload);
  }

  async set(menu: WriteMenu, id: string, values: Readonly<Record<string, string>>): Promise<void> {
    assertWritable(menu, values, this.scope, 'set');
    const current = await this.owned(menu, id);
    if (
      ('comment' in values && values.comment !== current.comment) ||
      (NAME_OWNED_MENUS.has(menu) && 'name' in values && values.name !== current.name)
    ) {
      throw new WriterRefusal(`${menu} : la marque d'un objet (étiquette, nom) ne change pas`);
    }
    await this.call('PATCH', `/rest/${menu}/${id}`, menu, values);
  }

  async remove(menu: WriteMenu, id: string): Promise<void> {
    if (!isWriteMenu(menu)) throw new WriterRefusal(`menu ${String(menu)} hors liste blanche`);
    await this.owned(menu, id);
    await this.call('DELETE', `/rest/${menu}/${id}`, menu);
  }

  /** Relit l'objet et vérifie qu'il porte notre étiquette (sinon : refus, rien n'est écrit). */
  private async owned(menu: WriteMenu, id: string): Promise<RouterOsRecord> {
    if (!ID.test(id)) throw new WriterRefusal(`${menu} : identifiant .id invalide`);
    const record = toRecord(
      await this.call('GET', `/rest/${menu}/${id}?.proplist=.id,comment,name`, menu),
    );
    if (!isEcsiOwned(menu, record)) {
      throw new WriterRefusal(`${menu} ${id} : objet non créé par ECSI CLOUD, intouchable`);
    }
    return record;
  }

  private async call(
    method: 'GET' | 'PUT' | 'PATCH' | 'DELETE',
    path: string,
    menu: string,
    values?: Readonly<Record<string, string>>,
  ): Promise<unknown> {
    const secrets = [...this.secrets, ...(values?.secret ? [values.secret] : [])];
    const { status, body } = await pinnedRequest(this.target, this.fingerprint, this.timeouts, {
      method,
      path,
      authorization: this.authorization,
      body: values === undefined ? undefined : JSON.stringify(values),
    });
    if (status === 401) {
      throw new RouterOsError('AUTH', 'Identifiants refusés par RouterOS (HTTP 401)');
    }
    const text = body.toString('utf8');
    let payload: unknown = null;
    if (text.trim() !== '') {
      try {
        payload = JSON.parse(text);
      } catch {
        throw new RouterOsError('PROTOCOL', `Réponse REST illisible (HTTP ${status})`);
      }
    }
    if (status === 403) {
      throw new RouterOsError('PERMISSION', `${method} ${menu} interdit au compte (HTTP 403)`);
    }
    if (status < 200 || status >= 300) {
      const record =
        payload && typeof payload === 'object' && !Array.isArray(payload)
          ? (payload as Record<string, unknown>)
          : {};
      const detail = [record.message, record.detail]
        .filter((part) => typeof part === 'string' && part !== '')
        .join(' : ');
      throw new RouterOsError(
        'API_ERROR',
        `${method} ${menu} refusé par RouterOS (HTTP ${status})${detail ? ` : ${sanitizeDetail(detail, secrets)}` : ''}`,
      );
    }
    return payload;
  }
}

export type WriterFactory = (
  target: { tunnelIp: string; tlsFingerprint: string | null },
  credentials: RouterOsCredentials,
) => RouterOsWriter;

/**
 * Seul point de création d'un transport d'écriture : adresse RE-VALIDÉE contre la plage
 * tunnel, port 443 fixé par le code, épinglage obligatoire (pas de repli API ni HTTP).
 */
export function tunnelWriterFactory(
  network: TunnelNetwork,
  timeouts: TransportTimeouts = DEFAULT_TIMEOUTS,
): WriterFactory {
  return (target, credentials) => {
    let host: string;
    try {
      host = assertRouterTunnelIp(target.tunnelIp, network);
    } catch (error) {
      if (error instanceof TunnelIpError) throw new RouterOsError('CONFIG', error.message);
      throw error;
    }
    if (!target.tlsFingerprint) {
      throw new RouterOsError('TLS_PINNING', 'Empreinte TLS absente : écriture refusée');
    }
    return new RestWriter(
      { host, port: REST_PORT },
      target.tlsFingerprint,
      credentials,
      { network, routerTunnelIp: host },
      timeouts,
    );
  };
}
