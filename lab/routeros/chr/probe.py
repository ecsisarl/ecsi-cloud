"""Sonde de laboratoire : ce que le futur worker ECSI CLOUD lira sur un routeur, par l'API REST,
EXCLUSIVEMENT via l'adresse tunnel WireGuard du routeur.

  ip netns exec worker python3 probe.py <ip-tunnel> <utilisateur> <fichier-mot-de-passe> \
      [--fingerprint <sha256 attendu>]

- TLS : le certificat du routeur est autosigné ; on ne fait PAS confiance à une AC, on compare
  son empreinte SHA-256 à celle relevée à l'enrôlement (épinglage). Sans --fingerprint,
  l'empreinte est seulement affichée (premier contact).
- Requêtes en lecture seule (GET, et POST sur monitor-traffic avec « once », l'équivalent
  REST d'une commande de supervision, cf. REST API pages/47579162).
- Le mot de passe n'est jamais affiché.
"""

import argparse
import base64
import hashlib
import http.client
import json
import ssl
import sys
import time


def connect(host: str, expected: str | None) -> tuple[http.client.HTTPSConnection, str]:
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE  # remplacé par l'épinglage ci-dessous
    conn = http.client.HTTPSConnection(host, 443, context=ctx, timeout=20)
    conn.connect()
    der = conn.sock.getpeercert(binary_form=True)
    fingerprint = hashlib.sha256(der).hexdigest()
    if expected and fingerprint != expected.lower():
        raise SystemExit(f"Empreinte TLS inattendue : {fingerprint} (attendue {expected})")
    return conn, fingerprint


def call(conn, auth: str, method: str, path: str, body=None):
    headers = {"Authorization": f"Basic {auth}", "Content-Type": "application/json"}
    start = time.monotonic()
    conn.request(method, f"/rest/{path}", body=json.dumps(body) if body else None, headers=headers)
    response = conn.getresponse()
    data = response.read()
    elapsed = round((time.monotonic() - start) * 1000)
    try:
        payload = json.loads(data) if data else None
    except json.JSONDecodeError:
        payload = data.decode(errors="replace")
    return response.status, payload, elapsed


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("host")
    parser.add_argument("user")
    parser.add_argument("password_file")
    parser.add_argument("--fingerprint")
    args = parser.parse_args()
    with open(args.password_file, encoding="utf-8") as f:
        password = f.read().strip()
    auth = base64.b64encode(f"{args.user}:{password}".encode()).decode()
    conn, fingerprint = connect(args.host, args.fingerprint)
    result = {"host": args.host, "tlsFingerprintSha256": fingerprint, "calls": {}}
    requests = [
        ("GET", "system/identity", None),
        ("GET", "system/resource", None),
        ("GET", "system/resource/cpu", None),
        ("GET", "system/routerboard", None),
        ("GET", "system/health", None),
        ("GET", "system/license", None),
        ("GET", "interface?.proplist=name,type,running,disabled,mtu,mac-address,rx-byte,tx-byte,rx-packet,tx-packet,link-downs", None),
        ("POST", "interface/monitor-traffic", {"interface": "ether1", "once": ""}),
        ("GET", "interface/wireguard/peers?.proplist=name,last-handshake,rx,tx,current-endpoint-address", None),
    ]
    for method, path, body in requests:
        status, payload, elapsed = call(conn, auth, method, path, body)
        result["calls"][f"{method} /rest/{path}"] = {"status": status, "ms": elapsed, "body": payload}
    json.dump(result, sys.stdout, indent=2, ensure_ascii=False)
    print()
    return 0


if __name__ == "__main__":
    sys.exit(main())
