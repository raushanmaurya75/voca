'use strict';

// Cloudflare Worker URL
const WORKER_URL = 'https://voca-backend.tivitji.workers.dev';

// DOM Elements
const statusEl    = document.getElementById('status');
const statusText  = document.getElementById('status-text');
const speakingLang = document.getElementById('speaking-lang');
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
    used: (data.messagesUsed || 0), 
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
  
  // Update Paid Credits UI
  if (messagesUsage) {
    const paidBalance = paid.balance ?? 0;
    const paidTotal = paid.total ?? 0;
    if (paidTotal > 0) {
      messagesUsage.textContent = `${paidBalance} / ${paidTotal} left`;
    } else {
      messagesUsage.textContent = `0 / 0 credits`;
    }
  }
  if (messagesBar) {
    const paidUsed = paid.total - paid.balance;
    const msgPercent = paid.total > 0 ? (paidUsed / paid.total) * 100 : 0;
    messagesBar.style.width = `${Math.min(msgPercent, 100)}%`;
    messagesBar.style.background = msgPercent > 90 ? '#ef4444' : 'linear-gradient(90deg, #60a5fa, #3b82f6)';
  }

  // Update Free Credits UI
  if (translationsUsage) {
    const freeRemaining = Math.max(0, free.total - free.used);
    translationsUsage.textContent = `${freeRemaining} / ${free.total} left`;
  }
  if (translationsBar) {
    const transPercent = free.total > 0 ? (free.used / free.total) * 100 : 0;
    translationsBar.style.width = `${Math.min(transPercent, 100)}%`;
    translationsBar.style.background = transPercent > 90 ? '#ef4444' : 'linear-gradient(90deg, #a78bfa, #7c3aed)';
  }

  // Visual cues if exhausted
  if (messagesUsage) messagesUsage.style.color = (paid.total > 0 && paid.used >= paid.total) ? "#ef4444" : "#fff";
  if (translationsUsage) translationsUsage.style.color = (free.total > 0 && free.used >= free.total) ? "#ef4444" : "#fff";

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

chrome.storage.sync.get({ speakingLang: 'English' }, (prefs) => {
  speakingLang.value = prefs.speakingLang;
  setStatus('ready');
});

speakingLang.addEventListener('change', () => {
  chrome.storage.sync.set({ speakingLang: speakingLang.value });
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs[0]?.id) {
      chrome.tabs.sendMessage(tabs[0].id, {
        type: 'voca:setting',
        key:   'speakingLang',
        value: speakingLang.value
      });
    }
  });
});

document.getElementById('btn-upgrade')?.addEventListener('click', async () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('pricing.html') });
});

btnLogout?.addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'voca:logout' });
  window.close();
});
