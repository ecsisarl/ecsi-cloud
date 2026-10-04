# ECSI CLOUD - retrait d'un routeur (RouterOS v7) - MODELE DE LABORATOIRE S3A
# Supprime UNIQUEMENT ce que le script d'enrolement a cree (objets "ecsi-*"), sans toucher au
# reste de la configuration. Le firewall existant n'est pas modifie : seules les regles
# commentees "ecsi-cloud" sont retirees. Cote cloud, le pair est retire de la passerelle
# (etat REVOKED) : sans lui, plus aucun trafic ne passe, meme si ce script n'est pas execute.
{
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
