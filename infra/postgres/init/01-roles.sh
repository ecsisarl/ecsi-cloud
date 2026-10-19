#!/bin/sh
# Création des rôles PostgreSQL d'ECSI CLOUD (exécuté une seule fois, à l'initialisation
# du volume, par l'image officielle postgres). Voir docs/DATABASE.md.
#
#  - ecsi_migrator : propriétaire de la base et des schémas, applique les migrations.
#  - ecsi_app      : rôle de l'API. Aucun privilège d'administration, PAS de BYPASSRLS :
#                    les politiques Row-Level Security s'appliquent toujours à lui.
#  - ecsi_auth     : rôle du seul module d'authentification (identifiants, sessions, jetons).
#                    Pas de BYPASSRLS : ses accès sont définis table par table par les migrations.
#  - ecsi_worker   : rôle du worker de supervision MikroTik (Sprint 3A). Pas de BYPASSRLS,
#                    aucun privilège par défaut : la migration 0005 lui accorde la seule table
#                    routers (lecture, et écriture des colonnes de supervision uniquement).
#  - ecsi_radius   : rôle de FreeRADIUS (lot B). Pas de BYPASSRLS, aucun droit sur les tables :
#                    la migration 0008 lui accorde EXECUTE sur les seules fonctions radius.*.
set -eu

: "${ECSI_DB_MIGRATOR_PASSWORD:?ECSI_DB_MIGRATOR_PASSWORD est requis}"
: "${ECSI_DB_APP_PASSWORD:?ECSI_DB_APP_PASSWORD est requis}"
: "${ECSI_DB_AUTH_PASSWORD:?ECSI_DB_AUTH_PASSWORD est requis}"
: "${ECSI_DB_WORKER_PASSWORD:?ECSI_DB_WORKER_PASSWORD est requis}"
# ecsi_radius : créé si ECSI_DB_RADIUS_PASSWORD est fourni (sinon la migration 0008 le réclame,
# création manuelle : docs/DEPLOYMENT.md, « Rôle ecsi_radius »).
export ECSI_DB_RADIUS_PASSWORD="${ECSI_DB_RADIUS_PASSWORD:-}"

# Mots de passe lus dans l'environnement par psql (\getenv), jamais passés en argument (ps) ;
# journalisation des requêtes neutralisée pour la session (S3H-H3) : même un serveur configuré
# avec log_statement=all n'écrit pas les CREATE ROLE … PASSWORD dans son journal.
psql -v ON_ERROR_STOP=1 \
  --username "$POSTGRES_USER" \
  --dbname "$POSTGRES_DB" \
  -v db_name="$POSTGRES_DB" <<'SQL'
SET log_statement = 'none';
SET log_min_error_statement = 'panic';
SET log_min_duration_statement = -1;
\getenv migrator_password ECSI_DB_MIGRATOR_PASSWORD
\getenv app_password ECSI_DB_APP_PASSWORD
\getenv auth_password ECSI_DB_AUTH_PASSWORD
\getenv worker_password ECSI_DB_WORKER_PASSWORD
\getenv radius_password ECSI_DB_RADIUS_PASSWORD
CREATE ROLE ecsi_migrator LOGIN NOSUPERUSER NOCREATEROLE NOCREATEDB NOBYPASSRLS PASSWORD :'migrator_password';
CREATE ROLE ecsi_app LOGIN NOSUPERUSER NOCREATEROLE NOCREATEDB NOBYPASSRLS PASSWORD :'app_password';
CREATE ROLE ecsi_auth LOGIN NOSUPERUSER NOCREATEROLE NOCREATEDB NOBYPASSRLS PASSWORD :'auth_password';
CREATE ROLE ecsi_worker LOGIN NOSUPERUSER NOCREATEROLE NOCREATEDB NOBYPASSRLS PASSWORD :'worker_password';
SELECT :'radius_password' <> '' AS with_radius \gset
\if :with_radius
CREATE ROLE ecsi_radius LOGIN NOSUPERUSER NOCREATEROLE NOCREATEDB NOBYPASSRLS PASSWORD :'radius_password';
GRANT CONNECT ON DATABASE :"db_name" TO ecsi_radius;
\endif

ALTER DATABASE :"db_name" OWNER TO ecsi_migrator;
REVOKE ALL ON DATABASE :"db_name" FROM PUBLIC;
GRANT CONNECT, TEMPORARY ON DATABASE :"db_name" TO ecsi_app;
GRANT CONNECT ON DATABASE :"db_name" TO ecsi_auth, ecsi_worker;

-- Personne d'autre que le propriétaire ne crée d'objets dans « public ».
ALTER SCHEMA public OWNER TO ecsi_migrator;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO ecsi_app, ecsi_auth;

-- Les tables et séquences créées par les migrations sont accessibles à l'API en
-- lecture/écriture de données uniquement (jamais DDL, jamais TRUNCATE).
ALTER DEFAULT PRIVILEGES FOR ROLE ecsi_migrator IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ecsi_app;
ALTER DEFAULT PRIVILEGES FOR ROLE ecsi_migrator IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO ecsi_app;
ALTER DEFAULT PRIVILEGES FOR ROLE ecsi_migrator
  GRANT EXECUTE ON FUNCTIONS TO ecsi_app;
SQL
