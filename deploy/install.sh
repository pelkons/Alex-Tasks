#!/usr/bin/env bash
# Mesimot installer. Idempotent: run it again after an update. Nothing here installs or logs in an agent program for you.
#   deploy/install.sh [--no-voice] [--no-systemd] [--yes]
#     [--owner-name-he "..."] [--owner-name-en "..."] [--owner-email you@example.com] [--assistant-name-he "אלכס"] [--assistant-name-en Alex]
#     [--domain https://tasks.example.com] [--inbox assistant@agentmail.to] [--mail-provider agentmail|imap] [--telegram-token TOKEN] [--timezone Asia/Jerusalem]
#   Without answers on the command line it asks (when run in a terminal and without --yes).
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"
NO_VOICE=0; NO_SYSTEMD=0; YES=0
OWNER_HE=""; OWNER_EN=""; OWNER_EMAIL=""; ASSIST_HE=""; ASSIST_EN=""; DOMAIN_ARG=""; INBOX=""; MAIL_PROVIDER=""; TG_TOKEN=""; TZ_ARG=""
while [ $# -gt 0 ]; do case "$1" in
  --no-voice) NO_VOICE=1;; --no-systemd) NO_SYSTEMD=1;; --yes) YES=1;;
  --owner-name-he) OWNER_HE="$2"; shift;; --owner-name-en) OWNER_EN="$2"; shift;; --owner-email) OWNER_EMAIL="$2"; shift;;
  --assistant-name-he) ASSIST_HE="$2"; shift;; --assistant-name-en) ASSIST_EN="$2"; shift;; --domain) DOMAIN_ARG="$2"; shift;;
  --inbox) INBOX="$2"; shift;; --mail-provider) MAIL_PROVIDER="$2"; shift;; --telegram-token) TG_TOKEN="$2"; shift;; --timezone) TZ_ARG="$2"; shift;;
  *) echo "unknown option: $1"; exit 1;; esac; shift; done
ask() { # ask VAR "question" "default"  (only in a terminal, without --yes, and when VAR is empty)
  local var="$1" q="$2" def="${3:-}" cur; cur="${!var}"
  if [ -z "$cur" ] && [ "$YES" = 0 ] && [ -t 0 ]; then read -r -p "$q${def:+ [$def]}: " cur; fi
  printf -v "$var" '%s' "${cur:-$def}"
}
say() { printf '\n== %s\n' "$*"; }
have() { command -v "$1" >/dev/null 2>&1; }

say "1. Requirements"
have node || { echo "Node.js 20 or newer is required: https://nodejs.org"; exit 1; }
[ "$(node -p 'process.versions.node.split(".")[0]')" -ge 20 ] || { echo "Node.js 20 or newer is required (found $(node -v))"; exit 1; }
have npm || { echo "npm is required"; exit 1; }
have python3 || echo "python3 not found: voice messages (speech to text) will not work"
for t in pdftotext pdftoppm tesseract ffmpeg convert; do have "$t" || echo "optional tool missing: $t (needed for PDF text, OCR, voice, images)"; done

say "2. Node dependencies"
npm ci 2>/dev/null || npm install

say "3. Python environment for voice messages (models are downloaded on first use, not here)"
if [ "$NO_VOICE" = 0 ] && have python3; then
  [ -d venv ] || python3 -m venv venv
  venv/bin/pip install --quiet --upgrade pip
  venv/bin/pip install --quiet faster-whisper numpy
else echo "skipped"; fi

say "4. Configuration"
mkdir -p config data files backups ~/.config/mesimot
if [ ! -f config/mesimot.config.json ]; then
  echo "A few questions (Enter keeps the default; every answer can be changed later in config/mesimot.config.json):"
  ask OWNER_HE "Your name in Hebrew" "הבעלים"; ask OWNER_EN "Your name in English" "Owner"; ask OWNER_EMAIL "Your email address(es), comma separated" ""
  ask ASSIST_HE "The assistant's name in Hebrew" "אלכס"; ask ASSIST_EN "The assistant's name in English" "Alex"
  ask DOMAIN_ARG "Public address of the site (empty = local only, http://127.0.0.1:8110)" ""; ask INBOX "The assistant's own mailbox address (empty = none yet)" ""
  ask MAIL_PROVIDER "Mail provider: agentmail or imap (Proton Mail Bridge)" "agentmail"; ask TZ_ARG "Time zone" "Asia/Jerusalem"
  ask TG_TOKEN "Telegram bot token (empty = no Telegram)" ""
  node bin/mesimot init-config --owner-name-he "$OWNER_HE" --owner-name-en "$OWNER_EN" --owner-email "$OWNER_EMAIL" --assistant-name-he "$ASSIST_HE" --assistant-name-en "$ASSIST_EN" \
    --domain "$DOMAIN_ARG" --inbox "$INBOX" --timezone "$TZ_ARG"
fi
if [ ! -f ~/.config/mesimot/env ]; then
  umask 077
  { echo "# Mesimot secrets (never commit). See .env.example for every variable."; echo "MESIMOT_TOKEN=$(head -c 24 /dev/urandom | base64 | tr -d '/+=' | head -c 32)"
    echo "MAIL_PROVIDER=${MAIL_PROVIDER:-agentmail}"; echo "# AGENTMAIL_API_KEY=   (agentmail) or the MAIL_IMAP_* / MAIL_SMTP_* variables (imap): see .env.example"
    [ -n "$TG_TOKEN" ] && echo "TELEGRAM_BOT_TOKEN=$TG_TOKEN"; } > ~/.config/mesimot/env
  echo "Created ~/.config/mesimot/env (mode 600)"
fi
if [ ! -s agent/memory/owner.md ] 2>/dev/null; then mkdir -p agent/memory agent/tmp; cp -n agent/memory.example/*.md agent/memory/; echo "Created agent/memory from the examples: describe the owner and the projects there (it is never committed)."; fi
node bin/mesimot render-agent >/dev/null && echo "Rendered the assistant's instructions (agent/AGENTS.md) from the template and the configuration."

say "5. Which coding agent will be the brain? (it must already be installed and logged in by you)"
echo "Automatic mode calls one of these CLIs headless with YOUR OWN login. This script installs none of them."
for pair in "claude-code|claude|https://docs.claude.com/en/docs/claude-code/setup" "codex|codex|https://github.com/openai/codex" "gemini|gemini|https://github.com/google-gemini/gemini-cli"; do
  IFS='|' read -r name bin link <<<"$pair"
  if have "$bin"; then echo "  [found]   $name ($(command -v "$bin"))  - check the login with: deploy/check-agent.sh $name"; else echo "  [missing] $name - official install instructions: $link"; fi
done
echo "Choose with MESIMOT_AGENT=claude-code|codex|gemini in ~/.config/mesimot/env, or later in Settings (המוח של אלכס)."

say "6. Services"
if [ "$NO_SYSTEMD" = 1 ] || ! have systemctl; then echo "skipped (start by hand: node bin/mesimot-server and node bin/mesimot-runner)"; exit 0; fi
NODE="$(command -v node)"; CF="$(command -v cloudflared || echo /usr/local/bin/cloudflared)"
TZN="$(node -p "require('./lib/config').get().timezone || 'Asia/Jerusalem'")"
DOMAIN="$(node -p "(require('./lib/config').get().site_url||'').replace(/^https?:\/\//,'')")"
TUNNEL_ID="$(node -p "require('./lib/config').get().tunnel_id || ''")"
PORT="${MESIMOT_PORT:-8110}"
if [ ! -f config/cloudflared.yml ] && [ -n "$TUNNEL_ID" ]; then
  sed -e "s#@DOMAIN@#$DOMAIN#g; s#@TUNNEL_ID@#$TUNNEL_ID#g; s#@HOME@#$HOME#g; s#@PORT@#$PORT#g" deploy/cloudflared.yml.template > config/cloudflared.yml
  echo "Rendered config/cloudflared.yml"
fi
dest=~/.config/systemd/user; mkdir -p "$dest"
for f in deploy/systemd/*; do
  rm -f "$dest/$(basename "$f")"   # an older install may have left a symlink into the repo: never write through it
  sed -e "s#@ROOT@#$root#g; s#@NODE@#$NODE#g; s#@CLOUDFLARED@#$CF#g; s#@TZ@#$TZN#g" "$f" > "$dest/$(basename "$f")"
done
systemctl --user daemon-reload
UNITS="mesimot.service mesimot-runner.service mesimot-backup.timer mesimot-reconcile.timer mesimot-daily.timer mesimot-housekeeping.timer mesimot-pulse.timer mesimot-watchdog.timer mesimot-curator.timer mesimot-usage.timer mesimot-health.timer"
[ -f config/cloudflared.yml ] && UNITS="$UNITS mesimot-tunnel.service" || echo "No config/cloudflared.yml: the public tunnel is not enabled (set tunnel_id in the config, see deploy/cloudflared.yml.template)"
systemctl --user enable --now $UNITS
have loginctl && loginctl enable-linger "$USER" 2>/dev/null || true
echo "Done. Set the site password: node bin/mesimot web-password --generate"
echo "Optional: the local Telegram Bot API server for big files: deploy/telegram-local.sh status"
