#!/bin/bash
# RC -> dashboard sync. Run from ~/Desktop/seo-room-v5/rc-sync: bash sync.sh
BASE="https://seo-room-v5-production.up.railway.app"
for P in 1 2 3; do
  echo "Project $P:"
  curl -s -w " [HTTP %{http_code}]\n" -X POST "$BASE/api/projects/$P/rc-sync" \
    -H "Content-Type: application/json" \
    --data-binary @rc_sync_p$P.json
done
