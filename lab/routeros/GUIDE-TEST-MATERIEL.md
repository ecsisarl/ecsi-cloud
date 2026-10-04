# Guide de test sur matériel MikroTik : hAP ax3, L009, RB5009 (Sprint 3A)

> **Statut : CONÇU MAIS NON TESTÉ sur matériel.** Ce guide reprend, étape par étape, ce qui a
> été validé sur CHR RouterOS 7.24.5 (voir `resultats/2026-10-0*-S3A-chr-*.md`). Le comportement
> d'un routeur physique **n'est pas supposé identique** à celui du CHR : chaque étape dit quoi
> relever, et le tableau final liste les différences attendues à vérifier.

Chaque étape suit le même format : **ACTION**, **COMMANDE**, **RÉSULTAT ATTENDU**, **SI ÉCHEC**.
Les commandes RouterOS se tapent (ou se collent) dans **WinBox > New Terminal** ou en SSH. Les
commandes « serveur » se tapent sur la passerelle de test (partie A).

## Règles de sécurité pendant les tests

- Tester **un routeur à la fois**, de préférence un routeur qui ne sert pas encore de clients.
- **Ne jamais désactiver le firewall du routeur**, même pour « voir si ça marche mieux ».
- Garder un accès local : un PC branché sur un port LAN avec WinBox (WinBox peut aussi se
  connecter par adresse MAC si l'adresse IP est perdue).
- Sauvegarde **avant** chaque routeur (étape B2). En cas de doute, restaurer et recommencer.
- **Starlink : ne rien modifier sur l'installation Starlink** (ni mode, ni réglage, ni câble
  d'alimentation). Le MikroTik se branche simplement derrière, comme n'importe quel client.
- Ne jamais coller dans ce guide, un ticket ou un message : mot de passe, jeton, clé privée.

## Matériel nécessaire

| Élément                                                                               | Pourquoi                                                                                                                                          |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Le routeur à tester (hAP ax3, L009 ou RB5009), configuration par défaut de préférence | objet du test                                                                                                                                     |
| Un PC sur le LAN du routeur, avec WinBox                                              | accès local, tests « depuis le LAN »                                                                                                              |
| Un serveur Linux **avec une IP publique** (petit VPS Debian/Ubuntu)                   | passerelle de test ; indispensable pour tester NAT/CGNAT/Starlink. À défaut, un PC Linux du LAN permet une première série (sans traversée de NAT) |
| Optionnel : connexion Starlink, routeur 4G/5G                                         | test CGNAT réel                                                                                                                                   |

---

## Partie A — Passerelle de test (une seule fois)

### A1. Préparer le serveur

- **ACTION** : installer les outils et récupérer le dépôt sur le serveur Linux.
- **COMMANDE** (serveur, Debian/Ubuntu) :
  ```bash
  sudo apt update && sudo apt install -y wireguard-tools iptables python3 openssl curl git
  git clone -b claude/project-thread-vh99r6 https://github.com/ecsisarl/ecsi-cloud.git
  cd ecsi-cloud
  ```
- **RÉSULTAT ATTENDU** : `wg --version` affiche une version ; le dossier `lab/routeros/materiel/` existe.
- **SI ÉCHEC** : dépôt privé → s'authentifier avec un jeton GitHub personnel (jamais copié
  dans un fichier du dépôt), ou copier le dossier `lab/` depuis le PC avec `scp -r`.

### A2. Ouvrir les ports chez l'hébergeur

- **ACTION** : dans le pare-feu de l'hébergeur (console web du VPS), autoriser en entrée
  **UDP 51820** (WireGuard) et **TCP 443** (API d'enrôlement de test). Rien d'autre.
- **COMMANDE** : aucune (interface de l'hébergeur).
- **RÉSULTAT ATTENDU** : les deux règles apparaissent dans la console de l'hébergeur.
- **SI ÉCHEC** : sans UDP 51820, le routeur ne fera jamais de handshake (étape B5, « pas de handshake »).

### A3. Démarrer la passerelle de test

- **ACTION** : lancer WireGuard, l'AC de laboratoire et le serveur d'enrôlement de test.
- **COMMANDE** (serveur ; remplacer par l'IP publique du serveur) :
  ```bash
  sudo lab/routeros/materiel/passerelle-test.sh up <IP_PUBLIQUE_DU_SERVEUR>
  ```
- **RÉSULTAT ATTENDU** : `Passerelle de test prête : <IP>, UDP 51820. Clé publique : …`.
  `sudo wg show wg0` affiche `listening port: 51820`.
- **SI ÉCHEC** : lire `lab/routeros/materiel/.state/public.log` et `activation.log`. Port 443
  déjà utilisé (serveur web) : arrêter ce service le temps du test.

---

## Partie B — Pour chaque routeur (hAP ax3, puis L009, puis RB5009)

Adresses tunnel proposées : hAP ax3 `10.200.0.21`, L009 `10.200.0.22`, RB5009 `10.200.0.23`.
Dans les commandes « serveur », `<nom>` vaut `hap-ax3`, `l009` ou `rb5009`.

### B1. Inventaire

- **ACTION** : relever l'identité matérielle et logicielle du routeur.
- **COMMANDE** (routeur) :
  ```
  /system/resource/print
  /system/clock/print
  /system/routerboard/print
  /system/health/print
  /interface/print
  /ip/address/print
  /ip/route/print
  /ip/firewall/filter/print
  /ip/service/print
  ```
- **RÉSULTAT ATTENDU** : version RouterOS **v7** ; noter `version`, `architecture-name`,
  `board-name`, et dans routerboard `model`, `serial-number`, `current-firmware`. `health` affiche
  au moins une température (contrairement au CHR). `clock` donne la **date du jour** : la
  documentation « Clock » indique qu'un routeur démarre au 2 janvier 1970 tant que l'heure
  n'est pas réglée ; avec une date fausse, la vérification du certificat à l'étape 6/9 échoue. Le firewall contient les règles de la
  configuration par défaut (commentaires `defconf`). Copier toute la sortie dans la fiche de
  résultats.
- **SI ÉCHEC** : version 6.x → ne pas continuer (ECSI CLOUD exige RouterOS v7). Firewall vide
  → noter « pas de configuration par défaut » : le test reste possible mais le routeur est
  alors exposé, à corriger avant toute mise en service.

### B2. Sauvegarde avant test

- **ACTION** : enregistrer l'export texte et une sauvegarde chiffrée, puis les télécharger.
- **COMMANDE** (routeur ; choisir un mot de passe de sauvegarde, ne pas le noter ici) :
  ```
  /export file=ecsi-avant-test
  /system/backup/save name=ecsi-avant-test password=<MOT_DE_PASSE_DE_SAUVEGARDE>
  /file/print
  ```
- **RÉSULTAT ATTENDU** : `ecsi-avant-test.rsc` et `ecsi-avant-test.backup` dans la liste ;
  les télécharger sur le PC (WinBox > Files, glisser-déposer).
- **SI ÉCHEC** : ne pas continuer sans sauvegarde.

### B3. Version de RouterOS

- **ACTION** : comparer la version relevée en B1 avec la version testée sur CHR (7.24.5).
- **COMMANDE** : aucune (lecture de B1).
- **RÉSULTAT ATTENDU** : version **≥ 7.15** (le script nomme le pair WireGuard, possible depuis
  7.15 d'après la documentation WireGuard). Une version différente de 7.24.5 n'a **pas** été
  testée : continuer et noter la version, c'est précisément ce que l'on veut mesurer.
- **SI ÉCHEC** : version < 7.15 → mettre à jour **si tu le décides** (procédure officielle
  « Upgrading and installation » : WinBox > System > Packages > Check For Updates, canal
  stable ; le routeur redémarre). Ne pas mettre à jour un routeur en service sans fenêtre de
  maintenance.

### B4. Générer le script d'enrôlement

- **ACTION** : créer le routeur côté passerelle de test (jeton à usage unique, 30 min).
- **COMMANDE** (serveur) :
  ```bash
  sudo lab/routeros/materiel/passerelle-test.sh nouveau <nom> <adresse-tunnel>
  sudo cat lab/routeros/materiel/.state/enrolement-<nom>.rsc
  ```
- **RÉSULTAT ATTENDU** : un script commenté qui commence par `# ECSI CLOUD - enrolement` et
  se termine par `}`. Il contient le jeton et des valeurs publiques, **aucun mot de passe ni
  clé privée**.
- **SI ÉCHEC** : `UNIQUE constraint failed` → ce nom ou cette adresse tunnel est déjà utilisé :
  en choisir d'autres. Le jeton expire après 30 min : au-delà, refaire B4.

### B5. Coller le script sur le routeur

- **ACTION** : activer le mode sécurisé, puis coller **tout** le script dans le terminal.
- **COMMANDE** (routeur) : `Ctrl+X` (le mot `SAFE` apparaît dans l'invite), puis coller le
  contenu de `enrolement-<nom>.rsc`.
- **RÉSULTAT ATTENDU** : lignes `ECSI 1/9` à `ECSI 9/9 : routeur enrole, en attente de
verification par ECSI CLOUD`. Noter la clé publique affichée à l'étape 3/9.
- **SI ÉCHEC** (le script s'arrête sur un message `ECSI:`) :
  - `RouterOS v7 requis` : voir B3 ;
  - `empreinte de l'AC inattendue` : le serveur a été recréé ; relancer B4 ;
  - `enrolement refuse ou serveur injoignable` suivi de `pas de handshake` : vérifier
    l'heure du routeur (`/system/clock/print`, une date fausse invalide les certificats),
    l'accès Internet du routeur, les ports de A2, puis relancer B4 (nouveau jeton) ;
  - `activation refusee` : le compte créé a déjà été retiré par le script ; relancer B4 ;
  - toute autre erreur RouterOS : copier la sortie complète dans la fiche (c'est une
    différence CHR/matériel), puis restaurer (B12).

### B6. Vérifier l'accès local, puis quitter le mode sécurisé

- **ACTION** : ouvrir une **seconde** session WinBox depuis le PC du LAN.
- **COMMANDE** : WinBox > Connect (adresse LAN habituelle). Si elle fonctionne : `Ctrl+X`
  dans le premier terminal pour quitter le mode sécurisé (les changements sont enregistrés).
- **RÉSULTAT ATTENDU** : la seconde session s'ouvre normalement.
- **SI ÉCHEC** : ne pas quitter le mode sécurisé ; fermer le terminal du script : RouterOS
  annule les changements faits en mode sécurisé. Noter le problème.

### B7. Ordre du firewall

- **ACTION** : vérifier que les règles ECSI sont placées **avant** les règles par défaut, et
  que les règles par défaut sont intactes.
- **COMMANDE** (routeur) : `/ip/firewall/filter/print`
- **RÉSULTAT ATTENDU** : en tête, 5 règles `ecsi-cloud:` (retours du tunnel ; API REST depuis la
  passerelle ; ping depuis la passerelle ; tout le reste du tunnel ; API REST refusee ailleurs),
  puis les règles `defconf` dans leur ordre d'origine, sans modification.
- **SI ÉCHEC** : règles ECSI après une règle `drop` → le routeur ne sera pas joignable par le
  tunnel (B8 en `DEGRADED`) ; copier la sortie dans la fiche.

### B8. État et lecture des données par le tunnel

- **ACTION** : interroger le routeur par l'API REST, **uniquement via son adresse tunnel**.
- **COMMANDE** (serveur) :
  ```bash
  sudo lab/routeros/materiel/passerelle-test.sh etat <nom>
  sudo lab/routeros/materiel/passerelle-test.sh sonde <nom>
  ```
- **RÉSULTAT ATTENDU** : `ONLINE (handshake il y a … s, API 200)`. La sonde renvoie en 200 :
  identité, ressources (`version`, `board-name`, `architecture-name`, `uptime`, `cpu-load`,
  `total-memory`, `free-memory`), CPU, interfaces avec compteurs, trafic instantané, pair
  WireGuard. **Différences attendues avec le CHR, à noter** : `system/routerboard` en 200
  (modèle, numéro de série) au lieu de 400 ; `system/health` avec des températures (la
  documentation « Health » indique que les valeurs lues par script/API peuvent être
  multipliées par 10 : comparer avec `/system/health/print`). Le fichier JSON est enregistré
  dans `lab/routeros/materiel/.state/`.
- **SI ÉCHEC** : `PROVISIONING (aucun handshake)` → voir B5 ; `DEGRADED` → firewall (B7) ou
  service `www-ssl` désactivé (`/ip/service/print`) ; `ERROR (… 500)` → politiques du groupe
  `ecsi-ro` (`/user/group/print`), noter la sortie ; empreinte TLS inattendue → certificat
  `ecsi-api` régénéré, noter.

### B9. Sécurité

#### B9a. Depuis la passerelle, par le tunnel

- **ACTION** : vérifier que le compte de service ne peut **rien modifier** et que seuls les
  ports prévus répondent.
- **COMMANDE** (serveur) : `sudo lab/routeros/materiel/passerelle-test.sh securite <nom>`
- **RÉSULTAT ATTENDU** : lecture 200 ; écriture identité, redémarrage, création d'utilisateur
  ≠ 200 ; mauvais mot de passe 401 ; `private-key` de moins de 44 caractères (masquée) ; ports
  21, 22, 23, 80, 8291, 8728, 8729 « refusé ».
- **SI ÉCHEC** : une écriture acceptée ou un port ouvert est **bloquant** : révoquer (B11),
  restaurer (B12), envoyer la sortie.

#### B9b. Depuis le LAN

- **ACTION** : vérifier que l'API REST est refusée depuis le LAN et que l'administration
  locale reste possible.
- **COMMANDE** (PC du LAN ; remplacer par l'adresse LAN du routeur, souvent 192.168.88.1) :
  - Windows (PowerShell) : `Test-NetConnection 192.168.88.1 -Port 443` puis `-Port 8291`
  - Linux/macOS : `curl -k --max-time 5 https://192.168.88.1/rest/system/identity`
- **RÉSULTAT ATTENDU** : port 443 → `TcpTestSucceeded : False` (ou délai dépassé avec curl) ;
  port 8291 → `True` (WinBox fonctionne toujours).
- **SI ÉCHEC** : 443 ouvert depuis le LAN → copier `/ip/firewall/filter/print` dans la fiche ;
  8291 fermé → l'administration locale est coupée, restaurer (B12).

#### B9c. Depuis Internet (seulement si le site a une IP publique)

- **ACTION** : vérifier qu'aucun port d'administration n'est joignable depuis Internet.
- **COMMANDE** (serveur) : `sudo lab/routeros/materiel/passerelle-test.sh scan <IP_PUBLIQUE_DU_SITE>`
  (l'IP publique du site se lit sur le serveur : `sudo wg show wg0 endpoints`).
- **RÉSULTAT ATTENDU** : tous les ports « fermé ». Derrière CGNAT/Starlink, l'adresse vue est
  celle de l'opérateur : noter « non applicable (CGNAT) ».
- **SI ÉCHEC** : un port ouvert vient de la configuration existante du routeur ou de la box
  opérateur ; le noter, ce n'est pas le script ECSI qui l'ouvre (il n'ajoute que des refus et
  des accès par le tunnel).

### B10. Résilience

Pendant ces tests, laisser tourner sur le serveur :
`watch -n 10 sudo lab/routeros/materiel/passerelle-test.sh etat <nom>`

| #    | ACTION                       | COMMANDE                                                                                                                                          | RÉSULTAT ATTENDU                                                                                                                              | SI ÉCHEC                                                                                  |
| ---- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| B10a | Coupure WAN 4 minutes        | débrancher le câble WAN (ether1) ou couper la box opérateur ; rebrancher après 4 min                                                              | `DEGRADED` en quelques secondes, `OFFLINE` vers 180 s, puis `ONLINE` en moins d'une minute après le retour (CHR : 3 s) **sans aucune action** | noter les durées ; vérifier `/interface/wireguard/peers/print` (endpoint, last-handshake) |
| B10b | Redémarrage du routeur       | `/system/reboot` puis `y`                                                                                                                         | `ONLINE` après le démarrage (noter la durée) ; même clé publique qu'en B5 : `/interface/wireguard/print`                                      | clé différente = anomalie bloquante, noter                                                |
| B10c | Coupure d'alimentation       | débrancher l'alimentation 30 s                                                                                                                    | comme B10b                                                                                                                                    | noter                                                                                     |
| B10d | Redémarrage de la passerelle | serveur : `sudo lab/routeros/materiel/passerelle-test.sh down` puis `up <IP>`                                                                     | `ONLINE` sans action sur le routeur (CHR : 10 s avec la passerelle du labo, **82 s** avec ce script ; noter la durée)                         | vérifier que le pair est rechargé : `sudo wg show wg0`                                    |
| B10e | Changement d'IP publique     | redémarrer la box opérateur (**pas Starlink** : sur Starlink, observer seulement les changements d'adresse qui surviennent d'eux-mêmes, partie C) | `ONLINE` à nouveau ; `sudo wg show wg0 endpoints` montre la nouvelle adresse                                                                  | noter les deux adresses et la durée                                                       |
| B10f | Service REST arrêté          | `/ip/service/set [find where name="www-ssl"] disabled=yes` puis, après l'état, `disabled=no`                                                      | `DEGRADED` (tunnel actif, API muette), puis `ONLINE`                                                                                          | noter                                                                                     |

### B11. Révocation

- **ACTION** : 1) désactiver le compte de service sur le routeur ; 2) révoquer le routeur côté
  passerelle.
- **COMMANDE** :
  1. routeur : `/user/disable [find where name="ecsi-svc"]` ; serveur : `etat <nom>` ;
     routeur : `/user/enable [find where name="ecsi-svc"]` ; serveur : `etat <nom>`
  2. serveur : `sudo lab/routeros/materiel/passerelle-test.sh revoquer <nom>` puis `etat <nom>`
- **RÉSULTAT ATTENDU** : 1) `ERROR (… 401)` aussitôt (CHR : 0,4 s), puis `ONLINE` après
  réactivation. 2) `REVOKED`, plus aucune réponse par le tunnel ; côté routeur,
  `/interface/wireguard/peers/print` montre que le dernier handshake vieillit.
- **SI ÉCHEC** : le routeur répond encore après révocation = anomalie bloquante.

### B12. Retrait et retour à l'état initial

- **ACTION** : retirer la configuration ECSI et comparer avec l'export de B2.
- **COMMANDE** (routeur) : coller `lab/routeros/enrolement/ecsi-retrait.rsc`, puis
  ```
  /export file=ecsi-apres-retrait
  ```
  et comparer sur le PC `ecsi-avant-test.rsc` et `ecsi-apres-retrait.rsc`.
- **RÉSULTAT ATTENDU** : `ECSI: configuration ECSI CLOUD retiree`. Les seules différences sont
  la date en tête de fichier et éventuellement le service `www-ssl` (désactivé, sans
  restriction). Le firewall par défaut est identique.
- **SI ÉCHEC** : restaurer la sauvegarde : `/system/backup/load name=ecsi-avant-test.backup
password=<MOT_DE_PASSE_DE_SAUVEGARDE>` (le routeur redémarre).

---

## Partie C — Starlink, 4G/5G (CGNAT réel)

Le tunnel est **initié par le routeur** : il envoie des paquets UDP vers la passerelle, le
NAT de la box et le CGNAT de l'opérateur créent une correspondance de sortie, et le keepalive
de 25 s la maintient ouverte. Aucune IP publique ni redirection de port n'est nécessaire sur le
site, et **rien n'est à modifier sur Starlink**.

### C1. Brancher derrière Starlink (ou le routeur 4G/5G)

- **ACTION** : relier le port WAN (ether1) du MikroTik à un port LAN du routeur Starlink (ou de
  la box 4G/5G), sans rien changer à ces équipements.
- **COMMANDE** (routeur) : `/ip/address/print` et `/ip/dhcp-client/print`
- **RÉSULTAT ATTENDU** : une adresse privée sur ether1 (192.168.x.x, ou 100.64.x.x).
- **SI ÉCHEC** : pas d'adresse → vérifier le câble ; ne pas toucher à la configuration Starlink.

### C2. Refaire B4 à B8, puis prouver le CGNAT

- **ACTION** : enrôler et vérifier comme en partie B, puis comparer l'adresse vue par la
  passerelle avec l'adresse du routeur.
- **COMMANDE** (serveur) : `sudo wg show wg0 endpoints`
- **RÉSULTAT ATTENDU** : `ONLINE` ; l'endpoint vu par la passerelle est une adresse publique de
  l'opérateur, différente de l'adresse WAN du routeur (C1) : le tunnel traverse bien le NAT.
- **SI ÉCHEC** : pas de handshake derrière Starlink/4G alors que tout fonctionne derrière une
  box classique → noter l'opérateur et l'offre (certains réseaux mobiles filtrent l'UDP) ;
  à analyser ensemble avant le Sprint 3B, sans modifier l'installation.

### C3. Résilience sur lien instable

- **ACTION** : refaire B10a (en débranchant le câble entre Starlink et le MikroTik, pas
  l'alimentation de Starlink) et B10b sur ce lien ; laisser tourner `etat` une heure pour
  observer les changements d'adresse publique.
- **RÉSULTAT ATTENDU** : retour `ONLINE` automatique à chaque fois ; noter les durées et les
  changements d'endpoint (fréquents sur Starlink et en 4G).

---

## Partie D — Fiche de résultats

Pour chaque routeur, remplir une fiche `lab/routeros/resultats/<date>-S3A-<modele>.md` à partir
de `RESULTATS-MODELE.md` : sorties de B1, versions, chaque étape avec PASS/ÉCHEC, durées
mesurées, JSON de la sonde (B8). **Retirer de la fiche tout mot de passe ou jeton.**

## Différences CHR / matériel à vérifier

| Point                                 | CHR 7.24.5 (constaté)                             | Matériel (attendu, à vérifier)                                                                            |
| ------------------------------------- | ------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Architecture                          | x86_64                                            | ARM (relever `architecture-name` en B1)                                                                   |
| `/system/routerboard`                 | 400 « no such command »                           | 200 : modèle, numéro de série, firmware                                                                   |
| `/system/health`                      | `state: disabled`, aucune température             | températures (valeurs API éventuellement × 10)                                                            |
| Configuration par défaut              | aucune (ni firewall, ni bridge)                   | `defconf` : bridge LAN, firewall `input`, ether1 en WAN                                                   |
| Licence                               | free (1 Mbit/s en envoi par interface)            | licence du matériel, sans bridage                                                                         |
| Interfaces                            | ether1 seule                                      | plusieurs ether, SFP (RB5009, L009), WiFi (hAP ax3) : relever les noms                                    |
| Génération du certificat `prime256v1` | quelques secondes en émulation                    | plus rapide ; noter si l'étape 8/9 est lente                                                              |
| Version RouterOS                      | 7.24.5                                            | celle du routeur ; < 7.24 → le script utilise `address` au lieu de `available-from` (non testé)           |
| Temps de redémarrage                  | 34 s (émulation)                                  | à mesurer (B10b)                                                                                          |
| Horloge                               | fournie par l'hyperviseur, juste dès le démarrage | peut repartir du 02/01/1970 sans réglage NTP (doc « Clock ») : bloque la vérification TLS de l'enrôlement |
