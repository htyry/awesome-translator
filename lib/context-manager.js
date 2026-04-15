// Per-tab translation context manager
// Only stores original source sentences + domain keywords (no full translations)

const STORAGE_PREFIX = 'ctx:';
const MAX_SENTENCES = 50;  // max source sentences per intent per tab
const KEYWORD_COUNT = 5;   // number of domain keywords to maintain
const KEYWORD_UPDATE_INTERVAL = 10; // update keywords every N new sentences

export class ContextManager {
  constructor() {
    this._cache = new Map();
  }

  async _load(tabId) {
    if (this._cache.has(tabId)) return this._cache.get(tabId);
    const result = await chrome.storage.local.get(`${STORAGE_PREFIX}${tabId}`);
    const data = result[`${STORAGE_PREFIX}${tabId}`] || {
      meaning: { sentences: [], keywords: [], totalTranslated: 0 },
      grammar: { sentences: [], keywords: [], totalTranslated: 0 },
    };
    this._cache.set(tabId, data);
    return data;
  }

  /**
   * Add a source sentence to context history.
   * Returns true if keywords should be updated (every KEYWORD_UPDATE_INTERVAL sentences).
   */
  async addSentence(tabId, intent, sourceText) {
    const ctx = await this._load(tabId);
    if (!ctx[intent]) {
      ctx[intent] = { sentences: [], keywords: [], totalTranslated: 0 };
    }

    const trimmed = sourceText.trim();
    if (!trimmed) return false;

    ctx[intent].sentences.push({ text: trimmed, ts: Date.now() });
    ctx[intent].totalTranslated++;

    // Trim old sentences
    if (ctx[intent].sentences.length > MAX_SENTENCES) {
      ctx[intent].sentences = ctx[intent].sentences.slice(-MAX_SENTENCES);
    }

    this._cache.set(tabId, ctx);
    await chrome.storage.local.set({ [`${STORAGE_PREFIX}${tabId}`]: ctx });

    // Signal that keywords need updating
    return ctx[intent].totalTranslated % KEYWORD_UPDATE_INTERVAL === 0;
  }

  /**
   * Get the latest N source sentences for context.
   */
  async getSentences(tabId, intent, maxCount = 10) {
    const ctx = await this._load(tabId);
    const sentences = (ctx[intent]?.sentences || []).slice(-maxCount);
    return sentences.map(s => s.text);
  }

  /**
   * Get current domain keywords.
   */
  async getKeywords(tabId, intent) {
    const ctx = await this._load(tabId);
    return ctx[intent]?.keywords || [];
  }

  /**
   * Update domain keywords (called by background.js after LLM extraction).
   */
  async updateKeywords(tabId, intent, keywords) {
    const ctx = await this._load(tabId);
    if (!ctx[intent]) {
      ctx[intent] = { sentences: [], keywords: [], totalTranslated: 0 };
    }
    ctx[intent].keywords = (keywords || []).slice(0, KEYWORD_COUNT);
    this._cache.set(tabId, ctx);
    await chrome.storage.local.set({ [`${STORAGE_PREFIX}${tabId}`]: ctx });
    return ctx[intent].keywords;
  }

  /**
   * Promote a keyword (user clicked it, move to front = higher relevance).
   */
  async promoteKeyword(tabId, intent, keyword) {
    const ctx = await this._load(tabId);
    const kws = ctx[intent]?.keywords || [];
    const idx = kws.indexOf(keyword);
    if (idx > 0) {
      kws.splice(idx, 1);
      kws.unshift(keyword);
      ctx[intent].keywords = kws;
      this._cache.set(tabId, ctx);
      await chrome.storage.local.set({ [`${STORAGE_PREFIX}${tabId}`]: ctx });
    }
    return ctx[intent]?.keywords || [];
  }

  /**
   * Get total translated count for an intent (used to decide keyword update).
   */
  async getTotalCount(tabId, intent) {
    const ctx = await this._load(tabId);
    return ctx[intent]?.totalTranslated || 0;
  }

  /**
   * Check if keywords need initial generation (first time reaching threshold).
   */
  async needsKeywordUpdate(tabId, intent) {
    const ctx = await this._load(tabId);
    const total = ctx[intent]?.totalTranslated || 0;
    // Need update if: no keywords yet but have enough sentences, or at interval
    const hasKw = (ctx[intent]?.keywords?.length || 0) > 0;
    if (!hasKw && total >= 3) return true;
    if (hasKw && total > 0 && total % KEYWORD_UPDATE_INTERVAL === 0) return true;
    return false;
  }

  async clearTab(tabId) {
    this._cache.delete(tabId);
    await chrome.storage.local.remove(`${STORAGE_PREFIX}${tabId}`);
  }
}
