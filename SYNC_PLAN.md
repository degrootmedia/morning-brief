# Morning Brief — Cloud Sync + Android (PWA) Plan

**Handoff document.** Written for an implementing agent working in this repo.
Read it end to end before writing code. No code has been written yet — this is
the design + task list only.

**Decisions locked in (from the user):**
1. Backend: **Supabase** (free tier) — Auth + Postgres.
2. First delivery: **PWA in the tablet browser** (no APK yet).
3. Deliverable now: **this plan** (no implementation yet).
4. Sign-in: **email + password**.
5. Gab key: **stored in the synced blob** (reaches all devices; RLS-protected).
6. **PC signs in too** — the Electron app and the browser use the same cloud
   account, so PC ↔ tablet sync directly (not just via the vault).
7. Sync cadence: **pull every 60 s** (+ on focus), debounced push. No Realtime.
8. Static hosting: **GitHub Pages**.

**Repo as of this writing:** `D:\Dashboard` — single-file `index.html`, a
zero-dep companion server (`lib/server.js`, `serve.js`), and an Electron shell
(`electron/`). No build step, no framework. `SYNC_PLAN.md` (this file) is new.

---

## 1. Goal

Add optional **sign-in + cloud sync** so the dashboard works as a **PWA on
Android** (and any browser) and stays in sync with the PC, with:

1. Email sign-in (Supabase Auth).
2. One synced dataset per user (todos, projects+tasks, hours, shortcuts, news,
   calendar, settings).
3. Offline-first: the app still works with no network and reconciles on reconnect.
4. Calendar/news proxying and Gab AI working from the hosted PWA (the local
   `serve.js` isn't available there).

### Non-goals (explicitly out of scope for v1)

- Native APK (Capacitor) — a follow-up once the PWA is solid.
- Play Store listing.
- Real-time multi-user collaboration / CRDT merge.
- Migrating the Obsidian vault to the cloud (the vault stays a PC-local feature).
- Launching PC apps from the tablet.

---

## 2. Invariants — do not break these

1. **`index.html` stays a single self-contained file** (inline CSS/JS, no
   bundler, no `import`). Cloud features are added behind feature detection.
2. **Browser mode and Electron mode keep working unchanged.** Cloud is additive.
3. **Markdown-first stays.** The six `.md` vault files remain the PC's
   source of truth; cloud sync is a separate, additive layer.
4. **The companion server stays zero-dependency.**
5. **Feature-detect, don't fork** — one `index.html`, three hosts (browser /
   Electron / cloud PWA), gated on which bridge object is present.

---

## 3. Current architecture (recap)

```
Browser:   index.html  ->  serve.js  ->  http://localhost:8787  (/proxy, /launch, /ai/chat)
Electron:  index.html  ->  lib/server.js (embedded)  +  window.morningBrief (IPC)
State:     localStorage ("morning-brief.state.v1") + optional Obsidian vault (.md)
AI:        renderer -> local server /ai/chat -> https://gab.ai/v1/chat/completions
```

The dashboard already has a clean host-detection seam:
`const isDesktop = !!(window.morningBrief && window.morningBrief.version)`.
Cloud becomes a third host, detected the same way.

---

## 4. Target architecture

```
┌─────────────── Cloud PWA (tablet browser) ───────────────┐
│  index.html (served over HTTPS by a static host)          │
│     │                                                     │
│     ├─ window.mbCloud  (injected cloud module)            │
│     │     • auth:  Supabase Auth (email)                  │
│     │     • sync:  pull/push state row <-> Postgres       │
│     │     • proxy: Supabase Edge Function "proxy"         │
│     │     • ai:    Supabase Edge Function "ai" -> Gab     │
│     └─ localStorage (offline cache; source while offline) │
└───────────────────────────────────────────────────────────┘
                     │ HTTPS
                     ▼
┌────────────────────────── Supabase (free tier) ───────────────────────────┐
│  Auth            email sign-in / sessions                                 │
│  Postgres        table: dashboards (user_id PK, state jsonb, updated_at)  │
│                  RLS: users read/write only their own row                 │
│  Edge Functions  proxy  (fetch .ics/RSS server-side)                      │
│                  ai     (forward to gab.ai, keep key off-device)          │
└───────────────────────────────────────────────────────────────────────────┘

Static host (Cloudflare Pages / Netlify / Vercel / GitHub Pages — free, HTTPS)
  serves index.html + manifest.webmanifest + sw.js + mb-cloud.js

PC unchanged: Electron app + serve.js. It may OPTIONALLY sign in too (later).
```

**Why a cloud module instead of editing the dashboard's network layer?** The
dashboard already knows how to talk to "a server" (`localServerBase()` +
`/proxy`, `/ai/chat`). In cloud mode we point those at Supabase Edge Functions.
Everything else (rendering, serialization, vault) is untouched.

---

## 5. Key decisions and rationale

1. **Sync the whole `state` JSON as one row** (not the six `.md` files). The
   in-memory `state` is the app's canonical model and already contains every
   feature's data plus settings (proxy, blocklist, AI key). One row = simplest
   correct thing. The `.md` vault stays a PC-local nicety.
2. **Last-write-wins on `updated_at`** for v1. Single user, few devices — LWW is
   adequate. Store `updated_at` (server clock via `now()`) and a client
   `syncedAt` watermark. Field-level/CRDT merge is a later enhancement.
3. **Offline-first**: `localStorage` is always the working copy; the network is
   an async reconciler. The UI never blocks on sync.
4. **Debounced push** (~1.5 s after `save()`) and **pull on boot + on
   focus/interval** (~60 s). Optional Realtime subscription later.
5. **Edge Functions for `proxy` and `ai`.** A hosted PWA has no local server, so
   CORS-sensitive fetches (Google `.ics`, RSS, Gab) must be server-side. Functions
   are free-tier friendly and reuse the same logic as `lib/server.js`.
6. **Gab key lives in the synced blob** (user's choice). It's stored in the
   RLS-protected `dashboards.state`, syncs to every signed-in device, and is sent
   per request to the `ai` Edge Function, which verifies the JWT and forwards it
   to Gab. Trade-off: the key sits in the DB row and on each device — fine for a
   personal key; never log it.
7. **`mb-cloud.js` is a separate plain script file** (no bundler, no imports).
   `index.html` loads it with `<script src="mb-cloud.js" defer></script>` and the
   dashboard feature-detects `window.mbCloud`. A missing file is harmless (script
   404), so `file://` mode still works. This relaxes the "single file" invariant
   only to "no build step / no framework" — all CSS/JS stays inline.
8. **GitHub Pages hosts the PWA** (free, HTTPS). The published directory holds
   `index.html`, `mb-cloud.js`, `manifest.webmanifest`, `sw.js`, and the icons.

---

## 6. Data model & sync semantics

### Supabase table

```sql
create table public.dashboards (
  user_id     uuid primary key references auth.users(id) on delete cascade,
  state       jsonb not null default '{}'::jsonb,
  revision    bigint not null default 0,      -- optional optimistic concurrency
  updated_at  timestamptz not null default now()
);

alter table public.dashboards enable row level security;

create policy "own row - select" on public.dashboards
  for select using (auth.uid() = user_id);
create policy "own row - insert" on public.dashboards
  for insert with check (auth.uid() = user_id);
create policy "own row - update" on public.dashboards
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
```

Optionally store the Gab key separately (`ai_secrets`) if you don't want it in
the synced blob.

### Client-side sync state (localStorage, separate keys)

```
morning-brief.state.v1     the existing app state (unchanged)
mb.sync.syncedAt           ISO time of the last successful pull/push
mb.sync.dirty              "1" while local changes await push
mb.auth.*                  Supabase session (managed by supabase-js)
```

### Reconciliation (LWW)

```
on boot:
  state = loadState()                    # instant, offline
  if signedIn: reconcile()

reconcile():
  remote = GET dashboards where user_id = me
  if !remote:            push(local)                 # first device
  else if remote.updated_at > syncedAt:
     if !dirty:          adopt(remote); syncedAt = remote.updated_at
     else:               push(local)                 # local wins (documented)
  else if dirty:         push(local)

on save():  local already saved; mark dirty; debounce(push, 1500)
push():     UPSERT dashboards(user_id, state=serialize(state), updated_at=now())
            on success: dirty=false; syncedAt=server updated_at
```

Conflict policy for v1 is **last writer wins**; surface a small status chip
("Synced · 2m ago" / "Offline" / "Conflict"). A future version can diff per
top-level key.

---

## 7. Auth

- **Supabase Auth, email + password** (locked in). OAuth later if wanted.
- Decide on email confirmation: disable it for a frictionless personal setup, or
  keep the default confirm-email flow.
- Client uses `supabase-js` from a CDN (`<script src=".../@supabase/supabase-js">`),
  which sets a global — no bundler needed.
- Session persists in localStorage; auto-refresh handled by the SDK.
- Minimal UI: a "Sign in" button in the header (next to Setup) opening a modal;
  shows the user's email + "Sign out" when logged in.

---

## 8. Edge Functions

Two functions, deployed with the Supabase CLI (free tier: 500k invocations/mo).

- **`proxy`** — `GET ?url=` : validate `http(s)`, 25 s timeout, forward
  `Accept`/`User-Agent`, return body + content-type with CORS `*`. Mirrors
  `handleProxy` in `lib/server.js`.
- **`ai`** — `POST { request }` : read the caller's Gab key (from their row, or
  from the request body), forward `request` to `https://gab.ai/v1/chat/completions`
  with `Authorization: Bearer <key>`, 90 s timeout, return upstream status/body.
  Mirrors `handleAiChat`. Requires a valid Supabase JWT (verify with
  `auth.getUser()`); do **not** expose the service role to the client.

---

## 9. Client integration points (`index.html`, surgical)

Add alongside the existing `isDesktop` constant:

```js
const isCloud = !!(window.mbCloud && window.mbCloud.version);
```

Five targeted changes (same spirit as the Electron work):

1. **Proxy URL** — `fetchIcs()` / `refreshNews()` use a helper:
   ```js
   function proxyBase(){ return isCloud ? window.mbCloud.proxyBase : localServerBase(); }
   ```
   (In cloud mode the prefix is the `proxy` function URL.)
2. **AI** — `aiChat(request)` branches: `isCloud` → `window.mbCloud.aiChat(request)`;
   else the existing local-server fetch.
3. **Launch** — hide Launchpad launch behavior in cloud mode (no OS launching);
   web links still open in a new tab.
4. **Sync hooks** — call `window.mbCloud.sync.markDirty()` inside `save()`, and
   `window.mbCloud.sync.start({ getState, setState })` in `boot()` after
   `loadState()`/`renderAll()`.
5. **Header** — add a Sign-in / account button; leave the 🖥️ badge out (already
   removed).

`window.mbCloud` contract (implemented by `mb-cloud.js`):

```js
window.mbCloud = {
  version: "1",
  proxyBase: "https://<ref>.functions.supabase.co/proxy?url=",
  auth: {
    user: () => ({ email } | null),
    signIn(email, password), signUp(email, password), signOut(),
    onChange(cb),
  },
  aiChat: (request) => Promise<object>,      // same shape as the local /ai/chat
  sync: {
    start({ getState, setState }),           // wires pull/push + intervals
    markDirty(), status: () => "synced"|"pending"|"offline",
    onChange(cb),
  },
};
```

**PC / Electron (v1):** the embedded server serves files from the app root, so
`mb-cloud.js` resolves at `/mb-cloud.js` and the same `<script>` tag loads it in
the desktop app too. Electron therefore gets the same sign-in + sync as the
tablet, giving direct PC ↔ tablet sync. Same origin, so no CSP/navigation change
is needed. The Obsidian vault stays optional and PC-local.

---

## 10. PWA packaging

Files added next to `index.html` (all static, no build):
- `manifest.webmanifest` — name, icons (reuse `build/icon.png` → 192/512 PNG),
  `display: standalone`, theme/background colors.
- `sw.js` — cache the app shell (`index.html`, icons, fonts fallback) for offline;
  network-first for data (data is in localStorage anyway).
- `mb-cloud.js` — the cloud module (auth + sync + function calls).
- `index.html` gains exactly one line: `<script src="mb-cloud.js" defer></script>`.
  Where the file is absent (bare `file://`) the script 404s harmlessly, so browser
  mode is unaffected.

**GitHub Pages:** publish a repo (or a `/docs` folder, or a `gh-pages` branch)
containing the files above. Pages serves over HTTPS (required for the service
worker and for Supabase) and needs no server-side code. Enable via
Settings → Pages → Deploy from a branch. Custom domain optional.

Android: "Add to Home screen" gives a full-screen PWA. APK/Capacitor is Phase 6.

---

## 11. Hosting & cost

| Piece | Choice | Cost |
| --- | --- | --- |
| Static PWA hosting | **GitHub Pages** | $0 |
| Auth + DB + Edge Functions | Supabase free tier (50k MAU, 500 MB DB, 500k fn calls/mo) | $0 |
| Domain | `*.pages.dev` / `*.netlify.app` subdomain | $0 |
| APK (later) | Capacitor build, sideload | $0 |
| Play Store (later) | one-time developer registration | $25 |

**Total for the PWA path: $0.** Only upgrade if you outgrow free limits (a
single user won't).

---

## 12. Security checklist

- [ ] RLS enabled; every table has `auth.uid()` policies (no anon access).
- [ ] `anon` key may be public (it's designed to be); **service role key never
      ships to the client** — only inside Edge Functions (env).
- [ ] Edge Functions verify the caller's JWT before doing work.
- [ ] `proxy` restricts to `http(s)` and never follows to `file:`/`data:`.
- [ ] Gab key lives in the RLS-protected row + device storage (by design); sent
      per request to `ai` and never logged.
- [ ] HTTPS everywhere (hosts + Supabase are HTTPS by default).
- [ ] No secrets in the repo; Supabase URL + anon key are config, not secrets.

---

## 13. Task list (ordered, each independently verifiable)

**Phase 0 — Supabase project (manual, ~15 min)**
1. Create a Supabase project; note `Project URL` + `anon key`. Run the SQL from
   §6. Enable email auth. *Accept:* the table exists with RLS on.

**Phase 1 — Cloud module (no dashboard edits yet)**
2. Write `mb-cloud.js`: init `supabase-js` (CDN), auth (sign up/in/out,
   `onChange`), session persistence. *Accept:* a bare test page signs in and
   shows the user's email.
3. Implement `sync.start/markDirty/status` per §6. *Accept:* two browser
   profiles signed into the same account converge to the same `state`.
4. Implement `aiChat()` and `proxyBase` against the Edge Functions. *Accept:*
   AI + a calendar `.ics` fetch work from a plain page.

**Phase 2 — Edge Functions**
5. Deploy `proxy`. *Accept:* `curl` with a JWT returns an ICS/RSS body; without
   a JWT → 401.
6. Deploy `ai`. *Accept:* a chat request returns a Gab response; bad key → 401
   surfaced cleanly.

**Phase 3 — Wire the dashboard**
7. Add `isCloud`, the five integration points (§9), and the account button.
   *Accept:* in browser mode nothing changes; in cloud mode the app syncs and
   AI/proxy work.
8. Offline test: go offline, edit, come back online → changes push; second
   device pulls them. *Accept:* no data loss, status chip accurate.

**Phase 4 — PWA**
9. `manifest.webmanifest` + `sw.js` + icons. *Accept:* Lighthouse PWA installable;
   "Add to Home screen" opens standalone on Android.
10. On the tablet: sign in, edit todos on the tablet, confirm they appear on the
    PC (and vice versa). *Accept:* round-trip within ~2 s while online.

**Phase 5 — PC sign-in (v1)**
11. Confirm the Electron app loads `mb-cloud.js` (served from the app root) and
    signs in. *Accept:* edit on the PC → appears on the tablet within ~60 s and
    vice versa; the vault remains optional.

**Phase 6 — Native APK (later)**
12. Capacitor wrap → sideloaded APK. *Accept:* same behavior as the PWA in an APK.

---

## 14. Test plan

- **Automated:** a Node script that hits the `proxy` function (expect 200/401)
  and a Supabase RLS check (user A cannot read user B's row → 0 rows).
- **Manual:** the offline→online reconciliation on two devices; the conflict
  chip; AI and calendar sync from the tablet; PWA install + standalone launch.

---

## 15. Risks and mitigations

| Risk | Likelihood | Mitigation |
| --- | --- | --- |
| LWW clobbers concurrent edits (PC vault vs tablet) | Med | Single-user; status chip + "pull now"; note the behavior. CRDT later. |
| Supabase free tier limits | Low | 500 MB / 50k MAU is far above one user. |
| `index.html` single-file invariant vs adding cloud JS | Med | Ship `mb-cloud.js` as a separate hosted file; inject via host/transform. |
| Edge Function cold starts | Low | Acceptable for a dashboard; retry on 5xx. |
| Gab key leakage | Med | It's in the RLS-protected row + device storage by design; the `ai` function verifies the JWT; never log it. |
| CORS/proxy abuse of the `proxy` function | Med | Require a valid JWT; rate-limit; restrict to http(s). |
| PWA offline staleness | Low | localStorage is always the working copy; reconcile on focus. |

---

## 16. Resolved decisions

1. Sign-in: **email + password** (Supabase Auth).
2. Gab key: **in the synced blob** (RLS-protected; sent per request to `ai`).
3. **PC (Electron) and browser both sign in** — direct PC ↔ tablet sync.
4. Sync: **pull every 60 s** + on window focus; debounced push (~1.5 s). No Realtime.
5. Static hosting: **GitHub Pages**.

---

## 17. Appendix — one-time setup (you do this, ~15 min)

**Supabase**
1. supabase.com → **New project** (free tier). Copy the **Project URL** and
   **anon key** from Settings → API.
2. SQL Editor → paste the schema from §6 → **Run**.
3. Auth → Providers → **Email**: enabled. Choose whether to require email
   confirmation (off = frictionless personal setup).
4. Install the CLI once: `npm i -g supabase`, then `supabase login` and
   `supabase link --project-ref <ref>`.
5. Create + deploy the two functions: `supabase functions new proxy` and
   `supabase functions new ai`, paste §8, then
   `supabase functions deploy proxy ai`.
6. (Only if you keep the key server-side) `supabase secrets set GAB_API_KEY=…`.
   With the key-in-blob decision, no secret is required.

**GitHub Pages**
1. Push this repo to GitHub.
2. Settings → Pages → **Deploy from a branch** (`main` / root, or `/docs`).
3. Note the URL: `https://<user>.github.io/<repo>/`.
4. Put the Supabase URL + anon key into `mb-config.js`. (The anon key is *meant*
   to be public — RLS is what protects your data. Never commit the service-role
   key.)

Then open the Pages URL on the tablet, sign in, and **Add to Home screen**.

---

## 18. Definition of done (v1 = PWA)

- [ ] Signed-in user's state syncs across two browsers/devices (LWW), offline-safe.
- [ ] Calendar sync + Gab AI work from the hosted PWA.
- [ ] Browser mode and Electron mode are unchanged.
- [ ] Installable PWA, runs standalone on the Android tablet.
- [ ] Security checklist (§12) fully satisfied.
- [ ] README documents hosting + the free-tier setup.
