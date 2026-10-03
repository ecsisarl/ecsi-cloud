# ADR 0008 : laboratoire MikroTik obligatoire

- Statut : acceptée (validation du 2026-10-03)

## Décision

Les fonctions WireGuard, enrôlement, REST API RouterOS, Hotspot, FreeRADIUS, accounting, CoA/Disconnect, Session-Timeout, débits, quotas, MAC binding, portail captif, walled garden et tickets multi-sites :

- ne sont **jamais déclarées terminées sur la seule base de mocks** ;
- sont validées **sur CHR puis sur matériel RouterOS v7 réel** (hAP ax3, L009, RB5009, autres modèles compatibles), avec fiche de résultats ;
- ne supposent jamais qu'un comportement CHR est identique sur tous les équipements ;
- reposent uniquement sur la documentation officielle de la version RouterOS utilisée.

Stratégie, matrice et checklists : [docs/MIKROTIK.md](../MIKROTIK.md).

## Conséquences

- Un équipement physique est nécessaire à partir du Sprint 3 ; sans lui, les fonctions concernées restent au statut « validé CHR ».
