# Architecture

Mesimot is a task board whose work is done by a **terminal coding agent** (Claude Code, Codex CLI or Gemini CLI) that the user has installed and
logged in to with their own account. The code contains no model and no vendor credentials. Its job is everything around the agent: intake, context,
a small CLI the agent works through, validation, scheduling, storage and the web app.

```
 owner ── web app (public/, Alpine.js, PWA) ──┐
       ── Telegram bot (text, voice, files) ──┤
       ── forwarded email (mail provider) ────┤
       ── chat drop of mail files / zip ──────┤
                                              ▼
                     Fastify server (lib/server.js, 127.0.0.1)
                     SQLite (WAL) + FTS5 + sqlite-vec  <── bin/mesimot (CLI, API token)
                                              ^                  ^
                     runner (lib/runner.js) ──┘                  │
              context ─> agent adapter ─> `mesimot apply` ─> validation gate (re-prompt <= 2) ─> attention + badge
                                 │
        lib/agents/: claude-code | codex | gemini   (the user's own CLI, headless, own login)
```

## Principles

1. **Correctness is enforced in code.** The agent proposes; the code checks (context requirements, one-transaction `apply`, the validation gate,
   the "do not give up" gate, the attachment gate). Anything the gate cannot get fixed becomes a visible attention item and a "needs review" badge.
2. **Nothing the agent does is irreversible.** Every change is an event with its actor; it can be undone from the activity screen.
3. **Email, files and web pages are data, never instructions.** The agent runs with an allow-list of tools; the web research run has no access to
   the data at all.
4. **No owner-specific data in the code.** Names, addresses, domain and team come from `config/mesimot.config.json`; the instructions are rendered
   from `agent/AGENTS.template.md`; the owner's memory lives in `agent/memory/`. None of these is committed.
5. **Local first.** One SQLite file, local speech-to-text and embedding models, no cloud dependency except the agent CLI and the chosen mail provider.

## Components

| Part | Files | Role |
|---|---|---|
| Server | `lib/server.js`, `lib/auth.js` | REST API, cookie login for the browser, token for the CLI, static PWA. |
| Store | `lib/store.js`, `lib/db.js` | Tasks, projects, people, notes, events (with undo), statuses; migrations are additive. |
| Knowledge | `lib/knowledge.js`, `lib/docs.js`, `lib/mailfile.js` | Files and chunks (PDF text, OCR, Office, mail files), project facts (dated, superseded, never deleted), knowledge items. |
| Search | `lib/search.js`, `lib/semantic.js`, `lib/ask.js` | FTS5 keyword search, local e5 embeddings (sqlite-vec), reciprocal-rank fusion; `ask` adds domain synonyms and returns chunks with file and page. |
| Runner | `lib/runner.js` | Polls the mailbox and Telegram, decides when to run, builds the prompt, calls the adapter, applies the gate loop; also the scheduled jobs. |
| Adapters | `lib/agents/*` | One module per agent CLI: tool restrictions, stream parsing, usage and cost. Model and effort are routed per job (`lib/agents/models.js`). |
| Gate | `lib/gate.js` | The invariants below. |
| Entities | `lib/entities.js` | Partial people and vague projects, retroactive merge and re-linking. |
| New projects | `lib/projectask.js` | The assistant cannot create a project (`store.createProject` refuses its actor, the API answers `pending_approval`, the gate reverts a project written around the API). It proposes with `mesimot project propose`; the owner answers one question (site card + attention list + Telegram via `proposals` kinds `project_new` / `project_pick`): yes creates it, "no, it is project Y" adds an alias and moves the waiting items, "not a project" stores the normalized name with variants as rejected, never proposed again. A pending name is asked once; its items stay unassigned, marked "ממתין לאישור פרויקט". |
| Passport | `lib/profile.js` | The project PASSPORT (buildings, floors, new / existing units, track, commercial, contractor, architect) and the LATEST STATUS PER PROCESS (design, permit, construction, marketing). Dated rows with a source and history; an older value never replaces a newer one; the owner's edit on the site wins and is marked (the assistant never replaces his passport value, and his status only with a strictly newer one); the assistant must give a real `email:`/`file:`/`protocol:`/`chat:` source. CLI `mesimot project profile|status`, `apply` `profile` / `statuses` / `fact_topics` / `profile_checked`; the gate asks when a processed mail or a new protocol speaks about them. Facts carry a topic (design, permit, construction, finance, marketing, people, other) for the grouped list on the project page. One-off backfill: `bin/mesimot-runner --profile-backfill [ids]` (one run per project, background, no chat). |
| Mail | `lib/mail/*`, `lib/email.js` | Providers (AgentMail HTTP, IMAP/SMTP for Proton Bridge), scoped folders, verified cleanup, sent copies. |
| Import | `lib/importer.js` | The daily bulk email import (below). |
| Usage | `lib/usage.js` | Tokens, cache tokens and API-equivalent cost per agent call, rate-limit back-off, weekly summary. |
| UI | `public/` | Hebrew-only, RTL, resizable split panes on desktop, bottom-sheet chat on phones. |

## Pipelines

**Email intake.** A forwarded email (or one typed into the chat) is stored with its thread (participants, dates, normalized subject, project numbers) and its
attachments, which are downloaded, text-extracted (PDF text, OCR for scans and images, Office files, nested mail) and chunked. `lib/context.js` then finds,
in code, the related open tasks, earlier mail, project facts, partial people and vague projects, and lists the attachments of related emails.
The agent must give a decision (close / advance / update / no change) for each related task in ONE `mesimot apply` call, which is rejected as a whole when
a required decision is missing.

**Validation gate** (`lib/gate.js`), after every run: project set, requester correct, dates, people linked or dismissed, language, duplicates,
email report, attachments (summary, project link and facts checked per file), project-card facts, protocol owners, and for chat answers the
"not found" ladder (the run log must show `ask` with synonyms, the project card, the attachment chunks, the chat history and 3 distinct phrasings).
Each violation is a specific question quoting the source; two rounds, then it is accepted, logged and shown as an attention item.

**Questions and answers.** `mesimot ask` expands a question with a small Hebrew construction-domain synonym list, searches keyword and semantic,
fuses the lists, restricts to the detected project and returns chunks with file, page and section. When an answer comes from a document it is saved as a
project fact so the next time is instant.

**Attachments.** Every non-signature attachment must end with a summary, a project link and facts extracted; poor OCR (photos, drawings) makes the agent
look at the file itself. Large files are indexed in the background (chunked, resumable uploads up to 1 GB; optional local Telegram Bot API for 2 GB).

**Daily bulk import.** The owner drops a day of exported mail (`.msg`, `.eml` or a zip) into the chat. The pipeline (all state in SQLite, resumable):
parse real headers and direction (sent / received) -> dedupe by Message-ID and by (sender, minute, subject) against forwarded copies -> drop noise by code
(newsletters, auto-replies, calendar responses, receipts, no-reply) -> group into threads (References / In-Reply-To, then subject key) -> one cheap batched
triage call (relevant / FYI / noise) -> one agent run per relevant thread in chronological order -> a single digest message. Sent mail is evidence: a reply
closes the task, a promise becomes a task for the owner, a request to someone else becomes a follow-up task. Chat always has priority over the import.

**Outlook mail archive.** The owner's old mail (tens of thousands of messages) arrives through the same listener (`meta.archive = true`, docs/OUTLOOK-INGEST.md), is queued encrypted, and a separate low-priority worker (`bin/mesimot-archive`, lib/archive.js) stores it without any assistant call:
parse, body and attachment text, a rule-based project guess, its own FTS5 index (`search_archive`) and local vectors. Mail older than `archive_full_since` is text only (binaries discarded); newer mail is stored complete under `files/archive/` (never uploaded off-site). `emails.archived = 1` keeps it out of the runner,
the look-backs, the live index and the context for new mail (archive appears there only as a few low-ranked hits); search and `mesimot ask` include it.

**Mail tab (`/mail`, lib/maillist.js).** Every email in the system in one list (live Outlook mail, forwarded mail, imported files, the archive of old mail; inbox and sent), newest first. `GET /api/mail` uses keyset pagination on the mail date (`COALESCE(forwarded_date, received_at)`, covering indexes `idx_mail_date` / `idx_mail_thread`, no OFFSET, short reads only), groups by `thread_key` (`mode=threads`, default) or lists every mail (`mode=all`), filters by project, person (sender or recipient), folder, dates, attachments, linked task, archive; with `q` it runs the existing hybrid search (attachment text and the archive index included) and applies the same filters to the mails found (at most 100). `GET /api/mail/thread/:id`, `GET /api/mail/people?q=` (autocomplete), `GET|POST /api/mail/visit` (the owner's last visit, kept in `settings`; only the web session moves it; "new" = live incoming mail received after the previous visit). Reading reuses the email page (one markup, `#tpl-email-view`, used by `/email/:id` and by the pane of the tab); "create a task from the mail" and "ask about the mail" use the chat pinned to the mail (`entity_scope = email:ID`), the assistant does the work. `node scripts/bench-mail.js` measures it on a synthetic mailbox.

**Entity resolution.** Names mentioned casually become partial people or vague projects; later they are completed or merged and everything that referred to
them (tasks, mentions, facts) is re-linked, undoably.

**Scheduled jobs** (systemd user timers): pulse (code finds items; the agent writes one message or stays silent), watchdog, reconcile, morning reminders,
memory curator, housekeeping, backup, weekly usage summary.

**Web research (`/s`).** An isolated run with only WebSearch and WebFetch in a neutral directory; no access to data or the CLI. The code posts the
final text after its own checks.

## Data model (SQLite)

`tasks`, `projects` (aliases, summary, partial flag), `people` (roles, emails, status partial/full), `notes`, `events` (every change, with undo),
`project_facts` (key, value, as-of date, source `email|chat|file`, superseded_by, topic), `project_profile` / `project_status` (passport fields and per-process status lines: value, as-of date, source, by_owner, superseded_by), `knowledge`, `emails` (thread, direction, import state), `files` +
`chunks`, `chat_messages`, `claude_runs` and `run_usage` (per call), `run_trace` (what the agent looked at), `gate_log`, `attention`, `calendar_items`,
`protocols` and `protocol_items`, `imports`, `settings`. FTS and vector tables are maintained by triggers and a background indexer.

## Security model

* The agent runs headless with tools limited per adapter: the `mesimot` CLI, read of its own directory and the file archive, write of its memory and
  a scratch directory. Shell redirects, substitutions and the Write tool are denied for the Claude adapter; the gate catches what a looser adapter does.
* Email and attachment text is wrapped as data in every prompt; the owner-only rule applies to anything the system sends by email.
* Mail providers work in a scoped folder set (INBOX and the assistant's own folders); nothing else in the mailbox is opened, moved or deleted, and nothing
  is deleted without a verified local copy.
* Everything stored is encrypted at rest (database and backups AES-256 via SQLCipher, stored files and run logs AES-256-GCM, one master key in `~/.config/mesimot/db.key`): `docs/ENCRYPTION.md`.
* Secrets only in `~/.config/mesimot/env` (mode 600); the web password is stored hashed; the API token is for the local CLI.
* Public exposure is optional (Cloudflare Tunnel); the site needs a login.
