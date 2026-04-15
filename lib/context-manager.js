// Per-tab translation context manager
// Stores original source sentences (per-intent) + shared domain keywords (per-tab)

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
      meaning: { sentences: [], totalTranslated: 0 },
      grammar: { sentences: [], totalTranslated: 0 },
      _shared: { keywords: [], totalTranslated: 0 },
    };
    this._cache.set(tabId, data);
    return data;
  }

  /**
   * Add a source sentence to context history.
   * Returns true if keywords should be updated (every KEYWORD_UPDATE_INTERVAL total sentences).
   */
  async addSentence(tabId, intent, sourceText) {
    const ctx = await this._load(tabId);
    if (!ctx[intent]) {
      ctx[intent] = { sentences: [], totalTranslated: 0 };
    }
    if (!ctx._shared) {
      ctx._shared = { keywords: [], totalTranslated: 0 };
    }

    const trimmed = sourceText.trim();
    if (!trimmed) return false;

    ctx[intent].sentences.push({ text: trimmed, ts: Date.now() });
    ctx[intent].totalTranslated++;
    ctx._shared.totalTranslated++;

    // Trim old sentences
    if (ctx[intent].sentences.length > MAX_SENTENCES) {
      ctx[intent].sentences = ctx[intent].sentences.slice(-MAX_SENTENCES);
    }

    this._cache.set(tabId, ctx);
    await chrome.storage.local.set({ [`${STORAGE_PREFIX}${tabId}`]: ctx });

    // Signal that keywords need updating
    return ctx._shared.totalTranslated % KEYWORD_UPDATE_INTERVAL === 0;
  }

  /**
   * Get the latest N source sentences for a specific intent.
   */
  async getSentences(tabId, intent, maxCount = 10) {
    const ctx = await this._load(tabId);
    const sentences = (ctx[intent]?.sentences || []).slice(-maxCount);
    return sentences.map(s => s.text);
  }

  /**
   * Get ALL recent sentences across intents (for keyword extraction).
   */
  async getAllSentences(tabId, maxCount = 20) {
    const ctx = await this._load(tabId);
    const meaning = (ctx.meaning?.sentences || []).map(s => ({ ...s, intent: 'meaning' }));
    const grammar = (ctx.grammar?.sentences || []).map(s => ({ ...s, intent: 'grammar' }));
    const all = [...meaning, ...grammar].sort((a, b) => a.ts - b.ts);
    return all.slice(-maxCount).map(s => s.text);
  }

  /**
   * Get current shared domain keywords (not intent-specific).
   */
  async getKeywords(tabId) {
    const ctx = await this._load(tabId);
    return ctx._shared?.keywords || [];
  }

  /**
   * Update shared domain keywords (called by background.js after LLM extraction).
   */
  async updateKeywords(tabId, keywords) {
    const ctx = await this._load(tabId);
    if (!ctx._shared) {
      ctx._shared = { keywords: [], totalTranslated: 0 };
    }
    ctx._shared.keywords = (keywords || []).slice(0, KEYWORD_COUNT);
    this._cache.set(tabId, ctx);
    await chrome.storage.local.set({ [`${STORAGE_PREFIX}${tabId}`]: ctx });
    return ctx._shared.keywords;
  }

  /**
   * Promote a keyword (user clicked it, move to front = higher relevance).
   */
  async promoteKeyword(tabId, keyword) {
    const ctx = await this._load(tabId);
    const kws = ctx._shared?.keywords || [];
    const idx = kws.indexOf(keyword);
    if (idx > 0) {
      kws.splice(idx, 1);
      kws.unshift(keyword);
      ctx._shared = ctx._shared || { keywords: [], totalTranslated: 0 };
      ctx._shared.keywords = kws;
      this._cache.set(tabId, ctx);
      await chrome.storage.local.set({ [`${STORAGE_PREFIX}${tabId}`]: ctx });
    }
    return ctx._shared?.keywords || [];
  }

  /**
   * Get total translated count across all intents.
   */
  async getTotalCount(tabId) {
    const ctx = await this._load(tabId);
    return ctx._shared?.totalTranslated || 0;
  }

  async clearTab(tabId) {
    this._cache.delete(tabId);
    await chrome.storage.local.remove(`${STORAGE_PREFIX}${tabId}`);
  }
}
