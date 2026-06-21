// Per-tab translation context manager
// Stores original source sentences (per-intent) + shared domain keywords (per-tab)

const STORAGE_PREFIX = 'ctx:';
const MAX_SENTENCES = 50;  // max source sentences per intent per tab
const KEYWORD_COUNT = 5;   // number of domain keywords to maintain
const FLUSH_DELAY = 300;   // ms to wait before flushing dirty data to storage
const FLUSH_MAX_WAIT = 1500; // max ms before forcing a flush even with repeated dirty marks

export class ContextManager {
  constructor() {
    this._cache = new Map();
    this._dirty = new Set();
    this._flushTimer = null;
    this._flushMaxTimer = null;
    this._configCache = new Map();
  }

  async _load(tabId) {
    if (this._cache.has(tabId)) return this._cache.get(tabId);
    const result = await chrome.storage.local.get(`${STORAGE_PREFIX}${tabId}`);
    const data = result[`${STORAGE_PREFIX}${tabId}`] || {
      meaning: { sentences: [], totalTranslated: 0 },
      grammar: { sentences: [], totalTranslated: 0 },
      _shared: { keywords: [], totalTranslated: 0 },
      explain: { history: [] },
    };
    this._cache.set(tabId, data);
    return data;
  }

  /** Mark a tab's context as needing persistence, schedule a delayed flush. */
  _markDirty(tabId) {
    this._dirty.add(tabId);
    if (this._flushTimer) clearTimeout(this._flushTimer);
    this._flushTimer = setTimeout(() => this._flush(), FLUSH_DELAY);
    // Enforce max wait: schedule a force flush if data stays dirty too long
    if (!this._flushMaxTimer) {
      this._flushMaxTimer = setTimeout(() => {
        this._flushMaxTimer = null;
        this._forceFlush();
      }, FLUSH_MAX_WAIT);
    }
  }

  /** Force flush regardless of debounce timer (for max-wait enforcement). */
  _forceFlush() {
    if (this._flushMaxTimer) {
      clearTimeout(this._flushMaxTimer);
      this._flushMaxTimer = null;
    }
    if (this._flushTimer) {
      clearTimeout(this._flushTimer);
      this._flushTimer = null;
    }
    this._flush();
  }

  /** Immediately flush all dirty contexts to storage. */
  async _flush() {
    const dirtyIds = [...this._dirty];
    this._dirty.clear();
    this._flushTimer = null;
    if (this._flushMaxTimer) {
      clearTimeout(this._flushMaxTimer);
      this._flushMaxTimer = null;
    }
    if (dirtyIds.length === 0) return;
    const updates = {};
    for (const tabId of dirtyIds) {
      if (this._cache.has(tabId)) {
        updates[`${STORAGE_PREFIX}${tabId}`] = this._cache.get(tabId);
      }
    }
    if (Object.keys(updates).length > 0) {
      await chrome.storage.local.set(updates);
    }
  }

  /** Flush immediately and wait for completion. For use before critical reads. */
  async flushNow() {
    if (this._flushTimer) {
      clearTimeout(this._flushTimer);
      this._flushTimer = null;
    }
    if (this._flushMaxTimer) {
      clearTimeout(this._flushMaxTimer);
      this._flushMaxTimer = null;
    }
    await this._flush();
  }

  /** Read a low-frequency config value from storage, with in-memory cache. */
  async _getConfig(key, defaultValue) {
    if (this._configCache.has(key)) return this._configCache.get(key);
    const result = await chrome.storage.local.get(key);
    const value = result[key] ?? defaultValue;
    this._configCache.set(key, value);
    return value;
  }

  /** Invalidate config cache (call when settings change). */
  invalidateConfigCache() {
    this._configCache.clear();
  }

  /**
   * Add a source sentence to context history.
   * Returns true if keywords should be updated (every N sentences, where N is configurable).
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
    this._markDirty(tabId);

    // Use cached config instead of reading storage every time
    const interval = await this._getConfig('keywordUpdateInterval', 10);

    // Signal that keywords need updating
    return ctx._shared.totalTranslated % interval === 0;
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
    this._markDirty(tabId);
    return ctx._shared.keywords;
  }

  /**
   * Promote a keyword (user clicked it, move to front = higher relevance).
   */
  async promoteKeyword(tabId, keyword) {
    const ctx = await this._load(tabId);
    const kws = ctx._shared?.keywords || [];
    // keyword may be a string (original) from promote, match by original or translated
    const idx = kws.findIndex(k =>
      (typeof k === 'string' && k === keyword) ||
      (k?.original === keyword) ||
      (k?.translated === keyword)
    );
    if (idx > 0) {
      const [item] = kws.splice(idx, 1);
      kws.unshift(item);
      ctx._shared = ctx._shared || { keywords: [], totalTranslated: 0 };
      ctx._shared.keywords = kws;
      this._cache.set(tabId, ctx);
      this._markDirty(tabId);
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
    this._dirty.delete(tabId);
    this._cache.delete(tabId);
    await chrome.storage.local.remove(`${STORAGE_PREFIX}${tabId}`);
  }

  // ─── Explain conversation history ───

  /**
   * Add multiple conversation turns to the explain history in one write.
   * @param {number} tabId
   * @param {Array<{role: 'user'|'assistant', content: string}>} turns
   */
  async addExplainTurns(tabId, turns) {
    const ctx = await this._load(tabId);
    if (!ctx.explain) ctx.explain = { history: [] };
    for (const { role, content } of turns) {
      ctx.explain.history.push({ role, content });
    }
    // Keep max 40 turns (20 exchanges)
    if (ctx.explain.history.length > 40) {
      ctx.explain.history = ctx.explain.history.slice(-40);
    }
    this._cache.set(tabId, ctx);
    this._markDirty(tabId);
  }

  /**
   * Add a single conversation turn to the explain history.
   * @param {number} tabId
   * @param {'user'|'assistant'} role
   * @param {string} content
   */
  async addExplainTurn(tabId, role, content) {
    await this.addExplainTurns(tabId, [{ role, content }]);
  }

  /**
   * Get the explain conversation history.
   */
  async getExplainHistory(tabId) {
    const ctx = await this._load(tabId);
    return ctx.explain?.history || [];
  }

  /**
   * Clear explain conversation history for a tab.
   */
  async clearExplainHistory(tabId) {
    const ctx = await this._load(tabId);
    ctx.explain = { history: [] };
    this._cache.set(tabId, ctx);
    this._markDirty(tabId);
  }
}
