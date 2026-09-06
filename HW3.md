# HW3 — collector.js: Changes Beyond the Collector Tutorial

The 10-module Collector Tutorial at cse135.site walks through building a beacon
script incrementally, but the actual assignment checklist required several
things the tutorial never covers at all, and a few places where the tutorial's
approach had to be changed to work in a real, non-demo deployment. This
document describes those differences — not the tutorial content itself, which
`collector-v1.js` through `collector-v9.js` in this repo already follow closely.

The file being described is the final, non-versioned `collector.js` — the one
actually loaded on the production homepage — built fresh from the assignment's
own data checklist rather than as another `-vN` increment of the tutorial.

## Static data the tutorial never asks for

The tutorial's technographics module (02) covers user agent, language, cookie
support, viewport/screen size, and network info. The assignment's checklist
required three fields with no tutorial coverage and no browser API that
answers them directly:

- **`jsEnabled`** — there's no way for JavaScript to detect that JavaScript is
  disabled (a contradiction: the script only runs if JS is on). This field is
  hardcoded `true`; the honest way to capture the negative case is a
  `<noscript>` fallback pixel on the page itself (reusing the Module 03
  tracking-pixel pattern), which is a separate, page-level mechanism rather
  than something `collector.js` itself can report.
- **`imagesEnabled`** — no `navigator` property exposes this. Detected
  empirically: load a same-document base64 data-URI 1×1 GIF (no network
  round trip) and check whether `onload` fires with `naturalWidth > 0` vs.
  `onerror`, with a timeout fallback that assumes enabled if neither fires.
- **`cssEnabled`** — also has no direct API. Detected empirically: inject a
  `<style>` rule with a highly specific, collision-proof value
  (`color: rgb(1, 2, 3)`), apply it to a throwaway probe element, and check
  `getComputedStyle` to see if the browser actually applied it.

## Performance data: a different shape than the tutorial teaches

Module 05 teaches extracting specific computed deltas from
`PerformanceNavigationTiming` (`dnsLookup`, `tcpConnect`, etc.) — never the raw
entry itself. The checklist asked for "the whole timing object," so
`collector.js` calls `entry.toJSON()` and sends that in full, in addition to
two fields the tutorial doesn't compute at all: absolute `pageLoadStart` /
`pageLoadEnd` ISO timestamps (via `performance.timeOrigin + entry.startTime` /
`entry.loadEventEnd`), and a manually-computed `totalLoadTimeMs`.

## Activity data: built from scratch, not in the tutorial

The tutorial's only activity-tracking content is error tracking (Module 07)
and a click-tracking plugin (Module 09, with debounce and a CSS-selector-path
builder). None of the following exist anywhere in the tutorial; all of it was
designed for this assignment specifically:

- **Mousemove tracking** — sampled at ~150ms intervals (not every raw event,
  which can fire 60–100×/sec) into a buffer.
- **Scroll position tracking** — raw `{x, y}` coordinates, not the percentage-
  depth-threshold approach Module 09's scroll extension uses.
- **Keyboard tracking** — `keydown`/`keyup` with `key` and `code`, entirely
  absent from the tutorial.
- **Idle-period detection** — a from-scratch, event-driven algorithm: every
  activity listener calls a shared `noteActivity()` that checks the gap since
  the last activity; if ≥2000ms, it records `{idleEndedAt, durationMs}` before
  updating the timestamp. No polling loop — the check only runs when activity
  actually happens.
- **Batched delivery** — all of the above (plus errors, see below) accumulate
  in memory and flush as a single `activity` beacon every 10 seconds and on
  page-hide, rather than one beacon per event. This is a deliberate design
  choice: sending one HTTP request per mousemove would be absurd at 60–100
  events/sec, so continuous signals are batched the same way Module 09's
  scroll-depth extension batches threshold crossings, extended to every
  activity type at once.

## A tutorial pattern deliberately changed: error delivery

Module 07's reference design sends each deduplicated error as its own
immediate beacon. `collector.js` keeps the same dedup-by-`type:message:source:
line:src` key and the same 25-error cap, but folds errors into the periodic
`activity` batch instead of sending them individually — consistent with
treating "continuously collected" activity data (errors included) as one
category delivered on one cadence, rather than errors being a special case
with their own beacon cadence.

## Deployment reality the tutorial's same-origin demos never hit

The tutorial's demo pages always load `collector-vN.js` and post to `/collect`
on the same origin, so a relative endpoint path just works. The real
deployment serves `collector.js` from `collector.shekarkrishnamoorthy.com` but
loads it on the actual homepage at `shekarkrishnamoorthy.com` — a different
origin. Two consequences the tutorial never has to deal with:

1. **The endpoint must be an absolute URL**
   (`https://collector.shekarkrishnamoorthy.com/collect`), not a relative
   `/collect` path, or beacons would silently target the wrong origin.
2. **A real CORS bug**: `navigator.sendBeacon()` requests are always sent
   credentialed, even cross-origin, per the Beacon API spec — and CORS
   forbids pairing a credentialed request with a wildcard
   `Access-Control-Allow-Origin`. This only surfaced once the script was
   actually running cross-origin in a real browser; the fix was to reflect
   the request's `Origin` header literally (plus
   `Access-Control-Allow-Credentials: true`) instead of using `*`.

## The one place the tutorial's own technique was reused directly

The assignment calls session-tying "the challenging point" and explicitly
says it's left for the student to figure out. This one *is* solved with the
tutorial's own Module 02 technique — a `sessionStorage`-backed random session
ID, generated once and reused for the life of the tab — applied as-is rather
than modified, since it already satisfies the requirement (every beacon in a
visit carries the same session ID, tying static/performance/activity data
together without cookies).

## Storage beyond the tutorial

Module 04 teaches appending JSON Lines to a flat file. Production storage
here is a real MySQL table (`analytics.events`) with a JSON payload column
and indexed generated columns for the numeric fields (`total_load_time_ms`,
`lcp_value`, `cls_value`, `inp_value`) that reporting queries actually
aggregate on — the tutorial never uses a database at all.
