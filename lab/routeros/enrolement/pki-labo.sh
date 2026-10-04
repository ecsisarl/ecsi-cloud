#!/usr/bin/env bash
# AC et certificat serveur du LABORATOIRE pour l'API d'enrôlement (203.0.113.30).
# En production, l'API d'enrôlement présente un certificat d'une AC publique : RouterOS le
# vérifie avec son magasin d'AC intégré (« builtin-trust-store », qui inclut fetch par défaut,
# doc Certificates pages/2555969) et aucune AC n'est importée sur le routeur.
# Clés privées dans $LAB_STATE/pki (ignoré par Git), jamais dans le dépôt.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
STATE="${LAB_STATE:-$HERE/../../sim/.state}"
PKI="$STATE/pki"
HOST_IP="${1:-203.0.113.30}"
mkdir -p "$PKI"
chmod 700 "$PKI"
cd "$PKI"
if [[ ! -f ca.key ]]; then
  openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 30 \
    -keyout ca.key -out ca.pem -subj "/CN=ECSI CLOUD LABO AC" \
    -addext "basicConstraints=critical,CA:TRUE" -addext "keyUsage=critical,keyCertSign,cRLSign" 2>/dev/null
fi
openssl req -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -keyout serveur.key \
  -out serveur.csr -subj "/CN=$HOST_IP" 2>/dev/null
openssl x509 -req -in serveur.csr -CA ca.pem -CAkey ca.key -CAcreateserial -days 30 -out serveur.pem \
  -extfile <(printf 'subjectAltName=IP:%s\nextendedKeyUsage=serverAuth\nkeyUsage=critical,digitalSignature\n' "$HOST_IP") 2>/dev/null
chmod 600 ./*.key
echo "AC : $PKI/ca.pem (SHA-256 DER : $(openssl x509 -in ca.pem -outform der | sha256sum | cut -d' ' -f1))"
