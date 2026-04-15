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
    let tQuick = 0, tAgent = 0, tDeep = 0;

    // LLM model tracking
    const modelMap = {};  // { model: count }
    const endpointMap = {}; // { endpoint: count }

    for (const d of data) {
      tCalls += d.count || 0;
      tIn += d.inputChars || 0;
      tOut += d.outputChars || 0;
      const q = d.quickCount || 0;
      const a = d.agentCount || 0;
      const dp = d.deepCount || 0;
      tQuick += q;
      tAgent += a;
      tDeep += dp;
      tLLM += a + dp;

      if (d.llmModel) modelMap[d.llmModel] = (modelMap[d.llmModel] || 0) + (a + dp);
      if (d.llmEndpoint) endpointMap[d.llmEndpoint] = (endpointMap[d.llmEndpoint] || 0) + (a + dp);
    }

    totalCallsEl.textContent = tCalls;
    llmCallsEl.textContent = tLLM;
    totalInEl.textContent = fmtChars(tIn);
    totalOutEl.textContent = fmtChars(tOut);

    // Daily table
    const rows = data.map(d => {
      const q = d.quickCount || 0;
      const a = d.agentCount || 0;
      const dp = d.deepCount || 0;
      return `<tr>
        <td class="cell-date">${d.date}</td>
        <td class="cell-num">${d.count || 0}</td>
        <td class="cell-num">${q}</td>
        <td class="cell-num">${a}</td>
        <td class="cell-num">${dp}</td>
        <td class="cell-num">${fmtChars(d.inputChars || 0)}</td>
        <td class="cell-num">${fmtChars(d.outputChars || 0)}</td>
        <td class="cell-model" title="${escapeAttr(d.llmModel || '-')}">${d.llmModel || '-'}</td>
        <td class="cell-endpoint" title="${escapeAttr(d.llmEndpoint || '-')}">${shortenEndpoint(d.llmEndpoint)}</td>
      </tr>`;
    }).join('');

    dailyTableEl.innerHTML = `
      <table class="stats-table">
        <thead>
          <tr>
            <th>Date</th>
            <th style="text-align:right">Total</th>
            <th style="text-align:right">Quick</th>
            <th style="text-align:right">Agent</th>
            <th style="text-align:right">Deep</th>
            <th style="text-align:right">In</th>
            <th style="text-align:right">Out</th>
            <th>Model</th>
            <th>Endpoint</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
        <tfoot>
          <tr>
            <td style="font-weight:600">Total</td>
            <td class="cell-num">${tCalls}</td>
            <td class="cell-num">${tQuick}</td>
            <td class="cell-num">${tAgent}</td>
            <td class="cell-num">${tDeep}</td>
            <td class="cell-num">${fmtChars(tIn)}</td>
            <td class="cell-num">${fmtChars(tOut)}</td>
            <td class="cell-model">${getTopKey(modelMap)}</td>
            <td class="cell-endpoint">${shortenEndpoint(getTopKey(endpointMap))}</td>
          </tr>
        </tfoot>
      </table>`;

    // LLM Info panel
    const topModel = getTopKey(modelMap);
    const topEndpoint = getTopKey(endpointMap);
    const modelCount = Object.keys(modelMap).length;
    const endpointCount = Object.keys(endpointMap).length;

    llmInfoEl.innerHTML = `
      <div class="llm-info-item">
        <div class="llm-info-label">Current Model</div>
        <div class="llm-info-value">${topModel || 'Not configured'}</div>
      </div>
      <div class="llm-info-item">
        <div class="llm-info-label">Models Used</div>
        <div class="llm-info-value">${modelCount ? modelCount + ' unique: ' + Object.entries(modelMap).map(([k, v]) => `${k} (${v})`).join(', ') : 'None'}</div>
      </div>
      <div class="llm-info-item">
        <div class="llm-info-label">Current Endpoint</div>
        <div class="llm-info-value">${topEndpoint || 'Not configured'}</div>
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
      const header = 'Date,Total,Quick,Agent,Deep,Input Chars,Output Chars,LLM Model,Endpoint';
      const rows = resp.data.map(d => [
        d.date,
        d.count || 0,
        d.quickCount || 0,
        d.agentCount || 0,
        d.deepCount || 0,
        d.inputChars || 0,
        d.outputChars || 0,
        `"${(d.llmModel || '').replace(/"/g, '""')}"`,
        `"${(d.llmEndpoint || '').replace(/"/g, '""')}"`,
      ].join(','));
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

  function getTopKey(map) {
    if (!Object.keys(map).length) return '';
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
});
