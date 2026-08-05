// Supabase Edge Function: proxies food-photo/text analysis to the Anthropic API.
//
// Why this exists: the frontend (index.html) used to call api.anthropic.com
// directly with no API key, which only works inside a Claude.ai Artifact
// sandbox. On a normal deployment (GitHub Pages) that fetch has nowhere to
// get credentials from, so it fails for everyone except whoever has a key
// injected some other way. This function holds the Anthropic key server-side
// (as a Supabase secret) and the frontend calls this instead.
//
// Auth: Supabase verifies the caller's JWT before this code runs (default
// `verify_jwt` behavior for Edge Functions), so an unauthenticated request
// never reaches here. We still fetch the user via the JWT to key the
// per-user rate limit in `ai_usage`.
import { createClient } from "jsr:@supabase/supabase-js@2";

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const DAILY_LIMIT = 30; // Max AI analysis calls per user per day, to cap the Anthropic bill.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// Error strings the frontend surfaces directly to the user. The client sends
// `lang` in the request body (its current UI language); default to Chinese
// for older cached frontends that don't send it yet.
const MESSAGES = {
  needLogin: { zh: "请先登录再使用 AI 分析", en: "Please sign in first to use AI analysis" },
  badRequestFormat: { zh: "请求格式不对", en: "Malformed request" },
  missingFields: { zh: "请求缺少必要字段", en: "Request is missing required fields" },
  dailyLimitReached: {
    zh: (n: number) => `今天的 AI 分析次数已用完（每天最多 ${n} 次），明天再来～`,
    en: (n: number) => `You've used all your AI analyses for today (max ${n}/day) — come back tomorrow.`,
  },
};
function msg(key: keyof typeof MESSAGES, lang: string, n?: number): string {
  const entry = MESSAGES[key][lang === "en" ? "en" : "zh"];
  return typeof entry === "function" ? entry(n as number) : entry;
}

function jsonResponse(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  const authHeader = req.headers.get("Authorization") ?? "";
  const callerClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: { user }, error: authError } = await callerClient.auth.getUser();

  let body: { model?: string; max_tokens?: number; messages?: unknown; lang?: string };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: msg("badRequestFormat", "zh") }, 400);
  }
  const { model, max_tokens, messages, lang } = body;

  if (authError || !user) {
    return jsonResponse({ error: msg("needLogin", lang ?? "zh") }, 401);
  }
  if (!model || !max_tokens || !messages) {
    return jsonResponse({ error: msg("missingFields", lang ?? "zh") }, 400);
  }

  // Service-role client bypasses RLS — only this function touches ai_usage.
  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const today = new Date().toISOString().slice(0, 10);
  const { data: usage } = await admin
    .from("ai_usage")
    .select("count")
    .eq("user_id", user.id)
    .eq("day", today)
    .maybeSingle();

  if (usage && usage.count >= DAILY_LIMIT) {
    return jsonResponse(
      { error: msg("dailyLimitReached", lang ?? "zh", DAILY_LIMIT) },
      429,
    );
  }

  const anthropicRes = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({ model, max_tokens, messages }),
  });
  const resultText = await anthropicRes.text();

  if (anthropicRes.ok) {
    await admin.from("ai_usage").upsert(
      { user_id: user.id, day: today, count: (usage?.count ?? 0) + 1 },
      { onConflict: "user_id,day" },
    );
  }

  return new Response(resultText, {
    status: anthropicRes.status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});
