#!/usr/bin/env bash
# Separate test instance: own DB, files, agent memory and port (8111). Never touches data/mesimot.db. The test database is encrypted with its own throw-away key ($T/db.key).
#   scripts/testenv.sh start [--runner]   stop   env
T=/tmp/mesimot-test
root="$(cd "$(dirname "$0")/.." && pwd)"
case "${1:-env}" in
  start)
    "$0" stop >/dev/null 2>&1
    rm -rf "$T"; mkdir -p "$T/files" "$T/runs" "$T/agent/memory"
    mkdir -p "$T/bin"; ln -sf "$root/bin/mesimot" "$T/bin/mesimot"; export MESIMOT_BIN_DIR="$T/bin" PATH="$T/bin:$PATH" # the assistant must run THIS tree's CLI, not an installed one
    node "$root/bin/mesimot" render-agent --dir "$T/agent" >/dev/null
    printf '# Owner\n(empty)\n' > "$T/agent/memory/owner.md"; printf '# People\n- אבי כהן and יעל רוזן: the owner'"'"'s bosses.\n' > "$T/agent/memory/people.md"; printf '# Projects\n(no projects yet)\n' > "$T/agent/memory/projects-index.md"
    export MESIMOT_DB_KEY_FILE="$T/db.key" MESIMOT_OUTBOX_KEY_FILE="$T/outbox-sign.key" MESIMOT_LOCK="$T/runner.lock" MESIMOT_DB="$T/test.db" MESIMOT_FILES="$T/files" MESIMOT_PORT=8111 MESIMOT_AGENT_DIR="$T/agent" MESIMOT_RUN_LOG="$T/runs" MESIMOT_URL=http://127.0.0.1:8111 MESIMOT_POLL_EMAIL=0 MESIMOT_TELEGRAM=0 MESIMOT_PUSH_DRYRUN=1 MESIMOT_MAIL_ENV_FILE=/nonexistent MESIMOT_QUIET_S="${MESIMOT_QUIET_S:-5}"
    echo "test-password-1234" | node "$root/bin/mesimot" web-password --stdin >/dev/null
    nohup node "$root/bin/mesimot-server" > "$T/server.log" 2>&1 &
    echo $! > "$T/server.pid"
    if [ "${2:-}" = "--runner" ]; then nohup node "$root/bin/mesimot-runner" > "$T/runner.log" 2>&1 & echo $! > "$T/runner.pid"; fi
    sleep 2; curl -s http://127.0.0.1:8111/healthz; echo ;;
  stop)
    for f in "$T/server.pid" "$T/runner.pid"; do [ -f "$f" ] && kill "$(cat "$f")" 2>/dev/null; done; rm -f "$T"/*.pid ;;
  env)
    echo "export MESIMOT_DB_KEY_FILE=$T/db.key MESIMOT_LOCK=$T/runner.lock MESIMOT_DB=$T/test.db MESIMOT_FILES=$T/files MESIMOT_URL=http://127.0.0.1:8111 MESIMOT_AGENT_DIR=$T/agent MESIMOT_WEB_PASSWORD=test-password-1234 BASE_URL=http://127.0.0.1:8111 NODE_PATH=$root/node_modules" ;;
esac
