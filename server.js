const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');
const fs = require('fs');
const Anthropic = require('@anthropic-ai/sdk');

// ==================== 1. CONFIG ====================

const app = express();
const PORT = process.env.PORT || 3000;

// Core env vars
const JWT_SECRET = process.env.JWT_SECRET || 'seo-room-v5-secret-change-in-production';
const DATABASE_URL = process.env.DATABASE_URL;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

// OAuth integrations
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || 'https://seo-room-v5-production.up.railway.app/api/gsc/callback';
const GSC_SCOPES = 'https://www.googleapis.com/auth/webmasters.readonly';
const GBP_SCOPES = 'https://www.googleapis.com/auth/business.manage';
const GBP_REDIRECT_URI = process.env.GBP_REDIRECT_URI || 'https://seo-room-v5-production.up.railway.app/api/gbp/callback';

// External APIs
const DATAFORSEO_LOGIN = process.env.DATAFORSEO_LOGIN;
const DATAFORSEO_PASSWORD = process.env.DATAFORSEO_PASSWORD;
const DATAFORSEO_AUTH = DATAFORSEO_LOGIN && DATAFORSEO_PASSWORD ? 'Basic ' + Buffer.from(`${DATAFORSEO_LOGIN}:${DATAFORSEO_PASSWORD}`).toString('base64') : null;
const LOCAL_FALCON_KEY = process.env.LOCAL_FALCON_KEY;
const SERPAPI_KEY = process.env.SERPAPI_KEY;

// Managed Agents (Claude API)
const AGENT_IDS = {
  website: process.env.WEBSITE_AUDIT_AGENT,
  gbp: process.env.GBP_AUDIT_AGENT,
  gsc: process.env.GSC_AUDIT_AGENT
};

// Validate required config
if (!DATABASE_URL) {
  console.error('ERROR: DATABASE_URL required');
  process.exit(1);
}

// Warn on missing optional integrations
if (!GOOGLE_CLIENT_ID) console.warn('[boot] GOOGLE_CLIENT_ID not set — GSC OAuth disabled');
if (!SERPAPI_KEY) console.warn('[boot] SERPAPI_KEY not set — SERP + Maps rank tracking disabled');
if (!LOCAL_FALCON_KEY) console.warn('[boot] LOCAL_FALCON_KEY not set — Local Falcon grid scanning disabled');
if (!ANTHROPIC_API_KEY) console.warn('[boot] ANTHROPIC_API_KEY not set — AI audits disabled');

// Database pool
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Anthropic client
const anthropic = ANTHROPIC_API_KEY ? new Anthropic({ apiKey: ANTHROPIC_API_KEY }) : null;

// Express config
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Load index.html once on startup
let INDEX_HTML = '';
const indexPath = path.join(__dirname, 'public', 'index.html');
if (fs.existsSync(indexPath)) {
  INDEX_HTML = fs.readFileSync(indexPath, 'utf8');
  console.log(`[boot] index.html loaded: ${INDEX_HTML.length} bytes`);
} else {
  console.warn('[boot] index.html not found, serving placeholder');
  INDEX_HTML = '<html><body><h1>SEO Room v5 - index.html missing</h1></body></html>';
}

// ==================== 2. SCHEMA ====================

async function initDb() {
  const client = await pool.connect();
  try {
    // Users table
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        email TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        name TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // Projects table
    await client.query(`
      CREATE TABLE IF NOT EXISTS projects (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        domain TEXT NOT NULL,
        business_name TEXT,
        industry TEXT,
        location TEXT,
        competitors TEXT[],
        service_areas JSONB DEFAULT '[]',
        is_local_business BOOLEAN DEFAULT true,
        is_elementor_site BOOLEAN DEFAULT true,
        wordpress_url TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // Project integrations (DataForSEO, Local Falcon, WordPress, Ahrefs — per-project credentials)
    await client.query(`
      CREATE TABLE IF NOT EXISTS project_integrations (
        id SERIAL PRIMARY KEY,
        project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        config JSONB,
        status TEXT DEFAULT 'not_connected',
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(project_id, kind)
      )
    `);

    // User-level integrations (GSC, GBP — OAuth tokens shared across all projects)
    await client.query(`
      CREATE TABLE IF NOT EXISTS user_integrations (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        config JSONB,
        status TEXT DEFAULT 'not_connected',
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(user_id, kind)
      )
    `);

    // Audits (GBP, GSC, Website)
    await client.query(`
      CREATE TABLE IF NOT EXISTS audits (
        id SERIAL PRIMARY KEY,
        project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        pillar TEXT NOT NULL,
        status TEXT DEFAULT 'queued',
        audit_data JSONB,
        started_at TIMESTAMPTZ,
        completed_at TIMESTAMPTZ,
        error_message TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // Audit findings (linked to audits)
    await client.query(`
      CREATE TABLE IF NOT EXISTS audit_findings (
        id SERIAL PRIMARY KEY,
        project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        audit_id INTEGER REFERENCES audits(id) ON DELETE SET NULL,
        pillar TEXT NOT NULL,
        category TEXT,
        title TEXT NOT NULL,
        description TEXT,
        recommendation TEXT,
        severity TEXT DEFAULT 'medium',
        current_value TEXT,
        recommended_value TEXT,
        status TEXT DEFAULT 'new',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // Action items (from findings)
    await client.query(`
      CREATE TABLE IF NOT EXISTS action_items (
        id SERIAL PRIMARY KEY,
        project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        finding_id INTEGER REFERENCES audit_findings(id) ON DELETE SET NULL,
        pillar TEXT NOT NULL,
        type TEXT,
        title TEXT NOT NULL,
        description TEXT,
        current_value TEXT,
        new_value TEXT,
        severity TEXT,
        status TEXT DEFAULT 'pending',
        execution_type TEXT DEFAULT 'manual',
        execution_log JSONB,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        approved_at TIMESTAMPTZ,
        executed_at TIMESTAMPTZ
      )
    `);

    // SERP rank tracking
    await client.query(`
      CREATE TABLE IF NOT EXISTS rank_keywords (
        id SERIAL PRIMARY KEY,
        project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        keyword TEXT NOT NULL,
        location TEXT DEFAULT '',
        location_code INTEGER DEFAULT 2036,
        language_code TEXT DEFAULT 'en',
        search_volume INTEGER,
        cpc DOUBLE PRECISION,
        competition TEXT,
        added_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(project_id, keyword, location)
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS rank_tracking (
        id SERIAL PRIMARY KEY,
        project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        keyword TEXT NOT NULL,
        location TEXT DEFAULT '',
        location_code INTEGER DEFAULT 2036,
        language_code TEXT DEFAULT 'en',
        serp_position INTEGER,
        serp_url TEXT,
        serp_title TEXT,
        serp_snippet TEXT,
        maps_position INTEGER,
        maps_title TEXT,
        maps_rating DOUBLE PRECISION,
        maps_reviews INTEGER,
        maps_address TEXT,
        competitors JSONB DEFAULT '[]',
        checked_at TIMESTAMPTZ,
        UNIQUE(project_id, keyword, location, checked_at)
      )
    `);

    // GSC keywords (position data from Google Search Console)
    await client.query(`
      CREATE TABLE IF NOT EXISTS gsc_keywords (
        id SERIAL PRIMARY KEY,
        project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        keyword TEXT NOT NULL,
        clicks INTEGER DEFAULT 0,
        impressions INTEGER DEFAULT 0,
        ctr DOUBLE PRECISION DEFAULT 0,
        position DOUBLE PRECISION DEFAULT 0,
        prev_position DOUBLE PRECISION,
        fetched_at TIMESTAMPTZ,
        UNIQUE(project_id, keyword)
      )
    `);

    // Monthly reports
    await client.query(`
      CREATE TABLE IF NOT EXISTS monthly_reports (
        id SERIAL PRIMARY KEY,
        project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        month TEXT NOT NULL,
        report_data JSONB,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(project_id, month)
      )
    `);

    // On-page audit cache
    await client.query(`
      CREATE TABLE IF NOT EXISTS onpage_audit_cache (
        project_id INTEGER PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
        results JSONB,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // Citation tracking (per-project directory listing status)
    await client.query(`
      CREATE TABLE IF NOT EXISTS citations (
        id SERIAL PRIMARY KEY,
        project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        directory_name TEXT NOT NULL,
        status TEXT DEFAULT 'not_listed',
        listing_url TEXT,
        notes TEXT,
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(project_id, directory_name)
      )
    `);

    // WordPress change history — universal rollback for ALL WP writes
    await client.query(`
      CREATE TABLE IF NOT EXISTS wp_change_history (
        id SERIAL PRIMARY KEY,
        project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        page_id INTEGER NOT NULL,
        page_url TEXT,
        page_title TEXT,
        change_type TEXT NOT NULL,
        field_name TEXT NOT NULL,
        original_value TEXT,
        new_value TEXT,
        applied_at TIMESTAMPTZ DEFAULT NOW(),
        rolled_back_at TIMESTAMPTZ
      )
    `);

    // Add columns for existing databases
    await client.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS competitors TEXT[]`);
    await client.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS is_elementor_site BOOLEAN DEFAULT true`);
    await client.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS wordpress_url TEXT`);
    await client.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS gsc_property TEXT`);
    await client.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS gbp_location_id TEXT`);
    await client.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS gbp_location_name TEXT`);
    await client.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS wp_username TEXT`).catch(() => {});
    await client.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS wp_app_password TEXT`).catch(() => {});
    await client.query(`ALTER TABLE action_items ADD COLUMN IF NOT EXISTS category TEXT`).catch(() => {});
    await client.query(`UPDATE action_items SET category = type WHERE category IS NULL AND type IS NOT NULL`).catch(() => {});
    await client.query(`ALTER TABLE action_items ADD COLUMN IF NOT EXISTS pages_affected TEXT DEFAULT ''`).catch(() => {});
    await client.query(`ALTER TABLE action_items ADD COLUMN IF NOT EXISTS effort TEXT DEFAULT ''`).catch(() => {});
    await client.query(`ALTER TABLE action_items ADD COLUMN IF NOT EXISTS expected_impact TEXT DEFAULT ''`).catch(() => {});
    await client.query(`ALTER TABLE action_items ADD COLUMN IF NOT EXISTS assignee_label TEXT`).catch(() => {});
    await client.query(`ALTER TABLE gsc_keywords ADD COLUMN IF NOT EXISTS prev_position DOUBLE PRECISION`).catch(() => {});

    // GBP tasks are manual (SEO Specialist) — no extension automation
    await client.query(`
      UPDATE action_items SET execution_type = 'manual'
      WHERE pillar IN ('gbp_external', 'gbp') AND execution_type = 'extension'
    `).catch(() => {});

    console.log('[boot] Database schema initialized');
  } catch (e) {
    console.error('[boot] Schema init error:', e.message);
    throw e;
  } finally {
    client.release();
  }
}

// ==================== 3. AUTH ====================

// Generate JWT token
function generateToken(userId, email) {
  return jwt.sign({ userId, email }, JWT_SECRET, { expiresIn: '30d' });
}

// Auth middleware
function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token provided' });
  try {
    req.auth = jwt.verify(token, JWT_SECRET);
    next();
  } catch (e) {
    res.status(401).json({ error: 'Invalid token' });
  }
}

// Whitelist certain paths from auth requirement
function optionalAuth(req, res, next) {
  const whitelistPaths = ['/api/auth/register', '/api/auth/login', '/api/health', '/api/gsc/callback', '/api/gbp/callback'];
  if (whitelistPaths.includes(req.path)) return next();
  // Skip auth for non-API routes (static files, index.html)
  if (!req.path.startsWith('/api/')) return next();
  authMiddleware(req, res, next);
}

// Register
app.post('/api/auth/register', async (req, res) => {
  const { email, password, name } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  try {
    const hash = await bcrypt.hash(password, 10);
    const result = await pool.query(
      'INSERT INTO users (email, password_hash, name) VALUES ($1, $2, $3) RETURNING id, email',
      [email, hash, name || '']
    );
    const user = result.rows[0];
    const token = generateToken(user.id, user.email);
    res.json({ ok: true, user, token });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'Email already registered' });
    res.status(500).json({ error: e.message });
  }
});

// Login
app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  try {
    const result = await pool.query('SELECT id, email, password_hash, name FROM users WHERE email=$1', [email]);
    if (result.rows.length === 0) return res.status(401).json({ error: 'Invalid credentials' });
    const user = result.rows[0];
    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) return res.status(401).json({ error: 'Invalid credentials' });
    const token = generateToken(user.id, user.email);
    res.json({ ok: true, user: { id: user.id, email: user.email, name: user.name }, token });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Me (get current user)
app.get('/api/auth/me', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query('SELECT id, email, name FROM users WHERE id=$1', [req.auth.userId]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'User not found' });
    res.json({ user: result.rows[0] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Apply optional auth to all routes
app.use(optionalAuth);

// ==================== 4. PROJECTS ====================

// List projects for current user
app.get('/api/projects', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM projects WHERE user_id=$1 ORDER BY created_at DESC',
      [req.auth.userId]
    );
    res.json({ projects: result.rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Create project
app.post('/api/projects', async (req, res) => {
  const { name, domain, business_name, industry, location, competitors, is_local_business, is_elementor_site, wordpress_url } = req.body;
  if (!name || !domain) return res.status(400).json({ error: 'Name and domain required' });
  try {
    const result = await pool.query(
      `INSERT INTO projects (user_id, name, domain, business_name, industry, location, competitors, is_local_business, is_elementor_site, wordpress_url)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING *`,
      [req.auth.userId, name, domain, business_name || null, industry || null, location || null, competitors || [], is_local_business !== false, is_elementor_site !== false, wordpress_url || null]
    );
    res.status(201).json({ project: result.rows[0] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Get project
app.get('/api/projects/:id', async (req, res) => {
  try {
    const userId = req.auth?.userId;
    const query = userId
      ? 'SELECT * FROM projects WHERE id=$1 AND user_id=$2'
      : 'SELECT * FROM projects WHERE id=$1';
    const params = userId ? [req.params.id, userId] : [req.params.id];
    const result = await pool.query(query, params);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Project not found' });
    res.json({ project: result.rows[0] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Update project (accepts both camelCase and snake_case)
app.put('/api/projects/:id', async (req, res) => {
  console.log(`[project-update] PUT /projects/${req.params.id} body keys:`, Object.keys(req.body || {}), 'competitors:', JSON.stringify(req.body?.competitors));
  const b = req.body;
  const name = b.name;
  const domain = b.domain;
  const business_name = b.business_name || b.businessName;
  const industry = b.industry;
  const location = b.location;
  const competitors = b.competitors;
  const service_areas = b.service_areas || b.serviceAreas;
  const is_local_business = b.is_local_business ?? b.isLocalBusiness;
  const is_elementor_site = b.is_elementor_site ?? b.isElementorSite;
  const wordpress_url = b.wordpress_url || b.wordpressUrl;
  const gsc_property = b.gsc_property || b.gscProperty;
  const gbp_location_id = b.gbp_location_id || b.gbpLocationId;
  const gbp_location_name = b.gbp_location_name || b.gbpLocationName;
  const wp_username = b.wp_username || b.wpUsername;
  const wp_app_password = b.wp_app_password || b.wpAppPassword;
  try {
    const result = await pool.query(
      `UPDATE projects
       SET name=COALESCE($2, name), domain=COALESCE($3, domain), business_name=COALESCE($4, business_name),
           industry=COALESCE($5, industry), location=COALESCE($6, location),
           competitors=COALESCE($7::text[], competitors),
           is_local_business=COALESCE($8, is_local_business), is_elementor_site=COALESCE($9, is_elementor_site),
           wordpress_url=COALESCE($10, wordpress_url),
           service_areas=COALESCE($11::jsonb, service_areas),
           gsc_property=COALESCE($12, gsc_property),
           gbp_location_id=COALESCE($13, gbp_location_id),
           gbp_location_name=COALESCE($14, gbp_location_name),
           wp_username=COALESCE($15, wp_username),
           wp_app_password=COALESCE($16, wp_app_password)
       WHERE id=$1
       RETURNING *`,
      [req.params.id, name, domain, business_name, industry, location,
       competitors && Array.isArray(competitors) ? competitors : null,
       is_local_business, is_elementor_site, wordpress_url,
       service_areas ? JSON.stringify(service_areas) : null,
       gsc_property || null, gbp_location_id || null, gbp_location_name || null,
       wp_username || null, wp_app_password || null]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Project not found' });
    console.log(`[project-update] Saved project ${req.params.id}, competitors:`, result.rows[0].competitors);
    res.json({ project: result.rows[0] });
  } catch (e) {
    console.error('[project-update] Error:', e.message, e.stack);
    res.status(500).json({ error: e.message });
  }
});

// Delete project
app.delete('/api/projects/:id', async (req, res) => {
  try {
    const result = await pool.query(
      'DELETE FROM projects WHERE id=$1 AND user_id=$2 RETURNING id',
      [req.params.id, req.auth.userId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Project not found' });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Get/set service areas for a project
app.get('/api/projects/:id/service-areas', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT service_areas FROM projects WHERE id=$1 AND user_id=$2',
      [req.params.id, req.auth.userId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Project not found' });
    res.json({ service_areas: result.rows[0].service_areas || [] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/projects/:id/service-areas', async (req, res) => {
  const { service_areas } = req.body;
  if (!Array.isArray(service_areas)) return res.status(400).json({ error: 'service_areas must be array' });
  try {
    const result = await pool.query(
      'UPDATE projects SET service_areas=$1 WHERE id=$2 AND user_id=$3 RETURNING service_areas',
      [JSON.stringify(service_areas), req.params.id, req.auth.userId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Project not found' });
    res.json({ service_areas: result.rows[0].service_areas });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ==================== 5. INTEGRATIONS ====================

// Get all integrations for a project
app.get('/api/projects/:id/integrations', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT kind, config, status FROM project_integrations WHERE project_id=$1',
      [req.params.id]
    );
    const integrations = {};
    result.rows.forEach(row => {
      integrations[row.kind] = { config: row.config || {}, status: row.status };
    });
    res.json({ integrations });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Update integration for a project
app.put('/api/projects/:id/integrations/:kind', async (req, res) => {
  const { config, status } = req.body;
  try {
    const result = await pool.query(
      `INSERT INTO project_integrations (project_id, kind, config, status, updated_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (project_id, kind) DO UPDATE SET config=$3, status=$4, updated_at=NOW()
       RETURNING kind, config, status`,
      [req.params.id, req.params.kind, JSON.stringify(config || {}), status || 'connected']
    );
    res.json({ integration: result.rows[0] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Test integration connection
app.post('/api/projects/:id/integrations/:kind/test', async (req, res) => {
  try {
    const r = await pool.query('SELECT config, status FROM project_integrations WHERE project_id=$1 AND kind=$2', [req.params.id, req.params.kind]);
    if (r.rows.length === 0) return res.status(400).json({ error: 'Not configured — save credentials first' });
    const { config, status } = r.rows[0];
    const cfg = typeof config === 'string' ? JSON.parse(config) : (config || {});

    if (req.params.kind === 'serpapi') {
      if (!cfg.apiKey) return res.status(400).json({ error: 'API key required' });
      const resp = await fetch(`https://serpapi.com/search.json?engine=google&q=test&api_key=${cfg.apiKey}&num=1`);
      if (resp.ok) {
        const data = await resp.json();
        return res.json({ ok: true, message: `SerpAPI connected — ${data.search_metadata?.status || 'OK'}` });
      }
      const text = await resp.text();
      return res.status(400).json({ error: text.substring(0, 200) || 'Invalid API key' });
    }

    if (req.params.kind === 'localfalcon') {
      if (!cfg.apiKey) return res.status(400).json({ error: 'API key required' });
      const resp = await fetch(`https://api.localfalcon.com/v1/reports?api_key=${cfg.apiKey}`);
      const data = await resp.json();
      if (data.success || resp.ok) return res.json({ ok: true, message: `Local Falcon connected — ${(data.data || []).length} reports found` });
      return res.status(400).json({ error: data.message || 'Invalid API key' });
    }

    if (req.params.kind === 'wordpress') {
      if (!cfg.url || !cfg.username || !cfg.appPassword) return res.status(400).json({ error: 'URL, username, and app password required' });
      const wpUrl = cfg.url.replace(/\/wp-admin\/?$/, '').replace(/\/$/, '');
      const authHeader = 'Basic ' + Buffer.from(`${cfg.username}:${cfg.appPassword}`).toString('base64');
      const resp = await fetch(`${wpUrl}/wp-json/wp/v2/users/me`, {
        headers: { Authorization: authHeader }
      });
      if (resp.ok) {
        const user = await resp.json();
        return res.json({ ok: true, message: `WordPress connected as ${user.name || user.slug}` });
      }
      return res.status(400).json({ error: `WordPress auth failed (${resp.status})` });
    }

    res.json({ ok: true, message: 'Connection stored' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ==================== 6. AUDITS ====================

// Trigger an audit (GBP, GSC, or Website)
app.post('/api/projects/:id/audit/:pillar', async (req, res) => {
  const { pillar } = req.params;
  if (!['gbp', 'gsc', 'website'].includes(pillar)) {
    return res.status(400).json({ error: 'pillar must be gbp, gsc, or website' });
  }
  try {
    const result = await pool.query(
      `INSERT INTO audits (project_id, pillar, status) VALUES ($1, $2, 'queued') RETURNING *`,
      [req.params.id, pillar]
    );
    // TODO: Enqueue agent job to execute audit asynchronously
    res.status(202).json({ audit: result.rows[0] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// List audits for a project
app.get('/api/projects/:id/audits', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM audits WHERE project_id=$1 ORDER BY created_at DESC',
      [req.params.id]
    );
    res.json({ audits: result.rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// List findings for a project
app.get('/api/projects/:id/audit-findings', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM audit_findings WHERE project_id=$1 ORDER BY created_at DESC',
      [req.params.id]
    );
    res.json({ findings: result.rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Update finding status (approve/reject) — auto-creates action item on approve
app.put('/api/audit-findings/:id', async (req, res) => {
  const { status } = req.body;
  try {
    const result = await pool.query(
      'UPDATE audit_findings SET status=$1, updated_at=NOW() WHERE id=$2 RETURNING *',
      [status, req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Finding not found' });
    const finding = result.rows[0];

    let actionItem = null;
    if (status === 'approved') {
      // Auto-create action item from this finding
      const existing = await pool.query('SELECT id FROM action_items WHERE finding_id=$1', [finding.id]);
      if (existing.rows.length === 0) {
        const aiRes = await pool.query(
          `INSERT INTO action_items (project_id, finding_id, pillar, type, title, description, current_value, new_value, severity, status, execution_type)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending', $10) RETURNING *`,
          [finding.project_id, finding.id, finding.pillar, finding.category || 'general',
           finding.title, finding.recommendation || finding.description,
           finding.current_value, finding.recommended_value, finding.severity,
           // Auto-detect execution type based on category
           ['Quick Win', 'Low CTR', 'Underperforming Page'].includes(finding.category) ? 'semi_auto' : 'manual']
        );
        actionItem = aiRes.rows[0];
        console.log(`[action] Created action item #${actionItem.id} from finding #${finding.id} (${finding.pillar}/${finding.category})`);
      }
    }

    res.json({ finding, actionItem });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ==================== 7. ACTION PLAN ====================

// Get action items for a project (optional ?pillar= filter)
app.get('/api/projects/:id/action-items', async (req, res) => {
  try {
    const { pillar } = req.query;
    let query = 'SELECT * FROM action_items WHERE project_id=$1';
    const params = [req.params.id];
    if (pillar) {
      query += ' AND pillar=$2';
      params.push(pillar);
    }
    query += ' ORDER BY created_at DESC';
    const result = await pool.query(query, params);
    res.json({ action_items: result.rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Create action item directly (from external audit)
app.post('/api/projects/:id/action-items', async (req, res) => {
  const { pillar, type, title, description, severity, current_value, new_value, category, execution_type } = req.body;
  try {
    const result = await pool.query(
      `INSERT INTO action_items (project_id, pillar, type, title, description, severity, current_value, new_value, category, status, execution_type)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending', $10) RETURNING *`,
      [req.params.id, pillar || 'gbp_external', type || 'external_audit', title, description, severity || 'medium', current_value || null, new_value || null, category || type || 'general', execution_type || 'manual']
    );
    res.json({ action_item: result.rows[0] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Update action item (status, execution_type)
app.put('/api/action-items/:id', async (req, res) => {
  const { status, approved_at, execution_type } = req.body;
  try {
    const result = await pool.query(
      `UPDATE action_items
       SET status=COALESCE($1, status), approved_at=COALESCE($2, approved_at), execution_type=COALESCE($3, execution_type)
       WHERE id=$4 RETURNING *`,
      [status || null, approved_at || null, execution_type || null, req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Action item not found' });
    res.json({ action_item: result.rows[0] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Execute action item
app.post('/api/action-items/:id/execute', async (req, res) => {
  const { id } = req.params;
  try {
    const itemResult = await pool.query('SELECT * FROM action_items WHERE id=$1', [id]);
    if (itemResult.rows.length === 0) return res.status(404).json({ error: 'Action item not found' });
    const item = itemResult.rows[0];

    // TODO: Execute based on item.execution_type (api, semi_auto, manual)
    // Update execution_log with results
    const result = await pool.query(
      `UPDATE action_items
       SET status='in_progress', executed_at=NOW(), execution_log=jsonb_build_object('attempted_at', NOW())
       WHERE id=$1 RETURNING *`,
      [id]
    );
    res.json({ action_item: result.rows[0] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});


// ==================== EXTENSION TASK QUEUE ====================

// Get pending extension tasks (polled by Chrome extension every 30s)
app.get('/api/extension/tasks', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT ai.*, p.domain, p.business_name, p.gbp_location_id, p.gbp_location_name
       FROM action_items ai
       JOIN projects p ON p.id = ai.project_id
       WHERE ai.execution_type = 'extension' AND ai.status = 'in_progress'
       ORDER BY ai.created_at ASC LIMIT 5`
    );
    res.json({ tasks: result.rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Claim a task (extension marks it as being worked on)
app.post('/api/extension/tasks/:id/claim', async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE action_items
       SET execution_log = COALESCE(execution_log, '{}'::jsonb) || jsonb_build_object('claimed_at', to_char(NOW(), 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), 'claimed_by', 'chrome_extension')
       WHERE id = $1 AND execution_type = 'extension' AND status = 'in_progress'
       RETURNING *`,
      [req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Task not found or not claimable' });
    res.json({ task: result.rows[0] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Report task result (extension reports success/failure)
app.post('/api/extension/tasks/:id/result', async (req, res) => {
  const { success, before_state, after_state, error: taskError } = req.body;
  try {
    const newStatus = success ? 'done' : 'failed';
    const logEntry = {
      completed_at: new Date().toISOString(),
      success,
      before_state: before_state || null,
      after_state: after_state || null,
      error: taskError || null
    };
    const result = await pool.query(
      `UPDATE action_items
       SET status = $1,
           execution_log = COALESCE(execution_log, '{}'::jsonb) || $2::jsonb
       WHERE id = $3 RETURNING *`,
      [newStatus, JSON.stringify(logEntry), req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Task not found' });
    res.json({ task: result.rows[0] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Report task progress (extension sends step updates)
app.post('/api/extension/tasks/:id/progress', async (req, res) => {
  const { step, total, description } = req.body;
  try {
    const logEntry = { progress: { step, total, description, updated_at: new Date().toISOString() } };
    const result = await pool.query(
      `UPDATE action_items
       SET execution_log = COALESCE(execution_log, '{}'::jsonb) || $1::jsonb
       WHERE id = $2 RETURNING *`,
      [JSON.stringify(logEntry), req.params.id]
    );
    res.json({ task: result.rows[0] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ==================== ORCHESTRATOR ====================

// Get all action items grouped by pillar + category, with deduplication
app.get('/api/projects/:id/orchestrator', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT ai.*, af.recommendation as finding_recommendation, af.audit_id
       FROM action_items ai
       LEFT JOIN audit_findings af ON ai.finding_id = af.id
       WHERE ai.project_id = $1
       ORDER BY
         CASE ai.severity WHEN 'Critical' THEN 1 WHEN 'Medium' THEN 2 WHEN 'Low' THEN 3 ELSE 4 END,
         ai.created_at DESC`,
      [req.params.id]
    );

    const items = result.rows;

    // Count how many times each title appears (source count for trust scoring)
    const titleCounts = {};
    for (const item of items) {
      const key = (item.title || '').toLowerCase().trim();
      titleCounts[key] = (titleCounts[key] || 0) + 1;
    }

    // Normalize title for fuzzy dedup: strip filler words, punctuation, collapse whitespace
    function normalizeTitle(t) {
      return (t || '').toLowerCase().trim()
        .replace(/[^a-z0-9\s]/g, '')
        .replace(/\b(the|a|an|to|for|of|in|on|and|or|with|your|their|its|this|that|add|create|update|implement|ensure|improve|optimize)\b/g, '')
        .replace(/\s+/g, ' ').trim();
    }

    // Deduplicate: same pillar + similar title = duplicate, keep the one with assignee_label (orchestrator) first, then newest
    const seen = new Map();
    const deduped = [];
    // Sort so orchestrator items (have assignee_label) come first
    const sorted = [...items].sort((a, b) => {
      if (a.assignee_label && !b.assignee_label) return -1;
      if (!a.assignee_label && b.assignee_label) return 1;
      return new Date(b.created_at) - new Date(a.created_at);
    });
    for (const item of sorted) {
      const exactKey = `${item.pillar}:${(item.title || '').toLowerCase().trim()}`;
      const fuzzyKey = `${item.pillar}:${normalizeTitle(item.title)}`;
      if (!seen.has(exactKey) && !seen.has(fuzzyKey)) {
        seen.set(exactKey, true);
        if (fuzzyKey !== exactKey) seen.set(fuzzyKey, true);
        deduped.push(item);
      }
    }

    // Trust scoring
    const HIGH_IMPACT_KEYWORDS = /ranking|position|index|crawl|canonical|redirect|404|broken|duplicate|title|meta|h1|schema|speed|lcp|cls|conversion|ctr|traffic/i;
    function computeTrustScore(item) {
      let score = 0;
      // Severity weight
      const sev = (item.severity || '').toLowerCase();
      if (sev === 'critical') score += 10;
      else if (sev === 'medium') score += 5;
      else if (sev === 'low') score += 2;
      else score += 3;
      // Source count: flagged by multiple audits = higher trust
      const sources = titleCounts[(item.title || '').toLowerCase().trim()] || 1;
      score += Math.min(sources - 1, 3) * 2; // +2 per extra source, max +6
      // Impact keywords in title or description
      const text = `${item.title || ''} ${item.description || ''}`;
      if (HIGH_IMPACT_KEYWORDS.test(text)) score += 3;
      // Quick win bonus: has both current and target values (actionable)
      if (item.current_value && item.new_value) score += 2;
      // Has a linked finding (agent-sourced = more trustworthy)
      if (item.finding_id) score += 1;
      return score;
    }

    // Score all items and sort within groups
    for (const item of deduped) {
      item.trust_score = computeTrustScore(item);
    }

    // Normalize pillar names for grouping display
    const pillarDisplayMap = {
      gbp: 'GBP', gbp_external: 'GBP',
      gsc: 'GSC', gsc_agent: 'GSC',
      website: 'Website', technical: 'Website',
    };

    // Group by display pillar → category, sorted by trust score desc
    const grouped = {};
    for (const item of deduped) {
      const displayPillar = pillarDisplayMap[item.pillar] || item.pillar;
      const category = item.category || item.type || 'General';
      if (!grouped[displayPillar]) grouped[displayPillar] = {};
      if (!grouped[displayPillar][category]) grouped[displayPillar][category] = [];
      grouped[displayPillar][category].push(item);
    }
    // Sort each category by trust_score descending
    for (const pillar of Object.values(grouped)) {
      for (const cat of Object.keys(pillar)) {
        pillar[cat].sort((a, b) => (b.trust_score || 0) - (a.trust_score || 0));
      }
    }

    // Stats
    const allScores = deduped.map(i => i.trust_score || 0);
    const stats = {
      total: deduped.length,
      pending: deduped.filter(i => i.status === 'pending').length,
      in_progress: deduped.filter(i => i.status === 'in-progress' || i.status === 'in_progress' || i.status === 'approved').length,
      done: deduped.filter(i => i.status === 'done' || i.status === 'completed').length,
      critical: deduped.filter(i => (i.severity || '').toLowerCase() === 'critical').length,
      medium: deduped.filter(i => (i.severity || '').toLowerCase() === 'medium').length,
      low: deduped.filter(i => (i.severity || '').toLowerCase() === 'low').length,
      duplicates_removed: items.length - deduped.length,
      avg_score: allScores.length ? Math.round(allScores.reduce((a, b) => a + b, 0) / allScores.length) : 0,
      max_score: allScores.length ? Math.max(...allScores) : 0,
    };

    res.json({ grouped, stats, total_raw: items.length, total_deduped: deduped.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Sync all pillars at once (for orchestrator)
// ==================== AI ORCHESTRATOR — intelligent cross-audit action plan ====================
app.post('/api/projects/:projectId/orchestrator/run', async (req, res) => {
  const { projectId } = req.params;
  if (!anthropic) return res.status(500).json({ error: 'Anthropic API not configured' });

  try {
    const proj = await pool.query('SELECT * FROM projects WHERE id=$1', [projectId]);
    if (proj.rows.length === 0) return res.status(404).json({ error: 'Project not found' });
    const project = proj.rows[0];

    // Gather all completed audit reports
    const auditPillars = ['gbp_external', 'gsc_agent', 'website'];
    const reports = {};
    for (const pillar of auditPillars) {
      const auditRes = await pool.query(
        `SELECT id, audit_data, completed_at FROM audits WHERE project_id=$1 AND pillar=$2 AND status='completed' ORDER BY completed_at DESC LIMIT 1`,
        [projectId, pillar]
      );
      if (auditRes.rows.length > 0) {
        const data = typeof auditRes.rows[0].audit_data === 'string' ? JSON.parse(auditRes.rows[0].audit_data) : auditRes.rows[0].audit_data;
        const reportText = data?.report || data?.final_report || '';
        if (reportText) {
          reports[pillar] = { text: reportText.slice(0, 15000), auditId: auditRes.rows[0].id, completedAt: auditRes.rows[0].completed_at };
        }
      }
    }

    if (Object.keys(reports).length === 0) {
      return res.status(400).json({ error: 'No completed audits found. Run at least one audit first.' });
    }

    console.log(`[orchestrator] Running AI orchestrator for project ${projectId} with ${Object.keys(reports).length} audit reports`);
    res.json({ status: 'running', pillars: Object.keys(reports) });

    // Run async — TWO-STEP orchestrator for maximum accuracy
    (async () => {
      try {
        const domain = (project.domain || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
        const serviceAreas = project.service_areas || [];
        const hasWordPress = !!(project.wordpress_url && project.wp_username && project.wp_app_password);

        // Build report sections
        let reportSection = '';
        for (const [pillar, r] of Object.entries(reports)) {
          const label = { gbp_external: 'GBP External Audit', gsc_agent: 'GSC Audit', website: 'Website Audit' }[pillar] || pillar;
          reportSection += `\n\n=== ${label} (completed ${new Date(r.completedAt).toLocaleDateString()}) ===\n${r.text}`;
        }

        // Include raw GSC data if available (structured source of truth for GSC metrics)
        let rawDataSection = '';
        if (reports.gsc_agent) {
          const gscAuditData = await pool.query('SELECT audit_data FROM audits WHERE id=$1', [reports.gsc_agent.auditId]);
          if (gscAuditData.rows.length > 0) {
            const ad = typeof gscAuditData.rows[0].audit_data === 'string' ? JSON.parse(gscAuditData.rows[0].audit_data) : gscAuditData.rows[0].audit_data;
            if (ad?.raw_gsc_data && ad.raw_gsc_data.length > 0) {
              rawDataSection += `\n\n=== RAW GSC DATA (structured, authoritative — use these numbers, not the report's paraphrasing) ===\n${JSON.stringify(ad.raw_gsc_data.slice(0, 100), null, 1)}`;
            }
          }
        }

        // ========== STEP 1: FACT EXTRACTION ==========
        // Extract only verifiable facts from reports — no recommendations, no opinions
        console.log(`[orchestrator] Step 1: Extracting structured facts...`);

        const factExtractionPrompt = `You are a precise data extractor. Read these SEO audit reports and extract ONLY verifiable facts — NO recommendations, NO opinions, NO suggestions.

For each fact, record:
- The exact data point (number, URL, status, score, etc.)
- Which report it came from
- Whether it's a measured value or an inference

Return ONLY a JSON object with these sections:

{
  "pages": [{"url": "/path", "exists": true|false, "title": "...", "meta_desc": "...", "word_count": 123, "has_schema": true|false, "source": "report_name"}],
  "gbp_profile": {"name": "...", "rating": 4.2, "review_count": 47, "categories": ["..."], "has_description": true|false|null, "has_hours": true|false|null, "has_photos": true|false|null, "photo_count": 12, "source": "report_name"},
  "competitors": [{"name": "...", "rating": 4.5, "review_count": 80, "position": 1, "source": "report_name"}],
  "gsc_metrics": [{"query": "...", "page": "/path", "clicks": 10, "impressions": 500, "ctr": 2.0, "position": 8.5, "source": "gsc_data"}],
  "technical_issues": [{"issue": "...", "url": "/path", "details": "...", "source": "report_name"}],
  "service_areas": [{"name": "...", "has_page": true|false, "page_url": "/path_or_null", "source": "report_name"}],
  "directories": [{"name": "...", "listed": true|false|null, "source": "report_name"}],
  "scores": {"performance": 45, "lcp": "3.2s", "cls": 0.15, "source": "report_name"}
}

RULES:
- Only include data EXPLICITLY stated in the reports. If a field is not mentioned, use null.
- For pages: only list pages the report explicitly names with URLs.
- For has_description/has_hours/has_photos: use null if the report doesn't mention it (NOT false).
- Include the raw GSC data rows as gsc_metrics if provided.
- Do NOT infer — if the report says "N/A" or doesn't mention something, it's null.

REPORTS:
${reportSection}
${rawDataSection}`;

        const factResp = await anthropic.messages.create({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 12000,
          messages: [{ role: 'user', content: factExtractionPrompt }]
        });

        const factText = factResp.content[0].text.trim();
        const factJsonMatch = factText.match(/\{[\s\S]*\}/);
        let facts = {};
        if (factJsonMatch) {
          try { facts = JSON.parse(factJsonMatch[0]); } catch (e) {
            console.error('[orchestrator] Failed to parse facts JSON:', e.message);
          }
        }
        console.log(`[orchestrator] Step 1 complete: ${Object.keys(facts).length} fact categories extracted`);

        // ========== STEP 2: ACTION ITEMS FROM FACTS ==========
        // Generate action items grounded in the extracted facts
        console.log(`[orchestrator] Step 2: Generating action items from verified facts...`);

        const orchestratorPrompt = `You are the SEO Orchestrator for "${project.business_name || project.name}" (${domain}).
Service areas: ${serviceAreas.map(a => a.name).join(', ') || 'not set'}
WordPress connected: ${hasWordPress ? 'YES — can auto-fix meta titles, descriptions, content via API' : 'NO — content changes need manual WordPress editing'}

You have TWO inputs:
1. STRUCTURED FACTS (verified data extracted from audit reports — this is your PRIMARY source of truth)
2. AUDIT REPORTS (for context and recommendations — SECONDARY source)

=== STRUCTURED FACTS (PRIMARY — trust these over report text) ===
${JSON.stringify(facts, null, 2)}

=== AUDIT REPORTS (SECONDARY — use for context only) ===
${reportSection}

YOUR JOB:
1. Create action items ONLY for issues supported by the STRUCTURED FACTS above.
2. If facts.pages shows a page EXISTS (exists: true), do NOT recommend creating it — recommend optimizing.
3. If facts.gbp_profile shows a field is null, do NOT flag it as missing — data was unavailable.
4. For GSC items: use the actual numbers from facts.gsc_metrics (position, CTR, clicks). Do NOT make up metrics.
5. For competitors: use actual competitor data from facts.competitors.
6. DEDUPLICATE — same issue across audits = ONE item.

ASSIGN execution_type:
- "plugin" (WP Plugin) — WordPress content changes via REST API + Yoast: meta titles, descriptions, headings, schema, content, pages, internal links, canonical tags, redirects
- "manual" with assignee_label "Manual" — business owner physical tasks: photos, review requests, directory registrations, claiming listings
- "manual" with assignee_label "SEO Specialist" — GBP edits (description, categories, hours, posts, review responses), strategy, server/theme configs, social media
- "api" (Automated) — API tasks: URL indexing submission, sitemap submission

SEVERITY: Critical (blocking revenue), High (significant impact), Medium (improvement), Low (nice-to-have)
PRIORITY ORDER: Quick wins first (GSC position 4-20), then critical fixes, then optimizations.

VALIDATION RULES — every action item MUST pass ALL of these:
- The "current_value" field must contain an actual value from the STRUCTURED FACTS (a real number, URL, or status — not a description)
- The "page_url" must be a real URL from facts.pages or facts.gsc_metrics — NEVER invented
- The "description" must reference specific data from STRUCTURED FACTS
- If you cannot find supporting data in STRUCTURED FACTS for an issue mentioned in the reports, SKIP that issue entirely

Return ONLY a JSON array:
[{
  "pillar": "<gbp_external|gsc_agent|website>",
  "category": "<section name>",
  "title": "<short actionable title>",
  "description": "<what's wrong — cite specific data from facts>",
  "recommendation": "<specific fix with steps>",
  "severity": "<Critical|High|Medium|Low>",
  "execution_type": "<plugin|manual|api>",
  "assignee_label": "<WP Plugin|SEO Specialist|Manual|Automated>",
  "current_value": "<actual value from facts>",
  "new_value": "<target value>",
  "page_url": "<real URL from facts or empty string>",
  "fact_source": "<which fact category supports this: pages|gbp_profile|competitors|gsc_metrics|technical_issues|service_areas|directories|scores>"
}]`;

        const resp = await anthropic.messages.create({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 16000,
          messages: [{ role: 'user', content: orchestratorPrompt }]
        });

        const text = resp.content[0].text.trim();
        const jsonMatch = text.match(/\[[\s\S]*\]/);
        if (!jsonMatch) {
          console.error('[orchestrator] No JSON array found in Step 2 response');
          return;
        }

        const items = JSON.parse(jsonMatch[0]);
        console.log(`[orchestrator] Step 2: AI returned ${items.length} action items`);

        // Filter out duplicates flagged by AI
        const uniqueItems = items.filter(i => !i.duplicate_of);
        console.log(`[orchestrator] After dedup: ${uniqueItems.length} items`);

        // Validate
        const validExecTypes = ['plugin', 'manual', 'api'];
        const validSeverities = ['Critical', 'High', 'Medium', 'Low'];
        const PILLAR_CATEGORIES = {
          gbp_external: ['Profile Completeness', 'NAP Consistency', 'Reviews & Reputation', 'Competitor Analysis', 'Directory & Citations', 'Photos & Media', 'Suburb Coverage'],
          website: ['Site Health', 'Crawlability', 'On-Page Issues', 'Content Quality', 'Core Web Vitals', 'Schema & Data'],
          gsc_agent: ['Quick Wins', 'Low CTR Pages', 'Cannibalization', 'Zero-Click Pages', 'Underperforming Pages'],
        };

        // Clean slate — delete ALL action items and findings for this project
        await pool.query('DELETE FROM action_items WHERE project_id=$1', [projectId]);
        await pool.query('DELETE FROM audit_findings WHERE project_id=$1', [projectId]);

        let savedCount = 0;
        let skippedCount = 0;
        for (const item of uniqueItems) {
          const pillar = auditPillars.includes(item.pillar) ? item.pillar : 'website';
          const validCats = PILLAR_CATEGORIES[pillar] || [];
          const category = validCats.find(c => c.toLowerCase() === (item.category || '').toLowerCase())
            || validCats.find(c => (item.category || '').toLowerCase().includes(c.toLowerCase().split(' ')[0]))
            || validCats[0] || 'General';
          const severity = validSeverities.find(s => s.toLowerCase() === (item.severity || '').toLowerCase()) || 'Medium';
          const execType = validExecTypes.includes(item.execution_type) ? item.execution_type : 'manual';
          const assigneeLabel = item.assignee_label || (execType === 'plugin' ? 'WP Plugin' : execType === 'api' ? 'Automated' : 'SEO Specialist');

          if (!item.title) { skippedCount++; continue; }

          const auditId = reports[pillar]?.auditId || null;

          // Save finding
          const fRes = await pool.query(
            `INSERT INTO audit_findings (project_id, audit_id, pillar, category, title, description, recommendation, severity, current_value, recommended_value, status)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'approved') RETURNING id`,
            [projectId, auditId, pillar, category, item.title.slice(0, 200), (item.description || '').slice(0, 1000),
             (item.recommendation || '').slice(0, 1000), severity, (item.current_value || '').slice(0, 500), (item.new_value || '').slice(0, 500)]
          );

          // Save action item
          await pool.query(
            `INSERT INTO action_items (project_id, finding_id, pillar, type, category, title, description, current_value, new_value, severity, status, execution_type, assignee_label)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'pending', $11, $12)`,
            [projectId, fRes.rows[0].id, pillar, category, category, item.title.slice(0, 200),
             (item.recommendation || item.description || '').slice(0, 1000),
             (item.current_value || '').slice(0, 500), (item.new_value || '').slice(0, 500),
             severity, execType, assigneeLabel]
          );
          savedCount++;
        }

        console.log(`[orchestrator] Saved ${savedCount} action items (${skippedCount} skipped) for project ${projectId}`);
      } catch (e) {
        console.error('[orchestrator] Error:', e.message);
      }
    })();
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Legacy sync-all removed — orchestrator is the sole source of truth for action items

// ==================== SERPAPI HELPER ====================

async function serpApiSearch(params) {
  if (!SERPAPI_KEY) throw new Error('SERPAPI_KEY not configured');
  // Filter out undefined/null values to avoid sending them as strings
  const cleanParams = Object.fromEntries(Object.entries({ ...params, api_key: SERPAPI_KEY }).filter(([_, v]) => v != null));
  const searchParams = new URLSearchParams(cleanParams);
  const resp = await fetch(`https://serpapi.com/search.json?${searchParams}`);
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`SerpAPI error ${resp.status}: ${text.substring(0, 200)}`);
  }
  return resp.json();
}

// ==================== 11b. SPEED AUDIT (via Google PageSpeed Insights API) ====================

// Helper: get WordPress URL for a project
async function getProjectWpUrl(projectId, userId) {
  const result = await pool.query('SELECT wordpress_url FROM projects WHERE id=$1 AND user_id=$2', [projectId, userId]);
  if (result.rows.length === 0) return null;
  return result.rows[0].wordpress_url;
}

// Helper: fetch from WP REST API
async function wpFetch(wpUrl, endpoint) {
  const url = `${wpUrl.replace(/\/$/, '')}/wp-json/${endpoint}`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`WP API error: ${resp.status} ${resp.statusText}`);
  return resp.json();
}

// Helper: run Google PageSpeed Insights on a URL and extract image issues
async function runPageSpeedAudit(url, strategy = 'mobile') {
  const PAGESPEED_KEY = process.env.PAGESPEED_API_KEY;
  const keyParam = PAGESPEED_KEY ? `&key=${PAGESPEED_KEY}` : '';
  const apiUrl = `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=${encodeURIComponent(url)}&strategy=${strategy}&category=performance${keyParam}`;
  const resp = await fetch(apiUrl);
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`PageSpeed API error ${resp.status}: ${text.substring(0, 200)}`);
  }
  return resp.json();
}

// Helper: extract image data from Lighthouse results
function extractImageIssues(lighthouseData) {
  const audits = lighthouseData?.lighthouseResult?.audits || {};
  const images = [];
  const seenSrcs = new Set();

  const imageAudits = [
    { key: 'uses-optimized-images', issue: 'too_large' },
    { key: 'modern-image-formats', issue: 'no_webp' },
    { key: 'unsized-images', issue: 'missing_width' },
    { key: 'offscreen-images', issue: 'no_lazy_load' },
    { key: 'uses-responsive-images', issue: 'oversized' },
  ];

  for (const { key, issue } of imageAudits) {
    const audit = audits[key];
    if (!audit?.details?.items) continue;
    for (const item of audit.details.items) {
      const src = item.url || item.node?.snippet || '';
      if (!src || src.startsWith('data:')) continue;
      const shortSrc = src.split('?')[0];
      if (seenSrcs.has(shortSrc)) {
        const existing = images.find(i => i.src.split('?')[0] === shortSrc);
        if (existing && !existing.issues.includes(issue)) existing.issues.push(issue);
      } else {
        seenSrcs.add(shortSrc);
        images.push({
          src,
          file_size_kb: item.totalBytes ? Math.round(item.totalBytes / 1024) : null,
          width: item.node?.boundingRect?.width || null,
          height: item.node?.boundingRect?.height || null,
          has_webp: issue !== 'no_webp',
          issues: [issue],
          wastedBytes: item.wastedBytes || 0,
        });
      }
    }
  }

  // Check for missing alt text
  const altAudit = audits['image-alt'];
  if (altAudit?.details?.items) {
    for (const item of altAudit.details.items) {
      const src = item.node?.snippet?.match(/src="([^"]+)"/)?.[1] || '';
      if (!src) continue;
      const shortSrc = src.split('?')[0];
      if (seenSrcs.has(shortSrc)) {
        const existing = images.find(i => i.src.split('?')[0] === shortSrc);
        if (existing && !existing.issues.includes('missing_alt')) existing.issues.push('missing_alt');
      } else {
        seenSrcs.add(shortSrc);
        images.push({ src, file_size_kb: null, width: null, height: null, has_webp: true, issues: ['missing_alt'], wastedBytes: 0 });
      }
    }
  }

  return images;
}

// Helper: discover pages from sitemap or WP REST API
async function discoverPages(projectUrl, wpUrl, authHeaders = null) {
  const pages = [];
  const baseUrl = projectUrl.replace(/\/$/, '');
  const seenUrls = new Set();

  // Helper: extract page URLs from a single sitemap XML
  function extractPagesFromSitemap(xml) {
    const urlMatches = xml.match(/<loc>([^<]+)<\/loc>/g) || [];
    for (const match of urlMatches) {
      const url = match.replace(/<\/?loc>/g, '');
      if (url.endsWith('.pdf') || url.match(/\.(jpg|png|gif|svg)$/i)) continue;
      if (url.endsWith('.xml')) continue; // skip sub-sitemap refs (handled separately)
      if (seenUrls.has(url)) continue;
      seenUrls.add(url);
      const slug = url.replace(baseUrl, '').replace(/^\/|\/$/g, '') || 'home';
      pages.push({ page_id: slug, title: slug === 'home' ? 'Homepage' : slug.replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase()), slug, url });
    }
  }

  // Try sitemap.xml first
  try {
    const sitemapResp = await fetch(`${baseUrl}/sitemap.xml`, { headers: { 'User-Agent': 'SEORoomBot/1.0' } });
    if (sitemapResp.ok) {
      const xml = await sitemapResp.text();

      // Check if this is a sitemap index (contains sub-sitemaps like post-sitemap.xml)
      const subSitemapMatches = xml.match(/<loc>([^<]+\.xml)<\/loc>/g) || [];
      if (subSitemapMatches.length > 0) {
        // It's a sitemap index — fetch each sub-sitemap
        for (const subMatch of subSitemapMatches) {
          const subUrl = subMatch.replace(/<\/?loc>/g, '');
          try {
            const subResp = await fetch(subUrl, { headers: { 'User-Agent': 'SEORoomBot/1.0' } });
            if (subResp.ok) {
              const subXml = await subResp.text();
              extractPagesFromSitemap(subXml);
            }
          } catch (e) { /* skip failed sub-sitemap */ }
          if (pages.length >= 50) break;
        }
      } else {
        // It's a regular sitemap — extract pages directly
        extractPagesFromSitemap(xml);
      }

      // Cap at 50
      if (pages.length > 50) pages.length = 50;
    }
  } catch (e) { /* sitemap not available */ }

  // Try WP REST API if available and no sitemap pages (or to supplement sitemap)
  if (wpUrl) {
    try {
      const wpBase = wpUrl.replace(/\/$/, '');
      const fetchOpts = { signal: AbortSignal.timeout(30000), ...(authHeaders ? { headers: authHeaders } : {}) };
      const resp = await fetch(`${wpBase}/wp-json/wp/v2/pages?per_page=50&status=publish&_fields=id,title,slug,link`, fetchOpts);
      if (resp.ok) {
        const wpPages = await resp.json();
        for (const p of (Array.isArray(wpPages) ? wpPages : [])) {
          const url = p.link || '';
          if (!seenUrls.has(url)) {
            seenUrls.add(url);
            pages.push({ page_id: String(p.id), title: p.title?.rendered || p.slug, slug: p.slug, url });
          }
        }
      }
    } catch (e) { console.log('[discoverPages] WP REST API failed:', e.message); }
  }

  // Fallback: just test the homepage
  if (pages.length === 0) {
    pages.push({ page_id: 'home', title: 'Homepage', slug: '', url: baseUrl });
  }

  return pages;
}

// Run speed audit on ALL pages (via Google PageSpeed Insights)
app.post('/api/speed-audit/:projectId/run', async (req, res) => {
  try {
    const projRes = await pool.query('SELECT * FROM projects WHERE id=$1', [req.params.projectId]);
    if (projRes.rows.length === 0) return res.status(404).json({ error: 'Project not found' });
    const project = projRes.rows[0];
    const siteUrl = project.wordpress_url || (project.domain ? `https://${project.domain.replace(/^https?:\/\//, '')}` : null);
    if (!siteUrl) return res.status(400).json({ error: 'Website URL or domain not configured. Set it in Project Settings.' });

    const pages = await discoverPages(siteUrl, project.wordpress_url, getWpAuthHeaders(project));

    // Process pages in parallel batches of 5
    const BATCH_SIZE = 5;
    const results = [];

    async function processPage(page) {
      try {
        const psData = await runPageSpeedAudit(page.url, 'mobile');
        const metrics = psData.lighthouseResult?.audits || {};
        const score = Math.round((psData.lighthouseResult?.categories?.performance?.score || 0) * 100);
        return {
          page_id: page.page_id,
          title: page.title,
          slug: page.slug,
          url: page.url,
          performance_score: score,
          cwv: {
            lcp: metrics['largest-contentful-paint']?.displayValue || 'N/A',
            fid: metrics['max-potential-fid']?.displayValue || 'N/A',
            cls: metrics['cumulative-layout-shift']?.displayValue || 'N/A',
            fcp: metrics['first-contentful-paint']?.displayValue || 'N/A',
            si: metrics['speed-index']?.displayValue || 'N/A',
            tbt: metrics['total-blocking-time']?.displayValue || 'N/A',
            score,
          },
        };
      } catch (err) {
        return {
          page_id: page.page_id, title: page.title, slug: page.slug, url: page.url,
          error: err.message,
        };
      }
    }

    for (let i = 0; i < pages.length; i += BATCH_SIZE) {
      const batch = pages.slice(i, i + BATCH_SIZE);
      const batchResults = await Promise.all(batch.map(processPage));
      results.push(...batchResults);
    }

    // Save audit to DB
    const auditResult = await pool.query(
      `INSERT INTO audits (project_id, pillar, status, audit_data, started_at, completed_at)
       VALUES ($1, 'speed', 'completed', $2, NOW(), NOW())
       RETURNING id`,
      [req.params.projectId, JSON.stringify({ results, ran_at: new Date().toISOString() })]
    );

    res.json({
      audit_id: auditResult.rows[0].id,
      total_pages: results.length,
      results,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PageSpeed Insights for individual page (used by "Run PageSpeed" button per page)
app.get('/api/speed-audit/:projectId/pagespeed', async (req, res) => {
  const { url, strategy = 'mobile' } = req.query;
  if (!url) return res.status(400).json({ error: 'url parameter required' });

  try {
    const data = await runPageSpeedAudit(url, strategy);
    const metrics = data.lighthouseResult?.audits;
    const cwv = {
      lcp: metrics?.['largest-contentful-paint']?.displayValue || 'N/A',
      fid: metrics?.['max-potential-fid']?.displayValue || 'N/A',
      cls: metrics?.['cumulative-layout-shift']?.displayValue || 'N/A',
      fcp: metrics?.['first-contentful-paint']?.displayValue || 'N/A',
      si: metrics?.['speed-index']?.displayValue || 'N/A',
      tbt: metrics?.['total-blocking-time']?.displayValue || 'N/A',
      score: Math.round((data.lighthouseResult?.categories?.performance?.score || 0) * 100),
    };
    res.json({ url, strategy, cwv });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Get latest speed audit results (for persistence across navigation)
app.get('/api/projects/:projectId/audits/speed/latest', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT audit_data FROM audits WHERE project_id=$1 AND pillar='speed' ORDER BY completed_at DESC LIMIT 1`,
      [req.params.projectId]
    );
    if (result.rows.length === 0) return res.json({ results: [] });
    const data = typeof result.rows[0].audit_data === 'string' ? JSON.parse(result.rows[0].audit_data) : result.rows[0].audit_data;
    res.json({ results: data.results || [] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ==================== INDEXING STATUS CHECK ====================

// Discover all important pages and check indexing status
app.post('/api/projects/:projectId/indexing/check', async (req, res) => {
  const { projectId } = req.params;
  try {
    const proj = await pool.query('SELECT * FROM projects WHERE id=$1', [projectId]);
    if (proj.rows.length === 0) return res.status(404).json({ error: 'Project not found' });
    const project = proj.rows[0];
    const domain = (project.domain || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
    const gscProperty = project.gsc_property;

    const accessToken = await getGscAccessToken(req.auth?.userId);
    if (!accessToken) return res.status(400).json({ error: 'GSC not connected. Connect in Agency Integrations.' });

    // Find matching GSC site
    let matchedSite = gscProperty;
    if (!matchedSite) {
      const sites = await fetch('https://www.googleapis.com/webmasters/v3/sites', {
        headers: { Authorization: `Bearer ${accessToken}` }
      }).then(r => r.json());
      matchedSite = (sites.siteEntry || []).map(s => s.siteUrl).find(s => s.includes(domain.replace(/^www\./, '')));
    }
    if (!matchedSite) return res.status(400).json({ error: 'GSC property not found. Set it in Project Settings.' });

    const baseUrl = `https://${domain}`;

    // Discover pages: ONLY home, services, and suburb pages
    const pageSet = new Set();
    // Only match top-level service pages, not every URL containing these words
    const servicePagePattern = /^\/(services?\/?|gas-fitt|drain-clean|hot-water|water-filter|emergency-plumb|blocked-drain|burst-pipe|leak-detect|tap-repair|toilet-repair|bathroom-renov|kitchen-plumb)([^\/]*)\/?$/i;

    // 1. Homepage
    pageSet.add(baseUrl + '/');

    // 2. From sitemap — filter to only services and suburb pages
    let allSitemapUrls = [];
    try {
      let sitemapResp = await fetch(`${baseUrl}/sitemap_index.xml`, { signal: AbortSignal.timeout(10000) });
      if (!sitemapResp.ok) sitemapResp = await fetch(`${baseUrl}/sitemap.xml`, { signal: AbortSignal.timeout(10000) });
      if (sitemapResp.ok) {
        const xml = await sitemapResp.text();
        if (xml.includes('<sitemapindex')) {
          const subUrls = (xml.match(/<loc>([^<]+)<\/loc>/g) || []).map(m => m.replace(/<\/?loc>/g, ''));
          for (const subUrl of subUrls.slice(0, 3)) {
            try {
              const subResp = await fetch(subUrl, { signal: AbortSignal.timeout(10000) });
              if (subResp.ok) {
                const subXml = await subResp.text();
                (subXml.match(/<loc>([^<]+)<\/loc>/g) || []).forEach(m => {
                  allSitemapUrls.push(m.replace(/<\/?loc>/g, ''));
                });
              }
            } catch (e) {}
          }
        } else {
          (xml.match(/<loc>([^<]+)<\/loc>/g) || []).forEach(m => {
            allSitemapUrls.push(m.replace(/<\/?loc>/g, ''));
          });
        }
      }
    } catch (e) { console.log('[indexing] Sitemap fetch failed:', e.message); }

    // Filter sitemap URLs to ONLY service and suburb pages (strict)
    const serviceAreas = project.service_areas || [];
    const suburbSlugs = serviceAreas.map(a => (a.name || '').toLowerCase().replace(/\s+/g, '-')).filter(Boolean);

    for (const url of allSitemapUrls) {
      if (url.endsWith('.xml') || url.match(/\.(jpg|png|gif|pdf)$/i)) continue;
      const path = url.replace(baseUrl, '');
      // Include if it's a service page (top-level only)
      if (servicePagePattern.test(path)) { pageSet.add(url); continue; }
      // Include if the path IS a suburb slug (e.g. /plumber-leeming/ or /leeming/)
      const cleanPath = path.replace(/^\/|\/$/g, '').toLowerCase();
      if (suburbSlugs.some(slug => cleanPath === slug || cleanPath === `plumber-${slug}` || cleanPath === `plumbing-${slug}` || cleanPath === `plumber-in-${slug}`)) { pageSet.add(url); continue; }
      // Include only specific important pages
      if (['contact', 'about', 'services', 'about-us', 'contact-us'].includes(cleanPath)) { pageSet.add(url); }
    }

    // 3. Add suburb pages from service areas (in case not in sitemap)
    for (const slug of suburbSlugs) {
      const match = allSitemapUrls.find(u => u.toLowerCase().includes(slug));
      if (match) pageSet.add(match);
    }

    const allPages = [...pageSet];
    console.log(`[indexing] Checking ${allPages.length} pages (filtered from ${allSitemapUrls.length} sitemap URLs) for project ${projectId}`);

    // Check each page via URL Inspection API
    const results = [];
    for (const pageUrl of allPages) {
      try {
        const inspRes = await fetch('https://searchconsole.googleapis.com/v1/urlInspection/index:inspect', {
          method: 'POST',
          headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ inspectionUrl: pageUrl, siteUrl: matchedSite })
        });
        if (inspRes.ok) {
          const inspData = await inspRes.json();
          const idx = inspData.inspectionResult?.indexStatusResult || {};
          const mobile = inspData.inspectionResult?.mobileUsabilityResult || {};
          const rich = inspData.inspectionResult?.richResultsResult || {};
          let path;
          try { path = new URL(pageUrl).pathname; } catch { path = pageUrl; }

          results.push({
            url: pageUrl,
            path,
            verdict: idx.verdict || 'UNKNOWN',
            coverageState: idx.coverageState || 'Unknown',
            robotsTxtState: idx.robotsTxtState || null,
            indexingState: idx.indexingState || null,
            pageFetchState: idx.pageFetchState || null,
            lastCrawlTime: idx.lastCrawlTime || null,
            crawledAs: idx.crawledAs || null,
            googleCanonical: idx.googleCanonical || null,
            userCanonical: idx.userCanonical || null,
            referringUrls: idx.referringUrls || [],
            mobileVerdict: mobile.verdict || null,
            mobileIssues: (mobile.issues || []).map(i => i.issueType),
            richVerdict: rich.verdict || null,
          });
        } else {
          let path;
          try { path = new URL(pageUrl).pathname; } catch { path = pageUrl; }
          const errText = await inspRes.text();
          results.push({ url: pageUrl, path, verdict: 'ERROR', coverageState: `API error: ${inspRes.status}`, error: errText.substring(0, 100) });
        }
      } catch (e) {
        let path;
        try { path = new URL(pageUrl).pathname; } catch { path = pageUrl; }
        results.push({ url: pageUrl, path, verdict: 'ERROR', coverageState: e.message });
      }
    }

    // Summary stats
    const indexed = results.filter(r => r.verdict === 'PASS').length;
    const notIndexed = results.filter(r => r.verdict === 'FAIL' || r.verdict === 'NEUTRAL').length;
    const errors = results.filter(r => r.verdict === 'ERROR').length;

    console.log(`[indexing] Done: ${indexed} indexed, ${notIndexed} not indexed, ${errors} errors out of ${results.length}`);

    const sortedResults = results.sort((a, b) => {
      const order = { FAIL: 0, NEUTRAL: 1, ERROR: 2, UNKNOWN: 3, PASS: 4 };
      return (order[a.verdict] || 3) - (order[b.verdict] || 3);
    });

    // Save to audits table for persistence
    const auditData = {
      total: sortedResults.length,
      indexed,
      notIndexed,
      errors,
      results: sortedResults,
      ran_at: new Date().toISOString(),
    };
    try {
      const saveResult = await pool.query(
        `INSERT INTO audits (project_id, pillar, status, audit_data, started_at, completed_at)
         VALUES ($1::int, 'indexing', 'completed', $2::jsonb, NOW(), NOW()) RETURNING id`,
        [parseInt(projectId), JSON.stringify(auditData)]
      );
      console.log(`[indexing] Saved audit id=${saveResult.rows[0].id} for project ${projectId} (${sortedResults.length} pages)`);
    } catch (saveErr) {
      console.error('[indexing] Failed to save audit:', saveErr.message, saveErr.stack);
    }

    res.json({ ...auditData, saved: true });
  } catch (e) {
    console.error('[indexing] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Get latest indexing results (persistence across navigation)
app.get('/api/projects/:projectId/audits/indexing/latest', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT audit_data, completed_at FROM audits WHERE project_id=$1 AND pillar='indexing' ORDER BY completed_at DESC LIMIT 1`,
      [req.params.projectId]
    );
    if (result.rows.length === 0) return res.json({ results: [] });
    const data = typeof result.rows[0].audit_data === 'string' ? JSON.parse(result.rows[0].audit_data) : result.rows[0].audit_data;
    res.json({ ...data, completed_at: result.rows[0].completed_at });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ==================== GBP PROFILE (from Chrome Extension) ====================

// Store GBP profile data scraped by the extension
app.post('/api/projects/:projectId/gbp-profile', async (req, res) => {
  const { projectId } = req.params;
  const profileData = req.body;
  try {
    // Store in project_integrations as kind='gbp_profile'
    await pool.query(
      `INSERT INTO project_integrations (project_id, kind, config, status, updated_at)
       VALUES ($1, 'gbp_profile', $2, 'connected', NOW())
       ON CONFLICT (project_id, kind)
       DO UPDATE SET config=$2, status='connected', updated_at=NOW()`,
      [projectId, JSON.stringify(profileData)]
    );
    console.log(`[gbp-profile] Stored GBP profile for project ${projectId}: ${profileData.business?.name || 'unknown'}`);
    res.json({ ok: true, message: 'GBP profile data saved' });
  } catch (e) {
    console.error('[gbp-profile] Save error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Get stored GBP profile data
app.get('/api/projects/:projectId/gbp-profile', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT config, updated_at FROM project_integrations WHERE project_id=$1 AND kind='gbp_profile'`,
      [req.params.projectId]
    );
    if (result.rows.length === 0) return res.json({ profile: null });
    const config = typeof result.rows[0].config === 'string' ? JSON.parse(result.rows[0].config) : result.rows[0].config;
    res.json({ profile: config, updated_at: result.rows[0].updated_at });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ==================== CITATIONS & DIRECTORIES ====================

// Get all directories with project-specific status
app.get('/api/projects/:projectId/citations', async (req, res) => {
  try {
    const saved = await pool.query(
      'SELECT directory_name, status, listing_url, notes, updated_at FROM citations WHERE project_id=$1',
      [req.params.projectId]
    );
    const statusMap = {};
    for (const row of saved.rows) {
      statusMap[row.directory_name] = { status: row.status, listing_url: row.listing_url, notes: row.notes, updated_at: row.updated_at };
    }
    const directories = AUSTRALIAN_DIRECTORIES.map(d => ({
      ...d,
      status: statusMap[d.name]?.status || 'not_listed',
      listing_url: statusMap[d.name]?.listing_url || '',
      notes: statusMap[d.name]?.notes || '',
      updated_at: statusMap[d.name]?.updated_at || null,
    }));
    const listed = directories.filter(d => d.status === 'listed').length;
    const pending = directories.filter(d => d.status === 'pending').length;
    res.json({ directories, stats: { total: directories.length, listed, pending, not_listed: directories.length - listed - pending } });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Scan all directories to check if business is listed
app.post('/api/projects/:projectId/citations/scan', async (req, res) => {
  const { projectId } = req.params;
  try {
    const proj = await pool.query('SELECT * FROM projects WHERE id=$1', [projectId]);
    if (proj.rows.length === 0) return res.status(404).json({ error: 'Project not found' });
    const project = proj.rows[0];
    const businessName = project.business_name || project.name || '';
    const domain = (project.domain || '').replace(/^https?:\/\//, '').replace(/\/$/, '');

    if (!SERPAPI_KEY) return res.status(400).json({ error: 'SerpAPI key not configured' });
    if (!businessName) return res.status(400).json({ error: 'Business name required in Project Settings' });

    const location = project.location || '';
    const gbpPlaceId = project.gbp_location_id || '';

    console.log(`[citations] Scanning ${AUSTRALIAN_DIRECTORIES.length} directories for "${businessName}" (${domain})`);

    // Platforms that can't be checked via site: search — detect differently
    const specialPlatforms = {
      'Google Business Profile': async () => {
        // If GBP is connected or Place ID is set, it's listed
        if (gbpPlaceId) return { status: 'listed', listing_url: `https://www.google.com/maps/place/?q=place_id:${gbpPlaceId}`, notes: 'Verified: GBP Place ID connected in Project Settings' };
        // Otherwise search Google Maps
        try {
          const mapsData = await serpApiSearch({ engine: 'google_maps', q: `${businessName} ${location}`, api_key: SERPAPI_KEY });
          const match = (mapsData.local_results || []).find(r => r.title?.toLowerCase().includes(businessName.toLowerCase().split(' ')[0]) || (r.website && r.website.includes(domain)));
          if (match) return { status: 'listed', listing_url: match.place_id ? `https://www.google.com/maps/place/?q=place_id:${match.place_id}` : match.link, notes: `Found on Google Maps: ${match.title}, ${match.rating || '?'} stars, ${match.reviews || 0} reviews` };
        } catch (e) {}
        return null;
      },
      'Apple Maps (Apple Business Connect)': async () => {
        // Can't check programmatically — search Google for apple maps listing
        try {
          const data = await serpApiSearch({ engine: 'google', q: `site:maps.apple.com "${businessName}"`, num: 3, api_key: SERPAPI_KEY });
          if ((data.organic_results || []).length > 0) return { status: 'listed', listing_url: data.organic_results[0].link, notes: `Found on Apple Maps` };
        } catch (e) {}
        return null;
      },
      'Bing Places': async () => {
        try {
          const data = await serpApiSearch({ engine: 'google', q: `site:bing.com/maps "${businessName}" ${location.split(',')[0] || ''}`, num: 3, api_key: SERPAPI_KEY });
          if ((data.organic_results || []).length > 0) return { status: 'listed', listing_url: data.organic_results[0].link, notes: `Found on Bing Maps` };
        } catch (e) {}
        return null;
      },
      'Facebook Business': async () => {
        try {
          const data = await serpApiSearch({ engine: 'google', q: `site:facebook.com "${businessName}" ${location.split(',')[0] || ''}`, num: 5, api_key: SERPAPI_KEY });
          const match = (data.organic_results || []).find(r => r.link?.includes('facebook.com/') && !r.link?.includes('/posts/') && !r.link?.includes('/photos/'));
          if (match) return { status: 'listed', listing_url: match.link, notes: `Found: ${match.title || ''}`.trim() };
        } catch (e) {}
        return null;
      },
      'LinkedIn Company': async () => {
        try {
          const data = await serpApiSearch({ engine: 'google', q: `site:linkedin.com/company "${businessName}"`, num: 3, api_key: SERPAPI_KEY });
          const match = (data.organic_results || []).find(r => r.link?.includes('linkedin.com/company/'));
          if (match) return { status: 'listed', listing_url: match.link, notes: `Found: ${match.title || ''}`.trim() };
        } catch (e) {}
        return null;
      },
    };

    const results = [];
    for (const dir of AUSTRALIAN_DIRECTORIES) {
      try {
        // Use special detection for platforms that don't work with site: search
        if (specialPlatforms[dir.name]) {
          const specialResult = await specialPlatforms[dir.name]();
          if (specialResult) {
            results.push({ name: dir.name, ...specialResult });
            console.log(`[citations] ${dir.name}: FOUND (special)`);
            continue;
          }
          // If special check found nothing, mark as not listed
          results.push({ name: dir.name, status: 'not_listed', listing_url: null, notes: 'Not found via automated scan' });
          console.log(`[citations] ${dir.name}: NOT FOUND (special)`);
          continue;
        }

        // Standard site: search for regular directories
        const searchData = await serpApiSearch({
          engine: 'google',
          q: `site:${dir.url} "${businessName}"`,
          num: 3,
          api_key: SERPAPI_KEY,
        });

        const organicResults = searchData.organic_results || [];
        let found = organicResults.length > 0;
        let listingUrl = found ? organicResults[0].link : null;
        let snippet = found ? (organicResults[0].snippet || '') : '';

        // Backup: search by domain
        if (!found && domain) {
          const domainSearch = await serpApiSearch({
            engine: 'google',
            q: `site:${dir.url} "${domain}"`,
            num: 3,
            api_key: SERPAPI_KEY,
          });
          const domainResults = domainSearch.organic_results || [];
          if (domainResults.length > 0) {
            found = true;
            listingUrl = domainResults[0].link;
            snippet = `Found via domain. ${domainResults[0].snippet || ''}`.trim();
          }
        }

        results.push({
          name: dir.name,
          status: found ? 'listed' : 'not_listed',
          listing_url: listingUrl,
          notes: found ? `Auto-detected: ${snippet}`.substring(0, 200) : '',
        });

        console.log(`[citations] ${dir.name}: ${found ? 'FOUND' : 'NOT FOUND'}`);
      } catch (e) {
        console.log(`[citations] Error checking ${dir.name}:`, e.message);
        results.push({ name: dir.name, status: 'not_listed', listing_url: null, notes: `Scan error: ${e.message}` });
      }
    }

    // Save all results to DB
    for (const r of results) {
      await pool.query(
        `INSERT INTO citations (project_id, directory_name, status, listing_url, notes, updated_at)
         VALUES ($1, $2, $3, $4, $5, NOW())
         ON CONFLICT (project_id, directory_name)
         DO UPDATE SET status=$3, listing_url=COALESCE($4, citations.listing_url), notes=$5, updated_at=NOW()`,
        [projectId, r.name, r.status, r.listing_url, r.notes]
      );
    }

    const listed = results.filter(r => r.status === 'listed').length;
    console.log(`[citations] Scan complete: ${listed}/${results.length} listed`);
    res.json({ results, stats: { total: results.length, listed, not_listed: results.length - listed } });
  } catch (e) {
    console.error('[citations] Scan error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Update citation status for a directory
app.put('/api/projects/:projectId/citations/:directoryName', async (req, res) => {
  const { projectId, directoryName } = req.params;
  const { status, listing_url, notes } = req.body;
  try {
    await pool.query(
      `INSERT INTO citations (project_id, directory_name, status, listing_url, notes, updated_at)
       VALUES ($1, $2, $3, $4, $5, NOW())
       ON CONFLICT (project_id, directory_name)
       DO UPDATE SET status=COALESCE($3, citations.status), listing_url=COALESCE($4, citations.listing_url), notes=COALESCE($5, citations.notes), updated_at=NOW()`,
      [projectId, decodeURIComponent(directoryName), status || 'not_listed', listing_url || null, notes || null]
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ==================== ON-PAGE AUDIT (Yoast + Content Analysis) ====================

// Run on-page audit — fetches Yoast scores + WP pages, analyzes content
app.post('/api/projects/:projectId/onpage-audit/run', async (req, res) => {
  const { projectId } = req.params;
  try {
    // Get WP URL from project
    const projRes = await pool.query('SELECT * FROM projects WHERE id=$1', [projectId]);
    if (projRes.rows.length === 0) return res.status(404).json({ error: 'Project not found' });
    const project = projRes.rows[0];
    const wpUrl = project.wordpress_url;
    if (!wpUrl) return res.status(400).json({ error: 'WordPress URL not configured. Set it in Project Settings.' });

    const wpBase = wpUrl.replace(/\/$/, '');
    const domain = wpBase.replace(/^https?:\/\//, '').replace(/\/$/, '');

    // 1. Try to get Yoast scores from seoroom-helper plugin
    let yoastMap = {};
    try {
      const yoastResp = await fetch(`${wpBase}/wp-json/seoroom/v1/yoast-scores`, {
        signal: AbortSignal.timeout(30000),
        ...(getWpAuthHeaders(project) ? { headers: getWpAuthHeaders(project) } : {}),
      });
      if (yoastResp.ok) {
        const scores = await yoastResp.json();
        for (const s of scores) { yoastMap[s.id] = s; }
        console.log(`[onpage-audit] Got Yoast scores for ${scores.length} pages via plugin`);
      }
    } catch (e) {
      console.log(`[onpage-audit] seoroom plugin not available: ${e.message}`);
    }

    // 2. Fetch all published pages from WP REST API (with auth if available)
    const wpAuth = getWpAuthHeaders(project);
    const wpFetchOpts = { signal: AbortSignal.timeout(30000), ...(wpAuth ? { headers: wpAuth } : {}) };
    let allPages = [];
    let page = 1;
    while (true) {
      try {
        const resp = await fetch(`${wpBase}/wp-json/wp/v2/pages?per_page=50&page=${page}&status=publish`, wpFetchOpts);
        if (!resp.ok) break;
        const pages = await resp.json();
        if (!Array.isArray(pages) || pages.length === 0) break;
        allPages = allPages.concat(pages);
        if (pages.length < 50) break;
        page++;
      } catch { break; }
    }
    // Also fetch posts
    page = 1;
    while (true) {
      try {
        const resp = await fetch(`${wpBase}/wp-json/wp/v2/posts?per_page=50&page=${page}&status=publish`, wpFetchOpts);
        if (!resp.ok) break;
        const posts = await resp.json();
        if (!Array.isArray(posts) || posts.length === 0) break;
        allPages = allPages.concat(posts);
        if (posts.length < 50) break;
        page++;
      } catch { break; }
    }

    console.log(`[onpage-audit] Fetched ${allPages.length} pages/posts`);
    if (allPages.length === 0) {
      // Check if REST API requires auth
      const testResp = await fetch(`${wpBase}/wp-json/wp/v2/pages?per_page=1`, { signal: AbortSignal.timeout(10000) }).catch(() => null);
      const isAuthRequired = testResp && testResp.status === 401;
      const msg = isAuthRequired
        ? 'WordPress REST API requires authentication. Add WP Username and Application Password in Project Settings.'
        : 'No published pages found. Check that the WordPress URL is correct and the REST API is accessible.';
      return res.json({ pages: [], message: msg });
    }

    // 3. Analyze each page
    const results = [];
    for (const pg of allPages) {
      const url = pg.link || '';
      const slug = pg.slug || '';
      const title = pg.title?.rendered || '';
      const content = pg.content?.rendered || '';
      const yoast = pg.yoast_head_json || {};
      const pluginData = yoastMap[pg.id];

      // Extract fields
      const metaTitle = yoast.title || '';
      const metaDesc = yoast.description || '';
      const focusKeyword = pluginData?.focus_keyword || '';
      const plainText = content.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      const wordCount = plainText.split(/\s+/).filter(Boolean).length;

      // Count links
      const linkRegex = /<a[^>]+href=["']([^"']+)["'][^>]*>/gi;
      let m; let internalLinks = 0; let externalLinks = 0;
      while ((m = linkRegex.exec(content)) !== null) {
        const href = m[1];
        if (href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('tel:')) continue;
        if (href.includes(domain) || href.startsWith('/')) internalLinks++;
        else if (href.startsWith('http')) externalLinks++;
      }

      // Count images
      const imgMatches = content.match(/<img[^>]*>/gi) || [];
      const images = imgMatches.length;
      const imagesWithAlt = imgMatches.filter(img => /alt=["'][^"']+["']/i.test(img)).length;

      // Extract H1
      const h1Match = content.match(/<h1[^>]*>(.*?)<\/h1>/i);
      const h1 = h1Match ? h1Match[1].replace(/<[^>]+>/g, '') : title;

      // Determine Yoast score
      let yoastScore = 'gray';
      if (pluginData) {
        const seoScore = pluginData.seo_score || 0;
        yoastScore = seoScore >= 70 ? 'green' : seoScore >= 40 ? 'orange' : 'red';
      } else {
        // Heuristic based on meta completeness
        const hasGoodTitle = metaTitle.length >= 30 && metaTitle.length <= 60;
        const hasGoodDesc = metaDesc.length >= 120 && metaDesc.length <= 155;
        const hasFocus = !!focusKeyword;
        const goodCount = [hasGoodTitle, hasGoodDesc, hasFocus, wordCount >= 500].filter(Boolean).length;
        yoastScore = goodCount >= 3 ? 'green' : goodCount >= 1 ? 'orange' : 'red';
      }

      // Build issues
      const issues = [];
      const kwLower = focusKeyword.toLowerCase();

      if (!metaTitle) issues.push({ type: 'problem', text: 'Meta title is missing' });
      else {
        if (metaTitle.length < 30) issues.push({ type: 'problem', text: `Meta title too short (${metaTitle.length} chars) — should be 50-60` });
        if (metaTitle.length > 60) issues.push({ type: 'warning', text: `Meta title too long (${metaTitle.length} chars) — max 60` });
        if (metaTitle.length >= 50 && metaTitle.length <= 60) issues.push({ type: 'good', text: 'Title tag length is good' });
        if (kwLower && metaTitle.toLowerCase().includes(kwLower)) issues.push({ type: 'good', text: 'Title tag contains focus keyword' });
        else if (kwLower) issues.push({ type: 'warning', text: 'Focus keyword not in title tag' });
      }

      if (!metaDesc) issues.push({ type: 'problem', text: 'Meta description is empty' });
      else {
        if (metaDesc.length < 120) issues.push({ type: 'warning', text: `Meta description short (${metaDesc.length} chars) — aim for 120-155` });
        if (metaDesc.length > 155) issues.push({ type: 'warning', text: `Meta description too long (${metaDesc.length} chars) — max 155` });
        if (metaDesc.length >= 120 && metaDesc.length <= 155) issues.push({ type: 'good', text: 'Meta description length is good' });
        if (kwLower && metaDesc.toLowerCase().includes(kwLower)) issues.push({ type: 'good', text: 'Meta description contains focus keyword' });
      }

      if (!focusKeyword) issues.push({ type: 'problem', text: 'No focus keyword set' });
      if (wordCount < 300) issues.push({ type: 'problem', text: `Content is very thin (${wordCount} words)` });
      else if (wordCount < 800) issues.push({ type: 'warning', text: `Content could be longer (${wordCount} words) — aim for 800+` });
      else issues.push({ type: 'good', text: `Good content length (${wordCount} words)` });

      if (internalLinks < 3) issues.push({ type: 'warning', text: `Only ${internalLinks} internal links — add more for better linking` });
      else issues.push({ type: 'good', text: `Good internal linking (${internalLinks} links)` });

      if (images > 0 && imagesWithAlt < images) issues.push({ type: 'warning', text: `${images - imagesWithAlt} image(s) missing alt text` });
      else if (images > 0) issues.push({ type: 'good', text: 'All images have alt text' });

      if (externalLinks === 0) issues.push({ type: 'warning', text: 'No external links' });

      results.push({
        id: pg.id,
        url: url.replace(wpBase, '') || '/',
        title,
        yoastScore,
        focusKeyword,
        wordCount,
        metaTitle,
        metaTitleLen: metaTitle.length,
        metaDesc,
        metaDescLen: metaDesc.length,
        h1,
        internalLinks,
        externalLinks,
        images,
        imagesWithAlt,
        issues
      });
    }

    // Sort: red first, then orange, then green
    const scoreOrder = { red: 0, orange: 1, gray: 2, green: 3 };
    results.sort((a, b) => (scoreOrder[a.yoastScore] || 2) - (scoreOrder[b.yoastScore] || 2));

    console.log(`[onpage-audit] Analyzed ${results.length} pages. Red: ${results.filter(r => r.yoastScore === 'red').length}, Orange: ${results.filter(r => r.yoastScore === 'orange').length}, Green: ${results.filter(r => r.yoastScore === 'green').length}`);

    // Cache results in DB for persistence
    try {
      await pool.query(
        `INSERT INTO onpage_audit_cache (project_id, results, updated_at) VALUES ($1, $2, NOW())
         ON CONFLICT (project_id) DO UPDATE SET results = $2, updated_at = NOW()`,
        [projectId, JSON.stringify(results)]
      );
    } catch (cacheErr) { console.log('[onpage-audit] Cache save failed:', cacheErr.message); }

    res.json({ pages: results });
  } catch (e) {
    console.error('[onpage-audit] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Get cached on-page audit results
app.get('/api/projects/:projectId/onpage-audit/results', async (req, res) => {
  try {
    const r = await pool.query('SELECT results, updated_at FROM onpage_audit_cache WHERE project_id=$1', [req.params.projectId]);
    if (r.rows.length === 0) return res.json({ pages: [] });
    const results = typeof r.rows[0].results === 'string' ? JSON.parse(r.rows[0].results) : r.rows[0].results;
    res.json({ pages: results, cached_at: r.rows[0].updated_at });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ==================== ON-PAGE FIX (WordPress Write-Back) ====================

// Helper: get WP auth headers for a project
function getWpAuthHeaders(project) {
  if (!project.wp_username || !project.wp_app_password) return null;
  const token = Buffer.from(`${project.wp_username}:${project.wp_app_password}`).toString('base64');
  return { 'Authorization': `Basic ${token}`, 'Content-Type': 'application/json' };
}

// Helper: read current Yoast meta from WordPress for a page/post
async function readWpYoastMeta(wpBase, pageId, authHeaders) {
  // Try pages first, then posts
  for (const type of ['pages', 'posts']) {
    try {
      const resp = await fetch(`${wpBase}/wp-json/wp/v2/${type}/${pageId}`, {
        headers: authHeaders,
        signal: AbortSignal.timeout(15000)
      });
      if (resp.ok) {
        const data = await resp.json();
        const yoast = data.yoast_head_json || {};
        return {
          type,
          title: data.title?.rendered || '',
          yoast_wpseo_title: data.meta?.yoast_wpseo_title || yoast.title || '',
          yoast_wpseo_metadesc: data.meta?.yoast_wpseo_metadesc || yoast.description || '',
          yoast_wpseo_focuskw: data.meta?.yoast_wpseo_focuskw || ''
        };
      }
    } catch (e) { /* try next type */ }
  }
  return null;
}

// AI-generate suggested meta fixes for a page
app.post('/api/projects/:projectId/onpage-audit/suggest', async (req, res) => {
  const { projectId } = req.params;
  const { pages } = req.body; // array of { id, title, url, metaTitle, metaDesc, focusKeyword, h1, wordCount, issues }
  if (!pages || !pages.length) return res.status(400).json({ error: 'No pages provided' });

  try {
    const projRes = await pool.query('SELECT * FROM projects WHERE id=$1', [projectId]);
    if (projRes.rows.length === 0) return res.status(404).json({ error: 'Project not found' });
    const project = projRes.rows[0];

    const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
    const pagesData = pages.map(p => ({
      id: p.id, title: p.title, url: p.url,
      current_meta_title: p.metaTitle || '(empty)',
      current_meta_description: p.metaDesc || '(empty)',
      current_focus_keyword: p.focusKeyword || '(not set)',
      h1: p.h1, word_count: p.wordCount,
      problems: (p.issues || []).filter(i => i.type === 'problem' || i.type === 'warning').map(i => i.text)
    }));

    const resp = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 4000,
      messages: [{
        role: 'user',
        content: `You are an SEO expert. Generate optimized meta fixes for these WordPress pages.

Business: ${project.business_name || project.name} | Domain: ${project.domain} | Industry: ${project.industry || 'general'} | Location: ${project.location || ''}

Pages to fix:
${JSON.stringify(pagesData, null, 2)}

For each page, return a JSON array with objects:
{
  "id": <page_id>,
  "suggested_title": "<optimized meta title, 50-60 chars, include primary keyword near start>",
  "suggested_desc": "<optimized meta description, 120-155 chars, compelling with CTA>",
  "suggested_keyword": "<best focus keyword for this page based on content and business>"
}

Rules:
- Meta title: 50-60 characters, keyword near the front, include brand name at end with | separator
- Meta description: 120-155 characters, include keyword naturally, add call-to-action
- Focus keyword: choose the most relevant, search-intent-matching keyword for each page
- If current values are already good, return them unchanged
- ONLY return valid JSON array, no explanation`
      }]
    });

    const text = resp.content[0].text.trim();
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return res.status(500).json({ error: 'AI returned invalid format' });
    const suggestions = JSON.parse(jsonMatch[0]);
    res.json({ suggestions });
  } catch (e) {
    console.error('[onpage-suggest] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Apply on-page fixes to WordPress (with rollback snapshot)
app.post('/api/projects/:projectId/onpage-audit/fix', async (req, res) => {
  const { projectId } = req.params;
  const { fixes } = req.body; // array of { id, url, title, new_meta_title, new_meta_desc, new_focus_keyword }
  if (!fixes || !fixes.length) return res.status(400).json({ error: 'No fixes provided' });

  try {
    const projRes = await pool.query('SELECT * FROM projects WHERE id=$1', [projectId]);
    if (projRes.rows.length === 0) return res.status(404).json({ error: 'Project not found' });
    const project = projRes.rows[0];
    const wpBase = (project.wordpress_url || '').replace(/\/$/, '');
    if (!wpBase) return res.status(400).json({ error: 'WordPress URL not configured' });

    const authHeaders = getWpAuthHeaders(project);
    if (!authHeaders) return res.status(400).json({ error: 'WordPress Application Password not configured. Go to Settings → WordPress Auth.' });

    const results = [];
    for (const fix of fixes) {
      try {
        // 1. Read current values from WordPress (before snapshot)
        const current = await readWpYoastMeta(wpBase, fix.id, authHeaders);
        if (!current) {
          results.push({ id: fix.id, success: false, error: 'Page not found in WordPress' });
          continue;
        }

        // 2. Save snapshot to wp_change_history (one row per field changed)
        const changes = [];
        if (fix.new_meta_title && fix.new_meta_title !== current.yoast_wpseo_title) {
          changes.push({ field: 'yoast_wpseo_title', old: current.yoast_wpseo_title, new: fix.new_meta_title });
        }
        if (fix.new_meta_desc && fix.new_meta_desc !== current.yoast_wpseo_metadesc) {
          changes.push({ field: 'yoast_wpseo_metadesc', old: current.yoast_wpseo_metadesc, new: fix.new_meta_desc });
        }
        if (fix.new_focus_keyword && fix.new_focus_keyword !== current.yoast_wpseo_focuskw) {
          changes.push({ field: 'yoast_wpseo_focuskw', old: current.yoast_wpseo_focuskw, new: fix.new_focus_keyword });
        }

        if (changes.length === 0) {
          results.push({ id: fix.id, success: true, message: 'No changes needed' });
          continue;
        }

        // Save each field change to history
        for (const ch of changes) {
          await pool.query(
            `INSERT INTO wp_change_history (project_id, page_id, page_url, page_title, change_type, field_name, original_value, new_value)
             VALUES ($1, $2, $3, $4, 'meta_fix', $5, $6, $7)`,
            [projectId, fix.id, fix.url || '', fix.title || '', ch.field, ch.old, ch.new]
          );
        }

        // 3. Write new values to WordPress
        const meta = {};
        if (fix.new_meta_title) meta.yoast_wpseo_title = fix.new_meta_title;
        if (fix.new_meta_desc) meta.yoast_wpseo_metadesc = fix.new_meta_desc;
        if (fix.new_focus_keyword) meta.yoast_wpseo_focuskw = fix.new_focus_keyword;

        const writeResp = await fetch(`${wpBase}/wp-json/wp/v2/${current.type}/${fix.id}`, {
          method: 'POST',
          headers: authHeaders,
          body: JSON.stringify({ meta }),
          signal: AbortSignal.timeout(15000)
        });

        if (!writeResp.ok) {
          const errText = await writeResp.text();
          results.push({ id: fix.id, success: false, error: `WordPress returned ${writeResp.status}: ${errText.slice(0, 200)}` });
          continue;
        }

        results.push({ id: fix.id, success: true, changes: changes.length });
        console.log(`[onpage-fix] Fixed page ${fix.id} (${changes.length} fields)`);
      } catch (e) {
        results.push({ id: fix.id, success: false, error: e.message });
      }
    }

    res.json({ results });
  } catch (e) {
    console.error('[onpage-fix] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Get change history for a project
app.get('/api/projects/:projectId/wp-changes', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT * FROM wp_change_history WHERE project_id=$1 ORDER BY applied_at DESC LIMIT 200`,
      [req.params.projectId]
    );
    res.json({ changes: r.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Rollback a specific change
app.post('/api/projects/:projectId/wp-changes/rollback/:changeId', async (req, res) => {
  const { projectId, changeId } = req.params;
  try {
    // Get the change record
    const chRes = await pool.query(
      'SELECT * FROM wp_change_history WHERE id=$1 AND project_id=$2 AND rolled_back_at IS NULL',
      [changeId, projectId]
    );
    if (chRes.rows.length === 0) return res.status(404).json({ error: 'Change not found or already rolled back' });
    const change = chRes.rows[0];

    // Get project for WP auth
    const projRes = await pool.query('SELECT * FROM projects WHERE id=$1', [projectId]);
    const project = projRes.rows[0];
    const wpBase = (project.wordpress_url || '').replace(/\/$/, '');
    const authHeaders = getWpAuthHeaders(project);
    if (!authHeaders) return res.status(400).json({ error: 'WordPress auth not configured' });

    // Determine page type (try pages then posts)
    const current = await readWpYoastMeta(wpBase, change.page_id, authHeaders);
    if (!current) return res.status(404).json({ error: 'Page not found in WordPress' });

    // Write original value back
    const meta = { [change.field_name]: change.original_value };
    const writeResp = await fetch(`${wpBase}/wp-json/wp/v2/${current.type}/${change.page_id}`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ meta }),
      signal: AbortSignal.timeout(15000)
    });

    if (!writeResp.ok) {
      const errText = await writeResp.text();
      return res.status(500).json({ error: `WordPress returned ${writeResp.status}: ${errText.slice(0, 200)}` });
    }

    // Mark as rolled back
    await pool.query('UPDATE wp_change_history SET rolled_back_at=NOW() WHERE id=$1', [changeId]);
    console.log(`[rollback] Rolled back change ${changeId} — ${change.field_name} on page ${change.page_id}`);
    res.json({ success: true });
  } catch (e) {
    console.error('[rollback] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Bulk rollback all changes for a specific page
app.post('/api/projects/:projectId/wp-changes/rollback-page/:pageId', async (req, res) => {
  const { projectId, pageId } = req.params;
  try {
    const chRes = await pool.query(
      'SELECT * FROM wp_change_history WHERE project_id=$1 AND page_id=$2 AND rolled_back_at IS NULL ORDER BY applied_at DESC',
      [projectId, pageId]
    );
    if (chRes.rows.length === 0) return res.json({ success: true, message: 'No changes to roll back' });

    const projRes = await pool.query('SELECT * FROM projects WHERE id=$1', [projectId]);
    const project = projRes.rows[0];
    const wpBase = (project.wordpress_url || '').replace(/\/$/, '');
    const authHeaders = getWpAuthHeaders(project);
    if (!authHeaders) return res.status(400).json({ error: 'WordPress auth not configured' });

    const current = await readWpYoastMeta(wpBase, parseInt(pageId), authHeaders);
    if (!current) return res.status(404).json({ error: 'Page not found in WordPress' });

    // Build meta object with all original values (earliest change = true original)
    const meta = {};
    const fieldOriginals = {};
    for (const ch of chRes.rows) {
      if (!fieldOriginals[ch.field_name]) {
        fieldOriginals[ch.field_name] = ch.original_value;
      }
    }
    // Get the very first original per field (oldest change)
    const allChanges = await pool.query(
      'SELECT DISTINCT ON (field_name) field_name, original_value FROM wp_change_history WHERE project_id=$1 AND page_id=$2 ORDER BY field_name, applied_at ASC',
      [projectId, pageId]
    );
    for (const row of allChanges.rows) {
      meta[row.field_name] = row.original_value;
    }

    const writeResp = await fetch(`${wpBase}/wp-json/wp/v2/${current.type}/${pageId}`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ meta }),
      signal: AbortSignal.timeout(15000)
    });

    if (!writeResp.ok) {
      const errText = await writeResp.text();
      return res.status(500).json({ error: `WordPress returned ${writeResp.status}: ${errText.slice(0, 200)}` });
    }

    // Mark all as rolled back
    await pool.query(
      'UPDATE wp_change_history SET rolled_back_at=NOW() WHERE project_id=$1 AND page_id=$2 AND rolled_back_at IS NULL',
      [projectId, pageId]
    );
    console.log(`[rollback] Rolled back all changes for page ${pageId}`);
    res.json({ success: true, rolled_back: chRes.rows.length });
  } catch (e) {
    console.error('[rollback] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ==================== GSC AUDIT ====================

app.post('/api/projects/:projectId/audits/gsc/run', async (req, res) => {
  const { projectId } = req.params;
  try {
    const proj = await pool.query('SELECT * FROM projects WHERE id=$1', [projectId]);
    if (proj.rows.length === 0) return res.status(404).json({ error: 'Project not found' });
    const project = proj.rows[0];
    const domain = project.domain;

    // Clean up old unactioned findings from previous runs
    await pool.query(`DELETE FROM audit_findings WHERE project_id=$1 AND pillar='gsc' AND status='new'`, [projectId]);

    // Try to get fresh GSC data first, fall back to stored data
    let gscRows = [];
    let pageRows = [];
    let matchedSite = null;
    const accessToken = await getGscAccessToken(req.auth?.userId);

    if (accessToken) {
      // Find matching GSC site
      const sites = await fetch('https://www.googleapis.com/webmasters/v3/sites', {
        headers: { Authorization: `Bearer ${accessToken}` }
      }).then(r => r.json());
      const available = (sites.siteEntry || []).map(s => s.siteUrl);
      matchedSite = available.find(s => s.includes(domain.replace(/^www\./, '')));
      if (!matchedSite && available.length > 0) matchedSite = available[0];

      if (matchedSite) {
        const endDate = new Date().toISOString().split('T')[0];
        const startDate = new Date(Date.now() - 28 * 86400000).toISOString().split('T')[0];

        // Fetch keyword-level data
        const kwRes = await fetch(`https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(matchedSite)}/searchAnalytics/query`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ startDate, endDate, dimensions: ['query'], rowLimit: 1000 })
        }).then(r => r.json());
        gscRows = (kwRes.rows || []).map(r => ({ keyword: r.keys[0], clicks: r.clicks, impressions: r.impressions, ctr: r.ctr, position: r.position }));

        // Fetch page-level data
        const pgRes = await fetch(`https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(matchedSite)}/searchAnalytics/query`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ startDate, endDate, dimensions: ['page'], rowLimit: 500 })
        }).then(r => r.json());
        pageRows = (pgRes.rows || []).map(r => ({ page: r.keys[0], clicks: r.clicks, impressions: r.impressions, ctr: r.ctr, position: r.position }));

        // Fetch page+query combos for cannibalization check
        const pqRes = await fetch(`https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(matchedSite)}/searchAnalytics/query`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ startDate, endDate, dimensions: ['query', 'page'], rowLimit: 2000 })
        }).then(r => r.json());
        var pageQueryRows = (pqRes.rows || []).map(r => ({ keyword: r.keys[0], page: r.keys[1], clicks: r.clicks, impressions: r.impressions, ctr: r.ctr, position: r.position }));
      }
    }

    // Fall back to stored GSC data if no live data
    if (gscRows.length === 0) {
      const stored = await pool.query('SELECT keyword, clicks, impressions, ctr, position FROM gsc_keywords WHERE project_id=$1 ORDER BY impressions DESC', [projectId]);
      gscRows = stored.rows;
    }

    if (gscRows.length === 0) {
      return res.json({ findings: [], message: 'No GSC data available. Connect GSC and sync keywords first.' });
    }

    // Create audit record
    const auditRes = await pool.query(
      `INSERT INTO audits (project_id, pillar, status, started_at) VALUES ($1, 'gsc', 'running', NOW()) RETURNING id`,
      [projectId]
    );
    const auditId = auditRes.rows[0].id;

    const findings = [];

    // 1. QUICK WINS: Keywords ranking 4-20 with high impressions (close to page 1)
    const quickWins = gscRows
      .filter(r => r.position >= 4 && r.position <= 20 && r.impressions >= 10)
      .sort((a, b) => b.impressions - a.impressions)
      .slice(0, 20);

    for (const kw of quickWins) {
      const severity = kw.position <= 10 ? 'Critical' : kw.position <= 15 ? 'Medium' : 'Low';
      findings.push({
        pillar: 'gsc', category: 'Quick Win',
        title: `"${kw.keyword}" ranking #${Math.round(kw.position)} — push to page 1`,
        description: `This keyword has ${kw.impressions} impressions/month but ranks at position ${kw.position.toFixed(1)}. With targeted optimization it could reach page 1.`,
        recommendation: kw.position <= 10
          ? 'Optimize the ranking page: improve title tag, add internal links, expand content around this topic.'
          : 'Create or improve a dedicated page targeting this keyword. Add it to your content plan.',
        severity,
        current_value: `Position ${kw.position.toFixed(1)} | ${kw.impressions} imp | ${kw.clicks} clicks`,
        recommended_value: 'Position 1-3'
      });
    }

    // 2. LOW CTR: Keywords with high impressions but low CTR (needs better titles/descriptions)
    const lowCtr = gscRows
      .filter(r => r.impressions >= 50 && r.ctr < 0.02 && r.position <= 20)
      .sort((a, b) => b.impressions - a.impressions)
      .slice(0, 15);

    for (const kw of lowCtr) {
      findings.push({
        pillar: 'gsc', category: 'Low CTR',
        title: `"${kw.keyword}" has ${kw.impressions} impressions but only ${(kw.ctr * 100).toFixed(1)}% CTR`,
        description: `This keyword gets good visibility but users aren't clicking. The title tag or meta description may not be compelling enough.`,
        recommendation: 'Rewrite the meta title and description to include the keyword and a clear call-to-action. Make it stand out in search results.',
        severity: kw.impressions >= 200 ? 'Critical' : 'Medium',
        current_value: `CTR: ${(kw.ctr * 100).toFixed(1)}% | ${kw.clicks} clicks / ${kw.impressions} impressions`,
        recommended_value: 'CTR > 3%'
      });
    }

    // 3. HIGH IMPRESSION ZERO CLICK: Wasted visibility
    const zeroClick = gscRows
      .filter(r => r.impressions >= 30 && r.clicks === 0)
      .sort((a, b) => b.impressions - a.impressions)
      .slice(0, 10);

    for (const kw of zeroClick) {
      findings.push({
        pillar: 'gsc', category: 'Zero Clicks',
        title: `"${kw.keyword}" — ${kw.impressions} impressions, 0 clicks`,
        description: `This keyword is showing in search results but getting zero clicks. The listing may be unappealing or the keyword may trigger featured snippets.`,
        recommendation: 'Review the SERP for this keyword. If a featured snippet exists, restructure your content to win it. Otherwise, rewrite title/description.',
        severity: kw.impressions >= 100 ? 'Medium' : 'Low',
        current_value: `${kw.impressions} impressions, 0 clicks, Position ${kw.position.toFixed(1)}`,
        recommended_value: 'At least 1-2% CTR'
      });
    }

    // 4. CANNIBALIZATION: Multiple pages ranking for the same keyword
    if (pageQueryRows && pageQueryRows.length > 0) {
      const kwPages = {};
      for (const row of pageQueryRows) {
        if (!kwPages[row.keyword]) kwPages[row.keyword] = [];
        kwPages[row.keyword].push(row);
      }

      const cannibalized = Object.entries(kwPages)
        .filter(([kw, pages]) => pages.length >= 2 && pages.some(p => p.impressions >= 10))
        .sort((a, b) => {
          const aImp = a[1].reduce((s, p) => s + p.impressions, 0);
          const bImp = b[1].reduce((s, p) => s + p.impressions, 0);
          return bImp - aImp;
        })
        .slice(0, 10);

      for (const [kw, pages] of cannibalized) {
        const totalImp = pages.reduce((s, p) => s + p.impressions, 0);
        const urls = pages.map(p => {
          try { return new URL(p.page).pathname; } catch { return p.page; }
        }).join(', ');
        findings.push({
          pillar: 'gsc', category: 'Cannibalization',
          title: `"${kw}" ranking on ${pages.length} different pages`,
          description: `Multiple pages compete for the same keyword, splitting authority. Pages: ${urls}`,
          recommendation: 'Consolidate content into one authoritative page. Redirect or noindex the weaker pages, or differentiate their target keywords.',
          severity: totalImp >= 100 ? 'Critical' : 'Medium',
          current_value: `${pages.length} pages | ${totalImp} total impressions`,
          recommended_value: '1 page per keyword'
        });
      }
    }

    // 5. DECLINING PAGES: Pages with high impressions but poor performance
    const poorPages = (pageRows || [])
      .filter(r => r.impressions >= 50 && r.ctr < 0.015)
      .sort((a, b) => b.impressions - a.impressions)
      .slice(0, 10);

    for (const pg of poorPages) {
      let path;
      try { path = new URL(pg.page).pathname; } catch { path = pg.page; }
      findings.push({
        pillar: 'gsc', category: 'Underperforming Page',
        title: `${path} — ${pg.impressions} impressions, ${(pg.ctr * 100).toFixed(1)}% CTR`,
        description: `This page appears in search results frequently but converts poorly to clicks.`,
        recommendation: 'Audit the page title, meta description, and structured data. Consider adding FAQ schema or improving the content quality.',
        severity: pg.impressions >= 200 ? 'Critical' : 'Medium',
        current_value: `${pg.clicks} clicks / ${pg.impressions} imp | CTR ${(pg.ctr * 100).toFixed(1)}%`,
        recommended_value: 'CTR > 3%'
      });
    }

    // 6. BRANDED vs NON-BRANDED split
    const brandTerms = (project.name || '').toLowerCase().split(/\s+/).filter(w => w.length > 3);
    if (brandTerms.length > 0) {
      const branded = gscRows.filter(r => brandTerms.some(t => r.keyword.toLowerCase().includes(t)));
      const nonBranded = gscRows.filter(r => !brandTerms.some(t => r.keyword.toLowerCase().includes(t)));
      const brandedClicks = branded.reduce((s, r) => s + r.clicks, 0);
      const totalClicks = gscRows.reduce((s, r) => s + r.clicks, 0);
      const brandPct = totalClicks > 0 ? (brandedClicks / totalClicks * 100) : 0;

      if (brandPct > 70) {
        findings.push({
          pillar: 'gsc', category: 'Brand Dependency',
          title: `${brandPct.toFixed(0)}% of clicks come from branded searches`,
          description: `Your traffic is heavily dependent on brand searches. If people don't know your brand, they won't find you.`,
          recommendation: 'Invest in non-branded content targeting service + location keywords. Build topical authority with blog posts and service pages.',
          severity: 'Critical',
          current_value: `Branded: ${brandPct.toFixed(0)}% (${brandedClicks}/${totalClicks} clicks)`,
          recommended_value: 'Below 50% branded'
        });
      }
    }

    // 7. INDEXING ISSUES: Check key pages via URL Inspection API
    if (accessToken && matchedSite) {
      try {
        // Get important pages from sitemap or pageRows
        const baseUrl = `https://${domain}`;
        const pagesToCheck = [baseUrl + '/'];

        // Add service pages and suburb pages from sitemap or page data
        const allPages = (pageRows || []).map(p => p.page);

        // Services pages (contain /services, /plumber, /gas-fitting, /blocked-drain etc)
        const servicePages = allPages.filter(p =>
          p.match(/\/(services|plumb|gas|drain|hot-water|water-filter|leak|burst|tap|toilet|bathroom|kitchen|emergency)/i)
        );
        pagesToCheck.push(...servicePages);

        // Suburb/location pages
        const serviceAreas = project.service_areas || [];
        for (const area of serviceAreas) {
          const suburbSlug = (area.name || '').toLowerCase().replace(/\s+/g, '-');
          if (suburbSlug) {
            // Try common URL patterns for suburb pages
            const suburbUrl = allPages.find(p => p.toLowerCase().includes(suburbSlug));
            if (suburbUrl && !pagesToCheck.includes(suburbUrl)) pagesToCheck.push(suburbUrl);
            else if (!pagesToCheck.some(p => p.includes(suburbSlug))) {
              pagesToCheck.push(`${baseUrl}/plumber-${suburbSlug}/`);
            }
          }
        }

        // Also add any remaining high-impression pages not yet included
        for (const p of allPages.slice(0, 20)) {
          if (!pagesToCheck.includes(p)) pagesToCheck.push(p);
        }

        console.log(`[gsc-audit] Indexing check: ${pagesToCheck.length} pages to check (home + services + suburbs)`);

        let notIndexed = [];
        let crawledNotIndexed = [];
        let mobileIssues = [];

        for (const pageUrl of pagesToCheck.slice(0, 20)) {
          try {
            const inspRes = await fetch('https://searchconsole.googleapis.com/v1/urlInspection/index:inspect', {
              method: 'POST',
              headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({ inspectionUrl: pageUrl, siteUrl: matchedSite })
            });
            if (inspRes.ok) {
              const inspData = await inspRes.json();
              const result = inspData.inspectionResult;
              const indexStatus = result?.indexStatusResult;
              const mobileStatus = result?.mobileUsabilityResult;

              if (indexStatus) {
                const verdict = indexStatus.verdict;
                const coverageState = indexStatus.coverageState;

                if (verdict === 'FAIL' || verdict === 'NEUTRAL') {
                  let path;
                  try { path = new URL(pageUrl).pathname; } catch { path = pageUrl; }

                  if (coverageState === 'Crawled - currently not indexed' || coverageState === 'Discovered - currently not indexed') {
                    crawledNotIndexed.push({ url: path, state: coverageState, lastCrawl: indexStatus.lastCrawlTime, robotsTxt: indexStatus.robotsTxtState, indexing: indexStatus.indexingState, crawlable: indexStatus.pageFetchState });
                  } else {
                    notIndexed.push({ url: path, state: coverageState || verdict, reason: indexStatus.pageFetchState, robotsTxt: indexStatus.robotsTxtState, indexing: indexStatus.indexingState, lastCrawl: indexStatus.lastCrawlTime });
                  }
                }
              }

              // Mobile usability
              if (mobileStatus?.verdict === 'FAIL') {
                let path;
                try { path = new URL(pageUrl).pathname; } catch { path = pageUrl; }
                const issues = (mobileStatus.issues || []).map(i => i.issueType).join(', ');
                mobileIssues.push({ url: path, issues });
              }
            }
          } catch (e) { /* skip individual page errors */ }
        }

        // Create individual findings per page for better detail
        for (const page of notIndexed) {
          findings.push({
            pillar: 'gsc', category: 'Indexing Issues',
            title: `${page.url} — NOT indexed`,
            description: `Status: ${page.state}. Fetch state: ${page.reason || 'unknown'}. ${page.robotsTxt ? 'Robots.txt: ' + page.robotsTxt + '.' : ''} ${page.indexing ? 'Indexing state: ' + page.indexing + '.' : ''} This page is completely invisible in Google search results.`,
            recommendation: `1) Check if ${page.url} has a noindex meta tag or is blocked by robots.txt. 2) Verify the canonical tag points to itself. 3) Submit the URL for indexing in Google Search Console. 4) Add internal links from other pages pointing to this URL.`,
            severity: 'Critical',
            current_value: `Not indexed | ${page.state}`,
            recommended_value: 'Indexed and ranking'
          });
        }

        for (const page of crawledNotIndexed) {
          const lastCrawlStr = page.lastCrawl ? new Date(page.lastCrawl).toLocaleDateString() : 'unknown';
          findings.push({
            pillar: 'gsc', category: 'Indexing Issues',
            title: `${page.url} — Crawled but NOT indexed`,
            description: `Status: "${page.state}". Last crawled: ${lastCrawlStr}. Google visited this page but decided not to add it to the index. Common reasons: thin content, duplicate content, low internal links, or Google considers it low quality.`,
            recommendation: `1) Review the content on ${page.url} — is it unique and valuable? At least 500+ words? 2) Check for duplicate content with other pages on the site. 3) Add 3-5 internal links from high-authority pages pointing to this URL. 4) Add schema markup (FAQ, LocalBusiness). 5) Request indexing in GSC after improvements.`,
            severity: 'Medium',
            current_value: `Crawled, not indexed | Last crawl: ${lastCrawlStr}`,
            recommended_value: 'Indexed and ranking'
          });
        }

        for (const page of mobileIssues) {
          findings.push({
            pillar: 'gsc', category: 'Mobile Usability',
            title: `${page.url} — Mobile usability issues`,
            description: `Issues found: ${page.issues}. Mobile usability problems hurt rankings since Google uses mobile-first indexing.`,
            recommendation: `Fix the mobile issues on ${page.url}: ensure proper viewport meta tag, readable text without zooming, adequate tap target sizing, and no horizontal scrolling.`,
            severity: 'Medium',
            current_value: `${page.issues}`,
            recommended_value: '0 mobile issues'
          });
        }

        if (notIndexed.length === 0 && crawledNotIndexed.length === 0) {
          findings.push({
            pillar: 'gsc', category: 'Indexing Issues',
            title: 'All checked pages are indexed',
            description: `${pagesToCheck.length} pages checked (home, services, suburbs) — all are indexed by Google.`,
            recommendation: 'Continue monitoring. New pages should be submitted via GSC sitemap.',
            severity: 'Low',
            current_value: 'All indexed',
            recommended_value: 'All indexed'
          });
        }

        console.log(`[gsc-audit] Indexing check: ${notIndexed.length} not indexed, ${crawledNotIndexed.length} crawled not indexed, ${mobileIssues.length} mobile issues`);
      } catch (e) {
        console.log(`[gsc-audit] URL Inspection failed: ${e.message}`);
      }
    }

    // Save findings to DB
    for (const f of findings) {
      const r = await pool.query(
        `INSERT INTO audit_findings (project_id, audit_id, pillar, category, title, description, recommendation, severity, current_value, recommended_value)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
        [projectId, auditId, f.pillar, f.category, f.title, f.description, f.recommendation, f.severity, f.current_value, f.recommended_value]
      );
      f.id = r.rows[0].id;
      f.status = 'new';
    }

    // Mark audit complete
    await pool.query('UPDATE audits SET status=$1, completed_at=NOW(), audit_data=$2 WHERE id=$3',
      ['completed', JSON.stringify({ totalKeywords: gscRows.length, totalPages: (pageRows || []).length, findingsCount: findings.length }), auditId]);

    console.log(`[gsc-audit] Project ${projectId}: ${findings.length} findings from ${gscRows.length} keywords`);
    res.json({ findings, summary: { keywords: gscRows.length, pages: (pageRows || []).length, findings: findings.length } });
  } catch (e) {
    console.error('[gsc-audit] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ==================== GBP AUDIT (Comprehensive Local SEO Audit) ====================

// Australian business directory database
const AUSTRALIAN_DIRECTORIES = [
  { name: 'Google Business Profile', url: 'business.google.com', type: 'Essential', free: true, difficulty: 'Easy', priority: 1, description: 'Most important local listing — drives Maps rankings' },
  { name: 'Apple Maps (Apple Business Connect)', url: 'businessconnect.apple.com', type: 'Essential', free: true, difficulty: 'Easy', priority: 2, description: 'Growing in importance with iPhone users' },
  { name: 'Bing Places', url: 'bingplaces.com', type: 'Essential', free: true, difficulty: 'Easy', priority: 3, description: 'Powers Bing, Cortana, and some voice search results' },
  { name: 'Yellow Pages Australia', url: 'yellowpages.com.au', type: 'Major', free: true, paid_option: '$30-300/mo', difficulty: 'Easy', priority: 4, description: 'High DA Australian directory, free basic listing' },
  { name: 'True Local', url: 'truelocal.com.au', type: 'Major', free: true, paid_option: '$20-200/mo', difficulty: 'Easy', priority: 5, description: 'Popular Australian directory with good SEO authority' },
  { name: 'Hotfrog', url: 'hotfrog.com.au', type: 'Major', free: true, difficulty: 'Easy', priority: 6, description: 'Free Australian business directory with decent DA' },
  { name: 'Local Business Guide', url: 'localbusinessguide.com.au', type: 'Major', free: true, difficulty: 'Easy', priority: 7, description: 'Australian local business directory' },
  { name: 'Start Local', url: 'startlocal.com.au', type: 'Major', free: true, paid_option: '$99-499/yr', difficulty: 'Easy', priority: 8, description: 'Australian directory with categories' },
  { name: 'Yelp Australia', url: 'yelp.com.au', type: 'Major', free: true, difficulty: 'Easy', priority: 9, description: 'International directory, helps with global SEO signals' },
  { name: 'Facebook Business', url: 'facebook.com', type: 'Essential', free: true, difficulty: 'Easy', priority: 10, description: 'Social proof + local signals + reviews' },
  { name: 'LinkedIn Company', url: 'linkedin.com', type: 'Standard', free: true, difficulty: 'Easy', priority: 11, description: 'Professional presence, B2B signals' },
  { name: 'Word of Mouth', url: 'wordofmouth.com.au', type: 'Major', free: true, paid_option: 'Contact for pricing', difficulty: 'Easy', priority: 12, description: 'Australian review platform, good for tradies' },
  { name: 'Oneflare', url: 'oneflare.com.au', type: 'Industry', free: false, paid_option: 'Pay per lead', difficulty: 'Medium', priority: 13, description: 'Lead gen for trades/services, good citations' },
  { name: 'hipages', url: 'hipages.com.au', type: 'Industry', free: false, paid_option: '$50-500/mo', difficulty: 'Medium', priority: 14, description: 'Top trades directory in Australia, strong local SEO' },
  { name: 'ServiceSeeking', url: 'serviceseeking.com.au', type: 'Industry', free: false, paid_option: 'Pay per lead', difficulty: 'Medium', priority: 15, description: 'Trades lead gen platform with business profiles' },
  { name: 'Bark', url: 'bark.com', type: 'Industry', free: true, paid_option: 'Pay per lead', difficulty: 'Easy', priority: 16, description: 'International service marketplace' },
  { name: 'Localsearch', url: 'localsearch.com.au', type: 'Major', free: true, paid_option: '$30-200/mo', difficulty: 'Easy', priority: 17, description: 'Australian business directory and digital marketing' },
  { name: 'Australian Business Directory', url: 'australianbusinessdirectory.com.au', type: 'Standard', free: true, difficulty: 'Easy', priority: 18, description: 'Basic free Australian listing' },
  { name: 'dLook', url: 'dlook.com.au', type: 'Standard', free: true, difficulty: 'Easy', priority: 19, description: 'Free Australian business directory' },
  { name: 'Superpages', url: 'superpages.com.au', type: 'Standard', free: true, difficulty: 'Easy', priority: 20, description: 'Australian online directory' },
  { name: 'Fyple', url: 'fyple.com.au', type: 'Standard', free: true, difficulty: 'Easy', priority: 21, description: 'Free business listing directory' },
  { name: 'EnrollBusiness', url: 'enrollbusiness.com', type: 'Standard', free: true, difficulty: 'Easy', priority: 22, description: 'Free international business directory' },
  { name: 'Cylex', url: 'cylex.com.au', type: 'Standard', free: true, difficulty: 'Easy', priority: 23, description: 'Free business directory with map integration' },
  { name: 'Spoke', url: 'spoke.com', type: 'Standard', free: true, difficulty: 'Easy', priority: 24, description: 'Business profile and networking' },
  { name: 'Foursquare', url: 'foursquare.com', type: 'Standard', free: true, difficulty: 'Easy', priority: 25, description: 'Location data powers Apple Maps, Uber, and others' },
];

app.post('/api/projects/:projectId/audits/gbp/run', async (req, res) => {
  const { projectId } = req.params;
  try {
    const proj = await pool.query('SELECT * FROM projects WHERE id=$1', [projectId]);
    if (proj.rows.length === 0) return res.status(404).json({ error: 'Project not found' });
    const project = proj.rows[0];

    await pool.query(`DELETE FROM audit_findings WHERE project_id=$1 AND pillar='gbp'`, [projectId]);

    const auditRes = await pool.query(
      `INSERT INTO audits (project_id, pillar, status, started_at) VALUES ($1, 'gbp', 'running', NOW()) RETURNING id`,
      [projectId]
    );
    const auditId = auditRes.rows[0].id;

    const domain = (project.domain || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
    const businessName = project.business_name || project.name || '';
    const location = project.location || '';
    const industry = project.industry || '';
    const GOOGLE_KEY = process.env.PAGESPEED_API_KEY || process.env.GOOGLE_API_KEY;

    // ===== PHASE 1: Gather all data =====
    const gbpData = { profile: null, source: 'none', competitors: [], mapsRankings: [], directories: AUSTRALIAN_DIRECTORIES };

    // 1. Get business profile — prefer extension-scraped data (100% accurate)

    // 1a. Check for extension-scraped GBP data (most accurate source)
    try {
      const extData = await pool.query(
        `SELECT config, updated_at FROM project_integrations WHERE project_id=$1 AND kind='gbp_profile'`,
        [projectId]
      );
      if (extData.rows.length > 0) {
        const ext = typeof extData.rows[0].config === 'string' ? JSON.parse(extData.rows[0].config) : extData.rows[0].config;
        const ageHours = (Date.now() - new Date(extData.rows[0].updated_at).getTime()) / (1000 * 60 * 60);
        console.log(`[gbp-audit] Extension data found (${Math.round(ageHours)}h old)`);

        gbpData.source = 'extension';
        gbpData.profile = {
          name: ext.business?.name || businessName,
          address: ext.address || '',
          phone: ext.phone || null,
          website: ext.website || null,
          rating: ext.reviews?.averageRating || null,
          reviewCount: ext.reviews?.totalCount || 0,
          primaryType: (ext.categories || []).find(c => c.primary)?.name || null,
          categories: (ext.categories || []).map(c => c.name),
          description: ext.description || null,
          hoursSet: (ext.hours || []).length > 0,
          hoursText: (ext.hours || []).map(h => `${h.day}: ${h.hours}`).join('; '),
          hoursDays: (ext.hours || []).length,
          photoCount: ext.photos?.totalCount || 0,
          photosByOwner: ext.photos?.byOwner || 0,
          photosByCustomer: ext.photos?.byCustomer || 0,
          services: ext.services || [],
          serviceAreas: ext.service_areas || [],
          posts: ext.posts || { count: 0 },
          attributes: ext.attributes || [],
          products: ext.products || [],
          reviews: [],
          thirdPartyReviews: ext.thirdPartyReviews || [],
          socialProfiles: ext.socialProfiles || [],
          monthlyViews: ext.monthlyViews || null,
          collectedAt: ext.collected_at,
          dataAge: `${Math.round(ageHours)}h`,
        };
        console.log(`[gbp-audit] PROFILE (extension):`, JSON.stringify({
          name: gbpData.profile.name, rating: gbpData.profile.rating, reviews: gbpData.profile.reviewCount,
          photos: gbpData.profile.photoCount, categories: gbpData.profile.categories,
          description: gbpData.profile.description ? 'YES' : 'NO', hours: gbpData.profile.hoursSet,
          services: gbpData.profile.services.length, posts: gbpData.profile.posts.count,
        }));
      }
    } catch (e) { console.log(`[gbp-audit] Extension data check error: ${e.message}`); }

    // 1b. SerpAPI Maps — run to get rating/reviews/categories
    // Extension data will be merged on top afterwards for hours/description
    const extensionProfile = gbpData.profile; // Save extension data to merge later
    if (SERPAPI_KEY && businessName) {
      try {
        const searchQ = businessName.replace(/&/g, 'and');
        console.log(`[gbp-audit] SerpAPI search: "${searchQ}" (original: "${businessName}"`);

        const data = await serpApiSearch({
          engine: 'google_maps',
          q: searchQ,
          type: 'search',
          api_key: SERPAPI_KEY,
        });

        const results = data.local_results || [];
        console.log(`[gbp-audit] SerpAPI found ${results.length} results`);

        // Match by website domain (most accurate)
        const match = results.find(r => r.website && r.website.includes(domain)) ||
          results.find(r => r.title && r.title.toLowerCase().includes('houseworks')) ||
          null;

        if (match) {
          console.log(`[gbp-audit] Matched: "${match.title}" (${match.website || 'no website'})`);
          gbpData.source = 'serpapi';
          // match.reviews can be a number or a URL string — extract the number
          const reviewCount = typeof match.reviews === 'number' ? match.reviews : (typeof match.reviews_original === 'number' ? match.reviews_original : parseInt(match.reviews) || 0);
          gbpData.profile = {
            name: match.title || '',
            address: match.address || '',
            phone: match.phone || null,
            website: match.website || null,
            rating: match.rating || null,
            reviewCount: reviewCount,
            primaryType: match.type || null,
            categories: match.types || (match.type ? [match.type] : []),
            placeId: match.place_id || null,
            photoCount: match.thumbnail ? 1 : 0,
            serviceOptions: match.service_options || null,
          };

          // Get more data via Google Knowledge Graph (regular Google search)
          {
            try {
              const kpData = await serpApiSearch({
                engine: 'google',
                q: businessName,
                api_key: SERPAPI_KEY,
              });
              const kp = kpData.knowledge_graph || {};
              console.log(`[gbp-audit] Knowledge graph: title="${kp.title || 'none'}", desc=${kp.description ? 'YES' : 'NO'}, hours=${kp.hours ? 'YES' : 'NO'}, type="${kp.type || 'none'}"`);

              // Also check local_results from Google search for richer data
              const localResult = (kpData.local_results?.places || [])[0];
              if (localResult) {
                console.log(`[gbp-audit] Local result: photos=${localResult.photos_count || '?'}, hours=${localResult.operating_hours ? 'YES' : 'NO'}`);
                if (localResult.description) gbpData.profile.description = localResult.description;
                if (localResult.operating_hours) {
                  gbpData.profile.hoursSet = true;
                  gbpData.profile.hoursText = JSON.stringify(localResult.operating_hours);
                }
              }
              if (kp.description) gbpData.profile.description = kp.description;
              if (kp.hours) {
                gbpData.profile.hoursSet = true;
                gbpData.profile.hoursText = typeof kp.hours === 'string' ? kp.hours : JSON.stringify(kp.hours);
              }

              // Merge knowledge graph — only safe fields, never overwrite reviewCount with non-numbers
              const p = kp;
              if (p) {
                if (p.address) gbpData.profile.address = p.address;
                if (p.phone) gbpData.profile.phone = p.phone;
                // Don't overwrite reviewCount — KG often has wrong/missing data
                // Don't overwrite rating — SerpAPI Maps is more accurate
                // Only overwrite if KG has better data — never null out existing values
                if (p.description && !gbpData.profile.description) gbpData.profile.description = p.description;
                console.log(`[gbp-audit] KG merge: description=${gbpData.profile.description ? 'YES' : 'NO'}, hours=${gbpData.profile.hoursSet}`);
              }
            } catch (e) { console.log(`[gbp-audit] Detail lookup error: ${e.message}`); }
          }

          console.log(`[gbp-audit] PROFILE:`, JSON.stringify({
            name: gbpData.profile.name, rating: gbpData.profile.rating, reviews: gbpData.profile.reviewCount,
            photos: gbpData.profile.photoCount, phone: gbpData.profile.phone ? 'YES' : 'NO',
            categories: gbpData.profile.categories, description: gbpData.profile.description ? 'YES' : 'NO',
            hours: gbpData.profile.hoursSet, website: gbpData.profile.website ? 'YES' : 'NO',
          }));
        } else {
          console.log(`[gbp-audit] No match found for domain "${domain}" in ${results.length} results`);
          if (results.length > 0) console.log(`[gbp-audit] First result: "${results[0].title}" (${results[0].website || 'no site'})`);
        }
      } catch (e) { console.error('[gbp-audit] SerpAPI error:', e.message); }
    }

    // 1b. Enrich profile with DataForSEO (full GBP data: description, hours, services, posts, Q&A)
    if (DATAFORSEO_AUTH && gbpData.profile?.placeId) {
      try {
        console.log(`[gbp-audit] DataForSEO lookup for place_id: ${gbpData.profile.placeId}`);
        const dfsResp = await fetch('https://api.dataforseo.com/v3/business_data/google/my_business_info/task_post', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': DATAFORSEO_AUTH },
          body: JSON.stringify([{ keyword: businessName, location_name: location || 'Australia', language_name: 'English' }]),
          signal: AbortSignal.timeout(15000),
        });
        if (dfsResp.ok) {
          const dfsData = await dfsResp.json();
          const task = dfsData.tasks?.[0];
          if (task?.status_code === 20000 && task.result?.[0]?.items?.[0]) {
            const item = task.result[0].items[0];
            console.log(`[gbp-audit] DataForSEO found: "${item.title}", desc=${item.description ? 'YES' : 'NO'}, hours=${item.work_hours ? 'YES' : 'NO'}, services=${(item.people_also_search || []).length}`);
            // Merge richer data
            if (item.description) gbpData.profile.description = item.description;
            if (item.work_hours) {
              gbpData.profile.hoursSet = true;
              gbpData.profile.hoursText = JSON.stringify(item.work_hours);
            }
            if (item.total_photos) gbpData.profile.photoCount = item.total_photos;
            if (item.phone) gbpData.profile.phone = item.phone;
            if (item.category) gbpData.profile.primaryType = item.category;
            if (item.additional_categories) gbpData.profile.categories = [item.category, ...item.additional_categories].filter(Boolean);
            if (item.attributes) gbpData.profile.attributes = item.attributes;
            if (item.place_topics) gbpData.profile.topics = item.place_topics;
            gbpData.profile.dfsEnriched = true;
          } else {
            console.log(`[gbp-audit] DataForSEO: no results or error`, task?.status_code, task?.status_message);
          }
        }
      } catch (e) { console.log(`[gbp-audit] DataForSEO error: ${e.message}`); }
    }

    // 1b-alt. Try DataForSEO by keyword if no place_id
    if (DATAFORSEO_AUTH && gbpData.profile && !gbpData.profile.dfsEnriched) {
      try {
        console.log(`[gbp-audit] DataForSEO keyword search: "${businessName}"`);
        const dfsResp = await fetch('https://api.dataforseo.com/v3/business_data/google/my_business_info/task_post', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': DATAFORSEO_AUTH },
          body: JSON.stringify([{ keyword: businessName, location_name: location || 'Australia', language_name: 'English' }]),
          signal: AbortSignal.timeout(15000),
        });
        if (dfsResp.ok) {
          const dfsData = await dfsResp.json();
          const task = dfsData.tasks?.[0];
          if (task?.status_code === 20000 && task.result?.[0]?.items) {
            // Find matching business by domain
            const items = task.result[0].items;
            const match = items.find(i => i.domain && i.domain.includes(domain)) || items.find(i => i.title && i.title.toLowerCase().includes(businessName.split(' ')[0].toLowerCase())) || items[0];
            if (match) {
              console.log(`[gbp-audit] DataForSEO matched: "${match.title}", desc=${match.description ? 'YES' : 'NO'}, hours=${match.work_hours ? 'YES' : 'NO'}, photos=${match.total_photos || '?'}`);
              if (match.description) gbpData.profile.description = match.description;
              if (match.work_hours) { gbpData.profile.hoursSet = true; gbpData.profile.hoursText = JSON.stringify(match.work_hours); }
              if (match.total_photos) gbpData.profile.photoCount = match.total_photos;
              if (match.category) gbpData.profile.primaryType = match.category;
              if (match.additional_categories) gbpData.profile.categories = [match.category, ...match.additional_categories].filter(Boolean);
              if (match.attributes) gbpData.profile.attributes = match.attributes;
              gbpData.profile.dfsEnriched = true;
            }
          }
        }
      } catch (e) { console.log(`[gbp-audit] DataForSEO keyword error: ${e.message}`); }
    }

    // 1c. Scrape website for NAP consistency + schema
    if (domain) {
      try {
        const siteRes = await fetch(`https://${domain}`, { signal: AbortSignal.timeout(10000), headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SEORoom/1.0)' } });
        if (siteRes.ok) {
          const html = await siteRes.text();
          gbpData.websiteCheck = {
            hasPhone: /tel:[\d\+\-\s\(\)]+/.test(html),
            hasAddress: /\d+\s+[\w\s]+(?:street|st|road|rd|avenue|ave|drive|dr|way|place|pl|crescent|cr)/i.test(html),
          };
          const schemaMatch = html.match(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi);
          if (schemaMatch) {
            gbpData.websiteCheck.schemas = schemaMatch.map(s => {
              try { return JSON.parse(s.replace(/<\/?script[^>]*>/gi, '')); } catch { return null; }
            }).filter(Boolean);
            gbpData.websiteCheck.hasLocalBusinessSchema = gbpData.websiteCheck.schemas.some(s => 
              s['@type'] === 'LocalBusiness' || s['@type'] === 'Plumber' || s['@type'] === 'HomeAndConstructionBusiness' ||
              (Array.isArray(s['@graph']) && s['@graph'].some(g => ['LocalBusiness', 'Plumber', 'HomeAndConstructionBusiness'].includes(g['@type'])))
            );
          }
          console.log(`[gbp-audit] Website check: phone=${gbpData.websiteCheck.hasPhone}, address=${gbpData.websiteCheck.hasAddress}, schema=${gbpData.websiteCheck.hasLocalBusinessSchema || false}`);
        }
      } catch (e) { console.log(`[gbp-audit] Website scrape error: ${e.message}`); }
    }

    // 2. Get maps ranking data + identify competitors
    const mapsData = await pool.query(
      `SELECT keyword, location, maps_position, maps_title, maps_rating, maps_reviews, checked_at
       FROM rank_tracking WHERE project_id=$1 AND maps_position IS NOT NULL
       ORDER BY checked_at DESC LIMIT 200`, [projectId]
    );
    gbpData.mapsRankings = mapsData.rows.map(r => ({
      keyword: r.keyword, location: r.location,
      position: r.maps_position, rating: r.maps_rating, reviews: r.maps_reviews,
    }));

    // Extract top competitors from maps data (businesses ranking above us)
    const competitorMap = {};
    for (const r of mapsData.rows) {
      if (r.maps_title && r.maps_title.toLowerCase() !== businessName.toLowerCase()) {
        if (!competitorMap[r.maps_title]) {
          competitorMap[r.maps_title] = { name: r.maps_title, rating: r.maps_rating, reviews: r.maps_reviews, appearances: 0, avgPosition: 0, keywords: [] };
        }
        competitorMap[r.maps_title].appearances++;
        competitorMap[r.maps_title].keywords.push({ keyword: r.keyword, location: r.location, position: r.maps_position });
      }
    }
    // Top 5 competitors by appearances
    gbpData.competitors = Object.values(competitorMap)
      .sort((a, b) => b.appearances - a.appearances)
      .slice(0, 5)
      .map(c => ({
        ...c,
        avgPosition: (c.keywords.reduce((s, k) => s + k.position, 0) / c.keywords.length).toFixed(1),
        keywords: c.keywords.slice(0, 5),
      }));

    // Fallback: if no competitors from maps data, use Project Settings competitors + SerpAPI lookup
    if (gbpData.competitors.length === 0 && (project.competitors || []).length > 0 && SERPAPI_KEY) {
      console.log(`[gbp-audit] No maps competitors found, looking up ${project.competitors.length} from Project Settings`);
      for (const compDomain of (project.competitors || []).slice(0, 5)) {
        try {
          const cleanDomain = compDomain.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/$/, '');
          // Extract a business name from domain: "littlepommieplumber.com.au" -> "little pommie plumber"
          const domainName = cleanDomain.split('.')[0].replace(/[-_]/g, ' ');
          const searchQuery = `${domainName} ${(location || '').split(',')[0] || ''}`.trim();
          console.log(`[gbp-audit] Competitor search: "${searchQuery}" (from ${compDomain})`);
          const compSearch = await serpApiSearch({
            engine: 'google_maps',
            q: searchQuery,
            type: 'search',
            api_key: SERPAPI_KEY,
          });
          const place = (compSearch.local_results || [])[0];
          if (place) {
            gbpData.competitors.push({
              name: place.title || compDomain,
              rating: place.rating || null,
              reviews: place.reviews || null,
              appearances: 0,
              avgPosition: place.position || '—',
              keywords: [],
              source: 'project_settings',
              profile: {
                rating: place.rating,
                reviews: place.reviews,
                photoCount: (place.thumbnail ? 1 : 0),
                categories: place.type ? 1 : 0,
                primaryType: place.type || null,
                website: place.website || null,
              },
            });
          }
        } catch (e) { console.log(`[gbp-audit] Competitor lookup failed for ${compDomain}:`, e.message); }
      }
      console.log(`[gbp-audit] Found ${gbpData.competitors.length} competitors from Project Settings`);
    }

    // 3. Look up top competitor profiles via Places API for comparison
    if (GOOGLE_KEY && gbpData.competitors.length > 0) {
      for (const comp of gbpData.competitors.slice(0, 3)) {
        try {
          const compResp = await fetch('https://places.googleapis.com/v1/places:searchText', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Goog-Api-Key': GOOGLE_KEY,
              'X-Goog-FieldMask': 'places.displayName,places.rating,places.userRatingCount,places.types,places.primaryTypeDisplayName,places.photos,places.editorialSummary,places.regularOpeningHours,places.websiteUri'
            },
            body: JSON.stringify({ textQuery: `${comp.name} ${location.split(',')[0] || ''}`.trim(), languageCode: 'en' })
          });
          if (compResp.ok) {
            const compData = await compResp.json();
            const p = (compData.places || [])[0];
            if (p) {
              comp.profile = {
                rating: p.rating, reviews: p.userRatingCount,
                photoCount: (p.photos || []).length,
                primaryType: p.primaryTypeDisplayName?.text || null,
                categories: (p.types || []).length,
                hasDescription: !!p.editorialSummary?.text,
                hasHours: !!(p.regularOpeningHours?.periods),
                website: p.websiteUri || null,
              };
            }
          }
        } catch (e) { /* skip competitor lookup errors */ }
      }
    }

    const serviceAreas = project.service_areas || [];
    // Merge extension data on top of SerpAPI data (extension wins for hours, address)
    if (extensionProfile && gbpData.profile) {
      if (extensionProfile.hoursSet) { gbpData.profile.hoursSet = true; gbpData.profile.hoursText = extensionProfile.hoursText; gbpData.profile.hoursDays = extensionProfile.hoursDays; }
      if (extensionProfile.address) gbpData.profile.address = extensionProfile.address;
      if (extensionProfile.description) gbpData.profile.description = extensionProfile.description;
      if (extensionProfile.services && extensionProfile.services.length > 0) gbpData.profile.services = extensionProfile.services;
      if (extensionProfile.posts) gbpData.profile.posts = extensionProfile.posts;
      if (extensionProfile.attributes && extensionProfile.attributes.length > 0) gbpData.profile.attributes = extensionProfile.attributes;
      if (extensionProfile.photoCount > 1) gbpData.profile.photoCount = extensionProfile.photoCount;
      if (extensionProfile.thirdPartyReviews) gbpData.profile.thirdPartyReviews = extensionProfile.thirdPartyReviews;
      if (extensionProfile.socialProfiles) gbpData.profile.socialProfiles = extensionProfile.socialProfiles;
      if (extensionProfile.monthlyViews) gbpData.profile.monthlyViews = extensionProfile.monthlyViews;
      gbpData.profile.extensionData = true;
      console.log(`[gbp-audit] Merged extension data: hours=${gbpData.profile.hoursSet}, desc=${gbpData.profile.description ? 'YES' : 'NO'}, photos=${gbpData.profile.photoCount}`);
    }

    console.log(`[gbp-audit] Final: source=${gbpData.source}, competitors=${gbpData.competitors.length}, rankings=${gbpData.mapsRankings.length}`);

    // ===== PHASE 2: AI Analysis =====
    let findings = [];

    if (anthropic) {
      try {
        const aiPrompt = `You are an expert local SEO auditor. Audit this Google Business Profile and produce findings based on the THREE PILLARS of local search: PROXIMITY, RELEVANCE, and PROMINENCE.

PROJECT: ${project.name} (${domain})
Business: ${businessName}
Industry: ${industry || 'trades/services'}
Location: ${location}
Service Areas: ${JSON.stringify(serviceAreas).substring(0, 500)}

===== CURRENT GBP PROFILE =====
${JSON.stringify(gbpData.profile, null, 1)}

IMPORTANT DATA NOTES:
- If "description" is null/NO, it means our API couldn't retrieve it — it does NOT mean the business has no description. DO NOT flag it as missing.
- If "hoursSet" is false/null, it means our API couldn't retrieve hours — DO NOT flag hours as missing.
- If "photoCount" is 1 or very low, our API only counts thumbnails — the actual count may be higher. Flag photos cautiously.
- ONLY flag things as missing if you are CERTAIN from the data. When in doubt, skip that finding.
- Focus on what you CAN see: categories, rating, review count, rankings, competitors.

===== COMPETITORS =====
${JSON.stringify(gbpData.competitors, null, 1)}

===== MAPS RANKINGS (sample of ${gbpData.mapsRankings.length}) =====
${JSON.stringify(gbpData.mapsRankings.slice(0, 20), null, 1)}

Return JSON with "findings" array AND "profile_summary" object.

The "profile_summary" should contain:
{
  "rating": number or null,
  "review_count": number or null,
  "photo_count": number or null,
  "primary_category": string or null,
  "secondary_categories": array or [],
  "has_description": boolean,
  "has_hours": boolean,
  "has_phone": boolean,
  "has_website": boolean,
  "services_listed": boolean or null,
  "posts_active": boolean or null,
  "pillar_scores": { "proximity": 1-10, "relevance": 1-10, "prominence": 1-10 }
}

CRITICAL: Each finding object MUST include ALL these fields:
{
  "gbp_pillar": "Proximity" or "Relevance" or "Prominence",
  "category": "subcategory name",
  "title": "action to take",
  "description": "why this matters",
  "recommendation": "one specific action",
  "severity": "Critical" or "High" or "Medium" or "Low",
  "current_value": "what it is now",
  "recommended_value": "what it should be"
}

EXAMPLE finding:
{"gbp_pillar": "Prominence", "category": "Reviews", "title": "Respond to all Google reviews", "description": "With 105 reviews, responding shows engagement.", "recommendation": "Set up a weekly review response schedule.", "severity": "High", "current_value": "Unknown response rate", "recommended_value": "100% response rate"}

"gbp_pillar" assigns each finding to one of the THREE PILLARS — this field is REQUIRED:
- "Proximity" = service areas, address, geo-targeting, maps ranking by suburb, distance issues
- "Relevance" = categories, description keywords, services listed, posts, attributes, hours, business info
- "Prominence" = reviews, photos, citations, social profiles, third-party reviews, brand signals

"category" is the subcategory:
  For Proximity: "Service Areas", "Maps Ranking", "Geo-Targeting"
  For Relevance: "Categories & Services", "Profile Completeness", "Posts & Updates", "Description"
  For Prominence: "Reviews", "Photos", "Citations", "Social Profiles"

ORGANIZE findings by the THREE PILLARS:

1. PROXIMITY (service areas + maps visibility):
   - Are service areas properly set on GBP? Any gaps vs project settings?
   - Which suburbs have weak/no ranking? (top 3-5 worst only)
   - Is address accurate and consistent?

2. RELEVANCE (categories, content, business info):
   - Is the primary category optimal? What should it be?
   - Are there secondary categories? What's missing? (e.g. "Gas Fitter", "Drain Cleaning Service")
   - Is the business description keyword-optimized?
   - Are services/products listed on GBP?
   - Are GBP posts being used? How often?
   - Are business hours complete (all 7 days)?
   - Are attributes set (licenses, payment methods, accessibility)?
   - Create ONE finding for EACH missing or suboptimal field.

3. PROMINENCE (reputation + brand signals):
   - Reviews: count, rating, are they being responded to? Do reviews mention suburbs?
   - Photos: how many? Types needed: logo, cover, team, before/after, van
   - Third-party reviews: Facebook, hipages, etc.
   - Social profiles: connected and active?
   - Citations: NAP consistency across directories
   - Create separate findings for each issue

RULES:
- ONE finding = ONE action. Each is approved or dismissed independently.
- "recommendation" = ONE sentence. ONE action. No lists.
- "title" reads like a to-do: "Add Gas Fitter as secondary category", "Upload 10 before/after job photos", "Write keyword-rich business description"
- NEVER flag missing data if the field is null in our data — the API may not return it.
- Use real numbers. No generic advice.
- Total: 15-30 focused findings. Quality over quantity.

Return ONLY valid JSON: {"profile_summary": {...}, "findings": [...]}`;

        const response = await anthropic.messages.create({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 16000,
          messages: [{ role: 'user', content: aiPrompt }]
        });

        const text = response.content[0]?.text || '';
        console.log(`[gbp-audit] AI response: ${text.length} chars`);

        const jsonMatch = text.match(/\{[\s\S]*\}/);
        let profileSummary = null;
        if (jsonMatch) {
          // Clean common JSON issues from AI responses
          let jsonStr = jsonMatch[0]
            .replace(/,\s*}/g, '}')      // trailing commas before }
            .replace(/,\s*]/g, ']')      // trailing commas before ]
            .replace(/[\x00-\x1f]/g, ' ') // control characters
            .replace(/"\s*\n\s*"/g, '", "'); // missing commas between strings
          let parsed;
          try { parsed = JSON.parse(jsonStr); } catch (e) {
            // Second attempt: try to extract just the findings array
            console.log(`[gbp-audit] JSON parse retry after cleanup...`);
            const findingsMatch = text.match(/"findings"\s*:\s*\[([\s\S]*)\]/);
            if (findingsMatch) {
              try { parsed = { findings: JSON.parse('[' + findingsMatch[1] + ']') }; } catch (e2) {
                console.error('[gbp-audit] JSON parse failed even after cleanup:', e2.message);
                parsed = null;
              }
            }
          }
          if (!parsed) throw new Error('Could not parse AI response as JSON');
          profileSummary = parsed.profile_summary || null;
          // Smart fallback: infer pillar from category when AI doesn't include gbp_pillar
          const categoryToPillar = {
            'Reviews': 'Prominence', 'Review Management': 'Prominence', 'Review Response': 'Prominence',
            'Photos': 'Prominence', 'Photo Optimization': 'Prominence',
            'Citations': 'Prominence', 'Citation Building': 'Prominence', 'Directories': 'Prominence',
            'Social Profiles': 'Prominence', 'Social Media': 'Prominence',
            'Backlinks': 'Prominence', 'Online Presence': 'Prominence', 'Brand Mentions': 'Prominence',
            'Third-Party Reviews': 'Prominence', 'Reputation': 'Prominence',
            'Service Areas': 'Proximity', 'Service Area': 'Proximity',
            'Maps Ranking': 'Proximity', 'Maps': 'Proximity', 'Map Pack': 'Proximity',
            'Geo-Targeting': 'Proximity', 'Location': 'Proximity', 'Address': 'Proximity',
            'NAP Consistency': 'Proximity', 'NAP': 'Proximity', 'Local Landing Pages': 'Proximity',
            'Categories & Services': 'Relevance', 'Categories': 'Relevance', 'Services': 'Relevance',
            'Profile Completeness': 'Relevance', 'Business Information': 'Relevance',
            'Posts & Updates': 'Relevance', 'Posts': 'Relevance', 'Google Posts': 'Relevance',
            'Description': 'Relevance', 'Business Description': 'Relevance',
            'Website': 'Relevance', 'Website Optimization': 'Relevance',
            'Keywords': 'Relevance', 'Keyword Optimization': 'Relevance',
            'Q&A': 'Relevance', 'Products': 'Relevance', 'Attributes': 'Relevance',
            'Hours': 'Relevance', 'Business Hours': 'Relevance',
          };
          function inferPillar(finding) {
            if (['Proximity', 'Relevance', 'Prominence'].includes(finding.gbp_pillar)) return finding.gbp_pillar;
            const cat = (finding.category || '').trim();
            if (categoryToPillar[cat]) return categoryToPillar[cat];
            const catLower = cat.toLowerCase();
            for (const [key, pillar] of Object.entries(categoryToPillar)) {
              if (catLower.includes(key.toLowerCase()) || key.toLowerCase().includes(catLower)) return pillar;
            }
            const text = `${finding.title || ''} ${finding.description || ''}`.toLowerCase();
            if (/\b(review|rating|photo|citation|director|backlink|reputation|social|third.party)\b/.test(text)) return 'Prominence';
            if (/\b(service area|proximity|geo|location|address|nap |local pack|map)\b/.test(text)) return 'Proximity';
            return 'Relevance';
          }
          if (parsed.findings && Array.isArray(parsed.findings)) {
            findings = parsed.findings.map(f => {
              const gbpPillar = inferPillar(f);
              return {
                pillar: 'gbp', category: `${gbpPillar} > ${f.category || 'General'}`,
                gbp_pillar: gbpPillar,
                title: f.title, description: f.description,
                recommendation: f.recommendation, severity: f.severity || 'Medium',
                current_value: f.current_value || '', recommended_value: f.recommended_value || '',
              };
            });
          }
        }
      } catch (aiErr) {
        console.error('[gbp-audit] AI failed:', aiErr.message);
      }
    }

    // Build profile summary from raw data if AI didn't provide one
    const profileSummary = gbpData.profile ? {
      name: gbpData.profile.name,
      rating: gbpData.profile.rating,
      review_count: gbpData.profile.reviewCount,
      photo_count: gbpData.profile.photoCount,
      primary_category: gbpData.profile.primaryType,
      has_description: !!gbpData.profile.description,
      has_hours: gbpData.profile.hoursSet,
      has_phone: !!gbpData.profile.phone,
      has_website: !!gbpData.profile.website,
      address: gbpData.profile.address,
      business_status: gbpData.profile.businessStatus,
    } : null;

    // Fallback
    if (findings.length === 0) {
      if (!gbpData.profile) {
        findings.push({ pillar: 'gbp', category: 'Profile Completeness', title: 'GBP profile not found on Google Maps', description: `Could not find "${businessName}".`, recommendation: 'Verify your listing at business.google.com', severity: 'Critical', current_value: 'Not found', recommended_value: 'Verified' });
      }
    }

    // Save
    for (const f of findings) {
      const r = await pool.query(
        `INSERT INTO audit_findings (project_id, audit_id, pillar, category, title, description, recommendation, severity, current_value, recommended_value)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
        [projectId, auditId, f.pillar, f.category, f.title, f.description, f.recommendation, f.severity, f.current_value, f.recommended_value]
      );
      f.id = r.rows[0].id; f.status = 'new';
    }

    await pool.query('UPDATE audits SET status=$1, completed_at=NOW(), audit_data=$2 WHERE id=$3',
      ['completed', JSON.stringify({ findingsCount: findings.length, source: gbpData.source, competitors: gbpData.competitors.length, profileSummary }), auditId]);

    console.log(`[gbp-audit] Project ${projectId}: ${findings.length} findings via ${gbpData.source}`);
    res.json({ findings, profileSummary });
  } catch (e) {
    console.error('[gbp-audit] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ==================== MANAGED AGENT HELPERS ====================

// Wait for a managed agent session to be ready for user input
async function waitForSessionReady(apiBase, agentHeaders, sessionId, label, maxWaitMs = 60000) {
  const pollMs = 2000;
  const t0 = Date.now();
  while (Date.now() - t0 < maxWaitMs) {
    const statusResp = await fetch(`${apiBase}/sessions/${sessionId}`, { method: 'GET', headers: agentHeaders });
    if (statusResp.ok) {
      const sess = await statusResp.json();
      const st = sess.status || sess.state || '';
      if (st === 'awaiting_input' || st === 'idle') {
        console.log(`[${label}] Session ready (${st})`);
        return true;
      }
      if (st === 'completed' || st === 'ended' || st === 'failed') {
        console.log(`[${label}] Session terminated before ready: ${st}`);
        return false;
      }
      console.log(`[${label}] Waiting for session ready... status: ${st}`);
    }
    await new Promise(r => setTimeout(r, pollMs));
  }
  console.log(`[${label}] Session readiness timeout after ${maxWaitMs}ms`);
  return true; // proceed anyway, let the POST fail with a clear error
}

// Send user message to a managed agent session with retry on tool_use/tool_result errors
async function sendAgentMessage(apiBase, agentHeaders, sessionId, userPrompt, label, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const msgResp = await fetch(`${apiBase}/sessions/${sessionId}/events`, {
      method: 'POST',
      headers: agentHeaders,
      body: JSON.stringify({
        events: [{ type: 'user.message', content: [{ type: 'text', text: userPrompt }] }]
      }),
    });

    if (msgResp.ok) {
      const ack = await msgResp.text();
      console.log(`[${label}] Message sent (attempt ${attempt}): ${ack.substring(0, 200)}`);
      return true;
    }

    const errBody = await msgResp.text();
    console.log(`[${label}] Message send attempt ${attempt} failed (${msgResp.status}): ${errBody.substring(0, 500)}`);

    // If it's a tool_use/tool_result mismatch, wait for the environment to process tools then retry
    if (errBody.includes('tool_use') && errBody.includes('tool_result') && attempt < maxRetries) {
      console.log(`[${label}] Waiting for environment to process pending tool calls...`);
      await new Promise(r => setTimeout(r, 5000 * attempt)); // exponential backoff
      // Wait for session to become ready again
      await waitForSessionReady(apiBase, agentHeaders, sessionId, label, 30000);
      continue;
    }

    throw new Error(`Message send failed (${msgResp.status}): ${errBody}`);
  }
  throw new Error('Message send exhausted retries');
}

// Poll a managed agent session until complete, extract report text
async function pollAgentSession(apiBase, agentHeaders, sessionId, label, maxWaitMs = 600000) {
  const pollMs = 5000;
  const t0 = Date.now();

  while (Date.now() - t0 < maxWaitMs) {
    await new Promise(r => setTimeout(r, pollMs));

    const statusResp = await fetch(`${apiBase}/sessions/${sessionId}`, { method: 'GET', headers: agentHeaders });
    if (!statusResp.ok) {
      console.log(`[${label}] Status check failed: ${statusResp.status}`);
      continue;
    }

    const sess = await statusResp.json();
    const st = sess.status || sess.state || '';

    if (st === 'awaiting_input' || st === 'idle' || st === 'completed' || st === 'ended') {
      console.log(`[${label}] Agent finished: ${st}`);

      const evResp = await fetch(`${apiBase}/sessions/${sessionId}/events`, { method: 'GET', headers: agentHeaders });
      if (!evResp.ok) throw new Error(`GET events failed: ${evResp.status}`);
      const evBody = await evResp.text();
      console.log(`[${label}] Events length: ${evBody.length}`);

      let finalText = '';
      try {
        const evData = JSON.parse(evBody);
        const evts = evData.data || evData.events || (Array.isArray(evData) ? evData : []);

        // First pass: get assistant text from clearly-labeled assistant events
        for (const evt of evts) {
          const role = evt.role || evt.type || '';
          if (role === 'assistant' || role === 'assistant.message' || role === 'agent.response') {
            const content = evt.content || evt.message?.content || [];
            const parts = Array.isArray(content) ? content : (typeof content === 'string' ? [{ type: 'text', text: content }] : []);
            for (const p of parts) {
              if (p.type === 'text' && p.text) finalText += p.text + '\n';
            }
          }
        }

        // Fallback: get any non-user text blocks > 50 chars
        if (!finalText) {
          for (const evt of evts) {
            const role = evt.role || evt.type || '';
            if (role === 'user' || role === 'user.message') continue;
            const content = evt.content || evt.message?.content || [];
            const parts = Array.isArray(content) ? content : [];
            for (const p of parts) {
              if (p.type === 'text' && p.text && p.text.length > 50) finalText += p.text + '\n';
            }
          }
        }
      } catch (e) {
        console.log(`[${label}] Parse error: ${e.message}`);
        if (evBody.length > 200) finalText = evBody;
      }

      if (!finalText || finalText.length < 50) {
        throw new Error(`No assistant text. Events: ${evBody.length} chars`);
      }

      return finalText.trim();
    }
  }

  throw new Error('Agent timed out after 10 minutes');
}

// ==================== AGENT REPORT → STRUCTURED FINDINGS EXTRACTOR ====================

// Valid categories per pillar — findings MUST map to one of these
const PILLAR_CATEGORIES = {
  gbp_external: ['Profile Completeness', 'NAP Consistency', 'Reviews & Reputation', 'Competitor Analysis', 'Directory & Citations', 'Photos & Media', 'Suburb Coverage'],
  website: ['Site Health', 'Crawlability', 'On-Page Issues', 'Content Quality', 'Core Web Vitals', 'Schema & Data'],
  gsc_agent: ['Quick Wins', 'Low CTR Pages', 'Cannibalization', 'Zero-Click Pages', 'Underperforming Pages'],
  gsc: ['Quick Wins', 'Low CTR Pages', 'Cannibalization', 'Zero-Click Pages', 'Underperforming Pages'],
};

// Extract structured findings from an agent's markdown report using Haiku
async function extractFindingsFromReport(reportText, pillar, projectId, auditId) {
  if (!anthropic || !reportText) return [];
  const validCategories = PILLAR_CATEGORIES[pillar] || [];
  if (validCategories.length === 0) return [];

  try {
    console.log(`[findings-extractor] Extracting findings from ${pillar} report (${reportText.length} chars)...`);

    const resp = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 8000,
      messages: [{
        role: 'user',
        content: `You are a precise data extractor. Extract EVERY actionable finding from this SEO audit report into structured JSON.

RULES — follow exactly:
1. Extract ONLY findings that exist in the report text. Do NOT invent, assume, or add findings.
2. Every finding must have an action — skip pure informational/status lines (e.g. "Business has 105 reviews" is NOT a finding unless there's a recommended action).
3. Each finding MUST map to one of these categories: ${JSON.stringify(validCategories)}
4. If a finding doesn't clearly fit any category, use the closest match.
5. Skip the "Action Plan" / "Priority Action Plan" summary section — those are summaries of findings already captured in other sections. Extracting them would create duplicates.
6. Severity must be one of: Critical, High, Medium, Low
7. Include current_value and recommended_value when the report states them (numbers, text, or status). Use empty string if not stated.
8. The title should be a short actionable statement (e.g. "Add missing business description" not "Business Description Analysis")
9. The recommendation MUST include step-by-step instructions for a human to execute. For GBP profile changes, always include: (a) Go to business.google.com → select the business, (b) Click "Edit profile" in the sidebar, (c) Navigate to the specific section (e.g. "Business information", "Contact", "Hours"), (d) The exact field to change and what to enter, (e) Click Save. Be specific — name the exact menu items and fields.

Return a JSON array — ONLY valid JSON, no explanation:
[{
  "category": "<one of the valid categories>",
  "title": "<short actionable title>",
  "description": "<what's wrong, from the report>",
  "recommendation": "<specific fix action, from the report>",
  "severity": "<Critical|High|Medium|Low>",
  "current_value": "<current state if stated>",
  "recommended_value": "<target state if stated>"
}]

REPORT:
${reportText}`
      }]
    });

    const text = resp.content[0].text.trim();
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      console.log(`[findings-extractor] No JSON array found in Haiku response for ${pillar}`);
      return [];
    }

    const findings = JSON.parse(jsonMatch[0]);
    console.log(`[findings-extractor] Extracted ${findings.length} findings from ${pillar} report`);

    // Validate and clean each finding
    const validFindings = [];
    for (const f of findings) {
      // Enforce valid category
      const cat = validCategories.find(c => c.toLowerCase() === (f.category || '').toLowerCase())
        || validCategories.find(c => c.toLowerCase().includes((f.category || '').toLowerCase().split(' ')[0]))
        || validCategories[0];

      // Enforce valid severity
      const sev = ['Critical', 'High', 'Medium', 'Low'].find(s => s.toLowerCase() === (f.severity || '').toLowerCase()) || 'Medium';

      if (!f.title || !f.description) continue; // Skip malformed entries

      validFindings.push({
        pillar,
        category: cat,
        title: f.title.slice(0, 200),
        description: (f.description || '').slice(0, 1000),
        recommendation: (f.recommendation || '').slice(0, 1000),
        severity: sev,
        current_value: (f.current_value || '').slice(0, 500),
        recommended_value: (f.recommended_value || '').slice(0, 500),
      });
    }

    // Save to DB — findings + auto-create action items (agent findings are pre-validated)
    if (validFindings.length > 0) {
      // Clear old findings and action items for this pillar first
      await pool.query('DELETE FROM action_items WHERE project_id=$1 AND pillar=$2', [projectId, pillar]);
      await pool.query('DELETE FROM audit_findings WHERE project_id=$1 AND pillar=$2', [projectId, pillar]);

      for (const f of validFindings) {
        // Save finding as approved
        const fRes = await pool.query(
          `INSERT INTO audit_findings (project_id, audit_id, pillar, category, title, description, recommendation, severity, current_value, recommended_value, status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'approved') RETURNING id`,
          [projectId, auditId, f.pillar, f.category, f.title, f.description, f.recommendation, f.severity, f.current_value, f.recommended_value]
        );
        const findingId = fRes.rows[0].id;

        // Auto-create action item (agent findings are the truth — no manual approval needed)
        await pool.query(
          `INSERT INTO action_items (project_id, finding_id, pillar, type, category, title, description, current_value, new_value, severity, status, execution_type)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'pending', 'manual')`,
          [projectId, findingId, f.pillar, f.category, f.category, f.title, f.recommendation || f.description, f.current_value, f.recommended_value, f.severity]
        );
      }
      console.log(`[findings-extractor] Saved ${validFindings.length} findings + action items for ${pillar} (project ${projectId})`);
    }

    return validFindings;
  } catch (e) {
    console.error(`[findings-extractor] Error extracting ${pillar} findings:`, e.message);
    return [];
  }
}

// Re-extract findings from an existing completed agent audit (for backfilling)
app.post('/api/projects/:projectId/audits/:pillar/extract-findings', async (req, res) => {
  const { projectId, pillar } = req.params;
  try {
    const auditRes = await pool.query(
      `SELECT id, audit_data FROM audits WHERE project_id=$1 AND pillar=$2 AND status='completed' ORDER BY completed_at DESC LIMIT 1`,
      [projectId, pillar]
    );
    if (auditRes.rows.length === 0) return res.status(404).json({ error: `No completed ${pillar} audit found` });
    const audit = auditRes.rows[0];
    const auditData = typeof audit.audit_data === 'string' ? JSON.parse(audit.audit_data) : audit.audit_data;
    const reportText = auditData?.report;
    if (!reportText) return res.status(400).json({ error: 'Audit has no report text' });

    const findings = await extractFindingsFromReport(reportText, pillar, parseInt(projectId), audit.id);
    res.json({ extracted: findings.length, findings });
  } catch (e) {
    console.error(`[extract-findings] Error:`, e.message);
    res.status(500).json({ error: e.message });
  }
});

// ==================== EXTERNAL GBP AUDIT (Managed Agent — Sonnet + Web Search) ====================

app.get('/api/projects/:projectId/audits/gbp-external/status', async (req, res) => {
  const { projectId } = req.params;
  try {
    const result = await pool.query(
      `SELECT id, status, audit_data, started_at, completed_at FROM audits WHERE project_id=$1 AND pillar='gbp_external' ORDER BY started_at DESC LIMIT 1`,
      [projectId]
    );
    if (result.rows.length === 0) return res.json({ status: 'none' });
    const audit = result.rows[0];
    const data = typeof audit.audit_data === 'string' ? JSON.parse(audit.audit_data) : (audit.audit_data || {});
    res.json({
      status: audit.status,
      report: data.report || null,
      error: data.error || null,
      startedAt: audit.started_at,
      completedAt: audit.completed_at,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/projects/:projectId/audits/gbp-external/run', async (req, res) => {
  const { projectId } = req.params;
  try {
    const proj = await pool.query('SELECT * FROM projects WHERE id=$1', [projectId]);
    if (proj.rows.length === 0) return res.status(404).json({ error: 'Project not found' });
    const project = proj.rows[0];

    // Delete old external findings
    await pool.query(`DELETE FROM audit_findings WHERE project_id=$1 AND pillar='gbp_external'`, [projectId]);

    const auditRes = await pool.query(
      `INSERT INTO audits (project_id, pillar, status, started_at) VALUES ($1, 'gbp_external', 'running', NOW()) RETURNING id`,
      [projectId]
    );
    const auditId = auditRes.rows[0].id;

    const domain = (project.domain || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
    const businessName = project.business_name || project.name || '';
    const location = project.location || '';
    const industry = project.industry || '';
    const serviceAreas = project.service_areas || [];

    // Get extension-scraped data if available (for context)
    let extensionProfile = null;
    try {
      const extData = await pool.query(
        `SELECT config FROM project_integrations WHERE project_id=$1 AND kind='gbp_profile'`, [projectId]
      );
      if (extData.rows.length > 0) {
        extensionProfile = typeof extData.rows[0].config === 'string' ? JSON.parse(extData.rows[0].config) : extData.rows[0].config;
      }
    } catch (e) {}

    const gbpAgentId = process.env.GBP_AGENT_ID;
    const gbpEnvId = process.env.GBP_ENVIRONMENT_ID;

    if (!anthropic || !gbpAgentId || !gbpEnvId) {
      await pool.query('UPDATE audits SET status=$1, completed_at=NOW() WHERE id=$2', ['failed', auditId]);
      return res.status(500).json({ error: 'GBP Agent not configured. Set GBP_AGENT_ID and GBP_ENVIRONMENT_ID.' });
    }

    console.log(`[gbp-external] Starting managed agent audit for "${businessName}" in ${location}`);

    const userPrompt = `Conduct a full Google Business Profile audit for: ${businessName}, ${location}${domain ? `, website: ${domain}` : ''}${industry ? `, industry: ${industry}` : ''}`;

    // Run the managed agent via Sessions API (raw fetch — SDK may not have beta.sessions)
    const apiKey = process.env.ANTHROPIC_API_KEY;
    const apiBase = 'https://api.anthropic.com/v1';
    const agentHeaders = {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'managed-agents-2026-04-01',
    };

    console.log(`[gbp-external] Creating session for agent ${gbpAgentId}...`);

    const sessionResp = await fetch(`${apiBase}/sessions`, {
      method: 'POST',
      headers: agentHeaders,
      body: JSON.stringify({ agent: gbpAgentId, environment_id: gbpEnvId }),
    });
    if (!sessionResp.ok) {
      const errBody = await sessionResp.text();
      throw new Error(`Session create failed (${sessionResp.status}): ${errBody}`);
    }
    const session = await sessionResp.json();
    console.log(`[gbp-external] Session created: ${session.id}`);

    res.json({ auditId, status: 'running', sessionId: session.id });

    (async () => {
      try {
        await waitForSessionReady(apiBase, agentHeaders, session.id, 'gbp-external');
        await sendAgentMessage(apiBase, agentHeaders, session.id, userPrompt, 'gbp-external');
        const finalText = await pollAgentSession(apiBase, agentHeaders, session.id, 'gbp-external');

        await pool.query('UPDATE audits SET status=$1, completed_at=NOW(), audit_data=$2 WHERE id=$3',
          ['completed', JSON.stringify({ report: finalText, sessionId: session.id }), auditId]);
        console.log(`[gbp-external] Report stored (${finalText.length} chars)`);
        // Action items are now created exclusively by the Orchestrator — no per-audit extraction
      } catch (bgErr) {
        console.error('[gbp-external] Background error:', bgErr.message);
        try { await pool.query(`UPDATE audits SET status='failed', completed_at=NOW(), audit_data=$1 WHERE id=$2`,
          [JSON.stringify({ error: bgErr.message }), auditId]); } catch (e2) {}
      }
    })();

  } catch (e) {
    console.error('[gbp-external] Error:', e.message);
    try { await pool.query(`UPDATE audits SET status='failed', completed_at=NOW() WHERE project_id=$1 AND pillar='gbp_external' AND status='running'`, [projectId]); } catch (e2) {}
    res.status(500).json({ error: e.message });
  }
});

// ==================== WEBSITE AGENT AUDIT (Managed Agent) ====================

app.get('/api/projects/:projectId/audits/website-agent/status', async (req, res) => {
  const { projectId } = req.params;
  try {
    const result = await pool.query(
      `SELECT id, status, audit_data, started_at, completed_at FROM audits WHERE project_id=$1 AND pillar='website' ORDER BY started_at DESC LIMIT 1`,
      [projectId]
    );
    if (result.rows.length === 0) return res.json({ status: 'none' });
    const audit = result.rows[0];
    const data = typeof audit.audit_data === 'string' ? JSON.parse(audit.audit_data) : (audit.audit_data || {});
    res.json({
      status: audit.status,
      report: data.report || null,
      error: data.error || null,
      startedAt: audit.started_at,
      completedAt: audit.completed_at,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/projects/:projectId/audits/website-agent/run', async (req, res) => {
  const { projectId } = req.params;
  try {
    const proj = await pool.query('SELECT * FROM projects WHERE id=$1', [projectId]);
    if (proj.rows.length === 0) return res.status(404).json({ error: 'Project not found' });
    const project = proj.rows[0];

    await pool.query(`DELETE FROM audit_findings WHERE project_id=$1 AND pillar='website'`, [projectId]);

    const auditRes = await pool.query(
      `INSERT INTO audits (project_id, pillar, status, started_at) VALUES ($1, 'website', 'running', NOW()) RETURNING id`,
      [projectId]
    );
    const auditId = auditRes.rows[0].id;

    const domain = (project.domain || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
    const businessName = project.business_name || project.name || '';
    const location = project.location || '';
    const industry = project.industry || '';

    const websiteAgentId = process.env.WEBSITE_AGENT_ID || process.env.WEBSITE_AUDIT_AGENT;
    const envId = process.env.GBP_ENVIRONMENT_ID; // shared environment

    if (!anthropic || !websiteAgentId || !envId) {
      await pool.query('UPDATE audits SET status=$1, completed_at=NOW() WHERE id=$2', ['failed', auditId]);
      return res.status(500).json({ error: 'Website Agent not configured. Set WEBSITE_AGENT_ID env var.' });
    }

    console.log(`[website-agent] Starting audit for "${domain}"`);

    const userPrompt = `Conduct a comprehensive website SEO audit for: ${domain}${businessName ? ` (${businessName})` : ''}${location ? `, located in ${location}` : ''}${industry ? `, industry: ${industry}` : ''}. Simulate Googlebot crawling the homepage and key service/location pages. Analyze crawlability, renderability, indexability, content quality, Core Web Vitals, and competitive SERP standing. Use pipe-delimited markdown tables (| Col | Col |) for all data tables.`;

    const apiKey = process.env.ANTHROPIC_API_KEY;
    const apiBase = 'https://api.anthropic.com/v1';
    const agentHeaders = {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'managed-agents-2026-04-01',
    };

    const sessionResp = await fetch(`${apiBase}/sessions`, {
      method: 'POST',
      headers: agentHeaders,
      body: JSON.stringify({ agent: websiteAgentId, environment_id: envId }),
    });
    if (!sessionResp.ok) {
      const errBody = await sessionResp.text();
      throw new Error(`Session create failed (${sessionResp.status}): ${errBody}`);
    }
    const session = await sessionResp.json();
    console.log(`[website-agent] Session created: ${session.id}`);

    res.json({ auditId, status: 'running', sessionId: session.id });

    (async () => {
      try {
        await waitForSessionReady(apiBase, agentHeaders, session.id, 'website-agent');
        await sendAgentMessage(apiBase, agentHeaders, session.id, userPrompt, 'website-agent');
        const finalText = await pollAgentSession(apiBase, agentHeaders, session.id, 'website-agent');

        await pool.query('UPDATE audits SET status=$1, completed_at=NOW(), audit_data=$2 WHERE id=$3',
          ['completed', JSON.stringify({ report: finalText, sessionId: session.id }), auditId]);
        console.log(`[website-agent] Report stored (${finalText.length} chars)`);
        // Action items are now created exclusively by the Orchestrator — no per-audit extraction
      } catch (bgErr) {
        console.error('[website-agent] Background error:', bgErr.message);
        try { await pool.query(`UPDATE audits SET status='failed', completed_at=NOW(), audit_data=$1 WHERE id=$2`,
          [JSON.stringify({ error: bgErr.message }), auditId]); } catch (e2) {}
      }
    })();

  } catch (e) {
    console.error('[website-agent] Error:', e.message);
    try { await pool.query(`UPDATE audits SET status='failed', completed_at=NOW() WHERE project_id=$1 AND pillar='website' AND status='running'`, [projectId]); } catch (e2) {}
    res.status(500).json({ error: e.message });
  }
});

// ==================== GSC AGENT AUDIT (Managed Agent) ====================

app.get('/api/projects/:projectId/audits/gsc-agent/status', async (req, res) => {
  const { projectId } = req.params;
  try {
    const result = await pool.query(
      `SELECT id, status, audit_data, started_at, completed_at FROM audits WHERE project_id=$1 AND pillar='gsc_agent' ORDER BY started_at DESC LIMIT 1`,
      [projectId]
    );
    if (result.rows.length === 0) return res.json({ status: 'none' });
    const audit = result.rows[0];
    const data = typeof audit.audit_data === 'string' ? JSON.parse(audit.audit_data) : (audit.audit_data || {});
    res.json({
      status: audit.status,
      report: data.report || null,
      error: data.error || null,
      startedAt: audit.started_at,
      completedAt: audit.completed_at,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/projects/:projectId/audits/gsc-agent/run', async (req, res) => {
  const { projectId } = req.params;
  try {
    const proj = await pool.query('SELECT * FROM projects WHERE id=$1', [projectId]);
    if (proj.rows.length === 0) return res.status(404).json({ error: 'Project not found' });
    const project = proj.rows[0];

    await pool.query(`DELETE FROM audit_findings WHERE project_id=$1 AND pillar='gsc_agent'`, [projectId]);

    const auditRes = await pool.query(
      `INSERT INTO audits (project_id, pillar, status, started_at) VALUES ($1, 'gsc_agent', 'running', NOW()) RETURNING id`,
      [projectId]
    );
    const auditId = auditRes.rows[0].id;

    const domain = (project.domain || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
    const gscProperty = project.gsc_property || '';

    const gscAgentId = process.env.GSC_AGENT_ID || process.env.GSC_AUDIT_AGENT;
    const envId = process.env.GBP_ENVIRONMENT_ID; // shared environment

    if (!anthropic || !gscAgentId || !envId) {
      await pool.query('UPDATE audits SET status=$1, completed_at=NOW() WHERE id=$2', ['failed', auditId]);
      return res.status(500).json({ error: 'GSC Agent not configured. Set GSC_AGENT_ID env var.' });
    }

    // Fetch GSC data to feed to agent
    let gscData = null;
    try {
      const userId = 1; // TODO: get from auth
      const accessToken = await getGscAccessToken(userId);
      if (accessToken && gscProperty) {
        const property = gscProperty;
        // Fetch last 28 days of search analytics
        const analyticsResp = await fetch('https://www.googleapis.com/webmasters/v3/sites/' + encodeURIComponent(property) + '/searchAnalytics/query', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            startDate: new Date(Date.now() - 28 * 86400000).toISOString().split('T')[0],
            endDate: new Date().toISOString().split('T')[0],
            dimensions: ['query', 'page'],
            rowLimit: 500,
          }),
        });
        if (analyticsResp.ok) {
          gscData = await analyticsResp.json();
          console.log(`[gsc-agent] Fetched ${(gscData.rows || []).length} GSC rows`);
        }
      }
    } catch (e) {
      console.log(`[gsc-agent] Could not fetch GSC data: ${e.message}`);
    }

    console.log(`[gsc-agent] Starting audit for "${domain}"`);

    let userPrompt = `Conduct a comprehensive Google Search Console audit for: ${domain}`;
    if (gscData && gscData.rows && gscData.rows.length > 0) {
      // Summarize top data for the agent
      const topRows = gscData.rows.slice(0, 200).map(r => ({
        query: r.keys[0],
        page: r.keys[1],
        clicks: r.clicks,
        impressions: r.impressions,
        ctr: (r.ctr * 100).toFixed(1) + '%',
        position: r.position.toFixed(1),
      }));
      userPrompt += `\n\nHere is the GSC search analytics data (last 28 days, top 200 query+page combinations):\n\`\`\`json\n${JSON.stringify(topRows, null, 2)}\n\`\`\`\n\nAnalyze this data to find: Quick Wins (position 4-20 with good impressions), Low CTR pages, Keyword Cannibalization (same query ranking for multiple pages), Zero Click queries, Underperforming Pages, Brand Dependency. Use pipe-delimited markdown tables for all findings.`;
    } else {
      userPrompt += `\n\nNote: GSC API data was not available. Analyze the site externally — check indexing, keyword targeting, content gaps, and SERP presence. Use pipe-delimited markdown tables for all findings.`;
    }

    const apiKey = process.env.ANTHROPIC_API_KEY;
    const apiBase = 'https://api.anthropic.com/v1';
    const agentHeaders = {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'managed-agents-2026-04-01',
    };

    const sessionResp = await fetch(`${apiBase}/sessions`, {
      method: 'POST',
      headers: agentHeaders,
      body: JSON.stringify({ agent: gscAgentId, environment_id: envId }),
    });
    if (!sessionResp.ok) {
      const errBody = await sessionResp.text();
      throw new Error(`Session create failed (${sessionResp.status}): ${errBody}`);
    }
    const session = await sessionResp.json();
    console.log(`[gsc-agent] Session created: ${session.id}`);

    res.json({ auditId, status: 'running', sessionId: session.id });

    // Store raw GSC data for structured orchestrator use
    const gscRawRows = (gscData && gscData.rows) ? gscData.rows.slice(0, 200).map(r => ({
      query: r.keys[0], page: r.keys[1], clicks: r.clicks, impressions: r.impressions,
      ctr: parseFloat((r.ctr * 100).toFixed(1)), position: parseFloat(r.position.toFixed(1)),
    })) : null;

    (async () => {
      try {
        await waitForSessionReady(apiBase, agentHeaders, session.id, 'gsc-agent');
        await sendAgentMessage(apiBase, agentHeaders, session.id, userPrompt, 'gsc-agent');
        const finalText = await pollAgentSession(apiBase, agentHeaders, session.id, 'gsc-agent');

        await pool.query('UPDATE audits SET status=$1, completed_at=NOW(), audit_data=$2 WHERE id=$3',
          ['completed', JSON.stringify({ report: finalText, sessionId: session.id, raw_gsc_data: gscRawRows }), auditId]);
        console.log(`[gsc-agent] Report stored (${finalText.length} chars) with ${gscRawRows ? gscRawRows.length : 0} raw GSC rows`);
        // Action items are now created exclusively by the Orchestrator — no per-audit extraction
      } catch (bgErr) {
        console.error('[gsc-agent] Background error:', bgErr.message);
        try { await pool.query(`UPDATE audits SET status='failed', completed_at=NOW(), audit_data=$1 WHERE id=$2`,
          [JSON.stringify({ error: bgErr.message }), auditId]); } catch (e2) {}
      }
    })();

  } catch (e) {
    console.error('[gsc-agent] Error:', e.message);
    try { await pool.query(`UPDATE audits SET status='failed', completed_at=NOW() WHERE project_id=$1 AND pillar='gsc_agent' AND status='running'`, [projectId]); } catch (e2) {}
    res.status(500).json({ error: e.message });
  }
});

// ==================== TECHNICAL AUDIT (AI-Powered) ====================

app.post('/api/projects/:projectId/audits/technical/run', async (req, res) => {
  const { projectId } = req.params;
  try {
    const proj = await pool.query('SELECT * FROM projects WHERE id=$1', [projectId]);
    if (proj.rows.length === 0) return res.status(404).json({ error: 'Project not found' });
    const project = proj.rows[0];
    const wpUrl = project.wordpress_url;
    const domain = (project.website || project.domain || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
    const siteUrl = wpUrl || (domain ? `https://${domain}` : '');

    if (!siteUrl) return res.status(400).json({ error: 'No website URL configured. Set it in Project Settings.' });

    // Clean up old findings
    await pool.query(`DELETE FROM audit_findings WHERE project_id=$1 AND pillar='technical'`, [projectId]);

    const auditRes = await pool.query(
      `INSERT INTO audits (project_id, pillar, status, started_at) VALUES ($1, 'technical', 'running', NOW()) RETURNING id`,
      [projectId]
    );
    const auditId = auditRes.rows[0].id;
    const baseUrl = siteUrl.replace(/\/$/, '');

    console.log(`[tech-audit] Starting AI-powered audit for ${baseUrl}`);

    // ===== PHASE 1: Crawl site data =====
    const crawlData = {
      https: null, headers: {}, robots: null, sitemap: null,
      pages: [], sitemapUrls: [], robotsTxt: ''
    };

    // 1. Homepage fetch + headers
    try {
      const resp = await fetch(baseUrl, { redirect: 'follow', signal: AbortSignal.timeout(15000) });
      crawlData.https = { finalUrl: resp.url, isHttps: resp.url.startsWith('https://'), status: resp.status };
      crawlData.headers = {
        hsts: resp.headers.get('strict-transport-security') || null,
        xFrameOptions: resp.headers.get('x-frame-options') || null,
        contentSecurityPolicy: resp.headers.get('content-security-policy') ? 'present' : null,
        server: resp.headers.get('server') || null,
      };
      const homeHtml = await resp.text();
      crawlData.homepageSize = Math.round(homeHtml.length / 1024);
      crawlData.httpRefs = (homeHtml.match(/src=["']http:\/\//gi) || []).length;
    } catch (e) {
      crawlData.https = { error: e.message };
    }

    // 2. Robots.txt
    try {
      const robotsResp = await fetch(`${baseUrl}/robots.txt`, { signal: AbortSignal.timeout(10000) });
      if (robotsResp.ok) {
        crawlData.robotsTxt = await robotsResp.text();
        crawlData.robots = {
          exists: true,
          hasSitemap: crawlData.robotsTxt.toLowerCase().includes('sitemap:'),
          length: crawlData.robotsTxt.length,
        };
        // Check wildcard user-agent blocking
        const wildcardBlocks = crawlData.robotsTxt.split(/User-agent:\s*/i);
        const wildcardSection = wildcardBlocks.find(b => b.match(/^\*\s*$/m) || b.match(/^\*\n/));
        if (wildcardSection) {
          crawlData.robots.wildcardDisallowAll = !!wildcardSection.match(/^Disallow:\s*\/\s*$/m);
          crawlData.robots.wildcardAllowAll = !!wildcardSection.match(/^Allow:\s*\/\s*$/m);
        }
      } else {
        crawlData.robots = { exists: false, status: robotsResp.status };
      }
    } catch (e) { crawlData.robots = { exists: false, error: e.message }; }

    // 3. Sitemap discovery
    try {
      let sitemapResp = await fetch(`${baseUrl}/sitemap_index.xml`, { signal: AbortSignal.timeout(10000) });
      if (!sitemapResp.ok) sitemapResp = await fetch(`${baseUrl}/sitemap.xml`, { signal: AbortSignal.timeout(10000) });
      
      if (sitemapResp.ok) {
        const sitemapXml = await sitemapResp.text();
        const allLocs = (sitemapXml.match(/<loc>([^<]+)<\/loc>/g) || []).map(m => m.replace(/<\/?loc>/g, ''));
        
        // Check if this is a sitemap index
        const isIndex = sitemapXml.includes('<sitemapindex');
        if (isIndex) {
          crawlData.sitemap = { exists: true, type: 'index', subSitemaps: allLocs.length };
          // Fetch first sub-sitemap for actual URLs
          if (allLocs.length > 0) {
            try {
              const subResp = await fetch(allLocs[0], { signal: AbortSignal.timeout(10000) });
              if (subResp.ok) {
                const subXml = await subResp.text();
                crawlData.sitemapUrls = (subXml.match(/<loc>([^<]+)<\/loc>/g) || []).map(m => m.replace(/<\/?loc>/g, ''));
              }
            } catch (e) {}
          }
        } else {
          crawlData.sitemapUrls = allLocs.filter(u => !u.endsWith('.xml'));
          crawlData.sitemap = { exists: true, type: 'single', urlCount: crawlData.sitemapUrls.length };
        }
      } else {
        crawlData.sitemap = { exists: false };
      }
    } catch (e) { crawlData.sitemap = { exists: false, error: e.message }; }

    console.log(`[tech-audit] Sitemap: ${crawlData.sitemapUrls.length} URLs found`);

    // 4. Crawl sample pages — extract SEO data from each
    const pagesToCrawl = crawlData.sitemapUrls.length > 0
      ? crawlData.sitemapUrls.slice(0, 15)
      : [baseUrl, `${baseUrl}/contact`, `${baseUrl}/about`, `${baseUrl}/services`];

    for (const pageUrl of pagesToCrawl) {
      try {
        const pageResp = await fetch(pageUrl, { signal: AbortSignal.timeout(10000) });
        if (!pageResp.ok) {
          crawlData.pages.push({ url: pageUrl, status: pageResp.status, error: true });
          continue;
        }
        const html = await pageResp.text();
        const slug = pageUrl.replace(baseUrl, '').replace(/^\/|\/$/g, '') || 'home';

        // Extract meta title
        const titleMatch = html.match(/<title[^>]*>(.*?)<\/title>/is);
        const metaTitle = titleMatch ? titleMatch[1].trim() : null;

        // Extract meta description
        const descMatch = html.match(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']*)/i) ||
                          html.match(/<meta[^>]*content=["']([^"']*)[^>]*name=["']description["']/i);
        const metaDesc = descMatch ? descMatch[1].trim() : null;

        // Extract canonical
        const canonicalMatch = html.match(/<link[^>]*rel=["']canonical["'][^>]*href=["']([^"']*)/i);
        const canonical = canonicalMatch ? canonicalMatch[1] : null;

        // Extract OG tags
        const ogTitle = html.match(/property=["']og:title["'][^>]*content=["']([^"']*)/i)?.[1] || null;
        const ogDesc = html.match(/property=["']og:description["'][^>]*content=["']([^"']*)/i)?.[1] || null;
        const ogImage = html.match(/property=["']og:image["'][^>]*content=["']([^"']*)/i)?.[1] || null;

        // Schema markup
        const schemaMatches = html.match(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi) || [];
        let schemaTypes = [];
        for (const sm of schemaMatches) {
          try {
            const jsonStr = sm.replace(/<script[^>]*>/i, '').replace(/<\/script>/i, '');
            const parsed = JSON.parse(jsonStr);
            if (parsed['@type']) schemaTypes.push(parsed['@type']);
            if (parsed['@graph']) schemaTypes.push(...parsed['@graph'].map(g => g['@type']).filter(Boolean));
          } catch (e) {}
        }
        const hasItemtype = !!html.match(/itemtype=/i);

        // Viewport
        const hasViewport = !!html.match(/name=["']viewport["']/i);

        // H1 tags
        const h1Matches = html.match(/<h1[^>]*>(.*?)<\/h1>/gis) || [];
        const h1s = h1Matches.map(h => h.replace(/<[^>]+>/g, '').trim()).filter(Boolean);

        // Internal links
        const linkMatches = html.match(/href=["']([^"'#]+)["']/gi) || [];
        const internalLinks = linkMatches.filter(l => {
          const href = l.replace(/href=["']/i, '').replace(/["']$/, '');
          return (href.includes(domain) || (href.startsWith('/') && !href.startsWith('//'))) && !href.match(/\.(css|js|png|jpg|gif|svg|ico|woff|pdf)(\?|$)/i);
        }).length;
        const externalLinks = linkMatches.filter(l => {
          const href = l.replace(/href=["']/i, '').replace(/["']$/, '');
          return href.startsWith('http') && !href.includes(domain);
        }).length;

        // Images without alt
        const imgMatches = html.match(/<img[^>]*>/gi) || [];
        const imgsWithoutAlt = imgMatches.filter(img => !img.match(/alt=["'][^"']+["']/i)).length;

        // Robots meta
        const robotsMeta = html.match(/<meta[^>]*name=["']robots["'][^>]*content=["']([^"']*)/i)?.[1] || null;

        crawlData.pages.push({
          url: pageUrl, slug, status: pageResp.status,
          metaTitle, metaTitleLen: metaTitle ? metaTitle.length : 0,
          metaDesc, metaDescLen: metaDesc ? metaDesc.length : 0,
          canonical, ogTitle: ogTitle ? 'yes' : 'no', ogDesc: ogDesc ? 'yes' : 'no', ogImage: ogImage ? 'yes' : 'no',
          schemaTypes: schemaTypes.length > 0 ? schemaTypes.join(', ') : (hasItemtype ? 'microdata' : 'none'),
          hasViewport, h1s, h1Count: h1s.length,
          internalLinks, externalLinks,
          totalImages: imgMatches.length, imgsWithoutAlt,
          robotsMeta,
          htmlSize: Math.round(html.length / 1024),
        });
      } catch (e) {
        crawlData.pages.push({ url: pageUrl, error: true, errorMsg: e.message });
      }
    }

    console.log(`[tech-audit] Crawled ${crawlData.pages.filter(p => !p.error).length}/${pagesToCrawl.length} pages`);

    // 5. Server response time
    const startTime = Date.now();
    try {
      await fetch(baseUrl, { signal: AbortSignal.timeout(10000) });
      crawlData.responseTime = Date.now() - startTime;
    } catch (e) {
      crawlData.responseTime = 10000;
    }

    // ===== PHASE 2: AI Analysis =====
    let findings = [];

    if (anthropic) {
      try {
        const serviceAreas = project.service_areas || [];
        const aiPrompt = `You are an expert local SEO technical auditor. Analyze this website crawl data and return actionable findings.

PROJECT: ${project.name} (${domain})
Industry: ${project.industry || 'unknown'}
Location: ${project.location || 'unknown'}
Service Areas: ${JSON.stringify(serviceAreas).substring(0, 500)}

CRAWL DATA:
${JSON.stringify(crawlData, null, 1)}

Return a JSON object with "findings" array. Each finding MUST have:
- pillar: "technical"
- category: one of "security", "crawl", "sitemap", "schema", "mobile", "speed", "links", "structure", "on_page"
- title: concise issue title
- description: what's wrong and why it matters for SEO
- recommendation: specific action to fix it
- severity: "Critical", "Medium", or "Low"
- current_value: what it is now
- recommended_value: what it should be

ANALYZE THOROUGHLY FOR:

HTTPS & SECURITY:
- Is site on HTTPS? Mixed content? Missing HSTS?
- Security headers (X-Frame-Options, CSP)

CRAWLABILITY & INDEXING:
- robots.txt issues (blocking crawlers, missing sitemap directive)
- Sitemap presence and quality
- Pages with noindex that shouldn't have it
- Server response time

ON-PAGE SEO (per page):
- Meta titles: too long (>60), too short (<30), missing, duplicates, missing location keywords for local SEO
- Meta descriptions: too long (>160), too short (<70), missing
- Missing or multiple H1 tags
- Missing canonical tags
- Missing OG tags (og:title, og:description, og:image)
- Images without alt text

SCHEMA MARKUP:
- Missing LocalBusiness schema (critical for local SEO)
- Missing Service schema
- Pages without any structured data

MOBILE USABILITY:
- Missing viewport meta tag

INTERNAL LINK STRUCTURE:
- Pages with fewer than 3 internal links (weak connectivity)
- Average internal links per page
- Orphan-like pages

Be specific — reference actual page URLs and their exact issues. Do NOT make up data — only report what the crawl data shows.
For a local business, missing LocalBusiness schema and location keywords in meta titles are high-priority findings.

Return ONLY valid JSON: {"findings": [...]}`;

        const response = await anthropic.messages.create({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 8000,
          messages: [{ role: 'user', content: aiPrompt }]
        });

        const text = response.content[0]?.text || '';
        console.log(`[tech-audit] AI response: ${text.length} chars`);

        // Parse AI response
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);
          if (parsed.findings && Array.isArray(parsed.findings)) {
            findings = parsed.findings.map(f => ({
              pillar: 'technical',
              category: f.category || 'general',
              title: f.title,
              description: f.description,
              recommendation: f.recommendation,
              severity: f.severity || 'Medium',
              current_value: f.current_value || '',
              recommended_value: f.recommended_value || '',
            }));
          }
        }
      } catch (aiErr) {
        console.error('[tech-audit] AI analysis failed:', aiErr.message);
      }
    }

    // Fallback: if AI failed or not configured, use basic rule-based findings
    if (findings.length === 0) {
      console.log('[tech-audit] Using rule-based fallback');
      if (crawlData.https && !crawlData.https.isHttps) {
        findings.push({ pillar: 'technical', category: 'security', title: 'Site not using HTTPS', description: 'HTTPS is a ranking factor.', recommendation: 'Install SSL certificate.', severity: 'Critical', current_value: 'HTTP', recommended_value: 'HTTPS' });
      }
      if (!crawlData.headers.hsts) {
        findings.push({ pillar: 'technical', category: 'security', title: 'Missing HSTS header', description: 'Strict-Transport-Security not set.', recommendation: 'Add HSTS header.', severity: 'Low', current_value: 'Not set', recommended_value: 'max-age=31536000' });
      }
      if (crawlData.robots && !crawlData.robots.exists) {
        findings.push({ pillar: 'technical', category: 'crawl', title: 'robots.txt not found', description: 'Search engines need this file.', recommendation: 'Create robots.txt.', severity: 'Medium', current_value: 'Missing', recommended_value: 'Present' });
      }
      if (crawlData.sitemap && !crawlData.sitemap.exists) {
        findings.push({ pillar: 'technical', category: 'sitemap', title: 'XML sitemap not found', description: 'Sitemaps help discovery.', recommendation: 'Generate sitemap.', severity: 'Critical', current_value: 'Missing', recommended_value: 'Present' });
      }
      for (const page of crawlData.pages.filter(p => !p.error)) {
        if (page.schemaTypes === 'none') {
          findings.push({ pillar: 'technical', category: 'schema', title: `Missing schema: ${page.slug}`, description: `${page.url} has no structured data.`, recommendation: 'Add JSON-LD schema.', severity: 'Medium', current_value: 'None', recommended_value: 'LocalBusiness + Service' });
        }
      }
      if (findings.length === 0) {
        findings.push({ pillar: 'technical', category: 'general', title: 'No critical issues detected', description: 'Basic checks passed.', recommendation: 'Run a deeper audit.', severity: 'Low', current_value: 'Passed', recommended_value: 'N/A' });
      }
    }

    // Save findings
    for (const f of findings) {
      await pool.query(
        `INSERT INTO audit_findings (project_id, audit_id, pillar, category, title, description, recommendation, severity, current_value, recommended_value)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
        [projectId, auditId, f.pillar, f.category, f.title, f.description, f.recommendation, f.severity, f.current_value, f.recommended_value]
      );
    }

    await pool.query(`UPDATE audits SET status='completed', completed_at=NOW(), audit_data=$2 WHERE id=$1`, [auditId, JSON.stringify({ crawlData: { pagesScanned: crawlData.pages.length, sitemapUrls: crawlData.sitemapUrls.length } })]);

    console.log(`[tech-audit] Done. ${findings.length} findings.`);
    const savedFindings = await pool.query('SELECT * FROM audit_findings WHERE audit_id=$1 ORDER BY severity', [auditId]);
    res.json({ findings: savedFindings.rows });
  } catch (e) {
    console.error('[tech-audit] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ==================== 11. USER-LEVEL OAUTH (GSC & GBP) ====================

// Helper: get GSC access token by userId (user-level, shared across all projects)
async function getGscAccessToken(userId) {
  const r = await pool.query('SELECT config FROM user_integrations WHERE user_id=$1 AND kind=$2 AND status=$3', [userId, 'gsc', 'connected']);
  if (r.rows.length === 0) return null;
  let config = r.rows[0].config;
  if (typeof config === 'string') config = JSON.parse(config);

  // Refresh if expired (with 60s buffer)
  if (Date.now() > (config.expires_at - 60000)) {
    if (!config.refresh_token) return null;
    const refreshRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        refresh_token: config.refresh_token, client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET, grant_type: 'refresh_token'
      })
    });
    const newTokens = await refreshRes.json();
    if (newTokens.error) { console.error('[gsc] Token refresh failed:', newTokens.error); return null; }
    config.access_token = newTokens.access_token;
    config.expires_at = Date.now() + (newTokens.expires_in * 1000);
    await pool.query('UPDATE user_integrations SET config=$1, updated_at=NOW() WHERE user_id=$2 AND kind=$3',
      [JSON.stringify(config), userId, 'gsc']);
  }
  return config.access_token;
}

// Helper: get GBP access token by userId (user-level)
async function getGbpAccessToken(userId) {
  const r = await pool.query('SELECT config FROM user_integrations WHERE user_id=$1 AND kind=$2 AND status=$3', [userId, 'gbp', 'connected']);
  if (r.rows.length === 0) return null;
  let config = r.rows[0].config;
  if (typeof config === 'string') config = JSON.parse(config);

  if (Date.now() > (config.expires_at - 60000)) {
    if (!config.refresh_token) return null;
    const refreshRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        refresh_token: config.refresh_token, client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET, grant_type: 'refresh_token'
      })
    });
    const newTokens = await refreshRes.json();
    if (newTokens.error) { console.error('[gbp] Token refresh failed:', newTokens.error); return null; }
    config.access_token = newTokens.access_token;
    config.expires_at = Date.now() + (newTokens.expires_in * 1000);
    await pool.query('UPDATE user_integrations SET config=$1, updated_at=NOW() WHERE user_id=$2 AND kind=$3',
      [JSON.stringify(config), userId, 'gbp']);
  }
  return config.access_token;
}

// List available GSC sites for dropdown in Project Settings
app.get('/api/user/gsc/sites', async (req, res) => {
  try {
    const accessToken = await getGscAccessToken(req.auth.userId);
    if (!accessToken) return res.json({ sites: [], error: 'GSC not connected' });
    const sites = await fetch('https://www.googleapis.com/webmasters/v3/sites', {
      headers: { Authorization: `Bearer ${accessToken}` }
    }).then(r => r.json());
    res.json({ sites: (sites.siteEntry || []).map(s => ({ url: s.siteUrl, permission: s.permissionLevel })) });
  } catch (e) { res.json({ sites: [], error: e.message }); }
});

// List available GBP locations for dropdown in Project Settings
app.get('/api/user/gbp/locations', async (req, res) => {
  try {
    const accessToken = await getGbpAccessToken(req.auth.userId);
    if (!accessToken) return res.json({ locations: [], error: 'GBP not connected' });
    const acctRes = await fetch('https://mybusinessaccountmanagement.googleapis.com/v1/accounts', {
      headers: { Authorization: `Bearer ${accessToken}` }
    }).then(r => r.json());
    const allLocations = [];
    for (const acct of (acctRes.accounts || [])) {
      try {
        const locRes = await fetch(
          `https://mybusinessbusinessinformation.googleapis.com/v1/${acct.name}/locations?readMask=name,title,storefrontAddress,websiteUri`, {
          headers: { Authorization: `Bearer ${accessToken}` }
        }).then(r => r.json());
        for (const l of (locRes.locations || [])) {
          allLocations.push({ id: l.name, title: l.title, address: l.storefrontAddress?.addressLines?.join(', ') || '', website: l.websiteUri || '' });
        }
      } catch (e) { /* skip account errors */ }
    }
    res.json({ locations: allLocations });
  } catch (e) { res.json({ locations: [], error: e.message }); }
});

// ==================== GSC OAUTH (USER-LEVEL) ====================

// Start GSC OAuth — no projectId needed
app.get('/api/user/gsc/connect', (req, res) => {
  if (!GOOGLE_CLIENT_ID) return res.status(503).json({ error: 'Google OAuth not configured' });
  const state = Buffer.from(JSON.stringify({
    token: req.headers.authorization?.replace('Bearer ', '')
  })).toString('base64url');
  const url = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${GOOGLE_CLIENT_ID}&redirect_uri=${encodeURIComponent(GOOGLE_REDIRECT_URI)}&response_type=code&scope=${encodeURIComponent(GSC_SCOPES)}&access_type=offline&prompt=consent&state=${state}`;
  res.json({ url });
});

// GSC callback — store tokens at user level
app.get('/api/gsc/callback', async (req, res) => {
  try {
    const { code, state } = req.query;
    if (!code || !state) return res.status(400).send('Missing code or state');
    const stateData = JSON.parse(Buffer.from(state, 'base64url').toString());
    const token = stateData.token;

    let userId;
    try { userId = jwt.verify(token, JWT_SECRET).userId; } catch { return res.status(401).send('Invalid session'); }

    // Exchange code for tokens
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code, client_id: GOOGLE_CLIENT_ID, client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri: GOOGLE_REDIRECT_URI, grant_type: 'authorization_code'
      })
    });
    const tokens = await tokenRes.json();
    if (tokens.error) return res.status(400).send(`OAuth error: ${tokens.error_description || tokens.error}`);

    // Store in user_integrations (not project_integrations)
    await pool.query(
      `INSERT INTO user_integrations (user_id, kind, config, status)
       VALUES ($1, 'gsc', $2, 'connected')
       ON CONFLICT (user_id, kind) DO UPDATE SET config=$2, status='connected', updated_at=NOW()`,
      [userId, JSON.stringify({
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        expires_at: Date.now() + (tokens.expires_in * 1000)
      })]
    );
    console.log(`[gsc] OAuth tokens stored for user ${userId}`);

    res.send('<html><body><script>window.close(); window.opener && window.opener.location.reload();</script><p>GSC connected! You can close this tab.</p></body></html>');
  } catch (err) {
    console.error('[gsc] OAuth callback error:', err.message);
    res.status(500).send('OAuth failed: ' + err.message);
  }
});

// User-level GSC status
app.get('/api/user/gsc/status', async (req, res) => {
  const r = await pool.query('SELECT status, updated_at FROM user_integrations WHERE user_id=$1 AND kind=$2', [req.auth.userId, 'gsc']);
  if (r.rows.length === 0) return res.json({ connected: false });
  res.json({ connected: r.rows[0].status === 'connected', updated_at: r.rows[0].updated_at });
});

// User-level GSC disconnect
app.post('/api/user/gsc/disconnect', async (req, res) => {
  await pool.query('UPDATE user_integrations SET status=$1, config=$2, updated_at=NOW() WHERE user_id=$3 AND kind=$4',
    ['disconnected', '{}', req.auth.userId, 'gsc']);
  res.json({ ok: true });
});

// ==================== GBP OAUTH (USER-LEVEL) ====================

// Start GBP OAuth — no projectId needed
app.get('/api/user/gbp/connect', (req, res) => {
  if (!GOOGLE_CLIENT_ID) return res.status(503).json({ error: 'Google OAuth not configured' });
  const state = Buffer.from(JSON.stringify({
    token: req.headers.authorization?.replace('Bearer ', '')
  })).toString('base64url');
  const url = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${GOOGLE_CLIENT_ID}&redirect_uri=${encodeURIComponent(GBP_REDIRECT_URI)}&response_type=code&scope=${encodeURIComponent(GBP_SCOPES)}&access_type=offline&prompt=consent&state=${state}`;
  res.json({ url });
});

// GBP callback — store tokens at user level
app.get('/api/gbp/callback', async (req, res) => {
  try {
    const { code, state } = req.query;
    if (!code || !state) return res.status(400).send('Missing code or state');
    const stateData = JSON.parse(Buffer.from(state, 'base64url').toString());
    const token = stateData.token;

    let userId;
    try { userId = jwt.verify(token, JWT_SECRET).userId; } catch { return res.status(401).send('Invalid session'); }

    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code, client_id: GOOGLE_CLIENT_ID, client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri: GBP_REDIRECT_URI, grant_type: 'authorization_code'
      })
    });
    const tokens = await tokenRes.json();
    if (tokens.error) return res.status(400).send(`OAuth error: ${tokens.error_description || tokens.error}`);

    await pool.query(
      `INSERT INTO user_integrations (user_id, kind, config, status)
       VALUES ($1, 'gbp', $2, 'connected')
       ON CONFLICT (user_id, kind) DO UPDATE SET config=$2, status='connected', updated_at=NOW()`,
      [userId, JSON.stringify({
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        expires_at: Date.now() + (tokens.expires_in * 1000)
      })]
    );
    console.log(`[gbp] OAuth tokens stored for user ${userId}`);
    res.send('<html><body><script>window.close(); window.opener && window.opener.location.reload();</script><p>GBP connected! You can close this tab.</p></body></html>');
  } catch (err) {
    console.error('[gbp] OAuth callback error:', err.message);
    res.status(500).send('OAuth failed: ' + err.message);
  }
});

// User-level GBP status
app.get('/api/user/gbp/status', async (req, res) => {
  const r = await pool.query('SELECT status, updated_at FROM user_integrations WHERE user_id=$1 AND kind=$2', [req.auth.userId, 'gbp']);
  if (r.rows.length === 0) return res.json({ connected: false });
  res.json({ connected: r.rows[0].status === 'connected', updated_at: r.rows[0].updated_at });
});

// User-level GBP disconnect
app.post('/api/user/gbp/disconnect', async (req, res) => {
  await pool.query('UPDATE user_integrations SET status=$1, config=$2, updated_at=NOW() WHERE user_id=$3 AND kind=$4',
    ['disconnected', '{}', req.auth.userId, 'gbp']);
  res.json({ ok: true });
});

// User-level: get all Google integration statuses
app.get('/api/user/integrations', async (req, res) => {
  try {
    const r = await pool.query('SELECT kind, status, updated_at FROM user_integrations WHERE user_id=$1', [req.auth.userId]);
    const integrations = {};
    r.rows.forEach(row => { integrations[row.kind] = { status: row.status, connected: row.status === 'connected', updated_at: row.updated_at }; });
    res.json({ integrations });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GBP: List accounts and locations (uses user-level token)
app.get('/api/projects/:projectId/gbp/locations', async (req, res) => {
  try {
    const accessToken = await getGbpAccessToken(req.auth.userId);
    if (!accessToken) return res.status(400).json({ error: 'GBP not connected — connect in Integrations' });

    const acctRes = await fetch('https://mybusinessaccountmanagement.googleapis.com/v1/accounts', {
      headers: { Authorization: `Bearer ${accessToken}` }
    }).then(r => r.json());

    const accounts = acctRes.accounts || [];
    if (accounts.length === 0) return res.json({ accounts: [], locations: [] });

    const allLocations = [];
    for (const acct of accounts) {
      const locRes = await fetch(`https://mybusinessbusinessinformation.googleapis.com/v1/${acct.name}/locations?readMask=name,title,storefrontAddress,phoneNumbers,categories,websiteUri,regularHours,metadata`, {
        headers: { Authorization: `Bearer ${accessToken}` }
      }).then(r => r.json());
      const locs = (locRes.locations || []).map(l => ({ ...l, accountName: acct.name, accountDisplayName: acct.accountName }));
      allLocations.push(...locs);
    }

    res.json({ accounts, locations: allLocations });
  } catch (e) {
    console.error('[gbp] Locations error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Sync GSC keywords — fetches real positions from Google and stores them
app.post('/api/projects/:projectId/gsc/sync-keywords', async (req, res) => {
  try {
    const { projectId } = req.params;
    const accessToken = await getGscAccessToken(req.auth.userId);
    if (!accessToken) return res.status(400).json({ error: 'GSC not connected — connect in Integrations' });

    const proj = await pool.query('SELECT domain FROM projects WHERE id=$1', [projectId]);
    if (proj.rows.length === 0) return res.status(404).json({ error: 'Project not found' });

    const domain = proj.rows[0].domain;
    const gscDomain = `sc-domain:${domain.replace(/^(https?:\/\/)?(www\.)?/, '').replace(/\/$/, '')}`;

    // Find matching site
    const sites = await fetch('https://www.googleapis.com/webmasters/v3/sites', {
      headers: { Authorization: `Bearer ${accessToken}` }
    }).then(r => r.json());
    const available = (sites.siteEntry || []).map(s => s.siteUrl);
    let matchedSite = available.find(s => s.includes(domain.replace(/^www\./, '')));
    if (!matchedSite && available.length > 0) matchedSite = available[0];
    if (!matchedSite) return res.status(400).json({ error: 'Domain not found in GSC' });

    // Fetch last 28 days for more accurate recent positions
    const endDate = new Date().toISOString().split('T')[0];
    const startDate = new Date(Date.now() - 28 * 86400000).toISOString().split('T')[0];

    const perfRes = await fetch(`https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(matchedSite)}/searchAnalytics/query`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ startDate, endDate, dimensions: ['query'], rowLimit: 500 })
    });
    const perfData = await perfRes.json();
    const rows = perfData.rows || [];

    // Upsert into gsc_keywords (save current position as prev_position before overwriting)
    let synced = 0;
    for (const row of rows) {
      const kw = row.keys[0];
      await pool.query(
        `INSERT INTO gsc_keywords (project_id, keyword, clicks, impressions, ctr, position, fetched_at)
         VALUES ($1, $2, $3, $4, $5, $6, NOW())
         ON CONFLICT (project_id, keyword)
         DO UPDATE SET prev_position = gsc_keywords.position, clicks=$3, impressions=$4, ctr=$5, position=$6, fetched_at=NOW()`,
        [projectId, kw, row.clicks || 0, row.impressions || 0, row.ctr || 0, row.position || 0]
      );
      synced++;
    }

    console.log(`[gsc] Synced ${synced} keywords for project ${projectId}, matchedSite=${matchedSite}, available=${JSON.stringify(available)}, rawRows=${rows.length}`);
    res.json({ ok: true, synced, last_date: endDate, debug: { matched_site: matchedSite, available_sites: available, raw_rows: rows.length, domain_used: domain, gsc_domain_tried: gscDomain, perf_response_keys: Object.keys(perfData) } });
  } catch (e) {
    console.error('[gsc] Sync keywords error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Get synced GSC keywords
app.get('/api/projects/:projectId/gsc/keywords', async (req, res) => {
  try {
    const r = await pool.query(
      'SELECT keyword, clicks, impressions, ctr, position, fetched_at FROM gsc_keywords WHERE project_id=$1 ORDER BY impressions DESC',
      [req.params.projectId]
    );
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Upload GSC keywords from CSV (exported from Google Search Console)
app.post('/api/projects/:projectId/gsc/upload-csv', async (req, res) => {
  try {
    const { projectId } = req.params;
    const { rows } = req.body; // [{keyword, clicks, impressions, ctr, position}]
    if (!Array.isArray(rows) || rows.length === 0) return res.status(400).json({ error: 'No rows provided' });

    let synced = 0;
    for (const row of rows) {
      const kw = (row.keyword || '').trim();
      if (!kw) continue;
      const clicks = parseInt(row.clicks) || 0;
      const impressions = parseInt(row.impressions) || 0;
      const ctr = parseFloat((row.ctr || '0').replace('%', '')) / 100 || 0;
      const position = parseFloat(row.position) || 0;

      await pool.query(
        `INSERT INTO gsc_keywords (project_id, keyword, clicks, impressions, ctr, position, fetched_at)
         VALUES ($1, $2, $3, $4, $5, $6, NOW())
         ON CONFLICT (project_id, keyword)
         DO UPDATE SET prev_position = gsc_keywords.position, clicks=$3, impressions=$4, ctr=$5, position=$6, fetched_at=NOW()`,
        [projectId, kw, clicks, impressions, ctr, position]
      );
      synced++;
    }

    console.log(`[gsc] CSV upload: ${synced} keywords for project ${projectId}`);
    res.json({ ok: true, synced });
  } catch (e) {
    console.error('[gsc] CSV upload error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ==================== DATAFORSEO RANK TRACKING ====================

// Import discovered keywords with volume + position data
app.post('/api/projects/:projectId/rank-tracking/import-discovered', async (req, res) => {
  const { projectId } = req.params;
  const { keywords } = req.body; // [{keyword, volume, position, url, competition}]
  if (!Array.isArray(keywords) || keywords.length === 0) return res.status(400).json({ error: 'No keywords provided' });
  try {
    let added = 0;
    const baseTime = Date.now();
    for (let i = 0; i < keywords.length; i++) {
      const k = keywords[i];
      if (!k.keyword) continue;
      const kw = k.keyword.trim();
      // Insert into rank_keywords with volume
      await pool.query(
        `INSERT INTO rank_keywords (project_id, keyword, search_volume, competition) VALUES ($1, $2, $3, $4)
         ON CONFLICT (project_id, keyword, location) DO UPDATE SET search_volume=COALESCE(EXCLUDED.search_volume, rank_keywords.search_volume), competition=COALESCE(EXCLUDED.competition, rank_keywords.competition)`,
        [projectId, kw, k.volume || null, k.competition || null]
      );
      // Don't insert GSC position as SERP rank — only real SERP checks should populate rank_tracking
      added++;
    }
    const { rows } = await pool.query('SELECT * FROM rank_keywords WHERE project_id=$1 ORDER BY keyword', [projectId]);
    res.json({ ok: true, added, total: rows.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Add keywords to track
app.post('/api/projects/:projectId/rank-tracking/keywords', async (req, res) => {
  const { projectId } = req.params;
  const { keywords, location_code, location } = req.body; // keywords: string[], location: string (suburb/city for Maps), location_code: number
  if (!Array.isArray(keywords) || keywords.length === 0) return res.status(400).json({ error: 'No keywords provided' });
  try {
    let added = 0;
    for (const kw of keywords) {
      if (!kw || typeof kw !== 'string') continue;
      await pool.query(
        `INSERT INTO rank_keywords (project_id, keyword, location, location_code) VALUES ($1, $2, $3, $4) ON CONFLICT (project_id, keyword, location) DO NOTHING`,
        [projectId, kw.trim(), location || '', location_code || 2036]
      );
      added++;
    }
    const { rows } = await pool.query('SELECT * FROM rank_keywords WHERE project_id=$1 ORDER BY added_at DESC', [projectId]);
    res.json({ ok: true, added, total: rows.length, keywords: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Remove a tracked keyword
app.delete('/api/projects/:projectId/rank-tracking/keywords/:keywordId', async (req, res) => {
  try {
    await pool.query('DELETE FROM rank_keywords WHERE id=$1 AND project_id=$2', [req.params.keywordId, req.params.projectId]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Delete ALL tracked keywords for a project
app.delete('/api/projects/:projectId/rank-tracking/keywords', async (req, res) => {
  try {
    await pool.query('DELETE FROM rank_tracking WHERE project_id=$1', [req.params.projectId]);
    await pool.query('DELETE FROM rank_keywords WHERE project_id=$1', [req.params.projectId]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Clean ALL maps data (keywords with location + their tracking records)
app.delete('/api/projects/:projectId/maps/clean', async (req, res) => {
  try {
    // Delete tracking records for maps keywords (those with a location)
    const trackDel = await pool.query(
      `DELETE FROM rank_tracking WHERE project_id=$1 AND location IS NOT NULL AND location != ''`,
      [req.params.projectId]
    );
    // Delete the maps keywords themselves
    const kwDel = await pool.query(
      `DELETE FROM rank_keywords WHERE project_id=$1 AND location IS NOT NULL AND location != ''`,
      [req.params.projectId]
    );
    console.log(`[maps-clean] Cleaned ${kwDel.rowCount} keywords + ${trackDel.rowCount} tracking records for project ${req.params.projectId}`);
    res.json({ ok: true, keywords_deleted: kwDel.rowCount, tracking_deleted: trackDel.rowCount });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// SERPapi-powered Maps/Local Pack sync
app.post('/api/projects/:projectId/maps/sync-serpapi', async (req, res) => {
  if (!SERPAPI_KEY) return res.status(503).json({ error: 'SERPAPI_KEY not configured. Add it to Railway env vars.' });
  const { projectId } = req.params;
  try {
    const projRes = await pool.query('SELECT * FROM projects WHERE id=$1', [projectId]);
    if (projRes.rows.length === 0) return res.status(404).json({ error: 'Project not found' });
    const project = projRes.rows[0];
    const businessName = project.business_name || project.name || '';

    // Get maps keywords (those with a location)
    const kwRes = await pool.query(
      `SELECT * FROM rank_keywords WHERE project_id=$1 AND location IS NOT NULL AND location != '' ORDER BY keyword`,
      [projectId]
    );
    if (kwRes.rows.length === 0) return res.status(400).json({ error: 'No maps keywords. Generate keywords first.' });

    console.log(`[maps-serpapi] Starting sync for ${kwRes.rows.length} keywords, business="${businessName}"`);

    // GPS coordinates for Perth suburbs — used for location-accurate local pack results
    const suburbGPS = {
      'leeming': { lat: -32.0728, lng: 115.8640 }, 'murdoch': { lat: -32.0660, lng: 115.8430 },
      'cannington': { lat: -32.0170, lng: 115.9340 }, 'east cannington': { lat: -32.0100, lng: 115.9500 },
      'ferndale': { lat: -32.0300, lng: 115.9500 }, 'lynwood': { lat: -32.0400, lng: 115.9300 },
      'parkwood': { lat: -32.0450, lng: 115.9150 }, 'queens park': { lat: -32.0050, lng: 115.9400 },
      'riverton': { lat: -32.0350, lng: 115.8940 }, 'rossmoyne': { lat: -32.0380, lng: 115.8700 },
      'shelley': { lat: -32.0280, lng: 115.8800 }, 'willetton': { lat: -32.0530, lng: 115.8890 },
      'wilson': { lat: -32.0230, lng: 115.9100 }, 'canning vale': { lat: -32.0580, lng: 115.9180 },
      'bentley': { lat: -32.0000, lng: 115.9200 }, 'welshpool': { lat: -31.9930, lng: 115.9450 },
      'atwell': { lat: -32.1440, lng: 115.8640 }, 'aubin grove': { lat: -32.1640, lng: 115.8660 },
      'bibra lake': { lat: -32.0930, lng: 115.8200 }, 'cockburn': { lat: -32.1300, lng: 115.8500 },
      'coogee': { lat: -32.1190, lng: 115.7650 }, 'coolbellup': { lat: -32.0830, lng: 115.8030 },
      'hamilton hill': { lat: -32.0820, lng: 115.7770 }, 'jandakot': { lat: -32.1050, lng: 115.8700 },
      'spearwood': { lat: -32.1050, lng: 115.7830 }, 'success': { lat: -32.1440, lng: 115.8490 },
      'banjup': { lat: -32.1290, lng: 115.8580 }, 'beeliar': { lat: -32.1350, lng: 115.8150 },
      'hammond park': { lat: -32.1620, lng: 115.8470 }, 'henderson': { lat: -32.1490, lng: 115.7730 },
      'lake coogee': { lat: -32.1280, lng: 115.7800 }, 'munster': { lat: -32.1310, lng: 115.7870 },
      'north coogee': { lat: -32.1100, lng: 115.7640 }, 'north lake': { lat: -32.0770, lng: 115.8330 },
      'south lake': { lat: -32.0870, lng: 115.8350 }, 'treeby': { lat: -32.1500, lng: 115.8630 },
      'wattleup': { lat: -32.1470, lng: 115.7990 }, 'yangebup': { lat: -32.1220, lng: 115.8140 }
    };

    // SERPapi helper — Google Search with GPS coordinates for accurate local pack
    async function serpApiSearch(keyword, suburb) {
      const query = suburb ? `${keyword} ${suburb}` : keyword;
      const gps = suburb ? suburbGPS[suburb.toLowerCase()] : null;
      const paramObj = {
        api_key: SERPAPI_KEY,
        engine: 'google',
        q: query,
        google_domain: 'google.com.au',
        gl: 'au',
        hl: 'en',
        num: 20
      };
      if (gps) {
        paramObj.lat = gps.lat;
        paramObj.lon = gps.lng;
      } else {
        paramObj.location = 'Perth, Western Australia, Australia';
      }
      const params = new URLSearchParams(paramObj);
      const resp = await fetch(`https://serpapi.com/search.json?${params}`);
      if (!resp.ok) {
        const text = await resp.text();
        throw new Error(`SERPapi error ${resp.status}: ${text.substring(0, 200)}`);
      }
      return resp.json();
    }

    // Process keywords in parallel (5 at a time)
    const results = [];
    const baseTime = Date.now();
    for (let i = 0; i < kwRes.rows.length; i += 5) {
      const batch = kwRes.rows.slice(i, i + 5);
      const promises = batch.map(async (kw, j) => {
        const idx = i + j;
        const query = `${kw.keyword} ${kw.location}`;
        try {
          const data = await serpApiSearch(kw.keyword, kw.location);
          if (idx === 0) console.log(`[maps-serpapi] Raw response keys for "${query}":`, Object.keys(data), 'local_results.places count:', (data.local_results?.places || []).length);

          // Extract local pack results — google engine returns local_results.places
          const localResults = data.local_results?.places || data.local_results || [];
          const localPack = Array.isArray(localResults) ? localResults : [];

          // Find our position in local pack
          let maps = { position: null, title: null, rating: null, reviews: null, address: null };
          const localPackTop3 = [];
          const nameLower = businessName.toLowerCase();
          const nameNoSpaces = nameLower.replace(/\s+/g, '');
          const nameWords = nameLower.split(/\s+/).filter(w => w.length > 2);

          for (let p = 0; p < localPack.length; p++) {
            const place = localPack[p];
            const titleLower = (place.title || '').toLowerCase();
            const titleNoSpaces = titleLower.replace(/\s+/g, '');
            const pos = place.position || (p + 1);

            // Match business
            const nameMatch = nameLower && (
              titleLower.includes(nameLower) || titleNoSpaces.includes(nameNoSpaces) ||
              (nameWords.length >= 2 && nameWords.every(w => titleLower.includes(w)))
            );

            if (nameMatch && !maps.position) {
              maps = { position: pos, title: place.title, rating: place.rating, reviews: place.reviews, address: place.address };
            }

            if (pos <= 3) {
              localPackTop3.push({ position: pos, title: place.title, rating: place.rating, reviews: place.reviews, source: 'local' });
            }
          }

          // Extract organic SERP position
          let serp = { position: null, url: null, title: null, snippet: null, type: null };
          const domain = (project.website || project.domain || '').replace(/^https?:\/\//, '').replace(/\/$/, '').replace(/^www\./, '').toLowerCase();
          for (const item of (data.organic_results || [])) {
            let itemHost = '';
            try { itemHost = new URL(item.link || '').hostname.replace(/^www\./, '').toLowerCase(); } catch (e) {
              itemHost = (item.link || '').replace(/^https?:\/\//, '').split('/')[0].replace(/^www\./, '').toLowerCase();
            }
            if (domain && (itemHost === domain || itemHost.endsWith('.' + domain))) {
              serp = { position: item.position, url: item.link, title: item.title, snippet: item.snippet, type: 'organic' };
              break;
            }
          }

          // Build competitors list (local pack top 3 minus our business)
          const kwCompetitors = localPackTop3.filter(t => {
            const tLower = (t.title || '').toLowerCase();
            const tNoSpaces = tLower.replace(/\s+/g, '');
            return !tLower.includes(nameLower) && !tNoSpaces.includes(nameNoSpaces);
          });

          // Save to DB
          await pool.query(
            `INSERT INTO rank_tracking (project_id, keyword, location, location_code, language_code, serp_position, serp_url, serp_title, serp_snippet, serp_type, maps_position, maps_title, maps_rating, maps_reviews, maps_address, competitors, checked_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
            [projectId, kw.keyword, kw.location || '', kw.location_code, kw.language_code,
             serp.position, serp.url, serp.title, serp.snippet, serp.type,
             maps.position, maps.title, maps.rating, maps.reviews, maps.address,
             JSON.stringify(kwCompetitors), new Date(baseTime + idx).toISOString()]
          );

          const result = { keyword: kw.keyword, location: kw.location, serp_position: serp.position, maps_position: maps.position, local_pack_top3: localPackTop3.map(t => t.title) };
          results[idx] = result;
          if (idx < 3) console.log(`[maps-serpapi] "${query}" → local_pack=${maps.position || '>20'}, top3: ${localPackTop3.map(t => t.title).join(', ')}`);
        } catch (err) {
          console.error(`[maps-serpapi] Error for "${query}":`, err.message);
          results[idx] = { keyword: kw.keyword, location: kw.location, error: err.message };
        }
      });
      await Promise.all(promises);
    }

    console.log(`[maps-serpapi] Done. Synced ${results.filter(r => r && !r.error).length}/${kwRes.rows.length} keywords.`);
    res.json({ ok: true, synced: results.filter(r => r && !r.error).length, total: kwRes.rows.length, results: results.filter(Boolean) });
  } catch (e) {
    console.error('[maps-serpapi] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Local Falcon sync — pulls scan reports into Maps tab
app.post('/api/projects/:projectId/maps/sync-localfalcon', async (req, res) => {
  if (!LOCAL_FALCON_KEY) return res.status(503).json({ error: 'LOCAL_FALCON_KEY not configured. Add it to Railway env vars.' });
  const { projectId } = req.params;
  try {
    const projRes = await pool.query('SELECT * FROM projects WHERE id=$1', [projectId]);
    if (projRes.rows.length === 0) return res.status(404).json({ error: 'Project not found' });
    const project = projRes.rows[0];
    const businessName = project.business_name || project.name || '';

    // Fetch all reports from Local Falcon
    const lfResp = await fetch(`https://api.localfalcon.com/v1/reports?api_key=${LOCAL_FALCON_KEY}`, {
      headers: { 'Accept': 'application/json' }
    });
    const lfData = await lfResp.json();
    if (!lfData.success) return res.status(400).json({ error: lfData.message || 'Local Falcon API error' });

    const reports = lfData.data?.reports || [];
    console.log(`[maps-localfalcon] Got ${reports.length} reports from Local Falcon`);

    // Filter reports for this business (match by place_id or name)
    const placeName = businessName.toLowerCase();
    const relevantReports = reports.filter(r => {
      const locName = (r.location?.name || '').toLowerCase();
      return locName.includes(placeName) || placeName.includes(locName);
    });

    if (relevantReports.length === 0) {
      // Try all reports if no name match (user might have only one location)
      if (reports.length > 0) {
        console.log(`[maps-localfalcon] No name match for "${businessName}", using all ${reports.length} reports`);
      } else {
        return res.status(400).json({ error: 'No scan reports found in Local Falcon. Run scans there first.' });
      }
    }

    const reportsToUse = relevantReports.length > 0 ? relevantReports : reports;
    const baseTime = Date.now();
    let synced = 0;

    for (let i = 0; i < reportsToUse.length; i++) {
      const report = reportsToUse[i];
      const keyword = report.keyword || '';
      const location = ''; // Local Falcon handles location via geo-grid

      // Extract keyword and location from keyword field (e.g. "plumber leeming" -> keyword="plumber", location="leeming")
      const parts = keyword.split(/\s+/);
      let kwBase = keyword;
      let kwLocation = '';
      if (parts.length >= 2) {
        kwBase = parts[0];
        kwLocation = parts.slice(1).join(' ');
      }

      // Ensure keyword exists in rank_keywords
      await pool.query(
        `INSERT INTO rank_keywords (project_id, keyword, location) VALUES ($1, $2, $3) ON CONFLICT (project_id, keyword, location) DO NOTHING`,
        [projectId, kwBase, kwLocation]
      );

      // Map Local Falcon data to our DB schema
      const arp = parseFloat(report.arp) || null;
      const atrp = parseFloat(report.atrp) || null;
      const solv = parseFloat(report.solv) || 0;
      const foundIn = parseInt(report.found_in) || 0;
      const dataPoints = parseInt(report.data_points) || 0;

      // maps_position = ARP (average rank position) — most useful metric
      const mapsPosition = arp && arp <= 20 ? Math.round(arp) : null;

      // Store competitors as metadata with Local Falcon metrics
      const lfMetrics = {
        arp, atrp, solv, found_in: foundIn, data_points: dataPoints,
        heatmap: report.heatmap || null,
        report_key: report.report_key || null,
        source: 'local_falcon'
      };

      await pool.query(
        `INSERT INTO rank_tracking (project_id, keyword, location, serp_position, maps_position, maps_title, competitors, checked_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [projectId, kwBase, kwLocation, null, mapsPosition, businessName,
         JSON.stringify([lfMetrics]), new Date(baseTime + i).toISOString()]
      );

      synced++;
    }

    // Reload keywords
    const { rows: allKw } = await pool.query('SELECT * FROM rank_keywords WHERE project_id=$1 ORDER BY keyword', [projectId]);

    console.log(`[maps-localfalcon] Done. Synced ${synced} reports.`);
    res.json({ ok: true, synced, total: reportsToUse.length, keywords: allKw });
  } catch (e) {
    console.error('[maps-localfalcon] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Get tracked keywords
app.get('/api/projects/:projectId/rank-tracking/keywords', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM rank_keywords WHERE project_id=$1 ORDER BY keyword', [req.params.projectId]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Sync ranks — calls DataForSEO for all tracked keywords
app.post('/api/projects/:projectId/rank-tracking/sync', async (req, res) => {
  if (!SERPAPI_KEY) return res.status(503).json({ error: 'SERPAPI_KEY not configured. Add it to Railway env vars.' });
  const { projectId } = req.params;
  try {
    const projRes = await pool.query('SELECT * FROM projects WHERE id=$1', [projectId]);
    if (projRes.rows.length === 0) return res.status(404).json({ error: 'Project not found' });
    const project = projRes.rows[0];
    const domain = (project.website || project.domain || '').replace(/^https?:\/\//, '').replace(/\/$/, '').replace(/^www\./, '');
    const businessName = project.business_name || project.name || domain;

    const kwRes = await pool.query('SELECT * FROM rank_keywords WHERE project_id=$1', [projectId]);
    if (kwRes.rows.length === 0) return res.status(400).json({ error: 'No keywords to track. Add keywords first.' });

    console.log(`[rank-sync] Starting SerpAPI sync for ${kwRes.rows.length} keywords, domain="${domain}", businessName="${businessName}"`);

    // GPS coordinates for Perth suburbs
    const suburbGPS = {
      'leeming': { lat: -32.0728, lng: 115.8640 }, 'cannington': { lat: -32.0170, lng: 115.9340 },
      'east cannington': { lat: -32.0100, lng: 115.9500 }, 'ferndale': { lat: -32.0300, lng: 115.9500 },
      'lynwood': { lat: -32.0400, lng: 115.9300 }, 'parkwood': { lat: -32.0450, lng: 115.9150 },
      'queens park': { lat: -32.0050, lng: 115.9400 }, 'riverton': { lat: -32.0350, lng: 115.8940 },
      'rossmoyne': { lat: -32.0380, lng: 115.8700 }, 'shelley': { lat: -32.0280, lng: 115.8800 },
      'willetton': { lat: -32.0530, lng: 115.8890 }, 'wilson': { lat: -32.0230, lng: 115.9100 },
      'canning vale': { lat: -32.0580, lng: 115.9180 }, 'bentley': { lat: -32.0000, lng: 115.9200 },
      'welshpool': { lat: -31.9930, lng: 115.9450 }, 'atwell': { lat: -32.1440, lng: 115.8640 },
      'aubin grove': { lat: -32.1640, lng: 115.8660 }, 'banjup': { lat: -32.1290, lng: 115.8580 },
      'beeliar': { lat: -32.1350, lng: 115.8150 }, 'bibra lake': { lat: -32.0930, lng: 115.8200 },
      'cockburn': { lat: -32.1300, lng: 115.8500 }, 'coogee': { lat: -32.1190, lng: 115.7650 },
      'coolbellup': { lat: -32.0830, lng: 115.8030 }, 'hamilton hill': { lat: -32.0820, lng: 115.7770 },
      'hammond park': { lat: -32.1620, lng: 115.8470 }, 'henderson': { lat: -32.1490, lng: 115.7730 },
      'jandakot': { lat: -32.1050, lng: 115.8700 }, 'lake coogee': { lat: -32.1280, lng: 115.7800 },
      'munster': { lat: -32.1310, lng: 115.7870 }, 'north coogee': { lat: -32.1100, lng: 115.7640 },
      'north lake': { lat: -32.0770, lng: 115.8330 }, 'south lake': { lat: -32.0870, lng: 115.8350 },
      'spearwood': { lat: -32.1050, lng: 115.7830 }, 'success': { lat: -32.1440, lng: 115.8490 },
      'treeby': { lat: -32.1500, lng: 115.8630 }, 'wattleup': { lat: -32.1470, lng: 115.7990 },
      'yangebup': { lat: -32.1220, lng: 115.8140 }, 'murdoch': { lat: -32.0660, lng: 115.8430 }
    };

    const results = [];
    const competitors = project.competitors || [];
    const competitorDomains = competitors.map(c => (c.domain || c).replace(/^https?:\/\//, '').replace(/\/$/, '').replace(/^www\./, '').toLowerCase());
    const baseTime = Date.now();

    // Process keywords in parallel (5 at a time) via SerpAPI
    for (let i = 0; i < kwRes.rows.length; i += 5) {
      const batch = kwRes.rows.slice(i, i + 5);
      const promises = batch.map(async (kw, j) => {
        const idx = i + j;
        const query = kw.location ? `${kw.keyword} ${kw.location}` : kw.keyword;
        try {
          // Build SerpAPI params
          const paramObj = {
            engine: 'google',
            q: query,
            google_domain: 'google.com.au',
            gl: 'au',
            hl: 'en',
            num: 30
          };
          // Use GPS coords for suburb-level accuracy
          const gps = kw.location ? suburbGPS[kw.location.toLowerCase()] : null;
          if (gps) {
            paramObj.lat = gps.lat;
            paramObj.lon = gps.lng;
          } else {
            paramObj.location = 'Perth, Western Australia, Australia';
          }

          const data = await serpApiSearch(paramObj);
          if (idx === 0) console.log(`[rank-sync] First keyword "${query}" response keys:`, Object.keys(data));

          // Parse organic results
          let serp = { position: null, url: null, title: null, snippet: null, type: null };
          let kwCompetitors = [];
          const domainLower = domain.toLowerCase();
          if (idx < 3) console.log(`[rank-sync] "${query}" matching domain: "${domainLower}", organic_results: ${(data.organic_results || []).length}`);
          for (const item of (data.organic_results || [])) {
            const pos = item.position;

            // Use item.link (actual URL) for domain matching — NOT displayed_link which has Google's display format
            let itemHost = '';
            try {
              itemHost = new URL(item.link || '').hostname.replace(/^www\./, '').toLowerCase();
            } catch (e) {
              itemHost = (item.link || '').replace(/^https?:\/\//, '').split('/')[0].replace(/^www\./, '').toLowerCase();
            }
            if (idx < 3 && pos <= 5) console.log(`[rank-sync]   #${pos} itemHost="${itemHost}" link="${(item.link || '').slice(0, 60)}" vs domain="${domainLower}" match=${itemHost === domainLower}`);
            if (domainLower && (itemHost === domainLower || itemHost === 'www.' + domainLower || itemHost.endsWith('.' + domainLower))) {
              if (!serp.position) {
                serp = { position: pos, url: item.link, title: item.title, snippet: item.snippet, type: 'organic' };
              }
            } else {
              if (kwCompetitors.filter(c => c.source === 'serp').length < 3) {
                kwCompetitors.push({ domain: itemHost, position: pos, url: item.link, title: item.title, source: 'serp' });
              }
            }
            // Named competitors — strict host match
            for (const cd of competitorDomains) {
              if ((itemHost === cd || itemHost === 'www.' + cd || itemHost.endsWith('.' + cd)) && !kwCompetitors.find(c => c.domain === itemHost && c.source === 'serp')) {
                kwCompetitors.push({ domain: itemHost, position: pos, url: item.link, title: item.title, source: 'serp' });
              }
            }
          }

          // Parse local pack
          let maps = { position: null, title: null, rating: null, reviews: null, address: null };
          const localPackTop3 = [];
          const localResults = data.local_results?.places || data.local_results || [];
          const localPack = Array.isArray(localResults) ? localResults : [];
          const nameLower = businessName.toLowerCase();
          const nameNoSpaces = nameLower.replace(/\s+/g, '');
          const nameWords = nameLower.split(/\s+/).filter(w => w.length > 2);

          for (let p = 0; p < localPack.length; p++) {
            const place = localPack[p];
            const titleLower = (place.title || '').toLowerCase();
            const titleNoSpaces = titleLower.replace(/\s+/g, '');
            const pos = place.position || (p + 1);
            const placeDomain = (place.links?.website || '').replace(/^https?:\/\//, '').replace(/\/$/, '').replace(/^www\./, '').toLowerCase();

            const nameMatch = nameLower && (
              titleLower.includes(nameLower) || titleNoSpaces.includes(nameNoSpaces) ||
              (nameWords.length >= 2 && nameWords.every(w => titleLower.includes(w)))
            );
            const domainMatch = domain && placeDomain && (placeDomain.includes(domain.toLowerCase()) || domain.toLowerCase().includes(placeDomain));

            if ((nameMatch || domainMatch) && !maps.position) {
              maps = { position: pos, title: place.title, rating: place.rating, reviews: place.reviews, address: place.address };
            }
            if (pos <= 3) {
              localPackTop3.push({ position: pos, title: place.title, rating: place.rating, reviews: place.reviews, source: 'local' });
            }
          }

          // Add local pack competitors (excluding our business)
          if (localPackTop3.length > 0) {
            const filtered = localPackTop3.filter(t => {
              const tLower = (t.title || '').toLowerCase();
              const tNoSpaces = tLower.replace(/\s+/g, '');
              return !tLower.includes(nameLower) && !tNoSpaces.includes(nameNoSpaces);
            });
            kwCompetitors = [...filtered, ...kwCompetitors];
          }

          // Extract search volume from search_information if available
          const searchInfo = data.search_information || {};

          // Save to DB
          await pool.query(
            `INSERT INTO rank_tracking (project_id, keyword, location, location_code, language_code, serp_position, serp_url, serp_title, serp_snippet, serp_type, maps_position, maps_title, maps_rating, maps_reviews, maps_address, competitors, checked_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
            [projectId, kw.keyword, kw.location || '', kw.location_code, kw.language_code,
             serp.position, serp.url, serp.title, serp.snippet, serp.type,
             maps.position, maps.title, maps.rating, maps.reviews, maps.address,
             JSON.stringify(kwCompetitors), new Date(baseTime + idx).toISOString()]
          );

          if (idx < 3) console.log(`[rank-sync] "${query}" → serp=${serp.position || '>30'}, maps=${maps.position || 'N/A'}`);
          results[idx] = { keyword: kw.keyword, location: kw.location, serp_position: serp.position, maps_position: maps.position, local_pack_top3: localPackTop3.map(t => t.title), competitors: kwCompetitors.length };
        } catch (err) {
          console.error(`[rank-sync] Error for "${query}":`, err.message);
          results[idx] = { keyword: kw.keyword, location: kw.location, error: err.message };
        }
      });
      await Promise.all(promises);
    }

    // Search volume via SerpAPI — use google_trends or keyword info if available
    // SerpAPI doesn't have a bulk volume endpoint like DataForSEO, so we skip bulk volume fetch
    // Volume data can be populated via GSC import or manual CSV upload instead

    const synced = results.filter(r => r && !r.error).length;
    console.log(`[rank-sync] Done. Synced ${synced}/${kwRes.rows.length} keywords.`);
    res.json({ ok: true, synced, results: results.filter(Boolean) });
  } catch (e) {
    console.error('[rank-sync] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Get latest rankings for a project
app.get('/api/projects/:projectId/rank-tracking/latest', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT DISTINCT ON (rt.keyword, rt.location) rt.keyword, rt.location, rt.serp_position, rt.serp_url, rt.maps_position, rt.maps_title, rt.maps_rating, rt.maps_reviews, rt.competitors, rt.checked_at,
             g.position AS gsc_position, g.clicks AS gsc_clicks, g.impressions AS gsc_impressions, g.ctr AS gsc_ctr
      FROM rank_tracking rt
      LEFT JOIN gsc_keywords g ON g.project_id = rt.project_id AND LOWER(g.keyword) = LOWER(rt.keyword)
      WHERE rt.project_id=$1
      ORDER BY rt.keyword, rt.location, rt.checked_at DESC
    `, [req.params.projectId]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Get rank history for a keyword (for charts)
app.get('/api/projects/:projectId/rank-tracking/history', async (req, res) => {
  const { keyword, days } = req.query;
  try {
    const { rows } = await pool.query(`
      SELECT keyword, serp_position, maps_position, competitors, checked_at
      FROM rank_tracking WHERE project_id=$1 ${keyword ? 'AND keyword=$2' : ''}
      AND checked_at > NOW() - INTERVAL '${parseInt(days) || 30} days'
      ORDER BY checked_at ASC
    `, keyword ? [req.params.projectId, keyword] : [req.params.projectId]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Import keywords from GSC into rank tracking
app.post('/api/projects/:projectId/rank-tracking/import', async (req, res) => {
  const { projectId } = req.params;
  const { limit: maxKw } = req.body;
  try {
    let keywords = new Set();

    // Import from GSC
    try {
      const gscRes = await pool.query(
        `SELECT keyword FROM gsc_keywords WHERE project_id=$1 AND keyword IS NOT NULL ORDER BY impressions DESC LIMIT $2`,
        [projectId, maxKw || 50]
      );
      gscRes.rows.forEach(r => keywords.add(r.keyword.toLowerCase()));
    } catch (e) { console.log('gsc_keywords table error, skipping:', e.message); }

    if (keywords.size === 0) {
      return res.json({ error: 'No keywords found. Connect Google Search Console first to import keywords.' });
    }

    let added = 0;
    for (const kw of keywords) {
      const r = await pool.query(
        `INSERT INTO rank_keywords (project_id, keyword, location) VALUES ($1, $2, $3) ON CONFLICT (project_id, keyword, location) DO NOTHING RETURNING id`,
        [projectId, kw, '']
      );
      if (r.rows.length > 0) added++;
    }

    const { rows } = await pool.query('SELECT * FROM rank_keywords WHERE project_id=$1 ORDER BY keyword', [projectId]);
    res.json({ ok: true, imported: added, total: rows.length, keywords: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Discover keywords a domain ranks for via SerpAPI (site: search)
app.post('/api/projects/:projectId/rank-tracking/discover', async (req, res) => {
  if (!SERPAPI_KEY) return res.status(503).json({ error: 'SERPAPI_KEY not configured' });
  const { projectId } = req.params;
  const limit = parseInt(req.body.limit) || 50; // Default 50, accepts 10/20/30/40/50
  try {
    const projRes = await pool.query('SELECT * FROM projects WHERE id=$1', [projectId]);
    if (projRes.rows.length === 0) return res.status(404).json({ error: 'Project not found' });
    const project = projRes.rows[0];
    const domain = (project.website || project.domain || '').replace(/^https?:\/\//, '').replace(/\/$/, '').replace(/^www\./, '');

    if (!domain) return res.status(400).json({ error: 'Project has no website/domain configured' });

    console.log(`[discover] Fetching ranked keywords for ${domain} via SerpAPI (limit: ${limit})`);

    // Use Google organic search with site: to find pages that rank, then extract keywords
    // Also check GSC data first as a primary keyword source
    const keywords = [];
    const seen = new Set();

    // 1. Pull from GSC if available
    try {
      const gscRes = await pool.query(
        `SELECT keyword, position, clicks, impressions FROM gsc_keywords WHERE project_id=$1 AND keyword IS NOT NULL ORDER BY impressions DESC LIMIT $2`,
        [projectId, limit * 4]
      );
      for (const r of gscRes.rows) {
        const kw = r.keyword.toLowerCase().trim();
        if (kw && !seen.has(kw)) {
          seen.add(kw);
          keywords.push({ keyword: r.keyword, volume: r.impressions || null, position: Math.round(r.position) || null, url: null, competition: null, source: 'gsc', clicks: r.clicks, impressions: r.impressions });
        }
      }
      console.log(`[discover] Found ${keywords.length} keywords from GSC`);
    } catch (e) { console.log('[discover] GSC lookup skipped:', e.message); }

    // 2. Use SerpAPI to search for the domain and extract related keywords from SERP features
    const searchQueries = [`site:${domain}`, domain];
    for (const q of searchQueries) {
      try {
        const data = await serpApiSearch({
          engine: 'google',
          q: q,
          google_domain: 'google.com.au',
          gl: 'au',
          hl: 'en',
          num: 100
        });

        // Extract related searches as keyword suggestions
        for (const rs of (data.related_searches || [])) {
          const kw = (rs.query || '').toLowerCase().trim();
          if (kw && !seen.has(kw)) {
            seen.add(kw);
            keywords.push({ keyword: rs.query, volume: null, position: null, url: null, competition: null, source: 'related' });
          }
        }

        // Extract "people also ask" as keyword ideas
        for (const paa of (data.related_questions || [])) {
          const kw = (paa.question || '').toLowerCase().trim();
          if (kw && !seen.has(kw)) {
            seen.add(kw);
            keywords.push({ keyword: paa.question, volume: null, position: null, url: null, competition: null, source: 'paa' });
          }
        }

        // Extract organic result URLs that belong to this domain
        for (const item of (data.organic_results || [])) {
          const itemDomain = (item.displayed_link || item.link || '').replace(/^https?:\/\//, '').replace(/\/$/, '').replace(/^www\./, '').toLowerCase();
          if (itemDomain.includes(domain.toLowerCase())) {
            // The title often contains the primary keyword for this page
            const title = (item.title || '').toLowerCase().replace(/\s*[-|–—].*$/, '').trim();
            if (title && title.length > 3 && title.length < 80 && !seen.has(title)) {
              seen.add(title);
              keywords.push({ keyword: item.title.replace(/\s*[-|–—].*$/, '').trim(), volume: null, position: item.position, url: item.link, competition: null, source: 'serp' });
            }
          }
        }
      } catch (e) {
        console.log(`[discover] SerpAPI query "${q}" failed:`, e.message);
      }
    }

    // Sort by relevance: GSC keywords with impressions first, then by position
    keywords.sort((a, b) => {
      if (a.source === 'gsc' && b.source !== 'gsc') return -1;
      if (b.source === 'gsc' && a.source !== 'gsc') return 1;
      if (a.impressions && b.impressions) return b.impressions - a.impressions;
      if (a.position && b.position) return a.position - b.position;
      return 0;
    });

    const capped = keywords.slice(0, limit);
    console.log(`[discover] Found ${keywords.length} total, returning top ${capped.length} (limit: ${limit}) for ${domain}`);

    // Fetch search volume from DataForSEO Keywords Data API
    if (DATAFORSEO_AUTH && capped.length > 0) {
      try {
        console.log(`[discover] Fetching search volume for ${capped.length} keywords via DataForSEO`);
        const dfsBody = [{
          keywords: capped.map(k => k.keyword),
          location_name: 'Australia',
          language_name: 'English',
        }];
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 15000);
        const dfsRes = await fetch('https://api.dataforseo.com/v3/keywords_data/google_ads/search_volume/live', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': DATAFORSEO_AUTH },
          body: JSON.stringify(dfsBody),
          signal: controller.signal,
        });
        clearTimeout(timeout);
        const dfsText = await dfsRes.text();
        console.log(`[discover] DataForSEO HTTP ${dfsRes.status}, body length: ${dfsText.length}`);
        console.log(`[discover] DataForSEO raw (first 500): ${dfsText.slice(0, 500)}`);
        const dfsData = JSON.parse(dfsText);
        const task = dfsData.tasks?.[0];
        if (task?.result) {
          const volMap = {};
          for (const r of task.result) {
            if (r.keyword && r.search_volume != null) {
              volMap[r.keyword.toLowerCase()] = r.search_volume;
            }
          }
          for (const kw of capped) {
            const vol = volMap[kw.keyword.toLowerCase()];
            if (vol != null) kw.volume = vol;
          }
          console.log(`[discover] Got volume for ${Object.keys(volMap).length}/${capped.length} keywords`);
        } else {
          console.log(`[discover] DataForSEO no results. Status: ${task?.status_code} ${task?.status_message}`);
        }
      } catch (e) {
        console.log(`[discover] DataForSEO volume lookup failed: ${e.name}: ${e.message}`);
      }
    }

    res.json({ ok: true, keywords: capped, total: keywords.length, limit });
  } catch (e) {
    console.error('[discover] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ==================== 12. MONTHLY REPORTS ====================

// List reports for a project
app.get('/api/projects/:projectId/reports', async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM monthly_reports WHERE project_id=$1 ORDER BY month DESC', [req.params.projectId]);
    const reports = r.rows.map(row => {
      const data = typeof row.report_data === 'string' ? JSON.parse(row.report_data) : (row.report_data || {});
      return { id: row.id, month: row.month, createdAt: row.created_at, ...data };
    });
    res.json({ reports });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Generate monthly report
app.post('/api/projects/:projectId/reports/generate', async (req, res) => {
  const { projectId } = req.params;
  try {
    const proj = await pool.query('SELECT * FROM projects WHERE id=$1', [projectId]);
    if (proj.rows.length === 0) return res.status(404).json({ error: 'Project not found' });
    const project = proj.rows[0];

    const now = new Date();
    const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const monthLabel = now.toLocaleDateString('en-AU', { year: 'numeric', month: 'long' });

    // 1. Rankings summary — avg SERP position, top 3 count, keywords tracked
    const rankRes = await pool.query(
      `SELECT keyword, serp_position, maps_position FROM rank_tracking
       WHERE project_id=$1 AND checked_at >= NOW() - INTERVAL '30 days'
       ORDER BY checked_at DESC`,
      [projectId]
    );
    const latestByKw = {};
    for (const r of rankRes.rows) {
      if (!latestByKw[r.keyword]) latestByKw[r.keyword] = r;
    }
    const rankEntries = Object.values(latestByKw);
    const serpPositions = rankEntries.filter(r => r.serp_position).map(r => r.serp_position);
    const mapsPositions = rankEntries.filter(r => r.maps_position).map(r => r.maps_position);
    const avgSerp = serpPositions.length > 0 ? serpPositions.reduce((a, b) => a + b, 0) / serpPositions.length : null;
    const avgMaps = mapsPositions.length > 0 ? mapsPositions.reduce((a, b) => a + b, 0) / mapsPositions.length : null;
    const serpTop3 = serpPositions.filter(p => p <= 3).length;
    const serpTop10 = serpPositions.filter(p => p <= 10).length;
    const mapsTop3 = mapsPositions.filter(p => p <= 3).length;

    const rankingsSummary = {
      avgPosition: avgSerp,
      avgMapsPosition: avgMaps,
      keywordsTracked: rankEntries.length,
      serpTop3,
      serpTop10,
      mapsTop3,
      serpPositions: serpPositions.length,
      mapsPositions: mapsPositions.length
    };

    // 2. GSC trends — total clicks, impressions, avg CTR, avg position
    const gscRes = await pool.query(
      'SELECT keyword, clicks, impressions, ctr, position FROM gsc_keywords WHERE project_id=$1',
      [projectId]
    );
    const totalClicks = gscRes.rows.reduce((s, r) => s + (r.clicks || 0), 0);
    const totalImpressions = gscRes.rows.reduce((s, r) => s + (r.impressions || 0), 0);
    const avgCtr = totalImpressions > 0 ? (totalClicks / totalImpressions * 100) : 0;
    const avgGscPos = gscRes.rows.length > 0 ? gscRes.rows.reduce((s, r) => s + (r.position || 0), 0) / gscRes.rows.length : null;

    const gscTrends = {
      clicks: totalClicks,
      impressions: totalImpressions,
      ctr: avgCtr,
      avgPosition: avgGscPos,
      keywordsWithClicks: gscRes.rows.filter(r => r.clicks > 0).length,
      totalKeywords: gscRes.rows.length
    };

    // 3. Audit findings summary
    const findingsRes = await pool.query(
      `SELECT pillar, severity, status, COUNT(*) as cnt FROM audit_findings WHERE project_id=$1 GROUP BY pillar, severity, status`,
      [projectId]
    );
    const findingsByPillar = {};
    for (const r of findingsRes.rows) {
      if (!findingsByPillar[r.pillar]) findingsByPillar[r.pillar] = { total: 0, critical: 0, approved: 0, new: 0 };
      const cnt = parseInt(r.cnt);
      findingsByPillar[r.pillar].total += cnt;
      if (r.severity === 'Critical') findingsByPillar[r.pillar].critical += cnt;
      if (r.status === 'approved') findingsByPillar[r.pillar].approved += cnt;
      if (r.status === 'new') findingsByPillar[r.pillar].new += cnt;
    }

    // 4. Action items summary
    const actionsRes = await pool.query(
      `SELECT status, COUNT(*) as cnt FROM action_items WHERE project_id=$1 GROUP BY status`,
      [projectId]
    );
    const actionsByStatus = {};
    for (const r of actionsRes.rows) actionsByStatus[r.status] = parseInt(r.cnt);
    const actionsCompleted = actionsByStatus['done'] || 0;
    const actionsPending = actionsByStatus['pending'] || 0;
    const actionsInProgress = actionsByStatus['in-progress'] || 0;

    // 5. Generate recommendations
    const recommendations = [];
    if (avgSerp && avgSerp > 15) recommendations.push(`Average SERP position is ${avgSerp.toFixed(1)} — focus on optimizing pages ranking 10-20 to push them onto page 1.`);
    if (serpTop3 === 0 && serpPositions.length > 0) recommendations.push('No keywords in top 3 yet. Prioritize content optimization and link building for your closest keywords.');
    if (avgCtr < 2 && totalImpressions > 100) recommendations.push(`Average CTR is only ${avgCtr.toFixed(1)}%. Rewrite meta titles and descriptions to be more compelling.`);
    if (findingsByPillar.gsc?.new > 5) recommendations.push(`${findingsByPillar.gsc.new} GSC audit findings still unactioned. Review and approve them in the Audit section.`);
    if (findingsByPillar.gbp?.new > 3) recommendations.push(`${findingsByPillar.gbp.new} GBP audit findings need attention. GBP optimization directly impacts local pack rankings.`);
    if (actionsPending > 5) recommendations.push(`${actionsPending} action items are pending. Schedule time to work through the Action Plan.`);
    if (mapsTop3 < mapsPositions.length * 0.5 && mapsPositions.length > 0) recommendations.push('Less than half your keywords are in Maps top 3. Focus on reviews, GBP posts, and NAP consistency.');
    if (recommendations.length === 0) recommendations.push('Keep monitoring rankings and running audits regularly. Consistency is key to SEO success.');

    const reportData = {
      monthLabel,
      project: { name: project.name, domain: project.domain },
      rankingsSummary,
      gscTrends,
      findingsByPillar,
      actionsCompleted,
      actionsPending,
      actionsInProgress,
      recommendations,
      generatedAt: now.toISOString()
    };

    // Upsert report
    const r = await pool.query(
      `INSERT INTO monthly_reports (project_id, month, report_data) VALUES ($1, $2, $3)
       ON CONFLICT (project_id, month) DO UPDATE SET report_data=$3, created_at=NOW() RETURNING *`,
      [projectId, month, JSON.stringify(reportData)]
    );

    console.log(`[reports] Generated ${month} report for project ${projectId}`);
    res.json({ report: { id: r.rows[0].id, month, createdAt: r.rows[0].created_at, ...reportData } });
  } catch (e) {
    console.error('[reports] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ==================== 13. SERVE ====================

// Health check
app.get('/api/health', (req, res) => res.json({ ok: true }));

// Static files
app.use(express.static(path.join(__dirname, 'public'), { maxAge: 0, etag: false }));

// Serve index.html for all other routes (SPA fallback)
app.get('*', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.type('html').send(INDEX_HTML);
});

// ==================== 13. STARTUP ====================

async function start() {
  try {
    await initDb();
    app.listen(PORT, () => {
      console.log(`[boot] SEO Room v5 listening on port ${PORT}`);
    });
  } catch (e) {
    console.error('[boot] Startup failed:', e.message);
    process.exit(1);
  }
}

start();
