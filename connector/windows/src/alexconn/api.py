"""HTTP side of the app: sessions with the device token, pairing, heartbeat, update check."""

import hashlib
import logging
import socket
import threading
import time
import urllib.parse

import requests

from .version import VERSION

log = logging.getLogger("connector")


def computer_name():
    return socket.gethostname()


def _header_safe(value):
    # HTTP headers are latin-1; keep non-ASCII computer names readable on the server
    return value if value.isascii() else urllib.parse.quote(value)


class Contact:
    """Remembers when the server last answered (any HTTP answer below 500)."""

    def __init__(self):
        self.lock = threading.Lock()
        self.last_ok = None      # time.time() of the last answer
        self.first_fail = None   # start of the current run of failures

    def ok(self):
        with self.lock:
            self.last_ok = time.time()
            self.first_fail = None

    def failed(self):
        with self.lock:
            if self.first_fail is None:
                self.first_fail = time.time()

    def offline_for(self):
        """Seconds without any server answer (0 while it answers)."""
        with self.lock:
            return 0 if self.first_fail is None else time.time() - self.first_fail


CONTACT = Contact()


class TrackedSession(requests.Session):
    def request(self, *args, **kwargs):
        try:
            resp = super().request(*args, **kwargs)
        except requests.RequestException:
            CONTACT.failed()
            raise
        (CONTACT.ok if resp.status_code < 500 else CONTACT.failed)()
        return resp


def make_session(token):
    s = TrackedSession()
    s.headers["Authorization"] = "Bearer " + token
    s.headers["X-Connector-Version"] = VERSION
    s.headers["X-Computer-Name"] = _header_safe(computer_name())
    s.headers["User-Agent"] = f"AlexLink/{VERSION}"
    return s


class PairError(Exception):
    """Message is shown to the user (Hebrew)."""


def pair(server_url, code, timeout=30):
    """POST /ingest/pair (no Bearer). Returns the server's JSON."""
    try:
        r = requests.post(server_url.rstrip("/") + "/ingest/pair", timeout=timeout,
                          json={"code": code, "computer_name": computer_name(), "app_version": VERSION},
                          headers={"User-Agent": f"AlexLink/{VERSION}"})
    except requests.RequestException:
        raise PairError("אין חיבור לשרת. בדוק שהמחשב מחובר לרשת ונסה שוב.")
    if r.status_code == 404:
        raise PairError("הקוד לא נמצא או שפג תוקפו. צור קוד חדש באתר ונסה שוב.")
    if r.status_code != 200:
        raise PairError(f"השרת החזיר שגיאה ({r.status_code}). נסה שוב מאוחר יותר.")
    try:
        body = r.json()
    except ValueError:
        raise PairError("תשובה לא תקינה מהשרת.")
    if not body.get("token") or not body.get("outbox_sign_key"):
        raise PairError("תשובה לא תקינה מהשרת.")
    return body


def heartbeat(session, server_url, payload):
    r = session.post(server_url.rstrip("/") + "/ingest/heartbeat", json=payload, timeout=30)
    if r.status_code == 401:
        raise PermissionError("device token rejected")
    r.raise_for_status()
    return r.json() if r.content else {}


def version_tuple(v):
    parts = []
    for p in str(v).strip().lstrip("v").split("."):
        num = "".join(ch for ch in p if ch.isdigit())
        parts.append(int(num) if num else 0)
    return tuple((parts + [0, 0, 0])[:3])


def latest(session, server_url):
    r = session.get(server_url.rstrip("/") + "/ingest/connector/latest", timeout=30)
    if r.status_code == 404:
        return None
    r.raise_for_status()
    return r.json()


def download_url(server_url, download):
    """The installer may only come from the paired server itself."""
    url = urllib.parse.urljoin(server_url.rstrip("/") + "/", download)
    a, b = urllib.parse.urlsplit(server_url), urllib.parse.urlsplit(url)
    if (a.scheme, a.hostname, a.port) != (b.scheme, b.hostname, b.port):
        raise ValueError("update download is not on the paired server")
    return url


def download(session, url, target, expected_sha256, expected_size):
    h = hashlib.sha256()
    size = 0
    tmp = target.with_suffix(".part")
    with session.get(url, timeout=600, stream=True) as r:
        r.raise_for_status()
        with open(tmp, "wb") as fh:
            for chunk in r.iter_content(1 << 16):
                fh.write(chunk)
                h.update(chunk)
                size += len(chunk)
                if expected_size and size > expected_size:
                    break
    if h.hexdigest() != (expected_sha256 or "").lower() or (expected_size and size != expected_size):
        tmp.unlink(missing_ok=True)
        raise ValueError("update file does not match its sha256/size")
    tmp.replace(target)
    return target
