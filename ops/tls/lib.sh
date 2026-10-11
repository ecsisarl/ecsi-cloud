# shellcheck shell=sh disable=SC2034  # SC2034 : variables utilisées par les scripts appelants.
# ECSI CLOUD — fonctions communes des outils HTTPS (Sprint S3H, étape H4).
# Chargé par preflight.sh et certificat.sh. Aucune valeur secrète n'est jamais affichée : la
# configuration Compose fusionnée n'est lue que par compose-check.mjs, qui n'écrit que des
# verdicts.
#
# Variables (facultatives) :
#   ECSI_ENV_FILE      fichier d'environnement de production (défaut : <dépôt>/.env)
#   ECSI_PROJECT       nom du projet Compose (défaut : ecsi-cloud, celui de la production)
#   ECSI_COMPOSE_EXTRA fichier(s) Compose supplémentaire(s) « -f … » (essais seulement)
#   ECSI_OPS_IMAGE     image contenant node, pour compose-check.mjs (défaut : ecsi-cloud/api:dev,
#                      jamais téléchargée ni reconstruite)
#   ECSI_HTTP_PORT / ECSI_HTTPS_PORT  ports locaux de Nginx pour les contrôles (défaut 80 / 443)

set -eu
umask 077

TLS_DIR=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$TLS_DIR/../.." && pwd)
ENV_FILE=${ECSI_ENV_FILE:-$REPO/.env}
PROJECT=${ECSI_PROJECT:-ecsi-cloud}
OPS_IMAGE=${ECSI_OPS_IMAGE:-ecsi-cloud/api:dev}
HTTP_PORT=${ECSI_HTTP_PORT:-80}
HTTPS_PORT=${ECSI_HTTPS_PORT:-443}
DOMAINS='app.mytikcentral.com enroll.mytikcentral.com'
CERT_NAME=mytikcentral

log() { printf '%s %s\n' "$(date -u +%H:%M:%SZ)" "$*" >&2; }
die() {
  log "ECHEC $*"
  exit 1
}

# Commande Compose de production (base + surcouche [+ essais]) : à découper en mots.
compose_cmd() {
  printf 'docker compose -p %s --env-file %s -f %s/docker-compose.yml -f %s/docker-compose.prod.yml %s' \
    "$PROJECT" "$ENV_FILE" "$REPO" "$REPO" "${ECSI_COMPOSE_EXTRA:-}"
}

# Requête HTTP locale vers Nginx pour un nom d'hôte (sans dépendre du DNS) : code HTTP.
local_http() { # local_http <hôte> <chemin>
  curl --noproxy "*" -s -o /dev/null -w '%{http_code}' --max-time 10 \
    --resolve "$1:$HTTP_PORT:127.0.0.1" "http://$1:$HTTP_PORT$2" || true
}
