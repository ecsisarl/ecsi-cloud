#!/bin/sh
# Génère un fichier d'environnement de TEST pour la surcouche de production
# (docker-compose.prod.yml) : secrets aléatoires, URL locales, SMTP fictif.
# Sert à la CI et aux essais locaux ; ne convient pas à un vrai déploiement (URL, SMTP).
# Usage : ./scripts/generate-prod-test-env.sh <fichier>   (refuse d'écraser ; n'affiche aucune valeur)
set -eu

out=${1:?Usage : generate-prod-test-env.sh <fichier>}
if [ -e "$out" ]; then
  echo "$out existe déjà : choisissez un autre fichier." >&2
  exit 1
fi

rand() { openssl rand -hex 24; }

umask 077
cat > "$out" <<ENV
POSTGRES_PASSWORD=$(rand)
ECSI_DB_MIGRATOR_PASSWORD=$(rand)
ECSI_DB_APP_PASSWORD=$(rand)
ECSI_DB_AUTH_PASSWORD=$(rand)
ECSI_DB_WORKER_PASSWORD=$(rand)
REDIS_PASSWORD=$(rand)
S3_BUCKET=ecsi-prod-test
S3_ACCESS_KEY_ID=ecsi-$(openssl rand -hex 8)
S3_SECRET_ACCESS_KEY=$(rand)
JWT_ACCESS_SECRET=$(openssl rand -hex 32)
ENCRYPTION_KEY=$(openssl rand -base64 32)
ENCRYPTION_KEY_ID=k1
WEB_PUBLIC_URL=https://app.example.test
CORS_ORIGINS=https://app.example.test
SMTP_HOST=smtp.invalid
SMTP_PORT=587
SMTP_FROM=ECSI CLOUD <no-reply@example.invalid>
ENV
echo "$out créé (secrets de test aléatoires, droits 600)."
