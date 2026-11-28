# Plan: a built-in MCP server for the assistant

Status: approved for implementation. Phases 0 to 5 are implemented and deployed with the switch OFF. Turning it on (phase 6) is a separate step after review.

## 1. Why

Today the assistant operates the system through the `mesimot` CLI. Every action is a shell string such as `mesimot task update 104 --due 2026-11-29`.
The Claude Code permission rules allow only strings that start with `mesimot` and contain no `cd`, `&&`, `;`, pipe, redirect or `$(`.

Numbers from the run logs (`data/runs/*.tools.json`, about 2,000 runs):

* **Shell use.** About 4,200 Bash calls, and about 2,000 of them contained `cd`, `&&`, `;`, `|`, `<` or `>`. Many `;` and `|` sit inside quoted Hebrew text, but about 400 started with `cd ... &&`.
* **Refusals.** About 590 tool calls were refused by the permission system, in about 410 runs (roughly 1 run in 5). Some of these runs did nothing and answered in English (run 900).
* **The `apply` detour.** `apply` is the most used command (about 1,600 times). It needs a Write of `tmp/apply.json` and then a Bash call, or a one-line `--json '<...>'` where an apostrophe in Hebrew text breaks the quoting. The prompts even tell the model to write ׳ instead of '.
* **The safety net.** Commit 5235862 retries a run once after a refused command. That is a safety net, not a fix.

With MCP, the model calls a typed function with JSON arguments. There is no shell, no quoting and no permission pattern to trip over.
Arguments are checked in code, and a wrong argument comes back as a clear error the model can fix in the same run.

## 2. What does not change

* **All rules stay on the server.** Every tool calls the same HTTP API (`/api/*`) with the same assistant token. Every validation gate, confirmation, audit entry, undo and recycle-bin path stays where it is. The MCP server holds no business logic and never opens the database.
* **The CLI stays.** It serves people, scripts, the Codex and Gemini adapters, and rare commands. Bash with `mesimot` stays allowed for Claude runs as a fallback.
* **No new powers.** Owner-only actions are not exposed as tools: `sql`, `web-password`, `rekey`, `backup`, `vault`, `connector publish`, `style analyse`, permanent deletion without a confirmation, and `project add` (the assistant proposes, the owner adds).
* **Jobs without commands get no MCP.** Jobs that run with `allowedCommands: []` (triage, audit, facts extraction, style, style_draft, the isolated web research run) keep no tools at all.

## 3. Architecture

```
runner pass()  ->  adapter claude-code  ->  claude -p ... --mcp-config <inline JSON> --allowedTools mcp__mesimot ...
                                               |
                                               +-- spawns: node bin/mesimot-mcp   (stdio, one process per run, stateless)
                                                        |
                                                        +-- HTTP  ->  http://127.0.0.1:8110/api/*  (Bearer = assistant token)
```

* **Files.**
  * `lib/mcp/tools.js`: the tool table. Each entry has a name, a short description, a JSON schema, a profile list, and a `call(args, api)` that maps to one or two API calls.
  * `lib/mcp/validate.js`: a small JSON-schema subset validator. It covers type, required, enum, pattern, min/max, items and additionalProperties:false, and coerces a numeric string to an integer for id fields. Each error message names the field and shows a correct example.
  * `lib/mcp/server.js`: the stdio JSON-RPC MCP server. Use `@modelcontextprotocol/sdk` (1.32.x) if it installs cleanly. Otherwise write a minimal implementation of `initialize`, `tools/list` and `tools/call` (newline-delimited JSON-RPC 2.0).
  * `bin/mesimot-mcp`: a 3-line launcher.
* **Token.** Read exactly like the CLI: `MESIMOT_TOKEN` from the environment, otherwise `readEnvFile()`. It is never written into the MCP config JSON or into any file.
* **Base URL.** `MESIMOT_URL`, the same as the CLI. The test instance uses 8111.
* **Run context.** Passed through env in the MCP config: `MESIMOT_RUN_ID`, `MESIMOT_MCP_PROFILE`. Every API call adds the headers `X-Mesimot-Via: mcp` and `X-Mesimot-Run: <id>`. The server may log them in `trace`; unknown headers are ignored.
* **Profiles.** A tool is listed only if its profile matches:

  | Profile | Jobs | Tools |
  |---|---|---|
  | `full` | chat, batch, reconcile, task/entity chat, curator, pulse, weekly memory | everything |
  | `import` | import, import_lite, import_fyi | read tools, `apply`, `run_summary`, `person_find`, `project_list` |
  | `apply_only` | profile backfill, fix names, other single-purpose apply jobs | read tools, `apply`, `run_summary` |

  The table lives in one place (`lib/mcp/tools.js`). The runner chooses the profile from the job name.
* **Output.**
  * Compact JSON text, not pretty-printed.
  * Hard cap of 20,000 characters per result. Longer output is cut, ending with `...[cut: N more characters; call again with offset=M]`.
  * Text tools (`show` of file, email or thread) accept `offset` and `max_chars`.
  * The Claude Code limit (`MAX_MCP_OUTPUT_TOKENS`) must never be hit.
* **Errors.** Errors are returned as `isError: true` with one plain text block. Three kinds:
  * Validation, before any HTTP call: `task_update: "due" must be a date YYYY-MM-DD, got "29/11". Example: {"id":104,"due":"2026-11-29"}`.
  * Server refusal (4xx): `The server refused (HTTP 400): <the Hebrew message from the API>`. The Hebrew text is kept as is, because gates phrase their questions in Hebrew.
  * Server unreachable or 5xx: `The server is not reachable right now (<reason>). Nothing was changed. Try once more; if it fails again, finish and say so in run_summary.`
* **Robustness.** The process never exits on bad input. Every handler is wrapped. Unknown tool names return an error result, not a crash.

## 4. Tool set (first version)

Names are snake_case and served as `mcp__mesimot__<name>`. The descriptions must be short, about one line each, because the whole list is sent on every run. The tool set covers what the run logs show the assistant actually does; everything else stays on the CLI.

**Read**

| Tool | Maps to | Notes |
|---|---|---|
| `show` | `/api/tasks/:id`, `/api/emails/:id`, `/api/emails/:id/thread`, `/api/files/:id/show`, `/api/chunks/:id`, `/api/knowledge/:id`, protocol, project, person show | `kind` is an enum; `offset`/`max_chars` for long text. Replaces `show *`, `task show`, `email show/thread`, `project show`, `person show`, `protocol show` (about 800 uses). |
| `task_list` | `GET /api/tasks` | The same filters as the CLI (open, project, person, status, due range, include_hidden, limit). |
| `search` | `GET /api/search` | Query plus the CLI's filters (archive, mail_archive, project, person, kind, from, to, limit, mode). |
| `ask` | `GET /api/ask` | Question and optional project. |
| `project_list` | `GET /api/projects` | Includes find by name. |
| `person_find` | `GET /api/people` | Find by name, email or company. |
| `chat_list` | `GET /api/chat` | |
| `pending` | `GET /api/pending` | |
| `attention_list` | `GET /api/attention` | |
| `calendar_list` | `GET /api/calendar` | From/to. |
| `outbox_list` | `GET /api/outbox` | |
| `trash_list` | `GET /api/trash` | |
| `file_list` | `GET /api/files` | |
| `style_for` | `GET /api/styles/for` | to, cc, reply_email, task. Must be used before any mail draft. |

**Write**

| Tool | Maps to | Notes |
|---|---|---|
| `apply` | `POST /api/apply` | The argument is the apply object itself (decisions, new_tasks, knowledge, attention, facts, resolutions, protocols, chat_message, profile, statuses, ...), plus `dry`. The schema lists the known top-level keys with short descriptions, and the server validates the content. No file and no quoting, so this removes the Write + Bash detour. |
| `run_summary` | `POST /api/run-summary` | |
| `task_create`, `task_update` | `POST /api/tasks`, `PATCH /api/tasks/:id` | Same fields as the CLI. Dates are YYYY-MM-DD; status, priority and due_source are enums taken from `/api/bootstrap` lookups at server start and cached for the run. |
| `note_add` | `POST /api/notes` | |
| `draft_add` | `POST /api/tasks/:id/drafts` | |
| `chat_send` | `POST /api/chat` | text, task ids, file ids, task_scope. |
| `person_add`, `person_update`, `person_merge` | `/api/people...` | |
| `project_propose`, `project_update` | `/api/projects...` | |
| `calendar_add`, `calendar_update`, `calendar_delete` | `/api/calendar/items...` | Date-time format checked; the CLI's argument names are kept. |
| `attention_add`, `ack` | `/api/attention`, `/api/ack` | |
| `outbox_draft`, `outbox_update`, `outbox_cancel` | `/api/outbox...` | Drafts only; the owner approves with a button. The style gate is unchanged. |
| `style_check` | `POST /api/styles/check` | |
| `confirm` | `POST /api/confirm` | `kind` is an enum: task_delete, project_delete (with tasks move/unassign/delete), person_delete, protocol_delete, trash_delete, trash_empty. The description says plainly that this only ASKS the owner and nothing is deleted until he presses yes. |
| `trash_restore` | `/api/trash/...` | |

That is about 40 tools. The exact argument names must be copied from `bin/mesimot` (the CLI is the reference) so that the instructions stay true for both paths.
Anything not in the table (protocol items, filters, facts, knowledge add and update, file classify, archive, telegram, usage, push, health) stays on the CLI in version 1. It can become a tool later if the logs show it is used.

## 5. Wiring into the Claude Code adapter

* **`buildArgs`.**
  * New option `mcp: { command, args, env }`. When it is present:
    * `--mcp-config` gets `{"mcpServers":{"mesimot":{"command":"node","args":["<abs>/bin/mesimot-mcp"],"env":{...no secrets...}}}}` instead of the empty `{"mcpServers":{}}`;
    * `--allowedTools` adds `mcp__mesimot`, which allows every tool of that server.
  * `--strict-mcp-config` stays, so no user-level MCP server can leak in.
  * Without `mcp`, the arguments are byte-for-byte what they are today; a unit test asserts this.
* **Runner `pass()`.** Adds `mcp` only when all three hold:
  * the adapter is claude-code;
  * the job's `allowedCommands` includes `mesimot`;
  * the switch says yes for this job.
* **The switch.** A setting `agent_mcp` in the `settings` table, overridden by env `MESIMOT_MCP` when it is set.
  * Values: `off` (default after deploy), `chat` (the `full` profile jobs only), `all`.
  * It is read on every pass, so a change applies to the next run with no restart and no deploy.
  * Settings → the agent section gets one dropdown, "כלים מובנים (MCP)": כבוי / צ'אט בלבד / הכול. Hebrew, same look as the other rows.
* **Codex and Gemini.** No change in version 1: CLI only. Both CLIs support MCP, which is a possible later step and out of scope here.
* **`deniedCommands`.** Stays as is. Extend it to also catch a refused `mcp__mesimot__*` call (it should never happen) so the retry covers both.

## 6. Instructions and prompts

* **Two instruction variants.** `lib/agentdoc.js` today writes `agent/AGENTS.md` and makes `CLAUDE.md` a symlink to it.
  * When the switch is not `off`, it writes `CLAUDE.md` as a real file rendered with the MCP vocabulary; `AGENTS.md` (Codex) and `GEMINI.md` stay CLI.
  * Rendering happens at runner start and again on any pass where the switch value differs from the last render. Record it in a small state file in `agent/tmp`.
* **The template.**
  * `agent/AGENTS.template.md` gets marked blocks, for example `<!--CLI-->...<!--/CLI-->` and `<!--MCP-->...<!--/MCP-->`. The renderer keeps one kind and drops the other. Only the places that teach HOW to act change: the CLI cheat sheet, the apply section, the outbox and confirm sections. The rules themselves are written once.
  * The MCP variant's cheat sheet:
    * "Use the mesimot tools. Bash with `mesimot` only for what has no tool."
    * One table, "if a message or a rule mentions `mesimot X Y`, call the tool `x_y`". This keeps the about 80 CLI mentions in gate questions, runner prompts and code messages valid without rewriting them.
* **Runner prompts.**
  * The strings that tell the model HOW to call apply or run-summary go through one helper, `howTo('apply')` and `howTo('run_summary')`. It returns the tool wording or the CLI wording for the current mode.
  * These are the strings in `lib/runner.js` that say "Write tmp/apply.json", "apply --json '<...>'", "never use an apostrophe" or "run-summary --text".
  * Other mentions stay as they are and are covered by the mapping table.

## 7. Tests

1. **Unit tests** (`test/mcp-*.test.js`, the existing fixture style).
   * Validator: every rule, the coercion, the error texts.
   * Every tool: valid args produce the right method, URL and body; invalid args give an error before any HTTP call.
   * Output cap and offset.
   * Profile filtering.
   * Unknown tool.
   * The server survives garbage input.
2. **Integration test against a real server.** Start `lib/server.js build()` on a random port with the test DB, start `bin/mesimot-mcp` as a child process over stdio, then run `initialize` and `tools/list` and call each tool for real. This proves every route and argument name exists. It is the most important test: no mocks for the HTTP side.
3. **Adapter tests.**
   * Without `mcp` the argv is unchanged.
   * With `mcp` it contains the config and the allow rule, and no token.
4. **Spike first (phase 0).** Before writing the tool set, prove on this server's Claude Code (2.1.321) that `-p` with inline `--mcp-config`, `--strict-mcp-config`, `--permission-mode dontAsk`, `--tools Bash,...` and `--allowedTools mcp__mesimot` really lets the model call a tool. Record the exact working flags in docs/MCP.md. If it does not work, stop and report; do not invent a workaround that weakens permissions.
5. **End to end on the TEST instance.**
   * Use `scripts/testenv.sh start` (port 8111, password test-password-1234) and the real assistant.
   * Run the scenario suite (`npm run scenarios`) twice, with `MESIMOT_MCP=off` and with `MESIMOT_MCP=all`. Compare pass rate, turns, tokens and time per scenario.
   * Then run these chat requests through the runner with the switch on:
     * add a calendar item tomorrow 11:00 linked to a task;
     * set a task's due date;
     * create a task in a project;
     * add a note to a task;
     * search a topic and answer;
     * draft a mail to an example person (the style gate must run);
     * ask to delete a task (it must only ask the owner);
     * restore something from the trash;
     * a message with Hebrew text containing an apostrophe and quotes;
     * an import of 2 example emails through the normal intake.
   * For each run, read its `tools.json`: tools were used, Bash only where no tool exists, zero refused calls.
6. **The full suite must pass.** `test/offsite.test.js` is known to be flaky only in parallel runs. Also run `scripts/test-settings-ui.js` for the new dropdown.

## 8. Rollout

* **Phases 0 to 5 (implementer).** Build, test and deploy with `agent_mcp=off`, so nothing changes for the owner. Then stop and report.
* **Phase 6 (after review).** Switch to `chat` for 1 to 2 days, then `all`. The review is done separately, outside this plan.
* **Measure during rollout.** `scripts/mcp-report.js [--days N]` reads the run logs through `lib/vault.js` and prints, per day and per job:
  * runs;
  * tool calls by name;
  * tool errors (validation or server refusal);
  * refused Bash calls;
  * the share of actions done via MCP versus Bash;
  * tokens and cost per run.

  The health check gets one non-alerting line: "MCP: tool errors in the last 24 hours".
* **Rollback.**
  * Normal: set the dropdown to כבוי; the next run uses the CLI.
  * Hard: deploy the previous commit with `scripts/deploy.sh`.

### Success criteria (to switch from `chat` to `all`, and to keep it on)
* Refused calls: from about 1 run in 5 down to under 1 in 50.
* The scenario suite passes at least as well with MCP as with the CLI.
* Tokens per chat run rise by at most 15% (the tool list is sent every run; keep the descriptions short).
* No tool error without the model recovering in the same run, in more than 1 of 20 runs.

## 9. Risks

| Risk | Answer |
|---|---|
| The tool list costs tokens on every run | Short descriptions, profiles per job, measured in the scenario comparison. |
| The model keeps using Bash out of habit | Bash still works, so this is only a measurement. The MCP instruction variant leads with the tools. |
| The MCP process crashes mid-run | It is stateless and every handler is wrapped. The model can fall back to the CLI, and the error is visible in the logs. |
| Argument names drift from the CLI | The integration test calls the real server; the CLI is the reference for names. |
| Hidden secret leak | The token is only read from env or the env file inside the process. The adapter test asserts the token never appears in argv or the config JSON. |
| Two runs at once | One MCP process per run, no shared state. |

## 10. Deliverables
* `lib/mcp/`, `bin/mesimot-mcp`, tests, adapter and runner changes, `agentdoc` variants, template blocks, the Settings dropdown, `scripts/mcp-report.js` and the health line.
* `docs/MCP.md`, short and for the owner and future contributors:
  * what the server is;
  * the tool list;
  * the profiles;
  * the switch and rollback;
  * how to add a tool (one entry in `tools.js`, one unit test, one line in the integration test, one line in the CLI-to-tool table).
* Commits on a branch in a git worktree, merged into main and deployed through the deploy lock with the switch OFF. No push to GitHub.
