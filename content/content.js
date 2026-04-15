// content.js — Injected into web pages
// In-page translation panel with mode switching, intent detection, streaming, TTS

(function () {
  'use strict';

  // ═══ Constants ═══
  const MODES = { QUICK: 'quick', AGENT: 'agent', DEEP: 'deep' };
  const MODE_LABELS = {
    quick: { label: 'Quick' },
    agent: { label: 'Context' },
    deep:  { label: 'Deep' },
  };
  const INTENT_LABELS = {
    meaning: { label: 'Meaning' },
    grammar: { label: 'Grammar' },
  };

  // ═══ State ═══
  let panel = null;
  let triggerBtn = null;
  let port = null;
  let currentMode = MODES.AGENT;
  let currentIntent = null;
  let detectedIntent = null;
  let currentText = '';
  let isTranslating = false;
  let customShortcut = 'Alt+Shift+T';
  let _isFromBtn = false;
  let modeResults = {};  // cache: { mode: formattedHtml }
  let settings = {
    autoTranslate: true,
    showTriggerIcon: true,
    minSelectionLength: 1,
    maxSelectionLength: 1000,
    showCopyButton: true,
    bubblePosition: 'below',
    defaultMode: 'agent',
    intentMode: 'auto',
    targetLang: 'zh',
    hasLLM: false,
  };

  // ─── Init ───
  loadSettings();
  ensureVoices();

  function loadSettings() {
    chrome.storage.local.get([
      'autoTranslate', 'showTriggerIcon',
      'minSelectionLength', 'maxSelectionLength',
      'showCopyButton', 'bubblePosition', 'customShortcut',
      'defaultMode', 'intentMode', 'targetLang', 'llmApiKey',
    ], r => {
      Object.assign(settings, {
        autoTranslate:       r.autoTranslate ?? true,
        showTriggerIcon:     r.showTriggerIcon ?? true,
        minSelectionLength:  r.minSelectionLength || 1,
        maxSelectionLength:  r.maxSelectionLength || 1000,
        showCopyButton:      r.showCopyButton ?? true,
        bubblePosition:      r.bubblePosition || 'below',
        customShortcut:      r.customShortcut || 'Alt+Shift+T',
        defaultMode:         r.defaultMode || 'agent',
        intentMode:          r.intentMode || 'auto',
        targetLang:          r.targetLang || 'zh',
        hasLLM:              !!r.llmApiKey,
      });
      // Without LLM key, fall back to quick mode
      if (!settings.hasLLM && settings.defaultMode !== 'quick') {
        currentMode = MODES.QUICK;
      } else {
        currentMode = MODES[settings.defaultMode.toUpperCase()] || MODES.AGENT;
      }
    });
  }

  function ensureVoices() {
    if (!('speechSynthesis' in window)) return;
    // Force initial voice loading (first call often returns empty)
    speechSynthesis.getVoices();
    if (speechSynthesis.onvoiceschanged !== undefined) {
      speechSynthesis.onvoiceschanged = () => speechSynthesis.getVoices();
    }
  }

  // ─── Message from background / popup ───
  chrome.runtime.onMessage.addListener((msg, _s, send) => {
    switch (msg.type) {
      case 'SETTINGS_UPDATED':
        if (msg.settings) Object.assign(settings, msg.settings);
        loadSettings();
        send({ success: true });
        break;
      case 'TRANSLATE_TEXT':
        doTranslate(msg.text);
        send({ success: true });
        break;
      case 'GET_SELECTED_TEXT':
        send({ text: window.getSelection().toString().trim() });
        break;
      case 'TRIGGER_TRANSLATE': {
        const sel = window.getSelection().toString().trim();
        sel ? (doTranslate(sel), send({ success: true })) : send({ success: false });
        break;
      }
      case 'TTS_SPEAK': {
        speakText(msg.text, msg.lang, msg.rate, msg.voiceName);
        send({ success: true });
        break;
      }
      case 'TTS_STOP': {
        stopSpeaking();
        send({ success: true });
        break;
      }
      case 'KEYWORDS_UPDATED': {
        updateKeywordsDisplay(msg.keywords);
        send({ success: true });
        break;
      }
      default:
        send({ success: false });
    }
  });

  // ─── Selection handler ───
  document.addEventListener('mouseup', e => {
    // Ignore clicks inside panel/trigger — don't let selection-clear hide them
    if (panel?.contains(e.target) || triggerBtn?.contains(e.target)) return;
    setTimeout(() => {
      if (_isFromBtn) { _isFromBtn = false; return; }
      const sel = window.getSelection().toString().trim();
      if (sel.length < settings.minSelectionLength || sel.length > settings.maxSelectionLength) {
        hideTriggerBtn(); hidePanel(); return;
      }
      if (settings.autoTranslate) {
        showPanel(sel, e.pageX, e.pageY);
      } else if (settings.showTriggerIcon) {
        hidePanel();
        showTriggerBtn(sel, e.pageX, e.pageY);
      } else {
        hideAll();
      }
    }, 10);
  });

  document.addEventListener('mousedown', e => {
    if (panel?.contains(e.target) || triggerBtn?.contains(e.target)) return;
    hidePanel(); hideTriggerBtn();
  });

  // ─── Keyboard ───
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') { hideAll(); return; }
    if (matchShortcut(e, customShortcut)) {
      const sel = window.getSelection().toString().trim();
      if (sel) { e.preventDefault(); doTranslate(sel); }
    }
  });

  function matchShortcut(ev, str) {
    const parts = str.toUpperCase().split('+').map(s => s.trim());
    const need = { ctrl: parts.includes('CTRL'), alt: parts.includes('ALT'), shift: parts.includes('SHIFT') };
    const has  = { ctrl: ev.ctrlKey || ev.metaKey, alt: ev.altKey, shift: ev.shiftKey };
    if (need.ctrl !== has.ctrl || need.alt !== has.alt || need.shift !== has.shift) return false;
    const key = parts.find(p => !['CTRL','ALT','SHIFT','CMD','META'].includes(p));
    if (!key) return false;
    const ek = ev.key === ' ' ? 'SPACE' : ev.key;
    return ek.toUpperCase() === key;
  }

  // ════════════════════════════════════════
  //  Trigger Button
  // ════════════════════════════════════════
  function showTriggerBtn(text, x, y) {
    hideTriggerBtn();
    triggerBtn = document.createElement('div');
    triggerBtn.className = 'at-trigger-btn';
    triggerBtn.textContent = 'T';
    triggerBtn.title = 'Click to translate';

    let px = x + 8, py = y + 8;
    const mxW = window.innerWidth + window.scrollX, mxH = window.innerHeight + window.scrollY;
    if (px + 32 > mxW - 5) px = mxW - 37;
    if (py + 32 > mxH - 5) py = y - 40;
    triggerBtn.style.left = px + 'px';
    triggerBtn.style.top = py + 'px';
    document.body.appendChild(triggerBtn);

    const h = e => { e.stopPropagation(); e.preventDefault(); _isFromBtn = true; hideTriggerBtn(); doTranslate(text, px, py); };
    triggerBtn.addEventListener('mousedown', h);
    triggerBtn.addEventListener('click', h);
  }

  function hideTriggerBtn() {
    if (triggerBtn) { triggerBtn.remove(); triggerBtn = null; }
  }

  // ════════════════════════════════════════
  //  Translation Panel
  // ════════════════════════════════════════
  function doTranslate(text, x, y) {
    if (!x || !y) {
      try {
        const r = window.getSelection().getRangeAt(0).getBoundingClientRect();
        x = r.left + r.width / 2 + window.scrollX;
        y = r.bottom + window.scrollY + 5;
      } catch { x = 200; y = 200; }
    }
    showPanel(text, x, y);
  }

  function showPanel(text, x, y) {
    hidePanel();
    currentText = text;
    currentIntent = null;
    detectedIntent = null;
    isTranslating = false;
    modeResults = {};
    stopSpeaking();

    // Decide initial mode
    if (!settings.hasLLM && settings.defaultMode !== 'quick') {
      currentMode = MODES.QUICK;
    } else {
      currentMode = MODES[settings.defaultMode.toUpperCase()] || MODES.AGENT;
    }

    panel = document.createElement('div');
    panel.className = 'at-panel';

    // Mode tabs
    const modeTabs = Object.entries(MODE_LABELS).map(([k, v]) =>
      `<button class="at-mode-tab ${currentMode === k ? 'at-active' : ''}" data-mode="${k}">${v.label}</button>`
    ).join('');

    // Intent row: auto-badge or manual-switch
    const intentRow = settings.intentMode === 'manual'
      ? `<div class="at-intent-switch">
           <span class="at-intent-tag at-active" data-intent="meaning">${INTENT_LABELS.meaning.label}</span>
           <span class="at-intent-tag" data-intent="grammar">${INTENT_LABELS.grammar.label}</span>
         </div>`
      : `<span class="at-intent-badge at-hidden"></span>`;

    panel.innerHTML = `
      <div class="at-panel-header">
        <span class="at-title">Awesome Translator</span>
        <button class="at-close-btn">&times;</button>
      </div>
      <div class="at-mode-tabs">${modeTabs}</div>
      <div class="at-intent-row ${currentMode === MODES.QUICK ? 'at-hidden' : ''}">${intentRow}</div>
      <div class="at-keywords-bar" id="atKeywordsBar">
        <span class="at-keywords-label">Domain</span>
        <span class="at-keywords-empty">translating...</span>
      </div>
      <div class="at-panel-body">
        <div class="at-result"></div>
      </div>
      <div class="at-panel-actions">
        ${settings.showCopyButton ? '<button class="at-action-btn at-copy-btn" title="Copy">Copy</button>' : ''}
        <button class="at-action-btn at-tts-btn" title="Read aloud">Speak</button>
        <button class="at-action-btn at-tts-stop-btn at-hidden" title="Stop">Stop</button>
      </div>
    `;

    const pos = calcPos(x, y);
    panel.style.left = pos.x + 'px';
    panel.style.top = pos.y + 'px';
    document.body.appendChild(panel);

    // Bind events
    panel.querySelector('.at-close-btn').addEventListener('click', hidePanel);
    panel.querySelectorAll('.at-mode-tab').forEach(t =>
      t.addEventListener('click', () => switchMode(t.dataset.mode))
    );
    if (settings.intentMode === 'manual') {
      panel.querySelectorAll('.at-intent-tag').forEach(t =>
        t.addEventListener('click', () => switchIntent(t.dataset.intent))
      );
    }
    panel.querySelector('.at-copy-btn')?.addEventListener('click', copyResult);
    panel.querySelector('.at-tts-btn').addEventListener('click', () => speakOriginal(text));
    panel.querySelector('.at-tts-stop-btn').addEventListener('click', stopSpeaking);

    // Start translation
    requestTranslation();
  }

  function hidePanel() {
    disconnectPort();
    stopSpeaking();
    if (panel) { panel.remove(); panel = null; }
    isTranslating = false;
    currentIntent = null;
    detectedIntent = null;
  }

  function updateKeywordsDisplay(keywords) {
    const bar = panel?.querySelector('#atKeywordsBar');
    if (!bar) return;
    if (!keywords || keywords.length === 0) {
      bar.innerHTML = '<span class="at-keywords-label">Domain</span><span class="at-keywords-empty">accumulating...</span>';
      return;
    }
    const tagsHtml = keywords.map((kw, i) =>
      `<span class="at-keyword-tag at-kw-rank-${i}" data-keyword="${escapeHtml(kw)}" title="Click to boost relevance">${escapeHtml(kw)}</span>`
    ).join('');
    bar.innerHTML = `<span class="at-keywords-label">Domain</span>${tagsHtml}`;
    bar.querySelectorAll('.at-keyword-tag').forEach(tag => {
      tag.addEventListener('click', () => promoteKeyword(tag.dataset.keyword));
    });
  }

  function promoteKeyword(keyword) {
    if (!keyword) return;
    chrome.runtime.sendMessage({ type: 'PROMOTE_KEYWORD', keyword }, resp => {
      if (resp?.success && resp.data?.keywords) {
        updateKeywordsDisplay(resp.data.keywords);
      }
    });
  }

  function switchMode(mode) {
    if (isTranslating) return;
    currentMode = mode;
    panel.querySelectorAll('.at-mode-tab').forEach(t =>
      t.classList.toggle('at-active', t.dataset.mode === mode)
    );
    panel.querySelector('.at-intent-row')?.classList.toggle('at-hidden', mode === MODES.QUICK);

    const resultEl = panel.querySelector('.at-result');

    // Show cached result if available
    if (modeResults[mode]) {
      resultEl.innerHTML = modeResults[mode];
      resultEl.className = 'at-result';
    } else {
      resultEl.innerHTML = '';
      requestTranslation();
      return;
    }

    currentIntent = null;
    detectedIntent = null;
    if (settings.intentMode === 'auto') {
      const badge = panel.querySelector('.at-intent-badge');
      if (badge) badge.classList.add('at-hidden');
    }

    // Reset manual intent selection
    if (settings.intentMode === 'manual') {
      panel.querySelectorAll('.at-intent-tag').forEach(t =>
        t.classList.toggle('at-active', t.dataset.intent === 'meaning')
      );
    }
  }

  function switchIntent(intent) {
    if (isTranslating) return;
    currentIntent = intent;
    panel.querySelectorAll('.at-intent-tag').forEach(t =>
      t.classList.toggle('at-active', t.dataset.intent === intent)
    );
    const resultEl = panel.querySelector('.at-result');
    if (resultEl) resultEl.innerHTML = '';
    requestTranslation();
  }

  // ─── Request translation ───
  function requestTranslation() {
    const resultEl = panel?.querySelector('.at-result');
    if (!resultEl || !currentText) return;

    disconnectPort();
    isTranslating = true;
    resultEl.innerHTML = '<span class="at-loading">Translating…</span>';

    if (currentMode === MODES.QUICK) {
      // Non-streaming via sendMessage
      chrome.runtime.sendMessage({
        type: 'GET_TRANSLATION',
        text: currentText,
        targetLang: settings.targetLang,
      }, resp => {
        isTranslating = false;
        if (!resultEl.isConnected) return;
        if (resp?.success) {
          resultEl.textContent = resp.data.translatedText;
          modeResults[MODES.QUICK] = resultEl.innerHTML;
        } else {
          resultEl.innerHTML = `<span class="at-error">${escapeHtml(resp?.error || 'Translation failed')}</span>`;
        }
      });
    } else {
      // Streaming via port
      port = chrome.runtime.connect({ name: 'translation' });
      let full = '';

      port.onMessage.addListener(msg => {
        if (!resultEl.isConnected) { disconnectPort(); return; }

        switch (msg.type) {
          case 'intent':
            detectedIntent = msg.intent;
            if (settings.intentMode === 'auto') {
              const badge = panel.querySelector('.at-intent-badge');
              if (badge) {
                const info = INTENT_LABELS[msg.intent];
                badge.textContent = info.label;
                badge.classList.remove('at-hidden');
              }
            }
            if (!currentIntent) currentIntent = msg.intent;
            break;

          case 'chunk':
            if (resultEl.querySelector('.at-loading')) resultEl.innerHTML = '';
            full += msg.content;
            resultEl.innerHTML = formatContent(full);
            resultEl.className = 'at-result at-streaming';
            resultEl.scrollTop = resultEl.scrollHeight;
            break;

          case 'result':
            resultEl.textContent = msg.content;
            full = msg.content;
            modeResults[currentMode] = resultEl.innerHTML;
            break;

          case 'done':
            isTranslating = false;
            resultEl.innerHTML = formatContent(msg.content || full);
            resultEl.className = 'at-result';
            modeResults[currentMode] = resultEl.innerHTML;
            if (msg.keywords) updateKeywordsDisplay(msg.keywords);
            break;

          case 'error':
            isTranslating = false;
            resultEl.innerHTML = `<span class="at-error">${escapeHtml(msg.error)}</span>`;
            resultEl.className = 'at-result';
            break;
        }
      });

      port.onDisconnect.addListener(() => { isTranslating = false; port = null; });

      port.postMessage({
        action: 'translate',
        text: currentText,
        mode: currentMode,
        intent: currentIntent || undefined,
        targetLang: settings.targetLang,
      });
    }
  }

  function disconnectPort() {
    if (port) { try { port.disconnect(); } catch {} port = null; }
  }

  // ─── Format content (markdown + Terms section) ───
  function formatContent(text) {
    let html = text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/^## (.+)$/gm, '<div class="at-h2">$1</div>')
      .replace(/^### (.+)$/gm, '<div class="at-h3">$1</div>')
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\n/g, '<br>');

    // Render **Terms** section as a styled card
    html = html.replace(
      /(<strong>Terms<\/strong><br>)([\s\S]*?)(?=<br><br>|<br><strong>|$)/,
      (_, header, body) => {
        const items = body
          .split(/<br>\s*/)
          .map(line => line.trim())
          .filter(line => line && line.startsWith('1.') || line.startsWith('2.') || line.startsWith('3.') || line.startsWith('4.') || line.startsWith('5.'))
          .map(line => `<div class="at-term-item">${line.replace(/^\d+\.\s*/, '')}</div>`)
          .join('');
        return items
          ? `${header}<div class="at-terms-card">${items}</div>`
          : header;
      }
    );

    return html;
  }

  // ════════════════════════════════════════
  //  TTS (Web Speech API)
  // ════════════════════════════════════════
  function speakText(text, lang, rate, voiceName) {
    if (!('speechSynthesis' in window)) return;
    stopSpeaking();
    const utt = new SpeechSynthesisUtterance(text);
    utt.lang = lang || 'en-US';
    utt.rate = rate ? parseFloat(rate) : 1;
    const voices = speechSynthesis.getVoices();
    if (voiceName) {
      const named = voices.find(v => v.name === voiceName);
      if (named) utt.voice = named;
    }
    if (!utt.voice) {
      const google = voices.find(v => v.lang.startsWith('en') && /google/i.test(v.name));
      if (google) utt.voice = google;
    }
    speechSynthesis.speak(utt);
  }

  function speakOriginal(text) {
    if (!('speechSynthesis' in window)) return;
    stopSpeaking();

    const utt = new SpeechSynthesisUtterance(text);
    utt.lang = 'en-US';
    utt.rate = 1;

    // Prefer Google English voice
    const voices = speechSynthesis.getVoices();
    const google = voices.find(v => v.lang.startsWith('en') && /google/i.test(v.name));
    if (google) utt.voice = google;

    utt.onstart = () => {
      panel?.querySelector('.at-tts-btn')?.classList.add('at-hidden');
      panel?.querySelector('.at-tts-stop-btn')?.classList.remove('at-hidden');
    };
    utt.onend = utt.onerror = () => {
      panel?.querySelector('.at-tts-btn')?.classList.remove('at-hidden');
      panel?.querySelector('.at-tts-stop-btn')?.classList.add('at-hidden');
    };

    speechSynthesis.speak(utt);
  }

  function stopSpeaking() {
    if ('speechSynthesis' in window) speechSynthesis.cancel();
    panel?.querySelector('.at-tts-btn')?.classList.remove('at-hidden');
    panel?.querySelector('.at-tts-stop-btn')?.classList.add('at-hidden');
  }

  // ════════════════════════════════════════
  //  Actions
  // ════════════════════════════════════════
  function copyResult() {
    const el = panel?.querySelector('.at-result');
    if (!el) return;
    navigator.clipboard.writeText(el.textContent || el.innerText).then(() => {
      const btn = panel.querySelector('.at-copy-btn');
      if (btn) { btn.textContent = 'Done'; setTimeout(() => { btn.textContent = 'Copy'; }, 1500); }
    });
  }

  // ════════════════════════════════════════
  //  Helpers
  // ════════════════════════════════════════
  function hideAll() { hidePanel(); hideTriggerBtn(); }

  function calcPos(x, y) {
    // x, y are page-relative (already include scrollX/scrollY)
    const pw = 380, ph = 300;
    const viewBottom = window.scrollY + window.innerHeight;
    const viewRight = window.scrollX + window.innerWidth;
    let px = Math.max(window.scrollX + 5, Math.min(x - pw / 2, viewRight - pw - 10));
    let py = y + 15;
    if (settings.bubblePosition === 'above' || (py + ph > viewBottom)) {
      py = Math.max(window.scrollY + 5, y - ph - 10);
    }
    return { x: px, y: py };
  }

  function escapeHtml(text) {
    const d = document.createElement('div');
    d.textContent = text;
    return d.innerHTML;
  }
})();
