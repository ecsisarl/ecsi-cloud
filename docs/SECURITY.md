# Sécurité

Mesures cibles complètes : [dossier d'architecture v0.1, §14](architecture/dossier-architecture-v0.1.md). Ce document décrit ce qui est **en place** et les règles à respecter.

## Gestion des secrets

- **Aucun secret dans Git** : `.env` et `.env.*` sont ignorés (sauf `.env.example`, qui ne contient que des valeurs factices).
- Les valeurs de développement contiennent le marqueur `devonly`. **L'API refuse de démarrer en production** si une variable le contient (`apps/api/src/config/env.ts`, testé).
- `./scripts/generate-dev-env.sh` génère un `.env` local avec des secrets aléatoires (droits 600).
- **Scan de secrets** : gitleaks sur tout l'historique en CI (`.gitleaks.toml`). Recommandé en local avant chaque commit :
  `docker run --rm -v "$PWD:/repo" -w /repo zricethezav/gitleaks:latest git . --config .gitleaks.toml`
- Production : secrets injectés par le gestionnaire de secrets (Docker secrets + SOPS/age au départ, Vault ou Infisical ensuite), jamais dans une image ni un dépôt. Rotation documentée dans [DEPLOYMENT.md](DEPLOYMENT.md).
- Les erreurs de configuration ne révèlent jamais la valeur d'un secret (testé).

## Mesures en place (Sprint 0)

| Domaine         | Mesure                                                                                                                                               |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Configuration   | Validation stricte (Zod) au démarrage ; refus des valeurs de démonstration, de CORS `*` et des options de développement en production                |
| HTTP            | En-têtes de sécurité (Helmet) ; CORS limité à une liste d'origines ; corps limité à 1 Mo ; documentation OpenAPI désactivée par défaut en production |
| Erreurs         | Format RFC 9457 ; aucun détail interne pour les erreurs 5xx ; identifiant de requête corrélé avec les journaux                                       |
| Journaux        | JSON structuré ; en-têtes `Authorization`, `Cookie`, `Set-Cookie` masqués                                                                            |
| Base de données | Rôle applicatif sans privilège d'administration ni BYPASSRLS ; DDL réservé au rôle de migration ; délai maximal de requête                           |
| Réseau (dev)    | Ports d'infrastructure liés à 127.0.0.1 ; Nginx avec limitation de débit                                                                             |
| Conteneurs      | Images multi-étapes, exécution en utilisateur non root, dépendances de production uniquement                                                         |
| Portail captif  | Aucun script, CSP `default-src 'none'`, échappement systématique des valeurs, couleurs de thème validées                                             |
| CI              | Lint strict, tests, scan de secrets                                                                                                                  |

## Mesures en place (Sprint 1 : authentification, multi-entreprise, RBAC)

Décisions détaillées : [ADR 0011](adr/0011-roles-postgresql-rls-module-auth.md) (rôles PostgreSQL et RLS) et [ADR 0012](adr/0012-sessions-jetons-cookies.md) (sessions, jetons, cookies).

| Domaine              | Mesure                                                                                                                                                                                                    |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Mots de passe        | Argon2id (`@node-rs/argon2`, paramètres OWASP) ; 12 à 128 caractères ; hachage factice quand le compte n'existe pas (temps de réponse constant)                                                           |
| Jeton d'accès        | JWT HS256 de 15 min, revendications minimales (`sub`, `sid`, `realm`) ; la session est relue en base à chaque requête : révocation et désactivation immédiates                                            |
| Refresh              | Jeton opaque de 32 octets, stocké haché (SHA-256), rotation à chaque usage, 14 jours glissants, session de 30 jours maximum ; réutilisation d'un jeton déjà tourné après 30 s de grâce = session révoquée |
| Cookies              | `ecsi_at` et `ecsi_rt` httpOnly, `SameSite=Strict`, `Secure` obligatoire en production ; aucun jeton dans le stockage du navigateur                                                                       |
| CSRF                 | Double soumission : cookie `ecsi_csrf` + en-tête `X-CSRF-Token` exigé sur toute méthode non sûre authentifiée ; corps non JSON refusés (415) ; `SameSite=Strict`                                          |
| Fixation de session  | Nouvelle session (nouveaux identifiant et jetons) à chaque connexion ; défi 2FA dans un cookie distinct de 5 min, à usage unique                                                                          |
| 2FA                  | TOTP (RFC 6238, fenêtre ±1 pas, rejeu du même pas refusé) ; secret chiffré AES-256-GCM ; 10 codes de récupération hachés (HMAC), usage unique                                                             |
| 2FA obligatoire      | `SUPER_ADMIN` et `ADMIN_ENTREPRISE` : tant qu'elle n'est pas activée, la session ne peut appeler que les routes d'activation de la 2FA                                                                    |
| Énumération          | Même réponse et même durée pour un compte inexistant, un mauvais mot de passe ou un compte désactivé ; « mot de passe oublié » répond toujours 202                                                        |
| Liens par e-mail     | Jetons opaques hachés en base, usage unique ; réinitialisation 30 min, invitation 7 jours ; réinitialisation = toutes les sessions révoquées                                                              |
| Limitation de débit  | Redis, partagée entre instances (tableau ci-dessous) ; réponse 429 avec `Retry-After`                                                                                                                     |
| Multi-entreprise     | Entreprise courante lue dans la session, jamais dans la requête (schémas Zod stricts) ; RLS PostgreSQL + filtres explicites ; voir [DATABASE.md](DATABASE.md)                                             |
| RBAC                 | 7 rôles système, permissions `ressource.action`, garde globale ; impossible d'attribuer une permission qu'on ne détient pas (anti-escalade)                                                               |
| Super administrateur | Domaine séparé (`platform_admins`, `/api/v1/platform/auth`), sessions et 2FA propres ; un utilisateur d'entreprise ne peut jamais l'obtenir                                                               |
| Validation           | Zod sur chaque corps, paramètre et requête ; requêtes SQL paramétrées (Drizzle) ; React échappe les sorties (aucun `dangerouslySetInnerHTML`)                                                             |
| Journaux             | Mots de passe, jetons, codes, cookies et chaîne de requête jamais journalisés (testé) ; adresse IP réelle via `TRUST_PROXY_HOPS`                                                                          |

### Limites de débit

| Action                        | Limite                                                    |
| ----------------------------- | --------------------------------------------------------- |
| Connexion                     | 20 / 15 min par IP ; 5 échecs / 15 min par adresse e-mail |
| Vérification 2FA              | 30 / 15 min par IP ; 5 essais par défi                    |
| Mot de passe oublié           | 5 / h par adresse e-mail ; 20 / h par IP                  |
| Réinitialisation              | 20 / h par IP                                             |
| Invitation (aperçu, accepter) | 30 / h par IP                                             |
| Refresh                       | 300 / 15 min par IP                                       |

Les clés Redis ne contiennent jamais d'adresse e-mail en clair (empreinte HMAC).

### Limites connues (Sprint 1)

- Journal d'audit en base : Sprint 2 ; les événements de sécurité vont pour l'instant dans les journaux applicatifs.
- Désactivation de la 2FA par l'utilisateur et réinitialisation par un administrateur : non livrées.
- Pas de nonce CSP dans le dashboard Next.js (en-têtes Helmet côté API et Nginx uniquement).
- Pas de mode Bearer pour les clients non navigateur (applications mobiles, intégrations) : à concevoir avec l'API publique.
- La RLS protège contre les oublis de filtre, pas contre un rôle `ecsi_auth` compromis (voir ADR 0011).

## À venir (par sprint)

- **S2** : journal d'audit chaîné par hachage, chiffrement enveloppe des secrets (AES-256-GCM).
- **S3** : sécurité MikroTik (voir ci-dessous).

## Sécurité MikroTik (règles validées)

- Aucune API de gestion MikroTik exposée publiquement.
- Accès administratifs ECSI CLOUD **uniquement par WireGuard** ; services du routeur restreints à l'adresse de la passerelle.
- Comptes créés sur les routeurs limités aux permissions strictement nécessaires.
- Toutes les commandes sensibles auditées ; actions dangereuses avec confirmation explicite.
- Clé privée WireGuard générée sur le routeur, jamais transmise.

## Signaler une vulnérabilité

Voir [SECURITY.md](../SECURITY.md) à la racine du dépôt.
