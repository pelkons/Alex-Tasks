# Recycle bin ("סל מחזור")

Everything the owner can delete goes to the recycle bin first. Code: `lib/trash.js` (used by `lib/taskdel.js`, `lib/purge.js`, `lib/confirm.js`,
`lib/chatedit.js`, `lib/calendar.js`, `lib/filters.js`, `lib/presence.js`).

## What goes there

| Kind | Deleted from | What the bin item holds |
|---|---|---|
| task | task card "העבר לסל", or `mesimot confirm task-delete` + the owner's "yes" | the task, notes, drafts, email links, decisions, attention items, task chat; links of files, calendar items, sub-tasks, protocol items |
| project | `mesimot confirm project-delete` + "yes" | the project, its passport and statuses, facts and protocols that went with it, the tasks when `--tasks delete`; the ids of everything that was moved elsewhere |
| person | `mesimot confirm person-delete` + "yes" | the person and every reference that was cleared or handed to the assistant |
| protocol | `mesimot confirm protocol-delete` + "yes" | the protocol and its items |
| calendar | `mesimot calendar delete` | the calendar item |
| chat | deleting a chat message (web) | the message stays hidden (`deleted_at`) and leaves the search index |
| filter | Settings, mail rules ✕, or `mesimot filter delete` | the rule |
| email | deleted by the owner in Outlook (Alex Link's presence check, docs/OUTLOOK-INGEST.md) | the email row, its attachment rows and their text chunks, the original HTML and inline pictures, task links (`task_emails`, `tasks.source_email_id`), calendar and mention links, archive index rows and vectors |

Emails cannot be deleted on the site or by the assistant; only the Outlook presence check puts them in the bin.

### Email items
* The mail leaves every live place at once: the keyword index (also its attachments and their text), the vectors, the "דואר" tab and its counts, search, `ask` and the assistant's context.
  Tasks created from it stay as they are and only lose the link. An attachment that was attached to a task stays with the task.
* The raw `.msg` and attachment files (encrypted, under `files/`) stay on disk while the item is in the bin; the final deletion (by hand or by expiry) deletes them. The Outlook record (`ingest_mail`)
  stays marked gone (`gone_at`, `trash_id`), so the same mail is never taken for new.
* Restoring puts back the mail with its id when free, its attachments, the links (to tasks that still exist), its folder, and the search entries (the semantic indexer re-embeds a live mail within
  seconds; archive mail gets its own index rows and int8 vectors back). A mail restored by hand stays even though it is gone from Outlook (`ingest_mail.presence_keep`).
  A mail that comes back in Outlook (restored from Deleted Items there) comes back from the bin by itself.

## How it works

* Deleting removes the live rows exactly as before, so lists, counts, keyword search, the semantic index and the assistant's context no longer see the item.
  The snapshot (JSON of the removed rows) is kept in the `trash` table of the encrypted database.
* Restoring re-inserts the rows. Ids are kept when they are free (a taken id gets a new one); a reference to something that is gone falls back: a task whose
  project was deleted goes to "לא משויך", a missing person becomes empty. A project whose name was taken meanwhile comes back as "<name> (משוחזר)". Things the
  deletion moved elsewhere (tasks, facts, files...) come back only if they are still where the deletion put them.
* Events that mention the item keep their content while it is in the bin; they are anonymised at the final deletion (a finally deleted chat message is blanked).
* Retention: setting `trash_days` (Settings, "ימים בסל המחזור לפני מחיקה סופית"), default 60, 0 = never automatically, max 3650. The purge date is computed
  from the deletion date and the current setting, so a change applies to everything already in the bin. The nightly housekeeping
  (`mesimot-housekeeping.timer`, 03:00) deletes what is older and writes one event per batch.

## Who can do what

* Web: the bin is under "עוד" on the phone and the bin icon in the desktop header (`/trash`). Restore, delete for good (with a confirm dialog), empty the bin.
* Assistant (CLI): `mesimot trash list [--kind ...]`, `mesimot trash restore <id>` are direct. `mesimot trash delete <id>` and `mesimot trash empty` are permanent and
  only post a confirmation; only the owner's "yes" (web or Telegram) executes them.
* API: `GET /api/trash`, `POST /api/trash/:id/restore`, `DELETE /api/trash/:id` and `POST /api/trash/empty` (owner session only).
