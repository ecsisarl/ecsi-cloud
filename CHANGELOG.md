# Journal des modifications

Format inspiré de [Keep a Changelog](https://keepachangelog.com/fr/1.1.0/). Versions par sprint.

## [S3B] — 2026-10-04 — Gestion et enrôlement des routeurs MikroTik

### Ajouté

- API routeurs (`/api/v1/routers`) : liste par entreprise et site, détail, ajout manuel, renommage et déplacement de site, changement des identifiants RouterOS (chiffrés, audités sans valeur), suppression douce ; portée par site et RLS ; console plateforme `GET /platform/companies/:id/routers` (colonnes non sensibles).
- Enrôlement réel depuis ECSI CLOUD : jeton à usage unique, expirant, stocké par empreinte SHA-256, anti-rejeu ; adresse tunnel attribuée par le cloud dans `10.200.0.0/24` (jamais réseau, diffusion, passerelle ni adresse occupée, quarantaine de 7 jours) ; script RouterOS généré à partir du modèle validé au Sprint 3A, valeurs validées contre l'injection ; aucune clé privée de routeur côté cloud.
- Agent passerelle `src/gateway.ts` : synchronisation des pairs WireGuard (/32) et activation par le tunnel uniquement (mot de passe chiffré avant stockage, audit).
- Migration 0006 (additive) : statut `PROVISIONING`, clé publique WireGuard, table `router_enrollment_tokens`, fonctions `SECURITY DEFINER` par rôle ; `ecsi_app` limité à la suppression douce.
- Dashboard : Réseau → Routeurs (liste avec état, IP tunnel, version, CPU, RAM, uptime, dernière connexion ; détail ; « Ajouter un routeur » avec script affiché une seule fois).
- Laboratoire `lab/routeros/s3b` : enrôlement d'un CHR 7.24.5 par l'API réelle, derrière NAT et CGNAT simulés.
- Tests : intégration sur PostgreSQL réel (isolation entre entreprises, jetons, allocation, secrets, suppression douce, privilèges des rôles, audit, montée de version 0005 → 0006), unitaires (script, agent passerelle, schémas).

## [S3A] — 2026-10-04 — Laboratoire MikroTik et fondation applicative

### Ajouté

- Laboratoire RouterOS : réseau simulé WireGuard (NAT, CGNAT, résilience, firewall), CHR RouterOS 7.24.5, protocole d'enrôlement, guide de test matériel (`lab/routeros`).
- Table `routers` (migration 0005) : clé composite entreprise/site, RLS, mot de passe RouterOS chiffré lié au routeur, données de supervision ; rôle PostgreSQL `ecsi_worker` limité à cette table.
- Worker de supervision `src/worker.ts` (NestJS sans HTTP, service `worker` de Docker Compose) : collecte périodique par l'adresse tunnel WireGuard uniquement, états ONLINE / DEGRADED / OFFLINE avec seuils.
- Accès RouterOS en lecture seule : REST HTTPS avec épinglage du certificat, API TCP 8728 ; validation anti-SSRF des adresses tunnel.
- `keys:rotate` ré-enveloppe aussi les mots de passe RouterOS (avec `DATABASE_WORKER_URL`).

## [S2] — 2026-10-03 — Entreprises, utilisateurs, sites, audit

### Ajouté

- Profil d'entreprise complet (nom commercial, raison sociale, logo, téléphone, WhatsApp, e-mail, adresse, pays, devise, langue, fuseau, paramètres ; FR / XOF par défaut).
- Gestion des membres : liste, recherche, filtres, détail, invitation avec portée par site, activation et désactivation, changement de rôles (sessions révoquées), retrait d'accès ; anti-escalade par portée et auto-protection.
- Sites (code unique par entreprise) et groupes de sites (un site dans plusieurs groupes, préparation du roaming GROUPE).
- Portée RBAC par site appliquée côté serveur (404 hors portée, 403 sans permission), `GERANT` et `VENDEUR` limités à leurs sites.
- Journal d'audit persistant en ajout seul, chaîné par hachage SHA-256 en base, vérifiable ; refus et échecs audités ; secrets masqués (migrations 0003 et 0004, ADR 0015).
- Chiffrement enveloppe versionné et commande de rotation `keys:rotate` (ADR 0014).
- Récupération 2FA par un administrateur ou par la plateforme : permission dédiée, code TOTP et motif exigés, sessions révoquées, e-mail, audit.
- Console super administrateur : entreprises (liste, recherche, détail, création, suspension, réactivation), support 2FA, audit de la plateforme et vérification des chaînes (ADR 0013).
- Dashboard : pages Entreprise, Utilisateurs, Sites, Groupes de sites, Journal d'audit, console `/plateforme` ; menu filtré par permissions.
- Tests : intégration (portée par site, administration, plateforme, RLS du journal d'audit), unitaires (chiffrement v2, assainissement, logo, schémas), E2E Sprint 2 (bureau et mobile).
- `RATE_LIMIT_LOGIN_PER_IP` configurable (relevé uniquement pour les E2E).

### Corrigé

- Mise à jour partielle d'un site : les valeurs par défaut de Zod 4 (appliquées même sous `.partial()`) réinitialisaient le statut et les métadonnées.

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
