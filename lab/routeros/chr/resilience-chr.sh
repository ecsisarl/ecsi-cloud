#!/usr/bin/env bash
# Tests de résilience RÉELS sur le CHR (RouterOS 7.24.5) derrière box + CGNAT du laboratoire.
#   sudo ./resilience-chr.sh <fichier-mot-de-passe-ecsi-svc> [scénario…]
# Scénarios : keepalive wan_ip wan_cut chr_reboot gateway_reboot tunnel_cut service_down
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
STATE="${LAB_STATE:-$HERE/../../sim/.state}"
PASS_FILE="${1:?fichier du mot de passe ecsi-svc}"
shift
CHR_TUN=10.200.0.10
CHR_PUB="$(cat "$STATE/chr1.public")"
SOCK="$STATE/chr1.sock"
OFFLINE_AFTER=180
FAILS=0
# Identifiants passés à curl par un fichier de configuration (-K), jamais sur la ligne de
# commande (visible dans la liste des processus).
creds() { printf 'user = "ecsi-svc:%s"\n' "$(cat "$1")"; }

ns() { ip netns exec "$1" "${@:2}"; }
now() { date +%s.%N; }
since() { printf '%.1f' "$(echo "$(now) - $1" | bc)"; }
pass() { echo "- **PASS** $*"; }
fail() {
  echo "- **FAIL** $*"
  FAILS=$((FAILS + 1))
}
note() { echo "  - $*"; }
rest_ok() {
  [[ "$(ns worker curl -sk --max-time "${1:-5}" -K <(creds "$PASS_FILE") -o /dev/null \
    -w '%{http_code}' "https://$CHR_TUN/rest/system/identity")" == 200 ]]
}
rest_down() { ! rest_ok 3; }
hs_age() {
  local ts
  ts=$(ns gw wg show wg-gw latest-handshakes | awk -v k="$CHR_PUB" '$1 == k { print $2 }')
  if [[ -z "$ts" || "$ts" == 0 ]]; then echo -1; else echo $(($(date +%s) - ts)); fi
}
state() {
  local age
  age=$(hs_age)
  if ((age < 0)); then echo PROVISIONING
  elif ((age > OFFLINE_AFTER)); then echo OFFLINE
  elif rest_ok; then echo ONLINE
  else echo DEGRADED; fi
}
is_state() { [[ "$(state)" == "$1" ]]; }
wait_for() {
  local start t
  start=$(now)
  t=$1
  shift
  while (($(echo "$(now) - $start < $t" | bc))); do
    if "$@"; then
      since "$start"
      return 0
    fi
    sleep 1
  done
  return 1
}
console() { # console <fichier .rsc> : exécute avec une session admin neuve
  LAB_PASSWORD_FILE="$STATE/chr1-admin.pass" python3 "$HERE/console.py" "$SOCK" --login --run "$1" >>"$STATE/resilience-console.log" 2>&1
}
endpoint() { ns gw wg show wg-gw endpoints | awk -v k="$CHR_PUB" '$1 == k { print $2 }'; }

t_keepalive() {
  echo "### Keepalive RouterOS face à un CGNAT agressif (mappage UDP 30 s)"
  printf '/interface/wireguard/peers/set [find name=ecsi-gateway] persistent-keepalive=0\n' >"$STATE/k0.rsc"
  console "$STATE/k0.rsc"
  rest_ok >/dev/null
  note "keepalive 0 sur le CHR, 45 s sans trafic…"
  sleep 45
  if rest_ok 5; then fail "sans keepalive, CHR encore joignable après 45 s"
  else pass "sans keepalive : après 45 s d'inactivité, la passerelle ne joint plus le CHR (mappage CGNAT expiré)"; fi
  printf '/interface/wireguard/peers/set [find name=ecsi-gateway] persistent-keepalive=25\n' >"$STATE/k25.rsc"
  console "$STATE/k25.rsc"
  local d
  d=$(wait_for 60 rest_ok) && note "keepalive 25 s rétabli : CHR joignable en ${d} s"
  note "keepalive 25 s, 45 s sans trafic applicatif…"
  sleep 45
  rest_ok && pass "avec keepalive 25 s : CHR joignable après 45 s d'inactivité" || fail "keepalive 25 s insuffisant"
}

t_wan_ip() {
  echo "### Changement d'adresse WAN publique"
  local old new d
  old=$(endpoint)
  ns cgn ip addr add 203.0.113.22/24 dev wan 2>/dev/null
  ns cgn iptables -t nat -F POSTROUTING
  ns cgn iptables -t nat -A POSTROUTING -s 100.64.0.0/10 -o wan -j SNAT --to-source 203.0.113.22
  ns cgn conntrack -F >/dev/null 2>&1
  if d=$(wait_for 90 rest_ok); then
    new=$(endpoint)
    pass "nouvelle IP publique : endpoint \`$old\` → \`$new\`, CHR joignable en ${d} s, aucune action côté passerelle"
  else fail "CHR injoignable après changement d'IP WAN"; fi
}

t_wan_cut() {
  echo "### Coupure WAN longue puis retour"
  note "état initial : $(state)"
  ns cpe ip link set wan down
  local d
  d=$(wait_for 20 rest_down) && note "API injoignable ${d} s après la coupure"
  [[ "$(state)" == DEGRADED ]] && pass "pendant la coupure (handshake récent) : DEGRADED" || fail "état pendant la coupure : $(state)"
  if d=$(wait_for 260 is_state OFFLINE); then
    pass "OFFLINE ${d} s plus tard ; pair toujours enregistré sur la passerelle"
  else fail "OFFLINE jamais atteint"; fi
  ns cpe ip link set wan up
  ns cpe ip route replace default via 100.64.0.1
  if d=$(wait_for 120 is_state ONLINE); then
    pass "retour du WAN : ONLINE en ${d} s, sans intervention"
  else fail "pas de retour ONLINE"; fi
}

t_chr_reboot() {
  echo "### Redémarrage du CHR (/system/reboot)"
  python3 - "$SOCK" "$STATE/chr1-admin.pass" <<'EOF' >>"$STATE/resilience-console.log" 2>&1
import socket, sys, pexpect, pexpect.fdpexpect
s = socket.socket(socket.AF_UNIX); s.connect(sys.argv[1])
c = pexpect.fdpexpect.fdspawn(s.fileno(), encoding="utf-8", timeout=60)
pw = open(sys.argv[2]).read().strip()
c.send("\x03\x04\r")
c.expect("Login: "); c.send("admin+ct200w\r"); c.expect("Password: "); c.send(pw + "\r")
c.expect(r"\] > "); c.send("/system/reboot\r"); c.expect(r"\[y/N\]"); c.send("y")
c.expect(["Login:", pexpect.TIMEOUT], timeout=5)
EOF
  local start d
  start=$(now)
  if d=$(wait_for 20 rest_down); then note "API injoignable ${d} s après la commande"; fi
  if d=$(wait_for 600 rest_ok); then
    pass "CHR redémarré (émulation sans KVM) : API de nouveau joignable via le tunnel $(since "$start") s après la commande, sans intervention"
  else fail "CHR injoignable après redémarrage"; fi
  local pub
  pub=$(ns worker curl -sk --max-time 10 -K <(creds "$PASS_FILE") "https://$CHR_TUN/rest/interface/wireguard?.proplist=public-key" | python3 -c 'import json,sys; print(json.load(sys.stdin)[0]["public-key"])')
  [[ "$pub" == "$CHR_PUB" ]] && pass "même clé WireGuard après redémarrage (clé persistante, rien à reconfigurer côté cloud)" || fail "clé changée après redémarrage"
}

t_gateway_reboot() {
  echo "### Redémarrage de la passerelle (configuration rechargée sans endpoint)"
  ns gw ip link del wg-gw 2>/dev/null
  pkill -f "wireguard-go -f wg-gw" 2>/dev/null
  rm -f /var/run/wireguard/wg-gw.sock
  sleep 5
  ns gw setsid wireguard-go -f wg-gw >>"$STATE/wg-gw.log" 2>&1 &
  for _ in $(seq 50); do [[ -S /var/run/wireguard/wg-gw.sock ]] && break; sleep 0.1; done
  ns gw ip addr add 10.200.0.1/24 dev wg-gw
  ns gw ip link set wg-gw up
  ns gw wg set wg-gw private-key "$STATE/gw/private" listen-port 51820
  ns gw wg set wg-gw peer "$(cat "$STATE/r1/public")" allowed-ips 10.200.0.2/32
  ns gw wg set wg-gw peer "$(cat "$STATE/r2/public")" allowed-ips 10.200.0.3/32
  ns gw wg set wg-gw peer "$CHR_PUB" allowed-ips 10.200.0.10/32
  local d
  if d=$(wait_for 300 rest_ok); then
    pass "passerelle redémarrée : CHR joignable en ${d} s, à l'initiative du routeur"
  else fail "CHR injoignable 300 s après le redémarrage de la passerelle"; fi
}

t_tunnel_cut() {
  echo "### Tunnel interrompu côté passerelle (pair retiré 60 s puis remis)"
  ns gw wg set wg-gw peer "$CHR_PUB" remove
  sleep 2
  rest_down && pass "pair retiré : API injoignable immédiatement" || fail "API encore joignable sans pair"
  sleep 58
  ns gw wg set wg-gw peer "$CHR_PUB" allowed-ips 10.200.0.10/32
  local d
  if d=$(wait_for 300 rest_ok); then
    pass "pair remis : CHR joignable en ${d} s, sans intervention sur le routeur"
  else fail "CHR injoignable après remise du pair"; fi
}

t_service_down() {
  echo "### Service REST indisponible (www-ssl désactivé), tunnel intact"
  printf '/ip/service/set www-ssl disabled=yes\n' >"$STATE/s0.rsc"
  console "$STATE/s0.rsc"
  local d
  d=$(wait_for 20 rest_down) && note "API injoignable ${d} s après la désactivation"
  [[ "$(state)" == DEGRADED ]] && pass "service arrêté, tunnel actif : DEGRADED (distinct d'OFFLINE)" || fail "état : $(state)"
  printf '/ip/service/set www-ssl disabled=no\n' >"$STATE/s1.rsc"
  console "$STATE/s1.rsc"
  if d=$(wait_for 60 is_state ONLINE); then pass "service réactivé : ONLINE en ${d} s"; else fail "pas de retour ONLINE"; fi
}

SCENARIOS=("$@")
((${#SCENARIOS[@]})) || SCENARIOS=(keepalive wan_ip wan_cut chr_reboot gateway_reboot tunnel_cut service_down)
echo "# Résilience CHR — $(date -u +%Y-%m-%dT%H:%M:%SZ)"
for s in "${SCENARIOS[@]}"; do "t_$s"; echo; done
echo "**Échecs : $FAILS**"
exit $((FAILS > 0))
