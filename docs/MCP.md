# Built-in tools (MCP) for the assistant

The assistant operates the system through typed tools instead of shell commands. **Nothing needs to be configured:** the server is in this repository (`bin/mesimot-mcp`, no extra dependency), and every
run gets its tool configuration generated for it. The plan and the reasons are in [MCP-PLAN.md](MCP-PLAN.md); this file is the short operating guide.

## What it is

* `bin/mesimot-mcp` is a stdio MCP server (newline-delimited JSON-RPC 2.0: `initialize`, `ping`, `tools/list`, `tools/call`), one process per assistant run, stateless. It never opens the database: every tool is one or two calls of the local HTTP API (`/api/*`) with the assistant's own token (`MESIMOT_TOKEN`, or `~/.config/mesimot/env`, exactly like the CLI), so every validation gate, confirmation, audit entry, undo and recycle-bin path stays on the server.
* `lib/mcp/tools.js` is the one place that defines the tools. `lib/mcp/validate.js` checks the arguments before any call (type, enum, pattern, ranges, `additionalProperties`; it also turns `"104"` into `104`, `"true"` into `true`, a JSON text into an array or object, `"5,6"` into `[5, 6]`) and every error names the field and shows a correct example. `lib/mcp/api.js` is the HTTP side, `lib/mcp/mode.js` the switch and the profile of each job.
* Results are compact JSON, cut at 20,000 characters (`...[cut: N more characters; call again with offset=M]`; `show` has `offset` and `max_chars`).
* Errors are an `isError` result with one plain text: a validation error (before any call), `The server refused (HTTP 4xx): <the Hebrew text of the server>`, or `The server is not reachable right now (...). Nothing was changed.`. The process never exits on bad input.
* The token is never written to a configuration, a log or an argument list. Every call carries the headers `X-Mesimot-Via: mcp` and `X-Mesimot-Run: <run id>`; the server counts the refusals it gives to such calls (table `mcp_errors`, one line in the health check, `scripts/mcp-report.js`).
* No owner or administrator action is a tool: `sql`, `web-password`, `rekey`, `backup`, `vault`, `connector publish`, `style analyse|try`, `project add`, `init-config`, `render-agent`, `calendar-token`, `telegram bind`, `push test`. Deleting only ASKS the owner (`confirm`).

## The switch and the rollback

Setting `agent_mcp` (Settings, "כלים מובנים (MCP)"), overridden by the environment variable `MESIMOT_MCP`. It is read on every run: a change applies to the next run, no restart, no deploy.

| Value | Meaning |
|---|---|
| `off` | CLI only, as before. |
| `chat` | Tools for the jobs with the `full` profile (chat, batch, reconcile, curator, pulse, gate). The shell `mesimot` stays as a fallback. |
| `all` | Tools for every job that may run commands (also import, names, facts, profile). The shell stays as a fallback. |
| `only` | Tools and NO shell, in every adapter where that is possible. The instruction file is written without CLI vocabulary. |

A new installation (a database with no runs) starts on `all`; an installation that already has runs starts on `off`. The first start of the server or the runner decides once and stores it, so a
later change of the data never flips it. Rollback: set the dropdown to `off`; the next run uses the CLI (hard rollback: `scripts/deploy.sh <previous commit>`).

Jobs without commands (triage, audit, style, style_draft, the isolated web run) never get tools.

## Profiles

| Profile | Jobs | Tools |
|---|---|---|
| `full` | chat, batch, reconcile, curator, pulse, gate | all |
| `import` | import, import_lite, import_fyi | the 14 read tools (`show`, `task_list`, `search`, `ask`, `project_list`, `person_find`, `chat_list`, `pending`, `attention_list`, `calendar_list`, `outbox_list`, `trash_list`, `file_list`, `style_for`), `apply`, `run_summary`, and the writes these jobs were seen to use: `draft_add`, `note_add`, `person_add`, `person_update`, `person_merge`, `style_check` |
| `apply_only` | profile backfill, names, facts | the same 22 tools |

(The first version of the two small profiles had only 9 and 7 tools; the scenario run showed an import job asking for `style_for`, and the CLI log showed `draft add` and `person merge`, so they were widened. The lists are `READ_TOOLS` and `BACKGROUND_TOOLS` in `lib/mcp/tools.js`.)

The runner chooses the profile from the job name (`JOB_PROFILE` in `lib/mcp/mode.js`) and passes it to the server in `MESIMOT_MCP_PROFILE`.

## The instruction files

`agent/AGENTS.template.md` has marked blocks: `<!--CLI-->` (shell wording), `<!--MCP-->` (tool wording), `<!--SHELL-->` (inside MCP: the shell fallback) and `<!--ONLY-->`. The rules are written once, outside the blocks. The runner renders the file that the
current adapter reads (`CLAUDE.md`, `AGENTS.md` for Codex, `GEMINI.md`) with the wording of the switch and records the state in `agent/tmp/.instructions`; the other files stay CLI. In `only` every `` `mesimot <command> ...` `` is written as the tool name.
The prompts that explain how to call `apply` and `run-summary` use `howTo()` from `lib/mcp/mode.js`. A table "if it says `mesimot X Y`, call the tool" keeps the many CLI mentions in gate questions and system messages valid.

## How each adapter attaches the server (phase 0, proven on this server)

**Claude Code 2.1.321: verified end to end** (model haiku, a tiny test server). The working flags, with an inline configuration and nothing else:

```
claude -p "<prompt>" --model haiku --tools Bash --allowedTools 'Bash(mesimot:*)' mcp__mesimot \
  --disallowedTools 'Bash(*>*)' 'Bash(*<*)' 'Bash(*`*)' 'Bash(*$(*)' --permission-mode dontAsk --max-turns 5 \
  --output-format stream-json --verbose --setting-sources project --strict-mcp-config \
  --mcp-config '{"mcpServers":{"mesimot":{"command":"<node>","args":["<repo>/bin/mesimot-mcp"],"env":{"MESIMOT_MCP_PROFILE":"full","MESIMOT_RUN_ID":"12"}}}}' --no-session-persistence
```

The init event shows `"tools":["Bash","mcp__spk__add_numbers"],"mcp_servers":[{"status":"connected"}]` and the model called the tool (2 turns). Negative control: without the `mcp__<server>` allow rule the call is refused (`permission_denied`, `dontAsk`), so the rule is required.
`--tools` limits the built-in tools only; MCP tools are not in it. In `only` the adapter passes no Bash at all (`--tools Read,Edit,Write`).

**Codex 0.148: verified with a local stand-in model** (the login of this server's Codex has an expired refresh token, so a real model call was not possible). A fake Responses endpoint was set as the model provider (`-c model_provider=...`,
a temporary `CODEX_HOME`); Codex started the server from `-c` overrides, listed all 72 tools to the "model" as `mcp__mesimot/<tool>`, executed the tool call the stand-in asked for (`mcp_tool_call` item, result returned to the model), and the server read the token from the env file (Codex does not forward the environment). The overrides:

```
-c mcp_servers.mesimot.command="<node>" -c mcp_servers.mesimot.args='["<repo>/bin/mesimot-mcp"]' -c mcp_servers.mesimot.env='{"MESIMOT_MCP_PROFILE"="full","MESIMOT_RUN_ID"="12"}'
-c mcp_servers.mesimot.default_tools_approval_mode="approve" -c mcp_servers.mesimot.startup_timeout_sec=30 -c mcp_servers.mesimot.tool_timeout_sec=180
```

`only`: `-c features.shell_tool=false -c features.unified_exec=false` removes `exec_command` and `write_stdin` from the model's tools (89 tools become 87: the MCP tools, `update_plan`, `view_image`, the MCP resource readers and the sub-agent tools stay). Codex still edits files with its own patch tool in the `workspace-write` sandbox, as before.

**Gemini CLI 0.71.1: the server loads (`gemini mcp list`: "mesimot ... Connected"); a model call is UNVERIFIED** (no Google login on this server; check it once with `deploy/check-agent.sh gemini` after signing in). The adapter writes `mcpServers.mesimot` (with `trust: true`) and the tool allowlist into the per-run system settings file. **Finding:** Gemini 0.71 skips a system settings file whose directory is not owned by root ("Security Warning: Skipping system settings file ... is insecure"), so the restrictions of the existing adapter were not applied on this version; the adapter now also writes the same settings to `agent/.gemini/settings.json` (project settings, git-ignored) and sets `GEMINI_CLI_TRUST_WORKSPACE=true` (without it the project's MCP servers are disabled). In `only` the allowlist has no `run_shell_command`.
The names of MCP tools in Gemini's `stats.tools` are normalised to `mcp__mesimot__<tool>` when they contain the server name (the exact prefix of this version is unverified).

## The tools

Names are `mcp__mesimot__<name>`. The CLI column is the parity table: the test `test/mcp-parity.test.js` parses `bin/mesimot` and fails when a command is neither covered here nor on the owner-only list (`CLI_ONLY` in `lib/mcp/tools.js`).

| Tool | What it does | Profiles | CLI commands it covers |
|---|---|---|---|
| `show` | Open one item in full: task, email, email_thread, file, chunk, knowledge, protocol, project or person. Long text: use offset and max_chars. | full, import, apply_only | `show task`, `show email`, `show knowledge`, `show chunk`, `show file`, `email show`, `email thread`, `project show`, `person show`, `protocol show`, `task show` |
| `task_list` | List tasks. Filters: open, project, assignee, requester, status, priority, person, q (text), stale_days, overdue, include_hidden, closed (the archive), from/to (last change date), limit. | full, import, apply_only | `task list` |
| `search` | Search tasks, notes, mail, files and knowledge (keyword, semantic or hybrid). | full, import, apply_only | `search` |
| `ask` | Answer a question from the knowledge base (synonyms, keyword and semantic retrieval, with file and page). | full, import, apply_only | `ask` |
| `project_list` | List projects, or find one by name or alias with "find". | full, import | `project list`, `project find` |
| `person_find` | Find people by name, email or company. | full, import | `person find`, `person list` |
| `file_list` | List stored files, optionally of one project. | full, import, apply_only | `file list` |
| `chat_list` | Recent chat messages with the owner. | full | `chat list` |
| `pending` | Events and mail waiting for you. | full | `pending` |
| `attention_list` | Reminders, questions and suggestions for the owner. | full | `attention list` |
| `calendar_list` | Calendar items (including the Outlook mirror) in a date range. | full | `calendar list` |
| `outbox_list` | Mail drafts and their status; with id, one draft in full. | full | `outbox list`, `outbox show` |
| `trash_list` | The recycle bin: what can be restored. | full | `trash list` |
| `style_for` | The owner's writing style for these recipients. Call it BEFORE any mail draft. | full | `style for` |
| `apply` | The structured answer: decisions, new_tasks, facts, resolutions, chat_message, summary... in ONE call. dry=true only validates. | full, import, apply_only | `apply` |
| `run_summary` | End every run with one short Hebrew line about what you did. | full, import, apply_only | `run-summary` |
| `task_create` | Create a task. Dates YYYY-MM-DD; status and priority by name. | full | `task add` |
| `task_update` | Change fields of a task (only the ones you give). null clears assignee, requester, due, source_date or parent. | full | `task update` |
| `note_add` | Add a note to a task or a project. | full | `note add` |
| `draft_add` | Add a reply draft (text for the owner to copy) to a task. Never sent. | full | `draft add` |
| `chat_send` | Send ONE message to the owner (web chat and Telegram). file sends documents. | full | `chat send`, `telegram send` |
| `person_add` | Add a person (status partial when only a name is known). | full | `person add` |
| `person_update` | Change a person (only the fields you give). | full | `person update` |
| `person_merge` | Merge a duplicate person into another (cannot be undone: be certain). | full | `person merge` |
| `project_propose` | Propose a new project; the owner approves it. You cannot create one. | full | `project propose` |
| `project_update` | Change a project: name (the old one becomes an alias), aliases, description, status, color, summary. | full | `project update` |
| `calendar_add` | Add a calendar item (Jerusalem time). | full | `calendar add` |
| `calendar_update` | Move or change a calendar item. | full | `calendar update` |
| `calendar_delete` | Delete a calendar item (goes to the recycle bin). | full | `calendar delete` |
| `attention_add` | Add a reminder, question or suggestion for the owner. | full | `attention add` |
| `attention_update` | Set the status of an attention item. | full | `attention update` |
| `ack` | Mark events as handled. The runner normally does this; rarely needed. | full | `ack` |
| `outbox_draft` | Prepare a mail DRAFT as a card; the owner approves with a button. Run style_for first. | full | `outbox draft` |
| `outbox_update` | Change a draft (creates a new card and cancels the old approval). | full | `outbox update` |
| `outbox_cancel` | Cancel a draft. | full | `outbox cancel` |
| `style_check` | Check a mail text against the owner's style rules without saving it. | full | `style check` |
| `confirm` | ASK the owner to confirm a deletion. Nothing is deleted until he presses yes; then it goes to the recycle bin (trash_delete and trash_empty are permanent). | full | `confirm task-delete`, `confirm project-delete`, `confirm person-delete`, `confirm protocol-delete`, `trash delete`, `trash empty` |
| `trash_restore` | Restore an item from the recycle bin with everything it held. | full | `trash restore` |
| `person_resolve` | Give a verdict on a partial person: into = merge into this full person, or complete it with name, emails, company, role_text. | full | `person resolve` |
| `project_merge` | Merge a duplicate project into another (its tasks move). | full | `project merge` |
| `project_resolve` | Give a verdict on a vague project: into = merge into this project, or complete it with name, aliases, description. | full | `project resolve` |
| `project_pending` | Projects you proposed that wait for the owner (and the rejected names). | full | `project pending` |
| `project_profile` | The project passport (buildings, floors, units, track, contractor, architect). With no field: show it. With fields: set them (as_of and source required). | full | `project profile` |
| `project_status` | The latest status of one process (design, permit, construction, marketing). With no text: show all of them. | full | `project status` |
| `fact_set` | Set a dated fact on the project card (a newer value supersedes the old one). | full | `fact set` |
| `fact_list` | The facts of a project card (history = all values over time). | full | `fact list` |
| `fact_topic` | Set the topic of a fact, by id or by project and key. | full | `fact topic` |
| `knowledge_list` | Saved knowledge items, optionally of one project. | full | `knowledge list` |
| `knowledge_add` | Save a durable piece of knowledge about a project. | full | `knowledge add` |
| `knowledge_update` | Change a knowledge item. | full | `knowledge update` |
| `knowledge_supersede` | Replace a knowledge item by a new one (or by an existing one with "by"). | full | `knowledge supersede` |
| `file_classify` | Set the project, task or summary of a stored file. | full | `file classify` |
| `protocol_list` | Meeting minutes, optionally of one project. Open one with show kind protocol. | full | `protocol list` |
| `protocol_add` | Add meeting minutes (without items; prefer apply with protocols, which adds everything at once). | full | `protocol add` |
| `protocol_item_add` | Add an item (action, decision, info) to meeting minutes. | full | `protocol item add` |
| `protocol_item_update` | Change a minutes item. | full | `protocol item update` |
| `protocol_item_action` | promote = make a linked task from the item; done; dismiss. | full | `protocol item promote`, `protocol item done`, `protocol item dismiss` |
| `filter_list` | The owner's mail filters. | full | `filter list` |
| `filter_add` | Add a mail filter (one of sender, domain, text, regex; action skip, fyi or relevant). Returns the rule and how many of the last 30 days' mails it matches. | full | `filter add` |
| `filter_preview` | How many mails of the last 30 days a filter would match, without adding it. | full | `filter preview` |
| `filter_delete` | Delete a mail filter (goes to the recycle bin). | full | `filter delete` |
| `filter_update` | Switch a mail filter on or off. | full | `filter enable`, `filter disable` |
| `mail_archive` | The old Outlook mail archive: status, failed items, retry, or an estimate (emails, full_share). | full | `archive status`, `archive failed`, `archive retry`, `archive estimate` |
| `telegram_status` | Whether Telegram is configured and bound to the owner. | full | `telegram status` |
| `push_status` | Web push: the subscribed devices. | full | `push status` |
| `usage` | Assistant usage and API-equivalent cost (days, by kind or model). | full | `usage` |
| `health` | The latest system health checks (read-only; the browser smoke test is run by the system itself). | full | `health` |
| `style_list` | The writing styles and their rules. | full | `style list` |
| `style_show` | One writing style in full. | full | `style show` |
| `style_feedback` | What the owner changed in your earlier drafts to these recipients. | full | `style feedback` |
| `style_suggest` | Suggest a change to a style rule; the owner accepts it in Settings. You cannot change rules. | full | `style suggest` |
| `outbox_submit` | Submit a draft that was saved without a card. | full | `outbox submit` |

Deviations from the CLI worth knowing: `health` returns the stored result of the system checks (the CLI runs a browser smoke test and is refused to the assistant); `push_status` and `health` were refused to the assistant by the CLI (`MESIMOT_AGENT_MODE`) and are read-only here; `filter_add` returns the rule and the 30-day preview like the CLI; dates accept `YYYY-MM-DD` and `DD/MM/YYYY`, as the server does.

## Measuring

`node scripts/mcp-report.js [--days N] [--json]` prints, per day and job: runs, calls by tool, refused Bash calls, tool errors seen by the model, the share of actions done through MCP versus the shell, tokens and cost per run, and the server refusals. The health check has one non-alerting line, "MCP: שגיאות כלים ב-24 שעות". Tool calls of all three adapters are logged as `mcp__mesimot__<tool>`.

## How to add a tool

1. One entry in `lib/mcp/tools.js` (`tool({ name, description, schema, example, profiles, call })`; keep the description to one line: the list is sent on every run) and its commands in the `CLI` table.
2. One case and one refusal case in `test/mcp-tools.test.js` (a coverage test fails without them).
3. One real call in `test/mcp-integration.test.js` (it fails when a tool was never called).
4. A row in the CLI-to-tool table of `agent/AGENTS.template.md` (block `<!--MCP-->`).
5. If a new CLI command exists, the parity test tells you; if it is owner-only, add it to `CLI_ONLY`.

## Known gaps

* A model call through Gemini is unverified (see above); Codex was verified with a stand-in model only.
* Codex cannot be limited to particular directories or commands (as before); `only` removes its shell tools.
* In `only`, a few `mesimot` words remain in the tool-vocabulary instructions where a command was written across lines.
