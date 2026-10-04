# Protocole d'enrôlement d'un routeur MikroTik (Sprint 3A)

> **Statut (2026-10-04) : TESTÉ RÉELLEMENT sur CHR RouterOS 7.24.5**, avec un serveur
> d'enrôlement de **laboratoire** (`enrolement/`) : enrôlement d'un CHR vierge derrière box +
> CGNAT, jeton à usage unique (y compris 8 requêtes simultanées), jeton expiré, relance sans
> doublon, activation refusée avec retrait du compte, réinitialisation. Résultats :
> `resultats/2026-10-04-S3A-chr-enrolement.md`. **Non testé** : matériel physique (voir
> `GUIDE-TEST-MATERIEL.md`), AC publique en production, implémentation dans l'API ECSI CLOUD.
> Rien de ce document n'est automatisé en production au Sprint 3A.

## Objectifs

- Aucune IP publique ni redirection de port sur le site : c'est **le routeur qui initie**.
- La **clé privée WireGuard du routeur est générée sur le routeur** et n'en sort jamais.
- Le script collé dans le terminal ne contient **aucun mot de passe** ni clé privée.
- Le jeton d'enrôlement est **à usage unique**, de courte durée, lié à un routeur précis.
- L'API d'administration du routeur n'est joignable **que par le tunnel**, depuis la seule
  adresse tunnel de la passerelle.
- Le compte de service ECSI CLOUD sur le routeur a le **minimum de droits** (lecture).

## Déroulé

```
Administrateur         ECSI CLOUD (API)                 Passerelle            Routeur
     │ « Ajouter un routeur »  │                              │                     │
     │────────────────────────>│ routeur PROVISIONING         │                     │
     │                         │ IP tunnel réservée (/32)     │                     │
     │                         │ jeton : 32 octets aléatoires, haché en base,       │
     │                         │ 30 min, usage unique         │                     │
     │<──── script commenté ───│                              │                     │
     │ colle le script dans le terminal ───────────────────────────────────────────>│
     │                         │                              │  1. clé privée      │
     │                         │                              │     générée ici     │
     │                         │<── 2. HTTPS : jeton + clé publique (rien d'autre) ──│
     │                         │ jeton consommé (atomique)    │                     │
     │                         │──── 3. ajouter le pair ─────>│                     │
     │                         │     (clé publique, /32)      │                     │
     │                         │                              │<── 4. handshake ────│
     │                         │                              │     (keepalive 25 s)│
     │                         │<─ 5. identifiants du compte de service, PAR LE TUNNEL│
     │                         │ 6. lecture identité/version/modèle par l'API REST   │
     │                         │    via 10.200.x.y uniquement │                     │
     │                         │ routeur ONLINE               │                     │
```

### Étape par étape

| #   | Où                    | Action                                                                                                                                                                                                                                                                                                                                                                                                                            | Données transmises                                                               |
| --- | --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| 0   | ECSI CLOUD            | Création du routeur (`PROVISIONING`), réservation d'une IP tunnel unique dans le pool de la passerelle, jeton d'enrôlement (stocké haché SHA-256, 30 min, usage unique, lié au routeur et à l'entreprise). Événement d'audit.                                                                                                                                                                                                     | —                                                                                |
| 1   | Dashboard → admin     | Affichage du script : commentaires FR, valeurs publiques (clé publique et adresse de la passerelle, IP tunnel attribuée) et le jeton. Le jeton n'est affiché qu'une fois.                                                                                                                                                                                                                                                         | —                                                                                |
| 2   | Routeur               | Le script vérifie la version minimale, puis crée (ou réutilise, s'il existe déjà avec le commentaire `ecsi-cloud`) l'interface WireGuard : **la clé privée est générée par RouterOS**.                                                                                                                                                                                                                                            | —                                                                                |
| 3   | Routeur               | Ajoute l'adresse tunnel, le pair « passerelle » avec `allowed-address` = adresse tunnel de la passerelle **/32 uniquement**, keepalive 25 s, puis les règles de firewall (voir plus bas), **avant** le démarrage du tunnel.                                                                                                                                                                                                       | —                                                                                |
| 4   | Routeur → API (HTTPS) | Envoie le jeton et la **clé publique** du routeur à l'endpoint public d'enrôlement, certificat serveur vérifié.                                                                                                                                                                                                                                                                                                                   | jeton, clé publique                                                              |
| 5   | API                   | Consommation atomique du jeton (`UPDATE … WHERE used_at IS NULL AND expires_at > now()`). Refus si déjà utilisé, expiré ou révoqué (410), avec audit et alerte « tentative de réutilisation ». Enregistre la clé publique, ajoute le pair à la passerelle (clé publique + `/32`, **sans endpoint**).                                                                                                                              | —                                                                                |
| 6   | Routeur → passerelle  | Handshake WireGuard initié par le routeur (fonctionne derrière NAT, CGNAT, Starlink, 4G/5G).                                                                                                                                                                                                                                                                                                                                      | —                                                                                |
| 7   | Routeur               | Crée le groupe et l'utilisateur de service avec les seules politiques nécessaires et un **mot de passe aléatoire généré sur le routeur**.                                                                                                                                                                                                                                                                                         | —                                                                                |
| 8   | Routeur → passerelle  | Envoie ces identifiants et l'empreinte SHA-256 du certificat TLS de l'API **par le tunnel** (`http://<IP tunnel passerelle>:8081/activate`, seul port ouvert du tunnel vers la passerelle). En cas de refus, le script supprime le compte qu'il vient de créer. L'émetteur est authentifié par WireGuard : seule la clé du routeur peut émettre depuis son IP tunnel. Accepté une seule fois, uniquement à l'état `PROVISIONING`. | utilisateur, mot de passe (chiffré au repos par chiffrement enveloppe, ADR 0014) |
| 9   | Worker ECSI           | Lit identité, version, modèle, architecture, uptime, CPU, mémoire, interfaces via l'API REST **par l'IP tunnel**. Si tout répond : `ONLINE`.                                                                                                                                                                                                                                                                                      | —                                                                                |

### Pourquoi deux canaux

- L'étape 4 passe par Internet parce que la passerelle ne connaît pas encore la clé du
  routeur ; elle ne transporte **rien de secret à long terme** (le jeton devient inutile dès
  sa consommation, la clé publique est publique).
- Le mot de passe du compte de service ne circule **que dans le tunnel**, après le handshake.
  Ainsi aucun mot de passe n'est codé en dur dans le script, ni généré par le cloud.

### Seconde utilisation du jeton

| Cas                                                | Réponse                                                                                       |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Script relancé sur le même routeur après succès    | Interface et pair réutilisés (pas de doublon) ; jeton refusé (410) ; message « déjà enrôlé ». |
| Jeton rejoué depuis un autre routeur               | 410, audit `DENIED`, alerte ; aucune clé publique remplacée.                                  |
| Jeton expiré                                       | 410 ; l'administrateur génère un nouveau script.                                              |
| Identifiants envoyés hors `PROVISIONING` (étape 8) | Refusés et audités.                                                                           |

### Constats RouterOS intégrés au script (CHR 7.24.5)

- Une règle de firewall qui cite une interface inexistante est refusée : l'interface WireGuard
  est créée (sans pair) avant les règles.
- Les règles sont déplacées (`move`) devant la première règle `input` existante : elles
  passent avant le « drop » de la configuration existante sans la modifier.
- Une règle « established,related » propre au tunnel est nécessaire : sinon le « drop » du
  tunnel bloquerait les réponses à l'activation (routeur sans configuration par défaut).
- RouterOS 7.24 a renommé `address` en `available-from` dans `/ip/service` (changelog 7.24) :
  le script choisit le nom selon la version.
- Le compte REST exige les politiques `read,api,rest-api` (mesure, la documentation ne cite
  pas `api`). Révocation : désactiver l'utilisateur (effet en moins d'une seconde), pas
  modifier le groupe (effet retardé de plusieurs minutes).
- L'empreinte `fingerprint` de RouterOS est le SHA-256 du certificat DER : le cloud l'épingle.

### Idempotence du script

Chaque objet créé par le script porte le commentaire `ecsi-cloud`. Avant chaque création, le
script vérifie s'il existe déjà : il le réutilise au lieu d'en créer un second, et **ne
régénère jamais une clé privée existante** (sinon le routeur déjà enrôlé serait coupé).

## Firewall du routeur (principe)

Règles ajoutées **avant** les règles de refus existantes de la chaîne `input`, sans jamais
désactiver le firewall :

1. accepter `established,related` (déjà présent dans la configuration par défaut, à vérifier
   modèle par modèle) ;
2. accepter le service d'administration choisi (REST sur HTTPS) **uniquement** depuis
   l'adresse tunnel de la passerelle, **uniquement** sur l'interface WireGuard ECSI ;
3. tout le reste vers ce service est refusé, depuis le WAN comme depuis le LAN.

Le service d'administration lui-même est restreint aux adresses autorisées (liste d'adresses
du service) en plus du firewall : deux barrières indépendantes.

## Passerelle (validé en SIMULÉ)

- Un pair par routeur : clé publique + **une seule adresse /32** ; aucun endpoint configuré.
- Firewall : WAN = UDP WireGuard uniquement ; **aucun transfert routeur → routeur** ; le
  worker interne n'atteint que le port d'administration, traduit (SNAT) vers l'adresse tunnel
  de la passerelle.
- Révocation = suppression du pair : plus aucun trafic dans les deux sens, immédiatement.

## États d'un routeur

| État           | Signification                                                  | Déduit de                                                        |
| -------------- | -------------------------------------------------------------- | ---------------------------------------------------------------- |
| `PROVISIONING` | Créé, script généré, pas encore de handshake ni d'identifiants | aucun handshake                                                  |
| `ONLINE`       | Tunnel actif et API qui répond correctement                    | handshake < 180 s **et** appel API réussi                        |
| `DEGRADED`     | Tunnel actif mais API injoignable ou lente                     | handshake < 180 s **et** appel API en échec ou au-delà du délai  |
| `OFFLINE`      | Plus de tunnel                                                 | aucun handshake depuis plus de 180 s                             |
| `REVOKED`      | Retiré par un administrateur ; pair supprimé de la passerelle  | décision d'administration (jamais déduit automatiquement)        |
| `ERROR`        | L'API répond mais de façon inutilisable                        | authentification refusée, permission manquante, réponse invalide |

Règles :

- Un routeur **n'est jamais supprimé ni révoqué automatiquement** parce qu'il est injoignable :
  `OFFLINE` peut durer des jours (coupure électrique, WAN), le retour est automatique.
- Le seuil de 180 s vient du protocole : avec un keepalive, WireGuard renégocie la session
  toutes les 120 s ; sans handshake depuis 180 s, le tunnel est tombé.
- Un passage `ONLINE → DEGRADED/OFFLINE` ne déclenche une alerte qu'après confirmation sur
  plusieurs mesures (anti-oscillation), au Sprint 4 (monitoring).
