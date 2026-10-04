# Enrôlement d'un CHR vierge (RouterOS 7.24.5) — TESTÉ RÉELLEMENT, 2026-10-04

Routeur : second CHR (`chr2`) démarré depuis l'image officielle, jamais configuré, derrière la box
(NAT) et le CGNAT du laboratoire (adresse publique vue par le cloud : 203.0.113.22). Seules
configurations préalables : adresse LAN, route par défaut et le firewall `input` d'exemple de la
documentation officielle (`cmds/00-prerequis-chr2.rsc`). Le script `ecsi-enrolement.rsc.modele`,
rendu par `serveur_enrolement.py new chr2 10.200.0.11`, a été **collé dans le terminal** du routeur
(console série, mode « paste » de `console.py`), comme le ferait un administrateur.

## Sortie du script, 4 passages

| Passage | Situation                                                                    | Résultat                                                                                                                                                                                               |
| ------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1       | routeur vierge, jeton valide                                                 | 9/9 étapes, enrôlé et activé                                                                                                                                                                           |
| 2       | même script recollé                                                          | jeton refusé (410) ; tunnel déjà établi ; compte inchangé ; **aucun doublon** (1 interface WG, 1 pair, 9 règles, 2 adresses, 2 certificats, 2 utilisateurs, avant comme après) ; **même clé publique** |
| 3       | compte `ecsi-svc` supprimé à la main, script recollé                         | activation refusée (409, état déjà ACTIVATED) ; le script **retire le compte qu'il vient de créer** (pas d'identifiants orphelins)                                                                     |
| 4       | identifiants réinitialisés côté cloud (action admin simulée), script recollé | activation acceptée ; nouveau mot de passe ; API 200                                                                                                                                                   |

```
ECSI 1/9: RouterOS 7.24.5 (stable)
ECSI 2/9: AC verifiee
ECSI 3/9: interface ecsi-wg, cle publique MgYSpV+MPvO4xKB3OuSmYYIH/PcBiZQeXAu4Yq/tuHM=
ECSI 4/9: firewall
ECSI 5/9: pair passerelle
ECSI 6/9: enrolement accepte
ECSI 7/9: tunnel etabli
ECSI 8/9: API REST HTTPS
ECSI 9/9: routeur enrole, en attente de verification par ECSI CLOUD
```

## Firewall du routeur après enrôlement (règles ajoutées AVANT les règles existantes)

```
0  ;;; ecsi-cloud: retours du tunnel
   chain=input action=accept connection-state=established,related in-interface=ecsi-wg

1  ;;; ecsi-cloud: API REST depuis la passerelle
   chain=input action=accept protocol=tcp src-address=10.200.0.1 in-interface=ecsi-wg dst-port=443

2  ;;; ecsi-cloud: ping depuis la passerelle
   chain=input action=accept protocol=icmp src-address=10.200.0.1 in-interface=ecsi-wg

3  ;;; ecsi-cloud: tout le reste du tunnel
   chain=input action=drop in-interface=ecsi-wg

4  ;;; ecsi-cloud: API REST refusee ailleurs
   chain=input action=drop protocol=tcp dst-port=443

5  ;;; default configuration
   chain=input action=accept connection-state=established,related

6  chain=input action=accept src-address-list=allowed_to_router

7  chain=input action=accept protocol=icmp

8  chain=input action=drop
```

## Tests du protocole (test-enrolement.sh)

### Côté cloud : état après enrôlement

- **PASS** routeur chr2 : jeton consommé (2026-10-04T02:13:23+00:00), état ACTIVATED, compte ecsi-svc
- **PASS** aucune colonne de clé privée en base (colonnes : name,tunnel_ip,state,public_key,token_hash,token_expires,token_used_at,svc_user,tls_fingerprint,created_at)
- **PASS** journaux du serveur : aucune clé WireGuard complète
- **PASS** worker → API REST de chr2 par le tunnel avec les identifiants reçus : HTTP 200
- **PASS** empreinte TLS envoyée par le routeur = certificat réellement présenté (épinglage possible)

### Jeton

- **PASS** même jeton utilisé deux fois : 1er HTTP 200, 2e HTTP 410 ; clé publique non remplacée
- **PASS** 8 requêtes simultanées avec le même jeton : 1 acceptée, 7 refusées (consommation atomique)
- **PASS** jeton expiré : HTTP 410
- **PASS** requête contenant un champ en plus (privateKey) : refusée HTTP 400, jeton non consommé
- **PASS** clé publique mal formée : HTTP 400
- **PASS** jeton inconnu : HTTP 410
- **PASS** client sans l'AC attendue : connexion TLS refusée (certificat non reconnu)

### Activation (canal tunnel)

- **PASS** Internet → point d'activation (10.200.0.1:8081) : injoignable
- **PASS** réseau interne → point d'activation : injoignable (écoute réservée au tunnel)

### Sécurité du routeur enrôlé

- **PASS** Internet → IP publique du site (CGNAT), ports d'administration : REFUSÉ
- **PASS** LAN du site → API REST (443) du routeur : REFUSÉ par la règle ajoutée par le script
- **PASS** LAN du site → WinBox (8291) : toujours AUTORISÉ (administration locale préservée par le script)
- **PASS** passerelle → autres ports du routeur par le tunnel (8291) : REFUSÉ
- **PASS** passerelle → SSH (22) par le tunnel : REFUSÉ
  **Échecs : 0**

## Retrait puis nouvel enrôlement (cycle de vie complet)

1. `ecsi-retrait.rsc` collé sur chr2 : le routeur revient **exactement** à son état d'avant
   enrôlement (0 interface WG, 0 pair, 4 règles de firewall d'origine intactes, 1 adresse,
   0 certificat, 1 utilisateur, 3 groupes, `www-ssl` désactivé et sans restriction).
2. Côté cloud : pair retiré de la passerelle, routeur `REVOKED` (jamais supprimé).
3. Nouveau jeton (`chr2-bis`, 10.200.0.12), même script modèle : 9/9 étapes, **nouvelle clé
   WireGuard** générée par le routeur (`zf4eX7B4…` au lieu de `MgYSpV+M…`), API 200 avec les
   nouveaux identifiants ; l'ancienne adresse tunnel 10.200.0.11 ne répond plus.

## Passerelle de test du guide matériel (`materiel/passerelle-test.sh`)

Exécutée dans un namespace « serveur » à IP publique 203.0.113.50, **sans module WireGuard
noyau** (repli automatique sur wireguard-go) : `up`, `nouveau test-vps 10.200.0.30`, script collé
sur chr2 (après retrait) → 9/9, `etat` → `ONLINE (handshake il y a 19 s, API 200)`, `revoquer` →
`REVOKED`, API injoignable (000), `down` → wg0 supprimée, 0 règle `ecsi-test` restante.
Redémarrage de cette passerelle (`down` puis `up`, pairs rechargés depuis la base) : chr2
de nouveau `ONLINE` après **82 s**, contre 10 s avec la passerelle du labo. Hypothèse non
vérifiée : ici le serveur arrêté répond « port injoignable » (ICMP) au lieu d'ignorer les
paquets, ce qui pourrait espacer les tentatives de RouterOS. À mesurer sur matériel (B10d).
**Non testé** : sur un vrai VPS avec module WireGuard du noyau et firewall du fournisseur.

## Révocation des identifiants du compte de service

- `/user/disable` du compte `ecsi-svc` : l'API répond **401 en 0,4 s** ; `/user/enable` : 200 en 0,5 s.
- À comparer avec la modification des politiques du groupe (rapport S3A, § 11) : effet retardé de
  plusieurs minutes. **Révoquer = désactiver ou supprimer l'utilisateur**, pas modifier le groupe.

## Journal d'audit du serveur (extrait chr2)

```
2026-10-04 02:27:51 | chr2 | CREDENTIALS_RESET | admin | labo : réinitialisation manuelle des identifiants
2026-10-04T02:12:04+00:00 | chr2 | CREATED | admin | ip=10.200.0.11 expire=2026-10-04T02:42:04+00:00
2026-10-04T02:13:23+00:00 | chr2 | ENROLLED | 203.0.113.22 | clé publique MgYSpV+M…, pair ajouté 10.200.0.11/32
2026-10-04T02:13:31+00:00 | chr2 | ACTIVATED | 10.200.0.11 | compte ecsi-svc, empreinte TLS 26beb2e2fe10e403…
2026-10-04T02:20:06+00:00 | chr2 | ENROLL_DENIED | 203.0.113.22 | jeton déjà utilisé, expiré ou inconnu (alerte : tentative de réutilisation)
2026-10-04T02:27:37+00:00 | chr2 | ENROLL_DENIED | 203.0.113.22 | jeton déjà utilisé, expiré ou inconnu (alerte : tentative de réutilisation)
2026-10-04T02:27:38+00:00 | chr2 | ACTIVATE_DENIED | 10.200.0.11 | état ACTIVATED : identifiants refusés
2026-10-04T02:28:12+00:00 | chr2 | ENROLL_DENIED | 203.0.113.22 | jeton déjà utilisé, expiré ou inconnu (alerte : tentative de réutilisation)
2026-10-04T02:28:13+00:00 | chr2 | ACTIVATED | 10.200.0.11 | compte ecsi-svc, empreinte TLS 26beb2e2fe10e403…
```
