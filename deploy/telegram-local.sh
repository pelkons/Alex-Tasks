#!/usr/bin/env bash
# Local Telegram Bot API server (lifts the bot's file limit from 20 MB to 2 GB).
#   deploy/telegram-local.sh status    what is ready and what is missing (never prints the hash)
#   deploy/telegram-local.sh enable    start the local server (needs TELEGRAM_API_ID and TELEGRAM_API_HASH in ~/.config/mesimot/env)
#   deploy/telegram-local.sh switch    log the bot out of the cloud API ONCE, point the bot at the local server, restart the runner
#   deploy/telegram-local.sh rollback  point the bot back at the cloud API (it may need ~10 minutes after a logOut)
set -euo pipefail
ENV="$HOME/.config/mesimot/env"
has() { grep -qE "^\s*$1\s*=\s*\S" "$ENV" 2>/dev/null; }
val() { grep -E "^\s*$1\s*=" "$ENV" | head -1 | sed -E 's/^[^=]*=\s*//; s/^["'"'"']|["'"'"']$//g'; }
healthy() { curl -s -m 4 -o /dev/null -w '%{http_code}' http://127.0.0.1:8081/ 2>/dev/null | grep -qE '^[0-9]{3}$' && [ "$(curl -s -m 4 -o /dev/null -w '%{http_code}' http://127.0.0.1:8081/ 2>/dev/null)" != "000" ]; }
case "${1:-status}" in
  status)
    for k in TELEGRAM_BOT_TOKEN TELEGRAM_API_ID TELEGRAM_API_HASH TELEGRAM_API_BASE; do has "$k" && echo "$k: set" || echo "$k: MISSING"; done
    systemctl --user is-active mesimot-botapi 2>/dev/null | sed 's/^/mesimot-botapi: /' || true
    healthy && echo "local server: answers on 127.0.0.1:8081" || echo "local server: not answering"
    ;;
  enable)
    has TELEGRAM_API_ID && has TELEGRAM_API_HASH || { echo "TELEGRAM_API_ID and TELEGRAM_API_HASH are missing in $ENV (get them at my.telegram.org)"; exit 1; }
    mkdir -p "$HOME/mesimot/data/botapi"
    systemctl --user daemon-reload && systemctl --user enable --now mesimot-botapi
    for i in $(seq 1 20); do healthy && { echo "local Bot API server is up"; exit 0; }; sleep 1; done
    echo "the server did not answer in 20 seconds: journalctl --user -u mesimot-botapi"; exit 1
    ;;
  switch)
    healthy || { echo "the local server is not up: run enable first"; exit 1; }
    has TELEGRAM_BOT_TOKEN || { echo "TELEGRAM_BOT_TOKEN is missing"; exit 1; }
    [ "${2:-}" = "--yes" ] || { echo "This logs the bot out of the cloud API and moves it to the local server. Run again with --yes."; exit 1; }
    curl -s -m 20 "https://api.telegram.org/bot$(val TELEGRAM_BOT_TOKEN)/logOut" | sed -E 's/"result":[^,}]*/"result":.../' ; echo
    has TELEGRAM_API_BASE || echo 'TELEGRAM_API_BASE=http://127.0.0.1:8081' >> "$ENV"
    systemctl --user restart mesimot-runner && echo "the bot now uses the local server (files up to 2 GB)"
    ;;
  rollback)
    sed -i '/^\s*TELEGRAM_API_BASE\s*=/d' "$ENV"
    systemctl --user restart mesimot-runner && echo "the bot uses the cloud API again (20 MB); if Telegram says the bot is logged out, wait ~10 minutes"
    ;;
  *) echo "usage: $0 status|enable|switch --yes|rollback"; exit 1;;
esac
