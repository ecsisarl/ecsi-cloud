# Résultats du laboratoire réseau SIMULÉ — 2026-10-03T22:22:14Z

Implémentation WireGuard : wireguard-go v0.0.20230223 (espace utilisateur, protocole standard). Noyau : 6.18.44-fc-v64.

### 1. Handshake derrière NAT et CGNAT, sans redirection de port

- **PASS** r1 (double NAT : box + CGNAT) joignable par le worker via 10.200.0.2 en 0.0 s
- **PASS** r2 (NAT simple) joignable via 10.200.0.3 en 0.0 s
  - endpoint de r1 vu par la passerelle : `203.0.113.20:49952` (adresse publique du CGNAT, port choisi par le NAT)
- **PASS** aucune règle DNAT (redirection de port) sur la box ni sur le CGNAT
- **PASS** le routeur voit uniquement l'adresse tunnel de la passerelle (10.200.0.1) comme client

### 2. Sécurité : exposition et cloisonnement

- **PASS** Internet → IP publique du site (CGNAT) :8443 : REFUSÉ (aucun chemin entrant)
- **PASS** Internet → passerelle :8443 : REFUSÉ (seul UDP 51820 est ouvert)
- **PASS** Internet → adresse tunnel du routeur (route forcée via la passerelle) : REFUSÉ
- ~~**PASS** LAN du site (client WiFi) → service d'administration du routeur : REFUSÉ~~ —
  **non probant** : la box du laboratoire bloquait déjà le trafic LAN → LAN (filtrage du pont).
  Corrigé dans `topology.sh`, rejoué le 2026-10-04 avec preuve par compteur :
- **PASS** LAN du site (client WiFi) → service d'administration du routeur : REFUSÉ par le firewall du routeur (+5 paquets refusés)
- **PASS** worker ECSI autorisé → routeur via WireGuard : AUTORISÉ
- **PASS** autre pair WireGuard (r2) → API de r1 : REFUSÉ par la passerelle (wg → wg interdit)
- **PASS** défense en profondeur : même avec wg → wg ouvert sur la passerelle, r1 refuse (allowed-ips strict 10.200.0.1/32 + firewall du routeur)
- **PASS** usurpation : r2 émettant avec l'adresse de r1 (10.200.0.2) est rejeté par WireGuard (cryptokey routing), 0 paquet reçu par la passerelle
- **PASS** la clé privée de r1 n'existe que dans le répertoire de r1 ; la passerelle n'a que sa clé publique

### 3. Keepalive et mappages CGNAT agressifs (timeout UDP 30 s)

- keepalive désactivé, 45 s sans trafic…
- **PASS** sans keepalive : après 45 s d'inactivité, la passerelle NE PEUT PLUS joindre le routeur (mappage CGNAT expiré)
  - keepalive 25 s rétabli : routeur joignable en 0.0 s
  - keepalive 25 s, 45 s sans trafic applicatif…
- **PASS** avec keepalive 25 s : routeur toujours joignable après 45 s d'inactivité

### 4. Changement d'adresse WAN publique (renumérotation CGNAT / Starlink)

- **PASS** nouvelle IP publique : endpoint `203.0.113.20:49952` → `203.0.113.21:49952`, routeur à nouveau joignable en 16.1 s sans aucune action côté passerelle

### 5. Coupure WAN longue puis retour (états ONLINE → DEGRADED → OFFLINE → ONLINE)

- état initial : ONLINE
- API injoignable 2.0 s après la coupure
- **PASS** pendant la coupure, handshake encore récent : état DEGRADED (pas OFFLINE, pas supprimé)
  - attente du seuil OFFLINE (180 s sans handshake)…
- **PASS** état OFFLINE atteint 177.4 s plus tard ; le routeur reste enregistré (son pair est toujours présent sur la passerelle)
- **PASS** pair r1 toujours présent : une indisponibilité ne supprime jamais le routeur
- **PASS** retour du WAN : ONLINE en 3.2 s, sans intervention

### 6. Redémarrage du routeur (processus et interface WireGuard détruits puis recréés)

- **PASS** après redémarrage du routeur : joignable 0.5 s après le retour du service (même clé, même IP tunnel)

### 7. Redémarrage de la passerelle

- **PASS** passerelle redémarrée (sans endpoint connu) : r1 de nouveau joignable en 10.1 s, à l'initiative du routeur
  - r2 joignable en 30.3 s supplémentaires

### 8. Service d'administration du routeur indisponible (tunnel intact)

- **PASS** service arrêté, tunnel actif : état DEGRADED (distinct d'OFFLINE)
- **PASS** service relancé : ONLINE en 0.6 s

### 9. Révocation d'un routeur

- **PASS** pair r2 retiré : plus aucun trafic possible dans les deux sens
- **PASS** r2 continue d'émettre des initiations mais la passerelle n'y répond plus (dernier handshake de r2 : il y a 36 s)
- **PASS** la révocation de r2 n'affecte pas r1

**Échecs : 0**
