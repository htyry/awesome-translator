// pdf-viewer.js — PDF rendering with translation support

(async function () {
  'use strict';

  // ─── Elements ───
  const container = document.getElementById('pvContainer');
  const viewer = document.getElementById('pdfViewer');
  const welcome = document.getElementById('pvWelcome');
  const fileInput = document.getElementById('pvFileInput');
  const fileNameEl = document.getElementById('pvFileName');
  const statusEl = document.getElementById('pvStatus');
  const pageInput = document.getElementById('pvPageInput');
  const totalPagesEl = document.getElementById('pvTotalPages');
  const zoomLabel = document.getElementById('pvZoomLevel');

  const prevBtn = document.getElementById('pvPrevBtn');
  const nextBtn = document.getElementById('pvNextBtn');
  const zoomInBtn = document.getElementById('pvZoomInBtn');
  const zoomOutBtn = document.getElementById('pvZoomOutBtn');
  const fitBtn = document.getElementById('pvFitBtn');
  const openBtn = document.getElementById('pvOpenBtn');
  const welcomeOpenBtn = document.getElementById('pvWelcomeOpenBtn');

  // ─── State ───
  let pdfDoc = null;
  let currentPage = 1;
  let totalPages = 0;
  let scale = 1.0;
  let rendering = false;
  let pendingPage = null;
  const ZOOM_STEP = 0.15;
  const ZOOM_MIN = 0.3;
  const ZOOM_MAX = 4.0;

  // ─── Load PDF.js ───
  let pdfjsLib = null;

  async function loadPdfJs() {
    if (pdfjsLib) return true;

    try {
      pdfjsLib = await import(chrome.runtime.getURL('lib/pdf.min.mjs'));
    } catch (err) {
      console.error('Failed to load PDF.js:', err);
    }

    if (!pdfjsLib) {
      setStatus('PDF.js not found. Please check console for details.');
      return false;
    }

    pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('lib/pdf.worker.min.mjs');

    return true;
  }

  // ─── File Handling ───
  openBtn.addEventListener('click', () => fileInput.click());
  welcomeOpenBtn.addEventListener('click', () => fileInput.click());

  fileInput.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    await loadFile(file);
    fileInput.value = '';
  });

  // Drag and drop
  container.addEventListener('dragover', (e) => {
    e.preventDefault();
    container.style.outline = '3px dashed #4285f4';
    container.style.outlineOffset = '-6px';
  });

  container.addEventListener('dragleave', () => {
    container.style.outline = '';
    container.style.outlineOffset = '';
  });

  container.addEventListener('drop', async (e) => {
    e.preventDefault();
    container.style.outline = '';
    container.style.outlineOffset = '';
    const file = e.dataTransfer.files[0];
    if (file && file.type === 'application/pdf') {
      await loadFile(file);
    }
  });

  async function loadFile(file) {
    if (!file.name.toLowerCase().endsWith('.pdf')) {
      setStatus('Please select a PDF file.');
      return;
    }

    const ok = await loadPdfJs();
    if (!ok) return;

    setStatus('Loading...');
    fileNameEl.textContent = file.name;

    try {
      const arrayBuffer = await file.arrayBuffer();
      const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;

      pdfDoc = pdf;
      totalPages = pdf.numPages;
      currentPage = 1;
      welcome.style.display = 'none';

      totalPagesEl.textContent = totalPages;
      pageInput.max = totalPages;
      pageInput.disabled = false;
      prevBtn.disabled = false;
      nextBtn.disabled = false;
      zoomInBtn.disabled = false;
      zoomOutBtn.disabled = false;
      fitBtn.disabled = false;

      // Auto-fit to width
      await fitToWidth();

      // Render first page
      await renderPage(currentPage);
      setStatus('Page 1 of ' + totalPages);
    } catch (err) {
      setStatus('Failed to load PDF: ' + err.message);
      console.error('PDF load error:', err);
    }
  }

  // ─── Text Layer (manual rendering, letter-spacing for precise width) ───
  // PDF.js renderTextLayer uses CSS scaleX which breaks browser selection.
  // Instead we manually place spans and use letter-spacing to stretch/compress
  // text so it exactly matches the PDF layout width — no transforms needed.
  async function renderTextLayer(page, container, viewport) {
    const textContent = await page.getTextContent();
    container.innerHTML = '';
    const vpScale = viewport.scale;
    const textItems = textContent.items.filter(it => it.str);

    // 1. Create all spans with positioning but no width constraint
    const spanData = textItems.map(item => {
      const tx = item.transform;
      const fontHeight = Math.sqrt(tx[2] * tx[2] + tx[3] * tx[3]) * vpScale;
      const textWidth = item.width * vpScale;
      const [left, baseline] = viewport.convertToViewportPoint(tx[4], tx[5]);
      const span = document.createElement('span');
      span.textContent = item.str;
      span.style.cssText =
        'position:absolute;' +
        'left:' + left + 'px;' +
        'top:' + (baseline - fontHeight) + 'px;' +
        'font-size:' + fontHeight + 'px;' +
        'color:transparent;' +
        'white-space:pre;' +
        'line-height:1;' +
        'transform-origin:0 0;';
      container.appendChild(span);
      return { span, textWidth, len: item.str.length };
    });

    // 2. Force single reflow to measure natural widths
    container.offsetHeight;

    // 3. Adjust letter-spacing so natural width matches PDF width
    for (const { span, textWidth, len } of spanData) {
      const natural = span.offsetWidth;
      if (natural <= 0) continue;
      const diff = textWidth - natural;
      if (Math.abs(diff) < 0.5) continue;
      if (len <= 1) {
        // Single char: can't adjust spacing, set explicit width
        span.style.width = textWidth + 'px';
        span.style.overflow = 'hidden';
        continue;
      }
      span.style.letterSpacing = (diff / (len - 1)) + 'px';
    }
  }

  // ─── Rendering ───
  async function renderPage(num) {
    if (!pdfDoc) return;
    if (rendering) {
      pendingPage = num;
      return;
    }

    rendering = true;
    setStatus('Loading page ' + num + '...');

    try {
      const page = await pdfDoc.getPage(num);
      const dpr = window.devicePixelRatio || 1;
      const viewport = page.getViewport({ scale: scale * dpr });
      const displayViewport = page.getViewport({ scale });

      // Remove old pages
      viewer.innerHTML = '';

      // Create page wrapper (CSS display size, not canvas pixels)
      const wrapper = document.createElement('div');
      wrapper.className = 'pv-page-wrapper';
      wrapper.style.width = displayViewport.width + 'px';
      wrapper.style.height = displayViewport.height + 'px';

      // Canvas (actual pixel dimensions = display × dpr)
      const canvas = document.createElement('canvas');
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      canvas.style.width = displayViewport.width + 'px';
      canvas.style.height = displayViewport.height + 'px';
      wrapper.appendChild(canvas);

      // Text layer container
      const textLayerDiv = document.createElement('div');
      textLayerDiv.className = 'textLayer';
      wrapper.appendChild(textLayerDiv);

      viewer.appendChild(wrapper);

      // Render canvas
      const ctx = canvas.getContext('2d');
      await page.render({ canvasContext: ctx, viewport }).promise;

      // Render text layer manually — no CSS transforms for reliable selection
      await renderTextLayer(page, textLayerDiv, displayViewport);

      setStatus('Page ' + num + ' of ' + totalPages);
    } catch (err) {
      console.error('Page render error:', err);
      setStatus('Error rendering page ' + num);
    }

    rendering = false;
    if (pendingPage !== null) {
      const p = pendingPage;
      pendingPage = null;
      renderPage(p);
    }
  }

  // ─── Navigation ───
  prevBtn.addEventListener('click', () => goToPage(currentPage - 1));
  nextBtn.addEventListener('click', () => goToPage(currentPage + 1));

  pageInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const val = parseInt(pageInput.value, 10);
      if (val >= 1 && val <= totalPages) {
        goToPage(val);
      } else {
        pageInput.value = currentPage;
      }
    }
  });

  function goToPage(num) {
    if (!pdfDoc || num < 1 || num > totalPages || num === currentPage) return;
    currentPage = num;
    pageInput.value = num;
    renderPage(num);
    container.scrollTop = 0;
  }

  // Keyboard navigation (Arrow keys when not in input)
  document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    if (!pdfDoc) return;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
      e.preventDefault();
      goToPage(currentPage - 1);
    } else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
      e.preventDefault();
      goToPage(currentPage + 1);
    }
  });

  // ─── Zoom ───
  zoomInBtn.addEventListener('click', () => setZoom(scale + ZOOM_STEP));
  zoomOutBtn.addEventListener('click', () => setZoom(scale - ZOOM_STEP));
  fitBtn.addEventListener('click', fitToWidth);

  function setZoom(newScale) {
    newScale = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, newScale));
    newScale = Math.round(newScale * 100) / 100;
    scale = newScale;
    zoomLabel.textContent = Math.round(scale * 100) + '%';
    if (pdfDoc) renderPage(currentPage);
  }

  async function fitToWidth() {
    if (!pdfDoc) return;
    try {
      const page = await pdfDoc.getPage(currentPage);
      const viewport = page.getViewport({ scale: 1 });
      const containerWidth = container.clientWidth - 40; // padding
      scale = containerWidth / viewport.width;
      scale = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, scale));
      scale = Math.round(scale * 100) / 100;
      zoomLabel.textContent = Math.round(scale * 100) + '%';
      await renderPage(currentPage);
    } catch {}
  }

  // Ctrl+scroll to zoom
  container.addEventListener('wheel', (e) => {
    if (!e.ctrlKey || !pdfDoc) return;
    e.preventDefault();
    const delta = e.deltaY > 0 ? -ZOOM_STEP : ZOOM_STEP;
    setZoom(scale + delta);
  }, { passive: false });

  // ─── Helpers ───
  function setStatus(text) {
    statusEl.textContent = text;
  }
})();
