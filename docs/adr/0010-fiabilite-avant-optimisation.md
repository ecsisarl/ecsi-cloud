# ADR 0010 : fiabilité avant optimisation, montée en charge par paliers

- Statut : acceptée (validation du 2026-10-03)

## Décision

L'architecture conserve les propriétés qui permettront d'atteindre des milliers de routeurs (passerelles partitionnables, statut issu des handshakes, tâches asynchrones, tenants isolés), mais **aucune optimisation prématurée** n'est réalisée.

Progression : 1 routeur → 2 → 10 → 50 → 100 → montée progressive. Chaque palier est franchi après mesure (voir [docs/MIKROTIK.md](../MIKROTIK.md)).

Exemples de ce qui n'est **pas** fait tant que les mesures ne le justifient pas : plusieurs passerelles, partitionnement des tables, base de séries temporelles, Kubernetes, multi-région.

## Conséquences

- Le code reste simple et lisible ; les points d'extension sont documentés plutôt qu'implémentés.
