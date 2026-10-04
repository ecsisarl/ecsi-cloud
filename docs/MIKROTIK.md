# MikroTik : intégration et laboratoire

Ce document définit la **stratégie de laboratoire obligatoire** et les **checklists de validation** des fonctions MikroTik. L'intégration elle-même (enrôlement, WireGuard, RADIUS, Hotspot) commence au Sprint 3 ; ce document sera complété à chaque sprint avec les scripts testés et les résultats.

## Règles

1. **Jamais terminé sur la seule base de mocks.** Les fonctions de la liste ci-dessous peuvent avoir des tests unitaires avec doublures, mais elles ne sont déclarées terminées qu'après validation sur un routeur réel.
2. **CHR d'abord, matériel ensuite.** Une fonction validée sur CHR est « validée CHR », pas « terminée ». Elle est terminée après validation sur au moins un équipement physique RouterOS v7, puis étendue aux autres modèles de la matrice.
3. **Un comportement CHR n'est jamais généralisé.** Les différences possibles entre CHR et matériel (architecture, pilotes, capteurs de température, licence, interfaces sans fil, accélération matérielle) sont vérifiées modèle par modèle.
4. **Documentation officielle uniquement.** Chaque commande RouterOS utilisée par ECSI CLOUD référence la page de [help.mikrotik.com](https://help.mikrotik.com/docs/) correspondante et la version RouterOS sur laquelle elle a été testée. Aucune commande n'est écrite de mémoire.
5. **Preuves conservées.** Chaque validation produit une fiche de résultats (`lab/routeros/resultats/`) avec version RouterOS, modèle, date, étapes, résultat et journaux.

## Fonctions soumises au laboratoire

WireGuard · enrôlement automatique · RouterOS REST API · Hotspot · FreeRADIUS · accounting · CoA / Disconnect · Session-Timeout · limitations de débit · quotas data · MAC binding · portail captif · walled garden · tickets multi-sites.

## Topologie du laboratoire

### Niveau 1 : CHR (Cloud Hosted Router)

- Une ou deux VM RouterOS CHR (image officielle téléchargée depuis mikrotik.com), dans QEMU/KVM, VirtualBox ou Proxmox.
- Une VM cliente Linux derrière l'interface Hotspot du CHR (navigateur, `curl`, outils de mesure de débit).
- Côté cloud : la passerelle de laboratoire (WireGuard + FreeRADIUS) en Docker sur la machine de développement, puis sur un serveur de staging à IP publique.
- **Limite connue à vérifier** : la licence gratuite CHR bride le débit par interface. Les tests de limitation de débit et de quotas importants nécessitent une licence d'essai ou du matériel réel. Vérifier les conditions sur la page officielle des licences CHR avant chaque campagne.

### Niveau 2 : matériel réel

| Équipement         | Rôle dans le laboratoire                                                |
| ------------------ | ----------------------------------------------------------------------- |
| MikroTik hAP ax3   | Point d'accès WiFi intégré : test de bout en bout avec téléphones réels |
| MikroTik L009      | Routeur de petite WiFi Zone, points d'accès externes                    |
| MikroTik RB5009    | Routeur de site plus chargé, plusieurs points d'accès                   |
| Autres RouterOS v7 | Ajoutés à la matrice au fil des clients                                 |

Liens montants à tester :

- connexion fixe derrière NAT (cas courant) ;
- **connexion 4G/CGNAT sans IP publique** (cas critique : le tunnel doit s'établir) ;
- connexion instable (coupures volontaires du lien pour tester la reconnexion).

Terminaux clients : au moins un Android récent, un iPhone récent, un ordinateur Windows, un Mac.

### Matrice de versions

Renseignée lors des tests, jamais supposée. Une ligne par couple modèle × version RouterOS testée.

| Modèle  | Architecture (relevée) | Version RouterOS | Canal  | Date          | Fiche de résultats                                                                                                                                                                                                       |
| ------- | ---------------------- | ---------------- | ------ | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| CHR     | x86_64                 | 7.24.5           | stable | 2026-10-03/04 | [sécurité](../lab/routeros/resultats/2026-10-03-S3A-chr-securite.md), [résilience](../lab/routeros/resultats/2026-10-03-S3A-chr-resilience.md), [enrôlement](../lab/routeros/resultats/2026-10-04-S3A-chr-enrolement.md) |
| hAP ax3 | à relever              | à relever        | stable |               |                                                                                                                                                                                                                          |
| L009    | à relever              | à relever        | stable |               |                                                                                                                                                                                                                          |
| RB5009  | à relever              | à relever        | stable |               |                                                                                                                                                                                                                          |

La **version minimale de RouterOS v7 supportée** par ECSI CLOUD sera fixée à partir de cette matrice, au Sprint 3.

## Procédure commune avant chaque test

1. Partir d'une configuration connue (configuration par défaut ou export de référence du laboratoire).
2. Relever modèle, architecture et version RouterOS.
3. Exporter la configuration avant le test, puis après, et conserver la différence.
4. Exécuter la checklist, consigner chaque résultat, joindre journaux et captures.
5. Revenir à l'état initial.

## Checklists de validation

Chaque case est cochée deux fois : **CHR** puis **matériel** (en précisant le modèle). Une case
reste vide tant que le matériel n'est pas validé ; l'état CHR est indiqué entre parenthèses.
Sprint 3A : le matériel se teste avec [GUIDE-TEST-MATERIEL.md](../lab/routeros/GUIDE-TEST-MATERIEL.md).

### 1. WireGuard

- [ ] Le routeur établit le tunnel sans IP publique (derrière NAT, puis derrière CGNAT 4G). (CHR 7.24.5 : validé derrière box + CGNAT simulés)
- [ ] Le handshake est visible côté passerelle ; le routeur passe ONLINE dans ECSI CLOUD.
- [ ] La clé privée est générée sur le routeur ; seule la clé publique parvient au cloud (vérifié en base et dans les journaux). (CHR : validé avec le serveur d'enrôlement de labo)
- [ ] Coupure du lien montant : le routeur passe OFFLINE dans le délai attendu, puis ONLINE automatiquement au retour. (CHR : validé, OFFLINE à 180 s, retour en 3,3 s)
- [ ] Redémarrage du routeur : reconnexion automatique sans intervention. (CHR : validé, 34 s en émulation)
- [ ] Révocation : le peer est retiré, le routeur ne joint plus ni l'API ni RADIUS. (CHR : API validée ; RADIUS hors périmètre S3A)
- [ ] Renouvellement de clé sans coupure de service des clients WiFi. (non testé)
- [ ] Le routeur ne peut joindre que l'adresse de sa passerelle (pas les autres routeurs). (CHR : validé, y compris passerelle volontairement ouverte)

### 2. Enrôlement automatique

- [ ] La commande générée s'exécute telle quelle dans le terminal RouterOS (copier-coller depuis le dashboard). (CHR : validé par collage du script de labo ; dashboard au Sprint 3B)
- [ ] Le jeton est à usage unique : une seconde exécution est refusée et journalisée. (CHR + serveur de labo : validé, y compris 8 requêtes simultanées)
- [ ] Un jeton expiré est refusé. (serveur de labo : validé)
- [ ] Rejouer le script sur un routeur déjà enrôlé ne crée pas de doublons. (CHR : validé)
- [ ] Le routeur est détecté automatiquement (modèle, version, numéro de série remontés). (CHR : modèle et version lus par REST ; numéro de série absent sur CHR)
- [ ] Le script de retrait supprime proprement la configuration ECSI. (non écrit)

### 3. RouterOS REST API

- [ ] Accessible uniquement par l'adresse tunnel de la passerelle ; **inaccessible depuis le WAN et le LAN** (testé depuis l'extérieur et depuis un client WiFi). (CHR : validé, preuve par compteur de la règle de refus)
- [ ] Le compte ECSI n'a que les permissions nécessaires : une action hors périmètre est refusée par le routeur. (CHR : validé avec read,api,rest-api)
- [ ] Lecture des ressources système, interfaces, compteurs : valeurs cohérentes avec WinBox/terminal. (CHR : lu par REST ; comparaison WinBox à faire sur matériel)
- [ ] Temps de réponse et comportement en cas de lien lent mesurés. (CHR : 12 à 44 ms par appel en labo ; lien lent non testé)
- [ ] Chaque commande sensible apparaît dans l'audit ECSI CLOUD (qui, quoi, quand, résultat).

### 4. Hotspot

- [ ] Hotspot configuré pour utiliser RADIUS, sur l'interface prévue.
- [ ] Un client non authentifié est redirigé vers la page de connexion.
- [ ] Un client authentifié accède à Internet ; la session apparaît côté routeur et dans ECSI CLOUD.
- [ ] Déconnexion par l'utilisateur et expiration de session fonctionnelles.

### 5. FreeRADIUS (authentification)

- [ ] Access-Request reçu uniquement par le tunnel ; le NAS est identifié par son IP tunnel.
- [ ] Ticket valide accepté ; ticket invalide, désactivé ou expiré refusé (avec motif dans le journal post-auth).
- [ ] Routeur inconnu ou révoqué refusé.
- [ ] Secret RADIUS propre à chaque routeur.
- [ ] Bascule vers le serveur RADIUS secondaire (quand il existe).

### 6. Accounting

- [ ] Start, Interim-Update et Stop enregistrés dans PostgreSQL avec les bons compteurs.
- [ ] Les octets et durées correspondent aux compteurs du routeur (écart documenté).
- [ ] Redémarrage du routeur sans Stop : sessions fermées par Accounting-On ou par le nettoyage des sessions orphelines.
- [ ] Aucun doublon de session après rejeu d'un paquet.

### 7. CoA / Disconnect

- [ ] « Déconnecter ce client » depuis ECSI CLOUD coupe la session sur le routeur.
- [ ] La désactivation d'un ticket coupe la session en cours.
- [ ] Les requêtes CoA ne sont acceptées que depuis la passerelle, par le tunnel.

### 8. Session-Timeout

- [ ] La session se termine à la durée restante calculée.
- [ ] Temps cumulé : reconnexion avec le même ticket, le temps restant est correct.
- [ ] Validité calendaire : le ticket expire à la date attendue même sans utilisation continue.

### 9. Limitations de débit

- [ ] Débits montant et descendant appliqués conformément au forfait (mesurés côté client).
- [ ] Le sens montant/descendant est correct (vérification explicite, source fréquente d'inversion).
- [ ] Comportement identique sur chaque modèle de la matrice (mesures consignées).

### 10. Quotas data

- [ ] La session se coupe quand le quota est atteint.
- [ ] Quotas supérieurs à 4 Go correctement appliqués.
- [ ] Le quota restant est correct après reconnexion.

### 11. MAC binding

- [ ] Ticket lié à la première adresse MAC lorsque le forfait l'exige ; refusé depuis une autre MAC.
- [ ] Comportement documenté face à la randomisation des adresses MAC (Android, iOS) : message clair à l'utilisateur.

### 12. Portail captif

- [ ] Détection automatique du portail et connexion réussie sur : Android, iPhone (Captive Network Assistant), Windows, macOS, navigateur classique.
- [ ] Temps de chargement mesuré sur connexion lente (3G simulée).
- [ ] Fonctionne avec les limitations de l'assistant captif iOS (pas de JavaScript requis).
- [ ] Personnalisation (logo, couleurs, textes) visible.

Voir [PORTAIL-CAPTIF.md](PORTAIL-CAPTIF.md).

### 13. Walled garden

- [ ] Le portail ECSI CLOUD est accessible avant authentification ; le reste d'Internet ne l'est pas.
- [ ] Domaines nécessaires au paiement autorisés (quand le paiement existe), et uniquement eux.
- [ ] Entrées générées automatiquement et identiques sur tous les modèles.

### 14. Tickets multi-sites (ECSI Roaming)

- [ ] Ticket LOCAL : accepté sur son site, refusé sur un autre site.
- [ ] Ticket GROUPE : accepté sur les sites du groupe, refusé hors groupe.
- [ ] Ticket GLOBAL : accepté sur tous les sites autorisés de l'entreprise, refusé sur un site d'une autre entreprise.
- [ ] Consommation partagée : le temps et les données consommés sur le site A sont déduits sur le site B.
- [ ] Simultaneous-use : le même ticket ne peut pas être utilisé en même temps sur deux sites au-delà du nombre d'appareils du forfait.
- [ ] **Critère du MVP commercial** : validation réelle sur au moins deux routeurs physiques de sites distincts.

### Sécurité transverse (à chaque campagne)

- [ ] Aucun service de gestion du routeur joignable depuis Internet (scan depuis l'extérieur).
- [ ] Comptes créés par ECSI CLOUD limités au strict nécessaire.
- [ ] Aucun secret (clé privée, mot de passe) dans les journaux ECSI CLOUD ni dans l'interface.

## Intégration applicative (Sprint 3A)

Code : `apps/api/src/routers` ; worker : `apps/api/src/worker.ts`.

- **Adresse contactée** : uniquement `routers.tunnel_ip`, validée à l'enregistrement ET avant chaque connexion contre `ROUTER_TUNNEL_CIDR` (IPv4 décimale stricte, ni réseau, ni diffusion, ni passerelle ; plage privée RFC 1918 ou RFC 6598 entre /16 et /30). Ports fixés par le code (443 ou 8728), jamais lus en base. Aucune résolution DNS, aucune redirection suivie.
- **Transports** (lecture seule, menus en liste blanche) : REST HTTPS, cible de production, certificat épinglé par SHA-256 du DER, connexion coupée avant tout envoi d'identifiants si l'empreinte diffère ; API RouterOS TCP 8728, protocole de la documentation officielle (connexion post-v6.43, mot de passe en clair dans la session API : uniquement par le tunnel WireGuard). Le prototype REST du laboratoire (`lab/routeros/chr/probe.py`) est conservé.
- **Compte de service** : REST `read,api,rest-api` (validé sur CHR 7.24.5) ; API 8728 `read,api` (validation indépendante OVH, CHR 7.23.7).
- **Données lues** : `system/identity`, `system/resource` (version, carte, architecture, uptime, CPU, nombre de CPU, charge, mémoire totale et libre), `interface` (nom, type, état, MTU, MAC, compteurs). Réservé : trafic dans le temps, santé, pairs WireGuard.
- **États** : `ONLINE` (collecte réussie) ; `DEGRADED` (le routeur répond mais la collecte échoue, ou silence plus court que le seuil) ; `OFFLINE` (silence ≥ `ROUTER_OFFLINE_AFTER_SECONDS`, 180 s, ET ≥ `ROUTER_OFFLINE_MIN_FAILURES`, 3, échecs consécutifs). Une erreur transitoire isolée ne rend jamais un routeur `OFFLINE`.
- **Secrets** : mot de passe RouterOS chiffré par le SecretBox, AAD `router:<company_id>:<router_id>:routeros-password` ; jamais journalisé ; messages d'erreur nettoyés et secrets masqués avant journalisation ou stockage dans `last_error`. Aucune clé privée WireGuard de routeur côté cloud.
- **Base** : rôle `ecsi_worker` limité à la table `routers` (voir [DATABASE.md](DATABASE.md)).

## Enrôlement depuis ECSI CLOUD (Sprint 3B)

Code : `apps/api/src/routers` (API), `apps/api/src/routers/gateway` et `apps/api/src/gateway.ts` (agent passerelle), migration 0006. Protocole : [PROTOCOLE-PROVISIONNEMENT.md](../lab/routeros/PROTOCOLE-PROVISIONNEMENT.md), dont le script modèle validé au Sprint 3A est repris **sans modification** (`enrollment-script.ts`, test d'égalité avec le fichier du laboratoire).

1. **Création** (`POST /api/v1/routers/enrollments`, permission `routers.create` sur le site) : entreprise et site obligatoires (le site doit appartenir à l'entreprise, RLS en dernière barrière). Le cloud attribue l'adresse tunnel (`app.router_allocate_tunnel_ip`, verrou consultatif, première adresse libre : jamais le réseau, la diffusion, la passerelle, ni une adresse active ou libérée depuis moins de 7 jours). Le routeur est créé en `PROVISIONING`, sans identifiants. Un jeton de 256 bits est émis : seule son empreinte SHA-256 est stockée, il expire après `ROUTER_ENROLL_TOKEN_TTL_MINUTES` (30 min) et n'apparaît qu'une fois, dans le script rendu.
2. **Script** : collé par l'administrateur dans le terminal du routeur. Il crée l'interface WireGuard (la **clé privée reste sur le routeur**), le firewall du tunnel, le pair passerelle, puis envoie en HTTPS le jeton et la clé publique à `POST /api/v1/routers/enroll`. Aucune IP WAN fixe n'est nécessaire : le routeur initie tout (NAT, CGNAT, Starlink).
3. **Enrôlement** (`app.router_consume_enrollment`, rôle `ecsi_auth`) : jeton à usage unique ; réponse uniforme 410 pour inconnu, expiré, déjà utilisé, révoqué ou clé déjà prise ; chaque tentative est auditée (`routers.enroll`, motif en cas de refus) ; limite de 30 tentatives par IP et 15 minutes.
4. **Pairs** : l'agent passerelle synchronise toutes les `GATEWAY_SYNC_INTERVAL_SECONDS` les pairs WireGuard (`wg set … allowed-ips <ip>/32`) avec `app.gateway_peers()`. Il ne touche jamais un pair qu'il ne connaît pas et refuse une adresse déjà tenue par un tel pair ou hors plage. Un routeur supprimé perd son pair au cycle suivant.
5. **Activation** : par le tunnel uniquement, le routeur poste son compte de service (`read,api,rest-api`) et l'empreinte de son certificat à `http://10.200.0.1:8081/activate`. L'agent n'écoute que sur l'adresse tunnel de la passerelle, identifie le routeur par l'adresse source (refus hors plage), chiffre le mot de passe avec le SecretBox avant tout stockage, et l'enregistre par `app.router_activate` (audit `router.activated`). Refus audités (`router.activation`).
6. **Supervision** : le worker du Sprint 3A collecte en REST HTTPS avec épinglage ; il ne voit pas les routeurs `PROVISIONING` ni les routeurs supprimés.

Gestion (`/api/v1/routers`) : liste, détail, renommage ou déplacement de site (portée vérifiée sur le site cible), changement des identifiants RouterOS (chiffrés, ré-épinglage optionnel, audités sans valeur), suppression douce (révoque les jetons, retire le pair, arrête la collecte), renouvellement d'un jeton non utilisé. Aucune réponse ne contient de mot de passe, de chiffré, de jeton (hors script de création) ni de clé privée. Interface : **Réseau → Routeurs** (`/reseau/routeurs`).

Résultats sur CHR 7.24.5 : [`resultats/2026-10-04-S3B-chr-enrolement-ecsi-cloud.md`](../lab/routeros/resultats/2026-10-04-S3B-chr-enrolement-ecsi-cloud.md).

## Paliers de montée en charge

| Palier       | Objectif                                       | Critère de passage                                                |
| ------------ | ---------------------------------------------- | ----------------------------------------------------------------- |
| 1 routeur    | Toutes les checklists ci-dessus sur un routeur | Checklists vertes CHR + matériel                                  |
| 2 routeurs   | Deux sites, roaming entre eux                  | Checklist 14 verte sur matériel                                   |
| 10 routeurs  | Premiers sites pilotes                         | Une semaine sans incident bloquant, métriques passerelle relevées |
| 50 routeurs  | Exploitation réelle                            | Latence RADIUS et charge passerelle mesurées et acceptables       |
| 100 routeurs | Montée en charge                               | Décision documentée sur l'ajout d'une seconde passerelle          |

Aucune optimisation d'échelle n'est réalisée avant que les mesures d'un palier la justifient.
