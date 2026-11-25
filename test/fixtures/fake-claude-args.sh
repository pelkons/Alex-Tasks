#!/usr/bin/env bash
echo "$@" > "$FAKE_ARGS_FILE"
echo '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"mesimot task list"}}]}}'
echo '{"type":"result","is_error":false,"num_turns":3,"result":"סיימתי","usage":{"input_tokens":9,"output_tokens":4}}'
