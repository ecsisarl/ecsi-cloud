# Lot B — compte ecsi-cfg et provisionnement Hotspot sur CHR RouterOS 7.24.5, 2026-10-19

Chaîne réelle, comme au S3B : API ECSI CLOUD, agent passerelle et worker compilés depuis la
branche du lot B, PostgreSQL 18 et Redis réels (Docker), routeur RouterOS 7.24.5 réel (CHR
`chr2`, image officielle, QEMU sans accélération). Réseau du laboratoire SIMULÉ (espaces de noms
Linux, passerelle `wireguard-go`). Harnais : `lab/routeros/s3b/labo-s3b.sh` (nouvelle commande
`services`), pilote `lab/routeros/s3b/pilote.mjs` (`config-acces`, `config-etat`), CHR démarré
avec `CHR_HOTSPOT=1 lab/routeros/chr/start-chr.sh` (deuxième carte `ether2` sur le pont `br-hs`),
client Hotspot `lab/routeros/lotb/client-hotspot.sh`. **Aucun secret ci-dessous** : le mot de
passe de ecsi-cfg est tiré par le routeur et n'a jamais été affiché ; le secret RADIUS n'est
cité que par sa longueur.

Classement : **TESTÉ RÉELLEMENT** (sur le CHR, chaîne réelle), **SIMULÉ** (faux routeur REST
des tests automatiques), **NON TESTÉ**.

## TESTÉ RÉELLEMENT

| Heure (UTC)                                                                                             | Action                                                                                       | Résultat                                                                                                                                                                                                                                                    |
| ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 10:11–10:12                                                                                             | `ecsi-retrait.rsc` mis à jour, collé sur le CHR encore configuré par une campagne antérieure | `ECSI: configuration ECSI CLOUD retiree` ; puis enrôlement **9/9**, routeur `ONLINE` (10.200.0.2, REST HTTPS épinglé)                                                                                                                                       |
| 10:15                                                                                                   | `GET /routers/:id/config-access`                                                             | `{"status":"NONE","activatedAt":null,"expiresAt":null}`                                                                                                                                                                                                     |
| 10:15:09                                                                                                | `POST /routers/:id/config-access` (administrateur, 2FA)                                      | 201 `{script, expiresAt}` ; audit `routers.config_access.create` sans jeton ni script. Un premier essai à 10:13:33 avait échoué (500, audit FAILURE) : insertion Drizzle refusée par les privilèges par colonne, corrigée (insertion à colonnes explicites) |
| 10:15:27                                                                                                | Script collé dans le terminal du CHR                                                         | `ECSI 1/4 … 4/4: compte de configuration active` ; passerelle : `compte de configuration activé depuis 10.200.0.2` ; en base : `ecsi-cfg`, chiffré `v2:`, jeton consommé ; audit `router.config_access.activated` (SYSTEM) ; `GET` → `ACTIVE`               |
| 10:15, 14:30                                                                                            | `/user print`, export du CHR                                                                 | `ecsi-cfg` groupe `ecsi-rw`, `address=10.200.0.1/32` ; `ecsi-rw policy=read,write,api,rest-api,!sensitive,!policy,!password,…` ; `ecsi-svc` inchangé (`ecsi-ro`)                                                                                            |
| (redémarrage du bac à sable : base et fichiers conservés, services relancés par `labo-s3b.sh services`) |                                                                                              |                                                                                                                                                                                                                                                             |
| 14:29:11                                                                                                | Worker démarré avec `RADIUS_NAS_KEY`                                                         | `Provisionnement Hotspot actif` ; entretien RADIUS exécuté (`radius.housekeeping()` : 0, 0, 0)                                                                                                                                                              |
| 14:30:38                                                                                                | Ligne `hotspots` insérée en SQL (ether2, 10.5.50.1/24, pool .10–.200, `wifi.ecsi.lan`)       | `SYNCED v1` : **9 ajouts** ; export ci-dessous ; `/ip/hotspot` `running` ; longueur du secret `/radius` relue en console : **40**                                                                                                                           |
| 14:33:14                                                                                                | Repassé en `PENDING` sans changement                                                         | `SYNCED` : **0 ajout, 1 modification** (secret réaffirmé : illisible pour ecsi-cfg), export identique                                                                                                                                                       |
| 14:33:53                                                                                                | Interface changée en `ether1` (WAN)                                                          | `ERROR (CONFIG: Interface ether1 : porte la route par défaut (WAN), refusée)` ; **rien modifié** sur le routeur                                                                                                                                             |
| 14:34:12                                                                                                | Interface changée en `ecsi-wg`                                                               | `ERROR (CONFIG: Interface ecsi-wg interdite (tunnel de gestion))` ; rien modifié                                                                                                                                                                            |
| 14:34:27                                                                                                | ether2, réseau 10.5.60.1/24                                                                  | `SYNCED v4` : **7 modifications** en place (adresse, pool, réseau DHCP, profil, NAT, filtre, secret), aucun objet recréé                                                                                                                                    |
| 14:34:46                                                                                                | `desired_state = DISABLED`                                                                   | `SYNCED v5` : **9 retraits** ; export identique à celui d'avant le Hotspot, à deux règles près posées par RouterOS lui-même (voir Constats)                                                                                                                 |
| 14:35:16                                                                                                | Réactivé                                                                                     | `SYNCED v6` : 9 ajouts ; les règles posées par RouterOS ne sont pas dupliquées                                                                                                                                                                              |
| vers 14:37                                                                                              | Client dans l'espace de noms `hsclient` (`client-hotspot.sh up`, `dhcp`)                     | `DHCP ACK : 10.5.60.100/24 passerelle 10.5.60.1 DNS 10.5.60.1` ; `curl http://203.0.113.30/` → **302** vers `http://wifi.ecsi.lan/login?dst=…` ; la page de connexion contient les champs `username`, `password` et `hexMD5` (CHAP)                         |
| 14:38:43                                                                                                | Deuxième script `config-access` (compte ACTIVE)                                              | 201, audit `replacesActive: true` ; script collé (14:39:17) : mot de passe remplacé ; 14:39:45 synchronisation OK avec le nouveau                                                                                                                           |
| 14:40:05                                                                                                | Script DÉJÀ utilisé recollé (rejeu)                                                          | passerelle `INVALID_TOKEN` (409), audit `router.config_access.activation` DENIED ; le script **retire ecsi-cfg** et s'arrête (`activation refusee … compte ecsi-cfg retire`)                                                                                |
| 14:40:42                                                                                                | Synchronisation suivante                                                                     | `ERROR (AUTH: Identifiants refusés par RouterOS (HTTP 401))` ; aucun mot de passe dans le message ni dans les journaux                                                                                                                                      |
| 14:42:16                                                                                                | Troisième script collé                                                                       | compte réactivé ; après le délai de nouvelle tentative, 14:42:45 `SYNCED`                                                                                                                                                                                   |
| 14:43                                                                                                   | `ecsi-retrait.rsc` collé avec le Hotspot ACTIF                                               | `ECSI: configuration ECSI CLOUD retiree` ; export : plus aucun objet `ecsi-*` ni `ecsi-cloud:hs:` (restent les deux règles posées par RouterOS), `/user` : `admin` seul                                                                                     |

Contrôles complémentaires : aucune chaîne de 40 caractères hexadécimaux (format du secret NAS) ni
le mot « password » dans `worker.log`, `gateway.log` et `api.log` du laboratoire.

### Objets créés (export `terse` du CHR, v1, extrait)

```
/ip hotspot profile add dns-name=wifi.ecsi.lan hotspot-address=10.5.50.1 login-by=http-chap name=ecsi-hs-0235931d6bdf use-radius=yes
/ip pool add comment=ecsi-cloud:hs:<hotspot> name=ecsi-hs-0235931d6bdf ranges=10.5.50.10-10.5.50.200
/ip address add address=10.5.50.1/24 comment=ecsi-cloud:hs:<hotspot> interface=ether2 network=10.5.50.0
/ip dhcp-server add address-pool=ecsi-hs-0235931d6bdf comment=ecsi-cloud:hs:<hotspot> interface=ether2 name=ecsi-hs-0235931d6bdf
/ip dhcp-server network add address=10.5.50.0/24 comment=ecsi-cloud:hs:<hotspot> dns-server=10.5.50.1 gateway=10.5.50.1
/ip firewall filter add action=drop chain=forward comment=ecsi-cloud:hs:<hotspot> out-interface=ecsi-wg src-address=10.5.50.0/24
/ip firewall nat add action=masquerade chain=srcnat comment=ecsi-cloud:hs:<hotspot> out-interface=!ecsi-wg src-address=10.5.50.0/24
/ip hotspot add address-pool=ecsi-hs-0235931d6bdf disabled=no interface=ether2 name=ecsi-hs-0235931d6bdf profile=ecsi-hs-0235931d6bdf
/radius add address=10.200.0.1 comment=ecsi-cloud:hs:<hotspot> service=hotspot src-address=10.200.0.2
```

`radius-accounting=yes`, `radius-interim-update=received` (profil), ports 1812/1813,
`protocol=udp` et `require-message-auth=yes-for-request-resp` (`/radius`) sont les valeurs par
défaut de RouterOS 7.24.5 : envoyées, elles n'apparaissent pas dans l'export `terse` mais dans
`print detail` (vérifié). Les règles du tunnel posées par l'enrôlement (`ecsi-cloud: …`) et
l'accès REST restreint à 10.200.0.1 sont inchangés.

## Constats

1. **Politique ecsi-rw sans `sensitive`** : l'écriture de la propriété `secret` de `/radius`
   par REST **réussit** sans la politique `sensitive` (longueur relue en console admin : 40) ;
   en revanche ecsi-cfg ne la relit pas (propriété absente de la réponse REST). Le
   réconciliateur la réaffirme donc à chaque passage (1 modification sur un passage
   idempotent). Le groupe reste `read,write,api,rest-api`.
2. **`comment` refusé** sur `/ip/hotspot` et `/ip/hotspot/profile` (`bad parameter comment`) :
   ces deux objets sont reconnus à leur nom réservé `ecsi-hs-<12 derniers chiffres hex de
l'identifiant>` ; tous les autres portent le commentaire `ecsi-cloud:hs:<identifiant>`.
3. **Règles posées par RouterOS** : à la création du premier Hotspot, RouterOS ajoute deux
   règles désactivées `place hotspot rules here` (chaîne `unused-hs-chain`) dans
   `/ip/firewall/filter` et `/ip/firewall/nat`. Elles ne sont pas à nous : ni modifiées ni
   retirées (ni par le retrait, ni par le script de retrait), et non dupliquées à la
   réactivation. Les règles dynamiques du Hotspot (redirection DNS 53 → 64872, HTTP…) sont
   gérées par RouterOS et disparaissent avec lui.
4. **Client DHCP du laboratoire** : sur un veth, une socket UDP ordinaire laisse la somme de
   contrôle UDP au déchargement matériel ; le CHR (derrière tap/QEMU) recevait une somme
   invalide et ignorait la requête. `lab/routeros/lotb/dhcp-client.py` construit les trames
   complètes (AF_PACKET) quand ni `udhcpc` ni `dhclient` n'existent.
5. **Console** : un `print detail` long (`/ip/firewall/nat`, règles dynamiques du Hotspot)
   déclenche la pagination de la console série et bloque `console.py` : utiliser `/export`
   ou `print` filtré.

## SIMULÉ (tests automatiques, faux routeur REST à état)

Liste blanche du transport d'écriture (menus, propriétés, valeurs, marques), refus de
modifier ou supprimer un objet non marqué, épinglage TLS, réconciliation (création,
idempotence, dérive, doublons, retrait, contrôles préalables, confirmation), worker contre
PostgreSQL réel : `writer.test.ts`, `reconcile.test.ts`, `test/router-config-access.int.test.ts`.

## NON TESTÉ

- Authentification et accounting RADIUS du client Hotspot contre FreeRADIUS (service `radius`
  du lot B, hors de ce périmètre) : la page de connexion a été atteinte, aucun ticket n'a été
  soumis.
- CoA / Disconnect (différés par décision du propriétaire : ni `/radius incoming`, ni règle de
  pare-feu).
- Matériel physique (hAP, RB) et autres versions de RouterOS que 7.24.5.
- Création du Hotspot par l'API et l'interface (lot B « application », autre branche) : la ligne
  `hotspots` a été insérée en SQL, avec les mêmes conventions (`sync_status = 'PENDING'`,
  `config_version + 1` à chaque changement).
