// Supabase Edge Function: proxy
// Server-side fetch of calendar (.ics) / RSS so the browser never deals with
// CORS. Requires a signed-in user (JWT). Mirrors handleProxy in lib/server.js.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

function text(body: string, status: number, headers: Record<string, string> = {}) {
  return new Response(body, { status, headers: { ...CORS, "Content-Type": "text/plain; charset=utf-8", ...headers } });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

  // Must be a signed-in user (not the public anon role).
  const authHeader = req.headers.get("Authorization") || "";
  const supa = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: authHeader } } }
  );
  const { data: { user } } = await supa.auth.getUser();
  if (!user) return text("Not signed in", 401);

  const target = new URL(req.url).searchParams.get("url");
  if (!target) return text("Missing ?url=", 400);

  let parsed: URL;
  try { parsed = new URL(target); } catch { return text("Malformed url", 400); }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return text("Only http(s) urls are allowed", 400);

  try {
    const r = await fetchUpstream(target);
    return new Response(r.buf, { status: r.status, headers: { ...CORS, "Content-Type": r.contentType } });
  } catch (e) {
    const msg = (e as Error)?.name === "AbortError"
      ? "Upstream timed out"
      : "Proxy fetch failed: " + ((e as Error)?.message || e);
    return text(msg, 502);
  }
});

// Mirror of fetchUpstream in lib/server.js: retry transient upstream failures
// a couple of times, presenting a browser User-Agent after a block, so one
// bad response doesn't take a feed down for days.
const PROXY_USER_AGENTS = [
  "MorningBrief/1.0 (cloud)",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
];
const PROXY_RETRY_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);
const PROXY_UA_BLOCK_STATUSES = new Set([401, 403, 406]);
const proxyDelay = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchUpstream(target: string): Promise<{ status: number; contentType: string; buf: ArrayBuffer }> {
  let uaIdx = 0;
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const upstream = await fetch(target, {
        redirect: "follow",
        signal: controller.signal,
        headers: {
          "User-Agent": PROXY_USER_AGENTS[Math.min(uaIdx, PROXY_USER_AGENTS.length - 1)],
          "Accept": "text/calendar, application/rss+xml, application/atom+xml, application/xml, text/xml, */*",
        },
      });
      const status = upstream.status;
      const uaBlocked = PROXY_UA_BLOCK_STATUSES.has(status) && uaIdx < PROXY_USER_AGENTS.length - 1;
      if ((PROXY_RETRY_STATUSES.has(status) || uaBlocked) && attempt < 2) {
        if (uaBlocked) uaIdx++;
        try { await upstream.body?.cancel(); } catch { /* ignore */ }
        clearTimeout(timer);
        await proxyDelay(500 * (attempt + 1));
        continue;
      }
      const buf = await upstream.arrayBuffer();
      const contentType = upstream.headers.get("content-type") || "text/plain; charset=utf-8";
      clearTimeout(timer);
      return { status, contentType, buf };
    } catch (e) {
      clearTimeout(timer);
      lastErr = e;
      if (attempt < 2) { await proxyDelay(500 * (attempt + 1)); continue; }
      throw e;
    }
  }
  throw lastErr || new Error("Upstream unreachable");
}
