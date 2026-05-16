'use strict';

// Cloudflare Worker URL
const WORKER_URL = 'https://voca-backend.tivitji.workers.dev';

// DOM Elements
const statusEl    = document.getElementById('status');
const statusText  = document.getElementById('status-text');
const planBadge = document.getElementById('plan-badge');
const currentPlan = document.getElementById('current-plan');
const remainingDays = document.getElementById('remaining-days');
const messagesUsage = document.getElementById('messages-usage');
const messagesBar = document.getElementById('messages-bar');
const translationsUsage = document.getElementById('translations-usage');
const translationsBar = document.getElementById('translations-bar');
const userInfo = document.getElementById('user-info');
const userEmail = document.getElementById('user-email');
const btnLogout = document.getElementById('btn-logout');
const btnUpgrade = document.getElementById('btn-upgrade');
const btnFeedback = document.getElementById('btn-feedback');

// ─── Auth Check ─────────────────────────────────────────────────────────────
async function checkAuth() {
  const status = await chrome.runtime.sendMessage({ type: 'voca:check-auth' });
  if (!status.authenticated) {
    await chrome.runtime.sendMessage({ type: 'voca:open-auth' });
    window.close();
    return false;
  }
  return true;
}

// Check auth on popup open
checkAuth().then(async (isAuth) => {
  if (isAuth) {
    const { vocaUser } = await chrome.storage.local.get('vocaUser');
    if (vocaUser?.email) {
      userEmail.textContent = vocaUser.email;
    }
    userInfo.style.display = 'flex';
    await loadSubscriptionInfo();
  } else {
    userInfo.style.display = 'none';
    setStatus('off');
    statusText.textContent = 'Please sign in to use Voca';
  }
});

// ─── Load Subscription Info ───────────────────────────────────────────────────
async function loadSubscriptionInfo() {
  const { vocaUser } = await chrome.storage.local.get('vocaUser');
  if (!vocaUser?.access_token) return;

  try {
    const response = await fetch(`${WORKER_URL}/v1/usage`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${vocaUser.access_token}`
      },
      body: JSON.stringify({ p_user_id: vocaUser.id })
    });

    if (!response.ok) {
      console.error('Failed to load subscription');
      return;
    }

    const data = await response.json();
    displaySubscriptionInfo(data);
  } catch (err) {
    console.error('Error loading subscription:', err);
  }
}

function displaySubscriptionInfo(data) {
  if (!data) {
    console.warn("displaySubscriptionInfo called with no data");
    return;
  }
  console.log("Subscription Data received:", data);

  // Fallback logic for legacy backend responses (supports old and new formats)
  // New format: data.paid: {used, total}, data.free: {used, total}
  // Legacy format: data.messagesUsed, data.messageLimit, etc.
  
  const paid = data.paid || { 
    used: 0, 
    total: 0,
    balance: 0
  };
  
  const free = data.free || { 
    used: (data.messagesUsed || 0) + (data.translationsUsed || 0), 
    total: data.messageLimit || 200 
  };

  const plan = data.plan || 'free';
  const planColors = {
    free: { color: '#9ca3af', text: 'FREE' },
    pro: { color: '#60a5fa', text: 'PRO' },
    premium: { color: '#a78bfa', text: 'PREMIUM' },
    elite: { color: '#f59e0b', text: 'ELITE' }
  };
  const planInfo = planColors[plan] || planColors.free;
  
  if (planBadge) {
    planBadge.textContent = planInfo.text;
    planBadge.style.color = planInfo.color;
  }
  if (currentPlan) {
    currentPlan.textContent = planInfo.text;
    currentPlan.style.color = planInfo.color;
  }
  
  // Logic to separate paid and free credits accurately
  const MAX_FREE_LIMIT = 200;
  
  let fUsed = free.used;
  let fTotal = free.total;
  let pUsed = paid.used;
  let pTotal = paid.total;

  // If worker hasn't split the data or legacy format is detected
  if (!paid.total || fTotal > MAX_FREE_LIMIT) {
    const rawTotalUsed = (data.messagesUsed || 0) + (data.translationsUsed || 0);
    const rawPlanLimit = data.messageLimit || 200;
    const rawPurchasedTotal = data.paid_credits || 0;
    const rawPurchasedUsed = data.paid_credits_used || 0;

    // Cap Free at 200
    fTotal = MAX_FREE_LIMIT;
    fUsed = Math.min(rawTotalUsed, MAX_FREE_LIMIT);

    // Everything else (plan overflow + purchased) goes to Paid
    const planOverflowUsed = Math.max(0, rawTotalUsed - MAX_FREE_LIMIT);
    const planOverflowLimit = Math.max(0, rawPlanLimit - MAX_FREE_LIMIT);

    pUsed = planOverflowUsed + rawPurchasedUsed;
    pTotal = planOverflowLimit + rawPurchasedTotal;
  }

  // Final check: ensure pUsed doesn't exceed pTotal in display if possible
  // but keep actual numbers for transparency

  // Update Paid Credits UI
  if (messagesUsage) {
    messagesUsage.textContent = `${pUsed} / ${pTotal}`;
    if (messagesBar) {
      const msgPercent = pTotal > 0 ? (pUsed / pTotal) * 100 : 0;
      messagesBar.style.width = `${Math.min(msgPercent, 100)}%`;
      messagesBar.style.background = msgPercent > 90 ? '#ef4444' : 'linear-gradient(90deg, #60a5fa, #3b82f6)';
    }
  }

  // Update Free Credits UI
  if (translationsUsage) {
    translationsUsage.textContent = `${fUsed} / ${fTotal}`;
    if (translationsBar) {
      const transPercent = fTotal > 0 ? (fUsed / fTotal) * 100 : 0;
      translationsBar.style.width = `${Math.min(transPercent, 100)}%`;
      translationsBar.style.background = transPercent > 90 ? '#ef4444' : 'linear-gradient(90deg, #9ca3af, #6b7280)';
    }
  }

  // Always show both sections
  const pContainer = document.getElementById('paid-container');
  const fContainer = document.getElementById('free-container');
  if (pContainer) pContainer.style.display = 'block';
  if (fContainer) fContainer.style.display = 'block';
  
  // Remaining time logic
  if (remainingDays) {
    const now = new Date();
    const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0);
    const daysLeft = Math.ceil((endOfMonth - now) / (1000 * 60 * 60 * 24));
    remainingDays.textContent = `${daysLeft} days left`;
  }
  
  const btnUpgrade = document.getElementById('btn-upgrade');
  if (btnUpgrade) {
    btnUpgrade.style.display = plan === 'elite' ? 'none' : 'block';
  }
}

function setStatus(state) {
  statusEl.classList.remove('ready', 'off', 'limited');
  statusEl.classList.add(state);
  const labels = {
    ready:   'AI Ready',
    off:     'AI Off',
    limited: 'Limited (10/day)',
  };
  statusText.textContent = labels[state] ?? 'AI Off';
}

// Remove settings logic - now managed via in-page toolbar
setStatus('ready');

document.getElementById('btn-upgrade')?.addEventListener('click', async () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('pricing.html') });
});

document.getElementById('btn-feedback')?.addEventListener('click', () => {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs[0]?.id) {
      chrome.tabs.sendMessage(tabs[0].id, { type: 'voca:open-feedback' });
      window.close();
    }
  });
});

// Initialize
document.addEventListener('DOMContentLoaded', async () => {
  // Initial load will be triggered by checkAuth() -> loadSubscriptionInfo()
});

// Listen for storage changes to sync credits in real-time
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.vocaUsage) {
    console.log('[Voca] Credits updated in background, refreshing popup UI...');
    const usage = changes.vocaUsage.newValue;
    if (usage) {
      displaySubscriptionInfo(usage);
    } else {
      loadSubscriptionInfo(); 
    }
  }
});

btnLogout?.addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'voca:logout' });
  window.close();
});
