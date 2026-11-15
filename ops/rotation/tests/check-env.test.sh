#!/bin/sh
# ECSI CLOUD — tests de ops/rotation/check-env.sh (Sprint S3H, étape H3, D.3 ; CI et local).
# Fichiers d'environnement de TEST (secrets aléatoires) ; vérifie chaque contrôle et qu'aucune
# valeur n'apparaît jamais dans la sortie.
#   ops/rotation/tests/check-env.test.sh
set -eu

REPO=$(cd "$(dirname "$0")/../../.." && pwd)
CHECK=$REPO/ops/rotation/check-env.sh
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
PASS=0

fail() { echo "ECHEC DU TEST : $*" >&2; exit 1; }
# Toutes les valeurs du fichier (et les clés de ENCRYPTION_PREVIOUS_KEYS) absentes de la sortie.
no_values_in() {
  while IFS='=' read -r key value; do
    case $key in ENCRYPTION_KEY_ID | S3_BUCKET | WEB_PUBLIC_URL | CORS_ORIGINS | SMTP_* | '') continue ;; esac
    for part in $(printf '%s' "$value" | tr ',' ' '); do
      v=${part#*:}
      [ "${#v}" -lt 12 ] || ! grep -qF -- "$v" "$2" || fail "valeur de $key dans la sortie"
    done
  done <"$1"
}
# expect <code attendu> <motif attendu> <fichier> [options…]
expect() {
  want=$1 pattern=$2
  shift 2
  rc=0
  "$CHECK" "$@" >"$T/out" 2>&1 || rc=$?
  [ "$rc" = "$want" ] || { cat "$T/out" >&2; fail "code $rc au lieu de $want ($pattern)"; }
  grep -qF -- "$pattern" "$T/out" || { cat "$T/out" >&2; fail "« $pattern » absent"; }
  no_values_in "$1" "$T/out"
  PASS=$((PASS + 1))
}
fresh() { rm -f "$T/env"; "$REPO/scripts/generate-prod-test-env.sh" "$T/env" >/dev/null; }
set_var() { grep -v "^$1=" "$T/env" >"$T/env.tmp" || true; printf '%s=%s\n' "$1" "$2" >>"$T/env.tmp"; mv "$T/env.tmp" "$T/env"; chmod 600 "$T/env"; }
k() { openssl rand -base64 32; }

fresh
K3=$(k)
K2=$(k)
set_var ENCRYPTION_KEY_ID k4
set_var ENCRYPTION_PREVIOUS_KEYS "k3:$K3,k2:$K2"
expect 0 'RESULTAT : conforme' "$T/env"
expect 0 'clé active : k4 ; anciennes clés : k3, k2' "$T/env"
expect 0 'ECSI_DB_APP_PASSWORD : conforme (48 caractères, KCV ' "$T/env"

# Variable absente → ECHEC (repli silencieux sur devonly dans le Compose de base).
grep -v '^REDIS_PASSWORD=' "$T/env" >"$T/env2"; chmod 600 "$T/env2"
expect 1 'REDIS_PASSWORD : absente' "$T/env2"
# … mais acceptée en mode partiel.
expect 0 'RESULTAT : conforme' "$T/env2" --partiel

fresh; set_var REDIS_PASSWORD devonly-redis-password
expect 1 'REDIS_PASSWORD : valeur de développement « devonly »' "$T/env"
fresh; printf 'ECSI_DB_APP_PASSWORD=%s\n' "$(openssl rand -hex 24)" >>"$T/env"
expect 1 'ECSI_DB_APP_PASSWORD : définie 2 fois' "$T/env"
fresh; set_var ECSI_DB_AUTH_PASSWORD "abc@def:ghi/jkl#mno-pqrstuvwx"
expect 1 'ECSI_DB_AUTH_PASSWORD : 24 caractères minimum parmi' "$T/env"
fresh; set_var ECSI_DB_WORKER_PASSWORD "$(sed -n 's/^ECSI_DB_APP_PASSWORD=//p' "$T/env")"
expect 1 'ECSI_DB_WORKER_PASSWORD : même valeur qu' "$T/env"
fresh; set_var JWT_ACCESS_SECRET court
expect 1 'JWT_ACCESS_SECRET : 32 caractères minimum' "$T/env"
fresh; set_var ENCRYPTION_KEY "$(openssl rand -base64 31)"
expect 1 'clé active k1 : 32 octets en base64 attendus' "$T/env"
fresh; set_var ENCRYPTION_KEY_ID 'K4!'
expect 1 'ENCRYPTION_KEY_ID : identifiant invalide' "$T/env"
fresh; set_var ENCRYPTION_PREVIOUS_KEYS "k1:$(k)"
expect 1 'clé k1 : identifiant en double' "$T/env"
fresh; set_var ENCRYPTION_KEY_ID k4; set_var ENCRYPTION_PREVIOUS_KEYS "k3:$(sed -n 's/^ENCRYPTION_KEY=//p' "$T/env")"
expect 1 'clé k3 : même valeur qu' "$T/env"
fresh; set_var ENCRYPTION_PREVIOUS_KEYS "sans-deux-points"
expect 1 'ENCRYPTION_PREVIOUS_KEYS : format' "$T/env"
fresh; chmod 644 "$T/env"
expect 1 'droits du fichier : 644' "$T/env"

# Comparaison : la clé k3 active dans un fichier, ancienne clé dans l'autre → identique.
fresh; set_var ENCRYPTION_KEY_ID k3; set_var ENCRYPTION_KEY "$K3"; set_var ENCRYPTION_PREVIOUS_KEYS "k2:$K2"
cp -p "$T/env" "$T/avant"
set_var ENCRYPTION_KEY_ID k4; set_var ENCRYPTION_KEY "$(k)"; set_var ENCRYPTION_PREVIOUS_KEYS "k3:$K3,k2:$K2"
expect 0 'OK    clé k3 : identique dans les deux fichiers' "$T/env" --comparer "$T/avant"
expect 0 'INFO  clé k4 : absente de' "$T/env" --comparer "$T/avant"
# k3 mal recopiée → ECHEC.
cp -p "$T/env" "$T/faux"
sed -i "s#k3:$K3#k3:$(k)#" "$T/faux"
expect 1 'ECHEC clé k3 : DIFFÉRENTE entre les deux fichiers' "$T/env" --comparer "$T/faux"
# gateway.env : mot de passe ecsi_worker dans DATABASE_WORKER_URL.
W=$(sed -n 's/^ECSI_DB_WORKER_PASSWORD=//p' "$T/env")
printf 'DATABASE_WORKER_URL=postgres://ecsi_worker:%s@127.0.0.1:5432/ecsi\nENCRYPTION_KEY_ID=k4\n' "$W" >"$T/gw"
printf 'ENCRYPTION_KEY=%s\nENCRYPTION_PREVIOUS_KEYS=k3:%s,k2:%s\n' "$(sed -n 's/^ENCRYPTION_KEY=//p' "$T/env")" "$K3" "$K2" >>"$T/gw"
expect 0 'OK    ECSI_DB_WORKER_PASSWORD (DATABASE_WORKER_URL) : identique' "$T/env" --comparer "$T/gw"
printf 'DATABASE_WORKER_URL=postgres://ecsi_worker:%s@127.0.0.1:5432/ecsi\n' "$(openssl rand -hex 24)" >>"$T/gw"
expect 1 'ECHEC ECSI_DB_WORKER_PASSWORD (DATABASE_WORKER_URL) : DIFFÉRENT' "$T/env" --comparer "$T/gw"

# Usage.
rc=0; "$CHECK" >/dev/null 2>&1 || rc=$?; [ "$rc" = 2 ] || fail "usage : code $rc"
rc=0; "$CHECK" "$T/env" --inconnu >/dev/null 2>&1 || rc=$?; [ "$rc" = 2 ] || fail "option inconnue : code $rc"

echo "check-env.sh : $PASS contrôles réussis, aucune valeur affichée."
