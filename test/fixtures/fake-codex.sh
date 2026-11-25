#!/usr/bin/env bash
# stands in for `codex exec`: records its arguments, writes the last message where --output-last-message says, prints JSONL events
echo "$@" > "$FAKE_ARGS_FILE"
while [ $# -gt 0 ]; do case "$1" in --output-last-message) out="$2"; shift 2;; *) shift;; esac; done
printf '%s\n' '{"type":"item.completed","item":{"type":"command_execution","command":"mesimot task list"}}' '{"type":"item.completed","item":{"type":"agent_message","text":"בוצע"}}' '{"type":"turn.completed","usage":{"input_tokens":11,"output_tokens":5}}'
[ -n "$out" ] && printf 'סיכום סופי' > "$out"
