"""Service HTTP factice du laboratoire SIMULÉ.

Il remplace l'API REST RouterOS dans les namespaces r1/r2 pour tester le CHEMIN réseau
(tunnel, firewall, NAT) et rien d'autre : il ne reproduit AUCUN format RouterOS.
Les données réelles du routeur sont collectées sur CHR (lab/routeros/).
"""

import json
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

NAME = sys.argv[1]
PORT = int(sys.argv[2])


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):  # noqa: N802 (nom imposé par http.server)
        body = json.dumps({"simulated": True, "node": NAME, "client": self.client_address[0]})
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.end_headers()
        self.wfile.write(body.encode())

    def log_message(self, *_args):
        pass


if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
