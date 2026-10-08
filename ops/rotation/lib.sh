# shellcheck shell=sh
# ECSI CLOUD — fonctions communes des outils de secrets (Sprint S3H, étape H3).
# Chargé par check-env.sh et pg-role-password.sh. Règle absolue : aucune valeur secrète n'est
# jamais affichée, écrite dans un journal ni passée en argument d'un programme externe (les
# valeurs ne transitent que par des variables du shell, l'entrée standard et printf, commande
# interne du shell).

set -eu
umask 077

log() { printf '%s %s\n' "$(date -u +%H:%M:%SZ)" "$*" >&2; }
die() {
  log "ECHEC $*"
  exit 1
}

# Valeur d'une variable dans un fichier d'environnement Compose (dernière occurrence, comme
# Compose), sans jamais exécuter le fichier. Guillemets englobants retirés.
env_get() {
  sed -n "s/^$2=//p" "$1" | tail -n 1 | sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'\$/\1/"
}

# Nombre de lignes qui définissent la variable.
env_count() {
  grep -c "^$2=" "$1" || true
}

# Empreinte courte (KCV) d'une valeur : 16 caractères hexadécimaux de SHA-256, avec séparation
# de domaine. Ne révèle rien d'une valeur aléatoire de 128 bits ou plus ; sert à vérifier
# qu'une copie (coffre, autre fichier, conteneur) est identique sans afficher la valeur.
kcv() {
  printf 'ecsi-kcv-v1:%s' "$1" | sha256sum | cut -c1-16
}

# Mot de passe d'une URL schéma://utilisateur:motdepasse@hôte…
url_password() {
  printf '%s' "$1" | sed -n 's#^[a-z]*://[^:/@]*:\([^@]*\)@.*#\1#p'
}

# Nombre d'octets d'une valeur base64 (0 si invalide).
b64_len() {
  printf '%s' "$1" | base64 -d 2>/dev/null | wc -c | tr -d ' ' || printf 0
}
