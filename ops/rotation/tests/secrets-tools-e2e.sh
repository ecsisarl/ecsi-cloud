#!/bin/sh
# ECSI CLOUD — essai Docker réel de l'outillage de rotation des secrets (Sprint S3H, étape H3,
# D.4 et D.5 ; CI et local). Pile « production » de TEST (secrets aléatoires), PostgreSQL
# configuré pour journaliser TOUTES les requêtes, connexions et erreurs (compose.pglog.yml), et
# un échantillonneur qui relève `ps -eo args` en continu pendant tout l'essai.
#
#  Redis (D.5) :
#   - témoin : l'ancien mécanisme (--requirepass en argument) EST détecté dans ps ;
#   - nouveau mécanisme : mot de passe absent de ps, de docker ps --no-trunc, de la commande,
#     de l'entrypoint et du healthcheck du conteneur, et de l'environnement de redis-server ;
#     accès sans mot de passe refusé ; rotation (redis + api relancés ensemble) : ancien refusé,
#     nouveau accepté, données conservées (AOF), API saine ;
#  PostgreSQL (D.4), rôle par rôle (ecsi_migrator, postgres, ecsi_worker, ecsi_auth, ecsi_app) :
#   - simulation, rotation, idempotence (« déjà fait »), consommateurs relancés et contrôlés,
#     valeurs réellement chargées par les conteneurs (check-env.sh --conteneurs) ;
#   - refus d'une valeur invalide ; échec réel d'ALTER ROLE (transaction en lecture seule) sans
#     aucune fuite ; retour arrière puis nouvelle rotation ;
#   - témoin : un ALTER ROLE naïf (psql -c) EST détecté dans le journal PostgreSQL et dans ps ;
#  Fin : aucune des valeurs (anciennes et nouvelles) dans les sorties, dans ps, dans le journal
#  PostgreSQL complet, ni dans la commande d'aucun conteneur.
#
#   ops/rotation/tests/secrets-tools-e2e.sh <dossier de travail vide>
# Nécessite : docker (Compose v2), openssl, l'image ecsi-cloud/api:dev.
# shellcheck disable=SC2086
set -eu
umask 077

T=${1:?Usage : secrets-tools-e2e.sh <dossier de travail vide>}
REPO=$(cd "$(dirname "$0")/../../.." && pwd)
mkdir -p "$T"
[ -z "$(ls -A "$T")" ] || { echo "$T n'est pas vide" >&2; exit 1; }
T=$(cd "$T" && pwd)
OUT=$T/sorties.log
: >"$OUT"
ENVF=$T/prod.env
P=ecsi-secretstest
VALUES=$T/valeurs # valeurs à rechercher (jamais affichées)
: >"$VALUES"

# Recherche d'une valeur SANS la passer en argument (sinon le grep lui-même apparaîtrait dans
# ps) : motif écrit dans un fichier par printf (commande interne du shell), grep -f.
has() { printf '%s\n' "$1" >"$T/motif"; grep -qFf "$T/motif" "$2"; }
step() { printf '\n=== %s\n' "$*" | tee -a "$OUT"; }
fail() { echo "ECHEC DE L'ESSAI : $*" >&2; exit 1; }
run() {
  rc=0
  "$@" >"$T/last.log" 2>&1 || rc=$?
  cat "$T/last.log" >>"$OUT"
  cat "$T/last.log"
}
ok() { run "$@"; [ "$rc" = 0 ] || fail "code de sortie $rc : $*"; }
expect_rc() { want=$1; shift; run "$@"; [ "$rc" = "$want" ] || fail "code $rc au lieu de $want : $*"; }
expect_in() { grep -qF -- "$1" "$T/last.log" || fail "attendu dans la sortie : « $1 »"; }
note() { echo "--- $*" | tee -a "$OUT"; }
set_env() {
  grep -v "^$1=" "$ENVF" >"$ENVF.tmp" || true
  printf '%s=%s\n' "$1" "$2" >>"$ENVF.tmp"
  mv "$ENVF.tmp" "$ENVF"
  printf '%s\n' "$2" >>"$VALUES"
}
get_env() { sed -n "s/^$1=//p" "$ENVF" | tail -n 1; }

"$REPO/scripts/generate-prod-test-env.sh" "$ENVF" >/dev/null
for name in POSTGRES_PASSWORD ECSI_DB_MIGRATOR_PASSWORD ECSI_DB_APP_PASSWORD ECSI_DB_AUTH_PASSWORD ECSI_DB_WORKER_PASSWORD REDIS_PASSWORD; do
  get_env "$name" >>"$VALUES"
done
PROD="docker compose -p $P --env-file $ENVF -f $REPO/docker-compose.yml -f $REPO/docker-compose.prod.yml -f $REPO/ops/rotation/tests/compose.pglog.yml"
ROLE_TOOL="$REPO/ops/rotation/pg-role-password.sh"
CHECK="$REPO/ops/rotation/check-env.sh"

SAMPLER_STOP=$T/stop
cleanup() {
  : >"$SAMPLER_STOP"
  docker rm -f ecsi-temoin-redis >/dev/null 2>&1 || true
  $PROD down -v >/dev/null 2>&1 || true
}
trap cleanup EXIT

# Échantillonneur : arguments de TOUS les processus de la machine (conteneurs compris).
( while [ ! -e "$SAMPLER_STOP" ]; do ps -eo args >>"$T/ps.log" 2>/dev/null; sleep 0.2; done ) &

cid() { $PROD ps -q "$1"; }
wait_healthy() {
  for _ in $(seq 1 80); do
    [ "$(docker inspect -f '{{.State.Health.Status}}' "$(cid "$1")" 2>/dev/null)" = healthy ] && return 0
    sleep 3
  done
  fail "$1 ne devient pas sain"
}
restart() { $PROD up -d --no-deps --no-build "$@" >>"$OUT" 2>&1; for s in "$@"; do wait_healthy "$s"; done; }
psql_q() { $PROD exec -T postgres psql -U postgres -d ecsi -Atc "$1"; }
# Redis avec un mot de passe lu sur l'entrée standard (jamais en argument).
redis_auth() { printf '%s\n' "$1" | docker exec -i "$(cid redis)" sh -c "IFS= read -r REDISCLI_AUTH; export REDISCLI_AUTH; redis-cli --no-auth-warning $2"; }
api_status() { # code HTTP d'une requête faite DANS le conteneur de l'API
  $PROD exec -T api node -e "fetch('http://127.0.0.1:4000/api/v1/$1',{method:'$2',headers:{cookie:'ecsi_rt=sonde-h3'}}).then(r=>console.log(r.status)).catch(()=>console.log('erreur'))"
}
worker_cycle_ok() {
  marker=$(psql_q "select coalesce(sum(consecutive_failures), 0) from routers where deleted_at is null")
  for _ in $(seq 1 60); do
    now=$(psql_q "select coalesce(sum(consecutive_failures), 0) from routers where deleted_at is null")
    [ "$now" -ge "$((marker + 2))" ] && break
    sleep 3
  done
  [ "$now" -ge "$((marker + 2))" ] || fail 'aucun cycle du worker observé'
  note 'worker : cycle de supervision observé (connexion ecsi_worker OK)'
}

step 'Pile de test (PostgreSQL journalisant toutes les requêtes)'
$PROD up -d --wait --no-build postgres redis s3 >>"$OUT" 2>&1
$PROD exec -T s3 sh -c "echo 's3.bucket.create -name ecsi-prod-test' | weed shell -master=localhost:9333" >/dev/null
$PROD run --rm -T --no-deps migrate >/dev/null
$PROD run --rm -T --no-deps -e NODE_ENV=development -e SEED_PASSWORD="essai-$(openssl rand -hex 8)" migrate node dist/database/seed.js >/dev/null
$PROD run --rm -T --no-deps migrate node --input-type=module - <"$REPO/ops/backup/tests/seed-secrets.mjs" | tee -a "$OUT"
restart api worker
ok "$CHECK" "$ENVF" --conteneurs "$P"

# ---------------------------------------------------------------------------- Redis (D.5)
step "Redis — témoin : l'ANCIEN mécanisme (--requirepass en argument) est bien détecté"
CTRL=$(openssl rand -hex 24)
docker run -d --name ecsi-temoin-redis redis:8-alpine redis-server --requirepass "$CTRL" >/dev/null
sleep 2
# redis-server masque ses propres arguments dans ps (titre de processus), mais pas la commande
# du conteneur ; et l'ancien contrôle de santé « redis-cli -a » apparaît dans ps à chaque
# exécution (ici rendu durable par une souscription bloquante).
docker exec -d ecsi-temoin-redis redis-cli -a "$CTRL" --no-auth-warning subscribe canal-temoin
sleep 2
ps -eo args >"$T/ps-now"
has "$CTRL" "$T/ps-now" || fail "le témoin n'est pas détecté : l'essai ne prouverait rien"
docker ps --no-trunc --format '{{.Command}}' >"$T/dps-now"
has "$CTRL" "$T/dps-now" || fail 'témoin non détecté par docker ps'
docker rm -f ecsi-temoin-redis >/dev/null
note 'témoin détecté par ps et docker ps --no-trunc (méthode de détection valide)'

redis_clean() { # redis_clean <mot de passe> : absent de toute commande et de ps
  pw=$1
  sleep 12 # au moins deux contrôles de santé (toutes les 5 s) pendant l'échantillonnage
  ps aux >"$T/ps-now"
  has "$pw" "$T/ps-now" && fail 'mot de passe Redis visible dans ps aux'
  has "$pw" "$T/ps.log" && fail "mot de passe Redis relevé par l'échantillonneur ps"
  docker ps --no-trunc --format '{{.Command}}' >"$T/dps-now"
  has "$pw" "$T/dps-now" && fail 'mot de passe Redis dans docker ps --no-trunc'
  docker inspect -f '{{json .Config.Entrypoint}}{{json .Config.Cmd}}{{json .Args}}{{json .Path}}{{json .Config.Healthcheck}}' "$(cid redis)" >"$T/inspect-now"
  has "$pw" "$T/inspect-now" && fail "mot de passe Redis dans la commande, l'entrypoint ou le healthcheck du conteneur"
  n=$(docker exec "$(cid redis)" sh -c 'tr "\0" "\n" </proc/$(pidof redis-server)/environ | grep -c "^REDIS_PASSWORD=" || true')
  [ "$n" = 0 ] || fail "REDIS_PASSWORD encore dans l'environnement de redis-server"
  return 0
}

step 'Redis — nouveau mécanisme : mot de passe absent de ps, de la commande et du healthcheck'
R1=$(get_env REDIS_PASSWORD)
redis_clean "$R1"
note 'ps aux, échantillonneur, docker ps --no-trunc, commande/entrypoint/healthcheck, environ de redis-server : aucun mot de passe'
docker exec "$(cid redis)" redis-cli ping 2>&1 | grep -q NOAUTH || fail 'Redis accepte une connexion sans mot de passe'
[ "$(redis_auth "$R1" ping)" = PONG ] || fail 'Redis refuse le bon mot de passe'
[ "$(redis_auth "$R1" 'set ecsi:essai:h3 conserve')" = OK ] || fail 'écriture Redis'
note 'sans mot de passe : NOAUTH ; avec : PONG'

step 'Redis — rotation (redis et api relancés ensemble)'
cp -p "$ENVF" "$T/avant-redis"
R2=$(openssl rand -hex 32)
set_env REDIS_PASSWORD "$R2"
ok "$CHECK" "$ENVF"
restart redis api
redis_clean "$R2"
redis_auth "$R1" ping 2>&1 | grep -q -e WRONGPASS -e NOAUTH -e 'invalid' || fail 'ancien mot de passe Redis encore accepté'
[ "$(redis_auth "$R2" ping)" = PONG ] || fail 'nouveau mot de passe Redis refusé'
[ "$(redis_auth "$R2" 'get ecsi:essai:h3')" = conserve ] || fail 'données Redis perdues'
[ "$(api_status health GET)" = 200 ] || fail 'API non saine après la rotation Redis'
[ "$(api_status auth/refresh POST)" = 401 ] || fail 'sonde refresh (Redis + ecsi_auth) : 401 attendu'
ok "$CHECK" "$ENVF" --conteneurs "$P"
note 'ancien refusé, nouveau accepté, données conservées, API saine, conteneurs à jour'

# ---------------------------------------------------------------------- PostgreSQL (D.4)
rotate_role() { # rotate_role <rôle> <variable>
  role=$1 var=$2
  cp -p "$ENVF" "$T/avant-$role"
  set_env "$var" "$(openssl rand -hex 32)"
  ok "$ROLE_TOOL" "$role" --env "$ENVF" --ancien "$T/avant-$role" --projet "$P" --dry-run
  expect_in 'SIMULATION'
  ok "$ROLE_TOOL" "$role" --env "$ENVF" --ancien "$T/avant-$role" --projet "$P"
  expect_in "RESULTAT : mot de passe de $role changé"
  ok "$ROLE_TOOL" "$role" --env "$ENVF" --ancien "$T/avant-$role" --projet "$P"
  expect_in 'RESULTAT : déjà fait'
}

step 'PostgreSQL — ecsi_migrator (aucun processus permanent)'
rotate_role ecsi_migrator ECSI_DB_MIGRATOR_PASSWORD
ok $PROD run --rm -T --no-deps migrate
note 'migrations relancées avec le nouveau mot de passe'

step 'PostgreSQL — postgres (superutilisateur) ; la sauvegarde H1 passe par le socket local'
rotate_role postgres POSTGRES_PASSWORD
docker exec "$(cid postgres)" pg_dump -U postgres -d ecsi -Fc >/dev/null || fail 'pg_dump (socket local) après rotation de postgres'
note 'pg_dump par docker exec (comme pg-backup.sh) toujours possible'

step 'PostgreSQL — ecsi_worker (worker relancé)'
rotate_role ecsi_worker ECSI_DB_WORKER_PASSWORD
restart worker
worker_cycle_ok

step 'PostgreSQL — ecsi_auth (API relancée)'
rotate_role ecsi_auth ECSI_DB_AUTH_PASSWORD
restart api
[ "$(api_status auth/refresh POST)" = 401 ] || fail 'sonde refresh (ecsi_auth) : 401 attendu'

step 'PostgreSQL — ecsi_app (API relancée)'
rotate_role ecsi_app ECSI_DB_APP_PASSWORD
restart api
[ "$(api_status health GET)" = 200 ] || fail 'API non saine (ecsi_app)'
ok "$CHECK" "$ENVF" --conteneurs "$P"
expect_in 'conteneur api : DATABASE_URL à jour'
expect_in 'conteneur worker : DATABASE_WORKER_URL à jour'

step 'PostgreSQL — conteneur non relancé : détecté par check-env.sh --conteneurs'
cp -p "$ENVF" "$T/avant-oubli"
set_env ECSI_DB_APP_PASSWORD "$(openssl rand -hex 32)"
expect_rc 1 "$CHECK" "$ENVF" --conteneurs "$P"
expect_in 'conteneur api : DATABASE_URL DIFFÉRENT du fichier'
cp -p "$T/avant-oubli" "$ENVF"

step "PostgreSQL — valeur invalide refusée, rien n'est modifié"
cp -p "$ENVF" "$T/avant-invalide"
set_env ECSI_DB_AUTH_PASSWORD 'mauvais@mot:de/passe#avec-caracteres'
expect_rc 1 "$ROLE_TOOL" ecsi_auth --env "$ENVF" --ancien "$T/avant-invalide" --projet "$P"
expect_in '24 caractères minimum parmi'
cp -p "$T/avant-invalide" "$ENVF"

step "PostgreSQL — échec réel d'ALTER ROLE (lecture seule) : message générique, aucune fuite"
psql_q 'ALTER ROLE postgres SET default_transaction_read_only = on' >/dev/null
cp -p "$ENVF" "$T/avant-lecture-seule"
set_env ECSI_DB_AUTH_PASSWORD "$(openssl rand -hex 32)"
expect_rc 1 "$ROLE_TOOL" ecsi_auth --env "$ENVF" --ancien "$T/avant-lecture-seule" --projet "$P"
expect_in 'sortie de psql masquée par sécurité'
printf '%s\n' 'SET default_transaction_read_only = off;' 'ALTER ROLE postgres RESET default_transaction_read_only;' |
  $PROD exec -T postgres psql -X -q -U postgres -d ecsi
cp -p "$T/avant-lecture-seule" "$ENVF"
ok "$ROLE_TOOL" ecsi_auth --env "$ENVF" --ancien "$T/avant-ecsi_auth" --projet "$P"
expect_in 'déjà fait'
note 'ALTER refusé par PostgreSQL, valeur en place inchangée'

step 'PostgreSQL — retour arrière ecsi_app, puis nouvelle rotation'
ok "$ROLE_TOOL" ecsi_app --env "$ENVF" --ancien "$T/avant-ecsi_app" --projet "$P" --rollback
expect_in 'retour arrière effectué'
cp -p "$T/avant-ecsi_app" "$ENVF"
restart api
[ "$(api_status health GET)" = 200 ] || fail 'API non saine après le retour arrière'
rotate_role ecsi_app ECSI_DB_APP_PASSWORD
restart api
[ "$(api_status health GET)" = 200 ] || fail 'API non saine après la nouvelle rotation'
ok "$CHECK" "$ENVF" --conteneurs "$P"

step 'PostgreSQL — témoin : un ALTER ROLE naïf (psql -c) EST détecté (journal et ps)'
CTRL_PG=$(openssl rand -hex 24)
psql_q 'CREATE ROLE ecsi_temoin LOGIN' >/dev/null
docker exec "$(cid postgres)" sh -c "psql -U postgres -d ecsi -c \"ALTER ROLE ecsi_temoin PASSWORD '$CTRL_PG'\"; sleep 1" >/dev/null
docker logs "$(cid postgres)" >"$T/pg-now" 2>&1
has "$CTRL_PG" "$T/pg-now" || fail "témoin absent du journal : l'essai ne prouverait rien"
has "$CTRL_PG" "$T/ps.log" || fail "témoin non relevé par l'échantillonneur ps"
note 'témoin détecté dans le journal PostgreSQL et dans ps (méthode de détection valide)'

step 'Aucune valeur dans les sorties, ps, le journal PostgreSQL ni les commandes des conteneurs'
docker logs "$(cid postgres)" >"$T/postgres.log" 2>&1
grep -qF 'statement: select current_user' "$T/postgres.log" || fail 'journalisation des requêtes inactive : preuve invalide'
grep -qF 'cannot execute ALTER ROLE in a read-only transaction' "$T/postgres.log" || fail "échec d'ALTER absent du journal : preuve invalide"
for c in $($PROD ps -aq); do
  docker inspect -f '{{json .Config.Entrypoint}}{{json .Config.Cmd}}{{json .Args}}{{json .Config.Healthcheck}}' "$c"
done >"$T/commandes.log"
: >"$SAMPLER_STOP"
sleep 1
grep -v '^$' "$VALUES" >"$VALUES.motifs"
leaks=0
for f in "$OUT" "$T/ps.log" "$T/postgres.log" "$T/commandes.log"; do
  if grep -qFf "$VALUES.motifs" "$f"; then leaks=$((leaks + 1)); echo "FUITE dans $(basename "$f")" >&2; fi
done
[ "$leaks" = 0 ] || fail "$leaks fichier(s) contenant une valeur"
note "$(wc -l <"$VALUES" | tr -d ' ') valeurs recherchées dans $(wc -l <"$T/ps.log" | tr -d ' ') lignes de ps, le journal PostgreSQL complet, les sorties et les commandes : 0 trouvée"
echo
echo 'ESSAI COMPLET RÉUSSI : Redis sans mot de passe dans les processus, rotation des 5 rôles PostgreSQL sans fuite, retour arrière.'
