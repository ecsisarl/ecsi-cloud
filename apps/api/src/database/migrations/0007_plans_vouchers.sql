CREATE TABLE "plans" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"price_amount" bigint NOT NULL,
	"currency" text DEFAULT 'XOF' NOT NULL,
	"session_time_seconds" integer,
	"validity_seconds" integer,
	"rate_down_kbps" integer,
	"rate_up_kbps" integer,
	"data_quota_bytes" bigint,
	"max_devices" smallint DEFAULT 1 NOT NULL,
	"mac_binding" boolean DEFAULT false NOT NULL,
	"default_scope" text DEFAULT 'LOCAL' NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_public" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "plans_company_id_key" UNIQUE("company_id","id"),
	CONSTRAINT "plans_price_check" CHECK ("plans"."price_amount" >= 0),
	CONSTRAINT "plans_currency_check" CHECK ("plans"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "plans_limits_check" CHECK (coalesce("plans"."session_time_seconds", 1) > 0 and coalesce("plans"."validity_seconds", 1) > 0
        and coalesce("plans"."rate_down_kbps", 1) > 0 and coalesce("plans"."rate_up_kbps", 1) > 0
        and coalesce("plans"."data_quota_bytes", 1) > 0 and "plans"."max_devices" between 1 and 20),
	CONSTRAINT "plans_scope_check" CHECK ("plans"."default_scope" in ('LOCAL', 'GROUP', 'GLOBAL')),
	CONSTRAINT "plans_status_check" CHECK ("plans"."status" in ('ACTIVE', 'INACTIVE'))
);
--> statement-breakpoint
CREATE TABLE "voucher_batches" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"plan_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"label" text,
	"quantity" integer NOT NULL,
	"auth_mode" text NOT NULL,
	"charset" text NOT NULL,
	"code_length" smallint NOT NULL,
	"prefix" text DEFAULT '' NOT NULL,
	"scope_type" text DEFAULT 'LOCAL' NOT NULL,
	"unit_price" bigint NOT NULL,
	"currency" text NOT NULL,
	"expires_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "voucher_batches_company_id_key" UNIQUE("company_id","id"),
	CONSTRAINT "voucher_batches_company_number_key" UNIQUE("company_id","number"),
	CONSTRAINT "voucher_batches_quantity_check" CHECK ("voucher_batches"."quantity" between 1 and 1000),
	CONSTRAINT "voucher_batches_auth_mode_check" CHECK ("voucher_batches"."auth_mode" in ('CODE', 'USER_PASS')),
	CONSTRAINT "voucher_batches_charset_check" CHECK ("voucher_batches"."charset" in ('DIGITS', 'UPPER', 'LOWER', 'UPPER_DIGITS', 'MIXED')),
	CONSTRAINT "voucher_batches_length_check" CHECK ("voucher_batches"."code_length" between 4 and 16),
	CONSTRAINT "voucher_batches_scope_check" CHECK ("voucher_batches"."scope_type" in ('LOCAL', 'GROUP', 'GLOBAL'))
);
--> statement-breakpoint
CREATE TABLE "voucher_events" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"voucher_id" uuid NOT NULL,
	"from_state" text,
	"to_state" text NOT NULL,
	"actor_user_id" uuid,
	"actor_type" text DEFAULT 'USER' NOT NULL,
	"reason" text,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "voucher_events_actor_check" CHECK ("voucher_events"."actor_type" in ('USER', 'SYSTEM', 'RADIUS'))
);
--> statement-breakpoint
CREATE TABLE "vouchers" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"batch_id" uuid NOT NULL,
	"plan_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"serial" integer NOT NULL,
	"code" text NOT NULL,
	"password" text,
	"state" text DEFAULT 'AVAILABLE' NOT NULL,
	"sold_at" timestamp with time zone,
	"activated_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"disabled_at" timestamp with time zone,
	"disabled_by" uuid,
	"disabled_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "vouchers_company_id_key" UNIQUE("company_id","id"),
	CONSTRAINT "vouchers_company_code_key" UNIQUE("company_id","code"),
	CONSTRAINT "vouchers_batch_serial_key" UNIQUE("batch_id","serial"),
	CONSTRAINT "vouchers_state_check" CHECK ("vouchers"."state" in ('AVAILABLE', 'ASSIGNED', 'SOLD', 'ACTIVE', 'EXPIRED', 'DISABLED')),
	CONSTRAINT "vouchers_code_check" CHECK ("vouchers"."code" ~ '^[A-Za-z2-9]{4,24}$'),
	CONSTRAINT "vouchers_disabled_check" CHECK (("vouchers"."state" = 'DISABLED') = ("vouchers"."disabled_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "plans" ADD CONSTRAINT "plans_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voucher_batches" ADD CONSTRAINT "voucher_batches_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voucher_batches" ADD CONSTRAINT "voucher_batches_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voucher_batches" ADD CONSTRAINT "voucher_batches_plan_fk" FOREIGN KEY ("company_id","plan_id") REFERENCES "public"."plans"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voucher_batches" ADD CONSTRAINT "voucher_batches_site_fk" FOREIGN KEY ("company_id","site_id") REFERENCES "public"."sites"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voucher_events" ADD CONSTRAINT "voucher_events_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voucher_events" ADD CONSTRAINT "voucher_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voucher_events" ADD CONSTRAINT "voucher_events_voucher_fk" FOREIGN KEY ("company_id","voucher_id") REFERENCES "public"."vouchers"("company_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vouchers" ADD CONSTRAINT "vouchers_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vouchers" ADD CONSTRAINT "vouchers_disabled_by_users_id_fk" FOREIGN KEY ("disabled_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vouchers" ADD CONSTRAINT "vouchers_batch_fk" FOREIGN KEY ("company_id","batch_id") REFERENCES "public"."voucher_batches"("company_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vouchers" ADD CONSTRAINT "vouchers_plan_fk" FOREIGN KEY ("company_id","plan_id") REFERENCES "public"."plans"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vouchers" ADD CONSTRAINT "vouchers_site_fk" FOREIGN KEY ("company_id","site_id") REFERENCES "public"."sites"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "plans_company_name_key" ON "plans" USING btree ("company_id","name") WHERE "plans"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "voucher_batches_company_created_idx" ON "voucher_batches" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE INDEX "voucher_events_voucher_idx" ON "voucher_events" USING btree ("voucher_id","occurred_at");--> statement-breakpoint
CREATE INDEX "vouchers_company_state_idx" ON "vouchers" USING btree ("company_id","state");--> statement-breakpoint
CREATE INDEX "vouchers_batch_idx" ON "vouchers" USING btree ("batch_id","serial");--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Sprint 6 — forfaits et tickets : isolation, droits et cycle de vie.
--
--  - Isolation stricte par entreprise (RLS, comme les migrations 0002 et 0004) ; clés
--    étrangères composites (company_id, id) : un ticket ne peut référencer ni le forfait,
--    ni le lot, ni le site d'une autre entreprise.
--  - Forfaits : suppression logique uniquement (pas de DELETE pour ecsi_app).
--  - Lots et historique des tickets : ajout seul (ni UPDATE ni DELETE pour ecsi_app).
--  - Tickets : le code, le mot de passe, le lot, le forfait et le site sont immuables ;
--    ecsi_app ne peut modifier que les colonnes du cycle de vie. Un ticket désactivé ou
--    expiré ne revient jamais à un autre état (déclencheur).
-- ---------------------------------------------------------------------------
CREATE TRIGGER plans_set_updated_at BEFORE UPDATE ON plans
  FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();
--> statement-breakpoint
CREATE TRIGGER vouchers_set_updated_at BEFORE UPDATE ON vouchers
  FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.vouchers_guard_state() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF OLD.state IN ('DISABLED', 'EXPIRED') AND NEW.state IS DISTINCT FROM OLD.state THEN
    RAISE EXCEPTION 'Ticket % : état final %, transition vers % refusée', OLD.id, OLD.state, NEW.state
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER vouchers_guard_state BEFORE UPDATE OF state ON vouchers
  FOR EACH ROW EXECUTE FUNCTION app.vouchers_guard_state();
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.vouchers_guard_state() TO ecsi_app;
--> statement-breakpoint
ALTER TABLE plans ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE voucher_batches ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE vouchers ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE voucher_events ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON plans TO ecsi_app
  USING (company_id = app.current_company_id())
  WITH CHECK (company_id = app.current_company_id());
--> statement-breakpoint
CREATE POLICY tenant_isolation ON voucher_batches TO ecsi_app
  USING (company_id = app.current_company_id())
  WITH CHECK (company_id = app.current_company_id());
--> statement-breakpoint
CREATE POLICY tenant_isolation ON vouchers TO ecsi_app
  USING (company_id = app.current_company_id())
  WITH CHECK (company_id = app.current_company_id());
--> statement-breakpoint
CREATE POLICY tenant_isolation ON voucher_events TO ecsi_app
  USING (company_id = app.current_company_id())
  WITH CHECK (company_id = app.current_company_id());
--> statement-breakpoint
REVOKE DELETE ON plans FROM ecsi_app;
--> statement-breakpoint
REVOKE UPDATE, DELETE ON voucher_batches, voucher_events FROM ecsi_app;
--> statement-breakpoint
REVOKE UPDATE, DELETE ON vouchers FROM ecsi_app;
--> statement-breakpoint
GRANT UPDATE (state, sold_at, activated_at, expires_at, disabled_at, disabled_by,
  disabled_reason) ON vouchers TO ecsi_app;
