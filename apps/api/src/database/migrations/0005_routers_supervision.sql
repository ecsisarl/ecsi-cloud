-- ECSI CLOUD — migration 0005 : routeurs MikroTik supervisés (Sprint 3A).
--
--  - (company_id, site_id) -> sites (company_id, id) : rattachement inter-entreprises impossible.
--  - ecsi_app    : accès limité à l'entreprise du contexte (RLS, même politique que les sites).
--  - ecsi_auth   : AUCUN accès (les secrets chiffrés des routeurs ne le concernent pas).
--  - ecsi_worker : worker de supervision, toutes entreprises (il n'a pas de tenant), routeurs
--                  non supprimés seulement ; lecture, et écriture des SEULES colonnes de
--                  supervision (+ le chiffré du mot de passe, pour la rotation de clé). Il ne
--                  peut ni créer, ni supprimer, ni déplacer un routeur, ni changer son adresse
--                  tunnel ou son entreprise. Aucun accès à une autre table.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ecsi_worker') THEN
    RAISE EXCEPTION 'Le rôle ecsi_worker doit exister (infra/postgres/init/01-roles.sh ; base existante : docs/DEPLOYMENT.md)';
  END IF;
END
$$;
--> statement-breakpoint
CREATE TABLE "routers" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'OFFLINE' NOT NULL,
	"transport" text DEFAULT 'REST_HTTPS' NOT NULL,
	"tunnel_ip" "inet" NOT NULL,
	"routeros_username" text NOT NULL,
	"routeros_password_encrypted" text NOT NULL,
	"tls_fingerprint" text,
	"identity" text,
	"routeros_version" text,
	"board_name" text,
	"architecture" text,
	"uptime_seconds" bigint,
	"cpu" text,
	"cpu_count" smallint,
	"cpu_load" smallint,
	"total_memory" bigint,
	"free_memory" bigint,
	"interfaces" jsonb,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"last_seen_at" timestamp with time zone,
	"last_sync_at" timestamp with time zone,
	"last_error" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "routers_status_check" CHECK ("routers"."status" in ('ONLINE', 'DEGRADED', 'OFFLINE')),
	CONSTRAINT "routers_transport_check" CHECK ("routers"."transport" in ('REST_HTTPS', 'API')),
	CONSTRAINT "routers_tunnel_ip_check" CHECK (family("routers"."tunnel_ip") = 4 and masklen("routers"."tunnel_ip") = 32),
	CONSTRAINT "routers_tls_fingerprint_check" CHECK ("routers"."tls_fingerprint" is null or "routers"."tls_fingerprint" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "routers_rest_pinned_check" CHECK ("routers"."transport" <> 'REST_HTTPS' or "routers"."tls_fingerprint" is not null),
	CONSTRAINT "routers_password_format_check" CHECK ("routers"."routeros_password_encrypted" like 'v2:%'),
	CONSTRAINT "routers_cpu_load_check" CHECK ("routers"."cpu_load" is null or "routers"."cpu_load" between 0 and 100),
	CONSTRAINT "routers_failures_check" CHECK ("routers"."consecutive_failures" >= 0)
);
--> statement-breakpoint
ALTER TABLE "routers" ADD CONSTRAINT "routers_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routers" ADD CONSTRAINT "routers_site_fk" FOREIGN KEY ("company_id","site_id") REFERENCES "public"."sites"("company_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "routers_tunnel_ip_key" ON "routers" USING btree ("tunnel_ip") WHERE "routers"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "routers_company_site_idx" ON "routers" USING btree ("company_id","site_id");--> statement-breakpoint
CREATE INDEX "routers_poll_idx" ON "routers" USING btree ("last_sync_at") WHERE "routers"."deleted_at" is null;
--> statement-breakpoint
CREATE TRIGGER routers_set_updated_at BEFORE UPDATE ON routers FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();
--> statement-breakpoint
ALTER TABLE routers ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON routers TO ecsi_app
  USING (company_id = app.current_company_id())
  WITH CHECK (company_id = app.current_company_id());
--> statement-breakpoint
REVOKE ALL ON routers FROM ecsi_auth;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO ecsi_worker;
--> statement-breakpoint
GRANT SELECT ON routers TO ecsi_worker;
--> statement-breakpoint
GRANT UPDATE (
  status, identity, routeros_version, board_name, architecture, uptime_seconds, cpu, cpu_count,
  cpu_load, total_memory, free_memory, interfaces, consecutive_failures, last_seen_at,
  last_sync_at, last_error, routeros_password_encrypted
) ON routers TO ecsi_worker;
--> statement-breakpoint
CREATE POLICY worker_select ON routers FOR SELECT TO ecsi_worker USING (deleted_at IS NULL);
--> statement-breakpoint
CREATE POLICY worker_update ON routers FOR UPDATE TO ecsi_worker
  USING (deleted_at IS NULL) WITH CHECK (deleted_at IS NULL);
