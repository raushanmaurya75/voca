'use strict';

const SUPABASE_URL = 'https://ouwfkmjuckuoiwzwoopd.supabase.co';
const EDGE_FUNCTION_URL = 'https://voca-backend.tivitji.workers.dev/v1/ai/process';
const GROQ_ENDPOINT = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL = 'llama-3.1-8b-instant';
const REQUEST_TIMEOUT_MS = 30000;
const MAX_TEXT_LENGTH = 1000;

const ALLOWED_TONES = new Set([
  'Professional', 'Formal', 'Friendly', 'Casual', 'Confident', 'Concise',
  'Business Collaboration', 'Service Provider'
]);
const DEFAULT_TONE = 'Professional';

const RULES =
  'RULES:\n' +
  '1. Only rewrite the text. Do NOT converse, apologize, or answer questions.\n' +
  '2. Preserve exact meaning, pronouns (I/you/he/she), and sentence structure.\n' +
  '3. Keep phrasing natural and direct.\n' +
  '4. Output ONLY the final text.';

const AUTO_REPLY_RULES =
  'RULES:\n' +
  '1. You are writing a reply on behalf of "Me".\n' +
  '2. Write a short, natural reply (1-3 sentences).\n' +
  '3. Match the tone and formality.\n' +
  '4. Output ONLY the reply text.';

// ─── Prompt Builders ─────────────────────────────────────────────────────
function buildPrompt(mode, targetLang, tone) {
  switch (mode) {
    case 'grammar':
      return `Fix grammar/spelling only.\n${RULES}`;
    case 'improve':
      const validTone = ALLOWED_TONES.has(tone) ? tone : DEFAULT_TONE;
      return `Rewrite text to sound ${validTone}.\n${RULES}`;
    case 'translate':
      if (!targetLang) return null;
      return `Translate to ${targetLang}.\n${RULES}`;
    case 'pro-translate':
      if (!targetLang) return null;
      return `Rewrite professionally and translate to ${targetLang}.\n${RULES}`;
    default:
      return null;
  }
}

function buildAutoReplyPrompt(tone) {
  const toneStr = ALLOWED_TONES.has(tone) ? tone : DEFAULT_TONE;
  return `You are writing a reply in a chat conversation. Reply in a ${toneStr} tone.\n${AUTO_REPLY_RULES}`;
}

// ─── Direct Groq API Call (User's own key) ──────────────────────────────────
async function callGroqDirect(systemPrompt, userText, apiKey) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const res = await fetch(GROQ_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: GROQ_MODEL,
        temperature: 0.7,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `Text: ${userText}` },
        ],
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const errorText = await res.text();
      throw new Error(`Groq API error ${res.status}: ${errorText}`);
    }

    const data = await res.json();
    return data.choices[0].message.content.trim();
  } finally {
    clearTimeout(timer);
  }
}

// ─── Edge Function Call (Fallback with quota) ──────────────────────────────
async function getAuthToken() {
  const { vocaUser } = await chrome.storage.local.get('vocaUser');
  return vocaUser?.access_token || null;
}

async function callEdgeFunction(payload) {
  const token = await getAuthToken();
  if (!token) {
    throw new Error('Not authenticated');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const res = await fetch(EDGE_FUNCTION_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    const data = await res.json();

    if (!res.ok) {
      throw new Error(data.error || `Server error: ${res.status}`);
    }

    return data.result;
  } finally {
    clearTimeout(timer);
  }
}

// ─── Daily Quota Tracking (Local) ───────────────────────────────────────────
const DAILY_QUOTA = 10;
const QUOTA_KEY = 'vocaDailyQuota';

async function checkDailyQuota() {
  const today = new Date().toDateString();
  const { [QUOTA_KEY]: quota } = await chrome.storage.local.get(QUOTA_KEY);

  if (!quota || quota.date !== today) {
    // Reset for new day
    const newQuota = { date: today, count: 0 };
    await chrome.storage.local.set({ [QUOTA_KEY]: newQuota });
    return { allowed: true, remaining: DAILY_QUOTA };
  }

  if (quota.count >= DAILY_QUOTA) {
    return { allowed: false, remaining: 0 };
  }

  return { allowed: true, remaining: DAILY_QUOTA - quota.count };
}

async function incrementDailyQuota() {
  const today = new Date().toDateString();
  const { [QUOTA_KEY]: quota } = await chrome.storage.local.get(QUOTA_KEY);

  if (quota && quota.date === today) {
    quota.count++;
    await chrome.storage.local.set({ [QUOTA_KEY]: quota });
  }
}

// ─── Main AI Handler ───────────────────────────────────────────────────────
async function handleAIRequest(msg, sendResponse) {
  const { mode, text, targetLang, tone, messages } = msg;

  // Check if user has their own API key
  const { groqApiKey } = await chrome.storage.sync.get('groqApiKey');

  if (groqApiKey) {
    // User has their own key - use direct API call (unlimited)
    try {
      let result;

      if (mode === 'auto-reply') {
        if (!Array.isArray(messages) || messages.length === 0) {
          sendResponse({ error: 'No messages provided.' });
          return;
        }
        const conversationBlock = messages.map(m => `${m.sender}: ${m.text}`).join('\n');
        const systemPrompt = buildAutoReplyPrompt(tone || DEFAULT_TONE);
        const userPrompt = `Conversation:\n${conversationBlock}\n\nWrite a reply:`;
        result = await callGroqDirect(systemPrompt, userPrompt, groqApiKey);
      } else {
        const systemPrompt = buildPrompt(mode, targetLang, tone);
        if (!systemPrompt) {
          sendResponse({ error: `Unknown mode: ${mode}` });
          return;
        }
        result = await callGroqDirect(systemPrompt, text, groqApiKey);
      }

      sendResponse({ result });
    } catch (err) {
      console.error('[Voca] Direct API call failed:', err);
      sendResponse({ error: err.message || 'Request failed. Check your API key.' });
    }
  } else {
    // No API key - check daily quota
    const quota = await checkDailyQuota();
    if (!quota.allowed) {
      sendResponse({ error: `Daily limit reached (10/day). Add your own API key for unlimited usage.` });
      return;
    }

    // Use Edge Function with strict rate limits
    try {
      const result = await callEdgeFunction({ mode, text, targetLang, tone, messages });
      await incrementDailyQuota();
      sendResponse({ result, remaining: quota.remaining - 1 });
    } catch (err) {
      console.error('[Voca] Edge function failed:', err);

      if (err.message?.includes('Rate limit exceeded')) {
        sendResponse({ error: 'Server busy. Please try again later or add your own API key.' });
      } else if (err.message?.includes('Not authenticated') || err.message?.includes('token')) {
        sendResponse({ error: 'Please sign in to use AI features.' });
      } else {
        sendResponse({ error: err.message || 'Request failed' });
      }
    }
  }
}

// ─── Message Handlers ─────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'voca:request' || msg.type === 'voca:auto-reply') {
    handleAIRequest(msg, sendResponse);
    return true; // async response
  }

  return false;
});

// ─── Auth Functions ─────────────────────────────────────────────────────────

async function checkAuthStatus() {
  const { vocaUser } = await chrome.storage.local.get('vocaUser');
  if (!vocaUser || !vocaUser.access_token) {
    return { authenticated: false };
  }

  if (vocaUser.expires_at && Date.now() >= vocaUser.expires_at * 1000) {
    await chrome.storage.local.remove('vocaUser');
    return { authenticated: false };
  }

  return { authenticated: true, user: vocaUser };
}

async function openAuthPage() {
  const authUrl = chrome.runtime.getURL('auth.html');
  await chrome.tabs.create({ url: authUrl });
}

// ─── Extension Install/Startup ─────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === 'install') {
    await openAuthPage();
  }
});

// ─── Auth Message Handlers ──────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'voca:check-auth') {
    checkAuthStatus().then(status => {
      sendResponse(status);
    });
    return true;
  }

  if (msg.type === 'voca:open-auth') {
    openAuthPage().then(() => {
      sendResponse({ success: true });
    });
    return true;
  }

  if (msg.type === 'voca:logout') {
    chrome.storage.local.remove('vocaUser').then(() => {
      sendResponse({ success: true });
    });
    return true;
  }
});
