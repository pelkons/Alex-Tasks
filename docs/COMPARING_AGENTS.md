# Comparing agents with the scenario suite

The scenario suite (`scripts/scenarios.js`) drives the **real** agent on a throw-away test database (own DB, files, memory, port 8111; it never
touches your data). Because correctness lives in code (gate, context, apply validation), the suite measures what differs between agents: how often
they slip, how many gate rounds they need, how long they take.

```bash
npm run scenarios -- --agent=claude-code
npm run scenarios -- --agent=codex  --model=<model name your CLI accepts>
npm run scenarios -- --agent=gemini
SCENARIOS=18,19,20 npm run scenarios -- --agent=codex     # a subset
```

Each agent must be installed and logged in by you (`deploy/check-agent.sh <agent>`). Every run writes `benchmarks/<agent>-<timestamp>.json`:
scenarios passed, total seconds, assistant runs and average run time, re-prompts for missing decisions, and the **gate statistics** (violations raised,
resolved after a question, accepted unresolved, per invariant: project, requester, dates, people, language, duplicates, ...).

How to read it: *passed/total* is the headline; then *raised* (how often the agent slipped before the gate), *resolved* (the gate's question fixed it),
*accepted* (still wrong after two rounds: these would show a "דורש בדיקה" badge), and *seconds* (cost proxy). Scenarios 18-20 deliberately run with a
stripped instructions file, so they measure the agent's behaviour without the rules and the gate's catch rate. Repeat each agent 2-3 times: model output varies.
