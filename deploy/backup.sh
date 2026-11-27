#!/usr/bin/env bash
# Daily database backup (encrypted with the database key, so it is useless without ~/.config/mesimot/db.key), keeps 30 days.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
dest="$root/backups"
mkdir -p "$dest"
out="$dest/mesimot-$(date +%F).db"
rm -f "$out"
"${NODE:-$(command -v node || echo /usr/local/bin/node)}" "$root/scripts/backup-db.js" "$out"
find "$dest" -name 'mesimot-*.db*' -mtime +30 -delete
# the Outlook mail archive makes the database big (several GB): the copies are also capped by total size (BACKUP_MAX_GB, default 40), oldest first, the newest 3 always stay
max=$(( ${BACKUP_MAX_GB:-40} * 1024 * 1024 * 1024 ))
while [ "$(find "$dest" -name 'mesimot-*.db*' | wc -l)" -gt 3 ] && [ "$(find "$dest" -name 'mesimot-*.db*' -printf '%s\n' | awk '{s+=$1} END {print s+0}')" -gt "$max" ]; do
  oldest="$(find "$dest" -name 'mesimot-*.db*' -printf '%T@ %p\n' | sort -n | head -1 | cut -d' ' -f2-)"; [ -n "$oldest" ] && rm -f "$oldest" || break
done
echo "backup written: $out"
