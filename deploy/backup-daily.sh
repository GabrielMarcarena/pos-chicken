#!/usr/bin/env bash
# Daily safety copy of the database. Run by cron at 01:00 (see docs/deploy/online-hosting-guide.md).
#   1. makes a consistent copy with  npm run backup  (safe while the app is running)
#   2. keeps the last 14 days of copies in backups/, and the 3 newest upgrade safety copies (data/*.bak)
#   3. copies backups/ to Google Drive with rclone, if rclone has a remote called "gdrive"
# It never touches backups/inventory (those are the saved daily inventory files the app checks).
set -euo pipefail
APP="${APP_DIR:-$HOME/pos-chicken}"
cd "$APP"
set -a; [ -f .env ] && . ./.env; set +a
export TZ="${TZ:-Asia/Manila}"

npm run --silent backup

find backups -maxdepth 1 -name 'pos-*.db' -mtime +14 -delete
DATA_DIR="$(dirname "${DB_PATH:-data/pos.db}")"
ls -1t "$DATA_DIR"/*.bak 2>/dev/null | tail -n +4 | xargs -r rm -f --

if command -v rclone >/dev/null 2>&1 && rclone listremotes 2>/dev/null | grep -q '^gdrive:'; then
  rclone copy backups gdrive:chicken-pos-backups --quiet && echo "Copied to Google Drive."
else
  echo "rclone is not set up: backups stay on this server only. See the guide, step 9."
fi
echo "Backup finished $(date '+%Y-%m-%d %H:%M')."
