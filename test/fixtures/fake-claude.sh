#!/usr/bin/env bash
# Stands in for `claude -p`: prints the reply from $FAKE_CLAUDE_REPLY as a stream-json result.
python3 - <<'PY'
import json, os
print(json.dumps({"type": "result", "subtype": "success", "is_error": False, "num_turns": 1, "result": os.environ.get("FAKE_CLAUDE_REPLY", "")}))
PY
