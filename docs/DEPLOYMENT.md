# Déploiement

Plan complet : [dossier v0.1, §15](architecture/dossier-architecture-v0.1.md). Ce document décrit ce qui est en place et sera enrichi à chaque sprint.

## Développement local

```bash
docker compose up --build
```

| Service  | Image                                            | Port local                             |
| -------- | ------------------------------------------------ | -------------------------------------- |
| postgres | `postgres:18-alpine`                             | 127.0.0.1:5432                         |
| redis    | `redis:8-alpine` (mot de passe obligatoire, AOF) | 127.0.0.1:6379                         |
| s3       | `chrislusf/seaweedfs:4.48` (passerelle S3)       | 127.0.0.1:8333                         |
| mailpit  | `axllent/mailpit:v1.31`                          | 127.0.0.1:8025 (web), 1025 (SMTP)      |
| migrate  | `ecsi-cloud/api:dev` (exécution unique)          | —                                      |
| api      | `ecsi-cloud/api:dev`                             | 127.0.0.1:4000                         |
| web      | `ecsi-cloud/web:dev`                             | 127.0.0.1:3000                         |
| portal   | `ecsi-cloud/portal:dev`                          | 127.0.0.1:3001                         |
| nginx    | `nginx:1-alpine`                                 | 8080 (dashboard + API), 8081 (portail) |

Nginx écoute sur toutes les interfaces afin de pouvoir tester le portail depuis un téléphone du réseau local ; les autres services ne sont joignables que depuis la machine.

Ordre de démarrage : PostgreSQL sain → migrations réussies → API (avec Redis et S3 sains) → web, portail → Nginx.

Réinitialiser complètement l'environnement local (efface les données) : `docker compose down -v`.

### Secrets et variables ajoutés au Sprint 1

| Variable                          | Rôle                                                                                       |
| --------------------------------- | ------------------------------------------------------------------------------------------ |
| `ECSI_DB_AUTH_PASSWORD`           | Mot de passe du rôle PostgreSQL `ecsi_auth` (créé par `infra/postgres/init/01-roles.sh`)   |
| `DATABASE_AUTH_URL`               | Connexion de l'API avec le rôle `ecsi_auth`                                                |
| `JWT_ACCESS_SECRET`               | Signature des jetons d'accès (32 caractères minimum)                                       |
| `ENCRYPTION_KEY`                  | Clé de 32 octets en base64 : chiffrement des secrets 2FA, empreintes (HMAC)                |
| `COOKIE_SECURE`, `WEB_PUBLIC_URL` | Cookies `Secure` et URL des liens envoyés par e-mail (obligatoirement HTTPS en production) |
| `TRUST_PROXY_HOPS`                | Nombre de proxies de confiance devant l'API (1 avec Nginx)                                 |
| `SMTP_*`                          | Envoi des e-mails (Mailpit en développement)                                               |

Un volume PostgreSQL créé avant le Sprint 1 ne contient pas le rôle `ecsi_auth` : la migration 0002 échoue avec un message explicite. En développement, recréer le volume (`docker compose down -v`) ; en production, créer le rôle par le provisioning avant de migrer.

### Variables ajoutées au Sprint 2

| Variable                   | Rôle                                                                                                                    |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `ENCRYPTION_KEY_ID`        | Identifiant de la clé maîtresse active, inscrit dans chaque chiffré (`k1` par défaut)                                   |
| `ENCRYPTION_PREVIOUS_KEYS` | Anciennes clés encore lisibles pendant une rotation : `id:base64,…` (vide hors rotation)                                |
| `RATE_LIMIT_LOGIN_PER_IP`  | Connexions par IP et par 15 min (20 par défaut) ; relevé à 200 uniquement pour les tests E2E (toutes depuis la même IP) |

**Changer de clé de chiffrement** : ne jamais remplacer `ENCRYPTION_KEY` seule. Suivre la procédure de rotation de [SECURITY.md](SECURITY.md#rotation-de-la-clé-de-chiffrement) : nouvelle clé active avec un nouvel identifiant, ancienne clé dans `ENCRYPTION_PREVIOUS_KEYS`, puis `docker compose run --rm migrate node dist/cli/rotate-encryption-keys.js --dry-run` et sans `--dry-run` ([ADR 0014](adr/0014-chiffrement-enveloppe-rotation.md)).

## Images

| Image               | Dockerfile                                                 | Contenu                                                                                       |
| ------------------- | ---------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| API                 | `infra/docker/api.Dockerfile`                              | `turbo prune`, build, `pnpm deploy --prod`, Node 22 Alpine, utilisateur non root, healthcheck |
| Dashboard / portail | `infra/docker/next.Dockerfile` (`APP=web` ou `APP=portal`) | Build Next.js `standalone`, utilisateur non root                                              |

Derrière un proxy d'entreprise qui intercepte TLS, `pnpm install` dans `docker build` peut échouer faute de certificat : fournir le certificat du proxy à la construction (non nécessaire sur un réseau standard).

## Intégration continue

`.github/workflows/ci.yml`, sur chaque pull request et sur `main` :

1. Format, lint, typecheck, tests unitaires, build.
2. Tests d'intégration sur PostgreSQL, Redis et S3 réels (Testcontainers).
3. Construction des images, démarrage de l'environnement complet et vérification de la santé via Nginx.
4. Scan de secrets gitleaks sur tout l'historique.

## Production (à partir du Sprint 10)

Phase pilote : un serveur applicatif (Compose), PostgreSQL managé avec PITR, Redis managé, S3 managé, **une passerelle** (WireGuard + FreeRADIUS) au départ, une seconde lorsque les paliers de [MIKROTIK.md](MIKROTIK.md) le justifient. Images publiées sur GHCR, déploiement de production approuvé manuellement, migrations exécutées avant la bascule.

## Points de restauration

Chaque sprint validé est marqué par un tag Git `sN-done` (ex. `s0-done`, `s1-done`). Revenir à un point de restauration : `git checkout s0-done`.
