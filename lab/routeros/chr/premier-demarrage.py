"""Premier démarrage d'un CHR neuf : connexion admin sans mot de passe (état d'usine de
l'image officielle), refus de l'affichage de la licence, puis changement de mot de passe
imposé par RouterOS. Le nouveau mot de passe est lu dans un fichier (jamais affiché).

  python3 premier-demarrage.py <socket> <fichier-mot-de-passe>
"""

import socket
import sys

import pexpect
import pexpect.fdpexpect

from console import PROMPT, Masked, sync


def main() -> int:
    path, password_file = sys.argv[1], sys.argv[2]
    password = open(password_file, encoding="utf-8").read().strip()
    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    sock.connect(path)
    child = pexpect.fdpexpect.fdspawn(sock.fileno(), encoding="utf-8", timeout=600)
    child.logfile_read = Masked([password])
    # Attente du démarrage (émulation sans KVM : plusieurs minutes possibles).
    while True:
        child.send("\r")
        if child.expect(["Login: ", pexpect.TIMEOUT], timeout=15) == 0:
            break
    child.send("admin+ct200w\r")
    child.expect("Password: ")
    child.send("\r")
    # Le terminal peut réafficher l'invite « new password> » : on attend chaque invite une
    # seule fois et on n'envoie le mot de passe que deux fois (saisie + confirmation).
    if child.expect([r"\[Y/n\]", r"(?i)new password> "], timeout=120) == 0:
        child.send("n")
        child.expect(r"(?i)new password> ", timeout=120)
    child.send(password + "\r")
    child.expect(r"(?i)repeat new password> ", timeout=120)
    child.send(password + "\r")
    child.expect("Password changed", timeout=120)
    child.expect(PROMPT)
    sync(child)
    child.logfile_read.close()
    print()
    return 0


if __name__ == "__main__":
    sys.exit(main())
