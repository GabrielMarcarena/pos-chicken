#!/usr/bin/env bash
# Install the newest version from GitHub:  ./deploy/update.sh
# Makes a backup first, then pulls, then restarts. The app upgrades the database by itself (with its own safety copy).
set -euo pipefail
cd "${APP_DIR:-$HOME/pos-chicken}"
./deploy/backup-daily.sh
git pull --ff-only
sudo systemctl restart chicken-pos
sleep 2
systemctl is-active chicken-pos
echo "Updated. Open the site and check it."
