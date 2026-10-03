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

## À venir (par sprint)

- **S1** : Argon2id, JWT courts + refresh rotatif avec détection de réutilisation, cookies httpOnly/Secure/SameSite, CSRF, 2FA TOTP obligatoire pour les administrateurs, rate limiting applicatif, RLS.
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
