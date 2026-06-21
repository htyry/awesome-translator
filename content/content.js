// content.js — Injected into web pages
// In-page translation panel with mode switching, intent detection, streaming, TTS
// Plus Explain mode with conversation history and thinking display

(async function () {
  'use strict';

  // ═══ Shared imports ═══
  const { escapeHtml, formatContent, buildMetaHtml } = await import(chrome.runtime.getURL('lib/ui-utils.js'));

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
  let toolbar = null;
  let port = null;
  let explainPort = null;
  let currentMode = MODES.AGENT;
  let currentIntent = null;
  let detectedIntent = null;
  let currentText = '';
  let isTranslating = false;
  let customShortcut = 'Alt+Shift+T';
  let _isFromToolbar = false;
  let modeResults = {};  // cache: { mode: formattedHtml }

  // Explain state
  let explainPanel = null;
  let explainConversation = []; // { role, content } pairs
  let explainThinking = '';
  let isExplaining = false;

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
    explainEnabled: true,
    explainThinkingMode: false,
  };

  // ─── Init ───
  loadSettings();
  ensureVoices();

  function loadSettings() {
    chrome.storage.local.get([
      'autoTranslate', 'showTriggerIcon',
      'minSelectionLength', 'maxSelectionLength',
      'showCopyButton', 'bubblePosition', 'customShortcut',
      'defaultMode', 'intentMode', 'targetLang',
      'explainEnabled', 'explainThinkingMode',
      'llmEndpoints',
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
        explainEnabled:      r.explainEnabled ?? true,
        explainThinkingMode: r.explainThinkingMode ?? false,
      });
      // Check if any LLM endpoint is configured (same get call, no nesting)
      const endpoints = r.llmEndpoints || [];
      settings.hasLLM = endpoints.some(e => e.apiKey);
      if (!settings.hasLLM && settings.defaultMode !== 'quick') {
        currentMode = MODES.QUICK;
      } else {
        currentMode = MODES[settings.defaultMode.toUpperCase()] || MODES.AGENT;
      }
    });
  }

  function ensureVoices() {
    if (!('speechSynthesis' in window)) return;
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
    // Ignore clicks inside panel/toolbar/explainPanel
    if (panel?.contains(e.target) || toolbar?.contains(e.target) || explainPanel?.contains(e.target)) return;
    const cx = e.clientX, cy = e.clientY;
    setTimeout(() => {
      if (_isFromToolbar) { _isFromToolbar = false; return; }
      const sel = window.getSelection().toString().trim();
      if (sel.length < settings.minSelectionLength || sel.length > settings.maxSelectionLength) {
        hideToolbar(); hidePanel(); hideExplainPanel(); return;
      }
      // If explain is enabled, always show floating toolbar (Translate + optional Explain)
      // hasLLM only controls whether the Explain button appears, not the toolbar itself
      if (settings.explainEnabled) {
        hidePanel();
        hideExplainPanel();
        showToolbar(sel, cx, cy);
      } else if (settings.autoTranslate) {
        showPanel(sel, cx, cy);
      } else if (settings.showTriggerIcon) {
        hidePanel();
        showToolbar(sel, cx, cy);
      } else {
        hideAll();
      }
    }, 10);
  });

  document.addEventListener('mousedown', e => {
    if (panel?.contains(e.target) || toolbar?.contains(e.target) || explainPanel?.contains(e.target)) return;
    hidePanel(); hideToolbar(); hideExplainPanel();
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
  //  Floating Toolbar (Translate + Explain)
  // ════════════════════════════════════════
  function showToolbar(text, x, y) {
    hideToolbar();
    toolbar = document.createElement('div');
    toolbar.className = 'at-floating-toolbar';

    // Translate icon button
    const translateBtn = document.createElement('button');
    translateBtn.className = 'at-toolbar-btn at-toolbar-translate';
    translateBtn.title = 'Translate';
    translateBtn.innerHTML = '<span class="at-toolbar-icon">T</span><span class="at-toolbar-label">Translate</span>';
    translateBtn.addEventListener('mousedown', e => {
      e.stopPropagation(); e.preventDefault();
      _isFromToolbar = true;
      hideToolbar();
      doTranslate(text, x, y);
    });

    toolbar.appendChild(translateBtn);

    // Explain icon button (only if LLM is available)
    if (settings.hasLLM) {
      const explainBtn = document.createElement('button');
      explainBtn.className = 'at-toolbar-btn at-toolbar-explain';
      explainBtn.title = 'Explain';
      explainBtn.innerHTML = '<span class="at-toolbar-icon">E</span><span class="at-toolbar-label">Explain</span>';
      explainBtn.addEventListener('mousedown', e => {
        e.stopPropagation(); e.preventDefault();
        _isFromToolbar = true;
        hideToolbar();
        doExplain(text, x, y);
      });
      toolbar.appendChild(explainBtn);
    }

    // Position near selection
    let px = x + 8, py = y + 8;
    const tbWidth = settings.hasLLM ? 160 : 100;
    if (px + tbWidth > window.innerWidth - 5) px = window.innerWidth - tbWidth - 10;
    if (py + 36 > window.innerHeight - 5) py = y - 44;
    toolbar.style.left = px + 'px';
    toolbar.style.top = py + 'px';

    document.body.appendChild(toolbar);
  }

  function hideToolbar() {
    if (toolbar) { toolbar.remove(); toolbar = null; }
  }

  // ════════════════════════════════════════
  //  Translation Panel
  // ════════════════════════════════════════
  function doTranslate(text, x, y) {
    if (!x || !y) {
      try {
        const r = window.getSelection().getRangeAt(0).getBoundingClientRect();
        x = r.left + r.width / 2;
        y = r.bottom + 5;
      } catch { x = 200; y = 200; }
    }
    showPanel(text, x, y);
  }

  function showPanel(text, x, y) {
    hidePanel();
    hideExplainPanel();
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
        <div class="at-request-meta at-hidden"></div>
      </div>
      <div class="at-panel-actions">
        ${settings.showCopyButton ? '<button class="at-action-btn at-copy-btn" title="Copy">Copy</button>' : ''}
        <button class="at-action-btn at-tts-btn" title="Read aloud">Speak</button>
        <button class="at-action-btn at-tts-stop-btn at-hidden" title="Stop">Stop</button>
      </div>
    `;

    const pos = calcPos(x, y, null);
    panel.style.left = pos.x + 'px';
    panel.style.top = pos.y + 'px';
    document.body.appendChild(panel);

    // Reposition after render so we use actual panel height
    const pos2 = calcPos(x, y, panel);
    if (pos2.y !== pos.y) panel.style.top = pos2.y + 'px';

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

    // Make panel draggable via header
    enableDrag(panel, panel.querySelector('.at-panel-header'));

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
    const refreshBtn = '<span class="at-keywords-refresh" title="Force refresh keywords" id="atKwRefresh">&#x21bb;</span>';
    if (!keywords || keywords.length === 0) {
      bar.innerHTML = '<span class="at-keywords-label">Domain</span><span class="at-keywords-empty">accumulating...</span>' + refreshBtn;
      bar.querySelector('#atKwRefresh')?.addEventListener('click', forceRefreshKeywords);
      return;
    }
    const tagsHtml = keywords.map((kw, i) => {
      const label = typeof kw === 'string' ? kw : (kw.translated || kw.original);
      const original = typeof kw === 'string' ? kw : kw.original;
      return `<span class="at-keyword-tag at-kw-rank-${i}" data-keyword="${escapeHtml(original)}" title="Click to boost relevance">${escapeHtml(label)}</span>`;
    }).join('');
    bar.innerHTML = `<span class="at-keywords-label">Domain</span>${tagsHtml}${refreshBtn}`;
    bar.querySelectorAll('.at-keyword-tag').forEach(tag => {
      tag.addEventListener('click', () => promoteKeyword(tag.dataset.keyword));
    });
    bar.querySelector('#atKwRefresh')?.addEventListener('click', forceRefreshKeywords);
  }

  function promoteKeyword(keyword) {
    if (!keyword) return;
    chrome.runtime.sendMessage({ type: 'PROMOTE_KEYWORD', keyword }, resp => {
      if (resp?.success && resp.data?.keywords) {
        updateKeywordsDisplay(resp.data.keywords);
        if (currentText && !isTranslating) {
          modeResults[currentMode] = null;
          requestTranslation();
        }
      }
    });
  }

  function forceRefreshKeywords() {
    if (!panel || isTranslating) return;
    const refreshEl = panel.querySelector('#atKwRefresh');
    if (refreshEl) refreshEl.textContent = '...';
    chrome.runtime.sendMessage({ type: 'FORCE_UPDATE_KEYWORDS' }, resp => {
      if (resp?.success && resp.data?.keywords) {
        updateKeywordsDisplay(resp.data.keywords);
        if (currentText && !isTranslating) {
          modeResults[currentMode] = null;
          requestTranslation();
        }
      } else {
        if (refreshEl) refreshEl.innerHTML = '&#x21bb;';
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
            if (resultEl.querySelector('.at-loading')) resultEl.textContent = '';
            full += msg.content;
            // Use textContent during streaming for O(1) per-chunk performance
            resultEl.textContent = full;
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
            showRequestMeta(panel, msg.meta, true);
            break;

          case 'error':
            isTranslating = false;
            resultEl.innerHTML = `<span class="at-error">${escapeHtml(msg.error)}</span>`;
            resultEl.className = 'at-result';
            showRequestMeta(panel, msg.meta, false);
            break;

          case 'retry':
            resultEl.innerHTML = `<span class="at-retrying">Retrying (${msg.attempt})...</span>`;
            resultEl.className = 'at-result at-retrying-state';
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

  // ════════════════════════════════════════
  //  Explain Panel
  // ════════════════════════════════════════
  function doExplain(text, x, y) {
    if (!x || !y) {
      try {
        const r = window.getSelection().getRangeAt(0).getBoundingClientRect();
        x = r.left + r.width / 2;
        y = r.bottom + 5;
      } catch { x = 200; y = 200; }
    }
    showExplainPanel(text, x, y);
  }

  function showExplainPanel(text, x, y) {
    hidePanel();
    hideExplainPanel();
    currentText = text;
    explainConversation = [];
    explainThinking = '';
    isExplaining = false;

    // Clear previous explain history on background side to avoid cross-text contamination
    chrome.runtime.sendMessage({ type: 'CLEAR_EXPLAIN_HISTORY' }, () => {
      void chrome.runtime.lastError;
    });

    explainPanel = document.createElement('div');
    explainPanel.className = 'at-panel at-explain-panel';

    // Build panel HTML
    explainPanel.innerHTML = `
      <div class="at-panel-header">
        <span class="at-title">Explain</span>
        <div class="at-explain-header-actions">
          <button class="at-action-btn at-explain-clear-btn" title="Clear conversation">Clear</button>
          <button class="at-close-btn">&times;</button>
        </div>
      </div>
      <div class="at-explain-source" id="atExplainSource">
        <div class="at-explain-source-toggle" id="atSourceToggle">
          <span class="at-explain-source-arrow">&#9660;</span>
          <span class="at-explain-source-label">Selected Text</span>
        </div>
        <div class="at-explain-source-text" id="atSourceText">${escapeHtml(text)}</div>
      </div>
      <div class="at-explain-body" id="atExplainBody">
        <div class="at-explain-messages" id="atExplainMessages"></div>
      </div>
      <div class="at-explain-input-area">
        <div class="at-explain-input-row">
          <input type="text" class="at-explain-input" id="atExplainInput" placeholder="Type your question, or press Enter for default explanation..." />
          <button class="at-explain-send-btn" id="atExplainSendBtn" title="Send">&#10148;</button>
        </div>
      </div>
    `;

    const pos = calcPos(x, y, null);
    explainPanel.style.left = pos.x + 'px';
    explainPanel.style.top = pos.y + 'px';
    document.body.appendChild(explainPanel);

    const pos2 = calcPos(x, y, explainPanel);
    if (pos2.y !== pos.y) explainPanel.style.top = pos2.y + 'px';

    // Bind events
    explainPanel.querySelector('.at-close-btn').addEventListener('click', hideExplainPanel);
    explainPanel.querySelector('.at-explain-clear-btn').addEventListener('click', clearExplainConversation);

    // Source text toggle
    const sourceToggle = explainPanel.querySelector('#atSourceToggle');
    sourceToggle.addEventListener('click', () => {
      const sourceText = explainPanel.querySelector('#atSourceText');
      const arrow = sourceToggle.querySelector('.at-explain-source-arrow');
      const isCollapsed = sourceText.classList.toggle('at-explain-collapsed');
      arrow.innerHTML = isCollapsed ? '&#9654;' : '&#9660;';
    });

    // Input handling
    const inputEl = explainPanel.querySelector('#atExplainInput');
    const sendBtn = explainPanel.querySelector('#atExplainSendBtn');
    sendBtn.addEventListener('click', () => sendExplainQuestion(inputEl));
    inputEl.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendExplainQuestion(inputEl);
      }
    });

    // Drag via header
    enableDrag(explainPanel, explainPanel.querySelector('.at-panel-header'));

    // Focus input — user can type question or press Enter for default
    setTimeout(() => inputEl.focus(), 50);
  }

  function hideExplainPanel() {
    disconnectExplainPort();
    if (explainPanel) { explainPanel.remove(); explainPanel = null; }
    isExplaining = false;
  }

  function clearExplainConversation() {
    explainConversation = [];
    explainThinking = '';
    const messagesEl = explainPanel?.querySelector('#atExplainMessages');
    if (messagesEl) messagesEl.innerHTML = '';
    // Also clear on background side
    chrome.runtime.sendMessage({ type: 'CLEAR_EXPLAIN_HISTORY' }, () => {
      void chrome.runtime.lastError;
    });
    // Re-send initial request
    if (currentText) requestExplanation('');
  }

  function sendExplainQuestion(inputEl) {
    if (isExplaining) return;
    const question = inputEl.value.trim();
    inputEl.value = '';
    // Allow empty question → triggers default explanation
    requestExplanation(question);
  }

  function requestExplanation(question) {
    const messagesEl = explainPanel?.querySelector('#atExplainMessages');
    if (!messagesEl) return;

    disconnectExplainPort();
    isExplaining = true;
    explainThinking = '';

    // Add user message bubble (only for follow-up questions)
    if (question) {
      const userBubble = document.createElement('div');
      userBubble.className = 'at-explain-msg at-explain-msg-user';
      userBubble.innerHTML = `<div class="at-explain-msg-content">${escapeHtml(question)}</div>`;
      messagesEl.appendChild(userBubble);
    }

    // Add assistant response placeholder
    const assistantBubble = document.createElement('div');
    assistantBubble.className = 'at-explain-msg at-explain-msg-assistant';
    assistantBubble.innerHTML = '<div class="at-explain-msg-content"><span class="at-loading">Thinking…</span></div>';
    messagesEl.appendChild(assistantBubble);
    messagesEl.scrollTop = messagesEl.scrollHeight;

    const resultEl = assistantBubble.querySelector('.at-explain-msg-content');
    const thinkingEl = document.createElement('div');
    thinkingEl.className = 'at-explain-thinking at-hidden';
    thinkingEl.innerHTML = '<div class="at-explain-thinking-header" id="atThinkingToggle"><span class="at-explain-thinking-arrow">&#9654;</span> Thinking Process</div><div class="at-explain-thinking-body at-explain-collapsed" id="atThinkingBody"></div>';
    assistantBubble.insertBefore(thinkingEl, resultEl);

    // Thinking toggle
    const thinkingToggle = thinkingEl.querySelector('#atThinkingToggle');
    thinkingToggle.addEventListener('click', () => {
      const body = thinkingEl.querySelector('#atThinkingBody');
      const arrow = thinkingToggle.querySelector('.at-explain-thinking-arrow');
      const isCollapsed = body.classList.toggle('at-explain-collapsed');
      arrow.innerHTML = isCollapsed ? '&#9654;' : '&#9660;';
    });

    const thinkingBody = thinkingEl.querySelector('#atThinkingBody');

    // Connect to background for streaming
    explainPort = chrome.runtime.connect({ name: 'explanation' });
    let full = '';
    let thinking = '';

    explainPort.onMessage.addListener(msg => {
      if (!assistantBubble.isConnected) { disconnectExplainPort(); return; }

      switch (msg.type) {
        case 'thinking':
          thinking += msg.content;
          thinkingBody.textContent = thinking;
          thinkingEl.classList.remove('at-hidden');
          // Auto-expand thinking on first chunk
          if (thinking.length < 50) {
            thinkingBody.classList.remove('at-explain-collapsed');
            const arrow = thinkingToggle.querySelector('.at-explain-thinking-arrow');
            if (arrow) arrow.innerHTML = '&#9660;';
          }
          break;

        case 'chunk':
          if (resultEl.querySelector('.at-loading')) resultEl.textContent = '';
          full += msg.content;
          resultEl.textContent = full;
          messagesEl.scrollTop = messagesEl.scrollHeight;
          break;

        case 'done':
          isExplaining = false;
          resultEl.innerHTML = formatContent(msg.content || full);
          if (msg.thinking) {
            thinking = msg.thinking;
            thinkingBody.textContent = thinking;
            thinkingEl.classList.remove('at-hidden');
          }
          // Show request meta
          appendExplainMeta(assistantBubble, msg.meta, true);
          // Update conversation
          explainConversation.push({ role: 'user', content: question || 'Explain this text' });
          explainConversation.push({ role: 'assistant', content: msg.content || full });
          messagesEl.scrollTop = messagesEl.scrollHeight;
          // After first explanation, switch placeholder to follow-up mode
          const inp = explainPanel?.querySelector('#atExplainInput');
          if (inp && explainConversation.length >= 2) {
            inp.placeholder = 'Ask a follow-up question...';
          }
          break;

        case 'error':
          isExplaining = false;
          resultEl.innerHTML = `<span class="at-error">${escapeHtml(msg.error)}</span>`;
          appendExplainMeta(assistantBubble, msg.meta, false);
          break;

        case 'retry':
          resultEl.innerHTML = `<span class="at-retrying">Retrying (${msg.attempt})...</span>`;
          break;
      }
    });

    explainPort.onDisconnect.addListener(() => { isExplaining = false; explainPort = null; });

    explainPort.postMessage({
      action: 'explain',
      text: currentText,
      question: question,
      targetLang: settings.targetLang,
    });
  }

  function disconnectExplainPort() {
    if (explainPort) { try { explainPort.disconnect(); } catch {} explainPort = null; }
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
  function hideAll() { hidePanel(); hideToolbar(); hideExplainPanel(); }

  // ─── Drag ───
  function enableDrag(el, handle) {
    let startX, startY, origLeft, origTop;
    handle.addEventListener('mousedown', e => {
      if (e.target.closest('.at-close-btn') || e.target.closest('.at-explain-clear-btn')) return;
      e.preventDefault();
      startX = e.clientX;
      startY = e.clientY;
      origLeft = el.offsetLeft;
      origTop = el.offsetTop;
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
    function onMove(e) {
      el.style.left = (origLeft + e.clientX - startX) + 'px';
      el.style.top = (origTop + e.clientY - startY) + 'px';
    }
    function onUp() {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    }
  }

  function calcPos(clientX, clientY, panelEl) {
    const pw = panelEl?.classList.contains('at-explain-panel') ? 520 : 380;
    const vh = window.innerHeight;
    const vw = window.innerWidth;
    let px = Math.max(5, Math.min(clientX - pw / 2, vw - pw - 10));
    let py = clientY + 15;

    const ph = panelEl ? panelEl.offsetHeight : 300;
    const maxH = panelEl?.classList.contains('at-explain-panel') ? Math.round(vh * 0.85) : Math.round(vh * 0.8);

    if (settings.bubblePosition === 'above' || (py + Math.min(ph, maxH) > vh)) {
      py = Math.max(5, clientY - Math.min(ph, maxH) - 10);
    }
    return { x: px, y: py };
  }

  // ─── Request Meta Display ───
  function showRequestMeta(panelEl, meta, success) {
    const metaEl = panelEl?.querySelector('.at-request-meta');
    if (!metaEl) return;
    if (!meta) {
      metaEl.classList.add('at-hidden');
      return;
    }
    metaEl.innerHTML = buildMetaHtml(meta, success);
    metaEl.classList.remove('at-hidden');
  }

  function appendExplainMeta(bubbleEl, meta, success) {
    if (!meta) return;
    // Remove previous meta if any
    const prev = bubbleEl.querySelector('.at-request-meta');
    if (prev) prev.remove();
    const metaEl = document.createElement('div');
    metaEl.className = 'at-request-meta';
    metaEl.innerHTML = buildMetaHtml(meta, success);
    bubbleEl.appendChild(metaEl);
  }
})();
