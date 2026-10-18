-- ECSI CLOUD — migration 0007 : historique de supervision et alertes dans l'application (lot E1).
-- Additive : aucune table existante n'est modifiée.
--
--  - router_metrics : une mesure par collecte du worker (valeurs déjà collectées par la
--    supervision S3A : statut, charge CPU, mémoire, durée de fonctionnement), conservation
--    bornée (purge par le worker, jamais moins d'un jour).
--  - alerts : ROUTER_OFFLINE, ROUTER_DEGRADED, CPU_HIGH, MEMORY_HIGH ; au plus une alerte
--    ouverte par routeur et par type (index unique partiel alerts_open_key).
--  - (company_id, router_id) -> routers (company_id, id) : rattachement inter-entreprises
--    impossible ; suppression en cascade avec le routeur.
--  - ecsi_app    : lecture de son entreprise (RLS) ; acquittement seulement (colonnes
--                  acknowledged_at / acknowledged_by), au nom de l'utilisateur de la
--                  transaction, une seule fois.
--  - ecsi_auth   : aucun accès.
--  - ecsi_worker : écrit mesures et alertes des SEULS routeurs qu'il supervise (politique
--                  appuyée sur sa RLS de routers), résout les alertes ouvertes, purge les
--                  données anciennes ; ne peut ni acquitter, ni rouvrir une alerte résolue.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ecsi_worker') THEN
    RAISE EXCEPTION 'Le rôle ecsi_worker doit exister (migration 0005)';
  END IF;
END
$$;
--> statement-breakpoint
CREATE TABLE "alerts" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"router_id" uuid NOT NULL,
	"type" text NOT NULL,
	"severity" text NOT NULL,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"acknowledged_at" timestamp with time zone,
	"acknowledged_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "alerts_type_check" CHECK ("alerts"."type" in ('ROUTER_OFFLINE', 'ROUTER_DEGRADED', 'CPU_HIGH', 'MEMORY_HIGH')),
	CONSTRAINT "alerts_severity_check" CHECK ("alerts"."severity" in ('WARNING', 'CRITICAL')),
	CONSTRAINT "alerts_resolved_check" CHECK ("alerts"."resolved_at" is null or "alerts"."resolved_at" >= "alerts"."opened_at"),
	CONSTRAINT "alerts_acknowledged_check" CHECK ("alerts"."acknowledged_by" is null or "alerts"."acknowledged_at" is not null)
);
--> statement-breakpoint
CREATE TABLE "router_metrics" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"router_id" uuid NOT NULL,
	"sampled_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" text NOT NULL,
	"cpu_load" smallint,
	"total_memory" bigint,
	"free_memory" bigint,
	"uptime_seconds" bigint,
	CONSTRAINT "router_metrics_status_check" CHECK ("router_metrics"."status" in ('ONLINE', 'DEGRADED', 'OFFLINE')),
	CONSTRAINT "router_metrics_cpu_load_check" CHECK ("router_metrics"."cpu_load" is null or "router_metrics"."cpu_load" between 0 and 100)
);
--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_acknowledged_by_users_id_fk" FOREIGN KEY ("acknowledged_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_router_fk" FOREIGN KEY ("company_id","router_id") REFERENCES "public"."routers"("company_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "router_metrics" ADD CONSTRAINT "router_metrics_router_fk" FOREIGN KEY ("company_id","router_id") REFERENCES "public"."routers"("company_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "alerts_open_key" ON "alerts" USING btree ("router_id","type") WHERE "alerts"."resolved_at" is null;--> statement-breakpoint
CREATE INDEX "alerts_company_opened_idx" ON "alerts" USING btree ("company_id","opened_at");--> statement-breakpoint
CREATE INDEX "alerts_resolved_at_idx" ON "alerts" USING btree ("resolved_at") WHERE "alerts"."resolved_at" is not null;--> statement-breakpoint
CREATE INDEX "router_metrics_router_time_idx" ON "router_metrics" USING btree ("router_id","sampled_at");--> statement-breakpoint
CREATE INDEX "router_metrics_sampled_at_idx" ON "router_metrics" USING btree ("sampled_at");
--> statement-breakpoint
CREATE TRIGGER alerts_set_updated_at BEFORE UPDATE ON alerts
  FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();
--> statement-breakpoint
ALTER TABLE router_metrics ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE alerts ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON router_metrics, alerts FROM ecsi_app, ecsi_auth, ecsi_worker;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 1. API (ecsi_app) : lecture de l'entreprise du contexte, acquittement des alertes.
-- ---------------------------------------------------------------------------
GRANT SELECT ON router_metrics, alerts TO ecsi_app;
--> statement-breakpoint
GRANT UPDATE (acknowledged_at, acknowledged_by) ON alerts TO ecsi_app;
--> statement-breakpoint
CREATE POLICY tenant_select ON router_metrics FOR SELECT TO ecsi_app
  USING (company_id = app.current_company_id());
--> statement-breakpoint
CREATE POLICY tenant_select ON alerts FOR SELECT TO ecsi_app
  USING (company_id = app.current_company_id());
--> statement-breakpoint
-- Acquittement unique, attribué à l'utilisateur authentifié de la transaction.
CREATE POLICY tenant_acknowledge ON alerts FOR UPDATE TO ecsi_app
  USING (company_id = app.current_company_id() AND acknowledged_at IS NULL)
  WITH CHECK (
    company_id = app.current_company_id()
    AND acknowledged_at IS NOT NULL
    AND acknowledged_by = app.current_user_id()
  );
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 2. Worker de supervision (ecsi_worker, sans tenant).
-- ---------------------------------------------------------------------------
GRANT SELECT, DELETE ON router_metrics TO ecsi_worker;
--> statement-breakpoint
-- sampled_at n'est pas accordé : toujours now() (aucune mesure antidatée).
GRANT INSERT (company_id, router_id, status, cpu_load, total_memory, free_memory, uptime_seconds)
  ON router_metrics TO ecsi_worker;
--> statement-breakpoint
CREATE POLICY worker_select ON router_metrics FOR SELECT TO ecsi_worker USING (true);
--> statement-breakpoint
-- Seulement pour un routeur que le worker supervise (sa politique worker_select de routers :
-- actif, hors enrôlement), dans l'entreprise de ce routeur.
CREATE POLICY worker_insert ON router_metrics FOR INSERT TO ecsi_worker
  WITH CHECK (EXISTS (
    SELECT 1 FROM routers r
     WHERE r.id = router_metrics.router_id AND r.company_id = router_metrics.company_id
  ));
--> statement-breakpoint
CREATE POLICY worker_purge ON router_metrics FOR DELETE TO ecsi_worker
  USING (sampled_at < now() - interval '1 day');
--> statement-breakpoint
GRANT SELECT ON alerts TO ecsi_worker;
--> statement-breakpoint
-- opened_at, acknowledged_* et resolved_at ne sont pas accordés à l'insertion.
GRANT INSERT (company_id, router_id, type, severity, details) ON alerts TO ecsi_worker;
--> statement-breakpoint
GRANT UPDATE (resolved_at) ON alerts TO ecsi_worker;
--> statement-breakpoint
GRANT DELETE ON alerts TO ecsi_worker;
--> statement-breakpoint
CREATE POLICY worker_select ON alerts FOR SELECT TO ecsi_worker USING (true);
--> statement-breakpoint
CREATE POLICY worker_insert ON alerts FOR INSERT TO ecsi_worker
  WITH CHECK (EXISTS (
    SELECT 1 FROM routers r
     WHERE r.id = alerts.router_id AND r.company_id = alerts.company_id
  ));
--> statement-breakpoint
-- Résolution seulement : une alerte résolue n'est jamais rouverte.
CREATE POLICY worker_resolve ON alerts FOR UPDATE TO ecsi_worker
  USING (resolved_at IS NULL) WITH CHECK (resolved_at IS NOT NULL);
--> statement-breakpoint
CREATE POLICY worker_purge ON alerts FOR DELETE TO ecsi_worker
  USING (resolved_at IS NOT NULL AND resolved_at < now() - interval '7 days');
