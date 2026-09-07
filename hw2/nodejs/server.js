const express = require('express');
const crypto = require('crypto');
const os = require('os');
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const rateLimit = require('express-rate-limit');

const app = express();

// Credentials come from the environment (EnvironmentFile= in the systemd
// unit, outside the git repo) - never hardcoded here, since this file is
// public on GitHub.
const dbPool = mysql.createPool({
  host: process.env.DB_HOST || '127.0.0.1',
  user: process.env.DB_USER || 'analytics_app',
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME || 'analytics',
  waitForConnections: true,
  connectionLimit: 5,
  queueLimit: 0
});

// Apache proxies to us over loopback and adds X-Forwarded-For; trust that so
// req.ip reflects the real client, not 127.0.0.1.
app.set('trust proxy', 'loopback');
app.disable('x-powered-by');

app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// In-memory only: this is a long-running process (unlike the one-shot Python/C
// CGI scripts), so a plain Map keyed by session id is enough - no file store
// needed. Trade-off: it resets if the process restarts.
const sessions = new Map();

// Fingerprint demo: fully separate from the state-nodejs session above -
// different cookie name, different Maps - so it can never affect the graded
// HW2 state demo.
const fpSessions = new Map(); // sessionId -> { fingerprint, savedValue, firstSeen, lastSeen }
const fpIndex = new Map();    // fingerprint -> sessionId (reassociation lookup)

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function currentTime() {
  return new Date().toString().replace(/ \(.*\)$/, '');
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  header.split(';').forEach((part) => {
    const idx = part.indexOf('=');
    if (idx === -1) return;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    try {
      out[key] = decodeURIComponent(val);
    } catch {
      out[key] = val;
    }
  });
  return out;
}

app.get('/hello-html-nodejs', (req, res) => {
  res.set('Cache-Control', 'no-cache');
  res.type('html').send(`<!DOCTYPE html>
<html>
<head><title>Hello CGI World - Shekar Krishnamoorthy</title></head>
<body>
<h1 align=center>Hello HTML World - Shekar Krishnamoorthy</h1><hr/>
<p>Hello World, from Shekar Krishnamoorthy</p>
<p>This page was generated with the NodeJS (Express) programming language</p>
<p>This program was generated at: ${escapeHtml(currentTime())}</p>
<p>Your current IP Address is: ${escapeHtml(req.ip)}</p>
</body>
</html>`);
});

app.get('/hello-json-nodejs', (req, res) => {
  res.set('Cache-Control', 'no-cache');
  res.json({
    title: 'Hello, NodeJS! - Shekar Krishnamoorthy',
    heading: 'Hello, NodeJS! - Shekar Krishnamoorthy',
    message: 'This page was generated with the NodeJS (Express) programming language',
    time: currentTime(),
    IP: req.ip,
  });
});

app.get('/environment-nodejs', (req, res) => {
  res.set('Cache-Control', 'no-cache');
  const keys = Object.keys(req.headers).sort();
  let rows = '';
  for (const k of keys) {
    rows += `<b>${escapeHtml(k)}:</b> ${escapeHtml(req.headers[k])}<br />\n`;
  }
  rows += `<b>method:</b> ${escapeHtml(req.method)}<br />\n`;
  rows += `<b>url:</b> ${escapeHtml(req.originalUrl)}<br />\n`;
  rows += `<b>remoteAddress:</b> ${escapeHtml(req.ip)}<br />\n`;

  res.type('html').send(`<!DOCTYPE html>
<html><head><title>Environment Variables - NodeJS - Shekar Krishnamoorthy</title></head>
<body><h1 align="center">Environment Variables - NodeJS - Shekar Krishnamoorthy</h1><hr>
<p><em>Express is a long-running server, not one-shot CGI, so there's no per-request
OS environment block the way Perl/Python/C get one. The closest real equivalent is
the incoming HTTP request itself - headers and request line, shown below.</em></p>
${rows}
</body></html>`);
});

app.all('/echo-nodejs', (req, res) => {
  res.set('Cache-Control', 'no-cache');

  let received = {};
  let source = '';
  if ((req.method === 'POST' || req.method === 'PUT') && req.body && Object.keys(req.body).length) {
    received = req.body;
    source = 'request body';
  } else if (req.query && Object.keys(req.query).length) {
    received = req.query;
    source = 'query string';
  }

  const keys = Object.keys(received);
  let rows = keys.length
    ? keys.map((k) => `<li>${escapeHtml(k)} = ${escapeHtml(received[k])}</li>`).join('\n')
    : '<li>(nothing received)</li>';

  res.type('html').send(`<!DOCTYPE html>
<html><head><title>Echo - NodeJS - Shekar Krishnamoorthy</title></head>
<body><h1 align="center">Echo Request - NodeJS</h1><hr>
<p><b>HTTP Method:</b> ${escapeHtml(req.method)}</p>
<p><b>Content-Type received:</b> ${escapeHtml(req.headers['content-type'] || '(none)')}</p>
<p><b>Data source:</b> ${escapeHtml(source || '(none)')}</p>
<p><b>Received data:</b></p><ul>
${rows}
</ul>
<p><b>Server hostname:</b> ${escapeHtml(os.hostname())}</p>
<p><b>Date/time:</b> ${escapeHtml(currentTime())}</p>
<p><b>User-Agent:</b> ${escapeHtml(req.headers['user-agent'] || '')}</p>
<p><b>Your IP Address:</b> ${escapeHtml(req.ip)}</p>
</body></html>`);
});

function handleState(req, res) {
  const cookies = parseCookies(req.headers.cookie);
  let sessionId = cookies.hw2_session;
  let isNew = false;
  if (!sessionId || !/^[0-9a-f]{32}$/.test(sessionId)) {
    sessionId = crypto.randomBytes(16).toString('hex');
    isNew = true;
  }

  if (req.method === 'POST' && req.body) {
    if (req.body.action === 'clear') {
      sessions.delete(sessionId);
    } else if (typeof req.body.value === 'string') {
      sessions.set(sessionId, req.body.value.slice(0, 500));
    }
  }

  const savedValue = sessions.get(sessionId) || '';

  res.set('Cache-Control', 'no-cache');
  if (isNew) {
    res.cookie('hw2_session', sessionId, { httpOnly: true, sameSite: 'Lax', path: '/' });
  }

  res.type('html').send(`<!DOCTYPE html>
<html><head><title>State - NodeJS - Shekar Krishnamoorthy</title></head>
<body><h1 align="center">Server-Side State - NodeJS</h1><hr>
<p><b>Currently saved value:</b> ${savedValue ? escapeHtml(savedValue) : '(nothing saved yet)'}</p>
<form method="POST">
<input type="text" name="value" placeholder="Enter a value" maxlength="500">
<button type="submit">Save</button>
</form>
<form method="POST" style="margin-top:10px">
<input type="hidden" name="action" value="clear">
<button type="submit">Clear</button>
</form>
<p style="margin-top:20px;color:#666">Session ID: ${escapeHtml(sessionId)}</p>
<p>Reload this page after saving a value &mdash; it persists across separate requests
via a server-side in-memory Map keyed by your session cookie, not localStorage.
Unlike the file-backed Python/C sessions, this resets if the Node process restarts.</p>
</body></html>`);
}

app.get('/state-nodejs', handleState);
app.post('/state-nodejs', handleState);

function newFpSessionId() {
  return crypto.randomBytes(16).toString('hex');
}

function fpCookieOptions() {
  return { httpOnly: true, sameSite: 'Lax', path: '/' };
}

app.post('/fingerprint-demo/identify', (req, res) => {
  const cookies = parseCookies(req.headers.cookie);
  const cookieSessionId = cookies.fp_session;
  const fingerprint = typeof req.body.fingerprint === 'string' ? req.body.fingerprint.slice(0, 200) : '';

  if (!fingerprint) {
    res.status(400).json({ error: 'missing fingerprint' });
    return;
  }

  let sessionId;
  let status;

  if (cookieSessionId && fpSessions.has(cookieSessionId)) {
    sessionId = cookieSessionId;
    status = 'cookie';
    const record = fpSessions.get(sessionId);
    record.fingerprint = fingerprint;
    record.lastSeen = new Date().toISOString();
    fpIndex.set(fingerprint, sessionId);
  } else if (fpIndex.has(fingerprint)) {
    sessionId = fpIndex.get(fingerprint);
    status = 'reassociated';
    fpSessions.get(sessionId).lastSeen = new Date().toISOString();
    res.cookie('fp_session', sessionId, fpCookieOptions());
  } else {
    sessionId = newFpSessionId();
    status = 'new';
    const now = new Date().toISOString();
    fpSessions.set(sessionId, { fingerprint, savedValue: '', firstSeen: now, lastSeen: now });
    fpIndex.set(fingerprint, sessionId);
    res.cookie('fp_session', sessionId, fpCookieOptions());
  }

  const record = fpSessions.get(sessionId);
  res.json({
    status,
    sessionId,
    fingerprint,
    savedValue: record.savedValue,
    firstSeen: record.firstSeen,
    lastSeen: record.lastSeen,
    knownFingerprints: fpIndex.size,
  });
});

app.post('/fingerprint-demo/save', (req, res) => {
  const cookies = parseCookies(req.headers.cookie);
  const sessionId = cookies.fp_session;
  if (!sessionId || !fpSessions.has(sessionId)) {
    res.status(400).json({ error: 'no active fingerprint session - call /identify first' });
    return;
  }
  const value = typeof req.body.value === 'string' ? req.body.value.slice(0, 500) : '';
  fpSessions.get(sessionId).savedValue = value;
  res.json({ savedValue: value });
});

app.post('/fingerprint-demo/clear-value', (req, res) => {
  const cookies = parseCookies(req.headers.cookie);
  const sessionId = cookies.fp_session;
  if (sessionId && fpSessions.has(sessionId)) {
    fpSessions.get(sessionId).savedValue = '';
  }
  res.json({ savedValue: '' });
});

app.post('/fingerprint-demo/expire-cookie', (req, res) => {
  // Simulates a real visitor clearing cookies: the fp_session cookie goes
  // away, but the underlying fpSessions/fpIndex record is untouched - that's
  // exactly the gap the fingerprint reassociation is meant to close.
  res.clearCookie('fp_session', { path: '/' });
  res.json({ cleared: true });
});

app.get('/fingerprint-demo/', (req, res) => {
  res.type('html').send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Fingerprint Demo - Shekar Krishnamoorthy</title>
<style>
  body { font-family: -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; background:#f8fafc; color:#0f172a; margin:0; }
  main { max-width: 680px; margin: 0 auto; padding: 2.5rem 1.5rem 4rem; }
  h1 { font-size: 1.6rem; }
  .card { background:#fff; border:1px solid #dbe3ee; border-radius:14px; padding:1.5rem; margin-top:1.5rem; }
  .banner { border-radius:10px; padding:1rem 1.25rem; margin-top:1.5rem; font-weight:600; }
  .banner.new { background:#eff6ff; color:#1d4ed8; border:1px solid #bfdbfe; }
  .banner.cookie { background:#ecfdf5; color:#047857; border:1px solid #a7f3d0; }
  .banner.reassociated { background:#fff7ed; color:#c2410c; border:1px solid #fed7aa; }
  dl { display:grid; grid-template-columns: max-content 1fr; gap: 0.4rem 1rem; font-size:0.9rem; }
  dt { color:#475569; }
  dd { margin:0; font-family: ui-monospace, Consolas, monospace; word-break: break-all; }
  input[type=text] { width:100%; padding:0.55rem 0.7rem; border:1px solid #dbe3ee; border-radius:8px; font-size:0.95rem; box-sizing:border-box; }
  button { margin-top:0.75rem; margin-right:0.5rem; border:none; padding:0.6rem 1.1rem; border-radius:8px; font-weight:600; cursor:pointer; }
  .btn-save { background:#0284c7; color:#fff; }
  .btn-save:hover { background:#0369a1; }
  .btn-clear { background:#e2e8f0; color:#0f172a; }
  .btn-clear:hover { background:#cbd5e1; }
  .btn-danger { background:#fee2e2; color:#b91c1c; }
  .btn-danger:hover { background:#fecaca; }
  .note { font-size:0.85rem; color:#475569; }
  a { color:#0284c7; }
</style>
</head>
<body>
<main>
  <h1>Fingerprint Re-association Demo</h1>
  <p>This page computes a browser fingerprint with
  <a href="https://github.com/fingerprintjs/fingerprintjs" target="_blank" rel="noopener">FingerprintJS</a>
  (open-source) and combines it with the same cookie-based server-side session pattern
  used in the HW2 state demos. Full explanation in
  <a href="/EXTRA_CREDIT_FINGERPRINT.md">EXTRA_CREDIT_FINGERPRINT.md</a>.</p>

  <div id="banner" class="banner new">Computing your fingerprint...</div>

  <div class="card">
    <dl>
      <dt>Status</dt><dd id="statusText">-</dd>
      <dt>Session ID</dt><dd id="sessionId">-</dd>
      <dt>Fingerprint</dt><dd id="fingerprintId">-</dd>
      <dt>First seen</dt><dd id="firstSeen">-</dd>
      <dt>Known fingerprints (this server)</dt><dd id="knownCount">-</dd>
    </dl>
  </div>

  <div class="card">
    <label for="valueInput"><strong>Saved value</strong> (tied to your session, restored on reassociation)</label>
    <input type="text" id="valueInput" maxlength="500" placeholder="Type something and Save">
    <div>
      <button class="btn-save" id="saveBtn">Save</button>
      <button class="btn-clear" id="clearValueBtn">Clear saved value</button>
    </div>
  </div>

  <div class="card">
    <p><strong>Try the trick:</strong> Save a value above, then click below to simulate
    clearing your cookies (this only removes the cookie, not your fingerprint - a real
    "clear cookies" click in your browser does the same). Then reload this page.</p>
    <button class="btn-danger" id="expireBtn">Simulate clearing cookies</button>
    <p class="note">If reassociation works, the banner above will turn orange
    ("reassociated via fingerprint") after reload, and your saved value will still be there
    even though the cookie was gone.</p>
  </div>

  <p class="note"><a href="/hw2/index.html">&larr; Back to Homework 2</a></p>
</main>

<script src="https://cdn.jsdelivr.net/npm/@fingerprintjs/fingerprintjs@4/dist/fp.min.js"></script>
<script>
(function () {
  "use strict";

  var banner = document.getElementById("banner");
  var statusText = document.getElementById("statusText");
  var sessionIdEl = document.getElementById("sessionId");
  var fingerprintEl = document.getElementById("fingerprintId");
  var firstSeenEl = document.getElementById("firstSeen");
  var knownCountEl = document.getElementById("knownCount");
  var valueInput = document.getElementById("valueInput");

  var labels = {
    new: "New visitor - no cookie, no matching fingerprint on file.",
    cookie: "Recognized via cookie (the normal case).",
    reassociated: "No cookie was found, but your fingerprint matched a previous visit - reassociated!"
  };

  function render(data) {
    banner.className = "banner " + data.status;
    banner.textContent = labels[data.status] || data.status;
    statusText.textContent = data.status;
    sessionIdEl.textContent = data.sessionId;
    fingerprintEl.textContent = data.fingerprint;
    firstSeenEl.textContent = data.firstSeen;
    knownCountEl.textContent = data.knownFingerprints;
    valueInput.value = data.savedValue || "";
  }

  function identify() {
    banner.className = "banner new";
    banner.textContent = "Computing your fingerprint...";
    FingerprintJS.load().then(function (fp) {
      return fp.get();
    }).then(function (result) {
      return fetch("/fingerprint-demo/identify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fingerprint: result.visitorId })
      });
    }).then(function (r) { return r.json(); })
      .then(render)
      .catch(function (err) {
        banner.textContent = "Fingerprinting failed: " + err.message;
      });
  }

  document.getElementById("saveBtn").addEventListener("click", function () {
    fetch("/fingerprint-demo/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value: valueInput.value })
    }).then(function (r) { return r.json(); }).then(function () { identify(); });
  });

  document.getElementById("clearValueBtn").addEventListener("click", function () {
    fetch("/fingerprint-demo/clear-value", { method: "POST" })
      .then(function () { identify(); });
  });

  document.getElementById("expireBtn").addEventListener("click", function () {
    fetch("/fingerprint-demo/expire-cookie", { method: "POST" })
      .then(function () {
        banner.className = "banner new";
        banner.textContent = "Cookie cleared. Reload the page to test reassociation.";
      });
  });

  identify();
})();
</script>
</body>
</html>`);
});

// HW3 Module 04: Custom Endpoint. analytics.jsonl lives in this same
// directory ($CLONE/hw2/nodejs), which deploy-site.sh never syncs into
// public_html (see its rsync excludes), so it's not web-servable - and it's
// gitignored so `git clean -fd` on every deploy doesn't wipe accumulated data.
const ANALYTICS_LOG = path.join(__dirname, 'analytics.jsonl');

// CORS: the collector script can run on a different origin than this
// endpoint (e.g. embedded on shekarkrishnamoorthy.com, posting here). Applies
// to any method hitting /collect; OPTIONS (the CORS preflight for JSON
// fetch() calls) is answered directly, POST falls through to the handler.
//
// navigator.sendBeacon() requests are always sent credentialed (per the
// Beacon API spec, even cross-origin), and CORS forbids pairing a
// credentialed request with a wildcard Access-Control-Allow-Origin - so the
// origin must be reflected back literally, not '*'.
app.use('/collect', (req, res, next) => {
  res.header('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.header('Access-Control-Allow-Credentials', 'true');
  res.header('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }
  next();
});

function appendToJsonlFallback(payload, reason) {
  console.error('[collect] MySQL insert failed, falling back to analytics.jsonl:', reason);
  fs.appendFile(ANALYTICS_LOG, JSON.stringify(payload) + '\n', (err) => {
    if (err) console.error('[collect] fallback JSONL write also failed:', err);
  });
}

// --- Live stream (Server-Sent Events) ---
//
// A dashboard can subscribe here and see every beacon the instant /collect
// receives it, with no MySQL round trip in the viewing path at all - the
// broadcast happens before the DB write is even attempted, so a slow or
// failed insert never delays or blocks the live view. This is generic
// across every site whose collector script posts here, not just one page:
// any beacon from any origin shows up for any connected viewer.
const sseClients = new Set();

app.get('/collect/stream', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive'
  });
  res.flushHeaders();
  res.write(': connected\n\n'); // comment line - opens the stream immediately

  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});

function broadcastLive(payload) {
  if (!sseClients.size) return;
  const line = `data: ${JSON.stringify(payload)}\n\n`;
  for (const client of sseClients) {
    client.write(line);
  }
}

// A beacon flood (scripted or accidental) pollutes every aggregate the
// reporting dashboard computes and grows the table forever, and /collect
// has no auth to gate it - it must accept beacons from any origin's
// browser. 60/min per IP is generous for real multi-tab use (collector.js
// itself sends at most one 'enter', one 'load', an 'activity' flush every
// 10s, and one 'exit' per page) while still capping a flood at a fixed,
// small cost. sendBeacon can't read the response anyway, and collector.js's
// fetch fallback already swallows failures, so a 429 here is silent and
// safe on the client - no retry storm.
const collectLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false
});

app.post('/collect', collectLimiter, async (req, res) => {
  const payload = req.body;

  if (!payload || typeof payload.url !== 'string' || typeof payload.type !== 'string') {
    return res.status(400).json({ error: 'Missing required fields: url, type' });
  }

  const size = Buffer.byteLength(JSON.stringify(payload), 'utf8');
  if (size > 50 * 1024) {
    return res.status(413).json({ error: 'Payload too large' });
  }

  // Server-side timestamp: client clocks can be wrong by minutes or hours.
  // Keeping both lets you detect clock skew later.
  payload.serverTimestamp = new Date().toISOString();
  payload.ip = req.ip;

  broadcastLive(payload);

  try {
    await dbPool.execute(
      'INSERT INTO events (session_id, type, url, ip, client_timestamp, payload) VALUES (?, ?, ?, ?, ?, ?)',
      [
        typeof payload.session === 'string' ? payload.session.slice(0, 64) : null,
        payload.type.slice(0, 32),
        payload.url,
        payload.ip || null,
        payload.timestamp ? new Date(payload.timestamp) : null,
        JSON.stringify(payload)
      ]
    );
    res.sendStatus(204); // No Content - confirms receipt, nothing to return
  } catch (err) {
    // Never lose a beacon just because the DB hiccuped - fall back to the
    // same local JSONL file Module 04 used, and still tell the client we
    // received it.
    appendToJsonlFallback(payload, err.message);
    res.sendStatus(204);
  }
});

// Body-parser errors (malformed JSON, etc.) land here instead of Express's
// default error page.
app.use((err, req, res, next) => {
  res.status(400).type('html').send(`<p>Bad request: ${escapeHtml(err.message)}</p>`);
});

const PORT = process.env.PORT || 3010;
app.listen(PORT, '127.0.0.1', () => {
  console.log(`HW2 Node/Express demo listening on 127.0.0.1:${PORT}`);
});
