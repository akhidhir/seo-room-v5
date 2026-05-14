#!/bin/bash
# RC Grid Sync push script - run from ~/Desktop/seo-room-v5/
curl -s -X POST \
  "https://seo-room-v5-production.up.railway.app/api/projects/3/rc-grid-sync" \
  -H "Content-Type: application/json" \
  -d @rc-grid-sync-payload.json
echo ""
echo "Done. You can delete rc-grid-sync-payload.json and rc-sync-push.sh after."
