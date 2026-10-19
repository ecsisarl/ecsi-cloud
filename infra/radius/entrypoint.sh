#!/bin/sh
# Démarrage de FreeRADIUS (lot B) : vérifie la configuration SANS jamais afficher une
# valeur, puis lance radiusd au premier plan (journaux sur la sortie standard, sans mode
# debug : le mode -X afficherait les secrets et ne doit jamais servir en production).
set -eu

fail() {
  echo "ecsi-radius : $1" >&2
  exit 64
}

for name in RADIUS_LISTEN_ADDRESS RADIUS_CLIENT_CIDR RADIUS_DB_HOST RADIUS_DB_PORT \
  RADIUS_DB_NAME RADIUS_DB_PASSWORD RADIUS_VOUCHER_LOOKUP_KEY RADIUS_NAS_KEY; do
  eval "value=\${$name:-}"
  [ -n "$value" ] || fail "$name est requis"
done

key_ok() {
  printf '%s' "$1" | grep -Eq '^([0-9a-f]{64}|devonly-[a-z0-9-]{8,64})$'
}
key_ok "$RADIUS_VOUCHER_LOOKUP_KEY" || fail 'RADIUS_VOUCHER_LOOKUP_KEY : 64 caractères hexadécimaux attendus'
key_ok "$RADIUS_NAS_KEY" || fail 'RADIUS_NAS_KEY : 64 caractères hexadécimaux attendus'
[ "$RADIUS_VOUCHER_LOOKUP_KEY" != "$RADIUS_NAS_KEY" ] ||
  fail 'RADIUS_VOUCHER_LOOKUP_KEY et RADIUS_NAS_KEY doivent être différentes'

if [ "${ECSI_ENV:-development}" = production ]; then
  for name in RADIUS_DB_PASSWORD RADIUS_VOUCHER_LOOKUP_KEY RADIUS_NAS_KEY; do
    eval "value=\${$name}"
    case "$value" in *devonly*) fail "$name : valeur de développement interdite en production" ;; esac
  done
  case "$RADIUS_LISTEN_ADDRESS" in
    0.0.0.0 | '*' | ::) fail 'RADIUS_LISTEN_ADDRESS : écoute sur toutes les interfaces interdite (WireGuard seulement)' ;;
  esac
fi

printf '%s' "$RADIUS_DB_PORT" | grep -Eq '^[0-9]{1,5}$' || fail 'RADIUS_DB_PORT invalide'
printf '%s' "$RADIUS_LISTEN_ADDRESS" | grep -Eq '^[0-9]{1,3}(\.[0-9]{1,3}){3}$' ||
  fail 'RADIUS_LISTEN_ADDRESS : adresse IPv4 attendue'
printf '%s' "$RADIUS_CLIENT_CIDR" | grep -Eq '^[0-9]{1,3}(\.[0-9]{1,3}){3}/[0-9]{1,2}$' ||
  fail 'RADIUS_CLIENT_CIDR : réseau IPv4 attendu (ex. 10.200.0.0/24)'

if [ "${1:-}" = check ]; then
  exec /usr/sbin/freeradius -C -l stdout
fi
# Mode debug (-X) : laboratoire uniquement. Il affiche les attributs, donc les codes saisis
# et les secrets : refusé en production.
if [ "${1:-}" = debug ]; then
  [ "${ECSI_ENV:-development}" != production ] || fail 'mode debug interdit en production'
  exec /usr/sbin/freeradius -X -l stdout
fi
exec /usr/sbin/freeradius -f -l stdout
