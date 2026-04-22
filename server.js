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
// Legacy — kept for reference but no longer used
// const DATAFORSEO_LOGIN = process.env.DATAFORSEO_LOGIN;
// const DATAFORSEO_PASSWORD = process.env.DATAFORSEO_PASSWORD;
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

    // Add columns for existing databases
    await client.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS is_elementor_site BOOLEAN DEFAULT true`);
    await client.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS wordpress_url TEXT`);
    await client.query(`ALTER TABLE gsc_keywords ADD COLUMN IF NOT EXISTS prev_position DOUBLE PRECISION`).catch(() => {});

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
  try {
    const result = await pool.query(
      `UPDATE projects
       SET name=COALESCE($2, name), domain=COALESCE($3, domain), business_name=COALESCE($4, business_name),
           industry=COALESCE($5, industry), location=COALESCE($6, location),
           competitors=COALESCE($7::text[], competitors),
           is_local_business=COALESCE($8, is_local_business), is_elementor_site=COALESCE($9, is_elementor_site),
           wordpress_url=COALESCE($10, wordpress_url),
           service_areas=COALESCE($11::jsonb, service_areas)
       WHERE id=$1
       RETURNING *`,
      [req.params.id, name, domain, business_name, industry, location,
       competitors && Array.isArray(competitors) ? competitors : null,
       is_local_business, is_elementor_site, wordpress_url,
       service_areas ? JSON.stringify(service_areas) : null]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Project not found' });
    res.json({ project: result.rows[0] });
  } catch (e) {
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

// Get action items for a project
app.get('/api/projects/:id/action-items', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM action_items WHERE project_id=$1 ORDER BY created_at DESC',
      [req.params.id]
    );
    res.json({ action_items: result.rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Update action item (approve/skip/mark done)
app.put('/api/action-items/:id', async (req, res) => {
  const { status, approved_at } = req.body;
  try {
    const result = await pool.query(
      `UPDATE action_items
       SET status=$1, approved_at=COALESCE($2, approved_at)
       WHERE id=$3 RETURNING *`,
      [status, approved_at || null, req.params.id]
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


// ==================== SERPAPI HELPER ====================

async function serpApiSearch(params) {
  if (!SERPAPI_KEY) throw new Error('SERPAPI_KEY not configured');
  const searchParams = new URLSearchParams({ ...params, api_key: SERPAPI_KEY });
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
async function discoverPages(projectUrl, wpUrl) {
  const pages = [];
  const baseUrl = projectUrl.replace(/\/$/, '');

  // Try sitemap.xml first
  try {
    const sitemapResp = await fetch(`${baseUrl}/sitemap.xml`, { headers: { 'User-Agent': 'SEORoomBot/1.0' } });
    if (sitemapResp.ok) {
      const xml = await sitemapResp.text();
      const urlMatches = xml.match(/<loc>([^<]+)<\/loc>/g) || [];
      for (const match of urlMatches.slice(0, 10)) {
        const url = match.replace(/<\/?loc>/g, '');
        if (url.endsWith('.xml') || url.endsWith('.pdf') || url.match(/\.(jpg|png|gif|svg)$/i)) continue;
        const slug = url.replace(baseUrl, '').replace(/^\/|\/$/g, '') || 'home';
        pages.push({ page_id: slug, title: slug === 'home' ? 'Homepage' : slug.replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase()), slug, url });
      }
    }
  } catch (e) { /* sitemap not available */ }

  // Try WP REST API if available and no sitemap pages
  if (pages.length === 0 && wpUrl) {
    try {
      const wpPages = await wpFetch(wpUrl, 'wp/v2/pages?per_page=10&status=publish&_fields=id,title,slug,link');
      for (const p of wpPages) {
        pages.push({ page_id: String(p.id), title: p.title.rendered, slug: p.slug, url: p.link });
      }
    } catch (e) { /* WP API not available */ }
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

    const pages = await discoverPages(siteUrl, project.wordpress_url);

    const results = [];
    for (const page of pages) {
      try {
        const psData = await runPageSpeedAudit(page.url, 'mobile');
        const images = extractImageIssues(psData);
        const totalIssues = images.reduce((sum, img) => sum + img.issues.length, 0);
        const metrics = psData.lighthouseResult?.audits || {};
        const score = Math.round((psData.lighthouseResult?.categories?.performance?.score || 0) * 100);

        results.push({
          page_id: page.page_id,
          title: page.title,
          slug: page.slug,
          url: page.url,
          image_count: images.length,
          images,
          total_issues: totalIssues,
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
        });
      } catch (err) {
        results.push({
          page_id: page.page_id, title: page.title, slug: page.slug, url: page.url,
          error: err.message, image_count: 0, images: [], total_issues: 0,
        });
      }
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
      total_images: results.reduce((sum, r) => sum + (r.image_count || 0), 0),
      total_issues: results.reduce((sum, r) => sum + (r.total_issues || 0), 0),
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
        signal: AbortSignal.timeout(30000)
      });
      if (yoastResp.ok) {
        const scores = await yoastResp.json();
        for (const s of scores) { yoastMap[s.id] = s; }
        console.log(`[onpage-audit] Got Yoast scores for ${scores.length} pages via plugin`);
      }
    } catch (e) {
      console.log(`[onpage-audit] seoroom plugin not available: ${e.message}`);
    }

    // 2. Fetch all published pages from WP REST API
    let allPages = [];
    let page = 1;
    while (true) {
      try {
        const resp = await fetch(`${wpBase}/wp-json/wp/v2/pages?per_page=50&page=${page}&status=publish`, {
          signal: AbortSignal.timeout(30000)
        });
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
        const resp = await fetch(`${wpBase}/wp-json/wp/v2/posts?per_page=50&page=${page}&status=publish`, {
          signal: AbortSignal.timeout(30000)
        });
        if (!resp.ok) break;
        const posts = await resp.json();
        if (!Array.isArray(posts) || posts.length === 0) break;
        allPages = allPages.concat(posts);
        if (posts.length < 50) break;
        page++;
      } catch { break; }
    }

    console.log(`[onpage-audit] Fetched ${allPages.length} pages/posts`);
    if (allPages.length === 0) return res.json({ pages: [], message: 'No published pages found' });

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

      // Readability score
      let yoastReadability = 'gray';
      if (pluginData?.readability_score) {
        const rs = pluginData.readability_score;
        yoastReadability = rs >= 70 ? 'green' : rs >= 40 ? 'orange' : 'red';
      } else {
        yoastReadability = wordCount >= 800 ? 'green' : wordCount >= 300 ? 'orange' : 'red';
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
        yoastReadability,
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
    const accessToken = await getGscAccessToken(req.auth?.userId);

    if (accessToken) {
      // Find matching GSC site
      const sites = await fetch('https://www.googleapis.com/webmasters/v3/sites', {
        headers: { Authorization: `Bearer ${accessToken}` }
      }).then(r => r.json());
      const available = (sites.siteEntry || []).map(s => s.siteUrl);
      let matchedSite = available.find(s => s.includes(domain.replace(/^www\./, '')));
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

// ==================== GBP AUDIT ====================

app.post('/api/projects/:projectId/audits/gbp/run', async (req, res) => {
  const { projectId } = req.params;
  try {
    const proj = await pool.query('SELECT * FROM projects WHERE id=$1', [projectId]);
    if (proj.rows.length === 0) return res.status(404).json({ error: 'Project not found' });
    const project = proj.rows[0];

    // Clean up old unactioned findings from previous runs
    await pool.query(`DELETE FROM audit_findings WHERE project_id=$1 AND pillar='gbp' AND status='new'`, [projectId]);

    // Create audit record
    const auditRes = await pool.query(
      `INSERT INTO audits (project_id, pillar, status, started_at) VALUES ($1, 'gbp', 'running', NOW()) RETURNING id`,
      [projectId]
    );
    const auditId = auditRes.rows[0].id;

    const findings = [];
    const config = project.config && typeof project.config === 'string' ? JSON.parse(project.config) : (project.config || {});

    // Check GBP integration status (user-level)
    const gbpInt = await pool.query('SELECT * FROM user_integrations WHERE user_id=$1 AND kind=$2', [req.auth?.userId, 'gbp']);
    const gbpConnected = gbpInt.rows.length > 0 && gbpInt.rows[0].status === 'connected';

    const name = project.name || '';
    const domain = project.domain || '';
    const businessName = project.business_name || name;

    // 1. GBP CONNECTION STATUS
    if (!gbpConnected) {
      findings.push({
        pillar: 'gbp', category: 'Setup',
        title: 'Google Business Profile not connected',
        description: 'Connect your GBP to enable live listing audits — checking your actual business info, categories, hours, photos, and reviews directly from Google.',
        recommendation: 'Go to Agency Integrations and connect Google Business Profile.',
        severity: 'Critical',
        current_value: 'Not connected',
        recommended_value: 'Connected'
      });
    }

    // 2. Check maps ranking data if available
    const mapsData = await pool.query(
      `SELECT keyword, location, maps_position, maps_title, maps_rating, maps_reviews, checked_at
       FROM rank_tracking WHERE project_id=$1 AND maps_position IS NOT NULL
       ORDER BY checked_at DESC LIMIT 100`,
      [projectId]
    );

    if (mapsData.rows.length > 0) {
      // Check for keywords not ranking in maps top 3
      const notTop3 = mapsData.rows.filter(r => r.maps_position > 3);
      const avgMapsPos = mapsData.rows.reduce((s, r) => s + r.maps_position, 0) / mapsData.rows.length;

      if (notTop3.length > 0) {
        const examples = notTop3.slice(0, 3).map(r => `"${r.keyword}" in ${r.location || 'default'} (#${r.maps_position})`).join(', ');
        findings.push({
          pillar: 'gbp', category: 'Maps Ranking',
          title: `${notTop3.length} keywords not in Maps top 3`,
          description: `Average maps position is ${avgMapsPos.toFixed(1)}. Examples: ${examples}`,
          recommendation: 'Improve GBP signals: get more reviews, add GBP posts weekly, ensure NAP consistency across all directories.',
          severity: notTop3.length > 5 ? 'Critical' : 'Medium',
          current_value: `Avg position: ${avgMapsPos.toFixed(1)} | ${notTop3.length} outside top 3`,
          recommended_value: 'Top 3 for all target keywords'
        });
      }

      // Check review count
      const latestReview = mapsData.rows.find(r => r.maps_reviews != null);
      if (latestReview && latestReview.maps_reviews < 20) {
        findings.push({
          pillar: 'gbp', category: 'Reviews',
          title: `Only ${latestReview.maps_reviews} Google reviews`,
          description: 'Businesses with more reviews rank higher in local pack results. Most top-ranking businesses have 30+ reviews.',
          recommendation: 'Implement a review generation strategy: ask happy customers, send follow-up emails/SMS with direct review links.',
          severity: latestReview.maps_reviews < 10 ? 'Critical' : 'Medium',
          current_value: `${latestReview.maps_reviews} reviews`,
          recommended_value: '30+ reviews'
        });
      }

      // Check rating
      if (latestReview && latestReview.maps_rating && latestReview.maps_rating < 4.5) {
        findings.push({
          pillar: 'gbp', category: 'Reviews',
          title: `Google rating is ${latestReview.maps_rating.toFixed(1)} stars`,
          description: 'A rating below 4.5 can hurt click-through rates from the local pack.',
          recommendation: 'Focus on service quality and respond to all negative reviews professionally. Ask satisfied customers to leave reviews.',
          severity: latestReview.maps_rating < 4.0 ? 'Critical' : 'Low',
          current_value: `${latestReview.maps_rating.toFixed(1)} stars`,
          recommended_value: '4.5+ stars'
        });
      }
    } else {
      findings.push({
        pillar: 'gbp', category: 'Maps Ranking',
        title: 'No Maps ranking data available',
        description: 'Track your local pack positions in the Maps Rankings tab to monitor your GBP performance.',
        recommendation: 'Go to Check → Maps Rankings, add your target keywords, and run a sync to start tracking.',
        severity: 'Low',
        current_value: 'No data',
        recommended_value: 'Active tracking'
      });
    }

    // 4. NAP CONSISTENCY - check if website has matching info (basic check)
    // We check what's stored in the project vs what on-page audit might have found
    if (domain && name) {
      findings.push({
        pillar: 'gbp', category: 'NAP Consistency',
        title: 'Verify NAP consistency across directories',
        description: `Ensure your business name "${name}", address, and phone number are identical across Google, Yelp, Yellow Pages, True Local, and your website.`,
        recommendation: 'Use the Directories tab to check and submit consistent NAP data across all Australian business directories.',
        severity: 'Medium',
        current_value: 'Not verified',
        recommended_value: 'Consistent across all directories'
      });
    }

    // 5. GBP POSTING
    findings.push({
      pillar: 'gbp', category: 'GBP Posts',
      title: 'Regular GBP posts recommended',
      description: 'Google favors active business profiles. Posting weekly keeps your listing fresh and can improve rankings.',
      recommendation: 'Post at least once per week on your GBP: special offers, tips, project photos, or service updates.',
      severity: 'Low',
      current_value: 'Not tracked',
      recommended_value: '1+ posts per week'
    });

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
      ['completed', JSON.stringify({ findingsCount: findings.length }), auditId]);

    console.log(`[gbp-audit] Project ${projectId}: ${findings.length} findings`);
    res.json({ findings });
  } catch (e) {
    console.error('[gbp-audit] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ==================== TECHNICAL AUDIT ====================

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
    await pool.query(`DELETE FROM audit_findings WHERE project_id=$1 AND pillar='technical' AND status='new'`, [projectId]);

    const auditRes = await pool.query(
      `INSERT INTO audits (project_id, pillar, status, started_at) VALUES ($1, 'technical', 'running', NOW()) RETURNING id`,
      [projectId]
    );
    const auditId = auditRes.rows[0].id;
    const findings = [];
    const baseUrl = siteUrl.replace(/\/$/, '');

    console.log(`[tech-audit] Starting for ${baseUrl}`);

    // 1. HTTPS & Security checks
    try {
      const resp = await fetch(baseUrl, { redirect: 'follow', signal: AbortSignal.timeout(15000) });
      const finalUrl = resp.url;
      if (!finalUrl.startsWith('https://')) {
        findings.push({ pillar: 'technical', category: 'security', title: 'Site not using HTTPS', description: `Final URL is ${finalUrl}. HTTPS is a ranking factor and required for user trust.`, recommendation: 'Install an SSL certificate and redirect all HTTP traffic to HTTPS.', severity: 'Critical', current_value: 'HTTP', recommended_value: 'HTTPS' });
      }

      // Check for mixed content hints in HTML
      const html = await resp.text();
      const httpRefs = (html.match(/src=["']http:\/\//gi) || []).length;
      if (httpRefs > 0) {
        findings.push({ pillar: 'technical', category: 'security', title: `${httpRefs} mixed content references found`, description: 'HTTP resources loaded on HTTPS pages cause browser warnings and reduce trust signals.', recommendation: 'Update all resource URLs to use HTTPS or protocol-relative URLs.', severity: 'Medium', current_value: `${httpRefs} HTTP refs`, recommended_value: '0 HTTP refs' });
      }

      // Check security headers
      const headers = resp.headers;
      if (!headers.get('strict-transport-security')) {
        findings.push({ pillar: 'technical', category: 'security', title: 'Missing HSTS header', description: 'Strict-Transport-Security header not set. Browsers may still attempt HTTP connections.', recommendation: 'Add Strict-Transport-Security header with max-age of at least 31536000.', severity: 'Low', current_value: 'Not set', recommended_value: 'max-age=31536000' });
      }

      // 2. Robots.txt
      try {
        const robotsResp = await fetch(`${baseUrl}/robots.txt`, { signal: AbortSignal.timeout(10000) });
        if (!robotsResp.ok) {
          findings.push({ pillar: 'technical', category: 'crawl', title: 'robots.txt not found', description: `Server returned ${robotsResp.status} for /robots.txt. Search engines need this file for crawl directives.`, recommendation: 'Create a robots.txt file at your domain root. Include Sitemap directive.', severity: 'Medium', current_value: `${robotsResp.status}`, recommended_value: '200 OK' });
        } else {
          const robotsTxt = await robotsResp.text();
          if (!robotsTxt.toLowerCase().includes('sitemap:')) {
            findings.push({ pillar: 'technical', category: 'sitemap', title: 'No Sitemap directive in robots.txt', description: 'robots.txt exists but doesn\'t reference a sitemap. This helps search engines discover your sitemap faster.', recommendation: 'Add Sitemap: https://yourdomain.com/sitemap.xml to robots.txt', severity: 'Low', current_value: 'No sitemap reference', recommended_value: 'Sitemap directive present' });
          }
          // Check for overly restrictive rules — only match "Disallow: /" alone on a line (not /wp-admin/ etc)
          if (robotsTxt.match(/^Disallow:\s*\/\s*$/m)) {
            findings.push({ pillar: 'technical', category: 'crawl', title: 'robots.txt blocks entire site', description: 'A "Disallow: /" rule prevents search engines from crawling your entire site.', recommendation: 'Remove the blanket Disallow rule and only block specific paths you don\'t want indexed.', severity: 'Critical', current_value: 'Disallow: /', recommended_value: 'Selective blocking only' });
          }
        }
      } catch (e) { console.log('[tech-audit] robots.txt fetch failed:', e.message); }

      // 3. Sitemap
      let sitemapUrls = [];
      try {
        const sitemapResp = await fetch(`${baseUrl}/sitemap_index.xml`, { signal: AbortSignal.timeout(10000) });
        if (!sitemapResp.ok) {
          const altResp = await fetch(`${baseUrl}/sitemap.xml`, { signal: AbortSignal.timeout(10000) });
          if (!altResp.ok) {
            findings.push({ pillar: 'technical', category: 'sitemap', title: 'XML sitemap not found', description: 'Neither /sitemap_index.xml nor /sitemap.xml returned a valid response. Sitemaps help search engines discover pages.', recommendation: 'Generate and submit an XML sitemap. Most SEO plugins (Yoast, RankMath) create these automatically.', severity: 'Critical', current_value: 'Not found', recommended_value: 'Valid sitemap' });
          } else {
            const sitemapXml = await altResp.text();
            sitemapUrls = (sitemapXml.match(/<loc>(.*?)<\/loc>/g) || []).map(m => m.replace(/<\/?loc>/g, ''));
          }
        } else {
          const indexXml = await sitemapResp.text();
          const subSitemaps = (indexXml.match(/<loc>(.*?)<\/loc>/g) || []).map(m => m.replace(/<\/?loc>/g, ''));
          // Fetch first sub-sitemap to count URLs
          if (subSitemaps.length > 0) {
            try {
              const subResp = await fetch(subSitemaps[0], { signal: AbortSignal.timeout(10000) });
              if (subResp.ok) {
                const subXml = await subResp.text();
                sitemapUrls = (subXml.match(/<loc>(.*?)<\/loc>/g) || []).map(m => m.replace(/<\/?loc>/g, ''));
              }
            } catch (e) {}
          }
          console.log(`[tech-audit] Sitemap index has ${subSitemaps.length} sitemaps, first has ${sitemapUrls.length} URLs`);
        }
      } catch (e) { console.log('[tech-audit] sitemap fetch failed:', e.message); }

      // 4. Check sample pages for broken links, schema, mobile viewport
      const pagesToCheck = sitemapUrls.length > 0 ? sitemapUrls.slice(0, 10) : [baseUrl, `${baseUrl}/contact`, `${baseUrl}/about`];
      let brokenLinks = 0;
      let pagesWithoutSchema = 0;
      let pagesWithoutViewport = 0;
      let totalInternalLinks = 0;
      let orphanPages = 0;
      let checkedPages = 0;

      for (const pageUrl of pagesToCheck) {
        try {
          const pageResp = await fetch(pageUrl, { signal: AbortSignal.timeout(10000) });
          if (!pageResp.ok) { brokenLinks++; continue; }
          const pageHtml = await pageResp.text();
          checkedPages++;

          // Schema check
          if (!pageHtml.includes('application/ld+json') && !pageHtml.includes('itemtype=')) {
            pagesWithoutSchema++;
          }

          // Mobile viewport
          if (!pageHtml.includes('viewport')) {
            pagesWithoutViewport++;
          }

          // Count internal links
          const linkMatches = pageHtml.match(/href=["']([^"']+)["']/gi) || [];
          const internalCount = linkMatches.filter(l => {
            const href = l.replace(/href=["']/i, '').replace(/["']$/, '');
            return href.includes(domain) || (href.startsWith('/') && !href.startsWith('//'));
          }).length;
          totalInternalLinks += internalCount;
          if (internalCount < 3) orphanPages++;
        } catch (e) { /* timeout or error — skip */ }
      }

      if (brokenLinks > 0) {
        findings.push({ pillar: 'technical', category: 'links', title: `${brokenLinks} broken pages found`, description: `${brokenLinks} out of ${pagesToCheck.length} sampled URLs returned errors. Broken pages waste crawl budget and hurt user experience.`, recommendation: 'Fix or redirect all broken URLs. Check server logs for 404/500 errors.', severity: brokenLinks > 3 ? 'Critical' : 'Medium', current_value: `${brokenLinks} broken`, recommended_value: '0 broken pages' });
      }

      if (pagesWithoutSchema > 0 && checkedPages > 0) {
        findings.push({ pillar: 'technical', category: 'schema', title: `${pagesWithoutSchema}/${checkedPages} pages missing structured data`, description: 'Pages without schema markup miss rich snippet opportunities in search results.', recommendation: 'Add LocalBusiness, Service, and BreadcrumbList schema to all pages. Use JSON-LD format.', severity: pagesWithoutSchema > checkedPages / 2 ? 'Medium' : 'Low', current_value: `${pagesWithoutSchema} without schema`, recommended_value: 'Schema on all pages' });
      }

      if (pagesWithoutViewport > 0 && checkedPages > 0) {
        findings.push({ pillar: 'technical', category: 'mobile', title: `${pagesWithoutViewport} pages missing mobile viewport`, description: 'Pages without a viewport meta tag won\'t render properly on mobile devices. Mobile-first indexing requires proper mobile support.', recommendation: 'Add <meta name="viewport" content="width=device-width, initial-scale=1"> to all pages.', severity: 'Critical', current_value: `${pagesWithoutViewport} missing`, recommended_value: 'All pages have viewport' });
      }

      if (orphanPages > 0 && checkedPages > 0) {
        findings.push({ pillar: 'technical', category: 'structure', title: `${orphanPages}/${checkedPages} pages have weak internal linking`, description: 'Pages with fewer than 3 internal links are poorly connected and harder for search engines to discover.', recommendation: 'Add contextual internal links between related service pages, suburb pages, and blog posts.', severity: orphanPages > 3 ? 'Medium' : 'Low', current_value: `${orphanPages} under-linked`, recommended_value: '3+ internal links per page' });
      }

      if (checkedPages > 0) {
        const avgLinks = Math.round(totalInternalLinks / checkedPages);
        if (avgLinks < 5) {
          findings.push({ pillar: 'technical', category: 'structure', title: `Low average internal links (${avgLinks} per page)`, description: 'Strong internal linking helps distribute page authority and improves crawlability.', recommendation: 'Aim for 5-10 contextual internal links per page. Link service pages to suburb pages and vice versa.', severity: 'Medium', current_value: `${avgLinks} avg links`, recommended_value: '5-10 per page' });
        }
      }

      // 5. Page speed (basic — check if site loads within threshold)
      const startTime = Date.now();
      try {
        await fetch(baseUrl, { signal: AbortSignal.timeout(10000) });
        const loadTime = Date.now() - startTime;
        if (loadTime > 3000) {
          findings.push({ pillar: 'technical', category: 'speed', title: `Homepage loads in ${(loadTime / 1000).toFixed(1)}s (server-side)`, description: 'Server response time exceeds 3 seconds. This impacts Core Web Vitals and user experience.', recommendation: 'Enable caching, optimize server configuration, use a CDN, and compress images.', severity: loadTime > 5000 ? 'Critical' : 'Medium', current_value: `${(loadTime / 1000).toFixed(1)}s`, recommended_value: '< 1.5s' });
        }
      } catch (e) {
        findings.push({ pillar: 'technical', category: 'speed', title: 'Homepage timed out (>10s)', description: 'The homepage took more than 10 seconds to respond from the server.', recommendation: 'Investigate server performance. Check hosting, database queries, and plugin load.', severity: 'Critical', current_value: '>10s', recommended_value: '< 1.5s' });
      }

    } catch (fetchErr) {
      findings.push({ pillar: 'technical', category: 'crawl', title: 'Could not reach site', description: `Failed to fetch ${baseUrl}: ${fetchErr.message}`, recommendation: 'Check that the website URL is correct and the server is running.', severity: 'Critical', current_value: 'Unreachable', recommended_value: 'Accessible' });
    }

    // If no issues found, add a positive finding
    if (findings.length === 0) {
      findings.push({ pillar: 'technical', category: 'general', title: 'No critical technical issues detected', description: 'Basic technical SEO checks passed. Consider running a deeper audit with tools like Google PageSpeed Insights or Screaming Frog.', recommendation: 'Run PageSpeed Insights for Core Web Vitals data and Screaming Frog for a full crawl audit.', severity: 'Low', current_value: 'Passed', recommended_value: 'N/A' });
    }

    // Save findings
    for (const f of findings) {
      await pool.query(
        `INSERT INTO audit_findings (project_id, audit_id, pillar, category, title, description, recommendation, severity, current_value, recommended_value)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
        [projectId, auditId, f.pillar, f.category, f.title, f.description, f.recommendation, f.severity, f.current_value, f.recommended_value]
      );
    }

    // Mark audit complete
    await pool.query(`UPDATE audits SET status='completed', completed_at=NOW() WHERE id=$1`, [auditId]);

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
      // Insert into rank_tracking with SERP position + URL (unique timestamp per keyword)
      if (k.position) {
        const ts = new Date(baseTime + i).toISOString();
        await pool.query(
          `INSERT INTO rank_tracking (project_id, keyword, serp_position, serp_url, checked_at)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (project_id, keyword, location, checked_at) DO NOTHING`,
          [projectId, kw, k.position, k.url || null, ts]
        );
      }
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
            const itemDomain = (item.displayed_link || item.link || '').replace(/^https?:\/\//, '').replace(/\/$/, '').replace(/^www\./, '').toLowerCase();
            if (domain && (itemDomain.includes(domain) || domain.includes(itemDomain.split('/')[0]))) {
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
          for (const item of (data.organic_results || [])) {
            const itemDomain = (item.displayed_link || item.link || '').replace(/^https?:\/\//, '').replace(/\/$/, '').replace(/^www\./, '').toLowerCase();
            const pos = item.position;

            if (domain && (itemDomain.includes(domain.toLowerCase()) || domain.toLowerCase().includes(itemDomain.split('/')[0]))) {
              if (!serp.position) {
                serp = { position: pos, url: item.link, title: item.title, snippet: item.snippet, type: 'organic' };
              }
            } else {
              if (kwCompetitors.filter(c => c.source === 'serp').length < 3) {
                kwCompetitors.push({ domain: itemDomain, position: pos, url: item.link, title: item.title, source: 'serp' });
              }
            }
            // Named competitors
            for (const cd of competitorDomains) {
              if ((itemDomain.includes(cd) || cd.includes(itemDomain)) && !kwCompetitors.find(c => c.domain === itemDomain && c.source === 'serp')) {
                kwCompetitors.push({ domain: itemDomain, position: pos, url: item.link, title: item.title, source: 'serp' });
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
  try {
    const projRes = await pool.query('SELECT * FROM projects WHERE id=$1', [projectId]);
    if (projRes.rows.length === 0) return res.status(404).json({ error: 'Project not found' });
    const project = projRes.rows[0];
    const domain = (project.website || project.domain || '').replace(/^https?:\/\//, '').replace(/\/$/, '').replace(/^www\./, '');

    if (!domain) return res.status(400).json({ error: 'Project has no website/domain configured' });

    console.log(`[discover] Fetching ranked keywords for ${domain} via SerpAPI`);

    // Use Google organic search with site: to find pages that rank, then extract keywords
    // Also check GSC data first as a primary keyword source
    const keywords = [];
    const seen = new Set();

    // 1. Pull from GSC if available
    try {
      const gscRes = await pool.query(
        `SELECT keyword, position, clicks, impressions FROM gsc_keywords WHERE project_id=$1 AND keyword IS NOT NULL ORDER BY impressions DESC LIMIT 200`,
        [projectId]
      );
      for (const r of gscRes.rows) {
        const kw = r.keyword.toLowerCase().trim();
        if (kw && !seen.has(kw)) {
          seen.add(kw);
          keywords.push({ keyword: r.keyword, volume: null, position: Math.round(r.position) || null, url: null, competition: null, source: 'gsc', clicks: r.clicks, impressions: r.impressions });
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

    console.log(`[discover] Found ${keywords.length} total keywords for ${domain}`);
    res.json({ ok: true, keywords, total: keywords.length });
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
