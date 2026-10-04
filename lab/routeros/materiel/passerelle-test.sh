#!/usr/bin/env bash
# Passerelle ECSI CLOUD de TEST pour les essais sur routeur physique (GUIDE-TEST-MATERIEL.md).
# PAS la passerelle de production : un serveur Linux, WireGuard, et le prototype d'enrôlement.
#
#   sudo ./passerelle-test.sh up <adresse-ip-du-serveur>   # IP publique (VPS) ou IP LAN (PC)
#   sudo ./passerelle-test.sh nouveau <nom> <ip-tunnel>     # jeton + script RouterOS à coller
#   sudo ./passerelle-test.sh etat <nom>                    # PROVISIONING/ONLINE/DEGRADED/OFFLINE
#   sudo ./passerelle-test.sh sonde <nom>                   # lecture REST (identité, ressources…)
#   sudo ./passerelle-test.sh securite <nom>                # refus attendus par le tunnel
#   sudo ./passerelle-test.sh scan <ip-publique-du-site>    # ports d'administration depuis Internet
#   sudo ./passerelle-test.sh revoquer <nom>                # retire le pair (REVOKED)
#   sudo ./passerelle-test.sh down                          # arrête tout, retire les règles ajoutées
#
# Ce que « up » fait sur le serveur :
#   - interface wg0 10.200.0.1/24, UDP 51820 (module WireGuard du noyau, sinon wireguard-go) ;
#     clé privée générée sur le serveur, dans $LAB_STATE/gw (0700), jamais affichée ;
#   - AC et certificat de laboratoire pour <adresse-ip-du-serveur> (lab/routeros/enrolement) ;
#   - API publique d'enrôlement en HTTPS sur <adresse>:443 et point d'activation sur
#     10.200.0.1:8081 (joignable uniquement par le tunnel) ;
#   - ajoute 3 règles iptables commentées « ecsi-test » (UDP 51820, TCP 443, TCP 8081 sur wg0)
#     SANS changer la politique du firewall existant ; « down » les retire.
# Prérequis : wireguard-tools (wg), iproute2, iptables, python3, openssl, curl.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ENROL="$HERE/../enrolement"
export LAB_STATE="${LAB_STATE:-$HERE/.state}"
export LAB_GW_NETNS=""
export LAB_WG_IFACE=wg0
STATE="$LAB_STATE"
OFFLINE_AFTER=180
# Identifiants passés à curl par un fichier de configuration (-K), jamais sur la ligne de
# commande (visible dans la liste des processus).
creds() { printf 'user = "ecsi-svc:%s"\n' "$(cat "$1")"; }

rule() { # rule -A|-D <args...> : règle commentée, ajoutée une seule fois
  local op=$1
  shift
  if [[ "$op" == -A ]]; then
    iptables -C INPUT "$@" -m comment --comment ecsi-test 2>/dev/null || iptables -I INPUT 1 "$@" -m comment --comment ecsi-test
  else
    while iptables -D INPUT "$@" -m comment --comment ecsi-test 2>/dev/null; do :; done
  fi
}
rules() {
  rule "$1" -p udp --dport 51820 -j ACCEPT
  rule "$1" -p tcp --dport 443 -j ACCEPT
  rule "$1" -i wg0 -s 10.200.0.0/24 -d 10.200.0.1 -p tcp --dport 8081 -j ACCEPT
}

up() {
  local addr="${1:?adresse IP du serveur}"
  mkdir -p "$STATE/gw"
  chmod 700 "$STATE" "$STATE/gw"
  [[ -f "$STATE/gw/private" ]] || (umask 077 && wg genkey >"$STATE/gw/private")
  wg pubkey <"$STATE/gw/private" >"$STATE/gw/public"
  echo "$addr" >"$STATE/adresse"
  if ! ip link show wg0 >/dev/null 2>&1; then
    if ! ip link add wg0 type wireguard 2>/dev/null; then
      echo "Module WireGuard du noyau absent : wireguard-go" >&2
      wireguard-go -f wg0 >"$STATE/wg0.log" 2>&1 </dev/null &
      echo $! >"$STATE/wg0.pid"
      for _ in $(seq 50); do [[ -S /var/run/wireguard/wg0.sock ]] && break; sleep 0.1; done
    fi
    ip addr add 10.200.0.1/24 dev wg0
  fi
  wg set wg0 private-key "$STATE/gw/private" listen-port 51820
  ip link set wg0 up
  # Redémarrage de la passerelle : les pairs enrôlés sont rechargés depuis la base, SANS
  # endpoint (c'est le routeur qui se reconnecte).
  if [[ -f "$STATE/enrolement.sqlite" ]]; then
    python3 -c 'import sqlite3,sys; [print(k, ip) for k, ip in sqlite3.connect(sys.argv[1]).execute("SELECT public_key, tunnel_ip FROM routers WHERE public_key IS NOT NULL AND state != ?", ("REVOKED",))]' "$STATE/enrolement.sqlite" |
      while read -r key ip; do wg set wg0 peer "$key" allowed-ips "$ip/32"; done
  fi
  rules -A
  "$ENROL/pki-labo.sh" "$addr" >/dev/null
  (cd "$ENROL" && python3 serveur_enrolement.py public --host 0.0.0.0 >>"$STATE/public.log" 2>&1 </dev/null & echo $! >"$STATE/public.pid")
  (cd "$ENROL" && python3 serveur_enrolement.py activation >>"$STATE/activation.log" 2>&1 </dev/null & echo $! >"$STATE/activation.pid")
  sleep 1
  echo "Passerelle de test prête : $addr, UDP 51820. Clé publique : $(cat "$STATE/gw/public")"
}

down() {
  local f
  for f in public activation; do
    [[ -f "$STATE/$f.pid" ]] && kill "$(cat "$STATE/$f.pid")" 2>/dev/null
    rm -f "$STATE/$f.pid"
  done
  rules -D
  ip link del wg0 2>/dev/null || true
  [[ -f "$STATE/wg0.pid" ]] && kill "$(cat "$STATE/wg0.pid")" 2>/dev/null
  rm -f "$STATE/wg0.pid"
  echo "Passerelle de test arrêtée (clés et base conservées dans $STATE)."
}

nouveau() {
  local addr
  addr=$(cat "$STATE/adresse")
  (cd "$ENROL" && python3 serveur_enrolement.py new "$1" "$2" --public-host "$addr" --gw-endpoint "$addr")
}

row() { python3 -c 'import sqlite3,sys; r=sqlite3.connect(sys.argv[1]).execute("SELECT tunnel_ip, public_key, tls_fingerprint, state FROM routers WHERE name=?", (sys.argv[2],)).fetchone(); print("|".join(map(str, r)) if r else "")' "$STATE/enrolement.sqlite" "$1"; }

etat() {
  local ip pub fp st ts age code
  IFS='|' read -r ip pub fp st <<<"$(row "$1")"
  [[ -n "$ip" ]] || { echo "routeur inconnu : $1" >&2; return 1; }
  if [[ "$st" == REVOKED ]]; then echo "REVOKED"; return 0; fi
  ts=$(wg show wg0 latest-handshakes | awk -v k="$pub" '$1 == k { print $2 }')
  if [[ -z "$ts" || "$ts" == 0 ]]; then echo "PROVISIONING (aucun handshake)"; return 0; fi
  age=$(($(date +%s) - ts))
  if ((age > OFFLINE_AFTER)); then echo "OFFLINE (dernier handshake il y a ${age} s)"; return 0; fi
  if [[ ! -f "$STATE/$1-svc.pass" ]]; then echo "PROVISIONING (tunnel établi, pas d'identifiants)"; return 0; fi
  code=$(curl -sk --noproxy '*' --max-time 5 -K <(creds "$STATE/$1-svc.pass") -o /dev/null -w '%{http_code}' "https://$ip/rest/system/identity" || true)
  case "$code" in
    200) echo "ONLINE (handshake il y a ${age} s, API 200)" ;;
    401 | 403 | 500) echo "ERROR (handshake il y a ${age} s, API HTTP $code)" ;;
    *) echo "DEGRADED (handshake il y a ${age} s, API injoignable)" ;;
  esac
}

sonde() {
  local ip pub fp st
  IFS='|' read -r ip pub fp st <<<"$(row "$1")"
  python3 "$HERE/../chr/probe.py" "$ip" ecsi-svc "$STATE/$1-svc.pass" --fingerprint "$fp" | tee "$STATE/sonde-$1-$(date +%Y%m%d-%H%M%S).json"
}

tcp_open() { timeout 4 bash -c "exec 3<>/dev/tcp/$1/$2" 2>/dev/null; }

securite() {
  local ip pub fp st code auth
  IFS='|' read -r ip pub fp st <<<"$(row "$1")"
  auth="$STATE/$1-svc.pass"
  req() { curl -sk --noproxy '*' --max-time 15 -K <(creds "$auth") -o /dev/null -w '%{http_code}' -X "$1" -H 'content-type: application/json' ${3:+--data "$3"} "https://$ip/rest/$2"; }
  echo "API REST lecture (attendu 200) : $(req GET system/identity)"
  echo "écriture identité (attendu ≠ 200) : $(req POST system/identity/set '{"name":"test-ecsi"}')"
  echo "redémarrage (attendu ≠ 200) : $(req POST system/reboot '{}')"
  echo "création d'utilisateur (attendu ≠ 200/201) : $(req PUT user '{"name":"x","group":"full","password":"Xx123456789!"}')"
  echo "mauvais mot de passe (attendu 401) : $(curl -sk --noproxy '*' --max-time 15 -K <(printf 'user = "ecsi-svc:%s"\n' mauvais) -o /dev/null -w '%{http_code}' "https://$ip/rest/system/identity")"
  echo "longueur du champ private-key lu (attendu < 44, clé masquée) : $(curl -sk --noproxy '*' --max-time 15 -K <(creds "$auth") "https://$ip/rest/interface/wireguard" | python3 -c 'import json,sys; print(max((len(i.get("private-key","")) for i in json.load(sys.stdin)), default=0))')"
  for port in 21 22 23 80 8291 8728 8729; do
    if tcp_open "$ip" "$port"; then echo "port $port par le tunnel : OUVERT (anomalie)"; else echo "port $port par le tunnel : refusé"; fi
  done
}

scan() {
  for port in 21 22 23 80 443 8291 8728 8729; do
    if tcp_open "$1" "$port"; then echo "$1:$port : OUVERT depuis Internet (anomalie)"; else echo "$1:$port : fermé"; fi
  done
}

revoquer() {
  local ip pub fp st
  IFS='|' read -r ip pub fp st <<<"$(row "$1")"
  [[ -n "$pub" && "$pub" != None ]] && wg set wg0 peer "$pub" remove
  python3 -c 'import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute("UPDATE routers SET state=? WHERE name=?", ("REVOKED", sys.argv[2])); c.execute("INSERT INTO audit VALUES (CURRENT_TIMESTAMP, ?, ?, ?, ?)", (sys.argv[2], "REVOKED", "admin", "pair retiré")); c.commit()' "$STATE/enrolement.sqlite" "$1"
  echo "$1 : REVOKED (pair retiré de la passerelle)"
}

case "${1:-}" in
  up) up "${2:-}" ;;
  down) down ;;
  nouveau) nouveau "${2:?nom}" "${3:?ip tunnel}" ;;
  etat) etat "${2:?nom}" ;;
  revoquer) revoquer "${2:?nom}" ;;
  sonde) sonde "${2:?nom}" ;;
  securite) securite "${2:?nom}" ;;
  scan) scan "${2:?ip publique}" ;;
  *)
    sed -n '4,12p' "$0" >&2
    exit 2
    ;;
esac
