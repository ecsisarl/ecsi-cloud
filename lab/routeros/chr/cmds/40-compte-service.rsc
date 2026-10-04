# Groupe et compte de service ECSI CLOUD. Réf. : User (pages/8978504).
# Essai 1 : uniquement la politique rest-api (sans read), pour mesurer le minimum nécessaire.
/user/group/add name=ecsi-ro policy=rest-api comment="ecsi-cloud: lecture seule"
/user/add name=ecsi-svc group=ecsi-ro address=10.200.0.1/32 password=__SVC_PASSWORD__ comment="ecsi-cloud: compte de service"
/user/print
/user/group/print where name=ecsi-ro
