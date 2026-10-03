-- ECSI CLOUD — migration 0000 : fondations de la base.
-- Exécutée par le rôle propriétaire (ecsi_migrator). Le rôle applicatif ecsi_app
-- est créé par infra/postgres/init/01-roles.sh (ou par le provisioning en production).

-- Extensions « trusted » : installables par le propriétaire de la base, sans superutilisateur.
CREATE EXTENSION IF NOT EXISTS pgcrypto;
--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS citext;
--> statement-breakpoint

-- Schéma « app » : fonctions techniques partagées par tous les modules.
CREATE SCHEMA IF NOT EXISTS app;
--> statement-breakpoint
GRANT USAGE ON SCHEMA app TO ecsi_app;
--> statement-breakpoint

-- Met à jour automatiquement updated_at (déclencheur posé sur chaque table métier).
CREATE OR REPLACE FUNCTION app.set_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
--> statement-breakpoint

-- Entreprise (tenant) de la transaction courante, positionnée par l'API avec
-- set_config('app.company_id', <uuid>, true). NULL si aucun contexte n'est défini :
-- les politiques RLS (Sprint 1) ne renvoient alors aucune ligne.
CREATE OR REPLACE FUNCTION app.current_company_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.company_id', true), '')::uuid
$$;
--> statement-breakpoint

-- Contexte super administrateur ECSI (console plateforme), tracé dans l'audit.
CREATE OR REPLACE FUNCTION app.is_platform_admin() RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT coalesce(current_setting('app.platform_admin', true), '') = 'on'
$$;
--> statement-breakpoint
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA app TO ecsi_app;
