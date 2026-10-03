# ADR 0014 — Chiffrement enveloppe versionné et rotation de la clé maîtresse

- Statut : Acceptée (Sprint 2)
- Complète : [ADR 0007](0007-gestion-des-secrets.md)

## Contexte

Au Sprint 1, les secrets TOTP étaient chiffrés directement avec `ENCRYPTION_KEY`
(AES-256-GCM, format `v1:iv:tag:ct`). Changer la clé rendait tous les secrets illisibles : aucune
rotation n'était possible. Les secrets futurs (MikroTik, WireGuard, RADIUS) utiliseront le même
mécanisme, la rotation doit donc exister avant eux.

## Décision

- **Chiffrement enveloppe** : chaque valeur reçoit une clé de données (DEK) aléatoire de
  32 octets ; la valeur est chiffrée par la DEK (AES-256-GCM), la DEK est chiffrée par la clé
  maîtresse (KEK) active (AES-256-GCM).
- **Format versionné** : `v2:<kid>:<wrapIv>:<wrapTag>:<wrappedDek>:<iv>:<tag>:<ct>`, où `kid`
  est l'identifiant de la clé maîtresse (`ENCRYPTION_KEY_ID`, `k1` par défaut). Le format `v1`
  reste lisible (compatibilité), toute nouvelle écriture est en `v2`.
- **Plusieurs clés connues** : `ENCRYPTION_KEY` (active) et `ENCRYPTION_PREVIOUS_KEYS`
  (`id:base64,…`, lecture seule pendant une rotation). Le déchiffrement choisit la clé par `kid`.
- **Empreintes HMAC** (codes de récupération, clés de limitation de débit) : stockées sous la
  forme `kid$mac` ; la vérification essaie toutes les clés connues (`macCandidates`).
- **Rotation** : `pnpm --filter @ecsi/api keys:rotate [--dry-run]` ré-enveloppe la DEK de chaque
  secret avec la clé active. La valeur chiffrée elle-même n'est pas réécrite et n'est jamais
  manipulée en clair hors mémoire. Idempotente ; le rapport ne contient ni valeur ni clé.

## Conséquences

- Une rotation ne coupe aucun utilisateur : l'ancienne clé reste en lecture tant qu'elle est
  listée dans `ENCRYPTION_PREVIOUS_KEYS`.
- Les codes de récupération sont des HMAC de valeurs inconnues du serveur : ils ne peuvent pas
  être recalculés. Ils restent valides tant que leur clé est conservée ; la commande les compte
  par clé, et l'utilisateur peut les régénérer. Retirer une ancienne clé trop tôt les invalide.
- Les clés de limitation de débit fondées sur une empreinte d'e-mail changent avec la clé active :
  les compteurs repartent de zéro à la rotation (effet limité à 15 minutes).
- La procédure d'exploitation est décrite dans [DEPLOYMENT.md](../DEPLOYMENT.md) et
  [SECURITY.md](../SECURITY.md).
