/*
 * Morning Brief — cloud module (auth + sync + function relay).
 *
 * Loaded as a plain <script> after mb-config.js. When configured it defines
 * `window.mbCloud`, which the dashboard feature-detects (like window.morningBrief
 * in Electron). It:
 *   - signs the user in with Supabase (email + password),
 *   - syncs the whole app `state` to one RLS-protected row (last-write-wins),
 *   - relays calendar/RSS via the `proxy` Edge Function,
 *   - relays Gab AI via the `ai` Edge Function.
 *
 * Offline-first: localStorage is always the working copy; the network is an
 * async reconciler. No bundler, no imports — supabase-js loads from a CDN.
 */
(function () {
  "use strict";
  var cfg = window.MB_CLOUD_CONFIG || {};
  if (!cfg.url || !cfg.anonKey) {
    console.warn("[mb-cloud] not configured (missing url/anonKey)");
    return;
  }
  // Keep the bare file:// fallback exactly as it was (no cloud, no SDK load).
  if (location.protocol === "file:") return;

  var SDK_URL = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.js";
  var TABLE = "dashboards";
  var KEY_SYNCED_AT = "mb.sync.syncedAt";
  var KEY_DIRTY = "mb.sync.dirty";

  var sb = null;
  var session = null;
  var impl = null;            // { getState, setState } from the dashboard
  var syncedAt = localStorage.getItem(KEY_SYNCED_AT) || "";
  var dirty = localStorage.getItem(KEY_DIRTY) === "1";
  var status = "offline";     // offline | pending | synced
  var authCbs = [];
  var statusCbs = [];
  var pushTimer = null;
  var pullTimer = null;
  var readyResolve;
  var ready = new Promise(function (r) { readyResolve = r; });

  function setStatus(s) {
    if (s === status) return;
    status = s;
    statusCbs.forEach(function (fn) { try { fn(s); } catch (e) {} });
  }
  function setDirty(v) {
    dirty = !!v;
    try { v ? localStorage.setItem(KEY_DIRTY, "1") : localStorage.removeItem(KEY_DIRTY); } catch (e) {}
  }
  function setSyncedAt(t) {
    syncedAt = t || "";
    try { t ? localStorage.setItem(KEY_SYNCED_AT, t) : localStorage.removeItem(KEY_SYNCED_AT); } catch (e) {}
  }
  function currentUser() {
    return session && session.user ? { email: session.user.email, id: session.user.id } : null;
  }
  function notifyAuth() {
    var u = currentUser();
    authCbs.forEach(function (fn) { try { fn(u); } catch (e) {} });
  }

  function loadSDK() {
    return new Promise(function (resolve, reject) {
      if (window.supabase && window.supabase.createClient) return resolve(window.supabase);
      var s = document.createElement("script");
      s.src = SDK_URL;
      s.onload = function () { resolve(window.supabase); };
      s.onerror = function () { reject(new Error("Failed to load supabase-js")); };
      document.head.appendChild(s);
    });
  }

  /* ---------- sync ---------- */
  async function pull() {
    if (!sb || !session || !impl) return;
    var res = await sb.from(TABLE).select("state, updated_at").eq("user_id", session.user.id).maybeSingle();
    if (res.error) { setStatus("offline"); return; }
    if (!res.data) { await push(); return; }
    var remoteAt = res.data.updated_at;
    if (!syncedAt || remoteAt > syncedAt) {
      if (dirty) { await push(); }
      else {
        impl.setState(res.data.state || {});
        setSyncedAt(remoteAt);
        setStatus("synced");
      }
    } else {
      setStatus(dirty ? "pending" : "synced");
    }
  }
  async function push() {
    if (!sb || !session || !impl) return;
    var payload = {
      user_id: session.user.id,
      state: impl.getState(),
      updated_at: new Date().toISOString()
    };
    var res = await sb.from(TABLE).upsert(payload, { onConflict: "user_id" }).select("updated_at").maybeSingle();
    if (res.error) { setStatus("offline"); return; }
    setDirty(false);
    setSyncedAt((res.data && res.data.updated_at) || payload.updated_at);
    setStatus("synced");
  }
  function markDirty() {
    if (!session) return;
    setDirty(true);
    setStatus("pending");
    clearTimeout(pushTimer);
    pushTimer = setTimeout(function () { push(); }, cfg.pushDebounceMs || 1500);
  }
  function start(o) {
    impl = o || impl;
    ready.then(function () {
      if (!sb) return;
      pull();
      clearInterval(pullTimer);
      pullTimer = setInterval(pull, cfg.pullIntervalMs || 60000);
    });
  }
  window.addEventListener("focus", function () { if (sb && session) pull(); });
  document.addEventListener("visibilitychange", function () { if (!document.hidden && sb && session) pull(); });

  /* ---------- auth ---------- */
  async function signIn(email, password) {
    await ready;
    var r = await sb.auth.signInWithPassword({ email: email, password: password });
    if (r.error) throw r.error;
    session = (await sb.auth.getSession()).data.session;
    notifyAuth();
    await pull();
  }
  async function signUp(email, password) {
    await ready;
    var r = await sb.auth.signUp({ email: email, password: password });
    if (r.error) throw r.error;
    session = (await sb.auth.getSession()).data.session;
    notifyAuth();
    if (session) await pull();
  }
  async function signOut() {
    await ready;
    try { await sb.auth.signOut(); } catch (e) {}
    session = null;
    setSyncedAt("");
    setDirty(false);
    notifyAuth();
    setStatus("offline");
  }

  /* ---------- relay ---------- */
  function authHeaders() {
    return {
      "apikey": cfg.anonKey,
      "Authorization": "Bearer " + (session && session.access_token ? session.access_token : cfg.anonKey)
    };
  }
  async function aiChat(request, apiKey) {
    await ready;
    var r = await fetch(functionBase() + (cfg.aiFunction || "ai"), {
      method: "POST",
      headers: Object.assign({ "Content-Type": "application/json" }, authHeaders()),
      body: JSON.stringify({ apiKey: apiKey || "", request: request })
    });
    var j = await r.json().catch(function () { return {}; });
    if (!r.ok) {
      var m = (j && j.error && (j.error.message || j.error)) || ("AI error " + r.status);
      throw new Error(typeof m === "string" ? m : "AI error " + r.status);
    }
    return j;
  }
  function functionBase() { return cfg.url + "/functions/v1/"; }

  /* ---------- public API ---------- */
  window.mbCloud = {
    version: "1",
    functionBase: functionBase(),
    proxyPrefix: functionBase() + (cfg.proxyFunction || "proxy") + "?url=",
    authHeaders: authHeaders,
    aiChat: aiChat,
    auth: {
      user: currentUser,
      signIn: signIn,
      signUp: signUp,
      signOut: signOut,
      onChange: function (cb) { authCbs.push(cb); cb(currentUser()); }
    },
    sync: {
      start: start,
      markDirty: markDirty,
      status: function () { return status; },
      onChange: function (cb) { statusCbs.push(cb); cb(status); }
    }
  };

  /* ---------- boot ---------- */
  loadSDK().then(function (mod) {
    sb = mod.createClient(cfg.url, cfg.anonKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
    });
    sb.auth.onAuthStateChange(function (_event, s) {
      session = s;
      notifyAuth();
      if (s && impl) pull();
    });
    return sb.auth.getSession();
  }).then(function (r) {
    session = r && r.data ? r.data.session : null;
    notifyAuth();
    readyResolve();
  }).catch(function (e) {
    console.warn("[mb-cloud] init failed:", e && e.message ? e.message : e);
    readyResolve();
  });
})();
