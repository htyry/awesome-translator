// Per-tab translation conversation chain manager

const STORAGE_PREFIX = 'ctx:';
const MAX_HISTORY = 20; // max messages per intent per tab

export class ContextManager {
  constructor() {
    this._cache = new Map();
  }

  async _load(tabId) {
    if (this._cache.has(tabId)) return this._cache.get(tabId);
    const result = await chrome.storage.local.get(`${STORAGE_PREFIX}${tabId}`);
    const data = result[`${STORAGE_PREFIX}${tabId}`] || { meaning: [], grammar: [] };
    this._cache.set(tabId, data);
    return data;
  }

  async addMessage(tabId, intent, role, content) {
    const ctx = await this._load(tabId);
    if (!ctx[intent]) ctx[intent] = [];
    ctx[intent].push({ role, content, ts: Date.now() });

    // trim to max
    if (ctx[intent].length > MAX_HISTORY) {
      ctx[intent] = ctx[intent].slice(-MAX_HISTORY);
    }

    this._cache.set(tabId, ctx);
    await chrome.storage.local.set({ [`${STORAGE_PREFIX}${tabId}`]: ctx });
    return ctx;
  }

  /**
   * Get context messages suitable for direct injection into LLM messages array.
   * Returns array of {role, content} objects.
   * @param {number} maxPairs - Max conversation pairs to include (each pair = user + assistant)
   */
  async getContext(tabId, intent, maxPairs = 10) {
    const ctx = await this._load(tabId);
    const history = (ctx[intent] || []).slice(-maxPairs * 2);
    return history.map(({ role, content }) => ({ role, content }));
  }

  /**
   * Get formatted context string suitable for string-based prompt injection.
   * @deprecated Use getContext() instead for better LLM performance
   */
  async getFormatted(tabId, intent, maxPairs = 5) {
    const history = await this.getContext(tabId, intent, maxPairs);
    if (!history.length) return '';
    return history
      .map(m => `${m.role === 'user' ? 'Q' : 'A'}: ${m.content}`)
      .join('\n');
  }

  async clearTab(tabId) {
    this._cache.delete(tabId);
    await chrome.storage.local.remove(`${STORAGE_PREFIX}${tabId}`);
  }
}
