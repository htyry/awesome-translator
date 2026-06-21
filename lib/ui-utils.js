// lib/ui-utils.js — Shared UI utilities for popup and content scripts
// ES module with named exports. Loaded via dynamic import() in content.js
// and static import in popup.js (loaded as module script).

export function escapeHtml(text) {
  const d = document.createElement('div');
  d.textContent = text;
  return d.innerHTML;
}

/**
 * Format markdown-like LLM output to styled HTML.
 * @param {string} text - Raw markdown text from LLM
 * @param {string} p - CSS class prefix (e.g., 'at-' for content, 'popup-' for popup)
 */
export function formatContent(text, p = 'at-') {
  let html = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/^## (.+)$/gm, `<div class="${p}h2">$1</div>`)
    .replace(/^### (.+)$/gm, `<div class="${p}h3">$1</div>`)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, `<code class="${p}code">$1</code>`)
    .replace(/\n/g, '<br>');

  html = html.replace(
    /(<strong>Terms<\/strong><br>)([\s\S]*?)(?=<br><br>|<br><strong>|$)/,
    (_, header, body) => {
      const items = body
        .split(/<br>\s*/)
        .map(l => l.trim())
        .filter(l => l && /^\d+\./.test(l))
        .map(l => `<div class="${p}term-item">${l.replace(/^\d+\.\s*/, '')}</div>`)
        .join('');
      return items ? `${header}<div class="${p}terms-card">${items}</div>` : header;
    }
  );
  return html;
}

/**
 * Build HTML for request metadata bar (model, latency, retries, tokens).
 * @param {object} meta - { model, endpoint, latency, retries, tokens }
 * @param {boolean} success
 * @param {string} p - CSS class prefix
 */
export function buildMetaHtml(meta, success, p = 'at-') {
  if (!meta) return '';
  const parts = [];
  if (meta.model) {
    parts.push(`<span class="${p}meta-item ${p}meta-model" title="${escapeHtml(meta.endpoint || '')}">${escapeHtml(meta.model)}</span>`);
  }
  if (meta.latency != null) {
    const cls = meta.latency < 2000 ? `${p}meta-fast` : meta.latency < 5000 ? `${p}meta-normal` : `${p}meta-slow`;
    parts.push(`<span class="${p}meta-item ${cls}">${(meta.latency / 1000).toFixed(1)}s</span>`);
  }
  if (meta.retries > 0) {
    parts.push(`<span class="${p}meta-item ${p}meta-retry">${meta.retries} retry${meta.retries > 1 ? 's' : ''}</span>`);
  }
  if (meta.tokens) {
    const t = meta.tokens;
    let str = `${t.input + t.output} tokens`;
    if (t.cached > 0) str += ` (${t.cached} cached)`;
    parts.push(`<span class="${p}meta-item ${p}meta-tokens">${str}</span>`);
  }
  parts.push(`<span class="${p}meta-item ${success ? `${p}meta-success` : `${p}meta-fail`}">${success ? 'OK' : 'FAIL'}</span>`);
  return parts.join(`<span class="${p}meta-sep">·</span>`);
}
