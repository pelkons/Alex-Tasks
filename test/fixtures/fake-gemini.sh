#!/usr/bin/env bash
echo "$@" > "$FAKE_ARGS_FILE"
[ -n "$GEMINI_CLI_SYSTEM_SETTINGS_PATH" ] && cp "$GEMINI_CLI_SYSTEM_SETTINGS_PATH" "$FAKE_SETTINGS_COPY"
echo '{"response":"תשובה מג׳מיני","stats":{"models":{"m":{"tokens":{"prompt":20,"candidates":7}}},"tools":{"byName":{"run_shell_command":{"count":2}}}}}'
