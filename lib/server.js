/*
 * Morning Brief — local companion server (reusable module)
 * --------------------------------------------------------
 * Extracted from the original `serve.js` so it can be used both by the CLI
 * (`node serve.js`) and by the Electron main process (required in-process).
 *
 * Zero dependencies: only Node built-ins.
 *
 *   GET /                -> the dashboard (index.html)
 *   GET /proxy?url=      -> server-side fetch of any http(s) URL (no CORS)
 *   GET /launch?target=  -> open a URL / protocol / file / app (gated)
 *   GET /health          -> liveness probe ("ok")
 *
 * Bound to 127.0.0.1 by default. /launch additionally requires a local origin
 * and a custom header, so other websites can't drive it.
 */
"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { fileURLToPath } = require("url");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json"
};

// Static files and /proxy are readable from any origin (the dashboard may be
// opened straight from disk as a file:// page). /launch is deliberately not.
function corsStar() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "*"
  };
}

function send(res, code, headers, body, cors) {
  res.writeHead(code, { ...(cors === false ? {} : corsStar()), ...headers });
  res.end(body);
}

function json(res, code, obj, cors) {
  send(res, code, { "Content-Type": "application/json; charset=utf-8" }, JSON.stringify(obj), cors);
}

// A request may drive /launch only if it came from the dashboard itself: a
// file:// page (Origin "null") or a page served from loopback.
function allowedOrigin(origin) {
  if (!origin || origin === "null") return true;
  try {
    const u = new URL(origin);
    return u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "::1";
  } catch {
    return false;
  }
}

/* ---------- /proxy ---------- */
async function handleProxy(res, target) {
  if (!target) return send(res, 400, { "Content-Type": "text/plain" }, "Missing ?url=");
  let parsed;
  try {
    parsed = new URL(target);
  } catch {
    return send(res, 400, { "Content-Type": "text/plain" }, "Malformed url");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return send(res, 400, { "Content-Type": "text/plain" }, "Only http(s) urls are allowed");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25000);
  try {
    const upstream = await fetch(target, {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "User-Agent": "MorningBrief/1.0 (local dashboard)",
        "Accept": "text/calendar, application/rss+xml, application/atom+xml, application/xml, text/xml, */*"
      }
    });
    const buf = Buffer.from(await upstream.arrayBuffer());
    const ct = upstream.headers.get("content-type") || "text/plain; charset=utf-8";
    send(res, upstream.status, { "Content-Type": ct }, buf);
  } catch (e) {
    const msg = e && e.name === "AbortError" ? "Upstream timed out" : "Proxy fetch failed: " + (e && e.message ? e.message : e);
    send(res, 502, { "Content-Type": "text/plain" }, msg);
  } finally {
    clearTimeout(timer);
  }
}

/* ---------- /launch ---------- */
// Work out what the target actually is, without touching the shell.
function resolveLaunchTarget(raw) {
  const t = String(raw || "").trim();
  if (!t) return { error: "Empty target" };
  if (/^https?:\/\//i.test(t)) return { url: t };                 // web link
  if (/^file:\/\//i.test(t)) {
    try { return { file: fileURLToPath(t) }; }                    // file:///C:/...
    catch { return { error: "Malformed file: url" }; }
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) return { url: t };      // custom protocol, e.g. blender://
  return { file: t };                                             // bare local path
}

// Open with the OS default handler. spawn (no shell) means no command
// injection from the target string.
function openWithOS(arg) {
  return new Promise((resolve) => {
    if (process.env.MB_LAUNCH_DRYRUN === "1") return resolve({ ok: true, dryRun: true });
    let cmd, args;
    if (process.platform === "win32") { cmd = "rundll32"; args = ["url.dll,FileProtocolHandler", arg]; }
    else if (process.platform === "darwin") { cmd = "open"; args = [arg]; }
    else { cmd = "xdg-open"; args = [arg]; }
    const child = spawn(cmd, args, { detached: true, stdio: "ignore", windowsHide: true });
    child.once("error", (e) => resolve({ ok: false, error: e.message }));
    child.once("spawn", () => { child.unref(); resolve({ ok: true }); });
  });
}

// Both /launch and /ai/chat are only callable by the dashboard itself.
function dashboardGate(req) {
  if (!allowedOrigin(req.headers.origin || "")) return "Origin not allowed";
  if (String(req.headers["x-morning-brief"] || "") !== "1") return "Missing X-Morning-Brief header";
  return null;
}

async function handleLaunch(req, res, raw) {
  const gate = dashboardGate(req);
  if (gate) return json(res, 403, { ok: false, error: gate }, false);

  const r = resolveLaunchTarget(raw);
  if (r.error) return json(res, 400, { ok: false, error: r.error }, false);

  let arg;
  if (r.url) {
    arg = r.url;
  } else {
    const p = path.resolve(r.file);
    if (!fs.existsSync(p)) return json(res, 404, { ok: false, error: "Path not found: " + p }, false);
    arg = p;
  }

  const result = await openWithOS(arg);
  return json(res, result.ok ? 200 : 500, result, false);
}

/* ---------- /ai/chat ---------- */
// Server-side relay to the Gab AI API (OpenAI-compatible). The renderer can't
// call it directly (CORS), so the dashboard sends { apiKey, request } here and
// the server forwards `request` to Gab with the key. The upstream host is fixed.
const AI_UPSTREAM = "https://gab.ai/v1/chat/completions";

function readBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) { reject(new Error("Body too large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function handleAiChat(req, res) {
  if (req.method !== "POST") return send(res, 405, { "Content-Type": "text/plain" }, "Method not allowed");
  const gate = dashboardGate(req);
  if (gate) return json(res, 403, { ok: false, error: gate });

  let payload;
  try {
    payload = JSON.parse(await readBody(req));
  } catch {
    return json(res, 400, { ok: false, error: "Invalid JSON body" });
  }
  const apiKey = payload && typeof payload.apiKey === "string" ? payload.apiKey.trim() : "";
  const request = payload && payload.request;
  if (!apiKey) return json(res, 400, { ok: false, error: "Missing apiKey" });
  if (!request || typeof request !== "object") return json(res, 400, { ok: false, error: "Missing request" });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 90000);
  try {
    const upstream = await fetch(AI_UPSTREAM, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + apiKey
      },
      body: JSON.stringify(request)
    });
    const text = await upstream.text();
    return send(res, upstream.status, { "Content-Type": "application/json; charset=utf-8" }, text);
  } catch (e) {
    const msg = e && e.name === "AbortError" ? "AI request timed out" : "AI request failed: " + (e && e.message ? e.message : e);
    return json(res, 502, { ok: false, error: msg });
  } finally {
    clearTimeout(timer);
  }
}

/* ---------- static files ---------- */
function makeStaticHandler(ROOT) {
  return function serveStatic(res, pathname) {
    let rel = decodeURIComponent(pathname);
    if (rel === "/" || rel === "") rel = "/index.html";
    const safe = path.normalize(rel).replace(/^([/\\]|\.\.[/\\])+/, "");
    const filePath = path.join(ROOT, safe);
    if (!filePath.startsWith(ROOT)) return send(res, 403, { "Content-Type": "text/plain" }, "Forbidden");
    fs.readFile(filePath, (err, data) => {
      if (err) return send(res, 404, { "Content-Type": "text/plain" }, "Not found");
      const type = MIME[path.extname(filePath).toLowerCase()] || "application/octet-stream";
      send(res, 200, { "Content-Type": type }, data);
    });
  };
}

function openInBrowser(url) {
  const cmd =
    process.platform === "win32" ? `start "" "${url}"` :
    process.platform === "darwin" ? `open "${url}"` :
    `xdg-open "${url}"`;
  spawn(cmd, { shell: true, stdio: "ignore", detached: true }).unref();
}

/**
 * Start the Morning Brief companion server.
 *
 * @param {object} [opts]
 * @param {number} [opts.port=8787]   0 = pick a free port
 * @param {string} [opts.host="127.0.0.1"]
 * @param {string} [opts.root]        directory to serve statics from (default: repo root)
 * @param {boolean} [opts.enableHttpLaunch=true]  when false, /launch returns 404
 * @param {boolean} [opts.openBrowser=false]
 * @param {object} [opts.logger=console]
 * @returns {Promise<{ url:string, port:number, close:()=>Promise<void> }>}
 */
async function startServer(opts = {}) {
  const {
    port = 8787,
    host = "127.0.0.1",
    root = path.resolve(__dirname, ".."),
    enableHttpLaunch = true,
    openBrowser = false,
    logger = console
  } = opts;

  const ROOT = path.resolve(root);
  const serveStatic = makeStaticHandler(ROOT);

  const server = http.createServer((req, res) => {
    const u = new URL(req.url, "http://localhost");

    if (req.method === "OPTIONS") {
      if ((u.pathname === "/launch" || u.pathname === "/ai/chat") && !allowedOrigin(req.headers.origin || "")) {
        return send(res, 403, {}, "", false);
      }
      return send(res, 204, {}, "");
    }
    if (req.method !== "GET" && req.method !== "POST") {
      return send(res, 405, { "Content-Type": "text/plain" }, "Method not allowed");
    }

    if (u.pathname === "/proxy") return handleProxy(res, u.searchParams.get("url") || "");
    if (u.pathname === "/health") return send(res, 200, { "Content-Type": "text/plain" }, "ok");
    if (u.pathname === "/ai/chat") return void handleAiChat(req, res);
    if (u.pathname === "/launch") {
      if (!enableHttpLaunch) return send(res, 404, { "Content-Type": "text/plain" }, "Not found");
      return void handleLaunch(req, res, u.searchParams.get("target") || "");
    }

    return serveStatic(res, u.pathname);
  });

  return new Promise((resolve, reject) => {
    const onError = (err) => { reject(err); };
    server.once("error", onError);

    server.listen(port, host, () => {
      server.removeListener("error", onError);
      server.on("error", (err) => {
        if (logger && typeof logger.error === "function") logger.error("Server error:", err);
      });

      const actualPort = server.address().port;
      const url = `http://localhost:${actualPort}`;

      if (openBrowser) openInBrowser(url);

      resolve({
        url,
        port: actualPort,
        close: () => new Promise((res) => {
          server.close(() => res());
          // Drop keep-alive sockets so close() can't hang on an idle client.
          if (typeof server.closeAllConnections === "function") server.closeAllConnections();
        })
      });
    });
  });
}

module.exports = { startServer };
