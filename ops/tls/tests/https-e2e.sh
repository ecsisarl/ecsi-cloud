#!/bin/sh
# ECSI CLOUD — essai complet de l'exposition HTTPS de production (Sprint S3H, étape H4) avec le
# VRAI Nginx de production (image nginx:1-alpine, infra/nginx/production/) sur Docker réel :
#
#   1. contrôle préalable (ops/tls/preflight.sh) de la configuration Compose FUSIONNÉE de
#      production : ports, portail, URL publiques, garde-fous, AC privée neutralisée, clés de
#      chiffrement (ENCRYPTION_PREVIOUS_KEYS identique partout, k2 conservée), SMTP ; cas refusés ;
#   2. mode acme-bootstrap : défi ACME servi en HTTP, 503 ailleurs, aucun HTTPS ;
#   3. Let's Encrypt SIMULÉ par Pebble (serveur ACME de test officiel) : essai « staging »
#      (--dry-run), certificat, idempotence, bascule https, renouvellement et rechargement ;
#   4. certificat d'une AC de test : routage app (web, API, WebSocket), enroll (POST exact
#      seulement), HTTP -> HTTPS, défi ACME non redirigé, en-têtes de sécurité, hôtes inconnus,
#      client sans SNI (RouterOS), TLS 1.2/1.3, taille de corps, limitation de débit.
#
# Projet Compose dédié (ecsi-tlstest), ports de test sur 127.0.0.1 (ECSI_HTTP_PORT /
# ECSI_HTTPS_PORT, défaut 18080 / 18443) : exécutable à côté d'une pile en service, sans toucher
# à ses conteneurs, volumes ni certificats. Aucun appel à Let's Encrypt ni au DNS public.
#
#   ops/tls/tests/https-e2e.sh <dossier de travail vide>
# Nécessite : docker (Compose v2), openssl, curl, l'image ecsi-cloud/api:dev (ou ECSI_OPS_IMAGE).
# Pebble (ghcr.io/letsencrypt/pebble) indisponible : étape 3 ignorée, sauf ECSI_TLS_REQUIRE_PEBBLE=1
# (CI) qui la rend obligatoire.
# $C est une commande à découper en mots.
# shellcheck disable=SC2086
set -eu

T=${1:?Usage : https-e2e.sh <dossier de travail vide>}
REPO=$(cd "$(dirname "$0")/../../.." && pwd)
mkdir -p "$T"
[ -z "$(ls -A "$T")" ] || { echo "$T n'est pas vide" >&2; exit 1; }
T=$(cd "$T" && pwd)
OUT=$T/sorties.log
: >"$OUT"
ENVF=$T/prod.env

export ECSI_PROJECT=ecsi-tlstest
export ECSI_HTTP_PORT=${ECSI_HTTP_PORT:-18080}
export ECSI_HTTPS_PORT=${ECSI_HTTPS_PORT:-18443}
export ECSI_ENV_FILE=$ENVF
EXTRA="-f $REPO/ops/tls/tests/compose.tlstest.yml"
C="docker compose -p $ECSI_PROJECT --env-file $ENVF -f $REPO/docker-compose.yml -f $REPO/docker-compose.prod.yml $EXTRA"
CERTSH=$REPO/ops/tls/certificat.sh
PREFLIGHT=$REPO/ops/tls/preflight.sh
APP=app.mytikcentral.com
ENROLL=enroll.mytikcentral.com
EP=/api/v1/routers/enroll

step() { printf '\n=== %s\n' "$*" | tee -a "$OUT"; }
fail() { echo "ECHEC DE L'ESSAI : $*" >&2; exit 1; }
pass() { echo "--- OK $*" | tee -a "$OUT"; }
run() {
  rc=0
  "$@" >"$T/last.log" 2>&1 || rc=$?
  cat "$T/last.log" >>"$OUT"
  cat "$T/last.log"
}
ok() { run "$@"; [ "$rc" = 0 ] || fail "code de sortie $rc : $*"; }
expect_rc() { want=$1; shift; run "$@"; [ "$rc" = "$want" ] || fail "code $rc au lieu de $want : $*"; }
expect_in() { grep -qF -- "$1" "$T/last.log" || fail "attendu dans la sortie : « $1 »"; }
set_env() { # set_env <fichier> <variable> <valeur>
  grep -v "^$2=" "$1" >"$1.tmp" || true
  printf '%s=%s\n' "$2" "$3" >>"$1.tmp"
  mv "$1.tmp" "$1"
}

# Aucun reste d'un essai précédent : rien n'est jamais écrasé.
if [ -n "$(docker ps -aq --filter "label=com.docker.compose.project=$ECSI_PROJECT")" ] ||
  [ -n "$(docker volume ls -q --filter "label=com.docker.compose.project=$ECSI_PROJECT")" ]; then
  fail "le projet $ECSI_PROJECT existe déjà (docker compose -p $ECSI_PROJECT down -v s'il s'agit d'un reste d'essai)"
fi
cleanup() { $C --profile tls --profile pebble down -v >/dev/null 2>&1 || true; }
trap cleanup EXIT

# Environnement de production de TEST : secrets aléatoires, URL publiques H4, k3 active et k2
# ancienne (comme la production après H2), AC privée de laboratoire présente dans le fichier
# (doit être neutralisée par la surcouche), SMTP réel fictif.
umask 077
"$REPO/scripts/generate-prod-test-env.sh" "$ENVF" >/dev/null
umask 022
set_env "$ENVF" ENCRYPTION_KEY_ID k3
set_env "$ENVF" ENCRYPTION_PREVIOUS_KEYS "k2:$(openssl rand -base64 32)"
set_env "$ENVF" WEB_PUBLIC_URL "https://$APP"
set_env "$ENVF" CORS_ORIGINS "https://$APP"
set_env "$ENVF" ROUTER_ENROLL_PUBLIC_URL "https://$ENROLL$EP"
set_env "$ENVF" ROUTER_ENROLL_CA_URL "https://ca.lab.example/ecsi-ca.pem"
set_env "$ENVF" ROUTER_ENROLL_CA_FINGERPRINT "$(openssl rand -hex 32)"
set_env "$ENVF" SMTP_HOST smtp.example.com

step '1. Contrôle préalable de la configuration Compose fusionnée de production'
ok "$PREFLIGHT"
expect_in 'OK    ports publiés : Nginx 80 et 443, PostgreSQL 127.0.0.1:5432 seulement'
expect_in 'OK    portail captif non démarré'
expect_in 'OK    Nginx ne dépend pas du portail'
expect_in 'OK    Nginx : configuration de production, mode « https »'
expect_in 'OK    Nginx : certificats et défis ACME montés en lecture seule'
expect_in 'OK    api ROUTER_ENROLL_PUBLIC_URL conforme'
expect_in 'OK    api ROUTER_ENROLL_CA_URL conforme'
expect_in 'OK    api COOKIE_SECURE conforme'
expect_in 'OK    api LOG_PRETTY conforme'
expect_in 'OK    api S3_AUTO_CREATE_BUCKET conforme'
expect_in 'OK    ENCRYPTION_PREVIOUS_KEYS identique et non vide dans api, migrate, worker, gateway, keys-rotate'
expect_in 'OK    ancienne clé k2 conservée (anciennes clés : k2)'
expect_in 'OK    mode acme-bootstrap : configuration valide'
expect_in 'PREFLIGHT H4 : CONFORME'

neg() { # neg <variable> <valeur|-> <attendu> : copie du fichier modifiée, contrôle refusé
  cp "$ENVF" "$T/neg.env"
  if [ "$2" = - ]; then
    grep -v "^$1=" "$ENVF" >"$T/neg.env"
  else
    set_env "$T/neg.env" "$1" "$2"
  fi
  expect_rc 1 env ECSI_ENV_FILE="$T/neg.env" "$PREFLIGHT"
  expect_in "$3"
}
neg ENCRYPTION_PREVIOUS_KEYS "k1:$(openssl rand -base64 32)" 'ECHEC ancienne clé k2 ABSENTE (anciennes clés : k1)'
neg ENCRYPTION_PREVIOUS_KEYS '' 'ECHEC ENCRYPTION_PREVIOUS_KEYS absente ou différente'
neg SMTP_HOST mailpit 'ECHEC SMTP_HOST : Mailpit'
neg WEB_PUBLIC_URL "http://$APP" 'ECHEC api WEB_PUBLIC_URL non conforme'
neg ROUTER_ENROLL_PUBLIC_URL "https://$APP$EP" 'ECHEC api ROUTER_ENROLL_PUBLIC_URL non conforme'
neg ECSI_NGINX_MODE acme-bootstrap 'ECHEC ECSI_NGINX_MODE défini dans le fichier .env'
neg JWT_ACCESS_SECRET - 'ECHEC required variable JWT_ACCESS_SECRET is missing a value'
rm -f "$T/neg.env"
pass 'contrôle préalable : conforme, et 7 configurations refusées'

step '2. Mode acme-bootstrap (aucun certificat) : défi ACME en HTTP seulement'
export ECSI_COMPOSE_EXTRA=$EXTRA
ok "$CERTSH" amorcer
expect_in 'OK    Nginx en mode acme-bootstrap'
[ "$($C ps --services --status running | tr '\n' ' ')" = 'nginx ' ] || fail 'autres services démarrés en mode acme-bootstrap'
TOKEN=essai-$(openssl rand -hex 8)
put_token() {
  $C --profile tls run --rm --no-deps -T --entrypoint sh certbot -c \
    "mkdir -p /var/www/acme/.well-known/acme-challenge && echo $TOKEN >/var/www/acme/.well-known/acme-challenge/$TOKEN" >/dev/null 2>&1
}
http_code() { # http_code <hôte> <chemin> [options curl]
  h=$1 p=$2
  shift 2
  curl --noproxy "*" -s --path-as-is -o "$T/body" -D "$T/headers" -w '%{http_code}' --max-time 10 \
    --resolve "$h:$ECSI_HTTP_PORT:127.0.0.1" "$@" "http://$h:$ECSI_HTTP_PORT$p" || true
}
put_token
for h in $APP $ENROLL; do
  [ "$(http_code "$h" "/.well-known/acme-challenge/$TOKEN")" = 200 ] || fail "défi ACME non servi pour $h"
  grep -qx "$TOKEN" "$T/body" || fail "contenu du défi ACME incorrect pour $h"
  [ "$(http_code "$h" /)" = 503 ] || fail "$h / : 503 attendu en mode acme-bootstrap"
done
[ "$(http_code "$APP" /.well-known/acme-challenge/absent)" = 404 ] || fail 'défi ACME absent : 404 attendu'
[ "$(http_code autre.example.org /)" = 000 ] || fail 'hôte inconnu en HTTP : connexion fermée attendue'
if curl --noproxy "*" -sk -o /dev/null --max-time 5 --resolve "$APP:$ECSI_HTTPS_PORT:127.0.0.1" "https://$APP:$ECSI_HTTPS_PORT/"; then
  fail 'HTTPS actif en mode acme-bootstrap'
fi
pass 'acme-bootstrap : défi servi (app, enroll), 503 ailleurs, hôte inconnu fermé, pas de HTTPS, Nginx seul'

served_serial() {
  openssl s_client -connect "127.0.0.1:$ECSI_HTTPS_PORT" -servername "$APP" </dev/null 2>/dev/null |
    openssl x509 -noout -serial
}
stored_serial() {
  $C --profile tls run --rm --no-deps -T --entrypoint cat certbot /etc/letsencrypt/live/mytikcentral/cert.pem |
    openssl x509 -noout -serial
}

step "3. Let's Encrypt simulé par Pebble : staging (--dry-run), production, idempotence, renouvellement"
PEBBLE_IMAGE=ghcr.io/letsencrypt/pebble:2.10.1
ACME='ACME simulé par Pebble'
if docker image inspect "$PEBBLE_IMAGE" >/dev/null 2>&1 || docker pull -q "$PEBBLE_IMAGE" >/dev/null 2>&1; then
  $C --profile pebble up -d --no-deps pebble >>"$OUT" 2>&1
  for _ in $(seq 1 30); do
    $C exec -T nginx curl --noproxy "*" -skf -o /dev/null https://pebble:14000/dir && break
    sleep 1
  done
  export ECSI_ACME_SERVER=https://pebble:14000/dir ECSI_ACME_INSECURE=1
  ok "$CERTSH" staging
  expect_in 'OK    défi ACME servi en HTTP pour app.mytikcentral.com (sans redirection)'
  expect_in 'OK    défi ACME servi en HTTP pour enroll.mytikcentral.com (sans redirection)'
  expect_in 'OK    essai staging réussi'
  run "$CERTSH" etat
  if grep -q 'Certificate Name: mytikcentral' "$T/last.log"; then fail "l'essai staging a écrit un certificat"; fi
  ok "$CERTSH" production
  expect_in 'OK    certificat « mytikcentral » présent'
  $C exec -T nginx curl --noproxy "*" -skf https://pebble:15000/roots/0 >"$T/pebble-root.pem"
  $C up -d --no-deps --no-build api web >>"$OUT" 2>&1
  ok env ECSI_TLS_CACERT="$T/pebble-root.pem" "$CERTSH" activer
  expect_in 'OK    https://app.mytikcentral.com : certificat vérifié'
  expect_in 'OK    https://enroll.mytikcentral.com : certificat vérifié'
  expect_in 'OK    Nginx en mode https'
  s1=$(served_serial)
  [ "$s1" = "$(stored_serial)" ] || fail 'Nginx ne sert pas le certificat obtenu'
  ok "$CERTSH" production
  [ "$(stored_serial)" = "$s1" ] || fail 'production relancée : certificat redemandé (non idempotent)'
  pass 'production relancée : certificat valide conservé (idempotent)'
  ok env ECSI_RENEW_FORCE=1 "$CERTSH" renouveler
  expect_in 'OK    renouvellement contrôlé, Nginx rechargé'
  # Rechargement asynchrone (HUP) : les anciens processus de travail finissent leurs
  # connexions ; le nouveau certificat est servi dès que les nouveaux ont pris le relais.
  s3=$(stored_serial)
  [ "$s3" != "$s1" ] || fail 'certificat non renouvelé'
  for _ in $(seq 1 20); do
    s2=$(served_serial)
    [ "$s2" = "$s3" ] && break
    sleep 1
  done
  [ "$s2" = "$s3" ] || fail 'certificat renouvelé non servi après rechargement'
  pass "Pebble : staging sans écriture, certificat, https vérifié, idempotence, renouvellement rechargé"
  unset ECSI_ACME_SERVER ECSI_ACME_INSECURE
  $C --profile tls --profile pebble down -v >>"$OUT" 2>&1
else
  [ "${ECSI_TLS_REQUIRE_PEBBLE:-0}" != 1 ] || fail "image $PEBBLE_IMAGE indisponible"
  echo "--- IGNORÉ : image $PEBBLE_IMAGE indisponible (exécutée en CI)" | tee -a "$OUT"
  ACME='ACME (Pebble) IGNORÉ'

fi

step "4. Certificat d'une AC de test : routage, refus, en-têtes, TLS"
mkdir -p "$T/ac"
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -days 2 -subj '/CN=ECSI essai H4' \
  -keyout "$T/ac/ca.key" -out "$T/ac/ca.pem" 2>/dev/null
openssl req -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -subj "/CN=$APP" \
  -keyout "$T/ac/privkey.pem" -out "$T/ac/leaf.csr" 2>/dev/null
printf 'subjectAltName=DNS:%s,DNS:%s\nextendedKeyUsage=serverAuth\n' "$APP" "$ENROLL" >"$T/ac/ext.cnf"
openssl x509 -req -in "$T/ac/leaf.csr" -CA "$T/ac/ca.pem" -CAkey "$T/ac/ca.key" -CAcreateserial \
  -days 2 -extfile "$T/ac/ext.cnf" -out "$T/ac/fullchain.pem" 2>/dev/null
chmod 644 "$T/ac/privkey.pem" "$T/ac/fullchain.pem"
$C --profile tls run --rm --no-deps -T -v "$T/ac:/src:ro" --entrypoint sh certbot -c \
  'mkdir -p /etc/letsencrypt/live/mytikcentral && cp /src/fullchain.pem /src/privkey.pem /etc/letsencrypt/live/mytikcentral/' >>"$OUT" 2>&1
$C up -d --no-deps --no-build api web >>"$OUT" 2>&1
ok env ECSI_TLS_CACERT="$T/ac/ca.pem" "$CERTSH" activer
expect_in 'OK    Nginx en mode https'
CA=$T/ac/ca.pem

https_code() { # https_code <hôte> <méthode> <chemin> [options curl] : code HTTP (000 : pas de réponse)
  h=$1 m=$2 p=$3
  shift 3
  if [ "$m" = HEAD ]; then set -- --head "$@"; else set -- -X "$m" "$@"; fi
  curl --noproxy "*" -s --path-as-is --cacert "$CA" -o "$T/body" -D "$T/headers" -w '%{http_code}' --max-time 10 \
    --resolve "$h:$ECSI_HTTPS_PORT:127.0.0.1" "$@" "https://$h:$ECSI_HTTPS_PORT$p" || true
}
header() { grep -i "^$1:" "$T/headers" | sed 's/^[^:]*: *//' | tr -d '\r'; }
upstream() { sed -n "s/.*\"$1\":\"\\([^\"]*\\)\".*/\\1/p" "$T/body"; }
api_hits() { $C logs --no-log-prefix api 2>/dev/null | grep -c '"stub":"api"' || true; }
security_headers() { # security_headers <contexte> [enroll]
  [ "$(header Strict-Transport-Security)" = 'max-age=86400' ] || fail "$1 : HSTS absent, dupliqué ou incorrect"
  [ "$(header X-Content-Type-Options)" = nosniff ] || fail "$1 : X-Content-Type-Options"
  [ "$(header X-Frame-Options)" = DENY ] || fail "$1 : X-Frame-Options absent ou dupliqué"
  [ "$(header Referrer-Policy)" = strict-origin-when-cross-origin ] || fail "$1 : Referrer-Policy"
  header Permissions-Policy | grep -q 'camera=()' || fail "$1 : Permissions-Policy"
  [ "$(header Cross-Origin-Opener-Policy)" = same-origin ] || fail "$1 : Cross-Origin-Opener-Policy"
  if [ "${2:-}" = enroll ]; then
    header Content-Security-Policy | grep -q "default-src 'none'" || fail "$1 : Content-Security-Policy"
  fi
  ! header Server | grep -q '[0-9]' || fail "$1 : version de Nginx divulguée"
}

# app : tableau de bord et API
[ "$(https_code $APP GET / -H 'X-Forwarded-For: 203.0.113.66')" = 200 ] || fail 'app / : 200 attendu'
{ [ "$(upstream stub)" = web ] && [ "$(upstream url)" = / ]; } || fail 'app / : tableau de bord attendu'
[ "$(upstream x-forwarded-proto)" = https ] || fail 'X-Forwarded-Proto https attendu'
[ "$(upstream host)" = $APP ] || fail 'Host transmis incorrect'
upstream x-request-id | grep -Eq '^[0-9a-f]{32}$' || fail 'X-Request-Id absent'
real=$(upstream x-real-ip)
{ [ -n "$real" ] && [ "$real" != 203.0.113.66 ]; } || fail 'X-Real-IP : adresse réelle du client attendue'
[ "$(upstream x-forwarded-for)" = "203.0.113.66, $real" ] || fail 'X-Forwarded-For : client réel en dernier attendu'
security_headers 'app /'
for p in /api/v1/health /api/v1/auth/me; do
  { [ "$(https_code $APP GET $p)" = 200 ] && [ "$(upstream stub)" = api ] && [ "$(upstream url)" = $p ]; } ||
    fail "app $p : API attendue"
  security_headers "app $p"
done
for m in POST PUT PATCH DELETE; do
  { [ "$(https_code $APP $m /api/v1/sites/x -H 'Content-Type: application/json' -d '{}')" = 200 ] &&
    [ "$(upstream method)" = $m ]; } || fail "app $m /api/ : API attendue"
done
[ "$(https_code $APP GET /tableau-de-bord --http2)" = 200 ] || fail 'app : HTTP/2 attendu'
grep -q '^HTTP/2 200' "$T/headers" || fail 'app : réponse HTTP/2 attendue'
ws=$(curl --noproxy "*" -s --http1.1 --cacert "$CA" -o /dev/null -w '%{http_code}' --max-time 5 \
  --resolve "$APP:$ECSI_HTTPS_PORT:127.0.0.1" -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
  -H 'Sec-WebSocket-Version: 13' -H "Sec-WebSocket-Key: $(openssl rand -base64 16)" \
  "https://$APP:$ECSI_HTTPS_PORT/_ws" || true)
[ "$ws" = 101 ] || fail "app : WebSocket (101) attendu, reçu $ws"
pass 'app : tableau de bord, API (toutes méthodes), HTTP/2, WebSocket, en-têtes transmis et de sécurité'

# enroll : POST exact seulement
before=$(api_hits)
[ "$(https_code $ENROLL POST $EP -H 'Content-Type: application/json' -d '{"token":"essai"}')" = 200 ] ||
  fail 'enroll POST exact : 200 attendu'
{ [ "$(upstream stub)" = api ] && [ "$(upstream url)" = $EP ] && [ "$(upstream method)" = POST ]; } ||
  fail 'enroll POST : API, chemin exact attendus'
[ "$(upstream x-forwarded-proto)" = https ] || fail 'enroll : X-Forwarded-Proto'
security_headers 'enroll POST' enroll
[ "$(api_hits)" = $((before + 1)) ] || fail 'enroll POST : une seule requête attendue côté API'
before=$(api_hits)
for m in GET HEAD PUT PATCH DELETE OPTIONS; do
  code=$(https_code $ENROLL $m $EP -H 'Content-Type: application/json')
  [ "$code" = 405 ] || fail "enroll $m : 405 attendu, reçu $code"
  [ "$(header Allow)" = POST ] || fail "enroll $m : Allow: POST attendu"
  security_headers "enroll $m" enroll
done
for p in / /api/v1/health /api/v1/auth/login /api/v1/routers /api/v1/routers/enrollments \
  "$EP/" "${EP}x" "$EP?x=1" "$EP?" /api/v1//routers/enroll /api/v1/routers/%65nroll \
  /api/v1/routers/x/../enroll /api/docs /.well-known/acme-challenge/x /tableau-de-bord; do
  for m in POST GET; do
    code=$(https_code $ENROLL $m "$p" -H 'Content-Type: application/json' -d '{}')
    [ "$code" = 404 ] || fail "enroll $m $p : 404 attendu, reçu $code"
  done
done
security_headers 'enroll 404' enroll
[ "$(api_hits)" = "$before" ] || fail "enroll : une requête refusée a atteint l'API"
[ "$(https_code $ENROLL POST $EP -H 'Content-Type: application/json' -d "$(head -c 5000 /dev/zero | tr '\0' a)")" = 413 ] ||
  fail 'enroll : corps de plus de 4 Kio refusé (413) attendu'
pass 'enroll : POST exact transmis tel quel ; GET/HEAD/PUT/PATCH/DELETE/OPTIONS 405 ; 15 autres chemins 404 sans atteindre l API ; corps limité'

# Client sans SNI (adresse IP, comme un client TLS minimal) : nom d'hôte par l'en-tête Host.
code=$(curl --noproxy "*" -s --http1.1 -k -o "$T/body" -w '%{http_code}' --max-time 10 -X POST \
  -H "Host: $ENROLL" -H 'Content-Type: application/json' -d '{}' "https://127.0.0.1:$ECSI_HTTPS_PORT$EP" || true)
{ [ "$code" = 200 ] && [ "$(upstream url)" = $EP ]; } || fail "enroll sans SNI : 200 attendu, reçu $code"
code=$(curl --noproxy "*" -s --http1.1 -k -o /dev/null -w '%{http_code}' --max-time 10 -H "Host: $ENROLL" \
  "https://127.0.0.1:$ECSI_HTTPS_PORT$EP" || true)
[ "$code" = 405 ] || fail "enroll sans SNI, GET : 405 attendu, reçu $code"
pass 'client sans SNI : enroll servi par l en-tête Host, mêmes refus'

# Hôtes inconnus et TLS
code=$(curl --noproxy "*" -s -k -o /dev/null -w '%{http_code}' --max-time 10 \
  --resolve "autre.example.org:$ECSI_HTTPS_PORT:127.0.0.1" "https://autre.example.org:$ECSI_HTTPS_PORT/" || true)
[ "$code" = 000 ] || fail "hôte inconnu en HTTPS : connexion fermée attendue, reçu $code"
code=$(curl --noproxy "*" -s -k -o /dev/null -w '%{http_code}' --max-time 10 "https://127.0.0.1:$ECSI_HTTPS_PORT/" || true)
[ "$code" = 000 ] || fail "accès HTTPS par adresse IP : connexion fermée attendue, reçu $code"
[ "$(https_code $APP GET / --tlsv1.2 --tls-max 1.2)" = 200 ] || fail 'TLS 1.2 attendu'
[ "$(https_code $APP GET / --tlsv1.3)" = 200 ] || fail 'TLS 1.3 attendu'
if openssl s_client -connect "127.0.0.1:$ECSI_HTTPS_PORT" -servername $APP -tls1_1 </dev/null >/dev/null 2>&1; then
  fail 'TLS 1.1 accepté'
fi
pass 'hôte inconnu et accès par IP fermés (HTTPS) ; TLS 1.2 et 1.3 ; TLS 1.1 refusé'

# HTTP : redirection vers HTTPS, sauf le défi ACME ; jamais de HSTS en HTTP.
put_token
for h in $APP $ENROLL; do
  [ "$(http_code "$h" /tableau?x=1)" = 301 ] || fail "http://$h : 301 attendu"
  [ "$(header Location)" = "https://$h/tableau?x=1" ] || fail "http://$h : Location HTTPS attendue"
  [ -z "$(header Strict-Transport-Security)" ] || fail "http://$h : HSTS en HTTP"
  [ "$(http_code "$h" $EP -X POST -d '{}')" = 301 ] || fail "http://$h POST : 301 attendu"
  [ "$(http_code "$h" "/.well-known/acme-challenge/$TOKEN")" = 200 ] || fail "défi ACME redirigé ($h)"
  grep -qx "$TOKEN" "$T/body" || fail "contenu du défi ACME incorrect ($h)"
  [ -z "$(header Location)" ] || fail "défi ACME redirigé ($h)"
  [ "$(http_code "$h" /.well-known/acme-challenge/absent)" = 404 ] || fail "défi absent : 404 attendu ($h)"
done
[ "$(http_code autre.example.org /)" = 000 ] || fail 'hôte inconnu en HTTP : connexion fermée attendue'
pass 'HTTP : 301 vers HTTPS (chemin et paramètres conservés), défi ACME servi sans redirection, aucun HSTS en HTTP'

# Portail non requis, ports de l'essai, configuration
[ "$($C ps --services --status running | sort | tr '\n' ' ')" = 'api nginx web ' ] ||
  fail 'services en cours inattendus (portail ?)'
if grep -rEn 'portal:|ecsi_portal|3001' "$REPO/infra/nginx/production"; then fail 'référence au portail'; fi
docker port "$($C ps -q nginx)" | sort >"$T/ports"
[ "$(tr '\n' ' ' <"$T/ports")" = "8080/tcp -> 127.0.0.1:$ECSI_HTTP_PORT 8443/tcp -> 127.0.0.1:$ECSI_HTTPS_PORT " ] ||
  fail 'ports publiés par Nginx inattendus'
ok $C exec -T nginx nginx -t -q -c /etc/nginx/ecsi/https.conf
pass 'portail absent et non requis ; Nginx publie seulement HTTP et HTTPS ; nginx -t valide'

# Limitation de débit de l'enrôlement (en dernier : elle consomme le quota de l'adresse).
limited=0
for _ in $(seq 1 40); do
  [ "$(https_code $ENROLL POST $EP -H 'Content-Type: application/json' -d '{}')" != 429 ] || limited=$((limited + 1))
done
[ "$limited" -gt 0 ] || fail 'enroll : limitation de débit (429) attendue'
security_headers 'enroll 429' enroll
pass "enroll : limitation de débit active ($limited réponse(s) 429 sur 40)"

step 'Aucune valeur secrète dans les sorties'
while IFS='=' read -r key value; do
  case $key in
    *PASSWORD | *SECRET* | S3_ACCESS_KEY_ID | ENCRYPTION_KEY | ENCRYPTION_PREVIOUS_KEYS)
      [ -z "$value" ] || printf '%s\n%s\n' "$value" "${value#*:}" ;;
  esac
done <"$ENVF" >"$T/secrets.pat"
if grep -qFf "$T/secrets.pat" "$OUT"; then fail 'une valeur secrète apparaît dans les sorties'; fi
rm -f "$T/secrets.pat"
echo
echo "ESSAI HTTPS COMPLET RÉUSSI : configuration fusionnée conforme, acme-bootstrap, $ACME, routage app/enroll, refus, en-têtes, TLS."
