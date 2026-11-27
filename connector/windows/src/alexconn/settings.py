"""Where the app keeps things, and the DPAPI-encrypted secrets.

%APPDATA%\\AlexLink\\config.json   server URL, device id, site URL, sync settings
%APPDATA%\\AlexLink\\secret.bin    token + outbox signing key, DPAPI (CurrentUser)
%APPDATA%\\AlexLink\\PAUSE         pause everything (ingest and sending), as before
%APPDATA%\\AlexLink\\PAUSE_INGEST  pause mail ingest only (tray toggle)
%APPDATA%\\AlexLink\\PAUSE_SEND    pause sending only (tray toggle)
%LOCALAPPDATA%\\AlexLink\\data     sync state, locks
%LOCALAPPDATA%\\AlexLink\\logs     connector.log, 5 x 2 MB
"""

import json
import os
import re
from pathlib import Path

ROAMING = Path(os.environ.get("APPDATA") or Path.home() / "AppData" / "Roaming") / "AlexLink"
LOCAL = Path(os.environ.get("LOCALAPPDATA") or Path.home() / "AppData" / "Local") / "AlexLink"
CONFIG_PATH = ROAMING / "config.json"
SECRET_PATH = ROAMING / "secret.bin"
PAUSE_FILE = ROAMING / "PAUSE"
PAUSE_SEND_FILE = ROAMING / "PAUSE_SEND"
PAUSE_INGEST_FILE = ROAMING / "PAUSE_INGEST"
DATA_DIR = LOCAL / "data"
LOG_DIR = LOCAL / "logs"
UPDATE_DIR = LOCAL / "updates"

DEFAULTS = {
    "server_url": "",
    "device_id": "",
    "server_name": "",
    "site_url": "",
    "mail_since": "",
    "calendar_days_back": 30,
    "calendar_days_ahead": 180,
    "max_item_mb": 100,
    "http_timeout_sec": 120,
    "retries": 4,
    "mail_overlap_minutes": 120,
    "mail_interval_min": 10,
    "outbox_interval_sec": 60,
    "heartbeat_interval_min": 5,
    "auto_update": True,
}

DPAPI_DESCRIPTION = "Alex Link"


def ensure_dirs():
    for d in (ROAMING, DATA_DIR, LOG_DIR):
        d.mkdir(parents=True, exist_ok=True)


def _write_atomic(path, data):
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_bytes(data)
    os.replace(tmp, path)


def load_config():
    cfg = dict(DEFAULTS)
    if CONFIG_PATH.exists():
        cfg.update(json.loads(CONFIG_PATH.read_text(encoding="utf-8")))
    return cfg


def save_config(cfg):
    ensure_dirs()
    keep = {k: cfg[k] for k in cfg if k in DEFAULTS}
    _write_atomic(CONFIG_PATH, json.dumps(keep, ensure_ascii=False, indent=1).encode("utf-8"))


# ---------------------------------------------------------------- secrets (DPAPI)

def protect(data: bytes) -> bytes:
    import win32crypt
    return win32crypt.CryptProtectData(data, DPAPI_DESCRIPTION, None, None, None, 0)


def unprotect(blob: bytes) -> bytes:
    import win32crypt
    return win32crypt.CryptUnprotectData(blob, None, None, None, 0)[1]


def save_secret(token, outbox_sign_key):
    ensure_dirs()
    raw = json.dumps({"token": token, "outbox_sign_key": outbox_sign_key}).encode("utf-8")
    _write_atomic(SECRET_PATH, protect(raw))


def load_secret():
    """{'token', 'outbox_sign_key'} or None when not paired (or not readable by this user)."""
    if not SECRET_PATH.exists():
        return None
    try:
        return json.loads(unprotect(SECRET_PATH.read_bytes()).decode("utf-8"))
    except Exception:
        return None


def is_paired(cfg=None):
    cfg = cfg or load_config()
    s = load_secret()
    return bool(cfg.get("server_url") and s and s.get("token"))


# ---------------------------------------------------------------- pairing code

CODE_RE = re.compile(r"^alex://(?P<host>[A-Za-z0-9.\-]+|\[[0-9A-Fa-f:]+\])(?::(?P<port>\d{1,5}))?"
                     r"/(?P<code>[A-Za-z0-9]{4}-[A-Za-z0-9]{4})/?$")


def parse_code(text):
    """'alex://<host>:8130/XXXX-XXXX' -> ('http://<host>:8130', 'XXXX-XXXX'); ValueError if malformed."""
    m = CODE_RE.match((text or "").strip())
    if not m:
        raise ValueError("bad code")
    port = m.group("port") or "8130"
    return f"http://{m.group('host')}:{port}", m.group("code").upper()


def pause_state():
    """(ingest paused, sending paused)"""
    everything = PAUSE_FILE.exists()
    return everything or PAUSE_INGEST_FILE.exists(), everything or PAUSE_SEND_FILE.exists()


def set_pause(path, on):
    ensure_dirs()
    if on:
        path.write_text("paused from the tray menu\n", encoding="utf-8")
    else:
        path.unlink(missing_ok=True)
