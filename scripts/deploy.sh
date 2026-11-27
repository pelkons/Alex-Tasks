#!/usr/bin/env bash
# POST-DEPLOY GATE. Run after merging a change into the live tree:  scripts/deploy.sh <previous-commit>
# It backs up the database, restarts the services, runs `mesimot health --quick` (real UI smoke test on every address + the APIs) and, if that fails,
# rolls the live tree back to <previous-commit>, restarts again and exits 1 (tell the coordinator). Never touches data.
set -u
root="$(cd "$(dirname "$0")/.." && pwd)"; cd "$root"
prev="${1:?usage: scripts/deploy.sh <previous-commit>}"
new="$(git rev-parse --short HEAD)"
touch data/.deploying; trap 'rm -f data/.deploying' EXIT  # health alerts stay quiet while the services restart (lib/health.js alertAll)
mkdir -p data/backups; node scripts/backup-db.js "data/backups/pre-deploy-$(date +%Y%m%d%H%M).db" || echo "WARNING: no pre-deploy database backup was made"   # an ENCRYPTED copy, never a plain copy of the database
ls -1t data/backups/pre-deploy-*.db 2>/dev/null | tail -n +6 | xargs -r rm -f   # the database is big (mail archive): only the 5 newest pre-deploy copies are kept
restart() { SINCE="$(date '+%F %T')"; systemctl --user restart mesimot.service mesimot-runner.service; systemctl --user is-enabled mesimot-archive.service >/dev/null 2>&1 && systemctl --user restart mesimot-archive.service; for i in $(seq 1 30); do curl -sf "http://127.0.0.1:${MESIMOT_PORT:-8110}/healthz" >/dev/null && return 0; sleep 2; done; return 1; }
gate() { for i in 1 2 3; do node bin/mesimot-health --quick --no-alert && stable "$SINCE" && return 0; echo "gate attempt $i failed"; sleep 15; done; return 1; }
# a crash loop passes the HTTP checks (systemd restarts the process in 5 s): after the restart both services must stay up with ZERO automatic restarts and no stack trace in their log
stable() {
  sleep 25; local since="$1" bad=0
  for u in mesimot mesimot-runner; do
    [ "$(systemctl --user is-active $u)" = active ] || { echo "$u is not active"; bad=1; }
    [ "$(systemctl --user show -p NRestarts --value $u)" = 0 ] || { echo "$u restarted by itself (crash loop?)"; bad=1; }
    if journalctl --user -u $u --since "$since" --no-pager 2>/dev/null | grep -qE "SqliteError|TypeError|ReferenceError|Uncaught|Error: Cannot find module|code=exited, status=1"; then echo "$u logged an error after the restart"; bad=1; fi
  done
  return $bad
}
KEPT=data/mesimot.db.plain-pre-encrypt   # exists only right after scripts/encrypt-db.js: the verified plaintext original, removed once the gate has passed
restart; if gate; then [ -f "$KEPT" ] && node scripts/encrypt-db.js --finalize; echo "DEPLOY OK: $new"; exit 0; fi
echo "DEPLOY FAILED the health gate: rolling back $new -> $prev"
if [ -f "$KEPT" ]; then # the previous code cannot read the encrypted database: put the verified plaintext one back first (and the old driver)
  systemctl --user stop mesimot.service mesimot-runner.service; node scripts/encrypt-db.js --rollback --no-services
  git reset --hard "$prev" >/dev/null && npm install --no-audit --no-fund >/dev/null 2>&1
else git reset --hard "$prev" >/dev/null; fi
restart && gate && echo "ROLLED BACK to $prev: healthy again" || echo "ROLLBACK ALSO UNHEALTHY: needs a human"
exit 1
