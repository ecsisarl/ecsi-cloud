# Enrôlement d'un routeur : prototype de laboratoire (Sprint 3A)

Valide sur un vrai RouterOS (CHR 7.24.5) le protocole de
[`../PROTOCOLE-PROVISIONNEMENT.md`](../PROTOCOLE-PROVISIONNEMENT.md). **Ce n'est pas le code de
production** : le serveur est un prototype en Python (SQLite, pas d'authentification
administrateur, mots de passe dans des fichiers 0600 ignorés par Git). L'implémentation dans
l'API ECSI CLOUD relève d'un sprint ultérieur.

| Fichier                      | Rôle                                                                                                              |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `ecsi-enrolement.rsc.modele` | script RouterOS collé par l'administrateur (commentaires ASCII : les accents ne passent pas par la console série) |
| `serveur_enrolement.py`      | `new` (jeton + script), `public` (HTTPS, `/enroll`), `activation` (HTTP dans le tunnel, `/activate`), `show`      |
| `pki-labo.sh`                | AC et certificat du labo pour l'API publique (en production : AC publique, rien à importer)                       |
| `test-enrolement.sh`         | tests côté cloud et côté routeur après enrôlement                                                                 |
| `cmds/00-prerequis-chr2.rsc` | état du CHR vierge avant enrôlement (adresse, route, firewall d'exemple officiel)                                 |

## Déroulé (labo)

```bash
sudo lab/sim/topology.sh up                       # crée aussi le namespace « cloud » 203.0.113.30
sudo lab/routeros/enrolement/pki-labo.sh
cd lab/routeros/enrolement
sudo ip netns exec cloud python3 serveur_enrolement.py public &
sudo ip netns exec gw python3 serveur_enrolement.py activation &
CHR_MAC=52:54:00:ec:51:02 sudo ../chr/start-chr.sh /chemin/chr-7.24.5.img chr2
sudo python3 ../chr/premier-demarrage.py ../../sim/.state/chr2.sock <fichier-mdp-admin>
LAB_PASSWORD_FILE=<fichier-mdp-admin> sudo python3 ../chr/console.py ../../sim/.state/chr2.sock --login --run cmds/00-prerequis-chr2.rsc
sudo python3 serveur_enrolement.py new chr2 10.200.0.11  # écrit ../../sim/.state/enrolement-chr2.rsc (0600)
LAB_PASSWORD_FILE=<fichier-mdp-admin> sudo python3 ../chr/console.py ../../sim/.state/chr2.sock --login --timeout 300 --paste ../../sim/.state/enrolement-chr2.rsc
sudo ./test-enrolement.sh chr2 10.200.0.11 192.168.88.11
```

Résultats : [`../resultats/2026-10-04-S3A-chr-enrolement.md`](../resultats/2026-10-04-S3A-chr-enrolement.md).

## Différences avec la production (à traiter au moment de l'implémentation)

- **AC** : le script de labo télécharge l'AC du labo et vérifie son empreinte SHA-256 avant de
  l'importer (`trust-store=fetch`). En production, l'API présente un certificat d'AC publique,
  vérifié par le magasin intégré de RouterOS (`builtin-trust-store`, qui inclut `fetch` par
  défaut d'après la documentation) : l'étape 2 disparaît. **Non testé** (le labo n'a pas
  d'accès Internet depuis le CHR).
- **Mot de passe du compte de service** : stocké chiffré (chiffrement enveloppe, ADR 0014), pas
  dans un fichier.
- **État ONLINE** : décidé par le worker (handshake récent et appel REST réussi) ; le prototype
  s'arrête à `ACTIVATED`, la vérification REST est faite par `test-enrolement.sh`.
- **Réinitialisation des identifiants** : simulée en base dans le labo (retour à
  `PROVISIONING`) ; à concevoir comme action administrateur auditée.
