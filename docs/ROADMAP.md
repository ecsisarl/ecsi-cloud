# Feuille de route

Sprints de deux semaines. **Un seul sprint à la fois** : à la fin de chaque sprint, un rapport de validation est produit et le sprint suivant ne démarre qu'après accord explicite.

Chaque module suit : PLAN → DATABASE → BACKEND → API → FRONTEND → TESTS → DOCUMENTATION → VALIDATION.

## Définition de « terminé » pour un sprint

1. `pnpm lint` sans erreur
2. `pnpm typecheck` sans erreur
3. `pnpm test` et `pnpm test:integration` verts
4. `docker compose up --build` fonctionnel, santé OK
5. Migrations appliquées sur base vierge et rejouables sans effet
6. Tests d'isolation des tenants verts (à partir du Sprint 1)
7. Documentation à jour
8. Liste des fichiers créés ou modifiés
9. Liste des fonctionnalités terminées
10. Ce qui reste non testé, dit clairement
11. Dettes techniques identifiées
12. Point de restauration Git (tag `sN-done`)

Pour les fonctions MikroTik : checklist de [MIKROTIK.md](MIKROTIK.md) cochée sur CHR **et** sur matériel réel.

## Sprints

| Sprint  | Contenu                                                                                                                             | Statut                                      |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| **S0**  | Fondations : monorepo, Docker, CI, API de base, dashboard, portail, design system, documentation                                    | ✅ Validé (commit `119ec9a`)                |
| **S1**  | Authentification, multi-tenant, RBAC, tests d'isolation                                                                             | ✅ Validé (commit `f624e99`)                |
| **S2**  | Entreprises, utilisateurs, sites, groupes de sites, audit                                                                           | ✅ Validé (commit `8984de6`)                |
| **S3A** | Laboratoire CHR (RouterOS v7, WireGuard, API par le tunnel) et fondation applicative                                                | ✅ Validé (commit `7a89b61`)                |
| **S3B** | Gestion et enrôlement des routeurs depuis ECSI CLOUD (RC2)                                                                          | ✅ Validé (commit `7496075`, tag `s3b-rc2`) |
| **S3H** | Durcissement et préproduction : sauvegarde/restauration, rotation des secrets, TLS public, gateway systemd, E2E Routeurs, guide VPS | 🔄 En cours (H0 validé, H1 livré)           |
| S4      | Monitoring, statut ONLINE/OFFLINE, alertes in-app                                                                                   | ○                                           |
| S5      | RADIUS central (portée LOCAL), accounting, CoA, configuration Hotspot                                                               | ○                                           |
| S6      | Forfaits et tickets                                                                                                                 | ○                                           |
| S7      | Portail captif connecté au Hotspot, clients connectés, walled garden                                                                | ○                                           |
| S8      | Vendeurs, ventes, caisse journalière                                                                                                | ○                                           |
| S9      | Dashboard réel, rapports, exports                                                                                                   | ○                                           |
| S10     | Durcissement, E2E, tests de charge, staging → **MVP technique**                                                                     | ○                                           |
| S11     | ECSI Roaming GROUPE et GLOBAL, validation multi-sites réelle                                                                        | ○                                           |
| S12     | Premier fournisseur de paiement (documentation officielle et accès requis)                                                          | ○                                           |
| S13     | Backups MikroTik, notifications e-mail → **MVP commercial** (avec S11 et S12)                                                       | ○                                           |

## MVP technique

Périmètre du dossier v0.1 §12 avec tickets en portée **LOCAL** et sans paiement en ligne.

## MVP commercial

MVP technique, plus :

- portées de tickets **LOCAL, GROUPE, GLOBAL** ;
- **au moins un fournisseur de paiement** réellement utilisable en Côte d'Ivoire, intégré avec sa documentation officielle ;
- **validation réelle** d'un ticket utilisé successivement sur au moins deux sites MikroTik autorisés (et refusé sur un site non autorisé), avec consommation partagée exacte.

## Reporté en V2

Voir le dossier v0.1 §13 : notifications WhatsApp/SMS/Telegram/Push, ECSI AI, PPPoE/ISP, abonnement SaaS ECSI, application mobile native, marque blanche, API publique, tunnel de secours TCP, Kubernetes.
