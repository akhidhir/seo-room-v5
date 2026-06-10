#!/usr/bin/env bash
# RC → SEO Room v5 GBP sync. Run from a machine with internet access.
# Posts the 3 prepared payloads (payload1/2/3.json must be in same dir).
set -e
BASE="https://seo-room-v5-production.up.railway.app/api/projects"
declare -A NAME=( [1]="Houseworks Plumbing" [2]="Gold PC Services" [3]="Car Key Rescue Perth" )
for pid in 1 2 3; do
  echo "=== Project $pid (${NAME[$pid]}) ==="
  curl -s -w "\nHTTP %{http_code}\n" -X POST "$BASE/$pid/rc-sync" \
    -H "Content-Type: application/json" --data @"payload$pid.json"
  echo
done
