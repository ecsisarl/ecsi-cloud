# Sécurité CHR (RouterOS 7.24.5) — TESTÉ RÉELLEMENT, rejoué le 2026-10-04

La première exécution (2026-10-03) affichait aussi PASS pour « LAN → CHR », mais ce test était
non probant (trafic LAN bloqué par la box du laboratoire). Version corrigée avec preuve par le
compteur de la règle de refus RouterOS :

### Exposition

- **PASS** Internet → IP publique du site (CGNAT), ports 22, 23, 80, 443, 8291, 8728, 8729 : REFUSÉ
- **PASS** LAN du site → CHR (21, 22, 23, 80, 443, 8291, 8728, 8729) : REFUSÉ par le firewall RouterOS (compteur de la règle de refus : +42 paquets)
- **PASS** passerelle (10.200.0.1) → CHR par le tunnel, ports autres que 443 : REFUSÉ par le firewall RouterOS
- **PASS** worker ECSI → API REST HTTPS du CHR via WireGuard : AUTORISÉ (HTTP 200)

### Autre pair WireGuard

- **PASS** autre pair (r2) → API du CHR : REFUSÉ par la passerelle
- **PASS** défense en profondeur : passerelle ouverte wg → wg, le CHR refuse quand même (allowed-address 10.200.0.1/32 + firewall)

### Compte de service (read + rest-api + api)

- **PASS** écriture refusée : PATCH interface/*2 (ether1) → « not enough permissions », HTTP 500
- **PASS** écriture refusée : POST system/identity/set → HTTP 500
- **PASS** redémarrage refusé : POST system/reboot → HTTP 500
- **PASS** création d'utilisateur refusée : PUT user → HTTP 500
- **PASS** clé privée WireGuard masquée pour le compte de service (champ de 5 caractères, pas de politique sensitive)
- **PASS** mauvais mot de passe → HTTP 401
- **PASS** HTTP en clair (port 80) via le tunnel : REFUSÉ
  **Échecs : 0**
