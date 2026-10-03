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

## Endpoints Sprint 2

Contrats Zod : `packages/shared/src/{company,members,sites,audit,platform}.ts`. Les routes marquées « par site » acceptent une permission détenue sur toute l'entreprise **ou** sur les sites concernés : un site hors de la portée de l'appelant répond 404, un site visible sans la permission demandée répond 403. Toute modification est inscrite au journal d'audit (refus et échecs compris).

### Entreprise courante (`/api/v1/company`)

| Méthode | Chemin      | Permission         | Description                                                                          |
| ------- | ----------- | ------------------ | ------------------------------------------------------------------------------------ |
| GET     | `/`         | `companies.read`   | Profil : noms, contacts, adresse, pays, devise, langue, fuseau, statut, paramètres   |
| PATCH   | `/`         | `companies.update` | Modifie le profil ; statut et identifiant refusés (422)                              |
| PUT     | `/settings` | `settings.manage`  | Remplace les paramètres                                                              |
| PUT     | `/logo`     | `companies.update` | `{ contentType, data }` base64, PNG/JPEG/WebP vérifiés par signature, 512 Ko maximum |
| DELETE  | `/logo`     | `companies.update` | Supprime le logo                                                                     |
| GET     | `/logo`     | session            | Logo de l'entreprise courante                                                        |

### Membres, rôles et invitations

| Méthode | Chemin                        | Permission (par site) | Description                                                                                          |
| ------- | ----------------------------- | --------------------- | ---------------------------------------------------------------------------------------------------- |
| GET     | `/api/v1/users`               | `users.read`          | `?q=&status=&roleId=&siteId=` ; un gestionnaire de site ne voit que les membres de ses sites         |
| GET     | `/api/v1/users/:id`           | `users.read`          | Détail, rôles et sites                                                                               |
| PATCH   | `/api/v1/users/:id/status`    | `users.disable`       | `{ status: ACTIVE \| DISABLED }` ; sessions révoquées à la désactivation ; jamais sur soi-même (403) |
| PUT     | `/api/v1/users/:id/roles`     | `users.update`        | `{ roles: [{ roleId, scope, siteIds? }] }` ; anti-escalade ; sessions du membre révoquées            |
| DELETE  | `/api/v1/users/:id`           | `users.remove`        | Retire l'accès à l'entreprise (le compte personnel est conservé)                                     |
| POST    | `/api/v1/users/:id/mfa/reset` | `users.mfa.reset`     | `{ code, reason }` : code TOTP de l'auteur et motif ; sessions révoquées, e-mail envoyé (204)        |
| GET     | `/api/v1/roles`               | `roles.read`          | Rôles et permissions                                                                                 |
| GET     | `/api/v1/invitations`         | `users.read`          | Invitations en attente (limitées aux sites de l'appelant)                                            |
| POST    | `/api/v1/invitations`         | `users.invite`        | `{ email, roles: [{ roleId, scope, siteIds? }] }` ; portée `SITES` disponible ; anti-escalade        |
| DELETE  | `/api/v1/invitations/:id`     | `users.invite`        | Révoque une invitation                                                                               |

### Sites et groupes de sites

| Méthode | Chemin                                 | Permission                  | Description                                                              |
| ------- | -------------------------------------- | --------------------------- | ------------------------------------------------------------------------ |
| GET     | `/api/v1/sites`                        | `sites.read` (par site)     | `?q=&status=&groupId=` ; uniquement les sites de la portée de l'appelant |
| GET     | `/api/v1/sites/:id`                    | `sites.read` (par site)     | Détail et groupes                                                        |
| POST    | `/api/v1/sites`                        | `sites.create` (entreprise) | Code unique dans l'entreprise (409 sinon)                                |
| PATCH   | `/api/v1/sites/:id`                    | `sites.update` (par site)   | Mise à jour partielle                                                    |
| DELETE  | `/api/v1/sites/:id`                    | `sites.delete` (par site)   | Suppression (retirée des groupes et des rôles par site)                  |
| GET     | `/api/v1/site-groups`                  | `site_groups.read`          | Groupes et leurs sites                                                   |
| GET     | `/api/v1/site-groups/:id`              | `site_groups.read`          | Détail                                                                   |
| POST    | `/api/v1/site-groups`                  | `site_groups.manage`        | Crée un groupe (code unique)                                             |
| PATCH   | `/api/v1/site-groups/:id`              | `site_groups.manage`        | Modifie un groupe                                                        |
| DELETE  | `/api/v1/site-groups/:id`              | `site_groups.manage`        | Supprime un groupe (les sites sont conservés)                            |
| POST    | `/api/v1/site-groups/:id/sites`        | `site_groups.manage`        | `{ siteIds }` : ajoute des sites                                         |
| POST    | `/api/v1/site-groups/:id/sites/remove` | `site_groups.manage`        | `{ siteIds }` : retire des sites                                         |

### Journal d'audit de l'entreprise

| Méthode | Chemin              | Permission   | Description                                                                                                                 |
| ------- | ------------------- | ------------ | --------------------------------------------------------------------------------------------------------------------------- |
| GET     | `/api/v1/audit`     | `audit.read` | `?from=&to=&actorId=&action=&resourceType=&resourceId=&siteId=&result=&q=&cursor=&limit=` (100 max), pagination par curseur |
| GET     | `/api/v1/audit/:id` | `audit.read` | Détail : avant/après, IP, user-agent, identifiant de requête, maillon de chaîne                                             |

### Console super administrateur (`/api/v1/platform`)

Domaine plateforme uniquement, 2FA vérifiée ([ADR 0013](adr/0013-console-plateforme-role-auth.md)).

| Méthode | Chemin                    | Description                                                                                           |
| ------- | ------------------------- | ----------------------------------------------------------------------------------------------------- |
| GET     | `/companies`              | `?q=&status=&page=&limit=` : entreprises, nombre de membres et de sites                               |
| GET     | `/companies/:id`          | Détail, administrateurs, invitations en attente, suspension                                           |
| POST    | `/companies`              | Crée l'entreprise, ses rôles système et l'invitation de son premier administrateur (`adminEmail`)     |
| PATCH   | `/companies/:id/status`   | `{ status: SUSPENDED \| ACTIVE, reason }` ; la suspension révoque toutes les sessions                 |
| GET     | `/users`                  | `?q=` (3 caractères minimum) : recherche d'un utilisateur, ses entreprises et l'état de sa 2FA        |
| POST    | `/users/:id/mfa/reset`    | `{ code, reason }` : réinitialisation 2FA (code TOTP du super administrateur exigé)                   |
| GET     | `/audit`                  | Mêmes filtres que l'audit d'entreprise, plus `companyId`                                              |
| GET     | `/audit/:id`              | Détail d'un événement                                                                                 |
| GET     | `/audit/verify/:chainKey` | `platform` ou identifiant d'entreprise : vérifie la chaîne de hachage, renvoie les maillons invalides |

Codes : 401 non authentifié, 403 permission ou CSRF manquants (ou 2FA à activer), 404 ressource absente ou d'une autre entreprise, 415 corps non JSON, 422 validation, 429 limite de débit (`Retry-After`).

## Ressources prévues

routers, hotspots, plans, vouchers, sessions, vendors, sales, payments, reports, notifications (voir [ROADMAP.md](ROADMAP.md)).
