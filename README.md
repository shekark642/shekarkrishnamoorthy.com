Hello, this is the github page for shekarkrishnamoorthy.com

Feel free to explore.

## Deployment setup (GitHub → webhook → server)

This repo is the single source of truth for all three domains hosted on this server: the main site (repo root), and `collector.shekarkrishnamoorthy.com` / `reporting.shekarkrishnamoorthy.com` (the `collector/` and `reporting/` folders). Nobody edits files directly on the server — every change goes through git, and deployment is fully automatic.

**How a push becomes a live change:**

1. `git push` to `main` on this repo.
2. GitHub sends a webhook (an HTTP POST) to `https://shekarkrishnamoorthy.com/hooks/deploy-main`.
3. Apache reverse-proxies anything under `/hooks/` to a listener running on `127.0.0.1:9000` — that listener is never reachable directly from the internet, only through Apache.
4. The listener (the `webhook` program, run as a systemd service, config in `~/hooks.json`) checks two things before doing anything: the request's HMAC-SHA256 signature matches a shared secret only it and GitHub know (proves the request is genuinely from GitHub, not a forged POST to that URL), and the payload's branch ref is `refs/heads/main`.
5. If both check out, it runs `~/bin/deploy-site.sh`, which `git fetch` + `git reset --hard origin/main`s a local clone, then `rsync`s the relevant folders into each domain's web root (`/var/www/<domain>/public_html`).

**Anyone with push access to this repo can deploy to production** — the webhook signature only proves the request came from GitHub, not that the *push itself* was authorized by any particular person. GitHub's repo permissions are the actual security boundary here, not the webhook.

## Password-protected area

The `/members` directory on shekarkrishnamoorthy.com is protected with HTTP Basic Authentication over HTTPS.

- URL: https://shekarkrishnamoorthy.com/members/
- Username: shekar
- Password: K6fTCWFCRfhK

## Compression (mod_deflate)

Apache's `mod_deflate` was already installed and enabled on this server, with `/etc/apache2/mods-available/deflate.conf` already configured to compress `text/html`, `text/css`, `text/javascript`, and `application/javascript` (this site's JavaScript is inline in HTML, so it's compressed as part of the document rather than as a separate file).

Verified compression is active:

| File | Content-Type | Uncompressed | Gzip-compressed |
|---|---|---|---|
| `/` (index.html) | text/html | 8,755 bytes | 2,958 bytes |
| `/assets/site-nav.css` | text/css | larger | 434 bytes |

In Chrome DevTools' Network tab, after reloading the page with compression enabled, the document request's **Response Headers** show `content-encoding: gzip`, and the **Size** column shows two numbers instead of one — the actual transferred size (much smaller) alongside the true uncompressed resource size. For the homepage, that's roughly a **66% reduction** in bytes actually sent over the wire, with no visible change to the rendered page.

## Obscuring server identity

**Goal:** change the `Server:` response header from `Apache/2.4.58 (Ubuntu)` to `CSE135 Server`.

**What didn't work (the obvious approach):** enabling `mod_headers` and adding `Header always set Server CSE135 Server`. This loaded without error and passed `apache2ctl configtest`, but had **zero effect** — every response still returned `Server: Apache/2.4.58 (Ubuntu)`, including on 404 error pages, even after a full `systemctl restart apache2`. This is because Apache's core sets the `Server` header *after* `mod_headers`' output filter runs, so mod_headers' value is silently overwritten every time. Verified this failure directly with `curl -I` before moving on, rather than assuming it worked.

**What actually worked:** installing `libapache2-mod-security2` and using its dedicated `SecServerSignature` directive, which operates at a lower level specifically built for rewriting this header:

- Set `SecServerSignature CSE135 Server` in `/etc/modsecurity/modsecurity.conf`
- Set `ServerTokens Full` (required — ModSecurity needs Apache to generate its most verbose banner first, so it has a complete string to overwrite)
- Set `SecRuleEngine Off` — only the header-rewrite behavior is used here; ModSecurity's actual Web Application Firewall rule engine is intentionally left off for now, since enabling real WAF filtering needs its own deliberate tuning pass to avoid false positives on legitimate traffic

**Related leak fixed at the same time:** Apache's default error pages were also printing the same version info in the page body via `ServerSignature On` (e.g. `Apache/2.4.58 (Ubuntu) Server at shekarkrishnamoorthy.com Port 443` at the bottom of every 404/500 page) — a separate mechanism from the `Server:` header that would have defeated the whole point if left alone. Set `ServerSignature Off` to close this too.

**Also checked:** PHP's `X-Powered-By` header (a common parallel version leak) — already absent, since `expose_php = Off` was already set in `php.ini`.

**Verification** (`curl -I`), confirmed on every response type, including the exact edge case where the naive fix failed:

| Response | Server header |
|---|---|
| Homepage | `CSE135 Server` |
| 404 error page | `CSE135 Server` |
| `hello.php` (PHP-generated) | `CSE135 Server` |

Screenshot of the fetch/DevTools Network tab showing the changed header is included alongside this README.

## Analytics: Matomo (chosen over Open Web Analytics)

Considered both **Matomo** and **Open Web Analytics** for self-hosted analytics. Chose Matomo: it's actively maintained and supports PHP 8.3 (what this server runs); OWA's last release predates PHP 8 and would likely have compatibility problems.

**Where it lives:** `/var/www/matomo` — deliberately kept *outside* this git repo and the deploy pipeline. Everything else in `/var/www/*` gets `rsync --delete`'d on every push, which would wipe out a database-backed app like Matomo. Instead, an Apache `Alias` on the `collector.shekarkrishnamoorthy.com` vhost maps `/analytics/` to that separate directory, so it's reachable at a normal URL under an existing domain/SSL cert without ever being touched by a deploy.

**Install process:**
1. Downloaded the official release tarball and extracted it to `/var/www/matomo`.
2. Created a dedicated, least-privilege MySQL database and user (`matomo`, `GRANT ALL` scoped only to the `matomo` database, not the whole MySQL instance).
3. Added the Apache `Alias` + `<Directory>` block (`AllowOverride All` is required here — Matomo ships its own `.htaccess` files to block direct web access to sensitive folders like `config/`, and without `AllowOverride All` those protections are silently ignored).
4. Set file ownership to `www-data` (the Apache process user) so Matomo can write its cache/temp files.
5. Ran through Matomo's own web-based setup wizard: system check, database connection, table creation, Superuser account, and initial website (`shekarkrishnamoorthy.com`) setup.
6. Added the JavaScript tracking snippet to the main site's `<head>`.

**Caught and fixed a real security issue during setup:** immediately after install, `config/config.ini.php` (which holds the plaintext database password) was directly downloadable over the web, because Matomo's protective `.htaccess` files hadn't been generated yet. Ran `php console core:create-security-files` (as `www-data`) to generate them, then verified the file returns 403 before proceeding further. Worth an explicit callout: don't assume a fresh install is safe by default, verify it.

**Links for graders:**
- Public dashboard/login: https://collector.shekarkrishnamoorthy.com/analytics/
- Tracked site: shekarkrishnamoorthy.com (site ID 1)
- Verify installation without logging in: `https://collector.shekarkrishnamoorthy.com/analytics/config/config.ini.php` should return 403 Forbidden (confirms the security files are active), and `https://collector.shekarkrishnamoorthy.com/analytics/matomo.js` should return the tracker JavaScript with a 200.

## HW4 — Analytics Viz Platform

**Site URL:** https://reporting.shekarkrishnamoorthy.com/

**Grader login (basic):**
- Username or email: `grader_basic` (or `grader_basic@example.com`)
- Password: `GraderBasic2026!`

**Grader login (admin):**
- Username or email: `grader_admin` (or `grader_admin@example.com`)
- Password: `GraderAdmin2026!`

### Authentication

Auth is hand-rolled in Node/Express rather than a third-party library
(Passport, `express-session`, etc.) — for a single-service project with one
simple session shape, a library would have added configuration surface
without saving meaningful code. It also let API-route gating and page-route
gating share the exact same session lookup, differing only in what happens
on failure (a JSON 401/403 vs. a redirect to `/login.html`).

**How it works:**
- `users` table in the same MySQL database the collector already writes to
  (`username`, `email`, `password_hash`, `is_admin`, `created_at`).
- Passwords hashed with `bcryptjs` (a pure-JS bcrypt implementation — chosen
  over native `bcrypt` specifically to avoid a native-module build step in
  the deploy pipeline, which only runs a plain `npm install`, no compiler
  toolchain guaranteed).
- On login, the username-or-email field is checked against *both* columns
  in one query (`WHERE username = ? OR email = ?`) so the same field
  genuinely accepts either, matching how most real sites' login forms work.
- A random session token (`crypto.randomBytes(32)`) is generated and stored
  server-side in an in-memory `Map` (token → `{userId, username, isAdmin}`),
  set as an `httpOnly`, `secure`, `SameSite=Lax` cookie. In-memory sessions
  are the same durability tradeoff already used elsewhere in this project
  (HW2's `state-nodejs`, the fingerprint demo) — a process restart logs
  everyone out, which is an acceptable cost here and happens automatically
  on every deploy anyway.
- Every `/api/*` route requires a valid session, and every protected page
  route checks the session before serving the file — not just before
  rendering a link to it. This distinction mattered in practice: it would
  have been easy to gate only the *pages* and leave the underlying API
  reachable directly, which would let anyone bypass the login wall entirely
  by hitting `/api/events` with `curl` instead of opening the dashboard in a
  browser. Both layers are gated for that reason.
- A real architectural change was needed to make page-level gating possible
  at all: originally, Apache served `reporting.shekarkrishnamoorthy.com`'s
  static HTML directly and only proxied `/api/` to Node. Static files can't
  check a session, so the proxy was expanded to send the *entire* vhost to
  Node, which now owns serving every page and can redirect to `/login.html`
  before a byte of protected content is ever sent.
- Admin-only routes (`/users.html`, `/api/users/*`) add one more check
  (`isAdmin`) on top of the same session — confirmed live that a basic
  account gets a 403 page hitting `/users.html` directly, and that the
  "User Management" nav link is only rendered on the dashboard for admins
  (checked via `GET /auth/me`, not just assumed client-side).

### Dashboard

Three metrics, three different presentations (the assignment's minimum:
2 charts + 1 grid):

1. **Events by type → bar chart.** Categorical comparison across a small,
   fixed set of labels (`load`, `activity`, `enter`, `exit`, ...) — a bar
   chart is the right tool for comparing discrete categories side by side;
   a line chart would have implied an ordering between categories that
   doesn't exist.
2. **Page load time across the last 20 loads → line chart.** This is a
   value that changes across a sequence (successive page loads over time),
   which is exactly what a line chart is for — a bar chart here would have
   obscured the trend/spikes that the line makes immediately visible.
3. **Recent activity → grid.** Individual record inspection (which
   session, which URL, what time) has no meaningful chart representation at
   all; a table is the correct - not just simplest - choice here.

All three are computed via the reporting API's heavy-SQL summary endpoint
(`GET /api/reports/summary`, `COUNT`/`AVG`/`GROUP BY` against indexed
generated columns) and the general CRUD endpoint (`GET /api/events`) for
the raw rows the grid and line chart need. Charts are rendered with
Chart.js (canvas) — a real improvement over the HW3 dashboard skeleton,
which only drew bars with plain CSS `<div>` widths and had no line-chart
capability at all.

The dashboard also checks `GET /auth/me` on load and only shows the "User
Management" link when the session is an admin, satisfying the requirement
to link to Part 2 conditionally rather than unconditionally.

### Report

**File:** `/performance.html`, linked from the dashboard's "Generate
Detailed Report" button.

**Guiding question:** *Is the site loading fast enough, and are Core Web
Vitals in a healthy range?* Chosen because performance is the metric with
the clearest, most defensible "healthy vs. not" answer — the collector
already computes Web Vitals scores client-side against published
thresholds (good/needs-improvement/poor), so the report can reuse those
exact same thresholds server-side rather than inventing a different
standard for what "fast enough" means.

- **Score cards** for average load time, LCP, CLS, and INP, each labeled
  with the same good/needs-improvement/poor thresholds `collector.js`
  itself uses — so a "Good" badge on the report means the same thing it
  means in the raw beacon data, not a report-specific reinterpretation.
- **A load-time histogram** (bucketed bar chart: 0-200ms, 200-500ms, etc.)
  — deliberately a *different* view than the dashboard's sequential trend
  line. The dashboard shows *when* load times changed; the report shows the
  *shape* of the whole distribution (how many visits fall in each speed
  bucket), which the trend line alone can't answer.
- **A grid** of individual load events with a per-row score, so an outlier
  (e.g. one 1501ms load flagged "Needs Improvement" against a majority of
  sub-700ms loads) is traceable back to a specific session and timestamp,
  not just visible as an aggregate number.
- **A written discussion** on the page itself computes the actual answer
  from live numbers (e.g. *"the average page load time is 455.43ms, which
  scores as Good... Answer: yes, the site is loading fast enough on
  average"*) rather than describing what the charts show in the abstract.

### Source files written for this assignment

- `reporting/nodejs/server.js` — sessions, auth routes (`/auth/login`,
  `/auth/logout`, `/auth/me`), `requireAuth*`/`requireAdmin*` middleware,
  `/api/users` CRUD, page-serving routes for every page below, and the
  generalized `/api/reports/summary` endpoint the dashboard/report use.
- `reporting/nodejs/pages/login.html`
- `reporting/nodejs/pages/logout.html`
- `reporting/nodejs/pages/index.html` (dashboard)
- `reporting/nodejs/pages/users.html`
- `reporting/nodejs/pages/performance.html` (detailed report)
- `reporting/nodejs/package.json` (added `bcryptjs`)
- MySQL `users` table (schema + the two seeded grader accounts above)
