"use strict";

/**
 * Voca AI - Content Script
 * Premium Vertical UI Redesign (Inspired by Voca Premium Design System)
 * Optimized for LinkedIn, WhatsApp, and complex SPAs.
 */

const CONSTANTS = {
  MIN_LENGTH: 3,
  LOGO_SIZE: 28,
  PADDING: 8,
  Z_INDEX: "2147483647",
  IGNORE_ATTR: "data-voca-ignore",
  PROCESSED_ATTR: "data-voca-processed",
  SCAN_INTERVAL: 2000
};

// ─── Native Overrides (Bridge) ────────────────────────────────────────────────
const NativeBridge = {
  applyToElement(el, value) {
    if (!el) return;
    console.log("[Voca] Applying text to element:", el);
    
    if (el.tagName === "TEXTAREA" || el.tagName === "INPUT") {
      const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
      if (setter) {
        setter.call(el, value);
      } else {
        el.value = value;
      }
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    } else {
      // Find the root contenteditable in case we are deep inside a span/p
      let targetEl = el;
      while (targetEl && targetEl.parentElement && targetEl.getAttribute) {
        if (targetEl.getAttribute("contenteditable") === "true") break;
        targetEl = targetEl.parentElement;
      }
      if (targetEl && targetEl.getAttribute && targetEl.getAttribute("contenteditable") === "true") {
        el = targetEl;
      }

      const isWhatsApp = window.location.hostname.includes("whatsapp.com");
      
      if (isWhatsApp) {
        try {
          chrome.runtime.sendMessage({ type: "voca:execute-main", value: value }, (response) => {
             if (chrome.runtime.lastError) {
                 console.error("[Voca] Main world execution error:", chrome.runtime.lastError);
                 this._fallbackReplacement(el, value);
             }
          });
          return;
        } catch (e) {
          console.warn("[Voca] Main world injection failed:", e);
        }
      }

      this._fallbackReplacement(el, value);
    }
  },

  _fallbackReplacement(el, value) {
    el.focus();
    
    // Modern approach for framework-based editors (Lexical/React)
    const selection = window.getSelection();
    if (selection.rangeCount > 0) {
      const range = selection.getRangeAt(0);
      
      // Try to clear the field first to avoid duplication
      try {
        document.execCommand("selectAll", false, null);
        document.execCommand("delete", false, null);
      } catch (e) {}

      // Wait a tick for the editor to sync the empty state
      setTimeout(() => {
        try {
          // 1. Primary method: insertText (safest for internal state)
          if (!document.execCommand("insertText", false, value)) {
             throw new Error("execCommand failed");
          }
        } catch (e) {
          // 2. Fallback: Clipboard Event (Paste)
          try {
            const dataTransfer = new DataTransfer();
            dataTransfer.setData("text/plain", value);
            const pasteEvent = new ClipboardEvent("paste", {
              clipboardData: dataTransfer,
              bubbles: true,
              cancelable: true
            });
            el.dispatchEvent(pasteEvent);
          } catch (e2) {
            // 3. Last resort: Direct DOM manipulation (may break React/Lexical state but better than nothing)
            el.innerText = value;
            el.dispatchEvent(new InputEvent("input", { bubbles: true }));
          }
        }
        
        // Final event trigger
        el.dispatchEvent(new Event("change", { bubbles: true }));
      }, 20);
    }
  }
};

// ─── UI Host (Shadow DOM) ───────────────────────────────────────────────────
class UIHost {
  constructor() {
    this.container = null;
    this.shadow = null;
    this.logo = null;
    this.panel = null;
    this.status = null;
    this.activeField = null;
    this.expanded = false;
    this.settings = { speakingLang: "English", translateLang: "Spanish", tone: "Professional" };
    this.selectionLogo = null;
    this.dialog = null;
    this.isDialogVisible = false;
    this.isResponseVisible = false;
    this.isReadOnlyResponse = false;
    this.pendingResult = "";
    this.responseBox = null;
    this.typingTimeout = null;
    this.isTyping = false;
    this.currentAction = "";
    
    this._init();
    this._loadSettings();
  }

  async _loadSettings() {
    try {
      if (!chrome.runtime?.id) return;
      const prefs = await chrome.storage.sync.get({ 
        speakingLang: "English", 
        translateLang: "Spanish", 
        tone: "Professional" 
      });
      this.settings = prefs;
      this._updateSettingsUI();
    } catch (e) {
      console.warn("[Voca] Failed to load settings (likely context invalidated):", e);
    }
  }

  _updateSettingsUI() {
    if (!this.shadow) return;
    const langSub = this.shadow.querySelector("#lang-label");
    const toneSub = this.shadow.querySelector("#tone-label");
    if (langSub) langSub.textContent = `(${this.settings.translateLang})`;
    if (toneSub) toneSub.textContent = `(${this.settings.tone})`;
  }

  _init() {
    if (document.getElementById("voca-host")) return;

    this.container = document.createElement("div");
    this.container.id = "voca-host";
    this.container.setAttribute(CONSTANTS.IGNORE_ATTR, "true");
    Object.assign(this.container.style, {
      position: "fixed",
      top: "0",
      left: "0",
      width: "0",
      height: "0",
      zIndex: CONSTANTS.Z_INDEX,
      pointerEvents: "none",
      overflow: "visible"
    });

    this.shadow = this.container.attachShadow({ mode: "open" });
    this.shadow.innerHTML = this._getStyles() + this._getHtml();
    
    // Inject font into main document as well (fallback for some sites)
    this._injectFonts();
    
    document.body.appendChild(this.container);
    this._bindElements();
  }

  _injectFonts() {
    const fontUrl = "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Outfit:wght@300;400;500;600&display=swap";
    if (!document.querySelector(`link[href="${fontUrl}"]`)) {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = fontUrl;
      document.head.appendChild(link);
    }
  }

  _getStyles() {
    return `
      <style>
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Outfit:wght@300;400;500;600&display=swap');
        
        :host { 
          all: initial; 
          font-family: 'Inter', sans-serif;
          color: var(--text);
          --primary: #adc6ff;
          --bg: rgba(0, 0, 0, 0.95);
          --border: rgba(255, 255, 255, 0.12);
          --text: #e5e2e1;
          --text-dim: #c1c6d7;
          --radius: 16px;
          --accent: #3b82f6;
        }

        .voca-logo {
          position: fixed;
          width: 24px;
          height: 24px;
          background: #000;
          backdrop-filter: blur(16px);
          -webkit-backdrop-filter: blur(16px);
          border: 1px solid var(--border);
          border-radius: 50%;
          display: none;
          align-items: center;
          justify-content: center;
          pointer-events: auto;
          transition: all 0.25s cubic-bezier(0.2, 1, 0.3, 1);
          z-index: 10000;
          box-shadow: 0 4px 12px rgba(0,0,0,0.3);
        }

        .voca-logo.visible { display: flex; }
        
        .voca-logo.breathing {
          animation: breathe 1.5s ease-in-out infinite;
          opacity: 1 !important;
          display: flex !important;
        }

        .voca-logo:hover { 
          transform: scale(1.1);
          border-color: rgba(255, 255, 255, 0.3);
        }

        .voca-logo.typing {
          width: 8px;
          height: 8px;
          background: var(--accent);
          border: none;
          box-shadow: 0 0 12px var(--accent);
          transform: scale(1);
        }
        
        .voca-logo.typing img { opacity: 0; display: none; }
        .voca-logo img { width: 14px; height: 14px; object-fit: contain; }

        .voca-panel {
          background: var(--bg);
          backdrop-filter: blur(25px);
          -webkit-backdrop-filter: blur(25px);
          border: 1px solid var(--border);
          border-radius: 18px;
          padding: 8px;
          box-shadow: 0 12px 40px rgba(0, 0, 0, 0.7), inset 0 1px 1px rgba(255, 255, 255, 0.1);
          pointer-events: auto;
          z-index: 1001;
          animation: barIn 0.2s cubic-bezier(0.16, 1, 0.3, 1);
          position: fixed;
          width: max-content;
          display: none;
          flex-direction: column;
        }
        @keyframes barIn {
          from { opacity: 0; transform: translateY(5px) scale(0.98); }
          to { opacity: 1; transform: translateY(0) scale(1); }
        }
        .voca-panel.visible { display: flex; }

        .logo-circle {
          width: 20px;
          height: 20px;
          background: var(--primary);
          border-radius: 6px;
          display: flex;
          align-items: center;
          justify-content: center;
          color: #000;
          flex-shrink: 0;
        }

        .logo-circle svg {
          width: 14px;
          height: 14px;
        }

        .status-container {
          display: flex;
          align-items: center;
          gap: 6px;
          color: var(--primary);
          font-size: 11px;
          font-weight: 600;
          padding: 0 8px;
        }

        .voca-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          width: 100%;
          height: 20px;
          padding: 0 4px 6px 4px;
          border-bottom: 1px solid rgba(255, 255, 255, 0.08);
          margin-bottom: 6px;
        }
        .header-text { font-size: 9px; color: var(--text-dim); font-weight: 500; letter-spacing: 0.2px; }
        
        .settings-btn {
          background: none;
          border: none;
          color: var(--text-dim);
          cursor: pointer;
          padding: 2px;
          display: flex;
          align-items: center;
          transition: color 0.2s;
        }
        .settings-btn:hover { color: var(--text); }
        .settings-btn svg { width: 14px; height: 14px; }

        .voca-dialog {
          position: absolute;
          display: none;
          flex-direction: column;
          width: 240px;
          background: #0d0d0d;
          border: 1px solid var(--border);
          border-radius: 12px;
          padding: 14px;
          box-shadow: 0 15px 50px rgba(0,0,0,0.9);
          z-index: 10005;
          position: fixed;
          pointer-events: auto;
          gap: 12px;
        }
        .voca-dialog.visible { display: flex; }
        .setting-item { display: flex; flex-direction: column; gap: 4px; }
        .setting-label { font-size: 11px; color: var(--text-dim); }
        .setting-select {
          background: #1a1a1a;
          border: 1px solid var(--border);
          color: var(--text);
          font-size: 12px;
          padding: 6px;
          border-radius: 6px;
          outline: none;
        }

        .response-box {
          position: absolute;
          display: none;
          flex-direction: column;
          width: 320px;
          background: var(--bg);
          backdrop-filter: blur(25px);
          border: 1px solid var(--border);
          border-radius: 16px;
          padding: 12px;
          box-shadow: 0 12px 50px rgba(0,0,0,0.8);
          z-index: 10002;
          position: fixed;
          pointer-events: auto;
          gap: 8px;
        }
        .response-box.visible { display: flex; }
        .box-label { font-size: 10px; text-transform: uppercase; letter-spacing: 0.5px; font-weight: 700; }
        .box-label.original {
          color: #ff5252;
          font-weight: 600;
        }

        .box-label.action {
          color: #4caf50;
          font-weight: 600;
        }

        .box-content {
          font-size: 13px;
          line-height: 1.5;
          color: var(--text);
          background: rgba(255,255,255,0.03);
          padding: 10px;
          border-radius: 8px;
          margin-bottom: 12px;
          max-height: 150px;
          overflow-y: auto;
          opacity: 0.85;
          border: 1px solid rgba(255,255,255,0.05);
        }
        .box-footer { display: flex; gap: 8px; margin-top: 4px; }
        .box-btn {
          flex: 1;
          height: 32px;
          border-radius: 8px;
          border: none;
          font-size: 12px;
          font-weight: 600;
          cursor: pointer;
          transition: all 0.2s;
        }
        .btn-apply { background: var(--accent); color: white; }
        .btn-apply:hover { opacity: 0.9; }
        .btn-cancel { background: rgba(255,255,255,0.1); color: var(--text); }
        .btn-cancel:hover { background: rgba(255,255,255,0.15); }

        .action-btn:disabled { opacity: 0.5; cursor: not-allowed; }

        .action-btn {
          background: rgba(255, 255, 255, 0.05);
          border: none;
          color: var(--text);
          padding: 0 10px;
          height: 26px;
          border-radius: 999px;
          font-size: 12px;
          font-weight: 600;
          cursor: pointer;
          transition: all 0.2s ease;
          display: flex;
          align-items: center;
          gap: 5px;
          white-space: nowrap;
        }
        .action-btn:hover:not(:disabled) { 
          background: rgba(255, 255, 255, 0.12);
          box-shadow: 0 0 15px rgba(255, 255, 255, 0.05);
        }
        .action-btn:active { transform: scale(0.96); }
        
        .action-btn.accent {
          background: rgba(173, 198, 255, 0.15);
          color: var(--primary);
          border: 1px solid rgba(173, 198, 255, 0.2);
        }

        .btn-wrapper {
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 2px;
        }

        .credit-cost {
          font-size: 8px;
          color: var(--text-dim);
          opacity: 0.6;
          font-weight: 500;
          letter-spacing: 0.2px;
        }

        .selection-logo {
          position: absolute;
          width: 24px;
          height: 24px;
          background: var(--primary);
          border-radius: 50%;
          display: flex;
          align-items: center;
          justify-content: center;
          cursor: pointer;
          box-shadow: 0 4px 12px rgba(0,0,0,0.2);
          z-index: 10001;
          transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
          opacity: 0;
          transform: scale(0.8);
          pointer-events: none;
          border: 2px solid white;
          color: white;
        }
        .selection-logo:hover {
          transform: scale(1.1);
          background: #4d82ff;
        }
        .selection-logo.visible { display: flex; opacity: 1; transform: scale(1); pointer-events: auto; }
        .selection-logo.breathing {
          animation: breathe 1.5s ease-in-out infinite;
        }
        .selection-logo img { width: 14px; height: 14px; }

        .response-box.read-only .btn-apply { display: block; background: var(--accent); color: white; }
        .response-box.read-only .btn-apply:after { content: ' to Input'; }
        .response-box.read-only .btn-copy-res { background: rgba(255,255,255,0.1); color: var(--text); }


        @keyframes breathe {
          0%, 100% { transform: scale(1); opacity: 1; border-color: var(--border); }
          50% { transform: scale(1.1); opacity: 0.7; border-color: var(--primary); }
        }

        .subtext { 
          font-size: 12px; 
          color: inherit; 
          font-weight: 600;
          opacity: 1;
          margin-left: 4px;
        }
        
        .status-container {
          padding-left: 8px;
          padding-right: 12px;
          border-left: 1px solid var(--border);
          font-size: 12px;
          color: var(--primary);
          font-weight: 600;
          height: 20px;
          display: flex;
          align-items: center;
        }

        .loading-dots:after {
          content: '.';
          animation: dots 1.5s steps(5, end) infinite;
        }
        @keyframes dots {
          0% { content: ''; }
          25% { content: '.'; }
          50% { content: '..'; }
          75% { content: '...'; }
          100% { content: ''; }
        }
        .loading-dots {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 24px;
        }
      </style>
    `;
  }

  _getHtml() {
    const logoUrl = chrome.runtime.getURL("logo.png");
    return `
      <div id="logo" class="voca-logo">
        <img src="${logoUrl}" alt="">
      </div>
      <div id="selection-logo" class="selection-logo">
        <img src="${logoUrl}" alt="">
      </div>
      <div id="panel" class="voca-panel">
        <div class="voca-header">
          <div style="display: flex; align-items: center; gap: 8px;">
            <span style="font-family: 'Outfit', sans-serif; color: rgba(255, 255, 255, 0.4); font-weight: 400; font-size: 10px; letter-spacing: 0.3px; text-transform: uppercase;">Select opposite side message to translate in your language</span>
          </div>
          <button id="btn-settings" class="settings-btn" title="Settings">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 15a3 3 0 100-6 3 3 0 000 6z"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-2 2 2 2 0 01-2-2v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 01-2-2 2 2 0 012-2h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 010-2.83 2 2 0 012.83 0l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 012-2 2 2 0 012 2v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 0 2 2 0 010 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 012 2 2 2 0 01-2 2h-.09a1.65 1.65 0 00-1.51 1z"/></svg>
          </button>
        </div>
        <div style="display: flex; align-items: flex-start; gap: 6px; padding: 0 2px;">
          <div class="btn-wrapper">
            <button class="action-btn accent" id="btn-reply">Write Reply</button>
            <span class="credit-cost">3 credits</span>
          </div>
          <div class="btn-wrapper">
            <button class="action-btn" id="btn-fix">Fix Grammar</button>
            <span class="credit-cost">1 credit</span>
          </div>
          <div class="btn-wrapper">
            <button class="action-btn" id="btn-improve">Improve <span class="subtext" id="tone-label">(Professional)</span></button>
            <span class="credit-cost">1 credit</span>
          </div>
          <div class="btn-wrapper">
            <button class="action-btn" id="btn-translate">Translate <span class="subtext" id="lang-label">(Spanish)</span></button>
            <span class="credit-cost">1 credit</span>
          </div>
          <div id="status-box" class="status-container" style="display:none; align-self: center; height: 32px;">
            <span id="status-text">Thinking</span>
          </div>
        </div>
      </div>
      <div id="dialog" class="voca-dialog">
        <div class="setting-item">
          <span class="setting-label">Speaking Language (Input)</span>
          <select id="sel-speaking" class="setting-select">
            <option value="English">English</option>
            <option value="Hindi">Hindi</option>
            <option value="Spanish">Spanish</option>
            <option value="French">French</option>
            <option value="German">German</option>
            <option value="Chinese (Simplified)">Chinese (Simplified)</option>
            <option value="Chinese (Traditional)">Chinese (Traditional)</option>
            <option value="Japanese">Japanese</option>
            <option value="Russian">Russian</option>
            <option value="Portuguese">Portuguese</option>
            <option value="Italian">Italian</option>
            <option value="Arabic">Arabic</option>
            <option value="Korean">Korean</option>
            <option value="Dutch">Dutch</option>
            <option value="Turkish">Turkish</option>
            <option value="Bengali">Bengali</option>
            <option value="Marathi">Marathi</option>
            <option value="Telugu">Telugu</option>
            <option value="Tamil">Tamil</option>
            <option value="Urdu">Urdu</option>
            <option value="Punjabi">Punjabi</option>
            <option value="Vietnamese">Vietnamese</option>
            <option value="Thai">Thai</option>
            <option value="Indonesian">Indonesian</option>
            <option value="Hebrew">Hebrew</option>
            <option value="Polish">Polish</option>
            <option value="Swedish">Swedish</option>
            <option value="Greek">Greek</option>
            <option value="Romanian">Romanian</option>
            <option value="Hungarian">Hungarian</option>
            <option value="Czech">Czech</option>
            <option value="Danish">Danish</option>
            <option value="Finnish">Finnish</option>
            <option value="Norwegian">Norwegian</option>
            <option value="Malay">Malay</option>
            <option value="Gujarati">Gujarati</option>
            <option value="Kannada">Kannada</option>
            <option value="Malayalam">Malayalam</option>
          </select>
        </div>
        <div class="setting-item">
          <span class="setting-label">Translate Language (Output)</span>
          <select id="sel-translate" class="setting-select">
            <option value="Spanish">Spanish</option>
            <option value="English">English</option>
            <option value="Hindi">Hindi</option>
            <option value="French">French</option>
            <option value="German">German</option>
            <option value="Chinese (Simplified)">Chinese (Simplified)</option>
            <option value="Chinese (Traditional)">Chinese (Traditional)</option>
            <option value="Japanese">Japanese</option>
            <option value="Russian">Russian</option>
            <option value="Portuguese">Portuguese</option>
            <option value="Italian">Italian</option>
            <option value="Arabic">Arabic</option>
            <option value="Korean">Korean</option>
            <option value="Dutch">Dutch</option>
            <option value="Turkish">Turkish</option>
            <option value="Bengali">Bengali</option>
            <option value="Marathi">Marathi</option>
            <option value="Telugu">Telugu</option>
            <option value="Tamil">Tamil</option>
            <option value="Urdu">Urdu</option>
            <option value="Punjabi">Punjabi</option>
            <option value="Vietnamese">Vietnamese</option>
            <option value="Thai">Thai</option>
            <option value="Indonesian">Indonesian</option>
            <option value="Hebrew">Hebrew</option>
            <option value="Polish">Polish</option>
            <option value="Swedish">Swedish</option>
            <option value="Greek">Greek</option>
            <option value="Romanian">Romanian</option>
            <option value="Hungarian">Hungarian</option>
            <option value="Czech">Czech</option>
            <option value="Danish">Danish</option>
            <option value="Finnish">Finnish</option>
            <option value="Norwegian">Norwegian</option>
            <option value="Malay">Malay</option>
            <option value="Gujarati">Gujarati</option>
            <option value="Kannada">Kannada</option>
            <option value="Malayalam">Malayalam</option>
          </select>
        </div>
        <div class="setting-item">
          <span class="setting-label">AI Tone</span>
          <select id="sel-tone" class="setting-select">
            <option value="Professional">Professional</option>
            <option value="Formal">Formal</option>
            <option value="Friendly">Friendly</option>
            <option value="Casual">Casual</option>
            <option value="Confident">Confident</option>
            <option value="Concise">Concise</option>
            <option value="Business Collaboration">Business Collaboration</option>
            <option value="Service Provider">Service Provider</option>
            <option value="Sarcastic">Sarcastic</option>
            <option value="Enthusiastic">Enthusiastic</option>
            <option value="Persuasive">Persuasive</option>
            <option value="Bold">Bold</option>
            <option value="Empathetic">Empathetic</option>
            <option value="Humorous">Humorous</option>
            <option value="Thoughtful">Thoughtful</option>
            <option value="Curious">Curious</option>
            <option value="Direct">Direct</option>
            <option value="Academic">Academic</option>
            <option value="Creative">Creative</option>
            <option value="Inspirational">Inspirational</option>
            <option value="Diplomatic">Diplomatic</option>
            <option value="Urgent">Urgent</option>
            <option value="Sincere">Sincere</option>
            <option value="Playful">Playful</option>
            <option value="Aggressive">Aggressive</option>
            <option value="Passive">Passive</option>
            <option value="Instructional">Instructional</option>
            <option value="Narrative">Narrative</option>
            <option value="Descriptive">Descriptive</option>
            <option value="Expository">Expository</option>
            <option value="Persuasive">Persuasive</option>
            <option value="Analytical">Analytical</option>
            <option value="Critical">Critical</option>
            <option value="Poetic">Poetic</option>
            <option value="Mysterious">Mysterious</option>
            <option value="Melancholic">Melancholic</option>
            <option value="Nostalgic">Nostalgic</option>
            <option value="Cynical">Cynical</option>
            <option value="Optimistic">Optimistic</option>
            <option value="Skeptical">Skeptical</option>
            <option value="Appreciative">Appreciative</option>
            <option value="Apologetic">Apologetic</option>
            <option value="Condescending">Condescending</option>
            <option value="Encouraging">Encouraging</option>
            <option value="Indifferent">Indifferent</option>
            <option value="Ironical">Ironical</option>
            <option value="Objective">Objective</option>
            <option value="Subjective">Subjective</option>
            <option value="Whimsical">Whimsical</option>
            <option value="Witty">Witty</option>
            <option value="Zealous">Zealous</option>
            <option value="Apathetic">Apathetic</option>
            <option value="Compassionate">Compassionate</option>
            <option value="Contemptuous">Contemptuous</option>
            <option value="Disdainful">Disdainful</option>
            <option value="Egotistical">Egotistical</option>
            <option value="Humble">Humble</option>
            <option value="Mocking">Mocking</option>
            <option value="Pompous">Pompous</option>
            <option value="Reverent">Reverent</option>
            <option value="Solemn">Solemn</option>
            <option value="Tragic">Tragic</option>
            <option value="Vibrant">Vibrant</option>
            <option value="Warm">Warm</option>
            <option value="Cold">Cold</option>
            <option value="Hostile">Hostile</option>
            <option value="Affectionate">Affectionate</option>
            <option value="Bitter">Bitter</option>
            <option value="Calm">Calm</option>
            <option value="Defiant">Defiant</option>
            <option value="Gloomy">Gloomy</option>
            <option value="Joyful">Joyful</option>
            <option value="Loving">Loving</option>
            <option value="Mad">Mad</option>
            <option value="Sad">Sad</option>
            <option value="Scared">Scared</option>
            <option value="Surprised">Surprised</option>
            <option value="Trusting">Trusting</option>
            <option value="Guilty">Guilty</option>
            <option value="Ashamed">Ashamed</option>
            <option value="Proud">Proud</option>
            <option value="Disappointed">Disappointed</option>
            <option value="Satisfied">Satisfied</option>
            <option value="Frustrated">Frustrated</option>
            <option value="Bored">Bored</option>
            <option value="Excited">Excited</option>
            <option value="Anxious">Anxious</option>
            <option value="Relaxed">Relaxed</option>
            <option value="Stressed">Stressed</option>
            <option value="Tired">Tired</option>
            <option value="Energetic">Energetic</option>
            <option value="Peaceful">Peaceful</option>
            <option value="Violent">Violent</option>
            <option value="Gentle">Gentle</option>
            <option value="Rough">Rough</option>
            <option value="Smooth">Smooth</option>
            <option value="Hard">Hard</option>
            <option value="Soft">Soft</option>
            <option value="Strong">Strong</option>
            <option value="Weak">Weak</option>
            <option value="Old">Old</option>
            <option value="New">New</option>
            <option value="Fast">Fast</option>
            <option value="Slow">Slow</option>
            <option value="High">High</option>
            <option value="Low">Low</option>
            <option value="Big">Big</option>
            <option value="Small">Small</option>
            <option value="Hot">Hot</option>
            <option value="Cold">Cold</option>
            <option value="Bright">Bright</option>
            <option value="Dark">Dark</option>
            <option value="Loud">Loud</option>
            <option value="Quiet">Quiet</option>
            <option value="Heavy">Heavy</option>
            <option value="Light">Light</option>
            <option value="Thick">Thick</option>
            <option value="Thin">Thin</option>
            <option value="Wide">Wide</option>
            <option value="Narrow">Narrow</option>
            <option value="Long">Long</option>
            <option value="Short">Short</option>
            <option value="Deep">Deep</option>
            <option value="Shallow">Shallow</option>
            <option value="Rich">Rich</option>
            <option value="Poor">Poor</option>
            <option value="Expensive">Expensive</option>
            <option value="Cheap">Cheap</option>
            <option value="Easy">Easy</option>
            <option value="Difficult">Difficult</option>
            <option value="Simple">Simple</option>
            <option value="Complex">Complex</option>
            <option value="Clean">Clean</option>
            <option value="Dirty">Dirty</option>
            <option value="Clear">Clear</option>
            <option value="Blurry">Blurry</option>
            <option value="Perfect">Perfect</option>
            <option value="Flawed">Flawed</option>
            <option value="Beautiful">Beautiful</option>
            <option value="Ugly">Ugly</option>
            <option value="Happy">Happy</option>
            <option value="Sad">Sad</option>
            <option value="Good">Good</option>
            <option value="Bad">Bad</option>
            <option value="Right">Right</option>
            <option value="Wrong">Wrong</option>
            <option value="True">True</option>
            <option value="False">False</option>
            <option value="Real">Real</option>
            <option value="Fake">Fake</option>
            <option value="Possible">Possible</option>
            <option value="Impossible">Impossible</option>
            <option value="Certain">Certain</option>
            <option value="Uncertain">Uncertain</option>
            <option value="Likely">Likely</option>
            <option value="Unlikely">Unlikely</option>
            <option value="Always">Always</option>
            <option value="Never">Never</option>
            <option value="Sometimes">Sometimes</option>
            <option value="Often">Often</option>
            <option value="Rarely">Rarely</option>
            <option value="Early">Early</option>
            <option value="Late">Late</option>
            <option value="Young">Young</option>
            <option value="Old">Old</option>
            <option value="Large">Large</option>
            <option value="Small">Small</option>
            <option value="Open">Open</option>
            <option value="Closed">Closed</option>
            <option value="Full">Full</option>
            <option value="Empty">Empty</option>
            <option value="Heavy">Heavy</option>
            <option value="Light">Light</option>
            <option value="Sharp">Sharp</option>
            <option value="Dull">Dull</option>
            <option value="Hard">Hard</option>
            <option value="Soft">Soft</option>
            <option value="Rough">Rough</option>
            <option value="Smooth">Smooth</option>
            <option value="Sweet">Sweet</option>
            <option value="Sour">Sour</option>
            <option value="Bitter">Bitter</option>
            <option value="Salty">Salty</option>
            <option value="Hot">Hot</option>
            <option value="Cold">Cold</option>
            <option value="Dry">Dry</option>
            <option value="Wet">Wet</option>
            <option value="Clean">Clean</option>
            <option value="Dirty">Dirty</option>
            <option value="Healthy">Healthy</option>
            <option value="Sick">Sick</option>
            <option value="Strong">Strong</option>
            <option value="Weak">Weak</option>
            <option value="Safe">Safe</option>
            <option value="Dangerous">Dangerous</option>
            <option value="Rich">Rich</option>
            <option value="Poor">Poor</option>
            <option value="Deep">Deep</option>
            <option value="Shallow">Shallow</option>
            <option value="Expensive">Expensive</option>
            <option value="Cheap">Cheap</option>
            <option value="High">High</option>
            <option value="Low">Low</option>
            <option value="Fast">Fast</option>
            <option value="Slow">Slow</option>
            <option value="Early">Early</option>
            <option value="Late">Late</option>
            <option value="Long">Long</option>
            <option value="Short">Short</option>
            <option value="Old">Old</option>
            <option value="New">New</option>
            <option value="Good">Good</option>
            <option value="Bad">Bad</option>
            <option value="Beautiful">Beautiful</option>
            <option value="Ugly">Ugly</option>
            <option value="Happy">Happy</option>
            <option value="Sad">Sad</option>
            <option value="Big">Big</option>
            <option value="Small">Small</option>
            <option value="Open">Open</option>
            <option value="Closed">Closed</option>
            <option value="True">True</option>
            <option value="False">False</option>
            <option value="Real">Real</option>
            <option value="Fake">Fake</option>
            <option value="Hot">Hot</option>
            <option value="Cold">Cold</option>
            <option value="Wet">Wet</option>
            <option value="Dry">Dry</option>
            <option value="Clean">Clean</option>
            <option value="Dirty">Dirty</option>
            <option value="Easy">Easy</option>
            <option value="Hard">Hard</option>
            <option value="Right">Right</option>
            <option value="Wrong">Wrong</option>
            <option value="Clear">Clear</option>
            <option value="Cloudy">Cloudy</option>
            <option value="Bright">Bright</option>
            <option value="Dark">Dark</option>
            <option value="Loud">Loud</option>
            <option value="Quiet">Quiet</option>
            <option value="Heavy">Heavy</option>
            <option value="Light">Light</option>
            <option value="Thick">Thick</option>
            <option value="Thin">Thin</option>
            <option value="Wide">Wide</option>
            <option value="Narrow">Narrow</option>
            <option value="Deep">Deep</option>
            <option value="Shallow">Shallow</option>
            <option value="Rich">Rich</option>
            <option value="Poor">Poor</option>
            <option value="Old">Old</option>
            <option value="Young">Young</option>
            <option value="Sharp">Sharp</option>
            <option value="Dull">Dull</option>
            <option value="Smooth">Smooth</option>
            <option value="Rough">Rough</option>
            <option value="Sweet">Sweet</option>
            <option value="Sour">Sour</option>
            <option value="Soft">Soft</option>
            <option value="Hard">Hard</option>
            <option value="Full">Full</option>
            <option value="Empty">Empty</option>
            <option value="Tight">Tight</option>
            <option value="Loose">Loose</option>
            <option value="Healthy">Healthy</option>
            <option value="Ill">Ill</option>
            <option value="Strong">Strong</option>
            <option value="Weak">Weak</option>
            <option value="Rich">Rich</option>
            <option value="Poor">Poor</option>
            <option value="High">High</option>
            <option value="Low">Low</option>
            <option value="Broad">Broad</option>
            <option value="Narrow">Narrow</option>
            <option value="Smart">Smart</option>
            <option value="Stupid">Stupid</option>
            <option value="Kind">Kind</option>
            <option value="Mean">Mean</option>
            <option value="Brave">Brave</option>
            <option value="Cowardly">Cowardly</option>
            <option value="Honest">Honest</option>
            <option value="Dishonest">Dishonest</option>
            <option value="Polite">Polite</option>
            <option value="Rude">Rude</option>
            <option value="Generous">Generous</option>
            <option value="Selfish">Selfish</option>
            <option value="Patient">Patient</option>
            <option value="Impatient">Impatient</option>
            <option value="Calm">Calm</option>
            <option value="Nervous">Nervous</option>
            <option value="Confident">Confident</option>
            <option value="Shy">Shy</option>
            <option value="Cheerful">Cheerful</option>
            <option value="Miserable">Miserable</option>
            <option value="Funny">Funny</option>
            <option value="Serious">Serious</option>
            <option value="Interesting">Interesting</option>
            <option value="Boring">Boring</option>
            <option value="Simple">Simple</option>
            <option value="Complex">Complex</option>
            <option value="Modern">Modern</option>
            <option value="Ancient">Ancient</option>
            <option value="Natural">Natural</option>
            <option value="Artificial">Artificial</option>
            <option value="Common">Common</option>
            <option value="Rare">Rare</option>
            <option value="Perfect">Perfect</option>
            <option value="Useless">Useless</option>
            <option value="Useful">Useful</option>
            <option value="Available">Available</option>
            <option value="Occupied">Occupied</option>
            <option value="Ready">Ready</option>
            <option value="Finished">Finished</option>
            <option value="Starting">Starting</option>
            <option value="Growing">Growing</option>
            <option value="Shrinking">Shrinking</option>
            <option value="Living">Living</option>
            <option value="Dead">Dead</option>
            <option value="Sleeping">Sleeping</option>
            <option value="Awake">Awake</option>
            <option value="Moving">Moving</option>
            <option value="Still">Still</option>
            <option value="Flying">Flying</option>
            <option value="Falling">Falling</option>
            <option value="Burning">Burning</option>
            <option value="Freezing">Freezing</option>
            <option value="Melting">Melting</option>
            <option value="Exploding">Exploding</option>
            <option value="Glowing">Glowing</option>
            <option value="Shining">Shining</option>
            <option value="Fading">Fading</option>
            <option value="Broken">Broken</option>
            <option value="Working">Working</option>
            <option value="Missing">Missing</option>
            <option value="Found">Found</option>
            <option value="Lost">Lost</option>
            <option value="Hidden">Hidden</option>
            <option value="Public">Public</option>
            <option value="Private">Private</option>
            <option value="Secret">Secret</option>
            <option value="Famous">Famous</option>
            <option value="Unknown">Unknown</option>
            <option value="Favorite">Favorite</option>
            <option value="Hated">Hated</option>
            <option value="Wanted">Wanted</option>
            <option value="Needed">Needed</option>
            <option value="Enough">Enough</option>
            <option value="Missing">Missing</option>
            <option value="Extra">Extra</option>
            <option value="All">All</option>
            <option value="None">None</option>
            <option value="Some">Some</option>
            <option value="Most">Most</option>
            <option value="Half">Half</option>
            <option value="Double">Double</option>
            <option value="Single">Single</option>
            <option value="Multiple">Multiple</option>
            <option value="First">First</option>
            <option value="Last">Last</option>
            <option value="Next">Next</option>
            <option value="Previous">Previous</option>
            <option value="Only">Only</option>
            <option value="Together">Together</option>
            <option value="Separate">Separate</option>
            <option value="Fast">Fast</option>
            <option value="Slow">Slow</option>
            <option value="Now">Now</option>
            <option value="Then">Then</option>
            <option value="Soon">Soon</option>
            <option value="Later">Later</option>
            <option value="Today">Today</option>
            <option value="Yesterday">Yesterday</option>
            <option value="Tomorrow">Tomorrow</option>
            <option value="Always">Always</option>
            <option value="Never">Never</option>
            <option value="Everywhere">Everywhere</option>
            <option value="Nowhere">Nowhere</option>
            <option value="Here">Here</option>
            <option value="There">There</option>
            <option value="Inside">Inside</option>
            <option value="Outside">Outside</option>
            <option value="Above">Above</option>
            <option value="Below">Below</option>
            <option value="Near">Near</option>
            <option value="Far">Far</option>
            <option value="Beside">Beside</option>
            <option value="Between">Between</option>
            <option value="Against">Against</option>
            <option value="Across">Across</option>
            <option value="Through">Through</option>
            <option value="Around">Around</option>
            <option value="Towards">Towards</option>
            <option value="Away">Away</option>
            <option value="Up">Up</option>
            <option value="Down">Down</option>
            <option value="Left">Left</option>
            <option value="Right">Right</option>
            <option value="Back">Back</option>
            <option value="Forward">Forward</option>
            <option value="Sideways">Sideways</option>
            <option value="Straight">Straight</option>
            <option value="Crooked">Crooked</option>
            <option value="Round">Round</option>
            <option value="Square">Square</option>
            <option value="Flat">Flat</option>
            <option value="Smooth">Smooth</option>
            <option value="Rough">Rough</option>
            <option value="Sharp">Sharp</option>
            <option value="Blunt">Blunt</option>
            <option value="Pointy">Pointy</option>
            <option value="Hollow">Hollow</option>
            <option value="Solid">Solid</option>
            <option value="Soft">Soft</option>
            <option value="Hard">Hard</option>
            <option value="Elastic">Elastic</option>
            <option value="Brittle">Brittle</option>
            <option value="Liquid">Liquid</option>
            <option value="Gas">Gas</option>
            <option value="Solid">Solid</option>
            <option value="Hot">Hot</option>
            <option value="Cold">Cold</option>
            <option value="Warm">Warm</option>
            <option value="Cool">Cool</option>
            <option value="Freezing">Freezing</option>
            <option value="Boiling">Boiling</option>
            <option value="Flammable">Flammable</option>
            <option value="Explosive">Explosive</option>
            <option value="Radioactive">Radioactive</option>
            <option value="Toxic">Toxic</option>
            <option value="Safe">Safe</option>
            <option value="Poisonous">Poisonous</option>
            <option value="Healthy">Healthy</option>
            <option value="Delicious">Delicious</option>
            <option value="Disgusting">Disgusting</option>
            <option value="Sweet">Sweet</option>
            <option value="Salty">Salty</option>
            <option value="Sour">Sour</option>
            <option value="Bitter">Bitter</option>
            <option value="Spicy">Spicy</option>
            <option value="Bland">Bland</option>
            <option value="Fresh">Fresh</option>
            <option value="Rotten">Rotten</option>
            <option value="Cooked">Cooked</option>
            <option value="Raw">Raw</option>
            <option value="Hungry">Hungry</option>
            <option value="Thirsty">Thirsty</option>
            <option value="Full">Full</option>
            <option value="Empty">Empty</option>
            <option value="Clean">Clean</option>
            <option value="Dirty">Dirty</option>
            <option value="Neat">Neat</option>
            <option value="Messy">Messy</option>
            <option value="Tidy">Tidy</option>
            <option value="Untidy">Untidy</option>
            <option value="Polished">Polished</option>
            <option value="Dusty">Dusty</option>
            <option value="Sticky">Sticky</option>
            <option value="Slippery">Slippery</option>
            <option value="Wet">Wet</option>
            <option value="Dry">Dry</option>
            <option value="Soft">Soft</option>
            <option value="Hard">Hard</option>
            <option value="Smooth">Smooth</option>
            <option value="Rough">Rough</option>
            <option value="Heavy">Heavy</option>
            <option value="Light">Light</option>
            <option value="Bright">Bright</option>
            <option value="Dim">Dim</option>
            <option value="Dark">Dark</option>
            <option value="Colorful">Colorful</option>
            <option value="Plain">Plain</option>
            <option value="Striped">Striped</option>
            <option value="Spotted">Spotted</option>
            <option value="Checkered">Checkered</option>
            <option value="Flowery">Flowery</option>
            <option value="Shiny">Shiny</option>
            <option value="Matt">Matt</option>
            <option value="Transparent">Transparent</option>
            <option value="Opaque">Opaque</option>
            <option value="Solid">Solid</option>
            <option value="Hollow">Hollow</option>
            <option value="Deep">Deep</option>
            <option value="Shallow">Shallow</option>
            <option value="Wide">Wide</option>
            <option value="Narrow">Narrow</option>
            <option value="Broad">Broad</option>
            <option value="Thin">Thin</option>
            <option value="Thick">Thick</option>
            <option value="Fat">Fat</option>
            <option value="Slim">Slim</option>
            <option value="Skinny">Skinny</option>
            <option value="Large">Large</option>
            <option value="Huge">Huge</option>
            <option value="Tiny">Tiny</option>
            <option value="Miniature">Miniature</option>
            <option value="Giant">Giant</option>
            <option value="Long">Long</option>
            <option value="Short">Short</option>
            <option value="Tall">Tall</option>
            <option value="Short">Short</option>
            <option value="High">High</option>
            <option value="Low">Low</option>
            <option value="Loud">Loud</option>
            <option value="Quiet">Quiet</option>
            <option value="Silent">Silent</option>
            <option value="Noisy">Noisy</option>
            <option value="Musical">Musical</option>
            <option value="Rhythmic">Rhythmic</option>
            <option value="Fast">Fast</option>
            <option value="Slow">Slow</option>
            <option value="Rapid">Rapid</option>
            <option value="Gradual">Gradual</option>
            <option value="Sudden">Sudden</option>
            <option value="Constant">Constant</option>
            <option value="Frequent">Frequent</option>
            <option value="Occasional">Occasional</option>
            <option value="Rare">Rare</option>
            <option value="Periodic">Periodic</option>
            <option value="Daily">Daily</option>
            <option value="Weekly">Weekly</option>
            <option value="Monthly">Monthly</option>
            <option value="Yearly">Yearly</option>
            <option value="Ancient">Ancient</option>
            <option value="Old">Old</option>
            <option value="Modern">Modern</option>
            <option value="Future">Future</option>
            <option value="Recent">Recent</option>
            <option value="Early">Early</option>
            <option value="Late">Late</option>
            <option value="Timely">Timely</option>
            <option value="Overdue">Overdue</option>
            <option value="Eternal">Eternal</option>
            <option value="Temporary">Temporary</option>
            <option value="Permanent">Permanent</option>
            <option value="Brief">Brief</option>
            <option value="Lasting">Lasting</option>
            <option value="Infinite">Infinite</option>
            <option value="Finite">Finite</option>
            <option value="Deadly">Deadly</option>
            <option value="Vital">Vital</option>
            <option value="Living">Living</option>
            <option value="Organic">Organic</option>
            <option value="Inorganic">Inorganic</option>
            <option value="Natural">Natural</option>
            <option value="Artificial">Artificial</option>
            <option value="Synthetic">Synthetic</option>
            <option value="Pure">Pure</option>
            <option value="Mixed">Mixed</option>
            <option value="Contaminated">Contaminated</option>
            <option value="Clean">Clean</option>
            <option value="Fresh">Fresh</option>
            <option value="Stale">Stale</option>
            <option value="Polluted">Polluted</option>
            <option value="Strong">Strong</option>
            <option value="Powerful">Powerful</option>
            <option value="Weak">Weak</option>
            <option value="Fragile">Fragile</option>
            <option value="Tough">Tough</option>
            <option value="Hardy">Hardy</option>
            <option value="Delicate">Delicate</option>
            <option value="Sturdy">Sturdy</option>
            <option value="Sharp">Sharp</option>
            <option value="Dull">Dull</option>
            <option value="Pointed">Pointed</option>
            <option value="Blunt">Blunt</option>
            <option value="Jagged">Jagged</option>
            <option value="Smooth">Smooth</option>
            <option value="Slippery">Slippery</option>
            <option value="Sticky">Sticky</option>
            <option value="Oily">Oily</option>
            <option value="Greasy">Greasy</option>
            <option value="Dry">Dry</option>
            <option value="Wet">Wet</option>
            <option value="Damp">Damp</option>
            <option value="Soaked">Soaked</option>
            <option value="Flooded">Flooded</option>
            <option value="Parched">Parched</option>
            <option value="Sandy">Sandy</option>
            <option value="Rocky">Rocky</option>
            <option value="Muddy">Muddy</option>
            <option value="Dusty">Dusty</option>
            <option value="Grassy">Grassy</option>
            <option value="Woody">Woody</option>
            <option value="Metallic">Metallic</option>
            <option value="Plastic">Plastic</option>
            <option value="Glassy">Glassy</option>
            <option value="Rubbery">Rubbery</option>
            <option value="Soft">Soft</option>
            <option value="Hard">Hard</option>
            <option value="Firm">Firm</option>
            <option value="Solid">Solid</option>
            <option value="Hollow">Hollow</option>
            <option value="Dense">Dense</option>
            <option value="Light">Light</option>
            <option value="Heavier">Heavier</option>
            <option value="Floaty">Floaty</option>
            <option value="Sinking">Sinking</option>
            <option value="Fast">Fast</option>
            <option value="Quick">Quick</option>
            <option value="Slow">Slow</option>
            <option value="Leisurely">Leisurely</option>
            <option value="Active">Active</option>
            <option value="Passive">Passive</option>
            <option value="Busy">Busy</option>
            <option value="Idle">Idle</option>
            <option value="Productive">Productive</option>
            <option value="Lazy">Lazy</option>
            <option value="Hardworking">Hardworking</option>
            <option value="Successful">Successful</option>
            <option value="Unsuccessful">Unsuccessful</option>
            <option value="Famous">Famous</option>
            <option value="Obscure">Obscure</option>
            <option value="Popular">Popular</option>
            <option value="Unpopular">Unpopular</option>
            <option value="Trendy">Trendy</option>
            <option value="Old-fashioned">Old-fashioned</option>
            <option value="Modern">Modern</option>
            <option value="Traditional">Traditional</option>
            <option value="Innovative">Innovative</option>
            <option value="Creative">Creative</option>
            <option value="Artistic">Artistic</option>
            <option value="Scientific">Scientific</option>
            <option value="Logical">Logical</option>
            <option value="Emotional">Emotional</option>
            <option value="Rational">Rational</option>
            <option value="Irrational">Irrational</option>
            <option value="Wise">Wise</option>
            <option value="Foolish">Foolish</option>
            <option value="Smart">Smart</option>
            <option value="Clever">Clever</option>
            <option value="Dull">Dull</option>
            <option value="Ignorant">Ignorant</option>
            <option value="Educated">Educated</option>
            <option value="Uneducated">Uneducated</option>
            <option value="Skilled">Skilled</option>
            <option value="Unskilled">Unskilled</option>
            <option value="Talented">Talented</option>
            <option value="Gifted">Gifted</option>
            <option value="Average">Average</option>
            <option value="Exceptional">Exceptional</option>
            <option value="Normal">Normal</option>
            <option value="Strange">Strange</option>
            <option value="Odd">Odd</option>
            <option value="Weird">Weird</option>
            <option value="Unique">Unique</option>
            <option value="Ordinary">Ordinary</option>
            <option value="Special">Special</option>
            <option value="Rare">Rare</option>
            <option value="Common">Common</option>
            <option value="Universal">Universal</option>
            <option value="Local">Local</option>
            <option value="Global">Global</option>
            <option value="International">International</option>
            <option value="National">National</option>
            <option value="Private">Private</option>
            <option value="Public">Public</option>
            <option value="Personal">Personal</option>
            <option value="Official">Official</option>
            <option value="Legal">Legal</option>
            <option value="Illegal">Illegal</option>
            <option value="Moral">Moral</option>
            <option value="Immoral">Immoral</option>
            <option value="Ethical">Ethical</option>
            <option value="Unethical">Unethical</option>
            <option value="Fair">Fair</option>
            <option value="Unfair">Unfair</option>
            <option value="Just">Just</option>
            <option value="Unjust">Unjust</option>
            <option value="Equal">Equal</option>
            <option value="Unequal">Unequal</option>
            <option value="Free">Free</option>
            <option value="Captive">Captive</option>
            <option value="Independent">Independent</option>
            <option value="Dependent">Dependent</option>
            <option value="Safe">Safe</option>
            <option value="Dangerous">Dangerous</option>
            <option value="Secure">Secure</option>
            <option value="Insecure">Insecure</option>
            <option value="Vulnerable">Vulnerable</option>
            <option value="Protected">Protected</option>
            <option value="Strong">Strong</option>
            <option value="Weak">Weak</option>
            <option value="Tough">Tough</option>
            <option value="Soft">Soft</option>
            <option value="Gentle">Gentle</option>
            <option value="Fierce">Fierce</option>
            <option value="Wild">Wild</option>
            <option value="Tame">Tame</option>
            <option value="Domestic">Domestic</option>
            <option value="Foreign">Foreign</option>
            <option value="Strange">Strange</option>
            <option value="Familiar">Familiar</option>
            <option value="Known">Known</option>
            <option value="Unknown">Unknown</option>
            <option value="Clear">Clear</option>
            <option value="Vague">Vague</option>
            <option value="Definite">Definite</option>
            <option value="Indefinite">Indefinite</option>
            <option value="Certain">Certain</option>
            <option value="Doubtful">Doubtful</option>
            <option value="Possible">Possible</option>
            <option value="Impossible">Impossible</option>
            <option value="Likely">Likely</option>
            <option value="Unlikely">Unlikely</option>
            <option value="True">True</option>
            <option value="False">False</option>
            <option value="Fact">Fact</option>
            <option value="Fiction">Fiction</option>
            <option value="Real">Real</option>
            <option value="Imaginary">Imaginary</option>
            <option value="Actual">Actual</option>
            <option value="Potential">Potential</option>
            <option value="Visible">Visible</option>
            <option value="Invisible">Invisible</option>
            <option value="Audible">Audible</option>
            <option value="Inaudible">Inaudible</option>
            <option value="Tangible">Tangible</option>
            <option value="Intangible">Intangible</option>
            <option value="Abstract">Abstract</option>
            <option value="Concrete">Concrete</option>
            <option value="Simple">Simple</option>
            <option value="Complex">Complex</option>
            <option value="Easy">Easy</option>
            <option value="Difficult">Difficult</option>
            <option value="Direct">Direct</option>
            <option value="Indirect">Indirect</option>
            <option value="Straight">Straight</option>
            <option value="Curved">Curved</option>
            <option value="Right">Right</option>
            <option value="Wrong">Wrong</option>
            <option value="Correct">Correct</option>
            <option value="Incorrect">Incorrect</option>
            <option value="Accurate">Accurate</option>
            <option value="Inaccurate">Inaccurate</option>
            <option value="Precise">Precise</option>
            <option value="Vague">Vague</option>
            <option value="Complete">Complete</option>
            <option value="Incomplete">Incomplete</option>
            <option value="Perfect">Perfect</option>
            <option value="Imperfect">Imperfect</option>
            <option value="Total">Total</option>
            <option value="Partial">Partial</option>
            <option value="Whole">Whole</option>
            <option value="Fragmented">Fragmented</option>
            <option value="Broken">Broken</option>
            <option value="Intact">Intact</option>
            <option value="Solid">Solid</option>
            <option value="Liquid">Liquid</option>
            <option value="Gas">Gas</option>
            <option value="Plasma">Plasma</option>
            <option value="Hard">Hard</option>
            <option value="Soft">Soft</option>
            <option value="Heavy">Heavy</option>
            <option value="Light">Light</option>
            <option value="Hot">Hot</option>
            <option value="Cold">Cold</option>
            <option value="Warm">Warm</option>
            <option value="Cool">Cool</option>
            <option value="Dry">Dry</option>
            <option value="Wet">Wet</option>
            <option value="Clean">Clean</option>
            <option value="Dirty">Dirty</option>
            <option value="Empty">Empty</option>
            <option value="Full">Full</option>
            <option value="Open">Open</option>
            <option value="Closed">Closed</option>
            <option value="Fast">Fast</option>
            <option value="Slow">Slow</option>
            <option value="Early">Early</option>
            <option value="Late">Late</option>
            <option value="Young">Young</option>
            <option value="Old">Old</option>
            <option value="New">New</option>
            <option value="Old">Old</option>
            <option value="Good">Good</option>
            <option value="Bad">Bad</option>
            <option value="Better">Better</option>
            <option value="Worse">Worse</option>
            <option value="Best">Best</option>
            <option value="Worst">Worst</option>
            <option value="First">First</option>
            <option value="Last">Last</option>
            <option value="High">High</option>
            <option value="Low">Low</option>
            <option value="Near">Near</option>
            <option value="Far">Far</option>
            <option value="Big">Big</option>
            <option value="Small">Small</option>
            <option value="Wide">Wide</option>
            <option value="Narrow">Narrow</option>
            <option value="Long">Long</option>
            <option value="Short">Short</option>
            <option value="Thick">Thick</option>
            <option value="Thin">Thin</option>
            <option value="Deep">Deep</option>
            <option value="Shallow">Shallow</option>
            <option value="Rich">Rich</option>
            <option value="Poor">Poor</option>
            <option value="Strong">Strong</option>
            <option value="Weak">Weak</option>
            <option value="Safe">Safe</option>
            <option value="Dangerous">Dangerous</option>
            <option value="True">True</option>
            <option value="False">False</option>
            <option value="Beautiful">Beautiful</option>
            <option value="Ugly">Ugly</option>
            <option value="Happy">Happy</option>
            <option value="Sad">Sad</option>
            <option value="Angry">Angry</option>
            <option value="Calm">Calm</option>
            <option value="Scared">Scared</option>
            <option value="Brave">Brave</option>
            <option value="Shy">Shy</option>
            <option value="Bold">Bold</option>
            <option value="Smart">Smart</option>
            <option value="Dull">Dull</option>
            <option value="Kind">Kind</option>
            <option value="Mean">Mean</option>
            <option value="Polite">Polite</option>
            <option value="Rude">Rude</option>
            <option value="Generous">Generous</option>
            <option value="Selfish">Selfish</option>
            <option value="Honest">Honest</option>
            <option value="Dishonest">Dishonest</option>
            <option value="Fair">Fair</option>
            <option value="Unfair">Unfair</option>
            <option value="Free">Free</option>
            <option value="Busy">Busy</option>
            <option value="Early">Early</option>
            <option value="Late">Late</option>
            <option value="Cheap">Cheap</option>
            <option value="Expensive">Expensive</option>
            <option value="Quiet">Quiet</option>
            <option value="Loud">Loud</option>
            <option value="Soft">Soft</option>
            <option value="Hard">Hard</option>
            <option value="Light">Light</option>
            <option value="Heavy">Heavy</option>
            <option value="Easy">Easy</option>
            <option value="Difficult">Difficult</option>
            <option value="Smooth">Smooth</option>
            <option value="Rough">Rough</option>
            <option value="Flat">Flat</option>
            <option value="Round">Round</option>
            <option value="Straight">Straight</option>
            <option value="Crooked">Crooked</option>
            <option value="Empty">Empty</option>
            <option value="Full">Full</option>
            <option value="Thin">Thin</option>
            <option value="Thick">Thick</option>
            <option value="Narrow">Narrow</option>
            <option value="Wide">Wide</option>
            <option value="Shallow">Shallow</option>
            <option value="Deep">Deep</option>
            <option value="Near">Near</option>
            <option value="Far">Far</option>
            <option value="Small">Small</option>
            <option value="Big">Big</option>
            <option value="Short">Short</option>
            <option value="Tall">Tall</option>
            <option value="Weak">Weak</option>
            <option value="Strong">Strong</option>
            <option value="Slow">Slow</option>
            <option value="Fast">Fast</option>
            <option value="Bad">Bad</option>
            <option value="Good">Good</option>
            <option value="Old">Old</option>
            <option value="New">New</option>
            <option value="Cold">Cold</option>
            <option value="Hot">Hot</option>
            <option value="Dry">Dry</option>
            <option value="Wet">Wet</option>
            <option value="Dark">Dark</option>
            <option value="Light">Light</option>
            <option value="Sad">Sad</option>
            <option value="Happy">Happy</option>
          </select>
          </select>
        </div>
      </div>
      <div id="response-box" class="response-box">
        <div class="box-label original">Original Text</div>
        <div id="original-text" class="box-content"></div>
        <div id="action-label" class="box-label action">AI Response</div>
        <div id="result-text" class="box-content"></div>
        <div class="box-footer">
          <button id="btn-apply-res" class="box-btn btn-apply">Apply</button>
          <button id="btn-copy-res" class="box-btn btn-cancel">Copy</button>
          <button id="btn-cancel-res" class="box-btn btn-cancel">Close</button>
        </div>

      </div>
    `;
  }

  _bindElements() {
    this.logo = this.shadow.getElementById("logo");
    this.panel = this.shadow.getElementById("panel");
    this.selectionLogo = this.shadow.getElementById("selection-logo");
    this.dialog = this.shadow.getElementById("dialog");
    this.responseBox = this.shadow.getElementById("response-box");
    this.status = this.shadow.getElementById("status-text");
    this.statusBox = this.shadow.getElementById("status-box");
    
    this.logo.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.expanded = !this.expanded;
      if (this.expanded) this._loadSettings();
      this.refresh();
    });

    this.shadow.getElementById("btn-settings").addEventListener("click", (e) => {
      e.stopPropagation();
      this.isDialogVisible = !this.isDialogVisible;
      this._updateDialogValues();
      this.refresh();
    });

    // Instant Auto-Save
    const selects = ["sel-speaking", "sel-translate", "sel-tone"];
    selects.forEach(id => {
      const el = this.shadow.getElementById(id);
      if (el) {
        el.addEventListener("change", async (e) => {
          const key = id.split("-")[1] === "speaking" ? "speakingLang" : 
                      id.split("-")[1] === "translate" ? "translateLang" : "tone";
          this.settings[key] = e.target.value;
          await chrome.storage.sync.set({ [key]: e.target.value });
          this._updateSettingsUI();
        });
      }
    });

    this.shadow.getElementById("btn-apply-res").addEventListener("click", (e) => {
      e.stopPropagation();
      if (this.pendingResult) {
        if (this.activeField) {
          NativeBridge.applyToElement(this.activeField.el, this.pendingResult);
        } else {
          // If no active field, try to find the WhatsApp input as a fallback
          const waInput = document.querySelector('div[contenteditable="true"][data-lexical-editor="true"]') || 
                          document.querySelector('footer div[contenteditable="true"]') || 
                          document.querySelector('#main div[contenteditable="true"]');
          if (waInput) {
            console.log("[Voca] Found WhatsApp fallback input", waInput);
            NativeBridge.applyToElement(waInput, this.pendingResult);
          } else {
            this._showStatus("No input field found to apply", 3000);
          }
        }
      }
      this.isResponseVisible = false;
      this.expanded = false;
      this.refresh();
    });

    this.shadow.getElementById("btn-cancel-res").addEventListener("click", (e) => {
      e.stopPropagation();
      this.isResponseVisible = false;
      this.refresh();
    });

    this.selectionLogo.addEventListener("mousedown", (e) => {
      // Prevent selection loss when clicking the logo
      e.preventDefault();
      e.stopPropagation();
    });

    this.selectionLogo.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this._translateSelection();
    });

    this.shadow.getElementById("btn-copy-res").addEventListener("click", (e) => {
      e.stopPropagation();
      const btn = this.shadow.getElementById("btn-copy-res");
      const text = this.shadow.getElementById("result-text").textContent;
      navigator.clipboard.writeText(text);
      
      const originalText = btn.textContent;
      btn.textContent = "Copied!";
      btn.classList.add("accent");
      
      setTimeout(() => {
        btn.textContent = originalText;
        btn.classList.remove("accent");
      }, 2000);
    });


    this.shadow.getElementById("btn-reply").addEventListener("click", (e) => { e.stopPropagation(); this.trigger("reply"); });
    this.shadow.getElementById("btn-fix").addEventListener("click", (e) => { e.stopPropagation(); this.trigger("grammar"); });
    this.shadow.getElementById("btn-improve").addEventListener("click", (e) => { e.stopPropagation(); this.trigger("improve"); });
    this.shadow.getElementById("btn-translate").addEventListener("click", (e) => { e.stopPropagation(); this.trigger("translate"); });

    // Anti-spam global click handler
    this.shadow.querySelectorAll(".action-btn").forEach(btn => {
      btn.addEventListener("mousedown", (e) => {
        if (this.inflight) {
          e.preventDefault();
          e.stopPropagation();
        }
      });
    });
    
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg.type === "voca:setting") {
        this.settings[msg.key] = msg.value;
        this._updateSettingsUI();
      }
    });
  }

  _updateDialogValues() {
    this.shadow.getElementById("sel-speaking").value = this.settings.speakingLang;
    this.shadow.getElementById("sel-translate").value = this.settings.translateLang;
    this.shadow.getElementById("sel-tone").value = this.settings.tone;
  }

  showSelectionLogo(selection) {
    if (!this.selectionLogo || !selection || selection.rangeCount === 0) return;
    try {
      const range = selection.getRangeAt(0);
      const rect = range.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) return;
      
      this.lastSelectionRect = rect;
      const top = Math.max(5, rect.top - 32);
      const left = Math.max(5, rect.left + rect.width / 2 - 12);
      
      this.selectionLogo.style.top = `${top}px`;
      this.selectionLogo.style.left = `${left}px`;
      this.selectionLogo.classList.add("visible");
      
      this.lastSelectedText = selection.toString().trim();
      this.lastSelectionRange = range.cloneRange();
    } catch (e) {
      console.warn("[Voca] Failed to position selection logo:", e);
    }
  }



  hideSelectionLogo() {
    if (this.selectionLogo) this.selectionLogo.classList.remove("visible");
  }

  async _translateSelection() {
    if (!this.selectionLogo) return;
    const text = this.lastSelectedText || window.getSelection().toString().trim();
    if (!text) return;

    this.selectionLogo.classList.add("breathing");
    
    this._safeSendMessage({
      type: "voca:request",
      text,
      mode: "translate",
      targetLang: this.settings.speakingLang,
      tone: "Professional"
    }, (res) => {
      this.selectionLogo.classList.remove("breathing");
      this.selectionLogo.classList.remove("visible");
      
      if (res?.result) {
        if (this.lastSelectionRange) {
          try {
            const range = this.lastSelectionRange;
            range.deleteContents();
            range.insertNode(document.createTextNode(res.result));
            window.getSelection().removeAllRanges();
          } catch(e) {
            console.error("[Voca] Could not replace selection inline:", e);
          }
        }
      } else if (res?.error) {
        console.error("[Voca] Translation error:", res.error);
      }
      this.refresh();
    });
  }

  _safeSendMessage(msg, cb) {
    if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.id) {
      try {
        chrome.runtime.sendMessage(msg, (res) => {
          if (chrome.runtime.lastError) {
            console.warn("[Voca] Runtime error:", chrome.runtime.lastError.message);
            if (cb) cb({ error: "Extension updated. Please refresh the page." });
            return;
          }
          if (cb) cb(res);
        });
      } catch (e) {
        console.warn("[Voca] Extension context invalidated:", e);
        if (cb) cb({ error: "Extension context invalidated. Please refresh the page." });
      }
    } else {
      console.warn("[Voca] Extension context not available.");
      if (cb) cb({ error: "Extension not available." });
    }
  }



  attach(field) {
    this.activeField = field;
    this.refresh();
  }

  refresh() {
    if (!this.logo || !this.panel) return;

    // Position Selection Result (when activeField is null)
    if (!this.activeField) {
      this.logo.classList.remove("visible");
      this.panel.classList.remove("visible");
      if (this.dialog) this.dialog.classList.remove("visible");
      
      if (this.isResponseVisible && this.responseBox && this.lastSelectionRect) {
        this.responseBox.classList.add("visible");
        const rect = this.lastSelectionRect;
        const respHeight = this.responseBox.offsetHeight || 250;
        
        // Dynamic positioning for selection response
        if (rect.top < respHeight + 50) {
          this.responseBox.style.top = `${rect.bottom + 10}px`;
          this.responseBox.style.bottom = 'auto';
        } else {
          this.responseBox.style.bottom = `${window.innerHeight - rect.top + 10}px`;
          this.responseBox.style.top = 'auto';
        }
        this.responseBox.style.left = `${Math.max(10, Math.min(rect.left, window.innerWidth - 320))}px`;
      } else if (this.responseBox) {
        this.responseBox.classList.remove("visible");
      }
      return;
    }
    
    const rect = this.activeField.el.getBoundingClientRect();
    const isFocused = this.activeField && (
      document.activeElement === this.activeField.el || 
      this.activeField.el.contains(document.activeElement)
    );

    if (rect.height === 0 || rect.width === 0 || !document.contains(this.activeField.el)) {
      this.activeField = null;
      this.refresh();
      return;
    }

    const shouldShowPanel = this.expanded || this.inflight;
    const logoSize = 24;
    const logoTop = rect.top - logoSize - 8;
    const logoLeft = rect.left;

    this.logo.style.top = `${Math.max(5, logoTop)}px`;
    this.logo.style.left = `${Math.max(5, logoLeft)}px`;
    this.logo.style.position = 'absolute';
    
    if (this.isTyping && !this.inflight && !this.expanded) {
      this.logo.classList.add("typing");
    } else {
      this.logo.classList.remove("typing");
    }
    
    if (this.inflight) {
      this.logo.classList.add("breathing");
      this.logo.classList.add("visible");
    } else {
      this.logo.classList.remove("breathing");
    }
    
    if (shouldShowPanel) {
      this.logo.classList.remove("visible");
      
      const panelHeight = this.panel.offsetHeight || 62; 
      const panelTop = logoTop - panelHeight + 4;
      const panelLeft = logoLeft;
      
      this.panel.style.top = `${Math.max(5, panelTop)}px`;
      this.panel.style.left = `${Math.max(5, panelLeft)}px`;
      this.panel.classList.add("visible");

      const btns = this.shadow.querySelectorAll(".action-btn");
      btns.forEach(b => b.disabled = this.inflight);

      if (this.isDialogVisible && this.dialog) {
        this.dialog.classList.add("visible");
        const dialogHeight = this.dialog.offsetHeight || 220;
        const spaceAbove = panelTop;
        
        if (spaceAbove < dialogHeight + 20) {
          // Show below if not enough space above
          this.dialog.style.top = `${panelTop + panelHeight + 10}px`;
          this.dialog.style.bottom = 'auto';
        } else {
          // Show above
          this.dialog.style.bottom = `${window.innerHeight - panelTop + 5}px`;
          this.dialog.style.top = 'auto';
        }
        this.dialog.style.left = `${Math.max(5, panelLeft)}px`;
      } else if (this.dialog) {
        this.dialog.classList.remove("visible");
      }

      if (this.isResponseVisible && this.responseBox) {
        this.responseBox.classList.add("visible");
        const respHeight = this.responseBox.offsetHeight || 280;
        const spaceAbove = panelTop;

        if (spaceAbove < respHeight + 20) {
          // Show below
          this.responseBox.style.top = `${panelTop + panelHeight + 10}px`;
          this.responseBox.style.bottom = 'auto';
        } else {
          // Show above
          this.responseBox.style.bottom = `${window.innerHeight - panelTop + 10}px`;
          this.responseBox.style.top = 'auto';
        }
        this.responseBox.style.left = `${Math.max(5, panelLeft)}px`;
        
        if (this.isReadOnlyResponse) this.responseBox.classList.add("read-only");
        else this.responseBox.classList.remove("read-only");
      } else if (this.responseBox) {
        this.responseBox.classList.remove("visible");
      }
    } else {
      const hasContent = this.activeField.getValue().trim().length > 0;
      
      const btnFix = this.shadow.getElementById("btn-fix");
      const btnImprove = this.shadow.getElementById("btn-improve");
      const btnTranslate = this.shadow.getElementById("btn-translate");
      const btnReply = this.shadow.getElementById("btn-reply");

      // Update button states - Logic fix: when input is empty, only reply is active
      if (btnFix) btnFix.disabled = this.inflight || !hasContent;
      if (btnImprove) btnImprove.disabled = this.inflight || !hasContent;
      if (btnTranslate) btnTranslate.disabled = this.inflight || !hasContent;
      // "Write Reply" is special: 
      // - If input has content, it acts on that content.
      // - If input is empty, it relies on conversation history.
      // Requirement: "when inout is empty then only write reply should be active"
      if (btnReply) {
        btnReply.disabled = this.inflight;
        // Make it visually pop if it's the "only" active one
        if (!hasContent) btnReply.classList.add("pulse-subtle");
        else btnReply.classList.remove("pulse-subtle");
      }

      const shouldShowLogo = (isFocused || this.inflight) && !this.expanded && !this.isResponseVisible;
      if (shouldShowLogo) {
        this.logo.classList.add("visible");
      } else {
        this.logo.classList.remove("visible");
      }
      this.panel.classList.remove("visible");
      if (this.dialog) this.dialog.classList.remove("visible");
      
      if (this.isResponseVisible && this.responseBox) {
        this.responseBox.classList.add("visible");
        const respHeight = this.responseBox.offsetHeight || 280;
        
        if (logoTop < respHeight + 20) {
          this.responseBox.style.top = `${logoTop + 40}px`;
          this.responseBox.style.bottom = 'auto';
        } else {
          this.responseBox.style.bottom = `${window.innerHeight - logoTop + 10}px`;
          this.responseBox.style.top = 'auto';
        }
        this.responseBox.style.left = `${Math.max(5, logoLeft)}px`;
        
        if (this.isReadOnlyResponse) this.responseBox.classList.add("read-only");
        else this.responseBox.classList.remove("read-only");
      } else if (this.responseBox) {
        this.responseBox.classList.remove("visible");
      }
    }
  }


  async trigger(mode) {
    if (this.inflight) return;
    
    let text = this.activeField ? this.activeField.getValue().trim() : "";
    let messages = [];

    // Try to scrape context
    messages = this._scrapeLinkedInContext();
    if (messages.length === 0) {
      messages = this._scrapeWhatsAppContext();
    }

    if (messages.length === 0 && !text) {
      this._showStatus("No context found", 2000);
      return;
    }
    
    // Only check length for grammar/improve/translate on the input field
    if (mode !== "reply" && text.length < CONSTANTS.MIN_LENGTH) {
      this._showStatus("Text too short", 2000);
      return;
    }

    this.inflight = true;
    this.isResponseVisible = false;
    this.isReadOnlyResponse = false;
    this.currentAction = mode;
    
    // Set loading state on the button
    const btnId = mode === "grammar" ? "btn-fix" : mode === "improve" ? "btn-improve" : mode === "translate" ? "btn-translate" : "btn-reply";
    const btn = this.shadow.getElementById(btnId);
    if (btn) {
      btn.dataset.originalText = btn.innerHTML;
      btn.innerHTML = `<span class="loading-dots"></span>`;
      btn.classList.add("loading");
    }

    // Lock all other action buttons
    const allBtns = this.shadow.querySelectorAll(".action-btn");
    allBtns.forEach(b => b.disabled = true);

    this.refresh();

    const requestType = mode === "reply" && messages.length > 0 ? "voca:auto-reply" : "voca:request";
    const payload = requestType === "voca:auto-reply" 
      ? { type: requestType, messages, tone: this.settings.tone }
      : { type: requestType, text, mode, targetLang: this.settings.speakingLang, tone: this.settings.tone };

    this._safeSendMessage(payload, (res) => {
      console.log('[Voca] AI response received:', res);
      this.inflight = false;
      
      // Restore buttons
      allBtns.forEach(b => b.disabled = false);
      
      const btn = this.shadow.getElementById(btnId);
      if (btn && btn.dataset.originalText) {
        btn.innerHTML = btn.dataset.originalText;
        btn.classList.remove("loading");
      }

      if (res?.result) {
        console.log('[Voca] Success! Result length:', res.result.length);
        this.pendingResult = res.result;
        this.isResponseVisible = true;
        
        // Update Action Label
        const actionMap = {
          "grammar": "Fixed Grammar",
          "improve": "Improved Content",
          "translate": "Translated Text",
          "reply": "Generated Reply"
        };
        const actionLabel = this.shadow.getElementById("action-label");
        if (actionLabel) actionLabel.textContent = actionMap[mode] || "AI Response";

        this.shadow.getElementById("original-text").textContent = text || (messages && messages.length > 0 ? messages[messages.length-1].text : "");
        this.shadow.getElementById("result-text").textContent = res.result;
      } else if (res?.error) {
        console.error('[Voca] AI Error:', res.error);
        this._showStatus(res.error, 5000);
        // Don't hide status box immediately if it's an error
      } else {
        if (this.statusBox) this.statusBox.style.display = "none";
      }
      this.refresh();
    });
  }


  _scrapeLinkedInContext() {
    // LinkedIn specific selector for message bubbles
    const bubbles = document.querySelectorAll(".msg-s-event-listitem__body");
    const msgs = Array.from(bubbles).slice(-5).map(b => {
      const isMe = b.closest(".msg-s-event-listitem--me") !== null;
      return { sender: isMe ? "Me" : "Them", text: b.innerText.trim() };
    });
    return msgs;
  }

  _scrapeWhatsAppContext() {
    // WhatsApp specific selectors for message bubbles
    const bubbles = document.querySelectorAll('.message-in, .message-out, [data-testid="msg-container"]');
    if (bubbles.length === 0) return [];
    
    // Get last 10 messages for better context
    const msgs = Array.from(bubbles).slice(-10).map(b => {
      const isMe = b.classList.contains("message-out"); 
      const textNode = b.querySelector(".copyable-text span") || 
                       b.querySelector("span[selectable]") || 
                       b.querySelector(".selectable-text") || 
                       b.querySelector('[data-testid="quoted-msg-text"]') ||
                       b;
      const text = textNode ? (textNode.innerText || textNode.textContent || "").trim() : "";
      return { role: isMe ? "assistant" : "user", content: text };
    }).filter(m => m.content && m.content.length > 1);
    
    return msgs;
  }

  _showStatus(msg, timeout) {
    if (!this.status || !this.statusBox) return;
    this.status.textContent = msg;
    this.statusBox.style.display = "block";
    this.status.classList.remove("loading-dots");
    
    if (timeout) {
      setTimeout(() => {
        if (this.status.textContent === msg) {
          this.statusBox.style.display = "none";
          this.status.textContent = "";
        }
      }, timeout);
    }
  }
}

// ─── Field Observer ──────────────────────────────────────────────────────────
class FieldObserver {
  constructor(el, host) {
    this.el = el;
    this.host = host;
    this._init();
  }

  _init() {
    this.el.addEventListener("focus", () => {
      this.host.attach(this);
    });
    this.el.addEventListener("input", () => {
      this.host.isTyping = true;
      if (this.host.typingTimeout) clearTimeout(this.host.typingTimeout);
      this.host.typingTimeout = setTimeout(() => {
        this.host.isTyping = false;
        this.host.refresh();
      }, 500); // Stop typing after 500ms of inactivity
      this.host.refresh();
    });
    
    const ro = new ResizeObserver(() => {
      if (this.host.activeField === this) this.host.refresh();
    });
    ro.observe(this.el);
  }

  getValue() {
    if (this.el.tagName === "TEXTAREA" || this.el.tagName === "INPUT") return this.el.value;
    return (this.el.innerText || this.el.textContent || "").replace(/\n/g, ' ').trim();
  }
}

// ─── Integration Manager ────────────────────────────────────────────────────
class IntegrationManager {
  constructor() {
    this.host = new UIHost();
    this.observers = new Map();
    this._start();
  }

  _start() {
    console.log("[Voca] Integration Manager active (Vertical UI)");
    this.scan();

    setInterval(() => this.scan(), CONSTANTS.SCAN_INTERVAL);

    new MutationObserver(() => this.scan()).observe(document.documentElement, {
      childList: true,
      subtree: true
    });

    document.addEventListener("focusin", (e) => {
      const target = this._findTarget(e.target);
      if (target) {
        this._monitor(target);
        this.host.attach(this.observers.get(target));
      }
    }, true);

    document.addEventListener("mousedown", (e) => {
      // 1. If clicked inside our shadow host, ignore
      if (this.host.container && this.host.container.contains(e.target)) return;
      
      // 2. If clicked an editable field, attach it but don't reset unless it's a different field
      const target = this._findTarget(e.target);
      if (target) {
        const obs = this.observers.get(target);
        if (obs) {
          if (this.host.activeField !== obs) {
             this.host.expanded = false;
             this.host.isDialogVisible = false;
             this.host.isResponseVisible = false;
          }
          this.host.attach(obs);
          return;
        }
      }

      // 3. Otherwise, if clicked outside everything, clear state
      this.host.expanded = false;
      this.host.isDialogVisible = false;
      this.host.isResponseVisible = false;
      this.host.activeField = null;
      this.host.hideSelectionLogo();
      this.host.refresh();
    }, true);

    document.addEventListener("mouseup", (e) => {
      if (this.host.container && this.host.container.contains(e.target)) return;
      
      setTimeout(() => {
        const selection = window.getSelection();
        const text = selection.toString().trim();
        const selectionNode = selection.anchorNode;
        const isSelectionInInput = this.host.activeField && 
                                   (this.host.activeField.el.contains(selectionNode) || 
                                    this.host.activeField.el === selectionNode);

        if (text && text.length >= CONSTANTS.MIN_LENGTH && !isSelectionInInput) {
          this.host.showSelectionLogo(selection);
        } else {
          this.host.hideSelectionLogo();
        }
      }, 10);
    }, true);

    window.addEventListener("scroll", () => this.host.refresh(), true);
    window.addEventListener("resize", () => this.host.refresh(), true);
  }

  _findTarget(el) {
    if (!el || !(el instanceof HTMLElement)) return null;
    if (this._isEditable(el)) return el;
    let parent = el.parentElement;
    for (let i=0; i<3 && parent; i++) {
      if (this._isEditable(parent)) return parent;
      parent = parent.parentElement;
    }
    return null;
  }

  scan() {
    this._deepScan(document.body);
  }

  _deepScan(root) {
    if (!root) return;
    const selector = 'textarea, [contenteditable="true"], [role="textbox"], input[type="text"]';
    root.querySelectorAll?.(selector).forEach(el => {
      if (this._isEditable(el)) this._monitor(el);
    });
    const all = root.querySelectorAll?.("*") || [];
    all.forEach(el => {
      if (el.shadowRoot) {
        this._deepScan(el.shadowRoot);
      }
    });
  }

  _isEditable(el) {
    if (!(el instanceof HTMLElement)) return false;
    if (el.hasAttribute(CONSTANTS.IGNORE_ATTR)) return false;
    if (el.closest("#voca-host")) return false;
    const role = el.getAttribute("role");
    const isCE = el.isContentEditable || el.getAttribute("contenteditable") === "true";
    const isInput = el.tagName === "TEXTAREA" || (el.tagName === "INPUT" && ["text", "search", "email", "url"].includes(el.type.toLowerCase()));
    return isCE || role === "textbox" || isInput;
  }

  _monitor(el) {
    if (this.observers.has(el)) return;
    if (el.hasAttribute(CONSTANTS.PROCESSED_ATTR)) return;
    el.setAttribute(CONSTANTS.PROCESSED_ATTR, "true");
    this.observers.set(el, new FieldObserver(el, this.host));
    console.log("[Voca] Monitoring new field:", el);
  }
}

if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.id) {
  if (!window._vocaInitialized) {
    window._vocaInitialized = true;
    const run = () => { if (document.body) new IntegrationManager(); };
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", run);
    } else {
      run();
    }
  }
}
