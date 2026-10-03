-- ECSI CLOUD — migration 0004 : isolation et droits des tables du Sprint 2, journal d'audit
-- en ajout seul et chaîné par hachage.
--
--  - Sites, groupes de sites : isolation stricte par entreprise (comme la migration 0002).
--  - Entreprises : ecsi_app ne peut modifier QUE les colonnes du profil (privilèges par
--    colonne) ; le statut, la suspension et l'identifiant (slug) sont réservés à la console
--    plateforme, qui passe par ecsi_auth (rôle sans tenant, voir ADR 0013).
--  - Journal d'audit : INSERT et SELECT uniquement pour les comptes applicatifs ; un
--    déclencheur refuse UPDATE, DELETE et TRUNCATE même au propriétaire ; un autre calcule
--    la chaîne de hachage (SHA-256) en base, ce qu'un compte applicatif ne peut pas falsifier.

-- ---------------------------------------------------------------------------
-- 1. Sites et groupes de sites.
-- ---------------------------------------------------------------------------
CREATE TRIGGER sites_set_updated_at BEFORE UPDATE ON sites
  FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();
--> statement-breakpoint
CREATE TRIGGER site_groups_set_updated_at BEFORE UPDATE ON site_groups
  FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();
--> statement-breakpoint
ALTER TABLE sites ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE site_groups ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE site_group_members ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON sites TO ecsi_app
  USING (company_id = app.current_company_id())
  WITH CHECK (company_id = app.current_company_id());
--> statement-breakpoint
CREATE POLICY tenant_isolation ON site_groups TO ecsi_app
  USING (company_id = app.current_company_id())
  WITH CHECK (company_id = app.current_company_id());
--> statement-breakpoint
CREATE POLICY tenant_isolation ON site_group_members TO ecsi_app
  USING (company_id = app.current_company_id())
  WITH CHECK (company_id = app.current_company_id());
--> statement-breakpoint
-- ecsi_auth : validation des sites d'une invitation, compteurs de la console plateforme.
GRANT SELECT ON sites, site_groups, site_group_members TO ecsi_auth;
--> statement-breakpoint
CREATE POLICY auth_select ON sites FOR SELECT TO ecsi_auth USING (true);
--> statement-breakpoint
CREATE POLICY auth_select ON site_groups FOR SELECT TO ecsi_auth USING (true);
--> statement-breakpoint
CREATE POLICY auth_select ON site_group_members FOR SELECT TO ecsi_auth USING (true);
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 2. Entreprises : profil modifiable par l'entreprise, statut réservé à la plateforme.
-- ---------------------------------------------------------------------------
REVOKE UPDATE ON companies FROM ecsi_app;
--> statement-breakpoint
GRANT UPDATE (name, legal_name, phone, whatsapp, email, address, city, country, currency,
  locale, timezone, logo_object_key, logo_content_type, settings) ON companies TO ecsi_app;
--> statement-breakpoint
GRANT INSERT, UPDATE ON companies TO ecsi_auth;
--> statement-breakpoint
CREATE POLICY auth_insert ON companies FOR INSERT TO ecsi_auth WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY auth_update ON companies FOR UPDATE TO ecsi_auth USING (true) WITH CHECK (true);
--> statement-breakpoint
-- Création d'une entreprise par la plateforme : rôles système et invitation du premier
-- administrateur.
GRANT INSERT, UPDATE ON roles TO ecsi_auth;
--> statement-breakpoint
GRANT INSERT, DELETE ON role_permissions TO ecsi_auth;
--> statement-breakpoint
GRANT INSERT ON invitations, invitation_roles TO ecsi_auth;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 3. Journal d'audit.
-- ---------------------------------------------------------------------------
-- Empreinte d'un événement : tableau JSON de tous les champs (les NULL sont explicites,
-- l'ordre est fixe), précédé de l'empreinte de l'événement précédent de la même chaîne.
CREATE OR REPLACE FUNCTION app.audit_event_hash(e public.audit_events) RETURNS bytea
LANGUAGE sql STABLE
SET search_path = pg_catalog, public
AS $$
  SELECT public.digest(
    convert_to(
      jsonb_build_array(
        encode(e.prev_hash, 'hex'),
        e.id,
        e.chain_key,
        e.chain_seq,
        to_char(e.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
        e.company_id,
        e.actor_type,
        e.actor_id,
        e.actor_label,
        to_jsonb(e.actor_roles),
        e.action,
        e.resource_type,
        e.resource_id,
        e.site_id,
        e.result,
        e.ip,
        e.user_agent,
        e.request_id,
        e.details
      )::text,
      'UTF8'
    ),
    'sha256'
  )
$$;
--> statement-breakpoint
-- Chaînage à l'insertion. SECURITY DEFINER (propriétaire : ecsi_migrator) pour lire le
-- dernier maillon de la chaîne quelle que soit la RLS de l'appelant. Les valeurs de chaînage
-- et l'horodatage fournis par l'appelant sont toujours écrasés.
CREATE OR REPLACE FUNCTION app.audit_events_chain() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  previous record;
BEGIN
  NEW.chain_key := coalesce(NEW.company_id::text, 'platform');
  NEW.occurred_at := clock_timestamp();
  PERFORM pg_advisory_xact_lock(hashtextextended('ecsi:audit:' || NEW.chain_key, 0));
  SELECT a.chain_seq, a.hash INTO previous
    FROM public.audit_events a
   WHERE a.chain_key = NEW.chain_key
   ORDER BY a.chain_seq DESC
   LIMIT 1;
  NEW.chain_seq := coalesce(previous.chain_seq, 0) + 1;
  NEW.prev_hash := previous.hash;
  NEW.hash := app.audit_event_hash(NEW);
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER audit_events_chain BEFORE INSERT ON audit_events
  FOR EACH ROW EXECUTE FUNCTION app.audit_events_chain();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.audit_events_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Le journal d''audit est en ajout seul : % refusé', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END
$$;
--> statement-breakpoint
CREATE TRIGGER audit_events_no_update_delete BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION app.audit_events_append_only();
--> statement-breakpoint
CREATE TRIGGER audit_events_no_truncate BEFORE TRUNCATE ON audit_events
  FOR EACH STATEMENT EXECUTE FUNCTION app.audit_events_append_only();
--> statement-breakpoint
-- Vérification d'une chaîne : renvoie les numéros des maillons invalides (vide si intacte).
CREATE OR REPLACE FUNCTION app.audit_verify_chain(p_chain_key text)
RETURNS TABLE (chain_seq bigint)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  WITH ordered AS (
    SELECT e AS event,
           e.chain_seq AS seq,
           e.prev_hash,
           e.hash,
           lag(e.hash) OVER (ORDER BY e.chain_seq) AS expected_prev,
           lag(e.chain_seq) OVER (ORDER BY e.chain_seq) AS previous_seq
      FROM public.audit_events e
     WHERE e.chain_key = p_chain_key
  )
  SELECT seq FROM ordered
   WHERE prev_hash IS DISTINCT FROM expected_prev
      OR hash <> app.audit_event_hash(event)
      OR seq <> coalesce(previous_seq, 0) + 1
   ORDER BY seq
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.audit_verify_chain(text) FROM PUBLIC, ecsi_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.audit_verify_chain(text) TO ecsi_auth;
--> statement-breakpoint
REVOKE ALL ON audit_events FROM ecsi_app, ecsi_auth;
--> statement-breakpoint
GRANT SELECT, INSERT ON audit_events TO ecsi_app, ecsi_auth;
--> statement-breakpoint
ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
-- Une entreprise ne lit que ses événements, et n'écrit qu'au nom de l'utilisateur
-- authentifié de la transaction (impossible d'attribuer une action à quelqu'un d'autre).
CREATE POLICY tenant_select ON audit_events FOR SELECT TO ecsi_app
  USING (company_id = app.current_company_id());
--> statement-breakpoint
CREATE POLICY tenant_insert ON audit_events FOR INSERT TO ecsi_app
  WITH CHECK (
    company_id = app.current_company_id()
    AND actor_type = 'USER'
    AND actor_id = app.current_user_id()
  );
--> statement-breakpoint
CREATE POLICY auth_select ON audit_events FOR SELECT TO ecsi_auth USING (true);
--> statement-breakpoint
CREATE POLICY auth_insert ON audit_events FOR INSERT TO ecsi_auth WITH CHECK (true);
