# Morning Brief — Daily Dashboard

A colorful, self-contained daily dashboard you can open every morning. It tracks
work projects, work hours, personal projects, and to-dos; shows your Google
Calendar meetings; pulls curated tech news (AI, robotics, motion graphics,
Blender, Blender add-ons, 3D tools, and new image/video models); and gives you a
launchpad of app shortcuts.

Everything is saved in your browser and, when you **sign in**, synced privately
across your devices (PC + phone) through your own account. No build step and no
install for the browser version — and a standalone Windows desktop app adds
native app launching.

---

## Run it

**Recommended — double-click `Start Dashboard.bat`.** It starts a tiny local
server (`serve.js`, no install) and opens the dashboard in your browser at
`http://localhost:8787`. The server also relays calendar and news requests on
your own machine, which is what makes live sync actually work (see below).

You can still double-click `index.html` to open it straight from the file — but
then calendar/news sync has to rely on flaky public CORS proxies. Use the `.bat`
if you want sync.

> Use **Chrome, Edge, Vivaldi, Brave** — any Chromium browser.
>
> The `.bat` needs **Node.js** (install the LTS version once from
> [nodejs.org](https://nodejs.org)); it will tell you if it's missing.

---

## Desktop app (Windows)

Morning Brief also ships as a standalone Windows desktop app. It runs in its own
window (no browser chrome) and launches apps, custom protocols, `.exe` files and
folders natively. Sign in with the same account you use on your phone and the two
stay in sync.

### Build it

1. Install [Node.js](https://nodejs.org) (the LTS version).
2. In this folder, install the build tools once: `npm install`.
3. Build the app: `npm run dist`.

This produces, in `dist/`:

- **`Morning Brief Setup <version>.exe`** — a normal installer (Start-menu and
  desktop shortcuts, and you can choose the install folder).
- **`MorningBrief-portable-<version>.exe`** — a single-file portable build that
  needs no installation.

To run the app straight from source while developing, use `npm start`.

### What's different in the app

- The local companion server runs **inside** the app on a random loopback port,
  so calendar and news sync work with no separate `Start Dashboard.bat` window.
- Shortcuts launch through the app directly (native OS APIs); web links open in
  your default browser rather than in-app.
- Sign in with the same account you use on your phone and the two stay in sync
  (changes push within seconds; it pulls every 60s).

Browser mode (below) is unchanged and still fully supported.

---

## First-run setup (2 minutes)

Click **⚙️ Setup** in the top-right.

### 1. General
Add your name so the header greets you.

### 2. Calendar (Google Calendar)
You can add as many calendars as you like — for example a **Work** calendar and
a **Personal** calendar. Each one has its own name, colour and iCal URL, and
they all appear together in **Today's Calendar**, tagged with their calendar's
colour.

For each calendar you want to add:
1. Open [Google Calendar](https://calendar.google.com) → **Settings**.
2. Under *Settings for my calendars*, pick the calendar → **Secret address in
   iCal format**.
3. Copy that URL.
4. Setup → Calendar → **＋ Add calendar**, give it a name (e.g. “Work”), pick a
   colour, and paste the URL.
5. Repeat for your other calendars, then click **Sync now**.

This is read-only and private to you. Your meetings show up in **Today's
Calendar**, with a live “next up” countdown.

You can also click **⤓ Import .ics** on the calendar panel to load a one-off
calendar file, or **＋ Add event** for manual entries.

> **Calendar sync needs the local server.** A browser can't fetch Google's
> `.ics` directly — Google sends no CORS header, so it's blocked no matter how
> you open the page. Launch with `Start Dashboard.bat`, which runs `serve.js`
> and proxies the request on your own machine (no third party). If the server
> isn't running, the dashboard falls back to the public proxies listed in
> **CORS proxies** (Setup → Calendar) — free and unreliable — or you can fall
> back to **⤓ Import .ics**, which needs no proxy at all.


### 3. News
Feeds are pre-loaded for:
AI · Robotics · Motion Graphics · Blender · Blender Add-ons · 3D Tools ·
Image & Video Models

- Click **↻ Refresh** to fetch stories.
- Click **Topics** to edit the topic list, the feed URLs, and the **blocked
  words** list that hides political stories.
- News is fetched through the same local server, so it works when you launch
  with `Start Dashboard.bat`. You can point it at any other proxy under
  **Topics → CORS proxy prefix** if you prefer.

### 4. Sign in & sync
Click **Sign in** (top-right) → **Create account** with an email and password.
From then on your dashboard — todos, projects, hours, shortcuts, news, calendar
and settings — is saved to your own account and **synced automatically**:
changes push within a couple of seconds and it pulls every 60 seconds. Sign in
with the same account on your phone and PC and they stay in step.

No account? Everything still works — it's just saved in this browser. Use
**Setup → Data → Export** for a JSON or Markdown backup.

### 5. Launchpad
Click the **＋** on the Launchpad panel to add a shortcut. Give it a name, a
target, and an emoji icon, and pick a tile color.

- **Web link** — any `https://` address. Opens in a new tab.
- **App / custom protocol** — e.g. `blender://`, `obsidian://open`,
  `aftereffects://`.
- **Local file or folder** — e.g. `file:///C:/Program%20Files/...`, or a plain
  path like `C:\Program Files\Blender\blender.exe`.

> **Desktop launching.** When you run the dashboard with `Start Dashboard.bat`
> (or the desktop app), these shortcuts launch for real — apps, custom
> protocols, `.exe` files and folders all open on your machine. The local server
> does the launching, which is why it works where a plain web page can't. If you
> open `index.html` directly (no server), web links still work but the browser
> will block apps and local files.

### 6. Projects & AI

Each work and personal project can carry its own **nested to-do list**. Click a
project to expand it, then check items off, rename them inline, delete them, or
add new ones. The progress bar is calculated automatically from the list.

To have an LLM draft the list for you, open a project (**✎ Edit**), describe it
under **Describe the project**, and click **✨ Generate to-dos**. The tasks land
in the editable list, where you can rename or delete any of them before saving.

AI runs through **Gab AI** (OpenAI-compatible). Add your API key in
**Setup → AI** — it's stored locally and only sent to your own local server,
which forwards it to Gab. AI needs the local server running (the desktop app, or
`Start Dashboard.bat`).

---

## What’s inside

`index.html` holds the whole dashboard (inline CSS and JavaScript) with no
front-end dependencies. The optional `serve.js` is a small Node script with
**zero npm packages** — it serves the page, relays calendar/news and AI requests,
and launches apps, protocols and files when a shortcut asks it to. No internet is
required except for fonts (Google Fonts), news feeds,
and calendar sync. Your data stays local — nothing is uploaded anywhere.

---

## Known limitations

- **Google Calendar** uses the read-only iCal feed, not the Google API. That
  avoids OAuth setup entirely, and events can lag a few hours behind live
  changes. Two-way editing of Google events is not supported. You can add
  multiple calendars (work, personal, …), each with its own iCal URL.
- **Calendar & news sync need the local server.** Browsers can't fetch Google's
  `.ics` or RSS feeds directly (no CORS headers), and public CORS proxies are
  unreliable. `Start Dashboard.bat` runs `serve.js`, which proxies these
  requests locally — that's the reliable path. Opened as a bare `file://` page
  with no server running, the dashboard falls back to the public proxies in
  Setup → Calendar, which may fail. **⤓ Import .ics** always works without a
  server.
- **Sync** requires signing in, and is last-write-wins per account: if you edit
  the same thing on two devices while offline, the most recent save wins.
- **Local app launching needs the local server.** A plain web page can't open
  `.exe` files or custom protocols, so the dashboard routes those through
  `serve.js` (`/launch`). Run `Start Dashboard.bat` (or the desktop app). The
  endpoint is bound to `127.0.0.1` and only answers requests from the dashboard
  itself, so other sites can't trigger it.
- **AI to-do generation needs the local server and a Gab AI key.** The key lives
  in Setup → AI; requests are relayed through the local server to `gab.ai`, and
  the endpoint is bound to `127.0.0.1` and gated the same way as `/launch`, so
  other websites can't use it.

---

## Files

- `index.html` — the whole dashboard.
- `lib/server.js` — the companion server (static files + `/proxy` + `/launch`),
  shared by the CLI and the desktop app.
- `serve.js` — CLI wrapper that starts the server for browser mode.
- `electron/` — desktop app: `main.js` (entry), `preload.js` (IPC bridge),
  `config.js` (window bounds + server port store).
- `mb-config.js` / `mb-cloud.js` — cloud sign-in + sync (Supabase) and the
  `proxy` / `ai` relays; `manifest.webmanifest` + `sw.js` + icons make it a PWA.
- `supabase/` — the database schema and the Edge Functions.
- `build/icon.ico` — the app icon.
- `Start Dashboard.bat` — double-click launcher (starts the server + browser).
- `package.json` — Electron/electron-builder config (`npm start`, `npm run dist`).
- `README.md` — this file.
