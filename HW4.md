
## HW4 — Analytics Viz Platform

**Site URL:** https://reporting.shekarkrishnamoorthy.com/

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
- `reporting/nodejs/pages/index.html` — the dashboard (3 metrics, 3
  presentations: bar chart, line chart, grid).
- `reporting/nodejs/pages/users.html` — admin-only user management.
- `reporting/nodejs/pages/performance.html` — the detailed report page
  (guiding question, score cards, histogram, per-row-scored grid,
  written discussion).

### Additional files beyond the assignment's requirements

Everything above is the graded minimum. Everything below was added after
that minimum was met. Each entry is a decision, the concrete change, and
why - not a feature list.

**Role model: boolean `is_admin` → three roles, page-scoped.**
`users.role` is now `super_admin` / `analyst` / `viewer`, and a new
`user_scopes(user_id, page)` table restricts an analyst to a subset of
`music` / `about-me` / `projects` (empty scope = unrestricted, still the
default). Why: a single admin flag can't express "this analyst sees Music
and Projects but not About Me," which the multi-page structure below now
requires. Enforcement is server-side on both the page route
(`requirePagePage`) and its API (`requirePageApi`) - gating only the page
would leave the API reachable directly with `curl`, same reasoning
already applied to the original login wall. Dashboard and Reports are
unscoped (any authenticated role, including viewer) since neither varies
by page.

**Three new metrics pages, each with its own API surface, not more
dashboard cards.** `music.html`, `about-me.html`, `projects.html` under
`reporting/nodejs/pages/`. Why: the assignment's dashboard is
site-wide (`load`/`activity`/etc. across everything); these three answer
page- or site-specific questions (time per page on the music site,
mouse replay scoped to one page, project click order) that a single
combined dashboard view can't express without either losing that
specificity or growing unreadable. About Me in particular needed a
custom time-on-page reconstruction (`computePageBreakdown` -
consecutive same-URL events collapse into one dwell-time block) because
it shares its session with the rest of the main site, so a
session-level duration would include time spent on unrelated pages.

**Saved reports: query snapshots → real generated PDFs.**
`saved_reports` dropped `section`/`kind`/`params`/`is_static`/`snapshot`,
gained `notes`/`source_page`/`file_name`. Why: the requirement changed
from "define a report query" to "generate a report from what's on
screen right now, mark it up, save it" - a fundamentally different
artifact (a file) needing a fundamentally different schema (a file
reference, not a query definition). PDF generation is 100% client-side
(`html2canvas` capture → canvas-based pen/highlighter/text annotation →
`jsPDF` → base64 upload), by explicit choice over a server-side headless-
browser renderer (e.g. Puppeteer): the droplet runs multiple Node
services already on one small instance, and a per-report headless
render is real, avoidable memory/CPU pressure on it. Files are stored on
disk (`reporting/nodejs/report-files/`, server-generated random
filenames only) with metadata in MySQL, not as DB blobs, so MySQL stays
small and PDFs stay trivially servable via `res.sendFile`.

**Per-login-session response cache, not a general cache layer.** A
`Map<sessionToken, Map<requestURL, {data, cachedAt}>>` in `server.js`;
every one of the dashboard's 15 read endpoints checks it before running
its query. Why: the same aggregate queries were re-running on every
page view/reload within one login, work that doesn't need repeating
until the underlying data or the viewer changes. Keyed by session token
specifically (not by user, not globally) because a brand-new login
needs zero explicit cache-warming logic - it's a new key, so it's
already a cache miss on everything. TTL is `SESSION_MAX_AGE_MS` (24h,
matching the login session's own lifetime) as a defensive backstop only;
the real invalidation path is logout deleting the cache entry alongside
the session row, which was already the obvious way to force a reload
without adding a second "clear cache" control that would do almost the
same thing.

**IP masking on Distinct Users, enforced server-side.** Non-super_admin
roles get `ip: "xxx.xxx.xxx.xxx"` in the API response itself, not a
frontend display rule. Why: a client can always read whatever a response
body actually contains regardless of what the UI chooses to render -
hiding a value in JS is not access control on that value.

**"User N" identity: IP-keyed, not cookie- or session_id-keyed.** New
`visitors(ip, user_number AUTO_INCREMENT, first_seen, last_seen)` table;
`/collect` upserts it on every beacon. Why: there's no login for
anonymous site visitors, and `sessionStorage` (which backs the existing
`session_id`) is scoped per-origin, so the same real person browsing
both the main site and the music site already produces two unrelated
session_ids - IP is the only signal that can identify them as one
visitor *across* that origin boundary. Given the existing 90-day IP
anonymization policy on `events.ip`, `visitors.ip` gets the identical
treatment (nulled after 90 days, `user_number` kept) - otherwise this
table would quietly become a permanent identity store working around a
retention policy that already exists for exactly this reason.

**Hardware/efficiency additions to the dashboard** (see below for what
each chart shows): `collector.js` gained `hardwareConcurrency`,
`deviceMemory`, and `resourceCount` in its payload; `important/
projects.html` gained click and page-view instrumentation. None of
these required a schema change - `payload` is already a flexible JSON
column, so a new field is a one-line addition, not a migration.

**Styled 403/404/500 and a noscript fallback, not framework defaults.**
One `errorPageHtml()` template in `server.js` used for every non-JSON
error response, plus a `<noscript><style>main{display:none}</style>
</noscript>` + visible message on every page. Why: every dashboard page
is 100% client-rendered (fetch-driven, no server-side rendering at
all) - with JavaScript off there is nothing on the page at all, not a
degraded version of it, so hiding the empty shell and saying so directly
is more honest than leaving it silently blank.

### Load-time and efficiency analysis (three new dashboard visualizations)

The existing line chart (load time across recent events) answers one
question: is it trending up or down. Three more were added, each
answering a genuinely different question rather than the same number
re-plotted:

1. **Page Load Time Trend** (line chart, `GET /api/performance/events?
   limit=100`, last 100 loads oldest→newest). `pointRadius: 0` and
   `tooltip: { enabled: false }` - point markers and hover removed on
   purpose. Decision: this chart answers "flat, climbing, or spiky,"
   which a plain shape shows faster than one built for per-point
   inspection; that inspection already has a home (the detailed report's
   grid), so duplicating it here would be redundant, not additive.

2. **Actual vs. Expected Load Time by Page** (double bar chart,
   `GET /api/performance/page-comparison`, curated to 4 named pages:
   home/About Me/Projects/music). "Expected" = `SITE_COMPARISON_
   FIXED_OVERHEAD_MS` (400ms: DNS/TCP/TLS handshake + base HTML parse)
   + `SITE_COMPARISON_PER_RESOURCE_MS` (40ms) × average `resourceCount`
   for that page. Decision: named, adjustable constants next to the
   endpoint, not a network simulation and not a magic number buried in a
   query - the estimate needs to be inspectable and changeable in one
   place, not reverse-engineered from behavior. `resourceCount` (sub-
   resource count per load) is what makes "expected" possible at all; it
   didn't exist before this and was added to `collector.js` for
   exactly this purpose.

3. **Hardware vs. Average Load Time** (interactive scatter,
   `GET /api/performance/hardware-scatter`, x = CPU core count, y = avg
   load time across every session that visitor has ever had). Decision:
   x-axis is `navigator.hardwareConcurrency`, not `navigator.
   deviceMemory`, specifically because deviceMemory is Chrome/Edge-only
   and would leave Safari/Firefox visitors stranded at x=0; hardwareConcurrency
   is supported on all three. deviceMemory is still collected and shown
   in the tooltip as supplementary detail, not discarded. y is an
   average across *all* of a visitor's sessions, not their latest one,
   so one unusually fast or slow session doesn't misrepresent their
   hardware's typical effect. Tooltip surfaces user, browser/OS, and
   exact x/y values - built to directly answer "does this person's slow
   load time trace back to their hardware," not to be eyeballed against
   a separate table.

**Bug found and fixed while building these:** the Visitor Type pie chart
(bot/human split) undercounted against the "Unique Sessions" stat beside
it - bot/human classification only considered sessions with a `load`
event, while "Unique Sessions" counted sessions with *any* event.
Traced with live data to real sessions that bounced before `load` (and
the async image-availability check it waits on) ever fired - genuinely
unclassifiable, not a bot-detection defect. Fix: group over the full
event set so a session with zero load events resolves to `NULL`
(unclassified) rather than defaulting to "human," and show that as an
explicit third pie slice. Result: the pie chart's total now always
equals the "Unique Sessions" stat next to it, which is what surfaced the
discrepancy in the first place - the two numbers were checked against
each other directly with live data, not assumed consistent.
