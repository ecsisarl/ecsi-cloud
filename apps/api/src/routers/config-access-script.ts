/**
 * Script d'activation CONFIGURATION (lot B), collé une fois par l'administrateur du routeur,
 * même mécanique que l'enrôlement (enrollment-script.ts) : crée le groupe ecsi-rw et le compte
 * d'écriture ecsi-cfg (mot de passe tiré au hasard PAR LE ROUTEUR, :rndstr), restreint à
 * l'adresse tunnel de la passerelle, et envoie le mot de passe UNIQUEMENT par le tunnel
 * WireGuard à l'agent passerelle (POST /activate-config, jeton à usage unique). Le compte de
 * supervision ecsi-svc n'est jamais modifié.
 *
 * Arrêt sans rien modifier si le routeur n'est pas enrôlé auprès de CETTE instance (interface
 * ecsi-wg, adresse tunnel et pair passerelle attendus, compte ecsi-svc présent : mêmes
 * contrôles que REENROLL_GUARD). Relancer le script (nouveau jeton) remplace le mot de passe.
 *
 * Commandes reprises du script d'enrôlement validé sur CHR 7.24.5 (/user/group/add,
 * /user/add, :rndstr, :serialize, /tool/fetch) ; /user/group/set et /user/set validés sur CHR
 * 7.24.5 au lot B (lab/routeros/resultats/2026-10-19-lot-b-provisioning.md). Valeurs
 * substituées validées par des expressions strictes (anti-injection, comme l'enrôlement).
 */
import { WIREGUARD_PUBLIC_KEY } from '@ecsi/shared';
import { formatIpv4, parseIpv4 } from './tunnel-ip.js';

/**
 * Politiques du groupe ecsi-rw. read : lire la configuration ; write : la modifier (« except
 * for user management », page User) ; api, rest-api : accès REST. Sans policy (gestion des
 * comptes), sans sensitive (lecture des secrets : clé privée WireGuard…), sans ftp, ssh,
 * winbox, web, reboot, test, sniff, password. Constat CHR 7.24.5 : l'écriture du secret
 * /radius (propriété « sensitive ») réussit SANS la politique sensitive (fiche de résultats).
 */
export const CONFIG_GROUP_POLICY = 'read,write,api,rest-api';
export const CONFIG_GROUP = 'ecsi-rw';
export const CONFIG_USER = 'ecsi-cfg';

export interface ConfigAccessScriptInput {
  token: string;
  gatewayTunnelIp: string;
  activationPort: number;
  gatewayPublicKey: string;
  tunnelIp: string;
  tunnelPrefix: number;
  ttlMinutes: number;
}

export class ConfigAccessScriptError extends Error {
  constructor(field: string) {
    super(`Valeur refusée dans le script d'activation configuration : ${field}`);
    this.name = 'ConfigAccessScriptError';
  }
}

const TOKEN = /^[A-Za-z0-9_-]{43}$/;

export const CONFIG_ACCESS_SCRIPT_BODY = String.raw`{
:local ecsiToken "__TOKEN__"
:local ecsiActivateUrl "__ACTIVATE_URL__"
:local gwPublicKey "__GW_PUBLIC_KEY__"
:local gwTunnelIp "__GW_TUNNEL_IP__"
:local tunnelAddress "__TUNNEL_ADDRESS__"
:local wgName "ecsi-wg"

# 1. Version
:local ver [/system/resource/get version]
:if ([:pick $ver 0 1] != "7") do={ :error "ECSI: RouterOS v7 requis (version: $ver)" }
:put "ECSI 1/4: RouterOS $ver"

# 2. Routeur enrole aupres de CETTE instance ECSI CLOUD, sinon arret AVANT toute modification
:if ([:len [/interface/wireguard/find where name=$wgName]] = 0) do={
  :error "ECSI: routeur non enrole (interface $wgName absente) : enroler d'abord le routeur"
}
:local addrOk false
:foreach a in=[/ip/address/find where interface=$wgName] do={
  :local current [/ip/address/get $a address]
  :if ($current = $tunnelAddress) do={ :set addrOk true } else={
    :error "ECSI: adresse tunnel inattendue ($wgName $current) : ce script n'est pas destine a ce routeur"
  }
}
:if (!$addrOk) do={ :error "ECSI: adresse tunnel $tunnelAddress absente : routeur non enrole" }
:local peerOk false
:foreach p in=[/interface/wireguard/peers/find where interface=$wgName] do={
  :if ([/interface/wireguard/peers/get $p public-key] = $gwPublicKey) do={ :set peerOk true } else={
    :error "ECSI: passerelle inattendue sur $wgName : ce script n'est pas destine a ce routeur"
  }
}
:if (!$peerOk) do={ :error "ECSI: pair passerelle absent : routeur non enrole" }
:if ([:len [/user/find where name="ecsi-svc"]] = 0) do={
  :error "ECSI: compte de supervision ecsi-svc absent : terminer d'abord l'enrolement"
}
:put "ECSI 2/4: routeur enrole ($tunnelAddress)"

# 3. Groupe ecsi-rw : politiques minimales, reimposees a chaque passage
:if ([:len [/user/group/find where name="ecsi-rw"]] = 0) do={
  /user/group/add name="ecsi-rw" policy=__POLICY__ comment="ecsi-cloud"
} else={
  /user/group/set [find where name="ecsi-rw"] policy=__POLICY__
}
:put "ECSI 3/4: groupe ecsi-rw"

# 4. Compte ecsi-cfg : mot de passe genere ici, envoye par le tunnel uniquement
:local pw [:rndstr length=32]
:if ([:len [/user/find where name="ecsi-cfg"]] = 0) do={
  /user/add name="ecsi-cfg" group="ecsi-rw" address="$gwTunnelIp/32" password=$pw comment="ecsi-cloud"
} else={
  /user/set [find where name="ecsi-cfg"] group="ecsi-rw" address="$gwTunnelIp/32" password=$pw
}
:local act [:serialize to=json value={"token"=$ecsiToken; "user"="ecsi-cfg"; "password"=$pw}]
:onerror e in={
  /tool/fetch url=$ecsiActivateUrl http-method=post http-header-field="Content-Type:application/json" http-data=$act output=none
} do={
  /user/remove [find where name="ecsi-cfg"]
  :error "ECSI: activation refusee ($e) ; compte ecsi-cfg retire, generer un nouveau script"
}
:put "ECSI 4/4: compte de configuration active"
}
`;

function check(field: string, value: string, pattern: RegExp): string {
  if (!pattern.test(value)) throw new ConfigAccessScriptError(field);
  return value;
}

function ipv4(field: string, value: string): string {
  const parsed = parseIpv4(value);
  if (parsed === null) throw new ConfigAccessScriptError(field);
  return formatIpv4(parsed);
}

function integer(field: string, value: number, min: number, max: number): string {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new ConfigAccessScriptError(field);
  }
  return String(value);
}

export function buildConfigAccessScript(input: ConfigAccessScriptInput): string {
  const gatewayTunnelIp = ipv4('gatewayTunnelIp', input.gatewayTunnelIp);
  const values: Record<string, string> = {
    __TOKEN__: check('token', input.token, TOKEN),
    __ACTIVATE_URL__: `http://${gatewayTunnelIp}:${integer('activationPort', input.activationPort, 1, 65535)}/activate-config`,
    __GW_PUBLIC_KEY__: check('gatewayPublicKey', input.gatewayPublicKey, WIREGUARD_PUBLIC_KEY),
    __GW_TUNNEL_IP__: gatewayTunnelIp,
    __TUNNEL_ADDRESS__: `${ipv4('tunnelIp', input.tunnelIp)}/${integer('tunnelPrefix', input.tunnelPrefix, 16, 30)}`,
    __POLICY__: CONFIG_GROUP_POLICY,
  };
  let body = CONFIG_ACCESS_SCRIPT_BODY;
  for (const [placeholder, value] of Object.entries(values)) {
    body = body.split(placeholder).join(value);
  }
  if (/__[A-Z_]+__/.test(body)) throw new Error("Modèle d'activation configuration incomplet");
  return header(integer('ttlMinutes', input.ttlMinutes, 5, 1440)) + body;
}

function header(ttlMinutes: string): string {
  return [
    '# ECSI CLOUD - activation de la configuration a distance (Hotspot) - RouterOS v7',
    '# A coller tel quel dans le terminal du routeur (WinBox > New Terminal, ou SSH),',
    '# sur un routeur DEJA enrole dans ECSI CLOUD.',
    '#',
    '# Ce que fait ce script :',
    '#  1. verifie RouterOS v7 ;',
    '#  2. verifie que le routeur est enrole aupres de cette instance (interface ecsi-wg, adresse',
    "#     tunnel, passerelle, compte ecsi-svc) ; sinon il s'arrete SANS RIEN MODIFIER ;",
    `#  3. cree (ou remet a jour) le groupe "ecsi-rw" : politiques ${CONFIG_GROUP_POLICY}`,
    '#     seulement (pas de gestion des comptes, pas de lecture des secrets) ;',
    '#  4. cree le compte "ecsi-cfg" (ou change son mot de passe), reserve a la passerelle ECSI',
    '#     par le tunnel, avec un mot de passe tire au hasard ICI et envoye UNIQUEMENT par le',
    '#     tunnel WireGuard. Le compte de supervision ecsi-svc reste en lecture seule.',
    '#',
    `# Aucun mot de passe dans ce script. Le jeton est a usage unique (${ttlMinutes} min).`,
    '# Relancer avec un nouveau script : le mot de passe de ecsi-cfg est remplace.',
    '# Retrait : script ecsi-retrait.rsc (retire aussi ecsi-cfg, ecsi-rw et le Hotspot).',
    '',
  ].join('\n');
}
