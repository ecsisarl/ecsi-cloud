"""Serveur d'enrôlement du LABORATOIRE (Sprint 3A) : valide le protocole décrit dans
lab/routeros/PROTOCOLE-PROVISIONNEMENT.md contre un vrai RouterOS (CHR).

Ce n'est PAS le code de production : pas d'authentification administrateur, base SQLite
locale, mots de passe stockés dans des fichiers 0600 du répertoire d'état (en production :
chiffrement enveloppe, ADR 0014). Il reproduit les règles du protocole :

  new <nom> <ip-tunnel>    étape 0 : routeur PROVISIONING, jeton 32 octets (haché SHA-256 en
                           base, 30 min, usage unique), script RouterOS généré (fichier 0600).
  public                   étapes 4-5 : POST /enroll {token, publicKey} en HTTPS (Internet).
                           Consommation ATOMIQUE du jeton, ajout du pair sur la passerelle
                           (clé publique + /32, sans endpoint). GET /ca.pem : AC du labo.
  activation               étape 8 : POST /activate {user, password, tlsFingerprint}, écoute
                           sur l'IP tunnel de la passerelle uniquement. L'émetteur est identifié
                           par son IP tunnel (garantie par WireGuard : allowed-ips /32).
                           Accepté une seule fois, à l'état PROVISIONING.
  show                     état des routeurs et journal d'audit.

Le serveur n'envoie jamais de clé privée et n'en reçoit jamais.
"""

import argparse
import datetime
import hashlib
import http.server
import json
import os
import re
import secrets
import sqlite3
import ssl
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
STATE = os.environ.get("LAB_STATE", os.path.join(HERE, "..", "..", "sim", ".state"))
DB = os.path.join(STATE, "enrolement.sqlite")
TOKEN_TTL = datetime.timedelta(minutes=30)
# Interface WireGuard de la passerelle et namespace réseau où elle se trouve (labo : « gw » ;
# passerelle de test sur un serveur : LAB_GW_NETNS vide, LAB_WG_IFACE=wg0).
GW_NETNS = os.environ.get("LAB_GW_NETNS", "gw")
WG_IFACE = os.environ.get("LAB_WG_IFACE", "wg-gw")
WG_KEY = re.compile(r"^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=$")


def now() -> str:
    return datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")


def db() -> sqlite3.Connection:
    conn = sqlite3.connect(DB, isolation_level=None, timeout=10)
    conn.execute(
        """CREATE TABLE IF NOT EXISTS routers (
             name TEXT PRIMARY KEY, tunnel_ip TEXT UNIQUE NOT NULL, state TEXT NOT NULL,
             public_key TEXT UNIQUE, token_hash TEXT UNIQUE, token_expires TEXT,
             token_used_at TEXT, svc_user TEXT, tls_fingerprint TEXT, created_at TEXT)"""
    )
    conn.execute(
        "CREATE TABLE IF NOT EXISTS audit (ts TEXT, router TEXT, event TEXT, source TEXT, detail TEXT)"
    )
    return conn


def audit(conn, router, event, source, detail=""):
    conn.execute("INSERT INTO audit VALUES (?,?,?,?,?)", (now(), router, event, source, detail))
    print(f"[audit] {event} routeur={router} source={source} {detail}", file=sys.stderr, flush=True)


def token_hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def cmd_new(args) -> int:
    conn = db()
    token = secrets.token_urlsafe(32)  # 32 octets aléatoires
    expires = (datetime.datetime.now(datetime.timezone.utc) + TOKEN_TTL).isoformat(timespec="seconds")
    conn.execute(
        "INSERT INTO routers (name, tunnel_ip, state, token_hash, token_expires, created_at)"
        " VALUES (?,?,?,?,?,?)",
        (args.name, args.tunnel_ip, "PROVISIONING", token_hash(token), expires, now()),
    )
    audit(conn, args.name, "CREATED", "admin", f"ip={args.tunnel_ip} expire={expires}")
    with open(args.template, encoding="utf-8") as f:
        script = f.read()
    gw_public = open(os.path.join(STATE, "gw", "public"), encoding="utf-8").read().strip()
    ca_der = subprocess.run(
        ["openssl", "x509", "-in", os.path.join(STATE, "pki", "ca.pem"), "-outform", "der"],
        check=True, capture_output=True,
    ).stdout
    values = {
        "__TOKEN__": token,
        "__ENROLL_URL__": f"https://{args.public_host}:{args.public_port}/enroll",
        "__CA_URL__": f"https://{args.public_host}:{args.public_port}/ca.pem",
        "__CA_FINGERPRINT__": hashlib.sha256(ca_der).hexdigest(),
        "__ACTIVATE_URL__": f"http://{args.gw_tunnel_ip}:{args.activation_port}/activate",
        "__GW_PUBLIC_KEY__": gw_public,
        "__GW_ENDPOINT__": args.gw_endpoint,
        "__GW_PORT__": str(args.gw_port),
        "__GW_TUNNEL_IP__": args.gw_tunnel_ip,
        "__TUNNEL_ADDRESS__": f"{args.tunnel_ip}/24",
    }
    for key, value in values.items():
        script = script.replace(key, value)
    out = os.path.join(STATE, f"enrolement-{args.name}.rsc")
    fd = os.open(out, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(script)
    print(out)
    return 0


class Handler(http.server.BaseHTTPRequestHandler):
    mode = "public"

    def log_message(self, fmt, *a):
        print(f"[{self.mode}] {self.client_address[0]} {fmt % a}", file=sys.stderr, flush=True)

    def reply(self, code: int, payload) -> None:
        body = json.dumps(payload).encode() if not isinstance(payload, bytes) else payload
        self.send_response(code)
        self.send_header("Content-Type", "application/json" if not isinstance(payload, bytes) else "application/x-pem-file")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def body(self) -> dict:
        length = int(self.headers.get("Content-Length", "0"))
        if length > 4096:
            raise ValueError("corps trop long")
        data = json.loads(self.rfile.read(length) or b"{}")
        if not isinstance(data, dict):
            raise ValueError("objet JSON attendu")
        return data

    def do_GET(self):
        if self.mode == "public" and self.path == "/ca.pem":
            # LABO uniquement : en production l'AC est publique (magasin intégré de RouterOS).
            with open(os.path.join(STATE, "pki", "ca.pem"), "rb") as f:
                return self.reply(200, f.read())
        self.reply(404, {"error": "introuvable"})

    def do_POST(self):
        try:
            data = self.body()
        except ValueError as e:
            return self.reply(400, {"error": str(e)})
        if self.mode == "public" and self.path == "/enroll":
            return self.enroll(data)
        if self.mode == "activation" and self.path == "/activate":
            return self.activate(data)
        self.reply(404, {"error": "introuvable"})

    def enroll(self, data):
        source = self.client_address[0]
        token, public_key = str(data.get("token", "")), str(data.get("publicKey", ""))
        conn = db()
        if not WG_KEY.match(public_key):
            audit(conn, "?", "ENROLL_DENIED", source, "clé publique invalide")
            return self.reply(400, {"error": "clé publique invalide"})
        if set(data) - {"token", "publicKey"}:
            audit(conn, "?", "ENROLL_DENIED", source, f"champs inattendus {sorted(set(data))}")
            return self.reply(400, {"error": "seuls token et publicKey sont acceptés"})
        # Consommation atomique : une seule requête peut passer, même en concurrence.
        cur = conn.execute(
            "UPDATE routers SET token_used_at=?, public_key=? WHERE token_hash=? AND token_used_at IS NULL"
            " AND token_expires > ? AND state='PROVISIONING'",
            (now(), public_key, token_hash(token), now()),
        )
        if cur.rowcount != 1:
            row = conn.execute("SELECT name FROM routers WHERE token_hash=?", (token_hash(token),)).fetchone()
            audit(conn, row[0] if row else "?", "ENROLL_DENIED", source,
                  "jeton déjà utilisé, expiré ou inconnu (alerte : tentative de réutilisation)" if row else "jeton inconnu")
            return self.reply(410, {"error": "jeton invalide, expiré ou déjà utilisé"})
        name, tunnel_ip = conn.execute(
            "SELECT name, tunnel_ip FROM routers WHERE token_hash=?", (token_hash(token),)
        ).fetchone()
        # Étape 5 : pair ajouté sur la passerelle, une seule adresse /32, AUCUN endpoint.
        prefix = ["ip", "netns", "exec", GW_NETNS] if GW_NETNS else []
        subprocess.run(
            prefix + ["wg", "set", WG_IFACE, "peer", public_key, "allowed-ips", f"{tunnel_ip}/32"],
            check=True,
        )
        audit(conn, name, "ENROLLED", source, f"clé publique {public_key[:8]}…, pair ajouté {tunnel_ip}/32")
        self.reply(200, {"status": "enrolled"})

    def activate(self, data):
        source = self.client_address[0]
        conn = db()
        row = conn.execute(
            "SELECT name, state, public_key FROM routers WHERE tunnel_ip=?", (source,)
        ).fetchone()
        user, password = str(data.get("user", "")), str(data.get("password", ""))
        fingerprint = str(data.get("tlsFingerprint", "")).lower()
        if not row or row[1] != "PROVISIONING" or not row[2]:
            audit(conn, row[0] if row else "?", "ACTIVATE_DENIED", source,
                  f"état {row[1] if row else 'inconnu'} : identifiants refusés")
            return self.reply(409, {"error": "activation refusée"})
        if not re.fullmatch(r"[a-f0-9]{64}", fingerprint) or len(password) < 20 or not user:
            audit(conn, row[0], "ACTIVATE_DENIED", source, "données invalides")
            return self.reply(400, {"error": "données invalides"})
        cur = conn.execute(
            "UPDATE routers SET state='ACTIVATED', svc_user=?, tls_fingerprint=? WHERE name=? AND state='PROVISIONING'",
            (user, fingerprint, row[0]),
        )
        if cur.rowcount != 1:
            return self.reply(409, {"error": "activation refusée"})
        path = os.path.join(STATE, f"{row[0]}-svc.pass")
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(password)
        audit(conn, row[0], "ACTIVATED", source, f"compte {user}, empreinte TLS {fingerprint[:16]}…")
        self.reply(200, {"status": "activated"})


def serve(mode: str, host: str, port: int, cert: str | None, key: str | None) -> int:
    Handler.mode = mode
    server = http.server.ThreadingHTTPServer((host, port), Handler)
    if cert:
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ctx.minimum_version = ssl.TLSVersion.TLSv1_2
        ctx.load_cert_chain(cert, key)
        server.socket = ctx.wrap_socket(server.socket, server_side=True)
    print(f"[{mode}] écoute sur {host}:{port}", file=sys.stderr, flush=True)
    server.serve_forever()
    return 0


def cmd_show(_args) -> int:
    conn = db()
    for row in conn.execute("SELECT name, tunnel_ip, state, public_key, token_used_at, svc_user, tls_fingerprint FROM routers"):
        print(" | ".join(str(c) for c in row))
    for row in conn.execute("SELECT * FROM audit ORDER BY ts"):
        print(" | ".join(str(c) for c in row))
    return 0


def main() -> int:
    p = argparse.ArgumentParser()
    sub = p.add_subparsers(dest="cmd", required=True)
    n = sub.add_parser("new")
    n.add_argument("name")
    n.add_argument("tunnel_ip")
    n.add_argument("--template", default=os.path.join(HERE, "ecsi-enrolement.rsc.modele"))
    n.add_argument("--public-host", default="203.0.113.30")
    n.add_argument("--public-port", type=int, default=443)
    n.add_argument("--gw-endpoint", default="203.0.113.10")
    n.add_argument("--gw-port", type=int, default=51820)
    n.add_argument("--gw-tunnel-ip", default="10.200.0.1")
    n.add_argument("--activation-port", type=int, default=8081)
    pub = sub.add_parser("public")
    pub.add_argument("--host", default="203.0.113.30")
    pub.add_argument("--port", type=int, default=443)
    act = sub.add_parser("activation")
    act.add_argument("--host", default="10.200.0.1")
    act.add_argument("--port", type=int, default=8081)
    sub.add_parser("show")
    args = p.parse_args()
    if args.cmd == "new":
        return cmd_new(args)
    if args.cmd == "public":
        pki = os.path.join(STATE, "pki")
        return serve("public", args.host, args.port, os.path.join(pki, "serveur.pem"), os.path.join(pki, "serveur.key"))
    if args.cmd == "activation":
        return serve("activation", args.host, args.port, None, None)
    return cmd_show(args)


if __name__ == "__main__":
    sys.exit(main())
