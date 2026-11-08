/**
 * FolioTrack - Analisi Titoli Azionari & Watchlist
 * Client-side engine for monitoring equity assets, multi-period variations,
 * Stop Loss / Take Profit target levels, and Yahoo Finance fundamental analysis.
 */

(function () {
  'use strict';

  let allAssets = [];
  let activeFilter = 'all';
  let searchQuery = '';
  let currentTargetTicker = null;

  // Formatting helpers
  function fmtCurrencySymbol(cur) {
    const c = (cur || 'EUR').toUpperCase();
    if (c === 'USD') return '$';
    if (c === 'GBP') return '£';
    if (c === 'CHF') return 'CHF';
    return '€';
  }

  function fmtPrice(val, cur = 'EUR') {
    const n = Number(val);
    if (isNaN(n) || val === null || val === undefined) return '-';
    const sym = fmtCurrencySymbol(cur);
    const hasSubCents = (n !== 0) && (Math.abs(n * 100 - Math.round(n * 100)) > 0.001);
    return `${sym} ` + n.toLocaleString('it-IT', {
      minimumFractionDigits: 2,
      maximumFractionDigits: hasSubCents ? 4 : 2
    });
  }

  function fmtLargeNumber(val, cur = 'EUR') {
    const n = Number(val);
    if (isNaN(n) || val === null || val === undefined) return '-';
    const sym = fmtCurrencySymbol(cur);
    const abs = Math.abs(n);
    if (abs >= 1e12) return `${sym} ${(n / 1e12).toFixed(2)} T`;
    if (abs >= 1e9) return `${sym} ${(n / 1e9).toFixed(2)} B`;
    if (abs >= 1e6) return `${sym} ${(n / 1e6).toFixed(2)} M`;
    if (abs >= 1e3) return `${sym} ${(n / 1e3).toFixed(1)} K`;
    return `${sym} ${n.toFixed(2)}`;
  }

  function fmtMultiple(val) {
    const n = Number(val);
    if (isNaN(n) || val === null || val === undefined || n === 0) return '-';
    return n.toFixed(2) + 'x';
  }

  function fmtPct(val, includeSign = true) {
    const n = Number(val);
    if (isNaN(n) || val === null || val === undefined) return '-';
    const sign = includeSign && n > 0 ? '+' : '';
    return `${sign}${n.toFixed(2)}%`;
  }

  function renderVariationBadge(val) {
    if (val === null || val === undefined || isNaN(Number(val))) {
      return '<span class="text-gray-400 font-mono text-[11px]">-</span>';
    }
    const n = Number(val);
    if (n > 0) {
      return `<span class="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-bold font-mono bg-emerald-100 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300 tabular-nums">+${n.toFixed(2)}%</span>`;
    } else if (n < 0) {
      return `<span class="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-bold font-mono bg-rose-100 text-rose-800 dark:bg-rose-950/60 dark:text-rose-300 tabular-nums">${n.toFixed(2)}%</span>`;
    }
    return `<span class="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-bold font-mono bg-gray-100 text-gray-700 dark:bg-white/10 dark:text-gray-300 tabular-nums">0.00%</span>`;
  }

  function getRecommendationBadge(recKey) {
    const k = (recKey || '').toLowerCase();
    if (k.includes('strong_buy')) {
      return '<span class="px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-600 text-white">STRONG BUY</span>';
    } else if (k.includes('buy')) {
      return '<span class="px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-500/80 text-white">BUY</span>';
    } else if (k.includes('hold')) {
      return '<span class="px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-500 text-white">HOLD</span>';
    } else if (k.includes('sell') || k.includes('underperform')) {
      return '<span class="px-2 py-0.5 rounded-full text-[10px] font-bold bg-rose-600 text-white">SELL</span>';
    }
    return `<span class="px-2 py-0.5 rounded-full text-[10px] font-bold bg-gray-200 dark:bg-white/10 text-gray-700 dark:text-gray-300 uppercase">${recKey || 'N/D'}</span>`;
  }

  // Filter items
  function getFilteredAssets() {
    return allAssets.filter(item => {
      // 1. Tab filter
      if (activeFilter === 'portfolio' && !item.inPortfolio) return false;
      if (activeFilter === 'monitored' && item.inPortfolio) return false;
      if (activeFilter === 'alerts' && item.slStatus === 'NORMAL' && item.tpStatus === 'NORMAL') return false;

      // 2. Search query
      if (searchQuery) {
        const q = searchQuery.toLowerCase();
        const matchesTicker = item.ticker.toLowerCase().includes(q);
        const matchesName = (item.name || '').toLowerCase().includes(q);
        if (!matchesTicker && !matchesName) return false;
      }
      return true;
    });
  }

  // Load analysis data from API
  async function loadAnalysisData() {
    const iconRefresh = document.getElementById('iconRefresh') || document.getElementById('mIconRefresh');
    if (iconRefresh) iconRefresh.classList.add('animate-spin');

    try {
      const res = await fetch('/api/analysis');
      const data = await res.json();

      if (!data.success) {
        console.error('[Analysis] Error:', data.error);
        return;
      }

      allAssets = data.assets || [];
      const stats = data.stats || {};

      // Update KPI counters (Desktop)
      const kpiTotal = document.getElementById('kpiTotalAssets');
      const kpiPortCount = document.getElementById('kpiPortfolioCount');
      const kpiGainers = document.getElementById('kpiGainers');
      const kpiSlAlerts = document.getElementById('kpiSlAlerts');
      const kpiTpReached = document.getElementById('kpiTpReached');

      if (kpiTotal) kpiTotal.textContent = stats.totalEquities || allAssets.length;
      if (kpiPortCount) kpiPortCount.textContent = `${stats.portfolioCount || 0} in portafoglio`;
      if (kpiGainers) kpiGainers.textContent = `${stats.gainers1mCount || 0} (1M) / ${stats.gainers1yCount || 0} (1Y)`;
      if (kpiSlAlerts) kpiSlAlerts.textContent = stats.slTriggeredCount || 0;
      if (kpiTpReached) kpiTpReached.textContent = stats.tpReachedCount || 0;

      // Update badge counts in filter buttons
      const countAll = document.getElementById('countAll') || document.getElementById('mCountAll');
      const countPort = document.getElementById('countPortfolio') || document.getElementById('mCountPortfolio');
      const countWatch = document.getElementById('countWatchlist') || document.getElementById('mCountWatchlist');
      const countAlerts = document.getElementById('countAlerts') || document.getElementById('mCountAlerts');
      const mTotalCount = document.getElementById('mTotalCount');

      if (countAll) countAll.textContent = allAssets.length;
      if (countPort) countPort.textContent = allAssets.filter(x => x.inPortfolio).length;
      if (countWatch) countWatch.textContent = allAssets.filter(x => !x.inPortfolio).length;
      if (countAlerts) countAlerts.textContent = allAssets.filter(x => x.slStatus !== 'NORMAL' || x.tpStatus !== 'NORMAL').length;
      if (mTotalCount) mTotalCount.textContent = `${allAssets.length} titoli monitorati`;

      // Render view
      if (document.getElementById('analysisTableBody')) {
        renderDesktopTable();
      }
      if (document.getElementById('mAnalysisListContainer')) {
        renderMobileList();
      }

    } catch (err) {
      console.error('[Analysis Fetch Error]', err);
    } finally {
      if (iconRefresh) iconRefresh.classList.remove('animate-spin');
    }
  }

  // Render Desktop Table
  function renderDesktopTable() {
    const tbody = document.getElementById('analysisTableBody');
    if (!tbody) return;

    const items = getFilteredAssets();
    const countBadge = document.getElementById('tableCountBadge');
    if (countBadge) countBadge.textContent = `${items.length} di ${allAssets.length} titoli`;

    if (items.length === 0) {
      tbody.innerHTML = `
        <tr>
          <td colspan="11" class="px-6 py-10 text-center text-gray-400 font-mono text-xs">
            Nessun titolo azionario trovato per i filtri selezionati.
          </td>
        </tr>
      `;
      return;
    }

    tbody.innerHTML = items.map(a => {
      const vars = a.variations || {};
      const cur = a.currency || 'EUR';

      // Origin badge
      const originBadge = a.inPortfolio
        ? '<span class="inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-bold bg-blue-100 text-blue-800 dark:bg-blue-950/60 dark:text-blue-300">PORTAFOGLIO</span>'
        : '<span class="inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-bold bg-purple-100 text-purple-800 dark:bg-purple-950/60 dark:text-purple-300">WATCHLIST</span>';

      // SL rendering
      let slHtml = '<span class="text-gray-400 font-mono text-xs">-</span>';
      if (a.stopLoss !== null && a.stopLoss > 0) {
        if (a.slStatus === 'TRIGGERED') {
          slHtml = `<span class="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-bold bg-rose-600 text-white animate-pulse" title="Prezzo attuale (${fmtPrice(a.currentPrice, cur)}) sotto il livello di Stop Loss">🚨 SL: ${fmtPrice(a.stopLoss, cur)}</span>`;
        } else if (a.slStatus === 'NEAR') {
          slHtml = `<span class="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-bold bg-amber-500 text-white" title="Prezzo vicino allo Stop Loss">⚠️ SL: ${fmtPrice(a.stopLoss, cur)}</span>`;
        } else {
          slHtml = `<span class="font-mono text-xs text-gray-700 dark:text-gray-300">${fmtPrice(a.stopLoss, cur)}</span>`;
        }
      }

      // TP rendering
      let tpHtml = '<span class="text-gray-400 font-mono text-xs">-</span>';
      if (a.takeProfit !== null && a.takeProfit > 0) {
        if (a.tpStatus === 'REACHED') {
          slHtml = `<span class="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-bold bg-emerald-600 text-white" title="Target raggiunto o superato">🎯 TP: ${fmtPrice(a.takeProfit, cur)}</span>`;
        } else if (a.tpStatus === 'NEAR') {
          tpHtml = `<span class="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-bold bg-emerald-500/80 text-white" title="Prezzo vicino al Take Profit">🎯 TP: ${fmtPrice(a.takeProfit, cur)}</span>`;
        } else {
          tpHtml = `<span class="font-mono text-xs text-gray-700 dark:text-gray-300">${fmtPrice(a.takeProfit, cur)}</span>`;
        }
      }

      return `
        <tr data-ticker="${a.ticker}" class="hover:bg-gray-50/80 dark:hover:bg-white/5 transition group cursor-pointer">
          <td class="px-2.5 py-1.5 whitespace-nowrap">
            <div class="flex items-center space-x-2">
              <span class="font-bold text-xs text-gray-900 dark:text-white font-mono group-hover:text-emerald-600 dark:group-hover:text-emerald-400 transition-colors">${a.ticker}</span>
              <span class="text-gray-400 text-[11px] truncate max-w-[150px] font-sans" title="${a.name}">${a.name}</span>
            </div>
          </td>
          <td class="px-2.5 py-1.5 whitespace-nowrap">${originBadge}</td>
          <td class="px-2.5 py-1.5 whitespace-nowrap text-right font-bold text-xs text-gray-900 dark:text-white font-mono">${fmtPrice(a.currentPrice, cur)}</td>
          <td class="px-2 py-1.5 whitespace-nowrap text-right">${renderVariationBadge(vars['1W'])}</td>
          <td class="px-2 py-1.5 whitespace-nowrap text-right">${renderVariationBadge(vars['1M'])}</td>
          <td class="px-2 py-1.5 whitespace-nowrap text-right">${renderVariationBadge(vars['3M'])}</td>
          <td class="px-2 py-1.5 whitespace-nowrap text-right">${renderVariationBadge(vars['1Y'])}</td>
          <td class="px-2 py-1.5 whitespace-nowrap text-right">${renderVariationBadge(vars['3Y'])}</td>
          <td class="px-2.5 py-1.5 whitespace-nowrap text-right">${slHtml}</td>
          <td class="px-2.5 py-1.5 whitespace-nowrap text-right">${tpHtml}</td>
          <td class="px-2 py-1.5 whitespace-nowrap text-center" onclick="event.stopPropagation()">
            <div class="inline-flex items-center space-x-1 opacity-75 group-hover:opacity-100 transition leading-none">
              <button data-action="targets" data-ticker="${a.ticker}" title="Imposta / Modifica SL e TP" class="p-1 text-gray-400 hover:text-emerald-600 dark:hover:text-emerald-400 rounded hover:bg-gray-100 dark:hover:bg-white/10 transition">
                <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
                </svg>
              </button>
              <button data-action="fundamentals" data-ticker="${a.ticker}" title="Analisi Fondamentale Yahoo Finance" class="p-1 text-gray-400 hover:text-blue-600 dark:hover:text-blue-400 rounded hover:bg-gray-100 dark:hover:bg-white/10 transition">
                <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              </button>
              ${!a.inPortfolio ? `
                <button data-action="delete" data-ticker="${a.ticker}" title="Rimuovi da watchlist" class="p-1 text-gray-400 hover:text-rose-600 dark:hover:text-rose-400 rounded hover:bg-gray-100 dark:hover:bg-white/10 transition">
                  <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                  </svg>
                </button>
              ` : ''}
            </div>
          </td>
        </tr>
      `;
    }).join('');

    // Bind row click for fundamentals
    tbody.querySelectorAll('tr[data-ticker]').forEach(row => {
      row.addEventListener('click', () => {
        const ticker = row.getAttribute('data-ticker');
        if (ticker) openFundamentalsModal(ticker);
      });
    });

    // Bind action buttons
    tbody.querySelectorAll('button[data-action]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const action = btn.getAttribute('data-action');
        const ticker = btn.getAttribute('data-ticker');
        if (action === 'fundamentals') openFundamentalsModal(ticker);
        else if (action === 'targets') openEditTargetsModal(ticker);
        else if (action === 'delete') removeWatchlistAsset(ticker);
      });
    });
  }

  // Render Mobile Cards List
  function renderMobileList() {
    const container = document.getElementById('mAnalysisListContainer');
    if (!container) return;

    const items = getFilteredAssets();

    if (items.length === 0) {
      container.innerHTML = `
        <div class="signature-card p-6 text-center text-xs text-gray-400 font-mono">
          Nessun titolo azionario trovato.
        </div>
      `;
      return;
    }

    container.innerHTML = items.map(a => {
      const vars = a.variations || {};
      const cur = a.currency || 'EUR';

      const originBadge = a.inPortfolio
        ? '<span class="px-1 py-0.2 rounded text-[8px] font-bold bg-blue-100 text-blue-800 dark:bg-blue-950/60 dark:text-blue-300">PORTAFOGLIO</span>'
        : '<span class="px-1 py-0.2 rounded text-[8px] font-bold bg-purple-100 text-purple-800 dark:bg-purple-950/60 dark:text-purple-300">WATCHLIST</span>';

      let slStatusBadge = '';
      if (a.stopLoss !== null && a.stopLoss > 0) {
        if (a.slStatus === 'TRIGGERED') {
          slStatusBadge = `<span class="px-1.5 py-0.2 rounded text-[9px] font-bold bg-rose-600 text-white animate-pulse">SL: ${fmtPrice(a.stopLoss, cur)}</span>`;
        } else {
          slStatusBadge = `<span class="px-1.5 py-0.2 rounded text-[9px] font-mono text-gray-400">SL: ${fmtPrice(a.stopLoss, cur)}</span>`;
        }
      }

      let tpStatusBadge = '';
      if (a.takeProfit !== null && a.takeProfit > 0) {
        if (a.tpStatus === 'REACHED') {
          tpStatusBadge = `<span class="px-1.5 py-0.2 rounded text-[9px] font-bold bg-emerald-600 text-white">TP: ${fmtPrice(a.takeProfit, cur)}</span>`;
        } else {
          tpStatusBadge = `<span class="px-1.5 py-0.2 rounded text-[9px] font-mono text-gray-400">TP: ${fmtPrice(a.takeProfit, cur)}</span>`;
        }
      }

      return `
        <div data-ticker="${a.ticker}" class="signature-card p-2 flex flex-col justify-between gap-1 hover:bg-gray-50/50 dark:hover:bg-white/[0.02] transition cursor-pointer">
          <!-- Line 1: Ticker + Badge + Name (Left) | Price (Right) -->
          <div class="flex items-center justify-between min-w-0">
            <div class="flex items-center space-x-1.5 min-w-0 overflow-hidden">
              <span class="font-bold text-xs font-mono text-gray-900 dark:text-white">${a.ticker}</span>
              ${originBadge}
              <span class="text-[10px] text-gray-400 truncate max-w-[120px] font-sans">${a.name}</span>
            </div>
            <div class="font-bold font-mono text-xs tabular-nums text-gray-900 dark:text-white flex-shrink-0 ml-1">
              ${fmtPrice(a.currentPrice, cur)}
            </div>
          </div>

          <!-- Line 2: 1W, 1M, 3M, 1Y, 3Y Multi-Period Performance Pills -->
          <div class="flex items-center justify-between text-[9px] font-mono gap-1 pt-0.5">
            <div class="flex items-center space-x-1 overflow-x-auto">
              <span class="text-gray-400">1W: ${renderVariationBadge(vars['1W'])}</span>
              <span class="text-gray-400">1M: ${renderVariationBadge(vars['1M'])}</span>
              <span class="text-gray-400">3M: ${renderVariationBadge(vars['3M'])}</span>
              <span class="text-gray-400">1Y: ${renderVariationBadge(vars['1Y'])}</span>
              <span class="text-gray-400">3Y: ${renderVariationBadge(vars['3Y'])}</span>
            </div>
          </div>

          <!-- Line 3: SL & TP Levels & Action Buttons -->
          <div class="flex items-center justify-between pt-0.5 text-[10px] font-mono border-t border-gray-100 dark:border-white/5" onclick="event.stopPropagation()">
            <div class="flex items-center space-x-1.5">
              ${slStatusBadge || '<span class="text-gray-500 text-[9px]">SL: -</span>'}
              ${tpStatusBadge || '<span class="text-gray-500 text-[9px]">TP: -</span>'}
            </div>
            <div class="flex items-center space-x-1.5">
              <button data-action="targets" data-ticker="${a.ticker}" class="p-0.5 text-gray-400 hover:text-emerald-500">
                <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
                </svg>
              </button>
              <button data-action="fundamentals" data-ticker="${a.ticker}" class="text-[10px] text-blue-500 font-bold px-1 py-0.2 rounded hover:bg-blue-50 dark:hover:bg-white/5">
                Analisi &rarr;
              </button>
              ${!a.inPortfolio ? `
                <button data-action="delete" data-ticker="${a.ticker}" class="p-0.5 text-rose-500 hover:text-rose-600">
                  <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                  </svg>
                </button>
              ` : ''}
            </div>
          </div>
        </div>
      `;
    }).join('');

    // Bind card clicks
    container.querySelectorAll('div[data-ticker]').forEach(card => {
      card.addEventListener('click', () => {
        const ticker = card.getAttribute('data-ticker');
        if (ticker) openFundamentalsModal(ticker);
      });
    });

    // Bind action buttons
    container.querySelectorAll('button[data-action]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const action = btn.getAttribute('data-action');
        const ticker = btn.getAttribute('data-ticker');
        if (action === 'fundamentals') openFundamentalsModal(ticker);
        else if (action === 'targets') openEditTargetsModal(ticker);
        else if (action === 'delete') removeWatchlistAsset(ticker);
      });
    });
  }

  // Open Fundamentals Modal Dialog
  async function openFundamentalsModal(ticker) {
    const modal = document.getElementById('fundamentalsModal');
    if (!modal) return;

    const modalTitle = document.getElementById('modalStockTitle');
    const modalTicker = document.getElementById('modalStockTicker');
    const modalBadge = document.getElementById('modalStockBadge');
    const modalSubtitle = document.getElementById('modalStockSubtitle');
    const modalBody = document.getElementById('modalBody');
    const modalSource = document.getElementById('modalSourceBadge');

    modalTitle.textContent = ticker;
    modalTicker.textContent = ticker;
    modalBadge.textContent = ticker.slice(0, 3).toUpperCase();
    modalSubtitle.textContent = 'Caricamento dati fondamentali da Yahoo Finance...';

    modalBody.innerHTML = `
      <div class="py-16 text-center text-gray-400">
        <svg class="w-8 h-8 mx-auto animate-spin text-emerald-500 mb-2" fill="none" viewBox="0 0 24 24">
          <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
          <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
        </svg>
        <span>Recupero metriche e consenso analisti per ${ticker}...</span>
      </div>
    `;

    // Open native dialog as modal
    if (!modal.open) {
      modal.showModal();
    }

    try {
      const res = await fetch(`/api/analysis/${encodeURIComponent(ticker)}/fundamentals`);
      const data = await res.json();

      if (!data.success || !data.fundamentals) {
        modalBody.innerHTML = `
          <div class="py-10 text-center text-rose-500 font-mono">
            ⚠️ ${data.error || 'Dati fondamentali non disponibili.'}
          </div>
        `;
        return;
      }

      const f = data.fundamentals;
      modalTitle.textContent = f.companyName || ticker;
      modalBadge.textContent = ticker.slice(0, 2).toUpperCase();
      modalSubtitle.innerHTML = `
        <span>${f.sector || 'N/D'}</span>
        <span>•</span>
        <span>${f.industry || 'N/D'}</span>
        ${f.country ? `<span>•</span><span>${f.country}</span>` : ''}
      `;

      if (modalSource) {
        modalSource.textContent = `Fonte: Yahoo Finance API (${data.source === 'CACHE' ? 'Cache' : 'Dati Live'})`;
      }

      // Render Rich Fundamental Report
      modalBody.innerHTML = `
        <!-- Top Metrics KPI Grid -->
        <div class="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
          <div class="signature-card p-2.5 bg-gray-50/70 dark:bg-white/[0.02] border border-gray-200/50 dark:border-white/5">
            <div class="text-[9px] uppercase font-bold text-gray-400">Market Cap</div>
            <div class="text-sm font-bold text-gray-900 dark:text-white mt-0.5">${fmtLargeNumber(f.marketCap, f.currency)}</div>
          </div>
          <div class="signature-card p-2.5 bg-gray-50/70 dark:bg-white/[0.02] border border-gray-200/50 dark:border-white/5">
            <div class="text-[9px] uppercase font-bold text-gray-400">P/E (Trailing / Fwd)</div>
            <div class="text-sm font-bold text-gray-900 dark:text-white mt-0.5">
              ${f.trailingPE ? f.trailingPE.toFixed(1) + 'x' : '-'} / ${f.forwardPE ? f.forwardPE.toFixed(1) + 'x' : '-'}
            </div>
          </div>
          <div class="signature-card p-2.5 bg-gray-50/70 dark:bg-white/[0.02] border border-gray-200/50 dark:border-white/5">
            <div class="text-[9px] uppercase font-bold text-gray-400">Dividend Yield</div>
            <div class="text-sm font-bold text-emerald-600 dark:text-emerald-400 mt-0.5">
              ${f.dividendYield ? f.dividendYield.toFixed(2) + '%' : '0.00%'}
            </div>
          </div>
          <div class="signature-card p-2.5 bg-gray-50/70 dark:bg-white/[0.02] border border-gray-200/50 dark:border-white/5">
            <div class="text-[9px] uppercase font-bold text-gray-400">Consenso Analisti</div>
            <div class="mt-0.5 flex items-center space-x-1.5">
              ${getRecommendationBadge(f.recommendationKey)}
            </div>
          </div>
        </div>

        <!-- Section 1: Multipli di Valutazione -->
        <div class="signature-card p-3 space-y-2 bg-gray-50/70 dark:bg-white/[0.02] border border-gray-200/50 dark:border-white/5">
          <div class="text-xs font-bold text-gray-900 dark:text-white flex items-center justify-between border-b border-gray-200/60 dark:border-white/5 pb-1">
            <span>📈 Multipli di Mercato & Valutazione</span>
            <span class="text-[10px] text-gray-400 font-normal">yfinance statistics</span>
          </div>
          <div class="grid grid-cols-2 sm:grid-cols-3 gap-2 text-[11px]">
            <div><span class="text-gray-400">P/E Ratio (Trailing):</span> <strong class="text-gray-900 dark:text-white font-mono">${fmtMultiple(f.trailingPE)}</strong></div>
            <div><span class="text-gray-400">P/E Forward:</span> <strong class="text-gray-900 dark:text-white font-mono">${fmtMultiple(f.forwardPE)}</strong></div>
            <div><span class="text-gray-400">PEG Ratio:</span> <strong class="text-gray-900 dark:text-white font-mono">${fmtMultiple(f.pegRatio)}</strong></div>
            <div><span class="text-gray-400">Price to Book (P/B):</span> <strong class="text-gray-900 dark:text-white font-mono">${fmtMultiple(f.priceToBook)}</strong></div>
            <div><span class="text-gray-400">Price to Sales (P/S):</span> <strong class="text-gray-900 dark:text-white font-mono">${fmtMultiple(f.priceToSales)}</strong></div>
            <div><span class="text-gray-400">Enterprise Value:</span> <strong class="text-gray-900 dark:text-white font-mono">${fmtLargeNumber(f.enterpriseValue, f.currency)}</strong></div>
            <div><span class="text-gray-400">EV / EBITDA:</span> <strong class="text-gray-900 dark:text-white font-mono">${fmtMultiple(f.enterpriseToEbitda)}</strong></div>
            <div><span class="text-gray-400">EV / Revenue:</span> <strong class="text-gray-900 dark:text-white font-mono">${fmtMultiple(f.enterpriseToRevenue)}</strong></div>
            <div><span class="text-gray-400">Beta (Volatilità):</span> <strong class="text-gray-900 dark:text-white font-mono">${f.beta ? Number(f.beta).toFixed(2) : '-'}</strong></div>
          </div>
        </div>

        <!-- Section 2: Redditività & Conto Economico -->
        <div class="signature-card p-3 space-y-2 bg-gray-50/70 dark:bg-white/[0.02] border border-gray-200/50 dark:border-white/5">
          <div class="text-xs font-bold text-gray-900 dark:text-white flex items-center justify-between border-b border-gray-200/60 dark:border-white/5 pb-1">
            <span>💰 Redditività, Margini & Dati Finanziari</span>
            <span class="text-[10px] text-gray-400 font-normal">Income & Balance Sheet</span>
          </div>
          <div class="grid grid-cols-2 sm:grid-cols-3 gap-2 text-[11px]">
            <div><span class="text-gray-400">Fatturato Totale:</span> <strong class="text-gray-900 dark:text-white font-mono">${fmtLargeNumber(f.totalRevenue, f.currency)}</strong></div>
            <div><span class="text-gray-400">Utile Netto (Net Income):</span> <strong class="text-gray-900 dark:text-white font-mono">${fmtLargeNumber(f.netIncome, f.currency)}</strong></div>
            <div><span class="text-gray-400">EBITDA:</span> <strong class="text-gray-900 dark:text-white font-mono">${fmtLargeNumber(f.ebitda, f.currency)}</strong></div>
            <div><span class="text-gray-400">Margine Utile Netto:</span> <strong class="text-emerald-600 dark:text-emerald-400 font-mono">${f.profitMargins ? (f.profitMargins * 100).toFixed(2) + '%' : '-'}</strong></div>
            <div><span class="text-gray-400">Margine Operativo:</span> <strong class="text-gray-900 dark:text-white font-mono">${f.operatingMargins ? (f.operatingMargins * 100).toFixed(2) + '%' : '-'}</strong></div>
            <div><span class="text-gray-400">Margine Lordo:</span> <strong class="text-gray-900 dark:text-white font-mono">${f.grossMargins ? (f.grossMargins * 100).toFixed(2) + '%' : '-'}</strong></div>
            <div><span class="text-gray-400">Return on Equity (ROE):</span> <strong class="text-emerald-600 dark:text-emerald-400 font-mono">${f.returnOnEquity ? (f.returnOnEquity * 100).toFixed(2) + '%' : '-'}</strong></div>
            <div><span class="text-gray-400">Return on Assets (ROA):</span> <strong class="text-gray-900 dark:text-white font-mono">${f.returnOnAssets ? (f.returnOnAssets * 100).toFixed(2) + '%' : '-'}</strong></div>
            <div><span class="text-gray-400">Free Cash Flow (FCF):</span> <strong class="text-gray-900 dark:text-white font-mono">${fmtLargeNumber(f.freeCashflow, f.currency)}</strong></div>
            <div><span class="text-gray-400">Cassa Totale:</span> <strong class="text-gray-900 dark:text-white font-mono">${fmtLargeNumber(f.totalCash, f.currency)}</strong></div>
            <div><span class="text-gray-400">Debito Totale:</span> <strong class="text-gray-900 dark:text-white font-mono">${fmtLargeNumber(f.totalDebt, f.currency)}</strong></div>
            <div><span class="text-gray-400">Debt to Equity:</span> <strong class="text-gray-900 dark:text-white font-mono">${f.debtToEquity ? Number(f.debtToEquity).toFixed(1) + '%' : '-'}</strong></div>
          </div>
        </div>

        <!-- Section 3: Target Prezzo & Consenso Analisti -->
        <div class="signature-card p-3 space-y-2 bg-gray-50/70 dark:bg-white/[0.02] border border-gray-200/50 dark:border-white/5">
          <div class="text-xs font-bold text-gray-900 dark:text-white flex items-center justify-between border-b border-gray-200/60 dark:border-white/5 pb-1">
            <span>🎯 Target Price & Opinioni Analisti</span>
            <span class="text-[10px] text-gray-400 font-normal">${f.numberOfAnalystOpinions || 0} analisti censiti</span>
          </div>
          <div class="grid grid-cols-2 sm:grid-cols-4 gap-2 text-[11px]">
            <div><span class="text-gray-400">Prezzo Corrente:</span> <strong class="text-gray-900 dark:text-white font-mono">${fmtPrice(f.currentPrice, f.currency)}</strong></div>
            <div><span class="text-gray-400">Target Medio:</span> <strong class="text-emerald-600 dark:text-emerald-400 font-mono">${fmtPrice(f.targetMeanPrice, f.currency)}</strong></div>
            <div><span class="text-gray-400">Target Minimo:</span> <strong class="text-gray-700 dark:text-gray-300 font-mono">${fmtPrice(f.targetLowPrice, f.currency)}</strong></div>
            <div><span class="text-gray-400">Target Massimo:</span> <strong class="text-emerald-500 font-mono">${fmtPrice(f.targetHighPrice, f.currency)}</strong></div>
          </div>
          ${f.targetMeanPrice && f.currentPrice ? `
            <div class="pt-1 flex items-center space-x-2 text-[11px]">
              <span class="text-gray-400">Potenziale rispetto al Target Medio:</span>
              ${(() => {
                const upside = ((f.targetMeanPrice - f.currentPrice) / f.currentPrice) * 100;
                const cl = upside >= 0 ? 'text-emerald-600 dark:text-emerald-400 font-bold' : 'text-rose-600 font-bold';
                return `<span class="${cl}">${upside >= 0 ? '+' : ''}${upside.toFixed(2)}%</span>`;
              })()}
            </div>
          ` : ''}
        </div>

        <!-- Section 4: Range 52 Settimane & Medie Mobili -->
        <div class="signature-card p-3 space-y-2 bg-gray-50/70 dark:bg-white/[0.02] border border-gray-200/50 dark:border-white/5">
          <div class="text-xs font-bold text-gray-900 dark:text-white flex items-center justify-between border-b border-gray-200/60 dark:border-white/5 pb-1">
            <span>📊 Range 52 Settimane & Medie Mobili</span>
            <span class="text-[10px] text-gray-400 font-normal">Technical Moving Averages</span>
          </div>
          <div class="grid grid-cols-2 sm:grid-cols-4 gap-2 text-[11px]">
            <div><span class="text-gray-400">Min 52W:</span> <strong class="text-gray-700 dark:text-gray-300 font-mono">${fmtPrice(f.fiftyTwoWeekLow, f.currency)}</strong></div>
            <div><span class="text-gray-400">Max 52W:</span> <strong class="text-gray-700 dark:text-gray-300 font-mono">${fmtPrice(f.fiftyTwoWeekHigh, f.currency)}</strong></div>
            <div><span class="text-gray-400">Media Mobile 50D:</span> <strong class="text-gray-700 dark:text-gray-300 font-mono">${fmtPrice(f.fiftyDayAverage, f.currency)}</strong></div>
            <div><span class="text-gray-400">Media Mobile 200D:</span> <strong class="text-gray-700 dark:text-gray-300 font-mono">${fmtPrice(f.twoHundredDayAverage, f.currency)}</strong></div>
          </div>
        </div>

        <!-- Section 5: Profilo Aziendale & Descrizione -->
        ${f.description ? `
          <div class="signature-card p-3 space-y-2 bg-gray-50/70 dark:bg-white/[0.02] border border-gray-200/50 dark:border-white/5">
            <div class="text-xs font-bold text-gray-900 dark:text-white flex items-center justify-between border-b border-gray-200/60 dark:border-white/5 pb-1">
              <span>🏢 Profilo Societario</span>
              ${f.website ? `<a href="${f.website}" target="_blank" rel="noopener noreferrer" class="text-emerald-600 hover:underline text-[10px] font-sans">Sito Web Ufficiale &nearr;</a>` : ''}
            </div>
            <p class="text-[11px] text-gray-600 dark:text-gray-300 font-sans leading-relaxed">
              ${f.description}
            </p>
            <div class="flex flex-wrap items-center gap-3 pt-1 text-[10px] text-gray-400 font-mono">
              ${f.employees ? `<span>Dipendenti: <strong class="text-gray-700 dark:text-gray-300">${f.employees.toLocaleString('it-IT')}</strong></span>` : ''}
              ${f.city ? `<span>Sede: <strong class="text-gray-700 dark:text-gray-300">${f.city}, ${f.country}</strong></span>` : ''}
            </div>
          </div>
        ` : ''}
      `;

    } catch (err) {
      console.error('[Fundamentals Dialog Error]', err);
      modalBody.innerHTML = `
        <div class="py-8 text-center text-rose-500 font-mono">
          Errore durante il caricamento dei dati: ${err.message}
        </div>
      `;
    }
  }

  // Open Edit Targets Modal
  function openEditTargetsModal(ticker) {
    const modal = document.getElementById('editTargetsModal');
    if (!modal) return;

    currentTargetTicker = ticker;
    const asset = allAssets.find(x => x.ticker === ticker);

    const tickerEl = document.getElementById('targetModalTicker');
    const priceEl = document.getElementById('targetModalPrice');
    const slInput = document.getElementById('editSlInput');
    const tpInput = document.getElementById('editTpInput');
    const notesInput = document.getElementById('editNotesInput');

    if (tickerEl) tickerEl.textContent = ticker;
    if (priceEl) priceEl.textContent = asset ? fmtPrice(asset.currentPrice, asset.currency) : '--';
    if (slInput) slInput.value = asset && asset.stopLoss !== null ? asset.stopLoss : '';
    if (tpInput) tpInput.value = asset && asset.takeProfit !== null ? asset.takeProfit : '';
    if (notesInput) notesInput.value = asset && asset.notes ? asset.notes : '';

    modal.showModal();
  }

  // Remove Watchlist Asset
  async function removeWatchlistAsset(ticker) {
    if (!confirm(`Rimuovere ${ticker} dai titoli monitorati?`)) return;

    try {
      const res = await fetch(`/api/analysis/watchlist/${encodeURIComponent(ticker)}`, {
        method: 'DELETE'
      });
      const data = await res.json();
      if (data.success) {
        await loadAnalysisData();
      } else {
        alert('Errore rimozione: ' + (data.error || 'Operazione fallita'));
      }
    } catch (err) {
      alert('Errore di connessione: ' + err.message);
    }
  }

  // Setup event listeners
  document.addEventListener('DOMContentLoaded', () => {
    loadAnalysisData();

    // Refresh buttons
    document.getElementById('refreshQuotesBtn')?.addEventListener('click', loadAnalysisData);
    document.getElementById('mRefreshBtn')?.addEventListener('click', loadAnalysisData);

    // Open Add Asset Modal
    const openAddBtn = document.getElementById('openAddAssetBtn') || document.getElementById('mOpenAddAssetBtn');
    if (openAddBtn) {
      openAddBtn.addEventListener('click', () => {
        const addModal = document.getElementById('addAssetModal');
        if (addModal) {
          document.getElementById('addAssetForm')?.reset();
          addModal.showModal();
        }
      });
    }

    // Submit Add Asset Form
    const addForm = document.getElementById('addAssetForm');
    if (addForm) {
      addForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const ticker = document.getElementById('addTickerInput')?.value.trim().toUpperCase();
        const name = document.getElementById('addNameInput')?.value.trim();
        const stopLoss = document.getElementById('addSlInput')?.value;
        const takeProfit = document.getElementById('addTpInput')?.value;
        const notes = document.getElementById('addNotesInput')?.value.trim();

        if (!ticker) return;

        const btn = document.getElementById('addAssetSubmitBtn');
        if (btn) btn.disabled = true;

        try {
          const res = await fetch('/api/analysis/watchlist', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ticker, name, stopLoss, takeProfit, notes })
          });
          const data = await res.json();

          if (data.success) {
            document.getElementById('addAssetModal')?.close();
            await loadAnalysisData();
          } else {
            alert('Errore: ' + (data.error || 'Impossibile aggiungere il titolo'));
          }
        } catch (err) {
          alert('Errore di rete: ' + err.message);
        } finally {
          if (btn) btn.disabled = false;
        }
      });
    }

    // Submit Edit Targets Form
    const editForm = document.getElementById('editTargetsForm');
    if (editForm) {
      editForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        if (!currentTargetTicker) return;

        const stopLoss = document.getElementById('editSlInput')?.value;
        const takeProfit = document.getElementById('editTpInput')?.value;
        const notes = document.getElementById('editNotesInput')?.value.trim();

        try {
          const res = await fetch(`/api/analysis/${encodeURIComponent(currentTargetTicker)}/targets`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ stopLoss, takeProfit, notes })
          });
          const data = await res.json();

          if (data.success) {
            document.getElementById('editTargetsModal')?.close();
            await loadAnalysisData();
          } else {
            alert('Errore aggiornamento: ' + (data.error || 'Operazione fallita'));
          }
        } catch (err) {
          alert('Errore di rete: ' + err.message);
        }
      });
    }

    // Filter Buttons (Desktop)
    document.querySelectorAll('.analysis-filter-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        activeFilter = btn.getAttribute('data-filter') || 'all';
        document.querySelectorAll('.analysis-filter-btn').forEach(b => {
          if (b === btn) {
            b.className = 'analysis-filter-btn px-2.5 py-1 rounded-lg bg-emerald-600 text-white font-semibold text-[11px] transition';
          } else {
            b.className = 'analysis-filter-btn px-2.5 py-1 rounded-lg bg-gray-200/70 dark:bg-white/5 hover:bg-gray-300 dark:hover:bg-white/10 text-gray-700 dark:text-gray-300 font-semibold text-[11px] transition';
          }
        });
        renderDesktopTable();
      });
    });

    // Filter Buttons (Mobile)
    document.querySelectorAll('.m-filter-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        activeFilter = btn.getAttribute('data-m-filter') || 'all';
        document.querySelectorAll('.m-filter-btn').forEach(b => {
          if (b === btn) {
            b.className = 'm-filter-btn px-2 py-0.5 rounded text-[10px] font-bold bg-emerald-600 text-white';
          } else {
            b.className = 'm-filter-btn px-2 py-0.5 rounded text-[10px] font-bold bg-gray-200 dark:bg-white/10 text-gray-700 dark:text-gray-300';
          }
        });
        renderMobileList();
      });
    });

    // Search Input (Desktop)
    const searchInput = document.getElementById('searchInput');
    const clearSearchBtn = document.getElementById('clearSearchBtn');
    if (searchInput) {
      searchInput.addEventListener('input', () => {
        searchQuery = searchInput.value.trim();
        if (clearSearchBtn) clearSearchBtn.classList.toggle('hidden', !searchQuery);
        renderDesktopTable();
      });
    }
    if (clearSearchBtn) {
      clearSearchBtn.addEventListener('click', () => {
        searchInput.value = '';
        searchQuery = '';
        clearSearchBtn.classList.add('hidden');
        renderDesktopTable();
      });
    }

    // Search Input (Mobile)
    const mSearchInput = document.getElementById('mSearchInput');
    if (mSearchInput) {
      mSearchInput.addEventListener('input', () => {
        searchQuery = mSearchInput.value.trim();
        renderMobileList();
      });
    }

    // Light-dismiss support for native dialogs when clicking on the backdrop
    document.querySelectorAll('dialog').forEach(diag => {
      diag.addEventListener('click', (e) => {
        const rect = diag.getBoundingClientRect();
        const isInDialog = (
          rect.top <= e.clientY && e.clientY <= rect.top + rect.height &&
          rect.left <= e.clientX && e.clientX <= rect.left + rect.width
        );
        if (!isInDialog) {
          diag.close();
        }
      });
    });
  });

})();
