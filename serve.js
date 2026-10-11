#!/usr/bin/env node
/*
 * Morning Brief — local companion server (CLI)
 * --------------------------------------------
 * Serves the dashboard, proxies calendar (.ics) / RSS requests so the browser
 * never deals with CORS, and launches apps, custom protocols and local files
 * on your machine (which a plain web page is not allowed to do).
 *
 * Zero dependencies: just `node serve.js` (or double-click Start Dashboard.bat).
 *
 *   http://localhost:8787/            -> the dashboard (index.html)
 *   http://localhost:8787/proxy?url=  -> server-side fetch of any http(s) URL
 *   http://localhost:8787/launch?target=  -> open a URL / protocol / file / app
 *
 * Bound to 127.0.0.1 only. /launch additionally requires a local origin and a
 * custom header, so other websites can't drive it.
 */
"use strict";

const { startServer } = require("./lib/server");

const PORT = process.env.PORT ? Number(process.env.PORT) : 8787;

startServer({ port: PORT, openBrowser: !process.env.NO_OPEN })
  .then(({ url }) => {
    console.log("");
    console.log("  ┌───────────────────────────────────────────────┐");
    console.log("  │            Morning Brief is running            │");
    console.log("  └───────────────────────────────────────────────┘");
    console.log("");
    console.log(`   Dashboard :  ${url}`);
    console.log(`   Proxy     :  ${url}/proxy?url=...`);
    console.log(`   Launcher  :  ${url}/launch?target=...`);
    console.log("");
    console.log("   Keep this window open while you use the dashboard.");
    console.log("   Press Ctrl+C to stop.");
    console.log("");
  })
  .catch((err) => {
    if (err && err.code === "EADDRINUSE") {
      console.error(`\n  Port ${PORT} is already in use.`);
      console.error(`  The dashboard server may already be running.`);
      console.error(`  Try:  set PORT=8788 && node serve.js\n`);
      process.exit(1);
    } else {
      console.error("\n  Server error:", err && err.message ? err.message : err, "\n");
      process.exit(1);
    }
  });
