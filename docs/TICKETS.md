# Forfaits et tickets (Sprint 6, partie commerciale)

Les fonctions de gestion des tickets de **Mikhmon** sont reprises dans ECSI CLOUD, mais dans son architecture : les tickets vivent dans le cloud (PostgreSQL, RLS par entreprise) et seront appliqués par le **RADIUS central** (Sprint 5), au lieu d'être recopiés comme utilisateurs Hotspot sur chaque routeur. Cette partie a été avancée avant les Sprints 4 et 5 à la demande d'ECSI SARL.

## Correspondance avec Mikhmon

| Mikhmon                                                                                     | ECSI CLOUD                                                                                                                                       | État                                        |
| ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------- |
| Profil utilisateur (prix, rate-limit, shared-users, validity, lock MAC)                     | Forfait : prix, débits ↓/↑, appareils simultanés, validité après 1re connexion, liaison MAC                                                      | ✅ Stocké, ⏳ appliqué au S5                |
| limit-uptime, limit-bytes-total                                                             | Temps de connexion cumulé, quota de données                                                                                                      | ✅ Stocké, ⏳ appliqué au S5                |
| Générer (quantité, préfixe, longueur, caractères, mode user=pass ou user/pass, commentaire) | Lot de tickets : jusqu'à 1 000, préfixe, longueur, 5 jeux de caractères sans ambiguïté, `CODE` ou `USER_PASS`, commentaire, date limite de vente | ✅                                          |
| Impression des vouchers (modèles, QR)                                                       | Page d'impression : modèles standard (QR), compact, thermique 58 mm ; QR de connexion si l'adresse du hotspot est fournie                        | ✅ (QR de connexion à valider sur matériel) |
| Liste des utilisateurs filtrée par commentaire                                              | Lots avec compteurs par état ; liste des tickets d'un lot (codes masqués) ; recherche exacte d'un code                                           | ✅                                          |
| Supprimer / désactiver un utilisateur                                                       | Désactivation définitive d'un ticket ou d'un lot, avec motif et historique                                                                       | ✅                                          |
| Rapport de ventes, recette par vendeur                                                      | Ventes, vendeurs, caisse journalière                                                                                                             | ⏳ Sprint 8                                 |
| Utilisateurs actifs, déconnexion                                                            | Clients connectés (RADIUS accounting)                                                                                                            | ⏳ Sprints 5 et 7                           |

Le dépôt de « Mikhmon by ECSI SARL » n'était pas accessible : la correspondance est établie à partir des fonctions de Mikhmon d'origine. Toute fonction propre à la version ECSI SARL reste à ajouter.

## Sécurité des codes

- Codes tirés par `crypto.randomInt` (sans biais), alphabet sans `0 O 1 I l`, **24 bits d'entropie minimum** (8 chiffres, 5 caractères majuscules + chiffres…) : risque R8 du dossier v0.1.
- Code unique par entreprise (contrainte en base, nouveau tirage en cas de collision).
- Les listes renvoient des codes masqués (`48••••61`). Les codes en clair ne sortent que par `POST /voucher-batches/:id/print` (`vouchers.export`, audité, sans le code dans l'audit).
- Un ticket désactivé ou expiré ne revient jamais à un autre état (déclencheur PostgreSQL).

## Ce qui n'est pas fait ni testé

- Aucune limite n'est appliquée au WiFi tant que le RADIUS central (S5) n'existe pas : un ticket généré ne permet pas encore de se connecter.
- Le QR de connexion (`login?username=…&password=…`) suppose la méthode HTTP PAP du Hotspot : non validé sur CHR ni sur matériel RouterOS réel.
- Portées GROUPE et GLOBAL (S11), attribution aux vendeurs et ventes (S8), export PDF côté serveur (worker) : non commencés. L'impression passe par le navigateur.
