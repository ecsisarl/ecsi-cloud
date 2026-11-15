import { WIREGUARD_PUBLIC_KEY } from '@ecsi/shared';
import { VERSION_GUARD } from './enrollment-script.js';
import { formatIpv4, parseIpv4 } from './tunnel-ip.js';

export interface EnrollmentResumeScriptInput {
  gatewayTunnelIp: string;
  activationPort: number;
  gatewayPublicKey: string;
  gatewayEndpoint: string;
  gatewayPort: number;
  tunnelIp: string;
  tunnelPrefix: number;
  routerPublicKey: string;
}

export class EnrollmentResumeScriptError extends Error {
  constructor(field: string) {
    super(`Valeur refusée dans le script de reprise d'enrôlement : ${field}`);
    this.name = 'EnrollmentResumeScriptError';
  }
}

const HOST =
  /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}[A-Za-z0-9])?)*$/;

function check(field: string, value: string, pattern: RegExp): string {
  if (!pattern.test(value)) throw new EnrollmentResumeScriptError(field);
  return value;
}

function ipv4(field: string, value: string): string {
  const parsed = parseIpv4(value);
  if (parsed === null) throw new EnrollmentResumeScriptError(field);
  return formatIpv4(parsed);
}

function integer(field: string, value: number, min: number, max: number): string {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new EnrollmentResumeScriptError(field);
  }
  return String(value);
}

export function buildEnrollmentResumeScript(input: EnrollmentResumeScriptInput): string {
  const gatewayTunnelIp = ipv4('gatewayTunnelIp', input.gatewayTunnelIp);
  const tunnelIp = ipv4('tunnelIp', input.tunnelIp);
  const tunnelPrefix = integer('tunnelPrefix', input.tunnelPrefix, 16, 30);
  const activationPort = integer('activationPort', input.activationPort, 1, 65535);
  const gatewayPort = integer('gatewayPort', input.gatewayPort, 1, 65535);
  const gatewayPublicKey = check('gatewayPublicKey', input.gatewayPublicKey, WIREGUARD_PUBLIC_KEY);
  const routerPublicKey = check('routerPublicKey', input.routerPublicKey, WIREGUARD_PUBLIC_KEY);
  const gatewayEndpoint = check('gatewayEndpoint', input.gatewayEndpoint, HOST);

  return String.raw`# ECSI CLOUD - reprise d'un enrolement interrompu
# Ce script NE CREE PAS de nouvelle identite WireGuard et NE CONTIENT AUCUN jeton.
# Il doit etre execute uniquement sur le routeur deja enrole dans ECSI CLOUD.

{
:local wgName "ecsi-wg"
:local expectedRouterPublicKey "${routerPublicKey}"
:local gwPublicKey "${gatewayPublicKey}"
:local gwEndpoint "${gatewayEndpoint}"
:local gwPort ${gatewayPort}
:local gwTunnelIp "${gatewayTunnelIp}"
:local tunnelAddress "${tunnelIp}/${tunnelPrefix}"
:local ecsiActivateUrl "http://${gatewayTunnelIp}:${activationPort}/activate"

# Controle RouterOS v7
:local ver [/system/resource/get version]
:if ([:pick $ver 0 1] != "7") do={
  :error "ECSI: RouterOS v7 requis"
}
${VERSION_GUARD}
# Le script de reprise ne cree ni interface, ni adresse, ni pair WireGuard.
:if ([:len [/interface/wireguard/find where name=$wgName]] != 1) do={
  :error "ECSI: interface ecsi-wg absente ou ambigue ; reprise annulee"
}

:local localPublicKey [/interface/wireguard/get [find where name=$wgName] public-key]
:if ($localPublicKey != $expectedRouterPublicKey) do={
  :error "ECSI: ce script de reprise appartient a un autre routeur"
}

:if ([:len [/ip/address/find where interface=$wgName address=$tunnelAddress]] != 1) do={
  :error "ECSI: adresse tunnel attendue absente ; reprise annulee"
}

:local gatewayPeers [/interface/wireguard/peers/find where interface=$wgName public-key=$gwPublicKey]
:if ([:len $gatewayPeers] != 1) do={
  :error "ECSI: pair passerelle attendu absent ou ambigu ; reprise annulee"
}

:local gatewayPeer [:pick $gatewayPeers 0]
# allowed-address est une liste : comparee a "$gwTunnelIp/32", elle n'est egale que si elle
# contient exactement cette seule adresse (mesure sur CHR 7.24.5, 2026-11-15).
:if ([/interface/wireguard/peers/get $gatewayPeer allowed-address] != "$gwTunnelIp/32") do={
  :error "ECSI: allowed-address de la passerelle inattendue ; reprise annulee"
}

# Pare-feu pose par l'enrolement (etape 4) : les cinq regles doivent etre presentes et actives,
# sinon l'API REST du routeur ne serait pas protegee comme prevu.
:foreach c in={"ecsi-cloud: retours du tunnel";"ecsi-cloud: API REST depuis la passerelle";"ecsi-cloud: ping depuis la passerelle";"ecsi-cloud: tout le reste du tunnel";"ecsi-cloud: API REST refusee ailleurs"} do={
  :if ([:len [/ip/firewall/filter/find where comment=$c disabled=no]] != 1) do={
    :error "ECSI: regle de pare-feu ECSI CLOUD absente, desactivee ou en double ($c) : reprise annulee ; appliquer le script de retrait ecsi-retrait.rsc puis un nouvel enrolement"
  }
}

# 7. Handshake WireGuard RECENT : RouterOS garde la date du dernier handshake quand le tunnel
# tombe (mesure sur CHR 7.24.5) ; seul un handshake de moins de 3 minutes prouve le tunnel.
:local up false
:for i from=1 to=30 do={
  :if (!$up) do={
    :if ([:len [/interface/wireguard/peers/find where interface=$wgName public-key=$gwPublicKey last-handshake<3m]] > 0) do={
      :set up true
    } else={
      :delay 2s
    }
  }
}
:if (!$up) do={
  :error "ECSI: pas de handshake avec la passerelle ; reprise interrompue"
}
:put "ECSI 7/9: tunnel etabli"

# 8. API REST HTTPS reservee a la passerelle
:if ([:len [/certificate/find where name="ecsi-api"]] = 0) do={
  /certificate/add name="ecsi-api" common-name="ecsi-api" key-size=prime256v1 days-valid=3650
  /certificate/sign "ecsi-api"
}
/ip/service/set [find where name="www-ssl"] certificate="ecsi-api" disabled=no

:local verNum [:pick $ver 0 [:find $ver " "]]
:local minorStr [:pick $verNum ([:find $verNum "."] + 1) [:len $verNum]]
:if ([:typeof [:find $minorStr "."]] != "nil") do={
  :set minorStr [:pick $minorStr 0 [:find $minorStr "."]]
}
:local minor [:tonum $minorStr]
:local svcParam "available-from"
:if ([:typeof $minor] = "num") do={
  :if ($minor < 24) do={ :set svcParam "address" }
}
:local restrict [:parse "/ip/service/set [find where name=\"www-ssl\"] $svcParam=$gwTunnelIp/32"]
$restrict
:put "ECSI 8/9: API REST HTTPS"

# 9. Compte de service et activation
:if ([:len [/user/group/find where name="ecsi-ro"]] = 0) do={
  /user/group/add name="ecsi-ro" policy=read,api,rest-api comment="ecsi-cloud"
}

# Ne jamais remplacer automatiquement un compte existant.
:if ([:len [/user/find where name="ecsi-svc"]] > 0) do={
  :error "ECSI: ecsi-svc existe deja ; reprise automatique refusee pour proteger le compte existant. Si ECSI CLOUD affiche toujours ce routeur en cours d'enrolement, retirer ce compte (/user/remove [find where name=\"ecsi-svc\"]) puis recoller ce script ; sinon ne rien faire"
}

:local pw [:rndstr length=32]
/user/add name="ecsi-svc" group="ecsi-ro" address="$gwTunnelIp/32" password=$pw comment="ecsi-cloud"

:local fp [/certificate/get [find where name="ecsi-api"] fingerprint]
:local act [:serialize to=json value={
  "user"="ecsi-svc";
  "password"=$pw;
  "tlsFingerprint"=$fp
}]

:onerror e in={
  /tool/fetch url=$ecsiActivateUrl http-method=post http-header-field="Content-Type:application/json" http-data=$act output=none
} do={
  # Refus certain (reponse HTTP 4xx) ou requete jamais arrivee : le compte est retire et la
  # reprise peut etre recollee. Sinon (delai depasse en attente de la reponse), le serveur a pu
  # enregistrer l'activation : le compte est conserve pour ne pas casser un routeur active.
  # Textes d'erreur de /tool/fetch mesures sur CHR 7.24.5 (2026-11-15).
  :if (([:typeof [:find $e "Status 4"]] = "num") || ([:typeof [:find $e "Connection refused"]] = "num") || ([:typeof [:find $e "unreachable"]] = "num") || ([:typeof [:find $e "timeout connecting"]] = "num")) do={
    /user/remove [find where name="ecsi-svc"]
    :error "ECSI: activation refusee ($e) ; compte de service retire, ce script peut etre recolle"
  }
  :error "ECSI: activation non confirmee ($e) ; compte de service conserve. Si ECSI CLOUD affiche ce routeur En ligne dans les 2 minutes, l'enrolement est termine ; s'il reste en cours d'enrolement, retirer ecsi-svc puis recoller ce script"
}

:put "ECSI 9/9: activation envoyee avec succes"
}
`;
}
