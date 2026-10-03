# ADR 0012 — Sessions serveur, jetons courts et cookies httpOnly

- Statut : Acceptée (Sprint 1)

## Contexte

Le dashboard est une application web servie sur le même domaine que l'API (Nginx). Les
exigences : révocation immédiate des sessions, rotation des refresh tokens avec détection de
réutilisation, protection contre le vol de jetons par XSS, 2FA obligatoire pour certains rôles.

## Décision

- **Session serveur** (`auth_sessions`) = famille de refresh tokens. Chaque requête relit la
  session (non révoquée, non expirée, compte et appartenance actifs) : la révocation, la
  désactivation d'un membre ou d'une entreprise prend effet immédiatement.
- **Jeton d'accès** JWT HS256 de 15 minutes, porteur de l'identifiant de session uniquement
  (`sub`, `sid`, `realm`). L'entreprise courante et l'état 2FA viennent de la base.
- **Refresh token** opaque de 256 bits, stocké haché (SHA-256), rotation à chaque usage, durée
  14 jours, session limitée à 30 jours. Réutilisation d'un jeton déjà tourné au-delà de 30 s :
  la session entière est révoquée. Dans les 30 s, le même successeur est renvoyé (onglets
  simultanés).
- **Transport** : cookies `httpOnly`, `SameSite=Strict`, `Secure` en HTTPS (`ecsi_at`,
  `ecsi_rt`). Pas d'en-tête `Authorization` pour le navigateur : un script injecté ne peut pas
  lire les jetons.
- **CSRF** : double soumission (`ecsi_csrf` lisible, recopié dans `X-CSRF-Token`) sur toute
  méthode non sûre authentifiée, en plus de `SameSite=Strict` et du refus des corps non JSON.
- **Nouvelle session** à chaque connexion et à chaque élévation (2FA validée) : pas de fixation.
- **Realms séparés** : `user` (entreprises) et `platform` (super administrateurs, table
  `platform_admins`), refusés mutuellement sur les routes de l'autre.

## Conséquences

- Une requête authentifiée coûte une lecture de session en base : acceptable aux paliers
  actuels (ADR 0010) ; un cache court pourra être ajouté si les mesures le justifient.
- Les clients non navigateur (application mobile, intégrations) auront besoin d'un mode
  « jeton porteur » dédié : à concevoir quand le besoin existera, sans affaiblir le mode cookie.
