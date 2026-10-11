/*
 * Morning Brief — Electron main process.
 *
 * Startup: start the embedded companion server (ephemeral port, HTTP /launch
 * disabled) then load `index.html` from it in a BrowserWindow. The renderer
 * gets desktop capabilities (vault + launcher) exclusively through the narrow
 * `window.morningBrief` IPC surface defined in preload.js.
 */
"use strict";

const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require("electron");
const path = require("path");
const fs = require("fs");
const { fileURLToPath } = require("url");
const { startServer } = require("../lib/server");
const config = require("./config");

const VAULT_FILES = ["todos.md", "projects.md", "hours.md", "shortcuts.md", "news.md", "calendar.md"];
const DEFAULT_BOUNDS = { width: 1280, height: 900, minWidth: 900, minHeight: 640 };
const BACKGROUND = "#fff3e2";

let server = null;
let win = null;
let cfg = config.read();
let boundsTimer = null;

// Start the embedded server on a STABLE port so the page origin stays the same
// across launches — localStorage (projects, hours, the AI key, settings) is
// scoped to the origin, so a random port each launch would lose everything.
// The chosen port is remembered; if it's busy we fall back to an ephemeral one.
async function startEmbeddedServer() {
  const wanted = Number.isInteger(cfg.serverPort) && cfg.serverPort > 0 ? cfg.serverPort : 0;
  if (wanted) {
    try {
      return await startServer({ port: wanted, enableHttpLaunch: false, openBrowser: false });
    } catch (err) {
      if (!(err && err.code === "EADDRINUSE")) throw err;
      // Saved port taken — fall through to an ephemeral port.
    }
  }
  const s = await startServer({ port: 0, enableHttpLaunch: false, openBrowser: false });
  cfg.serverPort = s.port;
  config.write(cfg);
  return s;
}

/* ---------- window bounds persistence ---------- */
function persistBounds() {
  if (!win || win.isDestroyed() || win.isMinimized() || win.isFullScreen()) return;
  const b = win.getNormalBounds();
  cfg.window = { width: b.width, height: b.height, x: b.x, y: b.y };
  config.write(cfg);
}
function schedulePersistBounds() {
  clearTimeout(boundsTimer);
  boundsTimer = setTimeout(persistBounds, 400);
}

/* ---------- vault helpers ---------- */
function vaultDir() {
  return cfg.vaultPath || null;
}
function validVaultName(name) {
  return typeof name === "string" && VAULT_FILES.includes(name);
}

/* ---------- launch (mirrors lib/server.js rules) ---------- */
async function launchTarget(target) {
  const t = String(target == null ? "" : target).trim();
  if (!t) return { ok: false, error: "Empty target" };
  try {
    // Web link
    if (/^https?:\/\//i.test(t)) {
      await shell.openExternal(t);
      return { ok: true };
    }
    // file:// URL -> real path -> open
    if (/^file:\/\//i.test(t)) {
      let p;
      try { p = fileURLToPath(t); }
      catch { return { ok: false, error: "Malformed file: url" }; }
      if (!fs.existsSync(p)) return { ok: false, error: "Path not found: " + p };
      const err = await shell.openPath(p);
      return err ? { ok: false, error: err } : { ok: true };
    }
    // Custom protocol, e.g. blender://
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) {
      await shell.openExternal(t);
      return { ok: true };
    }
    // Bare local path (.exe runs, folder opens)
    const p = path.resolve(t);
    if (!fs.existsSync(p)) return { ok: false, error: "Path not found: " + p };
    const err = await shell.openPath(p);
    return err ? { ok: false, error: err } : { ok: true };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
}

/* ---------- IPC ---------- */
function registerIpc() {
  ipcMain.handle("mb:vault:pick", async () => {
    const res = await dialog.showOpenDialog(win, {
      title: "Choose a folder inside your Obsidian vault",
      properties: ["openDirectory", "createDirectory"]
    });
    if (res.canceled || !res.filePaths || !res.filePaths.length) return null;
    const p = res.filePaths[0];
    cfg.vaultPath = p;
    config.write(cfg);
    return { name: path.basename(p), path: p };
  });

  ipcMain.handle("mb:vault:restore", async () => {
    const p = vaultDir();
    if (!p) return null;
    try {
      if (!fs.statSync(p).isDirectory()) throw new Error("Not a directory");
    } catch {
      cfg.vaultPath = null;
      config.write(cfg);
      return null;
    }
    return { name: path.basename(p), path: p };
  });

  ipcMain.handle("mb:vault:read", async (_e, name) => {
    if (!validVaultName(name)) throw new Error("Unknown vault file: " + name);
    const dir = vaultDir();
    if (!dir) return null;
    try {
      return fs.readFileSync(path.join(dir, name), "utf8");
    } catch (e) {
      if (e && e.code === "ENOENT") return null;
      throw e;
    }
  });

  ipcMain.handle("mb:vault:write", async (_e, name, text) => {
    if (!validVaultName(name)) throw new Error("Unknown vault file: " + name);
    const dir = vaultDir();
    if (!dir) return;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, name), text == null ? "" : String(text), "utf8");
  });

  ipcMain.handle("mb:vault:forget", async () => {
    cfg.vaultPath = null;
    config.write(cfg);
  });

  ipcMain.handle("mb:launch", async (_e, target) => launchTarget(target));

  ipcMain.handle("mb:openExternal", async (_e, url) => {
    try {
      const u = new URL(String(url));
      if (u.protocol !== "http:" && u.protocol !== "https:") {
        return { ok: false, error: "Only http(s) urls are allowed" };
      }
      await shell.openExternal(u.toString());
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e && e.message ? e.message : String(e) };
    }
  });
}

/* ---------- menu ---------- */
function buildMenu() {
  const template = [];
  if (process.platform === "darwin") template.push({ role: "appMenu" });

  template.push({
    label: "File",
    submenu: [process.platform === "darwin" ? { role: "close" } : { role: "quit" }]
  });

  template.push({
    label: "View",
    submenu: [
      { role: "reload" },
      { role: "forceReload" },
      { type: "separator" },
      {
        label: "Toggle DevTools",
        accelerator: "F12",
        click: () => {
          const w = BrowserWindow.getFocusedWindow();
          if (w) w.webContents.toggleDevTools();
        }
      },
      { type: "separator" },
      { role: "resetZoom" },
      { role: "zoomIn" },
      { role: "zoomOut" },
      { type: "separator" },
      { role: "togglefullscreen" }
    ]
  });

  template.push({ role: "windowMenu" });
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/* ---------- window ---------- */
function createWindow() {
  const saved = (cfg.window && typeof cfg.window === "object") ? cfg.window : {};
  const opts = {
    width: Number.isFinite(saved.width) ? saved.width : DEFAULT_BOUNDS.width,
    height: Number.isFinite(saved.height) ? saved.height : DEFAULT_BOUNDS.height,
    minWidth: DEFAULT_BOUNDS.minWidth,
    minHeight: DEFAULT_BOUNDS.minHeight,
    backgroundColor: BACKGROUND,
    show: false,
    title: "Morning Brief",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, "preload.js")
    }
  };
  if (Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
    opts.x = saved.x;
    opts.y = saved.y;
  }

  win = new BrowserWindow(opts);

  win.once("ready-to-show", () => win.show());
  win.on("resize", schedulePersistBounds);
  win.on("move", schedulePersistBounds);
  win.on("close", persistBounds);

  // Open external links in the system browser, never a new Electron window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });

  // Keep the app on its own origin; anything else goes to the system browser.
  win.webContents.on("will-navigate", (event, url) => {
    const base = server && server.url ? server.url : "";
    if (base && url.startsWith(base)) return;
    event.preventDefault();
    if (/^https?:/i.test(url)) shell.openExternal(url);
  });

  if (server && server.url) win.loadURL(server.url);
  else win.loadFile(path.join(__dirname, "..", "index.html"));

  win.on("closed", () => { win = null; });
}

/* ---------- lifecycle ---------- */
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(async () => {
    buildMenu();
    registerIpc();

    try {
      server = await startEmbeddedServer();
    } catch (err) {
      dialog.showErrorBox(
        "Morning Brief could not start",
        "The embedded server failed to start.\n\n" + (err && err.message ? err.message : String(err))
      );
      app.quit();
      return;
    }

    createWindow();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });

  let quitting = false;
  app.on("before-quit", async (event) => {
    if (quitting) return;
    if (server) {
      quitting = true;
      event.preventDefault();
      try {
        await Promise.race([
          server.close(),
          new Promise((r) => setTimeout(r, 2000))
        ]);
      } catch { /* ignore */ }
      server = null;
      app.quit();
    }
  });
}
