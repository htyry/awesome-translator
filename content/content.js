// content.js — Injected into web pages
// In-page translation panel with mode switching, intent detection, streaming, TTS
// Plus Explain mode with conversation history and thinking display

(async function () {
  'use strict';

  // ═══ Shared imports ═══
  const { escapeHtml, formatContent, buildMetaHtml } = await import(chrome.runtime.getURL('lib/ui-utils.js'));

  // ═══ Constants ═══
  const ACTIONS = { TRANSLATE: 'translate', LEARN: 'learn', ASK: 'ask' };
  const ACTION_LABELS = {
    translate: { label: '译' },
    learn:     { label: '学' },
    ask:       { label: '问' },
  };

  // ═══ State ═══
  let panel = null;
  let toolbar = null;
  let port = null;
  let askPort = null;
  let currentAction = ACTIONS.TRANSLATE;
  let currentText = '';
  let isProcessing = false;
  let customShortcut = 'Alt+Shift+T';
  let _isFromToolbar = false;
  let actionResults = {};  // cache: { translate: html, learn: html, ask: html }
  let askConversation = []; // { role, content } for ask mode

  let settings = {
    autoTranslate: true,
    showTriggerIcon: true,
    minSelectionLength: 1,
    maxSelectionLength: 1000,
    showCopyButton: true,
    bubblePosition: 'below',
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
      'targetLang', 'llmEndpoints',
    ], r => {
      Object.assign(settings, {
        autoTranslate:       r.autoTranslate ?? true,
        showTriggerIcon:     r.showTriggerIcon ?? true,
        minSelectionLength:  r.minSelectionLength || 1,
        maxSelectionLength:  r.maxSelectionLength || 1000,
        showCopyButton:      r.showCopyButton ?? true,
        bubblePosition:      r.bubblePosition || 'below',
        customShortcut:      r.customShortcut || 'Alt+Shift+T',
        targetLang:          r.targetLang || 'zh',
      });
      const endpoints = r.llmEndpoints || [];
      settings.hasLLM = endpoints.some(e => e.apiKey);
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
        openPanel(msg.text, 'translate');
        send({ success: true });
        break;
      case 'GET_SELECTED_TEXT':
        send({ text: window.getSelection().toString().trim() });
        break;
      case 'TRIGGER_TRANSLATE': {
        const sel = window.getSelection().toString().trim();
        sel ? (openPanel(sel, 'translate'), send({ success: true })) : send({ success: false });
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
    if (panel?.contains(e.target) || toolbar?.contains(e.target)) return;
    const cx = e.clientX, cy = e.clientY;
    setTimeout(() => {
      if (_isFromToolbar) { _isFromToolbar = false; return; }
      const sel = window.getSelection().toString().trim();
      if (sel.length < settings.minSelectionLength || sel.length > settings.maxSelectionLength) {
        hideToolbar(); hidePanel(); return;
      }
      // Always show floating toolbar with three action buttons
      hidePanel();
      showToolbar(sel, cx, cy);
    }, 10);
  });

  document.addEventListener('mousedown', e => {
    if (panel?.contains(e.target) || toolbar?.contains(e.target)) return;
    hidePanel(); hideToolbar();
  });

  // ─── Keyboard ───
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') { hideAll(); return; }
    if (matchShortcut(e, customShortcut)) {
      const sel = window.getSelection().toString().trim();
      if (sel) { e.preventDefault(); openPanel(sel, 'translate'); }
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
  //  Floating Toolbar (译 / 学 / 问)
  // ════════════════════════════════════════
  function showToolbar(text, x, y) {
    hideToolbar();
    toolbar = document.createElement('div');
    toolbar.className = 'at-floating-toolbar at-toolbar-3btn';

    const actions = [
      { action: 'translate', label: '译', title: '翻译', icon: 'T' },
      { action: 'learn',     label: '学', title: '学习单词/语法', icon: 'L' },
      { action: 'ask',       label: '问', title: '深入问答', icon: 'Q' },
    ];

    for (const { action, label, title, icon } of actions) {
      const btn = document.createElement('button');
      btn.className = 'at-toolbar-btn';
      btn.title = settings.hasLLM ? title : (action === 'translate' ? title : '需要配置 LLM');
      btn.innerHTML = `<span class="at-toolbar-icon">${icon}</span><span class="at-toolbar-label">${label}</span>`;
      if (!settings.hasLLM && action !== 'translate') {
        btn.classList.add('at-toolbar-disabled');
      } else {
        btn.addEventListener('mousedown', e => {
          e.stopPropagation(); e.preventDefault();
          _isFromToolbar = true;
          hideToolbar();
          openPanel(text, action, x, y);
        });
      }
      toolbar.appendChild(btn);
    }

    // Position near selection
    let px = x + 8, py = y + 8;
    const tbWidth = 240;
    if (px + tbWidth > window.innerWidth - 5) px = window.innerWidth - tbWidth - 10;
    if (py + 36 > window.innerHeight - 5) py = y - 44;
    toolbar.style.left = px + 'px';
    toolbar.style.top = py + 'px';

    document.body.appendChild(toolbar);
  }

  function hideToolbar() {
    if (toolbar) { toolbar.remove(); toolbar = null; }
  }

  function openPanel(text, action, x, y) {
    if (!x || !y) {
      try {
        const r = window.getSelection().getRangeAt(0).getBoundingClientRect();
        x = r.left + r.width / 2;
        y = r.bottom + 5;
      } catch { x = 200; y = 200; }
    }

    hidePanel();
    currentText = text;
    currentAction = action;
    isProcessing = false;
    stopSpeaking();

    // For ask action, init conversation
    if (action === 'ask') {
      askConversation = [];
      chrome.runtime.sendMessage({ type: 'CLEAR_EXPLAIN_HISTORY' }, () => { void chrome.runtime.lastError; });
    }

    panel = document.createElement('div');
    panel.className = 'at-panel';

    // Action buttons (译/学/问)
    const actionBtns = Object.entries(ACTION_LABELS).map(([k, v]) =>
      `<button class="at-action-tab ${action === k ? 'at-active' : ''}" data-action="${k}">${v.label}</button>`
    ).join('');

    // Keywords bar: only shown for translate action
    const keywordsBar = action === 'translate'
      ? `<div class="at-keywords-bar" id="atKeywordsBar"><span class="at-keywords-label">Domain</span><span class="at-keywords-empty">accumulating...</span></div>`
      : '';

    // Ask-specific: source text toggle + conversation area + input
    const askHtml = action === 'ask' ? `
      <div class="at-explain-source" id="atAskSource">
        <div class="at-explain-source-toggle" id="atSourceToggle">
          <span class="at-explain-source-arrow">&#9660;</span>
          <span class="at-explain-source-label">Selected Text</span>
        </div>
        <div class="at-explain-source-text" id="atSourceText">${escapeHtml(text)}</div>
      </div>
      <div class="at-explain-body" id="atAskBody">
        <div class="at-explain-messages" id="atAskMessages"></div>
      </div>
      <div class="at-explain-input-area">
        <div class="at-explain-input-row">
          <input type="text" class="at-explain-input" id="atAskInput" placeholder="输入你的问题..." />
          <button class="at-explain-send-btn" id="atAskSendBtn" title="发送">&#10148;</button>
        </div>
      </div>` : '';

    panel.innerHTML = `
      <div class="at-panel-header">
        <span class="at-title">Awesome Translator</span>
        ${action === 'ask' ? '<button class="at-action-btn at-explain-clear-btn" id="atAskClearBtn" title="清空对话">Clear</button>' : ''}
        <button class="at-close-btn">&times;</button>
      </div>
      <div class="at-action-tabs">${actionBtns}</div>
      ${keywordsBar}
      <div class="at-panel-body">
        <div class="at-result"></div>
        <div class="at-request-meta at-hidden"></div>
      </div>
      ${askHtml}
      <div class="at-panel-actions">
        ${settings.showCopyButton ? '<button class="at-action-btn at-copy-btn" title="复制">Copy</button>' : ''}
        <button class="at-action-btn at-tts-btn" title="朗读原文">Speak</button>
        <button class="at-action-btn at-tts-stop-btn at-hidden" title="停止">Stop</button>
      </div>
    `;

    // Position and render
    const pos = calcPos(x, y, null, action);
    panel.style.left = pos.x + 'px';
    panel.style.top = pos.y + 'px';
    document.body.appendChild(panel);

    const pos2 = calcPos(x, y, panel, action);
    if (pos2.y !== pos.y) panel.style.top = pos2.y + 'px';

    // Bind events
    bindPanelEvents(panel, text, action);
  }

  function bindPanelEvents(panelEl, text, action) {
    panelEl.querySelector('.at-close-btn').addEventListener('click', hidePanel);

    // Action switcher
    panelEl.querySelectorAll('.at-action-tab').forEach(t =>
      t.addEventListener('click', () => switchAction(t.dataset.action))
    );

    // Keywords for translate
    if (action === 'translate') {
      const kwRefresh = panelEl.querySelector('#atKwRefresh');
      if (kwRefresh) kwRefresh.addEventListener('click', forceRefreshKeywords);
      panelEl.querySelectorAll('.at-keyword-tag').forEach(tag => {
        tag.addEventListener('click', () => promoteKeyword(tag.dataset.keyword));
      });
    }

    // Copy + TTS
    panelEl.querySelector('.at-copy-btn')?.addEventListener('click', copyResult);
    panelEl.querySelector('.at-tts-btn').addEventListener('click', () => speakOriginal(text));
    panelEl.querySelector('.at-tts-stop-btn').addEventListener('click', stopSpeaking);

    // Ask-specific: source toggle, input, clear
    if (action === 'ask') {
      const srcToggle = panelEl.querySelector('#atSourceToggle');
      if (srcToggle) {
        srcToggle.addEventListener('click', () => {
          const srcText = panelEl.querySelector('#atSourceText');
          const arrow = srcToggle.querySelector('.at-explain-source-arrow');
          const collapsed = srcText.classList.toggle('at-explain-collapsed');
          arrow.innerHTML = collapsed ? '&#9654;' : '&#9660;';
        });
      }

      const inputEl = panelEl.querySelector('#atAskInput');
      const sendBtn = panelEl.querySelector('#atAskSendBtn');
      if (sendBtn) sendBtn.addEventListener('click', () => sendAskQuestion(inputEl));
      if (inputEl) {
        inputEl.addEventListener('keydown', e => {
          if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendAskQuestion(inputEl); }
        });
        setTimeout(() => inputEl.focus(), 50);
      }

      panelEl.querySelector('#atAskClearBtn')?.addEventListener('click', clearAskConversation);

      // Show placeholder in result area, wait for user input
      const resultEl = panelEl.querySelector('.at-result');
      if (resultEl) resultEl.innerHTML = '';
    } else {
      // Start LLM request immediately for translate/learn
      requestAction();
    }

    // Drag via header
    enableDrag(panelEl, panelEl.querySelector('.at-panel-header'));
  }

  function hidePanel() {
    disconnectPort();
    disconnectAskPort();
    stopSpeaking();
    if (panel) { panel.remove(); panel = null; }
    isProcessing = false;
    actionResults = {};
    askConversation = [];
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
        if (currentText && !isProcessing) {
          actionResults.translate = null;
          requestAction();
        }
      }
    });
  }

  function forceRefreshKeywords() {
    if (!panel || isProcessing) return;
    const refreshEl = panel.querySelector('#atKwRefresh');
    if (refreshEl) refreshEl.textContent = '...';
    chrome.runtime.sendMessage({ type: 'FORCE_UPDATE_KEYWORDS' }, resp => {
      if (resp?.success && resp.data?.keywords) {
        updateKeywordsDisplay(resp.data.keywords);
        if (currentText && !isProcessing) {
          actionResults.translate = null;
          requestAction();
        }
      } else {
        if (refreshEl) refreshEl.innerHTML = '&#x21bb;';
      }
    });
  }

  // ─── Switch action (译/学/问) ───
  function switchAction(action) {
    if (isProcessing) return;
    currentAction = action;
    panel.querySelectorAll('.at-action-tab').forEach(t =>
      t.classList.toggle('at-active', t.dataset.action === action)
    );

    const resultEl = panel.querySelector('.at-result');

    // Show/hide keywords bar (translate only)
    const kwBar = panel.querySelector('#atKeywordsBar');
    if (kwBar) kwBar.style.display = action === 'translate' ? '' : 'none';

    // Show/hide ask-specific elements
    const askInputArea = panel.querySelector('.at-explain-input-area');
    const askBody = panel.querySelector('#atAskBody');
    const askSource = panel.querySelector('#atAskSource');
    const askClearBtn = panel.querySelector('#atAskClearBtn');
    if (askInputArea) askInputArea.style.display = action === 'ask' ? '' : 'none';
    if (askBody) askBody.style.display = action === 'ask' ? '' : 'none';
    if (askSource) askSource.style.display = action === 'ask' ? '' : 'none';
    if (askClearBtn) askClearBtn.style.display = action === 'ask' ? '' : 'none';

    // Ask mode: show cached conversation or wait for user input
    if (action === 'ask') {
      const msgEl = panel?.querySelector('#atAskMessages');
      if (actionResults.ask && msgEl) {
        // Restore cached conversation
        msgEl.innerHTML = actionResults.ask;
        resultEl.innerHTML = '';
        resultEl.className = 'at-result';
      } else {
        askConversation = [];
        if (msgEl) msgEl.innerHTML = '';
        resultEl.innerHTML = '';
        resultEl.className = 'at-result';
        chrome.runtime.sendMessage({ type: 'CLEAR_EXPLAIN_HISTORY' }, () => { void chrome.runtime.lastError; });
      }
      // Focus the input
      const inputEl = panel?.querySelector('#atAskInput');
      if (inputEl) setTimeout(() => inputEl.focus(), 50);
      return;
    }

    // Translate / Learn: show cached or request new
    if (actionResults[action]) {
      resultEl.innerHTML = actionResults[action];
      resultEl.className = 'at-result';
    } else {
      resultEl.innerHTML = '';
      requestAction();
    }
  }

  // ─── Keywords display (translate only) ───
  function requestAction() {
    const resultEl = panel?.querySelector('.at-result');
    if (!resultEl || !currentText) return;

    disconnectPort();
    isProcessing = true;

    // Google Translate fallback for translate without LLM
    if (currentAction === 'translate' && !settings.hasLLM) {
      resultEl.innerHTML = '<span class="at-loading">翻译中…</span>';
      chrome.runtime.sendMessage({
        type: 'GET_TRANSLATION',
        text: currentText,
        targetLang: settings.targetLang,
      }, resp => {
        isProcessing = false;
        if (!resultEl.isConnected) return;
        if (resp?.success) {
          resultEl.textContent = resp.data.translatedText;
          actionResults.translate = resultEl.innerHTML;
        } else {
          resultEl.innerHTML = `<span class="at-error">${escapeHtml(resp?.error || '翻译失败')}</span>`;
        }
      });
      return;
    }

    resultEl.innerHTML = '<span class="at-loading">' + (currentAction === 'translate' ? '翻译中…' : '分析中…') + '</span>';
    port = chrome.runtime.connect({ name: 'translation' });
    let full = '';

    port.onMessage.addListener(msg => {
      if (!resultEl.isConnected) { disconnectPort(); return; }
      switch (msg.type) {
        case 'chunk':
          if (resultEl.querySelector('.at-loading')) resultEl.textContent = '';
          full += msg.content;
          resultEl.textContent = full;
          resultEl.className = 'at-result at-streaming';
          resultEl.scrollTop = resultEl.scrollHeight;
          break;
        case 'result':
          resultEl.textContent = msg.content;
          full = msg.content;
          actionResults[currentAction] = resultEl.innerHTML;
          break;
        case 'done':
          isProcessing = false;
          resultEl.innerHTML = formatContent(msg.content || full);
          resultEl.className = 'at-result';
          actionResults[currentAction] = resultEl.innerHTML;
          if (msg.keywords) updateKeywordsDisplay(msg.keywords);
          showRequestMeta(panel, msg.meta, true);
          break;
        case 'error':
          isProcessing = false;
          resultEl.innerHTML = `<span class="at-error">${escapeHtml(msg.error)}</span>`;
          resultEl.className = 'at-result';
          showRequestMeta(panel, msg.meta, false);
          break;
        case 'retry':
          resultEl.innerHTML = `<span class="at-retrying">重试 (${msg.attempt})...</span>`;
          resultEl.className = 'at-result at-retrying-state';
          break;
      }
    });

    port.onDisconnect.addListener(() => { isProcessing = false; port = null; });

    port.postMessage({
      action: currentAction,
      text: currentText,
      targetLang: settings.targetLang,
    });
  }

  function disconnectPort() {
    if (port) { try { port.disconnect(); } catch {} port = null; }
  }

  // ─── Ask mode: send question & stream ───
  function sendAskQuestion(inputEl) {
    if (isProcessing) return;
    const question = inputEl ? inputEl.value.trim() : '';
    if (inputEl) inputEl.value = '';
    requestAsk(question);
  }

  function clearAskConversation() {
    askConversation = [];
    const msgEl = panel?.querySelector('#atAskMessages');
    if (msgEl) msgEl.innerHTML = '';
    const resultEl = panel?.querySelector('.at-result');
    if (resultEl) resultEl.innerHTML = '';
    chrome.runtime.sendMessage({ type: 'CLEAR_EXPLAIN_HISTORY' }, () => { void chrome.runtime.lastError; });
    actionResults.ask = null;
    const inputEl = panel?.querySelector('#atAskInput');
    if (inputEl) setTimeout(() => inputEl.focus(), 50);
  }

  function requestAsk(question) {
    const msgEl = panel?.querySelector('#atAskMessages');
    if (!msgEl) return;

    disconnectAskPort();
    isProcessing = true;

    // User bubble (follow-up only)
    if (question) {
      const userBubble = document.createElement('div');
      userBubble.className = 'at-explain-msg at-explain-msg-user';
      userBubble.innerHTML = `<div class="at-explain-msg-content">${escapeHtml(question)}</div>`;
      msgEl.appendChild(userBubble);
    }

    // Assistant placeholder
    const assistantBubble = document.createElement('div');
    assistantBubble.className = 'at-explain-msg at-explain-msg-assistant';
    assistantBubble.innerHTML = '<div class="at-explain-msg-content"><span class="at-loading">思考中…</span></div>';
    msgEl.appendChild(assistantBubble);
    msgEl.scrollTop = msgEl.scrollHeight;

    const resultEl = assistantBubble.querySelector('.at-explain-msg-content');

    // Thinking process area
    const thinkingEl = document.createElement('div');
    thinkingEl.className = 'at-explain-thinking at-hidden';
    thinkingEl.innerHTML = '<div class="at-explain-thinking-header" id="atAskThinkingToggle"><span class="at-explain-thinking-arrow">&#9654;</span> 思考过程</div><div class="at-explain-thinking-body at-explain-collapsed" id="atAskThinkingBody"></div>';
    assistantBubble.insertBefore(thinkingEl, resultEl);

    const thinkingToggle = thinkingEl.querySelector('#atAskThinkingToggle');
    thinkingToggle.addEventListener('click', () => {
      const body = thinkingEl.querySelector('#atAskThinkingBody');
      const arrow = thinkingToggle.querySelector('.at-explain-thinking-arrow');
      const collapsed = body.classList.toggle('at-explain-collapsed');
      arrow.innerHTML = collapsed ? '&#9654;' : '&#9660;';
    });
    const thinkingBody = thinkingEl.querySelector('#atAskThinkingBody');

    askPort = chrome.runtime.connect({ name: 'explanation' });
    let full = '';
    let thinking = '';

    askPort.onMessage.addListener(msg => {
      if (!assistantBubble.isConnected) { disconnectAskPort(); return; }
      switch (msg.type) {
        case 'thinking':
          thinking += msg.content;
          thinkingBody.textContent = thinking;
          thinkingEl.classList.remove('at-hidden');
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
          msgEl.scrollTop = msgEl.scrollHeight;
          break;
        case 'done':
          isProcessing = false;
          resultEl.innerHTML = formatContent(msg.content || full);
          if (msg.thinking) {
            thinking = msg.thinking;
            thinkingBody.textContent = thinking;
            thinkingEl.classList.remove('at-hidden');
          }
          appendAskMeta(assistantBubble, msg.meta, true);
          askConversation.push({ role: 'user', content: question || 'Explain this text' });
          askConversation.push({ role: 'assistant', content: msg.content || full });
          msgEl.scrollTop = msgEl.scrollHeight;
          const inp = panel?.querySelector('#atAskInput');
          if (inp && askConversation.length >= 2) inp.placeholder = '输入追问...';
          // Cache result
          actionResults.ask = msgEl.innerHTML;
          break;
        case 'error':
          isProcessing = false;
          resultEl.innerHTML = `<span class="at-error">${escapeHtml(msg.error)}</span>`;
          appendAskMeta(assistantBubble, msg.meta, false);
          break;
        case 'retry':
          resultEl.innerHTML = `<span class="at-retrying">重试 (${msg.attempt})...</span>`;
          break;
      }
    });

    askPort.onDisconnect.addListener(() => { isProcessing = false; askPort = null; });

    askPort.postMessage({
      action: 'explain',
      text: currentText,
      question: question,
      targetLang: settings.targetLang,
    });
  }

  function disconnectAskPort() {
    if (askPort) { try { askPort.disconnect(); } catch {} askPort = null; }
    isProcessing = false;
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
  function hideAll() { hidePanel(); hideToolbar(); }

  // ─── Drag ───
  function enableDrag(el, handle) {
    let startX, startY, origLeft, origTop;
    handle.addEventListener('mousedown', e => {
      if (e.target.closest('.at-close-btn') || e.target.closest('#atAskClearBtn')) return;
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

  function calcPos(clientX, clientY, panelEl, action) {
    const isAsk = action === 'ask';
    const pw = isAsk ? 520 : 380;
    const vh = window.innerHeight;
    const vw = window.innerWidth;
    let px = Math.max(5, Math.min(clientX - pw / 2, vw - pw - 10));
    let py = clientY + 15;

    const ph = panelEl ? panelEl.offsetHeight : (isAsk ? 400 : 300);
    const maxH = isAsk ? Math.round(vh * 0.85) : Math.round(vh * 0.8);

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

  function appendAskMeta(bubbleEl, meta, success) {
    if (!meta) return;
    const prev = bubbleEl.querySelector('.at-request-meta');
    if (prev) prev.remove();
    const metaEl = document.createElement('div');
    metaEl.className = 'at-request-meta';
    metaEl.innerHTML = buildMetaHtml(meta, success);
    bubbleEl.appendChild(metaEl);
  }
})();
