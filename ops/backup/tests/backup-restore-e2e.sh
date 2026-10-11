#!/bin/sh
# ECSI CLOUD — essai complet de sauvegarde et de restauration sur Docker réel (CI et local).
#
#   ops/backup/tests/backup-restore-e2e.sh <dossier de travail vide>
#
# Monte une pile « production » de TEST (surcouche de production, secrets aléatoires, projet
# ecsi-cloud), y crée des données de test chiffrées, puis :
#   - sauvegarde (pg-backup.sh) avec une clé age générée pour l'essai ;
#   - restauration de test conforme (pg-restore-test.sh) ;
#   - cas négatifs : clé privée age côté serveur, fichier corrompu, mauvaise clé age,
#     mauvaise ENCRYPTION_KEY, projet de production, projet existant ;
#   - aucune valeur secrète dans les sorties ; données de la pile d'origine inchangées.
# Nécessite : docker (Compose v2), age, age-keygen, openssl, l'image ecsi-cloud/api:dev.
set -eu

T=${1:?Usage : backup-restore-e2e.sh <dossier de travail vide>}
REPO=$(cd "$(dirname "$0")/../../.." && pwd)
mkdir -p "$T"
[ -z "$(ls -A "$T")" ] || { echo "$T n'est pas vide" >&2; exit 1; }
T=$(cd "$T" && pwd)
OUT=$T/sorties.log
: >"$OUT"

step() { printf '\n=== %s\n' "$*"; }
fail() { echo "ECHEC DE L'ESSAI : $*" >&2; exit 1; }
# Exécute une commande en gardant sa sortie (stdout + stderr) pour le contrôle final.
run() { "$@" >"$T/last.log" 2>&1; rc=$?; cat "$T/last.log" >>"$OUT"; cat "$T/last.log"; return $rc; }
expect_fail() {
  label=$1; pattern=$2; shift 2
  if run "$@"; then fail "$label : accepté alors qu'un refus était attendu"; fi
  grep -q "$pattern" "$T/last.log" || fail "$label : message attendu « $pattern » absent"
  echo "--- refus attendu confirmé : $label"
}

"$REPO/scripts/generate-prod-test-env.sh" "$T/prod.env" >/dev/null
PROD="docker compose -p ecsi-cloud --env-file $T/prod.env -f $REPO/docker-compose.yml -f $REPO/docker-compose.prod.yml"
cleanup() {
  $PROD down -v >/dev/null 2>&1 || true
  for p in ecsi-backupcheck ecsi-restoretest; do
    docker compose -p "$p" down -v >/dev/null 2>&1 || true
  done
}
trap cleanup EXIT

step 'Pile « production » de test et données chiffrées'
$PROD up -d --wait --no-build postgres
$PROD run --rm -T --no-deps migrate >/dev/null
$PROD run --rm -T --no-deps -e SEED_PASSWORD="essai-$(openssl rand -hex 8)" -e NODE_ENV=development migrate node dist/database/seed.js >/dev/null
$PROD run --rm -T --no-deps migrate node --input-type=module - <"$REPO/ops/backup/tests/seed-secrets.mjs"
count_routers() { $PROD exec -T postgres psql -U postgres -d ecsi -Atc 'select count(*) from routers'; }
before=$(count_routers)

step "Clés age de l'essai (la clé privée reste hors du dossier de sauvegarde)"
age-keygen -o "$T/identite.txt" 2>/dev/null
age-keygen -y "$T/identite.txt" >"$T/destinataires.txt"
age-keygen -o "$T/autre-identite.txt" 2>/dev/null

export ECSI_ENV_FILE="$T/prod.env" BACKUP_DIR="$T/sauvegardes" ECSI_BACKUP_CONF=/dev/null

step 'Refus : clé privée age dans le fichier des destinataires'
expect_fail 'clé privée côté serveur' 'clé PRIVÉE' \
  env AGE_RECIPIENTS_FILE="$T/identite.txt" "$REPO/ops/backup/pg-backup.sh"

step 'Sauvegarde chiffrée et vérifiée'
run env AGE_RECIPIENTS_FILE="$T/destinataires.txt" "$REPO/ops/backup/pg-backup.sh" ||
  fail 'la sauvegarde a échoué'
archive=$(ls "$BACKUP_DIR"/ecsi-*.tar.age)
if [ ! -f "$archive.sha256" ] || [ ! -f "${archive%.tar.age}.info.json" ]; then
  fail 'empreinte ou fiche absente'
fi
grep -q '"verification": "OK"' "${archive%.tar.age}.info.json" || fail 'vérification non OK'
[ "$(stat -c %a "$archive")" = 600 ] || fail "droits de l'archive : $(stat -c %a "$archive")"
head -c 64 "$archive" | grep -q 'age-encryption.org' || fail "l'archive n'est pas au format age"
if grep -aq 'PGDMP' "$archive"; then fail 'dump en clair dans le fichier chiffré'; fi
if age -d -i "$T/autre-identite.txt" "$archive" >/dev/null 2>&1; then
  fail 'archive déchiffrée avec une autre clé'
fi
[ -z "$(find "$BACKUP_DIR" -name '.travail-*')" ] || fail 'dossier de travail non supprimé'

step 'Restauration de test conforme'
run "$REPO/ops/backup/pg-restore-test.sh" --fichier "$archive" --identite "$T/identite.txt" \
  --env "$T/prod.env" || fail 'la restauration de test a échoué'
grep -q 'RESULTAT : base restaurée conforme' "$T/last.log" || fail 'comparaison non conforme'
grep -q "mots de passe RouterOS : 2/2 déchiffrés, 0 échec" "$T/last.log" || fail 'routeurs non déchiffrés'
grep -q "secrets 2FA : 1/1 déchiffrés, 0 échec" "$T/last.log" || fail '2FA non déchiffré'
grep -q 'aucune rejouée' "$T/last.log" || fail 'migrations rejouées'
grep -q '/api/v1/health ok' "$T/last.log" || fail 'API non saine'
[ -z "$(docker ps -aq --filter label=com.docker.compose.project=ecsi-restoretest)" ] ||
  fail 'pile jetable non supprimée'

step 'Refus : fichier corrompu'
cp "$archive" "$T/corrompu.tar.age"
cp "$archive.sha256" "$T/corrompu.tar.age.sha256"
printf 'X' | dd of="$T/corrompu.tar.age" bs=1 seek=200 conv=notrunc 2>/dev/null
expect_fail 'fichier corrompu' 'empreinte SHA-256 différente' \
  "$REPO/ops/backup/pg-restore-test.sh" --fichier "$T/corrompu.tar.age" --identite "$T/identite.txt" --env "$T/prod.env"

step 'Refus : mauvaise clé age'
expect_fail 'mauvaise clé age' 'déchiffrement age impossible' \
  "$REPO/ops/backup/pg-restore-test.sh" --fichier "$archive" --identite "$T/autre-identite.txt" --env "$T/prod.env"

step 'Échec compté : mauvaise ENCRYPTION_KEY'
grep -v '^ENCRYPTION_KEY=' "$T/prod.env" >"$T/mauvaise-cle.env"
echo "ENCRYPTION_KEY=$(openssl rand -base64 32)" >>"$T/mauvaise-cle.env"
expect_fail 'mauvaise clé de chiffrement' 'RouterOS : 0/2 déchiffrés, 2 échec' \
  "$REPO/ops/backup/pg-restore-test.sh" --fichier "$archive" --identite "$T/identite.txt" --env "$T/mauvaise-cle.env"
[ -z "$(docker ps -aq --filter label=com.docker.compose.project=ecsi-restoretest)" ] ||
  fail 'pile jetable non supprimée après échec'

step 'Refus : cible de production ou projet existant'
expect_fail 'projet de production' 'refusé' \
  "$REPO/ops/backup/pg-restore-test.sh" --fichier "$archive" --identite "$T/identite.txt" --env "$T/prod.env" --projet ecsi-cloud
expect_fail 'projet de production (reprise)' 'refusé' \
  "$REPO/ops/backup/pg-restore-test.sh" --fichier "$archive" --identite "$T/identite.txt" --env "$T/prod.env" --reprise --projet ecsi-cloud
docker volume create --label com.docker.compose.project=ecsi-restoretest ecsi-restoretest_reste >/dev/null
expect_fail 'projet existant' 'déjà des conteneurs ou des volumes' \
  "$REPO/ops/backup/pg-restore-test.sh" --fichier "$archive" --identite "$T/identite.txt" --env "$T/prod.env"
docker volume rm ecsi-restoretest_reste >/dev/null

step "Pile d'origine intacte, aucune valeur secrète dans les sorties"
[ "$(count_routers)" = "$before" ] || fail "données de la pile d'origine modifiées"
[ "$(docker inspect -f '{{.State.Health.Status}}' "$($PROD ps -q postgres)")" = healthy ] ||
  fail "PostgreSQL de la pile d'origine non sain"
while IFS='=' read -r key value; do
  case $key in
    *PASSWORD | *SECRET* | ENCRYPTION_KEY | S3_ACCESS_KEY_ID)
      if grep -qF "$value" "$OUT"; then fail "valeur de $key présente dans les sorties"; fi ;;
  esac
done <"$T/prod.env"
if grep -q 'AGE-SECRET-KEY' "$OUT"; then fail 'clé privée age dans les sorties'; fi
echo
echo 'ESSAI COMPLET RÉUSSI : sauvegarde, restauration de test et cas négatifs.'
