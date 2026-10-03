#!/usr/bin/env bash
# ECSI CLOUD — scénarios du laboratoire réseau SIMULÉ (Sprint 3A).
#
# Chaque scénario affiche PASS/FAIL et ses mesures ; le résumé est écrit dans
# $LAB_STATE/resultats.md. Les « routeurs » sont des pairs Linux (voir topology.sh) :
# ces résultats valident le RÉSEAU (NAT, CGNAT, keepalive, firewall, reprise), pas RouterOS.
#
# Usage : sudo ./run-tests.sh            (démarre la topologie, puis tous les scénarios)
#         sudo ./run-tests.sh <scénario>  (topologie déjà démarrée)
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
export LAB_STATE="${LAB_STATE:-$HERE/.state}"
STATE="$LAB_STATE"
API_PORT=8443
# Seuils de l'état d'un routeur (proposés pour ECSI CLOUD, voir docs/MIKROTIK.md) :
# WireGuard renégocie la session toutes les 120 s tant que du trafic circule (keepalive
# compris) ; au-delà de 180 s sans handshake, le tunnel est considéré comme tombé.
OFFLINE_AFTER=180
RESULTS="$STATE/resultats.md"
FAILS=0

ns() { ip netns exec "$1" "${@:2}"; }
now() { date +%s.%N; }
since() { printf '%.1f' "$(echo "$(now) - $1" | bc)"; }
log() { printf '%s\n' "$*" | tee -a "$RESULTS"; }
pass() { log "- **PASS** $*"; }
fail() {
  log "- **FAIL** $*"
  FAILS=$((FAILS + 1))
}

pub() { cat "$STATE/$1/public"; }
api_ok() { ns "${2:-worker}" curl -s --max-time "${3:-2}" "http://$1:$API_PORT/" >/dev/null; }
# Âge du dernier handshake vu par la passerelle (secondes ; -1 = jamais).
hs_age() {
  local ts
  ts=$(ns gw wg show wg-gw latest-handshakes | awk -v k="$(pub "$1")" '$1 == k { print $2 }')
  if [[ -z "$ts" || "$ts" == 0 ]]; then echo -1; else echo $(($(date +%s) - ts)); fi
}
# État calculé comme le ferait le futur moniteur d'ECSI CLOUD. REVOKED et ERROR ne sont pas
# déduits du réseau : REVOKED est une décision d'administration, ERROR une réponse invalide
# de l'API (authentification, permission, format), testée sur CHR.
state() { # state <routeur> <ip>
  local age
  age=$(hs_age "$1")
  if ((age < 0)); then
    echo PROVISIONING
  elif ((age > OFFLINE_AFTER)); then
    echo OFFLINE
  elif api_ok "$2"; then
    echo ONLINE
  else
    echo DEGRADED
  fi
}
wait_for() { # wait_for <timeout_s> <commande…> : renvoie la durée ou échoue
  local start t
  start=$(now)
  t=$1
  shift
  while (($(echo "$(now) - $start < $t" | bc))); do
    if "$@"; then
      since "$start"
      return 0
    fi
    sleep 0.5
  done
  return 1
}
wait_state() { [[ "$(state "$1" "$2")" == "$3" ]]; }
api_down() { ! api_ok "$1"; }

restart_router_wg() { # Simule le redémarrage du routeur : processus et interface détruits.
  local r=$1 ip=$2
  ns "$r" ip link del "wg-$r" 2>/dev/null
  pkill -f "wireguard-go -f wg-$r" 2>/dev/null
  rm -f "/var/run/wireguard/wg-$r.sock"
}
start_router_wg() {
  local r=$1 ip=$2
  ns "$r" setsid wireguard-go -f "wg-$r" >>"$STATE/wg-$r.log" 2>&1 &
  for _ in $(seq 50); do [[ -S "/var/run/wireguard/wg-$r.sock" ]] && break; sleep 0.1; done
  ns "$r" ip addr add "$ip/32" dev "wg-$r"
  ns "$r" ip link set "wg-$r" up
  ns "$r" wg set "wg-$r" private-key "$STATE/$r/private"
  ns "$r" wg set "wg-$r" peer "$(pub gw)" endpoint 203.0.113.10:51820 \
    allowed-ips 10.200.0.1/32 persistent-keepalive "${KEEPALIVE:-25}"
  ns "$r" ip route add 10.200.0.1/32 dev "wg-$r" 2>/dev/null
}

# ---------------------------------------------------------------------------------------
t_handshake() {
  log "### 1. Handshake derrière NAT et CGNAT, sans redirection de port"
  local d
  if d=$(wait_for 20 api_ok 10.200.0.2); then
    pass "r1 (double NAT : box + CGNAT) joignable par le worker via 10.200.0.2 en ${d} s"
  else fail "r1 injoignable"; fi
  if d=$(wait_for 20 api_ok 10.200.0.3); then
    pass "r2 (NAT simple) joignable via 10.200.0.3 en ${d} s"
  else fail "r2 injoignable"; fi
  local ep
  ep=$(ns gw wg show wg-gw endpoints | awk -v k="$(pub r1)" '$1 == k { print $2 }')
  log "  - endpoint de r1 vu par la passerelle : \`$ep\` (adresse publique du CGNAT, port choisi par le NAT)"
  if ns cgn iptables -t nat -S | grep -q DNAT || ns cpe iptables -t nat -S | grep -q DNAT; then
    fail "une redirection de port existe sur le chemin"
  else pass "aucune règle DNAT (redirection de port) sur la box ni sur le CGNAT"; fi
  local r
  r=$(ns worker curl -s --max-time 2 "http://10.200.0.2:$API_PORT/")
  if [[ "$r" == *'"client": "10.200.0.1"'* ]]; then
    pass "le routeur voit uniquement l'adresse tunnel de la passerelle (10.200.0.1) comme client"
  else fail "adresse source inattendue côté routeur : $r"; fi
}

t_security() {
  log "### 2. Sécurité : exposition et cloisonnement"
  if ns attacker curl -s --max-time 3 "http://203.0.113.20:$API_PORT/" >/dev/null; then
    fail "Internet → IP publique du CGNAT : service joignable"
  else pass "Internet → IP publique du site (CGNAT) :$API_PORT : REFUSÉ (aucun chemin entrant)"; fi
  if ns attacker curl -s --max-time 3 "http://203.0.113.10:$API_PORT/" >/dev/null; then
    fail "Internet → passerelle :$API_PORT joignable"
  else pass "Internet → passerelle :$API_PORT : REFUSÉ (seul UDP 51820 est ouvert)"; fi
  ns attacker ip route add 10.200.0.0/24 via 203.0.113.10 2>/dev/null
  if ns attacker curl -s --max-time 3 "http://10.200.0.2:$API_PORT/" >/dev/null; then
    fail "Internet → 10.200.0.2 routé par la passerelle"
  else pass "Internet → adresse tunnel du routeur (route forcée via la passerelle) : REFUSÉ"; fi
  ns attacker ip route del 10.200.0.0/24 via 203.0.113.10 2>/dev/null
  if ns client1 curl -s --max-time 3 "http://192.168.88.2:$API_PORT/" >/dev/null; then
    fail "LAN du site → service d'administration du routeur joignable"
  else pass "LAN du site (client WiFi) → service d'administration du routeur : REFUSÉ"; fi
  if api_ok 10.200.0.2; then
    pass "worker ECSI autorisé → routeur via WireGuard : AUTORISÉ"
  else fail "worker → routeur refusé"; fi

  # Autre pair WireGuard malveillant : on élargit SES allowed-ips (il contrôle son routeur).
  ns r2 wg set wg-r2 peer "$(pub gw)" allowed-ips 10.200.0.0/24
  ns r2 ip route replace 10.200.0.0/24 dev wg-r2
  if api_ok 10.200.0.2 r2; then
    fail "autre pair (r2) → API de r1 joignable"
  else pass "autre pair WireGuard (r2) → API de r1 : REFUSÉ par la passerelle (wg → wg interdit)"; fi
  "$HERE/gateway-firewall.sh" allow-peer-to-peer
  if api_ok 10.200.0.2 r2; then
    fail "défense en profondeur : r1 accepte une source autre que 10.200.0.1"
  else pass "défense en profondeur : même avec wg → wg ouvert sur la passerelle, r1 refuse (allowed-ips strict 10.200.0.1/32 + firewall du routeur)"; fi
  "$HERE/gateway-firewall.sh" apply
  # Usurpation : r2 émet avec l'adresse de r1.
  ns r2 ip addr add 10.200.0.2/32 dev wg-r2
  local before after
  before=$(ns gw iptables -L INPUT -v -n -x | awk '/icmptype 8/ { print $1 }')
  ns r2 ping -c 3 -W 1 -I 10.200.0.2 10.200.0.1 >/dev/null 2>&1
  after=$(ns gw iptables -L INPUT -v -n -x | awk '/icmptype 8/ { print $1 }')
  if [[ "$before" == "$after" ]]; then
    pass "usurpation : r2 émettant avec l'adresse de r1 (10.200.0.2) est rejeté par WireGuard (cryptokey routing), 0 paquet reçu par la passerelle"
  else fail "paquets usurpés acceptés ($before → $after)"; fi
  ns r2 ip addr del 10.200.0.2/32 dev wg-r2
  ns r2 ip route del 10.200.0.0/24 dev wg-r2 2>/dev/null
  ns r2 wg set wg-r2 peer "$(pub gw)" allowed-ips 10.200.0.1/32
  if grep -rq "$(cat "$STATE/r1/private")" "$STATE/gw" 2>/dev/null; then
    fail "la clé privée de r1 se trouve côté passerelle"
  else pass "la clé privée de r1 n'existe que dans le répertoire de r1 ; la passerelle n'a que sa clé publique"; fi
}

t_keepalive() {
  log "### 3. Keepalive et mappages CGNAT agressifs (timeout UDP 30 s)"
  ns r1 wg set wg-r1 peer "$(pub gw)" persistent-keepalive 0
  ns cgn conntrack -F >/dev/null 2>&1
  ns cpe conntrack -F >/dev/null 2>&1
  sleep 3
  api_ok 10.200.0.2 >/dev/null # rouvre les mappages depuis le routeur
  log "  - keepalive désactivé, 45 s sans trafic…"
  sleep 45
  if api_ok 10.200.0.2 worker 5; then
    fail "sans keepalive, la passerelle joint encore le routeur (mappage CGNAT non expiré)"
  else pass "sans keepalive : après 45 s d'inactivité, la passerelle NE PEUT PLUS joindre le routeur (mappage CGNAT expiré)"; fi
  ns r1 wg set wg-r1 peer "$(pub gw)" persistent-keepalive 25
  local d
  d=$(wait_for 40 api_ok 10.200.0.2) && log "  - keepalive 25 s rétabli : routeur joignable en ${d} s"
  log "  - keepalive 25 s, 45 s sans trafic applicatif…"
  sleep 45
  if api_ok 10.200.0.2; then
    pass "avec keepalive 25 s : routeur toujours joignable après 45 s d'inactivité"
  else fail "avec keepalive 25 s, routeur injoignable"; fi
}

t_wan_ip_change() {
  log "### 4. Changement d'adresse WAN publique (renumérotation CGNAT / Starlink)"
  local old new d
  old=$(ns gw wg show wg-gw endpoints | awk -v k="$(pub r1)" '$1 == k { print $2 }')
  ns cgn ip addr add 203.0.113.21/24 dev wan
  ns cgn iptables -t nat -F POSTROUTING
  ns cgn iptables -t nat -A POSTROUTING -s 100.64.0.0/10 -o wan -j SNAT --to-source 203.0.113.21
  ns cgn conntrack -F >/dev/null 2>&1
  local start
  start=$(now)
  if d=$(wait_for 60 api_ok 10.200.0.2); then
    new=$(ns gw wg show wg-gw endpoints | awk -v k="$(pub r1)" '$1 == k { print $2 }')
    pass "nouvelle IP publique : endpoint \`$old\` → \`$new\`, routeur à nouveau joignable en ${d} s sans aucune action côté passerelle"
  else fail "routeur injoignable après changement d'IP WAN"; fi
}

t_wan_cut() {
  log "### 5. Coupure WAN longue puis retour (états ONLINE → DEGRADED → OFFLINE → ONLINE)"
  local d s
  s=$(state r1 10.200.0.2)
  log "  - état initial : $s"
  ns cpe ip link set wan down
  if d=$(wait_for 15 api_down 10.200.0.2); then
    log "  - API injoignable ${d} s après la coupure"
  fi
  s=$(state r1 10.200.0.2)
  [[ "$s" == DEGRADED ]] && pass "pendant la coupure, handshake encore récent : état DEGRADED (pas OFFLINE, pas supprimé)" || fail "état pendant la coupure : $s"
  log "  - attente du seuil OFFLINE (${OFFLINE_AFTER} s sans handshake)…"
  if d=$(wait_for 240 wait_state r1 10.200.0.2 OFFLINE); then
    pass "état OFFLINE atteint ${d} s plus tard ; le routeur reste enregistré (son pair est toujours présent sur la passerelle)"
  else fail "OFFLINE jamais atteint"; fi
  ns gw wg show wg-gw peers | grep -q "$(pub r1)" && pass "pair r1 toujours présent : une indisponibilité ne supprime jamais le routeur" || fail "pair r1 disparu"
  ns cpe ip link set wan up
  ns cpe ip route replace default via 100.64.0.1
  if d=$(wait_for 90 wait_state r1 10.200.0.2 ONLINE); then
    pass "retour du WAN : ONLINE en ${d} s, sans intervention"
  else fail "pas de retour ONLINE après rétablissement du WAN"; fi
}

t_router_reboot() {
  log "### 6. Redémarrage du routeur (processus et interface WireGuard détruits puis recréés)"
  restart_router_wg r1 10.200.0.2
  ns r1 pkill -f "lab/sim/fake_api.py r1" 2>/dev/null
  sleep 10
  local start d
  start=$(now)
  start_router_wg r1 10.200.0.2
  ns r1 python3 "$HERE/fake_api.py" r1 "$API_PORT" >/dev/null 2>&1 &
  if d=$(wait_for 60 api_ok 10.200.0.2); then
    pass "après redémarrage du routeur : joignable ${d} s après le retour du service (même clé, même IP tunnel)"
  else fail "routeur injoignable après redémarrage"; fi
}

t_gateway_reboot() {
  log "### 7. Redémarrage de la passerelle"
  ns gw ip link del wg-gw 2>/dev/null
  pkill -f "wireguard-go -f wg-gw" 2>/dev/null
  rm -f /var/run/wireguard/wg-gw.sock
  sleep 5
  local start d
  ns gw setsid wireguard-go -f wg-gw >>"$STATE/wg-gw.log" 2>&1 &
  for _ in $(seq 50); do [[ -S /var/run/wireguard/wg-gw.sock ]] && break; sleep 0.1; done
  ns gw ip addr add 10.200.0.1/24 dev wg-gw
  ns gw ip link set wg-gw up
  ns gw wg set wg-gw private-key "$STATE/gw/private" listen-port 51820
  # Configuration rechargée depuis la base : clés publiques et adresses, jamais d'endpoint.
  ns gw wg set wg-gw peer "$(pub r1)" allowed-ips 10.200.0.2/32
  ns gw wg set wg-gw peer "$(pub r2)" allowed-ips 10.200.0.3/32
  start=$(now)
  if d=$(wait_for 240 api_ok 10.200.0.2); then
    pass "passerelle redémarrée (sans endpoint connu) : r1 de nouveau joignable en ${d} s, à l'initiative du routeur"
  else fail "r1 injoignable 240 s après le redémarrage de la passerelle"; fi
  if d=$(wait_for 240 api_ok 10.200.0.3); then
    log "  - r2 joignable en ${d} s supplémentaires"
  else fail "r2 injoignable après le redémarrage de la passerelle"; fi
}

t_service_down() {
  log "### 8. Service d'administration du routeur indisponible (tunnel intact)"
  ns r1 pkill -f "lab/sim/fake_api.py r1" 2>/dev/null
  sleep 1
  local s
  s=$(state r1 10.200.0.2)
  [[ "$s" == DEGRADED ]] && pass "service arrêté, tunnel actif : état DEGRADED (distinct d'OFFLINE)" || fail "état : $s"
  ns r1 python3 "$HERE/fake_api.py" r1 "$API_PORT" >/dev/null 2>&1 &
  local d
  if d=$(wait_for 20 wait_state r1 10.200.0.2 ONLINE); then
    pass "service relancé : ONLINE en ${d} s"
  else fail "pas de retour ONLINE"; fi
}

t_revoke() {
  log "### 9. Révocation d'un routeur"
  ns gw wg set wg-gw peer "$(pub r2)" remove
  ns gw conntrack -D -d 10.200.0.3 >/dev/null 2>&1
  sleep 2
  if api_ok 10.200.0.3; then
    fail "r2 encore joignable après révocation"
  else pass "pair r2 retiré : plus aucun trafic possible dans les deux sens"; fi
  sleep 30
  local hs
  hs=$(ns r2 wg show wg-r2 latest-handshakes | awk '{ print $2 }')
  if (($(date +%s) - hs > 25)); then
    pass "r2 continue d'émettre des initiations mais la passerelle n'y répond plus (dernier handshake de r2 : il y a $(($(date +%s) - hs)) s)"
  else fail "r2 a obtenu un handshake après révocation"; fi
  if api_ok 10.200.0.2; then
    pass "la révocation de r2 n'affecte pas r1"
  else fail "r1 affecté par la révocation de r2"; fi
}

run_all() {
  "$HERE/topology.sh" up
  : >"$RESULTS"
  log "# Résultats du laboratoire réseau SIMULÉ — $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  log ""
  log "Implémentation WireGuard : $(wireguard-go --version 2>/dev/null | head -1) (espace utilisateur, protocole standard). Noyau : $(uname -r)."
  log ""
  for t in t_handshake t_security t_keepalive t_wan_ip_change t_wan_cut t_router_reboot \
    t_gateway_reboot t_service_down t_revoke; do
    "$t"
    log ""
  done
  log "**Échecs : $FAILS**"
  "$HERE/topology.sh" down
}

if [[ $# -gt 0 ]]; then "t_$1"; else run_all; fi
exit $((FAILS > 0))
