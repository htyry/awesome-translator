// popup.js - Popup UI with 译/学/问 action model

import { escapeHtml, buildMetaHtml } from '../lib/ui-utils.js';

const sourceText = document.getElementById('sourceText');
const targetLang = document.getElementById('targetLang');
const translateBtn = document.getElementById('translateBtn');
const copyBtn = document.getElementById('copyBtn');
const resultBox = document.getElementById('result');
const requestMeta = document.getElementById('requestMeta');
const settingsBtn = document.getElementById('settingsBtn');
const keywordsBar = document.getElementById('keywordsBar');
const llmStatus = document.getElementById('llmStatus');
const ttsBtn = document.getElementById('ttsBtn');
const ttsStopBtn = document.getElementById('ttsStopBtn');
const actionTabs = document.querySelectorAll('.action-tab');

let currentAction = 'translate';
let isProcessing = false;
let port = null;
let actionResults = {};
let settings = { targetLang: 'zh', hasLLM: false };

loadSettings();
getSelectedText();
checkLLMStatus();

// ─── Action tabs ───
actionTabs.forEach(tab => {
  tab.addEventListener('click', () => {
    if (isProcessing) return;
    currentAction = tab.dataset.action;
    actionTabs.forEach(t => t.classList.toggle('active', t === tab));
    // Keywords bar only for translate
    keywordsBar.style.display = currentAction === 'translate' ? '' : 'none';

    if (actionResults[currentAction]) {
      resultBox.innerHTML = actionResults[currentAction];
      resultBox.className = 'result-box has-result';
      copyBtn.style.display = 'inline-flex';
    } else {
      resultBox.innerHTML = '';
      resultBox.className = 'result-box';
      copyBtn.style.display = 'none';
    }
  });
});

// ─── Execute ───
translateBtn.addEventListener('click', handleExecute);
sourceText.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.ctrlKey) handleExecute();
});

async function handleExecute() {
  const text = sourceText.value.trim();
  if (!text) { showError('请输入文本'); return; }

  setLoading(true);
  resultBox.innerHTML = '';
  resultBox.className = 'result-box';

  if (currentAction === 'translate' && !settings.hasLLM) {
    try {
      const resp = await sendMessageToBackground({
        type: 'GET_TRANSLATION', text, targetLang: targetLang.value,
      });
      if (resp.success) showResult(resp.data.translatedText);
      else showError(resp.error || '翻译失败');
    } catch (e) { showError('错误: ' + e.message); }
    finally { setLoading(false); }
  } else {
    disconnectPort();
    port = chrome.runtime.connect({ name: 'translation' });
    let full = '';

    port.onMessage.addListener(msg => {
      switch (msg.type) {
        case 'chunk':
          resultBox.classList.add('streaming');
          full += msg.content;
          resultBox.innerHTML = formatContent(full);
          resultBox.scrollTop = resultBox.scrollHeight;
          break;
        case 'done':
          isProcessing = false;
          setLoading(false);
          resultBox.innerHTML = formatContent(msg.content || full);
          resultBox.className = 'result-box has-result';
          copyBtn.style.display = 'inline-flex';
          actionResults[currentAction] = resultBox.innerHTML;
          if (msg.keywords) updateKeywordsDisplay(msg.keywords);
          showRequestMeta(msg.meta, true);
          disconnectPort();
          break;
        case 'error':
          isProcessing = false;
          setLoading(false);
          showError(msg.error || '请求失败');
          showRequestMeta(msg.meta, false);
          disconnectPort();
          break;
        case 'retry':
          resultBox.classList.remove('streaming');
          resultBox.textContent = `重试 (${msg.attempt})...`;
          break;
      }
    });

    port.onDisconnect.addListener(() => {
      isProcessing = false;
      setLoading(false);
      port = null;
    });

    port.postMessage({
      action: currentAction,
      text,
      targetLang: targetLang.value,
    });
  }
}

function disconnectPort() {
  if (port) { try { port.disconnect(); } catch {} port = null; }
}

// ─── Request Meta Display ───
function showRequestMeta(meta, success) {
  const html = buildMetaHtml(meta, success, '');
  if (html) {
    requestMeta.innerHTML = html;
    requestMeta.classList.remove('hidden');
  } else {
    requestMeta.classList.add('hidden');
  }
}

// ─── Copy ───
copyBtn.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(resultBox.textContent);
    copyBtn.textContent = 'Done';
    setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1500);
  } catch { console.error('Copy failed'); }
});

// ─── TTS ───
ttsBtn.addEventListener('click', async () => {
  const text = sourceText.value.trim();
  if (!text) return;
  ttsBtn.classList.add('hidden');
  ttsStopBtn.classList.remove('hidden');
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) {
      await chrome.tabs.sendMessage(tab.id, { type: 'TTS_SPEAK', text, lang: 'en-US' });
    }
  } catch {
    ttsBtn.classList.remove('hidden');
    ttsStopBtn.classList.add('hidden');
  }
});

ttsStopBtn.addEventListener('click', async () => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) chrome.tabs.sendMessage(tab.id, { type: 'TTS_STOP' });
  } catch {}
  ttsBtn.classList.remove('hidden');
  ttsStopBtn.classList.add('hidden');
});

// ─── Settings ───
settingsBtn.addEventListener('click', () => chrome.runtime.openOptionsPage());
document.getElementById('openPdfBtn').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('pdf-viewer/pdf-viewer.html') });
});

// ─── Helpers ───
function showResult(text) {
  resultBox.textContent = text;
  resultBox.className = 'result-box has-result';
  copyBtn.style.display = 'inline-flex';
  actionResults[currentAction] = resultBox.innerHTML;
}

function showError(text) {
  resultBox.innerHTML = `<span class="error-text">${escapeHtml(text)}</span>`;
  resultBox.className = 'result-box';
  copyBtn.style.display = 'none';
}

function setLoading(loading) {
  isProcessing = loading;
  translateBtn.disabled = loading;
  translateBtn.textContent = loading ? '处理中...' : '执行';
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

  html = html.replace(
    /(<strong>Terms<\/strong><br>)([\s\S]*?)(?=<br><br>|<br><strong>|$)/,
    (_, header, body) => {
      const items = body
        .split(/<br>\s*/)
        .map(l => l.trim())
        .filter(l => l && /^\d+\./.test(l))
        .map(l => `<div class="term-item">${l.replace(/^\d+\.\s*/, '')}</div>`)
        .join('');
      return items ? `${header}<div class="terms-card">${items}</div>` : header;
    }
  );
  return html;
}

function updateKeywordsDisplay(keywords) {
  const refreshBtn = '<span class="keywords-refresh" title="Force refresh keywords" id="kwRefresh">&#x21bb;</span>';
  if (!keywords || keywords.length === 0) {
    keywordsBar.innerHTML = '<span class="keywords-label">Domain</span><span class="keywords-empty">accumulating...</span>' + refreshBtn;
    keywordsBar.querySelector('#kwRefresh')?.addEventListener('click', forceRefreshKeywords);
    return;
  }
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
          if (sourceText.value.trim() && !isProcessing && currentAction === 'translate') {
            actionResults.translate = null;
            handleExecute();
          }
        }
      });
    });
  });
  keywordsBar.querySelector('#kwRefresh')?.addEventListener('click', forceRefreshKeywords);
}

function forceRefreshKeywords() {
  if (isProcessing) return;
  const refreshEl = keywordsBar.querySelector('#kwRefresh');
  if (refreshEl) refreshEl.textContent = '...';
  chrome.runtime.sendMessage({ type: 'FORCE_UPDATE_KEYWORDS' }, resp => {
    if (resp?.success && resp.data?.keywords) {
      updateKeywordsDisplay(resp.data.keywords);
      if (sourceText.value.trim() && !isProcessing && currentAction === 'translate') {
        actionResults.translate = null;
        handleExecute();
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
  chrome.storage.local.get(['defaultTargetLang'], r => {
    if (r.defaultTargetLang) targetLang.value = r.defaultTargetLang;
    settings.targetLang = r.defaultTargetLang || 'zh';
    chrome.storage.local.get('llmEndpoints', r2 => {
      const endpoints = r2.llmEndpoints || [];
      settings.hasLLM = endpoints.some(e => e.apiKey);
    });
  });
}

function sendMessageToBackground(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(response);
    });
  });
}
