# shellcheck shell=sh
# ECSI CLOUD — fonctions communes de sauvegarde et de restauration (Sprint S3H, étape H1).
# Chargé par pg-backup.sh et pg-restore-test.sh ; n'affiche jamais une valeur secrète.

set -eu
umask 077

ECSI_PROJECT=${ECSI_PROJECT:-ecsi-cloud}
ECSI_API_IMAGE=${ECSI_API_IMAGE:-ecsi-cloud/api:dev}
export ECSI_API_IMAGE

log() { printf '%s %s\n' "$(date -u +%H:%M:%SZ)" "$*" >&2; }
die() {
  log "ECHEC $*"
  exit 1
}

need() {
  for cmd in "$@"; do
    command -v "$cmd" >/dev/null 2>&1 || die "commande introuvable : $cmd"
  done
}

# Nom de projet d'une pile jetable : motif réservé, jamais celui de la production, et aucun
# conteneur ni volume existant (on ne réutilise ni n'écrase jamais rien).
check_throwaway_project() {
  project=$1
  pattern=$2
  printf '%s' "$project" | grep -Eq "^($pattern)$" ||
    die "projet « $project » refusé : seuls les noms de forme $pattern sont acceptés"
  [ "$project" != "$ECSI_PROJECT" ] || die "projet « $project » refusé : c'est la production"
  if [ -n "$(docker ps -aq --filter "label=com.docker.compose.project=$project")" ] ||
    [ -n "$(docker volume ls -q --filter "label=com.docker.compose.project=$project")" ]; then
    die "le projet « $project » a déjà des conteneurs ou des volumes : rien n'est écrasé (docker compose -p $project down -v pour le supprimer s'il s'agit d'un reste de test)"
  fi
}

# Recopie, depuis le .env de production, les seules lignes nécessaires (clés de chiffrement,
# nom de la base) ; tout le reste de l'environnement jetable est aléatoire.
make_throwaway_env() {
  out=$1
  real_env=$2
  [ -r "$real_env" ] || die "fichier d'environnement illisible : $real_env"
  grep -q '^ENCRYPTION_KEY=.' "$real_env" || die "ENCRYPTION_KEY absente de $real_env"
  "$ECSI_REPO_DIR/scripts/generate-prod-test-env.sh" "$out.gen" >/dev/null
  grep -v '^ENCRYPTION_' "$out.gen" >"$out"
  rm -f "$out.gen"
  grep -E '^(ENCRYPTION_KEY|ENCRYPTION_KEY_ID|ENCRYPTION_PREVIOUS_KEYS|POSTGRES_DB)=' "$real_env" >>"$out"
  if ! grep -q '^ENCRYPTION_KEY_ID=.' "$real_env"; then
    echo 'ENCRYPTION_KEY_ID=k1' >>"$out"
    log 'INFO  ENCRYPTION_KEY_ID absent du .env : k1 (valeur par défaut de la pile actuelle)'
  fi
}

# Identifiant de la clé active (jamais la clé) : k1 par défaut.
key_id_of() {
  id=$(sed -n 's/^ENCRYPTION_KEY_ID=//p' "$1" | tail -n 1 | tr -d "\"' ")
  printf '%s' "${id:-k1}"
}

throwaway_compose() {
  # shellcheck disable=SC2086
  docker compose -p "$TW_PROJECT" --env-file "$TW_ENV" \
    -f "$ECSI_REPO_DIR/docker-compose.yml" \
    -f "$ECSI_REPO_DIR/docker-compose.prod.yml" \
    -f "$ECSI_REPO_DIR/ops/backup/compose.restore.yml" $TW_EXTRA "$@"
}

throwaway_down() {
  if [ -n "${TW_PROJECT:-}" ] && [ -n "${TW_ENV:-}" ] && [ -f "$TW_ENV" ]; then
    throwaway_compose --profile reprise down -v --remove-orphans >/dev/null 2>&1 || true
  fi
}

# Image applicative présente localement et contenant la commande de vérification.
check_api_image() {
  docker image inspect "$ECSI_API_IMAGE" >/dev/null 2>&1 ||
    die "image $ECSI_API_IMAGE absente : construisez-la (docs/SAUVEGARDE.md) ; elle n'est jamais construite ni téléchargée par ce script"
  docker run --rm --network none --entrypoint test "$ECSI_API_IMAGE" -f dist/cli/verify-restore.js ||
    die "l'image $ECSI_API_IMAGE ne contient pas dist/cli/verify-restore.js (version antérieure à S3H-H1)"
}

# Démarre PostgreSQL dans la pile jetable et y restaure le dump (format personnalisé, stdin).
throwaway_restore() {
  dump=$1
  throwaway_compose up -d --wait --no-build postgres >"$TW_LOG" 2>&1 ||
    die "démarrage du PostgreSQL jetable impossible (journal : $TW_LOG)"
  db=$(throwaway_compose exec -T postgres printenv POSTGRES_DB)
  throwaway_compose exec -T postgres pg_restore --exit-on-error -U postgres -d "$db" <"$dump" \
    >>"$TW_LOG" 2>&1 || die "pg_restore a échoué (journal : $TW_LOG)"
  log "OK    dump restauré dans la base jetable (projet $TW_PROJECT)"
}

# Lance la commande de vérification dans l'image applicative, sur la pile jetable.
throwaway_verify() {
  throwaway_compose run --rm --no-deps -T migrate node dist/cli/verify-restore.js "$@"
}

sha256_of() { sha256sum "$1" | cut -d' ' -f1; }
