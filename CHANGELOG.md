# Journal des modifications

Format inspiré de [Keep a Changelog](https://keepachangelog.com/fr/1.1.0/). Versions par sprint.

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
