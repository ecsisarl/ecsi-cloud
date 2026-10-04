#!/bin/sh
# Crée un fichier .env de développement avec des mots de passe aléatoires.
# Usage : ./scripts/generate-dev-env.sh   (refuse d'écraser un .env existant)
set -eu
cd "$(dirname "$0")/.."

if [ -f .env ]; then
  echo ".env existe déjà : supprimez-le d'abord si vous voulez le régénérer." >&2
  exit 1
fi

rand() { openssl rand -hex 24; }

PG=$(rand); MIG=$(rand); APP=$(rand); AUTH=$(rand); WORKER=$(rand); REDIS=$(rand); S3=$(rand); SEED=$(rand)
JWT=$(openssl rand -hex 32)
KEY=$(openssl rand -base64 32)

sed \
  -e "s/devonly-postgres-password/$PG/g" \
  -e "s/devonly-migrator-password/$MIG/g" \
  -e "s/devonly-app-password/$APP/g" \
  -e "s/devonly-auth-password/$AUTH/g" \
  -e "s/devonly-worker-password/$WORKER/g" \
  -e "s/devonly-demo-password/$SEED/g" \
  -e "s/devonly-jwt-access-secret-change-me-0000/$JWT/g" \
  -e "s|devonlydevonlydevonlydevonlydevonlydevonlyA=|$KEY|g" \
  -e "s/devonly-redis-password/$REDIS/g" \
  -e "s/devonly-s3-secret-key/$S3/g" \
  .env.example > .env
chmod 600 .env
echo ".env créé avec des secrets aléatoires."
echo "Attention : si les volumes Docker existent déjà, PostgreSQL garde les anciens mots de passe."
echo "Réinitialisation complète (efface les données locales) : docker compose down -v"
