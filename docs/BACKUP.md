# Off-site backup to Proton Drive

Every night (04:15, after the 03:30 local backup) the system uploads an encrypted copy of the database and any new stored files to a Proton Drive folder.
Nothing leaves the server unencrypted: the database is compressed first (encrypted data does not compress), then sealed with the vault key (`lib/vault.js`); stored files are uploaded exactly as they are on disk (already vault format).
The key (`~/.config/mesimot/db.key`) is never uploaded. Without it the copies are useless, so keep it in a password manager (Settings, "גיבוי והצפנה", shows it after the web password is entered again).

## Layout on the Drive (everything under `/my-files/Alex Tasks Backups/`)

* `db/mesimot-db-YYYY-MM-DD.db.zst.vault`: one copy per night. Kept: the newest 7 days and the newest 4 Sunday copies. If the folder passes 10 GB the oldest copies are thinned (the 2 newest always stay). Only these names, only in `db/`, are ever deleted.
* `files/...`: the stored files, same relative paths as `files/` here. Only new or changed files are uploaded (`data/offsite-manifest.json` remembers what is there; a changed file is a new revision). Nothing under `files/` is ever deleted. A file that is not in the vault format is never uploaded.

## The mail archive is NOT uploaded (rule, enforced in code)

The Outlook mail archive (`docs/OUTLOOK-INGEST.md`, "Archive mode") keeps the complete files of the last year's old mail under `files/archive/`. These files are far too big for the 15 GB Drive, so **no file of the archive ever goes to Proton Drive**:
the upload of `files/` skips the `archive/` directory, skips every path recorded as `files.archived = 1` wherever it is, and `guardNotArchive` refuses such a path at the moment of upload (tests in `test/mailarchive.test.js`; the dry run reports `files.skipped_archive`).
**The database is uploaded as always, and it holds all the archive TEXT** (bodies, the text of every attachment, the search index and the vectors), so after a disaster the archive is fully searchable again; only the complete `.msg` files and attachments of the last year's old mail
(and nothing else) would have to be re-sent from Outlook. The Drive budget therefore depends on the database size (it is compressed first; the 10 GB cap thins the oldest copies, the 2 newest always stay). Local backups in `backups/` contain everything.

## Safety rules (code, unit-tested in `test/offsite.test.js`)

* Every remote path goes through `guardRemote`: anything outside `/my-files/Alex Tasks Backups/` (also `..`, backslashes, other sections) is refused before a command runs.
* Every local upload goes through `guardLocal`: only inside the files directory or the private temporary directory, never a `*.key`, never anything under a `.config` directory.
* The plaintext copy of the database exists only in the private `0700` directory under `/dev/shm/mesimot-vault-<uid>/` and is removed in a `finally`.

## The Proton Drive CLI

Official binary (Proton AG, built on the Proton Drive SDK): `https://proton.me/download/drive/cli/index.html`, installed in `~/.local/opt/proton-drive/proton-drive` (linux-arm64, version 0.9.0, SHA-512 checked against `version.json` on proton.me).
It stores its session in the system keyring (libsecret / Secret Service), so the user session must have an unlocked keyring (this server runs gnome-keyring in the user session).

### One-time login (done by the owner, not by the assistant)

1. On the server run `~/.local/opt/proton-drive/proton-drive auth login`. It prints "Authenticate your account at <URL> (press ENTER to open in browser)". Do not press ENTER on a headless shell.
2. Open that URL on ANY device (phone, laptop; the help says another device is fine), sign in to Proton and approve. Keep the terminal open until it says the login completed.
3. Check: `~/.local/opt/proton-drive/proton-drive filesystem list /my-files` lists the Drive.
4. Then: `mesimot backup offsite --dry-run`, then `mesimot backup offsite`, then `systemctl --user enable --now mesimot-offsite.timer`.

## Commands

* `mesimot backup offsite [--dry-run]`: run now (the dry run prints what would be uploaded and touches nothing remote).
* `mesimot backup restore-test`: downloads the newest database copy, decrypts and decompresses it into the private temp directory, opens it and runs `integrity_check` (the live database is never touched).
* `mesimot backup status`: the stored status as JSON.

## Failure handling

The result is stored in the `offsite_status` setting. The health check "גיבוי מוצפן ל-Proton Drive" is red when the last run failed or when 36 hours passed without a success; the owner is told once per outage (and once when it recovers).
When the Drive has less than 2 GB free (if the CLI reports it) the owner is told once.

## Restoring

Install the system, put the key back, download `db/mesimot-db-<date>.db.zst.vault` and the `files/` folder from Proton Drive (`proton-drive filesystem download ...`), then:
`node -e "require('./lib/offsite').openFile('<copy>.vault','data/mesimot.db.plain')"` gives a plain SQLite file; encrypt it with the key (`scripts/encrypt-db.js` conversion) or use `mesimot backup restore-test` first to prove the copy opens. Stored files are copied back as they are (docs/ENCRYPTION.md, "Restoring a backup on a new server").
