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
echo "backup written: $out"
