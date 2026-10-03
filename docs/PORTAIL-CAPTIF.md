# Portail captif

**Statut : gabarit livré au Sprint 0, connexion au Hotspot au Sprint 7.**

## Objectifs

- Compatible **Android**, **iPhone/iOS** (y compris le _Captive Network Assistant_), **Windows**, **macOS** et navigateurs classiques.
- **Extrêmement léger** : utilisable sur une mauvaise connexion.
- Personnalisable par entreprise et par site (logo, couleurs, images, nom WiFi, téléphone, WhatsApp, message, promotions, publicité).

## Choix techniques

- Application Next.js dédiée (`apps/portal`), séparée du dashboard.
- Pages rendues côté serveur en **HTML pur, sans aucun JavaScript client** ([ADR 0006](adr/0006-portail-captif-html-pur.md)) : les mini-navigateurs des assistants captifs ont des capacités limitées (scripts, cookies, stockage), et chaque requête coûte cher sur réseau faible.
- CSS en ligne, aucune police ni image externe, aucune requête secondaire.
- Formulaires HTML standard : la soumission fonctionne même sans JavaScript.
- Langue choisie d'après le terminal (`Accept-Language`), français par défaut.
- En-têtes : `Cache-Control: no-store`, CSP `default-src 'none'`, `Referrer-Policy: no-referrer`.

## Mesures actuelles (Sprint 0)

| Mesure                        | Valeur                                | Contrôle                                   |
| ----------------------------- | ------------------------------------- | ------------------------------------------ |
| Poids de la page de connexion | ≈ 2,4 Ko HTML+CSS, ≈ 1,2 Ko compressé | Test automatisé : < 12 Ko                  |
| JavaScript client             | 0                                     | Test automatisé : aucune balise `<script>` |
| Ressources externes           | 0                                     | Test automatisé                            |
| Requêtes HTTP                 | 1                                     | —                                          |

## Détection de portail par les systèmes

Chaque système d'exploitation sonde une URL connue pour détecter un portail captif (Apple, Android, Windows et Firefox utilisent chacun leurs propres URLs de test). Le Hotspot MikroTik intercepte ces requêtes et redirige vers la page de connexion. Les points à vérifier **en laboratoire sur terminaux réels** au Sprint 7 :

- ouverture automatique de la fenêtre de connexion sur chaque système ;
- fermeture ou maintien de l'assistant iOS après connexion (le message de succès doit rester lisible) ;
- comportement après expiration de la session ;
- prise en charge de l'annonce standard du portail (RFC 8910 / RFC 8908) par RouterOS : **à vérifier dans la documentation officielle**, non supposée.

## Intégration Hotspot (Sprint 7)

1. La page de login du routeur redirige vers le portail ECSI CLOUD, autorisé dans le walled garden, avec les variables Hotspot.
2. Le client saisit son code ; le formulaire est soumis **à l'URL de login du routeur**, qui reste l'autorité Hotspot et interroge RADIUS.
3. La CSP `form-action` est élargie à cette URL.
4. Une page de secours hébergée sur le routeur est étudiée pour les pannes de liaison avec le cloud.

Checklists : 12 (portail) et 13 (walled garden) de [MIKROTIK.md](MIKROTIK.md).
