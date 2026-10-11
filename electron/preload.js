/*
 * Preload — the only bridge between the renderer and Node/Electron.
 * Exposes a narrow, promise-based API on `window.morningBrief`.
 * The dashboard feature-detects this object to switch into desktop mode.
 */
"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("morningBrief", {
  version: "1",
  platform: process.platform,
  launch:       (target)     => ipcRenderer.invoke("mb:launch", target),
  openExternal: (url)        => ipcRenderer.invoke("mb:openExternal", url),
});
