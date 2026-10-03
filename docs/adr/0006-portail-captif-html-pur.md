# ADR 0006 : portail captif en HTML pur, sans JavaScript client

- Statut : acceptée (Sprint 0, 2026-10-03)

## Contexte

Le portail doit être compatible avec les assistants captifs (iOS CNA, détection Android), Windows, macOS et les navigateurs classiques, et rapide sur une mauvaise connexion. Une page Next.js classique embarque le runtime React côté client (plusieurs dizaines de Ko compressés), inutile pour un formulaire de connexion.

## Décision

- L'application `apps/portal` reste une application Next.js (déploiement, routage, appels serveur à l'API), mais ses pages sont produites par des **route handlers** qui renvoient du **HTML pur**.
- Gabarits écrits avec un mini moteur sans dépendance (fonction `html` utilisée comme gabarit étiqueté) qui **échappe toute valeur interpolée** ; React n'est pas utilisé pour ce rendu (Next.js interdit `react-dom/server` dans l'App Router).
- CSS en ligne, aucune ressource externe, CSP `default-src 'none'`.
- Budget de poids vérifié par les tests (< 12 Ko non compressé pour la page de connexion).

## Conséquences

- Page de connexion d'environ 2,4 Ko (1,2 Ko compressée), une seule requête.
- Toute interactivité future doit fonctionner sans JavaScript (formulaires, redirections serveur) ; une exception devra faire l'objet d'une ADR.
