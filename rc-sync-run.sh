#!/bin/bash
cd "$(dirname "$0")"
echo "=== RC Sync: Houseworks Plumbing (Project 1) ==="
curl -s -X POST "https://seo-room-v5-production.up.railway.app/api/projects/1/rc-sync" \
  -H "Content-Type: application/json" -d @rc-sync-hw.json
echo ""

echo "=== RC Sync: Gold PC Services (Project 2) ==="
curl -s -X POST "https://seo-room-v5-production.up.railway.app/api/projects/2/rc-sync" \
  -H "Content-Type: application/json" -d @rc-sync-goldpc.json
echo ""

echo "=== RC Sync: Car Key Rescue (Project 3) ==="
curl -s -X POST "https://seo-room-v5-production.up.railway.app/api/projects/3/rc-sync" \
  -H "Content-Type: application/json" -d @rc-sync-ckr.json
echo ""

echo "=== Done. Cleaning up ==="
rm -f rc-sync-hw.json rc-sync-goldpc.json rc-sync-ckr.json rc-sync-run.sh
