#!/usr/bin/env bash
# Posts the prepared RC->dashboard sync payloads. Run from your machine (allowlist-free network).
set -e
BASE="https://seo-room-v5-production.up.railway.app/api/projects"
cd "$(dirname "$0")"
for pid in 1 2 3; do
  echo "=== POST project $pid ==="
  curl -s -w "\nHTTP %{http_code}\n" -X POST "$BASE/$pid/rc-sync" \
    -H "Content-Type: application/json" --data @payload$pid.json
  echo
done
