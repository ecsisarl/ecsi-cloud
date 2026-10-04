# Constat (essai 1) : avec la seule politique rest-api, toute lecture REST répond
# 500 « std failure: not allowed (9) ». Essai 2 : read + rest-api.
/user/group/set ecsi-ro policy=read,rest-api
/user/group/print where name=ecsi-ro
