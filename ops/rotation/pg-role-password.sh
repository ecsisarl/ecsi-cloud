#!/bin/sh
# ECSI CLOUD — rotation contrôlée du mot de passe d'UN rôle PostgreSQL (Sprint S3H, étape H3,
# outillage D.4). Procédure : docs/SECURITY.md, « Rotation des secrets (H3) ».
#
#   ops/rotation/pg-role-password.sh <rôle> --ancien <fichier> [--env <fichier>] [--projet <nom>] [--dry-run]
#   ops/rotation/pg-role-password.sh <rôle> --ancien <fichier> [--env <fichier>] [--projet <nom>] --rollback
#
#   <rôle>      ecsi_migrator | ecsi_app | ecsi_auth | ecsi_worker | postgres
#   --env       fichier contenant la NOUVELLE valeur (défaut : .env), déjà mise à jour
#   --ancien    instantané contenant l'ANCIENNE valeur (ex. /root/ecsi-h3/env.avant-h3.3)
#   --projet    projet Compose (défaut : ecsi-cloud)
#   --dry-run   contrôles seulement : nouvelle valeur conforme, ancienne valeur encore valide
#   --rollback  remet l'ancienne valeur (même contrôles, sens inverse)
#
# Garanties :
#  - aucune valeur n'est affichée, ni passée en argument d'un programme (ps, docker ps,
#    /proc/*/cmdline) : elle ne transite que par l'entrée standard de psql ;
#  - l'ALTER ROLE ne peut pas être écrit dans le journal PostgreSQL, même si le serveur journalise
#    toutes les requêtes ou les erreurs : log_statement, log_min_error_statement et
#    log_min_duration_statement sont neutralisés pour la session (superutilisateur) ; un échec
#    n'affiche qu'un message générique, jamais la sortie de psql ;
#  - contrôle par connexion TCP réelle (SCRAM) : nouvelle valeur acceptée, ancienne refusée ;
#  - idempotent : si la nouvelle valeur est déjà en place, rien n'est modifié.
# Le script ne redémarre aucun service : il affiche la commande des consommateurs, à lancer
# immédiatement (les connexions ouvertes restent valides, les nouvelles exigent la nouvelle
# valeur).
#
# Code de sortie : 0 succès (ou déjà fait) ; 1 échec ; 2 usage.
set -eu
# shellcheck source=lib.sh
. "$(dirname "$0")/lib.sh"

usage() {
  echo 'Usage : pg-role-password.sh <ecsi_migrator|ecsi_app|ecsi_auth|ecsi_worker|postgres> --ancien <fichier> [--env <fichier>] [--projet <nom>] [--dry-run | --rollback]' >&2
  exit 2
}

[ $# -ge 1 ] || usage
ROLE=$1
shift
case $ROLE in
  ecsi_migrator) VAR=ECSI_DB_MIGRATOR_PASSWORD; NEXT='docker compose run --rm --no-deps migrate   (puis : keys-rotate --verify)' ;;
  ecsi_app) VAR=ECSI_DB_APP_PASSWORD; NEXT='docker compose up -d --no-deps --no-build api' ;;
  ecsi_auth) VAR=ECSI_DB_AUTH_PASSWORD; NEXT='docker compose up -d --no-deps --no-build api' ;;
  ecsi_worker) VAR=ECSI_DB_WORKER_PASSWORD; NEXT='docker compose up -d --no-deps --no-build worker && docker compose --profile gateway up -d --no-deps --no-build gateway' ;;
  postgres) VAR=POSTGRES_PASSWORD; NEXT='aucun service à redémarrer (superutilisateur)' ;;
  *) usage ;;
esac
ENV_FILE=.env
OLD_FILE=''
PROJECT=ecsi-cloud
MODE=rotate
while [ $# -gt 0 ]; do
  case $1 in
    --env) [ $# -ge 2 ] || usage; ENV_FILE=$2; shift ;;
    --ancien) [ $# -ge 2 ] || usage; OLD_FILE=$2; shift ;;
    --projet) [ $# -ge 2 ] || usage; PROJECT=$2; shift ;;
    --dry-run) MODE=dry-run ;;
    --rollback) MODE=rollback ;;
    *) usage ;;
  esac
  shift
done
[ -n "$OLD_FILE" ] || usage
[ -r "$ENV_FILE" ] || die "fichier illisible : $ENV_FILE"
[ -r "$OLD_FILE" ] || die "fichier illisible : $OLD_FILE"
command -v docker >/dev/null 2>&1 || die 'docker introuvable'

valid() { printf '%s' "$1" | grep -Eq '^[A-Za-z0-9._~-]{24,}$'; }

NEW=$(env_get "$ENV_FILE" "$VAR")
OLD=$(env_get "$OLD_FILE" "$VAR")
[ "$(env_count "$ENV_FILE" "$VAR")" = 1 ] || die "$VAR doit être définie exactement une fois dans $ENV_FILE"
[ -n "$OLD" ] || die "$VAR absente de $OLD_FILE"
case $NEW in *devonly*) die "$VAR : valeur de développement « devonly » refusée" ;; esac
valid "$NEW" || die "$VAR : 24 caractères minimum parmi A-Z a-z 0-9 . _ ~ - (inséré dans une URL)"
[ "$(kcv "$NEW")" != "$(kcv "$OLD")" ] || die "$VAR : la nouvelle valeur est identique à l'ancienne"
if [ "$MODE" = rollback ]; then
  # Sens inverse : la valeur à poser est l'ancienne, celle à refuser est la nouvelle.
  TARGET=$OLD
  RETIRED=$NEW
  valid "$OLD" || die "$VAR : l'ancienne valeur ne respecte pas le format ; retour arrière manuel nécessaire"
else
  TARGET=$NEW
  RETIRED=$OLD
fi
log "rôle $ROLE ($VAR) : valeur à poser KCV $(kcv "$TARGET"), valeur à retirer KCV $(kcv "$RETIRED")"

CONTAINER=$(docker ps -q --filter "label=com.docker.compose.project=$PROJECT" \
  --filter 'label=com.docker.compose.service=postgres' | head -n 1)
[ -n "$CONTAINER" ] || die "conteneur postgres du projet « $PROJECT » introuvable"
DB=$(docker exec "$CONTAINER" printenv POSTGRES_DB)

# Exécute du SQL lu sur l'entrée standard, en superutilisateur (socket local du conteneur).
admin_sql() { docker exec -i "$CONTAINER" psql -X -q -v ON_ERROR_STOP=1 -U postgres -d "$DB" "$@"; }

# Connexion TCP réelle du rôle avec un mot de passe lu sur l'entrée standard (jamais en argument).
# Par l'adresse réseau du conteneur, pas 127.0.0.1 : l'image officielle accepte le bouclage
# local sans mot de passe (trust), alors que les autres adresses exigent SCRAM, comme pour
# l'API, le worker et la passerelle.
can_login() {
  printf '%s\n' "$1" | docker exec -i "$CONTAINER" sh -c \
    'IFS= read -r PGPASSWORD; export PGPASSWORD; h=$(hostname -i | cut -d" " -f1); exec psql -X -A -t -q -w -h "$h" -U "$1" -d "$2" -c "select current_user"' \
    sh "$ROLE" "$DB" 2>/dev/null | grep -qx "$ROLE"
}

exists=$(printf "select count(*) from pg_roles where rolname = '%s';\n" "$ROLE" | admin_sql -A -t 2>/dev/null || true)
[ "$exists" = 1 ] || die "rôle $ROLE introuvable"

if can_login "$TARGET"; then
  if can_login "$RETIRED"; then die "les deux valeurs sont acceptées pour $ROLE : état incohérent, rien n'est modifié"; fi
  log "OK    $ROLE : la valeur à poser est DÉJÀ en place et l'autre est refusée ; rien n'est modifié"
  echo "RESULTAT : déjà fait ($ROLE). Consommateurs : $NEXT"
  exit 0
fi
can_login "$RETIRED" || die "$ROLE : ni l'ancienne ni la nouvelle valeur ne sont acceptées ; rien n'est modifié"
log "OK    $ROLE : valeur actuelle valide (connexion TCP), valeur à poser conforme"

if [ "$MODE" = dry-run ]; then
  echo "RESULTAT : SIMULATION, rien n'est modifié ($ROLE). Consommateurs à relancer après la rotation : $NEXT"
  exit 0
fi

# ALTER ROLE par l'entrée standard ; journalisation neutralisée pour cette session.
err=$(mktemp)
trap 'rm -f "$err"' EXIT
if ! {
  printf '%s\n' \
    "SET log_statement = 'none';" \
    "SET log_min_error_statement = 'panic';" \
    "SET log_min_duration_statement = -1;" \
    "SET password_encryption = 'scram-sha-256';"
  printf "ALTER ROLE \"%s\" PASSWORD '%s';\n" "$ROLE" "$TARGET"
} | admin_sql >/dev/null 2>"$err"; then
  # Jamais la sortie de psql (elle pourrait citer la requête) : message générique.
  die "ALTER ROLE $ROLE a échoué (sortie de psql masquée par sécurité) ; aucune valeur modifiée si l'erreur est survenue avant l'exécution"
fi

if ! can_login "$TARGET"; then
  die "$ROLE : la valeur posée n'est PAS acceptée ; lancez le retour arrière (--rollback) immédiatement"
fi
if can_login "$RETIRED"; then
  die "$ROLE : l'ancienne valeur est encore acceptée (pg_hba ?)"
fi
log "OK    $ROLE : valeur posée acceptée (TCP, SCRAM), autre valeur refusée"
log "INFO  le contrôle de refus a écrit 1 ligne « password authentication failed » attendue dans le journal PostgreSQL (sans aucune valeur)"
if [ "$MODE" = rollback ]; then
  echo "RESULTAT : retour arrière effectué ($ROLE). Remettez $VAR à son ancienne valeur dans $ENV_FILE, puis relancez : $NEXT"
else
  echo "RESULTAT : mot de passe de $ROLE changé. Relancez MAINTENANT les consommateurs : $NEXT"
fi
