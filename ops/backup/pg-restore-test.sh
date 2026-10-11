#!/bin/sh
# ECSI CLOUD — restauration de TEST d'une sauvegarde (Sprint S3H, étape H1).
#
#   ops/backup/pg-restore-test.sh --fichier <ecsi-….tar.age> --identite <clé privée age> \
#       [--env <.env de production>] [--projet ecsi-restoretest] [--reprise]
#
# Restaure TOUJOURS dans une pile jetable séparée (projet Compose dédié, volumes et réseau
# propres), jamais dans la base de production :
#   1. contrôle de l'empreinte SHA-256 du fichier, puis déchiffrement age ;
#   2. contrôle de l'empreinte du dump contre les métadonnées ;
#   3. restauration dans un PostgreSQL 18 jetable (réseau interne, aucun port publié) ;
#   4. comparaison avec le manifeste : lignes par table, RLS et politiques, rôles et droits,
#      migrations (aucune à rejouer), chaîne d'audit, déchiffrement de CHAQUE mot de passe
#      RouterOS et secret 2FA avec les clés du .env (compteurs seulement) ;
#   5. démarrage de l'API contre la base restaurée et /api/v1/health OK ;
#   6. suppression de la pile jetable (docker compose -p <projet> down -v : ce projet seul).
#
# --reprise (exercice de reprise, projet ecsi-reprise…) : réseau non isolé, le worker est
# démarré et la pile est CONSERVÉE pour vérifier que les routeurs repassent ONLINE depuis la
# base restaurée (docs/SAUVEGARDE.md). Suppression ensuite par la commande affichée.
#
# La clé privée age n'est lue que par age ; elle ne doit pas rester sur le serveur.
set -eu

ECSI_REPO_DIR=${ECSI_REPO_DIR:-$(cd "$(dirname "$0")/../.." && pwd)}
. "$ECSI_REPO_DIR/ops/backup/lib.sh"

usage() {
  echo 'Usage : pg-restore-test.sh --fichier <sauvegarde.tar.age> --identite <clé age> [--env <.env>] [--projet <nom>] [--reprise]' >&2
  exit 2
}

file='' identity='' env_file="$ECSI_REPO_DIR/.env" project='' reprise=0
while [ $# -gt 0 ]; do
  case $1 in
    --fichier) file=${2:-}; shift 2 ;;
    --identite) identity=${2:-}; shift 2 ;;
    --env) env_file=${2:-}; shift 2 ;;
    --projet) project=${2:-}; shift 2 ;;
    --reprise) reprise=1; shift ;;
    *) usage ;;
  esac
done
if [ -z "$file" ] || [ -z "$identity" ]; then usage; fi

need docker age tar sha256sum openssl
if [ "$reprise" = 1 ]; then
  project=${project:-ecsi-reprise}
  check_throwaway_project "$project" 'ecsi-reprise(-[a-z0-9]+)?'
  TW_EXTRA=''
else
  project=${project:-ecsi-restoretest}
  check_throwaway_project "$project" 'ecsi-restoretest(-[a-z0-9]+)?'
  TW_EXTRA="-f $ECSI_REPO_DIR/ops/backup/compose.isolated.yml"
fi
[ -r "$file" ] || die "sauvegarde illisible : $file"
[ -r "$identity" ] || die "clé age illisible : $identity"
check_api_image

WORK=$(mktemp -d "${TMPDIR:-/tmp}/ecsi-restauration-XXXXXX")
TW_PROJECT=$project
TW_ENV=$WORK/jetable.env
TW_LOG=$WORK/compose.log
keep_stack=0
cleanup() {
  [ "$keep_stack" = 1 ] || throwaway_down
  rm -rf "$WORK"
}
trap cleanup EXIT
trap 'exit 1' INT TERM

# 1. Empreinte du fichier chiffré, puis déchiffrement.
[ -r "$file.sha256" ] || die "empreinte absente : $file.sha256"
expected=$(cut -d' ' -f1 "$file.sha256")
[ "$(sha256_of "$file")" = "$expected" ] ||
  die "empreinte SHA-256 différente : fichier corrompu ou modifié, restauration refusée"
log 'OK    empreinte SHA-256 du fichier chiffré'
age -d -i "$identity" -o "$WORK/archive.tar" "$file" 2>"$WORK/age.err" ||
  die "déchiffrement age impossible (clé age incorrecte ?), restauration refusée"
log 'OK    déchiffrement age'
mkdir "$WORK/archive"
tar -C "$WORK/archive" -xf "$WORK/archive.tar" ecsi.pgc globals.sql metadata.json 2>"$WORK/tar.err" ||
  die "archive incomplète (ecsi.pgc, globals.sql, metadata.json attendus)"
tar -C "$WORK/archive" -xf "$WORK/archive.tar" manifest.json 2>/dev/null ||
  die "manifeste absent : la sauvegarde n'avait pas été vérifiée à sa création (metadata.json, champ verification)"
rm -f "$WORK/archive.tar"

# 2. Empreinte du dump et clé de chiffrement attendue.
meta=$WORK/archive/metadata.json
field() { sed -n "s/^ *\"$1\": \"\(.*\)\",\{0,1\}$/\1/p" "$meta"; }
[ "$(sha256_of "$WORK/archive/ecsi.pgc")" = "$(field dump_sha256)" ] ||
  die "empreinte du dump différente des métadonnées, restauration refusée"
log "OK    dump du $(field created_at), PostgreSQL $(field postgres_version), commit $(field repo_commit)"
backup_key=$(field encryption_key_id)
current_key=$(key_id_of "$env_file")
if [ "$backup_key" != "$current_key" ]; then
  log "INFO  sauvegarde sous la clé $backup_key, clé active du .env : $current_key (ENCRYPTION_PREVIOUS_KEYS doit la contenir)"
fi

# 3 et 4. Restauration jetable et comparaison avec le manifeste.
make_throwaway_env "$TW_ENV" "$env_file"
throwaway_restore "$WORK/archive/ecsi.pgc"
throwaway_verify --compare <"$WORK/archive/manifest.json" ||
  die "la base restaurée n'est pas conforme au manifeste (lignes ECHEC ci-dessus)"

# 5. API contre la base restaurée.
throwaway_compose up -d --wait --no-build redis s3 >>"$TW_LOG" 2>&1 ||
  die "démarrage de Redis et S3 jetables impossible (journal : $TW_LOG)"
bucket=$(sed -n 's/^S3_BUCKET=//p' "$TW_ENV")
throwaway_compose exec -T s3 sh -c "echo 's3.bucket.create -name $bucket' | weed shell -master=localhost:9333" \
  >>"$TW_LOG" 2>&1 || die "création du bucket de test impossible"
throwaway_compose up -d --wait --no-build api >>"$TW_LOG" 2>&1 ||
  die "l'API ne démarre pas sur la base restaurée (journal : $TW_LOG)"
throwaway_compose exec -T api wget -qO- http://127.0.0.1:4000/api/v1/health >"$WORK/health.json" ||
  die "/api/v1/health ne répond pas"
grep -q '"status":"ok"' "$WORK/health.json" || die "/api/v1/health n'est pas « ok »"
log 'OK    API démarrée sur la base restaurée : /api/v1/health ok (base, Redis, stockage)'

if [ "$reprise" = 1 ]; then
  throwaway_compose --profile reprise up -d --no-build worker >>"$TW_LOG" 2>&1 ||
    die "le worker ne démarre pas sur la base restaurée"
  keep_stack=1
  cp "$TW_ENV" "${TMPDIR:-/tmp}/$project.env"
  log "OK    exercice de reprise : pile $project conservée, worker démarré"
  log "      fichier d'environnement de la pile : ${TMPDIR:-/tmp}/$project.env (à supprimer à la fin)"
  log "      suivi : voir docs/SAUVEGARDE.md, section « Exercice de reprise »"
  exit 0
fi

# 6. Suppression de la pile jetable (ce projet seul).
throwaway_down
log "OK    restauration de test réussie ; pile jetable $project supprimée"
