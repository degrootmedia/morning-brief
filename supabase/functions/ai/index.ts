// Supabase Edge Function: ai
// Relays a request to the Gab AI API (OpenAI-compatible) on the server side.
// The caller supplies their own Gab key in the body; the function verifies the
// Supabase JWT first. Mirrors handleAiChat in lib/server.js.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const UPSTREAM = "https://gab.ai/v1/chat/completions";

function json(obj: unknown, status: number) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...CORS, "Content-Type": "application/json; charset=utf-8" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const authHeader = req.headers.get("Authorization") || "";
  const supa = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: authHeader } } }
  );
  const { data: { user } } = await supa.auth.getUser();
  if (!user) return json({ error: "Not signed in" }, 401);

  let payload: any;
  try { payload = await req.json(); } catch { return json({ error: "Invalid JSON body" }, 400); }

  const apiKey = typeof payload?.apiKey === "string" ? payload.apiKey.trim() : "";
  const request = payload?.request;
  if (!apiKey) return json({ error: "Missing apiKey" }, 400);
  if (!request || typeof request !== "object") return json({ error: "Missing request" }, 400);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 90000);
  try {
    const upstream = await fetch(UPSTREAM, {
      method: "POST",
      signal: controller.signal,
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + apiKey },
      body: JSON.stringify(request),
    });
    const body = await upstream.text();
    return new Response(body, {
      status: upstream.status,
      headers: { ...CORS, "Content-Type": "application/json; charset=utf-8" },
    });
  } catch (e) {
    const msg = (e as Error)?.name === "AbortError"
      ? "AI request timed out"
      : "AI request failed: " + ((e as Error)?.message || e);
    return json({ error: msg }, 502);
  } finally {
    clearTimeout(timer);
  }
});
