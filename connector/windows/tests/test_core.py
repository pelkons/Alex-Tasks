"""python -m unittest discover -s tests  (from connector/windows)"""
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from alexconn import api, settings  # noqa: E402


class Paths(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.saved = {k: getattr(settings, k) for k in
                      ("ROAMING", "CONFIG_PATH", "SECRET_PATH", "DATA_DIR", "LOG_DIR",
                       "PAUSE_FILE", "PAUSE_SEND_FILE", "PAUSE_INGEST_FILE")}
        settings.ROAMING = self.tmp / "r"
        settings.CONFIG_PATH = settings.ROAMING / "config.json"
        settings.SECRET_PATH = settings.ROAMING / "secret.bin"
        settings.PAUSE_FILE = settings.ROAMING / "PAUSE"
        settings.PAUSE_SEND_FILE = settings.ROAMING / "PAUSE_SEND"
        settings.PAUSE_INGEST_FILE = settings.ROAMING / "PAUSE_INGEST"
        settings.DATA_DIR = self.tmp / "l" / "data"
        settings.LOG_DIR = self.tmp / "l" / "logs"

    def tearDown(self):
        for k, v in self.saved.items():
            setattr(settings, k, v)

    def test_secret_roundtrip_is_encrypted(self):
        settings.save_secret("tok-123", "key-456")
        raw = settings.SECRET_PATH.read_bytes()
        self.assertNotIn(b"tok-123", raw)
        self.assertNotIn(b"key-456", raw)
        self.assertEqual(settings.load_secret(), {"token": "tok-123", "outbox_sign_key": "key-456"})

    def test_broken_secret_reads_as_unpaired(self):
        settings.ensure_dirs()
        settings.SECRET_PATH.write_bytes(b"garbage")
        self.assertIsNone(settings.load_secret())

    def test_config_keeps_known_keys_only(self):
        settings.save_config({"server_url": "http://h:8130", "token": "must-not-be-saved"})
        text = settings.CONFIG_PATH.read_text(encoding="utf-8")
        self.assertNotIn("must-not-be-saved", text)
        self.assertEqual(settings.load_config()["server_url"], "http://h:8130")

    def test_pause_files(self):
        self.assertEqual(settings.pause_state(), (False, False))
        settings.set_pause(settings.PAUSE_SEND_FILE, True)
        self.assertEqual(settings.pause_state(), (False, True))
        settings.set_pause(settings.PAUSE_FILE, True)
        self.assertEqual(settings.pause_state(), (True, True))
        from alexconn.ui import toggle_pause
        toggle_pause(ingest=True)  # splits a manual PAUSE: ingest resumes, sending stays paused
        self.assertEqual(settings.pause_state(), (False, True))


class Code(unittest.TestCase):
    def test_good(self):
        self.assertEqual(settings.parse_code(" alex://10.0.0.5:8130/abcd-1234 "),
                         ("http://10.0.0.5:8130", "ABCD-1234"))
        self.assertEqual(settings.parse_code("alex://host.example/ABCD-1234"),
                         ("http://host.example:8130", "ABCD-1234"))

    def test_bad(self):
        for bad in ("", "ABCD-1234", "http://10.0.0.5:8130/ABCD-1234", "alex://h:8130/ABCD1234",
                    "alex://h:8130/ABCD-1234/extra", "alex://a b:8130/ABCD-1234"):
            with self.assertRaises(ValueError, msg=bad):
                settings.parse_code(bad)


class Update(unittest.TestCase):
    def test_versions(self):
        self.assertGreater(api.version_tuple("1.0.1"), api.version_tuple("1.0.0"))
        self.assertGreater(api.version_tuple("1.10.0"), api.version_tuple("1.9.9"))
        self.assertEqual(api.version_tuple("v1.2"), (1, 2, 0))

    def test_download_only_from_paired_server(self):
        base = "http://10.0.0.5:8130"
        self.assertEqual(api.download_url(base, "/ingest/connector/download"),
                         "http://10.0.0.5:8130/ingest/connector/download")
        for bad in ("http://evil.example/x.exe", "https://10.0.0.5:8130/x", "http://10.0.0.5:9999/x",
                    "//evil.example/x.exe"):
            with self.assertRaises(ValueError, msg=bad):
                api.download_url(base, bad)


class Signature(unittest.TestCase):
    def test_rfc8032_vector(self):
        from alexconn import ed25519
        sk = bytes.fromhex("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60")
        self.assertEqual(ed25519.public_key(sk).hex(),
                         "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a")
        self.assertTrue(ed25519.verify(ed25519.public_key(sk), b"", ed25519.sign(sk, b"")))

    def test_update_signature(self):
        import base64
        from alexconn import ed25519, updater
        sk = bytes(range(32))
        pub = ed25519.public_key(sk).hex()
        sha = "ab" * 32
        sig = base64.b64encode(ed25519.sign(sk, f"alexlink-update-v1|1.0.1|{sha}".encode())).decode()
        self.assertTrue(updater.signature_ok("1.0.1", sha, sig, pub))
        self.assertFalse(updater.signature_ok("1.0.2", sha, sig, pub))       # other version
        self.assertFalse(updater.signature_ok("1.0.1", "cd" * 32, sig, pub))  # other file
        self.assertFalse(updater.signature_ok("1.0.1", sha, None, pub))       # unsigned
        self.assertFalse(updater.signature_ok("1.0.1", sha, "!!", pub))       # garbage
        self.assertFalse(updater.signature_ok("1.0.1", sha, sig))             # real key: not ours


if __name__ == "__main__":
    unittest.main()
