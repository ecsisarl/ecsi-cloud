#!/usr/bin/env bash
# ECSI CLOUD — laboratoire réseau SIMULÉ du Sprint 3A (namespaces Linux + WireGuard).
#
# Ce laboratoire NE contient AUCUN RouterOS : les « routeurs » r1 et r2 sont des namespaces
# Linux qui jouent le rôle du MikroTik (pair WireGuard + service HTTP factice à la place de
# l'API REST). Il valide la partie réseau de l'architecture (NAT, CGNAT, changement d'IP WAN,
# keepalive, firewall de la passerelle, révocation, reprise après coupure) indépendamment de
# RouterOS. Les résultats sont donc « SIMULÉ » ; la validation RouterOS se fait sur CHR puis
# sur matériel (voir lab/routeros/).
#
# Topologie (adresses de documentation RFC 5737 pour « Internet », RFC 6598 pour le CGNAT) :
#
#   attacker 203.0.113.66 ─┐
#   gw       203.0.113.10 ─┤  inet (pont « Internet public »)
#   cgn      203.0.113.20 ─┤
#   nat2     203.0.113.40 ─┘
#
#   gw  : passerelle ECSI (wg-gw 10.200.0.1/24, UDP 51820) ── 10.10.0.0/24 ── worker 10.10.0.2
#   cgn : NAT opérateur (CGNAT) 100.64.0.1/24 ─ cpe 100.64.0.10 (box 4G / Starlink, 2e NAT)
#         cpe 192.168.88.1/24 ─ r1 192.168.88.2 (routeur du site 1, wg-r1 10.200.0.2)
#                               client1 192.168.88.50 (client WiFi du site 1)
#   nat2: NAT simple (fibre sans IP publique) 192.168.89.1/24 ─ r2 192.168.89.2 (wg-r2 10.200.0.3)
#
# Usage : sudo ./topology.sh up | down
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
STATE="${LAB_STATE:-$HERE/.state}"
NAMESPACES=(inet gw worker cgn cpe r1 client1 nat2 r2 attacker)
WG_PORT=51820
API_PORT=8443
KEEPALIVE="${LAB_KEEPALIVE:-25}"

ns() { ip netns exec "$1" "${@:2}"; }

veth() { # veth <ns1> <if1> <ns2> <if2>
  ip link add "$2" netns "$1" type veth peer name "$4" netns "$3"
  ns "$1" ip link set "$2" up
  ns "$3" ip link set "$4" up
}

down() {
  pkill -x wireguard-go 2>/dev/null || true
  pkill -f 'lab/sim/fake_api.py' 2>/dev/null || true
  for n in "${NAMESPACES[@]}"; do ip netns del "$n" 2>/dev/null || true; done
  rm -f /var/run/wireguard/wg-*.sock
}

# Démarre l'interface WireGuard d'un namespace (wireguard-go : le noyau du bac à sable n'a pas
# le module WireGuard ; le protocole est identique).
wg_up() { # wg_up <ns> <iface> <addr/cidr>
  # Mode premier plan lancé en arrière-plan : le mode démon de wireguard-go meurt dans ce
  # bac à sable (pas de processus init pour récupérer le fils détaché).
  ns "$1" setsid wireguard-go -f "$2" >"$STATE/$2.log" 2>&1 &
  for _ in $(seq 50); do [[ -S "/var/run/wireguard/$2.sock" ]] && break; sleep 0.1; done
  ns "$1" ip addr add "$3" dev "$2"
  ns "$1" ip link set "$2" up
}

# Clé privée générée DANS le namespace du routeur et conservée dans son propre répertoire :
# seule la clé publique est copiée vers la passerelle (comme sur le MikroTik).
gen_key() { # gen_key <dir>
  mkdir -p "$1"
  chmod 700 "$1"
  if [[ ! -f "$1/private" ]]; then
    (umask 077 && wg genkey >"$1/private")
  fi
  wg pubkey <"$1/private" >"$1/public"
}

router_wg() { # router_wg <ns> <iface> <addr> <allowed>
  wg_up "$1" "$2" "$3/32"
  ns "$1" wg set "$2" private-key "$STATE/$1/private"
  # allowed-ips strict : uniquement l'adresse tunnel de la passerelle.
  ns "$1" wg set "$2" peer "$(cat "$STATE/gw/public")" \
    endpoint "203.0.113.10:$WG_PORT" allowed-ips "$4" persistent-keepalive "$KEEPALIVE"
  ns "$1" ip route add 10.200.0.1/32 dev "$2" 2>/dev/null || true
}

gw_wg() {
  wg_up gw wg-gw 10.200.0.1/24
  ns gw wg set wg-gw private-key "$STATE/gw/private" listen-port "$WG_PORT"
  # Un pair = une adresse /32. Aucun endpoint : c'est le routeur qui initie (NAT/CGNAT).
  ns gw wg set wg-gw peer "$(cat "$STATE/r1/public")" allowed-ips 10.200.0.2/32
  ns gw wg set wg-gw peer "$(cat "$STATE/r2/public")" allowed-ips 10.200.0.3/32
}

# Firewall « refus par défaut » d'un routeur simulé : seul 10.200.0.1 (passerelle), arrivant
# par le tunnel, peut joindre le service d'administration. Le LAN et le WAN sont refusés.
router_firewall() { # router_firewall <ns> <wgif>
  ns "$1" iptables -P INPUT DROP
  ns "$1" iptables -P FORWARD DROP
  ns "$1" iptables -A INPUT -i lo -j ACCEPT
  ns "$1" iptables -A INPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
  ns "$1" iptables -A INPUT -m conntrack --ctstate INVALID -j DROP
  ns "$1" iptables -A INPUT -i "$2" -s 10.200.0.1 -p tcp --dport "$API_PORT" -j ACCEPT
  ns "$1" iptables -A INPUT -i "$2" -s 10.200.0.1 -p icmp -j ACCEPT
}

api_up() { # Service HTTP factice à la place de l'API REST RouterOS (SIMULÉ).
  ns "$1" python3 "$HERE/fake_api.py" "$1" "$API_PORT" >/dev/null 2>&1 &
}

up() {
  down
  mkdir -p "$STATE"
  chmod 700 "$STATE"
  for n in "${NAMESPACES[@]}"; do
    ip netns add "$n"
    ns "$n" ip link set lo up
  done

  # « Internet » : un pont dans le namespace inet.
  ns inet ip link add br0 type bridge
  ns inet ip link set br0 up
  for pair in gw:203.0.113.10 cgn:203.0.113.20 nat2:203.0.113.40 attacker:203.0.113.66; do
    n="${pair%%:*}"
    a="${pair#*:}"
    veth inet "p-$n" "$n" wan
    ns inet ip link set "p-$n" master br0
    ns "$n" ip addr add "$a/24" dev wan
  done

  # Passerelle ECSI et réseau interne du worker.
  veth gw int worker eth0
  ns gw ip addr add 10.10.0.1/24 dev int
  ns worker ip addr add 10.10.0.2/24 dev eth0
  ns worker ip route add 10.200.0.0/24 via 10.10.0.1
  ns gw sysctl -qw net.ipv4.ip_forward=1

  # CGNAT opérateur puis box du site (double NAT, aucune redirection de port).
  veth cgn lan cpe wan
  ns cgn ip addr add 100.64.0.1/24 dev lan
  ns cpe ip addr add 100.64.0.10/24 dev wan
  ns cpe ip route add default via 100.64.0.1
  ns cgn sysctl -qw net.ipv4.ip_forward=1
  ns cgn iptables -t nat -A POSTROUTING -s 100.64.0.0/10 -o wan -j SNAT --to-source 203.0.113.20
  ns cgn iptables -P FORWARD DROP
  ns cgn iptables -A FORWARD -i lan -o wan -j ACCEPT
  ns cgn iptables -A FORWARD -i wan -o lan -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
  # CGNAT agressif (cas 4G / Starlink) : mappages UDP courts.
  ns cgn sysctl -qw net.netfilter.nf_conntrack_udp_timeout=30
  ns cgn sysctl -qw net.netfilter.nf_conntrack_udp_timeout_stream=30

  veth cpe lan r1 eth0
  ns cpe ip link add br-lan type bridge
  ns cpe ip link set br-lan up
  ns cpe ip link set lan master br-lan
  ns cpe ip addr add 192.168.88.1/24 dev br-lan
  veth cpe lan2 client1 eth0
  ns cpe ip link set lan2 master br-lan
  ns r1 ip addr add 192.168.88.2/24 dev eth0
  ns r1 ip route add default via 192.168.88.1
  ns client1 ip addr add 192.168.88.50/24 dev eth0
  ns client1 ip route add default via 192.168.88.1
  ns cpe sysctl -qw net.ipv4.ip_forward=1
  ns cpe iptables -t nat -A POSTROUTING -s 192.168.88.0/24 -o wan -j MASQUERADE
  ns cpe iptables -P FORWARD DROP
  ns cpe iptables -A FORWARD -i br-lan -o wan -j ACCEPT
  ns cpe iptables -A FORWARD -i wan -o br-lan -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT

  # Site 2 : un seul NAT (fibre opérateur sans IP publique).
  veth nat2 lan r2 eth0
  ns nat2 ip addr add 192.168.89.1/24 dev lan
  ns r2 ip addr add 192.168.89.2/24 dev eth0
  ns r2 ip route add default via 192.168.89.1
  ns nat2 sysctl -qw net.ipv4.ip_forward=1
  ns nat2 iptables -t nat -A POSTROUTING -s 192.168.89.0/24 -o wan -j MASQUERADE
  ns nat2 iptables -P FORWARD DROP
  ns nat2 iptables -A FORWARD -i lan -o wan -j ACCEPT
  ns nat2 iptables -A FORWARD -i wan -o lan -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT

  # Clés : chacune générée dans le répertoire de son propriétaire.
  gen_key "$STATE/gw"
  gen_key "$STATE/r1"
  gen_key "$STATE/r2"

  "$HERE/gateway-firewall.sh" apply
  gw_wg
  # Firewall AVANT le tunnel : le suivi de connexions d'un namespace ne démarre qu'avec la
  # première règle « conntrack ». Sinon les réponses au premier handshake arrivent « NEW » et
  # sont refusées (constaté : ~14 s de retard au démarrage, voir le rapport S3A).
  router_firewall r1 wg-r1
  router_firewall r2 wg-r2
  router_wg r1 wg-r1 10.200.0.2 10.200.0.1/32
  router_wg r2 wg-r2 10.200.0.3 10.200.0.1/32
  api_up r1
  api_up r2
}

case "${1:-}" in
  up) up ;;
  down) down ;;
  *)
    echo "usage: $0 up|down" >&2
    exit 2
    ;;
esac
