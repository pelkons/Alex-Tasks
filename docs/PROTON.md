# Proton Mail through the Bridge (imap provider)

Proton has no public API. The `imap` mail provider (`lib/mail/imap.js`) talks to the official **Proton Mail Bridge** running locally in split
address mode (IMAP 127.0.0.1:1143, SMTP 127.0.0.1:1025, STARTTLS with a self-signed certificate, Bridge-generated credentials). The provider is selected with
`MAIL_PROVIDER=imap`; `agentmail` stays the default. **Nothing is switched until you set it.**

## Design: a dedicated address in Bridge's SPLIT mode

The assistant has its own Proton address, **assistant@proton.example**. With Bridge in split address mode that address gets its own IMAP/SMTP account that sees only its
own mail, so the owner's personal mailbox is never reachable. The owner forwards work mail (and points Power Automate) to assistant@proton.example.

* **Scope, enforced in code.** The provider may SELECT only the configured folders: the intake folders `MAIL_IMAP_SCOPE_FOLDERS` (default
  `INBOX,Folders/tasks.example.org/Inbox`: the INBOX before the owner's Proton filter existed, the assistant's own folder after it; both are read so nothing is
  lost), the processed label `MAIL_IMAP_DONE_FOLDER` (`Labels/Alex-done`) and the sent folder `MAIL_IMAP_SENT_FOLDER` (`Folders/tasks.example.org/Sent`, housekeeping
  only). Every name comes from the configuration. The IMAP client is wrapped (`scopedClient`): opening, creating, renaming or COPYing into any other mailbox
  (All Mail, Sent, Trash, the owner's other folders and labels) throws a `ScopeError`, and `LIST`/`STATUS`/`MOVE` do not exist on the wrapper. `CREATE` is allowed
  for exactly the configured own folders (and their parents), `RENAME` only when `MAIL_IMAP_LEGACY_PARENT` is set, and only for exactly that parent. Test:
  `test/mail-imap.test.js`. **Note:** the Bridge's IMAP `LIST` shows the owner's whole folder and label tree even in split mode, which is why the guard matters.
* **Folders (as Proton shows them):** `Folders/tasks.example.org` (the owner's filter "tasks.example.org" files incoming mail into `Folders/tasks.example.org/Inbox`),
  `Folders/tasks.example.org/Sent` (our outgoing copies), `Labels/Alex-done`. A dot in a folder name works through the Bridge for SELECT and for COPY.
  `node scripts/setup-bridge-folders.js` creates them (and renames `MAIL_IMAP_LEGACY_PARENT` when set); run it once after changing the names.
* **Outgoing copies.** Every message the system sends gets our own `Message-ID`. Proton shows the copy in its Sent folder only after about a minute, so the
  send does not wait: it remembers the id in `data/mail-sent-pending.json` and retries in the background (growing waits, about six minutes; resumed after a
  restart). The copy is found in `Sent` by the exact Message-ID **and** our From address (nothing else is listed or fetched there) and **COPYed** into
  `Folders/tasks.example.org/Sent`. Success means "the message is present in the target folder". On Proton, `Sent` behaves like a system label: a sent message
  normally keeps showing in Sent after it is filed in a custom folder. That is expected, is never retried or cleaned up, and **nothing is ever expunged from Sent**
  (that could delete the message entirely). `mail-check.py` does the same for its replies.
* **Processed state** is a COPY into `Labels/Alex-done` (in Proton: a label; the message stays in the INBOX). It never depends on `\Seen`.
* **Authentication.** The rule is unchanged: the work address (dana@exconstruct.example) or a forwarded subject from an allowlisted address
  (dana@exconstruct.example, dana.levi@mail.example, the owner's Proton address), with `dmarc=pass`. DMARC comes from the **topmost** `Authentication-Results` header
  (the one the receiving server adds; lower ones can be forged). A message the owner sends from his Proton account is accepted when `X-Pm-Origin: internal`
  and the From is `MAIL_OWNER_ADDRESS` (unset = this rule is off). *These Proton headers must be checked against the real Bridge output.*
* **Housekeeping** (`MAIL_HOUSEKEEPING`, default `trash` because the mailbox is the assistant's own; applies to both intake folders and to the sent folder): messages older than the retention period (Settings, default 30
  days) whose local copy is verified (the same check as before: email row, body, every attachment and its hash) are copied into Trash and expunged from the INBOX and
  from the done label. Our sent copies in `Folders/tasks.example.org/Sent` are kept 90 days (`MAIL_SENT_RETENTION_DAYS`) and then go to Trash. Trash is only a copy destination, never opened. Mode `labels` only removes the done label. Nothing outside the configured folders is touched.
* **Sending** (digests, watchdog alerts): SMTP **from assistant@proton.example** through the split-mode SMTP account, to the owner's notification address only
  (`sendOwnerEmail` refuses anyone else).
* The self-signed Bridge certificate is accepted only when `MAIL_TLS_INSECURE_LOCAL=1` **and** the host is 127.0.0.1, localhost or ::1.

## Configuration (`~/.config/mesimot/env`)

```
MAIL_PROVIDER=imap
MAIL_ADDRESS=assistant@proton.example
MAIL_IMAP_HOST=127.0.0.1   MAIL_IMAP_PORT=1143   MAIL_IMAP_USER=<bridge user of the assistant address>   MAIL_IMAP_PASS=<bridge password>
MAIL_SMTP_HOST=127.0.0.1   MAIL_SMTP_PORT=1025   MAIL_SMTP_USER=<bridge user of the assistant address>   MAIL_SMTP_PASS=<bridge password>
MAIL_TLS_INSECURE_LOCAL=1
MAIL_IMAP_SCOPE_FOLDERS=INBOX,Folders/tasks.example.org/Inbox   MAIL_IMAP_DONE_FOLDER=Labels/Alex-done   MAIL_IMAP_SENT_FOLDER=Folders/tasks.example.org/Sent
MAIL_HOUSEKEEPING=trash
MAIL_OWNER_ADDRESS=<the owner's own Proton address, once known>
```

`~/bin/mail-check.py` reads the same variables, opens only the INBOX and the done label of this account, treats messages that are not work forwards as personal
requests, and answers the owner by SMTP.

## Verified on the real Bridge (2026-11-25, split mode, account assistant@proton.example)

* Login to the IMAP account works (STARTTLS, self-signed certificate accepted for loopback only). Capabilities include IDLE, MOVE, UIDPLUS.
* The account's INBOX shows only that address's mail (`To: assistant@proton.example`).
* `CREATE "Labels/Alex-done"` is accepted by the Bridge (the label now exists; a second CREATE answers "already exists").
* `COPY` INBOX -> `Labels/Alex-done` adds the label and the original stays in the INBOX. Housekeeping `remove(trash)` (copy to Trash, expunge from the INBOX and
  from the label) leaves both folders empty without errors.
* Mail the assistant's own address receives from Proton carries `X-Pm-Origin: internal` and `X-Pm-Content-Encryption`, and **no** `Authentication-Results`.
  Hence the internal-origin rule (From must be `MAIL_OWNER_ADDRESS`). Whether **external** mail (a forward from exconstruct.example or gmail) carries
  `Authentication-Results` with `dmarc=pass` is still to be confirmed with the first real forward: if it does not, DMARC cannot be checked and the owner must decide.
* SMTP from assistant@proton.example to the owner's gmail works (250 queued).
* `node scripts/verify-bridge.js` repeats the read-only checks (never prints credentials or bodies).

## Cut-over and the AgentMail fallback

`MAIL_PROVIDER=imap` is set; `MAIL_FALLBACK_PROVIDER=agentmail` with `MAIL_FALLBACK_UNTIL=<date>` keeps the old inbox as an **intake-only** fallback for a limited time
(sending, digests and alerts use Proton only). Each stored email remembers its provider (`emails.mail_provider`), is marked done in the same one, and housekeeping cleans each
provider by its own rules. After the date the fallback switches itself off. `mail-check.py` follows the same variables. The watchdog checks the `proton-bridge` service and the
IMAP login (a failure restarts the Bridge, not the runner).
