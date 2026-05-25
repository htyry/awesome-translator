// background.js — Service Worker (ES Module)
// Handles LLM API calls, context management, message routing

import { LLMClient } from './lib/llm-client.js';
import { freeTranslate } from './lib/free-translate.js';
import { classifyIntent } from './lib/intent-classifier.js';
import { ContextManager } from './lib/context-manager.js';
import { buildMessages, buildKeywordPrompt, buildExplainMessages } from './lib/prompt-templates.js';

// ─── State ───
let llmClient = null;
let explainClient = null;
let activeEndpointId = null;
const contextManager = new ContextManager();

// ─── Init ───
async function init() {
  await initLLMClient();
  await initExplainClient();
}

async function initLLMClient() {
  const s = await chrome.storage.local.get(['llmEndpoints', 'activeEndpointId', 'llmEndpoint', 'llmApiKey', 'llmModel']);
  const endpoints = s.llmEndpoints || [];
  activeEndpointId = s.activeEndpointId || null;

  // If no endpoints array but legacy single config exists, migrate it
  if (endpoints.length === 0 && s.llmApiKey) {
    const migrated = {
      id: 'default',
      name: `${s.llmModel || 'gpt-4o-mini'} @ ${extractDomain(s.llmEndpoint)}`,
      endpoint: s.llmEndpoint || 'https://api.openai.com/v1',
      apiKey: s.llmApiKey,
      model: s.llmModel || 'gpt-4o-mini',
    };
    await chrome.storage.local.set({ llmEndpoints: [migrated], activeEndpointId: 'default' });
    llmClient = new LLMClient({ endpoint: migrated.endpoint, apiKey: migrated.apiKey, model: migrated.model, maxRetries: 3, timeoutMs: 30_000 });
    activeEndpointId = 'default';
    return;
  }

  // Use active endpoint or fall back to first one
  let ep = endpoints.find(e => e.id === activeEndpointId) || endpoints[0] || null;
  if (ep && ep.apiKey) {
    activeEndpointId = ep.id;
    llmClient = new LLMClient({ endpoint: ep.endpoint, apiKey: ep.apiKey, model: ep.model, maxRetries: 3, timeoutMs: 30_000 });
  } else {
    llmClient = null;
    activeEndpointId = null;
  }
}

function extractDomain(url) {
  try {
    return new URL(url).hostname.replace(/^api\./, '');
  } catch { return 'unknown'; }
}

async function initExplainClient() {
  const s = await chrome.storage.local.get(['explainEndpointId', 'llmEndpoints']);
  const endpoints = s.llmEndpoints || [];
  const explainId = s.explainEndpointId;

  if (explainId) {
    const ep = endpoints.find(e => e.id === explainId);
    if (ep && ep.apiKey) {
      explainClient = new LLMClient({ endpoint: ep.endpoint, apiKey: ep.apiKey, model: ep.model, maxRetries: 3, timeoutMs: 30_000 });
      return;
    }
  }

  // Fall back to translation endpoint
  explainClient = llmClient;
}

init();

// ─── Get active endpoint info ───
async function getActiveEndpoint() {
  const s = await chrome.storage.local.get(['llmEndpoints', 'activeEndpointId']);
  const endpoints = s.llmEndpoints || [];
  const id = s.activeEndpointId || activeEndpointId;
  return endpoints.find(e => e.id === id) || endpoints[0] || null;
}

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
    let retryCount = 0;

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
      let tokenUsage = null;
      const startTime = performance.now();
      const clientConfig = llmClient.getConfig();

      for await (const chunk of llmClient.chatStream(messages, {
        signal: abortCtrl.signal,
        onUsage: (u) => { tokenUsage = u; },
        onRetry: (n) => {
          retryCount = n;
          try { port.postMessage({ type: 'retry', attempt: n }); } catch {}
        },
      })) {
        full += chunk;
        port.postMessage({ type: 'chunk', content: chunk });
      }

      const latency = Math.round(performance.now() - startTime);

      // Record source sentence (not the full translation — saves tokens)
      const shouldUpdate = await contextManager.addSentence(tabId, detected, text);

      // Record usage with token data
      const systemPromptChars = messages[0]?.content?.length || 0;
      recordUsage(mode, text.length, full.length, systemPromptChars, tokenUsage);

      // Send shared keywords to frontend for display (reuse already-fetched keywords)
      port.postMessage({
        type: 'done',
        content: full,
        keywords,
        meta: {
          model: clientConfig.model,
          endpoint: clientConfig.endpoint,
          latency,
          retries: retryCount,
          tokens: tokenUsage ? {
            input: tokenUsage.prompt_tokens || 0,
            output: tokenUsage.completion_tokens || 0,
            cached: tokenUsage.prompt_tokens_details?.cached_tokens || 0,
          } : null,
        },
      });

      // Background keyword update (non-blocking, uses all sentences across intents)
      if (shouldUpdate && llmClient) {
        updateKeywords(tabId, false, targetLang).catch(() => {});
      }
    } catch (e) {
      if (e.name === 'AbortError' && !e._timeout) {
        // User-initiated cancel — silent
      } else {
        const msg = e._timeout
          ? 'Request timed out. Please check your network connection and try again.'
          : e.message;
        const clientConfig = llmClient?.getConfig();
        port.postMessage({
          type: 'error',
          error: msg,
          meta: clientConfig ? {
            model: clientConfig.model,
            endpoint: clientConfig.endpoint,
            retries: retryCount,
          } : null,
        });
      }
    }
  });
});

// ─── Port-based streaming for Explain mode ───
chrome.runtime.onConnect.addListener(port => {
  if (port.name !== 'explanation') return;

  const tabId = port.sender?.tab?.id;
  let abortCtrl = null;

  port.onDisconnect.addListener(() => {
    if (abortCtrl) abortCtrl.abort();
  });

  port.onMessage.addListener(async msg => {
    if (msg.action !== 'explain') return;

    abortCtrl = new AbortController();
    let retryCount = 0;

    try {
      const { text, question, targetLang } = msg;
      const client = explainClient || llmClient;

      if (!client) {
        port.postMessage({ type: 'error', error: 'LLM not configured. Please set up your API in Settings.' });
        return;
      }

      // Read settings
      const s = await chrome.storage.local.get([
        'contextHistoryLimit', 'userProfile',
        'customPrompt_explain', 'explainThinkingMode',
      ]);
      const profile = s.userProfile || '';
      const customPrompt = s.customPrompt_explain || '';
      const thinkingEnabled = s.explainThinkingMode || false;

      // Get context
      const limit = s.contextHistoryLimit || 10;
      const [keywords, sentences, history] = await Promise.all([
        contextManager.getKeywords(tabId),
        contextManager.getSentences(tabId, 'meaning', limit),
        contextManager.getExplainHistory(tabId),
      ]);
      const context = { keywords, sentences };

      // Build messages with conversation history
      const messages = buildExplainMessages(text, question, targetLang, context, profile, customPrompt, history);

      // Stream response
      let full = '';
      let thinkingFull = '';
      let tokenUsage = null;
      const startTime = performance.now();
      const clientConfig = client.getConfig();

      for await (const chunk of client.chatStream(messages, {
        signal: abortCtrl.signal,
        onUsage: (u) => { tokenUsage = u; },
        onThinking: thinkingEnabled ? (t) => {
          thinkingFull += t;
          port.postMessage({ type: 'thinking', content: t });
        } : null,
        onRetry: (n) => {
          retryCount = n;
          try { port.postMessage({ type: 'retry', attempt: n }); } catch {}
        },
      })) {
        full += chunk;
        port.postMessage({ type: 'chunk', content: chunk });
      }

      const latency = Math.round(performance.now() - startTime);

      // Record conversation turns (batch write)
      await contextManager.addExplainTurns(tabId, [
        { role: 'user', content: question || 'Explain this text' },
        { role: 'assistant', content: full },
      ]);

      // Record usage
      const systemPromptChars = messages[0]?.content?.length || 0;
      recordUsage('explain', text.length, full.length, systemPromptChars, tokenUsage);

      port.postMessage({
        type: 'done',
        content: full,
        thinking: thinkingFull,
        meta: {
          model: clientConfig.model,
          endpoint: clientConfig.endpoint,
          latency,
          retries: retryCount,
          tokens: tokenUsage ? {
            input: tokenUsage.prompt_tokens || 0,
            output: tokenUsage.completion_tokens || 0,
            cached: tokenUsage.prompt_tokens_details?.cached_tokens || 0,
          } : null,
        },
      });
    } catch (e) {
      if (e.name === 'AbortError' && !e._timeout) {
        // User-initiated cancel — silent
      } else {
        const msg = e._timeout
          ? 'Request timed out. Please check your network connection and try again.'
          : e.message;
        const errClientConfig = client?.getConfig?.();
        port.postMessage({
          type: 'error',
          error: msg,
          meta: errClientConfig ? {
            model: errClientConfig.model,
            endpoint: errClientConfig.endpoint,
            retries: retryCount,
          } : null,
        });
      }
    }
  });
});

// ─── Keyword extraction (background, non-blocking) ───
async function updateKeywords(tabId, force = false, targetLang = 'zh') {
  if (!llmClient) return;

  // Use cached config (shared with ContextManager)
  const interval = await contextManager._getConfig('keywordUpdateInterval', 10);

  const [sentences, existingKeywords] = await Promise.all([
    contextManager.getAllSentences(tabId, interval),
    contextManager.getKeywords(tabId),
  ]);

  if (!force && sentences.length < 3) return;

  try {
    const messages = buildKeywordPrompt(sentences, existingKeywords, targetLang);
    const { content: result } = await llmClient.chat(messages, { maxTokens: 300 });

    // Parse JSON array from response
    let keywords = [];
    const jsonMatch = result.match(/\[[\s\S]*?\]/);
    if (jsonMatch) {
      keywords = JSON.parse(jsonMatch[0]);
    }

    if (Array.isArray(keywords) && keywords.length > 0) {
      // Normalize to { original, translated } objects
      keywords = keywords.map(k => {
        if (typeof k === 'string') return { original: k, translated: k };
        if (k && k.original) return { original: k.original, translated: k.translated || k.original };
        return null;
      }).filter(Boolean).slice(0, 5);
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
// Per-day totals key: usage_YYYY-MM-DD -> { count, inputChars, outputChars, quickCount, agentCount, deepCount, inputTokens, outputTokens, cachedTokens }
// Per-model-per-day key: usage_YYYY-MM-DD:modelName -> { count, inputChars, outputChars, endpoint, inputTokens, outputTokens, cachedTokens }

function usageKey(date) { return `usage_${date}`; }
function modelUsageKey(date, model) { return `usage_${date}:${model}`; }

function recordUsage(mode, inputChars, outputChars, systemPromptChars = 0, tokenUsage = null) {
  const today = new Date().toISOString().slice(0, 10);
  const totalInputChars = inputChars + (mode !== 'quick' ? systemPromptChars : 0);

  // Extract token counts from API response
  const inputTokens = tokenUsage?.prompt_tokens || 0;
  const outputTokens = tokenUsage?.completion_tokens || 0;
  // OpenAI cached tokens: prompt_tokens_details.cached_tokens
  const cachedTokens = tokenUsage?.prompt_tokens_details?.cached_tokens || 0;

  // Update daily totals (read-modify-write, but each field is additive so safe)
  const dayKey = usageKey(today);
  chrome.storage.local.get(dayKey, (result) => {
    const data = result[dayKey] || {
      count: 0, inputChars: 0, outputChars: 0,
      quickCount: 0, agentCount: 0, deepCount: 0, explainCount: 0,
      inputTokens: 0, outputTokens: 0, cachedTokens: 0,
    };
    data.count++;
    data.inputChars += totalInputChars;
    data.outputChars += outputChars;
    if (mode === 'quick') data.quickCount++;
    else if (mode === 'agent') data.agentCount++;
    else if (mode === 'deep') data.deepCount++;
    else if (mode === 'explain') data.explainCount = (data.explainCount || 0) + 1;
    data.inputTokens = (data.inputTokens || 0) + inputTokens;
    data.outputTokens = (data.outputTokens || 0) + outputTokens;
    data.cachedTokens = (data.cachedTokens || 0) + cachedTokens;
    // Strip legacy fields to keep daily key clean
    delete data.models;
    delete data.llmModel;
    delete data.llmEndpoint;
    chrome.storage.local.set({ [dayKey]: data });
  });

  // Update per-model stats (separate key per model — no cross-model race)
  if (mode !== 'quick') {
    let modelName = 'unknown';
    let endpointUrl = '';
    if (llmClient) {
      const cfg = llmClient.getConfig();
      modelName = cfg.model || 'unknown';
      endpointUrl = cfg.endpoint || '';
    }

    const mKey = modelUsageKey(today, modelName);
    chrome.storage.local.get(mKey, (result) => {
      const mData = result[mKey] || { count: 0, inputChars: 0, outputChars: 0, endpoint: endpointUrl, inputTokens: 0, outputTokens: 0, cachedTokens: 0 };
      mData.count++;
      mData.inputChars += totalInputChars;
      mData.outputChars += outputChars;
      if (endpointUrl && !mData.endpoint) mData.endpoint = endpointUrl;
      mData.inputTokens = (mData.inputTokens || 0) + inputTokens;
      mData.outputTokens = (mData.outputTokens || 0) + outputTokens;
      mData.cachedTokens = (mData.cachedTokens || 0) + cachedTokens;
      chrome.storage.local.set({ [mKey]: mData });
    });
  }
}

async function getUsageStats(query = {}) {
  const all = await chrome.storage.local.get(null);

  // Opportunistic cleanup: remove orphaned ctx: keys for tabs that no longer exist
  const ctxKeys = Object.keys(all).filter(k => k.startsWith('ctx:'));
  if (ctxKeys.length > 0) {
    const tabIds = new Set((await chrome.tabs.query({})).map(t => String(t.id)));
    const orphaned = ctxKeys.filter(k => !tabIds.has(k.slice(4)));
    if (orphaned.length) {
      chrome.storage.local.remove(orphaned); // fire-and-forget
    }
  }

  const dayMap = {};     // { date: { count, inputChars, outputChars, quickCount, agentCount, deepCount, explainCount, inputTokens, outputTokens, cachedTokens } }
  const modelDayMap = {}; // { date: { modelName: { count, inputChars, outputChars, endpoint, inputTokens, outputTokens, cachedTokens } } }
  const legacyDates = new Set(); // Track dates that had legacy fields

  for (const key of Object.keys(all)) {
    if (!key.startsWith('usage_')) continue;
    const val = all[key];

    // Match daily totals: usage_YYYY-MM-DD (no colon)
    const dayMatch = key.match(/^usage_(\d{4}-\d{2}-\d{2})$/);
    if (dayMatch) {
      const date = dayMatch[1];
      if (!dayMap[date]) dayMap[date] = { count: 0, inputChars: 0, outputChars: 0, quickCount: 0, agentCount: 0, deepCount: 0, explainCount: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0 };
      dayMap[date].count += val.count || 0;
      dayMap[date].inputChars += val.inputChars || 0;
      dayMap[date].outputChars += val.outputChars || 0;
      dayMap[date].quickCount += val.quickCount || 0;
      dayMap[date].agentCount += val.agentCount || 0;
      dayMap[date].deepCount += val.deepCount || 0;
      dayMap[date].explainCount = (dayMap[date].explainCount || 0) + (val.explainCount || 0);
      dayMap[date].inputTokens += val.inputTokens || 0;
      dayMap[date].outputTokens += val.outputTokens || 0;
      dayMap[date].cachedTokens += val.cachedTokens || 0;

      // Mark dates with legacy fields for later cleanup
      if (val.models || val.llmModel) {
        legacyDates.add(date);
      }
      continue;
    }

    // Match per-model: usage_YYYY-MM-DD:modelName
    const modelMatch = key.match(/^usage_(\d{4}-\d{2}-\d{2}):(.+)$/);
    if (modelMatch) {
      const date = modelMatch[1];
      const modelName = modelMatch[2];
      if (!modelDayMap[date]) modelDayMap[date] = {};
      modelDayMap[date][modelName] = val;
      continue;
    }
  }

  // Build per-model keys from legacy daily data (only if per-model key doesn't exist)
  const toWrite = {};
  const toClean = {};
  for (const date of legacyDates) {
    const dayKey = usageKey(date);
    const dayVal = all[dayKey];
    if (!dayVal) continue;

    // Extract legacy models
    if (dayVal.models && typeof dayVal.models === 'object') {
      if (!modelDayMap[date]) modelDayMap[date] = {};
      for (const [mName, mData] of Object.entries(dayVal.models)) {
        const mKey = modelUsageKey(date, mName);
        if (!all[mKey] && !toWrite[mKey]) {
          // Only use legacy data if no per-model key exists yet
          modelDayMap[date][mName] = mData;
          toWrite[mKey] = mData;
        }
      }
    }

    // Extract legacy llmModel/llmEndpoint
    if (dayVal.llmModel && !dayVal.models) {
      if (!modelDayMap[date]) modelDayMap[date] = {};
      const mName = dayVal.llmModel;
      const mKey = modelUsageKey(date, mName);
      if (!all[mKey] && !toWrite[mKey] && !modelDayMap[date][mName]) {
        modelDayMap[date][mName] = {
          count: (dayVal.agentCount || 0) + (dayVal.deepCount || 0),
          inputChars: dayVal.inputChars || 0,
          outputChars: dayVal.outputChars || 0,
          endpoint: dayVal.llmEndpoint || '',
          inputTokens: 0, outputTokens: 0, cachedTokens: 0,
        };
        toWrite[mKey] = modelDayMap[date][mName];
      }
    }

    // Clean legacy fields from daily key
    toClean[dayKey] = {
      count: dayVal.count || 0,
      inputChars: dayVal.inputChars || 0,
      outputChars: dayVal.outputChars || 0,
      quickCount: dayVal.quickCount || 0,
      agentCount: dayVal.agentCount || 0,
      deepCount: dayVal.deepCount || 0,
      explainCount: dayVal.explainCount || 0,
      inputTokens: dayVal.inputTokens || 0,
      outputTokens: dayVal.outputTokens || 0,
      cachedTokens: dayVal.cachedTokens || 0,
    };
  }

  // Persist migrated per-model keys and cleaned daily keys
  if (Object.keys(toWrite).length) {
    await chrome.storage.local.set(toWrite);
  }
  if (Object.keys(toClean).length) {
    await chrome.storage.local.set(toClean);
  }

  // Apply query filters
  let dates = new Set([...Object.keys(dayMap), ...Object.keys(modelDayMap)]);
  if (query.model) {
    // Only include dates that have the specified model
    const filteredDates = new Set();
    for (const date of dates) {
      if (modelDayMap[date] && modelDayMap[date][query.model]) {
        filteredDates.add(date);
      }
    }
    dates = filteredDates;
  }
  if (query.startDate) {
    dates = new Set([...dates].filter(d => d >= query.startDate));
  }
  if (query.endDate) {
    dates = new Set([...dates].filter(d => d <= query.endDate));
  }

  // Merge into final stats array
  const stats = [];
  for (const date of dates) {
    const day = dayMap[date] || { count: 0, inputChars: 0, outputChars: 0, quickCount: 0, agentCount: 0, deepCount: 0, explainCount: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0 };
    let models = modelDayMap[date] || {};

    // If filtering by model, restrict models and recalculate day totals from model data
    if (query.model) {
      const mData = models[query.model];
      if (!mData) continue;
      models = { [query.model]: mData };
      stats.push({
        date,
        count: mData.count || 0,
        inputChars: mData.inputChars || 0,
        outputChars: mData.outputChars || 0,
        quickCount: 0,
        agentCount: mData.count || 0,
        deepCount: 0,
        inputTokens: mData.inputTokens || 0,
        outputTokens: mData.outputTokens || 0,
        cachedTokens: mData.cachedTokens || 0,
        models,
      });
    } else {
      stats.push({ date, ...day, models });
    }
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

    case 'GET_LLM_STATUS': {
      getActiveEndpoint().then(ep => {
        sendResponse({
          success: true,
          data: ep ? {
            endpoint: ep.endpoint,
            model: ep.model,
            name: ep.name,
            id: ep.id,
            hasApiKey: !!ep.apiKey,
          } : null,
        });
      });
      return true;
    }

    case 'SETTINGS_UPDATED':
      contextManager.invalidateConfigCache();
      initLLMClient().then(() => initExplainClient()).then(() => sendResponse({ success: true }));
      return true;

    case 'SET_ACTIVE_ENDPOINT':
      chrome.storage.local.set({ activeEndpointId: message.endpointId }, () => {
        initLLMClient().then(() => sendResponse({ success: true }));
      });
      return true;

    case 'GET_USAGE_STATS':
      getUsageStats(message.query || {}).then(stats => sendResponse({ success: true, data: stats }));
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
      chrome.storage.local.get('defaultTargetLang', s => {
        updateKeywords(tid, true, s.defaultTargetLang || 'zh')
          .then(kws => sendResponse({ success: true, data: { keywords: kws } }))
          .catch(e => sendResponse({ success: false, error: e.message }));
      });
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

    case 'CLEAR_EXPLAIN_HISTORY': {
      const tid = _sender.tab?.id;
      if (!tid) { sendResponse({ success: false, error: 'No tab context' }); return true; }
      contextManager.clearExplainHistory(tid)
        .then(() => sendResponse({ success: true }))
        .catch(e => sendResponse({ success: false, error: e.message }));
      return true;
    }

    case 'GET_EXPLAIN_HISTORY': {
      const tid = _sender.tab?.id;
      if (!tid) { sendResponse({ success: false, error: 'No tab context' }); return true; }
      contextManager.getExplainHistory(tid)
        .then(history => sendResponse({ success: true, data: { history } }))
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
      maxRetries: 2,
      timeoutMs: 15_000,
    });
    const { content: result } = await client.chat(
      [{ role: 'user', content: 'Say "OK" in one word.' }],
      { maxTokens: 10 }
    );
    return { success: true, data: result };
  } catch (e) {
    return { success: false, error: e.message };
  }
}
