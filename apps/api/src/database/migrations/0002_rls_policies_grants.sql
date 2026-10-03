-- ECSI CLOUD — migration 0002 : isolation des entreprises (Row-Level Security) et droits.
--
-- Modèle (docs/DATABASE.md, docs/SECURITY.md) :
--  - ecsi_app  : rôle de l'API métier. Chaque requête s'exécute dans une transaction où l'API
--                positionne app.company_id et app.user_id DEPUIS LA SESSION AUTHENTIFIÉE.
--                Les politiques ci-dessous filtrent toute ligne d'une autre entreprise, en
--                lecture (USING) comme en écriture (WITH CHECK). Sans contexte : aucune ligne.
--  - ecsi_auth : rôle du seul module d'authentification (connexion, jetons, invitations).
--                Il lit les identités et appartenances avant qu'un tenant soit connu.
--                Les tables de secrets (mots de passe, sessions, MFA, jetons) lui sont
--                réservées : ecsi_app n'y a AUCUN accès.
--  - ecsi_migrator (propriétaire) : RLS activée mais non forcée, pour synchroniser le
--                catalogue des permissions et les rôles système.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ecsi_auth') THEN
    RAISE EXCEPTION 'Le rôle ecsi_auth doit exister (infra/postgres/init/01-roles.sh)';
  END IF;
END
$$;
--> statement-breakpoint

GRANT USAGE ON SCHEMA app TO ecsi_auth;
--> statement-breakpoint

-- Utilisateur authentifié de la transaction courante (set_config('app.user_id', …, true)).
CREATE OR REPLACE FUNCTION app.current_user_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.user_id', true), '')::uuid
$$;
--> statement-breakpoint
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA app TO ecsi_app, ecsi_auth;
--> statement-breakpoint

-- updated_at automatique.
CREATE TRIGGER users_set_updated_at BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();
--> statement-breakpoint
CREATE TRIGGER platform_admins_set_updated_at BEFORE UPDATE ON platform_admins
  FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();
--> statement-breakpoint
CREATE TRIGGER companies_set_updated_at BEFORE UPDATE ON companies
  FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();
--> statement-breakpoint
CREATE TRIGGER memberships_set_updated_at BEFORE UPDATE ON memberships
  FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();
--> statement-breakpoint
CREATE TRIGGER roles_set_updated_at BEFORE UPDATE ON roles
  FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 1. Tables de secrets : réservées à ecsi_auth.
-- ---------------------------------------------------------------------------
REVOKE ALL ON user_credentials, platform_admins, mfa_factors, mfa_recovery_codes,
  auth_sessions, refresh_tokens, password_reset_tokens FROM ecsi_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON user_credentials, platform_admins, mfa_factors,
  mfa_recovery_codes, auth_sessions, refresh_tokens, password_reset_tokens TO ecsi_auth;
--> statement-breakpoint
-- Défense en profondeur : RLS activée, seule ecsi_auth possède une politique.
ALTER TABLE user_credentials ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE platform_admins ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE mfa_factors ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE mfa_recovery_codes ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE auth_sessions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE refresh_tokens ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE password_reset_tokens ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY auth_all ON user_credentials TO ecsi_auth USING (true) WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY auth_all ON platform_admins TO ecsi_auth USING (true) WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY auth_all ON mfa_factors TO ecsi_auth USING (true) WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY auth_all ON mfa_recovery_codes TO ecsi_auth USING (true) WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY auth_all ON auth_sessions TO ecsi_auth USING (true) WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY auth_all ON refresh_tokens TO ecsi_auth USING (true) WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY auth_all ON password_reset_tokens TO ecsi_auth USING (true) WITH CHECK (true);
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 2. Catalogue global des permissions : lecture seule pour l'API.
-- ---------------------------------------------------------------------------
REVOKE INSERT, UPDATE, DELETE ON permissions FROM ecsi_app;
--> statement-breakpoint
GRANT SELECT ON permissions TO ecsi_auth;
--> statement-breakpoint
ALTER TABLE permissions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY read_all ON permissions FOR SELECT TO ecsi_app, ecsi_auth USING (true);
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 3. Entreprises.
-- ---------------------------------------------------------------------------
-- Création et suppression d'entreprise : hors API métier (console plateforme, Sprint 2).
REVOKE INSERT, DELETE ON companies FROM ecsi_app;
--> statement-breakpoint
GRANT SELECT ON companies TO ecsi_auth;
--> statement-breakpoint
ALTER TABLE companies ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_select ON companies FOR SELECT TO ecsi_app
  USING (id = app.current_company_id());
--> statement-breakpoint
CREATE POLICY tenant_update ON companies FOR UPDATE TO ecsi_app
  USING (id = app.current_company_id()) WITH CHECK (id = app.current_company_id());
--> statement-breakpoint
CREATE POLICY auth_select ON companies FOR SELECT TO ecsi_auth USING (true);
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 4. Utilisateurs (identité globale, partagée entre entreprises).
-- ---------------------------------------------------------------------------
-- Un utilisateur n'est visible que de lui-même et des entreprises dont il est membre.
REVOKE INSERT, DELETE ON users FROM ecsi_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON users TO ecsi_auth;
--> statement-breakpoint
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_select ON users FOR SELECT TO ecsi_app
  USING (
    id = app.current_user_id()
    OR EXISTS (
      SELECT 1 FROM memberships m
      WHERE m.user_id = users.id AND m.company_id = app.current_company_id()
    )
  );
--> statement-breakpoint
CREATE POLICY self_update ON users FOR UPDATE TO ecsi_app
  USING (id = app.current_user_id()) WITH CHECK (id = app.current_user_id());
--> statement-breakpoint
CREATE POLICY auth_all ON users TO ecsi_auth USING (true) WITH CHECK (true);
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 5. Tables rattachées à une entreprise (company_id) : isolation stricte.
-- ---------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE ON memberships TO ecsi_auth;
--> statement-breakpoint
GRANT SELECT ON roles, role_permissions, invitation_roles TO ecsi_auth;
--> statement-breakpoint
GRANT SELECT, INSERT ON membership_roles, membership_role_sites TO ecsi_auth;
--> statement-breakpoint
GRANT SELECT, UPDATE ON invitations TO ecsi_auth;
--> statement-breakpoint
ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE roles ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE role_permissions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE membership_roles ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE membership_role_sites ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE invitations ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE invitation_roles ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON memberships TO ecsi_app
  USING (company_id = app.current_company_id())
  WITH CHECK (company_id = app.current_company_id());
--> statement-breakpoint
CREATE POLICY tenant_isolation ON roles TO ecsi_app
  USING (company_id = app.current_company_id())
  WITH CHECK (company_id = app.current_company_id());
--> statement-breakpoint
CREATE POLICY tenant_isolation ON role_permissions TO ecsi_app
  USING (company_id = app.current_company_id())
  WITH CHECK (company_id = app.current_company_id());
--> statement-breakpoint
CREATE POLICY tenant_isolation ON membership_roles TO ecsi_app
  USING (company_id = app.current_company_id())
  WITH CHECK (company_id = app.current_company_id());
--> statement-breakpoint
CREATE POLICY tenant_isolation ON membership_role_sites TO ecsi_app
  USING (company_id = app.current_company_id())
  WITH CHECK (company_id = app.current_company_id());
--> statement-breakpoint
CREATE POLICY tenant_isolation ON invitations TO ecsi_app
  USING (company_id = app.current_company_id())
  WITH CHECK (company_id = app.current_company_id());
--> statement-breakpoint
CREATE POLICY tenant_isolation ON invitation_roles TO ecsi_app
  USING (company_id = app.current_company_id())
  WITH CHECK (company_id = app.current_company_id());
--> statement-breakpoint
CREATE POLICY auth_all ON memberships TO ecsi_auth USING (true) WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY auth_all ON roles TO ecsi_auth USING (true) WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY auth_all ON role_permissions TO ecsi_auth USING (true) WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY auth_all ON membership_roles TO ecsi_auth USING (true) WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY auth_all ON membership_role_sites TO ecsi_auth USING (true) WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY auth_all ON invitations TO ecsi_auth USING (true) WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY auth_all ON invitation_roles TO ecsi_auth USING (true) WITH CHECK (true);
