# Encryption at rest

Everything the system stores on disk is encrypted, so a copy of the disk, the database, the files or a backup is useless without the key.
The system itself works exactly as before: the server, the runner and the assistant read everything, because the key lives on the same server.
The protection is against stolen or copied disks, snapshots, backups and file shares, not against someone who has the running server.

## The key: back it up separately

`~/.config/mesimot/db.key` is 64 hex characters (32 random bytes), mode 600, created once and never overwritten.

**It is the one thing to back up on its own** (password manager, printed copy in a safe, anything that is NOT stored together with the backups).
**Losing it means losing all data**: the database, every stored file and every backup become unreadable, and there is no recovery.
The key is never logged, never printed, never committed, and never part of a backup made by the system.

## What is encrypted

| What | Where | How |
|---|---|---|
| The database | `data/mesimot.db` (and its `-wal`) | SQLCipher 4, AES-256 (`better-sqlite3-multiple-ciphers`), raw 256-bit key. Includes the full-text index, the vector index, mail bodies, chat, and the inline pictures of emails. |
| Database backups | `backups/mesimot-DATE.db` (daily, 30 days), `data/backups/pre-deploy-*.db` | Encrypted copies made with the database key (never a plain copy, not gzipped: encrypted data does not compress). |
| Stored files | `files/**` (attachments, `.msg`/`.eml`, voice notes, documents) | AES-256-GCM per file, see below. Same paths and names as before. |
| Run logs | `data/runs/*` (prompts, streams, tool lists) | Same file format as stored files. Read one with `mesimot vault cat data/runs/123.prompt.txt`. |
| Chunked uploads in progress | `data/uploads/**` | Parts and metadata are encrypted too (deleted after the upload completes). |

Not encrypted on purpose: `data/connector` (the public installer of the Windows program), `agent/memory/` (the assistant reads and edits it as plain files), `data/memory-backups`
(copies of that memory), the web password hash and other secrets in `~/.config/mesimot/` (mode 600), and the system logs (journal).

### File format (lib/vault.js)

`"MSMVAULT" | version | key id | 16-byte salt | chunk size`, then 64 KB chunks, each AES-256-GCM with a 16-byte tag.
The master key gives the files key by HKDF-SHA256 (label `mesimot-files-v1`; the database uses the master key directly, so the two uses are independent), and every file gets its own
key from HKDF with its random salt. The chunk counter is the nonce, and the header and a last-chunk flag are authenticated, so a changed, reordered, removed or truncated chunk is detected.
A file without the magic is treated as not migrated yet and is read as it is, so old and new files can live side by side.

Plaintext exists only in memory or, for tools that need a real file (pdftotext, tesseract, ffmpeg, the assistant's Read tool), in a private `0700` directory under
`/dev/shm/mesimot-vault-<uid>/` that is removed right after use and swept if a crash leaves one. The assistant opens a file through `mesimot show file N`,
which returns `view_path`, a temporary readable copy that is removed after the run.

## Everyday use

* The database cannot be opened with the `sqlite3` tool any more. Use `mesimot sql "<query>"` (read-only; `--write` to change data; `".tables"`, `".schema table"`; `--db FILE` for another file).
* `mesimot vault status` counts encrypted and plain files; `mesimot vault cat <file>` prints one stored file.
* Settings, "מצב המערכת" has a check "הצפנת בסיס הנתונים בדיסק" that turns red if the database file is ever found unencrypted.
* The test instance (`scripts/testenv.sh`) uses its own throw-away key in `/tmp/mesimot-test/db.key`; `npm test` uses `/tmp/mesimot-test-db.key`.

Off-site copies on Proton Drive (nightly, encrypted with this same key): docs/BACKUP.md.

## Restoring a backup on a new server

1. Install the system (`deploy/install.sh`) and stop the services.
2. Put the key back: `install -m 600 <your key backup> ~/.config/mesimot/db.key`. Without the original key nothing can be restored.
3. Copy the backup over the database: `cp backups/mesimot-YYYY-MM-DD.db data/mesimot.db` and remove any old `data/mesimot.db-wal` / `-shm`.
4. Copy the `files/` directory (it is encrypted with the same key, so it can be copied as it is, also through untrusted storage).
5. Check: `mesimot sql ".tables"` lists the tables; start the services; `mesimot health --quick`.

## Rotating the key: `mesimot rekey`

`mesimot rekey` creates a new key and re-encrypts everything with it: the database (copy, verify, swap), every stored file and run log, and every backup.
It stops the services for the duration (the database part takes about half a minute; files and backups then take a few minutes), then starts them.
The new key is first written to `db.key.new`; if the run is interrupted, run it again and it resumes with the same new key. At the end the old key is kept as `db.key.old-<time>`
(mode 600) so you can still read an old copy of a backup that lives elsewhere; delete it once your key backup holds the **new** key. `mesimot rekey --dry` shows the plan only.
After a rotation, back up the new key file again.

## Where the encryption is set up (for developers)

* `lib/dbkey.js`: the key file, the HKDF derivation and the one function that opens an encrypted SQLite file; `lib/db.js` goes through it. Every script that opens a database must too.
* `lib/dbtools.js`: encrypted copies, in-place conversion, key change, verification (row counts, integrity, search results).
* `lib/vault.js`: the file format, streams, in-place encryption with verification, temporary plaintext.
* `scripts/encrypt-db.js` (one-time database conversion, `--backups` for old plain backups, `--rollback`, `--finalize`), `scripts/encrypt-files.js` (one-time file conversion, resumable, safe while running),
  `scripts/backup-db.js` (used by `deploy/backup.sh` and `scripts/deploy.sh`), `scripts/rekey.js`.
* Cost: encrypted pages are decrypted on read; the connection keeps a 128 MB page cache so vector search (which scans many pages) runs at the old speed. Keyword search measured 10-15% slower.
