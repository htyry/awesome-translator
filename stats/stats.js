// stats.js — Usage Statistics page

document.addEventListener('DOMContentLoaded', () => {
  const totalCallsEl = document.getElementById('totalCalls');
  const llmCallsEl = document.getElementById('llmCalls');
  const totalInEl = document.getElementById('totalIn');
  const totalOutEl = document.getElementById('totalOut');
  const dailyTableEl = document.getElementById('dailyTable');
  const llmInfoEl = document.getElementById('llmInfo');

  document.getElementById('refreshBtn').addEventListener('click', loadData);
  document.getElementById('resetBtn').addEventListener('click', resetData);
  document.getElementById('exportBtn').addEventListener('click', exportCSV);
  document.getElementById('backBtn').addEventListener('click', () => {
    window.location.href = chrome.runtime.getURL('options/options.html');
  });

  loadData();

  async function loadData() {
    try {
      const resp = await sendMsg({ type: 'GET_USAGE_STATS' });
      if (!resp.success || !resp.data?.length) {
        renderEmpty();
        return;
      }
      render(resp.data);
    } catch {
      dailyTableEl.innerHTML = '<div class="empty-text">Failed to load data.</div>';
    }
  }

  function render(data) {
    // Summary totals
    let tCalls = 0, tIn = 0, tOut = 0, tLLM = 0;
    let tQuick = 0;
    const modelMap = {};   // { modelName: { count, inputChars, outputChars, endpoint } }
    const endpointMap = {}; // { endpoint: count }

    for (const d of data) {
      tCalls += d.count || 0;
      tIn += d.inputChars || 0;
      tOut += d.outputChars || 0;
      const q = d.quickCount || 0;
      tQuick += q;
      tLLM += (d.agentCount || 0) + (d.deepCount || 0);

      if (d.models && typeof d.models === 'object' && Object.keys(d.models).length > 0) {
        for (const [modelName, modelData] of Object.entries(d.models)) {
          if (!modelMap[modelName]) {
            modelMap[modelName] = { count: 0, inputChars: 0, outputChars: 0, endpoint: modelData.endpoint || '' };
          }
          modelMap[modelName].count += modelData.count || 0;
          modelMap[modelName].inputChars += modelData.inputChars || 0;
          modelMap[modelName].outputChars += modelData.outputChars || 0;
          const ep = modelData.endpoint || '';
          if (ep) endpointMap[ep] = (endpointMap[ep] || 0) + (modelData.count || 0);
        }
      }
    }

    totalCallsEl.textContent = tCalls;
    llmCallsEl.textContent = tLLM;
    totalInEl.textContent = fmtChars(tIn);
    totalOutEl.textContent = fmtChars(tOut);

    // Build per-model rows grouped by date
    const rows = [];
    for (const d of data) {
      const q = d.quickCount || 0;
      const models = d.models || {};
      const modelEntries = Object.entries(models)
        .sort((x, y) => (y[1].count || 0) - (x[1].count || 0));

      let isFirst = true;

      // Per-model LLM rows
      for (const [modelName, mData] of modelEntries) {
        rows.push(`<tr>
          <td class="cell-date">${isFirst ? d.date : ''}</td>
          <td class="cell-model" title="${escapeAttr(modelName)}">${escapeHTML(modelName)}</td>
          <td class="cell-num">${mData.count || 0}</td>
          <td class="cell-num">${fmtChars(mData.inputChars || 0)}</td>
          <td class="cell-num">${fmtChars(mData.outputChars || 0)}</td>
          <td class="cell-endpoint" title="${escapeAttr(mData.endpoint || '')}">${shortenEndpoint(mData.endpoint)}</td>
        </tr>`);
        isFirst = false;
      }

      // Quick row (if any quick calls)
      if (q > 0) {
        const modelIn = modelEntries.reduce((s, [, m]) => s + (m.inputChars || 0), 0);
        const modelOut = modelEntries.reduce((s, [, m]) => s + (m.outputChars || 0), 0);
        const quickIn = Math.max(0, (d.inputChars || 0) - modelIn);
        const quickOut = Math.max(0, (d.outputChars || 0) - modelOut);

        rows.push(`<tr class="quick-row">
          <td class="cell-date">${isFirst ? d.date : ''}</td>
          <td class="cell-model">Google Translate</td>
          <td class="cell-num">${q}</td>
          <td class="cell-num">${fmtChars(quickIn)}</td>
          <td class="cell-num">${fmtChars(quickOut)}</td>
          <td class="cell-endpoint">translate.googleapis.com</td>
        </tr>`);
      }
    }

    dailyTableEl.innerHTML = `
      <table class="stats-table">
        <thead>
          <tr>
            <th>Date</th>
            <th>Model</th>
            <th style="text-align:right">Calls</th>
            <th style="text-align:right">In</th>
            <th style="text-align:right">Out</th>
            <th>Endpoint</th>
          </tr>
        </thead>
        <tbody>${rows.join('')}</tbody>
        <tfoot>
          <tr>
            <td colspan="2" style="font-weight:600">Total</td>
            <td class="cell-num">${tCalls}</td>
            <td class="cell-num">${fmtChars(tIn)}</td>
            <td class="cell-num">${fmtChars(tOut)}</td>
            <td></td>
          </tr>
        </tfoot>
      </table>`;

    // LLM Info panel
    const topModel = getTopKey(modelMap, 'count');
    const topEndpoint = getTopKey(endpointMap);
    const modelCount = Object.keys(modelMap).length;
    const endpointCount = Object.keys(endpointMap).length;

    llmInfoEl.innerHTML = `
      <div class="llm-info-item">
        <div class="llm-info-label">Most Used Model</div>
        <div class="llm-info-value">${topModel || 'Not configured'}</div>
      </div>
      <div class="llm-info-item">
        <div class="llm-info-label">Models Used</div>
        <div class="llm-info-value">${modelCount ? modelCount + ' unique: ' + Object.entries(modelMap).map(([k, v]) => `${k} (${v.count})`).join(', ') : 'None'}</div>
      </div>
      <div class="llm-info-item">
        <div class="llm-info-label">Most Used Endpoint</div>
        <div class="llm-info-value">${shortenEndpoint(topEndpoint) || 'Not configured'}</div>
      </div>
      <div class="llm-info-item">
        <div class="llm-info-label">Endpoints Used</div>
        <div class="llm-info-value">${endpointCount || 'None'}</div>
      </div>
      <div class="llm-info-item">
        <div class="llm-info-label">Data Range</div>
        <div class="llm-info-value">${data[data.length - 1].date} ~ ${data[0].date}</div>
      </div>
      <div class="llm-info-item">
        <div class="llm-info-label">Days Recorded</div>
        <div class="llm-info-value">${data.length}</div>
      </div>`;
  }

  function renderEmpty() {
    totalCallsEl.textContent = '0';
    llmCallsEl.textContent = '0';
    totalInEl.textContent = '0';
    totalOutEl.textContent = '0';
    dailyTableEl.innerHTML = '<div class="empty-text">No usage data yet. Start translating to see stats here.</div>';
    llmInfoEl.innerHTML = '<div class="empty-text">No LLM data available.</div>';
  }

  async function resetData() {
    if (!confirm('Delete all usage statistics? This cannot be undone.')) return;
    try {
      const resp = await sendMsg({ type: 'RESET_USAGE_STATS' });
      if (resp.success) {
        renderEmpty();
      }
    } catch {}
  }

  function exportCSV() {
    sendMsg({ type: 'GET_USAGE_STATS' }).then(resp => {
      if (!resp.success || !resp.data?.length) {
        alert('No data to export.');
        return;
      }
      const header = 'Date,Model,Calls,Input Chars,Output Chars,Endpoint';
      const rows = [];
      for (const d of resp.data) {
        const q = d.quickCount || 0;
        const models = d.models || {};
        const modelEntries = Object.entries(models)
          .sort((x, y) => (y[1].count || 0) - (x[1].count || 0));
        for (const [modelName, mData] of modelEntries) {
          rows.push([
            d.date,
            `"${modelName.replace(/"/g, '""')}"`,
            mData.count || 0,
            mData.inputChars || 0,
            mData.outputChars || 0,
            `"${(mData.endpoint || '').replace(/"/g, '""')}"`,
          ].join(','));
        }
        if (q > 0) {
          rows.push([d.date, 'Google Translate', q, '', '', 'translate.googleapis.com'].join(','));
        }
      }
      const csv = [header, ...rows].join('\n');
      const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `awesome-translator-usage-${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    });
  }

  // ─── Helpers ───
  function sendMsg(msg) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(msg, resp => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve(resp);
      });
    });
  }

  function fmtChars(n) {
    if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
    if (n >= 10000) return (n / 1000).toFixed(1) + 'k';
    return String(n);
  }

  function getTopKey(map, countField = null) {
    if (!Object.keys(map).length) return '';
    if (countField) {
      return Object.entries(map).sort((a, b) => (b[1][countField] || 0) - (a[1][countField] || 0))[0][0];
    }
    return Object.entries(map).sort((a, b) => b[1] - a[1])[0][0];
  }

  function shortenEndpoint(url) {
    if (!url) return '-';
    try {
      const u = new URL(url);
      return u.hostname + (u.pathname !== '/' ? u.pathname : '');
    } catch {
      return url;
    }
  }

  function escapeAttr(str) {
    return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function escapeHTML(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
});
