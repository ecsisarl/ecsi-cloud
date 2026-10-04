# Laboratoire RouterOS

Stratégie, matrice et checklists : [docs/MIKROTIK.md](../../docs/MIKROTIK.md).

## Contenu

- `resultats/` : une fiche par campagne de test (modèle, version RouterOS, checklist, preuves).
- `RESULTATS-MODELE.md` : modèle de fiche.
- `PROTOCOLE-PROVISIONNEMENT.md` : protocole d'enrôlement (testé sur CHR au Sprint 3A).
- `GUIDE-TEST-MATERIEL.md` : procédure pas à pas sur hAP ax3, L009 et RB5009.
- `chr/` : outils du laboratoire CHR (lancement QEMU, console série, sonde REST, tests de
  sécurité et de résilience) et journal des commandes passées (`chr/cmds/`).
- `enrolement/` : prototype de laboratoire du protocole d'enrôlement (script RouterOS modèle,
  serveur, tests). En production, les scripts seront générés par l'API à partir de ce modèle.
- `s3b/` : laboratoire du Sprint 3B, enrôlement d'un CHR par l'API ECSI CLOUD réelle, l'agent
  passerelle et le worker (`labo-s3b.sh up|down`, `pilote.mjs` pour piloter l'API comme le
  dashboard). Secrets générés dans `lab/sim/.state/s3b` (0600, ignoré par Git), jamais affichés.
- Laboratoire réseau simulé (sans RouterOS) : [`../sim/`](../sim/README.md).

## Mise en place du CHR

Suivre la documentation officielle « Cloud Hosted Router » de help.mikrotik.com pour la version visée (téléchargement de l'image, hyperviseur, licence). Ne pas utiliser d'image CHR provenant d'une source non officielle.
