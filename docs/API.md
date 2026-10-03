# API

Base : `/api/v1`. Documentation interactive OpenAPI : `/api/docs` (document JSON : `/api/docs/openapi.json`), activée hors production.

## Conventions

| Sujet               | Règle                                                                                                                  |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Format              | JSON ; dates ISO 8601 en UTC ; montants en entiers (unité mineure) + code devise                                       |
| Validation          | Schémas Zod partagés (`packages/shared`), erreurs 422 avec la liste des champs                                         |
| Erreurs             | `application/problem+json` (RFC 9457) : `type`, `title`, `status`, `detail`, `instance`, `requestId`, `errors[]`       |
| Traçabilité         | En-tête `X-Request-Id` accepté (8 à 64 caractères `[A-Za-z0-9._-]`) ou généré, renvoyé dans la réponse et les journaux |
| Pagination _(S1+)_  | Par curseur : `?limit=&cursor=`, réponse `{ data, nextCursor }`                                                        |
| Idempotence _(S6+)_ | En-tête `Idempotency-Key` sur les POST sensibles (génération de lots, ventes, paiements)                               |
| Authentification    | Cookies httpOnly (`ecsi_at` 15 min, `ecsi_rt` refresh rotatif) + en-tête `X-CSRF-Token` sur les méthodes non sûres     |
| Versionnement       | Rupture de compatibilité = nouvelle version `/api/v2`                                                                  |

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

## Endpoints Sprint 1

L'entreprise courante vient toujours de la session : aucun endpoint n'accepte de `companyId` pour choisir le tenant (sauf `switch-company`, qui vérifie l'appartenance). Contrats Zod : `packages/shared/src/auth.ts`.

### Authentification (`/api/v1/auth`)

| Méthode | Chemin                    | Accès          | Description                                                                                |
| ------- | ------------------------- | -------------- | ------------------------------------------------------------------------------------------ |
| POST    | `/login`                  | public         | `{ email, password }` → `AUTHENTICATED` (cookies posés) ou `MFA_REQUIRED` (cookie de défi) |
| POST    | `/mfa/verify`             | défi 2FA       | `{ code }` ou `{ recoveryCode }`                                                           |
| POST    | `/refresh`                | cookie refresh | Rotation des jetons (204)                                                                  |
| POST    | `/logout`                 | public         | Révoque la session du cookie refresh et efface les cookies (204)                           |
| GET     | `/me`                     | session        | Utilisateur, entreprise courante, entreprises, rôles, permissions, état 2FA                |
| POST    | `/switch-company`         | session        | Change d'entreprise courante (appartenance active vérifiée)                                |
| GET     | `/sessions`               | session        | Sessions actives de l'utilisateur                                                          |
| DELETE  | `/sessions/:id`           | session        | Révoque une de ses sessions                                                                |
| POST    | `/sessions/revoke-others` | session        | Révoque toutes ses autres sessions                                                         |
| POST    | `/mfa/setup`              | session        | Secret TOTP et URI `otpauth://` (autorisé pendant `SETUP_REQUIRED`)                        |
| POST    | `/mfa/confirm`            | session        | Active la 2FA, renvoie les codes de récupération                                           |
| POST    | `/mfa/recovery-codes`     | session        | Régénère les codes de récupération                                                         |
| POST    | `/password/forgot`        | public         | Toujours 202 ; e-mail envoyé si le compte existe                                           |
| POST    | `/password/reset`         | public         | `{ token, password }` → 204, toutes les sessions révoquées                                 |
| GET     | `/invitations/preview`    | public         | `?token=` → entreprise, adresse, compte existant                                           |
| POST    | `/invitations/accept`     | public         | Crée le compte ou ajoute l'appartenance (201)                                              |

### Super administrateur (`/api/v1/platform/auth`)

`POST /login`, `POST /mfa/verify`, `GET /me`, `POST /mfa/setup`, `POST /mfa/confirm`. Domaine séparé : un jeton d'entreprise y est refusé et inversement. Création du premier compte : `pnpm platform:create-admin --email … --name …` (mot de passe dans `PLATFORM_ADMIN_PASSWORD`).

### Utilisateurs et rôles de l'entreprise courante

| Méthode | Chemin                     | Permission      | Description                                                                                              |
| ------- | -------------------------- | --------------- | -------------------------------------------------------------------------------------------------------- |
| GET     | `/api/v1/users`            | `users.read`    | Membres de l'entreprise                                                                                  |
| GET     | `/api/v1/users/:id`        | `users.read`    | Un membre (404 s'il appartient à une autre entreprise)                                                   |
| PATCH   | `/api/v1/users/:id/status` | `users.disable` | `{ status: ACTIVE \| DISABLED }` ; ni soi-même ni un membre plus privilégié                              |
| GET     | `/api/v1/roles`            | `roles.read`    | Rôles et permissions                                                                                     |
| GET     | `/api/v1/invitations`      | `users.read`    | Invitations en attente                                                                                   |
| POST    | `/api/v1/invitations`      | `users.invite`  | `{ email, roles: [{ roleId, scope }] }` ; anti-escalade ; portée `SITES` refusée (422) jusqu'au Sprint 2 |
| DELETE  | `/api/v1/invitations/:id`  | `users.invite`  | Révoque une invitation                                                                                   |

Codes : 401 non authentifié, 403 permission ou CSRF manquants (ou 2FA à activer), 404 ressource absente ou d'une autre entreprise, 415 corps non JSON, 422 validation, 429 limite de débit (`Retry-After`).

## Ressources prévues

companies (gestion), sites, routers, hotspots, plans, vouchers, sessions, vendors, sales, payments, reports, notifications, audit (voir [ROADMAP.md](ROADMAP.md)).
