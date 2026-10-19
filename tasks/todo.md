# Plan — hours editing, weekly dropdowns, news hardening

## Findings
- Hours live in `state.hours.entries` ({id,date,client,project,minutes,note}); the
  timesheet only displays aggregates — no edit path exists.
- Client/project are plain text inputs in the Log time / Log timer dialogs.
- News (`refreshNews`) uses a single proxy (`activeProxyPrefix`), has no timeout,
  can't read JSON-wrapped proxy payloads (calendar can), and **overwrites cached
  stories with an empty list when a fetch fails** — a 1–2 day public-proxy outage
  (e.g. allorigins) wipes the feed until the proxy recovers.

## Tasks
- [x] Failing tests first (`tests/dashboard.test.js`, `node --test`, no new deps):
  weekly suggestion derivation, entry edit/merge, feed proxy fallback, server retry.
- [x] Edit hours: timesheet day cells become buttons — saved cell opens an edit
  dialog (date/hours/client/project/note + Delete), empty cell pre-fills Log time.
  Edits that collide with another entry merge (same rule as `logEntry`).
- [x] Dropdowns: `<datalist>` suggestions derived from current-week entries only
  (projects narrow to the chosen client); free text still allowed. Applied to
  Log time, Log timer, and Edit entry dialogs. Resets each week automatically
  because `normalizeHours` archives prior weeks at boot.
- [x] News hardening: try every proxy (local → cloud → public → direct) per feed
  with a 12s timeout, unwrap JSON payloads, fetch a topic's feeds in parallel,
  never replace cached stories with an empty result, show "Updated …" staleness.
- [x] Server hardening (`lib/server.js` + `supabase/functions/proxy`): retry
  transient upstream failures, fall back to a browser UA on 401/403/406.
- [x] Verify: `npm test`, boot `node serve.js`, exercise hours edit + dropdowns +
  news refresh (incl. a simulated dead proxy) in a real browser.

## Review
- `npm test`: 6/6 pass (was red before the changes, as expected).
- Headless Edge against `node serve.js` (seeded state): 16/17 checks passed —
  cell edit persisted (120→210 min), dropdowns listed exactly this week's
  clients, narrowed projects by client, picked up a newly logged client/project,
  delete+confirm worked, last week's client stayed out of the dropdowns, and a
  refresh with every proxy dead kept the cached story with an honest toast.
  The one failure was the live-internet fetch: this sandbox has no external DNS
  (`blog.blender.org` unresolved even direct), so the live chain was re-proven
  against a local RSS server that 502'd once — stories loaded through
  dead-proxy → local-proxy (2 feed hits = server retry worked).
- Note: the hosted/PWA proxy copy (`supabase/functions/proxy`) needs a redeploy
  (`supabase functions deploy proxy`) to pick up the retry hardening; the local
  server and Electron app get it automatically. Existing saved data needs no
  migration (same state shape).
- Follow-up: moved the status/activity toast area (`#status`) below `</main>`
  so updates appear under all panels and never shift them; verified in Edge
  (panel tops identical before/during/after a toast) and rebuilt `dist/`.

---

# Plan — greeting refreshes during the day (no restart needed)

## Findings
- `renderGreeting()` (index.html) derives morning/afternoon/evening from the
  current hour correctly, but its only callers are `renderAll()` at boot and
  the Setup name input — nothing re-runs it, so the header goes stale.
- Boot already runs several `setInterval`s (clock 15s, timer 1s,
  hours/calendar 60s, server ping 20s); the greeting is the odd one out.

## Tasks
- [x] Failing test first: boot must schedule `renderGreeting` on a repeating
  timer of an hour or less (`tests/dashboard.test.js`, source-level guard —
  same pattern as the `refreshNews` test).
- [x] Fix: `setInterval(renderGreeting, 60000)` alongside the other boot
  timers. A minute check (well inside "every hour or so") so the greeting
  flips promptly at noon/6pm instead of lagging up to an hour.
- [x] Verify: `npm test` green; boot `node serve.js` and confirm in a real
  browser that the greeting updates live without a reload.

## Review
- `npm test`: 8/8 pass (new greeting test was red before the fix, as expected).
- Headless Edge against `node serve.js` (port 8797): page loaded at 12:xx
  showing "Good afternoon"; the probe then stubbed the hour to 9am *without
  reloading* and the header flipped to "Good morning" on the timer's next
  tick, with no page exceptions. Throwaway probe kept at
  `%TEMP%\probe-greeting.mjs` (not part of the project).
- One changed line in `index.html`; no state or markup changes, so the
  Electron app and PWA pick it up with no other action needed.
