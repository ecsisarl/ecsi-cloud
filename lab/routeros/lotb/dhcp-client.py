"""Client DHCP minimal du laboratoire (RFC 2131 : DISCOVER, OFFER, REQUEST, ACK).

Utilisé quand ni udhcpc ni dhclient ne sont installés (bac à sable). À lancer DANS le
namespace du client :  ip netns exec hsclient python3 -I dhcp-client.py eth0
Trames Ethernet complètes par socket AF_PACKET, sommes de contrôle IP et UDP calculées ici :
une socket UDP ordinaire sur un veth laisse la somme UDP au déchargement matériel, et le CHR
(derrière tap/QEMU) recevait une somme invalide et ignorait la requête (constaté au lot B).
Affiche l'adresse, le masque, la passerelle et le DNS reçus, puis les applique à
l'interface (ip addr / ip route). Aucune dépendance hors bibliothèque standard.
"""

import os
import random
import socket
import struct
import subprocess
import sys

IFACE = sys.argv[1] if len(sys.argv) > 1 else "eth0"
MAC = bytes.fromhex(open(f"/sys/class/net/{IFACE}/address").read().strip().replace(":", ""))
XID = random.getrandbits(32)


def packet(msg_type: int, extra: bytes = b"") -> bytes:
    header = struct.pack(
        "!BBBBIHH4s4s4s4s16s64s128s",
        1, 1, 6, 0, XID, 0, 0x8000,  # BOOTREQUEST, Ethernet, broadcast
        b"\0" * 4, b"\0" * 4, b"\0" * 4, b"\0" * 4,
        MAC + b"\0" * 10, b"\0" * 64, b"\0" * 128,
    )
    options = b"\x63\x82\x53\x63" + bytes([53, 1, msg_type]) + extra + bytes([55, 3, 1, 3, 6, 255])
    return header + options


def parse(data: bytes) -> tuple[str, dict[int, bytes]]:
    yiaddr = socket.inet_ntoa(data[16:20])
    opts: dict[int, bytes] = {}
    i = 240
    while i < len(data) and data[i] != 255:
        if data[i] == 0:
            i += 1
            continue
        code, length = data[i], data[i + 1]
        opts[code] = data[i + 2 : i + 2 + length]
        i += 2 + length
    return yiaddr, opts


def checksum(data: bytes) -> int:
    if len(data) % 2:
        data += b"\0"
    total = sum(struct.unpack(f"!{len(data) // 2}H", data))
    while total >> 16:
        total = (total & 0xFFFF) + (total >> 16)
    return ~total & 0xFFFF


def frame(payload: bytes) -> bytes:
    src, dst = b"\0" * 4, b"\xff" * 4
    udp_len = 8 + len(payload)
    pseudo = src + dst + struct.pack("!BBH", 0, 17, udp_len)
    udp = struct.pack("!HHHH", 68, 67, udp_len, 0) + payload
    udp = udp[:6] + struct.pack("!H", checksum(pseudo + udp) or 0xFFFF) + udp[8:]
    ip = struct.pack("!BBHHHBBH4s4s", 0x45, 0, 20 + udp_len, 0, 0, 64, 17, 0, src, dst)
    ip = ip[:10] + struct.pack("!H", checksum(ip)) + ip[12:]
    return b"\xff" * 6 + MAC + b"\x08\x00" + ip + udp


def exchange(sock: socket.socket, payload: bytes, want: int) -> tuple[str, dict[int, bytes]]:
    for _ in range(5):
        sock.send(frame(payload))
        try:
            while True:
                data = sock.recv(4096)
                # Ethernet (14) + IPv4 (IHL) + UDP (8), port destination 68.
                if data[12:14] != b"\x08\x00" or data[23] != 17:
                    continue
                ihl = (data[14] & 0x0F) * 4
                udp = data[14 + ihl :]
                if struct.unpack("!H", udp[2:4])[0] != 68:
                    continue
                bootp = udp[8:]
                if len(bootp) < 240 or struct.unpack("!I", bootp[4:8])[0] != XID:
                    continue
                yiaddr, opts = parse(bootp)
                if opts.get(53, b"\0")[0] == want:
                    return yiaddr, opts
        except socket.timeout:
            continue
    raise SystemExit("Aucune réponse DHCP")


sock = socket.socket(socket.AF_PACKET, socket.SOCK_RAW, socket.htons(0x0800))
sock.bind((IFACE, 0))
sock.settimeout(3)

offer, opts = exchange(sock, packet(1), 2)
server = opts[54]
ack, opts = exchange(sock, packet(3, bytes([50, 4]) + socket.inet_aton(offer) + bytes([54, 4]) + server), 5)
mask = socket.inet_ntoa(opts.get(1, b"\xff\xff\xff\0"))
prefix = sum(bin(b).count("1") for b in socket.inet_aton(mask))
router = socket.inet_ntoa(opts[3][:4]) if 3 in opts else None
dns = socket.inet_ntoa(opts[6][:4]) if 6 in opts else None
print(f"DHCP ACK : {ack}/{prefix} passerelle {router} DNS {dns} serveur {socket.inet_ntoa(server)}")
if os.environ.get("DHCP_APPLY", "1") == "1":
    subprocess.run(["ip", "addr", "add", f"{ack}/{prefix}", "dev", IFACE], check=False)
    if router:
        subprocess.run(["ip", "route", "replace", "default", "via", router], check=False)
