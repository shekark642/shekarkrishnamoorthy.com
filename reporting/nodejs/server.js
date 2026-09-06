const express = require('express');
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const path = require('path');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 'loopback');
app.use(express.json());

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

// --- Sessions (HW4 auth) ---
//
// In-memory, same durability tradeoff already used elsewhere in this project
// (HW2's state-nodejs, the fingerprint demo) - fine for this assignment's
// scope; a process restart logs everyone out, nothing more.
const sessions = new Map(); // token -> { userId, username, isAdmin }
const SESSION_COOKIE = 'reporting_session';

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
app.use((req, res, next) => {
  const cookies = parseCookies(req.headers.cookie);
  const token = cookies[SESSION_COOKIE];
  req.session = token && sessions.has(token) ? sessions.get(token) : null;
  next();
});

// Two flavors of each guard: API routes get a JSON 401/403 (so fetch() calls
// can handle it programmatically), page routes get redirected to the login
// screen (so a browser navigating there directly lands somewhere sensible).
function requireAuthApi(req, res, next) {
  if (!req.session) return res.status(401).json({ error: 'not logged in' });
  next();
}
function requireAdminApi(req, res, next) {
  if (!req.session) return res.status(401).json({ error: 'not logged in' });
  if (!req.session.isAdmin) return res.status(403).json({ error: 'admin access required' });
  next();
}
function requireAuthPage(req, res, next) {
  if (!req.session) return res.redirect('/login.html');
  next();
}
function requireAdminPage(req, res, next) {
  if (!req.session) return res.redirect('/login.html');
  if (!req.session.isAdmin) return res.status(403).type('html').send('<h1>403 Forbidden</h1><p>Admin access required.</p>');
  next();
}

// --- Auth routes ---

app.post('/auth/login', async (req, res) => {
  const body = req.body || {};
  const usernameOrEmail = body.usernameOrEmail;
  const password = body.password;
  if (typeof usernameOrEmail !== 'string' || !usernameOrEmail || typeof password !== 'string' || !password) {
    return res.status(400).json({ error: 'usernameOrEmail and password are required' });
  }

  try {
    const [rows] = await dbPool.query(
      'SELECT id, username, password_hash, is_admin FROM users WHERE username = ? OR email = ? LIMIT 1',
      [usernameOrEmail, usernameOrEmail]
    );
    if (!rows.length) return res.status(401).json({ error: 'invalid username/email or password' });

    const user = rows[0];
    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) return res.status(401).json({ error: 'invalid username/email or password' });

    const token = crypto.randomBytes(32).toString('hex');
    sessions.set(token, { userId: user.id, username: user.username, isAdmin: !!user.is_admin });

    res.cookie(SESSION_COOKIE, token, {
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
      maxAge: 24 * 60 * 60 * 1000,
      path: '/'
    });
    res.json({ success: true, username: user.username, isAdmin: !!user.is_admin });
  } catch (err) {
    console.error('[POST /auth/login] error:', err.message);
    res.status(500).json({ error: 'server error' });
  }
});

app.post('/auth/logout', (req, res) => {
  const cookies = parseCookies(req.headers.cookie);
  const token = cookies[SESSION_COOKIE];
  if (token) sessions.delete(token);
  res.clearCookie(SESSION_COOKIE, { path: '/' });
  res.json({ success: true });
});

app.get('/auth/me', requireAuthApi, (req, res) => {
  res.json({ username: req.session.username, isAdmin: req.session.isAdmin });
});

// The reporting dashboard fetches these same-origin (it's served by this
// same app - see the page routes further down), so CORS isn't actually
// needed for normal use. It's kept permissive for non-browser tools
// (curl/Postman) that don't enforce CORS anyway; the real access control is
// requireAuthApi below, not this header - CORS only affects whether a
// *browser* running someone else's JS can read the response, not whether a
// request reaches the server at all.
app.use('/api', (req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Every /api/* route requires a logged-in session - this is what actually
// stops a grader (or anyone else) from reading report data without logging
// in first, since hitting the API directly would otherwise bypass a
// login wall that only gated the HTML pages.
app.use('/api', requireAuthApi);

// Resource: /api/events, mapping directly onto the `events` table the
// collector's /collect endpoint writes into (session_id, type, url, ip,
// client_timestamp, server_timestamp, payload). A single flexible table
// with a JSON payload column, rather than separate static/performance/
// activity tables, was the Storage choice made in the collector phase -
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

// GET /api/events - every entry, optionally filtered by ?type= and/or
// ?session=, paginated with ?limit=&offset= (default 100 / 0).
app.get('/api/events', async (req, res) => {
  const clauses = [];
  const params = [];

  if (typeof req.query.type === 'string') {
    clauses.push('type = ?');
    params.push(req.query.type);
  }
  if (typeof req.query.session === 'string') {
    clauses.push('session_id = ?');
    params.push(req.query.session);
  }

  const where = clauses.length ? 'WHERE ' + clauses.join(' AND ') : '';
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 1000);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

  try {
    const [rows] = await dbPool.query(
      `SELECT id, session_id, type, url, ip, client_timestamp, server_timestamp, payload
       FROM events ${where} ORDER BY id DESC LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );
    res.json(rows);
  } catch (err) {
    console.error('[GET /api/events] error:', err.message);
    res.status(500).json({ error: 'database error' });
  }
});

// GET /api/events/:id - a single entry by id.
app.get('/api/events/:id', async (req, res) => {
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
app.post('/api/events', async (req, res) => {
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
app.put('/api/events/:id', async (req, res) => {
  const id = parseId(req, res);
  if (id === null) return;

  const body = req.body || {};
  const payloadCheck = checkPayload(body.payload);
  if (!payloadCheck.ok) {
    return res.status(payloadCheck.status).json({ error: payloadCheck.error });
  }

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

  try {
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
app.delete('/api/events/:id', async (req, res) => {
  const id = parseId(req, res);
  if (id === null) return;

  try {
    const [result] = await dbPool.execute('DELETE FROM events WHERE id = ?', [id]);
    if (!result.affectedRows) return res.status(404).json({ error: 'not found' });
    res.sendStatus(204);
  } catch (err) {
    console.error('[DELETE /api/events/:id] error:', err.message);
    res.status(500).json({ error: 'database error' });
  }
});

// GET /api/reports/summary - the "heavy SQL, static visualization" pattern:
// every number here is computed in MySQL (COUNT/AVG/GROUP BY), so the
// response is already the finished answer - a dashboard just renders it,
// no client-side computation needed no matter how many rows are behind it.
//
// This isn't limited to analytics-shaped data. The four indexed generated
// columns (total_load_time_ms, lcp_value, cls_value, inp_value) are fast
// paths for the metrics the collector happens to produce today, but
// ?metricPath=&metricAgg= let you aggregate ANY numeric field out of ANY
// row's JSON payload, whatever type of data ends up in this table later -
// a contact-form submission, a custom app event, anything with a `type`
// and a JSON `payload`. Only an allowlisted aggregate function is
// accepted, and the JSON path is passed as a bound parameter (not string-
// interpolated), so this stays injection-safe even though it's arbitrary.
//
// ?urlPrefix= scopes the report to one site/page (e.g.
// https://shekarkrishnamoorthy.com/) without assuming there's only ever
// one - omit it to summarize every site this database has ever collected
// for. ?groupBy= chooses what the breakdown counts by (type by default,
// or session_id / url) - again so this isn't locked to one shape of data.
const ALLOWED_AGG = ['avg', 'sum', 'min', 'max', 'count'];
const ALLOWED_GROUP_BY = ['type', 'session_id', 'url'];
const JSON_PATH_RE = /^\$(\.[A-Za-z0-9_]+|\[\d+\])*$/; // e.g. $.vitals.lcp.value

app.get('/api/reports/summary', async (req, res) => {
  const where = [];
  const params = [];
  if (typeof req.query.urlPrefix === 'string' && req.query.urlPrefix) {
    where.push('url LIKE ?');
    params.push(req.query.urlPrefix + '%');
  }
  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';

  const groupBy = ALLOWED_GROUP_BY.includes(req.query.groupBy) ? req.query.groupBy : 'type';

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

    const [byGroup] = await dbPool.query(
      `SELECT ${groupBy} AS \`key\`, COUNT(*) AS count FROM events ${whereSql}
       GROUP BY ${groupBy} ORDER BY count DESC LIMIT 50`,
      params
    );

    let customMetric = null;
    const metricPath = req.query.metricPath;
    const metricAgg = (req.query.metricAgg || 'avg').toLowerCase();
    if (typeof metricPath === 'string' && metricPath) {
      if (!JSON_PATH_RE.test(metricPath)) {
        return res.status(400).json({ error: 'metricPath must look like a JSON path, e.g. $.vitals.lcp.value' });
      }
      if (!ALLOWED_AGG.includes(metricAgg)) {
        return res.status(400).json({ error: 'metricAgg must be one of: ' + ALLOWED_AGG.join(', ') });
      }
      const aggSql = metricAgg === 'count'
        ? 'COUNT(payload->>?)'
        : `${metricAgg.toUpperCase()}(CAST(payload->>? AS DOUBLE))`;
      const [[row]] = await dbPool.query(
        `SELECT ${aggSql} AS value FROM events ${whereSql}`,
        [metricPath, ...params]
      );
      customMetric = { path: metricPath, agg: metricAgg, value: row.value };
    }

    res.json({ totals, groupBy, byGroup, customMetric });
  } catch (err) {
    console.error('[GET /api/reports/summary] error:', err.message);
    res.status(500).json({ error: 'database error' });
  }
});

// --- User management (HW4 Part 2) ---
//
// Full CRUD on the `users` table. requireAuthApi already ran (blanket /api
// middleware above); requireAdminApi only needs to add the isAdmin check on
// top of that. Password hashes are never included in any response.

const USER_FIELDS = 'id, username, email, is_admin, created_at';

app.get('/api/users', requireAdminApi, async (req, res) => {
  try {
    const [rows] = await dbPool.query(`SELECT ${USER_FIELDS} FROM users ORDER BY id`);
    res.json(rows);
  } catch (err) {
    console.error('[GET /api/users] error:', err.message);
    res.status(500).json({ error: 'database error' });
  }
});

app.get('/api/users/:id', requireAdminApi, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'id must be a positive integer' });
  try {
    const [rows] = await dbPool.query(`SELECT ${USER_FIELDS} FROM users WHERE id = ?`, [id]);
    if (!rows.length) return res.status(404).json({ error: 'not found' });
    res.json(rows[0]);
  } catch (err) {
    console.error('[GET /api/users/:id] error:', err.message);
    res.status(500).json({ error: 'database error' });
  }
});

app.post('/api/users', requireAdminApi, async (req, res) => {
  const body = req.body || {};
  if ('id' in body) return res.status(400).json({ error: 'POST must not include an id - the database assigns one' });
  if (typeof body.username !== 'string' || !body.username) return res.status(400).json({ error: 'username is required' });
  if (typeof body.email !== 'string' || !body.email) return res.status(400).json({ error: 'email is required' });
  if (typeof body.password !== 'string' || body.password.length < 8) {
    return res.status(400).json({ error: 'password is required and must be at least 8 characters' });
  }

  try {
    const hash = await bcrypt.hash(body.password, 10);
    const [result] = await dbPool.execute(
      'INSERT INTO users (username, email, password_hash, is_admin) VALUES (?, ?, ?, ?)',
      [body.username.slice(0, 64), body.email.slice(0, 255), hash, body.isAdmin ? 1 : 0]
    );
    const [rows] = await dbPool.query(`SELECT ${USER_FIELDS} FROM users WHERE id = ?`, [result.insertId]);
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ error: 'username or email already exists' });
    }
    console.error('[POST /api/users] error:', err.message);
    res.status(500).json({ error: 'database error' });
  }
});

app.put('/api/users/:id', requireAdminApi, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'id must be a positive integer' });

  const body = req.body || {};
  const fields = [];
  const params = [];

  if (typeof body.username === 'string' && body.username) { fields.push('username = ?'); params.push(body.username.slice(0, 64)); }
  if (typeof body.email === 'string' && body.email) { fields.push('email = ?'); params.push(body.email.slice(0, 255)); }
  if (typeof body.isAdmin === 'boolean') { fields.push('is_admin = ?'); params.push(body.isAdmin ? 1 : 0); }
  if (typeof body.password === 'string' && body.password) {
    if (body.password.length < 8) return res.status(400).json({ error: 'password must be at least 8 characters' });
    fields.push('password_hash = ?');
    params.push(await bcrypt.hash(body.password, 10));
  }

  if (!fields.length) return res.status(400).json({ error: 'no updatable fields provided' });

  try {
    const [result] = await dbPool.execute(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`, [...params, id]);
    if (!result.affectedRows) return res.status(404).json({ error: 'not found' });
    const [rows] = await dbPool.query(`SELECT ${USER_FIELDS} FROM users WHERE id = ?`, [id]);
    res.json(rows[0]);
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ error: 'username or email already exists' });
    }
    console.error('[PUT /api/users/:id] error:', err.message);
    res.status(500).json({ error: 'database error' });
  }
});

app.delete('/api/users/:id', requireAdminApi, async (req, res) => {
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

app.get('/', (req, res) => res.redirect(req.session ? '/index.html' : '/login.html'));

app.get('/login.html', (req, res) => {
  if (req.session) return res.redirect('/index.html'); // already signed in
  res.sendFile(path.join(PAGES_DIR, 'login.html'));
});

app.get('/logout.html', (req, res) => {
  res.sendFile(path.join(PAGES_DIR, 'logout.html'));
});

app.get('/index.html', requireAuthPage, (req, res) => {
  res.sendFile(path.join(PAGES_DIR, 'index.html'));
});

app.get('/users.html', requireAdminPage, (req, res) => {
  res.sendFile(path.join(PAGES_DIR, 'users.html'));
});

const PORT = process.env.PORT || 3011;
app.listen(PORT, '127.0.0.1', () => {
  console.log(`Reporting API listening on 127.0.0.1:${PORT}`);
});
