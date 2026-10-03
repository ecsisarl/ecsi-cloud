# ADR 0001 : monorepo pnpm + Turborepo

- Statut : acceptée (Sprint 0, 2026-10-03)

## Contexte

API, dashboard, portail captif et futurs agents de passerelle partagent des types, des schémas de validation, la liste des rôles et permissions et des règles monétaires. Les dupliquer créerait des divergences.

## Décision

Un seul dépôt géré par **pnpm workspaces** (dépendances strictes, installation rapide) et **Turborepo** (ordonnancement et cache des tâches). TypeScript strict partout (`strict`, `noUncheckedIndexedAccess`). ESLint unique (typescript-eslint « strict type-checked ») et Prettier.

## Conséquences

- Un changement de contrat (ex. schéma de santé) casse immédiatement la compilation de tous les consommateurs.
- Les images Docker sont construites avec `turbo prune` pour n'embarquer que le nécessaire.
- TypeScript est épinglé en 6.0.x : typescript-eslint ne prend pas encore en charge TypeScript 7 au démarrage du projet.
