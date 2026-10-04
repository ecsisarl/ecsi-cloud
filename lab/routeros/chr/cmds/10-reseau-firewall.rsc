# Adresse du CHR sur le LAN du site (derrière la box et le CGNAT) et route par défaut.
# Réf. : WireGuard (pages/69664792, exemples /ip/address et /ip/route).
# (adresse et route déjà ajoutées au premier passage ; ce fichier reprend à l'interface)
# Constat : RouterOS refuse une règle qui cite une interface inexistante
# (« input does not match any value of interface ») : l'interface WireGuard est donc créée
# d'abord, SANS pair (aucun trafic possible), puis le firewall, puis le pair.
# Réf. : WireGuard (pages/69664792) : clé privée générée automatiquement à la création.
/interface/wireguard/add name=ecsi-wg listen-port=13231 comment="ecsi-cloud"
/ip/firewall/filter/add chain=input action=accept protocol=tcp dst-port=443 in-interface=ecsi-wg src-address=10.200.0.1 comment="ecsi-cloud: API REST uniquement via le tunnel, depuis la passerelle"
/ip/firewall/filter/add chain=input action=accept protocol=icmp in-interface=ecsi-wg src-address=10.200.0.1 comment="ecsi-cloud: ICMP depuis la passerelle"
/ip/firewall/filter/add chain=input action=drop comment="ecsi-lab: refus par défaut"
/ip/firewall/filter/print
/interface/wireguard/print
