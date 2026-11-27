"""Outlook -> Alex server connector (read-only).

Reads new mail (Inbox with subfolders, Sent Items) and calendar changes from
the running classic Outlook through COM and posts them to the server.
Never changes anything in Outlook.

In the Windows app (alexconn.app) run() is called from the mail loop with a config
built by the app; the command line below still works for the plain-script setup.

Usage:
    python outlook_connector.py --once            one sync run
    python outlook_connector.py --once --dry-run  write to data/dry-run instead of POST
"""

import argparse
import datetime as dt
import json
import logging
import logging.handlers
import os
import subprocess
import sys
import tempfile
import time
import uuid
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent
CONFIG_PATH = BASE_DIR / "config.json"
PAUSE_FILE = BASE_DIR / "PAUSE"

OL_FOLDER_INBOX = 6
OL_FOLDER_SENT = 5
OL_FOLDER_CALENDAR = 9
OL_MSG = 9  # olMSGUnicode; olMSG (3) is ANSI and turns Hebrew names into "?"
OL_MAIL_CLASS = 43
OL_APPOINTMENT_CLASS = 26
PR_INTERNET_MESSAGE_ID = "http://schemas.microsoft.com/mapi/proptag/0x1035001F"
PR_SMTP_ADDRESS = "http://schemas.microsoft.com/mapi/proptag/0x39FE001F"

LOCAL_TZ = dt.datetime.now().astimezone().tzinfo
log = logging.getLogger("connector")


# ---------------------------------------------------------------- config/state

DEFAULT_CONFIG = {
    "server_url": "",
    "token_file": "%USERPROFILE%\\.alex-connector\\token",
    "data_dir": "data",
    "mail_since": "2026-11-26T00:00:00",
    "calendar_days_back": 30,
    "calendar_days_ahead": 180,
    "max_item_mb": 100,
    "http_timeout_sec": 120,
    "retries": 4,
    "mail_overlap_minutes": 120,
}


def load_config(path=None):
    path = Path(path) if path else CONFIG_PATH
    cfg = dict(DEFAULT_CONFIG)
    if path.exists():
        cfg.update(json.loads(path.read_text(encoding="utf-8")))
    data_dir = Path(os.path.expandvars(cfg["data_dir"]))
    if not data_dir.is_absolute():
        data_dir = BASE_DIR / data_dir
    cfg["data_dir"] = data_dir
    token_file = Path(os.path.expandvars(cfg["token_file"]))
    cfg["token_file"] = token_file if token_file.is_absolute() else BASE_DIR / token_file
    return cfg


def load_state(path):
    if path.exists():
        return json.loads(path.read_text(encoding="utf-8"))
    return {"mail": {}, "calendar": {}}


def save_state(path, state):
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(state, ensure_ascii=False, indent=1), encoding="utf-8")
    os.replace(tmp, path)


def setup_logging(data_dir, verbose, filename="connector.log"):
    log_dir = data_dir / "logs"
    log_dir.mkdir(parents=True, exist_ok=True)
    handler = logging.handlers.RotatingFileHandler(
        log_dir / filename, maxBytes=2_000_000, backupCount=5, encoding="utf-8")
    fmt = logging.Formatter("%(asctime)s %(levelname)s %(message)s")
    handler.setFormatter(fmt)
    log.addHandler(handler)
    log.setLevel(logging.INFO)
    if verbose and sys.stdout:
        console = logging.StreamHandler(sys.stdout)
        console.setFormatter(fmt)
        log.addHandler(console)


# ---------------------------------------------------------------- helpers

def to_local(value):
    """pywin32 returns Outlook local times labelled as UTC; re-label them."""
    if value is None:
        return None
    d = dt.datetime(value.year, value.month, value.day, value.hour,
                    value.minute, value.second, value.microsecond)
    if d.year >= 4500:  # Outlook's "none" date (4501-01-01)
        return None
    return d.replace(tzinfo=LOCAL_TZ)


def iso(d):
    return d.isoformat(timespec="seconds") if d else None


def outlook_running():
    out = subprocess.run(
        ["tasklist", "/FI", "IMAGENAME eq OUTLOOK.EXE", "/NH"],
        capture_output=True, text=True,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    return "OUTLOOK.EXE" in out.stdout.upper()


def safe(getter, default=None):
    try:
        return getter()
    except Exception:
        return default


def smtp_of(address_entry):
    if address_entry is None:
        return None
    try:
        if address_entry.Type == "EX":
            user = address_entry.GetExchangeUser()
            if user is not None and user.PrimarySmtpAddress:
                return user.PrimarySmtpAddress
            return address_entry.PropertyAccessor.GetProperty(PR_SMTP_ADDRESS)
        return address_entry.Address
    except Exception:
        return safe(lambda: address_entry.Address)


def iter_items(items):
    item = items.GetFirst()
    while item is not None:
        yield item
        item = items.GetNext()


class Lock:
    """Prevents two runs at once (e.g. a slow run and the next scheduled one)."""

    def __init__(self, path):
        self.path = path
        self.fh = None

    def __enter__(self):
        import msvcrt
        self.fh = open(self.path, "a+")
        try:
            msvcrt.locking(self.fh.fileno(), msvcrt.LK_NBLCK, 1)
        except OSError:
            self.fh.close()
            self.fh = None
            return False
        return True

    def __exit__(self, *exc):
        if self.fh:
            import msvcrt
            try:
                self.fh.seek(0)
                msvcrt.locking(self.fh.fileno(), msvcrt.LK_UNLCK, 1)
            finally:
                self.fh.close()


# ---------------------------------------------------------------- transport

class Sink:
    """Where items go: the server (POST) or a local dry-run folder."""

    def __init__(self, cfg, dry_run):
        self.dry_run = dry_run
        self.cfg = cfg
        if dry_run:
            stamp = dt.datetime.now().strftime("%Y%m%d-%H%M%S")
            self.out_dir = cfg["data_dir"] / "dry-run" / stamp
            (self.out_dir / "mail").mkdir(parents=True, exist_ok=True)
        elif cfg.get("make_session"):  # the tray app: token from DPAPI, extra headers
            self.session = cfg["make_session"]()
        else:
            if not cfg["server_url"]:
                raise RuntimeError("server_url is not set in config.json")
            token_file = cfg["token_file"]
            if not token_file.exists():
                raise RuntimeError(f"token file not found: {token_file}")
            self.token = token_file.read_text(encoding="utf-8").strip()
            import requests
            self.session = requests.Session()
            self.session.headers["Authorization"] = "Bearer " + self.token

    def _post(self, path, **kwargs):
        url = self.cfg["server_url"].rstrip("/") + path
        delay = 2
        last_err = None
        for attempt in range(1, self.cfg["retries"] + 1):
            try:
                resp = self.session.post(url, timeout=self.cfg["http_timeout_sec"], **kwargs)
                if 200 <= resp.status_code < 300:
                    return resp
                last_err = f"HTTP {resp.status_code}: {resp.text[:300]}"
                if 400 <= resp.status_code < 500 and resp.status_code not in (408, 429):
                    break  # client error: retrying won't help
            except Exception as e:  # network errors
                last_err = f"{type(e).__name__}: {e}"
            log.warning("POST %s failed (attempt %d): %s", path, attempt, last_err)
            if attempt < self.cfg["retries"]:
                time.sleep(delay)
                delay *= 2
            # rewind file handles before the next attempt
            for f in (kwargs.get("files") or {}).values():
                if hasattr(f[1], "seek"):
                    f[1].seek(0)
        raise RuntimeError(f"POST {path} failed: {last_err}")

    def server_status(self):
        """GET /ingest/status; None in dry-run or on error."""
        if self.dry_run:
            return None
        try:
            resp = self.session.get(self.cfg["server_url"].rstrip("/") + "/ingest/status",
                                    timeout=self.cfg["http_timeout_sec"])
            resp.raise_for_status()
            return resp.json()
        except Exception as e:
            log.warning("GET /ingest/status failed: %s", e)
            return None

    def send_mail(self, meta, msg_path):
        if self.dry_run:
            name = f"{meta['received_or_sent_at'][:19].replace(':', '')}_{uuid.uuid4().hex[:6]}"
            target = self.out_dir / "mail" / (name + ".msg")
            os.replace(msg_path, target)
            (self.out_dir / "mail" / (name + ".json")).write_text(
                json.dumps(meta, ensure_ascii=False, indent=1), encoding="utf-8")
            return
        with open(msg_path, "rb") as fh:
            resp = self._post("/ingest/mail",
                              data={"meta": json.dumps(meta, ensure_ascii=False)},
                              files={"file": ("item.msg", fh, "application/vnd.ms-outlook")})
        result = safe(resp.json, {}) or {}
        status = result.get("status")
        if status not in ("stored", "duplicate"):
            raise RuntimeError(f"unexpected /ingest/mail answer: {str(result)[:300]}")
        return status

    def send_calendar(self, events):
        if self.dry_run:
            (self.out_dir / "calendar.json").write_text(
                json.dumps(events, ensure_ascii=False, indent=1), encoding="utf-8")
            return {}
        result = {}
        for i in range(0, len(events), 200):  # keep requests reasonably small
            resp = self._post("/ingest/calendar", json=events[i:i + 200])
            part = safe(resp.json, {}) or {}
            for k, v in part.items():
                if isinstance(v, int):
                    result[k] = result.get(k, 0) + v
                elif isinstance(v, list):
                    result.setdefault(k, []).extend(v)
        for err in result.get("errors", [])[:20]:
            log.warning("calendar error from server: %s", str(err)[:300])
        return result


# ---------------------------------------------------------------- mail

def walk_folders(folder, name):
    """Yields (folder, server_name): "inbox", "inbox/<sub>", "inbox/<sub>/<sub2>"..."""
    yield folder, name
    for sub in iter_items(folder.Folders):
        yield from walk_folders(sub, name + "/" + sub.Name)


def item_time(item, kind):
    if kind == "sent":
        value = safe(lambda: item.SentOn)
    else:
        value = safe(lambda: item.ReceivedTime)
    if value is None:
        value = safe(lambda: item.CreationTime)
    return to_local(value)


def sync_mail(ns, cfg, state, sink, dry_run):
    since = dt.datetime.fromisoformat(cfg["mail_since"]).replace(tzinfo=LOCAL_TZ)
    overlap = dt.timedelta(minutes=cfg["mail_overlap_minutes"])
    max_bytes = cfg["max_item_mb"] * 1024 * 1024
    inbox = ns.GetDefaultFolder(OL_FOLDER_INBOX)
    sent = ns.GetDefaultFolder(OL_FOLDER_SENT)
    store_name = inbox.Store.DisplayName

    targets = [(f, name, "inbox") for f, name in walk_folders(inbox, "inbox")]
    targets.append((sent, "sent", "sent"))
    counts = {"stored": 0, "duplicate": 0, "written": 0}
    skipped = 0

    # without local state (first run, or state lost) resume from what the server has
    server_last = {}
    if any(not state["mail"].get(name, {}).get("cursor") for _, name, _ in targets):
        status = sink.server_status() or {}
        for f in status.get("folders") or []:
            if f.get("folder") and f.get("last_item_at"):
                server_last[f["folder"]] = f["last_item_at"]

    tmp_dir = Path(tempfile.mkdtemp(prefix="alexconn_"))
    try:
        for folder, path, kind in targets:
            fstate = state["mail"].setdefault(path, {"cursor": None, "seen": {}})
            if not fstate["cursor"] and path in server_last:
                srv = dt.datetime.fromisoformat(server_last[path].replace("Z", "+00:00"))
                if srv.tzinfo is None:
                    srv = srv.replace(tzinfo=LOCAL_TZ)
                fstate["cursor"] = iso(max(srv.astimezone(LOCAL_TZ), since))
                log.info("%s: resuming from server last_item_at %s", path, fstate["cursor"])
            cursor = dt.datetime.fromisoformat(fstate["cursor"]) if fstate["cursor"] else since
            floor = max(since, cursor - overlap)

            items = folder.Items
            items.Sort("[SentOn]" if kind == "sent" else "[ReceivedTime]", True)
            batch = []
            for item in iter_items(items):
                t = item_time(item, kind)
                if t is None:
                    continue
                if t < floor:
                    break  # sorted newest first
                entry_id = item.EntryID
                if entry_id in fstate["seen"]:
                    continue
                batch.append((t, entry_id, item))
            batch.sort(key=lambda x: x[0])  # oldest first, so the cursor only moves forward

            for t, entry_id, item in batch:
                size = safe(lambda: item.Size, 0) or 0
                if size > max_bytes:
                    log.warning("skip %s item %s: %.1f MB is over the limit",
                                path, entry_id[-12:], size / 1048576)
                    skipped += 1
                    fstate["seen"][entry_id] = iso(t)
                    continue
                meta = {
                    "entry_id": entry_id,
                    "store": store_name,
                    "folder": path,
                    "folder_path": safe(lambda: folder.FolderPath),
                    "item_class": safe(lambda: item.MessageClass),
                    "received_or_sent_at": iso(t),
                    "internet_message_id": safe(
                        lambda: item.PropertyAccessor.GetProperty(PR_INTERNET_MESSAGE_ID)),
                    "size": size,
                }
                msg_path = tmp_dir / (uuid.uuid4().hex + ".msg")
                try:
                    item.SaveAs(str(msg_path), OL_MSG)
                except Exception as e:
                    log.warning("SaveAs failed for %s item %s: %s", path, entry_id[-12:], e)
                    skipped += 1
                    continue
                try:
                    result = sink.send_mail(meta, msg_path)
                finally:
                    if msg_path.exists():
                        msg_path.unlink()
                counts[result or "written"] += 1
                # confirmed (or written in dry-run): remember it and move the cursor
                fstate["seen"][entry_id] = iso(t)
                if not fstate["cursor"] or t > dt.datetime.fromisoformat(fstate["cursor"]):
                    fstate["cursor"] = iso(t)
                if not dry_run:
                    save_state(cfg["state_path"], state)

            # forget ids older than the overlap window: they are below the floor anyway
            if fstate["cursor"]:
                keep_after = dt.datetime.fromisoformat(fstate["cursor"]) - overlap - dt.timedelta(days=1)
                fstate["seen"] = {k: v for k, v in fstate["seen"].items()
                                  if dt.datetime.fromisoformat(v) >= keep_after}
    finally:
        for p in tmp_dir.glob("*"):
            p.unlink()
        tmp_dir.rmdir()
    return counts, skipped


# ---------------------------------------------------------------- calendar

def jet_date(d):
    # Restrict on [Start]/[End] uses the Windows short date/time format (local time)
    return d.strftime("%m/%d/%Y %I:%M %p")


def event_record(item):
    start = to_local(item.Start)
    end = to_local(item.End)
    attendees = []
    recipients = item.Recipients
    for i in range(1, (safe(lambda: recipients.Count, 0) or 0) + 1):
        r = recipients.Item(i)
        attendees.append({
            "name": safe(lambda: r.Name),
            "email": smtp_of(safe(lambda: r.AddressEntry)),
            "type": {1: "required", 2: "optional", 3: "resource"}.get(safe(lambda: r.Type), "other"),
            "response": safe(lambda: r.MeetingResponseStatus),
        })
    organizer_entry = safe(lambda: item.GetOrganizer())
    body = safe(lambda: item.Body, "") or ""
    snippet = body.encode("utf-8")[:2048].decode("utf-8", errors="ignore")
    recurring = bool(safe(lambda: item.IsRecurring, False))
    return {
        "entry_id": item.EntryID,
        "global_appointment_id": safe(lambda: item.GlobalAppointmentID),
        "subject": safe(lambda: item.Subject),
        "start": iso(start),
        "end": iso(end),
        "all_day": bool(safe(lambda: item.AllDayEvent, False)),
        "location": safe(lambda: item.Location),
        "organizer": {"name": safe(lambda: item.Organizer), "email": smtp_of(organizer_entry)},
        "attendees": attendees,
        "response_status": safe(lambda: item.ResponseStatus),
        "busy_status": safe(lambda: item.BusyStatus),
        "is_recurring": recurring,
        "occurrence": iso(start) if recurring and start else None,
        "last_modified": iso(to_local(safe(lambda: item.LastModificationTime))),
        "body_snippet": snippet,
        "deleted": False,
    }


def sync_calendar(ns, cfg, state, sink, dry_run):
    now = dt.datetime.now(LOCAL_TZ)
    win_start = (now - dt.timedelta(days=cfg["calendar_days_back"])).replace(
        hour=0, minute=0, second=0, microsecond=0)
    win_end = (now + dt.timedelta(days=cfg["calendar_days_ahead"])).replace(
        hour=23, minute=59, second=0, microsecond=0)

    items = ns.GetDefaultFolder(OL_FOLDER_CALENDAR).Items
    items.Sort("[Start]")
    items.IncludeRecurrences = True
    restricted = items.Restrict(
        f"[Start] <= '{jet_date(win_end)}' AND [End] >= '{jet_date(win_start)}'")

    known = state["calendar"]  # key -> {"lm": last_modified, "start": start, "occ": occurrence}
    current = {}
    changed = []
    for item in iter_items(restricted):
        if safe(lambda: item.Class) != OL_APPOINTMENT_CLASS:
            continue
        try:
            # cheap fields first; the full record (attendees etc.) only for changed events
            start = iso(to_local(item.Start))
            key = f"{item.EntryID}|{start}"
            lm = iso(to_local(safe(lambda: item.LastModificationTime)))
            prev = known.get(key)
            if prev and prev.get("lm") == lm:
                current[key] = prev
                continue
            rec = event_record(item)
        except Exception as e:
            log.warning("calendar item skipped: %s", e)
            continue
        current[key] = {"lm": rec["last_modified"], "start": rec["start"], "occ": rec["occurrence"]}
        changed.append(rec)

    deleted = []
    for key, info in known.items():
        if key in current:
            continue
        start = dt.datetime.fromisoformat(info["start"]) if info.get("start") else None
        # an event that only slid out of the window is not a deletion
        if start and win_start <= start <= win_end:
            entry_id = key.split("|", 1)[0]
            deleted.append({"entry_id": entry_id, "start": info["start"],
                            "occurrence": info.get("occ"), "deleted": True})

    payload = changed + deleted
    result = sink.send_calendar(payload) if payload else {}
    state["calendar"] = current
    if not dry_run:
        save_state(cfg["state_path"], state)
    return len(changed), len(deleted), len(current), result


# ---------------------------------------------------------------- main

def run(cfg, dry_run):
    cfg["data_dir"].mkdir(parents=True, exist_ok=True)
    cfg["state_path"] = cfg["data_dir"] / "state.json"
    if Path(cfg.get("pause_file") or PAUSE_FILE).exists():
        log.info("paused (PAUSE file present), nothing to do")
        return 0
    if not outlook_running():
        log.info("Outlook is not running, skipping")
        return 0

    with Lock(cfg["data_dir"] / "run.lock") as got:
        if not got:
            log.info("another run is in progress, skipping")
            return 0
        import pythoncom
        import win32com.client
        pythoncom.CoInitialize()
        try:
            outlook = win32com.client.Dispatch("Outlook.Application")
            ns = outlook.GetNamespace("MAPI")
            state = load_state(cfg["state_path"])
            sink = Sink(cfg, dry_run)
            mail, mail_skipped = sync_mail(ns, cfg, state, sink, dry_run)
            cal_changed, cal_deleted, cal_total, cal_result = sync_calendar(
                ns, cfg, state, sink, dry_run)
            mode = "DRY-RUN" if dry_run else "LIVE"
            log.info("%s done: mail stored %d, duplicate %d, written %d, skipped %d; "
                     "calendar changed %d, deleted %d, in window %d; server calendar %s",
                     mode, mail["stored"], mail["duplicate"], mail["written"], mail_skipped,
                     cal_changed, cal_deleted, cal_total,
                     {k: v for k, v in cal_result.items() if k != "errors"} or "-")
            if dry_run:
                log.info("dry-run output: %s", sink.out_dir)
        finally:
            pythoncom.CoUninitialize()
    return 0


def main():
    parser = argparse.ArgumentParser(description="Outlook -> Alex connector (read-only)")
    parser.add_argument("--once", action="store_true", help="one sync run (default)")
    parser.add_argument("--dry-run", action="store_true",
                        help="write to data/dry-run instead of sending; state is not saved")
    parser.add_argument("--verbose", action="store_true", help="also log to the console")
    parser.add_argument("--config", help="config file (default: config.json next to the script)")
    args = parser.parse_args()
    cfg = load_config(args.config)
    setup_logging(cfg["data_dir"], args.verbose)
    try:
        return run(cfg, args.dry_run)
    except Exception:
        log.exception("run failed")
        return 1


if __name__ == "__main__":
    sys.exit(main())
