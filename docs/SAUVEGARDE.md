# Sauvegarde et restauration PostgreSQL

Sprint S3H, étape H1. Scripts dans `ops/backup/`, unités systemd dans `infra/systemd/`.

## Principe

- **Sauvegarde** (`ops/backup/pg-backup.sh`). Elle est en lecture seule sur la production : `pg_dump -Fc` de la base et `pg_dumpall --globals-only --no-role-passwords` (rôles et attributs, sans mot de passe), dans le conteneur PostgreSQL du projet Compose.
- **Vérification à chaque sauvegarde** :
  - le dump est restauré dans une pile **jetable** (projet `ecsi-backupcheck`, réseau interne, aucun port publié) ;
  - la copie est contrôlée : rôles, RLS, migrations, chaîne d'audit, déchiffrement de chaque mot de passe RouterOS et de chaque secret 2FA ;
  - le **manifeste** est écrit depuis cette copie : lignes par table, RLS et politiques, empreinte des droits, migrations, audit, nombre de secrets.
- **Chiffrement** : archive `tar` (dump, rôles, manifeste, métadonnées) chiffrée avec [age](https://age-encryption.org) pour une **clé publique**. La clé privée n'est jamais sur le serveur.
- **Fichiers produits** dans `BACKUP_DIR` (droits 600, dossier 700) :
  - `ecsi-<horodatage>.tar.age` ;
  - `.sha256` ;
  - `.info.json` : date, version PostgreSQL, commit du dépôt, identifiant de la clé de chiffrement requise, empreinte du dump, résultat de la vérification. Aucune donnée.
- **Rétention** (`ops/backup/retention.sh`) : 7 quotidiennes, 4 hebdomadaires, 3 mensuelles. Elle n'est appliquée qu'après une sauvegarde **vérifiée** : un échec ne supprime jamais rien.
- **Restauration de test** (`ops/backup/pg-restore-test.sh`). Elle a toujours lieu dans une pile jetable séparée, jamais dans la base de production :
  1. contrôle de l'empreinte du fichier, puis déchiffrement age ;
  2. contrôle de l'empreinte du dump ;
  3. restauration ;
  4. comparaison complète avec le manifeste ; aucune migration ne doit être à rejouer ;
  5. démarrage de l'API sur la base restaurée, puis `/api/v1/health` ok ;
  6. suppression de la pile jetable (`down -v` de ce projet seul).
- **Garde-fous** :
  - nom de projet réservé (`ecsi-backupcheck`, `ecsi-restoretest…`, `ecsi-reprise…`) ;
  - refus du projet de production et de tout projet qui a déjà des conteneurs ou des volumes ;
  - image applicative jamais reconstruite ni téléchargée (`ECSI_API_IMAGE`).
- **Journaux** : seules des lignes `OK` / `ECHEC` / `INFO` et des compteurs sont affichés, jamais une valeur.

Une sauvegarde ne sert à rien sans la **clé de chiffrement applicative** (`ENCRYPTION_KEY`) qui protège les mots de passe RouterOS et les secrets 2FA. `.info.json` indique son identifiant. Conservez chaque clé tant qu'une sauvegarde l'utilise (étape H2).

## Mise en place sur le serveur

1. **Clé age, sur VOTRE poste** (pas sur le serveur) :
   ```
   age-keygen -o ecsi-backup-identite.txt
   ```
   La commande affiche la clé publique `age1…`. Gardez la clé privée hors ligne, avec une deuxième copie.
2. **Serveur** :
   - `apt install age` ;
   - `mkdir -p /etc/ecsi`, puis écrire **la clé publique seule** dans `/etc/ecsi/backup-recipients.txt`. Le script refuse un fichier qui contient une clé privée.
3. **Image applicative** contenant `dist/cli/verify-restore.js` (S3H-H1 ou plus récent). Pour ne pas toucher l'étiquette de la pile en service, construisez une étiquette dédiée :
   ```
   docker build -f infra/docker/api.Dockerfile -t ecsi-cloud/api:s3h-h1 .
   ```
4. **Configuration facultative** `/etc/ecsi/backup.conf` (0600), lue par le script :
   ```
   ECSI_PROJECT=ecsi-cloud
   ECSI_REPO_DIR=/opt/ecsi-cloud
   ECSI_ENV_FILE=/opt/ecsi-cloud/.env
   ECSI_API_IMAGE=ecsi-cloud/api:s3h-h1
   BACKUP_DIR=/var/backups/ecsi
   AGE_RECIPIENTS_FILE=/etc/ecsi/backup-recipients.txt
   ```
   Du `.env`, le script ne lit que `ENCRYPTION_KEY`, `ENCRYPTION_KEY_ID`, `ENCRYPTION_PREVIOUS_KEYS` et `POSTGRES_DB`, et ne les affiche jamais.
5. **Timer quotidien** (02:30 UTC) : voir l'en-tête de `infra/systemd/ecsi-backup.service`. Pour suivre : `systemctl list-timers ecsi-backup.timer` et `journalctl -u ecsi-backup.service`.
6. **Copie hors site** : elle reste à décider (par exemple OVH Object Storage). Les fichiers sont déjà chiffrés : une simple copie de `BACKUP_DIR` suffit.

## Restauration de test

Copier la clé privée age sur le serveur **le temps du test**, puis :

```
ops/backup/pg-restore-test.sh --fichier /var/backups/ecsi/ecsi-<horodatage>.tar.age \
  --identite /root/ecsi-backup-identite.txt --env /opt/ecsi-cloud/.env
shred -u /root/ecsi-backup-identite.txt
```

Résultat attendu :

- toutes les lignes en `OK` ;
- `RESULTAT : base restaurée conforme.` ;
- `API démarrée sur la base restaurée : /api/v1/health ok` ;
- `pile jetable ecsi-restoretest supprimée`.

Toute ligne `ECHEC` donne un code de sortie non nul.

## Exercice de reprise

`--reprise` restaure dans une pile séparée `ecsi-reprise`, puis démarre son worker et la **conserve**. On vérifie ainsi que les routeurs sont supervisés depuis la base restaurée. Le worker de cette pile ne fait que lire les routeurs (aucune modification de configuration).

1. Arrêter la pile principale **sans la supprimer** :
   ```
   docker compose --profile gateway stop
   ```
   L'interface WireGuard de l'hôte et ses pairs restent en place : l'agent passerelle ne retire un pair que sur ordre de la base.
2. Restaurer en mode reprise :
   ```
   ops/backup/pg-restore-test.sh --reprise --fichier … --identite … --env /opt/ecsi-cloud/.env
   ```
3. Après une ou deux minutes, vérifier que le routeur a été joint **depuis la pile restaurée** :
   ```
   docker compose -p ecsi-reprise exec -T postgres psql -U postgres -d ecsi -c \
     "select name, status, last_seen_at > now() - interval '3 minutes' as vu_par_la_reprise from routers where deleted_at is null"
   ```
   Attendu : `ONLINE` et `t`.
4. Fin de l'exercice, dans cet ordre :
   ```
   docker compose -p ecsi-reprise --env-file /tmp/ecsi-reprise.env \
     -f docker-compose.yml -f docker-compose.prod.yml -f ops/backup/compose.restore.yml \
     --profile reprise down -v
   rm -f /tmp/ecsi-reprise.env
   docker compose --profile gateway start
   ```
   Le `down -v` ne vise que le projet `ecsi-reprise`.

## Restauration réelle (sinistre)

Ce n'est pas l'objet de H1 et ce n'est pas automatisé. La pile restaurée de l'exercice de reprise en est la base. Dans les grandes lignes :

- volume PostgreSQL neuf, initialisé par `infra/postgres/init` avec les mots de passe du `.env` ;
- `pg_restore --exit-on-error` du dump ;
- vérification par `verify-restore --compare`.

`globals.sql` documente les rôles et leurs attributs (sans mot de passe) pour comparaison.

## Rollback

`systemctl disable --now ecsi-backup.timer`. Aucun effet sur l'application.
