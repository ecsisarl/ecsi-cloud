#!/bin/sh
# ECSI CLOUD — contrôle préalable de l'exposition HTTPS (Sprint S3H, étape H4), SANS AFFICHER
# AUCUNE VALEUR et sans rien modifier : ni conteneur de production, ni volume, ni certificat.
#
#   ops/tls/preflight.sh            (ECSI_ENV_FILE, ECSI_PROJECT : voir ops/tls/lib.sh)
#
# Contrôles :
#   - configuration Compose FUSIONNÉE (base + surcouche de production, profils gateway et ops),
#     lue par ops/tls/compose-check.mjs : ports publiés (Nginx 80/443, PostgreSQL 127.0.0.1
#     seulement), portail non requis, Nginx de production, URL publiques attendues, garde-fous
#     (COOKIE_SECURE, LOG_PRETTY, S3_AUTO_CREATE_BUCKET), aucune AC privée d'enrôlement,
#     clés de chiffrement identiques partout et k2 conservée, SMTP réel ;
#   - syntaxe Nginx (nginx -t) des deux modes, dans un conteneur jetable sans réseau ; le mode
#     « https » seulement si le certificat existe déjà dans le volume letsencrypt.
#
# Code de sortie : 0 conforme ; 1 au moins un ECHEC.
set -eu
# shellcheck source=lib.sh
. "$(dirname "$0")/lib.sh"

[ -r "$ENV_FILE" ] || die "fichier d'environnement illisible : $ENV_FILE"
FAILS=0
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

echo "=== Configuration Compose fusionnée (projet $PROJECT)"
# La sortie complète de « config » contient des secrets : elle ne va QUE vers compose-check.mjs.
# shellcheck disable=SC2046
if ! $(compose_cmd) --profile gateway --profile ops config --format json 2>"$TMP/config.err" |
  docker run --rm -i --network none --pull never --entrypoint node \
    -v "$TLS_DIR/compose-check.mjs:/ecsi-check/compose-check.mjs:ro" \
    "$OPS_IMAGE" /ecsi-check/compose-check.mjs; then
  # Messages de Compose : noms de variables manquantes, jamais leurs valeurs.
  sed -n 's/.*\(required variable [A-Z0-9_]* is missing a value\).*/ECHEC \1/p' "$TMP/config.err"
  FAILS=$((FAILS + 1))
fi

# Le mode Nginx est choisi par ops/tls/certificat.sh, jamais figé dans le fichier .env (sinon un
# simple « docker compose up -d » reviendrait au mode acme-bootstrap).
if grep -q '^ECSI_NGINX_MODE=' "$ENV_FILE"; then
  echo 'ECHEC ECSI_NGINX_MODE défini dans le fichier .env : le retirer (mode choisi par ops/tls/certificat.sh)'
  FAILS=$((FAILS + 1))
fi

echo "=== Syntaxe Nginx (nginx -t)"
nginx_test() { # nginx_test <mode> [options docker run supplémentaires]
  mode=$1
  shift
  docker run --rm --network none --add-host api:127.0.0.1 --add-host web:127.0.0.1 \
    -e NGINX_ENTRYPOINT_QUIET_LOGS=1 -v "$REPO/infra/nginx/production:/etc/nginx/ecsi:ro" "$@" \
    nginx:1-alpine nginx -t -q -c "/etc/nginx/ecsi/$mode.conf" >"$TMP/nginx.log" 2>&1
}
if nginx_test acme-bootstrap; then
  echo 'OK    mode acme-bootstrap : configuration valide'
else
  echo 'ECHEC mode acme-bootstrap : configuration invalide'
  sed 's/^/      /' "$TMP/nginx.log"
  FAILS=$((FAILS + 1))
fi
VOLUME="${PROJECT}_letsencrypt"
if docker volume inspect "$VOLUME" >/dev/null 2>&1 &&
  docker run --rm --network none -v "$VOLUME:/le:ro" nginx:1-alpine \
    test -s "/le/live/$CERT_NAME/fullchain.pem"; then
  if nginx_test https -v "$VOLUME:/etc/letsencrypt:ro"; then
    echo "OK    mode https : configuration valide avec le certificat « $CERT_NAME »"
  else
    echo 'ECHEC mode https : configuration invalide'
    sed 's/^/      /' "$TMP/nginx.log"
    FAILS=$((FAILS + 1))
  fi
else
  echo "INFO  mode https : certificat « $CERT_NAME » absent du volume $VOLUME (normal avant ops/tls/certificat.sh production)"
fi

echo
if [ "$FAILS" = 0 ]; then
  echo 'PREFLIGHT H4 : CONFORME'
else
  echo "PREFLIGHT H4 : $FAILS contrôle(s) en échec"
  exit 1
fi
