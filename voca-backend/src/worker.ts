// --- Constants & Helpers ---
import { jwtVerify, createRemoteJWKSet } from 'jose';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '86400',
};

let cachedJwks: any = null;

const PLAN_LIMITS: Record<UserPlan, { messages: number }> = {
  free: { messages: 200 },
  pro: { messages: 2200 },
  premium: { messages: 5000 },
  elite: { messages: 10000 },
};

const ALLOWED_TONES = new Set([
  'Professional', 'Formal', 'Friendly', 'Casual', 'Confident', 'Concise', 
  'Business Collaboration', 'Service Provider', 'Sarcastic', 'Enthusiastic', 
  'Persuasive', 'Bold', 'Empathetic', 'Humorous', 'Thoughtful', 'Curious', 'Direct'
]);
const DEFAULT_TONE = 'Professional';

const RULES = "RULES:\n1. Only rewrite the text. Do NOT converse, apologize, or answer questions.\n2. Preserve exact meaning, pronouns (I/you/he/she), and sentence structure.\n3. Keep phrasing natural and direct.\n4. Output ONLY the final text.";
const AUTO_REPLY_RULES = "RULES:\n1. You are writing a reply on behalf of 'Me'.\n2. Write a short, natural reply (1-3 sentences).\n3. Match the tone and formality.\n4. Output ONLY the reply text.";

const jsonResponse = (data: any, status = 200) => {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' }
  });
};

const getCurrentMonth = () => new Date().toISOString().slice(0, 7);

export interface Env {
  DB: D1Database;
  GROQ_API_KEY: string;
  SUPABASE_JWT_SECRET: string;
  SUPABASE_URL: string;
  SUPABASE_ANON_KEY: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  BATCH_SYNC_THRESHOLD: string;
  GROQ_API_ENDPOINT: string;
  GROQ_MODEL: string;
}

type UserPlan = 'free' | 'pro' | 'premium' | 'elite';

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (request.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });
    
    try {
      // Validate Environment
      const requiredVars: (keyof Env)[] = ['DB', 'GROQ_API_KEY', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'];
      for (const v of requiredVars) {
        if (!env[v]) return jsonResponse({ error: `Environment misconfigured: ${v} missing` }, 500);
      }

      const url = new URL(request.url);
      const path = url.pathname;

      if (path === '/v1/ai/process') return await handleAIRequest(request, env, ctx);
      if (path === '/v1/usage') return await handleUsageCheck(request, env);
      if (path === '/v1/sync') return await handleManualSync(request, env, ctx);
      if (path === '/v1/health-check' || path === '/health') return jsonResponse({ status: 'ok', worker: 'voca-backend' });

      return jsonResponse({ error: `Not found: ${path}` }, 404);
    } catch (err: any) {
      console.error('Worker top-level error:', err);
      return new Response(JSON.stringify({ 
        error: 'Internal server error', 
        message: err.message,
        path: new URL(request.url).pathname
      }), { 
        status: 500, 
        headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
      });
    }
  },
};

// --- Handlers ---

async function handleAIRequest(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) return jsonResponse({ error: 'Missing auth header' }, 401);

  const token = authHeader.slice(7);
  const user = await verifySupabaseToken(token, env);
  if (!user || user.error) return jsonResponse({ error: `Invalid token or session expired: ${user?.error || 'Unknown'}` }, 401);

  const { userId, plan } = user;
  const planLimits = PLAN_LIMITS[plan] || PLAN_LIMITS.free;
  const month = getCurrentMonth();

  let body: any;
  try { body = await request.json(); } catch { return jsonResponse({ error: 'Invalid JSON' }, 400); }

  const { mode, text, targetLang, tone, messages, streaming } = body;
  if (!mode) return jsonResponse({ error: 'Missing mode' }, 400);

  const usageField = (mode === 'translate' || mode === 'auto-reply-translate') ? 'translationsUsed' : 'messagesUsed';

  // 1. Fetch current usage and user credits
  let usage: any;
  let userCredits: { balance: number, totalPurchased: number } | null = null;
  
  try {
    const [usageRes, creditsRes] = await Promise.all([
      env.DB.prepare(
        "SELECT messagesUsed, translationsUsed, lastSyncCount, minute_count, last_minute FROM usage_tracking WHERE userId = ? AND month = ?"
      ).bind(userId, month).first(),
      env.DB.prepare(
        "SELECT balance, totalPurchased FROM user_credits WHERE userId = ?"
      ).bind(userId).first<{ balance: number, totalPurchased: number }>()
    ]);
    usage = usageRes;
    userCredits = creditsRes;
  } catch (dbErr: any) {
    console.error('DB Fetch Error:', dbErr);
    return jsonResponse({ error: 'Database service unavailable', details: dbErr.message }, 500);
  }

  // 2. Initialize usage if not exists
  if (!usage) {
    try {
      await env.DB.prepare(
        "INSERT INTO usage_tracking (userId, month, messagesUsed, translationsUsed, minute_count, last_minute) VALUES (?, ?, 0, 0, 0, ?)"
      ).bind(userId, month, Math.floor(Date.now() / 60000)).run();
      usage = { messagesUsed: 0, translationsUsed: 0, lastSyncCount: 0, minute_count: 0, last_minute: Math.floor(Date.now() / 60000) };
    } catch (dbErr: any) {
      console.error('DB Insert Error:', dbErr);
      return jsonResponse({ error: 'Database initialization failure', details: dbErr.message }, 500);
    }
  }

  // 3. Quota Check (with Purchased Balance fallback)
  const currentFreeUsed = (usage.messagesUsed || 0) + (usage.translationsUsed || 0);
  const planLimit = planLimits.messages;
  
  // Credit Cost calculation
  const cost = (mode === 'auto-reply' || mode === 'auto-reply-translate' || mode === 'reply') ? 3 : 1;
  const hasPurchasedBalance = userCredits && userCredits.balance >= cost;

  if (currentFreeUsed >= planLimit && !hasPurchasedBalance) {
    return jsonResponse({
      error: `Monthly Free Credits limit reached (${planLimit}/month). Buy credits to continue.`,
      upgradeRequired: true, plan, limit: planLimit, used: currentFreeUsed,
    }, 403);
  }

  const isUsingPurchased = currentFreeUsed >= planLimit && hasPurchasedBalance;

  // 4. Rate Limiting Check (40 req/min)
  const currentMinute = Math.floor(Date.now() / 60000);
  const isSameMinute = usage.last_minute === currentMinute;
  const effectiveMinuteCount = isSameMinute ? (usage.minute_count || 0) + 1 : 1;
  
  if (isSameMinute && (usage.minute_count || 0) >= 40) {
    return jsonResponse({ error: 'Rate limit exceeded. Please wait a minute.' }, 429);
  }

  // 5. Update usage in D1 (Background)
  ctx.waitUntil((async () => {
    try {
      if (isUsingPurchased) {
        // Deduct from purchased balance
        await env.DB.prepare(`
          UPDATE user_credits 
          SET balance = balance - ?, 
              updated_at = CURRENT_TIMESTAMP 
          WHERE userId = ?
        `).bind(cost, userId).run();
      } else {
        // Increment monthly usage
        await env.DB.prepare(`
          UPDATE usage_tracking 
          SET ${usageField} = ${usageField} + ?, 
              minute_count = ?, 
              last_minute = ?,
              updated_at = CURRENT_TIMESTAMP 
          WHERE userId = ? AND month = ?
        `)
          .bind(cost, effectiveMinuteCount, currentMinute, userId, month)
          .run();
      }
      
      const newTotal = (usage.messagesUsed || 0) + (usage.translationsUsed || 0) + cost;
      const threshold = parseInt(env.BATCH_SYNC_THRESHOLD || "20");
      if (!isUsingPurchased && newTotal - (usage.lastSyncCount || 0) >= threshold) {
        await batchSyncToSupabase(userId, month, newTotal, env);
      }
    } catch (e) {
      console.error('Background usage update failed:', e);
    }
  })());

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
    userPrompt = `Text to process: ${(text || '').trim()}`;
  }

  try {
    const groqResponse = await fetch(env.GROQ_API_ENDPOINT || "https://api.groq.com/openai/v1/chat/completions", {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${env.GROQ_API_KEY}` },
      body: JSON.stringify({
        model: env.GROQ_MODEL || "llama-3.1-8b-instant",
        temperature: 0.6,
        messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
        stream: streaming || false,
      }),
    });

    if (!groqResponse.ok) {
      const errData: any = await groqResponse.json().catch(() => ({}));
      console.error('Groq Error:', errData);
      return jsonResponse({ error: 'AI service error', details: errData.error?.message }, 502);
    }

    if (streaming) return new Response(groqResponse.body, { headers: { ...corsHeaders, 'Content-Type': 'text/event-stream' } });

    const groqData: any = await groqResponse.json();
    const result = groqData.choices?.[0]?.message?.content?.trim();
    if (!result) return jsonResponse({ error: 'Empty AI response' }, 502);

    return jsonResponse({
      result,
      plan,
      cost,
      // Provide detailed quota info at the top level to match /v1/usage
      paid: {
        used: Math.max(0, (userCredits?.totalPurchased || 0) - (userCredits?.balance || 0)) + (isUsingPurchased ? cost : 0),
        total: userCredits?.totalPurchased || 0,
        balance: Math.max(0, (userCredits?.balance || 0) - (isUsingPurchased ? cost : 0))
      },
      free: {
        used: (usage.messagesUsed || 0) + (usage.translationsUsed || 0) + (usageField === 'messagesUsed' || usageField === 'translationsUsed' ? (!isUsingPurchased ? cost : 0) : 0),
        total: planLimits.messages
      },
      isUsingPurchased
    });
  } catch (err: any) {
    console.error('AI Processing Error:', err);
    return jsonResponse({ error: 'AI service connection failed', details: err.message }, 503);
  }
}

async function handleUsageCheck(request: Request, env: Env): Promise<Response> {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader) return jsonResponse({ error: 'Unauthorized' }, 401);
  
  const user = await verifySupabaseToken(authHeader.slice(7), env);
  if (!user) return jsonResponse({ error: 'Invalid token' }, 401);

  const month = getCurrentMonth();
  const limits = PLAN_LIMITS[user.plan] || PLAN_LIMITS.free;

  const [usage, userCredits] = await Promise.all([
    env.DB.prepare(
      "SELECT messagesUsed, translationsUsed FROM usage_tracking WHERE userId = ? AND month = ?"
    ).bind(user.userId, month).first<{ messagesUsed: number; translationsUsed: number }>(),
    env.DB.prepare(
      "SELECT balance, totalPurchased FROM user_credits WHERE userId = ?"
    ).bind(user.userId).first<{ balance: number, totalPurchased: number }>()
  ]);

  const totalPurchased = userCredits?.totalPurchased || 0;
  const currentBalance = userCredits?.balance || 0;
  const purchasedUsed = Math.max(0, totalPurchased - currentBalance);

  // Unified Free Usage: Both messages and translations now count as "credits"
  const freeUsed = (usage?.messagesUsed || 0) + (usage?.translationsUsed || 0);
  const freeLimit = limits.messages;

  return jsonResponse({
    plan: user.plan,
    paid: {
      used: purchasedUsed,
      total: totalPurchased,
      balance: currentBalance
    },
    free: {
      used: freeUsed,
      total: freeLimit
    },
    // Legacy support: 
    messageLimit: freeLimit,
    messagesUsed: freeUsed,
    translationLimit: 0, 
    translationsUsed: 0,
    
    expiresAt: user.expiresAt
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

// --- Internal Logic ---

async function batchSyncToSupabase(userId: string, month: string, totalUsage: number, env: Env): Promise<void> {
  try {
    const response = await fetch(`${env.SUPABASE_URL.replace(/\/$/, '')}/rest/v1/user%20from%20voca`, {
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
      await env.DB.prepare("UPDATE usage_tracking SET lastSyncCount = ? WHERE userId = ? AND month = ?")
        .bind(totalUsage, userId, month)
        .run();
    }
  } catch (err) {
    console.error('Sync failed:', err);
  }
}

async function verifySupabaseToken(token: string, env: Env): Promise<{ userId: string, plan: UserPlan, error?: string } | null> {
  if (!token) return null;
  try {
    if (!cachedJwks) {
      cachedJwks = createRemoteJWKSet(new URL(`${env.SUPABASE_URL.replace(/\/$/, '')}/auth/v1/.well-known/jwks.json`));
    }
    const { payload } = await jwtVerify(token, cachedJwks);
    if (!payload.sub) return { error: 'Payload sub missing' } as any;
    return { userId: payload.sub, plan: (payload.app_metadata as any)?.plan || 'free' };
  } catch (err: any) { 
    console.error('Token verification failed:', err);
    return { error: err.message } as any; 
  }
}

function buildPrompt(mode: string, targetLang?: string, tone?: string): string {
  const SCRIPT_RULE = "Use the proper native script of the target language. NEVER use transliteration.";
  if (mode === 'grammar') return `Fix grammar/spelling only. Return ONLY the fixed text.\n${RULES}`;
  if (mode === 'improve') return `Rewrite text to sound ${tone || DEFAULT_TONE}. Return ONLY the rewritten text.\n${RULES}`;
  if (mode === 'translate') return `Translate to ${targetLang}. ${SCRIPT_RULE} Return ONLY the translation.\n${RULES}`;
  if (mode === 'pro-translate') return `Rewrite professionally and translate to ${targetLang}. ${SCRIPT_RULE} Return ONLY the result.\n${RULES}`;
  if (mode === 'reply') return `Write a short, natural reply (1-3 sentences) in a ${tone || DEFAULT_TONE} tone. Return ONLY the reply text.\n${AUTO_REPLY_RULES}`;
  return "";
}
