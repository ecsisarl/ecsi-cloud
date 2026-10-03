# ECSI CLOUD

Plateforme SaaS multi-entreprises de gestion de **WiFi Zones**, **Hotspots MikroTik** (RouterOS v7) et petits fournisseurs d'accès Internet : sites, routeurs, forfaits, tickets, vendeurs, ventes, caisse, paiements, supervision et rapports.

> **État : Sprint 1 (authentification, multi-entreprise, RBAC) terminé, en attente de validation.** Connexion, 2FA, sessions, invitations et isolation des entreprises sont livrées ; les modules métier (sites, routeurs, tickets…) affichent le sprint prévu. Voir [docs/ROADMAP.md](docs/ROADMAP.md).

## Démarrage rapide

Prérequis : Docker avec Docker Compose v2.

```bash
docker compose up --build
```

| Service                     | URL                                 |
| --------------------------- | ----------------------------------- |
| Dashboard                   | http://localhost:8080               |
| API : santé                 | http://localhost:8080/api/v1/health |
| API : documentation OpenAPI | http://localhost:8080/api/docs      |
| Portail captif (gabarit)    | http://localhost:8081               |
| Mailpit (e-mails capturés)  | http://localhost:8025               |

### Comptes de démonstration

```bash
docker compose run --rm -e SEED_PASSWORD='choisir-un-mot-de-passe-long' migrate node dist/database/seed.js
```

Crée ENTREPRISE_A (`admin.a@ecsi.test`, `gerant.a@ecsi.test`, `vendeur.a@ecsi.test`, `gerant.site-a@ecsi.test` limité au site SITE-A, `vendeur.site-b@ecsi.test` limité au site SITE-B), ENTREPRISE_B (`admin.b@ecsi.test`, `gerant.b@ecsi.test`) et le super administrateur `superadmin@ecsi.test` (console sur `/plateforme`, connexion sur `/plateforme/connexion`) avec ce mot de passe. Les administrateurs et le super administrateur doivent activer la 2FA à la première connexion (application TOTP). Les e-mails (réinitialisation, invitations) arrivent dans Mailpit.

Aucun fichier `.env` n'est nécessaire en développement : `docker-compose.yml` fournit des valeurs marquées `devonly`, refusées par l'API en production. Pour utiliser des secrets aléatoires : `./scripts/generate-dev-env.sh` puis `docker compose down -v && docker compose up --build`.

### Développement avec rechargement à chaud

Prérequis : Node.js 22 (`.nvmrc`) et pnpm 10 (`corepack enable`).

```bash
corepack enable
pnpm install
cp .env.example .env                                   # valeurs locales
docker compose up -d postgres redis s3 mailpit         # services d'infrastructure
pnpm build --filter=@ecsi/api && pnpm db:migrate       # migrations
pnpm dev                                               # API :4000, dashboard :3000, portail :3001
```

`pnpm dev` lit le `.env` via votre shell ; avec bash : `set -a; . ./.env; set +a; pnpm dev`.

## Commandes

| Commande                            | Rôle                                                                          |
| ----------------------------------- | ----------------------------------------------------------------------------- |
| `pnpm lint`                         | ESLint (TypeScript strict, règles React/Next)                                 |
| `pnpm typecheck`                    | Vérification des types de tous les paquets                                    |
| `pnpm test`                         | Tests unitaires                                                               |
| `pnpm test:integration`             | Tests d'intégration sur PostgreSQL, Redis et S3 réels (Docker requis)         |
| `pnpm test:e2e`                     | Tests Playwright sur l'environnement Docker démarré et initialisé             |
| `pnpm db:seed`                      | Données de démonstration (`SEED_PASSWORD` requis, refusé en production)       |
| `pnpm platform:create-admin`        | Crée un super administrateur (`--email`, `--name`, `PLATFORM_ADMIN_PASSWORD`) |
| `pnpm format` / `pnpm format:check` | Prettier                                                                      |
| `pnpm build`                        | Build de production de tous les paquets                                       |
| `pnpm db:generate`                  | Génère une migration SQL (Drizzle)                                            |
| `pnpm db:migrate`                   | Applique les migrations (rôle `ecsi_migrator`)                                |
| `pnpm validate`                     | Tout ce qui précède, comme la CI                                              |

## Structure

```
apps/
  api/        NestJS (Fastify) : API REST /api/v1, migrations Drizzle
  web/        Next.js : dashboard (exploitants, gérants, techniciens, comptables, vendeurs)
  portal/     Next.js : portail captif, HTML pur sans JavaScript client
packages/
  shared/     Schémas Zod, types, rôles, utilitaires monétaires (XOF/FCFA)
  ui/         Design system ECSI CLOUD (jetons, composants React)
infra/
  docker/     Dockerfiles (API, applications Next.js)
  nginx/      Reverse proxy de développement
  postgres/   Initialisation des rôles PostgreSQL
e2e/         Tests Playwright de bout en bout
lab/routeros/ Laboratoire MikroTik (CHR et matériel réel)
docs/         Architecture, base de données, sécurité, MikroTik, API, déploiement, ADR
```

## Documentation

- [Architecture](docs/ARCHITECTURE.md) et [dossier d'architecture validé v0.1](docs/architecture/dossier-architecture-v0.1.md)
- [Feuille de route : sprints, MVP technique et MVP commercial](docs/ROADMAP.md)
- [Base de données](docs/DATABASE.md) · [Sécurité](docs/SECURITY.md) · [API](docs/API.md)
- [MikroTik et laboratoire](docs/MIKROTIK.md) · [RADIUS](docs/RADIUS.md) · [Portail captif](docs/PORTAIL-CAPTIF.md)
- [Design system](docs/DESIGN-SYSTEM.md) · [Déploiement](docs/DEPLOYMENT.md)
- [Décisions d'architecture (ADR)](docs/adr/) · [Journal des modifications](CHANGELOG.md)

## Règles du projet

- Développement **sprint par sprint**, chaque sprint validé avant le suivant.
- Aucune fonction MikroTik, WireGuard, RADIUS ou portail captif n'est déclarée terminée sur la seule base de mocks : validation sur CHR **puis** sur matériel RouterOS v7 réel ([docs/MIKROTIK.md](docs/MIKROTIK.md)).
- Aucune commande RouterOS ni API de paiement inventée : documentation officielle uniquement.
- Aucun secret dans Git ([docs/SECURITY.md](docs/SECURITY.md)).
- Commits petits et explicites (Conventional Commits).

Logiciel propriétaire d'ECSI SARL. Tous droits réservés.
