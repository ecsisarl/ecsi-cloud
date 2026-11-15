# FreeRADIUS d'ECSI CLOUD (lot B) : configuration minimale écrite pour ECSI, aucune
# configuration d'exemple de l'image n'est conservée (pas d'EAP, pas de proxy, pas de
# fichier users, pas de client statique). Voir docs/RADIUS.md.
# Image officielle épinglée par version ET empreinte. Variante Ubuntu : la variante Alpine ne
# contient pas libpq (pilote rlm_sql_postgresql inutilisable sans installation de paquet).
FROM freeradius/freeradius-server:3.2.10@sha256:cc7fd136e7b03e7b332d94297530318e824a4ecfedbce54562cced723e71e812

RUN rm -rf /etc/freeradius \
 && mkdir -p /etc/freeradius /var/spool/radacct /run/radiusd \
 && useradd --system --uid 10812 --no-create-home --shell /usr/sbin/nologin ecsiradius \
 && chown ecsiradius /var/spool/radacct /run/radiusd \
 && chmod 0700 /var/spool/radacct

COPY raddb/ /etc/freeradius/
COPY entrypoint.sh /usr/local/bin/ecsi-radius-entrypoint
RUN chmod -R a=rX,u+w /etc/freeradius && chmod 0755 /usr/local/bin/ecsi-radius-entrypoint

USER ecsiradius
# Tampon d'accounting (volume nommé) : seul répertoire persistant écrit par FreeRADIUS.
VOLUME ["/var/spool/radacct"]
ENTRYPOINT ["/usr/local/bin/ecsi-radius-entrypoint"]
