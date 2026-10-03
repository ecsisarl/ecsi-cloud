-- ECSI CLOUD — migration 0003 : profil des entreprises, sites, groupes de sites, journal d'audit.
-- Générée par drizzle-kit depuis src/database/schema. RLS, droits et déclencheurs : migration 0004.

CREATE TABLE "audit_events" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"company_id" uuid,
	"chain_key" text NOT NULL,
	"chain_seq" bigint NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" uuid,
	"actor_label" text,
	"actor_roles" text[] DEFAULT '{}'::text[] NOT NULL,
	"action" text NOT NULL,
	"resource_type" text NOT NULL,
	"resource_id" text,
	"site_id" uuid,
	"result" text NOT NULL,
	"ip" text,
	"user_agent" text,
	"request_id" text,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"prev_hash" "bytea",
	"hash" "bytea" NOT NULL,
	CONSTRAINT "audit_events_actor_type_check" CHECK ("audit_events"."actor_type" in ('USER', 'PLATFORM_ADMIN', 'SYSTEM', 'ANONYMOUS')),
	CONSTRAINT "audit_events_result_check" CHECK ("audit_events"."result" in ('SUCCESS', 'FAILURE', 'DENIED')),
	CONSTRAINT "audit_events_action_check" CHECK ("audit_events"."action" ~ '^[a-z0-9_]+(\.[a-z0-9_]+)+$')
);
--> statement-breakpoint
CREATE TABLE "site_group_members" (
	"company_id" uuid NOT NULL,
	"group_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "site_group_members_group_id_site_id_pk" PRIMARY KEY("group_id","site_id")
);
--> statement-breakpoint
CREATE TABLE "site_groups" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"code" "citext" NOT NULL,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "site_groups_company_id_key" UNIQUE("company_id","id"),
	CONSTRAINT "site_groups_company_code_key" UNIQUE("company_id","code")
);
--> statement-breakpoint
CREATE TABLE "sites" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"code" "citext" NOT NULL,
	"description" text,
	"address" text,
	"city" text,
	"country" text NOT NULL,
	"latitude" double precision,
	"longitude" double precision,
	"timezone" text NOT NULL,
	"phone" text,
	"contact_name" text,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "sites_company_id_key" UNIQUE("company_id","id"),
	CONSTRAINT "sites_status_check" CHECK ("sites"."status" in ('ACTIVE', 'MAINTENANCE', 'INACTIVE')),
	CONSTRAINT "sites_country_check" CHECK ("sites"."country" ~ '^[A-Z]{2}$'),
	CONSTRAINT "sites_coordinates_check" CHECK (("sites"."latitude" is null) = ("sites"."longitude" is null)
        and ("sites"."latitude" is null or "sites"."latitude" between -90 and 90)
        and ("sites"."longitude" is null or "sites"."longitude" between -180 and 180))
);
--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "legal_name" text;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "phone" text;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "whatsapp" text;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "email" "citext";--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "address" text;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "city" text;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "country" text DEFAULT 'CI' NOT NULL;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "currency" text DEFAULT 'XOF' NOT NULL;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "locale" text DEFAULT 'fr' NOT NULL;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "timezone" text DEFAULT 'Africa/Abidjan' NOT NULL;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "logo_object_key" text;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "logo_content_type" text;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "settings" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "suspended_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "suspension_reason" text;--> statement-breakpoint
ALTER TABLE "site_group_members" ADD CONSTRAINT "site_group_members_group_fk" FOREIGN KEY ("company_id","group_id") REFERENCES "public"."site_groups"("company_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_group_members" ADD CONSTRAINT "site_group_members_site_fk" FOREIGN KEY ("company_id","site_id") REFERENCES "public"."sites"("company_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_groups" ADD CONSTRAINT "site_groups_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sites" ADD CONSTRAINT "sites_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "audit_events_chain_key" ON "audit_events" USING btree ("chain_key","chain_seq");--> statement-breakpoint
CREATE INDEX "audit_events_company_time_idx" ON "audit_events" USING btree ("company_id","occurred_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "audit_events_chain_time_idx" ON "audit_events" USING btree ("chain_key","occurred_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "audit_events_actor_idx" ON "audit_events" USING btree ("company_id","actor_id");--> statement-breakpoint
CREATE INDEX "audit_events_resource_idx" ON "audit_events" USING btree ("company_id","resource_type","resource_id");--> statement-breakpoint
CREATE INDEX "audit_events_site_idx" ON "audit_events" USING btree ("company_id","site_id");--> statement-breakpoint
CREATE INDEX "site_group_members_site_idx" ON "site_group_members" USING btree ("company_id","site_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sites_company_code_key" ON "sites" USING btree ("company_id","code") WHERE "sites"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "sites_company_name_idx" ON "sites" USING btree ("company_id","name");--> statement-breakpoint
ALTER TABLE "membership_role_sites" ADD CONSTRAINT "membership_role_sites_site_fk" FOREIGN KEY ("company_id","site_id") REFERENCES "public"."sites"("company_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "membership_role_sites_site_idx" ON "membership_role_sites" USING btree ("company_id","site_id");--> statement-breakpoint
ALTER TABLE "companies" ADD CONSTRAINT "companies_country_check" CHECK ("companies"."country" ~ '^[A-Z]{2}$');--> statement-breakpoint
ALTER TABLE "companies" ADD CONSTRAINT "companies_currency_check" CHECK ("companies"."currency" ~ '^[A-Z]{3}$');--> statement-breakpoint
ALTER TABLE "companies" ADD CONSTRAINT "companies_locale_check" CHECK ("companies"."locale" in ('fr', 'en'));