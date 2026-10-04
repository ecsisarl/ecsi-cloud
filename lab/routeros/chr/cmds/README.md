# Journal des commandes passées sur le CHR `chr1`

Ces fichiers sont la **trace chronologique** de la configuration manuelle du premier CHR
(RouterOS 7.24.5), exécutés par `console.py --run` : chaque essai, y compris les essais ratés et
la matrice des politiques, avec les constats en commentaire. Ils servent de preuve, pas de
procédure.

La séquence propre et rejouable est le script d'enrôlement
[`../../enrolement/ecsi-enrolement.rsc.modele`](../../enrolement/ecsi-enrolement.rsc.modele),
testé de bout en bout sur un second CHR vierge.

| Fichier                  | Contenu                                                                                                        |
| ------------------------ | -------------------------------------------------------------------------------------------------------------- |
| `00-etat-initial.rsc`    | relevé de l'état d'usine (lecture seule)                                                                       |
| `10-reseau-firewall.rsc` | interface WireGuard puis firewall (l'adresse LAN et la route avaient été passées à la main au premier passage) |
| `20-pair-passerelle.rsc` | adresse tunnel et pair passerelle (clé publique de la passerelle masquée)                                      |
| `30-api-rest.rsc`        | certificat autosigné généré sur le routeur, service `www-ssl`                                                  |
| `40`, `41`, `42`         | compte de service et recherche des politiques minimales                                                        |

Le mot de passe du compte de service n'apparaît jamais : `__SVC_PASSWORD__` est remplacé au
moment de l'exécution à partir d'un fichier local ignoré par Git.
