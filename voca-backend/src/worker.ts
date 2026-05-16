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

const PACKS: Record<string, { price: number, credits: number, plan: UserPlan, amount: number }> = {
  'starter': { price: 8, credits: 2200, plan: 'pro', amount: 800 }, // price in USD, amount in cents
  'pro': { price: 12, credits: 5000, plan: 'premium', amount: 1200 },
  'elite': { price: 18, credits: 10000, plan: 'elite', amount: 1800 }
};

const ALLOWED_TONES = new Set([
  'Professional', 'Formal', 'Friendly', 'Casual', 'Confident', 'Concise', 
  'Business Collaboration', 'Service Provider', 'Sarcastic', 'Enthusiastic', 
  'Persuasive', 'Bold', 'Empathetic', 'Humorous', 'Thoughtful', 'Curious', 'Direct'
]);
const DEFAULT_TONE = 'Professional';

const RULES = "RULES:\n1. Only rewrite the text. Do NOT converse, apologize, or answer questions.\n2. Preserve exact meaning, pronouns (I/you/he/she), and sentence structure.\n3. Keep phrasing natural and direct.\n4. Output ONLY the final text.";
const AUTO_REPLY_RULES = "RULES:\n1. You are writing a reply on behalf of 'Me'.\n2. Write a short, natural reply (1-3 sentences).\n3. Match the tone and formality.\n4. Output ONLY the reply text. DO NOT include any introductory text, labels, or explanations like 'Here is a possible reply'. Start immediately with the reply content.";

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
  RAZORPAY_KEY_ID: string;
  RAZORPAY_KEY_SECRET: string;
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
      if (path === '/v1/feedback') return await handleFeedback(request, env);
      if (path === '/v1/payments/create-order') return await handleCreateOrder(request, env);
      if (path === '/v1/payments/verify') return await handleVerifyPayment(request, env);
      if (path === '/v1/checkout') return await handleCheckoutPage(url, env);
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

  const usageField = (mode === 'translate' || mode === 'pro-translate' || mode === 'auto-reply-translate') ? 'translationsUsed' : 'messagesUsed';

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

  if (mode === 'auto-reply' || (mode === 'reply' && messages && messages.length > 0)) {
    const conversationBlock = (messages || []).map((m: any) => `${m.sender}: ${m.text || m.content || ""}`).join('\n');
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

    const totalFreeUsage = (usage.messagesUsed || 0) + (usage.translationsUsed || 0) + (!isUsingPurchased ? cost : 0);
    const baseFreeLimit = 200;
    const planTotalLimit = planLimits.messages;

    return jsonResponse({
      result,
      plan,
      cost,
      paid: {
        used: Math.max(0, (userCredits?.totalPurchased || 0) - (userCredits?.balance || 0)) + (isUsingPurchased ? cost : 0) + Math.max(0, totalFreeUsage - baseFreeLimit),
        total: (userCredits?.totalPurchased || 0) + Math.max(0, planTotalLimit - baseFreeLimit),
        balance: Math.max(0, (userCredits?.balance || 0) - (isUsingPurchased ? cost : 0)) + Math.max(0, planTotalLimit - totalFreeUsage)
      },
      free: {
        used: Math.min(totalFreeUsage, baseFreeLimit),
        total: baseFreeLimit
      },
      // Legacy top-level fields for background.js mapping
      messagesUsed: (usage.messagesUsed || 0) + (usageField === 'messagesUsed' && !isUsingPurchased ? cost : 0),
      translationsUsed: (usage.translationsUsed || 0) + (usageField === 'translationsUsed' && !isUsingPurchased ? cost : 0),
      messageLimit: baseFreeLimit,
      planTotalLimit: planTotalLimit,
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

  // Display Logic: "Free" is capped at 200. "Paid" includes Plan Overflow + Purchased Credits.
  const baseFreeLimit = 200;
  const planTotalLimit = limits.messages;
  
  const totalFreeUsage = (usage?.messagesUsed || 0) + (usage?.translationsUsed || 0);
  
  const displayFreeUsed = Math.min(totalFreeUsage, baseFreeLimit);
  const displayFreeTotal = baseFreeLimit;
  
  const displayPaidUsed = purchasedUsed + Math.max(0, totalFreeUsage - baseFreeLimit);
  const displayPaidTotal = totalPurchased + Math.max(0, planTotalLimit - baseFreeLimit);
  const displayPaidBalance = currentBalance + Math.max(0, planTotalLimit - totalFreeUsage);

  return jsonResponse({
    plan: user.plan,
    paid: {
      used: displayPaidUsed,
      total: displayPaidTotal,
      balance: displayPaidBalance
    },
    free: {
      used: displayFreeUsed,
      total: displayFreeTotal
    },
    // Legacy support
    messageLimit: baseFreeLimit,
    messagesUsed: usage?.messagesUsed || 0,
    translationLimit: 0, 
    translationsUsed: usage?.translationsUsed || 0,
    
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

async function handleFeedback(request: Request, env: Env): Promise<Response> {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) return jsonResponse({ error: 'Missing auth header' }, 401);

  const token = authHeader.slice(7);
  const user = await verifySupabaseToken(token, env);
  if (!user || user.error) return jsonResponse({ error: 'Invalid token' }, 401);

  const { userId } = user;
  
  // 1. Rate Limiting Check (D1)
  const lastSub = await env.DB.prepare(
    "SELECT last_submitted FROM feedback_tracking WHERE userId = ?"
  ).bind(userId).first<{ last_submitted: string }>();

  if (lastSub) {
    const lastDate = new Date(lastSub.last_submitted).getTime();
    const now = Date.now();
    const hoursSince = (now - lastDate) / (1000 * 60 * 60);
    if (hoursSince < 24) {
      return jsonResponse({ 
        error: 'Spam protection: You can only submit feedback once every 24 hours.',
        rateLimited: true 
      }, 429);
    }
  }

  // 2. Parse Body
  let body: any;
  try { body = await request.json(); } catch { return jsonResponse({ error: 'Invalid JSON' }, 400); }
  const { rating, comment, email } = body;

  if (!rating || rating < 1 || rating > 5) return jsonResponse({ error: 'Invalid rating (1-5 required)' }, 400);

  // 3. Store in Supabase
  try {
    const sbRes = await fetch(`${env.SUPABASE_URL.replace(/\/$/, '')}/rest/v1/feedbacks`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        'apikey': env.SUPABASE_SERVICE_ROLE_KEY
      },
      body: JSON.stringify({
        user_id: userId,
        rating,
        comment,
        email: email || null,
        created_at: new Date().toISOString()
      })
    });

    if (!sbRes.ok) {
      const err = await sbRes.text();
      console.error('Supabase Feedback Error:', err);
      return jsonResponse({ error: 'Failed to save feedback' }, 500);
    }

    // 4. Update tracking in D1
    await env.DB.prepare(`
      INSERT INTO feedback_tracking (userId, last_submitted) 
      VALUES (?, CURRENT_TIMESTAMP)
      ON CONFLICT(userId) DO UPDATE SET last_submitted = CURRENT_TIMESTAMP
    `).bind(userId).run();

    return jsonResponse({ success: true, message: 'Thank you for your feedback!' });
  } catch (err: any) {
    console.error('Feedback Error:', err);
    return jsonResponse({ error: 'Feedback service unavailable' }, 500);
  }
}

async function handleCreateOrder(request: Request, env: Env): Promise<Response> {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader) return jsonResponse({ error: 'Unauthorized' }, 401);
  
  const user = await verifySupabaseToken(authHeader.slice(7), env);
  if (!user) return jsonResponse({ error: 'Invalid token' }, 401);

  let body: any;
  try { body = await request.json(); } catch { return jsonResponse({ error: 'Invalid JSON' }, 400); }
  
  const packId = body.plan?.toLowerCase() || body.packId?.toLowerCase();
  const pack = PACKS[packId];
  if (!pack) return jsonResponse({ error: 'Invalid pack selection' }, 400);

  // 1. Create Razorpay Order
  const auth = btoa(`${env.RAZORPAY_KEY_ID}:${env.RAZORPAY_KEY_SECRET}`);
  const rzpRes = await fetch("https://api.razorpay.com/v1/orders", {
    method: "POST",
    headers: {
      "Authorization": `Basic ${auth}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      amount: pack.amount, // in cents/paise
      currency: "USD",
      receipt: `receipt_${Date.now()}`
    })
  });

  const rzpOrder: any = await rzpRes.json();
  if (!rzpRes.ok) {
    console.error('Razorpay Error:', rzpOrder);
    return jsonResponse({ error: 'Failed to create payment order', details: rzpOrder.error?.description }, 500);
  }

  // 2. Store in D1
  try {
    await env.DB.prepare(`
      INSERT INTO payments (id, userId, plan, amount, credits, status)
      VALUES (?, ?, ?, ?, ?, 'created')
    `).bind(rzpOrder.id, user.userId, pack.plan, pack.amount, pack.credits).run();
  } catch (err: any) {
    console.error('D1 Payment Insert Error:', err);
  }

  return jsonResponse({
    orderId: rzpOrder.id,
    amount: pack.amount,
    currency: "USD",
    key: env.RAZORPAY_KEY_ID,
    packId
  });
}

async function handleVerifyPayment(request: Request, env: Env): Promise<Response> {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader) return jsonResponse({ error: 'Unauthorized' }, 401);
  
  const user = await verifySupabaseToken(authHeader.slice(7), env);
  if (!user) return jsonResponse({ error: 'Invalid token' }, 401);

  let body: any;
  try { body = await request.json(); } catch { return jsonResponse({ error: 'Invalid JSON' }, 400); }
  
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = body;
  if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
    return jsonResponse({ error: 'Missing payment verification data' }, 400);
  }

  // 1. Verify Signature
  const isValid = await verifyRzpSignature(razorpay_order_id, razorpay_payment_id, razorpay_signature, env.RAZORPAY_KEY_SECRET);
  if (!isValid) return jsonResponse({ error: 'Invalid payment signature' }, 400);

  // 2. Get Payment Details from D1
  const payment = await env.DB.prepare("SELECT * FROM payments WHERE id = ?").bind(razorpay_order_id).first<any>();
  if (!payment) return jsonResponse({ error: 'Order not found' }, 404);
  if (payment.status === 'paid') return jsonResponse({ success: true, message: 'Payment already processed' });

  // 3. Update Credits & Status (Atomic)
  try {
    await env.DB.batch([
      env.DB.prepare(`
        UPDATE payments 
        SET status = 'paid', razorpay_payment_id = ?, razorpay_signature = ?, updated_at = CURRENT_TIMESTAMP 
        WHERE id = ?
      `).bind(razorpay_payment_id, razorpay_signature, razorpay_order_id),
      env.DB.prepare(`
        INSERT INTO user_credits (userId, balance, totalPurchased) 
        VALUES (?, ?, ?)
        ON CONFLICT(userId) DO UPDATE SET 
          balance = balance + EXCLUDED.balance,
          totalPurchased = totalPurchased + EXCLUDED.totalPurchased,
          updated_at = CURRENT_TIMESTAMP
      `).bind(user.userId, payment.credits, payment.credits)
    ]);

    // 4. Update Plan in Supabase (Async)
    // Only upgrade if the new plan is higher than current
    const planHierarchy = { free: 0, pro: 1, premium: 2, elite: 3 };
    const currentPlanRank = planHierarchy[user.plan] || 0;
    const newPlanRank = planHierarchy[payment.plan as UserPlan] || 0;

    if (newPlanRank > currentPlanRank) {
      // Sync plan upgrade to Supabase auth metadata
      // Note: This requires the GoTrue API or updating the auth.users table via management API
      // Since we are using Supabase Auth, we can use the management API to update app_metadata
      await fetch(`${env.SUPABASE_URL.replace(/\/$/, '')}/auth/v1/admin/users/${user.userId}`, {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
          'apikey': env.SUPABASE_SERVICE_ROLE_KEY,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ app_metadata: { plan: payment.plan } })
      });
    }

    return jsonResponse({ success: true, credits: payment.credits, plan: payment.plan });
  } catch (err: any) {
    console.error('Payment Verification Finalization Error:', err);
    return jsonResponse({ error: 'Payment verified but failed to update credits', details: err.message }, 500);
  }
}

async function verifyRzpSignature(orderId: string, paymentId: string, signature: string, secret: string) {
  const data = orderId + "|" + paymentId;
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signatureBuffer = await crypto.subtle.sign("HMAC", key, encoder.encode(data));
  const expectedSignature = Array.from(new Uint8Array(signatureBuffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
  return expectedSignature === signature;
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

async function handleCheckoutPage(url: URL, env: Env): Promise<Response> {
  const plan = url.searchParams.get('plan') || 'starter';
  const token = url.searchParams.get('token');

  if (!token) {
    return new Response('Missing authentication token. Please open from the Voca extension.', { status: 400 });
  }

  const html = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Secure Checkout - Voca AI</title>
    <script src="https://checkout.razorpay.com/v1/checkout.js"></script>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&display=swap" rel="stylesheet">
    <style>
        body {
            font-family: 'Inter', sans-serif;
            background: #0f172a;
            color: white;
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            height: 100vh;
            margin: 0;
            overflow: hidden;
        }
        .container {
            background: rgba(30, 41, 59, 0.7);
            backdrop-filter: blur(12px);
            padding: 2.5rem;
            border-radius: 24px;
            border: 1px solid rgba(255, 255, 255, 0.1);
            text-align: center;
            max-width: 400px;
            width: 90%;
            box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.5);
        }
        .spinner {
            width: 50px;
            height: 50px;
            border: 4px solid rgba(255, 255, 255, 0.1);
            border-left-color: #3b82f6;
            border-radius: 50%;
            animation: spin 1s linear infinite;
            margin: 0 auto 1.5rem;
        }
        @keyframes spin { to { transform: rotate(360deg); } }
        h1 { font-size: 1.5rem; margin-bottom: 0.5rem; color: #f8fafc; }
        p { color: #94a3b8; line-height: 1.6; }
        .error { color: #ef4444; margin-top: 1rem; display: none; }
        .success { color: #10b981; display: none; }
        .btn {
            margin-top: 1.5rem;
            padding: 0.75rem 1.5rem;
            background: #3b82f6;
            color: white;
            border: none;
            border-radius: 12px;
            font-weight: 600;
            cursor: pointer;
            text-decoration: none;
            display: inline-block;
        }
    </style>
</head>
<body>
    <div class="container" id="main-container">
        <div class="spinner" id="loader"></div>
        <h1 id="title">Processing Payment</h1>
        <p id="status">Connecting to secure gateway...</p>
        <div id="error-msg" class="error"></div>
        <div id="success-msg" class="success">
            <h2>Payment Successful!</h2>
            <p>Your credits have been updated. You can now close this window and return to the extension.</p>
            <button class="btn" onclick="window.close()">Close Window</button>
        </div>
    </div>

    <script>
        const plan = "${plan}";
        const token = "${token}";
        const WORKER_URL = window.location.origin;

        async function initCheckout() {
            try {
                // 1. Create Order
                const res = await fetch(\`\${WORKER_URL}/v1/payments/create-order\`, {
                    method: 'POST',
                    headers: { 
                        'Content-Type': 'application/json',
                        'Authorization': \`Bearer \${token}\`
                    },
                    body: JSON.stringify({ plan })
                });

                const data = await res.json();
                if (!res.ok) throw new Error(data.error || 'Failed to create order');

                // 2. Open Razorpay
                const options = {
                    key: data.key,
                    amount: data.amount,
                    currency: data.currency,
                    name: "Voca AI",
                    description: \`Upgrade to \${plan.toUpperCase()} Plan\`,
                    order_id: data.orderId,
                    handler: async function (response) {
                        document.getElementById('title').innerText = "Verifying Payment";
                        document.getElementById('status').innerText = "Please wait while we confirm your transaction...";
                        document.getElementById('loader').style.display = "block";

                        try {
                            const verifyRes = await fetch(\`\${WORKER_URL}/v1/payments/verify\`, {
                                method: 'POST',
                                headers: { 
                                    'Content-Type': 'application/json',
                                    'Authorization': \`Bearer \${token}\`
                                },
                                body: JSON.stringify(response)
                            });

                            const verifyData = await verifyRes.json();
                            if (!verifyRes.ok) throw new Error(verifyData.error || 'Verification failed');

                            // Success
                            document.getElementById('loader').style.display = "none";
                            document.getElementById('title').style.display = "none";
                            document.getElementById('status').style.display = "none";
                            document.getElementById('success-msg').style.display = "block";
                        } catch (err) {
                            showError(err.message);
                        }
                    },
                    modal: {
                        ondismiss: function() {
                            document.getElementById('status').innerText = "Payment cancelled. You can close this window.";
                            document.getElementById('loader').style.display = "none";
                        }
                    },
                    theme: { color: "#3b82f6" }
                };

                const rzp = new Razorpay(options);
                rzp.on('payment.failed', function (response) {
                    showError(response.error.description);
                });
                rzp.open();
                document.getElementById('loader').style.display = "none";
                document.getElementById('status').innerText = "Please complete the payment in the Razorpay window.";

            } catch (err) {
                showError(err.message);
            }
        }

        function showError(msg) {
            document.getElementById('loader').style.display = "none";
            document.getElementById('title').innerText = "Payment Error";
            document.getElementById('status').style.display = "none";
            const errEl = document.getElementById('error-msg');
            errEl.innerText = msg;
            errEl.style.display = "block";
        }

        initCheckout();
    </script>
</body>
</html>
  `;

  return new Response(html, {
    headers: { 'Content-Type': 'text/html' }
  });
}
