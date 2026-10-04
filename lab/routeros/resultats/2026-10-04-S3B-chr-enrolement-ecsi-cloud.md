# Enrôlement d'un CHR par ECSI CLOUD (RouterOS 7.24.5) — TESTÉ RÉELLEMENT, 2026-10-04

Sprint 3B. Chaîne complète réelle : API ECSI CLOUD (NestJS compilée), PostgreSQL 18 et Redis
réels, agent passerelle (`src/gateway.ts`) et worker de supervision (`src/worker.ts`), routeur
RouterOS 7.24.5 réel (CHR `chr2`, image officielle). Réseau du laboratoire SIMULÉ : box (NAT) et
CGNAT du laboratoire `lab/sim`, Internet de laboratoire, passerelle WireGuard `wireguard-go`
(pas de module noyau dans cet environnement). Harnais : `lab/routeros/s3b/labo-s3b.sh`.

Aucun secret dans ce document : clés publiques tronquées, jetons et mots de passe jamais affichés.

## Préparation

- Deux routeurs simulés (`r1-simule` 10.200.0.2, `r2-simule` 10.200.0.3) enregistrés à la main
  par l'API, pour vérifier que l'allocation saute les adresses occupées.
- CHR remis à l'état vierge (`enrolement/ecsi-retrait.rsc`), firewall `input` d'origine conservé.

## Déroulé

| Étape                                     | Résultat                                                                                                                             |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| « Ajouter un routeur » (gérant de SITE-A) | 201 ; adresse attribuée par le cloud : **10.200.0.4** (.1 passerelle, .2 et .3 occupées) ; statut `PROVISIONING`                     |
| Script collé dans le terminal du CHR      | 9/9 étapes (ci-dessous) ; enrôlé 21:49:59                                                                                            |
| Agent passerelle                          | « 1 ajouté(s), 0 mis à jour, 0 retiré(s) » ; pairs inconnus non touchés                                                              |
| Activation par le tunnel                  | 21:50:07 ; mot de passe chiffré (`v2:k…`) avant stockage                                                                             |
| Supervision                               | `OFFLINE -> ONLINE` à 21:50:37, REST HTTPS épinglé ; identité CHR2, 7.24.5, x86_64, CPU 8 %, mémoire, interfaces ether1, ecsi-wg, lo |
| Script recollé (rejeu)                    | 410 à l'étape 6 ; aucun doublon ; même clé publique ; ligne d'audit `routers.enroll` DENIED (REPLAY)                                 |
| Mot de passe changé sur le routeur        | `ONLINE -> DEGRADED (AUTH: Identifiants refusés par RouterOS (HTTP 401))`                                                            |
| `PUT /routers/:id/credentials`            | chiffré remplacé (clé k2) ; `DEGRADED -> ONLINE` ; le mot de passe n'apparaît dans aucun journal                                     |
| Suppression douce (admin avec 2FA)        | 204 ; « 0 ajouté(s), 0 mis à jour, 1 retiré(s) » ; routeur injoignable ; collecte arrêtée                                            |
| Retrait puis nouvel enrôlement            | nouvelle adresse **10.200.0.5** (.4 en quarantaine), nouvelle clé publique, `ONLINE`                                                 |

```
ECSI 1/9: RouterOS 7.24.5 (stable)
ECSI 2/9: AC verifiee
ECSI 3/9: interface ecsi-wg, cle publique tZoKTb…Y=
ECSI 4/9: firewall
ECSI 5/9: pair passerelle
ECSI 6/9: enrolement accepte
ECSI 7/9: tunnel etabli
ECSI 8/9: API REST HTTPS
ECSI 9/9: routeur enrole, en attente de verification par ECSI CLOUD
```

Rejeu du même script :

```
ECSI 6/9: enrolement refuse ou serveur injoignable (failure: Status 410, Gone)
ECSI 7/9: tunnel etabli
ECSI 8/9: API REST HTTPS
ECSI 9/9: compte de service deja present, inchange : routeur deja enrole
```

Après enrôlement, `www-ssl` du routeur : `available-from=10.200.0.1/32 certificate=ecsi-api`.

## Contrôles de sécurité

- Jeton : absent des journaux de l'API, de la passerelle et du worker ; en base, seule son
  empreinte SHA-256.
- Aucune colonne de clé privée WireGuard ; la clé privée du routeur n'a jamais quitté le routeur.
- Depuis l'Internet du laboratoire (espace de noms « attaquant ») : port d'activation 8081 et
  HTTPS 443 du routeur injoignables ; rejeu du jeton refusé (410).
- Chaîne d'audit : création d'enrôlement, enrôlement (SUCCESS puis DENIED REPLAY), activation,
  changement d'identifiants, suppression.

## Non couvert ici

Matériel physique (hAP ax3, L009, RB5009), Starlink réel, CGNAT d'opérateur réel, agent
passerelle avec le module WireGuard du noyau (VPS), variante d'AC publique (sans étape 2).
