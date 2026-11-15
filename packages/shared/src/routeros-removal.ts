/**
 * Script de retrait RouterOS v7 (Sprint 3B-RC2, complété au lot B) : retire d'un MikroTik la
 * configuration créée par le script d'enrôlement, le script d'activation configuration
 * (ecsi-cfg, ecsi-rw) et le provisionnement Hotspot (objets étiquetés ecsi-cloud:hs:<id> et,
 * pour /ip/hotspot et son profil qui n'ont pas de commentaire, nommés ecsi-hs-*), avant un
 * ré-enrôlement. Les règles de filtrage Hotspot sont retirées par la ligne ecsi-cloud existante. Le corps (à partir de l'accolade
 * ouvrante) est REPRIS À L'IDENTIQUE du modèle validé sur CHR 7.24.5
 * (lab/routeros/enrolement/ecsi-retrait.rsc) ; un test vérifie l'égalité. Aucun secret.
 */
export const ROUTER_REMOVAL_SCRIPT_FILE = 'ecsi-retrait.rsc';

export const ROUTER_REMOVAL_SCRIPT_HEADER = String.raw`# ECSI CLOUD - retrait d'un routeur MikroTik (RouterOS v7)
# A appliquer AVANT de re-enroler un routeur deja enrole (routeur supprime dans ECSI CLOUD).
# Methode recommandee : envoyer ce fichier sur le routeur (WinBox > Files, ou SFTP/SCP) sous le
# nom ecsi-retrait.rsc, puis : /import file-name=ecsi-retrait.rsc
# Il peut aussi etre colle dans le terminal du routeur (WinBox > New Terminal). Ne pas l'envoyer
# brut sur l'entree standard d'une session SSH non interactive (erreurs d'analyse constatees).
# Supprime UNIQUEMENT ce que ECSI CLOUD a cree (objets "ecsi-*", Hotspot compris) ; le reste de la
# configuration et les regles de firewall existantes ne sont pas modifies.
`;

export const ROUTER_REMOVAL_SCRIPT_BODY = String.raw`{
/ip/hotspot/remove [find where name~"^ecsi-hs-"]
/ip/hotspot/profile/remove [find where name~"^ecsi-hs-"]
/ip/firewall/nat/remove [find where comment~"^ecsi-cloud:hs:"]
/radius/remove [find where comment~"^ecsi-cloud:hs:"]
/ip/dhcp-server/remove [find where comment~"^ecsi-cloud:hs:"]
/ip/dhcp-server/network/remove [find where comment~"^ecsi-cloud:hs:"]
/ip/pool/remove [find where comment~"^ecsi-cloud:hs:"]
/ip/address/remove [find where comment~"^ecsi-cloud:hs:"]
/user/remove [find where name="ecsi-cfg"]
/user/group/remove [find where name="ecsi-rw"]
/user/remove [find where name="ecsi-svc"]
/user/group/remove [find where name="ecsi-ro"]
:local ver [/system/resource/get version]
:local verNum [:pick $ver 0 [:find $ver " "]]
:local minorStr [:pick $verNum ([:find $verNum "."] + 1) [:len $verNum]]
:if ([:typeof [:find $minorStr "."]] != "nil") do={ :set minorStr [:pick $minorStr 0 [:find $minorStr "."]] }
:local minor [:tonum $minorStr]
:local svcParam "available-from"
:if ([:typeof $minor] = "num") do={ :if ($minor < 24) do={ :set svcParam "address" } }
:local unrestrict [:parse "/ip/service/set [find where name=\"www-ssl\"] disabled=yes certificate=none $svcParam=\"\""]
$unrestrict
/certificate/remove [find where name="ecsi-api"]
/certificate/remove [find where name~"^ecsi-ca"]
/ip/firewall/filter/remove [find where comment~"^ecsi-cloud"]
/interface/wireguard/peers/remove [find where interface="ecsi-wg"]
/ip/address/remove [find where interface="ecsi-wg"]
/interface/wireguard/remove [find where name="ecsi-wg"]
:put "ECSI: configuration ECSI CLOUD retiree"
}
`;

export const ROUTER_REMOVAL_SCRIPT = ROUTER_REMOVAL_SCRIPT_HEADER + ROUTER_REMOVAL_SCRIPT_BODY;
