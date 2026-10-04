#!/usr/bin/env bash
# Firewall de la passerelle ECSI (namespace gw du laboratoire SIMULÉ).
#
# Principe : refus par défaut, puis autorisations minimales.
#   - WAN : seul UDP 51820 (WireGuard) est accepté ; tout le reste est ignoré.
#   - Tunnel → passerelle : ICMP (diagnostic) et TCP 8081, le point d'activation de
#     l'enrôlement (étape 8 du protocole : identifiants du compte de service envoyés par le
#     tunnel, acceptés une seule fois). Rien d'autre ; aucun accès au réseau interne.
#   - Routeur → routeur (wg → wg) : INTERDIT. Un routeur compromis ne peut joindre aucun autre.
#   - Worker → routeurs : uniquement le port d'administration, traduit (SNAT) vers 10.200.0.1,
#     pour que chaque routeur n'ait à autoriser qu'une seule adresse source.
set -euo pipefail

# 8443 : service factice des routeurs simulés ; 443 : API REST (www-ssl) du CHR.
API_PORTS="${API_PORTS:-8443 443}"
ns() { ip netns exec gw "$@"; }

apply() {
  ns iptables -F
  ns iptables -t nat -F
  ns iptables -P INPUT DROP
  ns iptables -P FORWARD DROP
  ns iptables -P OUTPUT ACCEPT

  ns iptables -A INPUT -i lo -j ACCEPT
  ns iptables -A INPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
  ns iptables -A INPUT -m conntrack --ctstate INVALID -j DROP
  ns iptables -A INPUT -i wan -p udp --dport 51820 -j ACCEPT
  ns iptables -A INPUT -i wg-gw -p icmp --icmp-type echo-request -j ACCEPT
  ns iptables -A INPUT -i wg-gw -s 10.200.0.0/24 -d 10.200.0.1 -p tcp --dport 8081 -j ACCEPT

  ns iptables -A FORWARD -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
  ns iptables -A FORWARD -m conntrack --ctstate INVALID -j DROP
  ns iptables -A FORWARD -i wg-gw -o wg-gw -j DROP
  for port in $API_PORTS; do
    ns iptables -A FORWARD -i int -s 10.10.0.2 -o wg-gw -p tcp --dport "$port" -j ACCEPT
  done
  ns iptables -A FORWARD -i int -s 10.10.0.2 -o wg-gw -p icmp --icmp-type echo-request -j ACCEPT

  ns iptables -t nat -A POSTROUTING -s 10.10.0.0/24 -o wg-gw -j SNAT --to-source 10.200.0.1
}

# Ouvre volontairement le transfert wg → wg (test de défense en profondeur uniquement).
allow_peer_to_peer() {
  ns iptables -I FORWARD 1 -i wg-gw -o wg-gw -j ACCEPT
}

case "${1:-}" in
  apply) apply ;;
  allow-peer-to-peer) allow_peer_to_peer ;;
  *)
    echo "usage: $0 apply|allow-peer-to-peer" >&2
    exit 2
    ;;
esac
