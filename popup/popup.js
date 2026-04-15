// popup.js - Popup UI logic with agent mode + streaming support

document.addEventListener('DOMContentLoaded', () => {
  const sourceText = document.getElementById('sourceText');
  const targetLang = document.getElementById('targetLang');
  const translateBtn = document.getElementById('translateBtn');
  const copyBtn = document.getElementById('copyBtn');
  const resultBox = document.getElementById('result');
  const settingsBtn = document.getElementById('settingsBtn');
  const intentRow = document.getElementById('intentRow');
  const intentBadge = document.getElementById('intentBadge');
  const intentSwitch = document.getElementById('intentSwitch');
  const keywordsBar = document.getElementById('keywordsBar');
  const llmStatus = document.getElementById('llmStatus');
  const ttsBtn = document.getElementById('ttsBtn');
  const ttsStopBtn = document.getElementById('ttsStopBtn');
  const modeTabs = document.querySelectorAll('.mode-tab');

  let currentMode = 'quick';
  let currentIntent = null;
  let detectedIntent = null;
  let isTranslating = false;
  let port = null;
  let modeResults = {};  // cache: { mode: formattedHtml }
  let settings = {
    defaultMode: 'agent',
    intentMode: 'auto',
    targetLang: 'zh',
    hasLLM: false,
  };

  loadSettings();
  getSelectedText();
  checkLLMStatus();

  // ─── Mode tabs ───
  modeTabs.forEach(tab => {
    tab.addEventListener('click', () => {
      if (isTranslating) return;
      currentMode = tab.dataset.mode;
      modeTabs.forEach(t => t.classList.toggle('active', t === tab));
      // Show/hide intent row
      intentRow.classList.toggle('hidden', currentMode === 'quick');

      // Show cached result if available, otherwise clear
      if (modeResults[currentMode]) {
        resultBox.innerHTML = modeResults[currentMode];
        resultBox.className = 'result-box has-result';
        copyBtn.style.display = 'inline-flex';
      } else {
        resultBox.innerHTML = '';
        resultBox.className = 'result-box';
        copyBtn.style.display = 'none';
      }

      currentIntent = null;
      detectedIntent = null;
      intentBadge.classList.add('hidden');
    });
  });

  // ─── Intent tags ───
  intentSwitch.querySelectorAll('.intent-tag').forEach(tag => {
    tag.addEventListener('click', () => {
      if (isTranslating) return;
      currentIntent = tag.dataset.intent;
      intentSwitch.querySelectorAll('.intent-tag').forEach(t =>
        t.classList.toggle('active', t === tag)
      );
      resultBox.innerHTML = '';
      resultBox.className = 'result-box';
      copyBtn.style.display = 'none';
    });
  });

  // ─── Translate ───
  translateBtn.addEventListener('click', handleTranslate);
  sourceText.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.ctrlKey) handleTranslate();
  });

  async function handleTranslate() {
    const text = sourceText.value.trim();
    if (!text) {
      showError('Please enter text to translate');
      return;
    }

    setLoading(true);
    modeResults = {};
    resultBox.innerHTML = '';
    resultBox.className = 'result-box';

    if (currentMode === 'quick') {
      // Non-streaming via message
      try {
        const resp = await sendMessageToBackground({
          type: 'GET_TRANSLATION',
          text,
          targetLang: targetLang.value,
        });
        if (resp.success) {
          showResult(resp.data.translatedText);
        } else {
          showError(resp.error || 'Translation failed');
        }
      } catch (e) {
        showError('Error: ' + e.message);
      } finally {
        setLoading(false);
      }
    } else {
      // Streaming via port (agent / deep)
      disconnectPort();
      port = chrome.runtime.connect({ name: 'translation' });
      let full = '';

      port.onMessage.addListener(msg => {
        switch (msg.type) {
          case 'intent':
            detectedIntent = msg.intent;
            if (settings.intentMode === 'auto') {
              const labels = { meaning: 'Meaning', grammar: 'Grammar' };
              intentBadge.textContent = labels[msg.intent] || msg.intent;
              intentBadge.classList.remove('hidden');
            }
            if (!currentIntent) currentIntent = msg.intent;
            break;

          case 'chunk':
            resultBox.classList.add('streaming');
            full += msg.content;
            resultBox.innerHTML = formatContent(full);
            resultBox.scrollTop = resultBox.scrollHeight;
            break;

          case 'done':
            isTranslating = false;
            setLoading(false);
            resultBox.innerHTML = formatContent(msg.content || full);
            resultBox.className = 'result-box has-result';
            copyBtn.style.display = 'inline-flex';
            modeResults[currentMode] = resultBox.innerHTML;
            if (msg.keywords) updateKeywordsDisplay(msg.keywords);
            disconnectPort();
            break;

          case 'error':
            isTranslating = false;
            setLoading(false);
            showError(msg.error || 'Translation failed');
            disconnectPort();
            break;
        }
      });

      port.onDisconnect.addListener(() => {
        isTranslating = false;
        setLoading(false);
        port = null;
      });

      port.postMessage({
        action: 'translate',
        text,
        mode: currentMode,
        intent: currentIntent || undefined,
        targetLang: targetLang.value,
      });
    }
  }

  function disconnectPort() {
    if (port) { try { port.disconnect(); } catch {} port = null; }
  }

  // ─── Copy ───
  copyBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(resultBox.textContent);
      copyBtn.textContent = 'Done';
      setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1500);
    } catch { console.error('Copy failed'); }
  });

  // ─── TTS (directly to content script, bypass background) ───
  ttsBtn.addEventListener('click', async () => {
    const text = sourceText.value.trim();
    if (!text) return;
    ttsBtn.classList.add('hidden');
    ttsStopBtn.classList.remove('hidden');
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab?.id) {
        await chrome.tabs.sendMessage(tab.id, {
          type: 'TTS_SPEAK', text, lang: 'en-US',
        });
      }
    } catch {
      ttsBtn.classList.remove('hidden');
      ttsStopBtn.classList.add('hidden');
    }
  });

  ttsStopBtn.addEventListener('click', async () => {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab?.id) {
        chrome.tabs.sendMessage(tab.id, { type: 'TTS_STOP' });
      }
    } catch {}
    ttsBtn.classList.remove('hidden');
    ttsStopBtn.classList.add('hidden');
  });

  // ─── Settings ───
  settingsBtn.addEventListener('click', () => chrome.runtime.openOptionsPage());

  // ─── Helpers ───
  function showResult(text) {
    resultBox.textContent = text;
    resultBox.className = 'result-box has-result';
    copyBtn.style.display = 'inline-flex';
    modeResults[currentMode] = resultBox.innerHTML;
  }

  function showError(text) {
    resultBox.innerHTML = `<span class="error-text">${escapeHtml(text)}</span>`;
    resultBox.className = 'result-box';
    copyBtn.style.display = 'none';
  }

  function setLoading(loading) {
    isTranslating = loading;
    translateBtn.disabled = loading;
    translateBtn.textContent = loading ? 'Translating...' : 'Translate';
  }

  function formatContent(text) {
    let html = text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/^## (.+)$/gm, '<div class="popup-h2">$1</div>')
      .replace(/^### (.+)$/gm, '<div class="popup-h3">$1</div>')
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/`([^`]+)`/g, '<code class="popup-code">$1</code>')
      .replace(/\n/g, '<br>');

    // Render **Terms** section as a styled card
    html = html.replace(
      /(<strong>Terms<\/strong><br>)([\s\S]*?)(?=<br><br>|<br><strong>|$)/,
      (_, header, body) => {
        const items = body
          .split(/<br>\s*/)
          .map(line => line.trim())
          .filter(line => line && /^\d+\./.test(line))
          .map(line => `<div class="term-item">${line.replace(/^\d+\.\s*/, '')}</div>`)
          .join('');
        return items
          ? `${header}<div class="terms-card">${items}</div>`
          : header;
      }
    );

    return html;
  }

  function escapeHtml(text) {
    const d = document.createElement('div');
    d.textContent = text;
    return d.innerHTML;
  }

  function updateKeywordsDisplay(keywords) {
    const refreshBtn = '<span class="keywords-refresh" title="Force refresh keywords" id="kwRefresh">&#x21bb;</span>';
    if (!keywords || keywords.length === 0) {
      keywordsBar.innerHTML = '<span class="keywords-label">Domain</span><span class="keywords-empty">accumulating...</span>' + refreshBtn;
      keywordsBar.querySelector('#kwRefresh')?.addEventListener('click', forceRefreshKeywords);
      return;
    }
    // Keywords may be { original, translated } objects or legacy strings
    const tagsHtml = keywords.map((kw, i) => {
      const label = typeof kw === 'string' ? kw : (kw.translated || kw.original);
      const original = typeof kw === 'string' ? kw : kw.original;
      return `<span class="keyword-tag kw-rank-${i}" data-keyword="${escapeHtml(original)}" title="Click to boost relevance">${escapeHtml(label)}</span>`;
    }).join('');
    keywordsBar.innerHTML = `<span class="keywords-label">Domain</span>${tagsHtml}${refreshBtn}`;
    keywordsBar.querySelectorAll('.keyword-tag').forEach(tag => {
      tag.addEventListener('click', () => {
        chrome.runtime.sendMessage({ type: 'PROMOTE_KEYWORD', keyword: tag.dataset.keyword }, resp => {
          if (resp?.success && resp.data?.keywords) {
            updateKeywordsDisplay(resp.data.keywords);
            // Re-translate with updated keyword order
            if (sourceText.value.trim() && !isTranslating && currentMode !== 'quick') {
              modeResults[currentMode] = null;
              handleTranslate();
            }
          }
        });
      });
    });
    keywordsBar.querySelector('#kwRefresh')?.addEventListener('click', forceRefreshKeywords);
  }

  function forceRefreshKeywords() {
    if (isTranslating) return;
    const refreshEl = keywordsBar.querySelector('#kwRefresh');
    if (refreshEl) refreshEl.textContent = '...';
    chrome.runtime.sendMessage({ type: 'FORCE_UPDATE_KEYWORDS' }, resp => {
      if (resp?.success && resp.data?.keywords) {
        updateKeywordsDisplay(resp.data.keywords);
        // Re-translate with updated keywords
        if (sourceText.value.trim() && !isTranslating && currentMode !== 'quick') {
          modeResults[currentMode] = null;
          handleTranslate();
        }
      } else {
        if (refreshEl) refreshEl.innerHTML = '&#x21bb;';
      }
    });
  }

  async function getSelectedText() {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const results = await chrome.tabs.sendMessage(tab.id, { type: 'GET_SELECTED_TEXT' });
      if (results?.text) sourceText.value = results.text;
    } catch {}
  }

  async function checkLLMStatus() {
    try {
      const resp = await sendMessageToBackground({ type: 'GET_LLM_STATUS' });
      if (resp.success && resp.data) {
        settings.hasLLM = true;
        llmStatus.textContent = resp.data.name || resp.data.model;
        llmStatus.title = `Connected to ${resp.data.endpoint}`;
      } else {
        settings.hasLLM = false;
        llmStatus.textContent = 'Quick mode (no LLM)';
      }
    } catch {
      settings.hasLLM = false;
      llmStatus.textContent = 'Quick mode (no LLM)';
    }
  }

  function loadSettings() {
    chrome.storage.local.get([
      'defaultTargetLang', 'defaultMode', 'intentMode',
    ], r => {
      if (r.defaultTargetLang) targetLang.value = r.defaultTargetLang;
      settings.defaultMode = r.defaultMode || 'agent';
      settings.intentMode = r.intentMode || 'auto';
      settings.targetLang = r.defaultTargetLang || 'zh';

      // Check if any LLM endpoint is configured
      chrome.storage.local.get('llmEndpoints', r2 => {
        const endpoints = r2.llmEndpoints || [];
        settings.hasLLM = endpoints.some(e => e.apiKey);
      });

      // Set initial mode tab
      const initialMode = settings.hasLLM ? settings.defaultMode : 'quick';
      currentMode = initialMode;
      modeTabs.forEach(t => t.classList.toggle('active', t.dataset.mode === initialMode));

      // Intent row visibility
      intentRow.classList.toggle('hidden', initialMode === 'quick');

      // Intent mode: auto → badge, manual → switch
      if (settings.intentMode === 'manual') {
        intentSwitch.classList.remove('hidden');
      }
    });
  }

  function sendMessageToBackground(message) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          resolve(response);
        }
      });
    });
  }
});
