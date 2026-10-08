#!/bin/sh
# ECSI CLOUD — essai complet de la rotation k3 → k4 à TROIS clés sur Docker réel (Sprint S3H,
# étape H3, outillage D.2 ; CI et local). Reproduit l'état de production après H2 et rejoue
# la procédure H3.4 / H3.5 de docs/SECURITY.md :
#
#   0. données sous k2, dont 10 codes de récupération 2FA, puis rotation H2 vers k3 :
#      k3 active, k2 encore nécessaire (codes) ; sauvegarde H1 vérifiée (ère k3) ;
#   1. k4 active, k3 et k2 anciennes : contrôle AVANT redémarrage (0 illisible, k3 nécessaire) ;
#   2. redémarrage, le worker déchiffre ; simulation sans écriture ;
#   3. rotation : k4 active, k3 retirable, k2 encore nécessaire, 0 illisible ;
#      verdicts --retirable (codes de sortie 0 / 3) ; idempotence ;
#   4. retour arrière k4 → k3 (k4 retirable, k2 nécessaire), puis nouvelle rotation vers k4 ;
#   5. retrait de k3 de l'environnement (k2 conservée) : 0 illisible, worker sain ;
#   6. la sauvegarde de l'ère k3 exige k3 (refusée sans, conforme avec) : séquestre obligatoire.
# Aucune valeur secrète dans les sorties (contrôlé à la fin).
#
#   ops/keys/tests/key-rotation-three-keys-e2e.sh <dossier de travail vide>
# Nécessite : docker (Compose v2), age, openssl, l'image ecsi-cloud/api:dev (code S3H-H3).
# $OPS et $PROD sont des commandes à découper en mots (comme dans key-rotation-e2e.sh).
# shellcheck disable=SC2086
set -eu

T=${1:?Usage : key-rotation-three-keys-e2e.sh <dossier de travail vide>}
REPO=$(cd "$(dirname "$0")/../../.." && pwd)
mkdir -p "$T"
[ -z "$(ls -A "$T")" ] || { echo "$T n'est pas vide" >&2; exit 1; }
T=$(cd "$T" && pwd)
OUT=$T/sorties.log
: >"$OUT"
ENVF=$T/prod.env

step() { printf '\n=== %s\n' "$*" | tee -a "$OUT"; }
fail() { echo "ECHEC DE L'ESSAI : $*" >&2; exit 1; }
# Exécute une commande, journalise sa sortie et renvoie son code de sortie dans $rc.
run() {
  rc=0
  "$@" >"$T/last.log" 2>&1 || rc=$?
  cat "$T/last.log" >>"$OUT"
  cat "$T/last.log"
}
ok() { run "$@"; [ "$rc" = 0 ] || fail "code de sortie $rc : $*"; }
expect_rc() { want=$1; shift; run "$@"; [ "$rc" = "$want" ] || fail "code $rc au lieu de $want : $*"; }
expect_in() { grep -qF -- "$1" "$T/last.log" || fail "attendu dans la sortie : « $1 »"; }

set_env() {
  grep -v "^$1=" "$ENVF" >"$ENVF.tmp" || true
  printf '%s=%s\n' "$1" "$2" >>"$ENVF.tmp"
  mv "$ENVF.tmp" "$ENVF"
}

"$REPO/scripts/generate-prod-test-env.sh" "$ENVF" >/dev/null
K2=$(sed -n 's/^ENCRYPTION_KEY=//p' "$ENVF")
K3=$(openssl rand -base64 32)
K4=$(openssl rand -base64 32)
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
  psql_q "select md5(coalesce((select string_agg(coalesce(routeros_password_encrypted, '-'), ',' order by id) from routers), '') || '|' || coalesce((select string_agg(secret_enc, ',' order by id) from mfa_factors), '') || '|' || coalesce((select string_agg(code_hash, ',' order by id) from mfa_recovery_codes), ''))"
}
restart_app() {
  $PROD up -d --no-build --no-deps api worker >>"$OUT" 2>&1
  for _ in $(seq 1 60); do
    [ "$(docker inspect -f '{{.State.Health.Status}}' "$($PROD ps -q api)")" = healthy ] && return 0
    sleep 3
  done
  fail "l'API ne redevient pas saine"
}
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
use_keys() { # use_keys <id active> <clé active> <anciennes clés id:base64,…>
  set_env ENCRYPTION_KEY_ID "$1"
  set_env ENCRYPTION_KEY "$2"
  set_env ENCRYPTION_PREVIOUS_KEYS "$3"
}

step '0. Données sous k2 (dont 10 codes de récupération), puis rotation H2 vers k3'
$PROD up -d --wait --no-build postgres redis s3 >>"$OUT" 2>&1
$PROD exec -T s3 sh -c "echo 's3.bucket.create -name ecsi-prod-test' | weed shell -master=localhost:9333" >/dev/null
$PROD run --rm -T --no-deps migrate >/dev/null
$PROD run --rm -T --no-deps -e NODE_ENV=development -e SEED_PASSWORD="essai-$(openssl rand -hex 8)" migrate node dist/database/seed.js >/dev/null
$PROD run --rm -T --no-deps migrate node --input-type=module - <"$REPO/ops/backup/tests/seed-secrets.mjs" | tee -a "$OUT"
$PROD run --rm -T --no-deps migrate node --input-type=module - <"$REPO/ops/keys/tests/seed-recovery-codes.mjs" | tee -a "$OUT"
use_keys k3 "$K3" "k2:$K2"
restart_app
ok $OPS
expect_rc 3 $OPS --verify --retirable k2
expect_in 'INFO  clé k3 : active'
expect_in 'clé k2 : ENCORE NÉCESSAIRE (0 mot(s) de passe RouterOS, 0 secret(s) 2FA, 10 code(s) de récupération) : NE PAS retirer'
expect_in '0 illisible(s)'
worker_cycle_ok

step "Sauvegarde H1 vérifiée de l'ère k3"
age-keygen -o "$T/identite.txt" 2>/dev/null
age-keygen -y "$T/identite.txt" >"$T/destinataires.txt"
ok env ECSI_BACKUP_CONF=/dev/null ECSI_ENV_FILE="$ENVF" BACKUP_DIR="$T/sauvegardes" \
  AGE_RECIPIENTS_FILE="$T/destinataires.txt" "$REPO/ops/backup/pg-backup.sh"
backup=$(ls "$T"/sauvegardes/ecsi-*.tar.age)
cp "$ENVF" "$T/env-ere-k3"

step '1. k4 active, k3 et k2 anciennes : contrôle AVANT tout redémarrage'
use_keys k4 "$K4" "k3:$K3,k2:$K2"
expect_rc 3 $OPS --verify --retirable k3
expect_in 'INFO  clé k4 : active (0 mot(s) de passe RouterOS, 0 secret(s) 2FA, 0 code(s) de récupération)'
expect_in 'clé k3 : ENCORE NÉCESSAIRE (2 mot(s) de passe RouterOS, 1 secret(s) 2FA, 0 code(s) de récupération) : NE PAS retirer'
expect_in '0 illisible(s)'

step '2. Redémarrage (k4 + k3 + k2), simulation'
restart_app
worker_cycle_ok
before=$(fingerprint)
ok $OPS --dry-run
expect_in 'SIMULATION'
expect_in '0 en échec'
[ "$(fingerprint)" = "$before" ] || fail 'la simulation a écrit'

step '3. Rotation k3 → k4 : k4 active, k3 retirable, k2 encore nécessaire'
ok $OPS
expect_in 'INFO  clé k4 : active (2 mot(s) de passe RouterOS, 1 secret(s) 2FA, 0 code(s) de récupération)'
expect_in 'OK    clé k3 : retirable'
expect_in 'clé k2 : ENCORE NÉCESSAIRE (0 mot(s) de passe RouterOS, 0 secret(s) 2FA, 10 code(s) de récupération) : NE PAS retirer'
expect_in '0 encore sous une ancienne clé, 0 illisible(s)'
expect_rc 0 $OPS --verify --retirable k3
expect_rc 3 $OPS --verify --retirable k2
expect_rc 3 $OPS --verify --retirable k4
after=$(fingerprint)
ok $OPS
expect_in '0 ré-enveloppés (contrôlés)'
[ "$(fingerprint)" = "$after" ] || fail 'la deuxième rotation a modifié des données'
echo '--- idempotence confirmée' | tee -a "$OUT"
worker_cycle_ok

step '4. Retour arrière k4 → k3, puis nouvelle rotation vers k4'
use_keys k3 "$K3" "k4:$K4,k2:$K2"
restart_app
ok $OPS
expect_in 'OK    clé k4 : retirable'
expect_in '10 code(s) de récupération) : NE PAS retirer'
expect_in '0 encore sous une ancienne clé, 0 illisible(s)'
worker_cycle_ok
use_keys k4 "$K4" "k3:$K3,k2:$K2"
restart_app
ok $OPS
expect_in 'OK    clé k3 : retirable'

step "5. Retrait de k3 de l'environnement (k2 conservée)"
use_keys k4 "$K4" "k2:$K2"
expect_rc 0 $OPS --verify --retirable k3
expect_in '0 encore sous une ancienne clé, 0 illisible(s)'
expect_in '(clés fournies : k4, k2)'
restart_app
worker_cycle_ok
expect_rc 3 $OPS --verify --retirable k2

step "6. La sauvegarde de l'ère k3 exige k3 : refusée sans, conforme avec (séquestre)"
run "$REPO/ops/backup/pg-restore-test.sh" --fichier "$backup" --identite "$T/identite.txt" --env "$ENVF"
[ "$rc" != 0 ] || fail "sauvegarde de l'ère k3 restaurée sans k3"
expect_in 'échec(s)'
ok "$REPO/ops/backup/pg-restore-test.sh" --fichier "$backup" --identite "$T/identite.txt" --env "$T/env-ere-k3"
expect_in 'RESULTAT : base restaurée conforme'

step 'Aucune valeur secrète dans les sorties'
for value in "$K2" "$K3" "$K4"; do
  if grep -qF "$value" "$OUT"; then fail 'une clé de chiffrement apparaît dans les sorties'; fi
done
while IFS='=' read -r key value; do
  case $key in
    *PASSWORD | *SECRET* | S3_ACCESS_KEY_ID)
      if [ -n "$value" ] && grep -qF "$value" "$OUT"; then fail "valeur de $key dans les sorties"; fi ;;
  esac
done <"$T/env-ere-k3"
echo
echo 'ESSAI COMPLET RÉUSSI : k4 active, k3 retirable puis retirée, k2 conservée, retour arrière, idempotence.'
