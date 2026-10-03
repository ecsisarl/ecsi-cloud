# ADR 0003 : PostgreSQL, Drizzle et isolation par RLS

- Statut : acceptée (Sprint 0, 2026-10-03)

## Contexte

Les données d'une entreprise ne doivent jamais être accessibles à une autre. Une base par tenant serait trop coûteuse à exploiter à des centaines d'entreprises et compliquerait le roaming.

## Décision

- **PostgreSQL 18**, schéma partagé, `company_id` sur chaque table tenant.
- Trois barrières : filtrage applicatif obligatoire, **Row-Level Security** (`app.current_company_id()` positionné par transaction), **clés étrangères composites** `(company_id, id)`.
- Rôle applicatif `ecsi_app` sans `BYPASSRLS` ni DDL ; migrations par `ecsi_migrator`.
- **Drizzle ORM** : proche du SQL, transactions avec variables de session simples ; migrations SQL versionnées (générées ou écrites à la main pour la RLS et les fonctions).

## Conséquences

- Une requête oubliée sans filtre renvoie zéro ligne au lieu de fuir des données.
- Les privilèges réels des rôles sont vérifiés par des tests d'intégration sur un vrai PostgreSQL.
- Le super administrateur passe par un contexte explicite (`app.is_platform_admin()`), audité.
