# Extra Credit: JavaScript Fingerprinting + Cookie Reassociation

Live demo: [/fingerprint-demo/](/fingerprint-demo/) (linked from [Homework 2](/hw2/index.html))

## The problem this solves

The `state-nodejs` demo from HW2 identifies a returning visitor with a cookie that
holds an opaque session ID, with the actual saved data kept server-side. That works
right up until the visitor clears their cookies — at that point the site has no way
to tell "new visitor" from "someone I've seen before but who reset their cookie
jar." Without a forced login, the only way to bridge that gap is to identify the
visitor by *something other than* a value they control — which is exactly what
browser fingerprinting does.

## What was built

A library, not hand-rolled: [FingerprintJS](https://github.com/fingerprintjs/fingerprintjs)
(open-source, MIT-licensed, v4), loaded client-side from a CDN
(`cdn.jsdelivr.net`). No account or API key required — that's the paid "Pro" tier's
feature, not the open-source one used here. FingerprintJS collects a few dozen
browser/device signals (canvas rendering output, WebGL renderer info, installed
fonts, audio context fingerprint, screen/timezone/language, and more), hashes them
together, and returns a `visitorId` string that's usually stable across visits from
the same browser on the same device.

The demo lives inside the existing Node/Express app from HW2
(`hw2/nodejs/server.js`) — the one language of the three (Node/Python/C) that runs
as a persistent process rather than one-shot CGI, which is what makes an in-memory
server-side lookup table straightforward. It's deliberately kept independent of the
graded `state-nodejs` route: separate cookie name (`fp_session`, not `hw2_session`),
separate in-memory stores, separate route prefix (`/fingerprint-demo/`) — a bug here
can't affect the HW2 deliverable.

**Server-side data model:**
```js
fpSessions: Map<sessionId, { fingerprint, savedValue, firstSeen, lastSeen }>
fpIndex:    Map<fingerprint, sessionId>   // reverse lookup, this is the "reassociation" part
```

**On every page load**, the client computes its fingerprint and POSTs it to
`/fingerprint-demo/identify`, which checks, in order:

1. **Cookie present and known** → normal case, "recognized via cookie." The stored
   fingerprint is refreshed in case it drifted slightly.
2. **No/invalid cookie, but the fingerprint matches a record in `fpIndex`** →
   **reassociation**: a fresh `fp_session` cookie is issued pointing at the
   *existing* session, so the previously saved value comes back even though the
   cookie itself was gone.
3. **Neither** → new visitor, new session created.

Each outcome is shown on the page with a distinct, plainly-labeled banner (blue for
new, green for cookie-recognized, orange for reassociated) — the demo shows the
mechanism happening, rather than hiding it.

## How to see it work

1. Visit `/fingerprint-demo/` → "New visitor" (blue banner).
2. Type something into the text field and click **Save**.
3. Click **Simulate clearing cookies** — this expires just the `fp_session` cookie
   (`Set-Cookie` with `Max-Age=0`) without touching the server-side record, exactly
   mirroring what happens when a real visitor clears cookies in their browser.
4. Reload the page. The client recomputes the same (or very similar) fingerprint,
   the server finds no cookie but *does* find a matching entry in `fpIndex`, and the
   banner turns orange: reassociated, with the saved value intact.

## Limitations

- **Open-source accuracy is meaningfully lower than the paid tier.** FingerprintJS's
  own docs put the open-source version's uniqueness accuracy well below their Pro
  API, which adds server-side network-level signals and a cross-site identification
  graph this demo has no access to. Collisions (two different visitors landing on
  the same fingerprint) are possible, and this demo does nothing special to detect
  or resolve them — a collision would silently reassociate the wrong person.
- **Fingerprints aren't perfectly stable.** A browser update, OS update, a newly
  installed font, or even switching to a private/incognito window in the *same*
  browser can change the computed fingerprint enough to break the match. This isn't
  a bug in the demo; it's inherent to the technique.
- **Privacy-focused browsers specifically defeat this.** Firefox's
  `resistFingerprinting` mode, Brave's Shields, Safari's cross-site tracking
  prevention, and the Tor Browser all deliberately normalize canvas/font/audio
  output across users to make fingerprinting unreliable. Reassociation failing for
  those visitors is the *intended*, privacy-respecting outcome of those tools doing
  their job, not a flaw in this implementation.
- **Requires JavaScript.** The fingerprint is computed entirely client-side, so a
  visitor with scripting disabled can't be fingerprinted this way at all — there is
  no fallback path here. A weaker, coarser alternative would be passive server-side
  signals (User-Agent, Accept-Language, IP address), which don't need JavaScript but
  are far less unique per-visitor and easily shared by many people behind the same
  NAT/proxy. That alternative was considered but not built, to keep this demo
  focused on the JS-fingerprinting technique the assignment asks about.
- **In-memory only.** Like `state-nodejs`, all records live in the Node process's
  memory — a service restart clears every session and every known fingerprint.
- **No eviction.** `fpIndex` keeps every fingerprint it has ever seen, forever. Fine
  for a short-lived class demo; a real deployment would need a TTL or size cap.
- **Ethical/legal note.** This page is transparent about what it's doing precisely
  because a real production use of fingerprinting for tracking generally requires
  the same consent treatment as cookies under GDPR/CCPA — fingerprinting is
  frequently used specifically to *evade* cookie-consent controls, which is why
  regulators increasingly treat it as functionally equivalent to a persistent
  cookie.
