#!/usr/bin/env bash
# ECSI CLOUD — lot B : client Hotspot SIMULÉ (namespace Linux) derrière le CHR.
#
#   CHR ether2 ── tap hs-<chr> ── br-hs (namespace cpe, pont sans adresse) ── hsclient eth0
#
# Prérequis : CHR démarré avec CHR_HOTSPOT=1 (lab/routeros/chr/start-chr.sh). Le client n'a
# aucune adresse au départ : il l'obtient du serveur DHCP du Hotspot poussé par le worker.
#
# Usage : sudo ./client-hotspot.sh up | down | dhcp
#   up   : crée le namespace hsclient et le relie au pont br-hs ;
#   dhcp : demande une adresse (udhcpc ou dhclient, selon ce qui est installé) ;
#   down : supprime le namespace.
# Exemple de test (curl dans un namespace : --noproxy '*') :
#   ip netns exec hsclient curl -sS --noproxy '*' -o /dev/null -w '%{http_code} %{redirect_url}\n' http://example.com/
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ns() { ip netns exec "$1" "${@:2}"; }

up() {
  ip netns list | grep -qw cpe || { echo "Démarrer d'abord lab/sim/topology.sh up" >&2; exit 1; }
  ns cpe ip link show br-hs >/dev/null 2>&1 || {
    echo "Pont br-hs absent : démarrer le CHR avec CHR_HOTSPOT=1" >&2
    exit 1
  }
  down
  ip netns add hsclient
  ns hsclient ip link set lo up
  ip link add hs-client netns cpe type veth peer name eth0 netns hsclient
  ns cpe ip link set hs-client master br-hs
  ns cpe ip link set hs-client up
  ns hsclient ip link set eth0 address 52:54:00:ec:53:01
  ns hsclient ip link set eth0 up
  echo "Client hsclient relié à br-hs (MAC 52:54:00:ec:53:01, sans adresse)"
}

dhcp() {
  if command -v udhcpc >/dev/null 2>&1; then
    ns hsclient udhcpc -i eth0 -n -q -t 10
  elif command -v dhclient >/dev/null 2>&1; then
    ns hsclient dhclient -1 -v eth0
  else
    # Bac à sable sans client DHCP : client minimal en Python (bibliothèque standard).
    ns hsclient python3 -I "$HERE/dhcp-client.py" eth0
  fi
  ns hsclient ip -br addr show eth0
}

down() {
  ip netns del hsclient 2>/dev/null || true
  ns cpe ip link del hs-client 2>/dev/null || true
}

case "${1:-}" in
  up) up ;;
  dhcp) dhcp ;;
  down) down ;;
  *) echo "usage: $0 up | dhcp | down" >&2; exit 1 ;;
esac
