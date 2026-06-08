#!/usr/bin/env bash
# Pushes the RC grid sync payload for Project 3 to the live dashboard.
# Run from your Mac (which can reach Railway). Requires: curl.
curl -sS -X POST \
  "https://seo-room-v5-production.up.railway.app/api/projects/3/rc-grid-sync" \
  -H "Content-Type: application/json" \
  --data-binary @"$(dirname "$0")/rc-grid-sync-project3.json" \
  -w "\nHTTP %{http_code}\n"
