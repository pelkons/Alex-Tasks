"""The background loops: mail ingest, outbox, heartbeat + update check.

Each loop runs in its own thread; the mail and outbox loops each initialise COM
for themselves (inside outlook_connector.run / outbox_sender.run). Outlook is never
started by the app: both runs check that OUTLOOK.EXE is already running.
"""

import datetime as dt
import logging
import threading
import time

from . import api, settings
from . import outbox_sender as ob
from . import outlook_connector as oc
from .version import APP_NAME, VERSION

log = logging.getLogger("connector")

OFFLINE_RED_SEC = 30 * 60
UPDATE_EVERY_SEC = 24 * 3600


STANDBY = "standby"
ACTIVE = "active"


def fmt_seen(iso):
    """'2026-11-27T10:05:00Z' -> '27.11 12:05' in local time; '' if missing or unreadable."""
    if not iso:
        return ""
    try:
        t = dt.datetime.fromisoformat(str(iso).replace("Z", "+00:00"))
        if t.tzinfo is None:
            t = t.replace(tzinfo=dt.timezone.utc)
        return t.astimezone(oc.LOCAL_TZ).strftime("%d.%m %H:%M")  # no line break inside
    except (ValueError, TypeError, OverflowError):
        return ""


def norm_role(role):
    """The server's role; a missing one (older server) means this computer works."""
    return STANDBY if role == STANDBY else ACTIVE


class Engine:
    def __init__(self, on_change=None):
        self.on_change = on_change or (lambda **kw: None)
        self.toasts = []                         # (title, text) for the UI thread to show
        self.role = ""                           # "" until the server has said
        self.stop = threading.Event()
        self.mail_wake = threading.Event()
        self.outbox_wake = threading.Event()
        self.heartbeat_wake = threading.Event()
        self.send_guard = threading.Lock()      # held while an outbox run may call Send()
        self.lock = threading.Lock()
        self.last_sync_at = None                 # last successful mail run
        self.last_error = None                   # (time, text) of the last failure
        self.outlook_ok = None
        self.syncing = False
        self.update_pending = None               # path of a verified installer to run
        self.token_rejected = False
        self.threads = []
        self.reload()

    # ---------------------------------------------------------------- config

    def reload(self):
        """(Re)reads config + secret; called at start and after pairing."""
        cfg = settings.load_config()
        if cfg.get("server_url") and not cfg.get("mail_since"):
            cfg["mail_since"] = default_mail_since()  # fixed once, so it never slides forward
            settings.save_config(cfg)
        secret = settings.load_secret() or {}
        with self.lock:
            self.cfg = cfg
            self.token = secret.get("token")
            self.sign_key = secret.get("outbox_sign_key")
            self.token_rejected = False
            self.role = cfg.get("role") or ""

    def standby(self):
        return self.role == STANDBY

    def active_name(self):
        return self.cfg.get("active_device_name") or ""

    def active_seen(self):
        return fmt_seen(self.cfg.get("active_device_seen"))

    # ---------------------------------------------------------------- role

    def toast(self, text, title=None):
        with self.lock:
            self.toasts.append((title or APP_NAME, text))
        self.on_change()

    def take_toasts(self):
        with self.lock:
            out, self.toasts = self.toasts, []
        return out

    def apply_role(self, role, active_device=None, announce=True):
        """Takes the role the server reported (pair / heartbeat / activate answer)."""
        role = norm_role(role)
        dev = active_device if isinstance(active_device, dict) else {}
        with self.lock:
            old = self.role
            self.role = role
            cfg = self.cfg
            changed = old != role
            new_name = str(dev.get("name") or "") if dev else cfg.get("active_device_name", "")
            new_seen = str(dev.get("last_contact_at") or "") if dev else cfg.get("active_device_seen", "")
            if role == ACTIVE:
                new_name, new_seen = "", ""
            dirty = changed or (new_name, new_seen) != (cfg.get("active_device_name"),
                                                        cfg.get("active_device_seen"))
            cfg["role"] = role
            cfg["active_device_name"] = new_name
            cfg["active_device_seen"] = new_seen
        if dirty:
            oc.safe(lambda: settings.save_config(cfg))
        if changed:
            log.info("role: %s -> %s%s", old or "unknown", role,
                     f" (active computer: {new_name})" if role == STANDBY and new_name else "")
            if role == STANDBY:
                # the mail/outbox loops check the role before each run and between
                # outbox items, so nothing stops in the middle of a send
                if announce:
                    self.toast(f"Alex Link עבר למחשב {new_name}" if new_name
                               else "Alex Link עבר למחשב אחר")
            else:
                if announce and old == STANDBY:
                    self.toast("Alex Link פעיל עכשיו במחשב הזה")
                self.sync_now()  # start right away; the server's /ingest/status says where to resume
        self.on_change()

    def activate(self):
        """Make this computer the active one. Blocking: call from a worker thread."""
        try:
            body = api.activate(api.make_session(self.token), self.cfg["server_url"])
        except PermissionError:
            self.token_rejected = True
            self.toast("החיבור בוטל בשרת — יש לחבר מחדש")
            return False
        except Exception as e:
            log.warning("activate failed: %s", str(e)[:200])
            self.toast("לא הצלחתי להעביר את העבודה למחשב הזה. נסה שוב מאוחר יותר.")
            return False
        log.info("activated this computer")
        self.apply_role(body.get("role") or ACTIVE, body.get("active_device"))
        self.heartbeat_wake.set()
        return self.role == ACTIVE

    def activate_async(self):
        threading.Thread(target=self.activate, name="activate", daemon=True).start()

    def _on_standby_seen(self):
        """The server answered "standby" to a mail push or the outbox: ask it for the role now."""
        if not self.standby():
            self.heartbeat_wake.set()

    def paired(self):
        return bool(self.cfg.get("server_url") and self.token)

    def run_cfg(self):
        """The config dict the reused outlook_connector / outbox_sender code expects."""
        c = self.cfg
        token = self.token
        return {
            "server_url": c["server_url"],
            "make_session": lambda: api.make_session(token),
            "outbox_key": self.sign_key,
            "data_dir": settings.DATA_DIR,
            "pause_file": settings.PAUSE_FILE,
            "pause_send_file": settings.PAUSE_SEND_FILE,
            "mail_since": c["mail_since"] or default_mail_since(),
            "calendar_days_back": c["calendar_days_back"],
            "calendar_days_ahead": c["calendar_days_ahead"],
            "max_item_mb": c["max_item_mb"],
            "http_timeout_sec": c["http_timeout_sec"],
            "retries": c["retries"],
            "mail_overlap_minutes": c["mail_overlap_minutes"],
            "should_stop": lambda: self.standby() or self.stop.is_set(),
            "on_standby": self._on_standby_seen,
        }

    # ---------------------------------------------------------------- status

    def error(self, text):
        text = str(text).replace("\n", " ")[:300]
        with self.lock:
            self.last_error = (dt.datetime.now(oc.LOCAL_TZ), text)
        self.on_change()

    def status(self):
        """(colour, Hebrew status line) — colour is green / yellow / red / grey / blue (standby)."""
        if not self.paired():
            return "grey", "לא מחובר לשרת"
        if self.token_rejected:
            return "red", "החיבור בוטל בשרת — יש לחבר מחדש"
        if api.CONTACT.offline_for() > OFFLINE_RED_SEC:
            return "red", "אין חיבור לשרת"
        if self.standby():
            name = self.active_name()
            return "blue", f"במצב המתנה — פעיל ב-{name}" if name else "במצב המתנה"
        if self.outlook_ok is False:
            return "yellow", "Outlook סגור"
        p_in, p_out = settings.pause_state()
        if p_in and p_out:
            return "yellow", "מושהה"
        if p_in:
            return "yellow", "מושהה — קליטת מיילים"
        if p_out:
            return "yellow", "מושהה — שליחת מיילים"
        return "green", "מחובר"

    # ---------------------------------------------------------------- loops

    def start(self):
        for target, name in ((self._mail_loop, "mail"), (self._outbox_loop, "outbox"),
                             (self._heartbeat_loop, "heartbeat")):
            t = threading.Thread(target=target, name=name, daemon=True)
            t.start()
            self.threads.append(t)

    def sync_now(self, heartbeat=False):
        self.mail_wake.set()
        self.outbox_wake.set()
        if heartbeat or self.stop.is_set():
            self.heartbeat_wake.set()

    def _wait(self, event, seconds):
        event.wait(seconds)
        event.clear()
        return not self.stop.is_set()

    def _check_outlook(self):
        ok = oc.outlook_running()
        if ok != self.outlook_ok:
            self.outlook_ok = ok
            log.info("Outlook is %s", "running" if ok else "not running; waiting")
            self.on_change()
        return ok

    def _mail_loop(self):
        time.sleep(5)  # let the tray come up first
        while not self.stop.is_set():
            if self.paired() and not self.token_rejected and not self.standby() \
                    and not settings.pause_state()[0] and self._check_outlook():
                self.syncing = True
                self.on_change()
                try:
                    oc.run(self.run_cfg(), dry_run=False)
                    with self.lock:
                        self.last_sync_at = dt.datetime.now(oc.LOCAL_TZ)
                except Exception as e:
                    if is_standby_error(e):
                        log.info("mail sync: the server says this computer is in standby")
                        self._on_standby_seen()
                    else:
                        log.exception("mail sync failed")
                        self._note_auth(e)
                        self.error(f"סנכרון מיילים: {e}")
                finally:
                    self.syncing = False
                    self.on_change()
            if not self._wait(self.mail_wake, self.cfg["mail_interval_min"] * 60):
                break

    def _outbox_loop(self):
        time.sleep(10)
        while not self.stop.is_set():
            if self.paired() and not self.token_rejected and not self.standby() \
                    and not settings.pause_state()[1] and self.update_pending is None:
                with self.send_guard:
                    try:
                        ob.run(self.run_cfg(), no_send=False)
                    except Exception as e:
                        log.exception("outbox run failed")
                        self._note_auth(e)
                        self.error(f"שליחת מיילים: {e}")
            if not self._wait(self.outbox_wake, self.cfg["outbox_interval_sec"]):
                break

    def _note_auth(self, e):
        if "401" in str(e):
            self.token_rejected = True
            self.on_change()

    def _heartbeat_loop(self):
        time.sleep(3)
        next_update = 0  # check for updates right after start, then daily
        while not self.stop.is_set():
            if self.paired():
                self._oc_poll_outlook()
                self._heartbeat()
                if self.cfg.get("auto_update", True) and time.time() >= next_update:
                    next_update = time.time() + UPDATE_EVERY_SEC
                    self._check_update()
            if not self._wait(self.heartbeat_wake, self.cfg["heartbeat_interval_min"] * 60):
                break

    def _oc_poll_outlook(self):
        oc.safe(self._check_outlook)

    def _heartbeat(self):
        p_in, p_out = settings.pause_state()
        err = self.last_error
        payload = {
            "app_version": VERSION,
            "computer_name": api.computer_name(),
            "outlook_ok": bool(self.outlook_ok),
            "paused_ingest": p_in,
            "paused_send": p_out,
            "last_sync_at": oc.iso(self.last_sync_at),
            "last_error": f"{oc.iso(err[0])} {err[1]}" if err else None,
        }
        try:
            body = api.heartbeat(api.make_session(self.token), self.cfg["server_url"], payload)
        except PermissionError:
            log.error("heartbeat: the server rejected the device token")
            self.token_rejected = True
        except Exception as e:
            log.warning("heartbeat failed: %s", str(e)[:200])
        else:
            if isinstance(body, dict):
                self.apply_role(body.get("role"), body.get("active_device"))
        self.on_change()

    # ---------------------------------------------------------------- update

    def _check_update(self):
        from . import updater
        try:
            path = updater.fetch_if_newer(api.make_session(self.token), self.cfg["server_url"])
        except Exception as e:
            log.warning("update check failed: %s", str(e)[:200])
            return
        if not path:
            return
        self.update_pending = path   # no new outbox runs from now on
        with self.send_guard:        # wait for a running send to finish
            log.info("starting the update installer %s", path.name)
            updater.run_installer(path)
            self.stop.set()
            self.on_change(quit_app=True)


def is_standby_error(e):
    """A mail/calendar push the server refused with 409 {"error": "standby"}."""
    text = str(e)
    return "409" in text and "standby" in text


def default_mail_since():
    """On a new PC: mail from the last day; the server's last_item_at wins when it has one."""
    return (dt.datetime.now() - dt.timedelta(days=1)).replace(microsecond=0).isoformat()
