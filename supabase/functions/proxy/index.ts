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

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25000);
  try {
    const upstream = await fetch(target, {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "User-Agent": "MorningBrief/1.0 (cloud)",
        "Accept": "text/calendar, application/rss+xml, application/atom+xml, application/xml, text/xml, */*",
      },
    });
    const buf = await upstream.arrayBuffer();
    const ct = upstream.headers.get("content-type") || "text/plain; charset=utf-8";
    return new Response(buf, { status: upstream.status, headers: { ...CORS, "Content-Type": ct } });
  } catch (e) {
    const msg = (e as Error)?.name === "AbortError"
      ? "Upstream timed out"
      : "Proxy fetch failed: " + ((e as Error)?.message || e);
    return text(msg, 502);
  } finally {
    clearTimeout(timer);
  }
});
