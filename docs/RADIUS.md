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
