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
