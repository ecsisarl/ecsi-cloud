# ADR 0007 : gestion des secrets

- Statut : acceptée (Sprint 0, 2026-10-03)

## Décision

- Aucun secret dans Git ; `.env` ignoré ; `.env.example` ne contient que des valeurs factices.
- Les valeurs de développement portent le marqueur `devonly` ; l'API **refuse de démarrer en production** si une variable le contient.
- `docker compose up` fonctionne sans configuration grâce à ces valeurs ; `scripts/generate-dev-env.sh` permet des secrets aléatoires en local.
- Scan gitleaks de tout l'historique en CI.
- Production : secrets injectés à l'exécution (Docker secrets + SOPS/age au départ, gestionnaire dédié ensuite) ; secrets applicatifs sensibles (identifiants routeurs, secrets RADIUS, TOTP, providers) chiffrés en base par chiffrement enveloppe (Sprint 2).

## Conséquences

- Une erreur de déploiement avec des valeurs de démonstration est bloquée au démarrage plutôt que découverte en production.
