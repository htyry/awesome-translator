// background.js — Service Worker (ES Module)
// Handles LLM API calls, context management, message routing

import { LLMClient } from './lib/llm-client.js';
import { freeTranslate } from './lib/free-translate.js';
import { classifyIntent } from './lib/intent-classifier.js';
import { ContextManager } from './lib/context-manager.js';
import { buildMessages, buildKeywordPrompt } from './lib/prompt-templates.js';

// ─── State ───
let llmClient = null;
const contextManager = new ContextManager();

// ─── Init ───
async function init() {
  const s = await chrome.storage.local.get([
    'llmEndpoint', 'llmApiKey', 'llmModel',
  ]);
  if (s.llmApiKey) {
    llmClient = new LLMClient({
      endpoint: s.llmEndpoint,
      apiKey: s.llmApiKey,
      model: s.llmModel,
    });
  }
}
init();

// ─── Tab lifecycle: clean up context on close / navigate ───
chrome.tabs.onRemoved.addListener(tabId => contextManager.clearTab(tabId));
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === 'loading') contextManager.clearTab(tabId);
});

// ─── Context menu ───
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'translateSelection',
    title: 'Translate "%s"',
    contexts: ['selection'],
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'translateSelection' && info.selectionText) {
    chrome.tabs.sendMessage(tab.id, {
      type: 'TRANSLATE_TEXT',
      text: info.selectionText,
    });
  }
});

// ─── Keyboard shortcut ───
chrome.commands.onCommand.addListener(command => {
  if (command === 'trigger-translate') {
    chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
      if (tabs[0]?.id) {
        chrome.tabs.sendMessage(tabs[0].id, { type: 'TRIGGER_TRANSLATE' }, () => {
          void chrome.runtime.lastError;
        });
      }
    });
  }
});

// ─── Port-based streaming for agent / deep modes ───
chrome.runtime.onConnect.addListener(port => {
  if (port.name !== 'translation') return;

  const tabId = port.sender?.tab?.id;
  let abortCtrl = null;

  port.onDisconnect.addListener(() => {
    if (abortCtrl) abortCtrl.abort();
  });

  port.onMessage.addListener(async msg => {
    if (msg.action !== 'translate') return;

    abortCtrl = new AbortController();

    try {
      const { text, mode, intent, targetLang } = msg;

      // ── Quick mode: free API ──
      if (mode === 'quick') {
        const result = await freeTranslate(text, targetLang);
        port.postMessage({ type: 'result', content: result });
        recordUsage('quick', text.length, result.length);
        return;
      }

      // ── Agent / Deep: LLM required ──
      if (!llmClient) {
        port.postMessage({
          type: 'error',
          error: 'LLM not configured. Please set up your API in Settings.',
        });
        return;
      }

      // Detect intent (auto) or use specified
      const detected = intent || classifyIntent(text);
      port.postMessage({ type: 'intent', intent: detected });

      // Build context: keywords + recent sentences
      const s = await chrome.storage.local.get([
        'contextHistoryLimit', 'userProfile',
        'customPrompt_agent_meaning', 'customPrompt_agent_grammar', 'customPrompt_deep',
      ]);
      const limit = s.contextHistoryLimit || 10;
      const profile = s.userProfile || '';
      const customPrompts = {
        agent_meaning: s.customPrompt_agent_meaning || '',
        agent_grammar: s.customPrompt_agent_grammar || '',
        deep: s.customPrompt_deep || '',
      };
      Object.keys(customPrompts).forEach(k => { if (!customPrompts[k]) delete customPrompts[k]; });

      const [keywords, sentences] = await Promise.all([
        contextManager.getKeywords(tabId),
        contextManager.getSentences(tabId, detected, limit),
      ]);

      const context = { keywords, sentences };

      // Build LLM messages (system prompt has context embedded)
      const messages = buildMessages(mode, detected, text, targetLang, context, profile, customPrompts);

      // Stream response
      let full = '';
      for await (const chunk of llmClient.chatStream(messages, { signal: abortCtrl.signal })) {
        full += chunk;
        port.postMessage({ type: 'chunk', content: chunk });
      }

      // Record source sentence (not the full translation — saves tokens)
      const shouldUpdate = await contextManager.addSentence(tabId, detected, text);

      // Record usage
      recordUsage(mode, text.length, full.length);

      // Send shared keywords to frontend for display
      const currentKeywords = await contextManager.getKeywords(tabId);
      port.postMessage({ type: 'done', content: full, keywords: currentKeywords });

      // Background keyword update (non-blocking, uses all sentences across intents)
      if (shouldUpdate && llmClient) {
        updateKeywords(tabId).catch(() => {});
      }
    } catch (e) {
      if (e.name !== 'AbortError') {
        port.postMessage({ type: 'error', error: e.message });
      }
    }
  });
});

// ─── Keyword extraction (background, non-blocking) ───
async function updateKeywords(tabId, force = false) {
  if (!llmClient) return;

  const [sentences, existingKeywords] = await Promise.all([
    contextManager.getAllSentences(tabId, 20),
    contextManager.getKeywords(tabId),
  ]);

  if (!force && sentences.length < 3) return;

  try {
    const messages = buildKeywordPrompt(sentences, existingKeywords);
    const result = await llmClient.chat(messages, { maxTokens: 200 });

    // Parse JSON array from response
    let keywords = [];
    const jsonMatch = result.match(/\[[\s\S]*?\]/);
    if (jsonMatch) {
      keywords = JSON.parse(jsonMatch[0]);
    }

    if (Array.isArray(keywords) && keywords.length > 0) {
      // Clean up: ensure strings only
      keywords = keywords.filter(k => typeof k === 'string').slice(0, 5);
      await contextManager.updateKeywords(tabId, keywords);

      // Notify content script about keyword update (shared, no intent)
      try {
        chrome.tabs.sendMessage(tabId, { type: 'KEYWORDS_UPDATED', keywords });
      } catch {}
    }
  } catch (e) {
    console.warn('Keyword extraction failed:', e.message);
  }
}

// ─── API Usage Tracking ───
async function recordUsage(mode, inputChars, outputChars) {
  const today = new Date().toISOString().slice(0, 10);
  const key = `usage_${today}`;
  const result = await chrome.storage.local.get(key);
  const data = result[key] || {
    count: 0, inputChars: 0, outputChars: 0,
    quickCount: 0, agentCount: 0, deepCount: 0,
    llmModel: '', llmEndpoint: '',
  };
  data.count++;
  data.inputChars += inputChars;
  data.outputChars += outputChars;
  if (mode === 'quick') data.quickCount++;
  else if (mode === 'agent') data.agentCount++;
  else if (mode === 'deep') data.deepCount++;

  if (mode !== 'quick' && llmClient) {
    const cfg = llmClient.getConfig();
    data.llmModel = cfg.model || '';
    data.llmEndpoint = cfg.endpoint || '';
  }

  await chrome.storage.local.set({ [key]: data });
}

async function getUsageStats() {
  const all = await chrome.storage.local.get(null);
  const stats = [];
  for (const key of Object.keys(all)) {
    if (!key.startsWith('usage_')) continue;
    const date = key.slice(5);
    stats.push({ date, ...all[key] });
  }
  stats.sort((a, b) => b.date.localeCompare(a.date));
  return stats;
}

async function resetUsageStats() {
  const all = await chrome.storage.local.get(null);
  const keys = Object.keys(all).filter(k => k.startsWith('usage_'));
  if (keys.length) await chrome.storage.local.remove(keys);
  return keys.length;
}

// ─── Simple message handler ───
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  switch (message.type) {
    case 'GET_TRANSLATION': {
      const targetLang = message.targetLang || 'zh';
      freeTranslate(message.text, targetLang)
        .then(result => sendResponse({ success: true, data: { translatedText: result } }))
        .catch(err => sendResponse({ success: false, error: err.message }));
      return true;
    }

    case 'SAVE_SETTINGS':
      chrome.storage.local.set(message.settings, () => {
        sendResponse({ success: true });
        init();
      });
      return true;

    case 'TEST_LLM':
      testLLM(message.settings)
        .then(r => sendResponse(r))
        .catch(e => sendResponse({ success: false, error: e.message }));
      return true;

    case 'GET_LLM_STATUS':
      sendResponse({
        success: true,
        data: llmClient ? llmClient.getConfig() : null,
      });
      return false;

    case 'SETTINGS_UPDATED':
      init();
      sendResponse({ success: true });
      return false;

    case 'GET_USAGE_STATS':
      getUsageStats().then(stats => sendResponse({ success: true, data: stats }));
      return true;

    case 'RESET_USAGE_STATS':
      resetUsageStats().then(count => sendResponse({ success: true, data: { deleted: count } }));
      return true;

    case 'PROMOTE_KEYWORD': {
      const tid = _sender.tab?.id;
      if (!tid) { sendResponse({ success: false, error: 'No tab context' }); return true; }
      const { keyword } = message;
      contextManager.promoteKeyword(tid, keyword)
        .then(kws => {
          sendResponse({ success: true, data: { keywords: kws } });
          // Notify content script of keyword update
          try {
            chrome.tabs.sendMessage(tid, { type: 'KEYWORDS_UPDATED', keywords: kws });
          } catch {}
        })
        .catch(e => sendResponse({ success: false, error: e.message }));
      return true;
    }

    case 'FORCE_UPDATE_KEYWORDS': {
      const tid = _sender.tab?.id;
      if (!tid) { sendResponse({ success: false, error: 'No tab context' }); return true; }
      updateKeywords(tid, true)
        .then(kws => sendResponse({ success: true, data: { keywords: kws } }))
        .catch(e => sendResponse({ success: false, error: e.message }));
      return true;
    }

    case 'GET_KEYWORDS': {
      const tid = _sender.tab?.id;
      if (!tid) { sendResponse({ success: false, error: 'No tab context' }); return true; }
      contextManager.getKeywords(tid)
        .then(kws => sendResponse({ success: true, data: { keywords: kws } }))
        .catch(e => sendResponse({ success: false, error: e.message }));
      return true;
    }

    default:
      sendResponse({ success: false, error: 'Unknown message type' });
      return false;
  }
});

// ─── Helpers ───
async function testLLM(settings) {
  try {
    const client = new LLMClient({
      endpoint: settings.llmEndpoint,
      apiKey: settings.llmApiKey,
      model: settings.llmModel,
    });
    const result = await client.chat(
      [{ role: 'user', content: 'Say "OK" in one word.' }],
      { maxTokens: 10 }
    );
    return { success: true, data: result };
  } catch (e) {
    return { success: false, error: e.message };
  }
}
