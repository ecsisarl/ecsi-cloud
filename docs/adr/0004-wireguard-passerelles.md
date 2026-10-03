# ADR 0004 : WireGuard via passerelles, clé privée générée sur le routeur

- Statut : acceptée (dossier v0.1, validé le 2026-10-03) ; implémentation au Sprint 3

## Contexte

Les MikroTik n'ont souvent pas d'IP publique (NAT, CGNAT 4G). L'API de gestion ne doit jamais être exposée sur Internet.

## Décision

- Chaque routeur ouvre un tunnel WireGuard **sortant** vers une passerelle ECSI CLOUD ; il reçoit une adresse /32 dans le sous-réseau de sa passerelle.
- La **clé privée est générée sur le routeur** ; seule la clé publique est transmise au cloud.
- RADIUS, CoA et l'API REST RouterOS passent **uniquement** par le tunnel ; les services du routeur sont restreints à l'adresse de la passerelle.
- Les actions sur les routeurs sont exécutées par des workers co-localisés avec la passerelle, jamais par le serveur web.
- Le statut ONLINE/OFFLINE est dérivé du dernier handshake WireGuard.

## Conséquences

- Fonctionne sans IP publique côté client.
- L'IP tunnel est une identité fiable du routeur (routage cryptographique WireGuard).
- Une seule passerelle au départ ; d'autres sont ajoutées quand les mesures le justifient (ADR 0010).
- Tout script d'enrôlement est validé en laboratoire (ADR 0008).
