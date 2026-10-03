# Base de données

PostgreSQL 18. Schéma complet cible : [dossier d'architecture v0.1, §8](architecture/dossier-architecture-v0.1.md). Les tables sont créées module par module à partir du Sprint 1.

## Rôles

Créés par [`infra/postgres/init/01-roles.sh`](../infra/postgres/init/01-roles.sh) à l'initialisation du volume (en production : par le provisioning de la base managée, avec les mêmes privilèges).

| Rôle                    | Usage                     | Privilèges                                                                                                     |
| ----------------------- | ------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `postgres`              | Administration uniquement | Superutilisateur, jamais utilisé par l'application                                                             |
| `ecsi_migrator`         | Migrations                | Propriétaire de la base et des schémas ; pas superutilisateur                                                  |
| `ecsi_app`              | API                       | `SELECT/INSERT/UPDATE/DELETE` sur les tables créées par les migrations ; **ni DDL, ni TRUNCATE, ni BYPASSRLS** |
| `radius` _(Sprint 5)_   | FreeRADIUS                | Schéma `radius` uniquement                                                                                     |
| `readonly` _(Sprint 9)_ | Rapports                  | Lecture seule                                                                                                  |

Ces privilèges sont vérifiés par les tests d'intégration (`apps/api/test/foundations.int.test.ts`).

## Migrations

- SQL versionné dans `apps/api/src/database/migrations`, généré par Drizzle (`pnpm db:generate`) ou écrit à la main (`drizzle-kit generate --custom`) pour la RLS, les fonctions et les déclencheurs.
- Appliquées par `pnpm db:migrate` (ou le service `migrate` de Docker Compose) avec le rôle `ecsi_migrator`. Une migration appliquée n'est jamais rejouée (table `drizzle.__drizzle_migrations`).
- En production, les migrations sont **rétrocompatibles** (ajout de colonne nullable, puis remplissage, puis contrainte) et s'exécutent avant le déploiement de la nouvelle version.
- Une migration publiée n'est jamais modifiée : on en écrit une nouvelle.

### Migration 0000 : fondations

- Extensions `pgcrypto` et `citext`.
- Schéma `app` avec :
  - `app.set_updated_at()` : déclencheur de mise à jour de `updated_at` ;
  - `app.current_company_id()` : entreprise de la transaction courante (`set_config('app.company_id', …, true)`), `NULL` sinon ;
  - `app.is_platform_admin()` : contexte super administrateur.

## Conventions

- Clés primaires **UUID v7** (`uuidv7()` natif de PostgreSQL 18, ou généré par l'application).
- `created_at`, `updated_at` (`timestamptz`) partout ; `deleted_at` sur les entités administrables uniquement ; ventes, paiements, sessions et audit sont immuables.
- `company_id` sur toute table tenant, en tête des index et contraintes d'unicité ; clés étrangères composites `(company_id, id)` entre tables tenant.
- Montants en `bigint`, en unité mineure, avec code devise ISO 4217 (`XOF` par défaut, 0 décimale).
- Noms en `snake_case`.

## Isolation des tenants (Sprint 1)

Chaque table tenant reçoit :

```sql
ALTER TABLE <table> ENABLE ROW LEVEL SECURITY;
ALTER TABLE <table> FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON <table>
  USING (company_id = app.current_company_id())
  WITH CHECK (company_id = app.current_company_id());
```

L'API ouvre une transaction, positionne `app.company_id` à partir du jeton authentifié (jamais d'un paramètre client), puis exécute les requêtes. Sans contexte, aucune ligne n'est visible. Une suite de tests d'isolation vérifie chaque endpoint avec deux entreprises.
