# SEO Room v5 Server Structure

Clean, production-ready Node + Express + PostgreSQL API. Fully functional endpoints with stubs for complex logic.

## File Overview

- **server.js** (950 lines)
  - Uses CommonJS (`require`) for Node.js compatibility
  - Single file, clearly labeled sections
  - No migration hacks; clean schema initialization on startup
  - Syntax validated with `node -c`

## Sections (13 total)

### 1. CONFIG (lines 10-72)
- Environment variables (DATABASE_URL, JWT_SECRET, Google OAuth, DataForSEO, Local Falcon)
- Database pool setup
- Anthropic client initialization
- Express middleware configuration
- INDEX_HTML loaded once on startup

### 2. SCHEMA (lines 74-252)
- `initDb()` function creates tables in correct order:
  - `users` (email, password_hash, name, created_at)
  - `projects` (user_id, name, domain, business_name, industry, location, competitors, service_areas, is_local_business)
  - `project_integrations` (kind, config, status; UNIQUE on project_id + kind)
  - `audits` (pillar: gbp|gsc|website, status, audit_data, timestamps)
  - `audit_findings` (linked to audits, severity, status)
  - `action_items` (finding_id, pillar, execution_type, execution_log)
  - `rank_keywords` (project_id, keyword, location, location_code, search_volume, cpc, competition)
  - `rank_tracking` (serp_position, serp_url, serp_title, serp_snippet, maps_position, maps_title, maps_rating, maps_reviews, maps_address, competitors, checked_at)
  - `gsc_keywords` (keyword, clicks, impressions, ctr, position)
  - `monthly_reports` (month TEXT unique per project, report_data JSONB)

### 3. AUTH (lines 253-328)
- `generateToken(userId, email)` — JWT with 30d expiry
- `authMiddleware` — verifies Bearer token on all protected routes
- `optionalAuth` — middleware that whitelists auth paths (/auth/*, /health, /gsc/callback)
- **POST /api/auth/register** — creates user, returns token
- **POST /api/auth/login** — bcrypt verification, returns token
- **GET /api/auth/me** — returns current user

### 4. PROJECTS (lines 329-437)
- **GET /api/projects** — list user's projects
- **POST /api/projects** — create project
- **GET /api/projects/:id** — get project
- **PUT /api/projects/:id** — update project (COALESCE for partial updates)
- **DELETE /api/projects/:id** — delete project
- **GET /api/projects/:id/service-areas** — get JSONB service areas
- **POST /api/projects/:id/service-areas** — set service areas

### 5. INTEGRATIONS (lines 438-473)
- **GET /api/projects/:id/integrations** — returns all integrations for project as object
- **PUT /api/projects/:id/integrations/:kind** — upsert integration (gbp, gsc, dataforseo, local_falcon, wordpress, ahrefs)

### 6. AUDITS (lines 474-534)
- **POST /api/projects/:id/audit/:pillar** — trigger audit (gbp|gsc|website), returns 202
  - TODO: enqueue agent job
- **GET /api/projects/:id/audits** — list audits for project
- **GET /api/projects/:id/audit-findings** — list findings for project
- **PUT /api/audit-findings/:id** — update finding status (new|approved|rejected|done)

### 7. ACTION PLAN (lines 535-588)
- **GET /api/projects/:id/action-items** — list all action items
- **PUT /api/action-items/:id** — update status (pending|approved|in_progress|done|skipped)
- **POST /api/action-items/:id/execute** — mark in_progress, set executed_at, populate execution_log
  - TODO: execute based on execution_type

### 8. MAPS RANKINGS (lines 589-722)
- **GET /api/projects/:id/maps/keywords** — keywords with location != ''
- **POST /api/projects/:id/maps/keywords** — bulk add keywords with location
- **DELETE /api/maps/keywords/:id** — delete single keyword
- **POST /api/projects/:id/maps/sync-localfalcon** — fetch reports from Local Falcon API, sync into rank_keywords and rank_tracking
- **DELETE /api/projects/:id/maps/clean** — delete all maps keywords + tracking

### 9. SERP RANKINGS (lines 723-865)
- **Helper:** `dataforseoRequest(endpoint, method, body)` — Basic auth wrapper
- **GET /api/projects/:id/serp/keywords** — keywords with location == ''
- **POST /api/projects/:id/serp/keywords** — bulk add SERP keywords
- **POST /api/projects/:id/serp/discover** — TODO: DataForSEO ranked_keywords discovery
- **POST /api/projects/:id/serp/check** — TODO: check positions via DataForSEO/SERPapi
- **POST /api/projects/:id/serp/import** — bulk import discovered keywords with volume, position, url
  - Creates unique timestamps to avoid UNIQUE violations
- **GET /api/projects/:id/gsc/keywords** — list GSC keywords
- **POST /api/projects/:id/gsc/sync** — TODO: OAuth refresh + GSC API call

### 10. REPORTS (lines 866-893)
- **GET /api/projects/:id/reports** — monthly reports for project
- **POST /api/projects/:id/reports/generate** — TODO: aggregate rank_tracking + gsc_keywords + audit_findings

### 11. GSC OAUTH (lines 894-921)
- **GET /api/gsc/auth-url** — returns full OAuth URL (client_id, scope, redirect_uri, etc.)
- **GET /api/gsc/callback** — TODO: exchange code for token, store in project_integrations

### 12. SERVE (lines 922-935)
- **GET /api/health** — simple health check (no auth)
- Static files from `public/` directory
- **GET \*** — fallback to INDEX_HTML (SPA routing)

### 13. STARTUP (lines 936-950)
- `start()` function:
  - `await initDb()` — initializes schema
  - `app.listen(PORT)` — starts server
  - Exits with error if DB init fails

## Key Features

1. **Clean separation of concerns** — 13 labeled sections, each with single responsibility
2. **No migrations** — schema created fresh in `initDb()`, safe for development
3. **Complete CRUD endpoints** — all project, integration, audit, action item operations
4. **Functional Maps sync** — Local Falcon integration fully implemented
5. **Functional SERP import** — bulk keyword + position import with unique timestamp handling
6. **Stateful stubs** — complex logic (DataForSEO discovery, GSC OAuth exchange, audit execution) marked with `// TODO`
7. **Error handling** — all routes return 400/401/404/500 with descriptive messages
8. **Database isolation** — user_id checks on all project endpoints
9. **Optimistic concurrency** — ON CONFLICT clauses for safe bulk operations

## Environment Variables Required

```
DATABASE_URL          # PostgreSQL connection string
JWT_SECRET           # For signing JWT tokens (optional, defaults to dev value)
ANTHROPIC_API_KEY    # For managed agents (optional)
GOOGLE_CLIENT_ID     # For GSC OAuth (optional)
GOOGLE_CLIENT_SECRET
GOOGLE_REDIRECT_URI
DATAFORSEO_LOGIN     # For SERP discovery (optional)
DATAFORSEO_PASSWORD
LOCAL_FALCON_KEY     # For Maps sync (optional)
NODE_ENV             # Set to 'production' for SSL
PORT                 # Defaults to 3000
```

## Dependencies

```json
{
  "express": "^4.x",
  "cors": "^2.x",
  "pg": "^8.x",
  "bcryptjs": "^2.x",
  "jsonwebtoken": "^9.x",
  "@anthropic-ai/sdk": "^1.x"
}
```

## Next Steps

1. Implement DataForSEO discovery in POST /api/projects/:id/serp/discover
2. Implement SERP position checking in POST /api/projects/:id/serp/check
3. Implement GSC OAuth token exchange in GET /api/gsc/callback
4. Implement audit execution via managed agents in POST /api/projects/:id/audit/:pillar
5. Implement action item execution logic in POST /api/action-items/:id/execute
6. Add report generation logic in POST /api/projects/:id/reports/generate
7. Create React frontend at public/index.html
8. Deploy to Railway with DATABASE_URL and ANTHROPIC_API_KEY
