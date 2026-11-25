#!/usr/bin/env bash
# restart only the TEST server (port 8111) so it loads the working tree
T=/tmp/mesimot-test; root="$(cd "$(dirname "$0")/.." && pwd)"
[ -f $T/server.pid ] && kill "$(cat $T/server.pid)" 2>/dev/null; sleep 1
export MESIMOT_LOCK="$T/runner.lock" MESIMOT_DB="$T/test.db" MESIMOT_FILES="$T/files" MESIMOT_PORT=8111 MESIMOT_AGENT_DIR="$T/agent" MESIMOT_RUN_LOG="$T/runs" MESIMOT_URL=http://127.0.0.1:8111 MESIMOT_POLL_EMAIL=0 MESIMOT_TELEGRAM=0 MESIMOT_MAIL_ENV_FILE=/nonexistent
nohup node "$root/bin/mesimot-server" > $T/server.log 2>&1 & echo $! > $T/server.pid; sleep 2; curl -s localhost:8111/healthz; echo
