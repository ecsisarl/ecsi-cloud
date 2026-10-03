# Architecture d'ECSI CLOUD

Document vivant. La référence complète validée le 3 octobre 2026 est le [dossier d'architecture v0.1](architecture/dossier-architecture-v0.1.md) ; ce document en résume les choix et intègre les ajustements demandés lors de la validation.

## Vue d'ensemble

```
 Navigateurs (admins, vendeurs)        Clients WiFi (portail captif)
            │ HTTPS                               │ HTTPS
            ▼                                     ▼
 ┌──────────────────────── Nginx (TLS, rate limiting) ────────────────────────┐
 │   web (Next.js)          api (NestJS /api/v1)          portal (Next.js)    │
 └──────────────┬────────────────┬─────────────────────────────┬──────────────┘
                │                ▼                             │
                │      PostgreSQL (RLS) · Redis · S3           │
                │                ▲                             │
 ═══════════════╪════════════════╪═════════════════════════════╪══════════════
                │   Passerelles : WireGuard + FreeRADIUS + router-worker
                │                ▲ tunnel WireGuard (sortant depuis le routeur)
                │                │
            MikroTik RouterOS v7 (sans IP publique) ── points d'accès ── clients
```

Principes :

1. **Monolithe modulaire** NestJS, découpé en modules à frontières nettes ; plusieurs processus (HTTP, workers, planificateur) issus du même code.
2. **Les routeurs ne parlent qu'aux passerelles** à travers WireGuard. Ni l'API RouterOS ni RADIUS ne sont exposés sur Internet. Le serveur web n'ouvre jamais de connexion vers un routeur.
3. **Asynchrone** pour tout ce qui touche un routeur, un PDF, un export, un paiement ou une notification.
4. **Isolation des tenants en profondeur** : filtrage applicatif, RLS PostgreSQL, clés étrangères composites `(company_id, id)`.
5. **AAA centralisé** (FreeRADIUS) dès le départ : condition du roaming multi-sites.

## Composants livrés au Sprint 0

| Composant      | Emplacement                    | Rôle actuel                                                                                                                                         |
| -------------- | ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| API            | `apps/api`                     | Configuration validée (Zod), santé (`/api/v1/health`), journaux structurés (pino), erreurs RFC 9457, OpenAPI, Drizzle, migrations, rôles PostgreSQL |
| Dashboard      | `apps/web`                     | Coque de navigation responsive, tableau de bord (indicateurs vides, état réel de la plateforme), i18n FR/EN, page design system                     |
| Portail captif | `apps/portal`                  | Gabarit de connexion en HTML pur (0 JavaScript, ≈ 2,4 Ko, ≈ 1,2 Ko compressé), CSP stricte                                                          |
| Partagé        | `packages/shared`              | Schémas et types communs, rôles, devises (XOF par défaut)                                                                                           |
| Design system  | `packages/ui`                  | Jetons (couleurs, rayons, typographie), composants de base                                                                                          |
| Infrastructure | `docker-compose.yml`, `infra/` | PostgreSQL 18, Redis 8, S3 (SeaweedFS), Mailpit, Nginx, migrations automatiques                                                                     |
| CI             | `.github/workflows/ci.yml`     | Format, lint, typecheck, tests unitaires et d'intégration, build, images Docker, scan de secrets                                                    |

Les workers (BullMQ) et le planificateur seront ajoutés au premier sprint qui en a besoin (au plus tard S3 pour l'enrôlement MikroTik), afin de ne pas livrer de code inutilisé.

## Ajustements validés (3 octobre 2026)

### MVP technique et MVP commercial

- **MVP technique** (fin du Sprint 10) : peut fonctionner avec la seule portée de ticket **LOCAL**.
- **MVP commercial** : exige les portées **LOCAL, GROUPE et GLOBAL**, et **au moins un fournisseur de paiement réellement utilisable en Côte d'Ivoire**. Il n'est considéré terminé qu'après **validation réelle d'un même ticket utilisé sur plusieurs sites MikroTik autorisés**.

L'architecture RADIUS centralisée est conservée telle que décrite dans le dossier v0.1 (§6).

### Fiabilité avant optimisation

L'architecture reste capable d'évoluer vers des milliers de routeurs (passerelles partitionnées, statut issu des handshakes WireGuard, queues), mais **aucune optimisation prématurée** n'est réalisée. Progression réelle visée :

```
1 MikroTik → 2 → 10 → 50 → 100 → montée en charge progressive
```

Concrètement : une seule passerelle tant que les mesures ne justifient pas d'en ajouter une, pas de partitionnement de tables avant que le volume l'exige, pas de Kubernetes. Chaque palier est franchi après mesure (voir [MIKROTIK.md](MIKROTIK.md), « Paliers de montée en charge »).

### Laboratoire MikroTik obligatoire

Chaque étape critique MikroTik est validée **sur CHR puis sur un équipement RouterOS v7 réel** (hAP ax3, L009, RB5009 et autres modèles compatibles). Une commande qui fonctionne sur CHR n'est jamais supposée fonctionner à l'identique sur tous les équipements. Les fonctions concernées et leurs checklists de validation sont dans [MIKROTIK.md](MIKROTIK.md).

### Sécurité MikroTik

Aucune API de gestion exposée publiquement ; accès administratifs ECSI CLOUD uniquement par WireGuard ; comptes créés sur les routeurs limités aux permissions strictement nécessaires ; commandes sensibles auditées.

### Paiement

Hors du MVP technique. L'abstraction `PaymentProvider` est prévue dans l'architecture ; le fournisseur sera choisi lorsque sa documentation officielle et les accès seront disponibles. Aucune API de paiement n'est inventée.

### Portail captif

Priorité à la compatibilité Android, iPhone/iOS (Captive Network Assistant), Windows, macOS et navigateurs classiques, et à la légèreté. Voir [PORTAIL-CAPTIF.md](PORTAIL-CAPTIF.md).

### Expérience utilisateur

Interface utilisable par un exploitant non technicien. La navigation sépare :

- **Activité** : Tableau de bord, Ventes, Tickets, Forfaits, Vendeurs, Clients, Sites, Rapports ;
- **Réseau** : MikroTik, Hotspots, Monitoring ;
- **Administration** : Utilisateurs, Notifications, Journal d'audit, Paramètres.

Français par défaut, internationalisation prévue (anglais prêt), devise XOF / FCFA par défaut.

## Écarts par rapport au dossier v0.1

| Sujet                           | Dossier v0.1 | Sprint 0                                           | Raison                                                                                                            |
| ------------------------------- | ------------ | -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Stockage objet de développement | MinIO        | SeaweedFS                                          | L'image officielle MinIO n'est plus publiée sur Docker Hub ([ADR 0009](adr/0009-stockage-objet-developpement.md)) |
| Version NestJS                  | 11.x         | 12.x (ESM)                                         | Version stable courante au démarrage du projet                                                                    |
| PostgreSQL                      | 16 ou 17     | 18                                                 | Version stable courante ; `uuidv7()` natif disponible                                                             |
| Portail captif                  | Next.js      | Next.js servant du HTML pur via des route handlers | Zéro JavaScript client ([ADR 0006](adr/0006-portail-captif-html-pur.md))                                          |

## Décisions

Les décisions structurantes sont consignées dans [docs/adr](adr/).
