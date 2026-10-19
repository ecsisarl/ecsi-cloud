import { formatIpv4, parseIpv4 } from '../tunnel-ip.js';
import { RouterOsError } from '../routeros/errors.js';
import {
  hotspotObjectName,
  hotspotTag,
  TUNNEL_INTERFACE,
  type WriteMenu,
} from '../routeros/writer.js';

/**
 * Configuration Hotspot VOULUE sur un routeur (lot B), calculée à partir de la ligne
 * hotspots, de l'adresse tunnel du routeur et du secret RADIUS dérivé. Ordre d'application
 * (proposition §4.3, sans CoA ni /radius incoming : différés) ; le retrait suit l'ordre
 * inverse. Pages de documentation : docs/MIKROTIK.md, « Provisionnement Hotspot ».
 */
export interface HotspotSpec {
  readonly hotspotId: string;
  readonly interface: string;
  /** Adresse du routeur côté clients, avec masque (ex. 10.5.50.1/24). */
  readonly gatewayAddress: string;
  readonly poolStart: string;
  readonly poolEnd: string;
  readonly dnsName: string | null;
  /** Adresse tunnel de la passerelle (serveur RADIUS) et du routeur (src-address). */
  readonly radiusServer: string;
  readonly routerTunnelIp: string;
  /** Secret RADIUS dérivé (radius-keys.ts nasSecret) : jamais journalisé. */
  readonly radiusSecret: string;
}

export interface DesiredObject {
  readonly menu: WriteMenu;
  /** Propriétés envoyées à la création et comparées ensuite (hors secret). */
  readonly values: Readonly<Record<string, string>>;
  /** Propriétés en écriture seule (secret) : envoyées à la création et réaffirmées. */
  readonly writeOnly?: Readonly<Record<string, string>>;
  /** Propriétés comparées SEULEMENT si le routeur les renvoie (selon la version). */
  readonly ifPresent?: Readonly<Record<string, string>>;
}

/** Ordre d'application ; le retrait parcourt la liste à l'envers. */
export const APPLY_ORDER: readonly WriteMenu[] = [
  'ip/address',
  'ip/pool',
  'ip/dhcp-server/network',
  'ip/dhcp-server',
  'radius',
  'ip/hotspot/profile',
  'ip/hotspot',
  'ip/firewall/nat',
  'ip/firewall/filter',
];

export interface HotspotNetwork {
  readonly host: string;
  readonly prefix: number;
  readonly network: string;
  readonly networkInt: number;
}

export function hotspotNetwork(gatewayAddress: string): HotspotNetwork {
  const [hostText, prefixText] = gatewayAddress.split('/');
  const host = hostText === undefined ? null : parseIpv4(hostText);
  const prefix = Number(prefixText);
  if (host === null || !Number.isInteger(prefix) || prefix < 16 || prefix > 30) {
    throw new RouterOsError('CONFIG', 'Adresse du Hotspot invalide (a.b.c.d/nn attendu)');
  }
  const mask = (0xffffffff << (32 - prefix)) >>> 0;
  const networkInt = (host & mask) >>> 0;
  return {
    host: formatIpv4(host),
    prefix,
    network: `${formatIpv4(networkInt)}/${prefix}`,
    networkInt,
  };
}

/** Objets voulus pour un Hotspot ACTIVÉ ; withNat : masquerade nécessaire (voir reconcile.ts). */
export function desiredObjects(spec: HotspotSpec, withNat: boolean): DesiredObject[] {
  const tag = hotspotTag(spec.hotspotId);
  const name = hotspotObjectName(spec.hotspotId);
  const net = hotspotNetwork(spec.gatewayAddress);
  const objects: DesiredObject[] = [
    {
      menu: 'ip/address',
      values: {
        address: `${net.host}/${net.prefix}`,
        interface: spec.interface,
        comment: tag,
      },
    },
    {
      menu: 'ip/pool',
      values: { name, ranges: `${spec.poolStart}-${spec.poolEnd}`, comment: tag },
    },
    {
      menu: 'ip/dhcp-server/network',
      values: { address: net.network, gateway: net.host, 'dns-server': net.host, comment: tag },
    },
    {
      menu: 'ip/dhcp-server',
      values: {
        name,
        interface: spec.interface,
        'address-pool': name,
        disabled: 'no',
        comment: tag,
      },
    },
    {
      menu: 'radius',
      values: {
        service: 'hotspot',
        address: spec.radiusServer,
        'src-address': spec.routerTunnelIp,
        'authentication-port': '1812',
        'accounting-port': '1813',
        protocol: 'udp',
        comment: tag,
      },
      writeOnly: { secret: spec.radiusSecret },
      // Valeur par défaut documentée (BlastRADIUS) ; réimposée si un routeur la renvoie autre.
      ifPresent: { 'require-message-auth': 'yes-for-request-resp' },
    },
    {
      menu: 'ip/hotspot/profile',
      values: {
        name,
        'hotspot-address': net.host,
        'dns-name': spec.dnsName ?? '',
        'use-radius': 'yes',
        'radius-accounting': 'yes',
        'radius-interim-update': 'received',
        'login-by': 'http-chap',
      },
    },
    {
      menu: 'ip/hotspot',
      values: {
        name,
        interface: spec.interface,
        'address-pool': name,
        profile: name,
        'addresses-per-mac': '2',
        disabled: 'no',
      },
    },
  ];
  if (withNat) {
    objects.push({
      menu: 'ip/firewall/nat',
      values: {
        chain: 'srcnat',
        action: 'masquerade',
        'src-address': net.network,
        'out-interface': `!${TUNNEL_INTERFACE}`,
        comment: tag,
      },
    });
  }
  // Clients du Hotspot : jamais vers le tunnel de gestion (défense en profondeur).
  objects.push({
    menu: 'ip/firewall/filter',
    values: {
      chain: 'forward',
      action: 'drop',
      'src-address': net.network,
      'out-interface': TUNNEL_INTERFACE,
      comment: tag,
    },
  });
  return objects;
}

/** Valeur RouterOS normalisée pour la comparaison (REST renvoie true/false pour yes/no). */
export function normalize(value: string | undefined): string {
  const text = (value ?? '').trim().toLowerCase();
  if (text === 'yes') return 'true';
  if (text === 'no') return 'false';
  return text;
}
