#!/usr/bin/env bash
# ECSI CLOUD — laboratoire du Sprint 3B : enrôlement d'un VRAI RouterOS (CHR) par l'API
# ECSI CLOUD réelle (NestJS), avec PostgreSQL 18 et Redis réels, l'agent passerelle WireGuard
# (src/gateway.ts) et le worker de supervision (src/worker.ts).
#
#   CHR (derrière box + CGNAT) ──Internet labo── gw 203.0.113.10 (wg-gw 10.200.0.1)
#                                    │              ├─ agent passerelle (pairs, activation :8081)
#                                    │              └─ worker de supervision (REST HTTPS épinglé)
#                              cloud 203.0.113.30:8443 (front-https.mjs, AC du labo)
#                                    └─ API ECSI CLOUD (hôte, port 14000)
#   hôte ── PostgreSQL 18 (Docker, 15432), Redis (Docker, 16379)
#
# Prérequis : lab/sim/topology.sh up, lab/routeros/enrolement/pki-labo.sh, API compilée
# (pnpm --filter @ecsi/api build), Docker. Secrets générés au premier « up » dans
# $STATE/s3b (0600, ignoré par Git), jamais affichés.
#
# Usage : sudo ./labo-s3b.sh up | down
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
STATE="${LAB_STATE:-$ROOT/lab/sim/.state}"
S3B="$STATE/s3b"
API="$ROOT/apps/api"
ns() { ip netns exec "$1" "${@:2}"; }

secrets() {
  mkdir -p "$S3B" && chmod 700 "$S3B"
  [[ -f "$S3B/env" ]] && return
  rnd() { openssl rand -hex 24; }
  (
    umask 077
    {
      echo "PGM=$(rnd)"; echo "PGA=$(rnd)"; echo "PGU=$(rnd)"; echo "PGW=$(rnd)"
      echo "PGS=$(rnd)"; echo "RDS=$(rnd)"; echo "JWT=$(rnd)$(rnd)"
      echo "KEY=$(openssl rand -base64 32)"
    } >"$S3B/env"
    rnd >"$S3B/seed.pass"
  )
}

up() {
  secrets
  # shellcheck disable=SC1091
  source "$S3B/env"
  docker rm -f ecsi-s3b-pg ecsi-s3b-redis >/dev/null 2>&1 || true
  docker run -d --name ecsi-s3b-pg -p 15432:5432 \
    -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD="$PGS" -e POSTGRES_DB=ecsi \
    -e ECSI_DB_MIGRATOR_PASSWORD="$PGM" -e ECSI_DB_APP_PASSWORD="$PGA" \
    -e ECSI_DB_AUTH_PASSWORD="$PGU" -e ECSI_DB_WORKER_PASSWORD="$PGW" \
    -v "$ROOT/infra/postgres/init:/docker-entrypoint-initdb.d:ro" postgres:18-alpine >/dev/null
  docker run -d --name ecsi-s3b-redis -p 16379:6379 redis:8-alpine \
    redis-server --requirepass "$RDS" >/dev/null
  for _ in $(seq 60); do
    docker exec ecsi-s3b-pg pg_isready -U postgres -d ecsi >/dev/null 2>&1 && break
    sleep 1
  done
  sleep 3

  # Liens hôte <-> namespaces (le labo simulé n'a pas d'accès à l'hôte).
  ip link del s3b-cloud 2>/dev/null || true
  ip link del s3b-gw 2>/dev/null || true
  ip link add s3b-cloud type veth peer name s3b netns cloud
  ip addr add 10.99.0.1/30 dev s3b-cloud && ip link set s3b-cloud up
  ns cloud ip addr add 10.99.0.2/30 dev s3b && ns cloud ip link set s3b up
  ip link add s3b-gw type veth peer name s3b netns gw
  ip addr add 10.99.1.1/30 dev s3b-gw && ip link set s3b-gw up
  ns gw ip addr add 10.99.1.2/30 dev s3b && ns gw ip link set s3b up

  local db="postgres://%s:%s@%s:15432/ecsi"
  export NODE_ENV=development LOG_LEVEL=info
  export DATABASE_MIGRATOR_URL
  DATABASE_MIGRATOR_URL="$(printf "$db" ecsi_migrator "$PGM" 127.0.0.1)"
  SEED_PASSWORD="$(cat "$S3B/seed.pass")" node "$API/dist/database/migrate.js" >"$S3B/migrate.log" 2>&1
  SEED_PASSWORD="$(cat "$S3B/seed.pass")" node "$API/dist/database/seed.js" >"$S3B/seed.log" 2>&1

  local gw_public
  gw_public="$(cat "$STATE/gw/public")"
  local ca_fp
  ca_fp="$(openssl x509 -in "$STATE/pki/ca.pem" -outform der | sha256sum | cut -d' ' -f1)"
  (
    export DATABASE_URL DATABASE_AUTH_URL REDIS_URL
    DATABASE_URL="$(printf "$db" ecsi_app "$PGA" 127.0.0.1)"
    DATABASE_AUTH_URL="$(printf "$db" ecsi_auth "$PGU" 127.0.0.1)"
    REDIS_URL="redis://:$RDS@127.0.0.1:16379"
    S3_BUCKET=ecsi-labo S3_ACCESS_KEY_ID=labo S3_SECRET_ACCESS_KEY=labo-labo-labo \
      S3_ENDPOINT=http://127.0.0.1:9 JWT_ACCESS_SECRET="$JWT" ENCRYPTION_KEY="$KEY" \
      ENCRYPTION_KEY_ID=k2 API_HOST=0.0.0.0 API_PORT=14000 \
      WEB_PUBLIC_URL=https://203.0.113.30:8443 \
      ROUTER_ENROLL_PUBLIC_URL=https://203.0.113.30:8443/api/v1/routers/enroll \
      ROUTER_ENROLL_CA_URL=https://203.0.113.30:8443/ca.pem ROUTER_ENROLL_CA_FINGERPRINT="$ca_fp" \
      WG_GATEWAY_PUBLIC_KEY="$gw_public" WG_GATEWAY_ENDPOINT=203.0.113.10 WG_GATEWAY_PORT=51820 \
      setsid node "$API/dist/main.js" >"$S3B/api.log" 2>&1 &
  )
  ns cloud setsid node "$HERE/front-https.mjs" "$STATE/pki" 10.99.0.1 14000 203.0.113.30 8443 \
    >"$S3B/front.log" 2>&1 &
  (
    export DATABASE_WORKER_URL
    DATABASE_WORKER_URL="$(printf "$db" ecsi_worker "$PGW" 10.99.1.1)"
    export ENCRYPTION_KEY="$KEY" ENCRYPTION_KEY_ID=k2
    WG_INTERFACE=wg-gw GATEWAY_SYNC_INTERVAL_SECONDS=3 \
      ns gw setsid node "$API/dist/gateway.js" >"$S3B/gateway.log" 2>&1 &
    ROUTER_POLL_INTERVAL_SECONDS=15 ns gw setsid node "$API/dist/worker.js" >"$S3B/worker.log" 2>&1 &
  )
  for _ in $(seq 60); do
    curl -sf http://127.0.0.1:14000/api/v1/health >/dev/null 2>&1 && break
    sleep 1
  done
  echo "API, front HTTPS, agent passerelle et worker démarrés (journaux : $S3B/*.log)"
}

down() {
  pkill -f "$API/dist/main.js" 2>/dev/null || true
  pkill -f "$API/dist/gateway.js" 2>/dev/null || true
  pkill -f "$API/dist/worker.js" 2>/dev/null || true
  pkill -f "$HERE/front-https.mjs" 2>/dev/null || true
  ip link del s3b-cloud 2>/dev/null || true
  ip link del s3b-gw 2>/dev/null || true
  docker rm -f ecsi-s3b-pg ecsi-s3b-redis >/dev/null 2>&1 || true
}

case "${1:-}" in
  up) up ;;
  down) down ;;
  *) echo "usage: $0 up | down" >&2; exit 1 ;;
esac
