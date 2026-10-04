# Matrice mesurée sur CHR 7.24.5 avec un utilisateur NEUF par combinaison (GET /rest/system/identity,
# /rest/system/resource, /rest/interface) :
#   rest-api                      -> 500 « std failure: not allowed (9) »
#   read,rest-api                 -> 500 « std failure: not allowed (9) »
#   rest-api,api                  -> 500 « not enough permissions (9) »
#   rest-api,web | +sensitive | +test (avec read) -> 500 « not allowed »
#   read | read,api | read,web    -> 401 (pas de rest-api)
#   read,rest-api,api             -> 200   <- MINIMUM RETENU
# La documentation User ne mentionne pas que REST exige aussi « api » : constat de laboratoire.
/user/group/set ecsi-ro policy=read,rest-api,api
/user/group/print where name=ecsi-ro
/user/remove [find where comment="ecsi-lab: matrice"]
/user/group/remove [find where comment~"ecsi-lab: matrice"]
/user/print
