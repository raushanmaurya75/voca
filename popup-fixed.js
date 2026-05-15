'use strict';

// Cloudflare Worker URL (update after deployment)
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
    // Not authenticated - open auth page and close popup
    await chrome.runtime.sendMessage({ type: 'voca:open-auth' });
    window.close();
    return false;
  }
  return true;
}

// Check auth on popup open
checkAuth().then(async (isAuth) => {
  if (isAuth) {
    // Display user email
    const { vocaUser } = await chrome.storage.local.get('vocaUser');
    if (vocaUser?.email) {
      userEmail.textContent = vocaUser.email;
    }
    
    // Show user info and logout button
    userInfo.style.display = 'flex';
    
    // Load subscription info
    await loadSubscriptionInfo();
  } else {
    // Hide user info and show login prompt
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
    // Call Cloudflare Worker to get usage info
    const response = await fetch(
      `${WORKER_URL}/v1/usage`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${vocaUser.access_token}`
        },
        body: JSON.stringify({ p_user_id: vocaUser.id })
      }
    );

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
  // Update plan info based on response from Cloudflare Worker
  const plan = data.plan || 'free';
  const planColors = {
    free: { color: '#9ca3af', text: 'FREE' },
    pro: { color: '#60a5fa', text: 'PRO' },
    premium: { color: '#a78bfa', text: 'PREMIUM' }
  };
  const planInfo = planColors[plan] || planColors.free;
  
  // Update plan badges
  planBadge.textContent = planInfo.text;
  planBadge.style.color = planInfo.color;
  currentPlan.textContent = planInfo.text;
  currentPlan.style.color = planInfo.color;
  
  // Update usage text using the new structured data
  const paid = data.paid || { used: 0, total: 0 };
  const free = data.free || { used: 0, total: 0 };
  
  // Show usage in 'Used / Total' format explicitly
  messagesUsage.textContent = `${paid.used} / ${paid.total}`;
  translationsUsage.textContent = `${free.used} / ${free.total}`;

  // Update progress bars
  const msgPercent = paid.total > 0 ? (paid.used / paid.total) * 100 : 0;
  const transPercent = free.total > 0 ? (free.used / free.total) * 100 : 0;
  messagesBar.style.width = `${Math.min(msgPercent, 100)}%`;
  translationsBar.style.width = `${Math.min(transPercent, 100)}%`;

  // Color bars based on usage
  messagesBar.style.background = msgPercent > 80 ? '#ef4444' : 'linear-gradient(90deg, #60a5fa, #3b82f6)';
  translationsBar.style.background = transPercent > 80 ? '#ef4444' : 'linear-gradient(90deg, #a78bfa, #7c3aed)';
  
  // Calculate days remaining in month
  const now = new Date();
  const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  const daysLeft = Math.ceil((endOfMonth - now) / (1000 * 60 * 60 * 24));
  remainingDays.textContent = `${daysLeft} days left`;
  
  // Show user info
  userInfo.style.display = 'flex';
  
  // Update upgrade button
  const btnUpgrade = document.getElementById('btn-upgrade');
  if (btnUpgrade) {
    btnUpgrade.style.display = plan === 'premium' ? 'none' : 'block';
    btnUpgrade.textContent = 'Buy Credits';
  }
}

// ─── Status display ───────────────────────────────────────────────────
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

// ─── Load saved settings ──────────────────────────────────────────────────────
chrome.storage.sync.get(
  { speakingLang: 'English' },
  (prefs) => {
    speakingLang.value = prefs.speakingLang;
    setStatus('ready'); // AI is always enabled with our backend
  }
);

// ─── Speaking language ────────────────────────────────────────────────────────
speakingLang.addEventListener('change', () => {
  chrome.storage.sync.set({ speakingLang: speakingLang.value });

  // Notify content script
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

// ─── Upgrade Button ───────────────────────────────────────────────────────────
document.getElementById('btn-upgrade')?.addEventListener('click', async () => {
  const plan = currentPlan.textContent;
  if (plan === 'premium') {
    chrome.tabs.create({ url: 'mailto:support@voca.app' });
  } else {
    chrome.tabs.create({ url: 'https://voca.app/pricing' });
  }
});

// ─── Logout ───────────────────────────────────────────────────────────────────
btnLogout?.addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'voca:logout' });
  window.close();
});
