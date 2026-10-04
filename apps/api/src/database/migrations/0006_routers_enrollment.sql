-- ECSI CLOUD — migration 0006 : enrôlement des routeurs MikroTik (Sprint 3B). Additive.
--
--  - routers : statut PROVISIONING (créé par « Ajouter un routeur », en attente du routeur),
--    clé PUBLIQUE WireGuard reçue à l'enrôlement, dates d'enrôlement et d'activation. Les
--    identifiants RouterOS deviennent facultatifs pour un routeur PROVISIONING seulement
--    (contrainte routers_credentials_check) : les routeurs existants ne changent pas.
--  - router_enrollment_tokens : jetons à usage unique, expirants, stockés HACHÉS (SHA-256).
--  - ecsi_app    : suppression logique seulement (plus de DELETE), mise à jour limitée aux
--                  colonnes que l'API modifie ; l'adresse tunnel est attribuée par
--                  app.router_allocate_tunnel_ip (verrou consultatif, toutes entreprises).
--  - ecsi_auth   : aucun accès aux tables ; consommation d'un jeton par la seule fonction
--                  app.router_consume_enrollment (endpoint public d'enrôlement).
--  - ecsi_worker : ne voit plus les routeurs PROVISIONING (le worker S3A n'y touche jamais) ;
--                  l'agent passerelle WireGuard (même rôle) passe par des fonctions dédiées
--                  qui n'exposent que clés publiques, adresses tunnel et l'activation.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ecsi_worker') THEN
    RAISE EXCEPTION 'Le rôle ecsi_worker doit exister (migration 0005)';
  END IF;
END
$$;
--> statement-breakpoint
CREATE TABLE "router_enrollment_tokens" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"router_id" uuid NOT NULL,
	"token_hash" "bytea" NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "router_enrollment_tokens_hash_check" CHECK (octet_length("router_enrollment_tokens"."token_hash") = 32)
);
--> statement-breakpoint
ALTER TABLE "routers" DROP CONSTRAINT "routers_status_check";--> statement-breakpoint
ALTER TABLE "routers" DROP CONSTRAINT "routers_rest_pinned_check";--> statement-breakpoint
ALTER TABLE "routers" DROP CONSTRAINT "routers_password_format_check";--> statement-breakpoint
ALTER TABLE "routers" ALTER COLUMN "routeros_username" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "routers" ALTER COLUMN "routeros_password_encrypted" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "routers" ADD COLUMN "wg_public_key" text;--> statement-breakpoint
ALTER TABLE "routers" ADD COLUMN "enrolled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "routers" ADD COLUMN "activated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "routers" ADD CONSTRAINT "routers_company_id_key" UNIQUE("company_id","id");--> statement-breakpoint
ALTER TABLE "router_enrollment_tokens" ADD CONSTRAINT "router_enrollment_tokens_router_fk" FOREIGN KEY ("company_id","router_id") REFERENCES "public"."routers"("company_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "router_enrollment_tokens_hash_key" ON "router_enrollment_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "router_enrollment_tokens_router_idx" ON "router_enrollment_tokens" USING btree ("company_id","router_id");--> statement-breakpoint
CREATE UNIQUE INDEX "routers_wg_public_key_key" ON "routers" USING btree ("wg_public_key") WHERE "routers"."deleted_at" is null;--> statement-breakpoint
ALTER TABLE "routers" ADD CONSTRAINT "routers_credentials_check" CHECK ("routers"."status" = 'PROVISIONING' or ("routers"."routeros_username" is not null and "routers"."routeros_password_encrypted" is not null));--> statement-breakpoint
ALTER TABLE "routers" ADD CONSTRAINT "routers_wg_public_key_check" CHECK ("routers"."wg_public_key" is null or "routers"."wg_public_key" ~ '^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw480]=$');--> statement-breakpoint
ALTER TABLE "routers" ADD CONSTRAINT "routers_status_check" CHECK ("routers"."status" in ('PROVISIONING', 'ONLINE', 'DEGRADED', 'OFFLINE'));--> statement-breakpoint
ALTER TABLE "routers" ADD CONSTRAINT "routers_rest_pinned_check" CHECK ("routers"."transport" <> 'REST_HTTPS' or "routers"."tls_fingerprint" is not null or "routers"."status" = 'PROVISIONING');--> statement-breakpoint
ALTER TABLE "routers" ADD CONSTRAINT "routers_password_format_check" CHECK ("routers"."routeros_password_encrypted" is null or "routers"."routeros_password_encrypted" like 'v2:%');
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 1. Droits de l'API (ecsi_app) : suppression logique, colonnes modifiables.
-- ---------------------------------------------------------------------------
REVOKE DELETE, UPDATE ON routers FROM ecsi_app;
--> statement-breakpoint
GRANT UPDATE (
  name, site_id, transport, routeros_username, routeros_password_encrypted, tls_fingerprint,
  consecutive_failures, last_sync_at, last_error, deleted_at
) ON routers TO ecsi_app;
--> statement-breakpoint
ALTER TABLE router_enrollment_tokens ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON router_enrollment_tokens TO ecsi_app
  USING (company_id = app.current_company_id())
  WITH CHECK (company_id = app.current_company_id());
--> statement-breakpoint
REVOKE ALL ON router_enrollment_tokens FROM ecsi_app, ecsi_auth, ecsi_worker;
--> statement-breakpoint
-- Création et révocation seulement : un jeton n'est ni supprimé ni « dé-consommé ».
GRANT SELECT, INSERT ON router_enrollment_tokens TO ecsi_app;
--> statement-breakpoint
GRANT UPDATE (revoked_at) ON router_enrollment_tokens TO ecsi_app;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 2. Worker de supervision : jamais de routeur en cours d'enrôlement.
-- ---------------------------------------------------------------------------
DROP POLICY worker_select ON routers;
--> statement-breakpoint
DROP POLICY worker_update ON routers;
--> statement-breakpoint
CREATE POLICY worker_select ON routers FOR SELECT TO ecsi_worker
  USING (deleted_at IS NULL AND status <> 'PROVISIONING');
--> statement-breakpoint
CREATE POLICY worker_update ON routers FOR UPDATE TO ecsi_worker
  USING (deleted_at IS NULL AND status <> 'PROVISIONING')
  WITH CHECK (deleted_at IS NULL AND status <> 'PROVISIONING');
--> statement-breakpoint
GRANT USAGE ON SCHEMA app TO ecsi_worker;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 3. Attribution d'une adresse tunnel (ecsi_app). Plan d'adressage global à la passerelle :
--    la fonction voit les adresses de TOUTES les entreprises mais n'en renvoie aucune donnée.
--    Jamais : adresse réseau, broadcast, passerelle, adresse d'un routeur actif, ni celle d'un
--    routeur supprimé depuis moins de 7 jours (le temps que la passerelle retire son pair).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.router_allocate_tunnel_ip(p_network cidr, p_gateway inet)
RETURNS inet
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_size bigint;
  v_candidate inet;
BEGIN
  IF p_network IS NULL OR p_gateway IS NULL OR family(p_network) <> 4
     OR masklen(p_network) NOT BETWEEN 16 AND 30
     OR NOT (set_masklen(p_gateway, 32) << p_network) THEN
    RAISE EXCEPTION 'Plage tunnel invalide' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('ecsi:router-tunnel-ip:' || p_network::text, 0));
  v_size := (1::bigint << (32 - masklen(p_network)));
  SELECT c INTO v_candidate
    FROM (
      SELECT set_masklen(host(network(p_network))::inet + g, 32) AS c
        FROM generate_series(1::bigint, v_size - 2) AS g
    ) AS candidates
   WHERE host(c) <> host(p_gateway)
     AND NOT EXISTS (
       SELECT 1 FROM public.routers r
        WHERE host(r.tunnel_ip) = host(candidates.c)
          AND (r.deleted_at IS NULL OR r.deleted_at > now() - interval '7 days')
     )
   ORDER BY c
   LIMIT 1;
  IF v_candidate IS NULL THEN
    RAISE EXCEPTION 'Plage tunnel épuisée' USING ERRCODE = 'EC001';
  END IF;
  RETURN v_candidate;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.router_allocate_tunnel_ip(cidr, inet) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.router_allocate_tunnel_ip(cidr, inet) TO ecsi_app;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 4. Consommation atomique d'un jeton (endpoint public, ecsi_auth). Le jeton est cherché par
--    son empreinte ; verrouillé, il ne peut servir qu'une fois (anti-rejeu). Résultats :
--    ENROLLED, UNKNOWN, REPLAY, REVOKED, EXPIRED, NOT_PROVISIONING, KEY_CONFLICT, INVALID_KEY.
--    Seul ENROLLED modifie quelque chose.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.router_consume_enrollment(p_token_hash bytea, p_public_key text)
RETURNS TABLE (outcome text, router_id uuid, company_id uuid, site_id uuid, tunnel_ip inet)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
#variable_conflict use_column
DECLARE
  v_token public.router_enrollment_tokens%ROWTYPE;
  v_router public.routers%ROWTYPE;
BEGIN
  IF p_public_key IS NULL OR p_public_key !~ '^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw480]=$' THEN
    outcome := 'INVALID_KEY';
    RETURN NEXT;
    RETURN;
  END IF;
  SELECT * INTO v_token FROM public.router_enrollment_tokens t
   WHERE t.token_hash = p_token_hash FOR UPDATE;
  IF NOT FOUND THEN
    outcome := 'UNKNOWN';
    RETURN NEXT;
    RETURN;
  END IF;
  router_id := v_token.router_id;
  company_id := v_token.company_id;
  IF v_token.used_at IS NOT NULL THEN
    outcome := 'REPLAY';
  ELSIF v_token.revoked_at IS NOT NULL THEN
    outcome := 'REVOKED';
  ELSIF v_token.expires_at <= now() THEN
    outcome := 'EXPIRED';
  END IF;
  IF outcome IS NOT NULL THEN
    RETURN NEXT;
    RETURN;
  END IF;
  SELECT * INTO v_router FROM public.routers r
   WHERE r.company_id = v_token.company_id AND r.id = v_token.router_id FOR UPDATE;
  IF NOT FOUND OR v_router.deleted_at IS NOT NULL OR v_router.status <> 'PROVISIONING'
     OR v_router.wg_public_key IS NOT NULL THEN
    outcome := 'NOT_PROVISIONING';
    RETURN NEXT;
    RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM public.routers r
              WHERE r.wg_public_key = p_public_key AND r.deleted_at IS NULL) THEN
    outcome := 'KEY_CONFLICT';
    RETURN NEXT;
    RETURN;
  END IF;
  UPDATE public.router_enrollment_tokens SET used_at = now() WHERE id = v_token.id;
  UPDATE public.routers SET wg_public_key = p_public_key, enrolled_at = now()
   WHERE id = v_router.id;
  site_id := v_router.site_id;
  tunnel_ip := v_router.tunnel_ip;
  outcome := 'ENROLLED';
  RETURN NEXT;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.router_consume_enrollment(bytea, text) FROM PUBLIC, ecsi_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.router_consume_enrollment(bytea, text) TO ecsi_auth;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 5. Agent passerelle WireGuard (ecsi_worker, hôte de la passerelle).
-- ---------------------------------------------------------------------------
-- Pairs à déclarer (active) ou à retirer (routeur supprimé depuis moins de 30 jours). Rien
-- d'autre : ni entreprise, ni nom, ni secret.
CREATE OR REPLACE FUNCTION app.gateway_peers()
RETURNS TABLE (public_key text, tunnel_ip inet, active boolean)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT r.wg_public_key, r.tunnel_ip, r.deleted_at IS NULL
    FROM public.routers r
   WHERE r.wg_public_key IS NOT NULL
     AND (r.deleted_at IS NULL OR r.deleted_at > now() - interval '30 days')
   ORDER BY r.tunnel_ip
$$;
--> statement-breakpoint
-- Routeur à activer, identifié par l'adresse source dans le tunnel : WireGuard n'accepte de
-- cette adresse que les paquets signés par la clé enregistrée à l'enrôlement.
CREATE OR REPLACE FUNCTION app.router_activation_target(p_tunnel_ip inet)
RETURNS TABLE (router_id uuid, company_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT r.id, r.company_id
    FROM public.routers r
   WHERE host(r.tunnel_ip) = host(p_tunnel_ip)
     AND r.deleted_at IS NULL
     AND r.status = 'PROVISIONING'
     AND r.wg_public_key IS NOT NULL
$$;
--> statement-breakpoint
-- Activation : identifiants (mot de passe déjà chiffré par l'agent, AAD liée au routeur) et
-- empreinte TLS ; le routeur passe OFFLINE, le worker le collecte aussitôt (last_sync_at NULL)
-- et décide ONLINE. Événement d'audit SYSTEM dans la chaîne de l'entreprise.
CREATE OR REPLACE FUNCTION app.router_activate(
  p_router_id uuid, p_company_id uuid, p_username text, p_password_encrypted text,
  p_tls_fingerprint text
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
     OR p_tls_fingerprint IS NULL OR p_tls_fingerprint !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'Activation invalide' USING ERRCODE = '22023';
  END IF;
  UPDATE public.routers
     SET status = 'OFFLINE', transport = 'REST_HTTPS', routeros_username = p_username,
         routeros_password_encrypted = p_password_encrypted, tls_fingerprint = p_tls_fingerprint,
         activated_at = now(), last_sync_at = NULL, consecutive_failures = 0, last_error = NULL
   WHERE id = p_router_id AND company_id = p_company_id AND deleted_at IS NULL
     AND status = 'PROVISIONING' AND wg_public_key IS NOT NULL
  RETURNING site_id, tunnel_ip INTO v_site, v_ip;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  INSERT INTO public.audit_events
    (company_id, actor_type, actor_label, action, resource_type, resource_id, site_id, result,
     details)
  VALUES
    (p_company_id, 'SYSTEM', 'ecsi-gateway', 'router.activated', 'router', p_router_id::text,
     v_site, 'SUCCESS',
     jsonb_build_object('tunnelIp', host(v_ip), 'transport', 'REST_HTTPS',
                        'routerosUsername', p_username));
  RETURN true;
END
$$;
--> statement-breakpoint
-- Activation refusée : tracée (sans le contenu de la requête), dans la chaîne de l'entreprise
-- du routeur qui porte cette adresse, sinon dans celle de la plateforme.
CREATE OR REPLACE FUNCTION app.router_activation_denied(p_tunnel_ip inet, p_reason text)
RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_router public.routers%ROWTYPE;
BEGIN
  IF p_reason IS NULL OR p_reason NOT IN
     ('NOT_PROVISIONING', 'INVALID_BODY', 'UNKNOWN_SOURCE', 'RATE_LIMITED') THEN
    RAISE EXCEPTION 'Motif invalide' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_router FROM public.routers r
   WHERE host(r.tunnel_ip) = host(p_tunnel_ip) AND r.deleted_at IS NULL;
  INSERT INTO public.audit_events
    (company_id, actor_type, actor_label, action, resource_type, resource_id, site_id, result,
     details)
  VALUES
    (v_router.company_id, 'SYSTEM', 'ecsi-gateway', 'router.activation', 'router',
     v_router.id::text, v_router.site_id, 'DENIED',
     jsonb_build_object('tunnelIp', host(p_tunnel_ip), 'reason', p_reason));
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.gateway_peers() FROM PUBLIC, ecsi_app;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.router_activation_target(inet) FROM PUBLIC, ecsi_app;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.router_activate(uuid, uuid, text, text, text) FROM PUBLIC, ecsi_app;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.router_activation_denied(inet, text) FROM PUBLIC, ecsi_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.gateway_peers() TO ecsi_worker;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.router_activation_target(inet) TO ecsi_worker;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.router_activate(uuid, uuid, text, text, text) TO ecsi_worker;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.router_activation_denied(inet, text) TO ecsi_worker;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 6. Console plateforme (Super Admin ECSI, rôle ecsi_auth) : lecture des routeurs d'une
--    entreprise, colonnes sans secret uniquement (ni chiffré, ni nom du compte RouterOS).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.platform_company_routers(p_company_id uuid)
RETURNS TABLE (
  id uuid, site_id uuid, site_name text, site_code text, name text, status text,
  transport text, tunnel_ip inet, routeros_version text, board_name text, identity text,
  uptime_seconds bigint, cpu_load smallint, total_memory bigint, free_memory bigint,
  last_seen_at timestamptz, last_error text, enrolled_at timestamptz, activated_at timestamptz,
  created_at timestamptz
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT r.id, r.site_id, s.name, s.code, r.name, r.status, r.transport, r.tunnel_ip,
         r.routeros_version, r.board_name, r.identity, r.uptime_seconds, r.cpu_load,
         r.total_memory, r.free_memory, r.last_seen_at, r.last_error, r.enrolled_at,
         r.activated_at, r.created_at
    FROM public.routers r
    JOIN public.sites s ON s.company_id = r.company_id AND s.id = r.site_id
   WHERE r.company_id = p_company_id AND r.deleted_at IS NULL
   ORDER BY s.name, r.name
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.platform_company_routers(uuid) FROM PUBLIC, ecsi_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.platform_company_routers(uuid) TO ecsi_auth;
