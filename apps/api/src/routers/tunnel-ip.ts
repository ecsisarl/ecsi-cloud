/**
 * Adresses tunnel WireGuard des routeurs : SEULES adresses que le worker contacte jamais
 * (docs/MIKROTIK.md, PROTOCOLE-PROVISIONNEMENT.md).
 *
 * Défense contre la falsification de requêtes côté serveur (SSRF) : une tunnel_ip arbitraire
 * enregistrée en base ne doit pas permettre au worker de joindre le LAN du cloud, une IP
 * publique, la boucle locale ou la passerelle elle-même. Une adresse est donc acceptée
 * uniquement si elle est :
 *  - une IPv4 en notation décimale stricte (pas de zéro initial, d'octal, d'hexadécimal, de
 *    nom d'hôte : aucune résolution DNS n'est jamais faite) ;
 *  - DANS la plage tunnel configurée (ROUTER_TUNNEL_CIDR, 10.200.0.0/24 au laboratoire) ;
 *  - différente de l'adresse de réseau, de diffusion et de la passerelle (ROUTER_TUNNEL_GATEWAY).
 * La plage elle-même doit être privée (RFC 1918) ou partagée (RFC 6598), entre /16 et /30.
 * Les ports ne sont jamais configurables : 443 (REST HTTPS) ou 8728 (API), fixés par le code.
 * La validation est faite à l'enregistrement ET avant chaque connexion du worker.
 */

export interface TunnelNetwork {
  /** Adresse de réseau (entier non signé 32 bits). */
  readonly network: number;
  readonly prefix: number;
  /** Adresse de la passerelle WireGuard du cloud (jamais une cible du worker). */
  readonly gateway: number;
  readonly cidr: string;
}

export class TunnelIpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TunnelIpError';
  }
}

const OCTET = '(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])';
const IPV4 = new RegExp(`^${OCTET}\\.${OCTET}\\.${OCTET}\\.${OCTET}$`);

/** Plages admises pour le réseau tunnel : privées (RFC 1918) et partagées (RFC 6598). */
const ALLOWED_TUNNEL_SPACES: readonly (readonly [string, number])[] = [
  ['10.0.0.0', 8],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
  ['100.64.0.0', 10],
];

/** IPv4 décimale stricte -> entier non signé, sinon null. */
export function parseIpv4(value: string): number | null {
  const match = IPV4.exec(value);
  if (!match) return null;
  return (
    ((Number(match[1]) << 24) |
      (Number(match[2]) << 16) |
      (Number(match[3]) << 8) |
      Number(match[4])) >>>
    0
  );
}

export function formatIpv4(value: number): string {
  return [value >>> 24, (value >>> 16) & 255, (value >>> 8) & 255, value & 255].join('.');
}

const mask = (prefix: number) => (prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0);

function inRange(address: number, network: number, prefix: number): boolean {
  return (address & mask(prefix)) >>> 0 === network;
}

/** Valide la configuration ROUTER_TUNNEL_CIDR / ROUTER_TUNNEL_GATEWAY. */
export function parseTunnelNetwork(cidr: string, gateway: string): TunnelNetwork {
  const [base, prefixText, ...rest] = cidr.split('/');
  const network = base === undefined ? null : parseIpv4(base);
  if (
    network === null ||
    prefixText === undefined ||
    rest.length > 0 ||
    !/^[0-9]{1,2}$/.test(prefixText)
  ) {
    throw new TunnelIpError(`Plage tunnel invalide : ${cidr} (format a.b.c.d/nn attendu)`);
  }
  const prefix = Number(prefixText);
  if (prefix < 16 || prefix > 30) {
    throw new TunnelIpError(`Plage tunnel invalide : ${cidr} (préfixe entre /16 et /30)`);
  }
  if ((network & mask(prefix)) >>> 0 !== network) {
    throw new TunnelIpError(`Plage tunnel invalide : ${cidr} (adresse de réseau attendue)`);
  }
  const allowed = ALLOWED_TUNNEL_SPACES.some(([space, spacePrefix]) => {
    const spaceNetwork = parseIpv4(space) ?? 0;
    return prefix >= spacePrefix && inRange(network, spaceNetwork, spacePrefix);
  });
  if (!allowed) {
    throw new TunnelIpError(
      `Plage tunnel invalide : ${cidr} (doit être privée RFC 1918 ou partagée RFC 6598)`,
    );
  }
  const gw = parseIpv4(gateway);
  const broadcast = (network | ~mask(prefix)) >>> 0;
  if (gw === null || !inRange(gw, network, prefix) || gw === network || gw === broadcast) {
    throw new TunnelIpError(`Passerelle tunnel invalide : ${gateway} (hors de ${cidr})`);
  }
  return { network, prefix, gateway: gw, cidr };
}

/**
 * Valide une adresse tunnel de routeur et la renvoie sous forme canonique. Accepte « a.b.c.d »
 * ou « a.b.c.d/32 » (forme renvoyée par PostgreSQL pour le type inet).
 */
export function assertRouterTunnelIp(value: string, net: TunnelNetwork): string {
  const text = value.endsWith('/32') ? value.slice(0, -3) : value;
  const address = parseIpv4(text);
  if (address === null) {
    throw new TunnelIpError('Adresse tunnel invalide : IPv4 décimale attendue');
  }
  if (!inRange(address, net.network, net.prefix)) {
    throw new TunnelIpError(`Adresse tunnel refusée : hors de la plage tunnel ${net.cidr}`);
  }
  const broadcast = (net.network | ~mask(net.prefix)) >>> 0;
  if (address === net.network || address === broadcast) {
    throw new TunnelIpError('Adresse tunnel refusée : adresse de réseau ou de diffusion');
  }
  if (address === net.gateway) {
    throw new TunnelIpError('Adresse tunnel refusée : adresse de la passerelle');
  }
  return formatIpv4(address);
}
