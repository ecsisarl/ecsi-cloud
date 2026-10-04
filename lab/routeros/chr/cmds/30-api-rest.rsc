# Certificat TLS de l'API REST généré SUR le routeur (clé privée jamais exportée), autosigné ;
# ECSI CLOUD épinglera son empreinte (SHA-256) à l'enrôlement.
# Réf. : Certificates (pages/2555969), Services (pages/103841820), REST API (pages/47579162).
# Constat : avec key-usage=…,tls-server sans key-cert-sign, « sign » échoue (« CA not found ») :
# un certificat autosigné doit garder l'usage key-cert-sign. On reprend donc l'usage par
# défaut documenté (digital-signature,key-encipherment,data-encipherment,key-cert-sign,
# crl-sign,tls-server,tls-client).
/certificate/remove ecsi-api
/certificate/add name=ecsi-api common-name=ecsi-api key-size=prime256v1 days-valid=3650
/certificate/sign ecsi-api
/certificate/print detail
# www-ssl (HTTPS) seulement ; www (HTTP) n'est pas utilisé (la doc le déconseille).
# address= : refus applicatif en plus du firewall (deux barrières).
# Constat ultérieur : RouterOS 7.24 a renommé « address » en « available-from » (changelog 7.24,
# « backwards compatible via deprecation ») ; « address » fonctionne encore mais affiche un
# avertissement. Le script d'enrôlement choisit le nom selon la version.
/ip/service/set www-ssl certificate=ecsi-api disabled=no address=10.200.0.1/32
/ip/service/print where name~"www"
