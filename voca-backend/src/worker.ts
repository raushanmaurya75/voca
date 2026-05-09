import { jwtVerify, createRemoteJWKSet, JWTPayload } from 'jose';

// Environment interface
export interface Env {
  DB: D1Database;           // Scalable usage storage (D1)
  USER_USAGE: KVNamespace;  // (Optional fallback/legacy)
  GROQ_API_KEY: string;
  SUPABASE_JWT_SECRET: string;
  SUPABASE_URL: string;
  SUPABASE_ANON_KEY: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  BATCH_SYNC_THRESHOLD: string;
  GROQ_API_ENDPOINT: string;
  GROQ_MODEL: string;
}

type UserPlan = 'free' | 'pro' | 'premium';

const PLAN_LIMITS: Record<UserPlan, { messages: number; translations: number }> = {
  free: { messages: 200, translations: 80 },
  pro: { messages: 2300, translations: 1500 },
  premium: { messages: 5000, translations: 4000 },
};

const ALLOWED_TONES = new Set(['Professional', 'Formal', 'Friendly', 'Casual', 'Confident', 'Concise', 'Business Collaboration', 'Service Provider']);
const DEFAULT_TONE = 'Professional';

const RULES = "RULES:\n1. Only rewrite the text. Do NOT converse, apologize, or answer questions.\n2. Preserve exact meaning, pronouns (I/you/he/she), and sentence structure.\n3. Keep phrasing natural and direct.\n4. Output ONLY the final text.";
const AUTO_REPLY_RULES = "RULES:\n1. You are writing a reply on behalf of 'Me'.\n2. Write a short, natural reply (1-3 sentences).\n3. Match the tone and formality.\n4. Output ONLY the reply text.";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (request.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });
    if (request.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405);

    try {
      const url = new URL(request.url);
      const path = url.pathname;

      switch (path) {
        case '/v1/ai/process': return handleAIRequest(request, env, ctx);
        case '/v1/usage': return handleUsageCheck(request, env);
        case '/v1/sync': return handleManualSync(request, env, ctx);
        default: return jsonResponse({ error: 'Not found' }, 404);
      }
    } catch (err) {
      console.error('Worker error:', err);
      return jsonResponse({ error: 'Internal server error' }, 500);
    }
  },
};

// --- Handlers ---

async function handleAIRequest(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) return jsonResponse({ error: 'Missing auth' }, 401);

  const token = authHeader.slice(7);
  const user = await verifySupabaseToken(token, env);
  if (!user) return jsonResponse({ error: 'Invalid token' }, 401);

  const { userId, plan } = user;
  const planLimits = PLAN_LIMITS[plan];
  const month = getCurrentMonth();

  let body: any;
  try { body = await request.json(); } catch { return jsonResponse({ error: 'Invalid JSON' }, 400); }

  const { mode, text, targetLang, tone, messages, streaming } = body;
  if (!mode) return jsonResponse({ error: 'Missing mode' }, 400);

  // Fetch current usage (includes rate limiting info)
  let usage = await env.DB.prepare(
    "SELECT messagesUsed, translationsUsed, lastSyncCount, minute_count, last_minute FROM usage_tracking WHERE userId = ? AND month = ?"
  ).bind(userId, month).first<{ messagesUsed: number; translationsUsed: number; lastSyncCount: number; minute_count: number; last_minute: number }>();

  // 2. Initialize if not exists
  if (!usage) {
    await env.DB.prepare(
      "INSERT INTO usage_tracking (userId, month, messagesUsed, translationsUsed, minute_count, last_minute) VALUES (?, ?, 0, 0, 0, ?)"
    ).bind(userId, month, Math.floor(Date.now() / 60000)).run();
    usage = { messagesUsed: 0, translationsUsed: 0, lastSyncCount: 0, minute_count: 0, last_minute: Math.floor(Date.now() / 60000) };
  }

  // 3. Input Validation (Before heavy processing)
  if (mode === 'auto-reply') {
    if (!Array.isArray(messages) || messages.length === 0) return jsonResponse({ error: 'Messages required for auto-reply' }, 400);
    if (messages.length > 10) return jsonResponse({ error: 'Too many messages provided' }, 400);
    for (const msg of messages) {
      if (typeof msg.text !== 'string' || msg.text.length > 1000) return jsonResponse({ error: 'Message text too long or invalid' }, 400);
      if (typeof msg.sender !== 'string') return jsonResponse({ error: 'Invalid sender format' }, 400);
    }
  } else {
    if (typeof text !== 'string' || (text || '').length > 4000) return jsonResponse({ error: 'Text too long or invalid' }, 400);
  }
  if (tone && !ALLOWED_TONES.has(tone)) return jsonResponse({ error: 'Invalid tone' }, 400);

  // 3. Quota Check
  const isTranslation = mode === 'translate' || mode === 'auto-reply' || mode === 'pro-translate';
  const usageField = isTranslation ? 'translationsUsed' : 'messagesUsed';
  const currentCount = isTranslation ? usage.translationsUsed : usage.messagesUsed;
  const limit = isTranslation ? planLimits.translations : planLimits.messages;

  if (currentCount >= limit) {
    return jsonResponse({
      error: `${plan} limit reached (${limit} ${isTranslation ? 'translations' : 'messages'}/month).`,
      upgradeRequired: true, plan, limit, used: currentCount,
    }, 403);
  }

  // 4. Rate Limiting Check (D1-based, 30 req/min)
  const currentMinute = Math.floor(Date.now() / 60000);
  const isSameMinute = usage.last_minute === currentMinute;
  const effectiveMinuteCount = isSameMinute ? usage.minute_count + 1 : 1;
  
  if (isSameMinute && usage.minute_count >= 30) {
    return jsonResponse({ error: 'Rate limit exceeded. Please wait a minute.' }, 429);
  }

  // 5. Update usage in D1 (Atomic)
  ctx.waitUntil(
    env.DB.prepare(`
      UPDATE usage_tracking 
      SET ${usageField} = ${usageField} + 1, 
          minute_count = ?, 
          last_minute = ?,
          updated_at = CURRENT_TIMESTAMP 
      WHERE userId = ? AND month = ?
    `)
      .bind(effectiveMinuteCount, currentMinute, userId, month)
      .run()
  );


  // 3. Batch sync to Supabase if needed
  const newTotal = usage.messagesUsed + usage.translationsUsed + 1;
  const threshold = parseInt(env.BATCH_SYNC_THRESHOLD) || 20;
  if (newTotal - usage.lastSyncCount >= threshold) {
    ctx.waitUntil(batchSyncToSupabase(userId, month, newTotal, env));
  }

  // --- AI Logic ---
  let systemPrompt: string;
  let userPrompt: string;

  if (mode === 'auto-reply') {
    const conversationBlock = (messages || []).map((m: any) => `${m.sender}: ${m.text}`).join('\n');
    systemPrompt = `You are writing a reply in a ${tone || DEFAULT_TONE} tone.\n${AUTO_REPLY_RULES}`;
    userPrompt = `Conversation:\n${conversationBlock}\n\nWrite a reply:`;
  } else {
    systemPrompt = buildPrompt(mode, targetLang, tone);
    if (!systemPrompt) return jsonResponse({ error: `Unknown mode: ${mode}` }, 400);
    userPrompt = `Text: ${(text || '').trim()}`;
  }

  try {
    const groqResponse = await fetch(env.GROQ_API_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${env.GROQ_API_KEY}` },
      body: JSON.stringify({
        model: env.GROQ_MODEL,
        temperature: 0.7,
        messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
        stream: streaming || false,
      }),
    });

    if (!groqResponse.ok) return jsonResponse({ error: 'AI service error' }, 502);
    if (streaming) return new Response(groqResponse.body, { headers: { ...corsHeaders, 'Content-Type': 'text/event-stream' } });

    const groqData: any = await groqResponse.json();
    const result = groqData.choices?.[0]?.message?.content?.trim();
    if (!result) return jsonResponse({ error: 'Empty AI response' }, 502);

    return jsonResponse({
      result,
      plan,
      remaining: (planLimits.messages + planLimits.translations) - newTotal,
    });
  } catch (err) {
    return jsonResponse({ error: 'AI service unavailable' }, 503);
  }
}

async function handleUsageCheck(request: Request, env: Env): Promise<Response> {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader) return jsonResponse({ error: 'Unauthorized' }, 401);
  
  const user = await verifySupabaseToken(authHeader.slice(7), env);
  if (!user) return jsonResponse({ error: 'Invalid token' }, 401);

  const month = getCurrentMonth();
  const limits = PLAN_LIMITS[user.plan];

  const usage = await env.DB.prepare(
    "SELECT messagesUsed, translationsUsed FROM usage_tracking WHERE userId = ? AND month = ?"
  ).bind(user.userId, month).first<{ messagesUsed: number; translationsUsed: number }>();

  if (!usage) {
    return jsonResponse({
      plan: user.plan,
      messageLimit: limits.messages,
      translationLimit: limits.translations,
      messagesUsed: 0,
      translationsUsed: 0,
      messagesRemaining: limits.messages,
      translationsRemaining: limits.translations,
    });
  }

  return jsonResponse({
    plan: user.plan,
    messageLimit: limits.messages,
    translationLimit: limits.translations,
    messagesUsed: usage.messagesUsed,
    translationsUsed: usage.translationsUsed,
    messagesRemaining: limits.messages - usage.messagesUsed,
    translationsRemaining: limits.translations - usage.translationsUsed,
  });
}

async function handleManualSync(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader) return jsonResponse({ error: 'Unauthorized' }, 401);
  
  const user = await verifySupabaseToken(authHeader.slice(7), env);
  if (!user) return jsonResponse({ error: 'Invalid token' }, 401);

  const usage = await env.DB.prepare(
    "SELECT messagesUsed, translationsUsed FROM usage_tracking WHERE userId = ? AND month = ?"
  ).bind(user.userId, getCurrentMonth()).first<{ messagesUsed: number; translationsUsed: number }>();

  if (!usage) return jsonResponse({ error: 'No usage found' }, 404);

  ctx.waitUntil(batchSyncToSupabase(user.userId, getCurrentMonth(), usage.messagesUsed + usage.translationsUsed, env));
  return jsonResponse({ success: true });
}

// --- Helpers ---

async function batchSyncToSupabase(userId: string, month: string, totalUsage: number, env: Env): Promise<void> {
  try {
    const response = await fetch(`${env.SUPABASE_URL}/rest/v1/user%20from%20voca`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        'apikey': env.SUPABASE_SERVICE_ROLE_KEY,
        'Prefer': 'resolution=merge-duplicates',
      },
      body: JSON.stringify({
        user_id: userId,
        usage_count: totalUsage,
        usage_month: month,
        usage_synced_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }),
    });

    if (response.ok) {
      // Update D1 to record that we've synced up to this count
      await env.DB.prepare("UPDATE usage_tracking SET lastSyncCount = ? WHERE userId = ? AND month = ?")
        .bind(totalUsage, userId, month)
        .run();
    }
  } catch (err) {
    console.error('Sync failed:', err);
  }
}

async function verifySupabaseToken(token: string, env: Env): Promise<{ userId: string, plan: UserPlan } | null> {
  try {
    const jwks = createRemoteJWKSet(new URL(`${env.SUPABASE_URL}/auth/v1/.well-known/jwks.json`));
    const { payload } = await jwtVerify(token, jwks);
    if (!payload.sub) return null;
    return { userId: payload.sub, plan: (payload.app_metadata as any)?.plan || 'free' };
  } catch { return null; }
}

function buildPrompt(mode: string, targetLang?: string, tone?: string): string {
  const SCRIPT_RULE = "Use the proper native script of the target language (e.g., Devanagari for Hindi). NEVER use transliteration or Latin letters for non-Latin target languages.";
  if (mode === 'grammar') return `Fix grammar/spelling only. Return ONLY the fixed text.\n${RULES}`;
  if (mode === 'improve') return `Rewrite text to sound ${tone || DEFAULT_TONE}. Return ONLY the rewritten text.\n${RULES}`;
  if (mode === 'translate') return `Translate to ${targetLang}. ${SCRIPT_RULE} Return ONLY the translation.\n${RULES}`;
  if (mode === 'pro-translate') return `Rewrite professionally and translate to ${targetLang}. ${SCRIPT_RULE} Return ONLY the result.\n${RULES}`;
  return "";
}

const getCurrentMonth = () => new Date().toISOString().slice(0, 7);
const corsHeaders = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization' };
const jsonResponse = (data: any, status = 200) => new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
