// src/worker.ts
var corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Max-Age": "86400"
};
var DEFAULT_SYNC_THRESHOLD = 20;
var PLAN_LIMITS = {
  free: { messages: 200, translations: 80 },
  pro: { messages: 2300, translations: 1500 },
  premium: { messages: 5e3, translations: 4e3 }
};
var ALLOWED_TONES = /* @__PURE__ */ new Set([
  "Professional",
  "Formal",
  "Friendly",
  "Casual",
  "Confident",
  "Concise",
  "Business Collaboration",
  "Service Provider"
]);
var DEFAULT_TONE = "Professional";
var RULES = "RULES:\n1. Only rewrite the text. Do NOT converse, apologize, or answer questions.\n2. Preserve exact meaning, pronouns (I/you/he/she), and sentence structure.\n3. Keep phrasing natural and direct.\n4. Output ONLY the final text.";
var AUTO_REPLY_RULES = "RULES:\n1. You are writing a reply on behalf of 'Me'.\n2. Write a short, natural reply (1-3 sentences).\n3. Match the tone and formality.\n4. Output ONLY the reply text.";
var worker_default = {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }
    if (request.method !== "POST") {
      return jsonResponse({ error: "Method not allowed" }, 405);
    }
    try {
      const url = new URL(request.url);
      const path = url.pathname;
      switch (path) {
        case "/v1/ai/process":
          return handleAIRequest(request, env, ctx);
        case "/v1/usage":
          return handleUsageCheck(request, env);
        case "/v1/sync":
          return handleManualSync(request, env, ctx);
        default:
          return jsonResponse({ error: "Not found" }, 404);
      }
    } catch (err) {
      console.error("Worker error:", err);
      return jsonResponse({ error: "Internal server error" }, 500);
    }
  }
};
async function handleAIRequest(request, env, ctx) {
  const authHeader = request.headers.get("Authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return jsonResponse({ error: "Missing or invalid authorization" }, 401);
  }
  const token = authHeader.slice(7);
  const user = await verifySupabaseToken(token, env);
  if (!user) {
    return jsonResponse({ error: "Invalid token" }, 401);
  }
  const userId = user.userId;
  const userPlan = user.plan;
  const planLimits = PLAN_LIMITS[userPlan];
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }
  const { mode, text, targetLang, tone, messages, streaming } = body;
  if (!mode) {
    return jsonResponse({ error: "Missing mode parameter" }, 400);
  }
  const usageKey = `usage:${userId}:${getCurrentMonth()}`;
  let userUsage = await env.USER_USAGE.get(usageKey, "json");
  if (!userUsage) {
    userUsage = {
      userId,
      plan: userPlan,
      messagesUsed: 0,
      translationsUsed: 0,
      lastSync: Date.now(),
      syncedCount: 0
    };
  }
  const isTranslation = mode === "translate" || mode === "auto-reply" || mode === "pro-translate";
  const currentCount = isTranslation ? userUsage.translationsUsed : userUsage.messagesUsed;
  const limit = isTranslation ? planLimits.translations : planLimits.messages;
  if (currentCount >= limit) {
    const actionType = isTranslation ? "translations" : "messages";
    return jsonResponse({
      error: `${userPlan} tier limit reached (${limit} ${actionType}/month). Upgrade to continue.`,
      upgradeRequired: true,
      plan: userPlan,
      limit,
      used: currentCount,
      remaining: 0
    }, 403);
  }
  if (isTranslation) {
    userUsage.translationsUsed++;
  } else {
    userUsage.messagesUsed++;
  }
  ctx.waitUntil(env.USER_USAGE.put(usageKey, JSON.stringify(userUsage)));
  const totalUsage = userUsage.messagesUsed + userUsage.translationsUsed;
  const threshold = parseInt(env.BATCH_SYNC_THRESHOLD) || DEFAULT_SYNC_THRESHOLD;
  if (totalUsage % threshold === 0) {
    ctx.waitUntil(batchSyncToSupabase(userId, userUsage, env));
  }
  let systemPrompt;
  let userPrompt;
  if (mode === "auto-reply") {
    if (!Array.isArray(messages) || messages.length === 0) {
      return jsonResponse({ error: "No messages provided for auto-reply" }, 400);
    }
    const conversationBlock = messages.map((m) => `${m.sender}: ${m.text}`).join("\n");
    const toneStr = ALLOWED_TONES.has(tone) ? tone : DEFAULT_TONE;
    systemPrompt = `You are writing a reply in a chat conversation. Reply in a ${toneStr} tone.
${AUTO_REPLY_RULES}`;
    userPrompt = `Conversation:
${conversationBlock}

Write a reply:`;
  } else {
    if (typeof text !== "string") {
      return jsonResponse({ error: "Text must be a string" }, 400);
    }
    const trimmed = text.trim();
    if (trimmed.length < 5) {
      return jsonResponse({ error: "Text too short (min 5 chars)" }, 400);
    }
    if (trimmed.length > 1e3) {
      return jsonResponse({ error: "Text too long (max 1000 chars)" }, 400);
    }
    systemPrompt = buildPrompt(mode, targetLang, tone);
    if (!systemPrompt) {
      return jsonResponse({ error: `Unknown mode: ${mode}` }, 400);
    }
    userPrompt = `Text: ${trimmed}`;
  }
  try {
    const groqResponse = await fetch(env.GROQ_API_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${env.GROQ_API_KEY}`
      },
      body: JSON.stringify({
        model: env.GROQ_MODEL,
        temperature: 0.7,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt }
        ],
        stream: streaming || false
      })
    });
    if (!groqResponse.ok) {
      const errorText = await groqResponse.text();
      console.error("Groq API error:", groqResponse.status, errorText);
      return jsonResponse({ error: "AI service temporarily unavailable" }, 502);
    }
    if (streaming) {
      return new Response(groqResponse.body, {
        status: 200,
        headers: {
          ...corsHeaders,
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache"
        }
      });
    }
    const groqData = await groqResponse.json();
    const result = groqData.choices?.[0]?.message?.content?.trim();
    if (!result) {
      return jsonResponse({ error: "Empty response from AI service" }, 502);
    }
    const totalUsage2 = userUsage.messagesUsed + userUsage.translationsUsed;
    const totalLimit = planLimits.messages + planLimits.translations;
    return jsonResponse({
      result,
      plan: userPlan,
      remaining: totalLimit - totalUsage2
    });
  } catch (err) {
    console.error("Groq API call failed:", err);
    return jsonResponse({ error: "AI service unavailable" }, 503);
  }
}
async function handleUsageCheck(request, env) {
  const authHeader = request.headers.get("Authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return jsonResponse({ error: "Missing authorization" }, 401);
  }
  const token = authHeader.slice(7);
  const user = await verifySupabaseToken(token, env);
  if (!user) {
    return jsonResponse({ error: "Invalid token" }, 401);
  }
  const userId = user.userId;
  const userPlan = user.plan;
  const planLimits = PLAN_LIMITS[userPlan];
  const usageKey = `usage:${userId}:${getCurrentMonth()}`;
  const userUsage = await env.USER_USAGE.get(usageKey, "json");
  if (!userUsage) {
    return jsonResponse({
      plan: userPlan,
      messageLimit: planLimits.messages,
      translationLimit: planLimits.translations,
      messagesUsed: 0,
      translationsUsed: 0,
      messagesRemaining: planLimits.messages,
      translationsRemaining: planLimits.translations
    });
  }
  const limits = PLAN_LIMITS[userUsage.plan];
  return jsonResponse({
    plan: userUsage.plan,
    messageLimit: limits.messages,
    translationLimit: limits.translations,
    messagesUsed: userUsage.messagesUsed,
    translationsUsed: userUsage.translationsUsed,
    messagesRemaining: limits.messages - userUsage.messagesUsed,
    translationsRemaining: limits.translations - userUsage.translationsUsed,
    lastSync: userUsage.lastSync
  });
}
async function handleManualSync(request, env, ctx) {
  const authHeader = request.headers.get("Authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return jsonResponse({ error: "Missing authorization" }, 401);
  }
  const token = authHeader.slice(7);
  const user = await verifySupabaseToken(token, env);
  if (!user) {
    return jsonResponse({ error: "Invalid token" }, 401);
  }
  const userId = user.userId;
  const usageKey = `usage:${userId}:${getCurrentMonth()}`;
  const userUsage = await env.USER_USAGE.get(usageKey, "json");
  if (!userUsage) {
    return jsonResponse({ error: "No usage data found" }, 404);
  }
  ctx.waitUntil(batchSyncToSupabase(userId, userUsage, env));
  return jsonResponse({ success: true, message: "Sync triggered" });
}
async function batchSyncToSupabase(userId, usage, env) {
  try {
    const totalUsage = usage.messagesUsed + usage.translationsUsed;
    const response = await fetch(`${env.SUPABASE_URL}/rest/v1/user%20from%20voca?user_id=eq.${userId}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${env.SUPABASE_ANON_KEY}`,
        "apikey": env.SUPABASE_ANON_KEY,
        "Prefer": "return=minimal"
      },
      body: JSON.stringify({
        usage_count: totalUsage,
        usage_month: getCurrentMonth(),
        usage_synced_at: (/* @__PURE__ */ new Date()).toISOString(),
        updated_at: (/* @__PURE__ */ new Date()).toISOString()
      })
    });
    if (!response.ok) {
      console.error("Supabase sync failed:", response.status, await response.text());
    } else {
      console.log("Supabase sync successful for user:", userId);
      usage.lastSync = Date.now();
      usage.syncedCount = totalUsage;
      await env.USER_USAGE.put(`usage:${userId}:${getCurrentMonth()}`, JSON.stringify(usage));
    }
  } catch (err) {
    console.error("Supabase sync error:", err);
  }
}
function buildPrompt(mode, targetLang, tone) {
  switch (mode) {
    case "grammar":
      return `Fix grammar/spelling only.
${RULES}`;
    case "improve": {
      const validTone = ALLOWED_TONES.has(tone || "") ? tone : DEFAULT_TONE;
      return `Rewrite text to sound ${validTone}.
${RULES}`;
    }
    case "translate":
      if (!targetLang)
        return null;
      return `Translate to ${targetLang}.
${RULES}`;
    case "pro-translate":
      if (!targetLang)
        return null;
      return `Rewrite professionally and translate to ${targetLang}.
${RULES}`;
    default:
      return null;
  }
}
function getCurrentMonth() {
  const now = /* @__PURE__ */ new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}
function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json"
    }
  });
}
async function verifySupabaseToken(token, env) {
  try {
    const res = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
      headers: {
        "Authorization": `Bearer ${token}`,
        "apikey": env.SUPABASE_ANON_KEY
      }
    });
    if (!res.ok) {
      return null;
    }
    const data = await res.json();
    if (!data || !data.id) {
      return null;
    }
    return {
      userId: data.id,
      plan: data.app_metadata?.plan || "free"
    };
  } catch (err) {
    console.error("Supabase token verification failed:", err);
    return null;
  }
}
export {
  worker_default as default
};
