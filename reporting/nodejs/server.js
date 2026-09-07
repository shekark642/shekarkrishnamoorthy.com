const express = require('express');
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 'loopback');
// 20mb (not the default 100kb) because of one route: POST /api/reports
// uploads a base64-encoded PDF, which can legitimately run a few MB for a
// tall captured page. A per-route override doesn't actually work here -
// this global parser already consumes the request stream before any
// route-level middleware would run - so the limit has to live here.
// buffer.length is still hard-capped at 15MB inside that route itself, so
// this 20mb is a generous outer bound, not the real enforced ceiling.
app.use(express.json({ limit: '20mb' }));

// Same analytics DB the collector's /collect endpoint writes to. Credentials
// come from the environment (EnvironmentFile= in the systemd unit) - never
// hardcoded here, since this file is public on GitHub.
const dbPool = mysql.createPool({
  host: process.env.DB_HOST || '127.0.0.1',
  user: process.env.DB_USER || 'analytics_app',
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME || 'analytics',
  waitForConnections: true,
  connectionLimit: 5,
  queueLimit: 0
});

// --- Page access ---
//
// Access is scoped per dashboard PAGE, not per data category. Dashboard and
// Reports are baseline pages every authenticated role can reach; only the
// three metrics pages below vary by role/scope. Which page a request is
// "for" is always derived from the route that was hit or a server-validated
// url parameter - never trusted from a client-supplied scope name, for the
// same reason the old section model never trusted one either.
const SCOPABLE_PAGES = ['music', 'about-me', 'projects'];

// page-visits (About Me and Projects share this one endpoint) has to derive
// which scoped page a request is actually about from its own url param,
// since the endpoint itself isn't page-specific - these are the only two
// urls it's ever legitimately called with.
const PAGE_SCOPE_BY_URL = {
  'https://shekarkrishnamoorthy.com/members/shekarkrishnamoorthy.html': 'about-me',
  'https://shekarkrishnamoorthy.com/important/projects.html': 'projects'
};

// --- Sessions ---
//
// Backed by the `sessions` table in the same analytics DB, not an in-memory
// Map: every `npm run deploy` restarts this process, and an in-memory store
// silently logged out anyone currently using the dashboard on every single
// deploy. A DB-backed token lookup is one indexed primary-key read - on a
// local (127.0.0.1) connection pool this costs well under a millisecond,
// not a meaningful bottleneck for a low-traffic reporting dashboard - and
// survives restarts like everything else this table already backs.
const SESSION_COOKIE = 'reporting_session';
const SESSION_MAX_AGE_MS = 24 * 60 * 60 * 1000;

async function createSession(user) {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + SESSION_MAX_AGE_MS);
  // sessions.is_admin predates the role system and is left at its default
  // (unused) - role is always looked up fresh from `users` in getSession,
  // via the JOIN below, so a role change takes effect on a user's very
  // next request rather than only at their next login.
  await dbPool.execute(
    'INSERT INTO sessions (token, user_id, username, expires_at) VALUES (?, ?, ?, ?)',
    [token, user.id, user.username, expiresAt]
  );
  return token;
}

async function getSession(token) {
  if (!token) return null;
  const [rows] = await dbPool.query(
    `SELECT s.user_id AS userId, s.username, u.role AS role
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token = ? AND s.expires_at > NOW()`,
    [token]
  );
  if (!rows.length) return null;
  return { userId: rows[0].userId, username: rows[0].username, role: rows[0].role };
}

async function deleteSession(token) {
  if (!token) return;
  await dbPool.execute('DELETE FROM sessions WHERE token = ?', [token]);
}

// Expired rows are already excluded from getSession's WHERE clause, so this
// sweep is just table hygiene (keeps it from growing forever), not a
// correctness requirement - safe to run infrequently.
setInterval(() => {
  dbPool.execute('DELETE FROM sessions WHERE expires_at < NOW()').catch((err) => {
    console.error('[session cleanup] error:', err.message);
  });
}, 60 * 60 * 1000);

// --- IP retention ---
//
// events.ip has no legitimate long-term use beyond abuse investigation
// shortly after the fact - every report/aggregate this dashboard computes
// (totals, byGroup, sessions) reads type/url/timestamps/payload, never ip.
// Keeping raw IPs indefinitely is pure liability with no analytical
// upside, so anonymize (not delete - the event itself is still valid
// analytics data) anything past a 90-day window, a common baseline
// retention period for raw IPs. Runs once at startup and once a day after.
const IP_RETENTION_DAYS = 90;
function anonymizeOldIps() {
  dbPool.execute(
    'UPDATE events SET ip = NULL WHERE ip IS NOT NULL AND server_timestamp < NOW() - INTERVAL ? DAY',
    [IP_RETENTION_DAYS]
  ).then(([result]) => {
    if (result.affectedRows) console.log(`[ip retention] anonymized ${result.affectedRows} row(s) older than ${IP_RETENTION_DAYS} days`);
  }).catch((err) => {
    console.error('[ip retention] error:', err.message);
  });

  // Same policy applied to the visitors table (see hw2/nodejs/server.js's
  // /collect handler): a "User N" label is meant as a stable pseudonym in
  // place of showing a raw IP, not a permanent side-channel that outlives
  // the retention window the raw IP itself is already held to. user_number
  // and first_seen are kept - the number itself isn't personal data, and
  // losing it would just make old sessions unlabeled for no privacy
  // benefit - only the ip column (and therefore the ability to recognize
  // this visitor again as the same numbered user) is cleared.
  dbPool.execute(
    'UPDATE visitors SET ip = NULL WHERE ip IS NOT NULL AND last_seen < NOW() - INTERVAL ? DAY',
    [IP_RETENTION_DAYS]
  ).then(([result]) => {
    if (result.affectedRows) console.log(`[ip retention] anonymized ${result.affectedRows} visitor(s) older than ${IP_RETENTION_DAYS} days`);
  }).catch((err) => {
    console.error('[ip retention] visitors error:', err.message);
  });
}
anonymizeOldIps();
setInterval(anonymizeOldIps, 24 * 60 * 60 * 1000);

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  header.split(';').forEach((part) => {
    const idx = part.indexOf('=');
    if (idx === -1) return;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    try { out[key] = decodeURIComponent(val); } catch { out[key] = val; }
  });
  return out;
}

// Attaches req.session (or null) on every request, before anything else runs.
// A DB error here fails closed (session stays null, same as no cookie at
// all) rather than crashing the request - an auth-store hiccup should mean
// "logged out," never a 500 for every page on the site.
app.use(async (req, res, next) => {
  const cookies = parseCookies(req.headers.cookie);
  const token = cookies[SESSION_COOKIE];
  try {
    req.session = await getSession(token);
  } catch (err) {
    console.error('[session lookup] error:', err.message);
    req.session = null;
  }
  next();
});

// --- Authorization ---
//
// Three roles: super_admin (everything, including user management),
// analyst (Dashboard + Reports always, optionally restricted to a subset of
// the three metrics pages), viewer (Dashboard + Reports only - none of the
// three metrics pages, ever).
//
// An analyst with zero rows in user_scopes is unrestricted ("An analyst
// can do anything and look at anything" - the default). Adding rows
// narrows them to exactly those pages ("may be defined... to look at a
// defined set of" pages, now, rather than sections).
async function getAllowedPages(session) {
  if (session.role === 'super_admin') return SCOPABLE_PAGES;
  if (session.role === 'analyst') {
    const [rows] = await dbPool.query('SELECT page FROM user_scopes WHERE user_id = ?', [session.userId]);
    return rows.length ? rows.map((r) => r.page) : SCOPABLE_PAGES;
  }
  return []; // viewer: none of the three metrics pages
}

// Two flavors of each guard: API routes get a JSON 401/403 (so fetch() calls
// can handle it programmatically), page routes get redirected to the login
// screen (so a browser navigating there directly lands somewhere sensible).
function requireAuthApi(req, res, next) {
  if (!req.session) return res.status(401).json({ error: 'not logged in' });
  next();
}
function requireRoleApi(...roles) {
  return (req, res, next) => {
    if (!req.session) return res.status(401).json({ error: 'not logged in' });
    if (!roles.includes(req.session.role)) return res.status(403).json({ error: 'insufficient role' });
    next();
  };
}
// Gates one of the three scopable metrics pages' own API endpoints.
function requirePageApi(page) {
  return async (req, res, next) => {
    if (!req.session) return res.status(401).json({ error: 'not logged in' });
    if (req.session.role === 'viewer') return res.status(403).json({ error: `no access to page: ${page}` });
    try {
      const allowed = await getAllowedPages(req.session);
      if (!allowed.includes(page)) return res.status(403).json({ error: `no access to page: ${page}` });
      next();
    } catch (err) {
      console.error('[requirePageApi] error:', err.message);
      res.status(500).json({ error: 'server error' });
    }
  };
}
function requireAuthPage(req, res, next) {
  if (!req.session) return res.redirect('/login.html');
  next();
}
function requireRolePage(...roles) {
  return (req, res, next) => {
    if (!req.session) return res.redirect('/login.html');
    if (!roles.includes(req.session.role)) return res.status(403).type('html').send('<h1>403 Forbidden</h1><p>Your role does not have access to this page.</p>');
    next();
  };
}
// Gates one of the three scopable metrics pages' own HTML route.
function requirePagePage(page) {
  return async (req, res, next) => {
    if (!req.session) return res.redirect('/login.html');
    if (req.session.role === 'viewer') return res.status(403).type('html').send('<h1>403 Forbidden</h1><p>Your role does not have access to this page.</p>');
    try {
      const allowed = await getAllowedPages(req.session);
      if (!allowed.includes(page)) return res.status(403).type('html').send('<h1>403 Forbidden</h1><p>You do not have access to this page.</p>');
      next();
    } catch (err) {
      console.error('[requirePagePage] error:', err.message);
      res.status(500).send('Server error');
    }
  };
}

// --- Auth routes ---

// A place to store anything a request/client did that reads as suspicious
// or malicious - repeated failed logins, injection-shaped inputs - not the
// routine stuff. Shared with hw2/nodejs's /collect, same table in the same
// analytics DB (each app writes through its own dbPool).
async function flagClient(req, reason, details, sessionId) {
  try {
    await dbPool.execute(
      'INSERT INTO flagged_clients (ip, user_agent, reason, endpoint, method, session_id, details) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [
        req.ip || null,
        (req.headers['user-agent'] || '').slice(0, 512) || null,
        reason,
        (req.originalUrl || req.path || '').slice(0, 255),
        req.method,
        typeof sessionId === 'string' ? sessionId.slice(0, 64) : null,
        JSON.stringify(details || {})
      ]
    );
  } catch (err) {
    console.error('[flagClient] error:', err.message);
  }
}

app.post('/auth/login', async (req, res) => {
  const body = req.body || {};
  const username = body.username;
  const password = body.password;
  if (typeof username !== 'string' || !username || typeof password !== 'string' || !password) {
    return res.status(400).json({ error: 'username and password are required' });
  }

  try {
    const [rows] = await dbPool.query(
      'SELECT id, username, password_hash, role FROM users WHERE username = ? LIMIT 1',
      [username]
    );
    if (!rows.length) {
      flagClient(req, 'failed_login', { usernameAttempted: username.slice(0, 64), cause: 'no such user' });
      return res.status(401).json({ error: 'invalid username or password' });
    }

    const user = rows[0];
    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) {
      flagClient(req, 'failed_login', { usernameAttempted: username.slice(0, 64), cause: 'wrong password' });
      return res.status(401).json({ error: 'invalid username or password' });
    }

    const token = await createSession(user);

    res.cookie(SESSION_COOKIE, token, {
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
      maxAge: SESSION_MAX_AGE_MS,
      path: '/'
    });
    res.json({ success: true, username: user.username, role: user.role });
  } catch (err) {
    console.error('[POST /auth/login] error:', err.message);
    res.status(500).json({ error: 'server error' });
  }
});

app.post('/auth/logout', async (req, res) => {
  const cookies = parseCookies(req.headers.cookie);
  const token = cookies[SESSION_COOKIE];
  try {
    await deleteSession(token);
  } catch (err) {
    console.error('[POST /auth/logout] error:', err.message);
  }
  res.clearCookie(SESSION_COOKIE, { path: '/' });
  res.json({ success: true });
});

app.get('/auth/me', requireAuthApi, async (req, res) => {
  try {
    const pages = await getAllowedPages(req.session);
    res.json({ userId: req.session.userId, username: req.session.username, role: req.session.role, pages });
  } catch (err) {
    console.error('[GET /auth/me] error:', err.message);
    res.status(500).json({ error: 'server error' });
  }
});

// The reporting dashboard fetches these same-origin (it's served by this
// same app - see the page routes further down), so CORS isn't actually
// needed for normal use. It's kept permissive for non-browser tools
// (curl/Postman) that don't enforce CORS anyway; the real access control is
// requireAuthApi/requireRoleApi/requirePageApi below, not this header -
// CORS only affects whether a *browser* running someone else's JS can read
// the response, not whether a request reaches the server at all.
app.use('/api', (req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Every /api/* route requires at least a logged-in session - role and
// section checks layer on top of this per-route below.
app.use('/api', requireAuthApi);

// Resource: /api/events, mapping directly onto the `events` table the
// collector's /collect endpoint writes into (session_id, type, url, ip,
// client_timestamp, server_timestamp, payload). A single flexible table
// with a JSON payload column, rather than separate static/performance/
// activity tables, was the storage choice made in the collector phase -
// this API reflects that same shape rather than inventing a different one.

function parseId(req, res) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: 'id must be a positive integer' });
    return null;
  }
  return id;
}

// Same 50KB cap /collect already enforces - this API can be hit directly
// (not just through collector.js), so it needs the same guard against an
// oversized payload landing straight in the JSON column unchecked.
const MAX_PAYLOAD_BYTES = 50 * 1024;

function checkPayload(payload) {
  if (payload === undefined) return { ok: true };
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return { ok: false, status: 400, error: 'payload must be a JSON object' };
  }
  const size = Buffer.byteLength(JSON.stringify(payload), 'utf8');
  if (size > MAX_PAYLOAD_BYTES) {
    return { ok: false, status: 413, error: 'payload too large (max 50KB)' };
  }
  return { ok: true };
}

// Single-record CRUD by id, gated by role only (requireRoleApi keeps
// viewers out entirely). A raw event row isn't reliably attributable to one
// of the three scopable pages the way a whole dashboard page is - an
// 'enter'/'activity'/'exit' row could belong to any site at all, not just
// the three that carry per-page scoping - so this stays a plain
// super_admin/analyst power-user API rather than trying to force page-level
// gating onto individual rows.

app.get('/api/events/:id', requireRoleApi('super_admin', 'analyst'), async (req, res) => {
  const id = parseId(req, res);
  if (id === null) return;

  try {
    const [rows] = await dbPool.query(
      `SELECT id, session_id, type, url, ip, client_timestamp, server_timestamp, payload
       FROM events WHERE id = ?`,
      [id]
    );
    if (!rows.length) return res.status(404).json({ error: 'not found' });
    res.json(rows[0]);
  } catch (err) {
    console.error('[GET /api/events/:id] error:', err.message);
    res.status(500).json({ error: 'database error' });
  }
});

// POST /api/events - create a new entry. Must NOT include an id - the
// database assigns one.
app.post('/api/events', requireRoleApi('super_admin', 'analyst'), async (req, res) => {
  const body = req.body || {};
  if ('id' in body) {
    return res.status(400).json({ error: 'POST must not include an id - the database assigns one' });
  }
  if (typeof body.type !== 'string' || !body.type) {
    return res.status(400).json({ error: 'type is required' });
  }
  const payloadCheck = checkPayload(body.payload);
  if (!payloadCheck.ok) {
    return res.status(payloadCheck.status).json({ error: payloadCheck.error });
  }

  try {
    const [result] = await dbPool.execute(
      `INSERT INTO events (session_id, type, url, ip, client_timestamp, payload)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        typeof body.session_id === 'string' ? body.session_id.slice(0, 64) : null,
        body.type.slice(0, 32),
        typeof body.url === 'string' ? body.url : null,
        typeof body.ip === 'string' ? body.ip : null,
        body.client_timestamp ? new Date(body.client_timestamp) : null,
        JSON.stringify(body.payload !== undefined ? body.payload : {})
      ]
    );
    const [rows] = await dbPool.query(
      `SELECT id, session_id, type, url, ip, client_timestamp, server_timestamp, payload
       FROM events WHERE id = ?`,
      [result.insertId]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error('[POST /api/events] error:', err.message);
    res.status(500).json({ error: 'database error' });
  }
});

// PUT /api/events/:id - update an existing entry. Must include an id.
app.put('/api/events/:id', requireRoleApi('super_admin', 'analyst'), async (req, res) => {
  const id = parseId(req, res);
  if (id === null) return;

  const body = req.body || {};
  const payloadCheck = checkPayload(body.payload);
  if (!payloadCheck.ok) {
    return res.status(payloadCheck.status).json({ error: payloadCheck.error });
  }

  try {
    const [existingRows] = await dbPool.query('SELECT type FROM events WHERE id = ?', [id]);
    if (!existingRows.length) return res.status(404).json({ error: 'not found' });

    const fields = [];
    const params = [];
    if (typeof body.type === 'string') { fields.push('type = ?'); params.push(body.type.slice(0, 32)); }
    if (typeof body.url === 'string') { fields.push('url = ?'); params.push(body.url); }
    if (typeof body.ip === 'string') { fields.push('ip = ?'); params.push(body.ip); }
    if (typeof body.session_id === 'string') { fields.push('session_id = ?'); params.push(body.session_id.slice(0, 64)); }
    if (body.payload !== undefined) { fields.push('payload = ?'); params.push(JSON.stringify(body.payload)); }

    if (!fields.length) {
      return res.status(400).json({ error: 'no updatable fields provided' });
    }

    const [result] = await dbPool.execute(
      `UPDATE events SET ${fields.join(', ')} WHERE id = ?`,
      [...params, id]
    );
    if (!result.affectedRows) return res.status(404).json({ error: 'not found' });

    const [rows] = await dbPool.query(
      `SELECT id, session_id, type, url, ip, client_timestamp, server_timestamp, payload
       FROM events WHERE id = ?`,
      [id]
    );
    res.json(rows[0]);
  } catch (err) {
    console.error('[PUT /api/events/:id] error:', err.message);
    res.status(500).json({ error: 'database error' });
  }
});

// DELETE /api/events/:id - remove an entry. Must include an id.
app.delete('/api/events/:id', requireRoleApi('super_admin', 'analyst'), async (req, res) => {
  const id = parseId(req, res);
  if (id === null) return;

  try {
    const [existingRows] = await dbPool.query('SELECT type FROM events WHERE id = ?', [id]);
    if (!existingRows.length) return res.status(404).json({ error: 'not found' });

    const [result] = await dbPool.execute('DELETE FROM events WHERE id = ?', [id]);
    if (!result.affectedRows) return res.status(404).json({ error: 'not found' });
    res.sendStatus(204);
  } catch (err) {
    console.error('[DELETE /api/events/:id] error:', err.message);
    res.status(500).json({ error: 'database error' });
  }
});

// --- Dashboard reporting ---
//
// These back the main Dashboard, which every authenticated role can reach -
// so they're gated by requireAuthApi (logged in at all), not by page scope.
// Each is still hardcoded to one WHERE clause server-side (type = 'load'
// for performance, type != 'load' for behavioral), replacing the old
// generic /api/events (list), /api/reports/summary, and /api/reports/
// sessions endpoints - there's no generic "give me everything" list
// endpoint here at all.
//
// ?urlPrefix= still scopes to one site/page; the arbitrary ?metricPath=/
// ?metricAgg= aggregation still works exactly as before, just applied
// within whichever WHERE clause is already active - the behavioral summary
// endpoint can aggregate any JSON path someone asks for, but only across
// behavioral-type rows, never across 'load' rows.
const ALLOWED_AGG = ['avg', 'sum', 'min', 'max', 'count'];
const ALLOWED_GROUP_BY = ['type', 'session_id', 'url'];
const JSON_PATH_RE = /^\$(\.[A-Za-z0-9_]+|\[\d+\])*$/; // e.g. $.vitals.lcp.value

function buildUrlPrefixClause(req) {
  if (typeof req.query.urlPrefix === 'string' && req.query.urlPrefix) {
    return { clause: 'url LIKE ?', param: req.query.urlPrefix + '%' };
  }
  return null;
}

// Characters/keywords that show up in an actual injection attempt but never
// in a legitimate JSON path (which is just $.foo.bar[0] segments) - a typo'd
// path fails JSON_PATH_RE too, but this narrower check is what separates
// "made a mistake" from "tried something."
const INJECTION_SHAPED_RE = /['";]|--|\/\*|\bunion\b|\bselect\b|\bdrop\b|\bor\s+1=1\b/i;

async function runCustomMetric(whereSql, params, req, res) {
  const metricPath = req.query.metricPath;
  const metricAgg = (req.query.metricAgg || 'avg').toLowerCase();
  if (typeof metricPath !== 'string' || !metricPath) return { customMetric: null };

  if (!JSON_PATH_RE.test(metricPath)) {
    if (INJECTION_SHAPED_RE.test(metricPath)) {
      flagClient(req, 'injection_attempt', { field: 'metricPath', value: metricPath.slice(0, 500) });
    }
    res.status(400).json({ error: 'metricPath must look like a JSON path, e.g. $.vitals.lcp.value' });
    return { handled: true };
  }
  if (!ALLOWED_AGG.includes(metricAgg)) {
    res.status(400).json({ error: 'metricAgg must be one of: ' + ALLOWED_AGG.join(', ') });
    return { handled: true };
  }
  const aggSql = metricAgg === 'count'
    ? 'COUNT(payload->>?)'
    : `${metricAgg.toUpperCase()}(CAST(payload->>? AS DOUBLE))`;
  const [[row]] = await dbPool.query(`SELECT ${aggSql} AS value FROM events ${whereSql}`, [metricPath, ...params]);
  return { customMetric: { path: metricPath, agg: metricAgg, value: row.value } };
}

// GET /api/performance/summary - averages across page-load (Web Vitals)
// events only.
app.get('/api/performance/summary', requireAuthApi, async (req, res) => {
  const where = ["type = 'load'"];
  const params = [];
  const prefix = buildUrlPrefixClause(req);
  if (prefix) { where.push(prefix.clause); params.push(prefix.param); }
  const whereSql = 'WHERE ' + where.join(' AND ');

  try {
    const [[totals]] = await dbPool.query(
      `SELECT
         COUNT(*) AS totalEvents,
         COUNT(DISTINCT session_id) AS uniqueSessions,
         AVG(total_load_time_ms) AS avgLoadTimeMs,
         AVG(lcp_value) AS avgLcp,
         AVG(cls_value) AS avgCls,
         AVG(inp_value) AS avgInp
       FROM events ${whereSql}`,
      params
    );

    const metricResult = await runCustomMetric(whereSql, params, req, res);
    if (metricResult.handled) return;

    res.json({ totals, customMetric: metricResult.customMetric });
  } catch (err) {
    console.error('[GET /api/performance/summary] error:', err.message);
    res.status(500).json({ error: 'database error' });
  }
});

// GET /api/performance/events - the load-event list (used for the load
// time trend/histogram/table views).
app.get('/api/performance/events', requireAuthApi, async (req, res) => {
  const where = ["type = 'load'"];
  const params = [];
  const prefix = buildUrlPrefixClause(req);
  if (prefix) { where.push(prefix.clause); params.push(prefix.param); }
  const whereSql = 'WHERE ' + where.join(' AND ');

  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 1000);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
  const includePayload = req.query.includePayload === 'true';
  const columns = 'id, session_id, type, url, ip, client_timestamp, server_timestamp, ' +
    'total_load_time_ms, lcp_value, cls_value, inp_value' + (includePayload ? ', payload' : '');

  try {
    const [rows] = await dbPool.query(
      `SELECT ${columns} FROM events ${whereSql} ORDER BY id DESC LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );
    res.json(rows);
  } catch (err) {
    console.error('[GET /api/performance/events] error:', err.message);
    res.status(500).json({ error: 'database error' });
  }
});

// GET /api/performance/page-comparison - actual average load time per
// tracked PAGE (not just per site) vs. an estimated "expected" load time
// for a basic machine/connection, derived from how many sub-resources
// that page actually makes the browser fetch (resourceCount, added to
// the 'load' event's own payload in collector.js). Pages are discovered
// from the url column itself, not a fixed list here - a newly tracked
// page just starts appearing once it sends its first 'load' event, with
// nothing to update in this file.
//
// The "expected" formula is a deliberately simple, fully transparent
// estimate, not a network simulation: FIXED_OVERHEAD_MS covers DNS/TCP/TLS
// handshake plus fetching and parsing the base HTML, before any
// sub-resource loading even starts; PER_RESOURCE_MS is the added cost of
// one more sub-resource under a modest connection with only partial
// HTTP/2 multiplexing - queuing, connection reuse, and parse/eval
// overhead per resource, not its raw serial fetch time (resources load
// substantially in parallel, so this is intentionally much less than a
// full round-trip per resource). Both constants are named and adjustable
// right here - nothing about how "expected" is computed is hidden in the
// query or the frontend.
const SITE_COMPARISON_FIXED_OVERHEAD_MS = 400;
const SITE_COMPARISON_PER_RESOURCE_MS = 40;

// reporting.shekarkrishnamoorthy.com is deliberately excluded - tracking
// was removed from the dashboard's own pages earlier ("I don't want to
// see that showing up in the dashboard/tracking/logs"), so the handful of
// 'load' rows still in the table from before that change (plus this
// session's own manual testing) don't belong in a chart meant to compare
// real tracked pages.
app.get('/api/performance/page-comparison', requireAuthApi, async (req, res) => {
  try {
    const [rows] = await dbPool.query(`
      SELECT
        url,
        COUNT(*) AS sampleSize,
        AVG(total_load_time_ms) AS avgLoadTimeMs,
        AVG(JSON_EXTRACT(payload, '$.performanceData.resourceCount')) AS avgResourceCount,
        COUNT(JSON_EXTRACT(payload, '$.performanceData.resourceCount')) AS resourceSamples
      FROM events
      WHERE type = 'load' AND url IS NOT NULL
        AND url NOT LIKE 'https://reporting.shekarkrishnamoorthy.com/%'
      GROUP BY url
    `);

    // Root ("/") and the explicit "/index.html" are the same page under two
    // different URL strings (see normalizePageUrl) - merged here with a
    // sample-size-weighted average rather than a plain average of the two
    // rows' averages, so a page with 2 samples doesn't count as heavily as
    // one with 200.
    const byPage = {};
    rows.forEach((r) => {
      const page = normalizePageUrl(r.url);
      const entry = byPage[page] || { page, sampleSize: 0, loadTimeSum: 0, resourceCountSum: 0, resourceSamples: 0 };
      entry.sampleSize += r.sampleSize;
      entry.loadTimeSum += r.avgLoadTimeMs * r.sampleSize;
      if (r.avgResourceCount !== null) {
        entry.resourceCountSum += r.avgResourceCount * r.resourceSamples;
        entry.resourceSamples += r.resourceSamples;
      }
      byPage[page] = entry;
    });

    const result = Object.values(byPage).map((e) => {
      const avgLoadTimeMs = e.loadTimeSum / e.sampleSize;
      const avgResourceCount = e.resourceSamples ? e.resourceCountSum / e.resourceSamples : null;
      return {
        page: e.page,
        sampleSize: e.sampleSize,
        avgLoadTimeMs,
        avgResourceCount,
        expectedLoadTimeMs: avgResourceCount === null
          ? null
          : SITE_COMPARISON_FIXED_OVERHEAD_MS + avgResourceCount * SITE_COMPARISON_PER_RESOURCE_MS
      };
    }).sort((a, b) => b.avgLoadTimeMs - a.avgLoadTimeMs);

    res.json(result);
  } catch (err) {
    console.error('[GET /api/performance/page-comparison] error:', err.message);
    res.status(500).json({ error: 'database error' });
  }
});

// GET /api/performance/hardware-scatter - one point per visitor (User N):
// x = their device's logical CPU core count (navigator.hardwareConcurrency,
// added to collector.js's staticData - a rough cross-browser hardware
// signal, not a real benchmark), y = their average total_load_time_ms
// across every session they've ever had, not just one. Only visitors with
// at least one 'load' event carrying this new field show up - existing
// historical events predate it and have nothing to plot.
app.get('/api/performance/hardware-scatter', requireAuthApi, async (req, res) => {
  try {
    const [rows] = await dbPool.query(`
      SELECT
        ip,
        AVG(JSON_EXTRACT(payload, '$.staticData.hardwareConcurrency')) AS hardwareConcurrency,
        AVG(JSON_EXTRACT(payload, '$.staticData.deviceMemory')) AS deviceMemory,
        AVG(total_load_time_ms) AS avgLoadTimeMs,
        COUNT(*) AS sampleSize,
        SUBSTRING_INDEX(GROUP_CONCAT(JSON_UNQUOTE(JSON_EXTRACT(payload, '$.staticData.userAgent')) ORDER BY id DESC SEPARATOR '||'), '||', 1) AS userAgent
      FROM events
      WHERE type = 'load' AND ip IS NOT NULL
        AND JSON_EXTRACT(payload, '$.staticData.hardwareConcurrency') IS NOT NULL
        AND url NOT LIKE 'https://reporting.shekarkrishnamoorthy.com/%'
      GROUP BY ip
    `);
    const userNumberByIp = await lookupUserNumbers(rows.map((r) => r.ip));
    res.json(rows.map((r) => ({
      userNumber: userNumberByIp[r.ip] ?? null,
      hardwareConcurrency: r.hardwareConcurrency,
      deviceMemory: r.deviceMemory,
      avgLoadTimeMs: r.avgLoadTimeMs,
      sampleSize: r.sampleSize,
      userAgent: r.userAgent
    })));
  } catch (err) {
    console.error('[GET /api/performance/hardware-scatter] error:', err.message);
    res.status(500).json({ error: 'database error' });
  }
});

// GET /api/behavioral/summary - type breakdown + totals across everything
// that isn't a page-load event.
app.get('/api/behavioral/summary', requireAuthApi, async (req, res) => {
  const where = ["type != 'load'"];
  const params = [];
  const prefix = buildUrlPrefixClause(req);
  if (prefix) { where.push(prefix.clause); params.push(prefix.param); }
  const whereSql = 'WHERE ' + where.join(' AND ');

  const groupBy = ALLOWED_GROUP_BY.includes(req.query.groupBy) ? req.query.groupBy : 'type';

  try {
    const [[totals]] = await dbPool.query(
      `SELECT COUNT(*) AS totalEvents, COUNT(DISTINCT session_id) AS uniqueSessions FROM events ${whereSql}`,
      params
    );

    const [byGroup] = await dbPool.query(
      `SELECT ${groupBy} AS \`key\`, COUNT(*) AS count FROM events ${whereSql}
       GROUP BY ${groupBy} ORDER BY count DESC LIMIT 50`,
      params
    );

    const metricResult = await runCustomMetric(whereSql, params, req, res);
    if (metricResult.handled) return;

    res.json({ totals, groupBy, byGroup, customMetric: metricResult.customMetric });
  } catch (err) {
    console.error('[GET /api/behavioral/summary] error:', err.message);
    res.status(500).json({ error: 'database error' });
  }
});

// GET /api/behavioral/events - the general activity/recent-events list.
app.get('/api/behavioral/events', requireAuthApi, async (req, res) => {
  const where = ["type != 'load'"];
  const params = [];
  if (typeof req.query.type === 'string') {
    where.push('type = ?');
    params.push(req.query.type);
  }
  if (typeof req.query.session === 'string') {
    where.push('session_id = ?');
    params.push(req.query.session);
  }
  const whereSql = 'WHERE ' + where.join(' AND ');

  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 1000);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
  const includePayload = req.query.includePayload === 'true';
  const columns = 'id, session_id, type, url, ip, client_timestamp, server_timestamp' + (includePayload ? ', payload' : '');

  try {
    const [rows] = await dbPool.query(
      `SELECT ${columns} FROM events ${whereSql} ORDER BY id DESC LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );
    res.json(rows);
  } catch (err) {
    console.error('[GET /api/behavioral/events] error:', err.message);
    res.status(500).json({ error: 'database error' });
  }
});

// GET /api/behavioral/distinct-users - unique visitors cross-referenced
// against how many sessions they've generated. There's no login-based
// identity for anonymous site visitors, so IP address is the only durable
// proxy available - grouping by session_id alone would just report the
// session count back at itself. Two caveats this can't get around: IPs
// older than the retention window are anonymized to NULL by
// anonymizeOldIps() and are excluded here (nothing left to group them by),
// and NAT/dynamic IPs mean this over- or under-counts "real" unique people
// at the margins - it's the best available signal, not a guarantee.
app.get('/api/behavioral/distinct-users', requireAuthApi, async (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 500);
  try {
    // Longest/average session time need each session's own duration first
    // (a per-session aggregate), then MAX()/AVG() of THOSE across a given
    // ip's sessions - a second level of aggregation the old single-pass
    // query over raw events couldn't express, since "session duration"
    // isn't a column, it's already an aggregate over that session's rows.
    const [rows] = await dbPool.query(
      `SELECT
         d.ip,
         v.user_number AS userNumber,
         d.sessionCount,
         d.firstSeen,
         d.lastSeen,
         d.longestSessionSecs,
         d.avgSessionSecs
       FROM (
         SELECT
           ip,
           COUNT(*) AS sessionCount,
           MIN(firstSeen) AS firstSeen,
           MAX(lastSeen) AS lastSeen,
           MAX(durationSecs) AS longestSessionSecs,
           AVG(durationSecs) AS avgSessionSecs
         FROM (
           SELECT
             session_id,
             SUBSTRING_INDEX(GROUP_CONCAT(ip ORDER BY id DESC SEPARATOR '||'), '||', 1) AS ip,
             MIN(COALESCE(client_timestamp, server_timestamp)) AS firstSeen,
             MAX(COALESCE(client_timestamp, server_timestamp)) AS lastSeen,
             TIMESTAMPDIFF(SECOND,
               MIN(COALESCE(client_timestamp, server_timestamp)),
               MAX(COALESCE(client_timestamp, server_timestamp))) AS durationSecs
           FROM events
           WHERE session_id IS NOT NULL
           GROUP BY session_id
         ) sessions
         WHERE ip IS NOT NULL
         GROUP BY ip
       ) d
       LEFT JOIN visitors v ON v.ip = d.ip
       ORDER BY d.sessionCount DESC, d.lastSeen DESC
       LIMIT ?`,
      [limit]
    );
    // Raw IPs on this table are super_admin only - masked (not omitted, so
    // the column still lines up and User N/session counts stay visible) for
    // everyone else. Done here, not left to the frontend to hide, since a
    // client can always just read whatever the response body already
    // contains - the real IP must never leave the server for a role that
    // isn't allowed to see it.
    const out = req.session.role === 'super_admin'
      ? rows
      : rows.map((r) => ({ ...r, ip: 'xxx.xxx.xxx.xxx' }));
    res.json(out);
  } catch (err) {
    console.error('[GET /api/behavioral/distinct-users] error:', err.message);
    res.status(500).json({ error: 'database error' });
  }
});

// GET /api/behavioral/visitor-types - bot vs. human, one classification per
// session (not per event). is_bot is a generated column on `events`,
// computed straight from each 'load' event's own JSON payload - true if
// navigator.webdriver was set (the default for Selenium/Puppeteer/
// Playwright) or the User-Agent string matches a known bot/crawler/tool
// pattern. A session can have more than one 'load' event (one per page
// visited); MAX() means one bot-flagged page load is enough to call the
// whole session a bot. This is a heuristic, not a guarantee - a bot that
// spoofs a normal browser UA and clears navigator.webdriver evades both
// signals, same limitation every client-side bot detector has.
//
// Grouped over ALL of a session's events, not just its 'load' ones - is_bot
// is a generated column that's NULL for every non-'load' row (see the
// column definition), so MAX() over the whole session reduces to exactly
// its load-event value when one exists. What this buys: a session that
// bounced before the page's load event (plus the async image-detection
// check it waits on) ever completed has no load event at all, and
// therefore no signal to classify it by - MAX() over an all-NULL group is
// NULL, which surfaces as "unclassified" below instead of being silently
// dropped or defaulted to human. Without this, the pie chart's total
// undercounts the dashboard's "Unique Sessions" stat (which counts any
// session with a non-load event) by exactly however many sessions bounced
// that fast - a real, observed gap, not a rounding artifact.
app.get('/api/behavioral/visitor-types', requireAuthApi, async (req, res) => {
  try {
    const [[row]] = await dbPool.query(`
      SELECT
        SUM(sessionIsBot = 1) AS botSessions,
        SUM(sessionIsBot = 0) AS humanSessions,
        SUM(sessionIsBot IS NULL) AS unclassifiedSessions
      FROM (
        SELECT session_id, MAX(is_bot) AS sessionIsBot
        FROM events
        WHERE session_id IS NOT NULL
        GROUP BY session_id
      ) t
    `);
    res.json({
      bot: Number(row.botSessions) || 0,
      human: Number(row.humanSessions) || 0,
      unclassified: Number(row.unclassifiedSessions) || 0
    });
  } catch (err) {
    console.error('[GET /api/behavioral/visitor-types] error:', err.message);
    res.status(500).json({ error: 'database error' });
  }
});

// GET /api/behavioral/top-sessions?sortBy=duration|recent - the N sessions
// (default 5) ranked either by total time on site or by how recently they
// were last active, each enriched with device info from its 'load' event
// and activity totals summed across its 'activity' events - three
// separate, cheap queries scoped to just those session ids, merged in JS,
// rather than one query dragging every event's full JSON payload through
// a join.
//
// exitUrl is the URL from that session's chronologically LAST event (the
// one with the highest id) - not MAX(url), which sorts alphabetically and
// has nothing to do with time. GROUP_CONCAT(... ORDER BY id DESC) then
// SUBSTRING_INDEX(..., 1) is the standard MySQL idiom for "value from the
// last row of the group" without a second join.
app.get('/api/behavioral/top-sessions', requireAuthApi, async (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 5, 1), 20);
  const orderCol = req.query.sortBy === 'recent' ? 'lastSeen' : 'durationSecs';
  const minSeconds = Math.max(parseInt(req.query.minSeconds, 10) || 0, 0);

  try {
    const [base] = await dbPool.query(
      `SELECT
         session_id,
         MIN(COALESCE(client_timestamp, server_timestamp)) AS firstSeen,
         MAX(COALESCE(client_timestamp, server_timestamp)) AS lastSeen,
         TIMESTAMPDIFF(SECOND,
           MIN(COALESCE(client_timestamp, server_timestamp)),
           MAX(COALESCE(client_timestamp, server_timestamp))) AS durationSecs,
         COUNT(*) AS eventCount,
         COUNT(DISTINCT url) AS pagesVisited,
         SUBSTRING_INDEX(GROUP_CONCAT(url ORDER BY id DESC SEPARATOR '||'), '||', 1) AS exitUrl,
         SUBSTRING_INDEX(GROUP_CONCAT(ip ORDER BY id DESC SEPARATOR '||'), '||', 1) AS ip,
         MAX(CASE WHEN type = 'submit_click' THEN 1 ELSE 0 END) = 1 AS submitted
       FROM events
       WHERE type != 'load' AND session_id IS NOT NULL
       GROUP BY session_id
       HAVING durationSecs >= ?
       ORDER BY ${orderCol} DESC
       LIMIT ?`,
      [minSeconds, limit]
    );
    if (!base.length) return res.json([]);

    const ids = base.map((r) => r.session_id);
    const placeholders = ids.map(() => '?').join(',');

    const [deviceRows] = await dbPool.query(
      `SELECT session_id,
              MAX(JSON_UNQUOTE(JSON_EXTRACT(payload, '$.staticData.userAgent'))) AS userAgent,
              MAX(JSON_UNQUOTE(JSON_EXTRACT(payload, '$.staticData.language'))) AS language,
              MAX(JSON_EXTRACT(payload, '$.staticData.screenWidth')) AS screenWidth,
              MAX(JSON_EXTRACT(payload, '$.staticData.screenHeight')) AS screenHeight,
              MAX(JSON_EXTRACT(payload, '$.staticData.windowWidth')) AS windowWidth,
              MAX(JSON_EXTRACT(payload, '$.staticData.windowHeight')) AS windowHeight,
              MAX(JSON_UNQUOTE(JSON_EXTRACT(payload, '$.staticData.connectionType'))) AS connectionType,
              MAX(is_bot) AS isBot
       FROM events
       WHERE type = 'load' AND session_id IN (${placeholders})
       GROUP BY session_id`,
      ids
    );
    const deviceBySession = {};
    deviceRows.forEach((r) => { deviceBySession[r.session_id] = r; });

    const [activityRows] = await dbPool.query(
      `SELECT session_id,
              SUM(JSON_LENGTH(payload, '$.mouseMoves')) AS totalMouseMoves,
              SUM(JSON_LENGTH(payload, '$.mouseClicks')) AS totalClicks,
              SUM(JSON_LENGTH(payload, '$.scrollEvents')) AS totalScrolls,
              SUM(JSON_LENGTH(payload, '$.idlePeriods')) AS totalIdlePeriods,
              SUM(JSON_LENGTH(payload, '$.errors')) AS totalErrors
       FROM events
       WHERE type = 'activity' AND session_id IN (${placeholders})
       GROUP BY session_id`,
      ids
    );
    const activityBySession = {};
    activityRows.forEach((r) => { activityBySession[r.session_id] = r; });

    // LogRocket's own product does full pixel-perfect session replay (DOM,
    // network, console), far richer than the coordinate-path replay above -
    // analytics.js sends its session URL through collector.track() as a
    // logrocket_session event, so it just needs surfacing here.
    const [logrocketRows] = await dbPool.query(
      `SELECT session_id, JSON_UNQUOTE(JSON_EXTRACT(payload, '$.logrocketUrl')) AS url
       FROM events
       WHERE type = 'logrocket_session' AND session_id IN (${placeholders})`,
      ids
    );
    const logrocketBySession = {};
    logrocketRows.forEach((r) => { logrocketBySession[r.session_id] = r.url; });

    const userNumberByIp = await lookupUserNumbers(base.map((r) => r.ip));

    res.json(base.map((r) => ({
      ...r,
      userNumber: r.ip ? (userNumberByIp[r.ip] ?? null) : null,
      device: deviceBySession[r.session_id] || null,
      activity: activityBySession[r.session_id] || null,
      logrocketUrl: logrocketBySession[r.session_id] || null
    })));
  } catch (err) {
    console.error('[GET /api/behavioral/top-sessions] error:', err.message);
    res.status(500).json({ error: 'database error' });
  }
});

// GET /api/behavioral/session-mouse/:sessionId - every recorded mouse
// move/click for one session, concatenated across however many 'activity'
// flushes it sent (collector.js flushes every 10s) and sorted back into
// time order, so it can be replayed as a single continuous path. Payloads
// are capped at 50KB each and a session realistically sends at most a few
// dozen flushes, so pulling and merging them in Node is cheap - no need
// for a database-side array-concatenation trick for this data size.
app.get('/api/behavioral/session-mouse/:sessionId', requireAuthApi, async (req, res) => {
  const sessionId = String(req.params.sessionId).slice(0, 64);
  // Optional ?url= scopes the replay to activity flushes recorded on that
  // one page - each 'activity' row already carries its own url column
  // (whichever page it was flushed from), so this is a plain equality
  // filter, not the block/gap reconstruction pageTime needs. Lets a
  // multi-page session (e.g. Home -> About Me -> Home) replay just the
  // portion spent on one specific page instead of the whole session.
  const pageUrl = typeof req.query.url === 'string' ? req.query.url : null;
  try {
    const [rows] = await dbPool.query(
      pageUrl
        ? "SELECT payload FROM events WHERE type = 'activity' AND session_id = ? AND url = ? ORDER BY id ASC"
        : "SELECT payload FROM events WHERE type = 'activity' AND session_id = ? ORDER BY id ASC",
      pageUrl ? [sessionId, pageUrl] : [sessionId]
    );
    let moves = [];
    let clicks = [];
    rows.forEach((r) => {
      const p = r.payload || {};
      if (Array.isArray(p.mouseMoves)) moves = moves.concat(p.mouseMoves);
      if (Array.isArray(p.mouseClicks)) clicks = clicks.concat(p.mouseClicks);
    });
    moves.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
    clicks.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
    res.json({ moves, clicks });
  } catch (err) {
    console.error('[GET /api/behavioral/session-mouse/:sessionId] error:', err.message);
    res.status(500).json({ error: 'database error' });
  }
});

// --- Advanced bot scoring ---
//
// The is_bot column is a fast, single-shot check (navigator.webdriver +
// a User-Agent regex) - both are things a bot author has to remember to
// spoof, and stealth automation tooling routinely does. This is a second,
// heavier classifier that combines multiple independent signal
// categories, weighted by how hard each is to fake, into one 0-100
// score instead of a single opaque boolean:
//
//   Self-reported environment (cheap to spoof, so low weight each):
//     - navigator.webdriver set                              (35)
//     - User-Agent matches a known bot/tool pattern           (25)
//     - zero browser plugins reported                         (8)
//     - zero or one navigator.languages entries                (7)
//
//   Behavioral trajectory (hard to fake - this is the actual "advanced"
//   part, since it reuses the raw mouseMoves/mouseClicks this site
//   already records rather than anything newly self-reported):
//     - clicks recorded with literally zero mouse movement     (15)
//       ever in the session - a human has to move the cursor
//       somewhere before clicking it; a script that calls
//       .click() directly never does.
//     - a high fraction of consecutive movement segments are    (7)
//       near-perfectly straight lines (< ~3.6 degrees of
//       direction change) - real hand movement constantly
//       micro-corrects; naive programmatic movement between
//       two points in a straight line does not.
//     - suspiciously regular timing between recorded mouse       (3)
//       moves (low coefficient of variation) - human timing is
//       bursty; scripted timing is often near-constant.
//
// Weights sum to 100. >=60 is reported as "likely bot", 30-59 as
// "uncertain", <30 as "likely human" - every contributing signal is
// returned too, so the classification is never a black box.
function collinearFraction(moves) {
  let straight = 0;
  let total = 0;
  for (let i = 2; i < moves.length; i++) {
    const a = moves[i - 2], b = moves[i - 1], c = moves[i];
    const dx1 = b.x - a.x, dy1 = b.y - a.y;
    const dx2 = c.x - b.x, dy2 = c.y - b.y;
    const len1 = Math.hypot(dx1, dy1), len2 = Math.hypot(dx2, dy2);
    if (len1 < 2 || len2 < 2) continue; // ignore near-stationary micro-jitter
    total++;
    const cosAngle = (dx1 * dx2 + dy1 * dy2) / (len1 * len2);
    if (cosAngle > 0.998) straight++; // < ~3.6 degrees of direction change
  }
  return total >= 5 ? straight / total : null; // not enough data to judge below that
}

function timingCoefficientOfVariation(moves) {
  if (moves.length < 6) return null;
  const intervals = [];
  for (let i = 1; i < moves.length; i++) {
    const dt = new Date(moves[i].timestamp) - new Date(moves[i - 1].timestamp);
    if (dt > 0 && dt < 5000) intervals.push(dt); // ignore gaps (tab switches, idle)
  }
  if (intervals.length < 5) return null;
  const mean = intervals.reduce((s, v) => s + v, 0) / intervals.length;
  const variance = intervals.reduce((s, v) => s + (v - mean) ** 2, 0) / intervals.length;
  return mean > 0 ? Math.sqrt(variance) / mean : null;
}

const BOT_UA_RE = /bot|crawl|spider|slurp|headless|phantom|selenium|puppeteer|playwright|curl\/|wget\/|python-requests|scrapy|go-http-client|okhttp|facebookexternalhit|bingpreview|whatsapp|telegrambot/i;

app.get('/api/behavioral/bot-score/:sessionId', requireAuthApi, async (req, res) => {
  const sessionId = String(req.params.sessionId).slice(0, 64);
  try {
    const [loadRows] = await dbPool.query(
      "SELECT payload FROM events WHERE type = 'load' AND session_id = ? ORDER BY id ASC LIMIT 1",
      [sessionId]
    );
    const [activityRows] = await dbPool.query(
      "SELECT payload FROM events WHERE type = 'activity' AND session_id = ? ORDER BY id ASC",
      [sessionId]
    );
    if (!loadRows.length) return res.status(404).json({ error: 'no load event for this session yet' });

    const staticData = (loadRows[0].payload || {}).staticData || {};
    let moves = [];
    let clicks = [];
    activityRows.forEach((r) => {
      const p = r.payload || {};
      if (Array.isArray(p.mouseMoves)) moves = moves.concat(p.mouseMoves);
      if (Array.isArray(p.mouseClicks)) clicks = clicks.concat(p.mouseClicks);
    });
    moves.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

    const signals = [];
    var score = 0;

    function addSignal(name, weight, triggered, note) {
      if (triggered) score += weight;
      signals.push({ signal: name, weight: weight, triggered: !!triggered, note: note });
    }

    addSignal('navigator.webdriver', 35, staticData.webdriver === true, 'Set by default under Selenium/Puppeteer/Playwright.');
    addSignal('user_agent_pattern', 25, BOT_UA_RE.test(staticData.userAgent || ''), 'Matches a known bot/crawler/tool substring.');
    addSignal('zero_plugins', 8, staticData.pluginsCount === 0, 'navigator.plugins.length === 0 - common in default headless configs.');
    addSignal('minimal_languages', 7, typeof staticData.languagesCount === 'number' && staticData.languagesCount <= 1, 'navigator.languages has 0-1 entries.');

    const clicksWithNoMovement = clicks.length > 0 && moves.length === 0;
    addSignal('clicks_without_movement', 15, clicksWithNoMovement, 'Clicks recorded but zero mouse movement ever - a human has to move the cursor there first.');

    const straightness = collinearFraction(moves);
    addSignal('linear_movement', 7, straightness !== null && straightness > 0.6,
      straightness !== null ? 'Fraction of near-perfectly-straight movement segments: ' + (straightness * 100).toFixed(1) + '%.' : 'Not enough movement data to judge.');

    const timingCV = timingCoefficientOfVariation(moves);
    addSignal('regular_timing', 3, timingCV !== null && timingCV < 0.15,
      timingCV !== null ? 'Coefficient of variation of move timing: ' + timingCV.toFixed(3) + ' (human timing is typically well above 0.3).' : 'Not enough movement data to judge.');

    const verdict = score >= 60 ? 'likely_bot' : score >= 30 ? 'uncertain' : 'likely_human';
    res.json({ sessionId: sessionId, score: score, verdict: verdict, signals: signals });
  } catch (err) {
    console.error('[GET /api/behavioral/bot-score/:sessionId] error:', err.message);
    res.status(500).json({ error: 'database error' });
  }
});

// --- Site-specific session metrics ---
//
// GET /api/behavioral/site-sessions?urlPrefix=&minSeconds=&limit= - one row
// per session that visited a given site, with total time, a per-page time
// breakdown, and click quality - not hardcoded to any one page, so it
// works for the test/music site today and the About Me or Projects pages
// later without a new endpoint each time.
//
// Per-page dwell time isn't a column anywhere - it's reconstructed from
// existing event timestamps. sessionStorage (where collector.js keeps the
// session id) is scoped per origin, so any session with an event under
// urlPrefix has ALL its events on that same site - no cross-site mixing
// to filter out. Consecutive same-URL events collapse into one "block";
// each block's dwell time is the gap until the next block starts (the
// last block runs to the session's last event). A session bouncing
// A -> B -> A sums both A-blocks together, so the per-page total is
// still correct even with back-and-forth navigation.
//
// "Useful clicks" relies on the `useful` flag collector.js now stamps on
// every click (landed on an actual interactive element vs. empty page
// space) - computed here from the raw activity payloads already being
// pulled for the page-time breakdown, not a second round trip.
// A site's root ("https://host/") and its default document
// ("https://host/index.html") are the same page, but different code paths
// report window.location.href differently (address-bar nav vs an internal
// link to the explicit filename) - without this they'd silently split one
// page's time across two buckets.
function normalizePageUrl(url) {
  return typeof url === 'string' ? url.replace(/index\.html$/, '') : url;
}

// Shared by every endpoint that resolves a batch of session/site rows'
// already-fetched `ip` values into "User N" labels (visitors.user_number) -
// one shared IN() lookup instead of a bespoke JOIN or repeated inline query
// in each endpoint, so a future endpoint just calls this rather than
// re-solving the same problem.
async function lookupUserNumbers(ips) {
  const distinctIps = [...new Set(ips.filter(Boolean))];
  if (!distinctIps.length) return {};
  const placeholders = distinctIps.map(() => '?').join(',');
  const [rows] = await dbPool.query(
    `SELECT ip, user_number FROM visitors WHERE ip IN (${placeholders})`,
    distinctIps
  );
  const byIp = {};
  rows.forEach((r) => { byIp[r.ip] = r.user_number; });
  return byIp;
}

function computePageBreakdown(rows) {
  const blocks = [];
  rows.forEach((r) => {
    const url = normalizePageUrl(r.url);
    const last = blocks[blocks.length - 1];
    if (last && last.url === url) {
      last.lastTs = r.ts;
    } else {
      blocks.push({ url: url, firstTs: r.ts, lastTs: r.ts });
    }
  });
  const pageTime = {};
  for (let i = 0; i < blocks.length; i++) {
    const start = new Date(blocks[i].firstTs);
    const end = i + 1 < blocks.length ? new Date(blocks[i + 1].firstTs) : new Date(blocks[i].lastTs);
    const secs = Math.max(0, (end - start) / 1000);
    pageTime[blocks[i].url] = (pageTime[blocks[i].url] || 0) + secs;
  }
  return pageTime;
}

app.get('/api/behavioral/site-sessions', requirePageApi('music'), async (req, res) => {
  const urlPrefix = typeof req.query.urlPrefix === 'string' ? req.query.urlPrefix : '';
  if (!urlPrefix) return res.status(400).json({ error: 'urlPrefix is required' });
  const minSeconds = Math.max(parseInt(req.query.minSeconds, 10) || 0, 0);
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 500);

  try {
    const [base] = await dbPool.query(
      `SELECT
         session_id,
         MIN(COALESCE(client_timestamp, server_timestamp)) AS firstSeen,
         MAX(COALESCE(client_timestamp, server_timestamp)) AS lastSeen,
         TIMESTAMPDIFF(SECOND,
           MIN(COALESCE(client_timestamp, server_timestamp)),
           MAX(COALESCE(client_timestamp, server_timestamp))) AS durationSecs,
         SUBSTRING_INDEX(GROUP_CONCAT(ip ORDER BY id DESC SEPARATOR '||'), '||', 1) AS ip,
         MAX(CASE WHEN type = 'submit_click' THEN 1 ELSE 0 END) = 1 AS submitted
       FROM events
       WHERE type != 'load' AND session_id IN (
         SELECT DISTINCT session_id FROM events WHERE url LIKE ? AND session_id IS NOT NULL
       )
       GROUP BY session_id
       HAVING durationSecs >= ?
       ORDER BY durationSecs DESC
       LIMIT ?`,
      [urlPrefix + '%', minSeconds, limit]
    );
    if (!base.length) return res.json([]);

    const ids = base.map((r) => r.session_id);
    const placeholders = ids.map(() => '?').join(',');

    // Lean columns for the page-time breakdown - no payload here, so this
    // stays cheap even for sessions with a lot of events.
    const [eventRows] = await dbPool.query(
      `SELECT session_id, url, COALESCE(client_timestamp, server_timestamp) AS ts
       FROM events
       WHERE type != 'load' AND session_id IN (${placeholders})
       ORDER BY session_id, id ASC`,
      ids
    );
    const eventsBySession = {};
    eventRows.forEach((r) => { (eventsBySession[r.session_id] = eventsBySession[r.session_id] || []).push(r); });

    // Payload only for 'activity' rows, since that's the only type carrying
    // mouseClicks - not dragging every row's JSON through the query above.
    const [activityRows] = await dbPool.query(
      `SELECT session_id, payload
       FROM events
       WHERE type = 'activity' AND session_id IN (${placeholders})`,
      ids
    );
    const clicksBySession = {};
    activityRows.forEach((r) => {
      const clicks = (r.payload || {}).mouseClicks;
      if (!Array.isArray(clicks)) return;
      const c = clicksBySession[r.session_id] || { total: 0, useful: 0 };
      clicks.forEach((click) => { c.total++; if (click.useful) c.useful++; });
      clicksBySession[r.session_id] = c;
    });

    const userNumberByIp = await lookupUserNumbers(base.map((r) => r.ip));

    // "Did this visitor also check out the main site during this visit?"
    // can't be answered by session_id at all - sessionStorage (and
    // therefore session_id) is scoped per origin, so a test.
    // shekarkrishnamoorthy.com session can never literally share a
    // session_id with a shekarkrishnamoorthy.com one, by construction. IP
    // is the only cross-origin signal available (the same one User N
    // identity is already built on) - "yes" means this visitor's IP has
    // been seen on the main domain at some point, not necessarily during
    // this exact visit window.
    const ips = [...new Set(base.map((r) => r.ip).filter(Boolean))];
    let mainDomainIps = new Set();
    if (ips.length) {
      const ipPlaceholders = ips.map(() => '?').join(',');
      const [mainDomainRows] = await dbPool.query(
        `SELECT DISTINCT ip FROM events WHERE url LIKE 'https://shekarkrishnamoorthy.com/%' AND ip IN (${ipPlaceholders})`,
        ips
      );
      mainDomainIps = new Set(mainDomainRows.map((r) => r.ip));
    }

    res.json(base.map((r) => ({
      session_id: r.session_id,
      ip: r.ip,
      userNumber: r.ip ? (userNumberByIp[r.ip] ?? null) : null,
      firstSeen: r.firstSeen,
      lastSeen: r.lastSeen,
      durationSecs: r.durationSecs,
      submitted: r.submitted,
      returnedToMainDomain: r.ip ? mainDomainIps.has(r.ip) : null,
      pageTime: computePageBreakdown(eventsBySession[r.session_id] || []),
      totalClicks: (clicksBySession[r.session_id] || { total: 0 }).total,
      usefulClicks: (clicksBySession[r.session_id] || { useful: 0 }).useful
    })));
  } catch (err) {
    console.error('[GET /api/behavioral/site-sessions] error:', err.message);
    res.status(500).json({ error: 'database error' });
  }
});

// GET /api/behavioral/page-visits?url=&minSeconds=&limit= - sessions that
// visited one specific page, with the time spent on JUST that page (not
// the whole session). Different from site-sessions above: a page like
// About Me shares its origin (and therefore session id, since
// sessionStorage is per-origin) with the rest of the main site, so a
// session visiting it could easily have spent most of its time elsewhere
// - "time on this site" would be the wrong number to report. Reuses the
// same block/gap reconstruction as computePageBreakdown, then reports
// just the one page's total instead of every page's.
//
// Click counts here are a plain WHERE url = ? filter, not the
// reconstruction - each 'activity' row already carries its own url
// column (whichever page it was flushed from).
//
// Shared by both About Me and Projects, so it can't be gated by a fixed
// page like the other endpoints - the required scope is derived from the
// url param itself against PAGE_SCOPE_BY_URL (a server-controlled lookup,
// not a client-supplied scope name) so a request for one page's data can't
// be waved through by claiming to be about the other.
app.get('/api/behavioral/page-visits', requireAuthApi, async (req, res) => {
  const pageUrl = typeof req.query.url === 'string' ? req.query.url : '';
  if (!pageUrl) return res.status(400).json({ error: 'url is required' });
  const requiredPage = PAGE_SCOPE_BY_URL[pageUrl];
  if (!requiredPage) return res.status(400).json({ error: 'unrecognized url' });
  if (req.session.role === 'viewer') return res.status(403).json({ error: `no access to page: ${requiredPage}` });
  const allowedPages = await getAllowedPages(req.session);
  if (!allowedPages.includes(requiredPage)) return res.status(403).json({ error: `no access to page: ${requiredPage}` });
  const normalizedTarget = normalizePageUrl(pageUrl);
  const minSeconds = Math.max(parseInt(req.query.minSeconds, 10) || 0, 0);
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 500);

  try {
    const [sessionIdRows] = await dbPool.query(
      `SELECT session_id, SUBSTRING_INDEX(GROUP_CONCAT(ip ORDER BY id DESC SEPARATOR '||'), '||', 1) AS ip
       FROM events WHERE url = ? AND session_id IS NOT NULL GROUP BY session_id`,
      [pageUrl]
    );
    if (!sessionIdRows.length) return res.json([]);
    const ids = sessionIdRows.map((r) => r.session_id);
    const ipBySession = {};
    sessionIdRows.forEach((r) => { ipBySession[r.session_id] = r.ip; });
    const placeholders = ids.map(() => '?').join(',');

    // Full session context is needed here (not just this page's own rows) -
    // a block's dwell time depends on when the NEXT block (possibly a
    // different page) starts.
    const [eventRows] = await dbPool.query(
      `SELECT session_id, url, COALESCE(client_timestamp, server_timestamp) AS ts
       FROM events
       WHERE type != 'load' AND session_id IN (${placeholders})
       ORDER BY session_id, id ASC`,
      ids
    );
    const eventsBySession = {};
    eventRows.forEach((r) => { (eventsBySession[r.session_id] = eventsBySession[r.session_id] || []).push(r); });

    const [activityRows] = await dbPool.query(
      `SELECT session_id, payload
       FROM events
       WHERE type = 'activity' AND url = ? AND session_id IN (${placeholders})`,
      [pageUrl, ...ids]
    );
    const clicksBySession = {};
    activityRows.forEach((r) => {
      const clicks = (r.payload || {}).mouseClicks;
      if (!Array.isArray(clicks)) return;
      const c = clicksBySession[r.session_id] || { total: 0, useful: 0 };
      clicks.forEach((click) => { c.total++; if (click.useful) c.useful++; });
      clicksBySession[r.session_id] = c;
    });

    const userNumberByIp = await lookupUserNumbers(Object.values(ipBySession));

    const results = ids.map((sessionId) => {
      const pageTime = computePageBreakdown(eventsBySession[sessionId] || []);
      const durationOnPage = pageTime[normalizedTarget] || 0;
      const clicks = clicksBySession[sessionId] || { total: 0, useful: 0 };
      const ip = ipBySession[sessionId];
      return {
        session_id: sessionId,
        ip: ip || null,
        userNumber: ip ? (userNumberByIp[ip] ?? null) : null,
        durationOnPageSecs: Math.round(durationOnPage),
        totalClicks: clicks.total,
        usefulClicks: clicks.useful
      };
    }).filter((r) => r.durationOnPageSecs >= minSeconds)
      .sort((a, b) => b.durationOnPageSecs - a.durationOnPageSecs)
      .slice(0, limit);

    res.json(results);
  } catch (err) {
    console.error('[GET /api/behavioral/page-visits] error:', err.message);
    res.status(500).json({ error: 'database error' });
  }
});

// GET /api/behavioral/project-popularity - click counts per project on the
// Projects page, most-clicked first - including projects with zero clicks,
// not just the ones someone happened to click. Click counts alone can only
// ever mention a project that's been clicked at least once; "which
// projects exist at all" comes from a separate project_page_view event
// projects.html fires once per page view with its full current project
// list (see important/projects.html), so a project someone never clicked
// still shows up with clicks: 0 instead of being silently missing.
//
// Uses the MOST RECENT page_view's list as "current" (not every title
// ever seen across history) - if a project is later removed from the
// page, it should stop appearing here too. Any project with click history
// that isn't in that latest list (e.g. removed since, or its page_view
// hasn't landed yet) still gets included - old click history doesn't just
// disappear because the list changed.
app.get('/api/behavioral/project-popularity', requirePageApi('projects'), async (req, res) => {
  try {
    const [[latestPageView]] = await dbPool.query(
      "SELECT payload FROM events WHERE type = 'project_page_view' ORDER BY id DESC LIMIT 1"
    );
    const knownTitles = latestPageView && Array.isArray(latestPageView.payload.projectTitles)
      ? latestPageView.payload.projectTitles
      : [];

    const [clickRows] = await dbPool.query(`
      SELECT JSON_UNQUOTE(JSON_EXTRACT(payload, '$.projectTitle')) AS projectTitle, COUNT(*) AS clicks
      FROM events
      WHERE type = 'project_click' AND JSON_EXTRACT(payload, '$.projectTitle') IS NOT NULL
      GROUP BY projectTitle
    `);
    const clicksByTitle = {};
    clickRows.forEach((r) => { clicksByTitle[r.projectTitle] = r.clicks; });

    const allTitles = new Set([...knownTitles, ...Object.keys(clicksByTitle)]);
    const rows = [...allTitles]
      .map((projectTitle) => ({ projectTitle, clicks: clicksByTitle[projectTitle] || 0 }))
      .sort((a, b) => b.clicks - a.clicks);

    res.json(rows);
  } catch (err) {
    console.error('[GET /api/behavioral/project-popularity] error:', err.message);
    res.status(500).json({ error: 'database error' });
  }
});

// GET /api/behavioral/project-click-sequence?limit= - for each session that
// clicked at least one project, the ordered list of which projects (and
// when) it clicked - the chronological click path per visitor, as opposed
// to project-popularity's aggregate counts above.
app.get('/api/behavioral/project-click-sequence', requirePageApi('projects'), async (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 200);
  try {
    const [sessionRows] = await dbPool.query(
      `SELECT session_id,
              SUBSTRING_INDEX(GROUP_CONCAT(ip ORDER BY id DESC SEPARATOR '||'), '||', 1) AS ip,
              MAX(COALESCE(client_timestamp, server_timestamp)) AS lastClick
       FROM events
       WHERE type = 'project_click' AND session_id IS NOT NULL
       GROUP BY session_id
       ORDER BY lastClick DESC
       LIMIT ?`,
      [limit]
    );
    if (!sessionRows.length) return res.json([]);
    const ids = sessionRows.map((r) => r.session_id);
    const placeholders = ids.map(() => '?').join(',');

    const [clickRows] = await dbPool.query(
      `SELECT session_id,
              JSON_UNQUOTE(JSON_EXTRACT(payload, '$.projectTitle')) AS projectTitle,
              COALESCE(client_timestamp, server_timestamp) AS ts
       FROM events
       WHERE type = 'project_click' AND session_id IN (${placeholders})
       ORDER BY session_id, id ASC`,
      ids
    );
    const bySession = {};
    clickRows.forEach((r) => {
      (bySession[r.session_id] = bySession[r.session_id] || []).push({ projectTitle: r.projectTitle, timestamp: r.ts });
    });

    // Last recorded moment on the Projects page itself (any event type, not
    // just clicks) for each of these sessions - lets the frontend show how
    // long they stuck around after their last click, not just the gaps
    // between clicks.
    const [lastSeenRows] = await dbPool.query(
      `SELECT session_id, MAX(COALESCE(client_timestamp, server_timestamp)) AS lastSeenOnPage
       FROM events
       WHERE url = 'https://shekarkrishnamoorthy.com/important/projects.html' AND session_id IN (${placeholders})
       GROUP BY session_id`,
      ids
    );
    const lastSeenBySession = {};
    lastSeenRows.forEach((r) => { lastSeenBySession[r.session_id] = r.lastSeenOnPage; });

    const userNumberByIp = await lookupUserNumbers(sessionRows.map((r) => r.ip));
    res.json(sessionRows.map((r) => ({
      session_id: r.session_id,
      userNumber: r.ip ? (userNumberByIp[r.ip] ?? null) : null,
      clicks: bySession[r.session_id] || [],
      lastSeenOnPage: lastSeenBySession[r.session_id] || null
    })));
  } catch (err) {
    console.error('[GET /api/behavioral/project-click-sequence] error:', err.message);
    res.status(500).json({ error: 'database error' });
  }
});

// --- Saved reports ---
//
// A report is now a PDF someone generated (and optionally marked up) from a
// specific dashboard page, not a live query definition - reports.html shows
// just a table of these; the query-builder UI that used to live there is
// gone. Every report is tagged with the page it was generated from, and
// visibility follows the same page-access rule the page itself uses:
// super_admin sees everything, an analyst sees a report from a scoped page
// (music/about-me/projects) only if they currently have that page's scope,
// and Dashboard/Performance reports (no scoped page behind them) are
// visible to any analyst. Viewers are the one exception - "a viewer can
// only look at saved reports" was never qualified by section, so a viewer
// still sees every report regardless of source page; they just can never
// create one.
const REPORT_SOURCE_PAGES = ['dashboard', 'performance', 'music', 'about-me', 'projects'];

function requiredScopeForReportPage(sourcePage) {
  return SCOPABLE_PAGES.includes(sourcePage) ? sourcePage : null; // dashboard/performance: no scope needed
}

async function canViewReport(session, sourcePage) {
  if (!REPORT_SOURCE_PAGES.includes(sourcePage)) return false;
  if (session.role === 'super_admin' || session.role === 'viewer') return true;
  const required = requiredScopeForReportPage(sourcePage);
  if (!required) return true;
  const allowed = await getAllowedPages(session);
  return allowed.includes(required);
}

async function canGenerateReport(session, sourcePage) {
  if (!REPORT_SOURCE_PAGES.includes(sourcePage)) return false;
  if (session.role === 'super_admin') return true;
  if (session.role !== 'analyst') return false;
  const required = requiredScopeForReportPage(sourcePage);
  if (!required) return true;
  const allowed = await getAllowedPages(session);
  return allowed.includes(required);
}

// PDFs live on disk, not in MySQL - a DB row just holds where to find one
// plus its metadata. file_name is always a server-generated random name
// (never derived from the client-supplied report name), so nothing about
// the request body can influence which path on disk gets written to or
// read from.
const REPORTS_DIR = path.join(__dirname, 'report-files');
fs.mkdirSync(REPORTS_DIR, { recursive: true });

// GET /api/reports - list every report this caller can see (see
// canViewReport above for exactly who that is per role/page).
app.get('/api/reports', async (req, res) => {
  try {
    const [rows] = await dbPool.query(
      `SELECT r.id, r.name, r.notes, r.source_page AS sourcePage, r.created_at AS createdAt, u.username AS createdBy
       FROM saved_reports r JOIN users u ON u.id = r.created_by
       ORDER BY r.created_at DESC`
    );
    const checks = await Promise.all(rows.map((r) => canViewReport(req.session, r.sourcePage)));
    res.json(rows.filter((_, i) => checks[i]));
  } catch (err) {
    console.error('[GET /api/reports] error:', err.message);
    res.status(500).json({ error: 'database error' });
  }
});

// GET /api/reports/:id/file - streams the PDF itself (opened inline, not
// forced as a download, so a click just opens it in the browser's own PDF
// viewer).
app.get('/api/reports/:id/file', async (req, res) => {
  const id = parseId(req, res);
  if (id === null) return;
  try {
    const [rows] = await dbPool.query('SELECT name, source_page AS sourcePage, file_name AS fileName FROM saved_reports WHERE id = ?', [id]);
    if (!rows.length) return res.status(404).json({ error: 'not found' });
    const report = rows[0];
    if (!(await canViewReport(req.session, report.sourcePage))) {
      return res.status(403).json({ error: 'no access to this report' });
    }
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="' + report.name.replace(/[^\w.-]/g, '_').slice(0, 200) + '.pdf"');
    res.sendFile(path.join(REPORTS_DIR, report.fileName), (err) => {
      if (err && !res.headersSent) res.status(404).json({ error: 'report file missing' });
    });
  } catch (err) {
    console.error('[GET /api/reports/:id/file] error:', err.message);
    res.status(500).json({ error: 'database error' });
  }
});

// POST /api/reports - save a newly generated (and possibly annotated) PDF.
// Body carries the finished PDF as a base64 string, not a multipart upload
// - it's already produced client-side (html2canvas + jsPDF), so this just
// needs a JSON endpoint, not a new upload-handling dependency.
app.post('/api/reports', requireRoleApi('super_admin', 'analyst'), async (req, res) => {
  const body = req.body || {};
  const name = typeof body.name === 'string' ? body.name.trim().slice(0, 255) : '';
  const notes = typeof body.notes === 'string' ? body.notes.slice(0, 5000) : '';
  const sourcePage = typeof body.sourcePage === 'string' ? body.sourcePage : '';
  const pdfBase64 = typeof body.pdfBase64 === 'string' ? body.pdfBase64 : '';

  if (!name) return res.status(400).json({ error: 'name is required' });
  if (!REPORT_SOURCE_PAGES.includes(sourcePage)) return res.status(400).json({ error: 'sourcePage must be one of: ' + REPORT_SOURCE_PAGES.join(', ') });
  if (!pdfBase64) return res.status(400).json({ error: 'pdfBase64 is required' });

  if (!(await canGenerateReport(req.session, sourcePage))) {
    return res.status(403).json({ error: 'no access to generate a report from this page' });
  }

  let buffer;
  try {
    buffer = Buffer.from(pdfBase64, 'base64');
  } catch {
    return res.status(400).json({ error: 'invalid pdfBase64' });
  }
  if (!buffer.length || buffer.length > 15 * 1024 * 1024) {
    return res.status(413).json({ error: 'PDF must be non-empty and under 15MB' });
  }
  if (buffer.slice(0, 5).toString('latin1') !== '%PDF-') {
    flagClient(req, 'invalid_report_upload', { reason: 'does not start with %PDF-', sizeBytes: buffer.length });
    return res.status(400).json({ error: 'not a valid PDF' });
  }

  const fileName = crypto.randomBytes(16).toString('hex') + '.pdf';
  try {
    await fs.promises.writeFile(path.join(REPORTS_DIR, fileName), buffer);
    const [result] = await dbPool.execute(
      'INSERT INTO saved_reports (name, notes, source_page, file_name, created_by) VALUES (?, ?, ?, ?, ?)',
      [name, notes, sourcePage, fileName, req.session.userId]
    );
    res.status(201).json({ id: result.insertId, name, notes, sourcePage, createdBy: req.session.username });
  } catch (err) {
    console.error('[POST /api/reports] error:', err.message);
    res.status(500).json({ error: 'failed to save report' });
  }
});

// DELETE /api/reports/:id - super_admin can delete any report; an analyst
// only their own, and only from a page they still have access to generate
// from (mirrors the old canManageReport rule, just re-keyed on page scope
// instead of section).
app.delete('/api/reports/:id', requireRoleApi('super_admin', 'analyst'), async (req, res) => {
  const id = parseId(req, res);
  if (id === null) return;

  try {
    const [rows] = await dbPool.query('SELECT * FROM saved_reports WHERE id = ?', [id]);
    if (!rows.length) return res.status(404).json({ error: 'not found' });
    const report = rows[0];

    const canManage = req.session.role === 'super_admin' ||
      (report.created_by === req.session.userId && (await canGenerateReport(req.session, report.source_page)));
    if (!canManage) return res.status(403).json({ error: 'you do not have permission to delete this report' });

    await dbPool.execute('DELETE FROM saved_reports WHERE id = ?', [id]);
    await fs.promises.unlink(path.join(REPORTS_DIR, report.file_name)).catch(() => {});
    res.sendStatus(204);
  } catch (err) {
    console.error('[DELETE /api/reports/:id] error:', err.message);
    res.status(500).json({ error: 'database error' });
  }
});

// --- Flagged clients ---
//
// Read access, super_admin only - this is who-did-what-suspicious data
// (IPs, user agents, attempted usernames), not a business-analytics
// section, so it doesn't fit the performance/behavioral scope model at all.
app.get('/api/flagged-clients', requireRoleApi('super_admin'), async (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 1000);
  try {
    const [rows] = await dbPool.query(
      'SELECT id, ip, user_agent, reason, endpoint, method, session_id, details, flagged_at FROM flagged_clients ORDER BY id DESC LIMIT ?',
      [limit]
    );
    res.json(rows);
  } catch (err) {
    console.error('[GET /api/flagged-clients] error:', err.message);
    res.status(500).json({ error: 'database error' });
  }
});

// --- User management ---
//
// Full CRUD on the `users` table, super_admin only - "A super admin can do
// anything, including managing users." Includes each analyst's page scopes
// (empty array = unrestricted, same convention the old section scopes used).

async function getScopesByUser(userIds) {
  if (!userIds.length) return {};
  const [rows] = await dbPool.query(
    `SELECT user_id, page FROM user_scopes WHERE user_id IN (${userIds.map(() => '?').join(',')})`,
    userIds
  );
  const out = {};
  rows.forEach((r) => { (out[r.user_id] = out[r.user_id] || []).push(r.page); });
  return out;
}

function validateScopes(scopes) {
  if (scopes === undefined) return [];
  if (!Array.isArray(scopes)) return null;
  if (!scopes.every((s) => SCOPABLE_PAGES.includes(s))) return null;
  return scopes;
}

async function setUserScopes(userId, scopes) {
  await dbPool.execute('DELETE FROM user_scopes WHERE user_id = ?', [userId]);
  if (scopes.length) {
    const values = scopes.map(() => '(?, ?)').join(',');
    const params = scopes.flatMap((s) => [userId, s]);
    await dbPool.execute(`INSERT INTO user_scopes (user_id, page) VALUES ${values}`, params);
  }
}

const USER_FIELDS = 'id, username, role, created_at';

app.get('/api/users', requireRoleApi('super_admin'), async (req, res) => {
  try {
    const [rows] = await dbPool.query(`SELECT ${USER_FIELDS} FROM users ORDER BY id`);
    const scopesByUser = await getScopesByUser(rows.map((u) => u.id));
    res.json(rows.map((u) => ({ ...u, scopes: scopesByUser[u.id] || [] })));
  } catch (err) {
    console.error('[GET /api/users] error:', err.message);
    res.status(500).json({ error: 'database error' });
  }
});

app.get('/api/users/:id', requireRoleApi('super_admin'), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'id must be a positive integer' });
  try {
    const [rows] = await dbPool.query(`SELECT ${USER_FIELDS} FROM users WHERE id = ?`, [id]);
    if (!rows.length) return res.status(404).json({ error: 'not found' });
    const scopesByUser = await getScopesByUser([id]);
    res.json({ ...rows[0], scopes: scopesByUser[id] || [] });
  } catch (err) {
    console.error('[GET /api/users/:id] error:', err.message);
    res.status(500).json({ error: 'database error' });
  }
});

app.post('/api/users', requireRoleApi('super_admin'), async (req, res) => {
  const body = req.body || {};
  if ('id' in body) return res.status(400).json({ error: 'POST must not include an id - the database assigns one' });
  if (typeof body.username !== 'string' || !body.username) return res.status(400).json({ error: 'username is required' });
  if (typeof body.password !== 'string' || body.password.length < 8) {
    return res.status(400).json({ error: 'password is required and must be at least 8 characters' });
  }
  if (!['super_admin', 'analyst', 'viewer'].includes(body.role)) {
    return res.status(400).json({ error: 'role must be one of: super_admin, analyst, viewer' });
  }
  const scopes = validateScopes(body.scopes);
  if (scopes === null) return res.status(400).json({ error: 'scopes must be an array of: ' + SCOPABLE_PAGES.join(', ') });

  try {
    const hash = await bcrypt.hash(body.password, 10);
    const [result] = await dbPool.execute(
      'INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)',
      [body.username.slice(0, 64), hash, body.role]
    );
    if (body.role === 'analyst' && scopes.length) await setUserScopes(result.insertId, scopes);

    const [rows] = await dbPool.query(`SELECT ${USER_FIELDS} FROM users WHERE id = ?`, [result.insertId]);
    res.status(201).json({ ...rows[0], scopes: body.role === 'analyst' ? scopes : [] });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ error: 'username already exists' });
    }
    console.error('[POST /api/users] error:', err.message);
    res.status(500).json({ error: 'database error' });
  }
});

app.put('/api/users/:id', requireRoleApi('super_admin'), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'id must be a positive integer' });

  const body = req.body || {};
  const fields = [];
  const params = [];

  if (typeof body.username === 'string' && body.username) { fields.push('username = ?'); params.push(body.username.slice(0, 64)); }
  if (body.role !== undefined) {
    if (!['super_admin', 'analyst', 'viewer'].includes(body.role)) {
      return res.status(400).json({ error: 'role must be one of: super_admin, analyst, viewer' });
    }
    fields.push('role = ?'); params.push(body.role);
  }
  if (typeof body.password === 'string' && body.password) {
    if (body.password.length < 8) return res.status(400).json({ error: 'password must be at least 8 characters' });
    fields.push('password_hash = ?');
    params.push(await bcrypt.hash(body.password, 10));
  }

  const scopes = validateScopes(body.scopes);
  if (scopes === null) return res.status(400).json({ error: 'scopes must be an array of: ' + SCOPABLE_PAGES.join(', ') });

  if (!fields.length && body.scopes === undefined) return res.status(400).json({ error: 'no updatable fields provided' });

  try {
    if (fields.length) {
      const [result] = await dbPool.execute(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`, [...params, id]);
      if (!result.affectedRows) return res.status(404).json({ error: 'not found' });
    } else {
      const [existing] = await dbPool.query('SELECT id FROM users WHERE id = ?', [id]);
      if (!existing.length) return res.status(404).json({ error: 'not found' });
    }
    if (body.scopes !== undefined) await setUserScopes(id, scopes);

    const [rows] = await dbPool.query(`SELECT ${USER_FIELDS} FROM users WHERE id = ?`, [id]);
    const scopesByUser = await getScopesByUser([id]);
    res.json({ ...rows[0], scopes: scopesByUser[id] || [] });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ error: 'username already exists' });
    }
    console.error('[PUT /api/users/:id] error:', err.message);
    res.status(500).json({ error: 'database error' });
  }
});

app.delete('/api/users/:id', requireRoleApi('super_admin'), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'id must be a positive integer' });
  if (req.session.userId === id) {
    return res.status(400).json({ error: 'cannot delete your own currently logged-in account' });
  }
  try {
    const [result] = await dbPool.execute('DELETE FROM users WHERE id = ?', [id]);
    if (!result.affectedRows) return res.status(404).json({ error: 'not found' });
    res.sendStatus(204);
  } catch (err) {
    console.error('[DELETE /api/users/:id] error:', err.message);
    res.status(500).json({ error: 'database error' });
  }
});

// --- Page serving ---
//
// Apache proxies the entire vhost here now (not just /api/ and /auth/), so
// this app owns serving every page - which is what lets login actually be
// enforced server-side instead of just hiding a link client-side. The pages
// live in ./pages, outside anything Apache would otherwise serve as a
// static file directly (deploy-site.sh excludes /nodejs from the rsync into
// public_html), so res.sendFile is the only way they're reachable.
const PAGES_DIR = path.join(__dirname, 'pages');

// report-generator.js is shared by every page with a "Generate Report"
// button (Dashboard, Music/About Me/Projects metrics, Performance) - one
// file, one static route, rather than duplicating the capture/annotate/
// upload flow inline in five separate pages. It carries no sensitive data
// itself (same reasoning as collector.js being public), so it isn't gated
// behind requireAuthPage the way the pages that load it are.
app.use('/assets', express.static(path.join(PAGES_DIR, 'assets')));

// Dashboard and Reports are the baseline pages every authenticated role
// (viewer included) can reach - so there's no longer a role-dependent
// landing page to pick between; everyone lands on the Dashboard.
app.get('/', (req, res) => {
  if (!req.session) return res.redirect('/login.html');
  res.redirect('/index.html');
});

app.get('/login.html', (req, res) => {
  if (req.session) return res.redirect('/index.html');
  res.sendFile(path.join(PAGES_DIR, 'login.html'));
});

app.get('/logout.html', (req, res) => {
  res.sendFile(path.join(PAGES_DIR, 'logout.html'));
});

app.get('/index.html', requireAuthPage, (req, res) => {
  res.sendFile(path.join(PAGES_DIR, 'index.html'));
});

app.get('/users.html', requireRolePage('super_admin'), (req, res) => {
  res.sendFile(path.join(PAGES_DIR, 'users.html'));
});

// Not linked from any nav under the current page model (it predates it) -
// still reachable directly by anyone who could already reach it before,
// left as-is rather than removed since nothing links to it to be wrong.
app.get('/performance.html', requireRolePage('super_admin', 'analyst'), (req, res) => {
  res.sendFile(path.join(PAGES_DIR, 'performance.html'));
});

app.get('/music.html', requirePagePage('music'), (req, res) => {
  res.sendFile(path.join(PAGES_DIR, 'music.html'));
});

app.get('/about-me.html', requirePagePage('about-me'), (req, res) => {
  res.sendFile(path.join(PAGES_DIR, 'about-me.html'));
});

app.get('/projects.html', requirePagePage('projects'), (req, res) => {
  res.sendFile(path.join(PAGES_DIR, 'projects.html'));
});

// Baseline page for all three roles, like the Dashboard - just a table of
// saved reports now (see canViewReport for who sees which rows). Reports
// themselves are generated from each individual metrics page's own
// "Generate Report" button, not from anything on this page.
app.get('/reports.html', requireAuthPage, (req, res) => {
  res.sendFile(path.join(PAGES_DIR, 'reports.html'));
});

const PORT = process.env.PORT || 3011;
app.listen(PORT, '127.0.0.1', () => {
  console.log(`Reporting API listening on 127.0.0.1:${PORT}`);
});
