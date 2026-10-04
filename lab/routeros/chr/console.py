"""Console série d'un CHR du laboratoire (socket UNIX exposé par QEMU).

  python3 console.py <socket>                          : session interactive (Ctrl-] pour quitter)
  python3 console.py <socket> --run cmds.rsc [--login] : exécute un fichier ligne par ligne,
                                                         sortie horodatée (journal de preuve)
  python3 console.py <socket> --paste script.rsc [--login] : colle le fichier d'un bloc, comme
                                                         un administrateur dans le terminal

--login ouvre une session avec l'utilisateur LAB_USER (admin par défaut) et le mot de passe
lu dans le fichier LAB_PASSWORD_FILE ; le nom est suffixé de « +ct200w » (options de
connexion documentées : couleurs désactivées, détection du terminal désactivée, largeur 200)
pour une sortie lisible dans les journaux. Le mot de passe n'est jamais affiché.

Ce programme ne contient aucune commande RouterOS : il transmet le fichier qu'on lui donne.
"""

import argparse
import datetime
import os
import re
import socket
import sys
import time

import pexpect
import pexpect.fdpexpect

PROMPT = r"\[[^\]\r\n]+\] > "
ANSI = re.compile(r"\x1b\[[0-9;?]*[A-Za-z]")


class Masked:
    """Écrit la sortie de la console en masquant les secrets et les séquences ANSI.

    Un secret peut arriver coupé entre deux lectures : la fin du tampon (longueur du plus
    long secret moins un) est retenue jusqu'à la lecture suivante ou jusqu'à close().
    """

    def __init__(self, secrets: list[str]):
        self.secrets = [s for s in secrets if s]
        self.keep = max((len(s) for s in self.secrets), default=1) - 1
        self.buf = ""

    def _clean(self, data: str) -> str:
        for secret in self.secrets:
            data = data.replace(secret, "<masqué>")
        return data

    def write(self, data: str) -> None:
        self.buf = self._clean(self.buf + ANSI.sub("", data).replace("\r", ""))
        if len(self.buf) > self.keep:
            cut = len(self.buf) - self.keep
            sys.stdout.write(self.buf[:cut])
            self.buf = self.buf[cut:]

    def flush(self) -> None:
        sys.stdout.flush()

    def close(self) -> None:
        sys.stdout.write(self._clean(self.buf))
        self.buf = ""
        sys.stdout.flush()


def connect(path: str, timeout: int) -> pexpect.fdpexpect.fdspawn:
    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    sock.connect(path)
    child = pexpect.fdpexpect.fdspawn(sock.fileno(), encoding="utf-8", timeout=timeout)
    child._ecsi_sock = sock  # garde la socket ouverte
    return child


def login(child: pexpect.fdpexpect.fdspawn, user: str, password: str) -> None:
    # Ferme une éventuelle session ouverte (Ctrl-C puis Ctrl-D), puis se reconnecte.
    child.send("\x03")
    child.send("\x04")
    for _ in range(5):
        child.send("\r")
        if child.expect(["Login: ", PROMPT, pexpect.TIMEOUT], timeout=10) == 0:
            break
        child.send("\x04")
    child.send(f"{user}+ct200w\r")
    child.expect("Password: ")
    child.send(password + "\r")
    child.expect(PROMPT, timeout=60)
    sync(child)


def sync(child: pexpect.fdpexpect.fdspawn, timeout: int = -1) -> None:
    """Vide le tampon : affiche un marqueur unique (:put) et attend sa sortie puis l'invite."""
    marker = f"ECSI-SYNC-{os.getpid()}"
    child.send(f':put "{marker}"\r')
    child.expect(marker + r"[^\"]", timeout=timeout)  # la sortie, pas l'écho (suivi d'un guillemet)
    child.expect(PROMPT, timeout=timeout)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("socket")
    parser.add_argument("--run", help="fichier de commandes, une par ligne (# = commentaire)")
    parser.add_argument("--paste", help="fichier collé tel quel dans le terminal (bloc { ... })")
    parser.add_argument("--login", action="store_true")
    parser.add_argument("--timeout", type=int, default=120)
    args = parser.parse_args()
    child = connect(args.socket, args.timeout)
    if not args.run and not args.paste:
        print("Connecté. Ctrl-] pour quitter.", file=sys.stderr)
        child.interact()
        return 0
    password = ""
    if args.login:
        with open(os.environ["LAB_PASSWORD_FILE"], encoding="utf-8") as f:
            password = f.read().strip()
    child.logfile_read = Masked([password])
    if args.login:
        login(child, os.environ.get("LAB_USER", "admin"), password)
    else:
        sync(child)
    if args.paste:
        # Collage : lignes envoyées sans attendre d'écho (le terminal affiche une invite de
        # continuation à l'intérieur du bloc), puis marqueur de synchronisation.
        with open(args.paste, encoding="utf-8") as script:
            for line in script:
                child.send(line.rstrip("\n") + "\r")
                time.sleep(0.05)
        # Pendant l'exécution du bloc, la frappe est ignorée par le terminal : le marqueur
        # est renvoyé jusqu'à ce qu'il apparaisse (fin d'exécution du script).
        deadline = time.monotonic() + args.timeout
        while True:
            try:
                sync(child, timeout=20)
                break
            except pexpect.TIMEOUT:
                if time.monotonic() > deadline:
                    raise
        child.logfile_read.close()
        sys.stdout.write("\n")
        return 0
    with open(args.run, encoding="utf-8") as commands:
        for line in commands:
            line = line.rstrip("\n")
            if not line.strip() or line.lstrip().startswith("#"):
                continue
            stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%H:%M:%SZ")
            sys.stdout.write(f"\n### {stamp}\n")
            child.send(line + "\r")
            # L'écho de la commande d'abord, puis l'invite qui suit sa sortie.
            # (début de ligne seulement : la console replie les lignes longues)
            child.expect_exact(line[:40])
            child.expect(PROMPT)
    child.logfile_read.close()
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
