# Etat du routeur AVANT enrolement (CHR neuf) : acces Internet et firewall "input" restrictif.
# Les regles de firewall sont l'exemple officiel "Filter" (help.mikrotik.com pages/48660574) :
# established/related accepte, LAN d'administration accepte, ICMP accepte, tout le reste refuse.
# Elles jouent le role de la configuration par defaut d'un vrai routeur : le script
# d'enrolement doit s'inserer AVANT la regle de refus, sans rien modifier.
/system/identity/set name=CHR2
/ip/address/add address=192.168.88.11/24 interface=ether1
/ip/route/add dst-address=0.0.0.0/0 gateway=192.168.88.1
/ip/firewall/address-list/add address=192.168.88.2-192.168.88.254 list=allowed_to_router
/ip/firewall/filter/add action=accept chain=input comment="default configuration" connection-state=established,related
/ip/firewall/filter/add action=accept chain=input src-address-list=allowed_to_router
/ip/firewall/filter/add action=accept chain=input protocol=icmp
/ip/firewall/filter/add action=drop chain=input
/ip/firewall/filter/print
/ip/service/print
