#!/bin/bash
# Push RC grid sync payload to SEO Room v5 server
cd ~/Desktop/seo-room-v5
curl -s -X POST \
  -H "Content-Type: application/json" \
  -d @rc-grid-sync-payload.json \
  "https://seo-room-v5-production.up.railway.app/api/projects/3/rc-grid-sync"
echo ""
echo "---"
echo "Done. Cleaning up..."
rm -f rc-grid-sync-payload.json rc-grid-sync-push.sh
