# Mesimot (משימות)

A Hebrew-only task board that an AI coding agent operates for its owner. This file is for any coding agent opened inside this repository
(Claude Code reads it as CLAUDE.md, Gemini CLI as GEMINI.md: both are links to this file).

- The assistant's own rules, the data model it works with and the structured answer format are in `agent/AGENTS.md`. Read that first when you are asked to
  operate the system ("Operating the system interactively" there).
- Everything that matters for correctness is CODE, independent of which agent runs: context gathering (`lib/context.js`), `mesimot apply`
  validation (`lib/apply.js`), the validation gate (`lib/gate.js`), entity resolution (`lib/entities.js`). The agent adapters live in `lib/agents/`.
- Operate the system only through the `mesimot` CLI (`bin/mesimot`), never by editing the database. Developing: `npm test` (unit tests, no agent needed),
  `npm run scenarios -- --agent=<claude-code|codex|gemini>` (real-agent regression suite on a throw-away test database, also the benchmark).
- Layout: `lib/` server and logic, `bin/` entry points, `public/` the web app (no build step), `agent/` the assistant's instructions and memory, `deploy/` installer and
  systemd units, `config/` this installation's settings, `docs/` operating notes. Secrets live in `~/.config/mesimot/`, never in the repo.
