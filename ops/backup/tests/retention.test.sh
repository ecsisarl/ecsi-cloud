#!/bin/sh
# Test de ops/backup/retention.sh (7 quotidiennes, 4 hebdomadaires, 3 mensuelles).
#   ops/backup/tests/retention.test.sh
set -eu
REPO=$(cd "$(dirname "$0")/../../.." && pwd)
D=$(mktemp -d)
trap 'rm -rf "$D"' EXIT

# Une sauvegarde par jour du 1er juin au 6 octobre 2026, plus une plus ancienne le 6 octobre.
day=2026-06-01
while [ "$day" != 2026-10-07 ]; do
  f=ecsi-$(date -u -d "$day" +%Y%m%d)T023000Z
  touch "$D/$f.tar.age" "$D/$f.tar.age.sha256" "$D/$f.info.json"
  day=$(date -u -d "$day + 1 day" +%Y-%m-%d)
done
touch "$D/ecsi-20261006T010000Z.tar.age" "$D/autre-fichier.txt"
total=$(find "$D" -name '*.tar.age' | wc -l)

"$REPO/ops/backup/retention.sh" "$D" --simulation >/dev/null
[ "$(find "$D" -name '*.tar.age' | wc -l)" = "$total" ] || { echo 'ECHEC : la simulation a supprimé'; exit 1; }

"$REPO/ops/backup/retention.sh" "$D" >/dev/null
expected='ecsi-20260831T023000Z.tar.age
ecsi-20260920T023000Z.tar.age
ecsi-20260927T023000Z.tar.age
ecsi-20260930T023000Z.tar.age
ecsi-20261001T023000Z.tar.age
ecsi-20261002T023000Z.tar.age
ecsi-20261003T023000Z.tar.age
ecsi-20261004T023000Z.tar.age
ecsi-20261005T023000Z.tar.age
ecsi-20261006T023000Z.tar.age'
actual=$(find "$D" -name '*.tar.age' -printf '%f\n' | sort)
if [ "$actual" != "$expected" ]; then
  echo 'ECHEC : sauvegardes conservées inattendues :'; echo "$actual"; exit 1
fi
# Fichiers associés supprimés avec leur sauvegarde ; fichiers étrangers intacts.
[ "$(find "$D" -name '*.sha256' | wc -l)" = 10 ] || { echo 'ECHEC : .sha256'; exit 1; }
[ "$(find "$D" -name '*.info.json' | wc -l)" = 10 ] || { echo 'ECHEC : .info.json'; exit 1; }
[ -f "$D/autre-fichier.txt" ] || { echo 'ECHEC : fichier étranger supprimé'; exit 1; }
echo "OK rétention : $total sauvegardes -> 10 conservées (7 jours, 4 semaines, 3 mois)"
