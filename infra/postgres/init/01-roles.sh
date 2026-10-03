#!/bin/sh
# Création des rôles PostgreSQL d'ECSI CLOUD (exécuté une seule fois, à l'initialisation
# du volume, par l'image officielle postgres). Voir docs/DATABASE.md.
#
#  - ecsi_migrator : propriétaire de la base et des schémas, applique les migrations.
#  - ecsi_app      : rôle de l'API. Aucun privilège d'administration, PAS de BYPASSRLS :
#                    les politiques Row-Level Security s'appliquent toujours à lui.
set -eu

: "${ECSI_DB_MIGRATOR_PASSWORD:?ECSI_DB_MIGRATOR_PASSWORD est requis}"
: "${ECSI_DB_APP_PASSWORD:?ECSI_DB_APP_PASSWORD est requis}"

psql -v ON_ERROR_STOP=1 \
  --username "$POSTGRES_USER" \
  --dbname "$POSTGRES_DB" \
  -v migrator_password="$ECSI_DB_MIGRATOR_PASSWORD" \
  -v app_password="$ECSI_DB_APP_PASSWORD" \
  -v db_name="$POSTGRES_DB" <<'SQL'
CREATE ROLE ecsi_migrator LOGIN NOSUPERUSER NOCREATEROLE NOCREATEDB NOBYPASSRLS PASSWORD :'migrator_password';
CREATE ROLE ecsi_app LOGIN NOSUPERUSER NOCREATEROLE NOCREATEDB NOBYPASSRLS PASSWORD :'app_password';

ALTER DATABASE :"db_name" OWNER TO ecsi_migrator;
REVOKE ALL ON DATABASE :"db_name" FROM PUBLIC;
GRANT CONNECT, TEMPORARY ON DATABASE :"db_name" TO ecsi_app;

-- Personne d'autre que le propriétaire ne crée d'objets dans « public ».
ALTER SCHEMA public OWNER TO ecsi_migrator;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO ecsi_app;

-- Les tables et séquences créées par les migrations sont accessibles à l'API en
-- lecture/écriture de données uniquement (jamais DDL, jamais TRUNCATE).
ALTER DEFAULT PRIVILEGES FOR ROLE ecsi_migrator IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ecsi_app;
ALTER DEFAULT PRIVILEGES FOR ROLE ecsi_migrator IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO ecsi_app;
ALTER DEFAULT PRIVILEGES FOR ROLE ecsi_migrator
  GRANT EXECUTE ON FUNCTIONS TO ecsi_app;
SQL
