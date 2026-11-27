"""Single active computer (1.1.0): role from pair / heartbeat / activate, standby gating.
Runs against an in-process fake of the server endpoints."""
import json
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from alexconn import api, settings, worker  # noqa: E402
from alexconn import outbox_sender as ob  # noqa: E402

TOKEN = "test-token-xyz"


class FakeServer:
    """role: what the server thinks this device is; calls: (method, path, body)."""

    def __init__(self):
        self.role = "standby"
        self.active = {"id": "dev-other", "name": "OFFICE-PC", "last_contact_at": "2026-11-27T10:05:00Z"}
        self.heartbeat_has_role = True
        self.calls = []
        fake = self

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def _send(self, code, obj):
                b = json.dumps(obj).encode()
                self.send_response(code)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(b)))
                self.end_headers()
                self.wfile.write(b)

            def _body(self):
                n = int(self.headers.get("Content-Length") or 0)
                raw = self.rfile.read(n) if n else b""
                return json.loads(raw) if raw else None

            def do_POST(self):
                body = self._body()
                fake.calls.append(("POST", self.path, body))
                if self.path == "/ingest/pair":
                    return self._send(200, {"device_id": "dev-me", "token": TOKEN, "outbox_sign_key": "k",
                                            "server_name": "fake", "role": fake.role,
                                            "active_device": fake.active if fake.role == "standby" else
                                            {"id": "dev-me", "name": "ME", "last_contact_at": None}})
                if self.headers.get("Authorization") != "Bearer " + TOKEN:
                    return self._send(401, {"error": "auth"})
                if self.path == "/ingest/heartbeat":
                    if not fake.heartbeat_has_role:
                        return self._send(200, {"ok": True})  # an older server
                    return self._send(200, {"role": fake.role,
                                            "active_device": fake.active if fake.role == "standby" else None})
                if self.path == "/ingest/activate":
                    fake.role = "active"
                    return self._send(200, {"role": "active"})
                if self.path in ("/ingest/mail", "/ingest/calendar") or "/claim" in self.path:
                    if fake.role == "standby":
                        return self._send(409, {"error": "standby"})
                    return self._send(200, {})
                return self._send(404, {})

            def do_GET(self):
                fake.calls.append(("GET", self.path, None))
                if self.headers.get("Authorization") != "Bearer " + TOKEN:
                    return self._send(401, {"error": "auth"})
                if self.path == "/outbox/approved":
                    if fake.role == "standby":
                        return self._send(200, {"enabled": False, "standby": True, "items": []})
                    return self._send(200, {"enabled": True, "items": []})
                return self._send(404, {})

        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), H)
        self.url = f"http://127.0.0.1:{self.httpd.server_address[1]}"
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()

    def close(self):
        self.httpd.shutdown()
        self.httpd.server_close()

    def paths(self):
        return [p for _, p, _ in self.calls]


class Base(unittest.TestCase):
    NAMES = ("ROAMING", "CONFIG_PATH", "SECRET_PATH", "DATA_DIR", "LOG_DIR",
             "PAUSE_FILE", "PAUSE_SEND_FILE", "PAUSE_INGEST_FILE")

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.saved = {k: getattr(settings, k) for k in self.NAMES}
        settings.ROAMING = self.tmp / "r"
        settings.CONFIG_PATH = settings.ROAMING / "config.json"
        settings.SECRET_PATH = settings.ROAMING / "secret.bin"
        settings.PAUSE_FILE = settings.ROAMING / "PAUSE"
        settings.PAUSE_SEND_FILE = settings.ROAMING / "PAUSE_SEND"
        settings.PAUSE_INGEST_FILE = settings.ROAMING / "PAUSE_INGEST"
        settings.DATA_DIR = self.tmp / "l" / "data"
        settings.LOG_DIR = self.tmp / "l" / "logs"
        self.srv = FakeServer()
        self.changes = []

    def tearDown(self):
        self.srv.close()
        for k, v in self.saved.items():
            setattr(settings, k, v)

    def paired_engine(self, role=""):
        body = api.pair(self.srv.url, "GOOD-1234")
        settings.save_secret(body["token"], body["outbox_sign_key"])
        from alexconn.ui import pair_role
        r, dev = pair_role(body)
        cfg = settings.load_config()
        cfg.update({"server_url": self.srv.url, "role": role or r,
                    "active_device_name": dev.get("name", ""),
                    "active_device_seen": dev.get("last_contact_at", "")})
        settings.save_config(cfg)
        e = worker.Engine(on_change=lambda **kw: self.changes.append(kw))
        e.outlook_ok = True
        return e


class Pairing(Base):
    def test_pair_as_standby(self):
        e = self.paired_engine()
        self.assertTrue(e.standby())
        self.assertEqual(e.active_name(), "OFFICE-PC")
        self.assertRegex(e.active_seen(), r"^27\.11\s\d\d:05$")
        colour, text = e.status()
        self.assertEqual(colour, "blue")
        self.assertEqual(text, "במצב המתנה — פעיל ב-OFFICE-PC")

    def test_pair_as_active(self):
        self.srv.role = "active"
        e = self.paired_engine()
        self.assertFalse(e.standby())
        self.assertEqual(e.status()[0], "green")

    def test_pair_role_missing_means_active(self):
        from alexconn.ui import pair_role
        self.assertEqual(pair_role({"token": "t"}), ("active", {}))


class Heartbeat(Base):
    def test_switch_to_standby_toasts_once(self):
        self.srv.role = "active"
        e = self.paired_engine()
        self.srv.role = "standby"
        e._heartbeat()
        e._heartbeat()
        self.assertTrue(e.standby())
        self.assertEqual(e.take_toasts(), [("Alex Link", "Alex Link עבר למחשב OFFICE-PC")])
        self.assertEqual(settings.load_config()["role"], "standby")  # survives a restart

    def test_switch_to_active_toasts_once_and_syncs(self):
        e = self.paired_engine()
        e.mail_wake.clear()
        self.srv.role = "active"
        e._heartbeat()
        e._heartbeat()
        self.assertFalse(e.standby())
        self.assertTrue(e.mail_wake.is_set() and e.outbox_wake.is_set())
        self.assertEqual(e.take_toasts(), [("Alex Link", "Alex Link פעיל עכשיו במחשב הזה")])
        self.assertEqual(settings.load_config()["active_device_name"], "")

    def test_older_server_without_role_means_active(self):
        self.srv.role = "active"
        self.srv.heartbeat_has_role = False
        e = self.paired_engine(role="active")
        e._heartbeat()
        self.assertFalse(e.standby())
        self.assertEqual(e.take_toasts(), [])

    def test_first_report_after_upgrade(self):
        # 1.0.1 -> 1.1.0: role unknown; server says active -> no toast
        self.srv.role = "active"
        e = self.paired_engine(role="active")
        e.role = ""
        e._heartbeat()
        self.assertEqual(e.take_toasts(), [])

    def test_heartbeat_payload_unchanged(self):
        e = self.paired_engine()
        e._heartbeat()
        body = [b for m, p, b in self.srv.calls if p == "/ingest/heartbeat"][-1]
        self.assertEqual(body["app_version"], "1.1.0")
        self.assertIn("outlook_ok", body)


class Activate(Base):
    def test_activate(self):
        e = self.paired_engine()
        self.assertTrue(e.activate())
        self.assertIn("/ingest/activate", self.srv.paths())
        self.assertEqual([b for _, p, b in self.srv.calls if p == "/ingest/activate"], [{}])
        self.assertFalse(e.standby())
        self.assertEqual(e.status()[0], "green")
        self.assertEqual(e.take_toasts(), [("Alex Link", "Alex Link פעיל עכשיו במחשב הזה")])

    def test_activate_fails(self):
        e = self.paired_engine()
        e.token = "wrong"
        self.assertFalse(e.activate())
        self.assertTrue(e.token_rejected)
        self.assertTrue(e.standby())


class Standby(Base):
    def test_outbox_standby_listing(self):
        e = self.paired_engine()
        seen = []
        cfg = e.run_cfg()
        cfg["on_standby"] = lambda: seen.append(1)
        self.assertEqual(ob.run(cfg, no_send=True), 0)
        self.assertEqual(seen, [1])
        self.assertFalse(any("/claim" in p for p in self.srv.paths()))

    def test_should_stop_follows_role(self):
        e = self.paired_engine()
        cfg = e.run_cfg()
        self.assertTrue(cfg["should_stop"]())
        e.apply_role("active")
        self.assertFalse(cfg["should_stop"]())

    def test_mail_409_is_recognised(self):
        self.assertTrue(worker.is_standby_error(
            RuntimeError('POST /ingest/mail failed: HTTP 409: {"error": "standby"}')))
        self.assertFalse(worker.is_standby_error(RuntimeError("HTTP 409: conflict")))
        self.assertFalse(worker.is_standby_error(RuntimeError("HTTP 500: standby")))

    def test_loops_skip_in_standby(self):
        # one pass of each loop body with a stopped engine: standby -> no mail run, no outbox call
        e = self.paired_engine()
        calls = []
        orig_run, orig_ob = worker.oc.run, worker.ob.run
        worker.oc.run = lambda *a, **k: calls.append("mail")
        worker.ob.run = lambda *a, **k: calls.append("outbox")
        orig_sleep = worker.time.sleep
        worker.time.sleep = lambda s: None
        orig_check = e._check_outlook
        e._check_outlook = lambda: True
        try:
            e.stop.set()
            e.mail_wake.set()
            e.outbox_wake.set()
            # loops check stop only at the top; run the body by clearing stop once inside _wait
            for loop in (e._mail_loop, e._outbox_loop):
                e.stop.clear()
                orig_wait = e._wait
                e._wait = lambda ev, s: (e.stop.set(), False)[1]
                loop()
                e._wait = orig_wait
            self.assertEqual(calls, [])
            e.apply_role("active", announce=False)
            for loop in (e._mail_loop, e._outbox_loop):
                e.stop.clear()
                e._wait = lambda ev, s: (e.stop.set(), False)[1]
                loop()
            self.assertEqual(calls, ["mail", "outbox"])
        finally:
            worker.oc.run, worker.ob.run, worker.time.sleep = orig_run, orig_ob, orig_sleep
            e._check_outlook = orig_check


class Seen(unittest.TestCase):
    def test_fmt(self):
        self.assertEqual(worker.fmt_seen(None), "")
        self.assertEqual(worker.fmt_seen("garbage"), "")
        self.assertRegex(worker.fmt_seen("2026-11-27T10:05:00+00:00"), r"^27\.11\s\d\d:05$")


if __name__ == "__main__":
    unittest.main()
