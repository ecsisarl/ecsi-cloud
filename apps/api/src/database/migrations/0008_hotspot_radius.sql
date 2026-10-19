-- ECSI CLOUD — migration 0008 : Hotspot, FreeRADIUS, forfaits et tickets (lot B).
-- Additive : aucune table existante n'est modifiée.
--
-- AUCUN SECRET EN BASE (décision du lot B, docs/RADIUS.md) :
--  - un ticket est retrouvé par HMAC-SHA1(RADIUS_VOUCHER_LOOKUP_KEY, code en minuscules),
--    calculé par l'API à la génération et par FreeRADIUS à chaque requête ; le code
--    lui-même n'est jamais stocké (réimpression : l'API le redérive de VOUCHER_CODE_KEY) ;
--  - le secret RADIUS d'un routeur est HMAC-SHA1(RADIUS_NAS_KEY, "nas:<router>:<version>"),
--    calculé par FreeRADIUS (client dynamique) et par le worker (configuration du routeur).
--
-- Rôles :
--  - ecsi_app    : forfaits, lots, tickets, hotspots de son entreprise (RLS) ; tickets :
--                  création et désactivation seulement ; sessions et journal RADIUS en
--                  lecture seule.
--  - ecsi_worker : application de la configuration Hotspot (colonnes de synchronisation),
--                  entretien (radius.housekeeping : expiration, sessions orphelines, purge).
--  - ecsi_radius : FreeRADIUS. AUCUN droit sur les tables : EXECUTE sur radius.* seulement.
--  - ecsi_auth   : aucun accès.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ecsi_worker') THEN
    RAISE EXCEPTION 'Le rôle ecsi_worker doit exister (migration 0005)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ecsi_radius') THEN
    RAISE EXCEPTION 'Le rôle ecsi_radius doit exister avant la migration 0008 (docs/DEPLOYMENT.md, « Rôle ecsi_radius »)';
  END IF;
END
$$;
--> statement-breakpoint
CREATE TABLE "hotspots" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"router_id" uuid NOT NULL,
	"name" text NOT NULL,
	"interface" text NOT NULL,
	"gateway_address" "inet" NOT NULL,
	"pool_start" "inet" NOT NULL,
	"pool_end" "inet" NOT NULL,
	"dns_name" text,
	"desired_state" text DEFAULT 'ENABLED' NOT NULL,
	"sync_status" text DEFAULT 'PENDING' NOT NULL,
	"config_version" integer DEFAULT 1 NOT NULL,
	"applied_version" integer,
	"nas_secret_version" integer DEFAULT 1 NOT NULL,
	"last_sync_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "hotspots_company_id_key" UNIQUE("company_id","id"),
	CONSTRAINT "hotspots_desired_state_check" CHECK ("hotspots"."desired_state" in ('ENABLED', 'DISABLED')),
	CONSTRAINT "hotspots_sync_status_check" CHECK ("hotspots"."sync_status" in ('PENDING', 'APPLYING', 'SYNCED', 'ERROR')),
	CONSTRAINT "hotspots_name_check" CHECK (char_length("hotspots"."name") between 1 and 80),
	CONSTRAINT "hotspots_interface_check" CHECK ("hotspots"."interface" ~ '^[A-Za-z0-9._-]{1,40}$'),
	CONSTRAINT "hotspots_network_check" CHECK (family("hotspots"."gateway_address") = 4 and masklen("hotspots"."gateway_address") between 16 and 30
        and "hotspots"."pool_start" << network("hotspots"."gateway_address") and "hotspots"."pool_end" << network("hotspots"."gateway_address")
        and "hotspots"."pool_start" <= "hotspots"."pool_end"
        and not (host("hotspots"."gateway_address")::inet between "hotspots"."pool_start" and "hotspots"."pool_end")),
	CONSTRAINT "hotspots_dns_name_check" CHECK ("hotspots"."dns_name" is null or "hotspots"."dns_name" ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$'),
	CONSTRAINT "hotspots_versions_check" CHECK ("hotspots"."config_version" >= 1 and "hotspots"."nas_secret_version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "plans" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"price_minor" bigint NOT NULL,
	"currency" text NOT NULL,
	"validity_seconds" integer,
	"session_time_seconds" integer,
	"rate_up_kbps" integer,
	"rate_down_kbps" integer,
	"data_quota_bytes" bigint,
	"max_devices" smallint DEFAULT 1 NOT NULL,
	"idle_timeout_seconds" integer DEFAULT 300 NOT NULL,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "plans_company_id_key" UNIQUE("company_id","id"),
	CONSTRAINT "plans_status_check" CHECK ("plans"."status" in ('ACTIVE', 'DISABLED')),
	CONSTRAINT "plans_name_check" CHECK (char_length("plans"."name") between 1 and 80),
	CONSTRAINT "plans_price_check" CHECK ("plans"."price_minor" >= 0),
	CONSTRAINT "plans_currency_check" CHECK ("plans"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "plans_limits_check" CHECK ("plans"."validity_seconds" is not null or "plans"."session_time_seconds" is not null or "plans"."data_quota_bytes" is not null),
	CONSTRAINT "plans_values_check" CHECK (("plans"."validity_seconds" is null or "plans"."validity_seconds" between 60 and 31622400)
        and ("plans"."session_time_seconds" is null or "plans"."session_time_seconds" between 60 and 31622400)
        and ("plans"."rate_up_kbps" is null or "plans"."rate_up_kbps" between 8 and 10000000)
        and ("plans"."rate_down_kbps" is null or "plans"."rate_down_kbps" between 8 and 10000000)
        and ("plans"."data_quota_bytes" is null or "plans"."data_quota_bytes" between 1048576 and 109951162777600)
        and "plans"."max_devices" between 1 and 10
        and "plans"."idle_timeout_seconds" between 60 and 86400)
);
--> statement-breakpoint
CREATE TABLE "radius_postauth" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"company_id" uuid,
	"router_id" uuid,
	"voucher_id" uuid,
	"nas_ip" "inet" NOT NULL,
	"result" text NOT NULL,
	"reason" text,
	"calling_station_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "radius_postauth_result_check" CHECK ("radius_postauth"."result" in ('ACCEPT', 'REJECT'))
);
--> statement-breakpoint
CREATE TABLE "radius_sessions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"router_id" uuid NOT NULL,
	"voucher_id" uuid NOT NULL,
	"acct_session_id" text NOT NULL,
	"acct_unique_id" text NOT NULL,
	"calling_station_id" text,
	"framed_ip" "inet",
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"stopped_at" timestamp with time zone,
	"session_seconds" bigint DEFAULT 0 NOT NULL,
	"input_bytes" bigint DEFAULT 0 NOT NULL,
	"output_bytes" bigint DEFAULT 0 NOT NULL,
	"terminate_cause" text,
	CONSTRAINT "radius_sessions_company_id_key" UNIQUE("company_id","id"),
	CONSTRAINT "radius_sessions_unique_id_key" UNIQUE("router_id","acct_unique_id")
);
--> statement-breakpoint
CREATE TABLE "voucher_batches" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"plan_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"quantity" integer NOT NULL,
	"scope_type" text DEFAULT 'LOCAL' NOT NULL,
	"label" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "voucher_batches_company_id_key" UNIQUE("company_id","id"),
	CONSTRAINT "voucher_batches_quantity_check" CHECK ("voucher_batches"."quantity" between 1 and 1000),
	CONSTRAINT "voucher_batches_scope_check" CHECK ("voucher_batches"."scope_type" = 'LOCAL'),
	CONSTRAINT "voucher_batches_label_check" CHECK ("voucher_batches"."label" is null or char_length("voucher_batches"."label") between 1 and 80)
);
--> statement-breakpoint
CREATE TABLE "vouchers" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"batch_id" uuid NOT NULL,
	"plan_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"serial" integer NOT NULL,
	"code_lookup" text NOT NULL,
	"lookup_key_version" smallint DEFAULT 1 NOT NULL,
	"code_key_version" smallint DEFAULT 1 NOT NULL,
	"state" text DEFAULT 'AVAILABLE' NOT NULL,
	"price_minor" bigint NOT NULL,
	"currency" text NOT NULL,
	"validity_seconds" integer,
	"session_time_seconds" integer,
	"rate_up_kbps" integer,
	"rate_down_kbps" integer,
	"data_quota_bytes" bigint,
	"max_devices" smallint NOT NULL,
	"idle_timeout_seconds" integer NOT NULL,
	"activated_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"used_seconds" bigint DEFAULT 0 NOT NULL,
	"used_bytes" bigint DEFAULT 0 NOT NULL,
	"disabled_at" timestamp with time zone,
	"disabled_by" uuid,
	"disabled_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "vouchers_company_id_key" UNIQUE("company_id","id"),
	CONSTRAINT "vouchers_company_lookup_key" UNIQUE("company_id","code_lookup"),
	CONSTRAINT "vouchers_batch_serial_key" UNIQUE("batch_id","serial"),
	CONSTRAINT "vouchers_state_check" CHECK ("vouchers"."state" in ('AVAILABLE', 'ACTIVE', 'EXHAUSTED', 'EXPIRED', 'DISABLED')),
	CONSTRAINT "vouchers_lookup_check" CHECK ("vouchers"."code_lookup" ~ '^[0-9a-f]{40}$'),
	CONSTRAINT "vouchers_key_versions_check" CHECK ("vouchers"."lookup_key_version" between 1 and 999 and "vouchers"."code_key_version" between 1 and 999),
	CONSTRAINT "vouchers_serial_check" CHECK ("vouchers"."serial" between 1 and 1000),
	CONSTRAINT "vouchers_usage_check" CHECK ("vouchers"."used_seconds" >= 0 and "vouchers"."used_bytes" >= 0),
	CONSTRAINT "vouchers_disabled_check" CHECK (("vouchers"."state" = 'DISABLED') = ("vouchers"."disabled_at" is not null)),
	CONSTRAINT "vouchers_disabled_reason_check" CHECK ("vouchers"."disabled_reason" is null or char_length("vouchers"."disabled_reason") <= 200)
);
--> statement-breakpoint
ALTER TABLE "hotspots" ADD CONSTRAINT "hotspots_router_fk" FOREIGN KEY ("company_id","router_id") REFERENCES "public"."routers"("company_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hotspots" ADD CONSTRAINT "hotspots_site_fk" FOREIGN KEY ("company_id","site_id") REFERENCES "public"."sites"("company_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plans" ADD CONSTRAINT "plans_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "radius_postauth" ADD CONSTRAINT "radius_postauth_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "radius_sessions" ADD CONSTRAINT "radius_sessions_voucher_fk" FOREIGN KEY ("company_id","voucher_id") REFERENCES "public"."vouchers"("company_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "radius_sessions" ADD CONSTRAINT "radius_sessions_router_fk" FOREIGN KEY ("company_id","router_id") REFERENCES "public"."routers"("company_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voucher_batches" ADD CONSTRAINT "voucher_batches_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voucher_batches" ADD CONSTRAINT "voucher_batches_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voucher_batches" ADD CONSTRAINT "voucher_batches_plan_fk" FOREIGN KEY ("company_id","plan_id") REFERENCES "public"."plans"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voucher_batches" ADD CONSTRAINT "voucher_batches_site_fk" FOREIGN KEY ("company_id","site_id") REFERENCES "public"."sites"("company_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vouchers" ADD CONSTRAINT "vouchers_disabled_by_users_id_fk" FOREIGN KEY ("disabled_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vouchers" ADD CONSTRAINT "vouchers_batch_fk" FOREIGN KEY ("company_id","batch_id") REFERENCES "public"."voucher_batches"("company_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vouchers" ADD CONSTRAINT "vouchers_plan_fk" FOREIGN KEY ("company_id","plan_id") REFERENCES "public"."plans"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vouchers" ADD CONSTRAINT "vouchers_site_fk" FOREIGN KEY ("company_id","site_id") REFERENCES "public"."sites"("company_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "hotspots_router_key" ON "hotspots" USING btree ("router_id") WHERE "hotspots"."deleted_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "plans_company_name_key" ON "plans" USING btree ("company_id",lower("name")) WHERE "plans"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "radius_postauth_company_created_idx" ON "radius_postauth" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE INDEX "radius_postauth_voucher_idx" ON "radius_postauth" USING btree ("voucher_id");--> statement-breakpoint
CREATE INDEX "radius_postauth_created_idx" ON "radius_postauth" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "radius_sessions_voucher_idx" ON "radius_sessions" USING btree ("voucher_id","started_at");--> statement-breakpoint
CREATE INDEX "radius_sessions_open_idx" ON "radius_sessions" USING btree ("router_id") WHERE "radius_sessions"."stopped_at" is null;--> statement-breakpoint
CREATE INDEX "radius_sessions_company_started_idx" ON "radius_sessions" USING btree ("company_id","started_at");--> statement-breakpoint
CREATE INDEX "voucher_batches_company_created_idx" ON "voucher_batches" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE INDEX "vouchers_company_state_idx" ON "vouchers" USING btree ("company_id","state");--> statement-breakpoint
CREATE INDEX "vouchers_company_site_idx" ON "vouchers" USING btree ("company_id","site_id");--> statement-breakpoint
CREATE INDEX "vouchers_expires_at_idx" ON "vouchers" USING btree ("expires_at") WHERE "vouchers"."state" = 'ACTIVE';
--> statement-breakpoint
CREATE TRIGGER plans_set_updated_at BEFORE UPDATE ON plans
  FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();
--> statement-breakpoint
CREATE TRIGGER vouchers_set_updated_at BEFORE UPDATE ON vouchers
  FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();
--> statement-breakpoint
CREATE TRIGGER hotspots_set_updated_at BEFORE UPDATE ON hotspots
  FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();
--> statement-breakpoint
-- Le site d'un hotspot est celui de son routeur (pas de hotspot rattaché à un autre site).
CREATE OR REPLACE FUNCTION app.hotspots_check_site() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.routers r
                  WHERE r.id = NEW.router_id AND r.company_id = NEW.company_id
                    AND r.site_id = NEW.site_id) THEN
    RAISE EXCEPTION 'Le site du hotspot doit être celui du routeur' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.hotspots_check_site() FROM PUBLIC, ecsi_app;
--> statement-breakpoint
CREATE TRIGGER hotspots_check_site BEFORE INSERT OR UPDATE OF site_id, router_id ON hotspots
  FOR EACH ROW EXECUTE FUNCTION app.hotspots_check_site();
--> statement-breakpoint
ALTER TABLE plans ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE voucher_batches ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE vouchers ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE hotspots ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE radius_sessions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE radius_postauth ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON plans, voucher_batches, vouchers, hotspots, radius_sessions, radius_postauth
  FROM PUBLIC, ecsi_app, ecsi_auth, ecsi_worker, ecsi_radius;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 1. API (ecsi_app), entreprise du contexte uniquement.
-- ---------------------------------------------------------------------------
-- Forfaits : pas de DELETE (suppression logique, les tickets émis gardent leur forfait).
GRANT SELECT, INSERT, UPDATE ON plans TO ecsi_app;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON plans TO ecsi_app
  USING (company_id = app.current_company_id())
  WITH CHECK (company_id = app.current_company_id());
--> statement-breakpoint
-- Lots : création et lecture seulement.
GRANT SELECT, INSERT ON voucher_batches TO ecsi_app;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON voucher_batches TO ecsi_app
  USING (company_id = app.current_company_id())
  WITH CHECK (company_id = app.current_company_id());
--> statement-breakpoint
-- Tickets : création (avec les limites copiées du forfait) et désactivation. La consommation
-- et l'activation ne sont écrites que par RADIUS (fonctions radius.*).
GRANT SELECT ON vouchers TO ecsi_app;
--> statement-breakpoint
GRANT INSERT (company_id, batch_id, plan_id, site_id, serial, code_lookup, lookup_key_version,
              code_key_version,
              price_minor, currency, validity_seconds, session_time_seconds, rate_up_kbps,
              rate_down_kbps, data_quota_bytes, max_devices, idle_timeout_seconds)
  ON vouchers TO ecsi_app;
--> statement-breakpoint
GRANT UPDATE (state, disabled_at, disabled_by, disabled_reason) ON vouchers TO ecsi_app;
--> statement-breakpoint
CREATE POLICY tenant_select ON vouchers FOR SELECT TO ecsi_app
  USING (company_id = app.current_company_id());
--> statement-breakpoint
CREATE POLICY tenant_insert ON vouchers FOR INSERT TO ecsi_app
  WITH CHECK (company_id = app.current_company_id());
--> statement-breakpoint
-- Désactivation seulement, définitive, au nom de l'utilisateur de la transaction.
CREATE POLICY tenant_disable ON vouchers FOR UPDATE TO ecsi_app
  USING (company_id = app.current_company_id() AND state <> 'DISABLED')
  WITH CHECK (
    company_id = app.current_company_id()
    AND state = 'DISABLED'
    AND disabled_by = app.current_user_id()
  );
--> statement-breakpoint
-- Hotspots : configuration voulue ; jamais les colonnes d'état écrites par le worker, sauf
-- le retour à PENDING (nouvelle version à appliquer).
GRANT SELECT ON hotspots TO ecsi_app;
--> statement-breakpoint
GRANT INSERT (company_id, site_id, router_id, name, interface, gateway_address, pool_start,
              pool_end, dns_name, desired_state)
  ON hotspots TO ecsi_app;
--> statement-breakpoint
GRANT UPDATE (name, interface, gateway_address, pool_start, pool_end, dns_name, desired_state,
              sync_status, config_version, nas_secret_version, deleted_at)
  ON hotspots TO ecsi_app;
--> statement-breakpoint
CREATE POLICY tenant_select ON hotspots FOR SELECT TO ecsi_app
  USING (company_id = app.current_company_id());
--> statement-breakpoint
CREATE POLICY tenant_insert ON hotspots FOR INSERT TO ecsi_app
  WITH CHECK (company_id = app.current_company_id());
--> statement-breakpoint
CREATE POLICY tenant_update ON hotspots FOR UPDATE TO ecsi_app
  USING (company_id = app.current_company_id() AND deleted_at IS NULL)
  WITH CHECK (company_id = app.current_company_id() AND sync_status = 'PENDING');
--> statement-breakpoint
GRANT SELECT ON radius_sessions, radius_postauth TO ecsi_app;
--> statement-breakpoint
CREATE POLICY tenant_select ON radius_sessions FOR SELECT TO ecsi_app
  USING (company_id = app.current_company_id());
--> statement-breakpoint
CREATE POLICY tenant_select ON radius_postauth FOR SELECT TO ecsi_app
  USING (company_id = app.current_company_id());
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 2. Worker (ecsi_worker, sans tenant) : application de la configuration Hotspot.
-- ---------------------------------------------------------------------------
GRANT SELECT ON hotspots TO ecsi_worker;
--> statement-breakpoint
GRANT UPDATE (sync_status, applied_version, last_sync_at, last_error) ON hotspots TO ecsi_worker;
--> statement-breakpoint
CREATE POLICY worker_select ON hotspots FOR SELECT TO ecsi_worker USING (true);
--> statement-breakpoint
CREATE POLICY worker_sync ON hotspots FOR UPDATE TO ecsi_worker
  USING (true) WITH CHECK (sync_status IN ('APPLYING', 'SYNCED', 'ERROR', 'PENDING'));
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 3. Schéma radius : seule surface de FreeRADIUS (ecsi_radius). Fonctions SECURITY DEFINER,
--    search_path fixé, entrées revalidées (rlm_sql échappe déjà les valeurs réseau).
--    Motifs de refus : NAS_UNKNOWN, UNKNOWN, WRONG_SITE, DISABLED, EXPIRED, EXHAUSTED,
--    TOO_MANY_DEVICES, INVALID.
-- ---------------------------------------------------------------------------
CREATE SCHEMA radius;
--> statement-breakpoint
REVOKE ALL ON SCHEMA radius FROM PUBLIC;
--> statement-breakpoint
GRANT USAGE ON SCHEMA radius TO ecsi_radius, ecsi_worker;
--> statement-breakpoint
-- Client dynamique : identité du NAS pour l'adresse source du paquet (garantie par le routage
-- cryptographique WireGuard). Renvoie "<router_id>:<version du secret>" si le routeur est
-- actif et porte un hotspot activé, sinon NULL (paquet ignoré).
CREATE OR REPLACE FUNCTION radius.nas_identity(p_nas text)
RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_ip inet;
  v_result text;
BEGIN
  BEGIN
    v_ip := p_nas::inet;
  EXCEPTION WHEN others THEN
    RETURN NULL;
  END;
  SELECT r.id::text || ':' || h.nas_secret_version::text INTO v_result
    FROM public.routers r
    JOIN public.hotspots h ON h.router_id = r.id AND h.company_id = r.company_id
   WHERE host(r.tunnel_ip) = host(v_ip)
     AND r.deleted_at IS NULL AND r.status <> 'PROVISIONING'
     AND h.deleted_at IS NULL AND h.desired_state = 'ENABLED';
  RETURN v_result;
END
$$;
--> statement-breakpoint
-- Décision d'autorisation (interne). Ne modifie que l'état d'un ticket arrivé à expiration.
CREATE OR REPLACE FUNCTION radius.decide(p_nas text, p_lookup text, p_calling text)
RETURNS TABLE (
  decision text, voucher_id uuid, company_id uuid, router_id uuid,
  remaining_seconds bigint, remaining_bytes bigint, rate_up_kbps integer,
  rate_down_kbps integer, idle_timeout_seconds integer
)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
#variable_conflict use_column
DECLARE
  v_ip inet;
  v_router public.routers%ROWTYPE;
  v_voucher public.vouchers%ROWTYPE;
  v_expires timestamptz;
  v_time bigint;
  v_devices integer;
BEGIN
  decision := 'INVALID';
  IF p_lookup IS NULL OR p_lookup !~ '^[0-9a-f]{40}$' THEN
    RETURN NEXT;
    RETURN;
  END IF;
  BEGIN
    v_ip := p_nas::inet;
  EXCEPTION WHEN others THEN
    RETURN NEXT;
    RETURN;
  END;
  SELECT r.* INTO v_router
    FROM public.routers r
    JOIN public.hotspots h ON h.router_id = r.id AND h.company_id = r.company_id
   WHERE host(r.tunnel_ip) = host(v_ip)
     AND r.deleted_at IS NULL AND r.status <> 'PROVISIONING'
     AND h.deleted_at IS NULL AND h.desired_state = 'ENABLED';
  IF NOT FOUND THEN
    decision := 'NAS_UNKNOWN';
    RETURN NEXT;
    RETURN;
  END IF;
  company_id := v_router.company_id;
  router_id := v_router.id;
  SELECT v.* INTO v_voucher FROM public.vouchers v
   WHERE v.company_id = v_router.company_id AND v.code_lookup = p_lookup
   FOR UPDATE;
  IF NOT FOUND THEN
    decision := 'UNKNOWN';
    RETURN NEXT;
    RETURN;
  END IF;
  voucher_id := v_voucher.id;
  -- Portée LOCAL : le ticket n'est valable que sur les routeurs de son site d'émission.
  IF v_voucher.site_id <> v_router.site_id THEN
    decision := 'WRONG_SITE';
    RETURN NEXT;
    RETURN;
  END IF;
  IF v_voucher.state IN ('DISABLED', 'EXPIRED', 'EXHAUSTED') THEN
    decision := v_voucher.state;
    RETURN NEXT;
    RETURN;
  END IF;
  v_expires := COALESCE(
    v_voucher.expires_at,
    CASE WHEN v_voucher.validity_seconds IS NOT NULL
         THEN now() + make_interval(secs => v_voucher.validity_seconds) END);
  IF v_expires IS NOT NULL AND v_expires <= now() THEN
    UPDATE public.vouchers SET state = 'EXPIRED' WHERE id = v_voucher.id;
    decision := 'EXPIRED';
    RETURN NEXT;
    RETURN;
  END IF;
  IF v_voucher.session_time_seconds IS NOT NULL THEN
    v_time := v_voucher.session_time_seconds - v_voucher.used_seconds;
  END IF;
  IF v_expires IS NOT NULL THEN
    v_time := LEAST(COALESCE(v_time, 9223372036854775807),
                    floor(extract(epoch FROM v_expires - now()))::bigint);
  END IF;
  IF v_voucher.data_quota_bytes IS NOT NULL THEN
    remaining_bytes := v_voucher.data_quota_bytes - v_voucher.used_bytes;
  END IF;
  IF (v_time IS NOT NULL AND v_time <= 0) OR (remaining_bytes IS NOT NULL AND remaining_bytes <= 0) THEN
    UPDATE public.vouchers SET state = 'EXHAUSTED' WHERE id = v_voucher.id;
    decision := 'EXHAUSTED';
    RETURN NEXT;
    RETURN;
  END IF;
  -- Appareils simultanés : sessions ouvertes et vivantes (mise à jour récente) d'AUTRES
  -- appareils. Le même appareil qui se reconnecte n'est pas compté.
  SELECT count(DISTINCT COALESCE(s.calling_station_id, s.id::text)) INTO v_devices
    FROM public.radius_sessions s
   WHERE s.voucher_id = v_voucher.id AND s.stopped_at IS NULL
     AND s.updated_at > now() - interval '11 minutes'
     AND (p_calling IS NULL OR p_calling = '' OR s.calling_station_id IS DISTINCT FROM p_calling);
  IF v_devices >= v_voucher.max_devices THEN
    decision := 'TOO_MANY_DEVICES';
    RETURN NEXT;
    RETURN;
  END IF;
  remaining_seconds := v_time;
  rate_up_kbps := v_voucher.rate_up_kbps;
  rate_down_kbps := v_voucher.rate_down_kbps;
  idle_timeout_seconds := v_voucher.idle_timeout_seconds;
  decision := 'ACCEPT';
  RETURN NEXT;
END
$$;
--> statement-breakpoint
-- Requête « authorize_check » de rlm_sql : lignes (id, username, attribute, value, op).
-- Toujours une ligne de contrôle Tmp-String-6 portant la décision ; FreeRADIUS refuse tout
-- ce qui n'est pas ACCEPT et pose lui-même Cleartext-Password (CHAP, code = identifiant).
CREATE OR REPLACE FUNCTION radius.authorize_check(p_nas text, p_lookup text, p_calling text)
RETURNS TABLE (id integer, username text, attribute text, value text, op text)
LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT 1, p_lookup, 'Tmp-String-6', d.decision, ':='
    FROM radius.decide(p_nas, p_lookup, p_calling) AS d
$$;
--> statement-breakpoint
-- Requête « authorize_reply » : limites appliquées par RouterOS. Mikrotik-Rate-Limit est
-- exprimé du point de vue du routeur : rx (montant, envoi du client) / tx (descendant) ;
-- 0 = non limité. Mikrotik-Total-Limit(-Gigawords) : volume restant (bits bas / hauts).
CREATE OR REPLACE FUNCTION radius.authorize_reply(p_nas text, p_lookup text, p_calling text)
RETURNS TABLE (id integer, username text, attribute text, value text, op text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  d record;
BEGIN
  SELECT * INTO d FROM radius.decide(p_nas, p_lookup, p_calling);
  IF d.decision IS DISTINCT FROM 'ACCEPT' THEN
    RETURN QUERY SELECT 1, p_lookup, 'Reply-Message'::text,
      CASE d.decision
        WHEN 'EXPIRED' THEN 'Ticket expiré'
        WHEN 'EXHAUSTED' THEN 'Forfait épuisé'
        WHEN 'DISABLED' THEN 'Ticket désactivé'
        WHEN 'WRONG_SITE' THEN 'Ticket non valable sur ce site'
        WHEN 'TOO_MANY_DEVICES' THEN 'Ticket déjà utilisé sur un autre appareil'
        ELSE 'Ticket invalide'
      END, '='::text;
    RETURN;
  END IF;
  IF d.remaining_seconds IS NOT NULL THEN
    RETURN QUERY SELECT 1, p_lookup, 'Session-Timeout'::text,
      LEAST(d.remaining_seconds, 2147483647)::text, '='::text;
  END IF;
  RETURN QUERY SELECT 2, p_lookup, 'Idle-Timeout'::text, d.idle_timeout_seconds::text, '='::text;
  RETURN QUERY SELECT 3, p_lookup, 'Acct-Interim-Interval'::text, '300'::text, '='::text;
  IF d.rate_up_kbps IS NOT NULL OR d.rate_down_kbps IS NOT NULL THEN
    RETURN QUERY SELECT 4, p_lookup, 'Mikrotik-Rate-Limit'::text,
      COALESCE(d.rate_up_kbps, 0)::text || 'k/' || COALESCE(d.rate_down_kbps, 0)::text || 'k',
      '='::text;
  END IF;
  IF d.remaining_bytes IS NOT NULL THEN
    RETURN QUERY SELECT 5, p_lookup, 'Mikrotik-Total-Limit'::text,
      (d.remaining_bytes % 4294967296)::text, '='::text;
    RETURN QUERY SELECT 6, p_lookup, 'Mikrotik-Total-Limit-Gigawords'::text,
      (d.remaining_bytes / 4294967296)::text, '='::text;
  END IF;
END
$$;
--> statement-breakpoint
-- Post-auth : journal (sans le code) et, à la première acceptation, activation du ticket
-- (début de la validité calendaire).
CREATE OR REPLACE FUNCTION radius.postauth(
  p_nas text, p_lookup text, p_result text, p_reason text, p_calling text
) RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_ip inet;
  v_router public.routers%ROWTYPE;
  v_voucher_id uuid;
  v_reason text := NULLIF(left(p_reason, 40), '');
BEGIN
  IF p_result NOT IN ('ACCEPT', 'REJECT') THEN
    RETURN 0;
  END IF;
  BEGIN
    v_ip := p_nas::inet;
  EXCEPTION WHEN others THEN
    RETURN 0;
  END;
  SELECT r.* INTO v_router FROM public.routers r
   WHERE host(r.tunnel_ip) = host(v_ip) AND r.deleted_at IS NULL;
  IF FOUND AND p_lookup ~ '^[0-9a-f]{40}$' THEN
    SELECT v.id INTO v_voucher_id FROM public.vouchers v
     WHERE v.company_id = v_router.company_id AND v.code_lookup = p_lookup;
  END IF;
  IF p_result = 'ACCEPT' AND v_voucher_id IS NOT NULL THEN
    UPDATE public.vouchers v
       SET state = 'ACTIVE',
           activated_at = COALESCE(v.activated_at, now()),
           expires_at = COALESCE(v.expires_at,
             CASE WHEN v.validity_seconds IS NOT NULL
                  THEN now() + make_interval(secs => v.validity_seconds) END),
           last_used_at = now()
     WHERE v.id = v_voucher_id AND v.state IN ('AVAILABLE', 'ACTIVE');
  END IF;
  INSERT INTO public.radius_postauth
    (company_id, router_id, voucher_id, nas_ip, result, reason, calling_station_id)
  VALUES
    (v_router.company_id, v_router.id, v_voucher_id, v_ip, p_result,
     CASE WHEN p_result = 'REJECT' THEN COALESCE(v_reason, 'AUTH_FAILED') END,
     NULLIF(left(p_calling, 64), ''));
  RETURN 1;
END
$$;
--> statement-breakpoint
-- Accounting Start / Interim-Update / Stop, idempotent : la session garde les compteurs
-- cumulés envoyés par le NAS ; le ticket est incrémenté du seul écart positif (un paquet
-- rejoué ou en retard ne compte jamais deux fois). Octets montants = Acct-Input (reçus du
-- client par le routeur), descendants = Acct-Output.
CREATE OR REPLACE FUNCTION radius.accounting(
  p_nas text, p_status text, p_lookup text, p_session_id text, p_unique_id text,
  p_calling text, p_framed_ip text, p_session_time text, p_in_octets text,
  p_in_gigawords text, p_out_octets text, p_out_gigawords text, p_cause text
) RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_ip inet;
  v_framed inet;
  v_router public.routers%ROWTYPE;
  v_voucher public.vouchers%ROWTYPE;
  v_session public.radius_sessions%ROWTYPE;
  v_time bigint;
  v_in bigint;
  v_out bigint;
  v_dtime bigint := 0;
  v_dbytes bigint := 0;
BEGIN
  IF p_status NOT IN ('Start', 'Interim-Update', 'Stop')
     OR p_lookup IS NULL OR p_lookup !~ '^[0-9a-f]{40}$'
     OR p_session_id IS NULL OR p_session_id !~ '^[A-Za-z0-9._:-]{1,64}$'
     OR p_unique_id IS NULL OR p_unique_id !~ '^[A-Za-z0-9._:-]{1,64}$' THEN
    RETURN 1;
  END IF;
  BEGIN
    v_ip := p_nas::inet;
    v_framed := NULLIF(p_framed_ip, '')::inet;
    v_time := COALESCE(NULLIF(p_session_time, '')::bigint, 0);
    v_in := COALESCE(NULLIF(p_in_gigawords, '')::bigint, 0) * 4294967296
            + COALESCE(NULLIF(p_in_octets, '')::bigint, 0);
    v_out := COALESCE(NULLIF(p_out_gigawords, '')::bigint, 0) * 4294967296
             + COALESCE(NULLIF(p_out_octets, '')::bigint, 0);
  EXCEPTION WHEN others THEN
    RETURN 1;
  END;
  IF v_time < 0 OR v_in < 0 OR v_out < 0 THEN
    RETURN 1;
  END IF;
  SELECT r.* INTO v_router FROM public.routers r
   WHERE host(r.tunnel_ip) = host(v_ip) AND r.deleted_at IS NULL;
  IF NOT FOUND THEN
    RETURN 1;
  END IF;
  SELECT v.* INTO v_voucher FROM public.vouchers v
   WHERE v.company_id = v_router.company_id AND v.code_lookup = p_lookup
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN 1;
  END IF;
  SELECT s.* INTO v_session FROM public.radius_sessions s
   WHERE s.router_id = v_router.id AND s.acct_unique_id = p_unique_id
   FOR UPDATE;
  IF NOT FOUND THEN
    INSERT INTO public.radius_sessions
      (company_id, site_id, router_id, voucher_id, acct_session_id, acct_unique_id,
       calling_station_id, framed_ip, session_seconds, input_bytes, output_bytes,
       stopped_at, terminate_cause)
    VALUES
      (v_router.company_id, v_router.site_id, v_router.id, v_voucher.id, p_session_id,
       p_unique_id, NULLIF(left(p_calling, 64), ''), v_framed, v_time, v_in, v_out,
       CASE WHEN p_status = 'Stop' THEN now() END,
       CASE WHEN p_status = 'Stop' THEN NULLIF(left(p_cause, 40), '') END);
    v_dtime := v_time;
    v_dbytes := v_in + v_out;
  ELSE
    v_dtime := GREATEST(v_time - v_session.session_seconds, 0);
    v_dbytes := GREATEST(v_in - v_session.input_bytes, 0) + GREATEST(v_out - v_session.output_bytes, 0);
    UPDATE public.radius_sessions s
       SET session_seconds = GREATEST(s.session_seconds, v_time),
           input_bytes = GREATEST(s.input_bytes, v_in),
           output_bytes = GREATEST(s.output_bytes, v_out),
           framed_ip = COALESCE(s.framed_ip, v_framed),
           updated_at = now(),
           stopped_at = CASE WHEN p_status = 'Stop' THEN COALESCE(s.stopped_at, now()) ELSE s.stopped_at END,
           terminate_cause = CASE WHEN p_status = 'Stop'
                                  THEN COALESCE(s.terminate_cause, NULLIF(left(p_cause, 40), ''))
                                  ELSE s.terminate_cause END
     WHERE s.id = v_session.id;
  END IF;
  UPDATE public.vouchers v
     SET used_seconds = v.used_seconds + v_dtime,
         used_bytes = v.used_bytes + v_dbytes,
         last_used_at = now(),
         state = CASE
           WHEN v.state NOT IN ('AVAILABLE', 'ACTIVE') THEN v.state
           WHEN (v.session_time_seconds IS NOT NULL
                 AND v.used_seconds + v_dtime >= v.session_time_seconds)
             OR (v.data_quota_bytes IS NOT NULL
                 AND v.used_bytes + v_dbytes >= v.data_quota_bytes) THEN 'EXHAUSTED'
           ELSE 'ACTIVE' END,
         activated_at = COALESCE(v.activated_at, now()),
         expires_at = COALESCE(v.expires_at,
           CASE WHEN v.validity_seconds IS NOT NULL
                THEN now() + make_interval(secs => v.validity_seconds) END)
   WHERE v.id = v_voucher.id;
  RETURN 1;
END
$$;
--> statement-breakpoint
-- Accounting-On / Accounting-Off : le NAS a (re)démarré, ses sessions ouvertes sont closes.
CREATE OR REPLACE FUNCTION radius.accounting_nas(p_nas text, p_status text)
RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_ip inet;
BEGIN
  IF p_status NOT IN ('Accounting-On', 'Accounting-Off') THEN
    RETURN 1;
  END IF;
  BEGIN
    v_ip := p_nas::inet;
  EXCEPTION WHEN others THEN
    RETURN 1;
  END;
  UPDATE public.radius_sessions s
     SET stopped_at = now(), terminate_cause = 'NAS-Reboot', updated_at = now()
    FROM public.routers r
   WHERE s.router_id = r.id AND host(r.tunnel_ip) = host(v_ip) AND r.deleted_at IS NULL
     AND s.stopped_at IS NULL;
  RETURN 1;
END
$$;
--> statement-breakpoint
-- Entretien (worker) : tickets arrivés à expiration, sessions orphelines (aucune mise à jour
-- depuis trois intervalles d'accounting), purge du journal d'authentification (90 jours).
CREATE OR REPLACE FUNCTION radius.housekeeping()
RETURNS TABLE (expired integer, stale_sessions integer, purged_postauth integer)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  UPDATE public.vouchers SET state = 'EXPIRED'
   WHERE state = 'ACTIVE' AND expires_at IS NOT NULL AND expires_at <= now();
  GET DIAGNOSTICS expired = ROW_COUNT;
  UPDATE public.radius_sessions
     SET stopped_at = updated_at, terminate_cause = 'Stale'
   WHERE stopped_at IS NULL AND updated_at < now() - interval '16 minutes';
  GET DIAGNOSTICS stale_sessions = ROW_COUNT;
  DELETE FROM public.radius_postauth WHERE created_at < now() - interval '90 days';
  GET DIAGNOSTICS purged_postauth = ROW_COUNT;
  RETURN NEXT;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION radius.nas_identity(text), radius.decide(text, text, text),
  radius.authorize_check(text, text, text), radius.authorize_reply(text, text, text),
  radius.postauth(text, text, text, text, text),
  radius.accounting(text, text, text, text, text, text, text, text, text, text, text, text, text),
  radius.accounting_nas(text, text), radius.housekeeping()
  FROM PUBLIC, ecsi_app, ecsi_auth, ecsi_worker, ecsi_radius;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION radius.nas_identity(text), radius.authorize_check(text, text, text),
  radius.authorize_reply(text, text, text), radius.postauth(text, text, text, text, text),
  radius.accounting(text, text, text, text, text, text, text, text, text, text, text, text, text),
  radius.accounting_nas(text, text)
  TO ecsi_radius;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION radius.housekeeping() TO ecsi_worker;
