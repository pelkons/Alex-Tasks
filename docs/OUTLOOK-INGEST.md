# Outlook live ingest: connector API

A connector on the owner's Windows PC pushes new mail and calendar changes to the server over Tailscale. Everything below is the contract.

* Base URL: `http://<server-tailscale-ip>:8130` (plain HTTP inside the Tailscale network, which is already encrypted). The listener is bound ONLY to the Tailscale
  address; it is not reachable from the public site or the tunnel. Requests must come from `100.64.0.0/10`.
* Auth: `Authorization: Bearer <MESIMOT_INGEST_TOKEN>` on every request (the token lives in the server's `~/.config/mesimot/env`). Without it: `401`; wrong source address: `403`.
* Errors are JSON `{ "error": "..." }` with `400` (bad input), `401`, `403`, `413` (file over 100 MB), `422` (the .msg cannot be read).
* The connector should call `GET /ingest/status` first to resume, push in order, and retry on any network error (every call is idempotent).
* Any authenticated request counts as "the connector is alive". If nothing arrives for 2 hours in work hours (Sun to Thu, 08:00 to 19:00 Jerusalem) the owner is told once.

## GET /ingest/status
Returns what the server has, so the connector knows where to resume:

```json
{ "server_version": "0.1.0", "now": "ISO", "last_contact_at": "ISO",
  "mail": { "folders": [ { "folder": "inbox", "last_item_at": "ISO of the newest mail by received_or_sent_at", "last_received_at": "ISO when the server stored it", "total": 12, "stored": 10, "duplicates": 2 } ],
            "last_received_at": "ISO", "total": 12, "per_day": [ { "day": "YYYY-MM-DD", "received": 5, "stored": 4 } ], "pending_in_pipeline": 0 },
  "calendar": { "last_received_at": "ISO", "items": 40 } }
```
Resume mail per folder from `folders[].last_item_at` (go back a few minutes for safety; duplicates are harmless).

## POST /ingest/mail   (multipart/form-data)
Parts:
* `meta`: JSON (a normal field or a part with `Content-Type: application/json`):
  `{ "entry_id": "Outlook EntryID (required)", "store": "mailbox/store name", "folder": "inbox | sent | <any other path>", "received_or_sent_at": "ISO 8601 with offset",
     "internet_message_id": "<...@...> (the Message-ID header; strongly recommended)", "size": 12345, "backfill": "optional label, e.g. 2026-10 (see below)" }`
* `file`: the message as a `.msg` file (up to 100 MB).

Response `200`: `{ "status": "stored", "email_id": 1, "import_id": 3 }` or `{ "status": "duplicate", "reason": "entry_id | internet_message_id | same_file" }`.
Idempotent on `entry_id` and on `internet_message_id` (also against mail imported earlier by hand or by forward). `folder` starting with `sent` marks the owner's own mail
(it can close or update tasks). Mail is processed within minutes; only urgent items reach the owner at once, the rest is in the 07:30 morning digest.

**Backfill of older periods:** send the same requests with `meta.backfill = "<label>"`. Mail with the same label is one separate import with its own card and digest in the chat,
and it always waits behind live mail. Send it in chunks (for example a week at a time), oldest or newest first, whatever suits.

## POST /ingest/calendar   (application/json)
Body: an array of events (send changes since the last sync, or the whole window; upserts are idempotent):

```json
[ { "entry_id": "...", "global_appointment_id": "...", "subject": "...", "start": "2026-12-01T09:00:00+02:00", "end": "2026-12-01T10:00:00+02:00", "all_day": false,
    "location": "...", "organizer": { "name": "...", "email": "..." } , "required_attendees": [ { "name": "...", "email": "..." } ], "optional_attendees": [],
    "response_status": "accepted", "is_recurring": false, "occurrence": "2026-12-01", "last_modified": "ISO", "body_snippet": "first 2 KB", "deleted": false } ]
```
* The key of an item is `entry_id`, plus `occurrence` (a date) for recurring events: send each occurrence as its own element with the same `entry_id`.
* All-day events: `start` and `end` as dates (`YYYY-MM-DD`); Outlook's exclusive end date is accepted as is.
* `deleted: true` removes the item (only `entry_id`, and `occurrence` when recurring, are needed).
* Items are a read-only mirror shown in the calendar as "Outlook"; they are never written back to Outlook.

Response `200`: `{ "received": 3, "created": 1, "updated": 1, "deleted": 0, "ignored": 1, "errors": [ { "entry_id": "...", "error": "..." } ] }`. A bad element is reported in `errors` and does not fail the rest.

## Re-ingest (replacing mail that was stored damaged)
`POST /ingest/mail` with `meta.reingest = true` and the same `entry_id` (or the same `internet_message_id`) REPLACES the stored mail in place: the raw file, headers, body and attachment names (matched by order and size; new attachments are added).
The email id and everything linked to it (tasks, facts, links) stay. Response: `{ "status": "reingested", "email_id", "garbled_before": bool, "files_renamed", "files_added", "people_fixed", "queued_for_extraction" }`,
or `{ "status": "reingested", "unchanged": true }` when the bytes are identical (idempotent). A mail the server has never seen is stored normally. The assistant is not re-run, except in the background for mail whose old text had more than 20% "?" characters.

## Archive mode: all the OLD mail, searchable, zero assistant calls

The owner's old Outlook mail (Inbox, every subfolder, Sent: tens of thousands of messages) is sent with the SAME request as live mail plus `meta.archive = true`. The server stores it, extracts the text and indexes it for search and for the
assistant's `mesimot ask`. It is **never processed by the assistant**: no run, no task, no proposal, no notification, no digest line, no project fact, no link to an existing task, no token of any model.

```
POST /ingest/mail   multipart: meta (JSON) + file (.msg)
meta = { "entry_id": "...", "store": "...", "folder": "inbox | sent | <path>", "received_or_sent_at": "ISO 8601 with offset", "internet_message_id": "<...>", "size": 12345,
         "archive": true,                       // REQUIRED for archive mode
         "backfill": "archive-2025",            // optional label of this push (kept per mail; the whole archive is ONE import / ONE chat card whatever the labels)
         "text_only": true }                    // optional: keep only the text (can only REDUCE what is kept, see below)
```

* **Storage rule, enforced by the server.** `archive_full_since` (config, default `2025-11-27`, Jerusalem date of `received_or_sent_at`): mail on or after that day is stored COMPLETE (the `.msg` and every attachment, encrypted, openable on the site exactly like live mail);
  mail before it is stored as **text only**: the body plus the text extracted from the attachments (PDF, Word, Excel, PowerPoint, text, OCR of images, nested messages); the `.msg` and the attachment files are discarded after extraction, only the
  names, sizes and types stay (the email page says "הקובץ נמצא רק ב-Outlook"). The cutoff applies whatever the connector sends: `text_only: false` on an old mail is ignored. If `received_or_sent_at` is missing the date inside the message decides.
* **Dedupe** is the same as for live mail (`entry_id`, `internet_message_id`, also against mail stored earlier by any route): `{"status":"duplicate","reason":"entry_id|internet_message_id"}`. A mail that already exists normally is left exactly as it is.
* **Response `200`:** `{"status":"stored","archive":true,"queued":true,"text_only":true,"import_id":7}`. "stored" means accepted and safely queued (encrypted); the heavy work (parsing, extraction, indexing, vectors) runs afterwards in a background worker.
* **Back-pressure and disk (the connector MUST honour these):**
  * `429 {"error":..., "retry_after_s":60}` + `Retry-After: 60`: the queue of unprocessed mail is full (`archive_queue_max_mb`, default 3000). Wait that long and send the SAME request again. Nothing was recorded.
  * `507 {"error":..., "retry_after_s":600}`: less than `archive_min_free_gb` (default 20) free on the server's disk. Wait and retry; the owner is alerted by the health check.
  * Everything else as for live mail (`400`, `401`, `403`, `413`, `422`). A mail the worker finds unreadable is counted as failed on the server (`mesimot archive failed`); it does not fail the request.
* **Pace.** Send one request at a time, newest or oldest first, any folder order. The worker handles about 20 to 40 mails a minute (see "Measured speed"), so a push at full network speed is slowed by the 429 rule; no need to throttle by hand. Live mail always goes first:
  the workers run at the lowest priority, stand still while a live batch is being staged or parsed or a chat message waits, and use fewer workers while live mail is arriving; live mail is never delayed by the archive.
* **Resume.** `GET /ingest/status` has an `archive` object next to `mail`: `{ emails, text_only, full, queued, embedding, failed, ..., folders: [ { folder, oldest_item_at, newest_item_at, total, accepted, duplicates, failed } ] }`.
  Archive mail is NOT counted in `mail.folders`, so the live resume point (`last_item_at`) is never moved by old mail. Every request is idempotent: after an error just send it again.

### What the server does with an archive mail

parse (real headers, direction by folder and owner addresses), the text of the body and of every attachment, thread key and project numbers, a cheap rule-based project guess (names and aliases in the subject and body, project numbers, a sender who always writes about one project,
the project of the same thread; only a clear winner, never a model), correspondents resolved to existing people (unknown addresses are only counted in `archive_contacts`, no people are created), full-text index (`search_archive`, the same trigram FTS5 as the live index),
local e5 vectors (the body in up to 3 parts and the first 4 chunks of each attachment; `embeddings.archive = 1`, stored int8-quantized in their own table `vec_archive`: a scan of 120,000 float vectors took 0.75 s here and would have slowed every live search and every context gathering, the int8 table answers in 0.05 s with ~95% of the float top-10; the live vector table is untouched). The mail is `emails.archived = 1`, `import_state = 'archived'`, `processed_at` set from the start, so no part of the live system picks it up.
It is excluded from: the runner, reconciliation and pulse look-backs, project pages and timelines, the recent-files list, the live search index and the live embedding queue. It is included in: search (chip "ארכיון" and the mail date, filter "כולל ארכיון", default on),
`mesimot ask` (hits are marked `archive: true`), the email page, `mesimot email show/thread`. When the assistant gathers context for NEW mail the archive is excluded from the main search and added back as at most 3 keyword hits (marked `[ארכיון]`, ranked last) plus at most 4 same-thread mails.

### Status

`mesimot archive status` (also `GET /api/mail-archive/status`, the "Outlook" card in Settings: "ארכיון: X מיילים, Y טקסט בלבד, אחרון ..."): counts, queue, failures, disk, speed and ETA. `mesimot archive failed | retry | estimate`.
The chat shows ONE card for the whole archive ("ארכיון Outlook: n/N נקלטו"), updated in place, never one message per mail. The health check "ארכיון המיילים" is red when the disk is low and warns when the worker is not running.

### Worker, speed and disk

* Worker: `bin/mesimot-archive` (user service `mesimot-archive.service`, `Nice=15`, idle I/O class, `CPUWeight=20`, `MemoryHigh=4G`, `MemoryMax=5G`). A SUPERVISOR process holds the embedding model (vectors in small batches of 8 passages) and starts up to 3 STORE workers
  (`--child`, one mail at a time: parse, attachment text, own search index) while mail is queued; a store worker exits after 40 mails, at 1 GB, or when idle, so memory never accumulates. Each mail is ONE short write transaction (the slow extraction happens before it),
  so killing any process at any moment loses nothing: on SIGTERM the workers put their mail back in the queue and the service stops in 2 to 3 seconds; after a crash the supervisor requeues orphaned work at start. A crash loses nothing: a mail is either fully stored or still in the queue.
* **Measured speed** (this 4-core ARM server, no GPU, e5-small q8, three mails in parallel, whole pipeline including vectors, `node scripts/bench-archive.js`): mail with no or small attachments about **130 mails a minute** (0.47 s each, 90% of it the vectors);
  mail that each carries a REAL attachment from this server's own files (mostly PDFs, scans, Office files; `--real 80`) about **20 a minute** (3 s each; OCR and PDF reading are 80% of that). About 32% of this owner's mail carries a real attachment, so the blended speed is about **45 mails a minute: 20,000 mails in roughly 7 hours** (between 2.6 hours if there were no attachments at all and 16 hours if every mail had a heavy one).
  Limits that keep the tail short: scanned PDFs are OCR-read for their first 4 pages (and only up to 10 pages in all), OCR of one picture is stopped after 45 s, camera photos over 3 MB and HEIC are not OCR-read, PDFs are read up to 120 pages, files over 60 MB are not read (their names stay).
  Search over a 1.5 GB archive index (80,000 indexed rows) answers in 20 to 500 ms (the slowest being a very common word); vector search over 120,000 archive vectors 0.05 s.
* **Disk.** Measured: a text-only mail costs about **80 to 100 KB** in the database (body, attachment text, trigram index, int8 vectors; 20,000 of them are about 2 GB) and nothing else once its raw file is deleted. A complete mail costs its real size (about 1.8 MB on average here, encrypted under `files/archive/`) plus the same 90 KB.
  Example: 20,000 mails of which a quarter are from the last year: 15,000 x 0.09 MB + 5,000 x 1.9 MB = about 11 GB. If ALL 20,000 were complete: about 38 GB.
  `mesimot archive estimate --emails 20000 --full_share 0.3` prints the projection against the free space. The daily local database backups multiply the database size, which is the real cost of a larger database: `deploy/backup.sh` therefore also caps the copies in `backups/` at `BACKUP_MAX_GB` (default 40, oldest first, the newest 3 always stay) and `scripts/deploy.sh` keeps only the 5 newest `pre-deploy` copies. The nightly Proton Drive copy needs room in `/dev/shm` for the plain snapshot of the database while it is built (about the database size, twice). Keep the free space above the 20 GB floor: below it the listener answers 507, the health check turns red and the owner is alerted.
* The raw queue directory `data/archive-queue/` is encrypted like every stored file and is covered by `mesimot rekey`.

## Mail presence: deletions made in Outlook (contract, Alex Link 1.2.0)
Until now the server only learned about NEW mail; a mail the owner deleted in Outlook stayed on the site. The connector now also reports what is currently in the mailbox, so the server can move vanished mail to the trash.

`POST /ingest/mail-presence` (same Bearer as the other ingest routes; a standby device gets `409 {"error":"standby"}`):
```
{ "store": "mailbox/store name", "scope": "recent" | "full",
  "since": "ISO 8601 with offset: every mail RECEIVED OR SENT on/after this moment, in every folder listed, is reported",
  "complete": true,
  "folders": [ { "folder": "inbox | sent | <path>", "mails": [ { "entry_id": "...", "internet_message_id": "<...>" } ] } ],
  "deleted_items": [ { "entry_id": "...", "internet_message_id": "<...>" } ] }
```
* `folders` = every normal folder of the store (Inbox, Sent, all subfolders), NOT Outlook's "Deleted Items", Junk, Drafts, Outbox or sync-issue folders. Items of "Deleted Items" go to `deleted_items` (ids only, same `since`).
* `complete` must be `true` only if every folder was enumerated without an error. On any COM error send nothing (the server then changes nothing).
* A mail the server holds whose `entry_id` AND `internet_message_id` appear in no folder of `folders` is "gone from Outlook". If it appears in `folders` under another folder or another entry id, it was only MOVED: nothing happens (the server updates its folder).
* The server looks only at mail with a date >= `since` and older than 10 minutes (so a just-arrived mail is never judged). Mail without an Outlook entry id (forwarded by hand, imported from a file) is never touched.
* Safety: if more than 30% of the covered stored mails (and at least 20) would be removed, the server removes nothing and tells the owner instead.
* Response `200`: `{ "checked": 812, "removed": 3, "moved": 1, "held": false }`.
* Size: ids only; about 60 bytes a mail (a full year is about 1 MB); one request per run, gzip allowed.

Schedule in the program: `scope: "recent"` with `since` = now minus 14 days every 10 minutes, right after the normal mail push (enumerating 14 days is cheap, Outlook is queried by date with `Restrict`); `scope: "full"` with `since` = the archive start (`archive_full_since` from `GET /ingest/status`, 2025-11-27) once after start/update and then once a night (around 03:00). Never while Outlook is closed.
