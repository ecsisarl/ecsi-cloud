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

## Mesures en place (Sprint 2 : entreprises, utilisateurs, sites, audit)

Décisions détaillées : [ADR 0013](adr/0013-console-plateforme-role-auth.md) (console super administrateur), [ADR 0014](adr/0014-chiffrement-enveloppe-rotation.md) (chiffrement enveloppe et rotation), [ADR 0015](adr/0015-journal-audit-chaine.md) (journal d'audit).

| Domaine              | Mesure                                                                                                                                                                                                                          |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Portée par site      | Rôle attribué à toute l'entreprise ou à des sites ; un site hors portée répond 404, un site visible sans la permission demandée répond 403 ; les listes sont filtrées côté serveur                                              |
| Contournements       | `companyId` et tout champ ou paramètre inconnu refusés (422) dans le corps et la requête ; en-têtes ignorés ; l'entreprise vient toujours de la session (testé par UUID, URL, corps, en-tête)                                   |
| Anti-escalade        | Attribuer, modifier ou retirer un rôle exige de détenir toutes ses permissions **sur la même portée** ; un membre plus privilégié que soi ne peut être ni modifié ni désactivé                                                  |
| Auto-protection      | Impossible de modifier son propre statut, ses rôles ou son accès (403)                                                                                                                                                          |
| Changement de rôles  | Toutes les sessions du membre sont révoquées ; ses nouveaux droits s'appliquent à la reconnexion                                                                                                                                |
| Profil d'entreprise  | `ecsi_app` ne peut modifier que les colonnes du profil (privilèges PostgreSQL par colonne) ; statut, suspension et identifiant réservés à la plateforme                                                                         |
| Logo                 | PNG, JPEG ou WebP vérifiés par leur signature (pas par l'extension), 512 Ko maximum ; SVG refusé ; servi avec la CSP `default-src 'none'; sandbox`                                                                              |
| Journal d'audit      | Ajout seul (déclencheurs, même pour le propriétaire), chaîne SHA-256 calculée en base, vérification de chaîne ; refus et échecs audités ; IP, user-agent et identifiant de requête                                              |
| Secrets dans l'audit | Clés `password`, `token`, `secret`, `cookie`, `totp`, `hash`, `private_key`, `api_key`, `encryption`, `recovery`, `credential`… masquées à toute profondeur ; métadonnées de site refusant ces clés                             |
| Chiffrement          | Enveloppe AES-256-GCM (clé de données par valeur, clé maîtresse versionnée) ; rotation sans interruption                                                                                                                        |
| Récupération 2FA     | Permission dédiée `users.mfa.reset` (administrateur) ou console plateforme ; code TOTP de l'auteur et motif exigés ; sessions de l'utilisateur révoquées ; e-mail d'information ; auditée ; l'ancien secret n'est jamais révélé |
| Super administrateur | Console `/api/v1/platform/*` (domaine séparé, 2FA vérifiée) ; création, suspension (sessions révoquées) et réactivation auditées dans la chaîne `platform` et dans celle de l'entreprise                                        |

### Rotation de la clé de chiffrement

Procédure validée en S3H-H2. Exemple : `k2` active aujourd'hui, `k3` nouvelle clé.

**Ce que la clé protège.**

- Les mots de passe RouterOS des routeurs, tous, y compris les routeurs supprimés.
- Les secrets 2FA.
- Les codes de récupération 2FA. Ce sont des empreintes HMAC : ils ne peuvent pas être ré-enveloppés et doivent être régénérés par les utilisateurs.
- Les empreintes d'e-mail des limites de débit (remises à zéro, sans conséquence).

**Principes.**

- L'ancienne clé reste dans `ENCRYPTION_PREVIOUS_KEYS` jusqu'à ce que le contrôle `--verify` déclare qu'aucune donnée n'en dépend.
- Elle est ensuite conservée **hors ligne** tant qu'il existe des sauvegardes antérieures à la rotation : elles ne se restaurent qu'avec elle.
- La commande ne retire jamais une clé.
- **Ré-enveloppe contrôlée** :
  - chaque secret doit se déchiffrer avant et après, à l'identique, sinon rien n'est écrit ;
  - l'écriture est conditionnelle : un identifiant modifié pendant la rotation (activation d'un routeur, nouvelle 2FA), déjà sous la clé active, n'est pas écrasé ;
  - seule la clé de données change d'enveloppe.
- **Commande d'exploitation** : service Compose `keys-rotate`, profil `ops`, sans port ni dépendance. Ses sorties ne contiennent que des compteurs et des identifiants de clé.

```
docker build -f infra/docker/api.Dockerfile -t ecsi-cloud/api:s3h-h2 .   # image de la commande
export ECSI_OPS_IMAGE=ecsi-cloud/api:s3h-h2
OPS="docker compose --profile ops run --rm --no-deps keys-rotate"        # + -f docker-compose.prod.yml si la surcouche est utilisée
$OPS --verify      # contrôle, lecture seule
$OPS --dry-run     # simulation : chaque secret est contrôlé, rien n'est écrit
$OPS               # rotation, puis contrôle
```

`--verify` donne, pour les mots de passe RouterOS et les secrets 2FA :

- le nombre de secrets par identifiant de clé ;
- le nombre de secrets sous la clé active, déchiffrés **avec elle seule** ;
- le nombre de secrets encore sous une ancienne clé ;
- le nombre de secrets illisibles.

Il compte aussi les codes de récupération par clé. Code de sortie non nul s'il existe un illisible.

**Procédure** (l'ancienne clé reste disponible jusqu'au point 8) :

1. **Sauvegarde H1 vérifiée** : `ops/backup/pg-backup.sh`, puis restauration de test (docs/SAUVEGARDE.md).
2. **Nouvelle clé.**
   - `openssl rand -base64 32`, rangée d'abord dans le coffre hors ligne.
   - Dans `.env` :
     - `ENCRYPTION_KEY=<k3>` ;
     - `ENCRYPTION_KEY_ID=k3` ;
     - `ENCRYPTION_PREVIOUS_KEYS=k2:<k2>`, en conservant toute autre ancienne clé déjà présente.
   - Avant tout redémarrage, `$OPS --verify` : attendu `0 illisible(s)`. Cela prouve que `k2` a été recopiée correctement.
   - Puis redémarrer **tous** les processus qui déchiffrent, avec les deux clés : `docker compose --profile gateway up -d --no-build`.
3. **Contrôle.**
   - Services `healthy`.
   - Routeurs ONLINE, aucun `last_error` « indéchiffrable ».
   - Connexion 2FA OK.
   - `$OPS --verify` : `0 illisible(s)`, « NE PAS retirer ».
4. **Simulation** : `$OPS --dry-run`, avec 0 en échec.
5. **Rotation** : `$OPS`, avec 0 en échec. Elle est idempotente : une deuxième exécution ré-enveloppe 0.
6. **Contrôle** : « 0 encore sous une ancienne clé, 0 illisible(s) ». Si des codes de récupération dépendent encore de `k2`, les utilisateurs concernés les régénèrent, puis on relance `--verify`.
7. **Observation.**
   - Plusieurs cycles du worker (au moins 3 min), routeurs ONLINE, connexion 2FA OK.
   - Nouvelle sauvegarde H1 vérifiée, désormais sous `k3`.
8. **Retrait de `k2` de l'environnement**, seulement si `--verify` déclare « aucune donnée ne dépend plus des anciennes clés ».
   - Vider `ENCRYPTION_PREVIOUS_KEYS`, puis `docker compose --profile gateway up -d --no-build`.
   - `$OPS --verify` : `clés fournies : k3`, `0 illisible(s)`.
   - Routeurs ONLINE, 2FA OK.
9. **`k2` conservée hors ligne, sous scellé**, tant qu'une sauvegarde antérieure à la rotation existe (rétention : 3 mois). Pour restaurer une telle sauvegarde : `ENCRYPTION_PREVIOUS_KEYS=k2:<k2>` dans le fichier passé à `pg-restore-test.sh --env`.

**Retour arrière.**

- **Avant le point 8** :
  - `ENCRYPTION_KEY=<k2>`, `ENCRYPTION_KEY_ID=k2`, `ENCRYPTION_PREVIOUS_KEYS=k3:<k3>` ;
  - `docker compose --profile gateway up -d --no-build` ;
  - `$OPS` ré-enveloppe tout sous `k2`, puis `$OPS --verify`.
- **Après le point 8** : remettre `k2` dans `ENCRYPTION_PREVIOUS_KEYS` depuis le scellé, puis redémarrer.
- **En dernier recours** : la sauvegarde H1 et `k2`.

**Rôles utilisés par `keys-rotate`.**

- **Propriétaire des tables** (`DATABASE_MIGRATOR_URL`) : contrôle et mots de passe RouterOS. Lui seul voit les routeurs supprimés et en cours d'enrôlement, car la RLS de `ecsi_worker` les masque.
- **`ecsi_auth`** : secrets 2FA.
- **Repli sans `DATABASE_MIGRATOR_URL`** : `ecsi_worker`, routeurs actifs seulement. La commande l'indique, et l'ancienne clé n'est alors jamais déclarée retirable.

### Limites de débit

| Action                        | Limite                                                                                                                      |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Connexion                     | 20 / 15 min par IP (`RATE_LIMIT_LOGIN_PER_IP`, relevé uniquement pour les tests E2E) ; 5 échecs / 15 min par adresse e-mail |
| Vérification 2FA              | 30 / 15 min par IP ; 5 essais par défi                                                                                      |
| Mot de passe oublié           | 5 / h par adresse e-mail ; 20 / h par IP                                                                                    |
| Réinitialisation              | 20 / h par IP                                                                                                               |
| Invitation (aperçu, accepter) | 30 / h par IP                                                                                                               |
| Refresh                       | 300 / 15 min par IP                                                                                                         |

Les clés Redis ne contiennent jamais d'adresse e-mail en clair (empreinte HMAC).

### Limites connues (Sprint 1)

- Désactivation de la 2FA par l'utilisateur : non livrée (la réinitialisation par un administrateur l'est depuis le Sprint 2).
- Pas de nonce CSP dans le dashboard Next.js (en-têtes Helmet côté API et Nginx uniquement).
- Pas de mode Bearer pour les clients non navigateur (applications mobiles, intégrations) : à concevoir avec l'API publique.
- La RLS protège contre les oublis de filtre, pas contre un rôle `ecsi_auth` compromis (voir ADR 0011).

### Limites connues (Sprint 2)

- La chaîne d'audit détecte la modification d'un maillon, pas la suppression des derniers maillons par un superutilisateur PostgreSQL : export externe des empreintes prévu au Sprint 10.
- La garde « dernier administrateur » existe dans le service mais n'est pas atteignable par l'API avec les rôles système (l'auto-protection et l'anti-escalade s'appliquent avant) : elle reste en défense en profondeur.
- Une rotation de clé remet à zéro les compteurs de limitation de débit fondés sur une empreinte d'e-mail.
- Rôles personnalisés : non livrés (seuls les 7 rôles système sont attribuables).

## À venir (par sprint)

- **S3** : sécurité MikroTik (voir ci-dessous).

## Sécurité MikroTik (règles validées)

- Aucune API de gestion MikroTik exposée publiquement.
- Accès administratifs ECSI CLOUD **uniquement par WireGuard** ; services du routeur restreints à l'adresse de la passerelle.
- Comptes créés sur les routeurs limités aux permissions strictement nécessaires.
- Toutes les commandes sensibles auditées ; actions dangereuses avec confirmation explicite.
- Clé privée WireGuard générée sur le routeur, jamais transmise.

## Signaler une vulnérabilité

Voir [SECURITY.md](../SECURITY.md) à la racine du dépôt.
