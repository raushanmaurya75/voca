// Enforce HTTPS for all requests
function enforceHttps(url) {
  if (!url.startsWith('https://')) {
    throw new Error(`Security Error: Insecure URL detected: ${url}`);
  }
  return url;
}

// Cloudflare Worker endpoint
const WORKER_URL = enforceHttps('https://voca-backend.tivitji.workers.dev');
const REQUEST_TIMEOUT_MS = 30000;

// Supabase config
const SUPABASE_URL = enforceHttps('https://ouwfkmjuckuoiwzwoopd.supabase.co');
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im91d2ZrbWp1Y2t1b2l3endvb3BkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU5MzE0MTAsImV4cCI6MjA5MTUwNzQxMH0.n-OPD8fl11kEbl_aD1QLMuvS4WmIHIiPOsk6DKMocsg';

// Get user's Supabase auth token from storage, auto-refresh if needed
async function getAuthToken() {
  let { vocaUser } = await chrome.storage.local.get('vocaUser');
  if (!vocaUser || !vocaUser.access_token) return null;

  // Refresh if within 5 minutes of expiry
  if (vocaUser.expires_at && Date.now() >= (vocaUser.expires_at - 300000)) {
    try {
      const response = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': SUPABASE_ANON_KEY
        },
        body: JSON.stringify({ refresh_token: vocaUser.refresh_token })
      });
      const data = await response.json();
      
      if (!data.error && data.access_token) {
        vocaUser = {
          ...vocaUser,
          access_token: data.access_token,
          refresh_token: data.refresh_token,
          expires_at: Date.now() + (data.expires_in * 1000)
        };
        await chrome.storage.local.set({ vocaUser });
      } else {
        await chrome.storage.local.remove('vocaUser');
        return null;
      }
    } catch (e) {
      console.error('[Voca] Token refresh failed:', e);
      // Don't remove user on network failure, just return null for now
      return null;
    }
  }

  return vocaUser.access_token;
}

// Call Cloudflare Worker (Groq API key is stored server-side in Worker secrets)
async function callVocaAI(payload) {
  const token = await getAuthToken();
  if (!token) {
    throw new Error('Not authenticated');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const res = await fetch(`${WORKER_URL}/v1/ai/process`, {
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
      const error = new Error(data.error || `Server error: ${res.status}`);
      // Attach usage info if available
      if (data.upgrade_required) {
        error.upgradeRequired = true;
        error.limit = data.limit;
        error.plan = data.plan;
        error.tier = data.tier; // Add tier info
      }
      throw error;
    }

    return {
      result: data.result,
      plan: data.plan,
      remaining: data.remaining,
      tier: data.tier, // Add tier info
    };
  } finally {
    clearTimeout(timer);
  }
}

// ─── Message Handlers ─────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  // Handle AI text processing (grammar, improve, translate)
  if (msg.type === 'voca:request') {
    const { mode, text, targetLang, tone } = msg;

    callVocaAI({ mode, text, targetLang, tone })
      .then(data => {
        sendResponse({ 
          result: data.result,
          plan: data.plan,
          remaining: data.remaining,
        });
      })
      .catch(err => {
        const isAuthError = err.message?.includes('Not authenticated') || err.message?.includes('token');
        const isTimeout = err.name === 'AbortError' || err.message?.includes('timed out');
        const isRateLimit = err.message?.includes('Rate limit');
        const isLimitReached = err.upgradeRequired || err.message?.includes('tier limit reached');

        console.error('[Voca] AI request failed:', err);

        if (isLimitReached) {
          sendResponse({ 
            error: err.message || 'Monthly limit reached. Upgrade to continue using AI features.',
            upgradeRequired: true,
            limit: err.limit,
            plan: err.plan,
          });
        } else if (isAuthError) {
          sendResponse({ error: 'Please sign in to use AI features' });
        } else if (isRateLimit) {
          sendResponse({ error: 'Too many requests. Please wait a moment.' });
        } else if (isTimeout) {
          sendResponse({ error: 'Request timed out. Please try again.' });
        } else {
          sendResponse({ error: err.message || 'Request failed' });
        }
      });

    return true; // async response
  }

  // Handle auto-reply
  if (msg.type === 'voca:auto-reply') {
    const { messages, tone } = msg;

    if (!Array.isArray(messages) || messages.length === 0) {
      sendResponse({ error: 'No messages provided.' });
      return false;
    }

    callVocaAI({ mode: 'auto-reply', messages, tone })
      .then(data => {
        sendResponse({ 
          result: data.result,
          plan: data.plan,
          remaining: data.remaining,
        });
      })
      .catch(err => {
        const isLimitReached = err.upgradeRequired || err.message?.includes('tier limit reached');
        console.error('[Voca] Auto-reply failed:', err);
        
        if (isLimitReached) {
          sendResponse({ 
            error: err.message || 'Monthly limit reached. Upgrade to continue.',
            upgradeRequired: true,
            limit: err.limit,
            plan: err.plan,
          });
        } else {
          sendResponse({ error: err.message || 'Auto-reply failed' });
        }
      });

    return true;
  }

  return false;
});

// ─── Auth Functions ─────────────────────────────────────────────────────────

async function checkAuthStatus() {
  const token = await getAuthToken(); // This will auto-refresh if needed
  if (!token) {
    return { authenticated: false };
  }
  const { vocaUser } = await chrome.storage.local.get('vocaUser');
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

  if (msg.type === 'voca:open-upgrade') {
    // Open pricing/upgrade page
    const upgradeUrl = `${SUPABASE_URL}/pricing`; // You'll need to create this page
    chrome.tabs.create({ url: 'https://voca.app/pricing' }).then(() => {
      sendResponse({ success: true });
    });
    return true;
  }

  // Auth handlers for auth.html (avoids CSP issues)
  if (msg.type === 'voca:auth:signin') {
    handleSignIn(msg.data).then(sendResponse);
    return true;
  }

  if (msg.type === 'voca:auth:signup') {
    handleSignUp(msg.data).then(sendResponse);
    return true;
  }

  if (msg.type === 'voca:auth:google') {
    handleGoogleAuth().then(sendResponse);
    return true;
  }

  if (msg.type === 'voca:auth:check') {
    checkAuthStatus().then(sendResponse);
    return true;
  }
});

// ─── Auth Handlers ───────────────────────────────────────────────────────────

async function handleSignIn({ email, password }) {
  try {
    const response = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${SUPABASE_ANON_KEY}`
      },
      body: JSON.stringify({ email, password })
    });

    const data = await response.json();

    if (!response.ok) {
      // Production-ready error messages
      const errorMsg = data.error_description || data.error || 'Sign in failed';
      if (errorMsg === 'Invalid login credentials') {
        return { error: 'Incorrect email or password. Please try again.' };
      }
      return { error: errorMsg };
    }

    // Handle different Supabase response structures (top-level or nested in session)
    const user = data.user || data.session?.user;
    const access_token = data.access_token || data.session?.access_token;
    const refresh_token = data.refresh_token || data.session?.refresh_token;
    const expires_in = data.expires_in || data.session?.expires_in;

    if (user && access_token) {
      // Store user data
      const vocaUser = {
        id: user.id,
        email: user.email,
        access_token: access_token,
        refresh_token: refresh_token,
        expires_at: Date.now() + (expires_in * 1000)
      };
      await chrome.storage.local.set({ vocaUser });

      return { success: true, user: user };
    }

    // If no user/session but no error, it might be a confirmation pending state
    if (user && !access_token) {
      return { error: 'Please confirm your email address before signing in.' };
    }

    return { error: 'Sign in failed: The server response was incomplete. Please check the console for details.' };
  } catch (error) {
    return { error: error.message };
  }
}

async function handleSignUp({ email, password, name }) {
  try {
    const response = await fetch(`${SUPABASE_URL}/auth/v1/signup`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${SUPABASE_ANON_KEY}`
      },
      body: JSON.stringify({ 
        email, 
        password,
        data: { name }
      })
    });

    const data = await response.json();

    if (data.error) {
      return { error: data.error_description || data.error };
    }

    if (data.user) {
      // Store user data
      const vocaUser = {
        id: data.user.id,
        email: data.user.email,
        access_token: data.access_token,
        refresh_token: data.refresh_token,
        expires_at: Date.now() + (data.expires_in * 1000)
      };
      await chrome.storage.local.set({ vocaUser });

      return { success: true, user: data.user };
    }

    return { success: true, message: 'Please check your email to confirm your account' };
  } catch (error) {
    return { error: error.message };
  }
}

async function handleGoogleAuth() {
  try {
    // Open OAuth popup
    const authUrl = `${SUPABASE_URL}/auth/v1/authorize?provider=google&redirect_to=${encodeURIComponent(chrome.runtime.getURL('auth.html'))}`;
    
    return new Promise((resolve) => {
      chrome.windows.create({
        url: authUrl,
        type: 'popup',
        width: 500,
        height: 600
      }, (window) => {
        // Poll for auth completion
        const checkAuth = setInterval(async () => {
          try {
            const { vocaUser } = await chrome.storage.local.get('vocaUser');
            if (vocaUser?.access_token) {
              clearInterval(checkAuth);
              if (window.id) chrome.windows.remove(window.id);
              resolve({ success: true });
            }
          } catch (e) {
            // Ignore errors
          }
        }, 1000);

        // Timeout after 5 minutes
        setTimeout(() => {
          clearInterval(checkAuth);
          if (window.id) chrome.windows.remove(window.id);
          resolve({ error: 'Authentication timeout' });
        }, 300000);
      });
    });
  } catch (error) {
    return { error: error.message };
  }
}

// storeUserInDB removed - Handled securely by Cloudflare Worker UPSERT during sync
