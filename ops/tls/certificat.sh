#!/bin/sh
# ECSI CLOUD — certificat HTTPS public Let's Encrypt de MyTikCentral (Sprint S3H, étape H4).
# Défi HTTP-01 par le webroot servi par Nginx (volume acme-webroot), certificat unique
# « mytikcentral » pour app.mytikcentral.com et enroll.mytikcentral.com (volume letsencrypt).
#
#   ops/tls/certificat.sh amorcer      Nginx en mode acme-bootstrap : HTTP seul (défi ACME,
#                                      503 ailleurs), sans dépendance ; à faire une seule fois,
#                                      quand aucun certificat n'existe encore
#   ops/tls/certificat.sh staging      contrôle local du webroot, puis essai Let's Encrypt
#                                      STAGING (--dry-run) : aucun certificat n'est écrit
#   ops/tls/certificat.sh production   essai staging, puis certificat de PRODUCTION
#                                      (idempotent : rien n'est demandé s'il est encore valide)
#   ops/tls/certificat.sh activer      Nginx en mode https (nginx -t d'abord), puis contrôles
#   ops/tls/certificat.sh renouveler   certbot renew, nginx -t, rechargement de Nginx (HUP)
#   ops/tls/certificat.sh etat         certificats présents et dates d'expiration
#
# Variables : celles de ops/tls/lib.sh, et ECSI_ACME_EMAIL (facultative : adresse du compte
# ACME). Essais seulement (jamais en production) : ECSI_ACME_SERVER (serveur ACME de test,
# Pebble), ECSI_ACME_INSECURE=1 (certificat du serveur de test non vérifié, exige
# ECSI_ACME_SERVER), ECSI_TLS_CACERT (AC de test pour les contrôles curl), ECSI_RENEW_FORCE=1.
#
# Ne touche ni aux autres services (--no-deps), ni au DNS, ni au pare-feu, ni à WireGuard.
# Code de sortie : 0 succès ; 1 échec ; 2 usage.
# $C, et les options produites par acme_opts / domain_opts (sans espace ni caractère spécial),
# sont à découper en mots (comme $PROD dans les essais).
# shellcheck disable=SC2086,SC2046
set -eu
# shellcheck source=lib.sh
. "$(dirname "$0")/lib.sh"

usage() {
  echo 'Usage : certificat.sh amorcer | staging | production | activer | renouveler | etat' >&2
  exit 2
}
[ $# = 1 ] || usage
ACTION=$1

[ -r "$ENV_FILE" ] || die "fichier d'environnement illisible : $ENV_FILE"
C=$(compose_cmd)
CERTBOT="$C --profile tls run --rm --no-deps -T certbot"

# Options ACME communes. Serveur de test (Pebble) : seulement si ECSI_ACME_SERVER est fourni.
acme_opts() {
  printf '%s' '--non-interactive --agree-tos'
  if [ -n "${ECSI_ACME_EMAIL:-}" ]; then
    printf ' --email %s' "$ECSI_ACME_EMAIL"
  else
    printf ' %s' '--register-unsafely-without-email'
  fi
  if [ -n "${ECSI_ACME_SERVER:-}" ]; then
    printf ' --server %s' "$ECSI_ACME_SERVER"
    [ "${ECSI_ACME_INSECURE:-0}" != 1 ] || printf ' %s' '--no-verify-ssl'
  elif [ "${ECSI_ACME_INSECURE:-0}" = 1 ]; then
    die 'ECSI_ACME_INSECURE réservé aux essais avec ECSI_ACME_SERVER'
  fi
}
domain_opts() {
  printf -- '--cert-name %s' "$CERT_NAME"
  for d in $DOMAINS; do printf ' -d %s' "$d"; done
}

cert_present() {
  $C --profile tls run --rm --no-deps -T --entrypoint test certbot \
    -s "/etc/letsencrypt/live/$CERT_NAME/fullchain.pem" >/dev/null 2>&1
}

# Le défi ACME doit être servi par Nginx pour chaque nom, en HTTP, sans redirection : on dépose
# un fichier témoin dans le webroot (comme certbot) et on le relit par Nginx en local.
check_webroot() {
  token="ecsi-controle-$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')"
  # shellcheck disable=SC2016 # $1 est développé par le shell du conteneur.
  $C --profile tls run --rm --no-deps -T --entrypoint sh certbot -c \
    'mkdir -p /var/www/acme/.well-known/acme-challenge && printf "%s" "$1" >"/var/www/acme/.well-known/acme-challenge/$1"' \
    sh "$token" >/dev/null 2>&1 || die 'dépôt du fichier témoin dans le webroot impossible'
  rc=0
  for d in $DOMAINS; do
    body=$(curl --noproxy "*" -s --max-time 10 --resolve "$d:$HTTP_PORT:127.0.0.1" \
      "http://$d:$HTTP_PORT/.well-known/acme-challenge/$token" || true)
    if [ "$body" = "$token" ]; then
      log "OK    défi ACME servi en HTTP pour $d (sans redirection)"
    else
      log "ECHEC défi ACME NON servi pour $d (Nginx démarré ? mode acme-bootstrap ou https ?)"
      rc=1
    fi
  done
  $C --profile tls run --rm --no-deps -T --entrypoint rm certbot -f \
    "/var/www/acme/.well-known/acme-challenge/$token" >/dev/null 2>&1 || true
  [ "$rc" = 0 ] || die 'webroot ACME non servi : rien n'"'"'est demandé à Let'"'"'s Encrypt'
}

staging() {
  check_webroot
  if [ -n "${ECSI_ACME_SERVER:-}" ]; then server=''; else server='--staging'; fi
  log "Let's Encrypt STAGING (--dry-run, aucun certificat écrit) : $DOMAINS"
  $CERTBOT certonly --webroot -w /var/www/acme $(domain_opts) $(acme_opts) $server --dry-run ||
    die 'essai staging en échec : corriger avant toute demande de production'
  log 'OK    essai staging réussi'
}

nginx_https_test() {
  docker run --rm --network none --add-host api:127.0.0.1 --add-host web:127.0.0.1 \
    -e NGINX_ENTRYPOINT_QUIET_LOGS=1 -v "$REPO/infra/nginx/production:/etc/nginx/ecsi:ro" \
    -v "${PROJECT}_letsencrypt:/etc/letsencrypt:ro" \
    nginx:1-alpine nginx -t -q -c /etc/nginx/ecsi/https.conf
}

case $ACTION in
  amorcer)
    if cert_present; then
      log "INFO  certificat « $CERT_NAME » déjà présent : utiliser « activer »"
      exit 0
    fi
    ECSI_NGINX_MODE=acme-bootstrap $C up -d --no-deps --no-build nginx
    log 'OK    Nginx en mode acme-bootstrap (HTTP : défi ACME seulement)'
    ;;
  staging)
    staging
    ;;
  production)
    staging
    log "Let's Encrypt PRODUCTION : $DOMAINS (idempotent : --keep-until-expiring)"
    $CERTBOT certonly --webroot -w /var/www/acme $(domain_opts) $(acme_opts) --keep-until-expiring
    cert_present || die 'certificat absent après la demande'
    log "OK    certificat « $CERT_NAME » présent ; étape suivante : certificat.sh activer"
    ;;
  activer)
    cert_present || die "certificat « $CERT_NAME » absent : certificat.sh production d'abord"
    nginx_https_test || die 'configuration https invalide : Nginx non modifié'
    ECSI_NGINX_MODE=https $C up -d --no-deps --no-build nginx
    sleep 2
    curl_tls() {
      if [ -n "${ECSI_TLS_CACERT:-}" ]; then
        curl --noproxy "*" --cacert "$ECSI_TLS_CACERT" "$@"
      else
        curl --noproxy "*" "$@"
      fi
    }
    rc=0
    for d in $DOMAINS; do
      code=$(local_http "$d" /)
      if [ "$code" = 301 ]; then
        log "OK    http://$d -> 301 vers HTTPS"
      else
        log "ECHEC http://$d : $code"
        rc=1
      fi
      if curl_tls -s -o /dev/null --max-time 10 --resolve "$d:$HTTPS_PORT:127.0.0.1" "https://$d:$HTTPS_PORT/"; then
        log "OK    https://$d : certificat vérifié"
      else
        log "ECHEC https://$d : TLS en échec"
        rc=1
      fi
    done
    [ "$rc" = 0 ] || die 'Nginx https démarré mais contrôles en échec (retour arrière : docs/DEPLOYMENT.md)'
    log 'OK    Nginx en mode https'
    ;;
  renouveler)
    force=''
    [ "${ECSI_RENEW_FORCE:-0}" != 1 ] || force='--force-renewal'
    insecure=''
    [ "${ECSI_ACME_INSECURE:-0}" != 1 ] || [ -z "${ECSI_ACME_SERVER:-}" ] || insecure='--no-verify-ssl'
    $CERTBOT renew --non-interactive $force $insecure
    $C exec -T nginx nginx -t -q -c /etc/nginx/ecsi/https.conf ||
      die 'configuration https invalide après renouvellement : Nginx NON rechargé'
    $C kill -s HUP nginx >/dev/null
    log 'OK    renouvellement contrôlé, Nginx rechargé'
    ;;
  etat)
    $CERTBOT certificates
    ;;
  *) usage ;;
esac
