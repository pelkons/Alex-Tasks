#!/usr/bin/env bash
# Daily SQLite backup, keeps 30 days.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
db="${MESIMOT_DB:-$root/data/mesimot.db}"
dest="$root/backups"
mkdir -p "$dest"
out="$dest/mesimot-$(date +%F).db"
rm -f "$out"
sqlite3 "$db" ".backup '$out'"
gzip -f "$out"
find "$dest" -name 'mesimot-*.db.gz' -mtime +30 -delete
echo "backup written: $out.gz"
