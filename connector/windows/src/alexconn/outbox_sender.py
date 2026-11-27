"""Alex outbox -> Outlook sender.

Sends mail the owner approved on a card in Alex, through the running classic Outlook.
Contract: docs/OUTBOX-CONNECTOR.md in the Alex-Tasks repository.

Each item is checked locally before anything else (HMAC signature, content hash,
approval under 24 h), then claimed on the server, built in Outlook, re-checked, sent,
and the result is reported. There are no retries after .Send(); only the result POST
is retried.

Usage:
    python outbox_sender.py            one poll
    python outbox_sender.py --verbose  one poll, log to the console too
    python outbox_sender.py --no-send  build and check everything, then discard instead of Send()
                                       (for tests against a local stand-in server)
"""

import argparse
import datetime as dt
import hashlib
import hmac
import html
import json
import logging
import os
import re
import sys
import tempfile
import time
from pathlib import Path

try:
    from . import outlook_connector as oc
except ImportError:  # run as a plain script
    import outlook_connector as oc

log = logging.getLogger("connector")

PAUSE_SEND_FILE = oc.BASE_DIR / "PAUSE_SEND"
SIG_PREFIX = "mesimot-outbox-v1"
MAX_APPROVAL_AGE = dt.timedelta(hours=24)
LOCAL_DAILY_CAP = 20
OL_MAIL_ITEM = 0
OL_TO, OL_CC, OL_BCC = 1, 2, 3
OL_DISCARD = 1
OL_BY_VALUE = 1
PR_ATTACH_CONTENT_ID = "http://schemas.microsoft.com/mapi/proptag/0x3712001F"
SENT_LOOKUP_SECONDS = 90


class Refused(Exception):
    """Something does not match the approval: do not send."""


# ---------------------------------------------------------------- verification

def canonical_json(obj):
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def _people(lst):
    return [{"email": (p.get("email") or "").strip().lower(), "name": p.get("name")}
            for p in (lst or [])]


def hash_payload(item):
    payload = {
        "attachments": [{"name": a.get("name"), "sha256": a.get("sha256"), "size": a.get("size")}
                        for a in (item.get("attachments") or [])],
        "bcc": _people(item.get("bcc")),
        "body_html": item.get("body_html"),
        "body_text": item.get("body_text"),
        "cc": _people(item.get("cc")),
        "from": item.get("from"),
        "kind": item.get("kind"),
        "orig_entry_id": item.get("orig_entry_id"),
        "orig_internet_message_id": item.get("orig_internet_message_id"),
        "subject": item.get("subject"),
        "to": _people(item.get("to")),
    }
    return hashlib.sha256(canonical_json(payload).encode("utf-8")).hexdigest()


def expected_sig(key, item_id, content_hash, approved_at):
    msg = f"{SIG_PREFIX}|{item_id}|{content_hash}|{approved_at}"
    return hmac.new(key.encode("utf-8"), msg.encode("utf-8"), hashlib.sha256).hexdigest()


def parse_iso(value):
    d = dt.datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    if d.tzinfo is None:
        d = d.replace(tzinfo=dt.timezone.utc)
    return d


def verify(item, key, now=None):
    """Raises Refused when the item must not be sent."""
    now = now or dt.datetime.now(dt.timezone.utc)
    for field in ("id", "kind", "content_hash", "approved_at", "approval_sig"):
        if item.get(field) in (None, ""):
            raise Refused(f"missing field {field}")
    if item["kind"] not in ("new", "reply", "reply_all", "forward"):
        raise Refused(f"unknown kind {item['kind']!r}")
    sig = expected_sig(key, item["id"], item["content_hash"], item["approved_at"])
    if not hmac.compare_digest(sig, str(item["approval_sig"]).lower()):
        raise Refused("bad approval signature")
    if not hmac.compare_digest(hash_payload(item), str(item["content_hash"]).lower()):
        raise Refused("content does not match its approved hash")
    approved = parse_iso(item["approved_at"])
    if now - approved > MAX_APPROVAL_AGE:
        raise Refused("approval is older than 24 hours")
    if approved - now > dt.timedelta(minutes=5):
        raise Refused("approval time is in the future")
    if not (item.get("to") or item.get("cc") or item.get("bcc")):
        raise Refused("no recipients")


# ---------------------------------------------------------------- state

def load_outbox_state(path):
    if path.exists():
        return json.loads(path.read_text(encoding="utf-8"))
    return {"sent": {}, "pending_results": {}, "refused": {}, "daily": {}}


def today_key():
    return dt.date.today().isoformat()


# ---------------------------------------------------------------- server

class Server:
    def __init__(self, cfg):
        import requests
        self.cfg = cfg
        self.base = cfg["server_url"].rstrip("/")
        if cfg.get("make_session"):  # the tray app: token from DPAPI, extra headers
            self.s = cfg["make_session"]()
        else:
            token = cfg["token_file"].read_text(encoding="utf-8").strip()
            self.s = requests.Session()
            self.s.headers["Authorization"] = "Bearer " + token
        self.timeout = 60

    def approved(self):
        r = self.s.get(self.base + "/outbox/approved", timeout=self.timeout)
        r.raise_for_status()
        return r.json()

    def claim(self, item_id):
        r = self.s.post(f"{self.base}/outbox/{item_id}/claim", timeout=self.timeout)
        body = oc.safe(r.json, {}) or {}
        return r.status_code, body

    def result(self, item_id, result):
        r = self.s.post(f"{self.base}/outbox/{item_id}/result", json=result, timeout=self.timeout)
        if r.status_code == 409:
            return 409
        r.raise_for_status()
        return r.status_code

    def download(self, path, target):
        with self.s.get(self.base + path, timeout=300, stream=True) as r:
            r.raise_for_status()
            h = hashlib.sha256()
            size = 0
            with open(target, "wb") as fh:
                for chunk in r.iter_content(1 << 16):
                    fh.write(chunk)
                    h.update(chunk)
                    size += len(chunk)
        return h.hexdigest(), size


# ---------------------------------------------------------------- Outlook

def safe_filename(name):
    name = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", name or "attachment").strip(" .")
    return name[:150] or "attachment"


def smtp_of_recipient(r):
    return (oc.smtp_of(oc.safe(lambda: r.AddressEntry)) or oc.safe(lambda: r.Address) or "").lower()


def is_inline(att, html_body):
    cid = oc.safe(lambda: att.PropertyAccessor.GetProperty(PR_ATTACH_CONTENT_ID))
    return bool(cid) and ("cid:" + cid) in (html_body or "")


def approved_html(item):
    if item.get("body_html"):
        return item["body_html"]
    text = html.escape(item.get("body_text") or "").replace("\n", "<br>")
    return f'<div dir="auto">{text}</div>'


def insert_above(html_body, fragment):
    """Puts the approved text at the top of the body, above the signature and the quote."""
    m = re.search(r"<body[^>]*>", html_body or "", flags=re.IGNORECASE)
    if not m:
        return fragment + (html_body or "")
    return html_body[:m.end()] + fragment + html_body[m.end():]


def build_mail(ns, item, files):
    kind = item["kind"]
    reply_to = item.get("reply_to") or {}
    entry_id = reply_to.get("entry_id")
    if kind == "new" or not entry_id:
        if kind != "new":
            log.info("outbox %s: %s without reply_to.entry_id, sending as a new mail",
                     item["id"], kind)
        mail = ns.Application.CreateItem(OL_MAIL_ITEM)
    else:
        try:
            original = ns.GetItemFromID(entry_id)
        except Exception:
            raise Refused("original message not found in Outlook")
        mail = {"reply": original.Reply, "reply_all": original.ReplyAll,
                "forward": original.Forward}[kind]()

    # No GetInspector here: on this Outlook build it makes a later Send() fail with
    # E_INVALIDARG, and it did not add the signature anyway. Any signature is in body_html.

    # recipients: exactly the payload, nothing that Reply/ReplyAll added
    while mail.Recipients.Count:
        mail.Recipients.Remove(1)
    for field, rtype in (("to", OL_TO), ("cc", OL_CC), ("bcc", OL_BCC)):
        for p in item.get(field) or []:
            r = mail.Recipients.Add(p["email"].strip())
            r.Type = rtype
    if not mail.Recipients.ResolveAll():
        raise Refused("some recipients could not be resolved")

    mail.Subject = item.get("subject") or ""

    # attachments: drop what Forward/Reply copied (inline images of the quote stay),
    # then add exactly the approved files
    body_before = oc.safe(lambda: mail.HTMLBody, "")
    for i in range(mail.Attachments.Count, 0, -1):
        att = mail.Attachments.Item(i)
        if not is_inline(att, body_before):
            att.Delete()
    for path, display in files:
        mail.Attachments.Add(str(path), OL_BY_VALUE, 1, display)

    mail.HTMLBody = insert_above(oc.safe(lambda: mail.HTMLBody, ""), approved_html(item))
    return mail


def check_mail(mail, item, files):
    """Re-checks recipients, subject and attachments against the payload before Send()."""
    want = {t: sorted(p["email"].strip().lower() for p in item.get(f) or [])
            for f, t in (("to", OL_TO), ("cc", OL_CC), ("bcc", OL_BCC))}
    have = {OL_TO: [], OL_CC: [], OL_BCC: []}
    for i in range(1, mail.Recipients.Count + 1):
        r = mail.Recipients.Item(i)
        have.setdefault(r.Type, []).append(smtp_of_recipient(r))
    for t in have:
        have[t].sort()
    for t, name in ((OL_TO, "To"), (OL_CC, "Cc"), (OL_BCC, "Bcc")):
        if have.get(t, []) != want[t]:
            raise Refused(f"{name} does not match the approval")
    if (mail.Subject or "") != (item.get("subject") or ""):
        raise Refused("subject does not match the approval")
    body = oc.safe(lambda: mail.HTMLBody, "")
    real = sorted(mail.Attachments.Item(i).FileName for i in range(1, mail.Attachments.Count + 1)
                  if not is_inline(mail.Attachments.Item(i), body))
    if real != sorted(display for _, display in files):
        raise Refused("attachments do not match the approval")


def find_sent_copy(ns, subject, since):
    """EntryID of the copy in Sent Items (waits a little for Outlook to move it there)."""
    sent = ns.GetDefaultFolder(oc.OL_FOLDER_SENT)
    floor = since - dt.timedelta(minutes=2)
    deadline = time.time() + SENT_LOOKUP_SECONDS
    while time.time() < deadline:
        items = sent.Items
        items.Sort("[SentOn]", True)
        for it in oc.iter_items(items):
            t = oc.to_local(oc.safe(lambda: it.SentOn))
            if t is None or t < floor:
                break
            if (oc.safe(lambda: it.Subject) or "") == subject:
                return it.EntryID, oc.iso(t)
        time.sleep(3)
    return None, None


# ---------------------------------------------------------------- one item

def process(item, ns, srv, key, ost, cfg, no_send, save):
    item_id = str(item["id"])
    if item_id in ost["sent"]:
        log.warning("outbox %s: already sent from this PC, not sending again", item_id)
        return

    # 1. verify before anything else
    try:
        verify(item, key)
    except Refused as e:
        mark = f"{item.get('content_hash')}|{e}"
        if ost["refused"].get(item_id) != mark:
            log.error("outbox %s REFUSED before claim: %s", item_id, e)
            ost["refused"][item_id] = mark
            save()
            oc.safe(lambda: srv.result(item["id"], {"ok": False, "error": f"connector refused: {e}"}))
        return

    # local daily cap
    if ost["daily"].get(today_key(), 0) >= LOCAL_DAILY_CAP:
        log.warning("outbox %s: local daily cap %d reached, not claiming", item_id, LOCAL_DAILY_CAP)
        return

    # 2. claim
    try:
        code, claimed = srv.claim(item["id"])
    except Exception as e:
        # the claim may or may not have happened; never send, tell the server
        log.error("outbox %s: claim request failed (%s); not sending", item_id, e)
        oc.safe(lambda: srv.result(item["id"], {"ok": False, "error": "claim response lost"}))
        return
    if code != 200:
        log.info("outbox %s: claim answered %s (%s), skipping", item_id, code,
                 str(claimed.get("error", ""))[:200])
        return
    if isinstance(claimed, dict) and claimed.get("id") is not None:
        try:
            verify(claimed, key)
        except Refused as e:
            return report(srv, ost, item_id, {"ok": False, "error": f"claimed item: {e}"}, save)
        if claimed["content_hash"] != item["content_hash"]:
            return report(srv, ost, item_id, {"ok": False, "error": "claimed item differs"}, save)
        item = claimed

    # 3. build, check, send. Anything failing before Send() is reported as ok:false.
    tmp = Path(tempfile.mkdtemp(prefix="alexout_"))
    mail = None
    try:
        files = []
        for n, a in enumerate(item.get("attachments") or []):
            sub = tmp / str(n)
            sub.mkdir()
            display = safe_filename(a.get("name"))
            path = sub / display
            digest, size = srv.download(a["download"], path)
            if digest != (a.get("sha256") or "").lower() or size != a.get("size"):
                raise Refused(f"attachment {display} does not match its sha256/size")
            files.append((path, display))

        mail = build_mail(ns, item, files)
        check_mail(mail, item, files)

        if no_send:
            preview = cfg["data_dir"] / "no-send"
            preview.mkdir(parents=True, exist_ok=True)
            recips = [f"{mail.Recipients.Item(i).Type}:{smtp_of_recipient(mail.Recipients.Item(i))}"
                      for i in range(1, mail.Recipients.Count + 1)]
            (preview / f"{item_id}.html").write_text(
                f"<!-- subject: {html.escape(mail.Subject)} | recipients: {recips} | "
                f"attachments: {mail.Attachments.Count} -->\n" + mail.HTMLBody, encoding="utf-8")
            mail.Close(OL_DISCARD)
            mail = None
            log.info("outbox %s: NO-SEND mode, built and checked, discarded", item_id)
            return report(srv, ost, item_id, {"ok": False, "error": "no-send test mode"}, save)

        started = dt.datetime.now(oc.LOCAL_TZ)
        ost["daily"][today_key()] = ost["daily"].get(today_key(), 0) + 1
        ost["sent"][item_id] = {"at": oc.iso(started), "subject": item.get("subject")}
        save()  # written before Send(): this PC never sends the same id twice
        mail.Send()
        mail = None
        log.info("outbox %s: SENT \"%s\" to %d recipient(s)", item_id, item.get("subject"),
                 sum(len(item.get(f) or []) for f in ("to", "cc", "bcc")))
    except Refused as e:
        log.error("outbox %s REFUSED: %s", item_id, e)
        return report(srv, ost, item_id, {"ok": False, "error": str(e)}, save)
    except Exception as e:
        log.exception("outbox %s failed before Send()", item_id)
        return report(srv, ost, item_id, {"ok": False, "error": f"{type(e).__name__}: {e}"[:300]},
                      save)
    finally:
        if mail is not None:
            oc.safe(lambda: mail.Close(OL_DISCARD))
        for p in sorted(tmp.rglob("*"), reverse=True):
            p.rmdir() if p.is_dir() else p.unlink()
        tmp.rmdir()

    # 4. after Send(): find the Sent Items copy and report; no more Outlook actions
    entry_id, sent_at = find_sent_copy(ns, item.get("subject") or "", started)
    result = {"ok": True, "sent_entry_id": entry_id, "sent_at": sent_at or oc.iso(started)}
    if not entry_id:
        log.warning("outbox %s: sent, but the Sent Items copy was not found within %d s",
                    item_id, SENT_LOOKUP_SECONDS)
    ost["sent"][item_id].update(result)
    report(srv, ost, item_id, result, save)


def report(srv, ost, item_id, result, save):
    """POST the result; on failure keep it and retry only this POST on later runs."""
    try:
        srv.result(item_id, result)
        ost["pending_results"].pop(item_id, None)
    except Exception as e:
        log.warning("outbox %s: result POST failed (%s), will retry", item_id, e)
        ost["pending_results"][item_id] = result
    save()


# ---------------------------------------------------------------- main

def run(cfg, no_send):
    data = cfg["data_dir"]
    data.mkdir(parents=True, exist_ok=True)
    pause = Path(cfg.get("pause_file") or oc.PAUSE_FILE)
    pause_send = Path(cfg.get("pause_send_file") or PAUSE_SEND_FILE)
    if pause.exists() or pause_send.exists():
        log.info("outbox: paused (PAUSE or PAUSE_SEND present)")
        return 0
    if cfg.get("outbox_key"):  # the tray app keeps the key DPAPI-encrypted
        key = cfg["outbox_key"]
    else:
        key_file = cfg["outbox_key_file"]
        if not key_file.exists():
            log.error("outbox: signing key not found: %s", key_file)
            return 1
        key = key_file.read_text(encoding="utf-8").strip()

    with oc.Lock(data / "send.lock") as got:
        if not got:
            return 0
        state_path = data / "outbox_state.json"
        ost = load_outbox_state(state_path)
        save = lambda: oc.save_state(state_path, ost)  # noqa: E731
        srv = Server(cfg)

        # results that could not be delivered earlier: retry only these POSTs
        for item_id, result in list(ost["pending_results"].items()):
            report(srv, ost, item_id, result, save)

        listing = srv.approved()
        if not listing.get("enabled"):
            return 0
        items = listing.get("items") or []
        if not items:
            return 0
        if not oc.outlook_running():
            log.info("outbox: %d approved item(s), but Outlook is not running", len(items))
            return 0

        import pythoncom
        import win32com.client
        pythoncom.CoInitialize()
        try:
            ns = win32com.client.Dispatch("Outlook.Application").GetNamespace("MAPI")
            for item in items:
                process(item, ns, srv, key, ost, cfg, no_send, save)
        finally:
            pythoncom.CoUninitialize()
    return 0


def main():
    parser = argparse.ArgumentParser(description="Alex outbox -> Outlook sender")
    parser.add_argument("--no-send", action="store_true",
                        help="build and check, then discard instead of Send()")
    parser.add_argument("--verbose", action="store_true")
    parser.add_argument("--config")
    args = parser.parse_args()
    cfg = oc.load_config(args.config)
    key_file = Path(os.path.expandvars(cfg.get("outbox_key_file", "data\\secret\\outbox-sign.key")))
    cfg["outbox_key_file"] = key_file if key_file.is_absolute() else oc.BASE_DIR / key_file
    oc.setup_logging(cfg["data_dir"], args.verbose, "outbox.log")
    try:
        return run(cfg, args.no_send)
    except Exception:
        log.exception("outbox run failed")
        return 1


if __name__ == "__main__":
    sys.exit(main())
