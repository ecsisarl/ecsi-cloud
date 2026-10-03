# Base de données

PostgreSQL 18. Schéma complet cible : [dossier d'architecture v0.1, §8](architecture/dossier-architecture-v0.1.md). Les tables sont créées module par module à partir du Sprint 1.

## Rôles

Créés par [`infra/postgres/init/01-roles.sh`](../infra/postgres/init/01-roles.sh) à l'initialisation du volume (en production : par le provisioning de la base managée, avec les mêmes privilèges).

| Rôle                    | Usage                     | Privilèges                                                                                                                                                                                     |
| ----------------------- | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `postgres`              | Administration uniquement | Superutilisateur, jamais utilisé par l'application                                                                                                                                             |
| `ecsi_migrator`         | Migrations                | Propriétaire de la base et des schémas ; pas superutilisateur                                                                                                                                  |
| `ecsi_app`              | API (requêtes métier)     | `SELECT/INSERT/UPDATE/DELETE` sur les tables tenant, soumis à la RLS ; **aucun accès aux tables de secrets** ; ni DDL, ni TRUNCATE, ni BYPASSRLS                                               |
| `ecsi_auth`             | Module d'authentification | Tables de secrets (sessions, facteurs 2FA, jetons) et résolution des appartenances avant tout contexte tenant ; ni DDL ni BYPASSRLS ([ADR 0011](adr/0011-roles-postgresql-rls-module-auth.md)) |
| `radius` _(Sprint 5)_   | FreeRADIUS                | Schéma `radius` uniquement                                                                                                                                                                     |
| `readonly` _(Sprint 9)_ | Rapports                  | Lecture seule                                                                                                                                                                                  |

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

### Migration 0001 : authentification, entreprises, RBAC (générée par Drizzle)

`companies`, `users`, `memberships`, `platform_admins`, `permissions`, `roles`, `role_permissions`, `membership_roles`, `membership_role_sites` (portée par site préparée pour S2), `user_sessions`, `platform_admin_sessions`, `mfa_factors`, `mfa_recovery_codes`, `password_reset_tokens`, `invitations`, `invitation_roles`. Clés étrangères composites `(company_id, id)` entre tables tenant ; e-mails en `citext`.

### Migration 0002 : RLS et privilèges (écrite à la main)

- Tables de secrets retirées à `ecsi_app`, accordées à `ecsi_auth`.
- Politiques `tenant_isolation` sur toutes les tables tenant ; `companies` visible uniquement pour l'entreprise courante ; `users` visible si c'est soi-même ou un membre de l'entreprise courante ; `permissions` en lecture seule.
- `app.current_user_id()` et déclencheurs `updated_at`.

Après les migrations, `pnpm db:migrate` synchronise le catalogue des permissions et les rôles système de chaque entreprise (`src/database/catalog.ts`), de façon idempotente.

### Migration 0003 : profil d'entreprise, sites, groupes, audit (générée par Drizzle)

- `companies` : raison sociale, téléphone, WhatsApp, e-mail, adresse, ville, pays, devise (`XOF` par défaut), langue (`fr`), fuseau, logo, paramètres (`jsonb`), suspension (`suspended_at`, `suspension_reason`).
- `sites` : code unique par entreprise (`(company_id, code)`), adresse, coordonnées, fuseau, contact, statut (`ACTIVE`, `MAINTENANCE`, `INACTIVE`), métadonnées.
- `site_groups` et `site_group_members` (préparation du roaming GROUPE) : clés composites `(company_id, …)`, un site peut appartenir à plusieurs groupes.
- `membership_role_sites` référence désormais `sites` (clé composite).
- `audit_events` : voir [ADR 0015](adr/0015-journal-audit-chaine.md).

### Migration 0004 : RLS, privilèges et journal d'audit (écrite à la main)

- Isolation `tenant_isolation` sur `sites`, `site_groups`, `site_group_members` ; lecture accordée à `ecsi_auth` (compteurs de la console plateforme).
- `companies` : `ecsi_app` ne peut mettre à jour que les colonnes du profil (`GRANT UPDATE (…)` par colonne) ; `ecsi_auth` crée et suspend les entreprises ([ADR 0013](adr/0013-console-plateforme-role-auth.md)).
- `audit_events` : `SELECT` et `INSERT` seulement ; déclencheurs refusant `UPDATE`, `DELETE` et `TRUNCATE` (même au propriétaire) ; déclencheur de chaînage SHA-256 (`app.audit_events_chain`) ; fonction `app.audit_verify_chain(chain_key)` exécutable par `ecsi_auth` seulement ; RLS : une entreprise lit ses événements et n'écrit qu'au nom de l'utilisateur authentifié.

### Données de démonstration

`SEED_PASSWORD=… pnpm db:seed` (refusé en production) crée ENTREPRISE_A (`admin.a`, `gerant.a`, `vendeur.a`, `gerant.site-a` limité à SITE-A, `vendeur.site-b` limité à SITE-B), ENTREPRISE_B (`admin.b`, `gerant.b`) et le super administrateur `superadmin@ecsi.test`, adresses `@ecsi.test`. Sites : SITE-A « Cocody Riviera » et SITE-B « Yopougon Selmer » (groupe GROUPE-ABIDJAN) pour A, SITE-A « Plateau Centre (B) » pour B (même code, autre entreprise). Chaque exécution réinitialise mots de passe, 2FA, sessions, rôles et statut de ces comptes et entreprises.

## Conventions

- Clés primaires **UUID v7** (`uuidv7()` natif de PostgreSQL 18, ou généré par l'application).
- `created_at`, `updated_at` (`timestamptz`) partout ; `deleted_at` sur les entités administrables uniquement ; ventes, paiements, sessions et audit sont immuables.
- `company_id` sur toute table tenant, en tête des index et contraintes d'unicité ; clés étrangères composites `(company_id, id)` entre tables tenant.
- Montants en `bigint`, en unité mineure, avec code devise ISO 4217 (`XOF` par défaut, 0 décimale).
- Noms en `snake_case`.

## Isolation des tenants (en place depuis le Sprint 1)

Chaque table tenant reçoit :

```sql
ALTER TABLE <table> ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON <table> TO ecsi_app
  USING (company_id = app.current_company_id())
  WITH CHECK (company_id = app.current_company_id());
```

`FORCE ROW LEVEL SECURITY` n'est pas utilisé : la RLS s'applique à `ecsi_app` et `ecsi_auth`, qui ne sont pas propriétaires ; seul `ecsi_migrator` (propriétaire, jamais utilisé à l'exécution) y échappe, ce qui lui permet de synchroniser le catalogue (ADR 0011).

`TenantDatabase.run()` ouvre une transaction et positionne `app.company_id` et `app.user_id` (`set_config(…, true)`, portée transaction) à partir de la session authentifiée, jamais d'un paramètre client. Sans contexte, aucune ligne n'est visible. Les services ajoutent en plus un filtre explicite sur `company_id` (défense en profondeur).

Vérifié par `apps/api/test/rls.int.test.ts` (politiques, privilèges par colonne, journal d'audit en ajout seul et chaîné) et `apps/api/test/isolation.int.test.ts` (endpoints avec ENTREPRISE_A et ENTREPRISE_B) ; la portée par site par `apps/api/test/sites.int.test.ts`.
