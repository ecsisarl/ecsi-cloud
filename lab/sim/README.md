# Laboratoire réseau SIMULÉ (Sprint 3A)

Valide la partie **réseau** de l'architecture ECSI CLOUD sans RouterOS : NAT, CGNAT (cas 4G,
5G, Starlink, fibre sans IP publique), keepalive, changement d'IP WAN, coupures, redémarrages,
révocation et firewall de la passerelle. Les « routeurs » sont des pairs WireGuard Linux et
le service d'administration est un serveur HTTP factice (`fake_api.py`) : **aucun résultat
de ce dossier ne vaut validation RouterOS**. La validation RouterOS se fait sur CHR
(`lab/routeros/chr/`) puis sur matériel (`lab/routeros/GUIDE-TEST-MATERIEL.md`).

Prérequis (Linux, root) : `iproute2`, `iptables`, `wireguard-tools`, `wireguard-go` (ou le
module noyau), `conntrack`, `curl`, `python3`, `bc`.

```bash
sudo lab/sim/run-tests.sh          # topologie, 9 scénarios, résumé dans lab/sim/.state/resultats.md
sudo lab/sim/topology.sh up|down   # topologie seule
```

Topologie et adresses : en-tête de `topology.sh`. Firewall de la passerelle :
`gateway-firewall.sh`. Les clés WireGuard sont générées dans `lab/sim/.state/` (ignoré par Git),
chacune dans le répertoire de son propriétaire.

Dernier résultat : [`lab/routeros/resultats/2026-10-03-S3A-reseau-simule.md`](../routeros/resultats/2026-10-03-S3A-reseau-simule.md).
