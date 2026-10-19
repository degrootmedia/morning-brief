"use strict";
/*
 * Focused regression tests for Morning Brief behavior changes:
 *   1. Weekly client/project dropdown suggestions (derived from this week's entries)
 *   2. Editing saved hour entries (update / merge-on-collision / delete handled by caller)
 *   3. News feed hardening (proxy fallback chain, JSON unwrap, never trust an empty response)
 *   4. Local proxy server upstream retry / User-Agent fallback
 *   5. Greeting refreshes on a timer (morning/afternoon/evening without a restart)
 *
 * The dashboard is a single index.html with no build step, so the pure helpers
 * are extracted from the page <script> by name and exercised directly.
 * Run: npm test   (node --test, no extra dependencies)
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");

// Extract `function NAME(...) { ... }` (or an async one) by brace matching.
function extractFn(name) {
  const re = new RegExp("(?:async\\s+)?function\\s+" + name + "\\s*\\(");
  const m = html.match(re);
  assert.ok(m, "expected function " + name + " to exist in index.html");
  let i = m.index;
  const start = i;
  let depth = 0, seenBrace = false, inStr = null, esc = false, inTemplate = 0;
  for (; i < html.length; i++) {
    const c = html[i];
    if (esc) { esc = false; continue; }
    if (c === "\\") { esc = true; continue; }
    if (inStr) { if (c === inStr) inStr = null; continue; }
    if (inTemplate) {
      if (c === "`") inTemplate--;
      else if (c === "$" && html[i + 1] === "{") { /* template expr braces net out below */ }
      continue;
    }
    if (c === '"' || c === "'") { inStr = c; continue; }
    if (c === "`") { inTemplate++; continue; }
    if (c === "{") { depth++; seenBrace = true; }
    else if (c === "}") { depth--; if (seenBrace && depth === 0) { i++; break; } }
  }
  assert.ok(seenBrace && depth === 0, "could not brace-match " + name);
  const src = html.slice(start, i);
  // eslint-disable-next-line no-new-func
  return new Function(src + "\nreturn " + name + ";")();
}

// Rebuild the small shared helpers the extracted functions may close over,
// evaluating them together so internal calls resolve.
function extractAll(names) {
  let src = "";
  for (const n of names) {
    const re = new RegExp("(?:async\\s+)?function\\s+" + n + "\\s*\\(");
    const m = html.match(re);
    assert.ok(m, "expected function " + n);
    let i = m.index; const start = i;
    let depth = 0, seen = false, inStr = null, esc = false;
    for (; i < html.length; i++) {
      const c = html[i];
      if (esc) { esc = false; continue; }
      if (c === "\\") { esc = true; continue; }
      if (inStr) { if (c === inStr) inStr = null; continue; }
      if (c === '"' || c === "'") { inStr = c; continue; }
      if (c === "`") continue; // these two helpers use no template literals
      if (c === "{") { depth++; seen = true; }
      else if (c === "}") { depth--; if (seen && depth === 0) { i++; break; } }
    }
    assert.ok(seen && depth === 0, "brace-match " + n);
    src += html.slice(start, i) + "\n";
  }
  // eslint-disable-next-line no-new-func
  return new Function(src + "\nreturn { " + names.join(", ") + " };")();
}
function extractWithDeps() { return extractAll(["unwrapProxyPayload", "fetchFeed"]); }

/* ---------------- 2. weekly dropdown suggestions ---------------- */

test("week suggestions: unique clients/projects from this week's entries only", () => {
  const { entriesInWeek, weekClients, weekProjects } =
    extractAll(["entriesInWeek", "uniqueSorted", "weekClients", "weekProjects"]);

  const entries = [
    { id: "1", date: "2026-10-12", client: "Acme Co", project: "Cascade", minutes: 60, note: "" },   // Mon (in week)
    { id: "2", date: "2026-10-14", client: "acme co", project: "Cascade", minutes: 30, note: "" },   // dup client casing
    { id: "3", date: "2026-10-16", client: "Beta",    project: "Logo",    minutes: 45, note: "" },
    { id: "4", date: "2026-10-18", client: "Beta",    project: "Website", minutes: 45, note: "" },   // Sun (in week)
    { id: "5", date: "2026-10-05", client: "OldCo",   project: "LastWeek", minutes: 45, note: "" },  // previous week
    { id: "6", date: "2026-10-15", client: "",        project: "NoClient", minutes: 45, note: "" }
  ];
  const week = entriesInWeek(entries, "2026-10-12", "2026-10-18");
  assert.equal(week.length, 5, "previous week's entry is excluded (dropdowns reset each week)");

  assert.deepEqual(weekClients(week), ["Acme Co", "Beta"],
    "clients are case-insensitively deduped, blanks dropped, sorted");

  assert.deepEqual(weekProjects(week, ""), ["Cascade", "Logo", "NoClient", "Website"],
    "with no client chosen, all of this week's projects are suggested");
  assert.deepEqual(weekProjects(week, "beta"), ["Logo", "Website"],
    "projects narrow to the chosen client (case-insensitive)");
  assert.deepEqual(weekProjects(week, "New Client"), ["Cascade", "Logo", "NoClient", "Website"],
    "an unknown/new client still gets the full project list (free text unaffected)");
});

/* ---------------- 1. editing hour entries ---------------- */

test("applyEntryEdit: update in place, merge on collision, report missing ids", () => {
  const applyEntryEdit = extractFn("applyEntryEdit");
  const base = () => ([
    { id: "a", date: "2026-10-12", client: "Acme", project: "Cascade", minutes: 60, note: "sketch" },
    { id: "b", date: "2026-10-13", client: "Beta", project: "Logo", minutes: 30, note: "" }
  ]);

  // Plain update: fix hours + rename project.
  let r = applyEntryEdit(base(), "a", { date: "2026-10-12", client: "Acme", project: "Cascade v2", minutes: 90, note: "sketch" });
  assert.equal(r.status, "updated");
  assert.deepEqual(r.entries.find(e => e.id === "a"),
    { id: "a", date: "2026-10-12", client: "Acme", project: "Cascade v2", minutes: 90, note: "sketch" });
  assert.equal(r.entries.length, 2);

  // Collision: moving "a" onto b's date+client+project merges minutes and notes.
  r = applyEntryEdit(base(), "a", { date: "2026-10-13", client: "beta", project: "LOGO", minutes: 60, note: "sketch" });
  assert.equal(r.status, "merged");
  assert.equal(r.entries.length, 1);
  assert.equal(r.entries[0].id, "b");
  assert.equal(r.entries[0].minutes, 90);
  assert.equal(r.entries[0].note, "sketch");

  // Missing id leaves entries untouched.
  const before = base();
  r = applyEntryEdit(before, "nope", { date: "2026-10-12", client: "X", project: "Y", minutes: 10, note: "" });
  assert.equal(r.status, "missing");
  assert.deepEqual(r.entries, before);

  // Input is not mutated.
  const src = base();
  applyEntryEdit(src, "a", { date: "2026-10-13", client: "Beta", project: "Logo", minutes: 5, note: "n" });
  assert.deepEqual(src, base(), "original entries array/objects are not mutated");
});

/* ---------------- 3. news feed hardening ---------------- */

test("unwrapProxyPayload: unwraps JSON-wrapped proxy bodies, passes others through", () => {
  const { unwrapProxyPayload } = extractWithDeps();
  assert.equal(unwrapProxyPayload('{"contents":"<rss>ITEM</rss>"}'), "<rss>ITEM</rss>");
  assert.equal(unwrapProxyPayload("<rss>ITEM</rss>"), "<rss>ITEM</rss>");
  assert.equal(unwrapProxyPayload("{not json"), "{not json");
});

test("fetchFeed: falls through dead proxies until one returns parseable stories", async () => {
  const { fetchFeed } = extractWithDeps();
  const parse = (xml) => {
    if (xml.includes("BAD")) throw new Error("Feed could not be parsed.");
    return xml.includes("ITEM") ? [{ title: "Story", link: "https://ex.com/1" }] : [];
  };
  const seen = [];
  const fetcher = async (target) => {
    seen.push(target);
    if (target.startsWith("https://dead-proxy/")) throw new Error("fetch failed");                 // proxy down
    if (target.startsWith("https://error-proxy/")) return { ok: true, status: 200, text: async () => "BAD html error page" };
    if (target.startsWith("https://json-proxy/")) return { ok: true, status: 200, text: async () => '{"contents":"<rss>ITEM</rss>"}' };
    return { ok: false, status: 404, text: async () => "" };
  };
  const r = await fetchFeed("https://feed.example/rss",
    ["https://dead-proxy/?url=", "https://error-proxy/?url=", "https://json-proxy/?url="], fetcher, parse);
  assert.equal(r.ok, true, "a later healthy proxy wins after earlier ones fail");
  assert.equal(r.via, "https://json-proxy/?url=");
  assert.equal(r.items.length, 1);
  assert.equal(seen.length, 3, "each candidate was tried exactly once, in order");

  // Empty-but-200 responses must not be accepted (that's what wiped the cache).
  const r2 = await fetchFeed("https://feed.example/rss", [""], fetcher, parse);
  assert.equal(r2.ok, false);
  assert.deepEqual(r2.items, []);
});

test("refreshNews keeps cached stories when every fetch fails (source-level guard)", () => {
  // The full refreshNews needs a DOM; assert the failure-preservation contract in source:
  // topic.items is only assigned from a non-empty collection.
  const m = html.match(/async function refreshNews[\s\S]*?\n\}/);
  assert.ok(m, "refreshNews exists");
  const src = m[0];
  assert.match(src, /if\s*\(\s*collected\.length\s*\)\s*\{[^}]*topic\.items\s*=/s,
    "cached items are only replaced when new stories were collected");
  assert.doesNotMatch(src, /topic\.items\s*=\s*collected\.filter/,
    "the old unconditional overwrite (which emptied the feed on outages) is gone");
});

/* ---------------- status/activity updates placement ---------------- */

test("status updates render below the panels so they cannot shift them", () => {
  const statusAt = html.indexOf('id="status"');
  const mainEnd = html.indexOf("</main>");
  const footerAt = html.indexOf("<footer");
  assert.ok(statusAt > -1 && mainEnd > -1, "status element and </main> exist");
  assert.ok(statusAt > mainEnd, "status (#status toast area) sits after </main>, below every panel");
  assert.ok(footerAt === -1 || statusAt < footerAt, "status sits before the footer");
  assert.equal((html.match(/id="status"/g) || []).length, 1, "exactly one #status element");
});

/* ---------------- greeting refresh ---------------- */

test("greeting refreshes on a timer so it tracks the time of day without a restart", () => {
  // renderGreeting recomputes morning/afternoon/evening from the current hour
  // on every call; the bug was that nothing re-called it after boot. Assert
  // boot schedules it on a repeating timer of an hour or less.
  const m = html.match(/setInterval\(\s*renderGreeting\s*,\s*(\d+)\s*\)/);
  assert.ok(m, "boot schedules renderGreeting with setInterval (not just once via renderAll)");
  const ms = Number(m[1]);
  assert.ok(ms > 0 && ms <= 60 * 60 * 1000, "greeting refresh interval is an hour or less (got " + ms + "ms)");
});

/* ---------------- proxy server retry ---------------- */

test("server fetchUpstream: retries transient failures and swaps UA when blocked", async () => {
  const { _internals } = require(path.join(__dirname, "..", "lib", "server.js"));
  assert.ok(_internals && typeof _internals.fetchUpstream === "function", "server exposes fetchUpstream for tests");
  const okRes = (status, body) => ({
    status, headers: { get: () => "application/rss+xml" },
    arrayBuffer: async () => Buffer.from(body || "<rss/>"),
    body: { cancel: async () => {} }
  });

  // 502 once, then 200.
  let calls = 0;
  let r = await _internals.fetchUpstream("https://feed.example/rss", async () => (++calls === 1 ? okRes(502, "bad gw") : okRes(200)));
  assert.equal(r.status, 200);
  assert.equal(calls, 2);

  // 403 with the bot UA, then 200 once a browser UA is presented.
  const uas = [];
  r = await _internals.fetchUpstream("https://feed.example/rss", async (_u, opts) => {
    uas.push(opts.headers["User-Agent"]);
    return /Mozilla/.test(opts.headers["User-Agent"]) ? okRes(200) : okRes(403, "blocked");
  });
  assert.equal(r.status, 200);
  assert.ok(uas.length >= 2 && uas[0] !== uas[1], "User-Agent changes after a block");

  // A genuine 404 is returned as-is (no pointless retries).
  calls = 0;
  r = await _internals.fetchUpstream("https://feed.example/missing", async () => { calls++; return okRes(404, "nope"); });
  assert.equal(r.status, 404);
  assert.equal(calls, 1);
});
