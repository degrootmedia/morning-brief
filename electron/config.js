/*
 * Tiny JSON config store for the Electron app.
 * Lives at <userData>/config.json. Synchronous read/write, no dependencies.
 *
 * Shape: { serverPort: number|null, window: { width, height, x, y } }
 */
"use strict";

const { app } = require("electron");
const fs = require("fs");
const path = require("path");

const DEFAULTS = { serverPort: null, window: {} };

function file() {
  return path.join(app.getPath("userData"), "config.json");
}

function read() {
  try {
    const raw = JSON.parse(fs.readFileSync(file(), "utf8"));
    return { ...DEFAULTS, ...(raw && typeof raw === "object" ? raw : {}) };
  } catch {
    return { ...DEFAULTS, window: {} };
  }
}

function write(cfg) {
  try {
    const f = file();
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, JSON.stringify(cfg, null, 2), "utf8");
    return true;
  } catch (e) {
    console.warn("Could not write config:", e && e.message ? e.message : e);
    return false;
  }
}

module.exports = { read, write, file };
