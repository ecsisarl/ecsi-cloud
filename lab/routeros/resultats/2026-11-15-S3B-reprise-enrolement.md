# Reprise d'un enrôlement interrompu sur CHR RouterOS 7.24.5 — TESTÉ RÉELLEMENT, 2026-11-15

Nouvelle route `POST /routers/:id/enrollment/resume` (droit `routers.create`, réponse
`{router, script}`) et script de reprise `apps/api/src/routers/enrollment-resume-script.ts`.
Validation finale sur le commit **`8521366`** (branche `claude/project-thread-vh99r6`). API, agent
passerelle et worker sont compilés depuis ce commit (`pnpm --filter @ecsi/shared build && pnpm
--filter @ecsi/api build`, puis `labo-s3b.sh services`). La chaîne réelle est celle du S3B :
PostgreSQL 18 et Redis réels, routeur RouterOS 7.24.5 réel (CHR `chr2`, image officielle, QEMU sans
accélération). Le réseau du laboratoire est SIMULÉ (box NAT et CGNAT en espaces de noms Linux,
passerelle `wireguard-go`). Harnais : `lab/routeros/s3b/labo-s3b.sh`. Pilote : copie locale de
`lab/routeros/s3b/pilote.mjs` augmentée d'une commande `reprise`, qui écrit le script servi dans un
fichier 0600.

Aucun secret ci-dessous : le script de reprise ne contient aucun jeton, et les mots de passe
`ecsi-svc` sont générés sur le routeur (`:rndstr`) sans jamais être affichés. Tous les scripts de
reprise ont été collés **tels que servis par l'API**. Avant chaque collage, la présence des
correctifs a été vérifiée dans le script servi : `!disabled` et `last-handshake last-handshake<3m`
présents, `disabled=no` absent du contrôle du pare-feu, contrôle `ecsi-svc` (ligne 66) avant
`# 7.` (ligne 69).

## Défauts trouvés sur CHR et corrigés (version intermédiaire `13fd3b1`)

### Défaut 1 — contrôle du pare-feu : `disabled=no` ne trouve aucune règle de `/ip/firewall/filter`

Le script vérifiait les règles avec `find where comment=$c disabled=no`. Sur un pare-feu d'enrôlement
intact, il s'arrêtait toujours, si bien qu'aucune reprise n'était possible :

```
ECSI: regle de pare-feu ECSI CLOUD absente, desactivee ou en double (ecsi-cloud: retours du tunnel) : reprise annulee ; appliquer le script de retrait ecsi-retrait.rsc puis un nouvel enrolement
```

Mesures sur le CHR, avec cinq règles `ecsi-cloud` actives :

```
:put [:len [/ip/firewall/filter/find where comment="ecsi-cloud: retours du tunnel"]]             -> 1
:put [:len [/ip/firewall/filter/find where comment="ecsi-cloud: retours du tunnel" disabled=no]] -> 0
:put [:len [/ip/firewall/filter/find where comment="ecsi-cloud: retours du tunnel" !disabled]]   -> 1
:put [/ip/firewall/filter/get [find where comment="ecsi-cloud: retours du tunnel"] disabled]      -> false (bool)
:put [:len [/ip/firewall/filter/find where disabled!=yes]]                                       -> 5
:put [:len [/ip/firewall/filter/find where disabled=false]]                                      -> expected yes or no (line 1 column 53)
# une règle désactivée : disabled=yes -> 1 ; where disabled -> 1 ; !disabled -> 4
# autres menus : /interface ... name=ether1 disabled=no -> 1 ; /ip/service ... name=www-ssl disabled=no -> 1
```

Correction : `find where comment=$c !disabled`.

### Défaut 2 — étape 7 : `last-handshake<3m` trouve un pair qui n'a jamais fait de handshake

Le script de reprise a été collé alors que l'UDP 51820 était bloqué depuis la création du pair. Il a
affiché `ECSI 7/9: tunnel etabli`, puis il a exécuté les étapes 8 et 9 sans tunnel : certificat
`ecsi-api`, `www-ssl`, groupe `ecsi-ro`, puis `ecsi-svc` créé et retiré (`activation refusee
(failure: timeout connecting)`).

| Filtre `find where interface=ecsi-wg …` | jamais connecté (`last-handshake` = `nil`) | récent | périmé (> 3 min) |
| --------------------------------------- | ------------------------------------------ | ------ | ---------------- |
| `last-handshake`                        | 0                                          | 1      | 1                |
| `last-handshake<3m`                     | **1**                                      | 1      | 0                |
| `last-handshake>3m`                     | 0                                          | 0      | 1                |
| `last-handshake last-handshake<3m`      | 0                                          | 1      | 0                |

Correction : `last-handshake last-handshake<3m`. Le script initial n'est pas concerné : il teste
`last-handshake` seul, comme au S3B.

### Ordre des contrôles

Dans `13fd3b1`, l'étape 8 (`www-ssl`, certificat) s'exécutait avant le contrôle d'un `ecsi-svc`
existant. Dans `8521366`, ce contrôle a lieu avant l'étape 7, donc avant toute modification (S4
ci-dessous).

## Déroulé final sur `8521366` (heures UTC)

Chaque scénario commence par une remise à zéro : suppression du routeur précédent (administrateur avec
2FA), `ecsi-retrait.rsc` sur le CHR, puis enrôlement initial. Les règles de blocage du namespace `gw`
ont été retirées après chaque scénario (vérifié par `iptables -S`). Pour les refus, des instantanés ont
été pris avant et après : `www-ssl`, `/user`, groupes `ecsi`, `/certificate`, `/ip/firewall/filter`,
WireGuard et pairs, `/ip/address`. Les compteurs volatils (rx, tx, last-handshake, expires-after,
last-logged-in) sont retirés avant la comparaison.

| Heure    | Scénario                                                                       | Résultat                                                                                                                                                                                                                                                           |
| -------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 20:05:51 | R — enrôlement initial `F-REG` (VERSION_GUARD)                                 | 9/9, 10.200.0.10 ; passerelle 20:06:23 « activé depuis 10.200.0.10 » ; worker 20:06:27 `OFFLINE -> ONLINE`                                                                                                                                                         |
| 20:06:40 | S8 — reprise d'un routeur ONLINE                                               | 409 « La reprise est réservée à un routeur dont l'enrôlement est encore en cours » ; audit FAILURE                                                                                                                                                                 |
| 20:06:49 | S2 — enrôlement `F-S2` avec UDP 51820 bloqué (namespace gw)                    | arrêt à l'étape 7 après consommation du jeton ; `PROVISIONING`, clé enregistrée, sans identifiants ; étape 8 jamais exécutée (`www-ssl` désactivé, `certificate=none`, pas de `ecsi-api`)                                                                          |
| 20:08:16 | S2 — reprise collée, UDP toujours bloqué                                       | `ECSI: pas de handshake avec la passerelle ; reprise interrompue` (74 s) ; **état identique avant et après**                                                                                                                                                       |
| 20:11:01 | S4 — `ecsi-ro` et `ecsi-svc` créés à la main, reprise collée                   | refus immédiat (14 s, sans attente de handshake) avec la consigne ; **état identique** : `www-ssl` toujours désactivé, `certificate=none`, aucun certificat `ecsi-api`                                                                                             |
| 20:11    | S5 — règle « ping » désactivée, puis règle « tout le reste du tunnel » absente | refus nommant la règle en cause, dans les deux cas ; état identique ; après rétablissement, l'état est celui d'avant S4                                                                                                                                            |
| 20:12:06 | S2 — UDP débloqué, même script recollé                                         | 7/9, 8/9, `9/9: activation envoyee avec succes` ; passerelle 20:12:21 « activé depuis 10.200.0.11 » ; worker 20:12:22 `OFFLINE -> ONLINE`                                                                                                                          |
| 20:12:45 | S1 — enrôlement `F-S1` avec TCP 8081 bloqué (namespace gw)                     | `activation refusee (failure: timeout connecting) ; compte de service retire` ; `PROVISIONING` avec clé ; aucun `ecsi-svc` sur le routeur                                                                                                                          |
| 20:13:35 | S6 — second routeur `F-AUTRE` (10.200.0.13)                                    | reprise avant consommation : 409 « Le routeur n'a pas encore consommé son jeton d'enrôlement » (S8). Jeton consommé depuis l'Internet du laboratoire (espace de noms « attaquant », clé publique générée) : 200. Son script collé sur chr2 : refus, état identique |
| 20:13:57 | S1 — 8081 débloqué, reprise collée                                             | 7/9, 8/9, 9/9 ; passerelle 20:14:11 « activé depuis 10.200.0.12 » ; worker 20:14:12 `OFFLINE -> ONLINE`                                                                                                                                                            |
| 20:15:24 | S3 — `F-S3` (enrôlé avec 8081 bloqué, tunnel monté), UDP 51820 bloqué          | après 3 min 36 s : `last-handshake` 1, `<3m` 0, `>3m` 1 ; reprise : `pas de handshake … reprise interrompue`, sans ligne 7/9 ; état identique                                                                                                                      |
| 20:20:26 | S3 — débloqué, recollé                                                         | 9/9 ; passerelle 20:20:40 « activé depuis 10.200.0.14 » ; worker 20:20:43 ONLINE                                                                                                                                                                                   |
| 20:21:53 | S7 — `F-S7` (enrôlé avec 8081 bloqué), réponses de l'agent supprimées          | `activation non confirmee (failure: timeout waiting data) ; compte de service conserve …` ; `ecsi-svc` présent ; passerelle 20:22:08 « activé depuis 10.200.0.15 » ; worker 20:22:13 `OFFLINE -> ONLINE`                                                           |

Blocages utilisés, tous dans le namespace `gw` :

- étape 9 : `-I INPUT 1 -i wg-gw -p tcp --dport 8081 -j DROP` ;
- étape 7 : `-I INPUT 1 -i wan -p udp --dport 51820 -j DROP` ;
- handshake périmé (S3) : la même règle plus `-I OUTPUT 1 -o wan -p udp --sport 51820 -j DROP` ;
- réponse perdue (S7) : `-I OUTPUT 1 -o wg-gw -p tcp --sport 8081 ! --tcp-flags SYN,ACK SYN,ACK -j DROP`.
  Le SYN-ACK passe, la requête arrive donc à l'agent ; 31 paquets de réponse ont été supprimés.

Sorties de console (scripts servis par l'API) :

```
S2, reprise UDP bloqué / S3, handshake périmé :
ECSI: pas de handshake avec la passerelle ; reprise interrompue

S4 :
ECSI: ecsi-svc existe deja ; reprise automatique refusee pour proteger le compte existant. Si ECSI CLOUD affiche toujours ce routeur en cours d'enrolement, retirer ce compte (/user/remove [find where name="ecsi-svc"]) puis recoller ce script ; sinon ne rien faire

S5 :
ECSI: regle de pare-feu ECSI CLOUD absente, desactivee ou en double (ecsi-cloud: ping depuis la passerelle) : reprise annulee ; appliquer le script de retrait ecsi-retrait.rsc puis un nouvel enrolement
ECSI: regle de pare-feu ECSI CLOUD absente, desactivee ou en double (ecsi-cloud: tout le reste du tunnel) : reprise annulee ; appliquer le script de retrait ecsi-retrait.rsc puis un nouvel enrolement

S6 :
ECSI: ce script de reprise appartient a un autre routeur

S1, S2, S3 (après déblocage) :
ECSI 7/9: tunnel etabli
ECSI 8/9: API REST HTTPS
ECSI 9/9: activation envoyee avec succes

S7 :
ECSI 7/9: tunnel etabli
ECSI 8/9: API REST HTTPS
ECSI: activation non confirmee (failure: timeout waiting data) ; compte de service conserve. Si ECSI CLOUD affiche ce routeur En ligne dans les 2 minutes, l'enrolement est termine ; s'il reste en cours d'enrolement, retirer ecsi-svc puis recoller ce script
```

Enrôlements initiaux interrompus (script initial de `8521366`) :

```
S2 : ECSI 6/9: enrolement accepte
     ECSI: pas de handshake avec la passerelle (jeton refuse, ou UDP 51820 sortant bloque)
S1, S3, S7 : ECSI 7/9: tunnel etabli
             ECSI 8/9: API REST HTTPS
             ECSI: activation refusee (failure: timeout connecting) ; compte de service retire
```

Audit `routers.enrollment.resume` :

```
20:06:40 | FAILURE | F-REG   | {"reason": "La reprise est réservée à un routeur dont l'enrôlement est encore en cours", "status": 409}
20:08:15 | SUCCESS | F-S2    | {"name": "F-S2", "tunnelIp": "10.200.0.11"}
20:13:35 | SUCCESS | F-S1    | {"name": "F-S1", "tunnelIp": "10.200.0.12"}
20:13:35 | FAILURE | F-AUTRE | {"reason": "Le routeur n'a pas encore consommé son jeton d'enrôlement", "status": 409}
20:13:35 | SUCCESS | F-AUTRE | {"name": "F-AUTRE", "tunnelIp": "10.200.0.13"}
20:15:24 | SUCCESS | F-S3    | {"name": "F-S3", "tunnelIp": "10.200.0.14"}
20:21:53 | SUCCESS | F-S7    | {"name": "F-S7", "tunnelIp": "10.200.0.15"}
```

## Classement

| #   | Scénario                                          | Statut                                         |
| --- | ------------------------------------------------- | ---------------------------------------------- |
| R   | Enrôlement initial (VERSION_GUARD)                | TESTÉ RÉELLEMENT                               |
| S1  | Coupure à l'étape 9, puis reprise                 | TESTÉ RÉELLEMENT                               |
| S2  | Coupure à l'étape 7, reprise bloquée puis reprise | TESTÉ RÉELLEMENT                               |
| S3  | Handshake périmé, puis recollage                  | TESTÉ RÉELLEMENT                               |
| S4  | `ecsi-svc` résiduel (étape 8 jamais faite)        | TESTÉ RÉELLEMENT                               |
| S5  | Règle désactivée ou absente                       | TESTÉ RÉELLEMENT                               |
| S6  | Script d'un autre routeur                         | TESTÉ RÉELLEMENT                               |
| S7  | Réponse d'activation perdue                       | TESTÉ RÉELLEMENT                               |
| S8  | Refus 409 (ONLINE, jeton non consommé)            | TESTÉ RÉELLEMENT (API)                         |
| S9  | VERSION_GUARD                                     | TESTÉ RÉELLEMENT (analyse de chaînes imposées) |

## S9 — VERSION_GUARD

Bloc copié de `enrollment-script.ts`. Il a été exécuté sur la console du CHR 7.24.5 avec
`:local ver` imposé, dans un `:onerror`.

```
GUARD OK (7.24.5 (stable)) minor=24
GUARD ERR: ECSI: RouterOS 7.15 minimum requis (version: 7.14.3 (stable)) : aucune modification effectuee
GUARD ERR: ECSI: version RouterOS non reconnue (7.23rc1 (testing)) : aucune modification effectuee
GUARD OK (7.15 (stable)) minor=15
GUARD OK (7.24.6 (long-term)) minor=24
```

## Constats

- **Versions candidates refusées** : `7.23rc1 (testing)` est refusée comme « non reconnue », car
  `:tonum "23rc1"` n'est pas un nombre. Ce comportement semble voulu, mais il n'est pas documenté.
- **Audit par appel de l'API** : une ligne `routers.enrollment.resume` est écrite à chaque obtention
  du script (SUCCESS, ou FAILURE avec le motif du 409), pas à chaque collage sur le routeur. Les
  refus côté routeur (S2 à S6) n'apparaissent pas dans l'audit.
- **Réponse perdue** : l'agent passerelle enregistre l'activation dès réception de la requête. Le
  compte conservé par le script suffit : le worker passe le routeur ONLINE sans autre action.
- **Pair préexistant** : comme au S3B-RC2, les pairs simulés `r1`/`r2` de `topology.sh` ont été
  retirés de `wg-gw` avant les essais. L'agent passerelle refuse en effet de remplacer un pair
  inconnu de la base.

## Non couvert ici

Matériel physique ; RouterOS autre que 7.24.5 (S9 ne teste que l'analyse des chaînes de version) ;
Starlink réel, CGNAT d'opérateur réel ; agent passerelle avec le module WireGuard du noyau.
