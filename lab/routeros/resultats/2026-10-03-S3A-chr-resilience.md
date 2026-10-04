# Résilience CHR — 2026-10-03T22:59:51Z

### Keepalive RouterOS face à un CGNAT agressif (mappage UDP 30 s)

- keepalive 0 sur le CHR, 45 s sans trafic…
- **PASS** sans keepalive : après 45 s d'inactivité, la passerelle ne joint plus le CHR (mappage CGNAT expiré)
  - keepalive 25 s rétabli : CHR joignable en 0.2 s
  - keepalive 25 s, 45 s sans trafic applicatif…
- **PASS** avec keepalive 25 s : CHR joignable après 45 s d'inactivité

### Changement d'adresse WAN publique

- **PASS** nouvelle IP publique : endpoint `203.0.113.20:14456` → `203.0.113.22:13231`, CHR joignable en 12.3 s, aucune action côté passerelle

### Coupure WAN longue puis retour

- état initial : ONLINE
- API injoignable 3.0 s après la coupure
- **PASS** pendant la coupure (handshake récent) : DEGRADED
- **PASS** OFFLINE 163.0 s plus tard ; pair toujours enregistré sur la passerelle
- **PASS** retour du WAN : ONLINE en 3.3 s, sans intervention

### Redémarrage du CHR (/system/reboot)

- API injoignable 3.0 s après la commande
- **PASS** CHR redémarré (émulation sans KVM) : API de nouveau joignable via le tunnel 34.2 s après la commande, sans intervention
- **PASS** même clé WireGuard après redémarrage (clé persistante, rien à reconfigurer côté cloud)

### Redémarrage de la passerelle (configuration rechargée sans endpoint)

- **PASS** passerelle redémarrée : CHR joignable en 10.1 s, à l'initiative du routeur

### Tunnel interrompu côté passerelle (pair retiré 60 s puis remis)

- **PASS** pair retiré : API injoignable immédiatement
- **PASS** pair remis : CHR joignable en 4.2 s, sans intervention sur le routeur

### Service REST indisponible (www-ssl désactivé), tunnel intact

- API injoignable 0.0 s après la désactivation
- **PASS** service arrêté, tunnel actif : DEGRADED (distinct d'OFFLINE)
- **PASS** service réactivé : ONLINE en 0.2 s

**Échecs : 0**
