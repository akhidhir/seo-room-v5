# RC Grid Sync — Run Report (2026-06-03)

## Status: Data fetched & transformed ✅ — Push to server BLOCKED ⚠️

### What ran
Scheduled task `rc-grid-sync`. Pulled latest (1-day) Rating Captain grid monitoring data and transformed it into the dashboard's grid-scan format.

### Projects processed
Could not load the live project list — `GET /api/projects` is unreachable from this environment (web_fetch returns empty body; bash sandbox proxy returns 403 for the Railway domain). Fell back to the known mapping in the task file:

- **Project 3 — Car Key Rescue Perth** → `locations/17933670947974765351`

### Keywords synced (Project 3) — measurement date 2026-06-02, 81-point 9×9 grid, 10km radius

| Keyword | RC keyword_id | Grid points | Found in top-20 | Note |
|---|---|---|---|---|
| emergency car locksmith | 92411 | 81 | 0 | not ranking anywhere on grid |
| car key replacement | 92412 | 81 | 1 | pos 17 at SW point (115.809, -31.9963) |
| auto locksmith services | 92413 | 81 | 0 | not ranking anywhere on grid |

Center for all three: lat -31.9514, lng 115.861667. Position 20 = "not found".

### Blocker
The push step `POST /api/projects/3/rc-grid-sync` could not run:
- bash sandbox → proxy returns `403 from proxy after CONNECT` (Railway domain not allowlisted)
- web_fetch → GET-only, cannot POST
- Chrome (user browser, not IP-blocked) → requires interactive browser selection; user not present in scheduled run

### To complete the sync manually
The ready-to-push body is saved as `rc_grid_sync_payload_project3.json`. Run from your machine:

```bash
curl -X POST "https://seo-room-v5-production.up.railway.app/api/projects/3/rc-grid-sync" \
  -H "Content-Type: application/json" \
  --data @rc_grid_sync_payload_project3.json
```

The server computes ARP/ATRP/SOLV from the raw positions sent.
