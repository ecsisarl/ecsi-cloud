/**
 * Abstraction d'accès RouterOS, en LECTURE SEULE. Le domaine (supervision) ne dépend que de
 * cette interface ; deux implémentations, toutes deux par l'adresse tunnel WireGuard :
 *
 *  - REST HTTPS (cible de production) : https://<tunnel_ip>/rest/<menu>, certificat épinglé
 *    par son empreinte SHA-256 (rest-transport.ts) ;
 *  - API RouterOS (TCP 8728, protocole binaire documenté) : validée de façon indépendante sur
 *    CHR RouterOS 7.23.7 (OVH) ; le chiffrement est celui du tunnel WireGuard (api-transport.ts).
 *
 * Seuls les menus de la liste ci-dessous peuvent être lus, et seulement par « print » (API) ou
 * GET (REST) : aucune écriture n'est possible par ce code. Sources : REST API
 * (help.mikrotik.com/docs/spaces/ROS/pages/47579162) et API (pages/47579160).
 */
export const READ_MENUS = [
  'system/identity',
  'system/resource',
  'interface',
  // Réservé (non collecté au Sprint 3A) : pairs WireGuard, santé.
  'interface/wireguard/peers',
  'system/health',
] as const;
export type RouterOsMenu = (typeof READ_MENUS)[number];

/** Enregistrement RouterOS : REST et API renvoient toutes les valeurs sous forme de texte. */
export type RouterOsRecord = Readonly<Record<string, string>>;

export interface RouterOsCredentials {
  readonly username: string;
  readonly password: string;
}

export interface RouterOsTransport {
  readonly kind: 'REST_HTTPS' | 'API';
  /** Lit un menu (proplist : propriétés à renvoyer, toutes si absent). */
  print(menu: RouterOsMenu, proplist?: readonly string[]): Promise<RouterOsRecord[]>;
  /** Libère la connexion (API). Sans effet pour REST. */
  close(): Promise<void>;
}

export interface TransportTimeouts {
  /** Établissement de la connexion TCP (+ TLS). */
  readonly connectMs: number;
  /** Durée maximale d'une requête complète. */
  readonly requestMs: number;
}

export const DEFAULT_TIMEOUTS: TransportTimeouts = { connectMs: 5_000, requestMs: 15_000 };

/** Taille maximale d'une réponse : une réponse plus grosse est refusée (PROTOCOL). */
export const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

const PROP = /^[a-z0-9.-]{1,64}$/;

/** Les noms de propriétés sont des constantes du code ; on refuse tout le reste. */
export function assertProplist(proplist: readonly string[]): void {
  for (const prop of proplist) {
    if (!PROP.test(prop)) throw new Error(`Propriété RouterOS invalide : ${prop}`);
  }
}
