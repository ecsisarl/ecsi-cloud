# Régression S3B-RC2 sur CHR RouterOS 7.24.5 — TESTÉ RÉELLEMENT, 2026-10-05

Corrections issues de la validation indépendante du Sprint 3B (VPS OVH, commit 1a30dda). Même
chaîne réelle qu'au S3B : API ECSI CLOUD compilée depuis S3B-RC2, PostgreSQL 18 et Redis réels,
agent passerelle et worker de supervision, routeur RouterOS 7.24.5 réel (CHR `chr2`, image
officielle). Réseau du laboratoire SIMULÉ (box NAT et CGNAT en espaces de noms Linux : un
environnement « NAT/CGNAT-like », pas un opérateur réel), passerelle `wireguard-go`. Harnais :
`lab/routeros/s3b/labo-s3b.sh`, pilote `lab/routeros/s3b/pilote.mjs`. Aucun secret ci-dessous.

## Point de départ

Le CHR portait encore la configuration ECSI CLOUD d'un enrôlement précédent (adresse
10.200.0.5/24, pair passerelle), alors que la base du cloud était neuve : c'est le cas
« MikroTik déjà configuré » du rapport de validation (§6.4).

## Déroulé (heures UTC)

| Heure    | Action                                                           | Résultat                                                                                                                                                                               |
| -------- | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 20:21:03 | `pilote enroler CHR2-RC2`                                        | 201, 10.200.0.2, `PROVISIONING`                                                                                                                                                        |
| 20:21    | `pilote voir` d'un identifiant inexistant                        | `ERREUR voir : HTTP 404 (Routeur introuvable)`, code de sortie 1 (plus de TypeError)                                                                                                   |
| 20:21    | Script collé sur le CHR encore configuré (.5)                    | arrêt après l'étape 1 : `ancienne configuration ECSI CLOUD detectee (ecsi-wg 10.200.0.5/24)` ; **aucun objet modifié**, jeton **non consommé** (aucune ligne d'audit `routers.enroll`) |
| 20:22    | `ecsi-retrait.rsc` envoyé par SFTP depuis le LAN, puis `/import` | `ECSI: configuration ECSI CLOUD retiree`, `Script file loaded and executed successfully` ; 0 interface, pair, adresse, règle                                                           |
| 20:22:39 | Script recollé                                                   | étapes 1 à 6 réussies, puis pas de handshake : voir « Constat » ci-dessous                                                                                                             |
| 20:24:03 | Suppression (admin avec 2FA), `r2-simule` enregistré en .3       | 204 ; 201                                                                                                                                                                              |
| 20:24:04 | `pilote enroler CHR2-RC2b`                                       | 201, **10.200.0.4** (.2 en quarantaine, .3 occupée)                                                                                                                                    |
| 20:24    | Script collé (CHR configuré en .2)                               | arrêt après l'étape 1 : `ancienne configuration ECSI CLOUD detectee (ecsi-wg 10.200.0.2/24)`                                                                                           |
| 20:25    | Retrait par SFTP + `/import`, puis script recollé                | **9/9** ; enrôlé 20:25:03, activé 20:25:11                                                                                                                                             |
| 20:25:18 | Worker                                                           | `OFFLINE -> ONLINE` (REST HTTPS épinglé), RouterOS 7.24.5, `consecutiveFailures=0`, `lastError=null`                                                                                   |
| 20:25:36 | `PUT /routers/:id/credentials` avec un faux mot de passe         | 200 ; 20:25:38 `ONLINE -> DEGRADED (AUTH: Identifiants refusés par RouterOS (HTTP 401))`                                                                                               |
| 20:25:55 | Nouveau mot de passe posé sur le routeur puis dans ECSI CLOUD    | 200 ; 20:26:03 `DEGRADED -> ONLINE` ; mot de passe absent des journaux de l'API, du worker et de la passerelle (0 occurrence)                                                          |
| 20:26:23 | Suppression (admin avec 2FA)                                     | 204 ; même seconde : `0 ajouté(s), 0 mis à jour, 1 retiré(s)` ; HTTPS 10.200.0.4 injoignable (000) ; plus aucune collecte                                                              |
| 20:26    | `pilote voir` du routeur supprimé                                | `ERREUR voir : HTTP 404 (Routeur introuvable)`, code de sortie 1                                                                                                                       |

```
ECSI 1/9: RouterOS 7.24.5 (stable)
ECSI: ancienne configuration ECSI CLOUD detectee (ecsi-wg 10.200.0.2/24) : appliquer d'abord le script de retrait ecsi-retrait.rsc, puis recoller ce script
```

```
ECSI 1/9: RouterOS 7.24.5 (stable)
ECSI 2/9: AC verifiee
ECSI 3/9: interface ecsi-wg, cle publique ZnMYLN…U=
ECSI 4/9: firewall
ECSI 5/9: pair passerelle
ECSI 6/9: enrolement accepte
ECSI 7/9: tunnel etabli
ECSI 8/9: API REST HTTPS
ECSI 9/9: routeur enrole, en attente de verification par ECSI CLOUD
```

Journal d'audit des deux routeurs : `routers.enrollment.create`, `routers.enroll`,
`routers.delete`, `routers.enrollment.create`, `routers.enroll`, `router.activated`,
`routers.credentials.update` (×2), `routers.delete`, tous SUCCESS.

## Constat : pair préexistant inconnu de la base

La passerelle du laboratoire porte des pairs simulés configurés à la main (10.200.0.2 et
10.200.0.3), inconnus de la base neuve. Le cloud a attribué 10.200.0.2 ; l'agent passerelle a
refusé, comme prévu, de remplacer le pair inconnu (« Pair ignoré : 10.200.0.2 est déjà tenue par
un pair inconnu de la base ») et le routeur est resté sans tunnel (étape 7 en échec). C'est le
comportement de sécurité attendu ; il est désormais documenté comme prérequis d'exploitation :
tout pair configuré à la main sur la passerelle (comme CHR-LAB sur le VPS) doit être enregistré
dans ECSI CLOUD avant d'activer l'enrôlement (docs/DEPLOYMENT.md, « Agent passerelle »).

## Healthcheck du worker (Docker réel, `docker-compose.yml`)

- Démarrage : `healthy` (« worker : OK (dernier cycle il y a 4 s) »).
- PostgreSQL arrêté : `unhealthy` après 367 s (« dernier cycle réussi il y a 370 s (maximum 300 s) »).
- PostgreSQL redémarré : `healthy` en 30 s.

## Non couvert ici

Image Docker de l'agent passerelle : non construite dans ce bac à sable (dépôt Alpine bloqué par
le proxy) ; construite et démarrée par la CI sur une interface WireGuard réelle du noyau.
Unité systemd : non testée. Matériel physique, Starlink réel, CGNAT d'opérateur réel : non testés.
