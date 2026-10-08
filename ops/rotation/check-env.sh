#!/bin/sh
# ECSI CLOUD — contrôle d'un fichier d'environnement SANS AFFICHER AUCUNE VALEUR
# (Sprint S3H, étape H3, outillage D.3). À lancer avant et après chaque sous-étape H3.
#
#   ops/rotation/check-env.sh <fichier .env>                 contrôle complet
#   ops/rotation/check-env.sh <fichier> --partiel            seulement les variables présentes
#                                                           (fichier de nouvelles valeurs)
#   ops/rotation/check-env.sh <fichier> --comparer <autre>   mêmes valeurs ? (coffre, gateway.env)
#   ops/rotation/check-env.sh <fichier> --conteneurs [projet]
#                                                           valeurs réellement chargées par les
#                                                           conteneurs en cours (défaut ecsi-cloud)
#
# Contrôles : présence, une seule définition, aucune valeur « devonly » (sur le VPS, le Compose
# de base retomberait silencieusement sur le mot de passe public du dépôt), longueur et
# caractères (les mots de passe sont insérés dans des URL postgres:// et redis://), clés de
# chiffrement de 32 octets, identifiants valides et distincts, aucune clé recopiée sous deux
# identifiants, droits du fichier. Pour chaque secret : empreinte courte (KCV), jamais la valeur.
#
# Code de sortie : 0 tout est conforme ; 1 au moins un ECHEC ; 2 usage.
set -eu
# shellcheck source=lib.sh
. "$(dirname "$0")/lib.sh"

usage() {
  echo 'Usage : check-env.sh <fichier> [--partiel] [--comparer <fichier>] [--conteneurs [projet]]' >&2
  exit 2
}

[ $# -ge 1 ] || usage
FILE=$1
shift
PARTIAL=0
COMPARE=''
PROJECT=''
while [ $# -gt 0 ]; do
  case $1 in
    --partiel) PARTIAL=1 ;;
    --comparer) [ $# -ge 2 ] || usage; COMPARE=$2; shift ;;
    --conteneurs)
      PROJECT=ecsi-cloud
      if [ $# -ge 2 ] && [ "${2#--}" = "$2" ]; then PROJECT=$2; shift; fi ;;
    *) usage ;;
  esac
  shift
done
[ -r "$FILE" ] || die "fichier illisible : $FILE"
[ -z "$COMPARE" ] || [ -r "$COMPARE" ] || die "fichier illisible : $COMPARE"

FAILS=0
okl() { printf 'OK    %s\n' "$*"; }
info() { printf 'INFO  %s\n' "$*"; }
bad() { printf 'ECHEC %s\n' "$*"; FAILS=$((FAILS + 1)); }

PASSWORDS='POSTGRES_PASSWORD ECSI_DB_MIGRATOR_PASSWORD ECSI_DB_APP_PASSWORD ECSI_DB_AUTH_PASSWORD ECSI_DB_WORKER_PASSWORD REDIS_PASSWORD'
OTHERS='JWT_ACCESS_SECRET S3_ACCESS_KEY_ID S3_SECRET_ACCESS_KEY'
KEY_ID_RE='^[a-z0-9][a-z0-9-]{0,15}$'

# Contrôle commun : définie une seule fois, non vide, sans « devonly ». Renvoie 1 si absente.
present() {
  n=$(env_count "$FILE" "$1")
  if [ "$n" = 0 ]; then
    [ "$PARTIAL" = 1 ] || bad "$1 : absente (le Compose de base retomberait sur une valeur par défaut)"
    return 1
  fi
  [ "$n" = 1 ] || bad "$1 : définie $n fois (ambigu)"
  v=$(env_get "$FILE" "$1")
  if [ -z "$v" ]; then bad "$1 : vide"; return 1; fi
  case $v in *devonly*) bad "$1 : valeur de développement « devonly » (publique)"; return 1 ;; esac
  return 0
}

# --- Droits du fichier
mode=$(stat -c '%a' "$FILE")
case $mode in
  600 | 400) okl "droits du fichier : $mode" ;;
  *) bad "droits du fichier : $mode (600 attendu : lisible par son seul propriétaire)" ;;
esac

# --- Mots de passe (insérés dans des URL : caractères sûrs uniquement)
for name in $PASSWORDS; do
  present "$name" || continue
  v=$(env_get "$FILE" "$name")
  if ! printf '%s' "$v" | grep -Eq '^[A-Za-z0-9._~-]{24,}$'; then
    bad "$name : 24 caractères minimum parmi A-Z a-z 0-9 . _ ~ - (inséré dans une URL)"
    continue
  fi
  okl "$name : conforme (${#v} caractères, KCV $(kcv "$v"))"
done

# --- Autres secrets
for name in $OTHERS; do
  present "$name" || continue
  v=$(env_get "$FILE" "$name")
  min=16
  [ "$name" != JWT_ACCESS_SECRET ] || min=32
  if [ "${#v}" -lt "$min" ]; then
    bad "$name : $min caractères minimum"
    continue
  fi
  okl "$name : conforme (${#v} caractères, KCV $(kcv "$v"))"
done

# --- Mots de passe tous différents (une copie entre deux rôles annulerait leur séparation)
seen=''
for name in $PASSWORDS JWT_ACCESS_SECRET; do
  [ "$(env_count "$FILE" "$name")" != 0 ] || continue
  k=$(kcv "$(env_get "$FILE" "$name")")
  case " $seen " in *" $k "*) bad "$name : même valeur qu'une autre variable" ;; esac
  seen="$seen $k"
done

# --- Clés de chiffrement
key_ok() { # key_ok <libellé> <base64>
  if ! printf '%s' "$2" | grep -Eq '^[A-Za-z0-9+/]{43}=?$' || [ "$(b64_len "$2")" != 32 ]; then
    bad "$1 : 32 octets en base64 attendus"
    return 1
  fi
}
ids=''
kcvs=''
add_key() { # add_key <id> <base64> <rôle>
  case " $ids " in *" $1 "*) bad "clé $1 : identifiant en double" ;; esac
  k=$(kcv "$2")
  case " $kcvs " in *" $k "*) bad "clé $1 : même valeur qu'une autre clé (recopie sous un autre identifiant)" ;; esac
  ids="$ids $1"
  kcvs="$kcvs $k"
  okl "clé $1 ($3) : 32 octets, KCV $k"
}
if present ENCRYPTION_KEY; then
  active=$(env_get "$FILE" ENCRYPTION_KEY)
  if present ENCRYPTION_KEY_ID; then
    active_id=$(env_get "$FILE" ENCRYPTION_KEY_ID)
  else
    active_id=''
  fi
  if [ -n "$active_id" ] && ! printf '%s' "$active_id" | grep -Eq "$KEY_ID_RE"; then
    bad "ENCRYPTION_KEY_ID : identifiant invalide"
  elif [ -n "$active_id" ] && key_ok "clé active $active_id" "$active"; then
    add_key "$active_id" "$active" active
  fi
fi
previous=$(env_get "$FILE" ENCRYPTION_PREVIOUS_KEYS)
[ "$(env_count "$FILE" ENCRYPTION_PREVIOUS_KEYS)" -le 1 ] || bad 'ENCRYPTION_PREVIOUS_KEYS : définie plusieurs fois (ambigu)'
if [ -n "$previous" ]; then
  old_ifs=$IFS
  IFS=','
  for entry in $previous; do
    IFS=$old_ifs
    id=${entry%%:*}
    value=${entry#*:}
    if [ "$id" = "$entry" ] || ! printf '%s' "$id" | grep -Eq "$KEY_ID_RE"; then
      bad 'ENCRYPTION_PREVIOUS_KEYS : format « id:base64,… » attendu'
    elif key_ok "ancienne clé $id" "$value"; then
      add_key "$id" "$value" ancienne
    fi
    IFS=','
  done
  IFS=$old_ifs
fi
if [ -n "${active_id:-}" ]; then
  olds=''
  for id in $ids; do
    [ "$id" = "$active_id" ] || olds="${olds:+$olds, }$id"
  done
  info "clé active : $active_id ; anciennes clés : ${olds:-aucune}"
fi

# --- Comparaison avec un autre fichier (coffre, gateway.env) : mêmes valeurs ?
compare_value() { # compare_value <libellé> <valeur ici> <valeur là-bas>
  if [ -z "$3" ]; then return 0; fi
  if [ "$(kcv "$2")" = "$(kcv "$3")" ]; then okl "$1 : identique dans les deux fichiers"; else bad "$1 : DIFFÉRENT entre les deux fichiers"; fi
}
keys_of() { # keys_of <fichier> → lignes « id base64 »
  aid=$(env_get "$1" ENCRYPTION_KEY_ID)
  [ -z "$(env_get "$1" ENCRYPTION_KEY)" ] || printf '%s %s\n' "${aid:-k1}" "$(env_get "$1" ENCRYPTION_KEY)"
  env_get "$1" ENCRYPTION_PREVIOUS_KEYS | tr ',' '\n' | sed -n 's/^\([^:]*\):\(.*\)$/\1 \2/p'
}
if [ -n "$COMPARE" ]; then
  info "comparaison avec $COMPARE"
  for name in $PASSWORDS $OTHERS; do
    [ "$(env_count "$FILE" "$name")" != 0 ] || continue
    compare_value "$name" "$(env_get "$FILE" "$name")" "$(env_get "$COMPARE" "$name")"
  done
  # gateway.env : mot de passe ecsi_worker inclus dans DATABASE_WORKER_URL.
  url=$(env_get "$COMPARE" DATABASE_WORKER_URL)
  if [ -n "$url" ] && [ "$(env_count "$FILE" ECSI_DB_WORKER_PASSWORD)" != 0 ]; then
    compare_value 'ECSI_DB_WORKER_PASSWORD (DATABASE_WORKER_URL)' \
      "$(env_get "$FILE" ECSI_DB_WORKER_PASSWORD)" "$(url_password "$url")"
  fi
  there=$(keys_of "$COMPARE")
  keys_of "$FILE" | while read -r id value; do
    other=$(printf '%s\n' "$there" | sed -n "s/^$id //p" | head -n 1)
    if [ -z "$other" ]; then
      printf 'INFO  clé %s : absente de %s\n' "$id" "$COMPARE"
    elif [ "$(kcv "$value")" = "$(kcv "$other")" ]; then
      printf 'OK    clé %s : identique dans les deux fichiers\n' "$id"
    else
      printf 'ECHEC clé %s : DIFFÉRENTE entre les deux fichiers\n' "$id"
    fi
  done >"${TMPDIR:-/tmp}/check-env.$$"
  cat "${TMPDIR:-/tmp}/check-env.$$"
  if grep -q '^ECHEC' "${TMPDIR:-/tmp}/check-env.$$"; then FAILS=$((FAILS + 1)); fi
  rm -f "${TMPDIR:-/tmp}/check-env.$$"
fi

# --- Valeurs réellement chargées par les conteneurs en cours (redémarrage oublié ?)
container_of() {
  docker ps -q --filter "label=com.docker.compose.project=$PROJECT" \
    --filter "label=com.docker.compose.service=$1" | head -n 1
}
# La valeur ne sort du conteneur que par un tube vers ce shell ; seul le NOM est un argument.
in_container() { docker exec "$1" printenv "$2" 2>/dev/null || true; }
check_container() { # check_container <service> <variable du conteneur> <variable du fichier> [url]
  c=$(container_of "$1")
  [ -n "$c" ] || return 0
  [ "$(env_count "$FILE" "$3")" != 0 ] || return 0
  got=$(in_container "$c" "$2")
  [ "${4:-}" != url ] || got=$(url_password "$got")
  if [ "$(kcv "$got")" = "$(kcv "$(env_get "$FILE" "$3")")" ]; then
    okl "conteneur $1 : $2 à jour"
  else
    bad "conteneur $1 : $2 DIFFÉRENT du fichier (conteneur non redémarré ?)"
  fi
}
if [ -n "$PROJECT" ]; then
  command -v docker >/dev/null 2>&1 || die 'docker introuvable'
  info "conteneurs du projet $PROJECT"
  for svc in api worker gateway keys-rotate; do
    check_container "$svc" ENCRYPTION_KEY ENCRYPTION_KEY
    check_container "$svc" ENCRYPTION_KEY_ID ENCRYPTION_KEY_ID
    check_container "$svc" ENCRYPTION_PREVIOUS_KEYS ENCRYPTION_PREVIOUS_KEYS
  done
  check_container api JWT_ACCESS_SECRET JWT_ACCESS_SECRET
  check_container api DATABASE_URL ECSI_DB_APP_PASSWORD url
  check_container api DATABASE_AUTH_URL ECSI_DB_AUTH_PASSWORD url
  check_container api REDIS_URL REDIS_PASSWORD url
  check_container worker DATABASE_WORKER_URL ECSI_DB_WORKER_PASSWORD url
  check_container gateway DATABASE_WORKER_URL ECSI_DB_WORKER_PASSWORD url
  check_container redis REDIS_PASSWORD REDIS_PASSWORD
fi

echo
if [ "$FAILS" = 0 ]; then
  echo 'RESULTAT : conforme (aucune valeur affichée).'
else
  echo "RESULTAT : $FAILS ECHEC(s) (aucune valeur affichée)."
  exit 1
fi
