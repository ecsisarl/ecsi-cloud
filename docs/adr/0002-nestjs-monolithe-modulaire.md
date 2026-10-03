# ADR 0002 : NestJS en monolithe modulaire

- Statut : acceptée (Sprint 0, 2026-10-03)

## Contexte

Le cahier des charges laissait le choix entre Laravel et NestJS. Le dossier d'architecture v0.1 recommandait NestJS ; recommandation validée.

## Décision

- **NestJS 12** (ESM) avec l'adaptateur **Fastify**.
- **Monolithe modulaire** : un module par domaine (auth, sites, routers, vouchers…), frontières strictes, pas de microservices.
- Même code, plusieurs processus : HTTP, workers (BullMQ, ajoutés au premier sprint qui en a besoin), planificateur.
- Validation par schémas **Zod** partagés avec le front (`packages/shared`), erreurs RFC 9457.

## Conséquences

- Un seul langage et un seul jeu de types de bout en bout.
- Les classes injectées doivent rester des imports de valeur (métadonnées de décorateurs) : la règle ESLint `consistent-type-imports` est désactivée pour l'API, et les tests utilisent SWC pour émettre ces métadonnées.
- Si un module exige un jour une échelle propre, il pourra être extrait grâce à ses frontières.
