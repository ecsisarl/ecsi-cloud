# ADR 0005 : AAA centralisé FreeRADIUS ; MVP technique et MVP commercial

- Statut : acceptée (validation du 2026-10-03) ; implémentation aux Sprints 5 et 11

## Contexte

ECSI Roaming (ticket valable sur un groupe de sites ou sur tous les sites autorisés) exige une autorité d'authentification unique et une consommation partagée.

## Décision

- **FreeRADIUS 3.2** central, adossé à PostgreSQL ; autorisation par fonction SQL appliquant la portée du ticket selon le site du NAS.
- Les vouchers sont authentifiés par RADIUS dès le MVP technique (pas d'utilisateurs Hotspot locaux à migrer ensuite).
- **MVP technique** : portée LOCAL suffit.
- **MVP commercial** : portées LOCAL, GROUPE et GLOBAL obligatoires ; terminé seulement après validation réelle d'un ticket utilisable sur plusieurs sites MikroTik autorisés.

## Conséquences

- Le schéma et la fonction d'autorisation gèrent les trois portées dès le Sprint 5.
- La disponibilité de RADIUS est critique : redondance prévue, accounting bufferisé.
