-- ECSI CLOUD — migration 0009 : compte d'écriture RouterOS « ecsi-cfg » (lot B,
-- provisionnement Hotspot). Additive : aucune table existante n'est modifiée.
--
--  - router_config_accounts : une ligne par routeur ; jeton d'activation à usage unique
--    (empreinte SHA-256, expirant) et mot de passe du compte ecsi-cfg CHIFFRÉ (SecretBox v2,
--    AAD router:<entreprise>:<routeur>:config-password), reçu par le tunnel WireGuard.
--  - ecsi_app    : émet un jeton (script d'activation) et lit l'état (jamais le chiffré ni
--                  l'empreinte du jeton : privilèges par colonne) ; RLS par entreprise.
--  - ecsi_worker : lit le chiffré des seuls routeurs actifs (réconciliation Hotspot) ;
--                  l'agent passerelle (même rôle) active le compte par des fonctions dédiées.
--  - ecsi_auth, ecsi_radius : aucun accès.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ecsi_worker') THEN
    RAISE EXCEPTION 'Le rôle ecsi_worker doit exister (migration 0005)';
  END IF;
END
$$;
--> statement-breakpoint
CREATE TABLE "router_config_accounts" (
	"router_id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"username" text,
	"password_encrypted" text,
	"activated_at" timestamp with time zone,
	"token_hash" "bytea",
	"token_expires_at" timestamp with time zone,
	"token_created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "router_config_accounts_token_check" CHECK (("router_config_accounts"."token_hash" is null) = ("router_config_accounts"."token_expires_at" is null) and ("router_config_accounts"."token_hash" is null or octet_length("router_config_accounts"."token_hash") = 32)),
	CONSTRAINT "router_config_accounts_password_check" CHECK (("router_config_accounts"."password_encrypted" is null) = ("router_config_accounts"."activated_at" is null) and ("router_config_accounts"."password_encrypted" is null) = ("router_config_accounts"."username" is null) and ("router_config_accounts"."password_encrypted" is null or "router_config_accounts"."password_encrypted" like 'v2:%') and ("router_config_accounts"."username" is null or "router_config_accounts"."username" ~ '^[A-Za-z0-9._-]{1,64}$'))
);
--> statement-breakpoint
ALTER TABLE "router_config_accounts" ADD CONSTRAINT "router_config_accounts_router_fk" FOREIGN KEY ("company_id","router_id") REFERENCES "public"."routers"("company_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "router_config_accounts_token_hash_key" ON "router_config_accounts" USING btree ("token_hash");
--> statement-breakpoint
CREATE TRIGGER router_config_accounts_set_updated_at BEFORE UPDATE ON router_config_accounts
  FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();
--> statement-breakpoint
ALTER TABLE router_config_accounts ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON router_config_accounts FROM PUBLIC, ecsi_app, ecsi_auth, ecsi_worker, ecsi_radius;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 1. API (ecsi_app) : émission du jeton, lecture de l'état. Jamais password_encrypted ni
--    token_hash en lecture ; jamais password_encrypted, username, activated_at en écriture.
-- ---------------------------------------------------------------------------
GRANT SELECT (router_id, company_id, username, activated_at, token_expires_at, created_at,
              updated_at)
  ON router_config_accounts TO ecsi_app;
--> statement-breakpoint
GRANT INSERT (router_id, company_id, token_hash, token_expires_at, token_created_by)
  ON router_config_accounts TO ecsi_app;
--> statement-breakpoint
GRANT UPDATE (token_hash, token_expires_at, token_created_by) ON router_config_accounts TO ecsi_app;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON router_config_accounts TO ecsi_app
  USING (company_id = app.current_company_id())
  WITH CHECK (company_id = app.current_company_id());
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 2. Worker (ecsi_worker) : chiffré des routeurs actifs seulement (la RLS de routers pour
--    ecsi_worker masque déjà les routeurs supprimés et en cours d'enrôlement).
-- ---------------------------------------------------------------------------
GRANT SELECT (router_id, company_id, username, password_encrypted, activated_at)
  ON router_config_accounts TO ecsi_worker;
--> statement-breakpoint
CREATE POLICY worker_select ON router_config_accounts FOR SELECT TO ecsi_worker
  USING (
    password_encrypted IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM routers r
       WHERE r.id = router_config_accounts.router_id
         AND r.company_id = router_config_accounts.company_id
         AND r.deleted_at IS NULL AND r.status <> 'PROVISIONING'
    )
  );
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 3. Agent passerelle (ecsi_worker) : activation PAR LE TUNNEL. Le routeur est identifié par
--    l'adresse SOURCE (routage cryptographique WireGuard) ET par le jeton à usage unique émis
--    pour CE routeur. Résultats : OK, UNKNOWN_SOURCE, INVALID_TOKEN.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.router_config_target(p_tunnel_ip inet, p_token_hash bytea)
RETURNS TABLE (outcome text, router_id uuid, company_id uuid)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
#variable_conflict use_column
DECLARE
  v_router public.routers%ROWTYPE;
BEGIN
  SELECT * INTO v_router FROM public.routers r
   WHERE host(r.tunnel_ip) = host(p_tunnel_ip) AND r.deleted_at IS NULL
     AND r.status <> 'PROVISIONING' AND r.wg_public_key IS NOT NULL;
  IF NOT FOUND THEN
    outcome := 'UNKNOWN_SOURCE';
    RETURN NEXT;
    RETURN;
  END IF;
  router_id := v_router.id;
  company_id := v_router.company_id;
  IF p_token_hash IS NULL OR octet_length(p_token_hash) <> 32 OR NOT EXISTS (
       SELECT 1 FROM public.router_config_accounts a
        WHERE a.router_id = v_router.id AND a.company_id = v_router.company_id
          AND a.token_hash = p_token_hash AND a.token_expires_at > now()) THEN
    outcome := 'INVALID_TOKEN';
  ELSE
    outcome := 'OK';
  END IF;
  RETURN NEXT;
END
$$;
--> statement-breakpoint
-- Enregistre le mot de passe (déjà chiffré par l'agent) et CONSOMME le jeton, atomiquement :
-- un jeton rejoué, expiré ou remplacé entre-temps ne modifie rien. Audit SYSTEM.
CREATE OR REPLACE FUNCTION app.router_config_activate(
  p_router_id uuid, p_company_id uuid, p_token_hash bytea, p_username text,
  p_password_encrypted text
) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_site uuid;
  v_ip inet;
BEGIN
  IF p_username IS NULL OR p_username !~ '^[A-Za-z0-9._-]{1,64}$'
     OR p_password_encrypted IS NULL OR p_password_encrypted NOT LIKE 'v2:%'
     OR p_token_hash IS NULL OR octet_length(p_token_hash) <> 32 THEN
    RAISE EXCEPTION 'Activation invalide' USING ERRCODE = '22023';
  END IF;
  SELECT r.site_id, r.tunnel_ip INTO v_site, v_ip FROM public.routers r
   WHERE r.id = p_router_id AND r.company_id = p_company_id AND r.deleted_at IS NULL
     AND r.status <> 'PROVISIONING'
   FOR SHARE;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  UPDATE public.router_config_accounts
     SET username = p_username, password_encrypted = p_password_encrypted,
         activated_at = now(), token_hash = NULL, token_expires_at = NULL
   WHERE router_id = p_router_id AND company_id = p_company_id
     AND token_hash = p_token_hash AND token_expires_at > now();
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  INSERT INTO public.audit_events
    (company_id, actor_type, actor_label, action, resource_type, resource_id, site_id, result,
     details)
  VALUES
    (p_company_id, 'SYSTEM', 'ecsi-gateway', 'router.config_access.activated', 'router',
     p_router_id::text, v_site, 'SUCCESS',
     jsonb_build_object('tunnelIp', host(v_ip), 'routerosUsername', p_username));
  RETURN true;
END
$$;
--> statement-breakpoint
-- Refus tracé (sans le contenu de la requête), dans la chaîne de l'entreprise du routeur qui
-- porte cette adresse, sinon dans celle de la plateforme.
CREATE OR REPLACE FUNCTION app.router_config_denied(p_tunnel_ip inet, p_reason text)
RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_router public.routers%ROWTYPE;
BEGIN
  IF p_reason IS NULL OR p_reason NOT IN
     ('INVALID_TOKEN', 'INVALID_BODY', 'UNKNOWN_SOURCE', 'RATE_LIMITED') THEN
    RAISE EXCEPTION 'Motif invalide' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_router FROM public.routers r
   WHERE host(r.tunnel_ip) = host(p_tunnel_ip) AND r.deleted_at IS NULL;
  INSERT INTO public.audit_events
    (company_id, actor_type, actor_label, action, resource_type, resource_id, site_id, result,
     details)
  VALUES
    (v_router.company_id, 'SYSTEM', 'ecsi-gateway', 'router.config_access.activation', 'router',
     v_router.id::text, v_router.site_id, 'DENIED',
     jsonb_build_object('tunnelIp', host(p_tunnel_ip), 'reason', p_reason));
END
$$;
--> statement-breakpoint
-- Les privilèges par défaut du schéma accordent EXECUTE à ecsi_app : retrait explicite.
REVOKE ALL ON FUNCTION app.router_config_target(inet, bytea) FROM PUBLIC, ecsi_app, ecsi_auth, ecsi_radius;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.router_config_activate(uuid, uuid, bytea, text, text) FROM PUBLIC, ecsi_app, ecsi_auth, ecsi_radius;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.router_config_denied(inet, text) FROM PUBLIC, ecsi_app, ecsi_auth, ecsi_radius;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.router_config_target(inet, bytea) TO ecsi_worker;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.router_config_activate(uuid, uuid, bytea, text, text) TO ecsi_worker;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.router_config_denied(inet, text) TO ecsi_worker;
