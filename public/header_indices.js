/**
 * FolioTrack Live Market Ticker Bar
 * Continuous automatic marquee banner with streaming quotes for world benchmarks & custom assets.
 * Configurable active indices, scroll speed, and refresh frequency from Settings.
 * Supports clicking any benchmark index to inspect its price trend in an interactive Chart.js modal with timeframe switcher (1M, 3M, 6M, 1Y, 3Y, ALL).
 */

(function () {
  const DEFAULT_INDICES = [
    { symbol: '^GSPC', name: 'S&P 500', price: 5864.67, change: 24.34, changePercent: 0.42, currency: 'USD' },
    { symbol: 'FTSEMIB.MI', name: 'FTSE MIB', price: 34928.10, change: 182.40, changePercent: 0.52, currency: 'EUR' },
    { symbol: 'BTP10Y', name: 'BTP 10Y', price: 3.58, change: -0.04, changePercent: -1.10, currency: '%', isYield: true },
    { symbol: 'GC=F', name: 'Oro (Gold)', price: 2748.20, change: 12.80, changePercent: 0.47, currency: 'USD' },
    { symbol: 'BTC-EUR', name: 'Bitcoin', price: 63890.00, change: 1240.00, changePercent: 1.98, currency: 'EUR' },
    { symbol: 'EURUSD=X', name: 'EUR / USD', price: 1.0874, change: 0.0018, changePercent: 0.17, currency: '' }
  ];

  let currentRefreshTimer = null;
  let currentRefreshSeconds = 60;
  let currentScrollSpeed = 'normal';
  let isFetching = false;
  let lastData = DEFAULT_INDICES;

  // Modal & Chart state
  let activeChartInstance = null;
  let currentModalItem = null;
  let currentModalRange = '1Y';
  let chartJsLoadingPromise = null;

  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function ensureStyles() {
    if (document.getElementById('ft-ticker-banner-styles')) return;

    const style = document.createElement('style');
    style.id = 'ft-ticker-banner-styles';
    style.textContent = `
      @keyframes ft-ticker-scroll {
        0% {
          transform: translate3d(0, 0, 0);
        }
        100% {
          transform: translate3d(-100%, 0, 0);
        }
      }

      .ft-ticker-container {
        position: relative;
        overflow: hidden;
        width: 100%;
        display: flex;
        align-items: center;
        background: rgba(255, 255, 255, 0.85);
        border-bottom: 1px solid rgba(229, 231, 235, 0.8);
        backdrop-filter: blur(8px);
        -webkit-backdrop-filter: blur(8px);
        user-select: none;
        -webkit-user-select: none;
      }

      .dark .ft-ticker-container {
        background: rgba(21, 21, 23, 0.85);
        border-bottom: 1px solid rgba(255, 255, 255, 0.06);
      }

      .ft-ticker-viewport {
        position: relative;
        overflow: hidden;
        flex: 1;
        display: flex;
        align-items: center;
        mask-image: linear-gradient(to right, transparent, black 24px, black calc(100% - 24px), transparent 100%);
        -webkit-mask-image: linear-gradient(to right, transparent, black 24px, black calc(100% - 24px), transparent 100%);
      }

      .ft-ticker-track {
        display: flex;
        width: max-content;
        will-change: transform;
        animation: ft-ticker-scroll var(--ft-ticker-speed, 35s) linear infinite;
      }

      .ft-ticker-track:hover,
      .ft-ticker-viewport:hover .ft-ticker-track {
        animation-play-state: paused;
      }

      .ft-ticker-group {
        display: flex;
        align-items: center;
        flex-shrink: 0;
      }

      .ft-ticker-item {
        display: inline-flex;
        align-items: center;
        gap: 0.5rem;
        padding: 0.35rem 0.85rem;
        font-size: 0.75rem;
        line-height: 1rem;
        flex-shrink: 0;
        cursor: pointer;
        transition: background-color 0.15s ease, transform 0.1s ease;
      }

      .ft-ticker-item:hover {
        background: rgba(16, 185, 129, 0.08);
      }
      .dark .ft-ticker-item:hover {
        background: rgba(16, 185, 129, 0.12);
      }
      .ft-ticker-item:active {
        transform: scale(0.98);
      }

      .ft-spin {
        animation: ft-rotate 0.8s linear infinite;
      }
      @keyframes ft-rotate {
        from { transform: rotate(0deg); }
        to { transform: rotate(360deg); }
      }
    `;
    document.head.appendChild(style);
  }

  function formatPrice(item) {
    if (item.isYield) {
      return `${Number(item.price || 0).toFixed(2)}%`;
    }
    const prefix = item.currency === 'EUR' ? '€' : (item.currency === 'USD' ? '$' : (item.currency === 'GBP' ? '£' : ''));
    const val = Number(item.price) || 0;
    // For values > 999, display zero decimals (e.g. S&P 500, FTSE MIB, Bitcoin, Gold)
    const decimals = val > 999 ? 0 : (val < 10 ? 4 : 2);
    const formatted = val.toLocaleString('it-IT', {
      useGrouping: true,
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals
    });
    return `${prefix}${formatted}`;
  }

  function formatVal(val, item) {
    if (item && item.isYield) {
      return `${Number(val || 0).toFixed(2)}%`;
    }
    const prefix = item?.currency === 'EUR' ? '€' : (item?.currency === 'USD' ? '$' : (item?.currency === 'GBP' ? '£' : ''));
    const num = Number(val) || 0;
    const decimals = num > 999 ? 0 : (num < 10 ? 4 : 2);
    const formatted = num.toLocaleString('it-IT', {
      useGrouping: true,
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals
    });
    return `${prefix}${formatted}`;
  }

  function formatChange(item) {
    const chgVal = Number(item.change) || 0;
    const chgPct = Number(item.changePercent) || 0;
    const isPositive = chgPct >= 0;
    const sign = isPositive ? '+' : '';
    const pct = `${sign}${chgPct.toFixed(2)}%`;
    return {
      isPositive,
      text: pct
    };
  }

  /**
   * Lazily loads Chart.js if not already available on the page.
   */
  function ensureChartJs() {
    if (window.Chart) return Promise.resolve(window.Chart);
    if (chartJsLoadingPromise) return chartJsLoadingPromise;

    chartJsLoadingPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = '/vendor/chartjs/chart.umd.min.js';
      script.async = true;
      script.onload = () => resolve(window.Chart);
      script.onerror = () => {
        chartJsLoadingPromise = null;
        reject(new Error('Impossibile caricare il motore dei grafici Chart.js'));
      };
      document.head.appendChild(script);
    });

    return chartJsLoadingPromise;
  }

  /**
   * Injects modal HTML into DOM once.
   */
  function ensureModalDom() {
    if (document.getElementById('ft-index-chart-modal')) return;

    const modal = document.createElement('div');
    modal.id = 'ft-index-chart-modal';
    modal.className = 'hidden fixed inset-0 z-[9999] overflow-y-auto bg-black/60 backdrop-blur-sm flex items-center justify-center p-3 sm:p-4 animate-in fade-in duration-150';
    modal.innerHTML = `
      <div class="signature-card bg-white dark:bg-[#18181b] border border-gray-200 dark:border-white/10 w-full max-w-2xl p-4 sm:p-6 shadow-2xl rounded-2xl relative flex flex-col gap-3 font-sans">
        
        <!-- Modal Header -->
        <div class="flex items-center justify-between pb-3 border-b border-gray-100 dark:border-white/5">
          <div class="flex items-center space-x-2.5 min-w-0">
            <div class="w-3 h-3 rounded-full bg-emerald-500 animate-pulse shrink-0"></div>
            <div class="min-w-0">
              <div class="flex items-center space-x-2 flex-wrap">
                <h3 id="ft-index-modal-title" class="text-base sm:text-lg font-bold text-gray-900 dark:text-white truncate">Indice</h3>
                <span id="ft-index-modal-symbol" class="text-[10px] font-mono px-2 py-0.5 rounded-full bg-gray-100 dark:bg-white/10 text-gray-500 dark:text-gray-400 font-semibold uppercase"></span>
              </div>
              <div class="flex items-center space-x-2 text-xs font-mono mt-0.5">
                <span id="ft-index-modal-price" class="font-bold text-gray-900 dark:text-white text-sm sm:text-base tabular-nums">-</span>
                <span id="ft-index-modal-change" class="text-[10px] font-semibold px-1.5 py-0.2 rounded-full tabular-nums"></span>
              </div>
            </div>
          </div>

          <button type="button" id="ft-index-modal-close" class="p-1.5 text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-white/5 rounded-xl transition" title="Chiudi (ESC)">
            <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/>
            </svg>
          </button>
        </div>

        <!-- Period Selector & Range Stats -->
        <div class="flex flex-wrap items-center justify-between gap-2 pt-1 font-mono text-xs">
          <!-- Period Selector Buttons -->
          <div id="ft-index-range-buttons" class="flex items-center space-x-1 text-[11px] font-semibold">
            <button type="button" data-range="1M" class="ft-range-btn px-2.5 py-1 rounded-lg transition border border-gray-200 dark:border-white/10 hover:bg-gray-100 dark:hover:bg-white/10 text-gray-600 dark:text-gray-300">1M</button>
            <button type="button" data-range="3M" class="ft-range-btn px-2.5 py-1 rounded-lg transition border border-gray-200 dark:border-white/10 hover:bg-gray-100 dark:hover:bg-white/10 text-gray-600 dark:text-gray-300">3M</button>
            <button type="button" data-range="6M" class="ft-range-btn px-2.5 py-1 rounded-lg transition border border-gray-200 dark:border-white/10 hover:bg-gray-100 dark:hover:bg-white/10 text-gray-600 dark:text-gray-300">6M</button>
            <button type="button" data-range="1Y" class="ft-range-btn px-2.5 py-1 rounded-lg transition border border-emerald-500 bg-emerald-600 text-white font-bold shadow-xs">1Y</button>
            <button type="button" data-range="3Y" class="ft-range-btn px-2.5 py-1 rounded-lg transition border border-gray-200 dark:border-white/10 hover:bg-gray-100 dark:hover:bg-white/10 text-gray-600 dark:text-gray-300">3Y</button>
            <button type="button" data-range="ALL" class="ft-range-btn px-2.5 py-1 rounded-lg transition border border-gray-200 dark:border-white/10 hover:bg-gray-100 dark:hover:bg-white/10 text-gray-600 dark:text-gray-300">ALL</button>
          </div>

          <!-- Quick Stats on Period -->
          <div id="ft-index-stats" class="flex items-center space-x-3 text-[11px] text-gray-500 dark:text-gray-400">
            <div>Var. Periodo: <strong id="ft-index-stat-perf" class="tabular-nums">-</strong></div>
            <div>Min: <span id="ft-index-stat-min" class="tabular-nums">-</span></div>
            <div>Max: <span id="ft-index-stat-max" class="tabular-nums">-</span></div>
          </div>
        </div>

        <!-- Chart Canvas Container -->
        <div class="h-64 sm:h-80 w-full relative overflow-hidden rounded-xl bg-gray-50/70 dark:bg-black/30 p-2 border border-gray-100 dark:border-white/5">
          <!-- Loading Overlay -->
          <div id="ft-index-chart-loading" class="absolute inset-0 bg-white/70 dark:bg-[#18181b]/70 backdrop-blur-xs flex items-center justify-center z-10 hidden">
            <div class="flex items-center space-x-2 text-xs font-mono text-gray-500">
              <svg class="w-5 h-5 animate-spin text-emerald-500" fill="none" viewBox="0 0 24 24">
                <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
              </svg>
              <span>Caricamento andamento...</span>
            </div>
          </div>

          <!-- Empty State Overlay -->
          <div id="ft-index-chart-empty" class="absolute inset-0 flex flex-col items-center justify-center z-10 hidden text-xs font-mono text-gray-400 p-4 text-center">
            <p>Nessun dato storico disponibile per il periodo selezionato.</p>
          </div>

          <!-- Canvas -->
          <canvas id="ft-index-chart-canvas" class="w-full h-full"></canvas>
        </div>

        <!-- Modal Footer / Details -->
        <div class="flex items-center justify-between text-[10px] font-mono text-gray-400 pt-1 border-t border-gray-100 dark:border-white/5">
          <span id="ft-index-modal-points-count">-</span>
          <span>Andamento benchmark di mercato</span>
        </div>
      </div>
    `;

    document.body.appendChild(modal);

    // Close button
    modal.querySelector('#ft-index-modal-close').addEventListener('click', closeIndexChartModal);

    // Close on clicking backdrop
    modal.addEventListener('click', (e) => {
      if (e.target === modal) closeIndexChartModal();
    });

    // Time range buttons click handler
    modal.querySelector('#ft-index-range-buttons').addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-range]');
      if (!btn) return;
      const range = btn.getAttribute('data-range');
      if (range && range !== currentModalRange) {
        updateRangeButtons(range);
        if (currentModalItem) {
          loadIndexChart(currentModalItem, range);
        }
      }
    });

    // Close on ESC key
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        const m = document.getElementById('ft-index-chart-modal');
        if (m && !m.classList.contains('hidden')) {
          closeIndexChartModal();
        }
      }
    });
  }

  function updateRangeButtons(activeRange) {
    currentModalRange = activeRange;
    const container = document.getElementById('ft-index-range-buttons');
    if (!container) return;
    container.querySelectorAll('button[data-range]').forEach(btn => {
      const r = btn.getAttribute('data-range');
      if (r === activeRange) {
        btn.className = 'ft-range-btn px-2.5 py-1 rounded-lg transition border border-emerald-500 bg-emerald-600 text-white font-bold shadow-xs';
      } else {
        btn.className = 'ft-range-btn px-2.5 py-1 rounded-lg transition border border-gray-200 dark:border-white/10 hover:bg-gray-100 dark:hover:bg-white/10 text-gray-600 dark:text-gray-300 font-medium';
      }
    });
  }

  function openIndexChartModal(item) {
    if (!item || !item.symbol) return;
    ensureModalDom();

    currentModalItem = item;
    const modal = document.getElementById('ft-index-chart-modal');
    if (!modal) return;

    // Header info
    document.getElementById('ft-index-modal-title').textContent = item.name || item.symbol;
    document.getElementById('ft-index-modal-symbol').textContent = item.symbol;
    document.getElementById('ft-index-modal-price').textContent = formatPrice(item);

    const chg = formatChange(item);
    const chgEl = document.getElementById('ft-index-modal-change');
    chgEl.className = `text-[10px] font-semibold px-1.5 py-0.2 rounded-full tabular-nums ${chg.isPositive ? 'badge-profit' : 'badge-loss'}`;
    chgEl.innerHTML = `<span class="mr-0.5 text-[8px]">${chg.isPositive ? '▲' : '▼'}</span>${chg.text} oggi`;

    // Reset stats
    document.getElementById('ft-index-stat-perf').textContent = '...';
    document.getElementById('ft-index-stat-min').textContent = '...';
    document.getElementById('ft-index-stat-max').textContent = '...';
    document.getElementById('ft-index-modal-points-count').textContent = 'Caricamento rilevazioni...';

    updateRangeButtons(currentModalRange || '1Y');
    modal.classList.remove('hidden');

    loadIndexChart(item, currentModalRange || '1Y');
  }

  function closeIndexChartModal() {
    const modal = document.getElementById('ft-index-chart-modal');
    if (modal) modal.classList.add('hidden');

    if (activeChartInstance) {
      activeChartInstance.destroy();
      activeChartInstance = null;
    }
  }

  async function loadIndexChart(item, range = '1Y') {
    const loadingOverlay = document.getElementById('ft-index-chart-loading');
    const emptyOverlay = document.getElementById('ft-index-chart-empty');
    const canvas = document.getElementById('ft-index-chart-canvas');

    if (loadingOverlay) loadingOverlay.classList.remove('hidden');
    if (emptyOverlay) emptyOverlay.classList.add('hidden');

    try {
      await ensureChartJs();

      const res = await fetch(`/api/market/chart/${encodeURIComponent(item.symbol)}?range=${encodeURIComponent(range)}`);
      const data = await res.json();
      const points = (data && (data.points || data.data)) || [];

      if (!points || points.length === 0) {
        if (emptyOverlay) emptyOverlay.classList.remove('hidden');
        if (loadingOverlay) loadingOverlay.classList.add('hidden');
        if (activeChartInstance) {
          activeChartInstance.destroy();
          activeChartInstance = null;
        }
        return;
      }

      // Sort points chronologically ASC
      points.sort((a, b) => (a.date > b.date ? 1 : -1));

      // Calculate Period Metrics
      const firstClose = Number(points[0].close) || 0;
      const lastClose = Number(points[points.length - 1].close) || 0;
      const delta = lastClose - firstClose;
      const deltaPct = firstClose > 0 ? (delta / firstClose) * 100 : 0;
      const isPositive = deltaPct >= 0;

      const closes = points.map(p => Number(p.close) || 0);
      const minClose = Math.min(...closes);
      const maxClose = Math.max(...closes);

      // Update Header Stats
      const perfEl = document.getElementById('ft-index-stat-perf');
      if (perfEl) {
        perfEl.textContent = `${isPositive ? '+' : ''}${deltaPct.toFixed(2)}%`;
        perfEl.className = isPositive ? 'text-emerald-600 dark:text-emerald-400 font-bold tabular-nums' : 'text-rose-600 dark:text-rose-400 font-bold tabular-nums';
      }

      const minEl = document.getElementById('ft-index-stat-min');
      if (minEl) minEl.textContent = formatVal(minClose, item);

      const maxEl = document.getElementById('ft-index-stat-max');
      if (maxEl) maxEl.textContent = formatVal(maxClose, item);

      const countEl = document.getElementById('ft-index-modal-points-count');
      if (countEl) {
        countEl.textContent = `${points.length} rilevazioni (${points[0].date} → ${points[points.length - 1].date})`;
      }

      // Render Chart.js line
      if (activeChartInstance) {
        activeChartInstance.destroy();
        activeChartInstance = null;
      }

      const ctx = canvas.getContext('2d');
      const isDark = document.documentElement.classList.contains('dark') || document.body.classList.contains('dark');
      const strokeColor = isPositive ? '#10b981' : '#f43f5e';

      const gradient = ctx.createLinearGradient(0, 0, 0, canvas.height || 280);
      if (isPositive) {
        gradient.addColorStop(0, 'rgba(16, 185, 129, 0.28)');
        gradient.addColorStop(1, 'rgba(16, 185, 129, 0.0)');
      } else {
        gradient.addColorStop(0, 'rgba(244, 63, 94, 0.28)');
        gradient.addColorStop(1, 'rgba(244, 63, 94, 0.0)');
      }

      activeChartInstance = new Chart(canvas, {
        type: 'line',
        data: {
          labels: points.map(p => p.date),
          datasets: [{
            label: item.name || item.symbol,
            data: closes,
            borderColor: strokeColor,
            borderWidth: 2,
            pointRadius: 0,
            pointHoverRadius: 5,
            pointBackgroundColor: strokeColor,
            fill: true,
            backgroundColor: gradient,
            tension: 0.15
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          interaction: {
            intersect: false,
            mode: 'index'
          },
          plugins: {
            legend: { display: false },
            tooltip: {
              backgroundColor: isDark ? 'rgba(20, 20, 22, 0.95)' : 'rgba(255, 255, 255, 0.95)',
              titleColor: isDark ? '#ffffff' : '#111827',
              bodyColor: isDark ? '#d1d5db' : '#374151',
              borderColor: isDark ? 'rgba(255, 255, 255, 0.1)' : 'rgba(0, 0, 0, 0.1)',
              borderWidth: 1,
              padding: 10,
              boxPadding: 4,
              usePointStyle: true,
              callbacks: {
                title: (items) => {
                  const idx = items[0]?.dataIndex;
                  const p = points[idx];
                  return p ? `Data: ${p.date}` : '';
                },
                label: (c) => {
                  return ` ${item.name || item.symbol}: ${formatVal(c.raw, item)}`;
                }
              }
            }
          },
          scales: {
            x: {
              grid: { display: false },
              ticks: {
                maxTicksLimit: (window.innerWidth < 640) ? 5 : 7,
                font: { family: 'JetBrains Mono', size: 10 },
                color: isDark ? '#9ca3af' : '#6b7280'
              }
            },
            y: {
              position: 'left',
              grid: { color: isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)' },
              ticks: {
                font: { family: 'JetBrains Mono', size: 10 },
                color: isDark ? '#9ca3af' : '#6b7280',
                callback: (v) => formatVal(v, item)
              }
            }
          }
        }
      });
    } catch (err) {
      console.warn('[HeaderIndices] Errore caricamento grafico indice:', err);
      if (emptyOverlay) emptyOverlay.classList.remove('hidden');
    } finally {
      if (loadingOverlay) loadingOverlay.classList.add('hidden');
    }
  }

  function renderTicker(container, indices, options = {}) {
    if (!container) return;
    ensureStyles();

    const speed = options.scrollSpeed || currentScrollSpeed;
    const refreshSec = options.refreshSeconds || currentRefreshSeconds;
    const activeIndices = Array.isArray(indices) && indices.length > 0 ? indices : DEFAULT_INDICES;

    // Determine marquee duration based on number of items and speed preference:
    // Slowed down significantly for calm, easy readability.
    const baseSecondsPerItem = speed === 'very_slow' ? 35 : (speed === 'slow' ? 26 : (speed === 'fast' ? 12 : 18));
    const minDuration = speed === 'very_slow' ? 180 : (speed === 'slow' ? 130 : (speed === 'fast' ? 55 : 85));
    const duration = Math.max(minDuration, activeIndices.length * baseSecondsPerItem);

    // Build the items HTML with click handler attributes
    const itemsHtml = activeIndices.map(item => {
      const chg = formatChange(item);
      const badgeClass = chg.isPositive ? 'badge-profit' : 'badge-loss';
      const arrow = chg.isPositive ? '▲' : '▼';

      return `
        <div class="ft-ticker-item border-r border-gray-200/50 dark:border-white/5 cursor-pointer"
             data-symbol="${escapeHtml(item.symbol)}"
             data-name="${escapeHtml(item.name || item.symbol)}"
             data-price="${item.price}"
             data-change="${item.change || 0}"
             data-change-pct="${item.changePercent || 0}"
             data-currency="${escapeHtml(item.currency || '')}"
             data-yield="${item.isYield ? 'true' : 'false'}"
             title="Clicca per visualizzare il grafico di ${escapeHtml(item.name || item.symbol)}">
          <span class="font-semibold text-gray-500 dark:text-gray-400 tracking-wide">${escapeHtml(item.name || item.symbol)}</span>
          <span class="font-mono font-medium text-gray-900 dark:text-gray-100 tabular-nums">${formatPrice(item)}</span>
          <span class="${badgeClass} tabular-nums text-[10px] px-1.5 py-0.2 rounded-full inline-flex items-center">
            <span class="mr-0.5 text-[8px]">${arrow}</span>${chg.text}
          </span>
        </div>
      `;
    }).join('');

    // Ensure enough repetitions so that one group comfortably exceeds ultra-wide screen width
    let groupHtml = itemsHtml;
    if (activeIndices.length < 5) {
      groupHtml = itemsHtml + itemsHtml; // duplicate once more if very few items
    }

    container.innerHTML = `
      <div class="ft-ticker-container">
        <!-- Live Ticker Indicator Badge -->
        <div class="flex items-center shrink-0 pl-3 pr-2.5 py-1 border-r border-gray-200/80 dark:border-white/10 z-20 bg-white/95 dark:bg-[#151517]/95 shadow-xs">
          <span class="relative flex h-2 w-2 mr-1.5">
            <span class="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
            <span class="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
          </span>
          <span class="font-mono text-[10px] font-bold text-gray-700 dark:text-gray-300 tracking-wider">LIVE</span>
          <span class="text-[9px] font-mono text-gray-400 ml-1.5 hidden sm:inline" title="Frequenza aggiornamento: ${refreshSec}s">${refreshSec}s</span>
          <button type="button" id="ft-ticker-force-btn" class="ml-1 text-gray-400 hover:text-emerald-500 transition p-0.5 rounded cursor-pointer" title="Ricarica quotazioni banner adesso">
            <span id="ft-ticker-spin-icon" class="text-[10px] block">🔄</span>
          </button>
        </div>

        <!-- Scrolling Ticker Viewport -->
        <div class="ft-ticker-viewport" style="--ft-ticker-speed: ${duration}s;">
          <div class="ft-ticker-track">
            <!-- Group 1 -->
            <div class="ft-ticker-group">
              ${groupHtml}
            </div>
            <!-- Group 2 (Exact replica for seamless infinite marquee loop) -->
            <div class="ft-ticker-group" aria-hidden="true">
              ${groupHtml}
            </div>
          </div>
        </div>
      </div>
    `;

    // Hook manual refresh button
    const forceBtn = container.querySelector('#ft-ticker-force-btn');
    if (forceBtn) {
      forceBtn.addEventListener('click', async (e) => {
        e.preventDefault();
        await refreshBanner(true);
      });
    }

    // Hook click on ticker items to open index trend chart modal
    const track = container.querySelector('.ft-ticker-viewport');
    if (track) {
      track.addEventListener('click', (e) => {
        const itemEl = e.target.closest('.ft-ticker-item');
        if (!itemEl) return;
        e.preventDefault();
        const sym = itemEl.getAttribute('data-symbol');
        if (!sym) return;
        const item = (lastData || []).find(x => x.symbol === sym) || {
          symbol: sym,
          name: itemEl.getAttribute('data-name') || sym,
          price: parseFloat(itemEl.getAttribute('data-price')) || 0,
          change: parseFloat(itemEl.getAttribute('data-change')) || 0,
          changePercent: parseFloat(itemEl.getAttribute('data-change-pct')) || 0,
          currency: itemEl.getAttribute('data-currency') || '',
          isYield: itemEl.getAttribute('data-yield') === 'true'
        };
        openIndexChartModal(item);
      });
    }
  }

  async function fetchLiveIndices(force = false) {
    try {
      const url = force ? '/api/market/indices?force=true' : '/api/market/indices';
      const res = await fetch(url);
      if (res.ok) {
        const data = await res.json();
        if (data.success && Array.isArray(data.indices)) {
          if (data.refreshSeconds) currentRefreshSeconds = Number(data.refreshSeconds);
          if (data.scrollSpeed) currentScrollSpeed = data.scrollSpeed;
          lastData = data.indices;
          return {
            indices: data.indices,
            refreshSeconds: currentRefreshSeconds,
            scrollSpeed: currentScrollSpeed
          };
        }
      }
    } catch {
      // Offline or network error
    }
    return {
      indices: lastData || DEFAULT_INDICES,
      refreshSeconds: currentRefreshSeconds,
      scrollSpeed: currentScrollSpeed
    };
  }

  async function refreshBanner(force = false) {
    if (isFetching) return;
    isFetching = true;

    const icon = document.getElementById('ft-ticker-spin-icon');
    if (icon) icon.classList.add('ft-spin');

    try {
      const container = document.getElementById('live-ticker-container') || document.querySelector('[data-live-ticker]');
      if (!container) return;

      const payload = await fetchLiveIndices(force);
      renderTicker(container, payload.indices, {
        scrollSpeed: payload.scrollSpeed,
        refreshSeconds: payload.refreshSeconds
      });

      // Reset timer if frequency changed
      setupRefreshTimer(payload.refreshSeconds);
    } finally {
      if (icon) icon.classList.remove('ft-spin');
      isFetching = false;
    }
  }

  function setupRefreshTimer(seconds) {
    if (currentRefreshTimer) {
      clearInterval(currentRefreshTimer);
      currentRefreshTimer = null;
    }
    const intervalMs = Math.max(5000, (Number(seconds) || 60) * 1000);
    currentRefreshTimer = setInterval(() => {
      refreshBanner(false);
    }, intervalMs);
  }

  async function init() {
    ensureStyles();
    const container = document.getElementById('live-ticker-container') || document.querySelector('[data-live-ticker]');
    if (!container) return;

    // Initial render with default/cached data so banner shows immediately
    renderTicker(container, DEFAULT_INDICES, { refreshSeconds: currentRefreshSeconds, scrollSpeed: currentScrollSpeed });

    // Fetch live data & user configured preferences
    await refreshBanner(false);

    // Listen for custom event fired when Settings page updates ticker configuration
    window.addEventListener('foliotrack:ticker-config-updated', (e) => {
      if (e.detail) {
        if (e.detail.refreshSeconds) currentRefreshSeconds = Number(e.detail.refreshSeconds);
        if (e.detail.scrollSpeed) currentScrollSpeed = e.detail.scrollSpeed;
      }
      refreshBanner(true);
    });

    // Listen for cross-tab updates via localStorage
    window.addEventListener('storage', (e) => {
      if (e.key === 'foliotrack_ticker_updated') {
        refreshBanner(true);
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  window.FolioTrackTicker = {
    render: renderTicker,
    refresh: () => refreshBanner(true),
    openChart: (symbolOrItem) => {
      let item = symbolOrItem;
      if (typeof symbolOrItem === 'string') {
        item = (lastData || []).find(x => x.symbol === symbolOrItem) || { symbol: symbolOrItem, name: symbolOrItem };
      }
      openIndexChartModal(item);
    },
    closeChart: closeIndexChartModal,
    DEFAULT_INDICES
  };
})();
