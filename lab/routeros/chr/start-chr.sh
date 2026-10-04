#!/usr/bin/env bash
# Démarre un MikroTik CHR (image OFFICIELLE uniquement) dans QEMU et le branche sur le LAN du
# site 1 du laboratoire simulé, à la place de r1 : derrière la box (NAT) et le CGNAT.
#
#   Internet (inet) ── cgn (CGNAT) ── cpe (box 4G/Starlink) ── br-lan ── tap-chr ── CHR ether1
#
# Usage : sudo ./start-chr.sh <image-disque-officielle> [nom]
#   - l'image d'origine n'est jamais modifiée : un disque de travail qcow2 est créé par-dessus ;
#   - console série : socket UNIX $LAB_STATE/chr-<nom>.sock (voir console.py) ;
#   - prérequis : lab/sim/topology.sh up (namespace cpe et pont br-lan).
#
# Ce script ne contient AUCUNE commande RouterOS : la configuration du routeur se fait ensuite
# par la console, avec les commandes vérifiées dans la documentation officielle.
# Bac à sable sans /dev/kvm : QEMU tourne en émulation (TCG), plus lentement qu'en production.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
STATE="${LAB_STATE:-$HERE/../../sim/.state}"
IMAGE="${1:?usage: $0 <image CHR officielle> [nom]}"
NAME="${2:-chr1}"
# Pilotes émulés : à confirmer dans la page CHR de la documentation officielle. En cas de
# disque ou de carte réseau non détectés, essayer CHR_DISK_IF=ide et CHR_NIC_MODEL=e1000.
NIC_MODEL="${CHR_NIC_MODEL:-virtio-net-pci}"
DISK_IF="${CHR_DISK_IF:-virtio}"
MEM="${CHR_MEM_MB:-256}"
# Une adresse MAC distincte par CHR branché sur le même LAN (ex. CHR_MAC=52:54:00:ec:51:02).
MAC="${CHR_MAC:-52:54:00:ec:51:01}"
TAP="tap-$NAME"
DISK="$STATE/$NAME.qcow2"
SOCK="$STATE/$NAME.sock"

mkdir -p "$STATE"
[[ -f "$IMAGE" ]] || { echo "Image introuvable : $IMAGE" >&2; exit 1; }
ip netns list | grep -qw cpe || { echo "Démarrer d'abord lab/sim/topology.sh up" >&2; exit 1; }

case "$IMAGE" in
  *.vmdk) FMT=vmdk ;;
  *.vdi) FMT=vdi ;;
  *.vhdx) FMT=vhdx ;;
  *.qcow2) FMT=qcow2 ;;
  *) FMT=raw ;;
esac
if [[ ! -f "$DISK" ]]; then
  qemu-img create -q -f qcow2 -F "$FMT" -b "$(realpath "$IMAGE")" "$DISK"
fi

# Interface tap dans le namespace de la box, reliée au LAN du site.
ip netns exec cpe ip tuntap add dev "$TAP" mode tap 2>/dev/null || true
ip netns exec cpe ip link set "$TAP" master br-lan
ip netns exec cpe ip link set "$TAP" up

ACCEL=tcg
[[ -e /dev/kvm ]] && ACCEL=kvm

rm -f "$SOCK"
ip netns exec cpe setsid qemu-system-x86_64 \
  -name "$NAME" -machine q35,accel="$ACCEL" -m "$MEM" -smp 1 \
  -drive file="$DISK",if="$DISK_IF",format=qcow2 \
  -netdev tap,id=wan,ifname="$TAP",script=no,downscript=no \
  -device "$NIC_MODEL",netdev=wan,mac="$MAC" \
  -display none -serial unix:"$SOCK",server,nowait -monitor none \
  >"$STATE/$NAME.qemu.log" 2>&1 &
echo "CHR « $NAME » démarré (accélération : $ACCEL). Console : python3 $HERE/console.py $SOCK"
