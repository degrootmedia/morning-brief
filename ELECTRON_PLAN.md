# Morning Brief — Electron App: Implementation Plan

**Handoff document.** Written for an implementing agent (OpenCode) working in this
repository. Read it end to end before writing code.

**Repo as of this writing:** `D:\Dashboard`

```
index.html             1906 lines / 92 KB   — the entire dashboard (inline CSS + JS)
serve.js                234 lines /  8.9 KB — local companion server (static + /proxy + /launch)
Start Dashboard.bat                          — double-click launcher for browser mode
README.md               166 lines            — user docs
body1.txt                                    — unrelated scratch file, ignore
.cascade/                                    — tool scratch dir, ignore
```

There is **no `package.json`, no `node_modules`, and no build step today.**

---

## 1. Goal

Ship a standalone Windows desktop app for the dashboard so it:

1. Runs in its **own window** (no browser chrome), with its own taskbar entry and icon.
2. Can **launch apps, custom protocols, `.exe` files and folders** natively (today this
   works only via the local HTTP server).
3. Manages the **Obsidian vault** through the real filesystem, so it survives restarts
   without re-granting permissions.
4. Installs as a normal Windows app (installer **and** a portable `.exe`).
5. **Does not regress browser mode.** `index.html` opened directly, and
   `Start Dashboard.bat`, must keep working exactly as they do now.

### Non-goals (explicitly out of scope)

- Auto-update / code signing / Microsoft Store.
- macOS or Linux builds (keep the code portable, but only Windows is tested/shipped).
- Two-way Google Calendar API sync (still the read-only iCal feed).
- Replacing the Markdown-first storage model.

---

## 2. Current architecture (what exists, and what must change)

The dashboard is a single HTML file. For the features that a browser can't do, it talks
to a **zero-dependency Node server** it expects at `http://localhost:8787`:

| Endpoint | Purpose | Client caller in `index.html` |
| --- | --- | --- |
| `GET /health` | liveness probe → shows the 🖥️ Desktop badge | `pingServer()` |
| `GET /proxy?url=` | server-side fetch of `.ics` / RSS (no CORS) | `fetchIcs()`, `refreshNews()` |
| `GET /launch?target=` | opens URL / protocol / file via OS | `openShortcut()` |
| `GET /` + static | serves the dashboard itself | — |

`/launch` is gated: it requires a local `Origin` (`null` from `file://`, or
`localhost`/`127.0.0.1`) **and** the header `X-Morning-Brief: 1`. The server binds to
`127.0.0.1` only.

The dashboard also uses the **File System Access API** (`window.showDirectoryPicker`,
`getFileHandle`, `createWritable`) for the vault, persisting the directory handle in
IndexedDB (`idbSet("dir", dirHandle)`).

### What must change for Electron

| Area | Change? | Why |
| --- | --- | --- |
| Networking (`/proxy`) | **No change** | Reuse the same server; Electron just runs it. |
| Server itself | **Refactor** | Split into a reusable module so both `serve.js` (CLI) and Electron can start it. |
| Launcher | **Add native path** | Use Electron `shell.openExternal`/`openPath` via IPC; disable the HTTP `/launch` surface in-app. |
| Vault | **Replace in desktop mode** | File System Access API permission persistence is unreliable under Electron. Use Node `fs` + a native folder dialog over IPC. Keep the browser path intact. |
| Web links | **Intercept** | `window.open` inside Electron would spawn a new BrowserWindow; route to the system browser instead. |

---

## 3. Target architecture

```
┌───────────────────────────── Electron (single app) ─────────────────────────────┐
│                                                                                 │
│  electron/main.js  ──(require)──►  lib/server.js  ──►  http://127.0.0.1:<port>  │
│     │  • startServer({port:0, enableHttpLaunch:false})                          │
│     │  • BrowserWindow.loadURL(serverUrl)                                       │
│     │  • IPC handlers: mb:vault:*, mb:launch, mb:openExternal                   │
│     │  • window lifecycle, config (window bounds, vault path)                   │
│     │                                                                           │
│     ├─ preload.js ──contextBridge──► window.morningBrief  (renderer API)        │
│     │                                                                           │
│     └─ BrowserWindow ──loads──► index.html (served by the embedded server)      │
│                                    │                                            │
│                                    ├─ /proxy   (unchanged — calendar, news)     │
│                                    ├─ window.morningBrief.vault.*   (new)       │
│                                    └─ window.morningBrief.launch()   (new)      │
└─────────────────────────────────────────────────────────────────────────────────┘

Browser mode (unchanged):  index.html  →  Start Dashboard.bat  →  serve.js (CLI)
```

**Why run the embedded server rather than rewriting the dashboard's network layer?**
The proxy and launcher logic are already written, tested, and depended on by
`index.html`. Keeping the server means **networking needs zero dashboard changes**.
The only renderer-side additions are the vault and launch IPC paths, gated behind
feature detection so browser mode is untouched.

---

## 4. Key decisions and rationale

1. **Reuse the server via a shared module, not a child process.** Spawning `serve.js`
   as a subprocess risks orphaned processes and port races. Extract `lib/server.js` and
   `require` it in-process.
2. **Ephemeral port in Electron (`port: 0`).** Avoids `EADDRINUSE` conflicts with the
   CLI server. The dashboard's `localServerBase()` already returns `location.origin`
   when the page is served from `localhost`/`127.0.0.1`, so a random port works with no
   client change.
3. **Disable HTTP `/launch` inside Electron (`enableHttpLaunch: false`).** IPC replaces
   it, so there is no reason to keep an HTTP surface that can execute programs.
4. **Vault via IPC + `fs`, not the File System Access API.** A stored absolute path in
   the app config is stable across restarts; `showDirectoryPicker` permissions are not.
   The native `dialog.showOpenDialog` is also a better UX.
5. **Keep `index.html` the single source of truth.** No framework, no bundler. Electron
   loads the same file. This preserves browser mode for free.
6. **Feature-detect, don't fork.** All desktop behaviour is gated on
   `window.morningBrief` being present. One codebase, two hosts.

---

## 5. Target repository layout

```
package.json                     NEW  — electron + electron-builder, scripts
lib/
  server.js                      NEW  — extracted server module (from serve.js)
serve.js                         EDIT — thin CLI wrapper around lib/server.js
electron/
  main.js                        NEW  — app entry (package.json "main")
  preload.js                     NEW  — contextBridge API
  config.js                      NEW  — tiny JSON config store (userData)
build/
  icon.ico                       NEW  — 256×256+ app icon
index.html                       EDIT — vault + launch feature-detection branches
README.md                        EDIT — desktop app section
Start Dashboard.bat              KEEP — browser mode still supported
electron-builder.yml             NEW  — packaging config (or inline in package.json)
```

---

## 6. Code contracts (implement exactly these signatures)

### 6.1 `lib/server.js`

Extract the current `serve.js` logic verbatim, changing only the entry point. **Preserve
all existing behaviour and security gates** — this is tested code.

```js
/**
 * @param {object} [opts]
 * @param {number} [opts.port=8787]   0 = pick a free port
 * @param {string} [opts.host="127.0.0.1"]
 * @param {string} [opts.root]        directory to serve statics from (default: repo root)
 * @param {boolean} [opts.enableHttpLaunch=true]  when false, /launch returns 404
 * @param {boolean} [opts.openBrowser=false]
 * @param {object} [opts.logger=console]
 * @returns {Promise<{ url:string, port:number, close:()=>Promise<void> }>}
 */
async function startServer(opts = {}) { /* ... */ }

module.exports = { startServer };
```

Requirements:
- `/proxy` keeps the 25 s `AbortController` timeout, JSON-unwrap tolerance is *not* here
  (that lives in the client), and the `Access-Control-Allow-Origin: *` response header.
- `/launch` keeps the `allowedOrigin()` + `X-Morning-Brief` gate when enabled.
- `/health` returns `200 ok`.
- Static serving keeps the path-traversal guard (`filePath.startsWith(ROOT)`).
- `close()` stops the listener and resolves when closed.
- Binds `127.0.0.1` by default.

### 6.2 `serve.js` (CLI, after refactor)

```js
#!/usr/bin/env node
"use strict";
const { startServer } = require("./lib/server");
const PORT = process.env.PORT ? Number(process.env.PORT) : 8787;

startServer({ port: PORT, openBrowser: !process.env.NO_OPEN })
  .then(({ url }) => { /* banner + endpoint lines, as today */ })
  .catch((err) => {
    if (err && err.code === "EADDRINUSE") { /* friendly message, exit 1 */ }
    else { console.error(err); process.exit(1); }
  });
```
Behaviour must be **byte-for-byte equivalent** to today for browser users: same banner,
same `PORT` env override, same `NO_OPEN` support, same EADDRINUSE message.

### 6.3 `electron/preload.js`

```js
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("morningBrief", {
  version: "1",
  platform: process.platform,
  // Vault (absolute-path backed, main-process fs)
  vault: {
    pick:      ()            => ipcRenderer.invoke("mb:vault:pick"),      // → {name,path}|null
    restore:   ()            => ipcRenderer.invoke("mb:vault:restore"),   // → {name,path}|null
    read:      (name)        => ipcRenderer.invoke("mb:vault:read", name),// → string|null
    write:     (name, text)  => ipcRenderer.invoke("mb:vault:write", name, text),
    forget:    ()            => ipcRenderer.invoke("mb:vault:forget"),
  },
  launch:       (target)     => ipcRenderer.invoke("mb:launch", target),     // → {ok,error?}
  openExternal: (url)        => ipcRenderer.invoke("mb:openExternal", url),
});
```

### 6.4 IPC channel contracts (`electron/main.js`)

| Channel | Args | Returns | Notes |
| --- | --- | --- | --- |
| `mb:vault:pick` | — | `{name,path}\|null` | `dialog.showOpenDialog({properties:["openDirectory","createDirectory"]})`; persist path; on cancel → `null`. |
| `mb:vault:restore` | — | `{name,path}\|null` | Read persisted path; verify it exists & is a directory; else clear + `null`. |
| `mb:vault:read` | `name` | `string\|null` | Validate `name ∈ VAULT_FILES`; read `path.join(vaultDir, name)`; missing file → `null`. |
| `mb:vault:write` | `name, text` | `void` | Validate `name`; write UTF-8; create dir if needed. |
| `mb:vault:forget` | — | `void` | Clear persisted path. |
| `mb:launch` | `target` | `{ok,error?}` | See resolution rules below. |
| `mb:openExternal` | `url` | `{ok,error?}` | Only `http(s)` allowed; `shell.openExternal`. |

`VAULT_FILES = ["todos.md","projects.md","hours.md","shortcuts.md","news.md","calendar.md"]`.
**Validate the filename against this allow-list** — never `path.join` an unchecked name.

### 6.5 Launch resolution (`mb:launch`) — mirror the server's rules

```
https://… or http://…        → shell.openExternal(url)
file:///…                    → fileURLToPath → must exist → shell.openPath(p)
<scheme>://…  (other)        → shell.openExternal(target)      e.g. blender://
bare path  C:\… | \\…        → must exist → shell.openPath(p)  (.exe runs, folder opens)
```
Return `{ok:true}` on success, `{ok:false,error:"…"}` otherwise. Never build a shell
command string; use the `shell`/`spawn` APIs directly.

### 6.6 `electron/main.js` — required behaviours

- **Single instance:** `app.requestSingleInstanceLock()`; focus the existing window on a
  second launch.
- **Startup order:** `await app.whenReady()` → `startServer({ port: 0, enableHttpLaunch: false, openBrowser: false })` → create window → `loadURL(server.url)`.
- **Window:** `width: 1280, height: 900, minWidth: 900, minHeight: 640`, `backgroundColor`
  matching the dashboard background, `show: false` then `ready-to-show` → `show()`.
  Restore/persist bounds from config.
- **WebPreferences:** `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`,
  `preload: path.join(__dirname, "preload.js")`.
- **External links:** `webContents.setWindowOpenHandler(({url}) => { if (/^https?:/i.test(url)) shell.openExternal(url); return {action:"deny"}; })`
  and a `will-navigate` guard that opens non-app URLs externally.
- **Lifecycle:** `window-all-closed` → quit (except macOS); `activate` → recreate window;
  `before-quit` → `await server.close()`.
- **Menu:** minimal — keep a `View → Toggle DevTools (F12)` and `Reload`; remove default menu noise.
- **Errors:** if `startServer` fails, show a `dialog.showErrorBox` with the message and quit.

### 6.7 `electron/config.js`

Tiny JSON store at `path.join(app.getPath("userData"), "config.json")`.
Keys: `{ vaultPath: string|null, window: {width,height,x,y} }`. Synchronous read/write is
fine. No external dependency (no `electron-store`).

---

## 7. `index.html` integration points (surgical edits only)

Add near the other constants (the file already defines `LOCAL_SERVER` / `localServerBase()`):

```js
const isDesktop = !!(window.morningBrief && window.morningBrief.version);
```

**Do not restructure the file.** Make these five targeted changes:

### 7.1 Vault — branch on `isDesktop`

Keep the existing File System Access code as the browser path. Add an Electron branch to
these functions (names unchanged so call sites stay put):

- `connectVault()` — if `isDesktop`: `const info = await window.morningBrief.vault.pick();`
  if `info` → set `state.vault.name = info.name`, `state.vault.connected = true`,
  `await vaultLoadAll()`, `save()`, `updateVaultBtn()`, toast. No `dirHandle` needed.
- `restoreVault()` — if `isDesktop`: `const info = await window.morningBrief.vault.restore();`
  if `info` → same as above. **Handle this before the existing
  `if(!window.showDirectoryPicker) return;` guard**, which would otherwise bail in Electron.
- `vaultRead(name)` — if `isDesktop` → `return window.morningBrief.vault.read(name);`
- `vaultWrite(name, text)` — if `isDesktop` → `return window.morningBrief.vault.write(name, text);`

Everything else (`vaultLoadAll`, `vaultWriteAll`, `applyVault`, serializers) is unchanged —
they already go through `vaultRead`/`vaultWrite`.

Also update the vault copy in Setup → Vault: in desktop mode say the folder is remembered
between launches (no re-authorization).

### 7.2 Launcher — prefer IPC

In `openShortcut(id)`, before the existing `fetch(localServerBase() + "/launch?…")` branch:

```js
if (isDesktop && window.morningBrief.launch) {
  const r = await window.morningBrief.launch(s.target);
  toast(r.ok ? "🚀 Launched " + s.name + "." : "⚠️ Couldn't launch " + s.name + (r.error ? " — " + r.error : "."));
  return;
}
```
Keep the HTTP path as the fallback for browser mode.

### 7.3 Server badge

`pingServer()` stays. In desktop mode the embedded server is always up, so the 🖥️ Desktop
badge appears automatically. Optionally relabel to `🖥️ App` when `isDesktop`.

### 7.4 Web links — no change

`window.open(...)` stays; the main process intercepts it and opens the system browser.

### 7.5 No change to networking

`fetchIcs()` and `refreshNews()` keep hitting `/proxy` on `localServerBase()`. Confirmed
compatible: in Electron the page origin is `http://127.0.0.1:<port>`, which
`localServerBase()` already recognises.

---

## 8. Security checklist (must hold after implementation)

- [ ] `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`.
- [ ] Renderer never gets `require`/`fs`; only the narrow `window.morningBrief` surface.
- [ ] Vault filenames validated against the 6-name allow-list (no traversal).
- [ ] HTTP `/launch` disabled in-app (`enableHttpLaunch: false`).
- [ ] Server bound to `127.0.0.1` only.
- [ ] `mb:openExternal` restricted to `http(s)`.
- [ ] No `shell` command strings built from user input (use `shell.*` APIs).
- [ ] External links open in the system browser, never in-app navigation.

---

## 9. Packaging

`package.json` (sketch):

```json
{
  "name": "morning-brief",
  "productName": "Morning Brief",
  "version": "1.0.0",
  "private": true,
  "main": "electron/main.js",
  "scripts": {
    "start": "electron .",
    "dist": "electron-builder --win nsis portable",
    "serve": "node serve.js"
  },
  "devDependencies": {
    "electron": "^33.0.0",
    "electron-builder": "^25.0.0"
  },
  "build": {
    "appId": "com.morningbrief.app",
    "productName": "Morning Brief",
    "files": ["electron/**", "lib/**", "index.html", "README.md", "package.json"],
    "win": { "target": ["nsis", "portable"], "icon": "build/icon.ico" },
    "nsis": { "oneClick": false, "allowToChangeInstallationDirectory": true, "createDesktopShortcut": true },
    "portable": { "artifactName": "MorningBrief-portable-${version}.exe" }
  }
}
```

Icon: create `build/icon.ico` (≥256×256, multi-size ideally). The repo already contains the
robot mascot as an inline SVG in `index.html` (`class="mascot"`) — render it to a 512×512
PNG and convert to `.ico`. Either is acceptable:
- ImageMagick: `magick mascot.svg -background none -resize 512x512 icon.png && magick icon.png -define icon:auto-resize=256,128,64,48,32,16 build/icon.ico`
- or an online SVG→ICO converter, saved to `build/icon.ico`.

**asar note:** with `asar: true` (default), the embedded server reads static files from
inside `app.asar`. Electron patches `fs` so `fs.readFile` works on asar paths, but **verify
it** in the packaged build (Task 12). If it misbehaves, set the server `root` to
`app.getAppPath()` and confirm, or add `asarUnpack`.

---

## 10. Task list (ordered, each independently verifiable)

> Follow in order. Do not start a task until the previous one's acceptance criteria pass.

**Phase 0 — Spike (do this first; it may change the plan)**
1. **Environment check.** `node -v` (expect ≥ 18; repo currently on 22) and
   `npm -v`. Run `npm init -y` then `npm i -D electron@^33`. Confirm `npx electron -v`.
   *Accept:* Electron downloads and reports a version.
2. **FSA reality check.** Build a throwaway window that loads the current dashboard and
   tries `window.showDirectoryPicker`. Record whether it opens, and whether permission
   survives a restart. *Accept:* a written yes/no — it decides whether Task 8 is
   mandatory (the plan assumes **yes, use IPC regardless**, for stability).

**Phase 1 — Server refactor (no behaviour change)**
3. **Extract `lib/server.js`.** Move all logic from `serve.js`; add `startServer(opts)`
   with the §6.1 signature; add the `enableHttpLaunch` flag (when `false`, `/launch`
   responds `404`). *Accept:* module exports `startServer`.
4. **Rewrite `serve.js` as a CLI wrapper** (§6.2). *Accept:* `node serve.js` behaves
   exactly as before — banner, `PORT` override, `NO_OPEN`, EADDRINUSE message.
5. **Regression-test browser mode.** Start `node serve.js`; in a browser confirm
   `/health`, `/proxy?url=<google ics>` returns ICS, `/launch?target=blender://` with
   `X-Morning-Brief: 1` and `Origin: null` returns `200`, and without the header `403`.
   *Accept:* all pass; no change vs. pre-refactor.

**Phase 2 — Electron shell**
6. **Scaffold** `package.json` + `electron/main.js` + `electron/preload.js` + `config.js`
   per §6. *Accept:* `npm start` opens a window showing the dashboard; the 🖥️ badge shows.
7. **Link handling + lifecycle.** `setWindowOpenHandler` → system browser; `will-navigate`
   guard; single-instance lock; window bounds persistence; `before-quit` closes the server.
   *Accept:* clicking a web shortcut opens it in Chrome/Vivaldi, not a new Electron window;
   resizing then relaunching restores bounds.

**Phase 3 — Vault**
8. **Implement vault IPC** (`mb:vault:*`) per §6.4 with the filename allow-list.
   *Accept:* `mb:vault:read`/`write` reject an unknown name; round-trip a file.
9. **Wire `index.html` vault branch** (§7.1). *Accept:* desktop → *Connect Vault* opens a
   native folder dialog; all six `.md` files are created in the chosen folder; edits made
   in Obsidian appear after *Reload from vault*; dashboard edits land on disk.

**Phase 4 — Launcher**
10. **Implement `mb:launch` + `mb:openExternal`** (§6.5). *Accept:* protocol, `.exe`, and
    folder targets each open; a bogus path returns `{ok:false,error}`.
11. **Wire `index.html` launcher branch** (§7.2) and confirm the HTTP `/launch` route is
    off in-app. *Accept:* Launchpad tiles open apps; `GET /launch` on the embedded port
    returns `404`.

**Phase 5 — Package**
12. **Icon + `electron-builder`** per §9. *Accept:* `npm run dist` produces an NSIS
    installer and a portable `.exe` in `dist/`; installing and launching works; the icon
    shows in the taskbar and Explorer.
13. **Packaged smoke test.** Run the installed app: dashboard loads (asar read OK),
    calendar sync works, news refresh works, launch works, vault persists across restarts.
    *Accept:* full checklist green on the **packaged** build, not just `npm start`.

**Phase 6 — Polish & docs**
14. **Menu + DevTools toggle (F12)**, first-run nudge text adjusted for desktop.
15. **Update `README.md`**: add a "Desktop app" section (build, install, portable);
    note that browser mode still exists; update the vault copy for desktop.
    *Accept:* a new user can follow the README to build and run.

---

## 11. Test plan

**Automated (cheap, add where practical)**
- `lib/server.js`: a Node test that starts it on port `0` and asserts:
  `/health` → 200; `/proxy?url=<invalid>` → 400; `/launch` gating (403 without header,
  403 with foreign `Origin`, 404 when `enableHttpLaunch:false`); static traversal
  (`/../package.json`) → 403.
- Reuse the pattern already proven in this repo: spawn the module, `fetch` it, assert,
  kill. (A prior session validated `/proxy` and `/launch` this way.)

**Manual acceptance (must run on the packaged build too)**
- [ ] Window opens with no browser chrome; taskbar icon is correct.
- [ ] 🖥️ Desktop badge visible.
- [ ] Calendar: *Sync now* pulls events for ≥2 calendars; a multi-day event spans days.
- [ ] News: *↻ Refresh* loads stories.
- [ ] Launchpad: Blender / Obsidian / a `.exe` / a folder all open.
- [ ] Web shortcut opens in the system browser, not in-app.
- [ ] Vault: connect, edit a file externally, *Reload from vault*, edit in-app, verify on disk.
- [ ] Vault persists across a full restart (no re-prompt).
- [ ] Close the app → no orphan `node`/server process remains (check Task Manager).

---

## 12. Risks and mitigations

| Risk | Likelihood | Mitigation |
| --- | --- | --- |
| `npm i electron` needs network / large download | Med | Do Task 1 first; if blocked, report before proceeding. |
| File System Access API flaky under Electron | High | Plan already uses IPC+`fs` (Task 8–9); FSA kept only for browser mode. |
| `window.open` spawning in-app windows | High | Task 7 `setWindowOpenHandler` — do not skip. |
| asar breaks the server's static reads | Med | Task 13 verifies on the packaged build; fallback in §9. |
| Port conflict with the CLI server | Low | Electron uses `port: 0`. |
| Dashboard regressions from vault edits | Med | Edits are additive branches behind `isDesktop`; Task 5 guards browser mode. |
| Icon file missing → builder fails | Low | Create `build/icon.ico` in Task 12 before `dist`. |
| Windows Firewall prompt | Low | Loopback-only bind generally avoids it; note if it appears. |

---

## 13. Invariants — do not break these

1. **Browser mode must keep working.** `index.html` + `Start Dashboard.bat` + `serve.js`
   are still a supported, documented way to run the dashboard.
2. **The server stays zero-dependency.** Do not add npm packages to `lib/server.js`.
3. **Keep the `/proxy` and `/launch` security gates** exactly as they are (local-origin +
   `X-Morning-Brief`). Loosening them is a security regression.
4. **`index.html` stays a single self-contained file** with inline CSS/JS. No bundler, no
   framework, no `import` statements.
5. **Markdown-first storage is unchanged.** Six files, same formats, same serializers.

---

## 14. Definition of done

- [ ] `npm start` and the installed build both run the dashboard in its own window.
- [ ] Apps/protocols/files launch from the Launchpad.
- [ ] Vault works via the filesystem and persists across restarts.
- [ ] Calendar and news sync work in the app.
- [ ] `npm run dist` yields installer + portable `.exe`.
- [ ] `node serve.js` / `Start Dashboard.bat` still work (browser mode intact).
- [ ] Security checklist (§8) fully satisfied.
- [ ] `README.md` documents building and running the desktop app.

---

## 15. Handoff notes for the implementing agent

**Read first, in order:** `serve.js` (the whole thing — you're refactoring it), then the
relevant regions of `index.html`: the constants near `LOCAL_SERVER`/`localServerBase()`,
`pingServer()`/`updateDesktopBadge()`, the vault block (`connectVault` … `vaultWriteAll`),
`openShortcut()`, `fetchIcs()`, `refreshNews()`.

**Gotchas**
- `restoreVault()` early-returns when `window.showDirectoryPicker` is missing — put the
  desktop branch **above** that guard.
- The dashboard's `localServerBase()` only treats `localhost`/`127.0.0.1` as "the server";
  the embedded server must load the page from one of those hosts (it does).
- `openShortcut()` is already `async`; the IPC branch is a drop-in.
- Keep the existing `X-Morning-Brief` header name and gate semantics if you touch `/launch`.
- The `deskBadge` element already exists in the header; reuse it rather than adding a new one.

**Suggested first commit:** the `lib/server.js` extraction + `serve.js` wrapper (Tasks 3–4)
with the browser-mode regression test passing — a safe, reviewable foundation before any
Electron code lands.
