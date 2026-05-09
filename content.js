"use strict";

// ─── Constants ────────────────────────────────────────────────────────────────
const MIN_LENGTH = 5;
const MAX_LENGTH = 1000;  // Prevent API spam while allowing longer messages
const DEBOUNCE_MS = 600;
const OFFSET_Y = 8;
const REQUEST_TIMEOUT_MS = 30000;

// Single in-flight request guard — blocks rapid clicks across all modes
let _inflight = false;

// ─── Client-side Cache for Scale ──────────────────────────────────────────────
// LRU Cache: key = "mode:text_hash" -> result (max 50 entries, 5min TTL)
const _cache = new Map();
const CACHE_MAX_SIZE = 50;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// Pending requests deduplication: key -> array of callbacks
const _pendingRequests = new Map();

function getCacheKey(mode, text) {
  // Simple hash for text
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    const char = text.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  return `${mode}:${hash}`;
}

function getCachedResult(key) {
  const entry = _cache.get(key);
  if (!entry) return null;
  
  // Check TTL
  if (Date.now() - entry.time > CACHE_TTL_MS) {
    _cache.delete(key);
    return null;
  }
  
  return entry.result;
}

function setCachedResult(key, result) {
  // LRU: delete oldest if at capacity
  if (_cache.size >= CACHE_MAX_SIZE) {
    const firstKey = _cache.keys().next().value;
    _cache.delete(firstKey);
  }
  
  _cache.set(key, { result, time: Date.now() });
}

// ─── Settings State ───────────────────────────────────────────────────────────
let _aiEnabled = true;
let _speakingLang = "English";
let _lastTone = "Professional";
let _lastLang = "English";

chrome.storage.sync.get(
  {
    aiEnabled: true,
    speakingLang: "English",
    lastTone: "Professional",
    lastLang: "English",
  },
  (prefs) => {
    _aiEnabled = prefs.aiEnabled;
    _speakingLang = prefs.speakingLang;
    _lastTone = prefs.lastTone;
    _lastLang = prefs.lastLang;
    if (typeof updateButtonLabels === "function") updateButtonLabels();
  },
);

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "voca:setting") {
    if (msg.key === "aiEnabled") {
      _aiEnabled = msg.value;
      if (!_aiEnabled) hideBar();
    }
    if (msg.key === "speakingLang") {
      _speakingLang = msg.value;
    }
  }
});

const LANGUAGES = [
  { code: "English", label: "English" },
  { code: "Spanish", label: "Spanish" },
  { code: "French", label: "French" },
  { code: "German", label: "German" },
  { code: "Italian", label: "Italian" },
  { code: "Portuguese", label: "Portuguese" },
  { code: "Hindi", label: "Hindi" },
  { code: "Thai", label: "Thai" },
  { code: "Chinese", label: "Chinese" },
  { code: "Japanese", label: "Japanese" },
  { code: "Korean", label: "Korean" },
  { code: "Arabic", label: "Arabic" },
  { code: "Russian", label: "Russian" },
];

const TONES = [
  { code: "Professional", label: "Professional" },
  { code: "Formal", label: "Formal" },
  { code: "Friendly", label: "Friendly" },
  { code: "Casual", label: "Casual" },
  { code: "Confident", label: "Confident" },
  { code: "Concise", label: "Concise" },
  { code: "Business Collaboration", label: "Business Collab" },
  { code: "Service Provider", label: "Service Provider" },
];

function getSafeLogoUrl() {
  try {
    return chrome.runtime.getURL("logo.png");
  } catch (e) {
    return "";
  }
}

// ─── Element helpers ──────────────────────────────────────────────────────────
function isEditable(el) {
  if (!(el instanceof HTMLElement)) return false;
  if (el.tagName === "TEXTAREA") return true;
  if (el.tagName === "INPUT") {
    const t = (el.getAttribute("type") || "text").toLowerCase();
    return t === "text" || t === "";
  }
  return el.isContentEditable;
}

function getText(el) {
  if (el.tagName === "TEXTAREA" || el.tagName === "INPUT") return el.value;
  return el.innerText ?? el.textContent ?? "";
}

async function applyText(el, newText, isSelection = false) {
  if (!document.body.contains(el)) return;

  if (el.tagName === "TEXTAREA" || el.tagName === "INPUT") {
    // Native setter bypasses React/Vue wrappers
    if (!isSelection) {
      const proto =
        el.tagName === "TEXTAREA"
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
      setter ? setter.call(el, newText) : (el.value = newText);
    } else {
      const start = el.selectionStart;
      const end = el.selectionEnd;
      const val = el.value;
      el.value = val.slice(0, start) + newText + val.slice(end);
    }
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  } else {
    // ─── Robust Text Replacement for WhatsApp / Lexical / Strict Frameworks ───

    el.focus();
    // If the user didn't explicitly highlight text, we must select all text to replace the whole box
    if (!isSelection) {
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(el);
      sel.removeAllRanges();
      sel.addRange(range);

      document.execCommand("selectAll", false, null);

      // CRITICAL YIELD: Strict frameworks (like Lexical on WhatsApp) listen to
      // 'selectionchange' asynchronously.
      await new Promise((r) => setTimeout(r, 50));
    }

    // Attempt native insertion (replaces active selection perfectly in most cases)
    let success = document.execCommand("insertText", false, newText);

    // Fallback Strategy for stubborn frameworks like Lexical
    if (!success) {
      try {
        const dataTransfer = new DataTransfer();
        dataTransfer.setData("text/plain", newText);
        const pasteEvent = new ClipboardEvent("paste", {
          clipboardData: dataTransfer,
          bubbles: true,
          cancelable: true,
        });
        el.dispatchEvent(pasteEvent);
      } catch(e) {
        // Ultimate fallback if ClipboardEvent constructor fails
        const inputEvent = new InputEvent('input', {
          bubbles: true,
          cancelable: true,
          inputType: 'insertText',
          data: newText,
        });
        el.dispatchEvent(inputEvent);
      }
    }

    // Force final UI state updates (crucial for WhatsApp's Send button to become active)
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));

    // Remove selection after insertion so user can type
    const sel = window.getSelection();
    if (sel) {
      sel.collapseToEnd();
    }
    
    // Focus the element back to resume typing
    el.focus();
  }
}

// ─── Floating action bar (Shadow DOM) ────────────────────────────────────────
let _bar = null;

function getBar() {
  if (_bar) return _bar;

  const host = document.createElement("div");
  Object.assign(host.style, {
    position: "fixed",
    top: "0",
    left: "0",
    width: "0",
    height: "0",
    overflow: "visible",
    pointerEvents: "none",
    zIndex: "2147483646",
  });
  const shadow = host.attachShadow({ mode: "closed" });
  shadow.innerHTML = `
    <style>
      .logo-row {
        position: fixed; display: none; align-items: center; gap: 5px;
        padding: 3px; border-radius: 9999px;
        background: rgba(19, 19, 19, 0.85); backdrop-filter: blur(16px); -webkit-backdrop-filter: blur(16px);
        border: 1px solid rgba(255, 255, 255, 0.1);
        box-shadow: inset 0 1px 1px rgba(255, 255, 255, 0.05), 0 4px 16px rgba(0,0,0,.3);
        z-index: 2147483646; pointer-events: auto; transition: all 0.2s;
      }
      .logo-row.visible { display: flex; }

      .logo-icon {
        width: 24px; height: 24px; border-radius: 50%;
        cursor: pointer; padding: 1px; flex-shrink: 0; transition: transform 0.2s;
      }
      .logo-icon img { width: 100%; height: 100%; object-fit: cover; border-radius: 50%; }
      .logo-icon:hover { transform: scale(1.1); }

      .auto-reply-btn {
        display: flex; align-items: center; justify-content: center; gap: 5px;
        height: 28px; padding: 0 12px 0 8px; border-radius: 9999px; border: none;
        background: rgba(0, 122, 255, 0.12); 
        cursor: pointer; pointer-events: auto;
        font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        font-size: 11px; font-weight: 600; color: #60a5fa;
        letter-spacing: -0.01em; transition: all 0.2s; white-space: nowrap; outline: none;
      }
      .auto-reply-btn:hover { background: rgba(0, 122, 255, 0.22); color: #93c5fd; }
      .auto-reply-btn svg { width: 13px; height: 13px; fill: currentColor; flex-shrink: 0; }

      .row-divider {
        width: 1px; height: 20px; background: rgba(255, 255, 255, 0.1); flex-shrink: 0;
      }

      .ar-panel {
        position: fixed; display: none; pointer-events: auto;
        width: 360px; overflow-y: auto;
        background: rgba(19, 19, 19, 0.95); backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px);
        border: 1px solid rgba(255, 255, 255, 0.1);
        box-shadow: 0 8px 32px rgba(0,0,0,.5);
        border-radius: 16px; padding: 16px;
        font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        z-index: 2147483647;
      }
      .ar-panel.visible { display: block; }
      .ar-panel::-webkit-scrollbar { width: 4px; }
      .ar-panel::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.15); border-radius: 4px; }

      .ar-title {
        font-size: 13px; font-weight: 700; color: #fff; margin-bottom: 12px;
        display: flex; align-items: center; gap: 6px;
      }
      .ar-title svg { width: 16px; height: 16px; fill: #60a5fa; }

      .ar-msg-list {
        display: flex; flex-direction: column; gap: 6px; margin-bottom: 14px;
      }
      .ar-msg {
        padding: 8px 10px; border-radius: 10px;
        font-size: 12px; line-height: 1.45; word-break: break-word;
      }
      .ar-msg.them {
        background: rgba(255, 255, 255, 0.06); color: #d4d4d8; border: 1px solid rgba(255,255,255,0.06);
      }
      .ar-msg.me {
        background: rgba(0, 122, 255, 0.1); color: #93c5fd; border: 1px solid rgba(0, 122, 255, 0.15);
      }
      .ar-msg .ar-sender {
        font-size: 10px; font-weight: 700; text-transform: uppercase;
        letter-spacing: 0.05em; margin-bottom: 3px; display: block;
      }
      .ar-msg.them .ar-sender { color: rgba(255,255,255,0.35); }
      .ar-msg.me .ar-sender { color: rgba(0, 122, 255, 0.6); }

      .ar-status {
        display: flex; align-items: center; gap: 8px;
        font-size: 12px; color: #a1a1aa; padding: 8px 0;
      }
      .ar-status .spinner {
        width: 14px; height: 14px; border: 2px solid #60a5fa;
        border-top-color: transparent; border-radius: 50%;
        animation: spin 0.6s linear infinite;
      }

      .ar-result-box {
        background: rgba(0, 122, 255, 0.08); border: 1px solid rgba(0, 122, 255, 0.2);
        border-radius: 10px; padding: 10px 12px;
        font-size: 13px; line-height: 1.5; color: #e4e4e7;
        margin-bottom: 12px; word-break: break-word;
      }

      .ar-actions {
        display: flex; gap: 8px; justify-content: flex-end;
      }
      .ar-btn {
        padding: 7px 18px; border: none; border-radius: 9999px;
        font-size: 12px; font-weight: 600; cursor: pointer;
        transition: all 0.2s; outline: none;
        font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      }
      .ar-btn-cancel {
        background: rgba(255, 255, 255, 0.08); color: #a1a1aa;
      }
      .ar-btn-cancel:hover { background: rgba(255, 255, 255, 0.14); color: #fff; }
      .ar-btn-insert {
        background: linear-gradient(135deg, #007AFF, #005bc1);
        color: #fff; box-shadow: 0 0 12px rgba(0, 122, 255, 0.3);
      }
      .ar-btn-insert:hover { filter: brightness(1.15); transform: scale(1.03); }

      .ar-error {
        font-size: 12px; color: #f87171; padding: 6px 0;
      }

      .ar-no-messages {
        font-size: 12px; color: #a1a1aa; text-align: center; padding: 16px 0;
      }

      .bar-container {
        position: fixed; display: none; flex-direction: column; gap: 8px;
        background: rgba(19, 19, 19, 0.8); backdrop-filter: blur(16px); -webkit-backdrop-filter: blur(16px);
        border: 1px solid rgba(255, 255, 255, 0.1);
        box-shadow: inset 0 1px 1px rgba(255, 255, 255, 0.05), inset 0 0 10px rgba(255, 255, 255, 0.02), 0 8px 32px rgba(0, 0, 0, 0.4);
        padding: 10px 12px; border-radius: 12px;
        font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        pointer-events: auto; z-index: 2147483645;
      }
      .bar-container.visible { display: flex; }

      .bar-header {
        display: flex; justify-content: space-between; align-items: center; width: 100%;
      }
      .bar-hint {
        font-size: 11px; color: #a1a1aa; font-style: italic; opacity: 0.9;
      }
      .btn-settings {
        background: transparent; border: none; font-size: 16px; color: #a1a1aa; cursor: pointer; padding: 0 4px; outline: none; transition: color 0.15s;
      }
      .btn-settings:hover { color: #fff; }

      .bar {
        display: flex; align-items: center; gap: 4px;
      }

      .btn {
        display: flex; align-items: center; justify-content: center; gap: 6px;
        padding: 8px 14px; border: none; font-size: 13px; font-weight: 600;
        cursor: pointer; white-space: nowrap; border-radius: 9999px;
        transition: all 0.2s; background: rgba(255, 255, 255, 0.05); color: #e4e4e7;
        margin: 0; letter-spacing: -0.01em; outline: none;
      }
      .btn:disabled { opacity: 0.45; cursor: not-allowed; }
      .btn:not(:disabled):hover { background: rgba(255, 255, 255, 0.1); color: #fff; box-shadow: 0 0 15px rgba(255, 255, 255, 0.1); transform: scale(1.02); }
      .btn:not(:disabled):active { transform: scale(0.95); }

      .btn-group {
        display: flex; align-items: stretch; border-radius: 9999px;
        background: rgba(255, 255, 255, 0.05); transition: all 0.2s;
      }
      .btn-group:hover { background: rgba(255, 255, 255, 0.1); box-shadow: 0 0 15px rgba(255, 255, 255, 0.1); }
      .btn-group .btn { background: transparent; box-shadow: none; transform: none; border-radius: 0; padding: 8px 12px; }
      .btn-group .btn:not(:disabled):hover { background: rgba(255, 255, 255, 0.05); }
      .btn-group .btn:not(:disabled):active { transform: scale(0.95); }
      .btn-group .main-btn { padding-right: 8px; border-top-left-radius: 9999px; border-bottom-left-radius: 9999px; }
      .btn-group .drop-btn { padding-left: 6px; padding-right: 10px; border-top-right-radius: 9999px; border-bottom-right-radius: 9999px; }
      
      .btn-divider { width: 1px; background: rgba(255, 255, 255, 0.1); margin: 6px 0; }

      .btn-protrans {
        background: rgba(0, 122, 255, 0.15); border: 1px solid rgba(0, 122, 255, 0.3);
        color: #60a5fa; box-shadow: 0 0 15px rgba(0, 122, 255, 0.2);
      }
      .btn-protrans:not(:disabled):hover {
        background: rgba(0, 122, 255, 0.25); color: #93c5fd; box-shadow: 0 0 20px rgba(0, 122, 255, 0.3);
      }

      .spinner {
        display: inline-block; width: 12px; height: 12px;
        border: 2px solid currentColor; border-top-color: transparent;
        border-radius: 50%; opacity: .8;
        animation: spin .6s linear infinite;
        vertical-align: middle; margin-right: 4px;
      }
      @keyframes spin { to { transform: rotate(360deg); } }
      .toast {
        display: none; position: fixed;
        top: 16px; left: 50%; transform: translateX(-50%);
        background: rgba(19, 19, 19, 0.9); backdrop-filter: blur(16px);
        color: #fff; font-size: 13px; font-weight: 500;
        padding: 8px 16px; border-radius: 9999px; border: 1px solid rgba(255, 255, 255, 0.1);
        white-space: nowrap; pointer-events: none;
        box-shadow: 0 4px 16px rgba(0,0,0,.3);
        z-index: 2147483647;
      }
      .toast.visible { display: block; }
      
      .translate-logo-row {
        position: fixed; display: none; align-items: center; justify-content: center;
        width: 28px; height: 28px;
        background: #fff; border-radius: 50%;
        box-shadow: 0 4px 12px rgba(0,0,0,.15);
        pointer-events: auto; z-index: 2147483646; cursor: pointer;
        transition: transform 0.2s;
      }
      .translate-logo-row:hover { transform: scale(1.1); }
      .translate-logo-row.visible { display: flex; }
      .translate-logo-row img { width: 16px; height: 16px; }
    </style>
    <div class="logo-row" id="logo-row">
      <div class="logo-icon" id="logo-btn" title="Voca AI — Open toolbar">
        <img src="${getSafeLogoUrl()}" alt="Voca">
      </div>
    </div>
    <div class="translate-logo-row" id="translate-logo-row" title="Translate Selected Message">
      <img src="${getSafeLogoUrl()}" alt="Translate">
    </div>
    <div class="ar-panel" id="ar-panel"></div>
    <div class="bar-container" id="bar-container">
      <div class="bar-header">
        <span class="bar-hint">Select opposite side messages to translate to your language</span>
        <button class="btn-settings" id="btn-settings" title="Settings">⚙</button>
      </div>
      <div class="bar" id="bar">
        <button class="btn btn-writereply" id="btn-writereply">Write Reply</button>
        <div class="btn-divider"></div>
        <button class="btn btn-grammar" id="btn-grammar">Fix Grammar</button>
        <button class="btn btn-improve" id="btn-improve-main">Improve</button>
        <button class="btn btn-translate" id="btn-translate-main">Translate</button>
      </div>
    </div>
    <div class="toast" id="bar-toast"></div>`;

  document.body.appendChild(host);

  _bar = {
    host,
    shadow,
    logoRow: shadow.getElementById("logo-row"),
    logoBtn: shadow.getElementById("logo-btn"),
    translateLogoRow: shadow.getElementById("translate-logo-row"),
    btnWriteReply: shadow.getElementById("btn-writereply"),
    arPanel: shadow.getElementById("ar-panel"),
    el: shadow.getElementById("bar-container"),
    btnGrammar: shadow.getElementById("btn-grammar"),
    btnImproveMain: shadow.getElementById("btn-improve-main"),
    btnTranslateMain: shadow.getElementById("btn-translate-main"),
    btnSettings: shadow.getElementById("btn-settings"),
    toast: shadow.getElementById("bar-toast"),
    activeEl: null,
  };

  // Prevent input focus loss when clicking anywhere on the bar/logo row
  _bar.el.addEventListener("mousedown", (e) => e.preventDefault());
  _bar.logoRow.addEventListener("mousedown", (e) => e.preventDefault());
  _bar.logoBtn.addEventListener("mousedown", (e) => {
    e.preventDefault();
    e.stopPropagation();
    _barExpanded = true;
    showBar(_bar.activeEl);
  });

  // Write Reply button — scrape messages and show panel
  _bar.btnWriteReply.addEventListener("click", (e) => {
    e.stopPropagation();
    if (_inflight || !_bar.activeEl) return;
    triggerAutoReply(_bar.activeEl);
  });

  // Prevent panel interaction from losing input focus
  _bar.arPanel.addEventListener("mousedown", (e) => e.preventDefault());

  // Check text length before triggering API call
  function checkTextLength(el) {
    const selText = window.getSelection().toString().trim();
    const fullText = getText(el).trim();
    const textToProcess = selText.length > 0 ? selText : fullText;

    if (textToProcess.length < MIN_LENGTH) {
      showBarToast(`Text too short (min ${MIN_LENGTH} chars)`);
      return false;
    }
    if (textToProcess.length > MAX_LENGTH) {
      showBarToast(`Text too long — max ${MAX_LENGTH} chars`);
      return false;
    }
    return true;
  }

  // Button click handlers — all guarded against in-flight requests and text length
  _bar.btnGrammar.addEventListener("click", (e) => {
    e.stopPropagation();
    if (_inflight || !_bar.activeEl) return;
    if (!checkTextLength(_bar.activeEl)) return;
    triggerMode(_bar.activeEl, "grammar");
  });

  _bar.btnImproveMain.addEventListener("click", (e) => {
    e.stopPropagation();
    if (_inflight || !_bar.activeEl) return;
    if (!checkTextLength(_bar.activeEl)) return;
    triggerMode(_bar.activeEl, "improve", "", _lastTone);
  });

  _bar.btnTranslateMain.addEventListener("click", (e) => {
    e.stopPropagation();
    if (_inflight || !_bar.activeEl) return;
    if (!checkTextLength(_bar.activeEl)) return;
    triggerMode(_bar.activeEl, "translate", _lastLang, "");
  });

  _bar.translateLogoRow.addEventListener("mousedown", (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (_inflight) return;
    const selection = window.getSelection().toString().trim();
    if (selection.length < MIN_LENGTH) {
      showBarToast(`Selection too short (min ${MIN_LENGTH} chars)`);
      return;
    }
    if (selection.length > MAX_LENGTH) {
      showBarToast(`Selection too long — max ${MAX_LENGTH} chars`);
      return;
    }
    translateSelectedText(_bar.translateLogoRow);
  });

  _bar.btnSettings.addEventListener("click", (e) => {
    e.stopPropagation();
    showSettingsPanel(_bar.activeEl || _bar.translateLogoRow);
  });

  document.addEventListener("mouseup", (e) => {
    const sel = window.getSelection();
    const text = sel.toString().trim();
    if (!text) {
      _bar.translateLogoRow.classList.remove("visible");
      return;
    }

    if (_bar.host.contains(e.target)) return;

    const range = sel.getRangeAt(0);
    const rect = range.getBoundingClientRect();
    let top = rect.top - 36;
    let left = rect.left + rect.width / 2 - 14;

    if (top < 0) top = rect.bottom + 8;

    _bar.translateLogoRow.style.top = `${top}px`;
    _bar.translateLogoRow.style.left = `${left}px`;
    _bar.translateLogoRow.classList.add("visible");
  });

  document.addEventListener("selectionchange", () => {
    const sel = window.getSelection();
    if (!sel || !sel.toString().trim()) {
      _bar?.translateLogoRow?.classList.remove("visible");
    }
  });

  updateButtonLabels();
  return _bar;
}

function updateButtonLabels() {
  if (!_bar) return;
  if (!_inflight) {
    _bar.btnImproveMain.textContent = `Improve (${_lastTone})`;
    _bar.btnTranslateMain.textContent = `Translate (${_lastLang})`;
  }
}

// ─── Positioning ──────────────────────────────────────────────────────────────
function positionNear(el, width = 0, height = 44) {
  const rect = el.getBoundingClientRect();
  let top = rect.top - height - OFFSET_Y;
  let left = rect.left;
  // If it goes off the top of the screen, place it below instead
  if (top < 8) top = rect.bottom + OFFSET_Y;
  if (left + width > window.innerWidth)
    left = Math.max(8, window.innerWidth - width - 8);
  return { top, left };
}

let _barExpanded = false;

function showBar(el) {
  const b = getBar();
  b.activeEl = el;
  const { top, left } = positionNear(el, 300, 44);

  const text = getDeepestText(el).trim();
  const isEmpty = text.length === 0;

  if (_barExpanded || _inflight) {
    b.el.style.top = `${top}px`;
    b.el.style.left = `${left}px`;
    b.el.classList.add("visible");
    b.logoRow.classList.remove("visible");
  } else {
    b.el.classList.remove("visible");
    b.logoRow.style.top = `${top}px`;
    b.logoRow.style.left = `${left}px`;
    b.logoRow.classList.add("visible");
  }

  if (!_inflight) {
    setBarBusy(false);
    b.btnGrammar.disabled = isEmpty;
    b.btnImproveMain.disabled = isEmpty;
    b.btnTranslateMain.disabled = isEmpty;
    b.btnWriteReply.disabled = false;
  }
}

function hideBar() {
  _barExpanded = false;
  _bar?.el.classList.remove("visible");
  _bar?.logoRow.classList.remove("visible");
  hideSettingsPanel();
}

function setBarBusy(busy, mode) {
  const b = getBar();
  const btns = [
    b.btnGrammar,
    b.btnImproveMain,
    b.btnTranslateMain,
    b.btnWriteReply,
    b.btnSettings,
  ];
  for (const btn of btns) {
    if (btn) btn.disabled = busy;
  }

  if (busy) {
    if (mode === "auto-reply")
      b.btnWriteReply.innerHTML = '<span class="spinner"></span>Working…';
    if (mode === "grammar")
      b.btnGrammar.innerHTML = '<span class="spinner"></span>Working…';
    if (mode === "improve")
      b.btnImproveMain.innerHTML = '<span class="spinner"></span>Working…';
    if (mode === "translate")
      b.btnTranslateMain.innerHTML = '<span class="spinner"></span>Working…';
  } else {
    b.btnWriteReply.textContent = "Write Reply";
    b.btnGrammar.textContent = "Fix Grammar";
    updateButtonLabels();
  }
}

let _toastTimer = null;
function showBarToast(msg, ms = 2500) {
  const b = getBar();
  b.toast.textContent = msg;
  b.toast.classList.add("visible");
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => b.toast.classList.remove("visible"), ms);
}

// ─── Upgrade Prompt ───────────────────────────────────────────────────────────
function showUpgradePrompt(type, response) {
  const plan = response.plan || 'free';
  const limit = response.limit || 0;
  
  // Custom messages based on plan tier
  const messages = {
    free: {
      limit_reached: `You've used all ${limit} messages in your Free plan. Upgrade to any plan to get more messages and continue using AI features.`,
      low_credits: `Only ${response.remaining} messages remaining. Upgrade to any plan to avoid interruption.`,
    },
    pro: {
      limit_reached: `Your Pro plan quota of ${limit.toLocaleString()} messages has been exhausted. Upgrade to any plan to get more messages and continue using AI features.`,
      low_credits: `Only ${response.remaining} messages left in your Pro plan. Upgrade to any plan for more messages.`,
    },
    premium: {
      limit_reached: `You've reached your Premium plan limit of ${limit.toLocaleString()} messages this month. Upgrade to any plan to get more messages and continue using AI features.`,
      low_credits: `Only ${response.remaining} messages remaining in your Premium plan. Upgrade to any plan for more messages.`,
    },
  };
  
  const message = messages[plan]?.[type] || messages.free.limit_reached;
  
  // Create upgrade modal
  const modal = document.createElement('div');
  modal.style.cssText = `
    position: fixed;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    background: rgba(0,0,0,0.7);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 2147483647;
    font-family: system-ui, -apple-system, sans-serif;
  `;
  
  modal.innerHTML = `
    <div style="
      background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
      border: 1px solid rgba(255,255,255,0.1);
      border-radius: 16px;
      padding: 24px;
      max-width: 380px;
      width: 90%;
      color: white;
      text-align: center;
      box-shadow: 0 20px 60px rgba(0,0,0,0.5);
    ">
      <div style="font-size: 48px; margin-bottom: 16px;">⭐</div>
      <h3 style="margin: 0 0 12px 0; font-size: 20px; font-weight: 600;">Upgrade Your Plan</h3>
      <p style="margin: 0 0 20px 0; font-size: 14px; color: #9ca3af; line-height: 1.5;">${message}</p>
      
      <div style="display: grid; gap: 8px; margin-bottom: 16px;">
        <div style="
          background: rgba(255,255,255,0.05);
          border: 1px solid rgba(255,255,255,0.1);
          border-radius: 8px;
          padding: 12px;
          text-align: left;
        ">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px;">
            <span style="font-weight: 600;">Pro Plan</span>
            <span style="color: #60a5fa; font-weight: 600;">$8/month</span>
          </div>
          <div style="font-size: 12px; color: #9ca3af;">2,300 messages + 1,500 translations</div>
        </div>
        
        <div style="
          background: rgba(255,255,255,0.05);
          border: 1px solid rgba(255,255,255,0.1);
          border-radius: 8px;
          padding: 12px;
          text-align: left;
        ">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px;">
            <span style="font-weight: 600;">Premium Plan</span>
            <span style="color: #a78bfa; font-weight: 600;">$12/month</span>
          </div>
          <div style="font-size: 12px; color: #9ca3af;">5,000 messages + 4,000 translations</div>
        </div>
      </div>
      
      <button id="voca-upgrade-btn" style="
        width: 100%;
        padding: 12px;
        background: linear-gradient(90deg, #4f46e5 0%, #7c3aed 100%);
        border: none;
        border-radius: 8px;
        color: white;
        font-weight: 600;
        cursor: pointer;
        margin-bottom: 8px;
        font-size: 14px;
      ">Upgrade Now</button>
      
      <button id="voca-close-btn" style="
        width: 100%;
        padding: 12px;
        background: transparent;
        border: 1px solid rgba(255,255,255,0.2);
        border-radius: 8px;
        color: #9ca3af;
        cursor: pointer;
        font-size: 14px;
      ">Maybe Later</button>
    </div>
  `;
  
  document.body.appendChild(modal);
  
  // Handle button clicks
  modal.querySelector('#voca-upgrade-btn').addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'voca:open-upgrade' });
    modal.remove();
  });
  
  modal.querySelector('#voca-close-btn').addEventListener('click', () => {
    modal.remove();
  });
  
  // Close on backdrop click
  modal.addEventListener('click', (e) => {
    if (e.target === modal) modal.remove();
  });
}

// ─── Unified Settings Panel (Shadow DOM) ──────────────────────────────────────
let _settingsPanel = null;

function getSettingsPanel() {
  if (_settingsPanel) return _settingsPanel;

  const host = document.createElement("div");
  Object.assign(host.style, {
    position: "fixed",
    top: "0",
    left: "0",
    width: "0",
    height: "0",
    overflow: "visible",
    pointerEvents: "none",
    zIndex: "2147483646",
  });

  const shadow = host.attachShadow({ mode: "closed" });
  shadow.innerHTML = `
    <style>
      .picker {
        display: none; position: fixed; pointer-events: auto;
        background: rgba(19, 19, 19, 0.8); backdrop-filter: blur(16px); -webkit-backdrop-filter: blur(16px);
        border: 1px solid rgba(255, 255, 255, 0.1); border-radius: 12px;
        box-shadow: inset 0 1px 1px rgba(255, 255, 255, 0.05), inset 0 0 10px rgba(255, 255, 255, 0.02), 0 8px 32px rgba(0, 0, 0, 0.4);
        padding: 14px;
        font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        min-width: 220px;
        z-index: 2147483648;
      }
      .picker.visible { display: block; }
      .picker-title {
        font-size: 13px; font-weight: 600; color: #fff;
        margin-bottom: 14px; display: flex; align-items: center; justify-content: space-between;
      }
      .field { margin-bottom: 12px; }
      label { display: block; font-size: 12px; color: #a1a1aa; margin-bottom: 6px; }
      select {
        width: 100%; padding: 8px; border: 1px solid rgba(255, 255, 255, 0.1); border-radius: 6px;
        font-size: 13px; color: #fff; background: rgba(255, 255, 255, 0.05);
        outline: none; transition: border 0.2s; cursor: pointer;
      }
      select:focus { border-color: rgba(255, 255, 255, 0.3); }
      select option { background: #1f1f1f; color: #fff; }
      .close-btn {
        margin-top: 4px; width: 100%; padding: 8px; background: rgba(255, 255, 255, 0.1);
        border: none; border-radius: 6px; font-size: 13px; font-weight: 500; cursor: pointer; color: #fff;
        transition: background 0.2s;
      }
      .close-btn:hover { background: rgba(255, 255, 255, 0.15); }
    </style>
    <div class="picker" id="picker">
      <div class="picker-title">Voca Settings</div>
      <div class="field">
        <label>Translation Language (for sending)</label>
        <select id="lang-select"></select>
      </div>
      <div class="field">
        <label>My Speaking Language (for reading)</label>
        <select id="speaking-lang-select"></select>
      </div>
      <div class="field">
        <label>Improvement Tone</label>
        <select id="tone-select"></select>
      </div>
      <button class="close-btn" id="close-btn">Close</button>
    </div>`;

  document.body.appendChild(host);

  const picker = shadow.getElementById("picker");
  const langSelect = shadow.getElementById("lang-select");
  const speakingLangSelect = shadow.getElementById("speaking-lang-select");
  const toneSelect = shadow.getElementById("tone-select");
  const closeBtn = shadow.getElementById("close-btn");

  LANGUAGES.forEach(({ code, label }) => {
    const opt = document.createElement("option");
    opt.value = code;
    opt.textContent = label;
    langSelect.appendChild(opt);
    
    const opt2 = document.createElement("option");
    opt2.value = code;
    opt2.textContent = label;
    speakingLangSelect.appendChild(opt2);
  });
  TONES.forEach(({ code, label }) => {
    const opt = document.createElement("option");
    opt.value = code;
    opt.textContent = label;
    toneSelect.appendChild(opt);
  });

  // Sync state
  langSelect.value = _lastLang;
  speakingLangSelect.value = _speakingLang;
  toneSelect.value = _lastTone;

  langSelect.addEventListener("change", (e) => {
    _lastLang = e.target.value;
    chrome.storage.sync.set({ lastLang: _lastLang });
    updateButtonLabels();
  });

  speakingLangSelect.addEventListener("change", (e) => {
    _speakingLang = e.target.value;
    chrome.storage.sync.set({ speakingLang: _speakingLang });
  });

  toneSelect.addEventListener("change", (e) => {
    _lastTone = e.target.value;
    chrome.storage.sync.set({ lastTone: _lastTone });
    updateButtonLabels();
  });

  picker.addEventListener("mousedown", (e) => {
    // Only prevent default if it's NOT a select element, so dropdowns can open
    if (e.target.tagName !== 'SELECT') {
      e.preventDefault();
    }
  });
  closeBtn.addEventListener("click", () => hideSettingsPanel());

  _settingsPanel = { host, shadow, el: picker };
  return _settingsPanel;
}

function showSettingsPanel(el) {
  const p = getSettingsPanel();
  const { top, left } = positionNear(el, 200, 200);
  p.el.style.top = `${top}px`;
  p.el.style.left = `${left}px`;

  // Sync the selects in case they were updated
  p.shadow.getElementById("lang-select").value = _lastLang;
  p.shadow.getElementById("tone-select").value = _lastTone;

  p.el.classList.add("visible");
}

function hideSettingsPanel() {
  _settingsPanel?.el.classList.remove("visible");
}

// ─── Translate Selected Message Logic ─────────────────────────────────────────
function translateSelectedText(el) {
  const selection = window.getSelection().toString().trim();
  if (!selection) {
    showBarToast("Please select some text to translate first.");
    return;
  }

  // Check cache first
  const cacheKey = getCacheKey(`translate:${_lastLang}`, selection);
  const cachedResult = getCachedResult(cacheKey);
  if (cachedResult) {
    const resText = cleanResult(cachedResult, selection);
    showTranslationPopup(selection, resText, el);
    return;
  }

  setBarBusy(true, "translate");
  _inflight = true;

  const timer = setTimeout(() => {
    _inflight = false;
    setBarBusy(false);
    showBarToast("Translation timed out");
  }, REQUEST_TIMEOUT_MS);

  try {
    // Send directly to groq logic but we just need translation result back. We can reuse triggerMode's background call structure.
    chrome.runtime.sendMessage(
      {
        type: "voca:request",
        mode: "translate",
        text: selection,
        tone: "",
        targetLang: _speakingLang,
        speakingLang: _speakingLang,
      },
      (response) => {
        clearTimeout(timer);
        _inflight = false;
        setBarBusy(false);

        if (chrome.runtime.lastError || !response || response.error) {
          if (response?.upgradeRequired) {
            showUpgradePrompt('limit_reached', response);
          } else {
            showBarToast(response?.error || "Translation failed");
          }
          return;
        }

        // Cache the result
        setCachedResult(cacheKey, response.result);

        const resText = cleanResult(response.result, selection);
        showTranslationPopup(selection, resText, el);
      },
    );
  } catch (err) {
    clearTimeout(timer);
    _inflight = false;
    setBarBusy(false);
    showBarToast("Extension error");
  }
}

function showTranslationPopup(orig, result, el) {
  const p = getPopup();
  p.orig.textContent = orig;
  p.res.textContent = result;

  p.orig.className = "box orig";
  p.res.className = "box result";

  p.improvedLbl.style.display = "none";
  p.improvedBox.style.display = "none";

  // Repurpose popup buttons: Just show Close
  p.btnApply.style.display = "none";
  p.btnCancel.textContent = "Close";

  // Note: We don't overwrite p.btnCancel.onclick permanently to avoid breaking other modes
  const originalCancelHandler = p.btnCancel.onclick;
  p.btnCancel.onclick = () => {
    closePopup();
    // Restore defaults for next time
    p.btnApply.style.display = "inline-block";
    p.btnCancel.textContent = "Cancel";
    p.btnCancel.onclick = originalCancelHandler;
  };

  const { top, left } = positionNear(el, 340, 250);
  p.el.style.top = `${top}px`;
  p.el.style.left = `${left}px`;
  p.el.classList.add("visible");
}

// ─── Result popup (Shadow DOM) ────────────────────────────────────────────────
let _popup = null;

function getPopup() {
  if (_popup) return _popup;

  const host = document.createElement("div");
  Object.assign(host.style, {
    position: "fixed",
    top: "0",
    left: "0",
    width: "0",
    height: "0",
    overflow: "visible",
    pointerEvents: "none",
    zIndex: "2147483647",
  });

  const shadow = host.attachShadow({ mode: "closed" });
  shadow.innerHTML = `
    <style>
      *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
      .popup {
        display: none; position: fixed; pointer-events: auto;
        width: 340px; 
        background: rgba(19, 19, 19, 0.9); backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px);
        border: 1px solid rgba(255, 255, 255, 0.1);
        border-radius: 16px; box-shadow: 0 8px 32px rgba(0,0,0,.5);
        padding: 18px;
        font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      }
      .popup.visible { display: block; }
      .label {
        font-size: 11px; font-weight: 600; color: #a1a1aa;
        text-transform: uppercase; letter-spacing: .5px; margin-bottom: 6px;
      }
      .box {
        font-size: 13px; line-height: 1.55; padding: 10px 12px;
        border-radius: 10px; margin-bottom: 14px;
        max-height: 120px; overflow-y: auto; word-break: break-word;
        user-select: text !important;
        -webkit-user-select: text !important;
        cursor: text;
      }
      .orig   { background: rgba(255, 255, 255, 0.05); color: #a1a1aa; border: 1px solid rgba(255, 255, 255, 0.05); }
      .result { background: rgba(0, 122, 255, 0.1); color: #93c5fd; border: 1px solid rgba(0, 122, 255, 0.15); }
      .improved { background: rgba(0, 122, 255, 0.08); color: #e4e4e7; border: 1px solid rgba(0, 122, 255, 0.1); }
      .actions { display: flex; gap: 10px; justify-content: flex-end; }
      .btn {
        padding: 8px 20px; border: none; border-radius: 9999px;
        font-size: 13px; font-weight: 600; cursor: pointer;
        transition: all 0.2s; outline: none;
      }
      .apply  { 
        background: linear-gradient(135deg, #007AFF, #005bc1); 
        color: #fff; box-shadow: 0 0 12px rgba(0, 122, 255, 0.3);
      }
      .apply:hover  { filter: brightness(1.15); transform: scale(1.03); }
      .cancel { background: rgba(255, 255, 255, 0.08); color: #a1a1aa; }
      .cancel:hover { background: rgba(255, 255, 255, 0.14); color: #fff; }
    </style>
    <div class="popup" id="popup">
      <div class="label">Original</div>
      <div class="box orig"   id="orig"></div>
      
      <div class="label" id="lbl-improved" style="display:none;">Improved</div>
      <div class="box improved" id="improved" style="display:none;"></div>
      
      <div class="label">Result</div>
      <div class="box result" id="res"></div>
      <div class="actions">
        <button class="btn cancel" id="btn-cancel">Cancel</button>
        <button class="btn apply"  id="btn-apply">Apply</button>
      </div>
    </div>`;

  document.body.appendChild(host);

  _popup = {
    host,
    shadow,
    el: shadow.getElementById("popup"),
    orig: shadow.getElementById("orig"),
    improvedLbl: shadow.getElementById("lbl-improved"),
    improvedBox: shadow.getElementById("improved"),
    res: shadow.getElementById("res"),
    btnApply: shadow.getElementById("btn-apply"),
    btnCancel: shadow.getElementById("btn-cancel"),
    targetEl: null,
  };

  _popup.el.addEventListener("mousedown", (e) => {
    // Only prevent default if clicking a button to avoid focus loss
    // DON'T prevent default on the text boxes so they stay selectable
    if (e.target.tagName === 'BUTTON') {
      e.preventDefault();
    }
  });

  _popup.btnCancel.onclick = closePopup;
  return _popup;
}

function showPopup(
  targetEl,
  original,
  result,
  isSelection,
  improvedText = null,
) {
  const p = getPopup();
  p.targetEl = targetEl;
  p.orig.textContent = original;
  p.res.textContent = result;
  
  // Ensure buttons are reset (in case showTranslationPopup hid them)
  p.btnApply.style.display = "inline-block";
  p.btnCancel.style.display = "inline-block";
  p.btnCancel.textContent = "Cancel";
  p.btnCancel.onclick = closePopup;

  if (improvedText) {
    p.improvedLbl.style.display = "block";
    p.improvedBox.style.display = "block";
    p.improvedBox.textContent = improvedText;
  } else {
    p.improvedLbl.style.display = "none";
    p.improvedBox.style.display = "none";
  }

  const rect = targetEl.getBoundingClientRect();
  // Default to above the input element
  let top = rect.top - (improvedText ? 380 : 270) - OFFSET_Y;
  let left = rect.left;
  // If it goes off the top of the screen, place it below instead
  if (top < 8) top = rect.bottom + OFFSET_Y;
  if (left + 340 > window.innerWidth)
    left = Math.max(8, window.innerWidth - 348);
  p.el.style.top = `${top}px`;
  p.el.style.left = `${left}px`;
  p.el.classList.add("visible");

  p.btnApply.onclick = () => {
    applyText(targetEl, result, isSelection);
    closePopup();
    hideBar();
  };
}

function closePopup() {
  _popup?.el.classList.remove("visible");
}

// ─── AI request ───────────────────────────────────────────────────────────────
// AI is only ever invoked from explicit button clicks below — never on typing.
function triggerMode(el, mode, targetLang = "", tone = "") {
  if (_inflight) return; // in-flight guard — blocks multiple rapid clicks

  const selText = window.getSelection().toString().trim();
  const fullText = getText(el).trim();
  const isSelection = selText.length > 0;

  const textToProcess = isSelection ? selText : fullText;

  if (textToProcess.length <= MIN_LENGTH) return;
  if (textToProcess.length > MAX_LENGTH) {
    showBarToast(`Text too long — max ${MAX_LENGTH} chars`);
    return;
  }

  // Check cache first (reduces API calls for repeated text/mode combinations)
  const cacheKey = getCacheKey(mode + (targetLang || '') + (tone || ''), textToProcess);
  const cachedResult = getCachedResult(cacheKey);
  if (cachedResult) {
    // Use cached result instantly
    const clean = cleanResult(cachedResult, textToProcess);
    showPopup(el, textToProcess, clean, isSelection);
    return;
  }

  // Check if same request is already pending (deduplication)
  if (_pendingRequests.has(cacheKey)) {
    // Add callback to pending list
    _pendingRequests.get(cacheKey).push((result) => {
      const clean = cleanResult(result, textToProcess);
      showPopup(el, textToProcess, clean, isSelection);
    });
    return;
  }

  // Mark as pending
  _pendingRequests.set(cacheKey, []);

  _inflight = true;
  hideSettingsPanel();
  showBar(el); // keep bar visible
  setBarBusy(true, mode); // spinner on the active button

  let settled = false;
  const finish = (errMsg) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    _inflight = false;
    setBarBusy(false);
    if (errMsg) {
      showBarToast(String(errMsg));
      // Clean up pending requests on error
      _pendingRequests.delete(cacheKey);
    }
  };

  // Soft timeout — re-enables UI even if the message channel never returns
  const timer = setTimeout(
    () => finish("Request timed out"),
    REQUEST_TIMEOUT_MS,
  );

  try {
    chrome.runtime.sendMessage(
      {
        type: "voca:request",
        mode,
        text: textToProcess,
        targetLang,
        tone,
        speakingLang: _speakingLang,
      },
      (response) => {
        if (chrome.runtime.lastError) {
          finish(chrome.runtime.lastError.message || "Request failed");
          return;
        }
        if (!response) {
          finish("No response");
          return;
        }
        if (response.error) {
          finish();
          // Check if upgrade is required
          if (response.upgradeRequired) {
            showUpgradePrompt(response.remaining === 0 ? 'limit_reached' : 'low_credits', response);
          } else {
            showBarToast(response.error);
          }
          return;
        }
        finish();

        let resultData = response.result;
        resultData = cleanResult(resultData, textToProcess);
        if (!resultData) {
          showBarToast("Empty response");
          return;
        }
        if (resultData === textToProcess) {
          showBarToast("No changes needed");
          return;
        }

        // Cache the successful result
        setCachedResult(cacheKey, response.result);

        // Notify any pending requests with same key (deduplication)
        const pendingCallbacks = _pendingRequests.get(cacheKey);
        if (pendingCallbacks) {
          pendingCallbacks.forEach(cb => cb(response.result));
          _pendingRequests.delete(cacheKey);
        }

        showPopup(el, textToProcess, resultData, isSelection, null);
      },
    );
  } catch (err) {
    if (err.message.includes("Extension context invalidated")) {
      alert(
        "Voca Extension was updated! Please refresh the page to continue using it.",
      );
      finish();
      return;
    }
    finish(err.message || "Extension error");
  }
}

// Strip wrapping quotes / common preambles the model sometimes adds despite instructions
function cleanResult(raw, fallback) {
  let r = String(raw ?? fallback ?? "").trim();
  // Drop a leading "Here is ...:" / "Corrected text:" style preamble on the first line, as well as "Language:" prefixes
  r = r.replace(
    /^(here(?:'s| is)[^:\n]{0,60}:|corrected(?: text)?:|translation:|rewritten(?: text)?:|(?:english|spanish|french|german|deutsch|italian|portuguese|hindi|thai|chinese|japanese|korean|arabic|russian):\s*)\s*/i,
    "",
  );
  // Drop matching wrapping quotes (straight, curly, guillemets, backticks)
  const quotes = [
    '"',
    "'",
    "`",
    "\u201C\u201D",
    "\u2018\u2019",
    "\u00AB\u00BB",
  ];
  for (const pair of quotes) {
    const open = pair[0],
      close = pair[pair.length - 1];
    if (r.length >= 2 && r.startsWith(open) && r.endsWith(close)) {
      r = r.slice(1, -1).trim();
      break;
    }
  }
  return r;
}

// ─── Auto Reply ───────────────────────────────────────────────────────────────

// UI noise filters — must be defined before scrapers use them
const UI_NOISE_EXACT =
  /^(send|reply|forward|delete|edit|edited|react|more|more actions|type a message|write a message|new message|close|minimize|maximize|maximize compose field|minimize compose field|sponsored|sponsored messaging ad|see translation|translated from|emoji|gif|sticker|attach|attachment|photo|video|voice message|audio|call|video call|today|yesterday|online|offline|typing|recording|seen|delivered|read|sent|status is online|status is offline|status is away|active now|active \d+ .* ago|\d{1,2}:\d{2}(\s?(am|pm))?)$/i;
const UI_NOISE_CONTAINS =
  /you are on the messaging overlay|press enter to open the list|compose message you are|messaging you are on|open the list of conversations|start of conversation|end of conversation/i;

function scrapeMessages() {
  const host = location.hostname;

  // ── Platform-specific scrapers ──
  const scrapers = [
    // WhatsApp Web
    () => {
      if (!host.includes("web.whatsapp.com")) return null;
      // WhatsApp wraps each message in elements with these classes
      const msgs = document.querySelectorAll("div.message-in, div.message-out");
      if (!msgs.length) return null;
      const result = [];
      const arr = Array.from(msgs).slice(-7);
      for (const m of arr) {
        const isMe = m.classList.contains("message-out");
        // Try multiple selectors for the text content
        let text = "";
        // Method 1: copyable-text has a data-pre-plain-text attribute
        const copyable = m.querySelector("[data-pre-plain-text]");
        if (copyable) {
          const selectable = copyable.querySelector("span.selectable-text");
          text =
            selectable?.innerText?.trim() || copyable.innerText?.trim() || "";
        }
        // Method 2: direct selectable-text lookup
        if (!text) {
          const selectable = m.querySelector("span.selectable-text");
          text = selectable?.innerText?.trim() || "";
        }
        // Method 3: quoted or plain text span
        if (!text) {
          const plain = m.querySelector(
            'span[dir="ltr"], span[dir="rtl"], span[class]',
          );
          text = plain?.innerText?.trim() || "";
        }
        if (text && text.length > 1) {
          result.push({
            sender: isMe ? "Me" : "Them",
            text: text.slice(0, 500),
          });
        }
      }
      return result.length ? result.slice(-5) : null;
    },

    // LinkedIn Messages
    () => {
      if (!host.includes("linkedin.com")) return null;

      // LinkedIn accessibility / UI noise patterns
      const LI_NOISE =
        /^(maximize compose field|minimize compose field|sponsored messaging ad|close your conversation|new message|send|type a message|write a message|you and .{0,50} are now connected|see translation|translated from|react|reply|forward|delete|more actions|edited|status is|messaging you are on|compose message|you are on the messaging overlay|press enter to)/i;

      const result = [];

      // Strategy 1: Find message bubbles directly
      const bubbles = document.querySelectorAll(
        '.msg-s-event-listitem__message-bubble, [class*="message-bubble"], ' +
          ".msg-s-message-group__bubble",
      );
      if (bubbles.length) {
        const arr = Array.from(bubbles).slice(-7);
        for (const bubble of arr) {
          const paragraphs = bubble.querySelectorAll("p");
          let text = "";
          if (paragraphs.length) {
            text = Array.from(paragraphs)
              .map((p) => p.innerText?.trim() || "")
              .filter(Boolean)
              .join("\n");
          }
          if (!text) text = bubble.innerText?.trim() || "";
          if (!text || text.length < 2 || text.length > 1500) continue;
          if (LI_NOISE.test(text)) continue;

          // Me/Them: check if the bubble's parent event item is from the current user
          const eventItem = bubble.closest('[class*="msg-s-event-listitem"]');
          const isMe = eventItem
            ? eventItem.classList.toString().includes("--current") ||
              eventItem.querySelector(
                '[class*="--current-user"], [class*="current-user"]',
              ) !== null
            : false;

          result.push({
            sender: isMe ? "Me" : "Them",
            text: text.slice(0, 500),
          });
        }
        if (result.length) return result.slice(-5);
      }

      // Strategy 2: Find event list items and extract paragraph text from them
      const events = document.querySelectorAll(
        '.msg-s-event-listitem, [class*="msg-s-event-listitem"]',
      );
      if (events.length) {
        const arr = Array.from(events).slice(-10);
        for (const ev of arr) {
          // Get all paragraphs inside this event
          const paragraphs = ev.querySelectorAll("p");
          if (!paragraphs.length) continue;

          let text = Array.from(paragraphs)
            .map((p) => p.innerText?.trim() || "")
            .filter((t) => t.length > 1 && !LI_NOISE.test(t))
            .join("\n");

          if (!text || text.length < 2 || text.length > 1500) continue;
          if (LI_NOISE.test(text)) continue;
          // Extra: skip text that contains common accessibility phrases
          if (
            /you are on the messaging overlay|press enter to open/i.test(text)
          )
            continue;

          const isMe =
            ev.classList.toString().includes("--current") ||
            ev.querySelector('[class*="--current-user"]') !== null;

          result.push({
            sender: isMe ? "Me" : "Them",
            text: text.slice(0, 500),
          });
        }
        if (result.length) return result.slice(-5);
      }

      return null;
    },

    // Instagram DMs
    () => {
      if (!host.includes("instagram.com")) return null;
      const result = [];

      // Strategy 1: role="row" with text containers inside
      const rows = document.querySelectorAll('[role="row"]');
      if (rows.length) {
        const arr = Array.from(rows).slice(-10);
        for (const row of arr) {
          // Find text spans/divs (Instagram uses div[dir="auto"] for message text)
          const textEls = row.querySelectorAll(
            'div[dir="auto"], span[dir="auto"]',
          );
          let best = "";
          for (const t of textEls) {
            if (t.closest('button, [role="button"], textarea, nav')) continue;
            const txt = t.innerText?.trim() || "";
            if (txt.length > best.length && txt.length < 1500) best = txt;
          }
          if (!best || best.length < 2) continue;
          if (UI_NOISE_EXACT.test(best)) continue;

          // Me/Them detection via CSS alignment
          const sender = detectSenderByAlignment(row) || "Chat";
          result.push({ sender, text: best.slice(0, 500) });
        }
        const deduped = dedupeMessages(result);
        if (deduped.length) return deduped.slice(-5);
      }

      // Strategy 2: Look for message-like containers with dir="auto"
      const textContainers = document.querySelectorAll(
        'div[dir="auto"]:not(textarea):not(input)',
      );
      if (textContainers.length > 2) {
        const candidates = [];
        const seen = new Set();
        const arr = Array.from(textContainers).slice(-15);
        for (const el of arr) {
          if (el.closest('button, [role="button"], nav, header, textarea'))
            continue;
          const text = el.innerText?.trim() || "";
          if (text.length < 2 || text.length > 1500 || seen.has(text)) continue;
          if (UI_NOISE_EXACT.test(text)) continue;
          seen.add(text);
          const sender = detectSenderByAlignment(el) || "Chat";
          candidates.push({ sender, text: text.slice(0, 500) });
        }
        const deduped = dedupeMessages(candidates);
        if (deduped.length >= 2) return deduped.slice(-5);
      }

      return null;
    },

    // Facebook Messenger
    () => {
      if (!host.includes("facebook.com") && !host.includes("messenger.com"))
        return null;
      const rows = document.querySelectorAll('[role="row"]');
      if (!rows.length) return null;
      return extractDeepText(rows);
    },

    // Telegram Web
    () => {
      if (!host.includes("web.telegram.org")) return null;
      // Telegram K and Telegram A use different structures
      const msgs = document.querySelectorAll(
        '.message, .Message, .bubble, [class*="message"][class*="body"]',
      );
      if (!msgs.length) return null;
      return extractDeepText(msgs);
    },

    // Discord
    () => {
      if (!host.includes("discord.com")) return null;
      const msgs = document.querySelectorAll(
        '[id^="chat-messages-"] [class*="messageContent"], ' +
          '[class*="messageContent-"], [role="article"]',
      );
      if (!msgs.length) return null;
      return extractDeepText(msgs);
    },

    // Slack
    () => {
      if (!host.includes("slack.com")) return null;
      const msgs = document.querySelectorAll(
        ".c-message__body, .c-message_kit__text, " +
          '[data-qa="message_content"], .p-rich_text_section',
      );
      if (!msgs.length) return null;
      return extractDeepText(msgs);
    },

    // Twitter / X DMs
    () => {
      if (!host.includes("twitter.com") && !host.includes("x.com")) return null;
      const msgs = document.querySelectorAll(
        '[data-testid="messageEntry"] [data-testid="tweetText"], ' +
          '[data-testid="messageEntry"], [class*="DirectMessage"]',
      );
      if (!msgs.length) return null;
      return extractDeepText(msgs);
    },

    // Microsoft Teams (web)
    () => {
      if (
        !host.includes("teams.microsoft.com") &&
        !host.includes("teams.live.com")
      )
        return null;
      const msgs = document.querySelectorAll(
        '[data-tid="chat-pane-message"], [class*="message-body"], ' +
          '[role="listitem"][class*="message"]',
      );
      if (!msgs.length) return null;
      return extractDeepText(msgs);
    },

    // ── Universal deep fallback ──
    () => {
      // Strategy 1: look for common chat-related selectors
      const selectors = [
        "[data-message-id]",
        "[data-msg-id]",
        '[data-testid*="message"]',
        '[role="row"]',
        '[role="article"]',
        '[role="listitem"]',
        '[class*="message"][class*="body"]',
        '[class*="message"][class*="content"]',
        '[class*="bubble"]',
        '[class*="Bubble"]',
        '[class*="chat-msg"]',
        '[class*="msg-body"]',
      ];
      for (const sel of selectors) {
        try {
          const els = document.querySelectorAll(sel);
          if (els.length >= 2) {
            const result = extractDeepText(els);
            if (result && result.length >= 2) return result;
          }
        } catch (_) {}
      }

      // Strategy 2: find the nearest scrollable ancestor of the active input
      // and grab leaf-level text blocks from it
      const activeEl = _bar?.activeEl;
      if (activeEl) {
        const scrollParent = findScrollParent(activeEl);
        if (scrollParent) {
          const result = extractFromScrollContainer(scrollParent);
          if (result && result.length >= 1) return result;
        }
      }

      // Strategy 3: broader class-based search (less specific)
      const broadSelectors = [
        '[class*="message"]',
        '[class*="Message"]',
        '[class*="comment"]',
        '[class*="Comment"]',
      ];
      for (const sel of broadSelectors) {
        try {
          const els = document.querySelectorAll(sel);
          if (els.length >= 2) {
            const result = extractDeepText(els);
            if (result && result.length >= 1) return result;
          }
        } catch (_) {}
      }

      return null;
    },
  ];

  for (const scraper of scrapers) {
    try {
      const result = scraper();
      if (result && result.length > 0) return result.slice(-5);
    } catch (_) {
      /* skip broken scraper */
    }
  }

  return [];
}

// Extract the deepest meaningful text from a list of message container elements
function extractDeepText(nodes) {
  const result = [];
  const seen = new Set();
  const arr = Array.from(nodes).slice(-10);

  for (const el of arr) {
    const text = getDeepestText(el);
    if (!text || text.length < 2 || text.length > 1500) continue;
    if (seen.has(text)) continue;
    seen.add(text);
    const sender = detectSenderByAlignment(el) || "Chat";
    result.push({ sender, text: text.slice(0, 500) });
  }
  return dedupeMessages(result).slice(-5);
}

// Detect if a message is from "Me" or "Them" based on DOM hints and CSS alignment
function detectSenderByAlignment(el) {
  // Check class names for common patterns
  const cls =
    (el.className || "") + " " + (el.closest("[class]")?.className || "");
  // Outgoing / self / me patterns
  if (
    /\b(message-out|msg-out|outgoing|is-mine|self|from-me|sent|current-user|--current)\b/i.test(
      cls,
    )
  )
    return "Me";
  // Incoming / other / them patterns
  if (
    /\b(message-in|msg-in|incoming|is-other|from-them|received|other-user|--other)\b/i.test(
      cls,
    )
  )
    return "Them";

  // Check data attributes
  const dataDir =
    el.getAttribute("data-message-direction") ||
    el
      .closest("[data-message-direction]")
      ?.getAttribute("data-message-direction") ||
    "";
  if (dataDir === "outgoing" || dataDir === "sent") return "Me";
  if (dataDir === "incoming" || dataDir === "received") return "Them";

  // CSS alignment heuristic: right-aligned = Me, left-aligned = Them
  try {
    const target =
      el.closest('[class*="message"], [class*="bubble"], [role="row"]') || el;
    const style = getComputedStyle(target);
    if (
      style.marginLeft === "auto" ||
      style.alignSelf === "flex-end" ||
      style.float === "right"
    )
      return "Me";
    if (
      style.marginRight === "auto" ||
      style.alignSelf === "flex-start" ||
      style.float === "left"
    )
      return "Them";
    // Check justify-content of parent
    const parent = target.parentElement;
    if (parent) {
      const pStyle = getComputedStyle(parent);
      if (pStyle.justifyContent === "flex-end") return "Me";
      if (pStyle.justifyContent === "flex-start") return "Them";
    }
  } catch (_) {}

  return null; // can't determine
}

// Get the most meaningful text from a message element
// Walks down to find the innermost text, stripping timestamps/metadata
function getDeepestText(el) {
  // First try: look for specific text content elements within
  const textSelectors = [
    '[data-testid="tweetText"]',
    "span.selectable-text",
    "p",
    '[dir="auto"]',
    '[dir="ltr"]',
    ".text-content",
    '[class*="text"]',
    '[class*="body"]',
    '[class*="content"]',
    "span",
  ];
  for (const sel of textSelectors) {
    const found = el.querySelectorAll(sel);
    if (found.length) {
      // Collect text from matching elements, pick the longest meaningful one
      let best = "";
      for (const f of found) {
        // Skip buttons, links that are just icons, timestamps
        if (f.closest('button, [role="button"]')) continue;
        if (f.querySelector("svg, img") && !f.textContent?.trim()) continue;
        const t = f.innerText?.trim() || "";
        if (t.length > best.length && t.length < 1500) best = t;
      }
      if (best.length >= 2) return cleanMessageText(best);
    }
  }
  // Fallback: use the element's own text
  const raw = (el.innerText || el.textContent || "").trim();
  return cleanMessageText(raw);
}

// Clean a message text by removing common noise (timestamps, "seen", reaction counts, etc.)
// Returns empty string for text that is purely UI noise.
function cleanMessageText(text) {
  if (!text) return "";
  let t = text;
  // Remove standalone timestamps like "10:30 AM", "14:25" at start or end
  t = t.replace(/^\d{1,2}:\d{2}(\s?(AM|PM|am|pm))?[,\s]*/i, "");
  t = t.replace(/[,\s]*\d{1,2}:\d{2}(\s?(AM|PM|am|pm))?\s*$/i, "");
  // Remove "Read", "Delivered", "Seen" suffixes
  t = t.replace(/\s*(Read|Delivered|Seen|Sent)\s*$/i, "");
  // Remove leading/trailing whitespace and newlines
  t = t.replace(/^[\s\n]+|[\s\n]+$/g, "");
  // Collapse multiple newlines into one
  t = t.replace(/\n{3,}/g, "\n\n");
  t = t.trim();
  // Return empty if the cleaned text is just a UI label
  if (UI_NOISE_EXACT.test(t)) return "";
  // Return empty if it contains accessibility / screen reader boilerplate
  if (UI_NOISE_CONTAINS.test(t)) return "";
  return t;
}

// Remove messages that are subsets of other messages (parent elements contain child text)
function dedupeMessages(messages) {
  if (messages.length <= 1) return messages;
  const result = [];
  for (let i = 0; i < messages.length; i++) {
    let isSubset = false;
    for (let j = 0; j < messages.length; j++) {
      if (i === j) continue;
      // If this message text is fully contained in another AND is significantly shorter
      if (
        messages[j].text.includes(messages[i].text) &&
        messages[i].text.length < messages[j].text.length * 0.8
      ) {
        isSubset = true;
        break;
      }
    }
    if (!isSubset) result.push(messages[i]);
  }
  return result;
}

// Extract messages from a scrollable container near the input
function extractFromScrollContainer(container) {
  const children = container.querySelectorAll("div, li, p, article");
  const blocks = [];
  const seen = new Set();
  for (const c of children) {
    // Only leaf-ish elements (few children = likely a message, not a wrapper)
    if (c.children.length > 8) continue;
    // Skip elements that are too deep or are controls
    if (c.closest('button, nav, header, footer, [role="button"]')) continue;
    const text = cleanMessageText(c.innerText || "");
    if (text.length > 3 && text.length < 1000 && !seen.has(text)) {
      seen.add(text);
      blocks.push({ sender: "Chat", text: text.slice(0, 500) });
    }
  }
  return dedupeMessages(blocks).slice(-5);
}

// Walk up the DOM to find the nearest scrollable container
function findScrollParent(el) {
  let node = el.parentElement;
  while (node && node !== document.body) {
    const style = getComputedStyle(node);
    if (
      node.scrollHeight > node.clientHeight + 50 &&
      (style.overflowY === "auto" || style.overflowY === "scroll")
    ) {
      return node;
    }
    node = node.parentElement;
  }
  return null;
}

function positionArPanel(b, el) {
  const rect = el.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const panelW = 360;
  const margin = 12;

  // Horizontal positioning
  let left = rect.left;
  if (left + panelW > vw) left = Math.max(margin, vw - panelW - margin);

  // Vertical positioning: prefer above the input, fall back to below
  const spaceAbove = rect.top - margin;
  const spaceBelow = vh - rect.bottom - margin;

  let top;
  let maxH;

  if (spaceAbove >= 200 && spaceAbove >= spaceBelow) {
    // Place above
    maxH = Math.min(spaceAbove - OFFSET_Y, 500);
    top = rect.top - Math.min(maxH, 400) - OFFSET_Y;
    if (top < margin) top = margin;
  } else {
    // Place below
    maxH = Math.min(spaceBelow - OFFSET_Y, 500);
    top = rect.bottom + OFFSET_Y;
  }

  // Ensure max-height is at least 150px to be useful
  maxH = Math.max(maxH, 150);

  b.arPanel.style.top = `${top}px`;
  b.arPanel.style.left = `${left}px`;
  b.arPanel.style.maxHeight = `${maxH}px`;
}

function triggerAutoReply(el) {
  if (_inflight) return;

  const b = getBar();
  const messages = scrapeMessages();

  // Smart panel positioning
  positionArPanel(b, el);

  if (messages.length === 0) {
    b.arPanel.innerHTML = `
      <div class="ar-title">
        <svg viewBox="0 0 24 24"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H5.17L4 17.17V4h16v12z"/></svg>
        Write Reply
      </div>
      <div class="ar-no-messages">No messages found on this page.<br>Try using this on a chat like WhatsApp Web.</div>
      <div class="ar-actions">
        <button class="ar-btn ar-btn-cancel" id="ar-close">Close</button>
      </div>
    `;
    b.arPanel.classList.add("visible");
    b.arPanel.querySelector("#ar-close").addEventListener("click", () => {
      b.arPanel.classList.remove("visible");
    });
    return;
  }

  // Show messages preview + loading state
  const msgsHTML = messages
    .map(
      (m) => `
    <div class="ar-msg ${m.sender === "Me" ? "me" : "them"}">
      <span class="ar-sender">${m.sender}</span>
      ${escapeHTML(m.text)}
    </div>
  `,
    )
    .join("");

  b.arPanel.innerHTML = `
    <div class="ar-title">
      <svg viewBox="0 0 24 24"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H5.17L4 17.17V4h16v12z"/></svg>
      Write Reply
    </div>
    <div class="ar-status" id="ar-loading">
      <div class="spinner"></div>
      Generating reply…
    </div>
  `;
  b.arPanel.classList.add("visible");

  // Send to background
  _inflight = true;
  setBarBusy(true, "auto-reply");

  const timer = setTimeout(() => {
    _inflight = false;
    setBarBusy(false);
    showAutoReplyError(b, msgsHTML, messages.length, "Request timed out");
  }, REQUEST_TIMEOUT_MS);

  try {
    chrome.runtime.sendMessage(
      {
        type: "voca:auto-reply",
        messages,
        tone: _lastTone,
        speakingLang: _speakingLang,
      },
      (response) => {
        clearTimeout(timer);
        _inflight = false;
        setBarBusy(false);

        if (chrome.runtime.lastError) {
          showAutoReplyError(
            b,
            msgsHTML,
            messages.length,
            chrome.runtime.lastError.message || "Request failed",
          );
          return;
        }
        if (!response || response.error) {
          showAutoReplyError(
            b,
            msgsHTML,
            messages.length,
            response?.error || "No response",
          );
          return;
        }

        const reply = cleanResult(response.result, "");
        if (!reply) {
          showAutoReplyError(
            b,
            msgsHTML,
            messages.length,
            "Empty response from AI",
          );
          return;
        }

        // Show result with Insert / Cancel
        b.arPanel.innerHTML = `
          <div class="ar-title">
            <svg viewBox="0 0 24 24"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H5.17L4 17.17V4h16v12z"/></svg>
            Write Reply
          </div>
          <div class="ar-result-box" id="ar-result">${escapeHTML(reply)}</div>
          <div class="ar-actions">
            <button class="ar-btn ar-btn-cancel" id="ar-cancel">Cancel</button>
            <button class="ar-btn ar-btn-insert" id="ar-insert">Insert Reply</button>
          </div>
        `;

        b.arPanel.querySelector("#ar-cancel").addEventListener("click", () => {
          b.arPanel.classList.remove("visible");
        });
        b.arPanel.querySelector("#ar-insert").addEventListener("click", () => {
          applyText(el, reply, false);
          b.arPanel.classList.remove("visible");
          hideBar();
        });
      },
    );
  } catch (err) {
    clearTimeout(timer);
    _inflight = false;
    setBarBusy(false);
    if (err.message.includes("Extension context invalidated")) {
      alert(
        "Voca Extension was updated! Please refresh the page to continue using it.",
      );
      return;
    }
    showAutoReplyError(
      b,
      msgsHTML,
      messages.length,
      err.message || "Extension error",
    );
  }
}

function showAutoReplyError(b, msgsHTML, msgCount, errorMsg) {
  b.arPanel.innerHTML = `
    <div class="ar-title">
      <svg viewBox="0 0 24 24"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H5.17L4 17.17V4h16v12z"/></svg>
      Write Reply
    </div>
    <div class="ar-error">⚠ ${escapeHTML(errorMsg)}</div>
    <div class="ar-actions">
      <button class="ar-btn ar-btn-cancel" id="ar-close">Close</button>
    </div>
  `;
  b.arPanel.querySelector("#ar-close").addEventListener("click", () => {
    b.arPanel.classList.remove("visible");
  });
}

function escapeHTML(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

// ─── Input debounce & spellcheck ─────────────────────────────────────────────
// NOTE: typing only updates bar visibility — it never triggers an AI request.
const _attached = new WeakSet();
const _debounces = new WeakMap();

function onInput(el) {
  if (!_aiEnabled) {
    hideBar();
    return;
  }
  if (_inflight) return; // don't disturb the bar while a request is in flight
  clearTimeout(_debounces.get(el));
  _debounces.set(
    el,
    setTimeout(() => {
      // Always show the logo row (auto-reply works with no text)
      showBar(el);
    }, DEBOUNCE_MS),
  );
}

function attach(el) {
  if (_attached.has(el)) return;
  _attached.add(el);

  // Enable browser spellcheck during typing
  el.spellcheck = true;

  el.addEventListener("input", () => onInput(el));
  el.addEventListener("focus", () => {
    if (!_aiEnabled) return;
    // Always show on focus — auto-reply doesn't need typed text
    showBar(el);
  });
  el.addEventListener("blur", (e) =>
    setTimeout(() => {
      // Don't hide if a request is busy OR if the user is interacting with settings
      if (_inflight || _settingsPanel?.el.classList.contains("visible")) return;
      
      // Check if focus moved to one of our own panels (Shadow DOM check)
      const activeHost = document.activeElement;
      if (activeHost === _bar?.host || activeHost === _settingsPanel?.host || activeHost === _popup?.host) return;

      hideBar();
      hideSettingsPanel();
    }, 250),
  );
}

// ─── DOM scan ─────────────────────────────────────────────────────────────────
const SELECTOR =
  'textarea, input[type="text"], input:not([type]), [contenteditable="true"]';

function scan(root) {
  if (root instanceof Element && isEditable(root)) attach(root);
  root.querySelectorAll?.(SELECTOR)?.forEach(attach);
}

// Initial scan
scan(document);

// Watch for dynamically added elements and attribute changes
new MutationObserver((mutations) => {
  for (const m of mutations) {
    if (m.type === "childList") {
      for (const node of m.addedNodes)
        if (node.nodeType === Node.ELEMENT_NODE) scan(node);
    } else if (
      m.type === "attributes" &&
      m.attributeName === "contenteditable"
    ) {
      if (m.target.nodeType === Node.ELEMENT_NODE) scan(m.target);
    }
  }
}).observe(document.documentElement, {
  childList: true,
  subtree: true,
  attributes: true,
  attributeFilter: ["contenteditable"],
});

// Backup global focus listener for SPAs (like LinkedIn) where DOM mutation observers might miss dynamic elements
document.addEventListener("focusin", (e) => {
  if (e.target && isEditable(e.target)) {
    attach(e.target);
    if (_aiEnabled) {
      showBar(e.target);
    }
  }
});

// Global input listener to catch typing in SPAs and force show the logo if it's missing
document.addEventListener(
  "input",
  (e) => {
    if (!_aiEnabled || _inflight) return;
    const el = e.target;
    if (el && isEditable(el)) {
      const text = getText(el).trim();
      if (text.length >= 5) {
        const b = getBar();
        // If the bar/logo is not visible, force show it
        if (
          !b.logoRow.classList.contains("visible") &&
          !b.el.classList.contains("visible")
        ) {
          attach(el);
          showBar(el);
        }
      }
    }
  },
  true,
);

// ─── Global dismissal ─────────────────────────────────────────────────────────
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    closePopup();
    hideBar();
    hideSettingsPanel();
  }
});
document.addEventListener("mousedown", (e) => {
  // In Shadow DOM, e.target is often the host element when viewed from document
  const target = e.target;
  const inPopup = _popup?.host === target || _popup?.host.contains(target);
  const inBar = _bar?.host === target || _bar?.host.contains(target);
  const inSettings = _settingsPanel?.host === target || _settingsPanel?.host.contains(target);

  if (!inPopup) closePopup();
  
  if (!inBar && !inSettings) {
    hideBar();
    hideSettingsPanel();
    _bar?.arPanel?.classList.remove("visible");
  }
});
