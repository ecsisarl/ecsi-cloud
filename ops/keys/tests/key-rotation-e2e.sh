#!/bin/sh
# ECSI CLOUD — essai complet de la rotation de la clé de chiffrement sur Docker réel
# (Sprint S3H, étape H2 ; CI et local). Rejoue la procédure de docs/SECURITY.md :
#
#   1. sauvegarde H1 vérifiée (sous k2) ;
#   2. k3 active + k2 en ancienne clé sur l'API et le worker, redémarrage, santé ;
#   3. contrôle --verify : tout lisible, k2 non retirable ;
#   4. --dry-run : rien n'est écrit ;
#   5. rotation ; 6. --verify : tout sous k3, lisible avec k3 seule ; idempotence ;
#      retour arrière (k2 active, k3 ancienne) puis nouvelle rotation ;
#   7. observation : le worker déchiffre (aucune erreur « indéchiffrable ») ;
#   8. retrait de k2 de l'environnement, redémarrage, contrôle avec k3 seule ;
#   9. la sauvegarde d'avant la rotation exige k2 (refusée sans, conforme avec).
# Cas négatif : rotation lancée sans l'ancienne clé → échecs comptés, rien n'est écrit.
# Aucune valeur secrète dans les sorties (contrôlé à la fin).
#
#   ops/keys/tests/key-rotation-e2e.sh <dossier de travail vide>
# Nécessite : docker (Compose v2), age, openssl, l'image ecsi-cloud/api:dev (code S3H-H2).
set -eu

T=${1:?Usage : key-rotation-e2e.sh <dossier de travail vide>}
REPO=$(cd "$(dirname "$0")/../../.." && pwd)
mkdir -p "$T"
[ -z "$(ls -A "$T")" ] || { echo "$T n'est pas vide" >&2; exit 1; }
T=$(cd "$T" && pwd)
OUT=$T/sorties.log
: >"$OUT"
ENVF=$T/prod.env

step() { printf '\n=== %s\n' "$*" | tee -a "$OUT"; }
fail() { echo "ECHEC DE L'ESSAI : $*" >&2; exit 1; }
run() { "$@" >"$T/last.log" 2>&1; rc=$?; cat "$T/last.log" >>"$OUT"; cat "$T/last.log"; return $rc; }
expect_in() { grep -qF "$1" "$T/last.log" || fail "attendu dans la sortie : « $1 »"; }

# Remplace (ou ajoute) une variable du fichier d'environnement, sans jamais l'afficher.
set_env() {
  grep -v "^$1=" "$ENVF" >"$ENVF.tmp" || true
  printf '%s=%s\n' "$1" "$2" >>"$ENVF.tmp"
  mv "$ENVF.tmp" "$ENVF"
}

"$REPO/scripts/generate-prod-test-env.sh" "$ENVF" >/dev/null
K2=$(sed -n 's/^ENCRYPTION_KEY=//p' "$ENVF")
K3=$(openssl rand -base64 32)
set_env ENCRYPTION_KEY_ID k2
PROD="docker compose -p ecsi-cloud --env-file $ENVF -f $REPO/docker-compose.yml -f $REPO/docker-compose.prod.yml"
OPS="$PROD --profile ops run --rm --no-deps -T keys-rotate"
cleanup() {
  $PROD --profile ops down -v >/dev/null 2>&1 || true
  for p in ecsi-backupcheck ecsi-restoretest; do docker compose -p "$p" down -v >/dev/null 2>&1 || true; done
}
trap cleanup EXIT

psql_q() { $PROD exec -T postgres psql -U postgres -d ecsi -Atc "$1"; }
fingerprint() {
  psql_q "select md5(coalesce((select string_agg(coalesce(routeros_password_encrypted, '-'), ',' order by id) from routers), '') || '|' || coalesce((select string_agg(secret_enc, ',' order by id) from mfa_factors), ''))"
}
restart_app() {
  $PROD up -d --no-build --no-deps api worker >>"$OUT" 2>&1
  for _ in $(seq 1 60); do
    [ "$(docker inspect -f '{{.State.Health.Status}}' "$($PROD ps -q api)")" = healthy ] && return 0
    sleep 3
  done
  fail "l'API ne redevient pas saine"
}
# Attend un cycle complet du worker après redémarrage et vérifie qu'il a déchiffré chaque
# mot de passe (les routeurs de test sont injoignables : l'erreur est réseau, jamais
# « indéchiffrable »).
worker_cycle_ok() {
  marker=$(psql_q "select coalesce(sum(consecutive_failures), 0) from routers where deleted_at is null")
  for _ in $(seq 1 60); do
    now=$(psql_q "select coalesce(sum(consecutive_failures), 0) from routers where deleted_at is null")
    [ "$now" -ge "$((marker + 2))" ] && break
    sleep 3
  done
  [ "$now" -ge "$((marker + 2))" ] || fail 'aucun cycle du worker observé'
  bad=$(psql_q "select count(*) from routers where last_error like '%indéchiffrable%'")
  [ "$bad" = 0 ] || fail "$bad mot(s) de passe indéchiffrable(s) pour le worker"
  echo "--- worker : cycle observé, 0 mot de passe indéchiffrable" | tee -a "$OUT"
}

step 'Pile « production » de test, données chiffrées sous k2'
$PROD up -d --wait --no-build postgres redis s3 >>"$OUT" 2>&1
$PROD exec -T s3 sh -c "echo 's3.bucket.create -name ecsi-prod-test' | weed shell -master=localhost:9333" >/dev/null
$PROD run --rm -T --no-deps migrate >/dev/null
$PROD run --rm -T --no-deps -e NODE_ENV=development -e SEED_PASSWORD="essai-$(openssl rand -hex 8)" migrate node dist/database/seed.js >/dev/null
$PROD run --rm -T --no-deps migrate node --input-type=module - <"$REPO/ops/backup/tests/seed-secrets.mjs" | tee -a "$OUT"
restart_app

step '1. Sauvegarde H1 vérifiée, avant toute rotation'
age-keygen -o "$T/identite.txt" 2>/dev/null
age-keygen -y "$T/identite.txt" >"$T/destinataires.txt"
run env ECSI_BACKUP_CONF=/dev/null ECSI_ENV_FILE="$ENVF" BACKUP_DIR="$T/sauvegardes" \
  AGE_RECIPIENTS_FILE="$T/destinataires.txt" "$REPO/ops/backup/pg-backup.sh" || fail 'sauvegarde'
backup=$(ls "$T"/sauvegardes/ecsi-*.tar.age)
cp "$ENVF" "$T/env-avant-rotation"

step 'Contrôle initial (k2 seule)'
run $OPS --verify || fail 'contrôle initial'
expect_in '0 illisible(s)'

step "Négatif : rotation lancée avec k3 SANS l'ancienne clé k2"
set_env ENCRYPTION_KEY "$K3"
set_env ENCRYPTION_KEY_ID k3
before=$(fingerprint)
if run $OPS; then fail 'rotation sans ancienne clé acceptée'; fi
expect_in 'indisponible'
[ "$(fingerprint)" = "$before" ] || fail 'des secrets ont été écrits malgré les échecs'
echo '--- refus attendu confirmé : échecs comptés, rien écrit' | tee -a "$OUT"

step "2. k3 active + k2 ancienne sur l'API et le worker, redémarrage"
set_env ENCRYPTION_PREVIOUS_KEYS "k2:$K2"
restart_app
worker_cycle_ok

step '3. Contrôle : tout lisible, k2 encore nécessaire'
run $OPS --verify || fail 'contrôle étape 3'
expect_in 'NE PAS retirer'
expect_in '0 illisible(s)'

step '4. Simulation (--dry-run)'
before=$(fingerprint)
run $OPS --dry-run || fail 'simulation'
expect_in 'SIMULATION'
[ "$(fingerprint)" = "$before" ] || fail 'la simulation a écrit'

step '5. Rotation, puis 6. contrôle'
run $OPS || fail 'rotation'
expect_in 'aucune donnée ne dépend plus des anciennes clés'
expect_in '0 encore sous une ancienne clé, 0 illisible(s)'
after=$(fingerprint)
run $OPS || fail 'deuxième rotation'
expect_in '0 ré-enveloppés (contrôlés)'
[ "$(fingerprint)" = "$after" ] || fail 'la deuxième rotation a modifié des données'

step 'Retour arrière avant retrait : k2 active, k3 ancienne, puis nouvelle rotation vers k3'
set_env ENCRYPTION_KEY "$K2"
set_env ENCRYPTION_KEY_ID k2
set_env ENCRYPTION_PREVIOUS_KEYS "k3:$K3"
restart_app
run $OPS || fail 'retour arrière'
expect_in 'aucune donnée ne dépend plus des anciennes clés'
worker_cycle_ok
set_env ENCRYPTION_KEY "$K3"
set_env ENCRYPTION_KEY_ID k3
set_env ENCRYPTION_PREVIOUS_KEYS "k2:$K2"
restart_app
run $OPS || fail 'nouvelle rotation'
expect_in 'aucune donnée ne dépend plus des anciennes clés'

step '7. Observation : le worker déchiffre sous k3'
worker_cycle_ok

step "8. Retrait de k2 de l'environnement, redémarrage, contrôle avec k3 seule"
set_env ENCRYPTION_PREVIOUS_KEYS ''
restart_app
run $OPS --verify || fail 'contrôle sans k2'
expect_in 'clés fournies : k3)'
expect_in '0 encore sous une ancienne clé, 0 illisible(s)'
worker_cycle_ok

step '9. La sauvegarde antérieure exige k2 : refusée sans, conforme avec'
if run "$REPO/ops/backup/pg-restore-test.sh" --fichier "$backup" --identite "$T/identite.txt" --env "$ENVF"; then
  fail 'sauvegarde sous k2 restaurée sans k2'
fi
expect_in 'échec(s)'
cp "$ENVF" "$T/env-avec-k2"
grep -v '^ENCRYPTION_PREVIOUS_KEYS=' "$ENVF" >"$T/env-avec-k2"
printf 'ENCRYPTION_PREVIOUS_KEYS=k2:%s\n' "$K2" >>"$T/env-avec-k2"
run "$REPO/ops/backup/pg-restore-test.sh" --fichier "$backup" --identite "$T/identite.txt" \
  --env "$T/env-avec-k2" || fail 'restauration avec k2 (scellé)'
expect_in 'RESULTAT : base restaurée conforme'

step 'Aucune valeur secrète dans les sorties'
for value in "$K2" "$K3"; do
  if grep -qF "$value" "$OUT"; then fail 'une clé de chiffrement apparaît dans les sorties'; fi
done
while IFS='=' read -r key value; do
  case $key in
    *PASSWORD | *SECRET* | S3_ACCESS_KEY_ID)
      if [ -n "$value" ] && grep -qF "$value" "$OUT"; then fail "valeur de $key dans les sorties"; fi ;;
  esac
done <"$T/env-avant-rotation"
echo
echo 'ESSAI COMPLET RÉUSSI : rotation k2 → k3 contrôlée, retour arrière, retrait de k2.'
