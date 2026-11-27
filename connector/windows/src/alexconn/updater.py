"""Auto-update: GET /ingest/connector/latest; if newer AND signed with the owner's
offline key, download from the same server, check sha256 + size, then run the
installer silently. The installer waits for this app to exit (AppMutex) and starts
the new version afterwards. Without a valid signature nothing is downloaded."""

import base64
import logging
import subprocess

from . import api, ed25519, settings
from .version import UPDATE_PUBLIC_KEY, UPDATE_SIG_PREFIX, VERSION

log = logging.getLogger("connector")


def signature_ok(version, sha256, signature_b64, public_hex=UPDATE_PUBLIC_KEY):
    try:
        sig = base64.b64decode(signature_b64 or "", validate=True)
        msg = f"{UPDATE_SIG_PREFIX}|{version}|{str(sha256).lower()}".encode("utf-8")
        return ed25519.verify(bytes.fromhex(public_hex), msg, sig)
    except (ValueError, TypeError):
        return False


_warned = set()


def fetch_if_newer(session, server_url):
    info = api.latest(session, server_url)
    if not info or not info.get("version"):
        return None
    if api.version_tuple(info["version"]) <= api.version_tuple(VERSION):
        return None
    if not info.get("sha256") or not info.get("download"):
        raise ValueError("update info without sha256/download")
    version = str(info["version"])
    if not signature_ok(version, info["sha256"], info.get("signature")):
        if version not in _warned:
            _warned.add(version)
            log.warning("update %s offered without a valid signature; ignored", version)
        return None
    url = api.download_url(server_url, info["download"])
    settings.UPDATE_DIR.mkdir(parents=True, exist_ok=True)
    safe_ver = "".join(ch for ch in version if ch.isalnum() or ch in ".-")
    target = settings.UPDATE_DIR / f"AlexLink-Setup-{safe_ver}.exe"
    log.info("update %s -> %s available (signed), downloading", VERSION, safe_ver)
    api.download(session, url, target, info["sha256"], info.get("size"))
    for old in settings.UPDATE_DIR.glob("AlexLink-Setup-*.exe"):
        if old != target:
            old.unlink(missing_ok=True)
    return target


def run_installer(path):
    subprocess.Popen([str(path), "/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART"],
                     creationflags=subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP,
                     close_fds=True)
