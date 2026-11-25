#!/usr/bin/env bash
# stands in for `claude -p`: records its arguments (one file per call) and prints the N-th reply of $FAKE_REPLIES (separated by '||'), N counted in $FAKE_COUNTER
n=$(( $(cat "$FAKE_COUNTER" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$FAKE_COUNTER"
echo "$@" > "$FAKE_ARGS_PREFIX.$n"
python3 - "$n" <<'PY'
import json, os, sys
n = int(sys.argv[1]); replies = os.environ.get("FAKE_REPLIES", "").split("||")
print(json.dumps({"type": "result", "is_error": os.environ.get("FAKE_ERROR") == "1", "num_turns": 2, "result": replies[min(n, len(replies)) - 1]}))
PY
