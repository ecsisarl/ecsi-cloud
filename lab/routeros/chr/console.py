"""Console série d'un CHR du laboratoire (socket UNIX exposé par QEMU).

  python3 console.py <socket>                      : session interactive (Ctrl-] pour quitter)
  python3 console.py <socket> --run commandes.rsc  : exécute un fichier ligne par ligne et
                                                     affiche la sortie (journal de preuve)

Ne contient aucune commande RouterOS : il transmet ce qu'on lui donne. L'invite attendue
est détectée par l'expression régulière PROMPT (« ] > » en fin de ligne), à ajuster si la
version testée affiche une invite différente.
"""

import argparse
import sys

import pexpect
import pexpect.fdpexpect
import socket

PROMPT = r"\] > $"


def connect(path: str) -> pexpect.fdpexpect.fdspawn:
    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    sock.connect(path)
    child = pexpect.fdpexpect.fdspawn(sock.fileno(), encoding="utf-8", timeout=60)
    child._sock = sock  # garde la socket ouverte
    return child


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("socket")
    parser.add_argument("--run", help="fichier de commandes, une par ligne (# = commentaire)")
    parser.add_argument("--timeout", type=int, default=60)
    args = parser.parse_args()
    child = connect(args.socket)
    if not args.run:
        print("Connecté. Ctrl-] pour quitter.", file=sys.stderr)
        child.interact()
        return 0
    child.logfile_read = sys.stdout
    child.sendline("")
    child.expect(PROMPT, timeout=args.timeout)
    with open(args.run, encoding="utf-8") as commands:
        for line in commands:
            line = line.rstrip("\n")
            if not line.strip() or line.lstrip().startswith("#"):
                continue
            child.sendline(line)
            child.expect(PROMPT, timeout=args.timeout)
    print()
    return 0


if __name__ == "__main__":
    sys.exit(main())
