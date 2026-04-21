// stats.js - Usage Statistics page with Today / History tabs and Token-based tracking

document.addEventListener('DOMContentLoaded', () => {
  // --- Element references ---
  const tabBtns = document.querySelectorAll('.tab-btn');
  const tabPanels = document.querySelectorAll('.tab-panel');

  // Today
  const todayCallsEl = document.getElementById('todayCalls');
  const todayTokensEl = document.getElementById('todayTokens');
  const todayInTokensEl = document.getElementById('todayInTokens');
  const todayOutTokensEl = document.getElementById('todayOutTokens');
  const todayCachedEl = document.getElementById('todayCached');
  const todayTableEl = document.getElementById('todayTable');
  const modeChartEl = document.getElementById('modeChart');

  // History
  const histCallsEl = document.getElementById('histCalls');
  const histTokensEl = document.getElementById('histTokens');
  const histInTokensEl = document.getElementById('histInTokens');
  const histOutTokensEl = document.getElementById('histOutTokens');
  const histCachedEl = document.getElementById('histCached');
  const historyTableEl = document.getElementById('historyTable');
  const llmInfoEl = document.getElementById('llmInfo');

  // Filters
  const filterModelEl = document.getElementById('filterModel');
  const filterPeriodEl = document.getElementById('filterPeriod');
  const filterStartEl = document.getElementById('filterStart');
  const filterEndEl = document.getElementById('filterEnd');

  // Buttons
  document.getElementById('refreshBtn').addEventListener('click', loadAll);
  document.getElementById('resetBtn').addEventListener('click', resetData);
  document.getElementById('exportBtn').addEventListener('click', exportCSV);
  document.getElementById('backBtn').addEventListener('click', () => {
    window.location.href = chrome.runtime.getURL('options/options.html');
  });
  document.getElementById('applyFilterBtn').addEventListener('click', loadHistory);

  // Tab switching
  tabBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      tabBtns.forEach(b => b.classList.remove('active'));
      tabPanels.forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById(`panel-${btn.dataset.tab}`).classList.add('active');
    });
  });

  // Initial load
  loadAll();

  // --- Data loading ---
  function loadAll() {
    loadToday();
    loadHistory();
  }

  async function loadToday() {
    setCardLoading(todayCallsEl, todayTokensEl, todayInTokensEl, todayOutTokensEl, todayCachedEl);

    try {
      const today = new Date().toISOString().slice(0, 10);
      const resp = await sendMsg({ type: 'GET_USAGE_STATS', query: { startDate: today, endDate: today } });
      if (!resp || !resp.success || !resp.data?.length) {
        renderTodayEmpty();
        return;
      }
      renderToday(resp.data);
    } catch {
      renderTodayEmpty();
    }
  }

  async function loadHistory() {
    setCardLoading(histCallsEl, histTokensEl, histInTokensEl, histOutTokensEl, histCachedEl);
    historyTableEl.innerHTML = '<div class="loading-text">Loading...</div>';
    llmInfoEl.innerHTML = '<div class="loading-text">Loading...</div>';

    try {
      const query = buildFilterQuery();
      const resp = await sendMsg({ type: 'GET_USAGE_STATS', query });
      if (!resp || !resp.success || !resp.data?.length) {
        renderHistoryEmpty();
        return;
      }
      renderHistory(resp.data);
      populateModelFilter(resp.data);
    } catch {
      renderHistoryEmpty();
    }
  }

  // --- Today rendering ---
  function renderToday(data) {
    const d = data[0]; // only today's data
    const tCalls = d.count || 0;
    const tInTokens = d.inputTokens || 0;
    const tOutTokens = d.outputTokens || 0;
    const tCached = d.cachedTokens || 0;
    const tTotalTokens = tInTokens + tOutTokens;

    todayCallsEl.textContent = tCalls;
    todayTokensEl.textContent = fmtNum(tTotalTokens);
    todayInTokensEl.textContent = fmtNum(tInTokens);
    todayOutTokensEl.textContent = fmtNum(tOutTokens);
    todayCachedEl.textContent = fmtNum(tCached);

    // Today breakdown table
    const models = d.models || {};
    const modelEntries = Object.entries(models).sort((a, b) => (b[1].count || 0) - (a[1].count || 0));
    const rows = [];

    for (const [modelName, mData] of modelEntries) {
      const cachePct = mData.inputTokens ? Math.round((mData.cachedTokens || 0) / mData.inputTokens * 100) : 0;
      rows.push(`<tr>
        <td class="cell-model" title="${escapeAttr(modelName)}">${escapeHTML(modelName)}</td>
        <td class="cell-num">${mData.count || 0}</td>
        <td class="cell-num">${fmtNum(mData.inputTokens || 0)}</td>
        <td class="cell-num">${fmtNum(mData.outputTokens || 0)}</td>
        <td class="cell-cache">${cachePct > 0 ? `<span class="cache-badge cache-hit">${cachePct}%</span> ${fmtNum(mData.cachedTokens || 0)}` : '<span class="cache-badge cache-none">-</span>'}</td>
        <td class="cell-endpoint" title="${escapeAttr(mData.endpoint || '')}">${shortenEndpoint(mData.endpoint)}</td>
      </tr>`);
    }

    const q = d.quickCount || 0;
    if (q > 0) {
      rows.push(`<tr class="quick-row">
        <td class="cell-model">Google Translate</td>
        <td class="cell-num">${q}</td>
        <td class="cell-num">-</td>
        <td class="cell-num">-</td>
        <td class="cell-cache"><span class="cache-badge cache-none">-</span></td>
        <td class="cell-endpoint">translate.googleapis.com</td>
      </tr>`);
    }

    if (rows.length === 0) {
      todayTableEl.innerHTML = '<div class="empty-text">No calls today.</div>';
    } else {
      todayTableEl.innerHTML = `
        <table class="stats-table">
          <thead>
            <tr>
              <th>Model</th>
              <th style="text-align:right">Calls</th>
              <th style="text-align:right">In Tokens</th>
              <th style="text-align:right">Out Tokens</th>
              <th style="text-align:right">Cache</th>
              <th>Endpoint</th>
            </tr>
          </thead>
          <tbody>${rows.join('')}</tbody>
          <tfoot>
            <tr>
              <td style="font-weight:600">Total</td>
              <td class="cell-num">${tCalls}</td>
              <td class="cell-num">${fmtNum(tInTokens)}</td>
              <td class="cell-num">${fmtNum(tOutTokens)}</td>
              <td class="cell-cache">${tCached > 0 ? fmtNum(tCached) : '-'}</td>
              <td></td>
            </tr>
          </tfoot>
        </table>`;
    }

    // Mode distribution
    const quick = d.quickCount || 0;
    const agent = d.agentCount || 0;
    const deep = d.deepCount || 0;
    const maxMode = Math.max(quick, agent, deep, 1);

    modeChartEl.innerHTML = `
      <div class="mode-bar-group">
        <div class="mode-bar-label">
          <span class="mode-name">Quick</span>
          <span class="mode-count">${quick}</span>
        </div>
        <div class="mode-bar-track">
          <div class="mode-bar-fill quick" style="width:${(quick / maxMode * 100).toFixed(1)}%"></div>
        </div>
      </div>
      <div class="mode-bar-group">
        <div class="mode-bar-label">
          <span class="mode-name">Agent</span>
          <span class="mode-count">${agent}</span>
        </div>
        <div class="mode-bar-track">
          <div class="mode-bar-fill agent" style="width:${(agent / maxMode * 100).toFixed(1)}%"></div>
        </div>
      </div>
      <div class="mode-bar-group">
        <div class="mode-bar-label">
          <span class="mode-name">Deep</span>
          <span class="mode-count">${deep}</span>
        </div>
        <div class="mode-bar-track">
          <div class="mode-bar-fill deep" style="width:${(deep / maxMode * 100).toFixed(1)}%"></div>
        </div>
      </div>`;
  }

  function renderTodayEmpty() {
    todayCallsEl.textContent = '0';
    todayTokensEl.textContent = '0';
    todayInTokensEl.textContent = '0';
    todayOutTokensEl.textContent = '0';
    todayCachedEl.textContent = '0';
    todayTableEl.innerHTML = '<div class="empty-text">No calls today.</div>';
    modeChartEl.innerHTML = `
      <div class="mode-bar-group"><div class="mode-bar-label"><span class="mode-name">Quick</span><span class="mode-count">0</span></div><div class="mode-bar-track"><div class="mode-bar-fill quick" style="width:0%"></div></div></div>
      <div class="mode-bar-group"><div class="mode-bar-label"><span class="mode-name">Agent</span><span class="mode-count">0</span></div><div class="mode-bar-track"><div class="mode-bar-fill agent" style="width:0%"></div></div></div>
      <div class="mode-bar-group"><div class="mode-bar-label"><span class="mode-name">Deep</span><span class="mode-count">0</span></div><div class="mode-bar-track"><div class="mode-bar-fill deep" style="width:0%"></div></div></div>`;
  }

  // --- History rendering ---
  function renderHistory(data) {
    const period = filterPeriodEl.value;
    const grouped = groupByPeriod(data, period);

    // Compute totals across all data
    let tCalls = 0, tInTokens = 0, tOutTokens = 0, tCached = 0;
    const modelMap = {};
    const endpointMap = {};

    for (const d of data) {
      tCalls += d.count || 0;
      tInTokens += d.inputTokens || 0;
      tOutTokens += d.outputTokens || 0;
      tCached += d.cachedTokens || 0;

      if (d.models && typeof d.models === 'object') {
        for (const [modelName, modelData] of Object.entries(d.models)) {
          if (!modelMap[modelName]) modelMap[modelName] = { count: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, endpoint: modelData.endpoint || '' };
          modelMap[modelName].count += modelData.count || 0;
          modelMap[modelName].inputTokens += modelData.inputTokens || 0;
          modelMap[modelName].outputTokens += modelData.outputTokens || 0;
          modelMap[modelName].cachedTokens += modelData.cachedTokens || 0;
          const ep = modelData.endpoint || '';
          if (ep) endpointMap[ep] = (endpointMap[ep] || 0) + (modelData.count || 0);
        }
      }
    }

    const tTotalTokens = tInTokens + tOutTokens;
    histCallsEl.textContent = fmtNum(tCalls);
    histTokensEl.textContent = fmtNum(tTotalTokens);
    histInTokensEl.textContent = fmtNum(tInTokens);
    histOutTokensEl.textContent = fmtNum(tOutTokens);
    histCachedEl.textContent = fmtNum(tCached);

    // Build table rows grouped by period
    const rows = [];
    const periodKeys = Object.keys(grouped).sort().reverse();

    for (const pk of periodKeys) {
      const items = grouped[pk];
      let pCalls = 0, pInT = 0, pOutT = 0, pCached = 0;
      const pModels = {};

      for (const d of items) {
        pCalls += d.count || 0;
        pInT += d.inputTokens || 0;
        pOutT += d.outputTokens || 0;
        pCached += d.cachedTokens || 0;

        for (const [mName, mData] of Object.entries(d.models || {})) {
          if (!pModels[mName]) pModels[mName] = { count: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, endpoint: mData.endpoint || '' };
          pModels[mName].count += mData.count || 0;
          pModels[mName].inputTokens += mData.inputTokens || 0;
          pModels[mName].outputTokens += mData.outputTokens || 0;
          pModels[mName].cachedTokens += mData.cachedTokens || 0;
          if (mData.endpoint && !pModels[mName].endpoint) pModels[mName].endpoint = mData.endpoint;
        }
      }

      const cachePct = pInT ? Math.round(pCached / pInT * 100) : 0;
      const modelEntries = Object.entries(pModels).sort((a, b) => (b[1].count || 0) - (a[1].count || 0));
      const modelSummary = modelEntries.map(([n, m]) => `${n}(${m.count})`).join(', ');

      rows.push(`<tr>
        <td class="cell-date">${pk}</td>
        <td class="cell-num">${pCalls}</td>
        <td class="cell-num">${fmtNum(pInT)}</td>
        <td class="cell-num">${fmtNum(pOutT)}</td>
        <td class="cell-cache">${cachePct > 0 ? `<span class="cache-badge cache-hit">${cachePct}%</span>` : '<span class="cache-badge cache-none">-</span>'}</td>
        <td class="cell-model" title="${escapeAttr(modelSummary)}" style="max-width:260px">${escapeHTML(modelSummary) || '-'}</td>
      </tr>`);
    }

    if (rows.length === 0) {
      historyTableEl.innerHTML = '<div class="empty-text">No usage data for this period.</div>';
    } else {
      const periodLabel = period === 'week' ? 'Week' : period === 'month' ? 'Month' : 'Date';
      historyTableEl.innerHTML = `
        <table class="stats-table">
          <thead>
            <tr>
              <th>${periodLabel}</th>
              <th style="text-align:right">Calls</th>
              <th style="text-align:right">In Tokens</th>
              <th style="text-align:right">Out Tokens</th>
              <th style="text-align:right">Cache</th>
              <th>Models</th>
            </tr>
          </thead>
          <tbody>${rows.join('')}</tbody>
          <tfoot>
            <tr>
              <td style="font-weight:600">Total</td>
              <td class="cell-num">${fmtNum(tCalls)}</td>
              <td class="cell-num">${fmtNum(tInTokens)}</td>
              <td class="cell-num">${fmtNum(tOutTokens)}</td>
              <td class="cell-cache">${tCached > 0 ? fmtNum(tCached) : '-'}</td>
              <td></td>
            </tr>
          </tfoot>
        </table>`;
    }

    // LLM Info panel
    const topModel = getTopKey(modelMap, 'count');
    const topEndpoint = getTopKey(endpointMap);
    const modelCount = Object.keys(modelMap).length;
    const endpointCount = Object.keys(endpointMap).length;
    const dates = data.map(d => d.date).sort();

    llmInfoEl.innerHTML = `
      <div class="llm-info-item">
        <div class="llm-info-label">Most Used Model</div>
        <div class="llm-info-value">${topModel || 'N/A'}</div>
      </div>
      <div class="llm-info-item">
        <div class="llm-info-label">Models Used</div>
        <div class="llm-info-value">${modelCount ? modelCount + ' unique' : 'None'}</div>
      </div>
      <div class="llm-info-item">
        <div class="llm-info-label">Most Used Endpoint</div>
        <div class="llm-info-value">${shortenEndpoint(topEndpoint) || 'N/A'}</div>
      </div>
      <div class="llm-info-item">
        <div class="llm-info-label">Endpoints Used</div>
        <div class="llm-info-value">${endpointCount || 'None'}</div>
      </div>
      <div class="llm-info-item">
        <div class="llm-info-label">Data Range</div>
        <div class="llm-info-value">${dates.length ? `${dates[0]} ~ ${dates[dates.length - 1]}` : 'N/A'}</div>
      </div>
      <div class="llm-info-item">
        <div class="llm-info-label">Cache Hit Rate</div>
        <div class="llm-info-value">${tInTokens ? Math.round(tCached / tInTokens * 100) + '%' : 'N/A'}</div>
      </div>`;
  }

  function renderHistoryEmpty() {
    histCallsEl.textContent = '0';
    histTokensEl.textContent = '0';
    histInTokensEl.textContent = '0';
    histOutTokensEl.textContent = '0';
    histCachedEl.textContent = '0';
    historyTableEl.innerHTML = '<div class="empty-text">No usage data yet. Start translating to see stats here.</div>';
    llmInfoEl.innerHTML = '<div class="empty-text">No LLM data available.</div>';
  }

  // --- Period grouping ---
  function groupByPeriod(data, period) {
    const groups = {};
    for (const d of data) {
      const key = periodKey(d.date, period);
      if (!groups[key]) groups[key] = [];
      groups[key].push(d);
    }
    return groups;
  }

  function periodKey(dateStr, period) {
    if (period === 'month') return dateStr.slice(0, 7); // YYYY-MM
    if (period === 'week') {
      const d = new Date(dateStr + 'T00:00:00');
      const day = d.getDay();
      const diff = d.getDate() - day + (day === 0 ? -6 : 1); // Monday
      const monday = new Date(d.setDate(diff));
      return monday.toISOString().slice(0, 10); // Week of YYYY-MM-DD (Monday)
    }
    return dateStr; // daily
  }

  // --- Filter ---
  function buildFilterQuery() {
    const query = {};
    const model = filterModelEl.value;
    const start = filterStartEl.value;
    const end = filterEndEl.value;
    if (model) query.model = model;
    if (start) query.startDate = start;
    if (end) query.endDate = end;
    return query;
  }

  function populateModelFilter(data) {
    const currentVal = filterModelEl.value;
    const models = new Set();
    for (const d of data) {
      for (const mName of Object.keys(d.models || {})) {
        models.add(mName);
      }
    }
    filterModelEl.innerHTML = '<option value="">All Models</option>';
    for (const m of [...models].sort()) {
      const opt = document.createElement('option');
      opt.value = m;
      opt.textContent = m;
      if (m === currentVal) opt.selected = true;
      filterModelEl.appendChild(opt);
    }
  }

  // --- Reset & Export ---
  async function resetData() {
    if (!confirm('Delete all usage statistics? This cannot be undone.')) return;
    try {
      const resp = await sendMsg({ type: 'RESET_USAGE_STATS' });
      if (resp && resp.success) {
        renderTodayEmpty();
        renderHistoryEmpty();
      }
    } catch {}
  }

  function exportCSV() {
    sendMsg({ type: 'GET_USAGE_STATS' }).then(resp => {
      if (!resp || !resp.success || !resp.data?.length) {
        alert('No data to export.');
        return;
      }
      const header = 'Date,Model,Calls,Input Tokens,Output Tokens,Cached Tokens,Input Chars,Output Chars,Endpoint';
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
            mData.inputTokens || 0,
            mData.outputTokens || 0,
            mData.cachedTokens || 0,
            mData.inputChars || 0,
            mData.outputChars || 0,
            `"${(mData.endpoint || '').replace(/"/g, '""')}"`,
          ].join(','));
        }
        if (q > 0) {
          rows.push([d.date, 'Google Translate', q, '', '', '', '', '', 'translate.googleapis.com'].join(','));
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

  // --- Helpers ---
  function setCardLoading(...els) {
    els.forEach(el => { if (el) el.textContent = '...'; });
  }

  function sendMsg(msg) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Request timed out'));
      }, 15000);
      chrome.runtime.sendMessage(msg, resp => {
        clearTimeout(timeout);
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve(resp);
      });
    });
  }

  function fmtNum(n) {
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
