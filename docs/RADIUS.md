# RADIUS central

**Statut : lot B en cours (MVP technique, portée LOCAL).** Architecture validée : [dossier v0.1, §6](architecture/dossier-architecture-v0.1.md) ; décisions du lot B ci-dessous (validées par le propriétaire le 2026-10-19).

## Résumé

- FreeRADIUS 3.2.10 (image officielle Ubuntu, épinglée par empreinte) dans le Compose de la passerelle (`radius`, profil `gateway`), à l'écoute **uniquement sur l'adresse WireGuard** de la passerelle (`10.200.0.1`, UDP 1812/1813). Jamais sur une interface publique.
- Le NAS (routeur) est identifié par l'**adresse source** du paquet, garantie par le routage cryptographique de WireGuard ; secret RADIUS propre à chaque routeur.
- PostgreSQL est la source d'autorité, via `rlm_sql` et le rôle `ecsi_radius` qui n'a **aucun droit sur les tables** : `EXECUTE` sur les fonctions `radius.*` seulement (migration 0008).
- HTTP-CHAP uniquement (pas de PAP). Ticket à code unique : identifiant = mot de passe = code.
- Accounting (Start / Interim / Stop / Accounting-On/Off) tamponné sur disque puis rejoué vers PostgreSQL : une indisponibilité de la base ne perd aucune consommation.
- CoA / Disconnect : **différé** (voir « Limites »).

## Aucun secret en base

| Élément                    | Où il vit                                                                                                                                                                 | Qui le connaît                                                     |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Code d'un ticket           | Nulle part. Dérivé à la demande : `HMAC-SHA256(VOUCHER_CODE_KEY, id du ticket)` converti dans l'alphabet `23456789abcdefghjkmnpqrstuvwxyz` (8 caractères, 31⁸ ≈ 8,5·10¹¹) | API seule (génération, impression, réimpression)                   |
| Empreinte du code          | `vouchers.code_lookup = HMAC-SHA1(RADIUS_VOUCHER_LOOKUP_KEY, code en minuscules)`                                                                                         | API (génération) et FreeRADIUS (chaque requête)                    |
| Secret RADIUS d'un routeur | Nulle part. `HMAC-SHA1(RADIUS_NAS_KEY, "nas:<id routeur>:<hotspots.nas_secret_version>")`                                                                                 | Worker (configuration du routeur) et FreeRADIUS (client dynamique) |

- Trois clés **distinctes**, une par rôle, 64 caractères hexadécimaux (`openssl rand -hex 32`), uniquement dans l'environnement du VPS (et donc dans le coffre d'escrow chiffré des paramètres, procédure H1) : jamais en base, jamais dans Git. FreeRADIUS ne reçoit que `RADIUS_VOUCHER_LOOKUP_KEY` et `RADIUS_NAS_KEY` (ni `VOUCHER_CODE_KEY`, ni `ENCRYPTION_KEY`, ni JWT).
- FreeRADIUS 3.2 ne propose que `hmacsha1`/`hmacmd5` : HMAC-SHA1 reste une fonction pseudo-aléatoire sûre (les collisions SHA-1 ne s'appliquent pas à HMAC). Les clés sont utilisées comme texte (octets de la chaîne) des deux côtés ; valeur de référence partagée par les tests (`hotspot/radius-keys.test.ts`, `test/radius.int.test.ts`).
- Une fuite de la base ou d'une sauvegarde ne donne aucun code utilisable : retrouver un code depuis son empreinte exige `RADIUS_VOUCHER_LOOKUP_KEY`.
- Comparaisons : la base retrouve le ticket par égalité d'empreinte (index unique) ; l'attaquant ne contrôle que le code saisi, dont l'empreinte est calculée avec une clé qu'il ne connaît pas. Toute comparaison d'empreintes côté Node utilise `lookupsEqual` (`timingSafeEqual`). La vérification CHAP est celle de FreeRADIUS.
- Le code n'apparaît jamais : ni dans les journaux FreeRADIUS (`auth = no`, pas de mode debug en production, refusé par l'entrypoint), ni dans le tampon d'accounting (`User-Name` remplacé par son empreinte **avant** l'écriture sur disque), ni dans `radius_postauth`, ni dans l'audit.

### Versions et rotation

- `vouchers.code_key_version` : version de `VOUCHER_CODE_KEY` (trousseau `VOUCHER_CODE_KEY_VERSION` + `VOUCHER_CODE_PREVIOUS_KEYS` « version:clé,… ») ; les tickets déjà émis restent réimprimables tant que leur ancienne clé est gardée.
- `vouchers.lookup_key_version` : version de `RADIUS_VOUCHER_LOOKUP_KEY`. Les codes étant dérivables, une rotation recalcule toutes les empreintes (API, une transaction) puis redémarre FreeRADIUS avec la nouvelle clé (coupure de l'authentification de quelques secondes ; outil de rotation : lot F).
- `hotspots.nas_secret_version` : l'augmenter change le secret d'un routeur (le worker le repousse). Rotation de `RADIUS_NAS_KEY` : nouvelle clé au worker et à FreeRADIUS, tous les hotspots repassent en synchronisation (lot F).

## Chemin d'une authentification

1. Le routeur (Hotspot, `login-by=http-chap`) envoie un Access-Request avec Message-Authenticator dans le tunnel.
2. `dynamic_clients` : premier paquet d'une adresse de la plage tunnel → `radius.nas_identity(adresse)` (routeur actif portant un hotspot activé) → secret dérivé ; adresse inconnue : paquet ignoré. Cache `lifetime = 300 s`.
3. `ecsi` / authorize : refus sans `CHAP-Password` (PAP) ou identifiant hors format ; empreinte du code ; `sql` → `radius.authorize_check` / `radius.authorize_reply` ; tout ce qui n'est pas `ACCEPT` est refusé, base indisponible comprise (`DB_UNAVAILABLE`).
4. CHAP vérifie que le mot de passe saisi est le code (`Cleartext-Password := User-Name`).
5. post-auth : `radius.postauth` journalise (jamais le code) et, à la première acceptation, active le ticket (`activated_at`, `expires_at = activation + validité`).

Ordre des contrôles de `radius.decide` : NAS actif → ticket de l'entreprise du NAS → portée LOCAL (site du ticket = site du routeur) → état (`DISABLED`, `EXPIRED`, `EXHAUSTED`) → validité calendaire → temps et volume restants → appareils simultanés (sessions ouvertes et vivantes d'autres adresses MAC).

### Attributs de réponse (dictionnaire officiel `dictionary.mikrotik`, vendor 14988)

| Attribut                              | Valeur                                                                                                                           |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `Session-Timeout`                     | min(temps de connexion restant, validité restante), en secondes                                                                  |
| `Idle-Timeout`                        | inactivité du forfait (300 s par défaut)                                                                                         |
| `Acct-Interim-Interval`               | 300 s (pris en compte en Hotspot avec `radius-interim-update=received`)                                                          |
| `Mikrotik-Rate-Limit`                 | `<montant>k/<descendant>k` : du point de vue du routeur, rx = envoi du client, tx = réception ; `0` = non limité                 |
| `Mikrotik-Total-Limit` / `-Gigawords` | volume restant (32 bits bas / bits hauts) — appliqué en `limit-bytes-total` sur l'entrée active, coupure vérifiée sur CHR 7.24.5 |

Motifs de refus (`radius_postauth.reason`, `Reply-Message` en français pour la page de connexion) : `UNKNOWN`, `WRONG_SITE`, `DISABLED`, `EXPIRED`, `EXHAUSTED`, `TOO_MANY_DEVICES`, `NAS_UNKNOWN`, `PAP_REFUSED`, `INVALID`, `DB_UNAVAILABLE`, `AUTH_FAILED` (mot de passe différent du code).

## Accounting et consommation

- `preacct` remplace `NAS-IP-Address` par l'adresse source authentifiée (le rejeu du tampon ne connaît plus l'adresse du paquet) et calcule `Acct-Unique-Session-Id`.
- `accounting` écrit dans le tampon (`detail`, volume `radius-spool`) et répond aussitôt ; le serveur `buffered-sql` rejoue vers `radius.accounting` / `radius.accounting_nas` et garde l'entrée tant que la base refuse.
- Idempotence : la session garde les compteurs cumulés du NAS, le ticket n'est incrémenté que de l'écart positif (paquet rejoué ou en retard : aucun double compte).
- Le worker appelle `radius.housekeeping()` : tickets arrivés à expiration, sessions sans nouvelles depuis 16 minutes (closes `Stale`), purge de `radius_postauth` après 90 jours.

## Expiration imposée côté RADIUS/RouterOS

- Pendant une session : `Session-Timeout` coupe la session à la fin du temps ou de la validité ; `Mikrotik-Total-Limit` borne le volume (vérifié sur CHR 7.24.5 : la session est coupée au quota, cause d'arrêt `NAS-Request`).
- Toute nouvelle connexion est refusée par `radius.decide` dès que le ticket est expiré, épuisé ou désactivé, quel que soit l'état affiché par l'interface.

## Limites connues (MVP)

- **CoA / Disconnect différé** : désactiver un ticket n'interrompt pas une session déjà ouverte ; elle s'arrête au plus tard à son `Session-Timeout` (fin du temps ou de la validité restants calculés à la connexion) ou à l'inactivité, et toute reconnexion est refusée. Un ticket sans limite de temps ni de validité (quota seul) n'a pas de `Session-Timeout`.
- Ticket à code unique : le code est l'identifiant, il circule en clair sur le Wi-Fi ouvert entre le téléphone et le routeur (comme pour tout ticket à code unique) ; CHAP protège le mot de passe, pas l'identifiant. Mode identifiant + code secret : envisageable plus tard.
- Le code étant le nom d'utilisateur, RouterOS l'affiche en clair à qui a un accès en lecture au routeur (`/ip/hotspot/active`, nom de la file dynamique, `/log` rubrique hotspot) : constaté sur CHR 7.24.5. Le compte de supervision `ecsi-svc` et `ecsi-cfg` y ont accès ; ECSI CLOUD n'en recopie rien.
- Plusieurs appareils sur un même ticket (`max_devices > 1`) : chaque session reçoit le temps restant au moment de sa connexion.
- Un client dynamique reste en cache 300 s : un routeur dont le hotspot est désactivé n'obtient plus aucune acceptation (la décision SQL le refuse aussitôt), mais ses paquets sont encore traités pendant ce délai.
- FreeRADIUS unique sur une passerelle unique ; pas de RADIUS secondaire (prévu plus tard).

## Tests

- `apps/api/test/radius.int.test.ts` : FreeRADIUS RÉEL (image `infra/radius`) + PostgreSQL 18 réel et rôles réels ; NAS simulé par `radclient` depuis un autre conteneur. Couvre CHAP, attributs, refus, portée, appareils, NAS désactivé, mauvais secret, accounting idempotent, base indisponible puis rejeu, absence du code dans la base, le tampon et les journaux, droits du rôle `ecsi_radius`.
- Laboratoire CHR (RouterOS v7) : voir [MIKROTIK.md](MIKROTIK.md) et `lab/routeros/resultats/`.

## MVP technique et MVP commercial

- MVP technique : portée **LOCAL** (contrainte `voucher_batches_scope_check`).
- MVP commercial : **LOCAL, GROUPE, GLOBAL**, validés sur plusieurs routeurs physiques (checklist 14 de [MIKROTIK.md](MIKROTIK.md)).

## Validation

Checklists 5 à 11 et 14 de [MIKROTIK.md](MIKROTIK.md). Les attributs de réponse (durée, débit, quota) et leur format côté RouterOS sont vérifiés sur la documentation officielle FreeRADIUS et MikroTik et en laboratoire avant d'être considérés acquis.

## Provisionnement RouterOS

Le worker pousse la configuration RADIUS du Hotspot sur le routeur par le compte d'écriture `ecsi-cfg` (REST HTTPS épinglé, par le tunnel) ; détail des objets, des pages de documentation et des garanties : [MIKROTIK.md, « Provisionnement Hotspot (lot B) »](MIKROTIK.md#provisionnement-hotspot-lot-b).

- `/radius` : `service=hotspot`, `address` = adresse tunnel de la passerelle (serveur FreeRADIUS), `src-address` = adresse tunnel du routeur (celle qui identifie le NAS), ports 1812 / 1813, UDP, `require-message-auth=yes-for-request-resp`, commentaire `ecsi-cloud:hs:<hotspot>`.
- Secret : `nasSecret(RADIUS_NAS_KEY, routeur, nas_secret_version)`, recalculé à chaque synchronisation et jamais stocké ; changer `nas_secret_version` (avec `sync_status = 'PENDING'`) le renouvelle sur le routeur au passage suivant. Le compte `ecsi-cfg` peut l'écrire mais pas le relire (pas de politique `sensitive`) : il est réaffirmé à chaque passage.
- Profil Hotspot : `use-radius=yes`, `radius-accounting=yes`, `radius-interim-update=received` (intervalle fourni par le serveur), `login-by=http-chap` uniquement.
- CoA / Disconnect : différés (ni `/radius/incoming`, ni règle de pare-feu).
- Le worker exécute `radius.housekeeping()` toutes les 5 minutes (tickets expirés, sessions orphelines, purge) et le journalise en compteurs.
- Le worker n'a besoin que de `RADIUS_NAS_KEY` (même valeur que le service `radius`) ; sans elle, le provisionnement Hotspot est désactivé et le signale au démarrage.
