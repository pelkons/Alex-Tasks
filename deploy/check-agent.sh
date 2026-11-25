#!/usr/bin/env bash
# Checks that the coding agent you chose is installed and that YOU are logged in, with one tiny headless call (it uses your own account and
# your own quota). Usage: deploy/check-agent.sh claude-code|codex|gemini
set -uo pipefail
a="${1:-${MESIMOT_AGENT:-claude-code}}"
case "$a" in
  claude-code) bin=claude; cmd=(claude -p "Reply with the single word OK" --max-turns 1);;
  codex)       bin=codex;  cmd=(codex exec --skip-git-repo-check --sandbox read-only "Reply with the single word OK");;
  gemini)      bin=gemini; cmd=(gemini -p "Reply with the single word OK");;
  *) echo "usage: $0 claude-code|codex|gemini"; exit 2;;
esac
command -v "$bin" >/dev/null || { echo "$a: '$bin' is not installed. Install it from the vendor's official instructions, then run it once to log in."; exit 1; }
echo "$a: running one tiny headless call with your own login..."
out="$(timeout 120 "${cmd[@]}" 2>&1)" && echo "$out" | grep -qi "ok" && { echo "$a: installed and logged in"; exit 0; }
echo "$a: the call did not succeed. Run '$bin' once by hand and log in; then try again. Output:"; echo "$out" | tail -5; exit 1
