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

`NGINX_BIND_ADDRESS` (défaut `0.0.0.0`) fixe l'adresse de publication de Nginx. Sur une machine qui exécute aussi l'agent passerelle, une publication sur `0.0.0.0:8081` occupe le port 8081 de **toutes** les adresses, y compris l'adresse tunnel `10.200.0.1` où l'agent doit écouter l'activation : l'agent s'arrête alors avec « Port d'activation … déjà utilisé ». Fixez `NGINX_BIND_ADDRESS` (`127.0.0.1` ou l'adresse publique du serveur) ou choisissez un autre `ROUTER_ACTIVATION_PORT` (les scripts d'enrôlement générés suivent cette valeur). Constaté par la CI S3B-RC2.

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

**Changer de clé de chiffrement** : ne jamais remplacer `ENCRYPTION_KEY` seule. Suivre la procédure en 9 temps de [SECURITY.md](SECURITY.md#rotation-de-la-clé-de-chiffrement) : nouvelle clé active avec un nouvel identifiant, ancienne clé dans `ENCRYPTION_PREVIOUS_KEYS`, puis le service d'exploitation `keys-rotate` (`docker compose --profile ops run --rm --no-deps keys-rotate --verify | --dry-run`, puis sans option) ([ADR 0014](adr/0014-chiffrement-enveloppe-rotation.md)). L'ancienne commande `docker compose run --rm migrate node dist/cli/rotate-encryption-keys.js` ne recevait pas les connexions nécessaires aux mots de passe RouterOS : ne plus l'utiliser.

### Variables ajoutées au Sprint 3A

| Variable                       | Rôle                                                                                                          |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| `ECSI_DB_WORKER_PASSWORD`      | Mot de passe du rôle PostgreSQL `ecsi_worker` (créé par `infra/postgres/init/01-roles.sh`)                    |
| `DATABASE_WORKER_URL`          | Connexion du worker de supervision (rôle `ecsi_worker`) ; repli de `keys-rotate` sans `DATABASE_MIGRATOR_URL` |
| `ROUTER_TUNNEL_CIDR`           | Plage des adresses tunnel WireGuard des routeurs (`10.200.0.0/24`) : seule plage jamais contactée             |
| `ROUTER_TUNNEL_GATEWAY`        | Adresse de la passerelle WireGuard (`10.200.0.1`), jamais une cible                                           |
| `ROUTER_POLL_INTERVAL_SECONDS` | Intervalle de collecte par routeur (60 s)                                                                     |
| `ROUTER_POLL_CONCURRENCY`      | Collectes simultanées (10)                                                                                    |
| `ROUTER_POLL_BATCH_SIZE`       | Routeurs réservés par cycle (100)                                                                             |
| `ROUTER_OFFLINE_AFTER_SECONDS` | Silence minimal avant OFFLINE (180 s, seuil du laboratoire)                                                   |
| `ROUTER_OFFLINE_MIN_FAILURES`  | Échecs consécutifs minimaux avant OFFLINE (3)                                                                 |

Le worker (`node dist/worker.js`, service `worker` de Docker Compose) ne reçoit que `DATABASE_WORKER_URL`, les clés du SecretBox et les variables `ROUTER_*` : ni les connexions `ecsi_app`/`ecsi_auth`, ni le secret JWT, ni Redis/S3. Il doit tourner sur un hôte qui route la plage tunnel vers la passerelle WireGuard ; en développement, sans passerelle, aucun routeur n'est joignable (état `OFFLINE`).

Un volume PostgreSQL créé avant le Sprint 3A ne contient pas le rôle `ecsi_worker` : la migration 0005 échoue avec un message explicite. En développement, recréer le volume (`docker compose down -v`) ; sinon, avant de migrer, en superutilisateur :

```sql
CREATE ROLE ecsi_worker LOGIN NOSUPERUSER NOCREATEROLE NOCREATEDB NOBYPASSRLS PASSWORD '…';
GRANT CONNECT ON DATABASE ecsi TO ecsi_worker;
```

### Variables et agent ajoutés au Sprint 3B

| Variable                                | Rôle                                                                                                                   |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `WG_GATEWAY_PUBLIC_KEY`                 | Clé PUBLIQUE WireGuard de la passerelle, inscrite dans le script d'enrôlement                                          |
| `WG_GATEWAY_ENDPOINT`                   | Nom DNS ou IPv4 publique de la passerelle (UDP), **sans `:port`** (ex. `vpn.exemple.com`, pas `vpn.exemple.com:51820`) |
| `WG_GATEWAY_PORT`                       | Port UDP WireGuard de la passerelle (51820), séparé de `WG_GATEWAY_ENDPOINT`                                           |
| `ROUTER_ENROLL_PUBLIC_URL`              | URL HTTPS de `POST /api/v1/routers/enroll` (défaut : `WEB_PUBLIC_URL` + `/api/v1/routers/enroll`)                      |
| `ROUTER_ENROLL_TOKEN_TTL_MINUTES`       | Durée de validité d'un jeton d'enrôlement (30 min, de 5 à 1440)                                                        |
| `ROUTER_ACTIVATION_PORT`                | Port HTTP d'activation de l'agent passerelle (8081), sur l'adresse tunnel seulement                                    |
| `ROUTER_ENROLL_CA_URL` / `_FINGERPRINT` | Laboratoire seulement (AC privée) ; **refusées en production**, où l'API présente un certificat public                 |
| `WG_INTERFACE`, `WG_COMMAND`            | Agent passerelle : interface WireGuard (`wg0`) et commande `wg`                                                        |
| `GATEWAY_SYNC_INTERVAL_SECONDS`         | Agent passerelle : intervalle de synchronisation des pairs (5 s)                                                       |

Depuis S3B-RC2, `docker-compose.yml` transmet toutes ces variables à l'API (`x-api-env`) avec `ROUTER_TUNNEL_CIDR` / `ROUTER_TUNNEL_GATEWAY` : il suffit de les renseigner dans `.env`. Une variable laissée vide vaut « non configurée » (l'enrôlement répond alors 503, le reste de l'API fonctionne). Un test unitaire (`apps/api/src/config/compose.test.ts`) vérifie que le Compose transmet chaque variable lue par l'API, le worker et la passerelle, et que les valeurs par défaut sont acceptées.

#### Agent passerelle

L'agent (`node dist/gateway.js`) tourne **sur l'hôte WireGuard**, avec `DATABASE_WORKER_URL`, les clés du SecretBox et les variables `ROUTER_TUNNEL_*`, `ROUTER_ACTIVATION_PORT`, `WG_INTERFACE`, `GATEWAY_SYNC_INTERVAL_SECONDS`. Il pilote l'interface par `wg set` (capacité `CAP_NET_ADMIN`) et écoute sur `ROUTER_TUNNEL_GATEWAY:ROUTER_ACTIVATION_PORT` uniquement. La clé privée de la passerelle reste dans la configuration `wg` de l'hôte : ni l'API, ni la base, ni l'agent ne la reçoivent. Prérequis communs :

- interface WireGuard configurée sur l'hôte (`wg-quick@wg0` : adresse `ROUTER_TUNNEL_GATEWAY`, port `WG_GATEWAY_PORT`) ;
- firewall de l'hôte : `ROUTER_ACTIVATION_PORT` accepté **uniquement** sur l'interface WireGuard ;
- **tout pair déjà présent sur l'interface** (routeur configuré à la main, comme CHR-LAB) doit être enregistré dans ECSI CLOUD avant d'activer l'enrôlement : l'agent ne touche jamais un pair inconnu de la base et refuse d'attribuer son adresse à un autre routeur (« Pair ignoré : … tenue par un pair inconnu de la base ») ; le routeur concerné resterait sans tunnel.

Deux installations, au choix :

1. **Conteneur** (recommandé quand l'hôte de la passerelle fait aussi tourner le Compose, cas du VPS de validation) : `docker compose --profile gateway up -d gateway`. Image `infra/docker/api.Dockerfile`, cible `gateway` : utilisateur non root, `wg` (wireguard-tools) avec la seule capacité de fichier `cap_net_admin` ; le service tourne dans le réseau de l'hôte (`network_mode: host`), `cap_drop: ALL` + `cap_add: NET_ADMIN`, système de fichiers en lecture seule, et joint PostgreSQL par son port publié sur `127.0.0.1`. La CI démarre ce conteneur sur une vraie interface WireGuard du noyau et vérifie qu'il devient sain, non root, à l'écoute sur l'adresse tunnel seulement.
2. **systemd** (hôte de passerelle dédié, sans Docker) : `infra/systemd/ecsi-gateway.service` et `infra/systemd/gateway.env.example` (procédure en tête du fichier) : utilisateur système dédié, `AmbientCapabilities=CAP_NET_ADMIN`, `CapabilityBoundingSet=CAP_NET_ADMIN`, `NoNewPrivileges`, `ProtectSystem=strict`. Ce mode n'a pas encore été testé sur un hôte réel.

#### Healthchecks des processus sans HTTP

Le worker et l'agent passerelle n'ont pas de serveur HTTP : chaque cycle réussi (collecte, synchronisation des pairs) écrit un battement de cœur dans `/tmp`, et `node dist/healthcheck.js worker|gateway` vérifie qu'il date de moins de 5 min (worker) ou 90 s (passerelle). Un processus bloqué ou privé de PostgreSQL devient `unhealthy` ; il redevient `healthy` au premier cycle réussi. Avant S3B-RC2, le worker héritait du healthcheck HTTP de l'API et était marqué `unhealthy` alors qu'il fonctionnait.

La migration 0006 est additive : les routeurs du Sprint 3A (dont CHR-LAB) restent supervisés sans action. Elle retire à `ecsi_app` le `DELETE` sur `routers` (suppression douce uniquement).

## Images

| Image               | Dockerfile                                                 | Contenu                                                                                       |
| ------------------- | ---------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| API, worker         | `infra/docker/api.Dockerfile`                              | `turbo prune`, build, `pnpm deploy --prod`, Node 22 Alpine, utilisateur non root, healthcheck |
| Agent passerelle    | `infra/docker/api.Dockerfile` (`--target gateway`)         | Même base, `wg` avec la seule capacité `cap_net_admin`, utilisateur non root                  |
| Dashboard / portail | `infra/docker/next.Dockerfile` (`APP=web` ou `APP=portal`) | Build Next.js `standalone`, utilisateur non root                                              |

Derrière un proxy d'entreprise qui intercepte TLS, `pnpm install` dans `docker build` peut échouer faute de certificat : fournir le certificat du proxy à la construction (non nécessaire sur un réseau standard).

## Intégration continue

`.github/workflows/ci.yml`, sur chaque pull request et sur `main` :

1. Format, lint, typecheck, tests unitaires, build.
2. Tests d'intégration sur PostgreSQL, Redis et S3 réels (Testcontainers).
3. Construction des images, démarrage de l'environnement complet et vérification de la santé via Nginx.
4. Scan de secrets gitleaks sur tout l'historique.

## Production : surcouche `docker-compose.prod.yml` (Sprint S3H)

Le Compose de développement fixe `NODE_ENV=development` : les garde-fous de production du code y sont inactifs. En production, on lance toujours les deux fichiers :

```
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build
```

La surcouche :

- passe l'API, les migrations, le worker et la passerelle en `NODE_ENV=production`. Le code refuse alors les valeurs contenant `devonly`, impose `COOKIE_SECURE`, des journaux JSON, une `WEB_PUBLIC_URL` en HTTPS, et interdit `S3_AUTO_CREATE_BUCKET` ;
- rend **obligatoires** les variables ci-dessous. Si l'une manque, Compose s'arrête avec « required variable X is missing a value », sans afficher de valeur ;
- retire Mailpit (profil `dev-mail`) : un SMTP réel est nécessaire ;
- ne publie que Nginx sur le port **80**. 443 et TLS arrivent à l'étape H4. Redis, S3, l'API, le web et le portail ne sont plus publiés ; PostgreSQL reste publié sur `127.0.0.1` uniquement, pour l'agent passerelle, qui tourne sur le réseau de l'hôte.

Variables obligatoires : `POSTGRES_PASSWORD`, `ECSI_DB_MIGRATOR_PASSWORD`, `ECSI_DB_APP_PASSWORD`, `ECSI_DB_AUTH_PASSWORD`, `ECSI_DB_WORKER_PASSWORD`, `REDIS_PASSWORD`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `JWT_ACCESS_SECRET`, `ENCRYPTION_KEY`, `ENCRYPTION_KEY_ID` (explicite en production, pour que la rotation des clés reste cohérente), `WEB_PUBLIC_URL` (HTTPS), `CORS_ORIGINS`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_FROM`. Facultatives : `SMTP_SECURE` (`true` par défaut), `SMTP_USER`, `SMTP_PASSWORD`.

**Bucket S3** : il n'est jamais créé par l'API en production. Avec le SeaweedFS du Compose, créez-le une seule fois :
`docker compose -f docker-compose.yml -f docker-compose.prod.yml exec s3 sh -c "echo 's3.bucket.create -name <S3_BUCKET>' | weed shell -master=localhost:9333"`.

**Essai local ou CI** : `./scripts/generate-prod-test-env.sh <fichier>` génère des secrets de test aléatoires (droits 600, rien n'est affiché), puis `docker compose --env-file <fichier> -f docker-compose.yml -f docker-compose.prod.yml up -d`. Ce fichier ne convient pas à un vrai déploiement : ses URL et son SMTP sont fictifs.

**Retour arrière** : relancer sans la surcouche, avec le seul `docker-compose.yml`. Les volumes et les données ne changent pas.

## Sauvegarde et restauration (Sprint S3H)

Sauvegarde PostgreSQL chiffrée (age), vérifiée par une restauration jetable à chaque exécution, timer systemd quotidien, restauration de test et exercice de reprise : voir [SAUVEGARDE.md](SAUVEGARDE.md).

## Production (à partir du Sprint 10)

Phase pilote : un serveur applicatif (Compose), PostgreSQL managé avec PITR, Redis managé, S3 managé, **une passerelle** (WireGuard + FreeRADIUS) au départ, une seconde lorsque les paliers de [MIKROTIK.md](MIKROTIK.md) le justifient. Images publiées sur GHCR, déploiement de production approuvé manuellement, migrations exécutées avant la bascule.

## Points de restauration

Chaque sprint validé est marqué par un tag Git `sN-done` (ex. `s0-done`, `s1-done`). Revenir à un point de restauration : `git checkout s0-done`.

Depuis S3B, la référence validée est l'étiquette **`s3b-rc2`** (commit `7496075`). La branche **`main`**, protégée (pull request obligatoire et 4 contrôles CI verts), reçoit chaque sprint après sa validation indépendante. Le développement se fait sur une branche de travail.
