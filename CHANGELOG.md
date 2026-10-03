# Journal des modifications

Format inspiré de [Keep a Changelog](https://keepachangelog.com/fr/1.1.0/). Versions par sprint.

## [S1] — 2026-10-03 — Authentification, multi-entreprise, RBAC

### Ajouté

- Tables d'identité, d'entreprises et de RBAC (migration 0001), RLS et privilèges par rôle (migration 0002), rôle PostgreSQL `ecsi_auth` réservé au module d'authentification.
- Authentification par e-mail et mot de passe (Argon2id), déconnexion, refresh rotatif avec détection de réutilisation, révocation, liste des sessions, mot de passe oublié et réinitialisation, invitations, protection contre la force brute (Redis).
- 2FA TOTP avec codes de récupération, obligatoire pour `SUPER_ADMIN` et `ADMIN_ENTREPRISE`.
- Domaine super administrateur séparé (`/api/v1/platform/auth`) et commande `pnpm platform:create-admin`.
- RBAC : 7 rôles système, catalogue de permissions `ressource.action` synchronisé à la migration, garde globale, anti-escalade, portée par site préparée.
- Endpoints utilisateurs, rôles et invitations de l'entreprise courante.
- Dashboard : pages connexion, mot de passe oublié, réinitialisation, invitation, activation et saisie 2FA, sessions, connexion super administrateur ; refresh côté serveur (`proxy.ts`).
- E-mails transactionnels FR/EN (Mailpit en développement).
- Tests : intégration sur PostgreSQL réel (RLS, auth, isolation ENTREPRISE_A / ENTREPRISE_B, journaux), E2E Playwright (bureau et mobile) en CI.
- Données de démonstration (`pnpm db:seed`), ADR 0011 et 0012.

### Corrigé

- Nginx ne transmettait pas `X-Forwarded-For` dans `location /api/` (les en-têtes `proxy_set_header` ne sont pas hérités quand un bloc en définit) : l'IP vue par l'API était celle de Nginx.

## [S0] — 2026-10-03 — Fondations

### Ajouté

- Monorepo pnpm + Turborepo, TypeScript strict, ESLint (typescript-eslint strict), Prettier.
- `@ecsi/api` : NestJS 12 (Fastify), configuration validée par Zod avec refus des secrets de démonstration en production, santé `/api/v1/health` et `/api/v1/health/live`, journaux pino structurés, erreurs RFC 9457, identifiant de requête, Helmet, CORS, OpenAPI, Drizzle ORM, migration de fondation, script de migration.
- Rôles PostgreSQL `ecsi_migrator` et `ecsi_app` (sans BYPASSRLS ni DDL).
- `@ecsi/web` : dashboard Next.js 16, navigation Activité / Réseau / Administration, tableau de bord avec état réel de la plateforme, pages d'attente des modules, i18n FR/EN, page design system.
- `@ecsi/portal` : portail captif en HTML pur (aucun JavaScript client), CSP stricte, budget de poids testé.
- `@ecsi/shared` : schémas d'API, rôles, langues, utilitaires monétaires (XOF par défaut).
- `@ecsi/ui` : jetons de design et composants de base.
- Docker Compose : PostgreSQL 18, Redis 8, SeaweedFS (S3), Mailpit, migrations, API, dashboard, portail, Nginx.
- CI GitHub Actions : qualité, tests d'intégration, images Docker et démarrage, scan de secrets.
- Documentation : architecture, feuille de route (MVP technique / commercial), base de données, sécurité, MikroTik (stratégie de laboratoire et checklists), RADIUS, API, portail captif, design system, déploiement, ADR 0001 à 0010.
