# Adresse tunnel attribuée par ECSI CLOUD et pair « passerelle ».
# allowed-address strict : uniquement l'adresse tunnel de la passerelle (/32).
# Keepalive 25 s : maintient le mappage NAT/CGNAT (valeur recommandée par la doc WireGuard).
# Réf. : WireGuard (pages/69664792) : propriétés des pairs, name depuis 7.15.
/ip/address/add address=10.200.0.10/24 interface=ecsi-wg comment="ecsi-cloud: adresse tunnel"
/interface/wireguard/peers/add interface=ecsi-wg name=ecsi-gateway public-key="<cle publique de la passerelle>" endpoint-address=203.0.113.10 endpoint-port=51820 allowed-address=10.200.0.1/32 persistent-keepalive=25 comment="ecsi-cloud"
/interface/wireguard/peers/print detail
