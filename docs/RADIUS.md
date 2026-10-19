# RADIUS central

**Statut : non implémenté (Sprint 5).** Architecture validée : [dossier v0.1, §6](architecture/dossier-architecture-v0.1.md).

## Résumé

- FreeRADIUS 3.2 sur les passerelles, à l'écoute **uniquement sur l'interface WireGuard**.
- Le NAS (routeur) est identifié par son **IP tunnel**, garantie par le routage cryptographique de WireGuard ; secret RADIUS propre à chaque routeur.
- Autorisation par une fonction SQL `radius.authorize(nas_ip, username)` qui applique, dans l'ordre : NAS actif, compte de l'entreprise du NAS, état du ticket, **portée (LOCAL / GROUPE / GLOBAL)**, validité, temps et quota restants, MAC binding.
- Accounting (Start / Interim / Stop) dans PostgreSQL, compteurs de consommation par ticket : base du roaming exact.
- Disconnect / CoA (RFC 5176) depuis la passerelle vers l'IP tunnel du routeur.
- Accounting bufferisé sur disque si PostgreSQL est indisponible.

## MVP technique et MVP commercial

- MVP technique : portée **LOCAL**.
- MVP commercial : **LOCAL, GROUPE, GLOBAL**, validés sur plusieurs routeurs physiques (checklist 14 de [MIKROTIK.md](MIKROTIK.md)).

La fonction d'autorisation est conçue dès le Sprint 5 pour les trois portées ; seules l'interface et la validation multi-sites arrivent au Sprint 11.

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
