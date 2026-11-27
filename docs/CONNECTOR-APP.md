# Alex Link: the Windows program

Goal: the Outlook connector on the owner's PC becomes a normal program that anyone can install on a new computer in a few minutes,
with no Python, no copying of token/key files and no Task Scheduler setup by hand. It keeps doing exactly what the current script does
(see `OUTLOOK-INGEST.md` and `OUTBOX-CONNECTOR.md`); only packaging, pairing, status and updates are new.

## What the owner does on a new computer
1. On the site: Settings → "מחשב Outlook" → "הורדת התוכנה" (downloads `AlexLink-Setup-<version>.exe`).
2. Runs it. No admin rights needed (per-user install into `%LOCALAPPDATA%\Programs\AlexLink`).
3. The program opens a small window "חיבור לשרת" and asks for the connection code.
4. On the site: "חבר מחשב חדש" shows a one-line code, for example `alex://<server-tailscale-ip>:8130/K7Q2-M9XD` with a copy button.
5. He pastes it, presses "חיבור". Done: a green icon appears next to the clock.

## Windows program (built and tested on MAINPC)
* Python 3.13 + pywin32, packaged with PyInstaller (one folder, no console), installer with Inno Setup (per-user, no admin, Hebrew + English
  installer text, uninstall from Windows "Apps", option "run at Windows sign-in" ON by default via the HKCU Run key).
* One process, single instance (named mutex). Background loops: mail push every 10 minutes (and on "סנכרן עכשיו"), outbox poll every 60 seconds,
  heartbeat every 5 minutes. Same logic, dedupe and resume as the current script (`GET /ingest/status` first). Unicode `.msg` (olMSGUnicode = 9).
* Tray icon (Hebrew menu, RTL text):
  status line (מחובר / אין חיבור לשרת / Outlook סגור / מושהה) with the last sync time and the last error,
  "סנכרן עכשיו", "השהה קליטת מיילים" (toggle), "השהה שליחת מיילים" (toggle), "פתח את Alex Tasks" (opens the site), "פתח יומן" (log folder),
  "החלף שרת / חיבור מחדש", "יציאה". Icon colour: green ok, yellow paused or Outlook closed, red no server for over 30 minutes.
  The old `PAUSE` / `PAUSE_SEND` files keep working (either the file or the menu toggle pauses).
* Settings and secrets in `%APPDATA%\AlexTasks\`: `config.json` (server URL, device id, toggles) and `secret.bin` = the device token and the
  outbox signing key encrypted with Windows DPAPI (CurrentUser). Never written in plain text, never logged.
* Logs: `%LOCALAPPDATA%\AlexTasks\logs\connector.log`, rotating, 5 x 2 MB, no mail bodies and no secrets.
* Outlook: if Outlook is not running, wait and retry quietly (tray shows "Outlook סגור"); do not start Outlook by itself.
* Auto-update: once a day and at start, `GET /ingest/connector/latest`; if newer, download, check sha256, run the installer silently
  (`/VERYSILENT /SUPPRESSMSGBOXES`), the installer restarts the program. Never update in the middle of a send.
* Migration on MAINPC: install, pair, then delete the old Task Scheduler jobs `AlexOutlookConnector` and `AlexOutlookOutbox` and stop the old script.
  Nothing is lost: the program resumes from the server's `/ingest/status`, duplicates are ignored by the server.
* Source in the public repo under `connector/windows/` (no secrets, no server address, no names), with `build.ps1` (PyInstaller + Inno Setup)
  and a short `README.md`. The built installer is NOT committed; it is uploaded to the server (see below).

## Server side (contract)
All on the existing Tailscale-only listener `http://<server-tailscale-ip>:8130` unless marked "site".

* **site** `POST /api/connector/pair-code` (logged in) → `{ "code": "K7Q2-M9XD", "connect_string": "alex://<tailscale-ip>:8130/K7Q2-M9XD", "expires_at": "ISO" }`.
  8 characters from an unambiguous alphabet, valid 15 minutes, one use, at most 5 live codes.
* `POST /ingest/pair` (no Bearer; Tailscale source addresses only; max 10 attempts a minute) body `{ "code", "computer_name", "app_version" }`
  → `200 { "device_id": 3, "token": "<random 32 bytes hex>", "outbox_sign_key": "<the outbox-sign.key text>", "server_name": "Alex Tasks" }`,
  `404` unknown/expired/used code. The server stores only sha256(token). The device appears in Settings.
* Device tokens are accepted on every `/ingest/*` and `/outbox/*` route exactly like `MESIMOT_INGEST_TOKEN` (which stays valid as the legacy token
  until the owner removes it). Each request updates the device's `last_contact_at`. A revoked device gets `401`.
* `POST /ingest/heartbeat` `{ "app_version", "computer_name", "outlook_ok": true, "paused_ingest": false, "paused_send": false, "last_sync_at": "ISO", "last_error": "text or null" }` → `200 {}`.
  Stored per device; shown in Settings; the health check and the existing 2-hour watchdog use it (Outlook closed or paused in work hours is reported once, not repeatedly).
* `GET /ingest/connector/latest` → `{ "version": "1.0.0", "sha256": "hex", "size": 123, "download": "/ingest/connector/download" }` or `{ "version": null }`.
  `GET /ingest/connector/download` (Bearer) streams the installer.
* **site** `GET /api/connector/download` (logged in) streams the same installer for a new computer.
* Installer files live in `data/connector/` (`AlexLink-Setup-<version>.exe` + `latest.json`); `bin/mesimot connector publish <file>` copies a
  file there, computes sha256 and writes `latest.json`.
* **site** Settings → section "מחשב Outlook": list of devices (name, version, last contact, Outlook ok, paused flags, last error), buttons
  "חבר מחשב חדש" (shows the connect string with a copy button and the expiry), "הורדת התוכנה", "ניתוק" per device (revoke, with confirm).
  Hebrew, RTL, same look as the other settings cards, works on the phone.
