#!/bin/bash
# Pushes the RC grid sync payload to the dashboard. Run from ~/Desktop/seo-room-v5
curl -sS -X POST \
  "https://seo-room-v5-production.up.railway.app/api/projects/3/rc-grid-sync" \
  -H "Content-Type: application/json" \
  --data @rc_grid_sync_project3.json
