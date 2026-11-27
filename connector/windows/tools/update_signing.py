"""Offline key for signing Alex Link installers (the app refuses unsigned updates).

  python tools\\update_signing.py newkey KEYFILE         create a key; prints the public key
  python tools\\update_signing.py pubkey KEYFILE         print the public key again
  python tools\\update_signing.py sign KEYFILE SETUP.exe VERSION
                                                        writes SETUP.exe.sig (base64)

The key file must never go to the server or into the repository. The public key
(hex) goes into src/alexconn/version.py as UPDATE_PUBLIC_KEY.
Signed message: "alexlink-update-v1|<version>|<sha256 of the installer>".
"""
import base64
import hashlib
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from alexconn import ed25519  # noqa: E402

PREFIX = "alexlink-update-v1"


def message(version, sha256):
    return f"{PREFIX}|{version}|{sha256.lower()}".encode("utf-8")


def read_key(path):
    return bytes.fromhex(Path(path).read_text(encoding="ascii").strip())


def main(argv):
    cmd, keyfile = argv[0], Path(argv[1])
    if cmd == "newkey":
        if keyfile.exists():
            sys.exit(f"{keyfile} already exists")
        keyfile.parent.mkdir(parents=True, exist_ok=True)
        keyfile.write_text(os.urandom(32).hex(), encoding="ascii")
        print(ed25519.public_key(read_key(keyfile)).hex())
    elif cmd == "pubkey":
        print(ed25519.public_key(read_key(keyfile)).hex())
    elif cmd == "sign":
        setup, version = Path(argv[2]), argv[3]
        digest = hashlib.sha256(setup.read_bytes()).hexdigest()
        sig = ed25519.sign(read_key(keyfile), message(version, digest))
        out = setup.with_name(setup.name + ".sig")
        out.write_text(base64.b64encode(sig).decode("ascii"), encoding="ascii")
        print(f"{out.name}: version {version}, sha256 {digest}")
    else:
        sys.exit(__doc__)


if __name__ == "__main__":
    main(sys.argv[1:])
