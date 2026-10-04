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

## Validation complémentaire réelle — VPS OVH — 2026-10-04

### Environnement

- MikroTik CHR réel sous QEMU/KVM sur VPS OVH
- RouterOS : 7.23.7 (long-term)
- Tunnel WireGuard : 10.200.0.1/24 ↔ 10.200.0.2/24
- Transport testé : RouterOS API TCP/8728 à travers WireGuard
- Worker ECSI CLOUD réel sous Docker
- PostgreSQL réel
- Routeur supervisé : CHR-LAB
- Collecte : 60 s
- Seuil OFFLINE : 180 s et au moins 3 échecs consécutifs

### TESTÉ RÉELLEMENT — indisponibilité du service API

État initial :
- CHR-LAB ONLINE
- consecutive_failures = 0

Action :
- désactivation volontaire du service RouterOS API TCP/8728 ;
- tunnel WireGuard et CHR laissés actifs.

Résultat :
- PASS : ONLINE -> DEGRADED ;
- erreur détectée : SERVICE_UNAVAILABLE / connexion refusée ;
- le routeur n'est pas déclaré OFFLINE puisque le tunnel reste joignable ;
- PASS : après réactivation de l'API, DEGRADED -> ONLINE automatiquement ;
- PASS : consecutive_failures remis à 0 ;
- PASS : last_error effacé ;
- aucune intervention ni redémarrage du Worker nécessaire.

### TESTÉ RÉELLEMENT — routeur totalement inaccessible

Action :
- arrêt complet du service systemd ecsi-chr.service ;
- ping 10.200.0.2 : 100 % de perte.

Résultat :
- PASS : ONLINE -> DEGRADED ;
- erreur détectée : UNREACHABLE / aucune réponse ;
- PASS : DEGRADED -> OFFLINE après dépassement du seuil ;
- PostgreSQL a confirmé status = OFFLINE ;
- le compteur a atteint 6 échecs consécutifs pendant l'indisponibilité.

### TESTÉ RÉELLEMENT — récupération automatique

Action :
- redémarrage de ecsi-chr.service ;
- aucune modification du Worker ;
- aucune modification manuelle de PostgreSQL.

Résultat :
- PASS : CHR redémarré correctement ;
- PASS : WireGuard rétabli automatiquement ;
- ping 10.200.0.2 : 4/4, 0 % de perte ;
- PASS : OFFLINE -> ONLINE automatiquement ;
- PASS : consecutive_failures = 0 ;
- PASS : last_error vide ;
- PASS : télémétrie de supervision de nouveau actualisée.

### Conclusion de cette validation

Cycle réellement observé :

ONLINE -> DEGRADED -> ONLINE -> DEGRADED -> OFFLINE -> ONLINE

La chaîne suivante est donc TESTÉE RÉELLEMENT :

CHR RouterOS 7.23.7 -> WireGuard -> Worker ECSI CLOUD -> RouterOS API -> PostgreSQL -> supervision -> récupération automatique.

Restent hors de cette validation réelle :
- transport REST HTTPS sur un RouterOS réel ;
- hAP ax3 physique ;
- L009 physique ;
- RB5009 physique ;
- Starlink / CGNAT opérateur réel.

Ces éléments ne doivent pas être présentés comme TESTÉS RÉELLEMENT.
