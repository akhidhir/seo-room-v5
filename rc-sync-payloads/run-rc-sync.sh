#!/usr/bin/env bash
# Completes the RC -> dashboard sync. Run from this folder.
set -e
BASE="https://seo-room-v5-production.up.railway.app/api/projects"
declare -A MAP=( [1]=p1_payload.json [2]=p2_payload.json [3]=p3_payload.json )
for PID in 1 2 3; do
  echo "=== Project $PID ==="
  curl -s -w "\nHTTP %{http_code}\n" -X POST "$BASE/$PID/rc-sync" \
    -H "Content-Type: application/json" --data "@${MAP[$PID]}"
  echo
done
