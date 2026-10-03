# Design system ECSI CLOUD

Paquet `@ecsi/ui` (`packages/ui`). Page de référence visuelle : `/design-system` dans le dashboard.

## Principes

- **Simple pour un non-technicien** : vocabulaire métier (« Tickets », « Ventes », « Caisse »), une action principale par écran, états vides explicites.
- **Sobre et professionnel** : fond clair, une couleur de marque, couleurs sémantiques réservées aux statuts.
- **Responsive** : barre latérale fixe sur ordinateur, tiroir sur tablette et mobile.
- **Rapide** : composants sans dépendance lourde, polices système.
- **Accessible** : contrastes suffisants, focus visible, libellés sur toutes les commandes.
- **Honnête** : une donnée absente s'affiche « — », jamais un chiffre fictif.

## Jetons

Définis par variables CSS dans `packages/ui/src/styles.css` et exposés à Tailwind CSS v4 (`bg-primary`, `text-muted`, etc.). Le thème sombre redéfinit uniquement les variables.

| Jeton                                                       | Usage                                 |
| ----------------------------------------------------------- | ------------------------------------- |
| `primary` (bleu ECSI `#1d4ed8`)                             | Actions principales, éléments actifs  |
| `success`                                                   | ONLINE, paiement reçu                 |
| `warning`                                                   | Stock faible, dégradé                 |
| `danger`                                                    | OFFLINE, erreurs, actions dangereuses |
| `surface`, `surface-muted`, `background`, `border`, `muted` | Structure                             |
| `sidebar-*`                                                 | Navigation                            |

## Composants (Sprint 0)

`Button` (principal, secondaire, discret, danger), `Card`, `Badge` (avec pastille de statut), `Input`, `Label`, `StatCard` (indicateur clé), `EmptyState`, `Logo`, utilitaire `cn`.

Les composants suivants (tableaux, formulaires complets, dialogues de confirmation des actions dangereuses, graphiques) sont ajoutés avec les modules qui les utilisent.

## Navigation

| Groupe         | Entrées                                                                        |
| -------------- | ------------------------------------------------------------------------------ |
| Activité       | Tableau de bord, Ventes, Tickets, Forfaits, Vendeurs, Clients, Sites, Rapports |
| Réseau         | MikroTik, Hotspots, Monitoring                                                 |
| Administration | Utilisateurs, Notifications, Journal d'audit, Paramètres                       |

## Internationalisation

Français par défaut, anglais prêt (`apps/web/messages/*.json`, next-intl). Un test vérifie que les deux fichiers ont exactement les mêmes clés. Devise par défaut XOF, affichée « FCFA » (`formatMoney` de `@ecsi/shared`).
