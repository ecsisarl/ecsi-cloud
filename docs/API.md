# API

Base : `/api/v1`. Documentation interactive OpenAPI : `/api/docs` (document JSON : `/api/docs/openapi.json`), activée hors production.

## Conventions

| Sujet                   | Règle                                                                                                                  |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Format                  | JSON ; dates ISO 8601 en UTC ; montants en entiers (unité mineure) + code devise                                       |
| Validation              | Schémas Zod partagés (`packages/shared`), erreurs 422 avec la liste des champs                                         |
| Erreurs                 | `application/problem+json` (RFC 9457) : `type`, `title`, `status`, `detail`, `instance`, `requestId`, `errors[]`       |
| Traçabilité             | En-tête `X-Request-Id` accepté (8 à 64 caractères `[A-Za-z0-9._-]`) ou généré, renvoyé dans la réponse et les journaux |
| Pagination _(S1+)_      | Par curseur : `?limit=&cursor=`, réponse `{ data, nextCursor }`                                                        |
| Idempotence _(S6+)_     | En-tête `Idempotency-Key` sur les POST sensibles (génération de lots, ventes, paiements)                               |
| Authentification _(S1)_ | Jeton d'accès Bearer court + refresh en cookie httpOnly                                                                |
| Versionnement           | Rupture de compatibilité = nouvelle version `/api/v2`                                                                  |

## Endpoints disponibles (Sprint 0)

| Méthode | Chemin                | Description                                                                                            |
| ------- | --------------------- | ------------------------------------------------------------------------------------------------------ |
| GET     | `/api/v1/health/live` | Vivacité du processus, sans dépendance                                                                 |
| GET     | `/api/v1/health`      | État de PostgreSQL, Redis et du stockage objet ; HTTP 503 si un service indispensable est indisponible |

Exemple :

```json
{
  "status": "ok",
  "service": "ecsi-api",
  "version": "0.1.0-dev",
  "uptimeSeconds": 26,
  "checks": {
    "database": { "status": "ok", "latencyMs": 24 },
    "redis": { "status": "ok", "latencyMs": 4 },
    "storage": { "status": "ok", "latencyMs": 6 }
  }
}
```

## Ressources prévues

auth, companies, users, sites, routers, hotspots, plans, vouchers, sessions, vendors, sales, payments, reports, notifications, audit (voir [ROADMAP.md](ROADMAP.md)).
