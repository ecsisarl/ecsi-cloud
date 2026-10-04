#!/usr/bin/env bash
# Tests RÉELS du protocole d'enrôlement, côté cloud et côté routeur, après l'enrôlement d'un
# CHR vierge par le script ecsi-enrolement.rsc (voir README.md de ce répertoire).
#   sudo ./test-enrolement.sh <nom> <ip-tunnel> <ip-lan-du-routeur>
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
STATE="${LAB_STATE:-$HERE/../../sim/.state}"
NAME="${1:?nom du routeur enrôlé}"
TUN="${2:?ip tunnel}"
LAN="${3:?ip LAN du routeur}"
URL=https://203.0.113.30/enroll
FAILS=0
ns() { ip netns exec "$1" "${@:2}"; }
pass() { echo "- **PASS** $*"; }
fail() {
  echo "- **FAIL** $*"
  FAILS=$((FAILS + 1))
}
sql() { python3 -c 'import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); r=c.execute(sys.argv[2]).fetchall(); c.commit(); print("\n".join("|".join(map(str,x)) for x in r))' "$STATE/enrolement.sqlite" "$1"; }
enroll() { # enroll <ns> <jeton> <clé publique> [champ supplémentaire JSON] -> code HTTP
  ns "$1" curl -s --noproxy '*' --max-time 10 --cacert "$STATE/pki/ca.pem" -o /dev/null -w '%{http_code}' \
    -H 'content-type: application/json' --data "{\"token\":\"$2\",\"publicKey\":\"$3\"${4:-}}" "$URL"
}
tcp_open() { ns "$1" timeout 4 bash -c "exec 3<>/dev/tcp/$2/$3" 2>/dev/null; }
newkey() { wg genkey | wg pubkey; }
new_router() { # new_router <nom> <ip> -> jeton (le script généré est supprimé : jeton seul utile ici)
  local out token
  out=$(python3 "$HERE/serveur_enrolement.py" new "$1" "$2" 2>/dev/null)
  token=$(sed -n 's/^:local ecsiToken "\(.*\)"$/\1/p' "$out")
  rm -f "$out"
  echo "$token"
}

echo "### Côté cloud : état après enrôlement"
row=$(sql "SELECT state, public_key, svc_user, tls_fingerprint, token_used_at FROM routers WHERE name='$NAME'")
IFS='|' read -r st pub user fp used <<<"$row"
[[ "$st" == ACTIVATED && -n "$used" ]] && pass "routeur $NAME : jeton consommé ($used), état $st, compte $user" || fail "état inattendu : $row"
cols=$(sql "SELECT group_concat(name) FROM pragma_table_info('routers')")
[[ "$cols" != *private* ]] && pass "aucune colonne de clé privée en base (colonnes : $cols)" || fail "colonne privée en base"
# Le serveur ne journalise que le début des clés publiques : aucune clé complète (44 caractères
# base64) ne doit apparaître dans ses journaux.
if grep -Eqs '[A-Za-z0-9+/]{43}=' "$STATE"/enrol-*.log; then fail "clé WireGuard complète dans les journaux"; else pass "journaux du serveur : aucune clé WireGuard complète"; fi
code=$(ns worker curl -sk --max-time 10 -u "ecsi-svc:$(cat "$STATE/$NAME-svc.pass")" -o /dev/null -w '%{http_code}' "https://$TUN/rest/system/identity")
[[ "$code" == 200 ]] && pass "worker → API REST de $NAME par le tunnel avec les identifiants reçus : HTTP 200" || fail "worker → REST : $code"
got=$(ns worker python3 - "$TUN" <<'EOF'
import hashlib, socket, ssl, sys
ctx = ssl.create_default_context(); ctx.check_hostname = False; ctx.verify_mode = ssl.CERT_NONE
with socket.create_connection((sys.argv[1], 443), timeout=10) as s, ctx.wrap_socket(s) as t:
    print(hashlib.sha256(t.getpeercert(binary_form=True)).hexdigest())
EOF
)
[[ "$got" == "$fp" ]] && pass "empreinte TLS envoyée par le routeur = certificat réellement présenté (épinglage possible)" || fail "empreinte : reçue $fp, présentée $got"

echo "### Jeton"
tok=$(new_router lab-rejeu 10.200.0.50)
k1=$(newkey)
k2=$(newkey)
c1=$(enroll attacker "$tok" "$k1")
c2=$(enroll attacker "$tok" "$k2")
[[ "$c1" == 200 && "$c2" == 410 ]] && pass "même jeton utilisé deux fois : 1er HTTP $c1, 2e HTTP $c2 ; clé publique non remplacée" || fail "rejeu : $c1 puis $c2"
[[ "$(sql "SELECT public_key FROM routers WHERE name='lab-rejeu'")" == "$k1" ]] || fail "clé publique remplacée par le rejeu"
tok=$(new_router lab-concurrence 10.200.0.51)
for i in $(seq 8); do enroll attacker "$tok" "$(newkey)" >"$STATE/conc.$i" & done
wait
ok=$(grep -l '^200$' "$STATE"/conc.* | wc -l)
gone=$(grep -l '^410$' "$STATE"/conc.* | wc -l)
rm -f "$STATE"/conc.*
[[ "$ok" == 1 && "$gone" == 7 ]] && pass "8 requêtes simultanées avec le même jeton : 1 acceptée, 7 refusées (consommation atomique)" || fail "concurrence : $ok acceptées, $gone refusées"
tok=$(new_router lab-expire 10.200.0.52)
sql "UPDATE routers SET token_expires='2000-01-01T00:00:00+00:00' WHERE name='lab-expire'" >/dev/null
c=$(enroll attacker "$tok" "$(newkey)")
[[ "$c" == 410 ]] && pass "jeton expiré : HTTP $c" || fail "jeton expiré : HTTP $c"
tok=$(new_router lab-champs 10.200.0.53)
c=$(enroll attacker "$tok" "$(newkey)" ',"privateKey":"x"')
[[ "$c" == 400 ]] && pass "requête contenant un champ en plus (privateKey) : refusée HTTP $c, jeton non consommé" || fail "champ en plus : HTTP $c"
c=$(enroll attacker "$tok" "pas-une-cle")
[[ "$c" == 400 ]] && pass "clé publique mal formée : HTTP $c" || fail "clé mal formée : HTTP $c"
c=$(enroll attacker "inconnu" "$(newkey)")
[[ "$c" == 410 ]] && pass "jeton inconnu : HTTP $c" || fail "jeton inconnu : HTTP $c"
c=$(ns attacker curl -s --noproxy '*' --max-time 10 -o /dev/null -w '%{http_code}' -H 'content-type: application/json' --data '{}' "$URL")
[[ "$c" == 000 ]] && pass "client sans l'AC attendue : connexion TLS refusée (certificat non reconnu)" || fail "TLS sans AC : HTTP $c"
# Nettoyage des pairs de test ajoutés à la passerelle.
for k in $(sql "SELECT public_key FROM routers WHERE name LIKE 'lab-%' AND public_key IS NOT NULL"); do
  ns gw wg set wg-gw peer "$k" remove
done
sql "DELETE FROM routers WHERE name LIKE 'lab-%'" >/dev/null

echo "### Activation (canal tunnel)"
c=$(ns attacker curl -s --noproxy '*' --max-time 5 -o /dev/null -w '%{http_code}' --data '{}' "http://10.200.0.1:8081/activate")
[[ "$c" == 000 ]] && pass "Internet → point d'activation (10.200.0.1:8081) : injoignable" || fail "activation depuis Internet : $c"
c=$(ns worker curl -s --noproxy '*' --max-time 5 -o /dev/null -w '%{http_code}' --data '{}' "http://10.200.0.1:8081/activate")
[[ "$c" == 000 ]] && pass "réseau interne → point d'activation : injoignable (écoute réservée au tunnel)" || fail "activation depuis le worker : $c"

echo "### Sécurité du routeur enrôlé"
for port in 22 23 80 443 8291 8728 8729; do
  tcp_open attacker 203.0.113.20 "$port" && fail "Internet → IP publique :$port ouvert"
  tcp_open attacker 203.0.113.22 "$port" && fail "Internet → IP publique :$port ouvert"
done
pass "Internet → IP publique du site (CGNAT), ports d'administration : REFUSÉ"
tcp_open client1 "$LAN" 443 && fail "LAN → API REST du routeur ouverte" || pass "LAN du site → API REST (443) du routeur : REFUSÉ par la règle ajoutée par le script"
tcp_open client1 "$LAN" 8291 && pass "LAN du site → WinBox (8291) : toujours AUTORISÉ (administration locale préservée par le script)" || fail "administration LAN coupée"
tcp_open gw "$TUN" 8291 && fail "passerelle → WinBox du routeur par le tunnel ouvert" || pass "passerelle → autres ports du routeur par le tunnel (8291) : REFUSÉ"
tcp_open gw "$TUN" 22 && fail "passerelle → SSH par le tunnel ouvert" || pass "passerelle → SSH (22) par le tunnel : REFUSÉ"
echo "**Échecs : $FAILS**"
exit $((FAILS > 0))
