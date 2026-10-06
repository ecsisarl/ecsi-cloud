#!/bin/sh
# ECSI CLOUD — rétention des sauvegardes (Sprint S3H, étape H1).
#
#   ops/backup/retention.sh <dossier> [--simulation]
#
# Conserve, parmi les fichiers ecsi-AAAAMMJJTHHMMSSZ.tar.age du dossier :
#   - la plus récente de chacun des 7 derniers jours ayant une sauvegarde ;
#   - la plus récente de chacune des 4 dernières semaines ISO ;
#   - la plus récente de chacun des 3 derniers mois.
# Les autres sont supprimées avec leurs fichiers .sha256 et .info.json. Appelé par
# pg-backup.sh seulement après une sauvegarde vérifiée : un échec ne supprime jamais rien.
set -eu

dir=${1:?Usage : retention.sh <dossier> [--simulation]}
dry=${2:-}
KEEP_DAILY=${KEEP_DAILY:-7}
KEEP_WEEKLY=${KEEP_WEEKLY:-4}
KEEP_MONTHLY=${KEEP_MONTHLY:-3}

list=$(find "$dir" -maxdepth 1 -type f -name 'ecsi-????????T??????Z.tar.age' -printf '%f\n' | sort -r)
[ -n "$list" ] || exit 0

# Pour chaque fichier (du plus récent au plus ancien) : jour, semaine ISO, mois.
keep=$(printf '%s\n' "$list" | while read -r f; do
  ts=${f#ecsi-}
  ts=${ts%.tar.age}
  d=$(printf '%s' "$ts" | cut -c1-8)
  printf '%s %s %s %s\n' "$f" "$d" "$(date -u -d "$d" +%G-W%V)" "$(printf '%s' "$d" | cut -c1-6)"
done | awk -v kd="$KEEP_DAILY" -v kw="$KEEP_WEEKLY" -v km="$KEEP_MONTHLY" '
  !($2 in day)   { day[$2] = 1;   if (++nd <= kd) keep[$1] = 1 }
  !($3 in week)  { week[$3] = 1;  if (++nw <= kw) keep[$1] = 1 }
  !($4 in month) { month[$4] = 1; if (++nm <= km) keep[$1] = 1 }
  END { for (f in keep) print f }')

printf '%s\n' "$list" | while read -r f; do
  if printf '%s\n' "$keep" | grep -qxF "$f"; then
    echo "conservée : $f"
  elif [ "$dry" = --simulation ]; then
    echo "à supprimer : $f"
  else
    rm -f "$dir/$f" "$dir/$f.sha256" "$dir/${f%.tar.age}.info.json"
    echo "supprimée : $f"
  fi
done
