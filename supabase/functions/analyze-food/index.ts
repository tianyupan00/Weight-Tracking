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
const DAILY_LIMIT = 30; // AI 分析每人每天最多调用次数，防止被刷爆账单

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
};

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
  if (authError || !user) {
    return jsonResponse({ error: "请先登录再使用 AI 分析" }, 401);
  }

  let body: { model?: string; max_tokens?: number; messages?: unknown };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "请求格式不对" }, 400);
  }
  const { model, max_tokens, messages } = body;
  if (!model || !max_tokens || !messages) {
    return jsonResponse({ error: "请求缺少必要字段" }, 400);
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
      { error: `今天的 AI 分析次数已用完（每天最多 ${DAILY_LIMIT} 次），明天再来～` },
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
