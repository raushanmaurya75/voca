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
  console.log('[Voca] getAuthToken called');
  let { vocaUser } = await chrome.storage.local.get('vocaUser');

  if (!vocaUser) {
    console.warn('[Voca] getAuthToken: No vocaUser found in storage.local');
    return null;
  }
  if (!vocaUser.access_token) {
    console.warn('[Voca] getAuthToken: vocaUser found but access_token is missing. User state:', vocaUser);
    return null;
  }

  const now = Date.now();
  const expiry = vocaUser.expires_at || 0;
  const needsRefresh = now >= (expiry - 300000); // 5 minutes buffer

  console.log('[Voca] Auth state:', {
    email: vocaUser.email,
    hasAccessToken: !!vocaUser.access_token,
    hasRefreshToken: !!vocaUser.refresh_token,
    expiresAt: new Date(expiry).toISOString(),
    now: new Date(now).toISOString(),
    needsRefresh
  });

  if (needsRefresh) {
    if (!vocaUser.refresh_token) {
      console.warn('[Voca] Token expired and no refresh_token available');
      await chrome.storage.local.remove('vocaUser');
      return null;
    }

    console.log('[Voca] Attempting to refresh token...');
    try {
      const response = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': SUPABASE_ANON_KEY
        },
        body: JSON.stringify({ refresh_token: vocaUser.refresh_token })
      });

      const contentType = response.headers.get('content-type') || '';
      let data;
      if (contentType.includes('application/json')) {
        data = await response.json();
      } else {
        const text = await response.text();
        console.error('[Voca] Supabase refresh returned non-JSON:', text.substring(0, 500));
        return null;
      }

      if (response.ok && data.access_token) {
        console.log('[Voca] Token refreshed successfully');
        vocaUser = {
          ...vocaUser,
          access_token: data.access_token,
          refresh_token: data.refresh_token || vocaUser.refresh_token,
          expires_at: Date.now() + ((data.expires_in || 3600) * 1000)
        };
        await chrome.storage.local.set({ vocaUser });
      } else {
        console.error('[Voca] Token refresh failed with error:', data);
        // Only clear user if the refresh token itself is invalid
        if (data.error === 'invalid_grant' || data.message?.includes('refresh_token')) {
          console.warn('[Voca] Refresh token invalid, signing out');
          await chrome.storage.local.remove('vocaUser');
        }
        return null;
      }
    } catch (e) {
      console.error('[Voca] Token refresh network error:', e);
      // Return existing token if not yet fully expired, otherwise null
      if (now < expiry) {
        console.log('[Voca] Using existing token despite refresh failure (not yet fully expired)');
        return vocaUser.access_token;
      }
      return null;
    }
  }

  return vocaUser.access_token;
}

// Call Cloudflare Worker (Groq API key is stored server-side in Worker secrets)
async function callVocaAI(payload) {
  const token = await getAuthToken();
  if (!token) {
    // console.warn('[Voca] callVocaAI: Authentication failed (token is null)');
    throw new Error('Not authenticated');
  }
  console.log('[Voca] callVocaAI: Authenticated successfully, proceeding with request');

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

    const contentType = res.headers.get('content-type') || '';
    let data;

    if (contentType.includes('application/json')) {
      data = await res.json();
    } else {
      const text = await res.text();
      // console.warn(`[Voca] Received non-JSON response from worker (Status: ${res.status}):`, text.substring(0, 500));
      throw new Error(`Worker returned invalid response (Status: ${res.status}). This often means a configuration error or WAF block.`);
    }

    if (!res.ok) {
      const error = new Error(data.error || `Server error: ${res.status}`);
      if (data.upgradeRequired) {
        error.upgradeRequired = true;
        error.limit = data.limit;
        error.plan = data.plan;
      }
      throw error;
    }

    // Store usage in local storage for real-time sync with popup
    await chrome.storage.local.set({
      vocaUsage: {
        ...data, // Include paid, free, plan, and all backend metadata
        lastUpdated: Date.now()
      }
    });

    return {
      result: data.result,
      plan: data.plan,
      messagesUsed: data.messagesUsed,
      translationsUsed: data.translationsUsed,
      messageLimit: data.messageLimit,
      translationLimit: data.translationLimit
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
          messagesUsed: data.messagesUsed,
          translationsUsed: data.translationsUsed,
          messageLimit: data.messageLimit,
          translationLimit: data.translationLimit
        });
      })
      .catch(err => {
        const isAuthError = err.message?.includes('Not authenticated') || err.message?.includes('token');
        const isTimeout = err.name === 'AbortError' || err.message?.includes('timed out');
        const isRateLimit = err.message?.includes('Rate limit');
        const isLimitReached = err.upgradeRequired || err.message?.includes('tier limit reached');

        // Silenced as per user request
        // console.error('[Voca] AI request failed:', err);

        if (isLimitReached) {
          sendResponse({
            error: err.message || 'Monthly limit reached. Buy credits to continue using AI features.',
            upgradeRequired: true,
            limit: err.limit,
            plan: err.plan,
          });
        } else if (isAuthError) {
          console.warn('[Voca] Authentication error detected. Mode:', mode, 'Error:', err.message);
          sendResponse({ error: 'Auth Error: ' + err.message });
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
        sendResponse(data);
      })
      .catch(err => {
        const isLimitReached = err.upgradeRequired || err.message?.includes('tier limit reached');
        const isAuthError = err.message?.includes('Not authenticated') || err.message?.includes('token');
        // Silenced as per user request
        // console.error('[Voca] Auto-reply failed:', err);

        if (isLimitReached) {
          sendResponse({
            error: err.message || 'Monthly limit reached. Buy credits to continue.',
            upgradeRequired: true,
            limit: err.limit,
            plan: err.plan,
          });
        } else if (isAuthError) {
          console.warn('[Voca] Auto-reply auth error');
          sendResponse({ error: 'Please sign in to use AI features' });
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
  if (msg.type === 'voca:open-upgrade' || msg.type === 'voca:open-pricing') {
    const pricingUrl = chrome.runtime.getURL('pricing.html');
    chrome.tabs.create({ url: pricingUrl }).then(() => {
      sendResponse({ success: true });
    });
    return true;
  }

  if (msg.type === 'voca:submit-feedback') {
    (async () => {
      try {
        const token = await getAuthToken();
        if (!token) {
          sendResponse({ error: 'Please log in to submit feedback' });
          return;
        }

        const response = await fetch(`${WORKER_URL}/v1/feedback`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(msg.data)
        });

        const result = await response.json();
        sendResponse(result);
      } catch (err) {
        sendResponse({ error: 'Network error submitting feedback' });
      }
    })();
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

  // Execute script in the MAIN world to bypass CSP & React Synthetic Events (e.g. WhatsApp Lexical)
  if (msg.type === 'voca:execute-main') {
    chrome.scripting.executeScript({
      target: { tabId: sender.tab.id },
      world: 'MAIN',
      func: async (value) => {
        try {
          let el = document.activeElement;
          if (!el || el.getAttribute('contenteditable') !== 'true') {
            el = document.querySelector('div[contenteditable="true"][data-lexical-editor="true"]') || document.querySelector('#main div[contenteditable="true"]');
          }
          if (el) {
            el.focus();

            // 1. Force Selection (Ctrl+A)
            el.dispatchEvent(new KeyboardEvent('keydown', {
              key: 'a', code: 'KeyA', ctrlKey: true, bubbles: true, cancelable: true
            }));
            document.execCommand('selectAll', false, null);

            await new Promise(r => setTimeout(r, 50));

            // 2. Single Delete
            document.execCommand('delete', false, null);

            await new Promise(r => setTimeout(r, 50));

            // 3. Single Insertion
            // Attempt insertText first as it's the cleanest
            document.execCommand('insertText', false, value);

            // Give a tiny moment for the DOM to update
            await new Promise(r => setTimeout(r, 10));

            // 4. Smart Fallback: Only paste if the text isn't there yet
            // This prevents the duplication bug you saw in some Lexical editors
            const currentText = el.innerText || el.textContent || "";
            if (!currentText.includes(value.substring(0, Math.min(value.length, 10)))) {
              const dt = new DataTransfer();
              dt.setData('text/plain', value);
              el.dispatchEvent(new ClipboardEvent('paste', {
                clipboardData: dt,
                bubbles: true,
                cancelable: true
              }));
            }

            // 5. Notify Lexical/React
            el.dispatchEvent(new Event('input', { bubbles: true }));
            return "SUCCESS";
          }
          return "ELEMENT_NOT_FOUND";
        } catch (e) {
          return "ERROR: " + e.toString();
        }
      },
      args: [msg.value]
    }).then((results) => {
      sendResponse({ success: true, result: results[0]?.result });
    }).catch(err => {
      sendResponse({ error: err.message });
    });
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
        expires_at: Date.now() + ((expires_in || 3600) * 1000)
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
        expires_at: Date.now() + ((data.expires_in || 3600) * 1000)
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
// Handle SPA navigation (like LinkedIn/WhatsApp thread switches)
chrome.webNavigation?.onHistoryStateUpdated?.addListener((details) => {
  if (details.tabId) {
    chrome.tabs.sendMessage(details.tabId, {
      type: 'voca:nav',
      url: details.url
    }).catch(() => {
      // Silently ignore errors for inactive/orphaned tabs
    });
  }
});
