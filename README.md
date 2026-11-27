# Mesimot (Alex Tasks)

A **Hebrew-first task board that an AI coding agent runs for you.** Forward emails, write or speak to a chat (web or Telegram), drag a day of Outlook mail
into the chat, and the assistant (named **Alex** by default) turns it all into tasks, keeps a card of dated facts per project, links email threads to the
tasks they continue, remembers every attached document, drafts replies and reminds you of what matters. The web app is a window onto the data; the work
is done by an agent you already have.

> The user interface and the assistant's replies are **Hebrew by default** (right-to-left). The code, the CLI and the documentation are English.

**It is a toolkit, not an AI service.** Mesimot contains no model, no API keys and no vendor credentials. In *automatic mode* it calls the official CLI of a
coding agent that **you** installed and logged in to (Claude Code, Codex CLI or Gemini CLI), headless, as you would from a terminal. In *interactive mode* you
open that agent inside this repository and it operates the system through the `mesimot` CLI.

> **Each user must run Mesimot with their own agent account and follow that vendor's terms of use.** The code never extracts, proxies or reuses an
> agent's credentials or tokens, never calls a vendor's private endpoints and never shares one login between users. It only starts the official CLI
> binary as a normal local user would.

## Principle: the assistant operates the system, the owner instructs

The owner should do nothing by hand. Every entity page (task, project, person, protocol, calendar day) has its own chat pinned to that entity, and a sentence such as
"rename this project", "merge these two people" or "move the meeting to Thursday" is carried out by the assistant, through the same validated, undoable path as
everything else, with a reply that says exactly what changed. Pickers and menus remain as a secondary way. Closed tasks leave the main list for an archive (searchable,
reopenable); permanent deletion exists, but only after a one-question confirmation with buttons, and a task deletion has a 30-second undo.

## Features

* Tasks with project, requester, assignee, due date (explicit or estimated), status, notes, undo of every change.
* **Email intake** (AgentMail or Proton Mail through the Bridge): threads, participants, attachments with text extraction, OCR and summaries.
* **Project card**: dated facts per project, the newest supersedes the older one, with the source (email, file, chat).
* **Questions answered from your own data** (`mesimot ask`): synonyms, keyword + semantic search, answers with file and page; a code-enforced "do not give up" ladder.
* **Daily bulk import**: drop a day of exported Outlook mail (`.msg`, `.eml`, zip) into the chat; duplicates and noise are dropped, threads are grouped, sent mail
  closes or opens tasks, one digest comes back.
* **Live Outlook ingest** (optional): a small connector on a Windows PC pushes new mail and calendar changes over Tailscale (`docs/OUTLOOK-INGEST.md`); mail is processed within minutes, only urgent items interrupt, one morning digest, a read-only calendar mirror.
* **Validation gate**: the code checks every run (project, requester, dates, people, language, attachments, facts) and re-prompts the agent.
* People and projects mentioned casually are resolved later and everything that referred to them is re-linked.
* Meeting minutes tab, calendar feed (subscribe from Outlook), voice messages (local speech-to-text), Telegram bot, web research command (`/s`).
* Usage measurement (tokens, API-equivalent cost, rate-limit back-off) and a weekly summary.
* A resizable desktop layout (list | card | chat), PWA, dark mode.

## Requirements

* Linux with systemd (user units), Node.js 20+, Python 3 (voice), `pdftotext`, `tesseract` (with Hebrew data), `ffmpeg`, ImageMagick.
* **A terminal coding agent CLI, installed and logged in with your own account:** Claude Code (reference adapter), Codex CLI or Gemini CLI.
* Optional: Proton Mail + Proton Bridge (split mode) or an AgentMail inbox for email intake; a Telegram bot; `cloudflared` for a public address; Docker for the local Telegram Bot API.

## Install

```bash
git clone https://github.com/pelkons/Alex-Tasks.git mesimot && cd mesimot
deploy/install.sh        # asks a few questions; idempotent; flags: --yes --no-voice --no-systemd --owner-name-he ... (see the header of the script)
node bin/mesimot web-password --generate
```

The script installs the Node dependencies and the Python venv, writes `config/mesimot.config.json` from your answers, creates `~/.config/mesimot/env`
(mode 600) and `agent/memory/` from the examples, renders the assistant's instructions (`agent/AGENTS.template.md` (rendered to `agent/AGENTS.md`)) from the template, installs the systemd **user** units
and enables the timers. AI models for voice and search are downloaded on first use. It **installs no agent for you**: it shows which of the three CLIs it finds
and prints the official install link for the others. Install one, log in yourself, then `deploy/check-agent.sh claude-code|codex|gemini` runs one tiny call.

Then open the site (default `http://127.0.0.1:8110`, or your tunnel address), log in with the generated password and tell the assistant about yourself in the chat.

## Configure

* `config/mesimot.config.json` (template `config/mesimot.config.example.json`): owner and assistant names, team, bosses, site address, inbox, time zone, model routing.
  Nothing owner-specific is in the code.
* `~/.config/mesimot/env`: secrets and switches; every variable is documented in `.env.example`.
* `agent/memory/*.md`: what the assistant knows about you, your people and projects (templates in `agent/memory.example/`). Never committed.
* Mail provider (`MAIL_PROVIDER`): `agentmail` (default) or `imap` for Proton Mail via the local Bridge, see `docs/PROTON.md`.
* Telegram: create a bot with @BotFather, put `TELEGRAM_BOT_TOKEN` in the env file, bind it from Settings.
* A public address is optional: a Cloudflare Tunnel (`tunnel_id` in the config, `deploy/cloudflared.yml.template`).

## What guarantees correctness

An agent can slip. Everything that matters is therefore enforced **in code**, independent of the agent:

| Layer | File | What it does |
|---|---|---|
| Context gathering | `lib/context.js` | For each email/file finds related open tasks, earlier mail, project facts, partial people and vague projects and **requires a decision on each**. |
| Apply validation | `lib/apply.js` | `mesimot apply` is one transaction; it is rejected when a required decision is missing. |
| Validation gate | `lib/gate.js` | After every run: project set, requester right, dates, people linked, Hebrew only, no duplicates, email report, attachments, facts, protocol owners. Violations become specific questions that quote the source (2 rounds), then an attention item and a "דורש בדיקה" badge. Every violation is logged. |
| Entity resolution | `lib/entities.js` | Partial people/projects ("גלעד מפרויקט דוגמית") are completed or merged later and everything that referred to them is re-linked, undoably. |
| Undo | `lib/undo.js` | Every change of the assistant is an event and can be undone. |

See `docs/ARCHITECTURE.md` for the architecture and the pipelines.

## Choose the agent (the brain)

`MESIMOT_AGENT=claude-code|codex|gemini` (and optionally `MESIMOT_AGENT_MODEL`), or Settings → "המוח של אלכס". The instructions live in `agent/AGENTS.template.md` (rendered to `agent/AGENTS.md`)
(`CLAUDE.md` and `GEMINI.md` are links). Adapters (`lib/agents/`):

| Agent | How it is restricted | Gaps |
|---|---|---|
| `claude-code` | `claude -p` with an allow list (`mesimot`, read of `agent/` and `files/`, write of `agent/memory` and `agent/tmp`) and a deny list for redirections and substitutions | none known; the reference adapter |
| `codex` | `codex exec`, `workspace-write` sandbox in `agent/`, approvals off, network only for the local CLI | no per-command allow list: the model could run other shell commands inside the sandbox; the code-side gate and validation still apply |
| `gemini` | `gemini -p` with a per-run settings file limiting core tools to `run_shell_command(mesimot)` and file tools | file tools are not limited to directories; tools are auto-approved (no one to ask) |

### Model routing (save tokens)

Every kind of run (`chat`, `batch` = email and files, `reconcile`, `curator`, `pulse`, `names`, `gate`, `facts`) has its own model and effort per adapter: `agent_models` in the config, editable in Settings. Default `sonnet` / `medium` for Claude Code; a job moves to a smaller model (e.g. `pulse` → `haiku`/`low`, optional `fallback`) only when its scenarios pass on it. The model and effort of every run are recorded and shown on the activity screen. Benchmark override: `MESIMOT_JOB_MODELS="pulse=haiku:low:sonnet"`.

Only `claude-code` is verified against a real agent today; the others are covered by unit tests with fake binaries. To compare agents run the scenario
suite with each: see `docs/COMPARING_AGENTS.md`.

**Interactive mode:** open your agent in the repository root; it reads `AGENTS.md` (root) and `agent/AGENTS.template.md` (rendered to `agent/AGENTS.md`), and works through the `mesimot` CLI
(`mesimot task list`, `mesimot search ...`, `mesimot apply ...`). The same code-side validation applies.

## Operate

| Timer / service | What |
|---|---|
| `mesimot`, `mesimot-runner` | the site; the mailbox poller, Telegram bot and agent runner |
| `mesimot-watchdog.timer` (5 min) | checks services, heartbeats, site; restarts once, then alerts you |
| `mesimot-pulse.timer` | daytime pulse (code finds items; the agent writes one message or stays silent) |
| `mesimot-reconcile.timer`, `mesimot-daily.timer`, `mesimot-curator.timer` | reconciliation, morning reminders, weekly memory tidy |
| `mesimot-housekeeping.timer` (03:00) | verified mailbox cleanup, disk check, log rotation, VACUUM; files are never deleted automatically |
| `mesimot-backup.timer` (03:30) | encrypted SQLite backup to `backups/` (30 days) |

Status: Settings → "מצב המערכת". Logs: `journalctl --user -u mesimot-runner`. Run logs: `data/runs/`.
**Restore:** stop the services, `cp backups/mesimot-YYYY-MM-DD.db data/mesimot.db` (backups are encrypted with the same key as the database, so `~/.config/mesimot/db.key` must be present), start them. Files (`files/`) are not in the DB backup: back them up separately. Everything on disk is encrypted: see `docs/ENCRYPTION.md` (and back up the key file separately: without it nothing can be read).

## Security model

* The agent runs headless with a tool allow-list per adapter (the `mesimot` CLI, read of its own directory and the archive, write of its memory).
* Email, attachments and web pages are **untrusted data**: they are wrapped as data in every prompt; the web research run has no access to your data at all.
* Everything that matters is checked **in code** (context requirements, one-transaction `apply`, the gate); every change is logged and undoable.
* Mail providers work in a scoped set of folders; nothing is deleted without a verified local copy; the system only emails the owner.
* Secrets live only in `~/.config/mesimot/env` (mode 600); the site needs a login; the API token is for the local CLI.

## Limitations

* The reference adapter is Claude Code; the Codex and Gemini adapters are covered by tests with fake binaries but are less restricted (see the table below).
* Hebrew is the only UI language. The assistant's instructions are written for a construction-project manager and can be adapted in `agent/AGENTS.template.md`.
* Single user, single machine (SQLite). Voice and semantic search need a few GB of local models.
* Cost depends on your agent plan: Mesimot records tokens and an API-equivalent cost estimate and backs off when a usage limit is hit, but it cannot raise your limits.

## Develop

`npm test` (no agent needed) · `npm run scenarios` (real agent, throw-away DB) · `scripts/testenv.sh start` (test instance on port 8111). Design: `docs/ARCHITECTURE.md`.

## License

MIT, see `LICENSE`.
