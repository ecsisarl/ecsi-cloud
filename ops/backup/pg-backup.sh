#!/bin/sh
# ECSI CLOUD — sauvegarde PostgreSQL chiffrée et vérifiée (Sprint S3H, étape H1).
#
#   sudo ops/backup/pg-backup.sh            (ou via le timer systemd ecsi-backup.timer)
#
# LECTURE SEULE sur la production : pg_dump et pg_dumpall --globals-only dans le conteneur
# PostgreSQL de la pile (projet Compose ECSI_PROJECT). Puis, à chaque sauvegarde :
#   1. restauration du dump dans une pile JETABLE isolée (projet ecsi-backupcheck, réseau
#      interne, aucun port publié) et contrôles complets : rôles, RLS, migrations, chaîne
#      d'audit, déchiffrement de chaque mot de passe RouterOS et secret 2FA ;
#   2. manifeste écrit depuis la copie restaurée (nombre de lignes par table, droits, etc.) ;
#   3. archive tar (dump, rôles, manifeste, métadonnées) chiffrée avec age pour la clé
#      PUBLIQUE de AGE_RECIPIENTS_FILE : la clé privée n'est jamais sur le serveur ;
#   4. empreinte SHA-256 et fiche .info.json (sans donnée) ; rétention appliquée seulement
#      si la vérification a réussi.
# Code de sortie non nul si une étape échoue : le timer systemd le signale.
#
# Configuration (variables d'environnement, ou /etc/ecsi/backup.conf chargé s'il existe) :
#   ECSI_PROJECT         projet Compose de production         (défaut : ecsi-cloud)
#   ECSI_REPO_DIR        dépôt ECSI CLOUD                      (défaut : ce dépôt)
#   ECSI_ENV_FILE        .env de production : seules les lignes ENCRYPTION_* et POSTGRES_DB
#                        sont lues, jamais affichées           (défaut : $ECSI_REPO_DIR/.env)
#   ECSI_API_IMAGE       image applicative existante           (défaut : ecsi-cloud/api:dev)
#   BACKUP_DIR           destination                           (défaut : /var/backups/ecsi)
#   AGE_RECIPIENTS_FILE  clé(s) publique(s) age                (défaut : /etc/ecsi/backup-recipients.txt)
set -eu

CONF=${ECSI_BACKUP_CONF:-/etc/ecsi/backup.conf}
# shellcheck disable=SC1090
[ -r "$CONF" ] && . "$CONF"

ECSI_REPO_DIR=${ECSI_REPO_DIR:-$(cd "$(dirname "$0")/../.." && pwd)}
. "$ECSI_REPO_DIR/ops/backup/lib.sh"

ECSI_ENV_FILE=${ECSI_ENV_FILE:-$ECSI_REPO_DIR/.env}
BACKUP_DIR=${BACKUP_DIR:-/var/backups/ecsi}
AGE_RECIPIENTS_FILE=${AGE_RECIPIENTS_FILE:-/etc/ecsi/backup-recipients.txt}

need docker age tar sha256sum openssl
[ -s "$AGE_RECIPIENTS_FILE" ] || die "fichier de destinataires age absent ou vide : $AGE_RECIPIENTS_FILE"
if grep -q 'AGE-SECRET-KEY' "$AGE_RECIPIENTS_FILE"; then
  die "$AGE_RECIPIENTS_FILE contient une clé PRIVÉE age : seule la clé publique (age1…) doit être sur le serveur"
fi
grep -q '^age1' "$AGE_RECIPIENTS_FILE" || die "$AGE_RECIPIENTS_FILE ne contient aucune clé publique age (age1…)"
[ -r "$ECSI_ENV_FILE" ] || die "fichier d'environnement illisible : $ECSI_ENV_FILE"

container=$(docker ps -q --filter "label=com.docker.compose.project=$ECSI_PROJECT" \
  --filter "label=com.docker.compose.service=postgres")
[ -n "$container" ] || die "aucun conteneur PostgreSQL en marche pour le projet $ECSI_PROJECT"
[ "$(printf '%s\n' "$container" | wc -l)" -eq 1 ] || die "plusieurs conteneurs PostgreSQL pour $ECSI_PROJECT"
check_api_image

mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"
WORK=$(mktemp -d "$BACKUP_DIR/.travail-XXXXXX")
TW_PROJECT=ecsi-backupcheck
TW_ENV=$WORK/jetable.env
TW_LOG=$WORK/compose.log
TW_EXTRA="-f $ECSI_REPO_DIR/ops/backup/compose.isolated.yml"
cleanup() {
  throwaway_down
  rm -rf "$WORK"
}
trap cleanup EXIT
trap 'exit 1' INT TERM
check_throwaway_project "$TW_PROJECT" 'ecsi-backupcheck'

TS=$(date -u +%Y%m%dT%H%M%SZ)
NAME=ecsi-$TS
db=$(docker exec "$container" printenv POSTGRES_DB)

log "INFO  sauvegarde de la base $db (projet $ECSI_PROJECT, conteneur $(printf %.12s "$container"))"
docker exec "$container" pg_dump -U postgres -d "$db" -Fc >"$WORK/ecsi.pgc" ||
  die "pg_dump a échoué"
docker exec "$container" pg_dumpall -U postgres --globals-only --no-role-passwords \
  >"$WORK/globals.sql" || die "pg_dumpall --globals-only a échoué"
pg_version=$(docker exec "$container" psql -U postgres -d "$db" -Atc 'show server_version')
dump_sha=$(sha256_of "$WORK/ecsi.pgc")
log "OK    dump PostgreSQL $pg_version : $(wc -c <"$WORK/ecsi.pgc") octets, sha256 $dump_sha"

# Vérification : restauration réelle dans la pile jetable, puis manifeste.
make_throwaway_env "$TW_ENV" "$ECSI_ENV_FILE"
verification=ECHEC
throwaway_restore "$WORK/ecsi.pgc"
if throwaway_verify --manifest >"$WORK/manifest.json"; then
  verification=OK
else
  rm -f "$WORK/manifest.json"
  log 'ECHEC la copie restaurée ne passe pas les contrôles : sauvegarde conservée mais NON vérifiée'
fi
throwaway_down

commit=$(git -C "$ECSI_REPO_DIR" rev-parse --short HEAD 2>/dev/null || echo inconnu)
cat >"$WORK/metadata.json" <<JSON
{
  "format": "ecsi-backup/1",
  "created_at": "$TS",
  "project": "$ECSI_PROJECT",
  "database": "$db",
  "postgres_version": "$pg_version",
  "repo_commit": "$commit",
  "api_image": "$ECSI_API_IMAGE",
  "encryption_key_id": "$(key_id_of "$ECSI_ENV_FILE")",
  "dump_sha256": "$dump_sha",
  "verification": "$verification"
}
JSON

files="ecsi.pgc globals.sql metadata.json"
[ -f "$WORK/manifest.json" ] && files="$files manifest.json"
# shellcheck disable=SC2086
tar -C "$WORK" -cf - $files | age -R "$AGE_RECIPIENTS_FILE" -o "$WORK/$NAME.tar.age"
(cd "$WORK" && sha256sum "$NAME.tar.age" >"$NAME.tar.age.sha256")
cp "$WORK/metadata.json" "$WORK/$NAME.info.json"
mv "$WORK/$NAME.tar.age" "$WORK/$NAME.tar.age.sha256" "$WORK/$NAME.info.json" "$BACKUP_DIR/"
log "OK    $BACKUP_DIR/$NAME.tar.age ($(wc -c <"$BACKUP_DIR/$NAME.tar.age") octets, chiffré age)"

if [ "$verification" != OK ]; then
  die "sauvegarde $NAME produite mais NON vérifiée : rétention non appliquée"
fi
"$ECSI_REPO_DIR/ops/backup/retention.sh" "$BACKUP_DIR"
log "OK    sauvegarde $NAME vérifiée (restauration jetable conforme)"
