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

/* ---------------- steps 1+2: auto-refresh ---------------- */

test("isStale: missing/invalid timestamps are stale, fresh ones are not", () => {
  const isStale = extractFn("isStale");
  const now = Date.parse("2026-10-20T12:00:00.000Z");
  const max = 15 * 60 * 1000;
  assert.equal(isStale(null, now, max), true, "never synced is stale");
  assert.equal(isStale("", now, max), true);
  assert.equal(isStale("not-a-date", now, max), true, "garbage timestamp is stale");
  assert.equal(isStale("2026-10-20T11:50:00.000Z", now, max), false, "10 min old is fresh");
  assert.equal(isStale("2026-10-20T11:44:59.000Z", now, max), true, "just past the window is stale");
  assert.equal(isStale("2026-10-20T11:45:00.000Z", now, max), false, "exactly at the window edge is still fresh");
});

test("boot triggers the auto-refresh check (source-level guard)", () => {
  const boot = html.slice(html.indexOf("function boot()"));
  assert.match(boot, /maybeAutoRefresh\(\)/, "boot must kick off an automatic freshness check");
  const fn = html.slice(html.indexOf("function maybeAutoRefresh"), html.indexOf("function maybeAutoRefresh") + 1500);
  assert.match(fn, /isStale\(/, "auto-refresh must be staleness-gated, not unconditional");
  assert.match(fn, /syncCalendar\(/, "auto-refresh covers the calendar");
  assert.match(fn, /refreshNews\(/, "auto-refresh covers the news feed");
});

/* ---------------- steps 1+2: todos ---------------- */

test("applyTodoEdit: updates fields immutably, reports missing ids", () => {
  const applyTodoEdit = extractFn("applyTodoEdit");
  const base = () => ([
    { id: "a", text: "Old", done: false, prio: "med", due: "", project: "", created: "2026-10-20" },
    { id: "b", text: "Keep", done: true, prio: "low", due: "", project: "", created: "2026-10-20" }
  ]);
  const r = applyTodoEdit(base(), "a", { text: " New text ", prio: "high", due: "2026-10-22", project: "Cascade" });
  assert.equal(r.status, "updated");
  assert.deepEqual(r.todos[0],
    { id: "a", text: "New text", done: false, prio: "high", due: "2026-10-22", project: "Cascade", created: "2026-10-20" },
    "text is trimmed; done/created survive an edit");
  const before = base();
  const miss = applyTodoEdit(before, "nope", { text: "X" });
  assert.equal(miss.status, "missing");
  assert.deepEqual(miss.todos, before);
  const src = base();
  applyTodoEdit(src, "a", { text: "Z" });
  assert.deepEqual(src, base(), "input list/objects are not mutated");
});

test("clearCompletedTodos: removes only done items and reports them for undo", () => {
  const clearCompletedTodos = extractFn("clearCompletedTodos");
  const list = [
    { id: "1", text: "open", done: false },
    { id: "2", text: "done1", done: true },
    { id: "3", text: "done2", done: true }
  ];
  const r = clearCompletedTodos(list);
  assert.deepEqual(r.todos.map(t => t.id), ["1"]);
  assert.deepEqual(r.removed.map(t => t.id), ["2", "3"], "removed items are returned so the UI can undo");
  assert.equal(list.length, 3, "input is not mutated");
  assert.deepEqual(clearCompletedTodos([]).removed, []);
});

test("todo UI wires due/project fields, filters, edit and clear-completed (source guard)", () => {
  assert.ok(html.includes('id="todoDue"'), "quick-add form has a due-date field");
  assert.ok(html.includes('id="todoProject"'), "quick-add form has a project field");
  assert.match(html, /data-tfilter/, "Open/All/Done filter controls exist");
  assert.match(html, /data-tedit/, "todo rows expose an edit control");
  assert.match(html, /state\.ui\.todoFilter/, "rendering actually honours ui.todoFilter");
  const formAt = html.indexOf('$("#todoForm")');
  const formSrc = html.slice(formAt, formAt + 900);
  assert.match(formSrc, /\$\("#todoDue"\)\.value/, "the quick-add form stores the chosen due date");
  assert.match(formSrc, /\$\("#todoProject"\)\.value/, "the quick-add form stores the chosen project");
  assert.ok(html.includes("toastUndo("), "destructive actions offer undo");
  assert.match(html, /\.status\{[^}]*position:fixed/, "toasts are fixed to the viewport, not buried below the panels");
});

test("manual calendar events can be edited and deleted (source guard)", () => {
  assert.match(html, /data-mevedit/, "manual events render an edit control");
  assert.match(html, /data-mevdel/, "manual events render a delete control");
  assert.match(html, /state\.calendar\.manual\s*=\s*state\.calendar\.manual\.filter/, "delete removes from state.calendar.manual");
});

/* ---------------- steps 1+2: dark theme ---------------- */

test("dark theme exists and can follow the OS (source guard)", () => {
  assert.match(html, /\[data-theme="dark"\]\{/, "a dark theme token block exists");
  assert.match(html, /THEMES\s*=\s*\[[^\]]*"dark"/, "dark is a selectable theme");
  assert.match(html, /value="auto"/, "Setup offers an Auto (match system) theme");
  assert.match(html, /prefers-color-scheme:\s*dark/, "Auto resolves via the OS color-scheme preference");
  assert.match(html, /color-scheme" content="light dark"/, "the page advertises both color schemes");
});

/* ---------------- steps 1+2: Today strip + timer-from-task ---------------- */

test("topTodayTasks: overdue and due-today first, done excluded, limit applied", () => {
  const topTodayTasks = extractFn("topTodayTasks");
  const todos = [
    { id: "1", text: "future low", done: false, prio: "low", due: "2026-11-01" },
    { id: "2", text: "overdue med", done: false, prio: "med", due: "2026-10-18" },
    { id: "3", text: "today high", done: false, prio: "high", due: "2026-10-20" },
    { id: "4", text: "done overdue", done: true, prio: "high", due: "2026-10-01" },
    { id: "5", text: "no due high", done: false, prio: "high", due: "" },
    { id: "6", text: "overdue high", done: false, prio: "high", due: "2026-10-19" }
  ];
  const top = topTodayTasks(todos, "2026-10-20", 3);
  assert.deepEqual(top.map(t => t.id), ["6", "3", "2"],
    "overdue-high, then due-today-high, then overdue-med; done and future/low fall off");
  assert.deepEqual(topTodayTasks([], "2026-10-20", 3), []);
  assert.equal(todos[0].id, "1", "input order is not mutated");
});

test("projectNextActions: first open task of each active project, done projects skipped", () => {
  const projectNextActions = extractFn("projectNextActions");
  const work = [
    { id: "w1", name: "Cascade", status: "active", tasks: [
      { id: "t1", text: "Storyboard", done: true },
      { id: "t2", text: "Animatic pass", done: false },
      { id: "t3", text: "Sound", done: false } ] },
    { id: "w2", name: "Shipped", status: "done", tasks: [ { id: "t4", text: "Leftover", done: false } ] },
    { id: "w3", name: "All done", status: "active", tasks: [ { id: "t5", text: "Fin", done: true } ] }
  ];
  const personal = [
    { id: "p1", name: "Robot kit", status: "idea", tasks: [ { id: "t6", text: "Order servos", done: false } ] }
  ];
  const r = projectNextActions(work, personal);
  assert.deepEqual(r.map(x => x.projectName + ":" + x.taskText), ["Cascade:Animatic pass", "Robot kit:Order servos"]);
  assert.equal(r[0].bucket, "work");
  assert.equal(r[1].bucket, "personal");
});

test("Today strip and timer-from-task are wired (source guard)", () => {
  assert.ok(html.includes('id="todayStrip"'), "a Today strip exists above the grid");
  const renderAllSrc = html.slice(html.indexOf("function renderAll()"), html.indexOf("function renderAll()") + 400);
  assert.match(renderAllSrc, /renderToday\(\)/, "renderAll refreshes the Today strip");
  assert.match(html, /data-timer-task/, "project tasks can start the timer");
  assert.match(html, /function startTimerFor\(/, "timer start accepts a prefill (client/project/label)");
  assert.match(html, /data-timer-todo/, "todos can start the timer");
});

/* ---------------- steps 1+2: command palette ---------------- */

test("paletteFilter: case-insensitive match over label and hint, empty query keeps all", () => {
  const paletteFilter = extractFn("paletteFilter");
  const items = [
    { label: "Cascade animatic", hint: "Work project" },
    { label: "Log time", hint: "Action" },
    { label: "Buy servos", hint: "To-do · Robot kit" }
  ];
  assert.equal(paletteFilter(items, "").length, 3);
  assert.deepEqual(paletteFilter(items, "cas").map(i => i.label), ["Cascade animatic"]);
  assert.deepEqual(paletteFilter(items, "ROBOT").map(i => i.label), ["Buy servos"], "hint text is searchable");
  assert.deepEqual(paletteFilter(items, "zzz"), []);
});

test("Ctrl+K palette is wired (source guard)", () => {
  assert.ok(html.includes('id="palette"'), "palette overlay exists");
  assert.match(html, /\(e\.ctrlKey \|\| e\.metaKey\)[^\n]*"k"/i, "Ctrl/Cmd+K opens the palette");
  assert.ok(html.includes('id="paletteBtn"'), "a discoverable palette button exists in the header");
});

/* ---------------- steps 1+2: hours history + CSV ---------------- */

test("hoursToCSV: header, date order, quoting of commas/quotes/newlines", () => {
  const hoursToCSV = extractFn("hoursToCSV");
  const csv = hoursToCSV([
    { date: "2026-10-14", client: "Beta", project: "Logo", minutes: 90, note: "plain" },
    { date: "2026-10-12", client: "Acme, Co", project: 'Say "hi"', minutes: 61, note: "line1\nline2" }
  ]);
  const lines = csv.trimEnd().split("\n");
  assert.equal(lines[0], "Date,Client,Project,Hours,Minutes,Notes");
  assert.equal(lines[1], '2026-10-12,"Acme, Co","Say ""hi""",1.02,61,"line1\nline2"'.split("\n")[0],
    "earlier date first; comma/quote fields are quoted with doubled quotes");
  assert.ok(csv.indexOf('"line1\nline2"') > -1, "embedded newlines stay inside the quoted field");
  assert.ok(csv.includes("2026-10-14,Beta,Logo,1.5,90,plain"));
  assert.equal(hoursToCSV([]).trimEnd(), "Date,Client,Project,Hours,Minutes,Notes", "empty input still yields a header");
});

test("hours history browser and CSV export are wired (source guard)", () => {
  assert.match(html, /data-hweek/, "previous/next week navigation exists");
  assert.ok(html.includes('id="hoursCsv"'), "a CSV export control exists in the Hours panel");
  assert.match(html, /hoursToCSV\(/, "the export uses the CSV serializer");
  assert.match(html, /\.csv",\s*hoursToCSV|hoursToCSV\([^)]*\)[^;]*"text\/csv"/is, "CSV downloads as a .csv/text-csv file");
});

/* ---------------- steps 1+2: news read/save ---------------- */

test("toggleSavedNews: saves a copy, unsaves by link, never duplicates or mutates", () => {
  const toggleSavedNews = extractFn("toggleSavedNews");
  const item = { title: "Blender 9.0", link: "https://ex.com/1", date: "2026-10-20", summary: "s", feedName: "ex.com" };
  let saved = toggleSavedNews([], item);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].link, "https://ex.com/1");
  saved = toggleSavedNews(saved, item);
  assert.equal(saved.length, 0, "toggling the same link again unsaves it");
  const before = [item];
  toggleSavedNews(before, { title: "Other", link: "https://ex.com/2" });
  assert.deepEqual(before, [item], "input array is not mutated");
});

test("news read/save state is wired (source guard)", () => {
  assert.match(html, /read: \[\], saved: \[\]/, "default news state carries read/saved collections");
  assert.match(html, /data-nsave/, "stories expose a save toggle");
  assert.match(html, /state\.news\.read/, "read state is read/written");
  assert.match(html, /data-nview/, "All/Unread/Saved view switch exists");
});
