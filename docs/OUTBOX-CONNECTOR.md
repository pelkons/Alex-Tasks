# Outbound mail: connector contract

The server never sends mail. The owner approves the EXACT content of each message on a card (✅ in the chat or in Telegram); the server then signs it, and the connector on the
owner's PC sends it through Outlook and reports back. Everything below is on the same listener as the ingest API (`http://<server-tailscale-ip>:8130`, Bearer token, Tailscale
source addresses only; see `OUTLOOK-INGEST.md`).

## What the connector must do
1. Poll `GET /outbox/approved` every ~30-60 seconds (it can be the same loop as the mail push).
2. For each item, **verify before anything else** (refuse and do NOT claim if any check fails):
   * the signature: `HMAC-SHA256(key, "mesimot-outbox-v1|<id>|<content_hash>|<approved_at>")` as lowercase hex must equal `approval_sig`. `key` is the shared secret from `outbox-sign.key` (the file's text, trimmed, used as UTF-8 bytes). Compare in constant time.
   * the hash: recompute `content_hash` yourself from the fields you received (below). It must equal the `content_hash` you received.
   * `approved_at` is not older than 24 hours.
3. `POST /outbox/<id>/claim`. Only on `200` send the mail. `409` (already claimed, not approved, disabled, changed) or `429` (daily cap) means do not send.
4. Build the Outlook item exactly from the payload: `from` is informational (send from the default account of the owner), `to`, `cc`, `bcc`, `subject`, `body_html` as the HTML body
   (it is RTL-aware; `body_text` is the plain-text equivalent), the attachments (download each from its `download` path with the Bearer token and check the `sha256`).
   For `kind` `reply` / `reply_all` / `forward` with `reply_to.entry_id`, open that original item (`GetItemFromID`) and use `.Reply()` / `.ReplyAll()` / `.Forward()`, then SET the recipients,
   subject and body to the payload values (so what is sent equals what was approved; Outlook's own signature may be added below by your template). If `reply_to` is null, send it as a new mail.
   Do not add or change any recipient, text or attachment.
5. `POST /outbox/<id>/result` with `{ "ok": true, "sent_entry_id": "<EntryID of the Sent Items copy>", "sent_at": "<ISO>" }` or `{ "ok": false, "error": "<short reason>" }`.
   Send the result even if it must be retried later (it is idempotent for `ok: true`). A claimed item with no result is NOT retried by the server (to avoid double sending); the owner is shown "בשליחה".

## GET /outbox/approved
`{ "enabled": true, "daily_cap": 20, "sent_today": 3, "items": [ <item> ] }`. When the owner's kill switch is off: `{ "enabled": false, "items": [] }`: send nothing.

Item:
```json
{ "id": 12, "kind": "new|reply|reply_all|forward", "from": "owner@work.example",
  "to": [ { "name": "...", "email": "a@b.co" } ], "cc": [], "bcc": [], "subject": "...",
  "body_text": "...", "body_html": "<div ...>...</div>",
  "attachments": [ { "file_id": 5, "name": "plan.pdf", "size": 1234, "sha256": "hex", "download": "/outbox/12/attachment/5" } ],
  "reply_to": { "entry_id": "Outlook EntryID or null", "internet_message_id": "<...@...> or null" },
  "orig_entry_id": "...", "orig_internet_message_id": "...",
  "content_hash": "hex", "approved_at": "ISO", "approved_via": "web|telegram", "approval_sig": "hex",
  "sig_format": "..." }
```

## content_hash
`content_hash = sha256_hex( canonical_json(payload) )` where `payload` is this object (recipients are `{email, name}`; emails are lowercase):

```json
{ "attachments": [ {"name", "sha256", "size"} ... ], "bcc": [...], "body_html": "...", "body_text": "...", "cc": [...], "from": "...",
  "kind": "...", "orig_entry_id": "... or null", "orig_internet_message_id": "... or null", "subject": "...", "to": [...] }
```
`canonical_json`: keys sorted alphabetically at every level, no whitespace (`separators=(",",":")`), UTF-8 with non-ASCII characters left as they are (Python: `json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False)`), arrays keep their order.
`attachments` in the hash carry only `name`, `sha256`, `size` (not `file_id`/`download`). Use the item's own `body_text` and `body_html` strings as received.

## POST /outbox/{id}/claim
`200` with the item (same shape), status becomes `sending`. `409` `{error}` if not approved / already claimed / disabled / content no longer matches its approval; `429` daily cap reached.

## POST /outbox/{id}/result
Body `{ "ok": true, "sent_entry_id": "...", "sent_at": "ISO" }` or `{ "ok": false, "error": "..." }`. `200 {status: "sent"|"failed"}`; `409` if the item is not in `sending`. On `ok: true` the owner gets "נשלח: <subject> → <to>" in the chat.

## GET /outbox/{id}/attachment/{file_id}
The file bytes (only while the item is `approved` or `sending`).

## Rules enforced by the server (for your information)
* Nothing is listed unless the owner approved that exact hash within the last 24 hours and the global switch is on; any edit after approval clears the approval.
* Daily cap (default 20); recipients are syntax-checked. The default signature is empty (mail goes out as the owner); a configured block is already inside `body_text`/`body_html`.

## Test vector

```
canonical_json = {"attachments":[],"bcc":[],"body_html":"<div style=\"font-family:Calibri,Arial,sans-serif;font-size:11pt\"><p dir=\"auto\" style=\"margin:0 0 10px 0\">שלום<br>עולם</p></div>","body_text":"שלום\nעולם","cc":[],"from":"owner@work.example","kind":"new","orig_entry_id":null,"orig_internet_message_id":null,"subject":"בדיקה","to":[{"email":"a@b.co","name":"דנה"}]}
content_hash   = ef14bd9cc517090638a23eba30f64f36eed935508a370ad60287d683efbb528a
key            = test-key-0123456789abcdef0123456789abcdef  (id 7, approved_at 2026-11-26T10:00:00.000Z)
approval_sig   = a92d2da2b2bbc018559cbed719adff0e0299006a3ece7212f74cd56545b4de85
```


## Replies: finding the original (reply_to)
For `kind` `reply`, `reply_all` and `forward` the item ALWAYS has a `reply_to` object (for `new` it is `null`):
* `reply_to.entry_id`: the Outlook EntryID of the original when it came through the Outlook ingest (also when it was first imported by hand and the connector pushed it later). Try `GetItemFromID(entry_id)` first.
* `reply_to.internet_message_id`: the original's Message-ID (with angle brackets) whenever the server knows it, including mail from the manual import or the Proton path. When the EntryID is missing or no longer resolves, search for the original by `PR_INTERNET_MESSAGE_ID` (`http://schemas.microsoft.com/mapi/proptag/0x1035001F`), comparing case-insensitively and ignoring the brackets.
* Both null: send it as a new mail. The approval card tells the owner which way it goes ("תשובה בשרשור המקורי" or "יישלח כמייל חדש"). The ids are part of the signed content hash.

## Failed items: re-send
A failed item is never retried by the server. The owner re-sends it from its card ("שלח שוב (טיוטה חדשה)", or the Telegram button), which creates a NEW draft (new id, new card, fresh approval, the original found again by the rules above). The connector sees it only after the owner approves it, as a normal approved item.
