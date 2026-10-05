/**
 * Script d'enrôlement RouterOS v7 (Sprint 3B), collé par l'administrateur dans le terminal du
 * routeur. Le corps est REPRIS À L'IDENTIQUE du modèle validé sur CHR 7.24.5 au laboratoire
 * (lab/routeros/enrolement/ecsi-enrolement.rsc.modele, résultats
 * lab/routeros/resultats/2026-10-04-S3A-chr-enrolement.md). Seule addition : le contrôle de
 * ré-enrôlement REENROLL_GUARD (S3B-RC2), inséré après l'étape 1 et validé sur CHR 7.24.5.
 * Un test unitaire vérifie l'égalité avec le modèle du laboratoire plus ce contrôle.
 *
 * Sans AC de laboratoire configurée, l'étape 2 (import de l'AC) est retirée : le certificat de
 * l'API est alors vérifié par le magasin intégré de RouterOS (AC publique). Cette variante
 * n'a PAS été testée sur un routeur réel (le CHR du laboratoire n'a pas d'accès Internet).
 *
 * Anti-injection : chaque valeur substituée est validée par une expression stricte qui exclut
 * tout caractère interprété par la console RouterOS (" $ \\ ; [ ] { } espace, retour ligne).
 */
import { WIREGUARD_PUBLIC_KEY } from '@ecsi/shared';
import { formatIpv4, parseIpv4 } from './tunnel-ip.js';

export interface EnrollmentScriptInput {
  token: string;
  enrollUrl: string;
  /** Adresse tunnel de la passerelle (ROUTER_TUNNEL_GATEWAY). */
  gatewayTunnelIp: string;
  activationPort: number;
  gatewayPublicKey: string;
  gatewayEndpoint: string;
  gatewayPort: number;
  /** Adresse tunnel attribuée au routeur et longueur du préfixe du réseau tunnel. */
  tunnelIp: string;
  tunnelPrefix: number;
  ttlMinutes: number;
  /** Laboratoire seulement. */
  ca?: { url: string; fingerprint: string } | null;
}

export class EnrollmentScriptError extends Error {
  constructor(field: string) {
    super(`Valeur refusée dans le script d'enrôlement : ${field}`);
    this.name = 'EnrollmentScriptError';
  }
}

const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const HTTPS_URL = /^https:\/\/[A-Za-z0-9.-]+(?::[0-9]{1,5})?(?:\/[A-Za-z0-9._~/-]*)?$/;
const HOST =
  /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}[A-Za-z0-9])?)*$/;
const SHA256 = /^[0-9a-f]{64}$/;

/** Corps du modèle de laboratoire (à partir de l'accolade ouvrante), sans modification. */
export const ENROLLMENT_SCRIPT_BODY = String.raw`{
:local ecsiToken "__TOKEN__"
:local ecsiEnrollUrl "__ENROLL_URL__"
:local ecsiActivateUrl "__ACTIVATE_URL__"
:local ecsiCaUrl "__CA_URL__"
:local ecsiCaFingerprint "__CA_FINGERPRINT__"
:local gwPublicKey "__GW_PUBLIC_KEY__"
:local gwEndpoint "__GW_ENDPOINT__"
:local gwPort __GW_PORT__
:local gwTunnelIp "__GW_TUNNEL_IP__"
:local tunnelAddress "__TUNNEL_ADDRESS__"
:local wgName "ecsi-wg"

# 1. Version
:local ver [/system/resource/get version]
:if ([:pick $ver 0 1] != "7") do={ :error "ECSI: RouterOS v7 requis (version: $ver)" }
:put "ECSI 1/9: RouterOS $ver"

# 2. AC du laboratoire (en production : AC publique, magasin integre, etape supprimee)
:if ([:len [/certificate/find where fingerprint=$ecsiCaFingerprint]] = 0) do={
  /tool/fetch url=$ecsiCaUrl dst-path="ecsi-ca.pem" check-certificate=no
  :delay 1s
  /certificate/import file-name="ecsi-ca.pem" name="ecsi-ca" trusted=yes trust-store=fetch
  /file/remove [find name="ecsi-ca.pem"]
  :if ([:len [/certificate/find where fingerprint=$ecsiCaFingerprint]] = 0) do={
    /certificate/remove [find where name~"^ecsi-ca"]
    :error "ECSI: empreinte de l'AC inattendue, enrolement annule"
  }
}
:put "ECSI 2/9: AC verifiee"

# 3. Interface WireGuard (cle privee generee par RouterOS a la creation)
:if ([:len [/interface/wireguard/find where name=$wgName]] = 0) do={
  /interface/wireguard/add name=$wgName listen-port=13231 comment="ecsi-cloud"
}
:local routerPublicKey [/interface/wireguard/get [find where name=$wgName] public-key]
:put "ECSI 3/9: interface $wgName, cle publique $routerPublicKey"

# 4. Firewall : regles placees AVANT toutes les regles input existantes
:if ([:len [/ip/firewall/filter/find where comment~"^ecsi-cloud"]] = 0) do={
  :local first [/ip/firewall/filter/find where chain="input"]
  :local rules ({})
  :set rules ($rules, [/ip/firewall/filter/add chain=input action=accept in-interface=$wgName connection-state=established,related comment="ecsi-cloud: retours du tunnel"])
  :set rules ($rules, [/ip/firewall/filter/add chain=input action=accept in-interface=$wgName src-address=$gwTunnelIp protocol=tcp dst-port=443 comment="ecsi-cloud: API REST depuis la passerelle"])
  :set rules ($rules, [/ip/firewall/filter/add chain=input action=accept in-interface=$wgName src-address=$gwTunnelIp protocol=icmp comment="ecsi-cloud: ping depuis la passerelle"])
  :set rules ($rules, [/ip/firewall/filter/add chain=input action=drop in-interface=$wgName comment="ecsi-cloud: tout le reste du tunnel"])
  :set rules ($rules, [/ip/firewall/filter/add chain=input action=drop protocol=tcp dst-port=443 comment="ecsi-cloud: API REST refusee ailleurs"])
  :if ([:len $first] > 0) do={
    /ip/firewall/filter/move $rules [:pick $first 0]
  }
}
:put "ECSI 4/9: firewall"

# 5. Adresse tunnel et pair passerelle (allowed-address /32 uniquement)
:if ([:len [/ip/address/find where interface=$wgName]] = 0) do={
  /ip/address/add address=$tunnelAddress interface=$wgName comment="ecsi-cloud"
}
:if ([:len [/interface/wireguard/peers/find where interface=$wgName]] = 0) do={
  /interface/wireguard/peers/add interface=$wgName name="ecsi-gateway" public-key=$gwPublicKey endpoint-address=$gwEndpoint endpoint-port=$gwPort allowed-address="$gwTunnelIp/32" persistent-keepalive=25s comment="ecsi-cloud"
}
:put "ECSI 5/9: pair passerelle"

# 6. Enrolement : jeton + cle publique, HTTPS avec certificat verifie
:local body [:serialize to=json value={"token"=$ecsiToken; "publicKey"=$routerPublicKey}]
:local enrolled false
:onerror e in={
  /tool/fetch url=$ecsiEnrollUrl http-method=post http-header-field="Content-Type:application/json" http-data=$body check-certificate=yes output=none
  :set enrolled true
} do={ :put "ECSI 6/9: enrolement refuse ou serveur injoignable ($e)" }
:if ($enrolled) do={ :put "ECSI 6/9: enrolement accepte" }

# 7. Handshake WireGuard (initie par le routeur), 60 s maximum
:local up false
:for i from=1 to=30 do={
  :if (!$up) do={
    :if ([:len [/interface/wireguard/peers/find where interface=$wgName last-handshake]] > 0) do={
      :set up true
    } else={ :delay 2s }
  }
}
:if (!$up) do={ :error "ECSI: pas de handshake avec la passerelle (jeton refuse, ou UDP $gwPort sortant bloque)" }
:put "ECSI 7/9: tunnel etabli"

# 8. API REST en HTTPS, reservee a l'adresse tunnel de la passerelle
:if ([:len [/certificate/find where name="ecsi-api"]] = 0) do={
  /certificate/add name="ecsi-api" common-name="ecsi-api" key-size=prime256v1 days-valid=3650
  /certificate/sign "ecsi-api"
}
/ip/service/set [find where name="www-ssl"] certificate="ecsi-api" disabled=no
# Restriction du service a la passerelle : RouterOS 7.24 a renomme "address" en
# "available-from" (changelog 7.24) ; la commande est construite selon la version.
:local verNum [:pick $ver 0 [:find $ver " "]]
:local minorStr [:pick $verNum ([:find $verNum "."] + 1) [:len $verNum]]
:if ([:typeof [:find $minorStr "."]] != "nil") do={ :set minorStr [:pick $minorStr 0 [:find $minorStr "."]] }
:local minor [:tonum $minorStr]
:local svcParam "available-from"
:if ([:typeof $minor] = "num") do={ :if ($minor < 24) do={ :set svcParam "address" } }
:local restrict [:parse "/ip/service/set [find where name=\"www-ssl\"] $svcParam=$gwTunnelIp/32"]
$restrict
:put "ECSI 8/9: API REST HTTPS"

# 9. Compte de service en lecture ; mot de passe genere ici, envoye par le tunnel uniquement
:if ([:len [/user/group/find where name="ecsi-ro"]] = 0) do={
  /user/group/add name="ecsi-ro" policy=read,api,rest-api comment="ecsi-cloud"
}
:if ([:len [/user/find where name="ecsi-svc"]] > 0) do={
  :put "ECSI 9/9: compte de service deja present, inchange : routeur deja enrole"
} else={
  :local pw [:rndstr length=32]
  /user/add name="ecsi-svc" group="ecsi-ro" address="$gwTunnelIp/32" password=$pw comment="ecsi-cloud"
  :local fp [/certificate/get [find where name="ecsi-api"] fingerprint]
  :local act [:serialize to=json value={"user"="ecsi-svc"; "password"=$pw; "tlsFingerprint"=$fp}]
  :onerror e in={
    /tool/fetch url=$ecsiActivateUrl http-method=post http-header-field="Content-Type:application/json" http-data=$act output=none
  } do={
    /user/remove [find where name="ecsi-svc"]
    :error "ECSI: activation refusee ($e) ; compte de service retire"
  }
  :put "ECSI 9/9: routeur enrole, en attente de verification par ECSI CLOUD"
}
}
`;

const CA_STEP_START = '# 2. AC du laboratoire';
const CA_STEP_END = ':put "ECSI 2/9: AC verifiee"\n';
const CA_LOCALS = ':local ecsiCaUrl "__CA_URL__"\n:local ecsiCaFingerprint "__CA_FINGERPRINT__"\n';
const PUBLIC_CA_STEP =
  "# 2. Certificat de l'API verifie par le magasin integre de RouterOS (AC publique)\n" +
  ':put "ECSI 2/9: AC publique (magasin integre)"\n';

function check(field: string, value: string, pattern: RegExp): string {
  if (!pattern.test(value)) throw new EnrollmentScriptError(field);
  return value;
}

function ipv4(field: string, value: string): string {
  const parsed = parseIpv4(value);
  if (parsed === null) throw new EnrollmentScriptError(field);
  return formatIpv4(parsed);
}

function integer(field: string, value: number, min: number, max: number): string {
  if (!Number.isInteger(value) || value < min || value > max)
    throw new EnrollmentScriptError(field);
  return String(value);
}

/** Fin de l'étape 1 du modèle : le contrôle de ré-enrôlement est inséré juste après. */
const STEP1_END = ':put "ECSI 1/9: RouterOS $ver"\n';

/**
 * Contrôle ajouté au modèle S3A (Sprint 3B-RC2, rapport de validation §6.4) : un routeur
 * déjà enrôlé puis supprimé dans ECSI CLOUD garde son interface ecsi-wg, son adresse tunnel et
 * son pair passerelle ; le modèle les réutilise sans les remplacer, et le ré-enrôlement
 * échouait (nouvelle adresse attribuée par le cloud, ancienne adresse sur le routeur). Le
 * script s'arrête désormais AVANT toute modification et demande d'appliquer le script de
 * retrait (ROUTER_REMOVAL_SCRIPT). Un recollage du MÊME script (même adresse, même passerelle)
 * reste sans effet de bord, comme validé au S3A. Commandes vérifiées sur CHR 7.24.5
 * (lab/routeros/resultats/2026-10-05-S3B-RC2-chr-regression.md).
 */
export const REENROLL_GUARD = String.raw`
# 1b. Ancienne configuration ECSI CLOUD (routeur supprime puis re-enrole) : arret AVANT toute
#     modification si l'adresse tunnel ou la passerelle configurees different de ce script.
:foreach a in=[/ip/address/find where interface=$wgName] do={
  :local current [/ip/address/get $a address]
  :if ($current != $tunnelAddress) do={
    :error "ECSI: ancienne configuration ECSI CLOUD detectee ($wgName $current) : appliquer d'abord le script de retrait ecsi-retrait.rsc, puis recoller ce script"
  }
}
:foreach p in=[/interface/wireguard/peers/find where interface=$wgName] do={
  :if ([/interface/wireguard/peers/get $p public-key] != $gwPublicKey) do={
    :error "ECSI: ancienne passerelle ECSI CLOUD sur $wgName : appliquer d'abord le script de retrait ecsi-retrait.rsc, puis recoller ce script"
  }
}
`;

export function buildEnrollmentScript(input: EnrollmentScriptInput): string {
  const gatewayTunnelIp = ipv4('gatewayTunnelIp', input.gatewayTunnelIp);
  const values: Record<string, string> = {
    __TOKEN__: check('token', input.token, TOKEN),
    __ENROLL_URL__: check('enrollUrl', input.enrollUrl, HTTPS_URL),
    __ACTIVATE_URL__: `http://${gatewayTunnelIp}:${integer('activationPort', input.activationPort, 1, 65535)}/activate`,
    __GW_PUBLIC_KEY__: check('gatewayPublicKey', input.gatewayPublicKey, WIREGUARD_PUBLIC_KEY),
    __GW_ENDPOINT__: check('gatewayEndpoint', input.gatewayEndpoint, HOST),
    __GW_PORT__: integer('gatewayPort', input.gatewayPort, 1, 65535),
    __GW_TUNNEL_IP__: gatewayTunnelIp,
    __TUNNEL_ADDRESS__: `${ipv4('tunnelIp', input.tunnelIp)}/${integer('tunnelPrefix', input.tunnelPrefix, 16, 30)}`,
  };
  if (!ENROLLMENT_SCRIPT_BODY.includes(STEP1_END)) {
    throw new Error("Modèle d'enrôlement inattendu (étape 1)");
  }
  let body = ENROLLMENT_SCRIPT_BODY.replace(STEP1_END, STEP1_END + REENROLL_GUARD);
  if (input.ca) {
    values.__CA_URL__ = check('ca.url', input.ca.url, HTTPS_URL);
    values.__CA_FINGERPRINT__ = check('ca.fingerprint', input.ca.fingerprint, SHA256);
  } else {
    const start = body.indexOf(CA_STEP_START);
    const end = body.indexOf(CA_STEP_END);
    if (start < 0 || end < start || !body.includes(CA_LOCALS)) {
      throw new Error("Modèle d'enrôlement inattendu (étape 2)");
    }
    body = body.slice(0, start) + PUBLIC_CA_STEP + body.slice(end + CA_STEP_END.length);
    body = body.replace(CA_LOCALS, '');
  }
  for (const [placeholder, value] of Object.entries(values)) {
    body = body.split(placeholder).join(value);
  }
  if (/__[A-Z_]+__/.test(body)) throw new Error("Modèle d'enrôlement incomplet");
  return header(integer('ttlMinutes', input.ttlMinutes, 5, 1440), Boolean(input.ca)) + body;
}

function header(ttlMinutes: string, labCa: boolean): string {
  return [
    "# ECSI CLOUD - enrolement d'un routeur MikroTik (RouterOS v7)",
    '# A coller tel quel dans le terminal du routeur (WinBox > New Terminal, ou SSH).',
    '#',
    '# Ce que fait ce script :',
    '#  1. verifie RouterOS v7 ;',
    labCa
      ? "#  2. (labo) installe l'AC du laboratoire apres verification de son empreinte SHA-256 ;"
      : "#  2. (rien a faire : le certificat de l'API est verifie par le magasin integre) ;",
    '#  3. cree l\'interface WireGuard "ecsi-wg" : la CLE PRIVEE EST GENEREE PAR LE ROUTEUR et',
    "#     n'en sort jamais ; une interface deja presente est reutilisee (cle conservee) ;",
    "#  4. ajoute en TETE de la chaine input des regles qui n'ouvrent l'API REST (HTTPS 443)",
    "#     qu'a la passerelle ECSI, par le tunnel ; aucune regle existante n'est modifiee ;",
    '#  5. configure l\'adresse tunnel et le pair "passerelle" (allowed-address /32, keepalive 25 s) ;',
    "#  6. envoie au cloud, en HTTPS avec certificat verifie, le jeton et la CLE PUBLIQUE (rien d'autre) ;",
    '#  7. attend le handshake WireGuard (le routeur initie : fonctionne derriere NAT/CGNAT) ;',
    "#  8. active l'API REST en HTTPS (certificat autosigne genere ici), reservee a la passerelle ;",
    '#  9. cree le compte de service en lecture (read, api, rest-api) avec un mot de passe tire au',
    "#     hasard ICI, et l'envoie au cloud UNIQUEMENT par le tunnel.",
    '#',
    `# Aucun mot de passe ni cle privee dans ce script. Le jeton est a usage unique (${ttlMinutes} min).`,
    "# Relancer le script : rien n'est cree en double, la cle WireGuard n'est jamais regeneree,",
    "# un compte de service existant n'est pas modifie.",
    '#',
    "# Routeur deja enrole puis supprime dans ECSI CLOUD : appliquer d'abord le script de retrait",
    "# (ecsi-retrait.rsc, fourni par ECSI CLOUD) ; sinon ce script s'arrete sans rien modifier.",
    '',
  ].join('\n');
}
