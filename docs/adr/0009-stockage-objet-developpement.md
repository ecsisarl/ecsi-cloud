# ADR 0009 : SeaweedFS comme stockage S3 de développement

- Statut : acceptée (Sprint 0, 2026-10-03)

## Contexte

Le dossier v0.1 prévoyait MinIO en développement. Au moment du Sprint 0, le dépôt `minio/minio` n'existe plus sur Docker Hub (l'API Docker Hub répond « object not found ») : l'image officielle n'est plus distribuée publiquement.

## Décision

- Utiliser **SeaweedFS** (`chrislusf/seaweedfs:4.48`, licence Apache 2.0) et sa passerelle S3 comme stockage objet de développement, avec identifiants fournis par variables d'environnement.
- Le code applicatif n'utilise que l'API S3 standard (`@aws-sdk/client-s3`) ; aucune dépendance à un fournisseur.
- Production : stockage S3 compatible managé (choix au Sprint 10).

## Conséquences

- Remplacer SeaweedFS par un autre stockage S3 (MinIO compilé, Garage, RustFS, S3 managé) ne demande qu'un changement de `docker-compose.yml` et de variables.
