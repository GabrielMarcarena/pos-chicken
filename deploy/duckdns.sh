#!/usr/bin/env bash
# Keeps your DuckDNS address pointed at this server. Run by cron every 5 minutes.
# Needs ~/.duckdns with two lines:   DOMAIN=pitikpos   and   TOKEN=your-token-from-duckdns.org
set -euo pipefail
. "$HOME/.duckdns"
curl -fsS "https://www.duckdns.org/update?domains=${DOMAIN}&token=${TOKEN}&ip=" -o /dev/null
