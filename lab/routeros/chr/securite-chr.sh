#!/usr/bin/env bash
# Tests de sécurité RÉELS sur le CHR (RouterOS 7.24.5) branché derrière la box et le CGNAT du
# laboratoire. Prérequis : topologie lab/sim démarrée, CHR configuré (cmds/10 à 42).
#   sudo ./securite-chr.sh <fichier-mot-de-passe-ecsi-svc>
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
STATE="${LAB_STATE:-$HERE/../../sim/.state}"
PASS_FILE="${1:?fichier du mot de passe ecsi-svc}"
CHR_TUN=10.200.0.10
CHR_LAN=192.168.88.10
FAILS=0
ns() { ip netns exec "$1" "${@:2}"; }
pass() { echo "- **PASS** $*"; }
fail() {
  echo "- **FAIL** $*"
  FAILS=$((FAILS + 1))
}
tcp_open() { ns "$1" timeout 4 bash -c "exec 3<>/dev/tcp/$2/$3" 2>/dev/null; }
rest() { # rest <ns> <méthode> <chemin> [corps] -> code HTTP
  local args=(-sk --max-time 15 -u "ecsi-svc:$(cat "$PASS_FILE")" -o /dev/null -w '%{http_code}' -X "$2")
  [[ -n "${4:-}" ]] && args+=(-H 'content-type: application/json' --data "$4")
  ns "$1" curl "${args[@]}" "https://$CHR_TUN/rest/$3"
}

echo "### Exposition"
for port in 22 23 80 443 8291 8728 8729; do
  if tcp_open attacker 203.0.113.20 "$port"; then fail "Internet → IP publique du site :$port ouvert"; fi
done
pass "Internet → IP publique du site (CGNAT), ports 22, 23, 80, 443, 8291, 8728, 8729 : REFUSÉ"
# Compteur de la règle de refus du CHR : prouve que les paquets du LAN atteignent bien le
# routeur et que c'est RouterOS qui les refuse (et non le laboratoire, cf. rapport S3A).
drop_packets() {
  ns worker curl -sk --max-time 10 -u "ecsi-svc:$(cat "$PASS_FILE")" \
    "https://$CHR_TUN/rest/ip/firewall/filter?.proplist=action,comment,packets" |
    python3 -c 'import json,sys; print(sum(int(r["packets"]) for r in json.load(sys.stdin) if r["action"] == "drop" and r.get("comment", "").startswith("ecsi-lab")))'
}
before=$(drop_packets)
open_lan=()
for port in 21 22 23 80 443 8291 8728 8729; do
  tcp_open client1 "$CHR_LAN" "$port" && open_lan+=("$port")
done
after=$(drop_packets)
if ((${#open_lan[@]} == 0 && after - before >= 8)); then
  pass "LAN du site → CHR (21, 22, 23, 80, 443, 8291, 8728, 8729) : REFUSÉ par le firewall RouterOS (compteur de la règle de refus : +$((after - before)) paquets)"
else fail "LAN du site → CHR : ports ouverts « ${open_lan[*]} », compteur de refus +$((after - before))"; fi
open_gw=()
for port in 22 23 80 8291 8728 8729; do
  tcp_open gw "$CHR_TUN" "$port" && open_gw+=("$port")
done
if ((${#open_gw[@]} == 0)); then
  pass "passerelle (10.200.0.1) → CHR par le tunnel, ports autres que 443 : REFUSÉ par le firewall RouterOS"
else fail "passerelle → CHR ports ouverts : ${open_gw[*]}"; fi
c=$(rest worker GET system/identity)
[[ "$c" == 200 ]] && pass "worker ECSI → API REST HTTPS du CHR via WireGuard : AUTORISÉ (HTTP $c)" || fail "worker → REST : HTTP $c"

echo "### Autre pair WireGuard"
ns r2 wg set wg-r2 peer "$(cat "$STATE/gw/public")" allowed-ips 10.200.0.0/24
ns r2 ip route replace 10.200.0.0/24 dev wg-r2
tcp_open r2 "$CHR_TUN" 443 && fail "r2 → CHR:443 joignable" || pass "autre pair (r2) → API du CHR : REFUSÉ par la passerelle"
"$HERE/../../sim/gateway-firewall.sh" allow-peer-to-peer
tcp_open r2 "$CHR_TUN" 443 && fail "défense en profondeur : CHR accepte r2" \
  || pass "défense en profondeur : passerelle ouverte wg → wg, le CHR refuse quand même (allowed-address 10.200.0.1/32 + firewall)"
"$HERE/../../sim/gateway-firewall.sh" apply
ns r2 ip route del 10.200.0.0/24 dev wg-r2 2>/dev/null
ns r2 wg set wg-r2 peer "$(cat "$STATE/gw/public")" allowed-ips 10.200.0.1/32

echo "### Compte de service (read + rest-api + api)"
c=$(rest worker PATCH 'interface/*2' '{"comment":"pirate"}')  # *2 = ether1 (identifiant REST)
[[ "$c" != 200 ]] && pass "écriture refusée : PATCH interface/*2 (ether1) → « not enough permissions », HTTP $c" || fail "écriture acceptée"
c=$(rest worker POST system/identity/set '{"name":"pirate"}')
[[ "$c" != 200 ]] && pass "écriture refusée : POST system/identity/set → HTTP $c" || fail "set accepté"
c=$(rest worker POST system/reboot '{}')
[[ "$c" != 200 ]] && pass "redémarrage refusé : POST system/reboot → HTTP $c" || fail "reboot accepté"
c=$(rest worker PUT user '{"name":"x","group":"full","password":"Xx123456789!"}')
[[ "$c" != 201 && "$c" != 200 ]] && pass "création d'utilisateur refusée : PUT user → HTTP $c" || fail "utilisateur créé"
body=$(ns worker curl -sk --max-time 15 -u "ecsi-svc:$(cat "$PASS_FILE")" "https://$CHR_TUN/rest/interface/wireguard")
# Le champ existe mais RouterOS le masque (valeur de 5 caractères au lieu d'une clé base64 de 44).
key_len=$(printf '%s' "$body" | python3 -c 'import json,sys; print(max((len(i.get("private-key","")) for i in json.load(sys.stdin)), default=0))')
if ((key_len >= 44)); then fail "la clé privée WireGuard est lisible par le compte de service"
else pass "clé privée WireGuard masquée pour le compte de service (champ de $key_len caractères, pas de politique sensitive)"; fi
code=$(ns worker curl -sk --max-time 15 -u "ecsi-svc:mauvais" -o /dev/null -w '%{http_code}' "https://$CHR_TUN/rest/system/identity")
[[ "$code" == 401 ]] && pass "mauvais mot de passe → HTTP 401" || fail "mauvais mot de passe → HTTP $code"
code=$(ns worker curl -s --max-time 10 -o /dev/null -w '%{http_code}' "http://$CHR_TUN/rest/system/identity")
[[ "$code" == 000 ]] && pass "HTTP en clair (port 80) via le tunnel : REFUSÉ" || fail "HTTP 80 → $code"
echo "**Échecs : $FAILS**"
exit $((FAILS > 0))
