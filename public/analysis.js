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
  let currentFundamentalsTicker = null;
  let currentModalRange = '1Y';
  let activeRevenueChart = null;
  let activePEChart = null;
  let activePriceChart = null;

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

  /**
   * Evaluates the health/quality of fundamental indicators.
   * Conforms to Modern Web Guidance on color accessibility:
   * never relies solely on color; includes text labels and status icons with high contrast.
   */
  function scoreIndicator(type, val, extra = {}) {
    if (val === null || val === undefined || isNaN(Number(val))) {
      return {
        score: 'none',
        label: 'N/D',
        icon: '•',
        bgClass: 'bg-gray-100 dark:bg-white/5 border-gray-200 dark:border-white/10',
        textClass: 'text-gray-500 dark:text-gray-400'
      };
    }
    const n = Number(val);

    switch (type) {
      case 'peg': {
        // PEG Ratio: < 1.0 (Undervalued vs growth), 1.0-1.5 (Fair), > 1.5 (Overvalued), <= 0 (Negative growth)
        if (n <= 0) {
          return { score: 'bad', label: 'Crescita Negativa', icon: '⚠', bgClass: 'bg-rose-50 dark:bg-rose-950/40 border-rose-500/30', textClass: 'text-rose-700 dark:text-rose-300' };
        } else if (n < 1.0) {
          return { score: 'good', label: 'Sottovalutato vs Crescita (< 1.0)', icon: '✓', bgClass: 'bg-emerald-50 dark:bg-emerald-950/40 border-emerald-500/30', textClass: 'text-emerald-700 dark:text-emerald-300' };
        } else if (n <= 1.5) {
          return { score: 'neutral', label: 'Valutazione Equilibrata (1.0-1.5)', icon: '•', bgClass: 'bg-amber-50 dark:bg-amber-950/40 border-amber-500/30', textClass: 'text-amber-700 dark:text-amber-300' };
        } else {
          return { score: 'bad', label: 'Sopravvalutato vs Crescita (> 1.5)', icon: '▲', bgClass: 'bg-rose-50 dark:bg-rose-950/40 border-rose-500/30', textClass: 'text-rose-700 dark:text-rose-300' };
        }
      }
      case 'pe': {
        // P/E Ratio: <= 18 (Low/Attractive), 18-28 (Moderate/Fair), > 28 (High), <= 0 (Loss)
        if (n <= 0) {
          return { score: 'bad', label: 'In Perdita (EPS < 0)', icon: '⚠', bgClass: 'bg-rose-50 dark:bg-rose-950/40 border-rose-500/30', textClass: 'text-rose-700 dark:text-rose-300' };
        } else if (n <= 18) {
          return { score: 'good', label: 'Conveniente (≤ 18x)', icon: '✓', bgClass: 'bg-emerald-50 dark:bg-emerald-950/40 border-emerald-500/30', textClass: 'text-emerald-700 dark:text-emerald-300' };
        } else if (n <= 28) {
          return { score: 'neutral', label: 'Equilibrato (18-28x)', icon: '•', bgClass: 'bg-amber-50 dark:bg-amber-950/40 border-amber-500/30', textClass: 'text-amber-700 dark:text-amber-300' };
        } else {
          return { score: 'bad', label: 'Multiplo Elevato (> 28x)', icon: '▲', bgClass: 'bg-rose-50 dark:bg-rose-950/40 border-rose-500/30', textClass: 'text-rose-700 dark:text-rose-300' };
        }
      }
      case 'pb': {
        // Price to Book: <= 1.5 (Low), 1.5-3.5 (Normal), > 3.5 (High)
        if (n <= 0) {
          return { score: 'bad', label: 'Patrimonio Negativo', icon: '⚠', bgClass: 'bg-rose-50 dark:bg-rose-950/40 border-rose-500/30', textClass: 'text-rose-700 dark:text-rose-300' };
        } else if (n <= 1.5) {
          return { score: 'good', label: 'Basso Multiplo Contabile (≤ 1.5x)', icon: '✓', bgClass: 'bg-emerald-50 dark:bg-emerald-950/40 border-emerald-500/30', textClass: 'text-emerald-700 dark:text-emerald-300' };
        } else if (n <= 3.5) {
          return { score: 'neutral', label: 'Moderato (1.5-3.5x)', icon: '•', bgClass: 'bg-amber-50 dark:bg-amber-950/40 border-amber-500/30', textClass: 'text-amber-700 dark:text-amber-300' };
        } else {
          return { score: 'bad', label: 'Elevato (> 3.5x)', icon: '▲', bgClass: 'bg-rose-50 dark:bg-rose-950/40 border-rose-500/30', textClass: 'text-rose-700 dark:text-rose-300' };
        }
      }
      case 'ps': {
        // Price to Sales: <= 2.0 (Good), 2-5 (Neutral), > 5 (High)
        if (n <= 0) {
          return { score: 'neutral', label: 'N/D', icon: '•', bgClass: 'bg-gray-100 dark:bg-white/5 border-gray-200 dark:border-white/10', textClass: 'text-gray-500' };
        } else if (n <= 2.0) {
          return { score: 'good', label: 'Conveniente vs Fatturato (≤ 2x)', icon: '✓', bgClass: 'bg-emerald-50 dark:bg-emerald-950/40 border-emerald-500/30', textClass: 'text-emerald-700 dark:text-emerald-300' };
        } else if (n <= 5.0) {
          return { score: 'neutral', label: 'Allineato (2-5x)', icon: '•', bgClass: 'bg-amber-50 dark:bg-amber-950/40 border-amber-500/30', textClass: 'text-amber-700 dark:text-amber-300' };
        } else {
          return { score: 'bad', label: 'Elevato (> 5x)', icon: '▲', bgClass: 'bg-rose-50 dark:bg-rose-950/40 border-rose-500/30', textClass: 'text-rose-700 dark:text-rose-300' };
        }
      }
      case 'evEbitda': {
        // EV/EBITDA: <= 10 (Good), 10-16 (Neutral), > 16 (High)
        if (n <= 0) {
          return { score: 'bad', label: 'EBITDA Negativo', icon: '⚠', bgClass: 'bg-rose-50 dark:bg-rose-950/40 border-rose-500/30', textClass: 'text-rose-700 dark:text-rose-300' };
        } else if (n <= 10.0) {
          return { score: 'good', label: 'Basso Multiplo Operativo (≤ 10x)', icon: '✓', bgClass: 'bg-emerald-50 dark:bg-emerald-950/40 border-emerald-500/30', textClass: 'text-emerald-700 dark:text-emerald-300' };
        } else if (n <= 16.0) {
          return { score: 'neutral', label: 'Allineato (10-16x)', icon: '•', bgClass: 'bg-amber-50 dark:bg-amber-950/40 border-amber-500/30', textClass: 'text-amber-700 dark:text-amber-300' };
        } else {
          return { score: 'bad', label: 'Elevato (> 16x)', icon: '▲', bgClass: 'bg-rose-50 dark:bg-rose-950/40 border-rose-500/30', textClass: 'text-rose-700 dark:text-rose-300' };
        }
      }
      case 'margin': {
        // Margins: >= 15% (Good), 5-15% (Neutral), < 5% (Bad)
        if (n >= 0.15) {
          return { score: 'good', label: 'Elevata Marginalità (≥ 15%)', icon: '✓', bgClass: 'bg-emerald-50 dark:bg-emerald-950/40 border-emerald-500/30', textClass: 'text-emerald-700 dark:text-emerald-300' };
        } else if (n >= 0.05) {
          return { score: 'neutral', label: 'Margine Moderato (5-15%)', icon: '•', bgClass: 'bg-amber-50 dark:bg-amber-950/40 border-amber-500/30', textClass: 'text-amber-700 dark:text-amber-300' };
        } else {
          return { score: 'bad', label: 'Margine Ridotto / Negativo', icon: '▼', bgClass: 'bg-rose-50 dark:bg-rose-950/40 border-rose-500/30', textClass: 'text-rose-700 dark:text-rose-300' };
        }
      }
      case 'roe': {
        // ROE: >= 15% (Good), 8-15% (Neutral), < 8% (Bad)
        if (n >= 0.15) {
          return { score: 'good', label: 'Forte Resa Capitale (≥ 15%)', icon: '✓', bgClass: 'bg-emerald-50 dark:bg-emerald-950/40 border-emerald-500/30', textClass: 'text-emerald-700 dark:text-emerald-300' };
        } else if (n >= 0.08) {
          return { score: 'neutral', label: 'Resa Discreta (8-15%)', icon: '•', bgClass: 'bg-amber-50 dark:bg-amber-950/40 border-amber-500/30', textClass: 'text-amber-700 dark:text-amber-300' };
        } else {
          return { score: 'bad', label: 'Resa Bassa (< 8%)', icon: '▼', bgClass: 'bg-rose-50 dark:bg-rose-950/40 border-rose-500/30', textClass: 'text-rose-700 dark:text-rose-300' };
        }
      }
      case 'roa': {
        // ROA: >= 7% (Good), 3-7% (Neutral), < 3% (Bad)
        if (n >= 0.07) {
          return { score: 'good', label: 'Alta Efficienza Asset (≥ 7%)', icon: '✓', bgClass: 'bg-emerald-50 dark:bg-emerald-950/40 border-emerald-500/30', textClass: 'text-emerald-700 dark:text-emerald-300' };
        } else if (n >= 0.03) {
          return { score: 'neutral', label: 'Efficienza Media (3-7%)', icon: '•', bgClass: 'bg-amber-50 dark:bg-amber-950/40 border-amber-500/30', textClass: 'text-amber-700 dark:text-amber-300' };
        } else {
          return { score: 'bad', label: 'Bassa Efficienza (< 3%)', icon: '▼', bgClass: 'bg-rose-50 dark:bg-rose-950/40 border-rose-500/30', textClass: 'text-rose-700 dark:text-rose-300' };
        }
      }
      case 'cashDebt': {
        const cash = Number(extra.cash || 0);
        const debt = Number(extra.debt || 0);
        if (cash >= debt) {
          return { score: 'good', label: 'Cassa Netta Positiva (Cash Rich)', icon: '✓', bgClass: 'bg-emerald-50 dark:bg-emerald-950/40 border-emerald-500/30', textClass: 'text-emerald-700 dark:text-emerald-300' };
        } else {
          const ratio = cash > 0 ? (debt / cash).toFixed(1) + 'x' : 'Alto';
          return { score: 'neutral', label: `Debito Netto (${ratio} della cassa)`, icon: '•', bgClass: 'bg-amber-50 dark:bg-amber-950/40 border-amber-500/30', textClass: 'text-amber-700 dark:text-amber-300' };
        }
      }
      case 'dividend': {
        if (n >= 3.0) {
          return { score: 'good', label: 'Cedola Generosa (≥ 3%)', icon: '✓', bgClass: 'bg-emerald-50 dark:bg-emerald-950/40 border-emerald-500/30', textClass: 'text-emerald-700 dark:text-emerald-300' };
        } else if (n >= 1.5) {
          return { score: 'neutral', label: 'Cedola Media (1.5-3%)', icon: '•', bgClass: 'bg-amber-50 dark:bg-amber-950/40 border-amber-500/30', textClass: 'text-amber-700 dark:text-amber-300' };
        } else {
          return { score: 'none', label: 'Cedola Bassa o Assente', icon: '•', bgClass: 'bg-gray-100 dark:bg-white/5 border-gray-200 dark:border-white/10', textClass: 'text-gray-500' };
        }
      }
      default:
        return { score: 'none', label: '', icon: '', bgClass: '', textClass: '' };
    }
  }

  function renderScoredMetric(label, valueFormatted, scoreObj, tooltip = '') {
    let badgeHtml = '';
    if (scoreObj && scoreObj.label && scoreObj.label !== 'N/D') {
      badgeHtml = `
        <span class="inline-flex items-center px-1.5 py-0.2 rounded text-[9px] font-semibold border ${scoreObj.bgClass} ${scoreObj.textClass}" title="${scoreObj.label}">
          <span class="mr-0.5 text-[8px]" aria-hidden="true">${scoreObj.icon}</span>
          <span>${scoreObj.label}</span>
        </span>
      `;
    }

    return `
      <div class="p-2 rounded-lg bg-white/70 dark:bg-white/[0.02] border border-gray-100 dark:border-white/5 flex flex-col justify-between" ${tooltip ? `title="${tooltip}"` : ''}>
        <span class="text-gray-400 text-[10px] block truncate">${label}</span>
        <div class="mt-1 flex items-baseline justify-between flex-wrap gap-1">
          <strong class="text-gray-900 dark:text-white font-mono text-xs tabular-nums">${valueFormatted}</strong>
          ${badgeHtml}
        </div>
      </div>
    `;
  }

  function renderPegTableBadge(val) {
    if (val === null || val === undefined || isNaN(Number(val))) {
      return '<span class="text-gray-400 font-mono text-[11px]">-</span>';
    }
    const score = scoreIndicator('peg', val);
    return `
      <span class="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-bold font-mono border ${score.bgClass} ${score.textClass}" title="PEG Ratio: ${Number(val).toFixed(2)} (${score.label})">
        <span class="mr-0.5 text-[8px]" aria-hidden="true">${score.icon}</span>${Number(val).toFixed(2)}x
      </span>
    `;
  }

  function renderEyeIcon(isMonitored, ticker) {
    const active = Boolean(isMonitored);
    const title = active
      ? `Monitoraggio notifiche ATTIVO per ${ticker} (fai clic per disabilitare)`
      : `Monitoraggio notifiche DISABILITATO per ${ticker} (fai clic per abilitare)`;
    const btnClass = active
      ? 'text-emerald-600 dark:text-emerald-400 hover:text-emerald-700 bg-emerald-50/90 dark:bg-emerald-950/60 hover:bg-emerald-100 dark:hover:bg-emerald-900/60 border border-emerald-500/30 shadow-2xs'
      : 'text-rose-500 dark:text-rose-400 hover:text-rose-600 bg-rose-50/80 dark:bg-rose-950/50 hover:bg-rose-100 dark:hover:bg-rose-900/60 border border-rose-500/30 shadow-2xs';

    const eyeOpenSvg = `
      <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
        <path stroke-linecap="round" stroke-linejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
        <path stroke-linecap="round" stroke-linejoin="round" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
      </svg>
    `;

    const eyeOffSvg = `
      <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
        <path stroke-linecap="round" stroke-linejoin="round" d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l18 18" />
      </svg>
    `;

    return `
      <button type="button" data-action="toggle-monitor" data-ticker="${ticker}" title="${title}" aria-label="${title}" onclick="event.stopPropagation()" class="p-1 rounded-md transition cursor-pointer inline-flex items-center justify-center ${btnClass} flex-shrink-0">
        ${active ? eyeOpenSvg : eyeOffSvg}
      </button>
    `;
  }

  function renderOriginBadge(origin) {
    const o = (origin || 'WATCHLIST').toUpperCase();
    if (o === 'OPEN') {
      return '<span class="inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-bold bg-blue-100 text-blue-800 dark:bg-blue-950/60 dark:text-blue-300 border border-blue-500/20" title="Posizione aperta in portafoglio">OPEN</span>';
    } else if (o === 'CLOSE') {
      return '<span class="inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-bold bg-slate-200 text-slate-800 dark:bg-slate-800 dark:text-slate-300 border border-slate-400/20" title="Posizione chiusa in portafoglio (operazioni chiuse)">CLOSE</span>';
    }
    return '<span class="inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-bold bg-purple-100 text-purple-800 dark:bg-purple-950/60 dark:text-purple-300 border border-purple-500/20" title="Titolo in watchlist (mai trattato)">WATCHLIST</span>';
  }

  function renderOriginBadgeMobile(origin) {
    const o = (origin || 'WATCHLIST').toUpperCase();
    if (o === 'OPEN') {
      return '<span class="px-1 py-0.2 rounded text-[8px] font-bold bg-blue-100 text-blue-800 dark:bg-blue-950/60 dark:text-blue-300 border border-blue-500/20" title="Posizione aperta">OPEN</span>';
    } else if (o === 'CLOSE') {
      return '<span class="px-1 py-0.2 rounded text-[8px] font-bold bg-slate-200 text-slate-800 dark:bg-slate-800 dark:text-slate-300 border border-slate-400/20" title="Posizione chiusa">CLOSE</span>';
    }
    return '<span class="px-1 py-0.2 rounded text-[8px] font-bold bg-purple-100 text-purple-800 dark:bg-purple-950/60 dark:text-purple-300 border border-purple-500/20" title="Watchlist">WATCHLIST</span>';
  }

  async function toggleAssetMonitoring(ticker) {
    if (!ticker) return;
    const cleanTicker = ticker.toUpperCase();
    const asset = allAssets.find(x => x.ticker.toUpperCase() === cleanTicker);
    if (!asset) return;

    const previousState = Boolean(asset.isMonitored);
    const newState = !previousState;

    // Optimistic UI update
    asset.isMonitored = newState;
    renderDesktopTable();
    renderMobileList();

    try {
      const res = await fetch(`/api/analysis/${encodeURIComponent(cleanTicker)}/monitoring`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isMonitored: newState })
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || 'Errore durante l\'aggiornamento del monitoraggio.');
      }

      asset.isMonitored = Boolean(data.isMonitored);
      renderDesktopTable();
      renderMobileList();

      if (typeof window.showToast === 'function') {
        window.showToast(data.message || (newState ? `Notifiche attivate per ${cleanTicker}` : `Notifiche disattivate per ${cleanTicker}`));
      }
    } catch (err) {
      console.error('[Toggle Monitoring Error]', err);
      // Revert optimistic update
      asset.isMonitored = previousState;
      renderDesktopTable();
      renderMobileList();
      alert(`Impossibile modificare il monitoraggio notifiche per ${cleanTicker}: ${err.message}`);
    }
  }

  // Filter items
  function getFilteredAssets() {
    return allAssets.filter(item => {
      // 1. Tab filter
      if (activeFilter === 'open' || activeFilter === 'portfolio') {
        if (item.origin !== 'OPEN') return false;
      } else if (activeFilter === 'close') {
        if (item.origin !== 'CLOSE') return false;
      } else if (activeFilter === 'watchlist' || activeFilter === 'monitored') {
        if (item.origin !== 'WATCHLIST') return false;
      } else if (activeFilter === 'alerts') {
        if (item.slStatus === 'NORMAL' && item.tpStatus === 'NORMAL') return false;
      }

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

      const openCount = stats.openCount !== undefined ? stats.openCount : allAssets.filter(x => x.origin === 'OPEN').length;
      const closeCount = stats.closeCount !== undefined ? stats.closeCount : allAssets.filter(x => x.origin === 'CLOSE').length;
      const watchlistCount = stats.watchlistCount !== undefined ? stats.watchlistCount : allAssets.filter(x => x.origin === 'WATCHLIST').length;

      // Update KPI counters (Desktop)
      const kpiTotal = document.getElementById('kpiTotalAssets');
      const kpiPortCount = document.getElementById('kpiPortfolioCount');
      const kpiGainers = document.getElementById('kpiGainers');
      const kpiSlAlerts = document.getElementById('kpiSlAlerts');
      const kpiTpReached = document.getElementById('kpiTpReached');

      if (kpiTotal) kpiTotal.textContent = stats.totalEquities || allAssets.length;
      if (kpiPortCount) kpiPortCount.textContent = `${openCount} open, ${closeCount} close`;
      if (kpiGainers) kpiGainers.textContent = `${stats.gainers1mCount || 0} (1M) / ${stats.gainers1yCount || 0} (1Y)`;
      if (kpiSlAlerts) kpiSlAlerts.textContent = stats.slTriggeredCount || 0;
      if (kpiTpReached) kpiTpReached.textContent = stats.tpReachedCount || 0;

      // Update badge counts in filter buttons
      const countAll = document.getElementById('countAll') || document.getElementById('mCountAll');
      const mTotalCount = document.getElementById('mTotalCount');

      if (countAll) countAll.textContent = allAssets.length;
      if (document.getElementById('countOpen')) document.getElementById('countOpen').textContent = openCount;
      if (document.getElementById('mCountOpen')) document.getElementById('mCountOpen').textContent = openCount;
      if (document.getElementById('countPortfolio')) document.getElementById('countPortfolio').textContent = openCount;
      if (document.getElementById('mCountPortfolio')) document.getElementById('mCountPortfolio').textContent = openCount;
      if (document.getElementById('countClose')) document.getElementById('countClose').textContent = closeCount;
      if (document.getElementById('mCountClose')) document.getElementById('mCountClose').textContent = closeCount;
      if (document.getElementById('countWatchlist')) document.getElementById('countWatchlist').textContent = watchlistCount;
      if (document.getElementById('mCountWatchlist')) document.getElementById('mCountWatchlist').textContent = watchlistCount;

      const alertCount = allAssets.filter(x => x.slStatus !== 'NORMAL' || x.tpStatus !== 'NORMAL').length;
      if (document.getElementById('countAlerts')) document.getElementById('countAlerts').textContent = alertCount;
      if (document.getElementById('mCountAlerts')) document.getElementById('mCountAlerts').textContent = alertCount;
      if (mTotalCount) mTotalCount.textContent = `${allAssets.length} titoli (${openCount} open, ${closeCount} close)`;

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
          <td colspan="13" class="px-6 py-10 text-center text-gray-400 font-mono text-xs">
            Nessun titolo azionario trovato per i filtri selezionati.
          </td>
        </tr>
      `;
      return;
    }

    tbody.innerHTML = items.map(a => {
      const vars = a.variations || {};
      const cur = a.currency || 'EUR';

      // Origin badge (OPEN / CLOSE / WATCHLIST)
      const originBadge = renderOriginBadge(a.origin);

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
          tpHtml = `<span class="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-bold bg-emerald-600 text-white" title="Target raggiunto o superato">🎯 TP: ${fmtPrice(a.takeProfit, cur)}</span>`;
        } else if (a.tpStatus === 'NEAR') {
          tpHtml = `<span class="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-bold bg-emerald-500/80 text-white" title="Prezzo vicino al Take Profit">🎯 TP: ${fmtPrice(a.takeProfit, cur)}</span>`;
        } else {
          tpHtml = `<span class="font-mono text-xs text-gray-700 dark:text-gray-300">${fmtPrice(a.takeProfit, cur)}</span>`;
        }
      }

      // PEG Ratio rendering (Highlighted)
      const pegHtml = renderPegTableBadge(a.pegRatio);

      return `
        <tr data-ticker="${a.ticker}" class="hover:bg-gray-50/80 dark:hover:bg-white/5 transition group cursor-pointer ${!a.isMonitored ? 'opacity-80' : ''}">
          <td class="px-2.5 py-1.5 whitespace-nowrap">
            <div class="flex items-center space-x-2">
              <span class="font-bold text-xs text-gray-900 dark:text-white font-mono group-hover:text-emerald-600 dark:group-hover:text-emerald-400 transition-colors">${a.ticker}</span>
              <span class="text-gray-400 text-[11px] truncate max-w-[150px] font-sans" title="${a.name}">${a.name}</span>
              ${!a.isMonitored ? '<span class="text-[8px] font-mono px-1 py-0.2 rounded bg-gray-100 dark:bg-white/10 text-gray-400 font-bold uppercase" title="Notifiche disabilitate per questo asset">OFF</span>' : ''}
            </div>
          </td>
          <td class="px-2 py-1.5 whitespace-nowrap text-center" onclick="event.stopPropagation()">
            ${renderEyeIcon(a.isMonitored, a.ticker)}
          </td>
          <td class="px-2.5 py-1.5 whitespace-nowrap">${originBadge}</td>
          <td class="px-2.5 py-1.5 whitespace-nowrap text-right font-bold text-xs text-gray-900 dark:text-white font-mono">
            <div>${fmtPrice(a.currentPrice, cur)}</div>
            ${(a.preMarketPrice && Number(a.preMarketPrice) > 0) ? `
              <div class="text-[9px] font-bold text-amber-600 dark:text-amber-400 flex items-center justify-end space-x-1 mt-0.5" title="Pre-Market Live: ${fmtPrice(a.preMarketPrice, cur)}">
                <span class="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse"></span>
                <span>PRE: ${fmtPrice(a.preMarketPrice, cur)}</span>
              </div>
            ` : ''}
          </td>
          <td class="px-2 py-1.5 whitespace-nowrap text-right">${renderVariationBadge(vars['1W'])}</td>
          <td class="px-2 py-1.5 whitespace-nowrap text-right">${renderVariationBadge(vars['1M'])}</td>
          <td class="px-2 py-1.5 whitespace-nowrap text-right">${renderVariationBadge(vars['3M'])}</td>
          <td class="px-2 py-1.5 whitespace-nowrap text-right">${renderVariationBadge(vars['1Y'])}</td>
          <td class="px-2 py-1.5 whitespace-nowrap text-right">${renderVariationBadge(vars['3Y'])}</td>
          <td class="px-2 py-1.5 whitespace-nowrap text-right font-mono">${pegHtml}</td>
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
              ${a.origin === 'WATCHLIST' ? `
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
        if (action === 'toggle-monitor') toggleAssetMonitoring(ticker);
        else if (action === 'fundamentals') openFundamentalsModal(ticker);
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

      const originBadge = renderOriginBadgeMobile(a.origin);

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
        <div data-ticker="${a.ticker}" class="signature-card p-2 flex flex-col justify-between gap-1 hover:bg-gray-50/50 dark:hover:bg-white/[0.02] transition cursor-pointer ${!a.isMonitored ? 'opacity-80' : ''}">
          <!-- Line 1: Eye + Ticker + Badge + Name (Left) | Price (Right) -->
          <div class="flex items-center justify-between min-w-0">
            <div class="flex items-center space-x-1.5 min-w-0 overflow-hidden">
              ${renderEyeIcon(a.isMonitored, a.ticker)}
              <span class="font-bold text-xs font-mono text-gray-900 dark:text-white">${a.ticker}</span>
              ${originBadge}
              <span class="text-[10px] text-gray-400 truncate max-w-[120px] font-sans">${a.name}</span>
              ${!a.isMonitored ? '<span class="text-[8px] font-mono px-1 py-0.2 rounded bg-gray-100 dark:bg-white/10 text-gray-400 font-bold uppercase" title="Notifiche disabilitate">OFF</span>' : ''}
            </div>
            <div class="flex items-center space-x-1 tabular-nums flex-shrink-0 ml-1">
              ${a.pegRatio !== null && a.pegRatio !== undefined ? renderPegTableBadge(a.pegRatio) : ''}
              <div class="text-right">
                <span class="font-bold font-mono text-xs text-gray-900 dark:text-white">${fmtPrice(a.currentPrice, cur)}</span>
                ${(a.preMarketPrice && Number(a.preMarketPrice) > 0) ? `
                  <div class="text-[8px] font-bold text-amber-600 dark:text-amber-400 flex items-center justify-end space-x-0.5">
                    <span class="w-1 h-1 rounded-full bg-amber-500 animate-pulse"></span>
                    <span>PRE: ${fmtPrice(a.preMarketPrice, cur)}</span>
                  </div>
                ` : ''}
              </div>
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
              <button data-action="targets" data-ticker="${a.ticker}" title="Imposta / Modifica SL e TP" class="p-0.5 text-gray-400 hover:text-emerald-500">
                <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
                </svg>
              </button>
              <button data-action="fundamentals" data-ticker="${a.ticker}" title="Analisi Fondamentale" class="text-[10px] text-blue-500 font-bold px-1 py-0.2 rounded hover:bg-blue-50 dark:hover:bg-white/5">
                Analisi &rarr;
              </button>
              ${a.origin === 'WATCHLIST' ? `
                <button data-action="delete" data-ticker="${a.ticker}" title="Rimuovi da watchlist" class="p-0.5 text-rose-500 hover:text-rose-600">
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
        if (action === 'toggle-monitor') toggleAssetMonitoring(ticker);
        else if (action === 'fundamentals') openFundamentalsModal(ticker);
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
      currentFundamentalsTicker = ticker;
      const assetInfo = allAssets.find(a => a.ticker.toUpperCase() === ticker.toUpperCase()) || {};
      const currentPrice = assetInfo.currentPrice || f.currentPrice || 0;
      const prevClose = assetInfo.previousClose || f.previousClose || currentPrice;
      const currency = assetInfo.currency || f.currency || 'EUR';
      const dayChangePct = prevClose > 0 ? ((currentPrice - prevClose) / prevClose) * 100 : 0;

      modalTitle.textContent = f.companyName || assetInfo.name || ticker;
      modalBadge.textContent = ticker.slice(0, 2).toUpperCase();

      let originBadgeHtml = '';
      if (assetInfo.origin === 'OPEN') {
        originBadgeHtml = `<span class="px-2 py-0.5 rounded-full text-[10px] font-bold font-mono bg-emerald-100 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300 border border-emerald-500/30">IN PORTAFOGLIO (${assetInfo.netQuantity ? Math.round(assetInfo.netQuantity) : '1+'} quote)</span>`;
      } else if (assetInfo.origin === 'CLOSE') {
        originBadgeHtml = `<span class="px-2 py-0.5 rounded-full text-[10px] font-bold font-mono bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300 border border-amber-500/30">POSIZIONE CHIUSA (STORICO)</span>`;
      } else {
        originBadgeHtml = `<span class="px-2 py-0.5 rounded-full text-[10px] font-bold font-mono bg-blue-100 text-blue-800 dark:bg-blue-950/60 dark:text-blue-300 border border-blue-500/30">WATCHLIST</span>`;
      }

      modalSubtitle.innerHTML = `
        <span>${f.sector || 'N/D'}</span>
        <span>•</span>
        <span>${f.industry || 'N/D'}</span>
        ${f.country ? `<span>•</span><span>${f.country}</span>` : ''}
        <span>•</span>
        ${originBadgeHtml}
      `;

      if (modalSource) {
        modalSource.textContent = `Fonte: Yahoo Finance API (${data.source === 'CACHE' ? 'Cache' : 'Dati Live'})`;
      }

      // Scores for indicators
      const pegScore = scoreIndicator('peg', f.pegRatio);
      const peScore = scoreIndicator('pe', f.trailingPE);
      const fwdPeScore = scoreIndicator('pe', f.forwardPE);
      const pbScore = scoreIndicator('pb', f.priceToBook);
      const psScore = scoreIndicator('ps', f.priceToSales);
      const evEbitdaScore = scoreIndicator('evEbitda', f.enterpriseToEbitda);
      const profitMarginScore = scoreIndicator('margin', f.profitMargins);
      const opMarginScore = scoreIndicator('margin', f.operatingMargins);
      const roeScore = scoreIndicator('roe', f.returnOnEquity);
      const roaScore = scoreIndicator('roa', f.returnOnAssets);
      const cashDebtScore = scoreIndicator('cashDebt', f.totalCash, { cash: f.totalCash, debt: f.totalDebt });
      const divYieldScore = scoreIndicator('dividend', f.dividendYield);

      // Render Rich Fundamental Report & Price Chart Card
      modalBody.innerHTML = `
        <!-- TOP CARD: GRAFICO PREZZO CON ULTIMA QUOTAZIONE AD OGGI E OPERAZIONI BUY / SELL -->
        <div class="signature-card p-3 space-y-2 bg-gray-50/70 dark:bg-white/[0.02] border border-gray-200/50 dark:border-white/5 rounded-xl font-mono">
          <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 border-b border-gray-200/60 dark:border-white/5 pb-2">
            <div>
              <div class="flex items-center space-x-2">
                <span class="text-base" aria-hidden="true">📈</span>
                <h3 class="text-xs font-bold text-gray-900 dark:text-white uppercase tracking-wider font-mono">
                  Andamento Prezzo & Operazioni Eseguite
                </h3>
                <span class="px-1.5 py-0.5 rounded text-[9px] font-bold bg-emerald-100 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300 border border-emerald-500/20">
                  Live Oggi
                </span>
              </div>
              <div class="text-[11px] text-gray-500 dark:text-gray-400 mt-0.5 flex flex-wrap items-center gap-x-2 font-mono">
                <span>Ultima quotazione: <strong class="text-gray-900 dark:text-white font-bold">${fmtPrice(currentPrice, currency)}</strong></span>
                ${(assetInfo.preMarketPrice && Number(assetInfo.preMarketPrice) > 0) ? `
                  <span class="inline-flex items-center space-x-1 px-1.5 py-0.2 rounded text-[10px] font-bold bg-amber-500/15 text-amber-700 dark:text-amber-400 border border-amber-500/30">
                    <span class="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse"></span>
                    <span>PRE: ${fmtPrice(assetInfo.preMarketPrice, currency)} (${Number(assetInfo.preMarketChangePercent || 0) > 0 ? '+' : ''}${Number(assetInfo.preMarketChangePercent || 0).toFixed(2).replace('.', ',')}%)</span>
                  </span>
                ` : ''}
                <span>${renderVariationBadge(dayChangePct)}</span>
                <span class="text-gray-400">• Aggiornato ad oggi</span>
              </div>
            </div>

            <!-- Time Range Selector -->
            <div class="flex items-center space-x-1 font-mono text-[10px]" id="modalPriceChartRangeButtons">
              <button type="button" data-range="1M" class="chart-range-btn px-2 py-0.5 rounded transition border ${currentModalRange === '1M' ? 'bg-emerald-600 text-white font-bold border-emerald-500' : 'border-gray-200 dark:border-white/10 hover:bg-gray-100 dark:hover:bg-white/10 text-gray-600 dark:text-gray-300'}">1M</button>
              <button type="button" data-range="3M" class="chart-range-btn px-2 py-0.5 rounded transition border ${currentModalRange === '3M' ? 'bg-emerald-600 text-white font-bold border-emerald-500' : 'border-gray-200 dark:border-white/10 hover:bg-gray-100 dark:hover:bg-white/10 text-gray-600 dark:text-gray-300'}">3M</button>
              <button type="button" data-range="6M" class="chart-range-btn px-2 py-0.5 rounded transition border ${currentModalRange === '6M' ? 'bg-emerald-600 text-white font-bold border-emerald-500' : 'border-gray-200 dark:border-white/10 hover:bg-gray-100 dark:hover:bg-white/10 text-gray-600 dark:text-gray-300'}">6M</button>
              <button type="button" data-range="1Y" class="chart-range-btn px-2 py-0.5 rounded transition border ${currentModalRange === '1Y' ? 'bg-emerald-600 text-white font-bold border-emerald-500' : 'border-gray-200 dark:border-white/10 hover:bg-gray-100 dark:hover:bg-white/10 text-gray-600 dark:text-gray-300'}">1Y</button>
              <button type="button" data-range="5Y" class="chart-range-btn px-2 py-0.5 rounded transition border ${currentModalRange === '5Y' ? 'bg-emerald-600 text-white font-bold border-emerald-500' : 'border-gray-200 dark:border-white/10 hover:bg-gray-100 dark:hover:bg-white/10 text-gray-600 dark:text-gray-300'}">5Y</button>
              <button type="button" data-range="ALL" class="chart-range-btn px-2 py-0.5 rounded transition border ${currentModalRange === 'ALL' ? 'bg-emerald-600 text-white font-bold border-emerald-500' : 'border-gray-200 dark:border-white/10 hover:bg-gray-100 dark:hover:bg-white/10 text-gray-600 dark:text-gray-300'}">ALL</button>
            </div>
          </div>

          <!-- Operations Summary Banner -->
          <div class="flex flex-wrap items-center justify-between text-[10px] text-gray-500 dark:text-gray-400 bg-white/60 dark:bg-white/[0.02] p-1.5 rounded-lg border border-gray-100 dark:border-white/5">
            <div class="flex items-center space-x-2">
              <span id="modalTxCountsBadge" class="font-semibold text-gray-700 dark:text-gray-300">Caricamento operazioni portafoglio...</span>
            </div>
            <div class="flex items-center space-x-2 text-[9px]">
              <span class="inline-flex items-center"><span class="w-2.5 h-2.5 rounded-full bg-emerald-500 border border-white mr-1" aria-hidden="true"></span>BUY (Acquisto)</span>
              <span class="inline-flex items-center"><span class="w-2.5 h-2.5 rounded-full bg-rose-500 border border-white mr-1" aria-hidden="true"></span>SELL (Vendita)</span>
              <span class="inline-flex items-center"><span class="w-2.5 h-2.5 rounded-full bg-amber-500 border border-white mr-1" aria-hidden="true"></span>DIV (Dividendo)</span>
            </div>
          </div>

          <!-- Canvas Container -->
          <div class="h-60 sm:h-72 w-full relative">
            <div id="modalPriceChartLoading" class="absolute inset-0 bg-white/60 dark:bg-[#151518]/60 backdrop-blur-xs flex items-center justify-center z-10 hidden">
              <svg class="w-6 h-6 animate-spin text-emerald-500" fill="none" viewBox="0 0 24 24">
                <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
              </svg>
            </div>
            <canvas id="modalPriceChartCanvas"></canvas>
          </div>
        </div>

        <!-- Top Metrics KPI Grid -->
        <div class="grid grid-cols-2 sm:grid-cols-5 gap-2 text-xs font-mono">
          <div class="signature-card p-2 bg-gray-50/70 dark:bg-white/[0.02] border border-gray-200/50 dark:border-white/5">
            <span class="text-[9px] uppercase font-bold text-gray-400 block truncate">Market Cap</span>
            <div class="text-xs font-bold text-gray-900 dark:text-white mt-0.5">${fmtLargeNumber(f.marketCap, f.currency)}</div>
          </div>
          <div class="signature-card p-2 bg-gray-50/70 dark:bg-white/[0.02] border border-gray-200/50 dark:border-white/5">
            <span class="text-[9px] uppercase font-bold text-gray-400 block truncate">P/E (Trail / Fwd)</span>
            <div class="text-xs font-bold text-gray-900 dark:text-white mt-0.5">
              ${f.trailingPE ? f.trailingPE.toFixed(1) + 'x' : '-'} / ${f.forwardPE ? f.forwardPE.toFixed(1) + 'x' : '-'}
            </div>
          </div>
          <div class="signature-card p-2 bg-emerald-500/10 dark:bg-emerald-500/5 border border-emerald-500/30 dark:border-emerald-500/20">
            <span class="text-[9px] uppercase font-bold text-emerald-700 dark:text-emerald-400 block truncate">PEG Ratio</span>
            <div class="text-xs font-bold text-emerald-800 dark:text-emerald-300 mt-0.5 flex items-center justify-between">
              <span>${f.pegRatio ? f.pegRatio.toFixed(2) + 'x' : '-'}</span>
              <span class="text-[9px] font-sans font-semibold">${pegScore.label ? pegScore.label.split(' ')[0] : ''}</span>
            </div>
          </div>
          <div class="signature-card p-2 bg-gray-50/70 dark:bg-white/[0.02] border border-gray-200/50 dark:border-white/5">
            <span class="text-[9px] uppercase font-bold text-gray-400 block truncate">Dividend Yield</span>
            <div class="text-xs font-bold text-emerald-600 dark:text-emerald-400 mt-0.5">
              ${f.dividendYield ? f.dividendYield.toFixed(2) + '%' : '0.00%'}
            </div>
          </div>
          <div class="signature-card p-2 bg-gray-50/70 dark:bg-white/[0.02] border border-gray-200/50 dark:border-white/5 col-span-2 sm:col-span-1">
            <span class="text-[9px] uppercase font-bold text-gray-400 block truncate">Consenso Analisti</span>
            <div class="mt-0.5">
              ${getRecommendationBadge(f.recommendationKey)}
            </div>
          </div>
        </div>

        <!-- SPOTLIGHT: PEG RATIO (Peter Lynch Growth Metric) -->
        <div class="signature-card p-3 bg-gradient-to-r from-emerald-500/10 via-teal-500/5 to-transparent border border-emerald-500/30 dark:border-emerald-500/20 rounded-xl space-y-2">
          <div class="flex items-center justify-between flex-wrap gap-1">
            <div class="flex items-center space-x-2">
              <span class="text-base" aria-hidden="true">💎</span>
              <h3 class="text-xs font-bold text-gray-900 dark:text-white uppercase tracking-wider font-mono">
                PEG Ratio (Price / Earnings-to-Growth) - Regola di Peter Lynch
              </h3>
            </div>
            <div class="flex items-center space-x-2">
              ${f.pegSource ? `<span class="text-[9px] text-gray-400 font-mono">Fonte: ${f.pegSource}</span>` : ''}
              <span class="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold border ${pegScore.bgClass} ${pegScore.textClass}">
                <span class="mr-1" aria-hidden="true">${pegScore.icon}</span>
                <span>${pegScore.label}</span>
              </span>
            </div>
          </div>

          <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pt-1">
            <div class="flex items-baseline space-x-2">
              <span class="text-2xl font-extrabold font-mono text-gray-900 dark:text-white">${f.pegRatio ? f.pegRatio.toFixed(2) + 'x' : 'N/D'}</span>
              <span class="text-[11px] text-gray-500 dark:text-gray-400 font-sans leading-tight">
                ${f.pegRatio && f.pegRatio > 0 && f.pegRatio < 1.0
                  ? 'Il titolo tratta a sconto rispetto alla crescita attesa degli utili (Buy Zone).'
                  : f.pegRatio && f.pegRatio <= 1.5
                    ? 'Il prezzo attuale incorpora una valutazione equilibrata rispetto alla crescita prevista.'
                    : 'Il multiplo riflette un prezzo elevato rispetto al tasso di crescita degli utili.'}
              </span>
            </div>

            <!-- Visual Scale Reference -->
            <div class="flex items-center space-x-1.5 text-[9px] font-mono shrink-0">
              <span class="px-1.5 py-0.5 rounded ${f.pegRatio > 0 && f.pegRatio < 1.0 ? 'bg-emerald-600 text-white font-bold ring-2 ring-emerald-400' : 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400'} border border-emerald-500/30">&lt; 1.0 Sottovalutato</span>
              <span class="px-1.5 py-0.5 rounded ${f.pegRatio >= 1.0 && f.pegRatio <= 1.5 ? 'bg-amber-600 text-white font-bold ring-2 ring-amber-400' : 'bg-amber-500/10 text-amber-700 dark:text-amber-400'} border border-amber-500/30">1.0 - 1.5 Fair</span>
              <span class="px-1.5 py-0.5 rounded ${f.pegRatio > 1.5 ? 'bg-rose-600 text-white font-bold ring-2 ring-rose-400' : 'bg-rose-500/10 text-rose-700 dark:text-rose-400'} border border-rose-500/30">&gt; 1.5 Sopravvalutato</span>
            </div>
          </div>
        </div>

        <!-- ULTIMA TRIMESTRALE (Latest Quarter Financials & EPS Surprise) -->
        ${f.latestQuarter ? `
          <div class="signature-card p-3 space-y-2 bg-gray-50/70 dark:bg-white/[0.02] border border-gray-200/50 dark:border-white/5 rounded-xl font-mono">
            <div class="text-xs font-bold text-gray-900 dark:text-white flex items-center justify-between border-b border-gray-200/60 dark:border-white/5 pb-1.5">
              <div class="flex items-center space-x-2">
                <span>📅 Ultima Trimestrale (${f.latestQuarter.quarter})</span>
                ${f.latestQuarter.reportedDate ? `<span class="text-[10px] text-gray-400 font-normal">Riportata il ${new Date(f.latestQuarter.reportedDate).toLocaleDateString('it-IT')}</span>` : ''}
              </div>
              <div>
                ${(() => {
                  const sp = f.latestQuarter.surprisePercent;
                  if (sp !== null && sp !== undefined) {
                    const isBeat = sp >= 0;
                    const cl = isBeat
                      ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300 border-emerald-500/30'
                      : 'bg-rose-100 text-rose-800 dark:bg-rose-950/60 dark:text-rose-300 border-rose-500/30';
                    const icon = isBeat ? '🚀 Beat' : '🔻 Miss';
                    return `<span class="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold border ${cl}"><span class="mr-1">${icon}</span>${isBeat ? '+' : ''}${sp.toFixed(2)}% vs stime</span>`;
                  }
                  return '';
                })()}
              </div>
            </div>

            <div class="grid grid-cols-2 sm:grid-cols-4 gap-2 text-[11px]">
              <div class="p-2 rounded-lg bg-white/70 dark:bg-white/[0.02] border border-gray-100 dark:border-white/5">
                <span class="text-[9px] uppercase font-bold text-gray-400 block truncate">EPS Effettivo vs Stima</span>
                <div class="text-xs font-bold text-gray-900 dark:text-white mt-0.5">
                  ${f.latestQuarter.epsActual !== null ? f.latestQuarter.epsActual.toFixed(2) : '-'} / ${f.latestQuarter.epsEstimate !== null ? f.latestQuarter.epsEstimate.toFixed(2) : '-'}
                </div>
                <span class="text-[9px] text-gray-400">Diff: ${f.latestQuarter.epsDifference !== null ? (f.latestQuarter.epsDifference >= 0 ? '+' : '') + f.latestQuarter.epsDifference.toFixed(3) : '-'}</span>
              </div>

              <div class="p-2 rounded-lg bg-white/70 dark:bg-white/[0.02] border border-gray-100 dark:border-white/5">
                <span class="text-[9px] uppercase font-bold text-gray-400 block truncate">Ricavi Trimestrali</span>
                <div class="text-xs font-bold text-gray-900 dark:text-white mt-0.5">
                  ${fmtLargeNumber(f.latestQuarter.revenue, f.currency)}
                </div>
                <span class="text-[9px] text-gray-400">Fatturato 3M</span>
              </div>

              <div class="p-2 rounded-lg bg-white/70 dark:bg-white/[0.02] border border-gray-100 dark:border-white/5">
                <span class="text-[9px] uppercase font-bold text-gray-400 block truncate">Utile Netto Trimestre</span>
                <div class="text-xs font-bold text-emerald-600 dark:text-emerald-400 mt-0.5">
                  ${fmtLargeNumber(f.latestQuarter.earnings, f.currency)}
                </div>
                <span class="text-[9px] text-gray-400">Net Income 3M</span>
              </div>

              <div class="p-2 rounded-lg bg-white/70 dark:bg-white/[0.02] border border-gray-100 dark:border-white/5">
                <span class="text-[9px] uppercase font-bold text-gray-400 block truncate">Margine Trimestrale</span>
                <div class="text-xs font-bold text-gray-900 dark:text-white mt-0.5">
                  ${f.latestQuarter.profitMargin !== null ? f.latestQuarter.profitMargin.toFixed(1) + '%' : '-'}
                </div>
                <span class="text-[9px] text-gray-400">${f.latestQuarter.nextEarningsDate ? `Prossima: ${new Date(f.latestQuarter.nextEarningsDate).toLocaleDateString('it-IT')}` : 'Prossima: N/D'}</span>
              </div>
            </div>
          </div>
        ` : ''}

        <!-- STORICO 5 ANNI: GRAFICI FATTURATO E P/E -->
        <div class="signature-card p-3 space-y-2 bg-gray-50/70 dark:bg-white/[0.02] border border-gray-200/50 dark:border-white/5 rounded-xl font-mono">
          <div class="text-xs font-bold text-gray-900 dark:text-white flex items-center justify-between border-b border-gray-200/60 dark:border-white/5 pb-1.5">
            <div class="flex items-center space-x-1.5">
              <span>📊 Storico Ultimi 5 Anni: Fatturato & Multiplo P/E</span>
            </div>
            <span class="text-[10px] text-gray-400 font-normal">Dati storici yfinance</span>
          </div>

          <div class="grid grid-cols-1 md:grid-cols-2 gap-3 pt-1">
            <!-- Chart 1: Fatturato e Utili Annuali -->
            <div class="p-2 rounded-lg bg-white dark:bg-[#121214] border border-gray-200/60 dark:border-white/5 flex flex-col justify-between">
              <div class="flex items-center justify-between mb-1 text-[10px] font-mono">
                <span class="font-bold text-gray-700 dark:text-gray-300">Fatturato & Utili Annuali</span>
                <div class="flex items-center space-x-2 text-[9px]">
                  <span class="inline-flex items-center"><span class="w-2 h-2 rounded-sm bg-emerald-500 mr-1" aria-hidden="true"></span>Fatturato</span>
                  <span class="inline-flex items-center"><span class="w-2 h-2 rounded-sm bg-purple-500 mr-1" aria-hidden="true"></span>Utile</span>
                </div>
              </div>
              <div class="h-40 w-full relative">
                <canvas id="modalRevenueChart"></canvas>
              </div>
            </div>

            <!-- Chart 2: Andamento Multiplo P/E -->
            <div class="p-2 rounded-lg bg-white dark:bg-[#121214] border border-gray-200/60 dark:border-white/5 flex flex-col justify-between">
              <div class="flex items-center justify-between mb-1 text-[10px] font-mono">
                <span class="font-bold text-gray-700 dark:text-gray-300">Andamento P/E Storico</span>
                <div class="flex items-center space-x-2 text-[9px]">
                  <span class="inline-flex items-center"><span class="w-2 h-2 rounded-full bg-blue-500 mr-1" aria-hidden="true"></span>P/E Storico</span>
                  <span class="text-gray-400">(Ref. 20x)</span>
                </div>
              </div>
              <div class="h-40 w-full relative">
                <canvas id="modalPEChart"></canvas>
              </div>
            </div>
          </div>
        </div>

        <!-- Section 1: Multipli di Valutazione Evidenziati -->
        <div class="signature-card p-3 space-y-2 bg-gray-50/70 dark:bg-white/[0.02] border border-gray-200/50 dark:border-white/5 font-mono">
          <div class="text-xs font-bold text-gray-900 dark:text-white flex items-center justify-between border-b border-gray-200/60 dark:border-white/5 pb-1">
            <span>📈 Multipli di Mercato & Valutazione</span>
            <span class="text-[10px] text-gray-400 font-normal">Evidenziati per congruità del valore</span>
          </div>
          <div class="grid grid-cols-2 sm:grid-cols-3 gap-2">
            ${renderScoredMetric('P/E Ratio (Trailing)', fmtMultiple(f.trailingPE), peScore, 'Multiplo prezzo/utili ultimi 12 mesi')}
            ${renderScoredMetric('P/E Forward', fmtMultiple(f.forwardPE), fwdPeScore, 'Multiplo prezzo/utili attesi a 1 anno')}
            ${renderScoredMetric('PEG Ratio', fmtMultiple(f.pegRatio), pegScore, 'Rapporto tra P/E e crescita stimata')}
            ${renderScoredMetric('Price to Book (P/B)', fmtMultiple(f.priceToBook), pbScore, 'Prezzo diviso valore contabile per azione')}
            ${renderScoredMetric('Price to Sales (P/S)', fmtMultiple(f.priceToSales), psScore, 'Prezzo diviso fatturato per azione')}
            ${renderScoredMetric('EV / EBITDA', fmtMultiple(f.enterpriseToEbitda), evEbitdaScore, 'Enterprise Value diviso margine EBITDA')}
            <div class="p-2 rounded-lg bg-white/70 dark:bg-white/[0.02] border border-gray-100 dark:border-white/5 flex flex-col justify-between">
              <span class="text-gray-400 text-[10px] block truncate">Enterprise Value</span>
              <strong class="text-gray-900 dark:text-white font-mono text-xs tabular-nums mt-1">${fmtLargeNumber(f.enterpriseValue, f.currency)}</strong>
            </div>
            <div class="p-2 rounded-lg bg-white/70 dark:bg-white/[0.02] border border-gray-100 dark:border-white/5 flex flex-col justify-between">
              <span class="text-gray-400 text-[10px] block truncate">EV / Revenue</span>
              <strong class="text-gray-900 dark:text-white font-mono text-xs tabular-nums mt-1">${fmtMultiple(f.enterpriseToRevenue)}</strong>
            </div>
            <div class="p-2 rounded-lg bg-white/70 dark:bg-white/[0.02] border border-gray-100 dark:border-white/5 flex flex-col justify-between">
              <span class="text-gray-400 text-[10px] block truncate">Beta (Volatilità)</span>
              <strong class="text-gray-900 dark:text-white font-mono text-xs tabular-nums mt-1">${f.beta ? Number(f.beta).toFixed(2) : '-'}</strong>
            </div>
          </div>
        </div>

        <!-- Section 2: Redditività & Conto Economico Evidenziati -->
        <div class="signature-card p-3 space-y-2 bg-gray-50/70 dark:bg-white/[0.02] border border-gray-200/50 dark:border-white/5 font-mono">
          <div class="text-xs font-bold text-gray-900 dark:text-white flex items-center justify-between border-b border-gray-200/60 dark:border-white/5 pb-1">
            <span>💰 Redditività, Margini & Solidità Patrimoniale</span>
            <span class="text-[10px] text-gray-400 font-normal">Income & Balance Sheet</span>
          </div>
          <div class="grid grid-cols-2 sm:grid-cols-3 gap-2">
            ${renderScoredMetric('Margine Utile Netto', f.profitMargins ? (f.profitMargins * 100).toFixed(2) + '%' : '-', profitMarginScore, 'Percentuale di utile netto sui ricavi totali')}
            ${renderScoredMetric('Margine Operativo', f.operatingMargins ? (f.operatingMargins * 100).toFixed(2) + '%' : '-', opMarginScore, 'Redditività dell attività core')}
            ${renderScoredMetric('Return on Equity (ROE)', f.returnOnEquity ? (f.returnOnEquity * 100).toFixed(2) + '%' : '-', roeScore, 'Rendimento del patrimonio netto degli azionisti')}
            ${renderScoredMetric('Return on Assets (ROA)', f.returnOnAssets ? (f.returnOnAssets * 100).toFixed(2) + '%' : '-', roaScore, 'Efficienza nell impiego del totale attivo')}
            ${renderScoredMetric('Posizione Cassa vs Debito', f.totalCash && f.totalDebt ? fmtLargeNumber(f.totalCash - f.totalDebt, f.currency) : '-', cashDebtScore, 'Differenza tra cassa totale disponibile e debito')}
            ${renderScoredMetric('Dividend Yield', f.dividendYield ? f.dividendYield.toFixed(2) + '%' : '0.00%', divYieldScore, 'Rendimento cedolare annuo')}

            <div class="p-2 rounded-lg bg-white/70 dark:bg-white/[0.02] border border-gray-100 dark:border-white/5 flex flex-col justify-between">
              <span class="text-gray-400 text-[10px] block truncate">Fatturato Totale 12M</span>
              <strong class="text-gray-900 dark:text-white font-mono text-xs tabular-nums mt-1">${fmtLargeNumber(f.totalRevenue, f.currency)}</strong>
            </div>
            <div class="p-2 rounded-lg bg-white/70 dark:bg-white/[0.02] border border-gray-100 dark:border-white/5 flex flex-col justify-between">
              <span class="text-gray-400 text-[10px] block truncate">Utile Netto 12M</span>
              <strong class="text-gray-900 dark:text-white font-mono text-xs tabular-nums mt-1">${fmtLargeNumber(f.netIncome, f.currency)}</strong>
            </div>
            <div class="p-2 rounded-lg bg-white/70 dark:bg-white/[0.02] border border-gray-100 dark:border-white/5 flex flex-col justify-between">
              <span class="text-gray-400 text-[10px] block truncate">EBITDA 12M</span>
              <strong class="text-gray-900 dark:text-white font-mono text-xs tabular-nums mt-1">${fmtLargeNumber(f.ebitda, f.currency)}</strong>
            </div>
            <div class="p-2 rounded-lg bg-white/70 dark:bg-white/[0.02] border border-gray-100 dark:border-white/5 flex flex-col justify-between">
              <span class="text-gray-400 text-[10px] block truncate">Free Cash Flow (FCF)</span>
              <strong class="text-gray-900 dark:text-white font-mono text-xs tabular-nums mt-1">${fmtLargeNumber(f.freeCashflow, f.currency)}</strong>
            </div>
            <div class="p-2 rounded-lg bg-white/70 dark:bg-white/[0.02] border border-gray-100 dark:border-white/5 flex flex-col justify-between">
              <span class="text-gray-400 text-[10px] block truncate">Cassa Disponibile</span>
              <strong class="text-gray-900 dark:text-white font-mono text-xs tabular-nums mt-1">${fmtLargeNumber(f.totalCash, f.currency)}</strong>
            </div>
            <div class="p-2 rounded-lg bg-white/70 dark:bg-white/[0.02] border border-gray-100 dark:border-white/5 flex flex-col justify-between">
              <span class="text-gray-400 text-[10px] block truncate">Debito Totale</span>
              <strong class="text-gray-900 dark:text-white font-mono text-xs tabular-nums mt-1">${fmtLargeNumber(f.totalDebt, f.currency)}</strong>
            </div>
          </div>
        </div>

        <!-- Section 3: Target Prezzo & Consenso Analisti -->
        <div class="signature-card p-3 space-y-2 bg-gray-50/70 dark:bg-white/[0.02] border border-gray-200/50 dark:border-white/5 font-mono">
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
        <div class="signature-card p-3 space-y-2 bg-gray-50/70 dark:bg-white/[0.02] border border-gray-200/50 dark:border-white/5 font-mono">
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
          <div class="signature-card p-3 space-y-2 bg-gray-50/70 dark:bg-white/[0.02] border border-gray-200/50 dark:border-white/5 font-mono">
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

      // Bind price chart range buttons
      const rangeBtns = modalBody.querySelectorAll('.chart-range-btn');
      rangeBtns.forEach(btn => {
        btn.addEventListener('click', () => {
          const newRange = btn.getAttribute('data-range');
          currentModalRange = newRange;
          rangeBtns.forEach(b => {
            b.className = 'chart-range-btn px-2 py-0.5 rounded transition border border-gray-200 dark:border-white/10 hover:bg-gray-100 dark:hover:bg-white/10 text-gray-600 dark:text-gray-300';
          });
          btn.className = 'chart-range-btn px-2 py-0.5 rounded transition border bg-emerald-600 text-white font-bold border-emerald-500';
          loadModalPriceChart(ticker, newRange, currency);
        });
      });

      // Render charts on next frame
      requestAnimationFrame(() => {
        loadModalPriceChart(ticker, currentModalRange, currency);
        renderModalCharts(f);
      });

    } catch (err) {
      console.error('[Fundamentals Dialog Error]', err);
      modalBody.innerHTML = `
        <div class="py-8 text-center text-rose-500 font-mono">
          Errore durante il caricamento dei dati: ${err.message}
        </div>
      `;
    }
  }

  // Render Chart.js charts for Revenue & P/E 5-Year History
  function renderModalCharts(f) {
    if (typeof Chart === 'undefined') return;

    const isDark = document.documentElement.classList.contains('dark');
    const textColor = isDark ? '#9ca3af' : '#4b5563';
    const gridColor = isDark ? 'rgba(255, 255, 255, 0.06)' : 'rgba(0, 0, 0, 0.06)';

    // 1. Revenue & Earnings History Chart
    const revCanvas = document.getElementById('modalRevenueChart');
    if (revCanvas) {
      if (activeRevenueChart) {
        activeRevenueChart.destroy();
        activeRevenueChart = null;
      }

      const revData = (f.revenueHistory && f.revenueHistory.length) ? f.revenueHistory : [];
      const labels = revData.map(d => String(d.year));
      const revenues = revData.map(d => d.revenue ? Number((d.revenue / 1e9).toFixed(2)) : 0);
      const earnings = revData.map(d => d.earnings ? Number((d.earnings / 1e9).toFixed(2)) : 0);

      activeRevenueChart = new Chart(revCanvas, {
        type: 'bar',
        data: {
          labels: labels.length ? labels : ['N/D'],
          datasets: [
            {
              label: 'Fatturato (B)',
              data: revenues,
              backgroundColor: 'rgba(16, 185, 129, 0.75)',
              borderColor: '#10b981',
              borderWidth: 1,
              borderRadius: 4
            },
            {
              label: 'Utili Netti (B)',
              data: earnings,
              backgroundColor: 'rgba(168, 85, 247, 0.75)',
              borderColor: '#a855f7',
              borderWidth: 1,
              borderRadius: 4
            }
          ]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: { display: false },
            tooltip: {
              callbacks: {
                label: (ctx) => `${ctx.dataset.label}: ${ctx.raw} Mrd`
              }
            }
          },
          scales: {
            x: {
              grid: { display: false },
              ticks: { color: textColor, font: { size: 10, family: 'JetBrains Mono' } }
            },
            y: {
              grid: { color: gridColor },
              ticks: {
                color: textColor,
                font: { size: 9, family: 'JetBrains Mono' },
                callback: (v) => v + ' B'
              }
            }
          }
        }
      });
    }

    // 2. PE Trend Chart
    const peCanvas = document.getElementById('modalPEChart');
    if (peCanvas) {
      if (activePEChart) {
        activePEChart.destroy();
        activePEChart = null;
      }

      const peData = (f.peHistory && f.peHistory.length) ? f.peHistory : [];
      const labels = peData.map(d => String(d.year));
      const peValues = peData.map(d => Number(d.pe));

      activePEChart = new Chart(peCanvas, {
        type: 'line',
        data: {
          labels: labels.length ? labels : ['N/D'],
          datasets: [
            {
              label: 'P/E Storico',
              data: peValues,
              borderColor: '#3b82f6',
              backgroundColor: 'rgba(59, 130, 246, 0.1)',
              fill: true,
              tension: 0.25,
              pointBackgroundColor: '#3b82f6',
              pointRadius: 4,
              pointHoverRadius: 6,
              borderWidth: 2
            }
          ]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: { display: false },
            tooltip: {
              callbacks: {
                label: (ctx) => {
                  const item = peData[ctx.dataIndex];
                  if (item && item.price && item.eps) {
                    return `P/E: ${ctx.raw}x (Prezzo: ${item.price}, EPS: ${item.eps})`;
                  }
                  return `P/E: ${ctx.raw}x`;
                }
              }
            }
          },
          scales: {
            x: {
              grid: { display: false },
              ticks: { color: textColor, font: { size: 10, family: 'JetBrains Mono' } }
            },
            y: {
              grid: { color: gridColor },
              ticks: {
                color: textColor,
                font: { size: 9, family: 'JetBrains Mono' },
                callback: (v) => v + 'x'
              }
            }
          }
        }
      });
    }
  }

  // Load interactive Price History & Transactions (BUY/SELL) Chart
  async function loadModalPriceChart(ticker, range = '1Y', currency = 'EUR') {
    const canvas = document.getElementById('modalPriceChartCanvas');
    if (!canvas || typeof Chart === 'undefined') return;

    const loadingEl = document.getElementById('modalPriceChartLoading');
    if (loadingEl) loadingEl.classList.remove('hidden');

    try {
      // Fetch chart points and transactions in parallel
      const [chartRes, txRes] = await Promise.all([
        fetch(`/api/market/chart/${encodeURIComponent(ticker)}?range=${encodeURIComponent(range)}`),
        fetch(`/api/transactions?assetTicker=${encodeURIComponent(ticker)}&limit=500`).catch(() => null)
      ]);

      const chartData = await chartRes.json();
      let points = (chartData && (chartData.points || chartData.data)) || [];

      let allTxs = [];
      if (txRes && txRes.ok) {
        try {
          const txData = await txRes.json();
          if (txData && txData.success && Array.isArray(txData.transactions)) {
            allTxs = txData.transactions;
          }
        } catch {}
      }

      if (!points || points.length === 0) {
        const countsBadge = document.getElementById('modalTxCountsBadge');
        if (countsBadge) countsBadge.textContent = 'Dati grafici storici non disponibili';
        return;
      }

      // Determine date window of visible chart
      const minDate = points[0].date;
      const maxDate = points[points.length - 1].date;

      // Filter transactions that fall within chart range
      const visibleTxs = allTxs.filter(t => t.date && t.date >= minDate && t.date <= maxDate);

      // Match transactions to point indices
      const txMapByPointIndex = {};
      let buyCount = 0;
      let sellCount = 0;
      let divCount = 0;

      visibleTxs.forEach(t => {
        const tType = (t.type || '').toUpperCase();
        if (tType === 'BUY') buyCount++;
        else if (tType === 'SELL') sellCount++;
        else if (tType === 'DIVIDEND') divCount++;

        let matchIdx = points.findIndex(p => p.date === t.date);
        if (matchIdx === -1) {
          const tTime = new Date(t.date).getTime();
          let closestDist = Infinity;
          let bestIdx = -1;
          for (let i = 0; i < points.length; i++) {
            const dist = Math.abs(new Date(points[i].date).getTime() - tTime);
            if (dist < closestDist) {
              closestDist = dist;
              bestIdx = i;
            }
          }
          if (closestDist <= 4 * 24 * 60 * 60 * 1000) {
            matchIdx = bestIdx;
          }
        }

        if (matchIdx !== -1) {
          if (!txMapByPointIndex[matchIdx]) {
            txMapByPointIndex[matchIdx] = [];
          }
          txMapByPointIndex[matchIdx].push(t);
        }
      });

      // Update summary bar count
      const countsBadge = document.getElementById('modalTxCountsBadge');
      if (countsBadge) {
        if (allTxs.length === 0) {
          countsBadge.innerHTML = `<span class="text-blue-500 font-semibold">Asset in Watchlist</span> <span class="text-gray-400">• Nessuna operazione eseguita in portafoglio</span>`;
        } else if (visibleTxs.length > 0) {
          countsBadge.innerHTML = `<strong class="text-gray-900 dark:text-white font-bold">${visibleTxs.length} operazioni</strong> nel periodo (<span class="text-emerald-600 dark:text-emerald-400 font-semibold">${buyCount} acq</span>, <span class="text-rose-600 dark:text-rose-400 font-semibold">${sellCount} vend</span>${divCount > 0 ? `, <span class="text-amber-600 dark:text-amber-400 font-semibold">${divCount} div</span>` : ''})`;
        } else {
          countsBadge.innerHTML = `<span class="text-gray-500 dark:text-gray-400">${allTxs.length} operazioni registrate in altri periodi (espandi il periodo temporale)</span>`;
        }
      }

      // Format labels & prices
      const isMultiYear = range === '1Y' || range === '5Y' || range === 'ALL';
      const labels = points.map(p => {
        if (!p.date) return '';
        const parts = p.date.split('-');
        if (parts.length === 3) {
          return isMultiYear ? `${parts[1]}/${parts[0].slice(2)}` : `${parts[2]}/${parts[1]}`;
        }
        return p.date;
      });
      const prices = points.map(p => p.close);

      // Construct Operation Marker Data Points
      const txDataPoints = [];
      const txPointRadii = [];
      const txColors = [];
      const txBorderColors = [];
      const txStyles = [];

      for (let i = 0; i < points.length; i++) {
        const txList = txMapByPointIndex[i];
        if (txList && txList.length > 0) {
          const mainTx = txList.find(x => x.type === 'BUY' || x.type === 'SELL') || txList[0];
          const yVal = (mainTx.price && Number(mainTx.price) > 0) ? Number(mainTx.price) : points[i].close;
          txDataPoints.push(yVal);
          txPointRadii.push(7);

          if (mainTx.type === 'BUY') {
            txColors.push('#10b981'); // Emerald
            txBorderColors.push('#ffffff');
            txStyles.push('circle');
          } else if (mainTx.type === 'SELL') {
            txColors.push('#f43f5e'); // Rose
            txBorderColors.push('#ffffff');
            txStyles.push('circle');
          } else if (mainTx.type === 'DIVIDEND') {
            txColors.push('#f59e0b'); // Amber
            txBorderColors.push('#ffffff');
            txStyles.push('circle');
          } else {
            txColors.push('#8b5cf6'); // Purple
            txBorderColors.push('#ffffff');
            txStyles.push('circle');
          }
        } else {
          txDataPoints.push(null);
          txPointRadii.push(0);
          txColors.push('transparent');
          txBorderColors.push('transparent');
          txStyles.push('circle');
        }
      }

      if (activePriceChart) {
        activePriceChart.destroy();
        activePriceChart = null;
      }

      const isDark = document.documentElement.classList.contains('dark');
      const isPositive = prices.length > 0 && prices[prices.length - 1] >= prices[0];
      const strokeColor = isPositive ? '#10b981' : '#f43f5e';
      const fillColor = isPositive ? 'rgba(16, 185, 129, 0.08)' : 'rgba(244, 63, 94, 0.08)';

      // Custom Plugin to Draw Operation Badges/Labels above/below dots
      const modalTxLabelsPlugin = {
        id: 'modalTransactionLabels',
        afterDatasetsDraw(chart) {
          const ctx = chart.ctx;
          const meta = chart.getDatasetMeta(1); // operations dataset
          if (!meta || !meta.data) return;

          ctx.save();
          ctx.font = 'bold 9px "JetBrains Mono", monospace';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';

          meta.data.forEach((element, index) => {
            const txList = txMapByPointIndex[index];
            if (!txList || txList.length === 0) return;

            const pos = element.tooltipPosition ? element.tooltipPosition() : { x: element.x, y: element.y };
            if (!pos || isNaN(pos.x) || isNaN(pos.y)) return;

            const primaryTx = txList.find(x => x.type === 'BUY' || x.type === 'SELL') || txList[0];
            const isBuy = primaryTx.type === 'BUY';
            const isSell = primaryTx.type === 'SELL';
            const isDiv = primaryTx.type === 'DIVIDEND';

            let text = isBuy ? 'BUY' : (isSell ? 'SELL' : (isDiv ? 'DIV' : primaryTx.type));
            if (primaryTx.quantity && (isBuy || isSell)) {
              text += ` ${isBuy ? '+' : '-'}${Math.round(primaryTx.quantity)}`;
            } else if (isDiv && primaryTx.amount) {
              text += ` +${fmtPrice(primaryTx.amount, currency)}`;
            }

            const textWidth = ctx.measureText(text).width;
            const padX = 5;
            const pillWidth = textWidth + padX * 2;
            const pillHeight = 15;
            const pillY = isSell ? pos.y + 16 : pos.y - 16;
            const pillX = pos.x - pillWidth / 2;

            // Background pill
            ctx.fillStyle = isBuy ? '#10b981' : (isSell ? '#f43f5e' : (isDiv ? '#f59e0b' : '#8b5cf6'));
            ctx.beginPath();
            const r = 4;
            if (typeof ctx.roundRect === 'function') {
              ctx.roundRect(pillX, pillY - pillHeight / 2, pillWidth, pillHeight, r);
            } else {
              ctx.rect(pillX, pillY - pillHeight / 2, pillWidth, pillHeight);
            }
            ctx.fill();

            // Border
            ctx.strokeStyle = '#ffffff';
            ctx.lineWidth = 1;
            ctx.stroke();

            // Text
            ctx.fillStyle = '#ffffff';
            ctx.fillText(text, pos.x, pillY);
          });

          ctx.restore();
        }
      };

      activePriceChart = new Chart(canvas, {
        type: 'line',
        plugins: [modalTxLabelsPlugin],
        data: {
          labels,
          datasets: [
            // Dataset 0: Continuous price history line
            {
              label: 'Prezzo',
              data: prices,
              borderColor: strokeColor,
              borderWidth: 2,
              pointRadius: 0,
              pointHoverRadius: 4,
              pointBackgroundColor: strokeColor,
              fill: true,
              backgroundColor: fillColor,
              tension: 0.15,
              order: 2
            },
            // Dataset 1: Operation markers
            {
              label: 'Operazioni',
              data: txDataPoints,
              borderColor: 'transparent',
              borderWidth: 0,
              showLine: false,
              pointRadius: txPointRadii,
              pointHoverRadius: 9,
              pointBackgroundColor: txColors,
              pointBorderColor: txBorderColors,
              pointBorderWidth: 2,
              pointStyle: txStyles,
              order: 1
            }
          ]
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
                  if (!p) return '';
                  const isToday = p.source === 'LIVE_TODAY' || p.date === new Date().toISOString().split('T')[0];
                  return `Data: ${p.date}${isToday ? ' (Oggi - Prezzo Live)' : ''}`;
                },
                label: (ctx) => {
                  const idx = ctx.dataIndex;
                  if (ctx.datasetIndex === 0) {
                    return ` Prezzo: ${fmtPrice(ctx.raw, currency)}`;
                  } else {
                    const txList = txMapByPointIndex[idx];
                    if (!txList || txList.length === 0) return '';
                    return txList.map(t => {
                      const isB = t.type === 'BUY';
                      const isS = t.type === 'SELL';
                      const isD = t.type === 'DIVIDEND';
                      const typeLabel = isB ? '🟢 ACQUISTO (BUY)' : (isS ? '🔴 VENDITA (SELL)' : (isD ? '🟡 DIVIDENDO' : `🟣 ${t.type}`));
                      const qStr = t.quantity ? `${Math.round(t.quantity)} quote` : '';
                      const pStr = t.price ? `@ ${fmtPrice(t.price, currency)}` : '';
                      const amtStr = t.amount ? `[Tot: ${fmtPrice(t.amount, currency)}]` : '';
                      return ` ${typeLabel}: ${qStr} ${pStr} ${amtStr}`.trim();
                    });
                  }
                },
                afterLabel: (ctx) => {
                  if (ctx.datasetIndex === 1) {
                    const txList = txMapByPointIndex[ctx.dataIndex];
                    if (txList && txList[0] && txList[0].notes) {
                      return ` Note: ${txList[0].notes}`;
                    }
                  }
                  return '';
                }
              }
            }
          },
          scales: {
            x: {
              grid: { display: false },
              ticks: { maxTicksLimit: 7, font: { family: 'JetBrains Mono', size: 10 }, color: isDark ? '#9ca3af' : '#6b7280' }
            },
            y: {
              grid: { color: isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)' },
              ticks: {
                font: { family: 'JetBrains Mono', size: 10 },
                color: isDark ? '#9ca3af' : '#6b7280',
                callback: (v) => fmtPrice(v, currency)
              }
            }
          }
        }
      });
    } catch (err) {
      console.warn('Error loading asset price chart:', err);
    } finally {
      if (loadingEl) loadingEl.classList.add('hidden');
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

    // Cleanup Chart.js instances when fundamentals modal closes
    const fundModal = document.getElementById('fundamentalsModal');
    if (fundModal) {
      fundModal.addEventListener('close', () => {
        if (activePriceChart) {
          activePriceChart.destroy();
          activePriceChart = null;
        }
        if (activeRevenueChart) {
          activeRevenueChart.destroy();
          activeRevenueChart = null;
        }
        if (activePEChart) {
          activePEChart.destroy();
          activePEChart = null;
        }
      });
    }
  });

})();

