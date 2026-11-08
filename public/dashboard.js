/**
 * FolioTrack 12-Column Modular Dashboard Engine
 * Powered by GridStack.js and Chart.js
 * Featuring the 14 official Wealthfolio-inspired widgets, live Rebalancing, layout persistence,
 * and comprehensive Multi-Portfolio filtering & aggregation.
 */

(function () {
  let grid = null;
  let isCustomizing = false;
  let activeCharts = {};
  let rawPortfolioData = null;
  let selectedPortfolioId = 'all';
  let cachedPortfolioNews = null;
  let isNewsLoading = false;

  // 23 Official FolioTrack & Wealthfolio Widgets default grid definition
  const WIDGET_DEFINITIONS = [
    { id: 'value', name: 'Patrimonio (NAV)', category: 'KPI', w: 4, h: 2, minW: 3, minH: 2 },
    { id: 'dayChange', name: 'Variazione Giornaliera (Oggi)', category: 'Performance', w: 3, h: 2, minW: 2, minH: 2 },
    { id: 'cash', name: 'Liquidità', category: 'KPI', w: 2, h: 2, minW: 2, minH: 2 },
    { id: 'invested', name: 'Versato', category: 'KPI', w: 2, h: 2, minW: 2, minH: 2 },
    { id: 'bookCost', name: 'Carico (PMC)', category: 'KPI', w: 2, h: 2, minW: 2, minH: 2 },
    { id: 'pnl', name: 'P&L Totale', category: 'KPI', w: 2, h: 2, minW: 2, minH: 2 },
    { id: 'twrr', name: 'Rendimento TWRR (Time-Weighted)', category: 'Performance', w: 3, h: 2, minW: 2, minH: 2 },
    { id: 'mwrr', name: 'Rendimento MWRR / XIRR', category: 'Performance', w: 3, h: 2, minW: 2, minH: 2 },
    { id: 'drawdown', name: 'Drawdown & Picco ATH', category: 'Rischio', w: 3, h: 2, minW: 2, minH: 2 },
    { id: 'riskMetrics', name: 'Rischio & Efficienza (Sharpe, Volatilità)', category: 'Rischio', w: 3, h: 2, minW: 2, minH: 2 },
    { id: 'performanceChart', name: 'Andamento Patrimonio & Performance', category: 'Grafici', w: 12, h: 5, minW: 6, minH: 4 },
    { id: 'performanceMatrix', name: 'Matrice Rendimenti Multi-Periodo', category: 'Performance', w: 6, h: 4, minW: 4, minH: 3 },
    { id: 'accounts', name: 'Conti & Ripartizione', category: 'Allocazione', w: 3, h: 4, minW: 3, minH: 3 },
    { id: 'classes', name: 'Asset Class', category: 'Allocazione', w: 3, h: 4, minW: 3, minH: 3 },
    { id: 'regions', name: 'Aree Geografiche', category: 'Allocazione', w: 3, h: 4, minW: 3, minH: 3 },
    { id: 'sectors', name: 'Settori GICS', category: 'Allocazione', w: 3, h: 4, minW: 3, minH: 3 },
    { id: 'composition', name: 'Titoli & Sparkline', category: 'Dettaglio', w: 9, h: 8, minW: 6, minH: 6 },
    { id: 'holdingsCompact', name: 'Titoli Compatti (Var. Day)', category: 'Dettaglio', w: 12, h: 6, minW: 4, minH: 3 },
    { id: 'categoryQuotes', name: 'Quotazioni per Categoria', category: 'Dettaglio', w: 12, h: 8, minW: 6, minH: 5 },
    { id: 'targets', name: 'Target & Rebalance', category: 'Strategia', w: 3, h: 8, minW: 3, minH: 6 },
    { id: 'breakdown', name: 'Holdings Dettagliate', category: 'Dettaglio', w: 12, h: 5, minW: 8, minH: 4 },
    { id: 'moversDay', name: 'Movers Giornalieri (1D)', category: 'Performance', w: 6, h: 6, minW: 4, minH: 4 },
    { id: 'moversAllTime', name: 'Movers All-Time', category: 'Performance', w: 6, h: 6, minW: 4, minH: 4 },
    { id: 'concentration', name: 'Concentrazione Portfolio', category: 'Rischio', w: 6, h: 6, minW: 4, minH: 4 },
    { id: 'news', name: 'Ultime Notizie Portafoglio', category: 'News', w: 6, h: 6, minW: 4, minH: 4 }
  ];

  // Dedicated 1 or 2-column layout definition for mobile devices
  const MOBILE_DEFAULT_LAYOUT = [
    // Hero KPI Banner (full width)
    { id: 'value', name: 'Patrimonio (NAV)', category: 'KPI', w: 2, h: 2, x: 0, y: 0 },

    // Core KPIs paired side-by-side (1 column each = 50% width)
    { id: 'dayChange', name: 'Variazione Giornaliera (Oggi)', category: 'Performance', w: 1, h: 2, x: 0, y: 2 },
    { id: 'pnl', name: 'P&L Totale', category: 'KPI', w: 1, h: 2, x: 1, y: 2 },

    { id: 'cash', name: 'Liquidità', category: 'KPI', w: 1, h: 2, x: 0, y: 4 },
    { id: 'invested', name: 'Versato', category: 'KPI', w: 1, h: 2, x: 1, y: 4 },

    { id: 'twrr', name: 'Rendimento TWRR (Time-Weighted)', category: 'Performance', w: 1, h: 2, x: 0, y: 6 },
    { id: 'mwrr', name: 'Rendimento MWRR / XIRR', category: 'Performance', w: 1, h: 2, x: 1, y: 6 },

    { id: 'drawdown', name: 'Drawdown & Picco ATH', category: 'Rischio', w: 1, h: 2, x: 0, y: 8 },
    { id: 'bookCost', name: 'Carico (PMC)', category: 'KPI', w: 1, h: 2, x: 1, y: 8 },

    // Risk Metrics (full width)
    { id: 'riskMetrics', name: 'Rischio & Efficienza (Sharpe, Volatilità)', category: 'Rischio', w: 2, h: 2, x: 0, y: 10 },

    // Interactive Net Worth & Performance Chart (full width)
    { id: 'performanceChart', name: 'Andamento Patrimonio & Performance', category: 'Grafici', w: 2, h: 5, x: 0, y: 12 },

    // Quotazioni per Categoria (Accordion live view - Photo 1 & 2)
    { id: 'categoryQuotes', name: 'Quotazioni per Categoria', category: 'Dettaglio', w: 2, h: 8, x: 0, y: 17 },

    // Titoli Compatti in Singola Riga (Variazioni Giornaliere)
    { id: 'holdingsCompact', name: 'Titoli Compatti (Var. Day)', category: 'Dettaglio', w: 2, h: 6, x: 0, y: 25 },

    // Portfolio Composition with Sparklines (full width)
    { id: 'composition', name: 'Titoli & Sparkline', category: 'Dettaglio', w: 2, h: 7, x: 0, y: 31 },

    // Daily Movers and All-Time Movers (full width)
    { id: 'moversDay', name: 'Movers Giornalieri (1D)', category: 'Performance', w: 2, h: 5, x: 0, y: 38 },
    { id: 'moversAllTime', name: 'Movers All-Time', category: 'Performance', w: 2, h: 5, x: 0, y: 43 },

    // Multi-Period Return Matrix (full width)
    { id: 'performanceMatrix', name: 'Matrice Rendimenti Multi-Periodo', category: 'Performance', w: 2, h: 4, x: 0, y: 48 },

    // Ultime Notizie Portafoglio (full width)
    { id: 'news', name: 'Ultime Notizie Portafoglio', category: 'News', w: 2, h: 6, x: 0, y: 52 },

    // Allocation Donut Charts (full width)
    { id: 'classes', name: 'Asset Class', category: 'Allocazione', w: 2, h: 5, x: 0, y: 58 },
    { id: 'sectors', name: 'Settori GICS', category: 'Allocazione', w: 2, h: 5, x: 0, y: 63 },
    { id: 'regions', name: 'Aree Geografiche', category: 'Allocazione', w: 2, h: 5, x: 0, y: 68 },
    { id: 'accounts', name: 'Conti & Ripartizione', category: 'Allocazione', w: 2, h: 5, x: 0, y: 73 },

    // Strategy & Targets (full width)
    { id: 'targets', name: 'Target & Rebalance', category: 'Strategia', w: 2, h: 6, x: 0, y: 78 },

    // Portfolio Concentration (full width)
    { id: 'concentration', name: 'Concentrazione Portfolio', category: 'Rischio', w: 2, h: 5, x: 0, y: 84 },

    // Holdings Breakdown Table (full width)
    { id: 'breakdown', name: 'Holdings Dettagliate', category: 'Dettaglio', w: 2, h: 6, x: 0, y: 89 }
  ];

  function isMobileDashboard() {
    return document.querySelector('.grid-stack-2') !== null || document.getElementById('mDashboardPortfolioSelect') !== null;
  }

  function getLayoutSettingKey() {
    return isMobileDashboard() ? 'insightsOverviewLayoutMobile' : 'insightsOverviewLayout';
  }

  function getLayoutStorageKey() {
    return isMobileDashboard() ? 'foliotrack_dashboard_layout_mobile' : 'foliotrack_dashboard_layout';
  }

  const PASTEL_COLORS = [
    '#4f6b92', '#b89a4c', '#8e7cb3', '#7b96c9', '#b74583',
    '#2f4f73', '#d2b98a', '#9c998e', '#cfccc6', '#357941', '#b3261e'
  ];

  let activeSparklinePeriod = '3M';
  let activeCompositionSort = localStorage.getItem('foliotrack_comp_sort') || 'day_desc';
  let activeHistoryRange = localStorage.getItem('foliotrack_perf_range') || '1Y';
  let activeHistoryMetric = localStorage.getItem('foliotrack_perf_metric') || 'NAV';
  let activeTwrrPeriod = localStorage.getItem('foliotrack_twrr_period') || '1Y';
  let currentPerformanceMetrics = null;
  let widgetSearchQuery = '';
  let hiddenWidgets = new Set(JSON.parse(localStorage.getItem('foliotrack_hidden_widgets') || '[]'));
  if (hiddenWidgets.has('movers')) {
    hiddenWidgets.delete('movers');
    hiddenWidgets.add('moversDay');
  }
  let currentSavedLayout = null;
  let autoSaveTimer = null;

  function formatEur(val) {
    const num = Number(val) || 0;
    const kVal = formatKValue(num, false);
    if (kVal !== null) return kVal;
    const sign = num < 0 ? '-' : '';
    return `${sign}€ ${Math.abs(Math.round(num)).toLocaleString('it-IT')}`;
  }

  function formatEurSigned(val) {
    const num = Number(val) || 0;
    const kVal = formatKValue(num, true);
    if (kVal !== null) return kVal;
    const sign = num > 0 ? '+' : (num < 0 ? '-' : '');
    return `${sign}€ ${Math.abs(Math.round(num)).toLocaleString('it-IT')}`;
  }

  function formatEurSignedDec(val, decimals = 0) {
    const num = Number(val) || 0;
    const kVal = formatKValue(num, true);
    if (kVal !== null) return kVal;
    const sign = num > 0 ? '+' : (num < 0 ? '-' : '');
    return `${sign}€ ${Math.abs(Math.round(num)).toLocaleString('it-IT')}`;
  }

  function formatKValue(num, withSign = false) {
    const abs = Math.abs(num);
    if (abs >= 1000) {
      const sign = num > 0 ? (withSign ? '+' : '') : (num < 0 ? '-' : '');
      return `${sign}${(abs / 1000).toFixed(1).replace('.', ',')}k`;
    }
    return null;
  }

  function formatPriceEur(val, curr = '€') {
    const num = Number(val) || 0;
    const hasSubCents = (num !== 0) && (Math.abs(num * 100 - Math.round(num * 100)) > 0.001);
    return (curr === '€' ? '€ ' : '') + num.toLocaleString('it-IT', {
      minimumFractionDigits: 2,
      maximumFractionDigits: hasSubCents ? 4 : 2
    }) + (curr !== '€' ? ' ' + curr : '');
  }

  function formatPct(val) {
    const num = Number(val) || 0;
    const sign = num >= 0 ? '+' : '';
    return `${sign}${num.toFixed(2).replace('.', ',')}%`;
  }

  let activeMoversMode = (typeof localStorage !== 'undefined' ? localStorage.getItem('foliotrack_movers_mode') : null) || 'pct';
  let activeCompactSort = (typeof localStorage !== 'undefined' ? localStorage.getItem('foliotrack_compact_sort') : null) || 'day_desc';
  let collapsedCategorySet = new Set();
  try {
    const rawCollapsed = typeof localStorage !== 'undefined' ? localStorage.getItem('foliotrack_collapsed_categories') : null;
    if (rawCollapsed) collapsedCategorySet = new Set(JSON.parse(rawCollapsed));
  } catch {}

  /**
   * Checks whether a holding was quoted/traded during the current calendar/trading day.
   * Excludes quotes originating from prior trading sessions.
   */
  function isHoldingQuotedToday(h) {
    if (!h) return false;
    const now = new Date();
    const todayIso = now.toISOString().split('T')[0];
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, '0');
    const d = String(now.getDate()).padStart(2, '0');
    const todayLocal = `${y}-${m}-${d}`;
    let todayRome = '';
    try {
      todayRome = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome' }).format(now);
    } catch {}

    const qd = h.quoteDate ? String(h.quoteDate).substring(0, 10) : '';
    if (qd && (qd === todayIso || qd === todayLocal || qd === todayRome)) {
      return true;
    }
    const rmt = h.regularMarketTime ? String(h.regularMarketTime).substring(0, 10) : '';
    if (rmt && (rmt === todayIso || rmt === todayLocal || rmt === todayRome)) {
      return true;
    }
    if (!qd && !rmt) return true;
    return false;
  }

  /**
   * Generates dynamic gradient background and styling for the Var. DAY minicard
   * scaling smoothly from green (positive) to red (negative) based on the % of variation,
   * or a neutral grey background when the market is closed.
   */
  function getDayVarCardStyle(dayPct, isClosed = false) {
    const pct = Number(dayPct) || 0;
    const isPos = pct >= 0;

    if (isClosed) {
      return {
        style: 'background-color: rgba(156, 163, 175, 0.14); border-color: rgba(156, 163, 175, 0.28);',
        titleCls: 'text-gray-400 dark:text-gray-400 font-medium',
        valCls: isPos ? 'text-emerald-600 dark:text-emerald-400 font-bold' : 'text-rose-600 dark:text-rose-400 font-bold',
        subCls: isPos ? 'text-emerald-600/80 dark:text-emerald-400/80' : 'text-rose-600/80 dark:text-rose-400/80'
      };
    }

    if (Math.abs(pct) < 0.001) {
      return {
        style: 'background-color: rgba(156, 163, 175, 0.10); border-color: rgba(156, 163, 175, 0.20);',
        titleCls: 'text-gray-400',
        valCls: 'text-gray-600 dark:text-gray-300 font-bold',
        subCls: 'text-gray-400'
      };
    }
    // Intensity factor from 0.12 to 1.0 based on % (max saturation reached around ±5%)
    const intensity = Math.min(1.0, Math.max(0.12, Math.abs(pct) / 5.0));
    if (pct > 0) {
      const a1 = (0.10 + intensity * 0.25).toFixed(3);
      const a2 = (0.16 + intensity * 0.30).toFixed(3);
      const bAlpha = (0.25 + intensity * 0.45).toFixed(3);
      return {
        style: `background: linear-gradient(135deg, rgba(16, 185, 129, ${a1}) 0%, rgba(5, 150, 105, ${a2}) 100%); border-color: rgba(16, 185, 129, ${bAlpha});`,
        titleCls: 'text-emerald-800 dark:text-emerald-300 font-bold',
        valCls: 'text-emerald-950 dark:text-emerald-100 font-extrabold',
        subCls: 'text-emerald-800/90 dark:text-emerald-200/90 font-semibold'
      };
    } else {
      const a1 = (0.10 + intensity * 0.25).toFixed(3);
      const a2 = (0.16 + intensity * 0.30).toFixed(3);
      const bAlpha = (0.25 + intensity * 0.45).toFixed(3);
      return {
        style: `background: linear-gradient(135deg, rgba(244, 63, 94, ${a1}) 0%, rgba(225, 29, 72, ${a2}) 100%); border-color: rgba(244, 63, 94, ${bAlpha});`,
        titleCls: 'text-rose-800 dark:text-rose-300 font-bold',
        valCls: 'text-rose-950 dark:text-rose-100 font-extrabold',
        subCls: 'text-rose-800/90 dark:text-rose-200/90 font-semibold'
      };
    }
  }

  /**
   * Evaluates whether an asset's stock market is currently CLOSED.
   * Recognizes active European markets (Borsa Italiana 09:00 - 17:30 CET) as OPEN,
   * while classifying US stocks (opening at 15:30 CET) or closed sessions as CHIUSO.
   *
   * @param {object} h Holding / asset object
   * @param {Date} [refDate=new Date()] Reference time
   * @returns {boolean}
   */
  function isAssetMarketClosed(h, refDate = new Date()) {
    if (!h) return false;

    // 0. DELISTED assets never trade
    if (h.dataSource === 'DELISTED') {
      return true;
    }

    // 1. Crypto trades 24/7/365 uninterrupted
    const type = (h.type || '').toUpperCase();
    if (type === 'CRYPTO') {
      return false;
    }

    // 2. Weekend check in Rome timezone (Sat & Sun: traditional exchanges closed)
    const romeDayFormatter = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Europe/Rome',
      weekday: 'short'
    });
    const dayOfWeek = romeDayFormatter.format(refDate);
    if (['Sat', 'Sun'].includes(dayOfWeek)) {
      return true;
    }

    // 3. Current Rome Time (HH:MM)
    const romeTimeFormatter = new Intl.DateTimeFormat('it-IT', {
      timeZone: 'Europe/Rome',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    });
    const currentRomeHHMM = romeTimeFormatter.format(refDate);

    const curr = (h.currency || 'EUR').toUpperCase();
    const exchange = (h.exchange || '').toUpperCase();

    // Determine exchange / market region
    const isUS = curr === 'USD' || ['NASDAQ', 'NYSE', 'NMS', 'NYQ', 'AMEX', 'OTC', 'BATS', 'ARCA'].some(ex => exchange.includes(ex));
    const isUK = curr === 'GBP' || ['LSE', 'LON'].some(ex => exchange.includes(ex));
    const isAsia = ['TYO', 'TSE', 'HKEX', 'HKG', 'SSE', 'SZSE'].some(ex => exchange.includes(ex));
    const isEuro = !isUS && !isUK && !isAsia; // Italian (MIL/BIT) and European (GER/AMS/EPA)

    // 4. Check explicit marketState from provider if available
    if (h.marketState) {
      const ms = String(h.marketState).toUpperCase();
      // If provider explicitly confirms REGULAR trading session, it is actively open!
      if (ms === 'REGULAR') {
        return false;
      }
      // If provider explicitly flags closed, pre-market, or post-market sessions:
      if (['CLOSED', 'POST', 'POSTPOST', 'PRE', 'PREPRE'].includes(ms)) {
        // Double check: if it's European and within 09:00-17:30, trust market hours over delayed provider flag
        if (isEuro && currentRomeHHMM >= '09:00' && currentRomeHHMM < '17:30') {
          return false;
        }
        return true;
      }
    }

    // 5. Official Exchange Trading Hours check in Europe/Rome (CET/CEST)
    if (isUS) {
      // US Markets: 09:30 - 16:00 EST -> 15:30 - 22:00 Europe/Rome
      return !(currentRomeHHMM >= '15:30' && currentRomeHHMM < '22:00');
    }

    if (isUK) {
      // UK Market: 08:00 - 16:30 London -> 09:00 - 17:30 Europe/Rome
      return !(currentRomeHHMM >= '09:00' && currentRomeHHMM < '17:30');
    }

    if (isAsia) {
      // Asian Markets: ~02:00 - 09:00 Europe/Rome
      return !(currentRomeHHMM >= '02:00' && currentRomeHHMM < '09:00');
    }

    // Default European / Italian Markets (Borsa Italiana / Euronext / XETRA): 09:00 - 17:30 Europe/Rome
    return !(currentRomeHHMM >= '09:00' && currentRomeHHMM < '17:30');
  }

  /**
   * Returns human-readable status metadata for an asset's market state.
   */
  function getAssetMarketStatusInfo(h, refDate = new Date()) {
    if (h && h.dataSource === 'DELISTED') {
      return {
        isClosed: true,
        label: 'DELISTED',
        reason: 'Titolo Delistato (Aggiornamenti quotazioni disattivati, storico preservato)'
      };
    }

    const isClosed = isAssetMarketClosed(h, refDate);
    const curr = (h.currency || 'EUR').toUpperCase();
    const exchange = (h.exchange || '').toUpperCase();
    const isUS = curr === 'USD' || ['NASDAQ', 'NYSE', 'NMS', 'NYQ', 'AMEX', 'OTC', 'BATS', 'ARCA'].some(ex => exchange.includes(ex));

    if (isClosed) {
      const romeDayFormatter = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Rome', weekday: 'short' });
      const isWeekend = ['Sat', 'Sun'].includes(romeDayFormatter.format(refDate));
      let reason = 'Mercato Chiuso';
      if (isWeekend) {
        reason = 'Mercato Chiuso (Fine settimana)';
      } else if (isUS) {
        reason = 'Mercato USA Chiuso (Apre alle 15:30 CET)';
      } else {
        reason = 'Mercato Chiuso (Orari di contrattazione: 09:00 - 17:30 CET)';
      }
      return {
        isClosed: true,
        label: 'CHIUSO',
        reason
      };
    }

    return {
      isClosed: false,
      label: 'LIVE',
      reason: 'Mercato Aperto (Contrattazioni regolari)'
    };
  }

  /**
   * Generates a mini sparkline SVG curve for an asset's historical price trend.
   */
  function generateSparklineData(quotes, period = '3M', ticker = '', fallbackHolding = null) {
    let filtered = [];
    const now = new Date();
    let cutoff = new Date();

    switch (period) {
      case '1M':
        cutoff.setMonth(now.getMonth() - 1);
        break;
      case '3M':
        cutoff.setMonth(now.getMonth() - 3);
        break;
      case '6M':
        cutoff.setMonth(now.getMonth() - 6);
        break;
      case '8M':
        cutoff.setMonth(now.getMonth() - 8);
        break;
      case '1Y':
        cutoff.setFullYear(now.getFullYear() - 1);
        break;
      case '3Y':
        cutoff.setFullYear(now.getFullYear() - 3);
        break;
      case '5Y':
        cutoff.setFullYear(now.getFullYear() - 5);
        break;
      default:
        cutoff.setMonth(now.getMonth() - 3);
        break;
    }

    const cutoffStr = cutoff.toISOString().split('T')[0];

    if (Array.isArray(quotes) && quotes.length > 0) {
      filtered = quotes.filter(q => q && q.date >= cutoffStr && q.close !== null && !isNaN(q.close));
      if (filtered.length < 2) {
        filtered = quotes.filter(q => q && q.close !== null && !isNaN(q.close));
      }
    }

    // Fallback if no quote history yet: use PMC and Current Price
    if (filtered.length < 2 && fallbackHolding) {
      const pmc = Number(fallbackHolding.pmc) || 0;
      const curr = Number(fallbackHolding.currentPrice) || pmc;
      if (pmc > 0 || curr > 0) {
        filtered = [
          { date: 'Carico', close: pmc || curr },
          { date: 'Attuale', close: curr }
        ];
      }
    }

    if (filtered.length < 2) {
      return {
        svg: `
          <div class="h-9 flex items-center justify-center text-[10px] text-gray-400 font-mono bg-gray-50/50 dark:bg-white/[0.02] rounded-lg">
            Serie storica in aggiornamento
          </div>
        `,
        periodPct: 0,
        isPos: true
      };
    }

    const closes = filtered.map(q => Number(q.close) || 0);
    const minVal = Math.min(...closes);
    const maxVal = Math.max(...closes);
    const range = maxVal - minVal || 1;
    const firstPrice = closes[0];
    const lastPrice = closes[closes.length - 1];
    const periodPct = firstPrice > 0 ? ((lastPrice - firstPrice) / firstPrice) * 100 : 0;
    const isPos = periodPct >= 0;

    const w = 200;
    const h = 42;
    const padY = 5;
    const effH = h - 2 * padY;

    // Resample down to max 60 points for light DOM footprint
    let sample = filtered;
    if (sample.length > 60) {
      const step = Math.ceil(sample.length / 60);
      const resampled = [];
      for (let i = 0; i < sample.length; i += step) {
        resampled.push(sample[i]);
      }
      if (resampled[resampled.length - 1] !== sample[sample.length - 1]) {
        resampled.push(sample[sample.length - 1]);
      }
      sample = resampled;
    }

    const coords = sample.map((p, i) => {
      const x = Number(((i / (sample.length - 1)) * w).toFixed(1));
      const y = Number((h - padY - ((Number(p.close) - minVal) / range) * effH).toFixed(1));
      return { x, y };
    });

    const strokeColor = isPos ? '#10b981' : '#f43f5e';
    const fillColor = isPos ? '#10b981' : '#f43f5e';
    const gradId = `spark-${ticker.replace(/[^a-zA-Z0-9]/g, '_')}-${Math.floor(Math.random() * 100000)}`;

    const linePath = coords.map((c, i) => (i === 0 ? `M ${c.x} ${c.y}` : `L ${c.x} ${c.y}`)).join(' ');
    const areaPath = `${linePath} L ${coords[coords.length - 1].x} ${h} L ${coords[0].x} ${h} Z`;
    const lastCoord = coords[coords.length - 1];

    const svg = `
      <svg viewBox="0 0 ${w} ${h}" class="w-full h-9 overflow-visible" preserveAspectRatio="none">
        <defs>
          <linearGradient id="${gradId}" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="${fillColor}" stop-opacity="0.32"/>
            <stop offset="100%" stop-color="${fillColor}" stop-opacity="0.0"/>
          </linearGradient>
        </defs>
        <path d="${areaPath}" fill="url(#${gradId})" />
        <path d="${linePath}" fill="none" stroke="${strokeColor}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
        <circle cx="${lastCoord.x}" cy="${lastCoord.y}" r="3" fill="${strokeColor}" stroke="#ffffff" stroke-width="1" />
      </svg>
    `;

    return {
      svg,
      periodPct,
      isPos
    };
  }

  /**
   * Merges holdings across portfolios that are included in global totals.
   */
  function getAggregatedHoldings(portfolios) {
    const map = new Map();
    let totalNav = 0;

    for (const p of portfolios) {
      if (!p.include_in_totals) continue;
      totalNav += (p.metrics?.totalValue || 0);
      const holdings = p.metrics?.holdings || [];

      for (const h of holdings) {
        const qty = Number(h.quantity) || 0;
        const cost = (Number(h.pmc || h.costBasis) || 0) * qty;
        const mv = Number(h.marketValue) || 0;
        const pnl = Number(h.unrealizedPnl || h.unrealizedPnL) || 0;

        if (!map.has(h.ticker)) {
          map.set(h.ticker, {
            ...h,
            quantity: qty,
            totalCost: cost,
            marketValue: mv,
            unrealizedPnl: pnl,
            sparkline: h.sparkline || []
          });
        } else {
          const item = map.get(h.ticker);
          item.quantity += qty;
          item.totalCost += cost;
          item.marketValue += mv;
          item.unrealizedPnl += pnl;
          item.marketValueNative = (item.marketValueNative || 0) + (h.marketValueNative || 0);
          item.bookValueNative = (item.bookValueNative || 0) + (h.bookValueNative || 0);
          item.unrealizedPnlNative = (item.unrealizedPnlNative || 0) + (h.unrealizedPnlNative || 0);
          item.dayPnlNative = (item.dayPnlNative || 0) + (h.dayPnlNative || 0);
          item.dayPnlEur = (item.dayPnlEur || 0) + (h.dayPnlEur || 0);
          item.dividends = (item.dividends || 0) + (h.dividends || 0);
          item.dividendsNative = (item.dividendsNative || 0) + (h.dividendsNative || 0);
          item.fxImpact = (item.fxImpact || 0) + (h.fxImpact || 0);
          item.totalReturnNative = (item.totalReturnNative || 0) + (h.totalReturnNative || 0);
          if ((!item.sparkline || item.sparkline.length === 0) && h.sparkline && h.sparkline.length > 0) {
            item.sparkline = h.sparkline;
          }
          if (!item.changeValue && h.changeValue) {
            item.changeValue = h.changeValue;
          }
        }
      }
    }

    const result = Array.from(map.values());
    for (const h of result) {
      h.pmc = h.quantity > 0 ? h.totalCost / h.quantity : 0;
      h.pmcNative = h.quantity > 0 && h.bookValueNative > 0 ? h.bookValueNative / h.quantity : (h.currentPriceNative || h.pmc);
      h.unrealizedPnlPercent = h.totalCost > 0 ? (h.unrealizedPnl / h.totalCost) * 100 : 0;
      h.unrealizedPnlPercentNative = h.bookValueNative > 0 ? (h.unrealizedPnlNative / h.bookValueNative) * 100 : 0;
      h.totalReturnPercentNative = h.bookValueNative > 0 ? (h.totalReturnNative / h.bookValueNative) * 100 : 0;
      h.weight = totalNav > 0 ? (h.marketValue / totalNav) * 100 : 0;
    }

    result.sort((a, b) => b.marketValue - a.marketValue);
    return result;
  }

  /**
   * Fetches real-time quantitative performance metrics (TWRR, MWRR/XIRR, Drawdown, Volatility, Sharpe)
   * for the given portfolio or all portfolios.
   */
  async function fetchPerformanceMetrics(pId) {
    try {
      const res = await fetch(`/api/history/metrics?portfolioId=${pId || 'all'}`);
      if (res.ok) {
        const data = await res.json();
        if (data.success && data.metrics) {
          currentPerformanceMetrics = data.metrics;
          return data.metrics;
        }
      }
    } catch (err) {
      console.warn('[Dashboard Warning] Error fetching performance metrics:', err);
    }
    return null;
  }

  /**
   * Fetches latest scraped portfolio news from backend API and updates news widget.
   */
  async function loadPortfolioNews(forceRefresh = false) {
    if (isNewsLoading) return;
    isNewsLoading = true;
    const iconEl = document.getElementById('news-refresh-icon');
    if (iconEl) iconEl.classList.add('animate-spin');

    try {
      const endpoint = forceRefresh ? '/api/news/refresh' : '/api/news?limit=5';
      const method = forceRefresh ? 'POST' : 'GET';
      const res = await fetch(endpoint, { method });
      if (res.ok) {
        const data = await res.json();
        if (data.success && Array.isArray(data.news)) {
          cachedPortfolioNews = data.news;
        }
      }
    } catch (err) {
      console.warn('[Dashboard Warning] Error fetching news:', err);
    } finally {
      isNewsLoading = false;
      if (iconEl) iconEl.classList.remove('animate-spin');
      const bodyEl = document.getElementById('widget-body-news');
      if (bodyEl && WIDGET_RENDERERS.news) {
        const activeView = getViewData(rawPortfolioData, selectedPortfolioId);
        bodyEl.innerHTML = WIDGET_RENDERERS.news(activeView);
      }
    }
  }

  /**
   * Produces the active view data given the raw API payload and selected portfolio.
   */
  function getViewData(raw, pId) {
    if (!raw || !raw.success) {
      return {
        success: false,
        portfolios: [],
        totals: {},
        activeHoldings: [],
        isAggregate: true,
        performanceMetrics: currentPerformanceMetrics
      };
    }

    if (!pId || pId === 'all') {
      const aggHoldings = getAggregatedHoldings(raw.portfolios || []);
      const aggDayPnl = raw.totals?.dayPnl !== undefined
        ? Number(raw.totals.dayPnl)
        : aggHoldings.reduce((sum, h) => sum + (Number(h.dayPnlEur) || 0), 0);
      const aggTotVal = Number(raw.totals?.totalValue) || 0;
      const aggPrevVal = aggTotVal - aggDayPnl;
      const aggDayPct = raw.totals?.dayPnlPercent !== undefined
        ? Number(raw.totals.dayPnlPercent)
        : (aggPrevVal > 0 ? (aggDayPnl / aggPrevVal) * 100 : 0);

      return {
        success: true,
        isAggregate: true,
        selectedPortfolioId: 'all',
        portfolios: raw.portfolios || [],
        totals: {
          ...raw.totals,
          dayPnl: aggDayPnl,
          dayPnlPercent: aggDayPct
        },
        activeHoldings: aggHoldings,
        performanceMetrics: currentPerformanceMetrics
      };
    }

    const p = (raw.portfolios || []).find(x => String(x.id) === String(pId));
    if (!p) {
      const aggHoldings = getAggregatedHoldings(raw.portfolios || []);
      const aggDayPnl = raw.totals?.dayPnl !== undefined
        ? Number(raw.totals.dayPnl)
        : aggHoldings.reduce((sum, h) => sum + (Number(h.dayPnlEur) || 0), 0);
      const aggTotVal = Number(raw.totals?.totalValue) || 0;
      const aggPrevVal = aggTotVal - aggDayPnl;
      const aggDayPct = raw.totals?.dayPnlPercent !== undefined
        ? Number(raw.totals.dayPnlPercent)
        : (aggPrevVal > 0 ? (aggDayPnl / aggPrevVal) * 100 : 0);

      return {
        success: true,
        isAggregate: true,
        selectedPortfolioId: 'all',
        portfolios: raw.portfolios || [],
        totals: {
          ...raw.totals,
          dayPnl: aggDayPnl,
          dayPnlPercent: aggDayPct
        },
        activeHoldings: aggHoldings,
        performanceMetrics: currentPerformanceMetrics
      };
    }

    const costBasis = (p.metrics?.totalValue || 0) - (p.metrics?.unrealizedPnl || 0) - (p.metrics?.currentCash || 0);
    const unrealizedPnlPercent = costBasis > 0 ? ((p.metrics?.unrealizedPnl || 0) / costBasis) * 100 : 0;
    const portHoldings = p.metrics?.holdings || [];
    const portDayPnl = p.metrics?.dayPnl !== undefined
      ? Number(p.metrics.dayPnl)
      : portHoldings.reduce((sum, h) => sum + (Number(h.dayPnlEur) || 0), 0);
    const portTotVal = Number(p.metrics?.totalValue) || 0;
    const portPrevVal = portTotVal - portDayPnl;
    const portDayPct = p.metrics?.dayPnlPercent !== undefined
      ? Number(p.metrics.dayPnlPercent)
      : (portPrevVal > 0 ? (portDayPnl / portPrevVal) * 100 : 0);

    return {
      success: true,
      isAggregate: false,
      selectedPortfolioId: String(p.id),
      selectedPortfolio: p,
      portfolios: [p],
      totals: {
        totalValue: portTotVal,
        currentCash: p.metrics?.currentCash || 0,
        investedCapital: p.metrics?.investedCapital || 0,
        realizedPnl: p.metrics?.realizedPnl || 0,
        unrealizedPnl: p.metrics?.unrealizedPnl || 0,
        unrealizedPnlPercent: p.metrics?.unrealizedPnlPercent ?? unrealizedPnlPercent,
        totalDividends: p.metrics?.totalDividends || 0,
        dayPnl: portDayPnl,
        dayPnlPercent: portDayPct,
        allocations: p.metrics?.allocations || { byAssetClass: {}, bySector: {}, byRegion: {} }
      },
      activeHoldings: portHoldings,
      performanceMetrics: currentPerformanceMetrics
    };
  }

  /**
   * Groups holdings by Asset Category & Currency for the mobile accordion view (Photos 1 & 2)
   */
  function groupHoldingsByCategory(holdings) {
    const groups = new Map();

    for (const h of holdings) {
      const type = (h.type || 'EQUITY').toUpperCase();
      const curr = (h.currency || 'EUR').toUpperCase();
      let catKey = 'AZIONI EUR';
      let catTitle = 'AZIONI EUR';
      let catCurrency = curr;
      let sortPriority = 10;

      if (type === 'ETF') {
        catKey = curr === 'EUR' ? 'ETF' : `ETF ${curr}`;
        catTitle = catKey;
        sortPriority = 30;
      } else if (type.includes('BOND') || type === 'FIXED_INCOME') {
        catKey = curr === 'EUR' ? 'OBBLIGAZIONI' : `OBBLIGAZIONI ${curr}`;
        catTitle = catKey;
        sortPriority = 40;
      } else if (type === 'CRYPTO') {
        catKey = 'CRYPTO';
        catTitle = 'CRYPTO';
        sortPriority = 50;
      } else if (type.includes('COMMODIT') || type === 'GOLD') {
        catKey = 'MATERIE PRIME / ORO';
        catTitle = 'MATERIE PRIME / ORO';
        sortPriority = 60;
      } else if (type === 'CASH' || type === 'LIQUIDITY') {
        catKey = 'LIQUIDITÀ';
        catTitle = 'LIQUIDITÀ';
        sortPriority = 70;
      } else {
        // Equity / Stocks
        if (curr === 'EUR') {
          catKey = 'AZIONI EUR';
          catTitle = 'AZIONI EUR';
          sortPriority = 10;
        } else if (curr === 'USD') {
          catKey = 'AZIONI USD';
          catTitle = 'AZIONI USD';
          sortPriority = 20;
        } else {
          catKey = `AZIONI ${curr}`;
          catTitle = `AZIONI ${curr}`;
          sortPriority = 25;
        }
      }

      if (!groups.has(catKey)) {
        groups.set(catKey, {
          id: catKey.replace(/[^a-zA-Z0-9]/g, '_'),
          key: catKey,
          title: catTitle,
          currency: catCurrency,
          sortPriority,
          holdings: []
        });
      }
      groups.get(catKey).holdings.push(h);
    }

    const categories = Array.from(groups.values());
    categories.sort((a, b) => a.sortPriority - b.sortPriority);

    for (const cat of categories) {
      const isUSD = cat.currency === 'USD';
      const isNonEur = cat.currency !== 'EUR';
      const currSym = isUSD ? '$' : (cat.currency === 'EUR' ? '€' : cat.currency);

      let totMarketVal = 0;
      let totCostBasis = 0;
      let totUnrealizedPnl = 0;
      let totDayPnl = 0;

      for (const h of cat.holdings) {
        const isToday = isHoldingQuotedToday(h);
        const isClosed = !isToday;

        const mv = Number(isNonEur && h.marketValueNative !== undefined ? h.marketValueNative : h.marketValue) || 0;
        const cost = (Number(isNonEur && h.pmcNative !== undefined ? h.pmcNative : (h.pmc || h.costBasis)) || 0) * (Number(h.quantity) || 0);
        const pnl = Number(isNonEur && h.unrealizedPnlNative !== undefined ? h.unrealizedPnlNative : h.unrealizedPnl) || 0;

        let dayVal = 0;
        if (isToday && !isClosed) {
          dayVal = Number(isNonEur && h.dayPnlNative !== undefined ? h.dayPnlNative : h.dayPnlEur) || 0;
          if (!dayVal && h.changeValue && h.quantity) {
            dayVal = Number(h.changeValue) * Number(h.quantity);
          }
        }

        totMarketVal += mv;
        totCostBasis += cost;
        totUnrealizedPnl += pnl;
        totDayPnl += dayVal;
      }

      const totUnrealizedPnlPct = totCostBasis > 0 ? (totUnrealizedPnl / totCostBasis) * 100 : 0;

      cat.totMarketVal = totMarketVal;
      cat.totCostBasis = totCostBasis;
      cat.totUnrealizedPnl = totUnrealizedPnl;
      cat.totUnrealizedPnlPct = totUnrealizedPnlPct;
      cat.totDayPnl = totDayPnl;
      cat.currSym = currSym;

      cat.holdings.sort((a, b) => {
        const aClosed = !isHoldingQuotedToday(a);
        const bClosed = !isHoldingQuotedToday(b);
        if (!aClosed && bClosed) return -1;
        if (aClosed && !bClosed) return 1;

        if (!aClosed && !bClosed) {
          const aPct = Number(a.changePercent) || 0;
          const bPct = Number(b.changePercent) || 0;
          if (bPct !== aPct) return bPct - aPct;
        }
        return (a.ticker || '').localeCompare(b.ticker || '');
      });
    }

    return categories;
  }

  // Widget HTML Renderers for each of the widgets
  const WIDGET_RENDERERS = {
    // 1. Portfolio Value
    value: (data) => {
      const t = data.totals || {};
      const pct = Number(t.unrealizedPnlPercent) || 0;
      const isPos = pct >= 0;
      const label = data.isAggregate ? 'Patrimonio' : (data.selectedPortfolio?.name || 'Patrimonio');
      return `
        <div class="h-full flex flex-col justify-between">
          <div class="flex items-center justify-between">
            <span class="text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400 truncate max-w-[200px]">${label}</span>
            <span class="badge-profit text-[10px] uppercase font-mono">${data.isAggregate ? 'Aggr.' : 'Conto'}</span>
          </div>
          <div class="my-2">
            <div class="text-3xl font-bold font-mono text-gray-900 dark:text-white tabular-nums tracking-tight">${formatEur(t.totalValue)}</div>
          </div>
          <div class="flex items-center space-x-2 text-xs">
            <span class="${isPos ? 'badge-profit' : 'badge-loss'} tabular-nums">${formatPct(pct)}</span>
            <span class="text-gray-400 font-mono text-[11px]">${formatEur(t.unrealizedPnl)} lat.</span>
          </div>
        </div>
      `;
    },

    // 2. Day Change (Variazione Giornaliera in Valore e %)
    dayChange: (data) => {
      const t = data.totals || {};
      const dayVal = Number(t.dayPnl) || 0.0;
      const totalVal = Number(t.totalValue) || 0.0;
      const prevVal = totalVal - dayVal;
      const dayPct = t.dayPnlPercent !== undefined && !isNaN(t.dayPnlPercent)
        ? Number(t.dayPnlPercent)
        : (prevVal > 0 ? (dayVal / prevVal) * 100.0 : 0.0);

      const isPos = dayVal >= 0;
      const isAgg = data.isAggregate;
      const subtitle = isAgg ? 'Aggr.' : (data.selectedPortfolio?.name || 'Conto');

      return `
        <div class="h-full flex flex-col justify-between">
          <div class="flex items-center justify-between">
            <span class="text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400 truncate max-w-[150px]">Var. Oggi</span>
            <span class="px-1.5 py-0.5 rounded text-[10px] font-mono font-semibold uppercase ${isPos ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border border-emerald-500/20' : 'bg-rose-500/10 text-rose-700 dark:text-rose-400 border border-rose-500/20'}">
              ${formatPct(dayPct)}
            </span>
          </div>
          <div class="my-2">
            <div class="text-2xl font-bold font-mono tabular-nums tracking-tight ${isPos ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}">
              ${formatEurSignedDec(dayVal, 2)}
            </div>
          </div>
          <div class="flex items-center justify-between text-[11px] font-mono text-gray-400">
            <span>Prec: ${formatEur(prevVal)}</span>
            <span class="text-[10px] truncate max-w-[110px]" title="${subtitle}">${subtitle}</span>
          </div>
        </div>
      `;
    },

    // 2. Cash
    cash: (data) => {
      const t = data.totals || {};
      const cashPct = t.totalValue > 0 ? (t.currentCash / t.totalValue) * 100 : 0;
      return `
        <div class="h-full flex flex-col justify-between">
          <div class="flex items-center justify-between">
            <span class="text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">Liquidità</span>
            <span class="text-[10px] font-mono px-1.5 py-0.5 rounded bg-gray-100 dark:bg-white/10 text-gray-600 dark:text-gray-300 font-semibold">${cashPct.toFixed(1)}%</span>
          </div>
          <div class="my-2 text-2xl font-bold font-mono text-gray-900 dark:text-white tabular-nums tracking-tight">${formatEur(t.currentCash)}</div>
          <div class="flex items-center justify-between text-[11px] font-mono text-gray-400">
            <span>Disponibile</span>
            <span>c/c</span>
          </div>
        </div>
      `;
    },

    // 3. Invested Capital
    invested: (data) => {
      const t = data.totals || {};
      return `
        <div class="h-full flex flex-col justify-between">
          <div class="flex items-center justify-between">
            <span class="text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">Versato</span>
            <span class="text-[10px] font-mono px-1.5 py-0.5 rounded bg-gray-100 dark:bg-white/10 text-gray-600 dark:text-gray-300 font-semibold">Netto</span>
          </div>
          <div class="my-2 text-2xl font-bold font-mono text-gray-900 dark:text-white tabular-nums tracking-tight">${formatEur(t.investedCapital)}</div>
          <div class="flex items-center justify-between text-[11px] font-mono text-gray-400">
            <span>Depositi netti</span>
            <span>Capitale</span>
          </div>
        </div>
      `;
    },

    // 4. Book Cost (PMC Totale)
    bookCost: (data) => {
      const t = data.totals || {};
      const costBasis = (t.totalValue || 0) - (t.unrealizedPnl || 0) - (t.currentCash || 0);
      return `
        <div class="h-full flex flex-col justify-between">
          <div class="flex items-center justify-between">
            <span class="text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">Carico (PMC)</span>
            <span class="text-[10px] font-mono px-1.5 py-0.5 rounded bg-gray-100 dark:bg-white/10 text-gray-600 dark:text-gray-300 font-semibold">PMC</span>
          </div>
          <div class="my-2 text-2xl font-bold font-mono text-gray-900 dark:text-white tabular-nums tracking-tight">${formatEur(Math.max(0, costBasis))}</div>
          <div class="flex items-center justify-between text-[11px] font-mono text-gray-400">
            <span>Costo carico</span>
            <span>Fiscale</span>
          </div>
        </div>
      `;
    },

    // 5. Total PnL
    pnl: (data) => {
      const t = data.totals || {};
      const pnl = Number(t.unrealizedPnl) || 0;
      const pct = Number(t.unrealizedPnlPercent) || 0;
      const isPos = pnl >= 0;
      return `
        <div class="h-full flex flex-col justify-between">
          <div class="flex items-center justify-between">
            <span class="text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">P&L Totale</span>
            <span class="px-1.5 py-0.5 rounded text-[10px] font-mono font-semibold uppercase ${isPos ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border border-emerald-500/20' : 'bg-rose-500/10 text-rose-700 dark:text-rose-400 border border-rose-500/20'}">
              ${formatPct(pct)}
            </span>
          </div>
          <div class="my-2 text-2xl font-bold font-mono tabular-nums tracking-tight ${isPos ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}">${formatEur(pnl)}</div>
          <div class="flex items-center justify-between text-[11px] font-mono text-gray-400">
            <span>Plus/Minus</span>
            <span>Titoli</span>
          </div>
        </div>
      `;
    },

    // 6. Performance & Net Worth History Chart
    performanceChart: (data) => {
      const isAgg = data.isAggregate;
      const subtitle = isAgg ? 'Tutti i conti' : (data.selectedPortfolio?.name || 'Conto');
      const timeframes = ['1M', '3M', '6M', '1Y', '3Y', '5Y', 'ALL'];

      const tfButtons = timeframes.map(tf => `
        <button type="button"
          class="perf-tf-btn px-2.5 py-1 rounded-lg text-[10px] font-mono font-medium transition ${activeHistoryRange === tf ? 'bg-emerald-600 text-white font-bold shadow-xs' : 'text-gray-500 hover:text-gray-900 dark:text-gray-400 dark:hover:text-white bg-gray-100 dark:bg-white/5'}"
          data-perf-range="${tf}">
          ${tf}
        </button>
      `).join('');

      return `
        <div class="h-full flex flex-col justify-between">
          <!-- Widget Header Controls -->
          <div class="flex flex-wrap items-center justify-between gap-2 pb-2 border-b border-gray-100 dark:border-white/5">
            <div class="flex items-center space-x-3">
              <div>
                <div class="flex items-center space-x-2">
                  <span class="text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">Performance</span>
                  <span class="badge-profit text-[10px] uppercase font-mono">${isAgg ? 'Aggr.' : 'Conto'}</span>
                </div>
                <div class="text-[11px] font-mono text-gray-400 truncate max-w-[220px]">${subtitle}</div>
              </div>
            </div>

            <!-- Controls: Metric Toggle + Timeframe Buttons -->
            <div class="flex flex-wrap items-center gap-2">
              <!-- Metric Toggle -->
              <div class="inline-flex rounded-lg bg-gray-100 dark:bg-white/5 p-0.5 text-xs font-mono">
                <button type="button" data-perf-metric="NAV" class="perf-metric-btn px-2.5 py-1 rounded-md transition text-[11px] ${activeHistoryMetric === 'NAV' ? 'bg-white dark:bg-[#1f1f22] text-gray-900 dark:text-white font-bold shadow-xs' : 'text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white'}">
                  Valore
                </button>
                <button type="button" data-perf-metric="RETURN" class="perf-metric-btn px-2.5 py-1 rounded-md transition text-[11px] ${activeHistoryMetric === 'RETURN' ? 'bg-white dark:bg-[#1f1f22] text-gray-900 dark:text-white font-bold shadow-xs' : 'text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white'}">
                  Rendimento
                </button>
              </div>

              <!-- Timeframe Selector -->
              <div class="inline-flex rounded-lg space-x-1">
                ${tfButtons}
              </div>

              <!-- Recalculate Performance on Demand Button -->
              <button type="button" id="btn-recalculate-perf" data-action="recalculate-perf" title="Ricalcola e ricostruisci performance storica su richiesta" class="px-2 py-1 rounded-md text-[11px] font-mono border border-gray-200 dark:border-white/10 bg-white dark:bg-[#1f1f22] text-gray-600 dark:text-gray-300 hover:text-emerald-600 dark:hover:text-emerald-400 hover:border-emerald-500/30 transition flex items-center space-x-1 shadow-xs cursor-pointer">
                <svg id="icon-recalc-perf" class="w-3.5 h-3.5 text-gray-400 hover:text-emerald-500 transition-transform" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                </svg>
                <span class="hidden sm:inline font-semibold">Ricalcola</span>
              </button>
            </div>
          </div>

          <!-- Dynamic Key Metric Header -->
          <div class="flex items-center justify-between my-2 px-1">
            <div class="flex items-baseline space-x-3">
              <span id="perf-display-val" class="text-2xl font-bold font-mono text-gray-900 dark:text-white tabular-nums tracking-tight">--</span>
              <span id="perf-display-badge" class="badge-profit text-xs font-mono font-semibold">--</span>
            </div>
            <div class="flex items-center space-x-4 text-[11px] font-mono text-gray-400">
              <span id="perf-display-range-lbl">Per.: ${activeHistoryRange}</span>
              <span id="perf-display-dd" class="hidden sm:inline">Max DD: --</span>
            </div>
          </div>

          <!-- Chart Area -->
          <div class="flex-1 relative min-h-[160px] w-full">
            <canvas id="chart-performance"></canvas>
            <div id="chart-perf-loading" class="hidden absolute inset-0 bg-white/50 dark:bg-black/40 backdrop-blur-xs flex items-center justify-center text-xs font-mono text-gray-500">
              Caricamento...
            </div>
          </div>
        </div>
      `;
    },

    // 7. Accounts / Brokers Donut
    accounts: (data) => `
      <div class="h-full flex flex-col">
        <div class="flex items-center justify-between mb-2">
          <span class="text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">Conti</span>
          <span class="text-[10px] font-mono text-gray-400">${data.isAggregate ? 'Ripart.' : 'Asset/Cash'}</span>
        </div>
        <div class="flex-1 relative min-h-[140px]">
          <canvas id="chart-accounts"></canvas>
        </div>
      </div>
    `,

    // 7. Asset Classes Donut
    classes: () => `
      <div class="h-full flex flex-col">
        <span class="text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400 mb-2">Asset Class</span>
        <div class="flex-1 relative min-h-[140px]">
          <canvas id="chart-classes"></canvas>
        </div>
      </div>
    `,

    // 8. Geographic Regions Donut
    regions: () => `
      <div class="h-full flex flex-col">
        <span class="text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400 mb-2">Aree Geo</span>
        <div class="flex-1 relative min-h-[140px]">
          <canvas id="chart-regions"></canvas>
        </div>
      </div>
    `,

    // 9. GICS 11 Sectors
    sectors: () => `
      <div class="h-full flex flex-col">
        <span class="text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400 mb-2">Settori</span>
        <div class="flex-1 relative min-h-[140px]">
          <canvas id="chart-sectors"></canvas>
        </div>
      </div>
    `,

    // 10. Portfolio Composition Asset Cards
    composition: (data) => {
      const holdings = data.activeHoldings || [];
      const totalNav = data.totals?.totalValue || 1;

      // Sort holdings: active/open holdings first, closed/inactive holdings at the end!
      // Within each category, sort according to activeCompositionSort
      const sortedHoldings = [...holdings];
      sortedHoldings.sort((a, b) => {
        const aClosed = isAssetMarketClosed(a);
        const bClosed = isAssetMarketClosed(b);

        // Put closed markets at the end of the active sort order!
        if (!aClosed && bClosed) return -1;
        if (aClosed && !bClosed) return 1;

        const aDayPct = Number(a.changePercent !== undefined ? a.changePercent : (a.change24h || 0)) || 0;
        const bDayPct = Number(b.changePercent !== undefined ? b.changePercent : (b.change24h || 0)) || 0;

        switch (activeCompositionSort) {
          case 'day_desc':
            return bDayPct - aDayPct;
          case 'day_asc':
            return aDayPct - bDayPct;
          case 'weight_desc':
            return (b.weight || b.marketValue || 0) - (a.weight || a.marketValue || 0);
          case 'ticker_asc':
            return (a.ticker || '').localeCompare(b.ticker || '');
          case 'tot_desc':
            return (b.unrealizedPnlPercent || 0) - (a.unrealizedPnlPercent || 0);
          default:
            return bDayPct - aDayPct;
        }
      });

      const closedCount = sortedHoldings.filter(h => isAssetMarketClosed(h)).length;

      const periods = ['1M', '3M', '6M', '8M', '1Y', '3Y', '5Y'];

      const periodButtons = periods.map(p => `
        <button type="button"
          class="px-2 py-0.5 rounded transition text-[10px] font-mono ${activeSparklinePeriod === p ? 'bg-white dark:bg-white/10 text-gray-900 dark:text-white font-bold shadow-xs' : 'text-gray-400 hover:text-gray-800 dark:hover:text-gray-200'}"
          data-sparkline-period="${p}">
          ${p}
        </button>
      `).join('');

      return `
        <div class="h-full flex flex-col">
          <div class="flex flex-wrap items-center justify-between gap-2 mb-3">
            <div class="flex items-center space-x-2">
              <span class="text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">Composizione</span>
              <span class="text-xs font-mono text-gray-400">${sortedHoldings.length} pos.</span>
              ${closedCount > 0 ? `
                <span class="text-[10px] font-mono px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-700 dark:text-amber-400 font-semibold border border-amber-500/20" title="${closedCount} titoli in mercati chiusi o senza contrattazioni negli ultimi 5m (posizionati a fine elenco)">
                  ${closedCount} Chiusi
                </span>
              ` : `
                <span class="text-[10px] font-mono px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 font-semibold border border-emerald-500/20" title="Tutti i mercati dei titoli sono aperti">
                  Tutti Aperti
                </span>
              `}
            </div>

            <!-- Controls: Sort Selector + Timeframe Selector -->
            <div class="flex flex-wrap items-center gap-2">
              <!-- Sort Selector -->
              <div class="flex items-center space-x-1">
                <span class="text-[10px] font-mono text-gray-400 hidden sm:inline">Ordina:</span>
                <div class="inline-flex rounded-lg bg-gray-100 dark:bg-white/5 p-0.5 text-[10px] font-mono border border-gray-200/60 dark:border-white/5">
                  <button type="button" data-comp-sort="day_desc"
                    class="px-2 py-0.5 rounded transition ${activeCompositionSort === 'day_desc' ? 'bg-white dark:bg-white/10 text-emerald-600 dark:text-emerald-400 font-bold shadow-xs' : 'text-gray-400 hover:text-gray-800 dark:hover:text-gray-200'}"
                    title="Ordina per variazione % giornaliera (migliori in alto)">
                    DAY ▼
                  </button>
                  <button type="button" data-comp-sort="day_asc"
                    class="px-2 py-0.5 rounded transition ${activeCompositionSort === 'day_asc' ? 'bg-white dark:bg-white/10 text-rose-600 dark:text-rose-400 font-bold shadow-xs' : 'text-gray-400 hover:text-gray-800 dark:hover:text-gray-200'}"
                    title="Ordina per variazione % giornaliera (peggiori in alto)">
                    DAY ▲
                  </button>
                  <button type="button" data-comp-sort="weight_desc"
                    class="px-2 py-0.5 rounded transition ${activeCompositionSort === 'weight_desc' ? 'bg-white dark:bg-white/10 text-gray-900 dark:text-white font-bold shadow-xs' : 'text-gray-400 hover:text-gray-800 dark:hover:text-gray-200'}"
                    title="Ordina per peso nel portafoglio">
                    Peso
                  </button>
                  <button type="button" data-comp-sort="ticker_asc"
                    class="px-2 py-0.5 rounded transition ${activeCompositionSort === 'ticker_asc' ? 'bg-white dark:bg-white/10 text-gray-900 dark:text-white font-bold shadow-xs' : 'text-gray-400 hover:text-gray-800 dark:hover:text-gray-200'}"
                    title="Ordina alfabeticamente per Ticker">
                    A-Z
                  </button>
                </div>
              </div>

              <!-- Timeframe selector with 3M default -->
              <div class="flex items-center space-x-0.5 bg-gray-100 dark:bg-white/5 p-0.5 rounded-lg border border-gray-200/60 dark:border-white/5" title="Seleziona orizzonte temporale del mini grafico storico">
                ${periodButtons}
              </div>
            </div>
          </div>

          <div class="flex-1 overflow-y-auto grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3.5 p-1.5 no-scrollbar">
            ${sortedHoldings.map((h, idx) => {
              const bgCol = PASTEL_COLORS[idx % PASTEL_COLORS.length];
              const weightPct = (h.marketValue / totalNav) * 100;
              const curr = (h.currency || 'EUR').toUpperCase();
              const isNonEur = curr !== 'EUR';
              const isUSD = curr === 'USD';
              const statusInfo = getAssetMarketStatusInfo(h);
              const isClosed = statusInfo.isClosed;

              // Sparkline mini chart
              const sparkData = generateSparklineData(h.sparkline, activeSparklinePeriod, h.ticker, h);

              // DAY Variation: strictly 0 if holding has not traded in today's regular session
              const isToday = isHoldingQuotedToday(h);
              const dayPct = isToday ? (Number(h.changePercent !== undefined ? h.changePercent : (h.change24h || 0)) || 0) : 0;
              const dayNative = isToday ? (h.dayPnlNative !== undefined ? h.dayPnlNative : ((Number(h.changeValue) || 0) * (Number(h.quantity) || 0))) : 0;
              let dayEur = 0;
              if (isToday) {
                dayEur = h.dayPnlEur !== undefined ? h.dayPnlEur : 0;
                if (!dayEur && h.changeValue && h.quantity) {
                  dayEur = Number(h.changeValue) * Number(h.quantity);
                } else if (!dayEur && dayPct !== 0 && h.marketValue) {
                  dayEur = h.marketValue - (h.marketValue / (1 + (dayPct / 100)));
                }
              }
              const isDayPos = dayPct >= 0;

              // Dynamic gradient background style for open markets, or grey background when market is closed
              const dayStyle = getDayVarCardStyle(dayPct, isClosed);

              // Complessiva (Total P&L) Variation
              const totPct = Number(isNonEur && h.unrealizedPnlPercentNative !== undefined ? h.unrealizedPnlPercentNative : h.unrealizedPnlPercent) || 0;
              const totNative = isNonEur && h.unrealizedPnlNative !== undefined ? h.unrealizedPnlNative : Number(h.unrealizedPnl || 0);
              const totEur = Number(h.unrealizedPnl || 0);
              const isTotPos = totPct >= 0;

              // Native currency formatters (thousands abbreviated with k)
              const fmtNative = (v) => {
                const num = Number(v) || 0;
                const abs = Math.abs(num);
                const sign = num < 0 ? '-' : '';
                if (abs >= 1000) {
                  return `${sign}${(abs / 1000).toFixed(1).replace('.', ',')}k`;
                }
                const s = Math.round(abs).toLocaleString('it-IT');
                return isUSD ? `${sign}${s} USD` : (isNonEur ? `${sign}${s} ${curr}` : `${sign}€ ${s}`);
              };

              const fmtNativeSigned = (v) => {
                const num = Number(v) || 0;
                const abs = Math.abs(num);
                const sign = num > 0 ? '+' : (num < 0 ? '-' : '');
                if (abs >= 1000) {
                  return `${sign}${(abs / 1000).toFixed(1).replace('.', ',')}k`;
                }
                const s = Math.abs(Math.round(num)).toLocaleString('it-IT');
                return isUSD ? `${sign}${s} USD` : (isNonEur ? `${sign}${s} ${curr}` : `${sign}€ ${s}`);
              };

              const displayMv = isNonEur && h.marketValueNative !== undefined ? h.marketValueNative : h.marketValue;
              const displayPrice = isNonEur && h.currentPriceNative !== undefined ? h.currentPriceNative : h.currentPrice;

              return `
                <div class="pt-5 pb-4 px-5 rounded-2xl border ${isClosed ? 'border-amber-400/40 dark:border-amber-500/30 bg-amber-50/[0.12] dark:bg-[#1a1917]' : 'border-gray-200/70 dark:border-white/10 bg-white dark:bg-[#18181a]'} flex flex-col justify-between transition hover:shadow-xl hover:border-emerald-500/60 dark:hover:border-emerald-500/60 shadow-sm cursor-pointer group"
                     style="border-top: 3px solid ${isClosed ? '#f59e0b' : bgCol};"
                     data-open-asset="${h.ticker}">
                  <!-- Header Titolo con Ticker, Tipo, Valuta nativa, Stato Mercato e Info ↗ -->
                  <div class="space-y-1.5 mb-1">
                    <div class="flex items-center justify-between">
                      <div class="flex items-center space-x-1.5 truncate">
                        <span class="font-bold font-mono text-xs sm:text-sm text-gray-900 dark:text-white tracking-tight group-hover:text-emerald-600 dark:group-hover:text-emerald-400 transition-colors">${h.ticker}</span>
                        <span class="text-[9px] font-mono px-1.5 py-0.5 rounded bg-gray-100 dark:bg-white/10 text-gray-500 dark:text-gray-400 font-semibold uppercase">${h.type || 'EQUITY'}</span>
                        ${isNonEur ? `<span class="text-[9px] font-mono px-1.5 py-0.5 rounded font-bold ${isUSD ? 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/20' : 'bg-blue-500/10 text-blue-600 dark:text-blue-400 border border-blue-500/20'}">${curr}</span>` : ''}
                        ${isClosed ? `
                          <span class="inline-flex items-center space-x-1 px-1.5 py-0.5 rounded text-[9px] font-mono font-bold bg-amber-500/15 text-amber-700 dark:text-amber-400 border border-amber-500/30 shrink-0" title="${statusInfo.reason}">
                            <span class="w-1.5 h-1.5 rounded-full bg-amber-500"></span>
                            <span>CHIUSO</span>
                          </span>
                        ` : `
                          <span class="inline-flex items-center space-x-1 px-1.5 py-0.5 rounded text-[9px] font-mono font-semibold bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border border-emerald-500/20 shrink-0" title="${statusInfo.reason}">
                            <span class="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse"></span>
                            <span>LIVE</span>
                          </span>
                        `}
                      </div>
                      <div class="flex items-center space-x-1 shrink-0">
                        <span class="text-[9px] font-mono px-1.5 py-0.5 rounded bg-gray-100 dark:bg-white/10 text-gray-400 group-hover:text-emerald-600 dark:group-hover:text-emerald-400 group-hover:bg-emerald-50 dark:group-hover:bg-emerald-950/40 transition flex items-center space-x-0.5" title="Espandi scheda dettagliata asset">
                          <span>Info</span>
                          <span>↗</span>
                        </span>
                        <span class="text-[10px] font-mono px-2 py-0.5 rounded-full bg-gray-100 dark:bg-white/10 font-bold text-gray-700 dark:text-gray-300">${weightPct.toFixed(1)}%</span>
                      </div>
                    </div>
                    <div class="text-xs text-gray-500 dark:text-gray-400 truncate" title="${h.name}">${h.name}</div>
                    
                    <!-- Valore & Prezzo (in USD per titoli nativi USD) -->
                    <div class="flex items-baseline justify-between pt-1 text-xs font-mono">
                      <div>
                        <span class="text-sm sm:text-base font-bold text-gray-900 dark:text-white tabular-nums">${fmtNative(displayMv)}</span>
                        ${isNonEur ? `<span class="text-[10px] text-gray-400 block sm:inline sm:ml-1 tabular-nums">(≈ ${formatEur(h.marketValue)})</span>` : ''}
                      </div>
                      <div class="text-right">
                        <span class="text-xs text-gray-400 tabular-nums">${fmtNative(displayPrice)}</span>
                      </div>
                    </div>
                  </div>

                  <!-- Mini Grafico Storico -->
                  <div class="my-3 pt-2 border-t border-gray-100 dark:border-white/5">
                    <div class="flex items-center justify-between text-[10px] font-mono text-gray-400 mb-1.5">
                      <span>Trend ${activeSparklinePeriod}</span>
                      <span class="${sparkData.periodPct >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'} font-semibold tabular-nums">
                        ${formatPct(sparkData.periodPct)}
                      </span>
                    </div>
                    <div class="w-full">
                      ${sparkData.svg}
                    </div>
                  </div>

                  <!-- Sotto: Variazione DAY con gradiente dinamico verde-rosso e Variazione Complessiva -->
                  <div class="pt-2.5 border-t border-gray-100 dark:border-white/5 grid grid-cols-2 gap-2 text-xs font-mono tabular-nums">
                    <div class="p-2 sm:p-2.5 rounded-xl border transition-all shadow-2xs"
                         style="${dayStyle.style}">
                      <div class="text-[9px] uppercase tracking-wider ${dayStyle.titleCls} flex items-center justify-between">
                        <span>DAY</span>
                        ${isClosed ? `<span class="text-[8px] font-bold text-amber-600 dark:text-amber-400">CHIUSO</span>` : `<span class="text-[8px] font-semibold text-emerald-600 dark:text-emerald-400">LIVE</span>`}
                      </div>
                      <div class="text-[11px] leading-tight mt-0.5 ${dayStyle.valCls}">
                        ${formatPct(dayPct)}
                      </div>
                      <div class="text-[10px] ${dayStyle.subCls}">
                        ${isNonEur ? fmtNativeSigned(dayNative) : formatEurSigned(dayEur)}
                      </div>
                    </div>

                    <div class="p-2 sm:p-2.5 rounded-xl bg-gray-50 dark:bg-white/[0.03] border border-gray-100 dark:border-white/5">
                      <div class="text-[9px] font-bold uppercase text-gray-400 tracking-wider">Totale</div>
                      <div class="text-[11px] font-bold ${isTotPos ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'} leading-tight mt-0.5">
                        ${formatPct(totPct)}
                      </div>
                      <div class="text-[10px] ${isTotPos ? 'text-emerald-600/80 dark:text-emerald-400/80' : 'text-rose-600/80 dark:text-rose-400/80'}">
                        ${isNonEur ? fmtNativeSigned(totNative) : formatEurSigned(totEur)}
                      </div>
                    </div>
                  </div>
                </div>
              `;
            }).join('') || '<div class="col-span-full text-center py-12 text-xs text-gray-400 font-mono">Nessun titolo in portafoglio. Aggiungi il tuo primo movimento!</div>'}
          </div>
        </div>
      `;
    },

    // 10b. Titoli Compatti (Var. Day in 1 Sola Riga per Asset)
    holdingsCompact: (data) => {
      const holdings = data.activeHoldings || [];
      if (holdings.length === 0) {
        return `
          <div class="h-full flex flex-col items-center justify-center p-6 text-center">
            <span class="text-xs font-mono text-gray-400">Nessun titolo in portafoglio</span>
          </div>
        `;
      }

      const totalNav = data.totals?.totalValue || 1;
      const sortedHoldings = [...holdings];
      const closedCount = sortedHoldings.filter(h => !isHoldingQuotedToday(h)).length;

      sortedHoldings.sort((a, b) => {
        const aClosed = !isHoldingQuotedToday(a);
        const bClosed = !isHoldingQuotedToday(b);
        const aIsToday = isHoldingQuotedToday(a);
        const bIsToday = isHoldingQuotedToday(b);

        // In day sorts, open and today-quoted assets come first
        if (activeCompactSort === 'day_desc' || activeCompactSort === 'day_asc') {
          const aActive = aIsToday && !aClosed;
          const bActive = bIsToday && !bClosed;
          if (aActive && !bActive) return -1;
          if (!aActive && bActive) return 1;

          const aDayPct = aActive ? (Number(a.changePercent) || 0) : 0;
          const bDayPct = bActive ? (Number(b.changePercent) || 0) : 0;
          if (activeCompactSort === 'day_desc') {
            if (bDayPct !== aDayPct) return bDayPct - aDayPct;
            const aVal = Number(a.dayPnlEur) || 0;
            const bVal = Number(b.dayPnlEur) || 0;
            return bVal - aVal;
          } else {
            if (aDayPct !== bDayPct) return aDayPct - bDayPct;
            const aVal = Number(a.dayPnlEur) || 0;
            const bVal = Number(b.dayPnlEur) || 0;
            return aVal - bVal;
          }
        }

        if (activeCompactSort === 'value_desc') {
          return (Number(b.marketValue) || 0) - (Number(a.marketValue) || 0);
        }

        if (activeCompactSort === 'ticker_asc') {
          return (a.ticker || '').localeCompare(b.ticker || '');
        }

        return 0;
      });

      return `
        <div class="h-full flex flex-col justify-between select-none">
          <!-- Header compatto con contatore e filtri ordinamento -->
          <div class="flex flex-wrap items-center justify-between gap-1.5 pb-2.5 border-b border-gray-100 dark:border-white/5 shrink-0">
            <div class="flex items-center space-x-2 min-w-0">
              <span class="text-xs sm:text-sm font-bold font-mono tracking-wider text-gray-800 dark:text-gray-100 uppercase truncate">
                Titoli (Var. Day)
              </span>
              <span class="text-[10px] font-mono px-2 py-0.5 rounded-full bg-gray-100 dark:bg-white/10 text-gray-600 dark:text-gray-300 font-semibold shrink-0">
                ${sortedHoldings.length} ${closedCount > 0 ? `<span class="text-amber-600 dark:text-amber-400">(${closedCount} chiusi)</span>` : ''}
              </span>
            </div>

            <!-- Bottoni Ordinamento -->
            <div class="inline-flex p-0.5 rounded-lg bg-gray-100 dark:bg-white/5 border border-gray-200/60 dark:border-white/10 text-[10px] font-mono shrink-0">
              <button type="button" data-compact-sort="day_desc"
                class="px-2 py-0.5 rounded transition ${activeCompactSort === 'day_desc' ? 'bg-white dark:bg-white/15 text-gray-900 dark:text-white font-bold shadow-xs' : 'text-gray-400 hover:text-gray-700 dark:hover:text-gray-300'}"
                title="Ordina per variazione giornaliera migliore (1D)">
                Day ▼
              </button>
              <button type="button" data-compact-sort="day_asc"
                class="px-2 py-0.5 rounded transition ${activeCompactSort === 'day_asc' ? 'bg-white dark:bg-white/15 text-gray-900 dark:text-white font-bold shadow-xs' : 'text-gray-400 hover:text-gray-700 dark:hover:text-gray-300'}"
                title="Ordina per variazione giornaliera peggiore (1D)">
                Day ▲
              </button>
              <button type="button" data-compact-sort="value_desc"
                class="px-2 py-0.5 rounded transition ${activeCompactSort === 'value_desc' ? 'bg-white dark:bg-white/15 text-gray-900 dark:text-white font-bold shadow-xs' : 'text-gray-400 hover:text-gray-700 dark:hover:text-gray-300'}"
                title="Ordina per controvalore totale">
                Valore
              </button>
              <button type="button" data-compact-sort="ticker_asc"
                class="px-2 py-0.5 rounded transition ${activeCompactSort === 'ticker_asc' ? 'bg-white dark:bg-white/15 text-gray-900 dark:text-white font-bold shadow-xs' : 'text-gray-400 hover:text-gray-700 dark:hover:text-gray-300'}"
                title="Ordina alfabeticamente A-Z">
                A-Z
              </button>
            </div>
          </div>

          <!-- Intestazione colonne a 4 sezioni (1 riga) -->
          <div class="px-2 py-1.5 bg-gray-50/80 dark:bg-[#18181b] border-b border-gray-200/60 dark:border-white/5 text-[10px] sm:text-[11px] font-extrabold font-mono text-gray-500 uppercase tracking-wider shrink-0"
               style="display: grid; grid-template-columns: 1.15fr 1.15fr 1.05fr 1.25fr; align-items: center;">
            <div class="text-left pl-0.5">TICKER</div>
            <div class="text-right">PREZZO</div>
            <div class="text-right pr-1">% DAY</div>
            <div class="text-right pr-0.5">Δ VALORE</div>
          </div>

          <!-- Lista Titoli in Singola Riga -->
          <div class="flex-1 overflow-y-auto divide-y divide-gray-100 dark:divide-white/5 no-scrollbar">
            ${sortedHoldings.map(h => {
              const isToday = isHoldingQuotedToday(h);
              const isClosed = !isToday;
              const isMarketClosed = isAssetMarketClosed(h);
              const isNonEur = h.currency && h.currency !== 'EUR';
              const currSym = h.currency === 'USD' ? '$' : (h.currency === 'EUR' ? '€' : (h.currency || '€'));

              const rawPrice = Number(isNonEur && h.currentPriceNative !== undefined ? h.currentPriceNative : h.currentPrice) || 0;
              const priceStr = rawPrice.toLocaleString('it-IT', {
                minimumFractionDigits: 2,
                maximumFractionDigits: 2
              }) + ' ' + currSym;

              let dayVal = 0;
              if (isToday && !isClosed) {
                dayVal = Number(isNonEur && h.dayPnlNative !== undefined ? h.dayPnlNative : h.dayPnlEur) || 0;
                if (!dayVal && h.changeValue && h.quantity) {
                  dayVal = Number(h.changeValue) * Number(h.quantity);
                }
              }

              const dayPct = (isToday && !isClosed) ? (Number(h.changePercent) || 0) : 0;

              let pctBadgeHtml = '';
              if (isClosed) {
                pctBadgeHtml = `
                  <span class="inline-flex items-center justify-center px-1.5 py-0.5 rounded-md font-bold font-mono text-[10px] sm:text-[11px] tracking-wide uppercase" style="background-color: #E2E8F0; color: #475569;">
                    CHIUSO
                  </span>
                `;
              } else if (Math.abs(dayPct) < 0.0001) {
                pctBadgeHtml = `
                  <span class="inline-flex items-center justify-center px-1.5 py-0.5 rounded-md font-bold font-mono text-[10px] sm:text-[11px] tabular-nums" style="background-color: #F1F5F9; color: #334155;">
                    0,00%
                  </span>
                `;
              } else if (dayPct > 0) {
                pctBadgeHtml = `
                  <span class="inline-flex items-center justify-center px-1.5 py-0.5 rounded-md font-bold font-mono text-[10px] sm:text-[11px] tabular-nums" style="background-color: #DCFCE7; color: #15803D;">
                    +${dayPct.toFixed(2).replace('.', ',')}%
                  </span>
                `;
              } else {
                pctBadgeHtml = `
                  <span class="inline-flex items-center justify-center px-1.5 py-0.5 rounded-md font-bold font-mono text-[10px] sm:text-[11px] tabular-nums" style="background-color: #FFE4E6; color: #BE123C;">
                    ${dayPct.toFixed(2).replace('.', ',')}%
                  </span>
                `;
              }

              let valGiornoHtml = '';
              const absDayVal = Math.abs(dayVal);
              let formattedDayVal = '';
              if (absDayVal >= 1000) {
                formattedDayVal = (absDayVal / 1000).toFixed(1).replace('.', ',') + 'k';
              } else {
                formattedDayVal = Math.abs(Math.round(dayVal)).toLocaleString('it-IT') + ' ' + currSym;
              }

              if (isClosed || (isToday && Math.abs(dayVal) < 0.001)) {
                valGiornoHtml = `
                  <span class="text-right font-extrabold font-mono text-xs sm:text-sm tabular-nums" style="color: #64748B;">
                    0 ${currSym}
                  </span>
                `;
              } else if (dayVal > 0) {
                valGiornoHtml = `
                  <span class="text-right font-extrabold font-mono text-xs sm:text-sm tabular-nums" style="color: #15803D;">
                    +${formattedDayVal}
                  </span>
                `;
              } else {
                valGiornoHtml = `
                  <span class="text-right font-extrabold font-mono text-xs sm:text-sm tabular-nums" style="color: #BE123C;">
                    -${formattedDayVal}
                  </span>
                `;
              }

              return `
                <div class="px-2 py-2 hover:bg-gray-50/70 dark:hover:bg-white/5 transition cursor-pointer select-none"
                     style="display: grid; grid-template-columns: 1.15fr 1.15fr 1.05fr 1.25fr; align-items: center;"
                     data-open-asset="${h.ticker}">
                  <!-- Ticker + Dot / Closed indicator -->
                  <div class="flex items-center space-x-1.5 min-w-0 pl-0.5">
                    <span class="inline-flex items-center justify-center px-1.5 py-0.5 rounded font-black font-mono text-xs sm:text-sm tracking-tight cursor-pointer active:scale-95 transition bg-gray-100 dark:bg-white/10 text-gray-900 dark:text-gray-100 border border-gray-200/80 dark:border-white/10">
                      ${h.ticker}
                    </span>
                    ${!isClosed ? `
                      <span class="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse shrink-0" title="Mercato Aperto"></span>
                    ` : ''}
                  </div>

                  <!-- Prezzo -->
                  <div class="text-right font-extrabold font-mono text-xs sm:text-sm text-gray-900 dark:text-gray-100 tabular-nums">
                    ${priceStr}
                  </div>

                  <!-- % Day -->
                  <div class="text-right pr-1">
                    ${pctBadgeHtml}
                  </div>

                  <!-- Valore Day -->
                  <div class="text-right pr-0.5">
                    ${valGiornoHtml}
                  </div>
                </div>
              `;
            }).join('')}
          </div>
        </div>
      `;
    },

    // 11. Targets & Rebalancing Engine
    targets: (data) => {
      const holdings = data.activeHoldings || [];
      const totalNav = data.totals?.totalValue || 1;
      const targetPct = holdings.length > 0 ? 100 / holdings.length : 0;

      return `
        <div class="h-full flex flex-col justify-between">
          <div>
            <div class="flex items-center justify-between mb-2">
              <span class="text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">Asset Target</span>
              <span class="badge-profit text-[9px] uppercase font-mono">Tgt</span>
            </div>
            <p class="text-[11px] text-gray-400 font-mono mb-2">Reale vs target</p>
          </div>
          <div class="flex-1 overflow-y-auto space-y-3 pr-1 no-scrollbar">
            ${holdings.slice(0, 6).map(h => {
              const actualPct = (h.marketValue / totalNav) * 100;
              const diffPct = actualPct - targetPct;
              const diffEur = (diffPct / 100) * totalNav;
              const isOver = diffPct > 0;

              return `
                <div class="p-2.5 rounded-xl bg-gray-50/70 dark:bg-white/5 border border-gray-100 dark:border-white/5 text-xs font-mono">
                  <div class="flex items-center justify-between">
                    <span class="font-bold text-gray-900 dark:text-white">${h.ticker}</span>
                    <span class="text-[11px] text-gray-400">Tgt: ${targetPct.toFixed(1)}%</span>
                  </div>
                  <div class="w-full bg-gray-200 dark:bg-white/10 h-1.5 rounded-full mt-2 overflow-hidden">
                    <div class="bg-emerald-500 h-full rounded-full" style="width: ${Math.min(100, actualPct * 2)}%"></div>
                  </div>
                  <div class="flex items-center justify-between mt-2 text-[10px]">
                    <span class="text-gray-500 dark:text-gray-400">Att.: ${actualPct.toFixed(1)}%</span>
                    <span class="${isOver ? 'text-amber-600 dark:text-amber-400' : 'text-emerald-600 dark:text-emerald-400'} font-semibold">
                      ${isOver ? 'Vendi ' + formatEur(diffEur) : 'Acquista ' + formatEur(Math.abs(diffEur))}
                    </span>
                  </div>
                </div>
              `;
            }).join('') || '<div class="text-center py-6 text-xs text-gray-400 font-mono">Aggiungi titoli per calcolare il rebalancing.</div>'}
          </div>
          <div class="pt-3 border-t border-gray-100 dark:border-white/5 text-center">
            <a href="/rebalancing" class="btn-pill w-full py-1.5 text-xs font-medium border border-gray-300 dark:border-white/10 hover:bg-gray-50 dark:hover:bg-white/5">
              Simula →
            </a>
          </div>
        </div>
      `;
    },

    // 11b. Quotazioni per Categoria (Accordion live view - Photos 1 & 2)
    categoryQuotes: (data) => {
      const holdings = data.activeHoldings || [];
      if (holdings.length === 0) {
        return `
          <div class="h-full flex flex-col items-center justify-center p-6 text-center">
            <span class="text-xs font-mono text-gray-400">Nessun titolo in portafoglio</span>
          </div>
        `;
      }

      const categories = groupHoldingsByCategory(holdings);

      return `
        <div class="h-full flex flex-col -m-2 sm:-m-3 overflow-hidden select-none">
          <div class="flex-1 overflow-y-auto no-scrollbar space-y-2 py-1">
            ${categories.map(cat => {
              const isCollapsed = collapsedCategorySet.has(cat.id);
              const dayNum = Math.round(cat.totDayPnl);
              const daySign = dayNum > 0 ? '+' : (dayNum < 0 ? '-' : '+');
              const dayStyleColor = dayNum > 0 ? '#15803D' : (dayNum < 0 ? '#DC2626' : '#78350F');
              const dayColor = dayNum > 0 ? 'text-[#16A34A] dark:text-[#4ADE80]' : (dayNum < 0 ? 'text-[#E11D48] dark:text-[#FB7185]' : 'text-[#6B7280] dark:text-gray-400');
              const dayStr = Math.abs(dayNum) >= 1000
                ? `${daySign}${(Math.abs(dayNum) / 1000).toFixed(1).replace('.', ',')}k`
                : `${daySign}${Math.abs(dayNum).toLocaleString('it-IT')} ${cat.currSym}`;

              const totNum = Math.round(cat.totUnrealizedPnl);
              const totSign = totNum > 0 ? '+' : (totNum < 0 ? '-' : '');
              const totStyleColor = totNum >= 0 ? '#15803D' : '#DC2626';
              const totColor = totNum >= 0 ? 'text-[#16A34A] dark:text-[#4ADE80]' : 'text-[#E11D48] dark:text-[#FB7185]';
              const totStr = Math.abs(totNum) >= 1000
                ? `${totSign}${(Math.abs(totNum) / 1000).toFixed(1).replace('.', ',')}k`
                : `${totSign}${Math.abs(totNum).toLocaleString('it-IT')} ${cat.currSym}`;

              const pctNum = Number(cat.totUnrealizedPnlPct) || 0;
              const pctSign = pctNum >= 0 ? '+' : '';
              const totPctStyleColor = pctNum >= 0 ? '#15803D' : '#DC2626';
              const totPctColor = pctNum >= 0 ? 'text-[#16A34A] dark:text-[#4ADE80]' : 'text-[#E11D48] dark:text-[#FB7185]';
              const totPctStr = `${pctSign}${pctNum.toFixed(1).replace('.', ',')} %`;

              return `
                <div class="category-block border-y border-amber-300 dark:border-amber-700/60 shadow-xs mb-2 bg-white dark:bg-[#141416]">
                  <!-- Accordion Header Banner (Yellow/Warm theme matching Photo 1 & 2) -->
                  <div class="category-header cursor-pointer select-none px-3 py-2 flex items-center justify-between"
                       style="background-color: #FEF9C3;"
                       data-toggle-category="${cat.id}">
                    <!-- Left: Chevron + Dot + Title -->
                    <div class="flex items-center space-x-2 min-w-0 pr-2">
                      <span id="cat-chevron-${cat.id}" class="transform transition-transform duration-200 font-black text-sm shrink-0 ${isCollapsed ? '-rotate-90' : 'rotate-0'}" style="color: #78350F !important;">
                        ⌄
                      </span>
                      <span class="w-2.5 h-2.5 rounded-full inline-block shrink-0 shadow-xs" style="background-color: #2563EB;"></span>
                      <span class="font-extrabold text-xs sm:text-sm tracking-wider uppercase font-mono truncate" style="color: #78350F !important;">
                        ${cat.title}
                      </span>
                    </div>

                    <!-- Right: Two Metric Columns -->
                    <div class="flex items-center space-x-3.5 shrink-0">
                      <!-- Column 1: Daily delta -->
                      <div class="text-right">
                        <div class="text-xs sm:text-sm font-extrabold font-mono leading-tight ${dayColor}" style="color: ${dayStyleColor} !important;">
                          ${dayStr}
                        </div>
                        <div class="text-[9px] font-black tracking-widest uppercase font-mono" style="color: #92400E !important;">
                          DAILY
                        </div>
                      </div>

                      <!-- Column 2: Total P&L / Return -->
                      <div class="text-right">
                        <div class="text-xs sm:text-sm font-extrabold font-mono leading-tight ${totColor}" style="color: ${totStyleColor} !important;">
                          ${totStr}
                        </div>
                        <div class="text-[10px] font-extrabold font-mono leading-tight ${totPctColor}" style="color: ${totPctStyleColor} !important;">
                          ${totPctStr}
                        </div>
                      </div>
                    </div>
                  </div>

                  <!-- Table Section -->
                  <div id="cat-body-${cat.id}" class="${isCollapsed ? 'hidden' : ''}">
                    <!-- Table Header Row -->
                    <div class="px-3 py-1.5 bg-gray-50/90 dark:bg-[#18181b] border-b border-gray-200/60 dark:border-white/5 text-[10px] sm:text-[11px] font-extrabold font-mono text-gray-500 uppercase tracking-wider"
                         style="display: grid; grid-template-columns: 1.1fr 1.3fr 1.1fr 1.2fr; align-items: center;">
                      <div class="text-left pl-0.5">TICKER</div>
                      <div class="text-right">PREZZO</div>
                      <div class="text-right pr-1.5">% GIORNO</div>
                      <div class="text-right pr-0.5">VAL GIORNO</div>
                    </div>

                    <!-- Table Rows -->
                    <div class="divide-y divide-gray-100 dark:divide-white/5 bg-white dark:bg-[#141416]">
                      ${cat.holdings.map(h => {
                        const isToday = isHoldingQuotedToday(h);
                        const isClosed = !isToday;
                        const isMarketClosed = isAssetMarketClosed(h);
                        const isNonEur = cat.currency !== 'EUR';

                        const rawPrice = Number(isNonEur && h.currentPriceNative !== undefined ? h.currentPriceNative : h.currentPrice) || 0;
                        const priceStr = rawPrice.toLocaleString('it-IT', {
                          minimumFractionDigits: 2,
                          maximumFractionDigits: 2
                        }) + ' ' + cat.currSym;

                        let dayVal = 0;
                        if (isToday && !isClosed) {
                          dayVal = Number(isNonEur && h.dayPnlNative !== undefined ? h.dayPnlNative : h.dayPnlEur) || 0;
                          if (!dayVal && h.changeValue && h.quantity) {
                            dayVal = Number(h.changeValue) * Number(h.quantity);
                          }
                        }

                        const dayPct = isToday && !isClosed ? (Number(h.changePercent) || 0) : 0;

                        let pctBadgeHtml = '';
                        if (isClosed) {
                          pctBadgeHtml = `
                            <span class="inline-flex items-center justify-center px-1.5 py-0.5 rounded-md font-bold font-mono text-[10px] sm:text-[11px] tracking-wide uppercase" style="background-color: #E2E8F0; color: #475569;">
                              CHIUSO
                            </span>
                          `;
                        } else if (Math.abs(dayPct) < 0.0001) {
                          pctBadgeHtml = `
                            <span class="inline-flex items-center justify-center px-1.5 py-0.5 rounded-md font-bold font-mono text-[10px] sm:text-[11px] tabular-nums" style="background-color: #F1F5F9; color: #334155;">
                              0,00%
                            </span>
                          `;
                        } else if (dayPct > 0) {
                          pctBadgeHtml = `
                            <span class="inline-flex items-center justify-center px-1.5 py-0.5 rounded-md font-bold font-mono text-[10px] sm:text-[11px] tabular-nums" style="background-color: #DCFCE7; color: #15803D;">
                              +${dayPct.toFixed(2).replace('.', ',')}%
                            </span>
                          `;
                        } else {
                          pctBadgeHtml = `
                            <span class="inline-flex items-center justify-center px-1.5 py-0.5 rounded-md font-bold font-mono text-[10px] sm:text-[11px] tabular-nums" style="background-color: #FFE4E6; color: #BE123C;">
                              ${dayPct.toFixed(2).replace('.', ',')}%
                            </span>
                          `;
                        }

                        let valGiornoHtml = '';
                        const absCatDayVal = Math.abs(dayVal);
                        let formattedCatDayDelta = '';
                        if (absCatDayVal >= 1000) {
                          formattedCatDayDelta = (absCatDayVal / 1000).toFixed(1).replace('.', ',') + 'k';
                        } else {
                          formattedCatDayDelta = Math.abs(Math.round(dayVal)).toLocaleString('it-IT') + ' ' + cat.currSym;
                        }

                        if (isClosed || (isToday && Math.abs(dayVal) < 0.001)) {
                          const zeroLabel = `0 ${cat.currSym}`;
                          valGiornoHtml = `
                            <span class="text-right font-extrabold font-mono text-xs sm:text-sm tabular-nums" style="color: #64748B;">
                              ${zeroLabel}
                            </span>
                          `;
                        } else if (dayVal > 0) {
                          valGiornoHtml = `
                            <span class="text-right font-extrabold font-mono text-xs sm:text-sm tabular-nums" style="color: #15803D;">
                              +${formattedCatDayDelta}
                            </span>
                          `;
                        } else {
                          valGiornoHtml = `
                            <span class="text-right font-extrabold font-mono text-xs sm:text-sm tabular-nums" style="color: #BE123C;">
                              -${formattedCatDayDelta}
                            </span>
                          `;
                        }

                        return `
                          <div class="px-3 py-2 border-b border-gray-100 dark:border-white/5 hover:bg-gray-50/50 dark:hover:bg-white/5 transition"
                               style="display: grid; grid-template-columns: 1.1fr 1.3fr 1.1fr 1.2fr; align-items: center;"
                               data-open-asset="${h.ticker}">
                            <!-- Ticker Badge -->
                            <div class="text-left pl-0.5">
                              <span class="inline-flex items-center justify-center px-1.5 py-0.5 rounded-md font-black font-mono text-xs sm:text-sm tracking-tight cursor-pointer active:scale-95 transition bg-gray-100 dark:bg-white/10 text-gray-900 dark:text-gray-100 border border-gray-200/80 dark:border-white/10">
                                ${h.ticker}
                              </span>
                            </div>

                            <!-- Prezzo -->
                            <div class="text-right font-extrabold font-mono text-xs sm:text-sm text-gray-900 dark:text-gray-100 tabular-nums">
                              ${priceStr}
                            </div>

                            <!-- % Giorno -->
                            <div class="text-right pr-1.5">
                              ${pctBadgeHtml}
                            </div>

                            <!-- Val Giorno -->
                            <div class="text-right pr-0.5">
                              ${valGiornoHtml}
                            </div>
                          </div>
                        `;
                      }).join('')}
                    </div>
                  </div>
                </div>
              `;
            }).join('')}
          </div>
        </div>
      `;
    },

    // 12. Complete Breakdown Table
    breakdown: (data) => {
      if (isMobileDashboard()) {
        return WIDGET_RENDERERS.categoryQuotes(data);
      }
      const holdings = data.activeHoldings || [];
      return `
        <div class="h-full flex flex-col">
          <div class="flex items-center justify-between mb-3">
            <span class="text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">Holdings</span>
            <span class="text-xs font-mono text-gray-400">${holdings.length} posizioni</span>
          </div>
          <div class="flex-1 overflow-auto rounded-xl border border-gray-100 dark:border-white/5">
            <table class="min-w-full divide-y divide-gray-200/60 dark:divide-white/5 text-left text-xs font-mono">
              <thead class="bg-gray-50/80 dark:bg-white/5 text-gray-500 uppercase tracking-wider text-[10px] sticky top-0 backdrop-blur">
                <tr>
                  <th class="px-4 py-2.5">Ticker</th>
                  <th class="px-4 py-2.5">Nome</th>
                  <th class="px-4 py-2.5">Settore</th>
                  <th class="px-4 py-2.5 text-right">Quote</th>
                  <th class="px-4 py-2.5 text-right">PMC</th>
                  <th class="px-4 py-2.5 text-right">Prezzo</th>
                  <th class="px-4 py-2.5 text-right">Valore</th>
                  <th class="px-4 py-2.5 text-right">P&L</th>
                  <th class="px-4 py-2.5 text-right">Peso</th>
                </tr>
              </thead>
              <tbody class="divide-y divide-gray-200/40 dark:divide-white/5 tabular-nums">
                ${holdings.map(h => {
                  const sInfo = getAssetMarketStatusInfo(h);
                  return `
                  <tr class="hover:bg-gray-50/50 dark:hover:bg-white/5 transition cursor-pointer" data-open-asset="${h.ticker}">
                    <td class="px-4 py-3 font-bold text-gray-900 dark:text-white">
                      <div class="flex items-center space-x-1.5">
                        <span>${h.ticker}</span>
                        ${sInfo.isClosed
                          ? `<span class="px-1.5 py-0.2 rounded text-[8px] font-bold bg-amber-500/15 text-amber-700 dark:text-amber-400 border border-amber-500/20" title="${sInfo.reason}">CHIUSO</span>`
                          : `<span class="px-1.5 py-0.2 rounded text-[8px] font-semibold bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border border-emerald-500/20" title="${sInfo.reason}">LIVE</span>`}
                      </div>
                    </td>
                    <td class="px-4 py-3 text-gray-600 dark:text-gray-300 truncate max-w-[150px]">${h.name}</td>
                    <td class="px-4 py-3 text-gray-400">${h.sector || 'Unclassified'}</td>
                    <td class="px-4 py-3 text-right">${Math.round(h.quantity).toLocaleString('it-IT')}</td>
                    <td class="px-4 py-3 text-right">${formatPriceEur(h.pmc)}</td>
                    <td class="px-4 py-3 text-right">${formatPriceEur(h.currentPrice)}</td>
                    <td class="px-4 py-3 text-right font-bold text-gray-900 dark:text-white">${formatEur(h.marketValue)}</td>
                    <td class="px-4 py-3 text-right font-semibold ${h.unrealizedPnl >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}">${formatPct(h.unrealizedPnlPercent)}</td>
                    <td class="px-4 py-3 text-right font-bold">${h.weight.toFixed(1)}%</td>
                  </tr>
                `;
                }).join('') || '<tr><td colspan="9" class="text-center py-8 text-gray-400">Nessuna posizione in portafoglio.</td></tr>'}
              </tbody>
            </table>
          </div>
        </div>
      `;
    },

    // 13a. Top Gainers & Losers Giornalieri (TOP WINNER / LOSER 1D - Photo 3)
    moversDay: (data) => {
      const allHoldings = data.activeHoldings || [];
      const dayHoldings = allHoldings.filter(h => isHoldingQuotedToday(h));

      if (dayHoldings.length === 0) {
        return `
          <div class="h-full flex flex-col justify-between">
            <div class="flex items-center justify-between pb-2.5 border-b border-gray-100 dark:border-white/5">
              <span class="text-xs sm:text-sm font-bold font-mono tracking-wider text-gray-700 dark:text-gray-200 uppercase">
                TOP WINNER / LOSER (1D)
              </span>
              <span class="text-[10px] font-mono text-gray-400">Sessione Odierna</span>
            </div>
            <div class="flex-1 flex flex-col items-center justify-center text-center p-4">
              <svg class="w-8 h-8 text-gray-400/50 mb-2 mx-auto" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>
              <span class="text-xs text-gray-500 dark:text-gray-400 font-mono">Nessun titolo con scambi nella seduta odierna</span>
              <span class="text-[10px] text-gray-400 mt-1 block">I titoli con quotazioni della seduta precedente o a mercati ancora chiusi sono esclusi.</span>
            </div>
          </div>
        `;
      }

      const gainers = dayHoldings
        .filter(h => {
          const pct = Number(h.changePercent) || 0;
          const val = Number(h.dayPnlEur) || ((Number(h.changeValue) || 0) * (Number(h.quantity) || 0));
          return pct > 0 || (pct === 0 && val >= 0);
        })
        .sort((a, b) => {
          const aPct = Number(a.changePercent) || 0;
          const bPct = Number(b.changePercent) || 0;
          if (bPct !== aPct) return bPct - aPct;
          const aVal = Number(a.dayPnlEur) || 0;
          const bVal = Number(b.dayPnlEur) || 0;
          return bVal - aVal;
        })
        .slice(0, 5);

      const losers = dayHoldings
        .filter(h => {
          const pct = Number(h.changePercent) || 0;
          const val = Number(h.dayPnlEur) || ((Number(h.changeValue) || 0) * (Number(h.quantity) || 0));
          return pct < 0 || (pct === 0 && val < 0);
        })
        .sort((a, b) => {
          const aPct = Number(a.changePercent) || 0;
          const bPct = Number(b.changePercent) || 0;
          if (aPct !== bPct) return aPct - bPct;
          const aVal = Number(a.dayPnlEur) || 0;
          const bVal = Number(b.dayPnlEur) || 0;
          return aVal - bVal;
        })
        .slice(0, 5);

      const isValMode = (typeof activeMoversMode !== 'undefined' ? activeMoversMode : 'pct') === 'val';

      return `
        <div class="h-full flex flex-col justify-between select-none">
          <!-- Top Header with Segmented Toggle (Photo 3) -->
          <div class="flex items-center justify-between pb-2.5 border-b border-gray-100 dark:border-white/5">
            <span class="text-xs sm:text-sm font-bold font-mono tracking-wider text-gray-700 dark:text-gray-200 uppercase">
              TOP WINNER / LOSER (1D)
            </span>
            <div class="inline-flex p-0.5 rounded-lg bg-gray-100 dark:bg-white/5 border border-gray-200/60 dark:border-white/10 text-xs font-mono">
              <button type="button" data-movers-mode="pct"
                class="px-2.5 py-0.5 rounded-md text-xs font-mono transition ${!isValMode ? 'bg-white dark:bg-white/15 text-gray-900 dark:text-white font-bold shadow-xs' : 'text-gray-400 hover:text-gray-700 dark:hover:text-gray-300'}">
                %
              </button>
              <button type="button" data-movers-mode="val"
                class="px-2.5 py-0.5 rounded-md text-xs font-mono transition ${isValMode ? 'bg-white dark:bg-white/15 text-gray-900 dark:text-white font-bold shadow-xs' : 'text-gray-400 hover:text-gray-700 dark:hover:text-gray-300'}">
                Valore
              </button>
            </div>
          </div>

          <!-- Two Columns (Photo 3) -->
          <div class="grid grid-cols-2 gap-3 sm:gap-4 flex-1 pt-2.5 overflow-hidden">
            <!-- Gainers (MIGLIORI) -->
            <div class="space-y-1.5 min-w-0">
              <div class="flex items-center text-[11px] font-bold font-mono text-gray-600 dark:text-gray-300 uppercase tracking-wider mb-2">
                <span class="w-2 h-2 rounded-full bg-emerald-500 inline-block mr-1.5 shrink-0"></span>
                <span>MIGLIORI (1D)</span>
              </div>
              <div class="space-y-1">
                ${gainers.map(g => {
                  const dayVal = (g.dayPnlEur !== undefined && !isNaN(g.dayPnlEur))
                    ? Number(g.dayPnlEur)
                    : ((Number(g.changeValue) || 0) * (Number(g.quantity) || 0));

                  const displayTicker = g.ticker.length > 7 ? g.ticker.slice(0, 4) + '...' : g.ticker;
                  const valStr = formatEurSignedDec(dayVal, 2);
                  const pctStr = formatPct(g.changePercent);

                  const contentStr = isValMode
                    ? `${valStr} (${pctStr})`
                    : `${pctStr} (${valStr})`;

                  return `
                    <div class="flex items-center justify-between py-1 px-1 rounded hover:bg-gray-50/70 dark:hover:bg-white/5 transition cursor-pointer"
                         data-open-asset="${g.ticker}">
                      <span class="font-extrabold font-mono text-xs sm:text-sm text-gray-900 dark:text-white truncate pr-1" title="${g.ticker}">
                        ${displayTicker}
                      </span>
                      <span class="text-emerald-600 dark:text-emerald-400 font-extrabold font-mono text-xs sm:text-sm whitespace-nowrap text-right tabular-nums">
                        ${contentStr}
                      </span>
                    </div>
                  `;
                }).join('') || '<div class="text-xs text-gray-400 font-mono py-2">Nessun rialzo</div>'}
              </div>
            </div>

            <!-- Losers (PEGGIORI) -->
            <div class="space-y-1.5 min-w-0">
              <div class="flex items-center text-[11px] font-bold font-mono text-gray-600 dark:text-gray-300 uppercase tracking-wider mb-2">
                <span class="w-2 h-2 rounded-full bg-rose-500 inline-block mr-1.5 shrink-0"></span>
                <span>PEGGIORI (1D)</span>
              </div>
              <div class="space-y-1">
                ${losers.map(l => {
                  const dayVal = (l.dayPnlEur !== undefined && !isNaN(l.dayPnlEur))
                    ? Number(l.dayPnlEur)
                    : ((Number(l.changeValue) || 0) * (Number(l.quantity) || 0));

                  const displayTicker = l.ticker.length > 7 ? l.ticker.slice(0, 4) + '...' : l.ticker;
                  const valStr = formatEurSignedDec(dayVal, 2);
                  const pctStr = formatPct(l.changePercent);

                  const contentStr = isValMode
                    ? `${valStr} (${pctStr})`
                    : `${pctStr} (${valStr})`;

                  return `
                    <div class="flex items-center justify-between py-1 px-1 rounded hover:bg-gray-50/70 dark:hover:bg-white/5 transition cursor-pointer"
                         data-open-asset="${l.ticker}">
                      <span class="font-extrabold font-mono text-xs sm:text-sm text-gray-900 dark:text-white truncate pr-1" title="${l.ticker}">
                        ${displayTicker}
                      </span>
                      <span class="text-rose-600 dark:text-rose-400 font-extrabold font-mono text-xs sm:text-sm whitespace-nowrap text-right tabular-nums">
                        ${contentStr}
                      </span>
                    </div>
                  `;
                }).join('') || '<div class="text-xs text-gray-400 font-mono py-2">Nessun ribasso</div>'}
              </div>
            </div>
          </div>
        </div>
      `;
    },

    // 13b. Top Gainers & Losers All-Time (Movers All-Time)
    moversAllTime: (data) => {
      const allHoldings = data.activeHoldings || [];
      const gainers = allHoldings
        .filter(h => (Number(h.unrealizedPnlPercent) || 0) > 0)
        .sort((a, b) => (Number(b.unrealizedPnlPercent) || 0) - (Number(a.unrealizedPnlPercent) || 0))
        .slice(0, 3);

      const losers = allHoldings
        .filter(h => (Number(h.unrealizedPnlPercent) || 0) < 0)
        .sort((a, b) => (Number(a.unrealizedPnlPercent) || 0) - (Number(b.unrealizedPnlPercent) || 0))
        .slice(0, 3);

      return `
        <div class="h-full flex flex-col justify-between">
          <div class="flex items-center justify-between mb-2">
            <span class="text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">Movers All-Time</span>
            <span class="text-[10px] font-mono text-gray-400">Storico</span>
          </div>
          <div class="grid grid-cols-2 gap-4 flex-1">
            <!-- Gainers -->
            <div class="space-y-2">
              <span class="text-[11px] font-semibold text-emerald-600 dark:text-emerald-400 uppercase font-mono">Gainers ▲</span>
              ${gainers.map(g => `
                <div class="p-2.5 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-xs font-mono flex items-center justify-between cursor-pointer hover:opacity-80 transition" data-open-asset="${g.ticker}">
                  <div class="min-w-0 pr-2">
                    <span class="font-bold text-gray-900 dark:text-white block truncate">${g.ticker}</span>
                    <span class="text-[10px] text-gray-400 block">${formatEur(g.marketValue)}</span>
                  </div>
                  <div class="text-right flex-shrink-0">
                    <span class="badge-profit tabular-nums inline-block">${formatPct(g.unrealizedPnlPercent)}</span>
                    <span class="text-[11px] font-bold block mt-0.5 text-emerald-600 dark:text-emerald-400 tabular-nums">${formatEurSignedDec(g.unrealizedPnl)}</span>
                  </div>
                </div>
              `).join('') || '<div class="text-xs text-gray-400 font-mono py-2">Nessun titolo in guadagno</div>'}
            </div>
            <!-- Losers -->
            <div class="space-y-2">
              <span class="text-[11px] font-semibold text-rose-600 dark:text-rose-400 uppercase font-mono">Losers ▼</span>
              ${losers.map(l => `
                <div class="p-2.5 rounded-xl bg-rose-500/10 border border-rose-500/20 text-xs font-mono flex items-center justify-between cursor-pointer hover:opacity-80 transition" data-open-asset="${l.ticker}">
                  <div class="min-w-0 pr-2">
                    <span class="font-bold text-gray-900 dark:text-white block truncate">${l.ticker}</span>
                    <span class="text-[10px] text-gray-400 block">${formatEur(l.marketValue)}</span>
                  </div>
                  <div class="text-right flex-shrink-0">
                    <span class="badge-loss tabular-nums inline-block">${formatPct(l.unrealizedPnlPercent)}</span>
                    <span class="text-[11px] font-bold block mt-0.5 text-rose-600 dark:text-rose-400 tabular-nums">${formatEurSignedDec(l.unrealizedPnl)}</span>
                  </div>
                </div>
              `).join('') || '<div class="text-xs text-gray-400 font-mono py-2">Nessun titolo in perdita</div>'}
            </div>
          </div>
        </div>
      `;
    },

    // Backward compatibility alias for legacy 'movers' ID
    movers: (data) => WIDGET_RENDERERS.moversDay(data),
    topWinnersLosers: (data) => WIDGET_RENDERERS.moversDay(data),

    // 14. Risk Concentration Index
    concentration: (data) => {
      const holdings = [...(data.activeHoldings || [])];
      holdings.sort((a, b) => b.weight - a.weight);
      const top3Weight = holdings.slice(0, 3).reduce((acc, h) => acc + h.weight, 0);
      const top5Weight = holdings.slice(0, 5).reduce((acc, h) => acc + h.weight, 0);
      const diversificationScore = Math.max(10, Math.round(100 - top3Weight * 0.8));

      return `
        <div class="h-full flex flex-col justify-between">
          <div class="flex items-center justify-between">
            <span class="text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">Concentrazione</span>
            <span class="text-xs font-mono font-bold ${diversificationScore > 60 ? 'text-emerald-600' : 'text-amber-500'}">Score: ${diversificationScore}/100</span>
          </div>

          <div class="my-4 space-y-4 font-mono text-xs">
            <div>
              <div class="flex items-center justify-between text-gray-600 dark:text-gray-300 mb-1">
                <span>Top 3</span>
                <span class="font-bold tabular-nums">${top3Weight.toFixed(1)}%</span>
              </div>
              <div class="w-full bg-gray-200 dark:bg-white/10 h-2 rounded-full overflow-hidden">
                <div class="${top3Weight > 50 ? 'bg-amber-500' : 'bg-emerald-500'} h-full rounded-full transition-all" style="width: ${top3Weight}%"></div>
              </div>
            </div>

            <div>
              <div class="flex items-center justify-between text-gray-600 dark:text-gray-300 mb-1">
                <span>Top 5</span>
                <span class="font-bold tabular-nums">${top5Weight.toFixed(1)}%</span>
              </div>
              <div class="w-full bg-gray-200 dark:bg-white/10 h-2 rounded-full overflow-hidden">
                <div class="${top5Weight > 70 ? 'bg-amber-500' : 'bg-emerald-500'} h-full rounded-full transition-all" style="width: ${top5Weight}%"></div>
              </div>
            </div>
          </div>

          <div class="text-[10px] text-gray-400 font-mono flex items-center justify-between">
            <span>Asset: ${holdings.length}</span>
            <span>Max: ${holdings[0] ? holdings[0].weight.toFixed(1) + '%' : '0%'}</span>
          </div>
        </div>
      `;
    },

    // 14b. Ultime Notizie Portafoglio (News Scraper Widget - Top 5)
    news: (data) => {
      if (cachedPortfolioNews === null) {
        setTimeout(() => loadPortfolioNews(false), 20);
        return `
          <div class="h-full flex flex-col justify-between">
            <div class="flex items-center justify-between pb-2 border-b border-gray-100 dark:border-white/5 shrink-0">
              <div class="flex items-center space-x-1.5">
                <span class="text-sm">📰</span>
                <span class="text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">Ultime Notizie Portafoglio</span>
              </div>
              <span class="text-[10px] font-mono text-gray-400">Caricamento...</span>
            </div>
            <div class="flex-1 flex flex-col items-center justify-center p-6 space-y-2">
              <div class="w-5 h-5 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin"></div>
              <span class="text-xs font-mono text-gray-400">Scansione notizie per i titoli in portafoglio...</span>
            </div>
          </div>
        `;
      }

      const newsItems = cachedPortfolioNews || [];
      if (newsItems.length === 0) {
        return `
          <div class="h-full flex flex-col justify-between">
            <div class="flex items-center justify-between pb-2 border-b border-gray-100 dark:border-white/5 shrink-0">
              <div class="flex items-center space-x-1.5">
                <span class="text-sm">📰</span>
                <span class="text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">Ultime Notizie Portafoglio</span>
              </div>
              <button type="button" onclick="FolioTrackDashboard.refreshNews()" class="p-1 rounded text-gray-400 hover:text-emerald-600 dark:hover:text-emerald-400 hover:bg-gray-100 dark:hover:bg-white/5 transition cursor-pointer" title="Ricarica notizie">
                <svg id="news-refresh-icon" class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                </svg>
              </button>
            </div>
            <div class="flex-1 flex flex-col items-center justify-center p-4 text-center">
              <span class="text-xs font-mono text-gray-400">Nessuna notizia recente per i titoli in portafoglio</span>
              <button type="button" onclick="FolioTrackDashboard.refreshNews()" class="mt-2 text-xs font-mono text-emerald-600 dark:text-emerald-400 underline cursor-pointer">
                Cerca news adesso
              </button>
            </div>
          </div>
        `;
      }

      const rowsHtml = newsItems.slice(0, 5).map(item => `
        <div class="pt-2 first:pt-0 group">
          <div class="flex items-center justify-between text-[10px] font-mono mb-1">
            <div class="flex items-center space-x-1.5 overflow-hidden">
              <span class="px-1.5 py-0.5 rounded font-bold bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20 shrink-0">${item.ticker}</span>
              <span class="text-gray-400 truncate max-w-[130px] sm:max-w-[160px]">${item.publisher || 'News'}</span>
            </div>
            <span class="text-gray-400 shrink-0 text-[9px]">${item.timeAgo || ''}</span>
          </div>
          <a href="${item.link}" target="_blank" rel="noopener noreferrer" class="text-xs font-medium text-gray-900 dark:text-gray-100 group-hover:text-emerald-600 dark:group-hover:text-emerald-400 line-clamp-2 leading-snug transition-colors flex items-start gap-1">
            <span class="flex-1">${item.title}</span>
            <svg class="w-3 h-3 text-gray-400 group-hover:text-emerald-500 shrink-0 mt-0.5 opacity-60 group-hover:opacity-100" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
            </svg>
          </a>
        </div>
      `).join('');

      return `
        <div class="h-full flex flex-col justify-between overflow-hidden">
          <div class="flex items-center justify-between pb-2 border-b border-gray-100 dark:border-white/5 shrink-0">
            <div class="flex items-center space-x-1.5">
              <span class="text-sm">📰</span>
              <span class="text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">Ultime Notizie Portafoglio</span>
              <span class="text-[9px] font-mono text-emerald-600 dark:text-emerald-400 bg-emerald-500/10 px-1 rounded font-bold">5 news</span>
            </div>
            <button type="button" onclick="FolioTrackDashboard.refreshNews()" class="p-1 rounded text-gray-400 hover:text-emerald-600 dark:hover:text-emerald-400 hover:bg-gray-100 dark:hover:bg-white/5 transition cursor-pointer" title="Rileggi le ultime news dal web">
              <svg id="news-refresh-icon" class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
            </button>
          </div>
          <div class="flex-1 overflow-y-auto no-scrollbar py-2 space-y-2 divide-y divide-gray-100 dark:divide-white/5">
            ${rowsHtml}
          </div>
          <div class="pt-1.5 border-t border-gray-100 dark:border-white/5 text-[10px] font-mono text-gray-400 flex items-center justify-between shrink-0">
            <span>Fonti: Google & Yahoo</span>
            <span>Titoli: ${data.activeHoldings ? data.activeHoldings.length : 0}</span>
          </div>
        </div>
      `;
    },

    // 15. TWRR (Time-Weighted Rate of Return)
    twrr: (data) => {
      const m = data.performanceMetrics || {};
      const twrMap = m.twr || {};
      const gainMap = m.periodGain || {};
      const twrrVal = twrMap[activeTwrrPeriod] !== undefined ? Number(twrMap[activeTwrrPeriod]) : (Number(data.totals?.unrealizedPnlPercent) || 0);
      const gainVal = gainMap[activeTwrrPeriod] !== undefined ? Number(gainMap[activeTwrrPeriod]) : (Number(data.totals?.unrealizedPnl) || 0);
      const isPos = twrrVal >= 0;
      const periods = ['1M', '3M', '6M', '1Y', '3Y', 'ALL'];

      const pillsHtml = periods.map(p => `
        <button type="button" data-twrr-period="${p}" class="px-1.5 py-0.5 rounded text-[10px] font-mono transition cursor-pointer ${activeTwrrPeriod === p ? 'bg-emerald-600 text-white font-bold shadow-xs' : 'text-gray-400 hover:text-gray-900 dark:hover:text-white bg-gray-100 dark:bg-white/5'}">
          ${p}
        </button>
      `).join('');

      return `
        <div class="h-full flex flex-col justify-between">
          <div class="flex items-center justify-between gap-1">
            <span class="text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">Rend. TWRR</span>
            <div class="flex items-center space-x-1">
              ${pillsHtml}
            </div>
          </div>
          <div class="my-1.5">
            <div class="text-2xl font-bold font-mono tabular-nums tracking-tight ${isPos ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}">
              ${formatPct(twrrVal)}
            </div>
          </div>
          <div class="flex items-center justify-between text-[11px] font-mono text-gray-400">
            <span class="${gainVal >= 0 ? 'text-emerald-600/90 dark:text-emerald-400/90 font-semibold' : 'text-rose-600/90 dark:text-rose-400/90 font-semibold'}">${formatEurSigned(gainVal)} (${activeTwrrPeriod})</span>
            <span class="text-[10px] uppercase text-gray-400 tracking-wider" title="Time-Weighted Rate of Return">TWRR</span>
          </div>
        </div>
      `;
    },

    // 16. MWRR / XIRR (Money-Weighted Rate of Return)
    mwrr: (data) => {
      const m = data.performanceMetrics || {};
      const xirrVal = m.xirr !== undefined ? Number(m.xirr) : 0;
      const roiVal = m.roi !== undefined ? Number(m.roi) : (Number(data.totals?.unrealizedPnlPercent) || 0);
      const isPos = xirrVal >= 0;
      return `
        <div class="h-full flex flex-col justify-between">
          <div class="flex items-center justify-between">
            <span class="text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">Rend. MWRR</span>
            <span class="badge-profit text-[10px] uppercase font-mono">XIRR</span>
          </div>
          <div class="my-1.5">
            <div class="text-2xl font-bold font-mono tabular-nums tracking-tight ${isPos ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}">
              ${formatPct(xirrVal)} <span class="text-xs font-normal text-gray-500">p.a.</span>
            </div>
          </div>
          <div class="flex items-center justify-between text-[11px] font-mono text-gray-400">
            <span>ROI: <strong class="${roiVal >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}">${formatPct(roiVal)}</strong></span>
            <span class="text-[10px] uppercase text-gray-400 tracking-wider" title="Money-Weighted Rate of Return (TIR / XIRR)">MWRR</span>
          </div>
        </div>
      `;
    },

    // 17. Drawdown & ATH (All-Time High)
    drawdown: (data) => {
      const m = data.performanceMetrics || {};
      const maxDd = Number(m.maxDrawdown) || 0;
      const curDd = Number(m.currentDrawdown) || 0;
      const peak = Number(m.peak) || (Number(data.totals?.totalValue) || 0);
      const recoveryPct = Math.max(0, Math.min(100, 100 - curDd));
      return `
        <div class="h-full flex flex-col justify-between">
          <div class="flex items-center justify-between">
            <span class="text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">Drawdown</span>
            <span class="px-1.5 py-0.5 rounded text-[10px] font-mono font-medium ${curDd > 5 ? 'bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300' : 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300'}">Max -${maxDd.toFixed(2)}%</span>
          </div>
          <div class="my-1.5 flex items-baseline justify-between">
            <div class="text-2xl font-bold font-mono tabular-nums tracking-tight text-rose-600 dark:text-rose-400">
              -${curDd.toFixed(2)}%
            </div>
            <div class="text-[11px] font-mono text-gray-500">da ATH</div>
          </div>
          <div>
            <div class="flex items-center justify-between text-[11px] font-mono text-gray-400 mb-1">
              <span>ATH: ${formatEur(peak)}</span>
              <span>Data: ${m.maxDrawdownDate ? m.maxDrawdownDate.slice(0, 10) : '-'}</span>
            </div>
            <div class="w-full bg-gray-200 dark:bg-white/10 h-1.5 rounded-full overflow-hidden" title="Livello attuale rispetto al massimo storico ATH">
              <div class="bg-emerald-500 h-full rounded-full transition-all duration-500" style="width: ${recoveryPct}%"></div>
            </div>
          </div>
        </div>
      `;
    },

    // 18. Risk & Efficiency Metrics (Volatility, Sharpe, Historical Days)
    riskMetrics: (data) => {
      const m = data.performanceMetrics || {};
      const vol = Number(m.annualizedVolatility) || 0;
      const sharpe = m.sharpeRatio !== undefined && m.sharpeRatio !== null ? Number(m.sharpeRatio) : 0;
      const pts = m.dailyPointsCount || 0;
      return `
        <div class="h-full flex flex-col justify-between">
          <div class="flex items-center justify-between">
            <span class="text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">Rischio & Sharpe</span>
            <span class="badge-profit text-[10px] uppercase font-mono">Rischio</span>
          </div>
          <div class="my-1.5 grid grid-cols-2 gap-2">
            <div class="bg-gray-50 dark:bg-white/5 p-2 rounded-lg border border-gray-100 dark:border-white/5">
              <div class="text-[10px] uppercase font-mono text-gray-400">Vol. Ann.</div>
              <div class="text-sm sm:text-base font-bold font-mono text-gray-900 dark:text-white tabular-nums">${vol.toFixed(2)}%</div>
            </div>
            <div class="bg-gray-50 dark:bg-white/5 p-2 rounded-lg border border-gray-100 dark:border-white/5">
              <div class="text-[10px] uppercase font-mono text-gray-400">Sharpe</div>
              <div class="text-sm sm:text-base font-bold font-mono tabular-nums ${sharpe >= 1 ? 'text-emerald-600 dark:text-emerald-400' : (sharpe < 0 ? 'text-rose-600 dark:text-rose-400' : 'text-gray-900 dark:text-white')}">${sharpe >= 0 ? '+' : ''}${sharpe.toFixed(2)}</div>
            </div>
          </div>
          <div class="flex items-center justify-between text-[11px] font-mono text-gray-400">
            <span>Dati: <strong>${pts} gg</strong></span>
            <span class="text-[10px] text-gray-400" title="Volatilità annualizzata calcolata su 252 giorni">252gg</span>
          </div>
        </div>
      `;
    },

    // 19. Multi-Period Performance Matrix
    performanceMatrix: (data) => {
      const m = data.performanceMetrics || {};
      const twrMap = m.twr || {};
      const gainMap = m.periodGain || {};

      const periods = [
        { key: '1M', label: '1 Mese', years: 1/12 },
        { key: '3M', label: '3 Mesi', years: 0.25 },
        { key: '6M', label: '6 Mesi', years: 0.5 },
        { key: '1Y', label: '1 Anno', years: 1.0 },
        { key: '3Y', label: '3 Anni', years: 3.0 },
        { key: '5Y', label: '5 Anni', years: 5.0 },
        { key: 'ALL', label: 'Da Inizio', years: null }
      ];

      const rowsHtml = periods.map(p => {
        const tVal = twrMap[p.key] !== undefined ? Number(twrMap[p.key]) : null;
        const gVal = gainMap[p.key] !== undefined ? Number(gainMap[p.key]) : null;
        const hasData = tVal !== null;
        const isPos = (tVal || 0) >= 0;
        let annStr = '-';
        if (hasData && p.years && p.years >= 2.0 && tVal > -100) {
          const ann = (Math.pow(1.0 + tVal / 100.0, 1.0 / p.years) - 1.0) * 100.0;
          annStr = `${ann >= 0 ? '+' : ''}${ann.toFixed(2)}% p.a.`;
        }

        return `
          <tr class="border-b border-gray-100 dark:border-white/5 hover:bg-gray-50/50 dark:hover:bg-white/5 transition">
            <th scope="row" class="py-1.5 px-3 font-mono font-medium text-gray-900 dark:text-gray-100 text-left sticky left-0 bg-white dark:bg-[#1a1a1c] z-10">${p.label}</th>
            <td class="py-1.5 px-3 text-right">
              ${hasData ? `<span class="${isPos ? 'badge-profit' : 'badge-loss'} font-mono text-[11px]">${formatPct(tVal)}</span>` : '<span class="text-gray-400 font-mono text-xs">--</span>'}
            </td>
            <td class="py-1.5 px-3 font-mono text-right text-xs ${hasData ? (gVal >= 0 ? 'text-emerald-600 dark:text-emerald-400 font-medium' : 'text-rose-600 dark:text-rose-400 font-medium') : 'text-gray-400'}">
              ${hasData ? formatEurSigned(gVal) : '--'}
            </td>
            <td class="py-1.5 px-3 font-mono text-right text-xs text-gray-500 dark:text-gray-400 hidden sm:table-cell">
              ${annStr}
            </td>
            <td class="py-1.5 px-3 text-right text-[11px] font-mono">
              ${hasData ? (isPos ? '<span class="text-emerald-600 dark:text-emerald-400 font-bold">▲ Guadagno</span>' : '<span class="text-rose-600 dark:text-rose-400 font-bold">▼ Perdita</span>') : '--'}
            </td>
          </tr>
        `;
      }).join('');

      return `
        <div class="h-full flex flex-col justify-between">
          <div class="flex items-center justify-between pb-2 border-b border-gray-100 dark:border-white/5">
            <div>
              <div class="flex items-center space-x-2">
                <span class="text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">Matrice Rendimenti</span>
                <span class="badge-profit text-[10px] uppercase font-mono">TWRR</span>
              </div>
              <div class="text-[11px] font-mono text-gray-400">Rendimenti e guadagni per periodo</div>
            </div>
            <button type="button" data-action="recalculate-perf" title="Ricalcola serie e indicatori" class="p-1 text-gray-400 hover:text-emerald-500 rounded transition cursor-pointer">
              <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
            </button>
          </div>

          <div role="region" tabindex="0" aria-label="Tabella rendimenti per periodo" class="flex-1 overflow-x-auto overflow-y-auto my-2 no-scrollbar">
            <table class="w-full text-left text-xs border-collapse">
              <thead class="sticky top-0 bg-gray-50/90 dark:bg-[#151518]/90 backdrop-blur z-20 text-[10px] uppercase font-mono text-gray-500 dark:text-gray-400 border-b border-gray-200 dark:border-white/10">
                <tr>
                  <th scope="col" class="py-1.5 px-3">Periodo</th>
                  <th scope="col" class="py-1.5 px-3 text-right">Rend. TWRR</th>
                  <th scope="col" class="py-1.5 px-3 text-right">Guadagno</th>
                  <th scope="col" class="py-1.5 px-3 text-right hidden sm:table-cell">Annualizzato</th>
                  <th scope="col" class="py-1.5 px-3 text-right">Stato</th>
                </tr>
              </thead>
              <tbody>
                ${rowsHtml}
              </tbody>
            </table>
          </div>

          <div class="pt-2 border-t border-gray-100 dark:border-white/5 flex items-center justify-between text-[10px] font-mono text-gray-400">
            <span>TWRR depurato da flussi</span>
            <span class="text-emerald-600 dark:text-emerald-400 font-semibold cursor-pointer hover:underline" onclick="FolioTrackDashboard.openDrawer()">Personalizza</span>
          </div>
        </div>
      `;
    }
  };

  /**
   * Helper to render or update a Chart.js Donut
   */
  function renderDonutChart(canvasId, labels, values) {
    const canvas = document.getElementById(canvasId);
    if (!canvas || typeof Chart === 'undefined') return;

    if (activeCharts[canvasId]) {
      activeCharts[canvasId].destroy();
      delete activeCharts[canvasId];
    }

    const hasData = values && values.some(v => v > 0);
    const chartLabels = hasData ? labels : ['Nessun Dato'];
    const chartData = hasData ? values : [1];
    const bgColors = hasData
      ? PASTEL_COLORS.slice(0, labels.length)
      : ['#9c998e33'];

    const isDark = document.documentElement.classList.contains('dark');
    const textColor = isDark ? '#a1a1aa' : '#71717a';

    activeCharts[canvasId] = new Chart(canvas, {
      type: 'doughnut',
      data: {
        labels: chartLabels,
        datasets: [{
          data: chartData,
          backgroundColor: bgColors,
          borderWidth: 1.5,
          borderColor: isDark ? '#141416' : '#ffffff'
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            position: 'right',
            labels: {
              boxWidth: 8,
              boxHeight: 8,
              color: textColor,
              font: { family: 'JetBrains Mono', size: 9 },
              padding: 6
            }
          },
          tooltip: {
            callbacks: {
              label: (ctx) => {
                if (!hasData) return ' Nessun Dato';
                return ` ${ctx.label}: ${formatEur(ctx.raw)}`;
              }
            }
          }
        },
        cutout: '68%'
      }
    });
  }

  /**
   * Renders all chart widgets with active data
   */
  function renderAllCharts(data) {
    if (!data) return;

    // Accounts Chart: Portfolios (Aggregate) or Assets vs Cash (Individual)
    if (data.isAggregate) {
      const accLabels = (data.portfolios || []).map(p => p.name);
      const accValues = (data.portfolios || []).map(p => p.totalValue);
      renderDonutChart('chart-accounts', accLabels, accValues);
    } else {
      const p = data.selectedPortfolio || (data.portfolios && data.portfolios[0]);
      const cashVal = p?.metrics?.currentCash || 0;
      const assetVal = Math.max(0, (p?.metrics?.totalValue || 0) - cashVal);
      renderDonutChart('chart-accounts', ['Titoli', 'Liquidità'], [assetVal, cashVal]);
    }

    // Asset Classes Chart
    const allocClasses = (data.totals && data.totals.allocations && data.totals.allocations.byAssetClass) || {};
    const clsLabels = Object.keys(allocClasses);
    const clsValues = clsLabels.map(k => allocClasses[k].value);
    renderDonutChart('chart-classes', clsLabels, clsValues);

    // Regions Chart
    const allocRegions = (data.totals && data.totals.allocations && data.totals.allocations.byRegion) || {};
    const regLabels = Object.keys(allocRegions);
    const regValues = regLabels.map(k => allocRegions[k].value);
    renderDonutChart('chart-regions', regLabels, regValues);

    // GICS Sectors Chart
    const allocSectors = (data.totals && data.totals.allocations && data.totals.allocations.bySector) || {};
    const secLabels = Object.keys(allocSectors);
    const secValues = secLabels.map(k => allocSectors[k].value);
    renderDonutChart('chart-sectors', secLabels, secValues);

    // Performance & Net Worth History Chart
    if (!hiddenWidgets.has('performanceChart')) {
      renderPerformanceChart(selectedPortfolioId, activeHistoryRange, activeHistoryMetric);
    }
  }

  /**
   * Helper to render or update the Performance & NAV history line chart
   */
  async function renderPerformanceChart(portfolioId, range, metric) {
    const canvas = document.getElementById('chart-performance');
    if (!canvas || typeof Chart === 'undefined') return;

    const loadingEl = document.getElementById('chart-perf-loading');
    if (loadingEl) loadingEl.classList.remove('hidden');

    try {
      const q = portfolioId && portfolioId !== 'all'
        ? `portfolioId=${encodeURIComponent(portfolioId)}&range=${encodeURIComponent(range)}`
        : `range=${encodeURIComponent(range)}`;

      const res = await fetch(`/api/history/performance?${q}`);
      if (!res.ok) throw new Error('Network error');
      const data = await res.json();
      if (!data.success) throw new Error(data.error || 'API error');

      const series = data.series || [];
      const isMetricNav = metric === 'NAV';

      // Update widget header dynamic badges
      const valEl = document.getElementById('perf-display-val');
      const badgeEl = document.getElementById('perf-display-badge');
      const ddEl = document.getElementById('perf-display-dd');
      const rangeLblEl = document.getElementById('perf-display-range-lbl');

      if (series.length > 0) {
        const first = series[0];
        const last = series[series.length - 1];

        // Period-congruent gain and return % (immune to deposits/withdrawals)
        const periodGain = data.periodGain !== undefined
          ? data.periodGain
          : (last.totalValue - first.totalValue - (last.netDeposits - first.netDeposits));
        
        const periodPct = data.periodReturnPercent !== undefined
          ? data.periodReturnPercent
          : (last.periodReturnPercent !== undefined ? last.periodReturnPercent : (first.totalValue > 0 ? (periodGain / first.totalValue) * 100 : 0));

        const isPos = isMetricNav ? (periodGain >= 0) : (periodPct >= 0);

        if (valEl) {
          valEl.textContent = isMetricNav ? formatEur(last.totalValue) : formatPct(periodPct);
        }
        if (badgeEl) {
          badgeEl.className = isPos ? 'badge-profit text-xs font-mono font-semibold' : 'badge-loss text-xs font-mono font-semibold';
          badgeEl.textContent = isMetricNav
            ? `${formatEurSigned(periodGain)} (${formatPct(periodPct)})`
            : `${formatEurSigned(periodGain)} nel periodo ${range}`;
        }
        if (ddEl) {
          ddEl.textContent = `Max DD: -${(data.maxDrawdown || 0).toFixed(2)}%`;
        }
        if (rangeLblEl) {
          rangeLblEl.textContent = `Dal ${first.date} al ${last.date} (${range})`;
        }
      } else {
        if (valEl) valEl.textContent = formatEur(0);
        if (badgeEl) {
          badgeEl.className = 'badge-profit text-xs font-mono';
          badgeEl.textContent = 'Inizializzazione...';
        }
        if (rangeLblEl) rangeLblEl.textContent = `Periodo: ${range}`;
        if (ddEl) ddEl.textContent = 'Max DD: 0.00%';
      }

      if (activeCharts['chart-performance']) {
        activeCharts['chart-performance'].destroy();
        delete activeCharts['chart-performance'];
      }

      const isDark = document.documentElement.classList.contains('dark');
      const textColor = isDark ? '#a1a1aa' : '#71717a';
      const gridColor = isDark ? 'rgba(255, 255, 255, 0.05)' : 'rgba(0, 0, 0, 0.05)';

      const isMultiYear = range === '1Y' || range === '3Y' || range === '5Y' || range === 'ALL';
      const labels = series.map(s => {
        const parts = s.date.split('-');
        if (parts.length === 3) {
          return isMultiYear ? `${parts[1]}/${parts[0].slice(2)}` : `${parts[2]}/${parts[1]}`;
        }
        return s.date;
      });

      const values = series.map(s => {
        if (isMetricNav) return s.totalValue;
        return s.periodReturnPercent !== undefined ? s.periodReturnPercent : s.returnPercent;
      });
      const periodPct = data.periodReturnPercent !== undefined ? data.periodReturnPercent : 0;
      const isPositiveOverall = isMetricNav
        ? (values.length > 0 && values[values.length - 1] >= values[0])
        : (periodPct >= 0);
      const primaryColor = isPositiveOverall ? '#10b981' : '#f43f5e';
      const fillGradientColor = isPositiveOverall ? 'rgba(16, 185, 129, 0.22)' : 'rgba(244, 63, 94, 0.22)';

      const ctx = canvas.getContext('2d');
      const gradient = ctx.createLinearGradient(0, 0, 0, canvas.clientHeight || 200);
      gradient.addColorStop(0, fillGradientColor);
      gradient.addColorStop(1, 'rgba(0, 0, 0, 0.0)');

      activeCharts['chart-performance'] = new Chart(canvas, {
        type: 'line',
        data: {
          labels,
          datasets: [{
            label: isMetricNav ? 'Patrimonio (€)' : `Rendimento ${range} (%)`,
            data: values,
            borderColor: primaryColor,
            borderWidth: 2,
            backgroundColor: gradient,
            fill: true,
            tension: 0.25,
            pointRadius: series.length > 60 ? 0 : 2,
            pointHoverRadius: 5,
            pointBackgroundColor: primaryColor,
            pointBorderColor: '#ffffff',
            pointBorderWidth: 1.5
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
                  return series[idx] ? `Data: ${series[idx].date}` : '';
                },
                label: (ctx) => {
                  const idx = ctx.dataIndex;
                  const item = series[idx];
                  if (!item) return '';
                  const itemPeriodPct = item.periodReturnPercent !== undefined ? item.periodReturnPercent : item.returnPercent;
                  return isMetricNav
                    ? ` Patrimonio: ${formatEur(item.totalValue)}`
                    : ` Rendimento (${range}): ${formatPct(itemPeriodPct)}`;
                },
                afterLabel: (ctx) => {
                  const idx = ctx.dataIndex;
                  const item = series[idx];
                  if (!item) return '';
                  const itemPeriodPct = item.periodReturnPercent !== undefined ? item.periodReturnPercent : item.returnPercent;
                  return [
                    ` Titoli: ${formatEur(item.assetValue)}`,
                    ` Liquidità: ${formatEur(item.cashValue)}`,
                    ` Rendimento periodo: ${formatPct(itemPeriodPct)}`,
                    ` Rendimento totale: ${formatPct(item.returnPercent)}`,
                    ` Drawdown: -${(item.drawdownPercent || 0).toFixed(2)}%`
                  ];
                }
              }
            }
          },
          scales: {
            x: {
              grid: { display: false },
              ticks: {
                color: textColor,
                font: { family: 'JetBrains Mono', size: 9 },
                maxTicksLimit: 8
              }
            },
            y: {
              grid: { color: gridColor },
              ticks: {
                color: textColor,
                font: { family: 'JetBrains Mono', size: 9 },
                callback: (val) => isMetricNav ? formatEur(val) : formatPct(val)
              }
            }
          }
        }
      });
    } catch (err) {
      console.warn('[Dashboard Warning] Performance chart update:', err.message);
    } finally {
      if (loadingEl) loadingEl.classList.add('hidden');
    }
  }

  /**
   * Temporary dashboard toast notification
   */
  function showDashboardToast(msg, isError = false) {
    let t = document.getElementById('dashboard-live-toast');
    if (!t) {
      t = document.createElement('div');
      t.id = 'dashboard-live-toast';
      document.body.appendChild(t);
    }
    t.className = `fixed bottom-6 right-6 z-50 px-5 py-3 rounded-2xl shadow-xl flex items-center space-x-2 text-xs font-mono font-semibold transition-all transform duration-300 ${
      isError ? 'bg-rose-600 text-white' : 'bg-emerald-600 text-white'
    }`;
    t.innerHTML = `<span>${isError ? '⚠️' : '✓'}</span><span>${msg}</span>`;
    t.classList.remove('hidden', 'opacity-0', 'translate-y-4');
    setTimeout(() => {
      t.classList.add('opacity-0', 'translate-y-4');
      setTimeout(() => t.classList.add('hidden'), 300);
    }, 4500);
  }

  /**
   * Triggers historical performance recalculation and history reconstruction on demand
   */
  async function handleRecalculatePerformance(buttonEl) {
    if (buttonEl) buttonEl.disabled = true;
    const icon = buttonEl ? buttonEl.querySelector('svg') : null;
    if (icon) icon.classList.add('animate-spin');

    const loadingEl = document.getElementById('chart-perf-loading');
    if (loadingEl) {
      loadingEl.textContent = 'Ricostruzione storico e ricalcolo indicatori in corso...';
      loadingEl.classList.remove('hidden');
    }

    try {
      showDashboardToast('🚀 Avvio ricostruzione serie storica e ricalcolo indicatori...');
      const res = await fetch('/api/history/recalculate-performance', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          portfolioId: selectedPortfolioId,
          daysBack: 1825,
          syncQuotes: true
        })
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error || 'Errore ricalcolo performance');

      // Refresh chart and entire dashboard view
      await renderPerformanceChart(selectedPortfolioId, activeHistoryRange, activeHistoryMetric);
      
      const m = data.metrics || {};
      currentPerformanceMetrics = m;
      const activeView = getViewData(rawPortfolioData, selectedPortfolioId);
      updateWidgetContents(activeView);

      const twr1y = m.twr && m.twr['1Y'] !== undefined ? `${m.twr['1Y'] >= 0 ? '+' : ''}${m.twr['1Y']}%` : 'N/D';
      const xirrStr = m.xirr !== undefined ? `${m.xirr >= 0 ? '+' : ''}${m.xirr}%` : 'N/D';
      const ddStr = m.maxDrawdown !== undefined ? `-${m.maxDrawdown}%` : 'N/D';

      showDashboardToast(`✓ Storico ricalcolato (${data.pointsReconstructed || 0} punti). TWR 1A: ${twr1y} • XIRR: ${xirrStr} • Max DD: ${ddStr}`);
    } catch (err) {
      console.warn('Error recalculating performance:', err);
      showDashboardToast('Errore durante il ricalcolo degli indicatori: ' + err.message, true);
    } finally {
      if (icon) icon.classList.remove('animate-spin');
      if (buttonEl) buttonEl.disabled = false;
      if (loadingEl) loadingEl.classList.add('hidden');
    }
  }

  /**
   * Updates only widget DOM contents and charts without destroying GridStack layout
   */
  function updateWidgetContents(viewData) {
    for (const item of WIDGET_DEFINITIONS) {
      if (hiddenWidgets.has(item.id)) continue;
      const bodyEl = document.getElementById(`widget-body-${item.id}`);
      const renderer = WIDGET_RENDERERS[item.id];
      if (bodyEl && renderer) {
        bodyEl.innerHTML = renderer(viewData);
      }
    }
    setTimeout(() => {
      renderAllCharts(viewData);
    }, 50);
  }

  /**
   * Automatically packs an ordered list of mobile widgets into a 2-column grid
   * ensuring 1-column widgets are paired side-by-side and 2-column widgets span full width.
   */
  function repackMobileCoordinates(orderedItems) {
    let curY = 0;
    let curCol = 0; // 0 or 1
    let col0Height = 0;
    let col1Height = 0;

    return orderedItems.map(item => {
      const isFullWidth = item.w === 2;
      const h = Number.isInteger(item.h) && item.h > 0 ? item.h : 2;
      let x = 0;
      let y = 0;

      if (isFullWidth) {
        if (curCol === 1) {
          curY += Math.max(col0Height, 2);
          curCol = 0;
          col0Height = 0;
          col1Height = 0;
        }
        x = 0;
        y = curY;
        curY += h;
      } else {
        if (curCol === 0) {
          x = 0;
          y = curY;
          col0Height = h;
          curCol = 1;
        } else {
          x = 1;
          y = curY;
          col1Height = h;
          curY += Math.max(col0Height, col1Height);
          curCol = 0;
          col0Height = 0;
          col1Height = 0;
        }
      }

      return {
        ...item,
        w: isFullWidth ? 2 : 1,
        h,
        x,
        y
      };
    });
  }

  /**
   * Moves a widget one step up in the visual flow and re-packs the layout
   */
  async function moveWidgetUp(widgetId) {
    const isMobile = isMobileDashboard();
    const layout = getCurrentGridLayout() || (isMobile ? MOBILE_DEFAULT_LAYOUT : WIDGET_DEFINITIONS);
    const sorted = [...layout].sort((a, b) => {
      const yDiff = (a.y ?? 0) - (b.y ?? 0);
      if (yDiff !== 0) return yDiff;
      return (a.x ?? 0) - (b.x ?? 0);
    });

    const idx = sorted.findIndex(item => item.id === widgetId);
    if (idx > 0) {
      const temp = sorted[idx];
      sorted[idx] = sorted[idx - 1];
      sorted[idx - 1] = temp;

      if (isMobile) {
        currentSavedLayout = repackMobileCoordinates(sorted);
      } else {
        const prevX = sorted[idx - 1].x;
        const prevY = sorted[idx - 1].y;
        sorted[idx - 1].x = sorted[idx].x;
        sorted[idx - 1].y = sorted[idx].y;
        sorted[idx].x = prevX;
        sorted[idx].y = prevY;
        currentSavedLayout = sorted;
      }

      await saveCurrentLayout(false);
      await initGrid(currentSavedLayout);
      updateVisibilityDrawerUI();
    }
  }

  /**
   * Moves a widget one step down in the visual flow and re-packs the layout
   */
  async function moveWidgetDown(widgetId) {
    const isMobile = isMobileDashboard();
    const layout = getCurrentGridLayout() || (isMobile ? MOBILE_DEFAULT_LAYOUT : WIDGET_DEFINITIONS);
    const sorted = [...layout].sort((a, b) => {
      const yDiff = (a.y ?? 0) - (b.y ?? 0);
      if (yDiff !== 0) return yDiff;
      return (a.x ?? 0) - (b.x ?? 0);
    });

    const idx = sorted.findIndex(item => item.id === widgetId);
    if (idx >= 0 && idx < sorted.length - 1) {
      const temp = sorted[idx];
      sorted[idx] = sorted[idx + 1];
      sorted[idx + 1] = temp;

      if (isMobile) {
        currentSavedLayout = repackMobileCoordinates(sorted);
      } else {
        const nextX = sorted[idx + 1].x;
        const nextY = sorted[idx + 1].y;
        sorted[idx + 1].x = sorted[idx].x;
        sorted[idx + 1].y = sorted[idx].y;
        sorted[idx].x = nextX;
        sorted[idx].y = nextY;
        currentSavedLayout = sorted;
      }

      await saveCurrentLayout(false);
      await initGrid(currentSavedLayout);
      updateVisibilityDrawerUI();
    }
  }

  /**
   * Updates the Widget Management Drawer with interactive visibility checkboxes
   */
  function updateVisibilityDrawerUI() {
    const listContainer = document.getElementById('widget-visibility-list');
    const drawerCountEl = document.getElementById('drawer-visible-count');
    const headerCountEl = document.getElementById('visible-widgets-count');

    const totalCount = WIDGET_DEFINITIONS.length;
    const visibleCount = totalCount - hiddenWidgets.size;

    if (drawerCountEl) drawerCountEl.textContent = `${visibleCount} / ${totalCount}`;
    if (headerCountEl) headerCountEl.textContent = `${visibleCount}`;

    if (!listContainer) return;

    const isMobile = isMobileDashboard();
    const activeLayout = currentSavedLayout || (isMobile ? MOBILE_DEFAULT_LAYOUT : WIDGET_DEFINITIONS);
    const orderMap = new Map();
    activeLayout.forEach((item, index) => {
      orderMap.set(item.id, index);
    });

    const query = (widgetSearchQuery || '').toLowerCase().trim();
    const baseList = query
      ? WIDGET_DEFINITIONS.filter(item => (item.name || '').toLowerCase().includes(query) || (item.category || '').toLowerCase().includes(query))
      : WIDGET_DEFINITIONS;

    const sortedWidgets = [...baseList].sort((a, b) => {
      const orderA = orderMap.has(a.id) ? orderMap.get(a.id) : 999;
      const orderB = orderMap.has(b.id) ? orderMap.get(b.id) : 999;
      return orderA - orderB;
    });

    if (sortedWidgets.length === 0) {
      listContainer.innerHTML = `
        <div class="p-6 text-center text-xs font-mono text-gray-400">
          Nessun widget trovato per "${widgetSearchQuery}".
        </div>
      `;
      return;
    }

    listContainer.innerHTML = sortedWidgets.map((item, idx) => {
      const isVisible = !hiddenWidgets.has(item.id);
      return `
        <div class="flex items-center justify-between p-2 rounded-xl border transition ${isVisible ? 'bg-gray-50/70 dark:bg-white/[0.03] border-gray-200/80 dark:border-white/10' : 'bg-transparent border-gray-100 dark:border-white/5 opacity-60'}">
          <label class="flex items-center space-x-2.5 cursor-pointer flex-1 min-w-0" for="widget-chk-${item.id}">
            <input type="checkbox" id="widget-chk-${item.id}" data-widget-checkbox="${item.id}" ${isVisible ? 'checked' : ''} class="w-4 h-4 rounded text-emerald-600 focus:ring-emerald-500 cursor-pointer accent-emerald-600">
            <div class="truncate">
              <div class="text-xs font-semibold text-gray-900 dark:text-white truncate">${item.name}</div>
              <div class="text-[10px] text-gray-400 font-mono">${item.category || 'Widget'}</div>
            </div>
          </label>
          <div class="flex items-center space-x-1 shrink-0 ml-2">
            <button type="button" data-move-widget-up="${item.id}" class="p-1.5 rounded-lg text-gray-500 hover:text-emerald-500 bg-gray-100 dark:bg-white/5 active:scale-90 transition ${idx === 0 ? 'opacity-30 pointer-events-none' : ''}" title="Sposta in alto">
              <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M5 15l7-7 7 7" />
              </svg>
            </button>
            <button type="button" data-move-widget-down="${item.id}" class="p-1.5 rounded-lg text-gray-500 hover:text-emerald-500 bg-gray-100 dark:bg-white/5 active:scale-90 transition ${idx === sortedWidgets.length - 1 ? 'opacity-30 pointer-events-none' : ''}" title="Sposta in basso">
              <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M19 9l-7 7-7-7" />
              </svg>
            </button>
          </div>
        </div>
      `;
    }).join('');
  }

  /**
   * Toggles visibility for an individual widget
   */
  async function setWidgetVisibility(widgetId, isVisible) {
    // Capture current grid layout so any drag/resize isn't lost
    const current = getCurrentGridLayout();
    if (current && current.length > 0) {
      currentSavedLayout = current;
    }

    if (isVisible) {
      hiddenWidgets.delete(widgetId);
    } else {
      hiddenWidgets.add(widgetId);
    }
    localStorage.setItem('foliotrack_hidden_widgets', JSON.stringify([...hiddenWidgets]));
    saveHiddenWidgetsSetting();
    scheduleAutoSaveLayout(true);
    await initGrid(currentSavedLayout);
  }

  /**
   * Shows all widgets
   */
  async function showAllWidgets() {
    const current = getCurrentGridLayout();
    if (current && current.length > 0) {
      currentSavedLayout = current;
    }
    hiddenWidgets.clear();
    localStorage.setItem('foliotrack_hidden_widgets', JSON.stringify([]));
    saveHiddenWidgetsSetting();
    scheduleAutoSaveLayout(true);
    await initGrid(currentSavedLayout);
  }

  /**
   * Resets widgets to default visibility
   */
  async function resetDefaultWidgets() {
    hiddenWidgets.clear();
    localStorage.setItem('foliotrack_hidden_widgets', JSON.stringify([]));
    saveHiddenWidgetsSetting();
    const isMobile = isMobileDashboard();
    currentSavedLayout = (isMobile ? MOBILE_DEFAULT_LAYOUT : WIDGET_DEFINITIONS).map(d => ({ ...d }));
    scheduleAutoSaveLayout(true);
    await initGrid(currentSavedLayout);
  }

  async function saveHiddenWidgetsSetting() {
    try {
      await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          key: 'hiddenWidgets',
          value: JSON.stringify([...hiddenWidgets]),
          encrypted: false
        })
      });
    } catch {}
  }

  async function loadHiddenWidgets() {
    try {
      const local = localStorage.getItem('foliotrack_hidden_widgets');
      if (local) {
        const arr = JSON.parse(local);
        if (Array.isArray(arr)) {
          hiddenWidgets = new Set(arr);
        }
      }
    } catch {}

    try {
      const res = await fetch('/api/settings/hiddenWidgets');
      if (res.ok) {
        const data = await res.json();
        if (data.success && data.value) {
          const arr = typeof data.value === 'string' ? JSON.parse(data.value) : data.value;
          if (Array.isArray(arr)) {
            hiddenWidgets = new Set(arr);
            localStorage.setItem('foliotrack_hidden_widgets', JSON.stringify(arr));
          }
        }
      }
    } catch {}
  }

  /**
   * Extracts current grid coordinates for all 21 widgets, guaranteeing
   * integer positions and preserving positions of hidden widgets.
   */
  function getCurrentGridLayout() {
    const isMobile = isMobileDashboard();
    const defaultList = isMobile ? MOBILE_DEFAULT_LAYOUT : WIDGET_DEFINITIONS;
    if (!grid) return currentSavedLayout;

    const nodeMap = new Map();
    const currentNodes = grid.engine ? (grid.engine.nodes || []) : [];

    currentNodes.forEach(n => {
      if (n.id) {
        nodeMap.set(n.id, {
          id: n.id,
          x: Number.isInteger(n.x) ? (isMobile ? Math.min(1, Math.max(0, n.x)) : n.x) : 0,
          y: Number.isInteger(n.y) ? n.y : 0,
          w: (Number.isInteger(n.w) && n.w > 0) ? (isMobile ? Math.min(2, Math.max(1, n.w)) : n.w) : (isMobile ? 1 : 2),
          h: (Number.isInteger(n.h) && n.h > 0) ? n.h : 2
        });
      }
    });

    // Also inspect DOM elements in case node attributes have fresher values
    document.querySelectorAll('.grid-stack-item').forEach(el => {
      const card = el.querySelector('[data-widget-card-id]');
      const id = el.getAttribute('gs-id') || (card ? card.getAttribute('data-widget-card-id') : null);
      if (!id) return;
      const x = parseInt(el.getAttribute('gs-x'), 10);
      const y = parseInt(el.getAttribute('gs-y'), 10);
      let w = parseInt(el.getAttribute('gs-w'), 10);
      const h = parseInt(el.getAttribute('gs-h'), 10);
      if (isMobile && !isNaN(w) && w > 2) w = 2;
      if (!isNaN(x) && !isNaN(y)) {
        nodeMap.set(id, {
          id,
          x: isMobile ? Math.min(1, Math.max(0, x)) : x,
          y,
          w: !isNaN(w) && w > 0 ? (isMobile ? Math.min(2, Math.max(1, w)) : w) : (nodeMap.get(id)?.w || (isMobile ? 1 : 2)),
          h: !isNaN(h) && h > 0 ? h : (nodeMap.get(id)?.h || 2)
        });
      }
    });

    // Build complete layout for all widgets (visible + hidden)
    const fullLayout = [];
    for (const def of defaultList) {
      const active = nodeMap.get(def.id);
      if (active) {
        fullLayout.push({
          id: def.id,
          x: active.x,
          y: active.y,
          w: active.w || def.w || (isMobile ? 1 : 2),
          h: active.h || def.h || 2
        });
      } else {
        const prev = (currentSavedLayout || []).find(p => p.id === def.id);
        fullLayout.push({
          id: def.id,
          x: prev && Number.isInteger(prev.x) ? (isMobile ? Math.min(1, Math.max(0, prev.x)) : prev.x) : (def.x || 0),
          y: prev && Number.isInteger(prev.y) ? prev.y : (def.y || 0),
          w: prev && Number.isInteger(prev.w) && prev.w > 0 ? (isMobile ? Math.min(2, prev.w) : prev.w) : (def.w || (isMobile ? 1 : 2)),
          h: prev && Number.isInteger(prev.h) && prev.h > 0 ? prev.h : (def.h || 2)
        });
      }
    }

    return fullLayout;
  }

  /**
   * Persists layout changes to SQLite DB (/api/settings) and localStorage
   */
  async function saveCurrentLayout(showToast = false) {
    const layoutArray = getCurrentGridLayout();
    if (!layoutArray || layoutArray.length === 0) return;

    currentSavedLayout = layoutArray;

    const storageKey = getLayoutStorageKey();
    const settingKey = getLayoutSettingKey();

    // 1. Immediately store in localStorage for instant access
    try {
      localStorage.setItem(storageKey, JSON.stringify(layoutArray));
      if (!isMobileDashboard()) {
        localStorage.setItem('foliotrack_dashboard_layout', JSON.stringify(layoutArray));
      }
    } catch {}

    // 2. Persist to server database via PUT /api/settings
    try {
      await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          key: settingKey,
          value: JSON.stringify(layoutArray),
          encrypted: false
        })
      });

      await saveHiddenWidgetsSetting();

      if (showToast) {
        const toast = document.getElementById('save-toast');
        if (toast) {
          toast.classList.remove('hidden');
          setTimeout(() => toast.classList.add('hidden'), 2500);
        }
      }
    } catch (err) {
      console.error('[Dashboard Error] Failed to persist layout to server:', err);
    }
  }

  /**
   * Schedules debounced auto-save or executes immediately
   */
  function scheduleAutoSaveLayout(immediate = false) {
    if (autoSaveTimer) {
      clearTimeout(autoSaveTimer);
      autoSaveTimer = null;
    }
    if (immediate) {
      saveCurrentLayout(false);
    } else {
      autoSaveTimer = setTimeout(() => {
        saveCurrentLayout(false);
      }, 500);
    }
  }

  /**
   * Initializes GridStack with layout persistence, auto-save and visibility filtering
   */
  async function initGrid(savedLayout) {
    const gridContainer = document.querySelector('.grid-stack');
    if (!gridContainer || !window.GridStack) return;

    const isMobile = isMobileDashboard();
    const defaultList = isMobile ? MOBILE_DEFAULT_LAYOUT : WIDGET_DEFINITIONS;

    if (savedLayout && Array.isArray(savedLayout) && savedLayout.length > 0) {
      if (isMobile && savedLayout.some(item => (item.w || 0) > 2)) {
        currentSavedLayout = defaultList.map(d => ({ ...d }));
      } else {
        currentSavedLayout = savedLayout;
      }
    } else if (!currentSavedLayout || (isMobile && currentSavedLayout.some(item => (item.w || 0) > 2))) {
      currentSavedLayout = defaultList.map(d => ({ ...d }));
    }

    if (grid) {
      grid.destroy(false);
      gridContainer.innerHTML = '';
    }

    if (isMobile) {
      grid = GridStack.init({
        column: 2,
        cellHeight: 68,
        animate: true,
        margin: 4,
        staticGrid: !isCustomizing,
        draggable: { handle: '.widget-drag-handle' },
        resizable: { handles: 'se,sw' }
      }, gridContainer);
    } else {
      grid = GridStack.init({
        column: 12,
        cellHeight: 85,
        animate: true,
        margin: 12,
        staticGrid: !isCustomizing,
        draggable: { handle: '.widget-drag-handle' },
        resizable: { handles: 'se,sw' }
      }, gridContainer);
    }

    // Auto-save layout on any movement, drag or resize
    grid.on('change', function(event, items) {
      if (items && items.length > 0) {
        scheduleAutoSaveLayout(false);
      }
    });

    grid.on('dragstop', function() {
      scheduleAutoSaveLayout(false);
    });

    grid.on('resizestop', function() {
      scheduleAutoSaveLayout(false);
    });

    let layoutToApply = [];
    if (currentSavedLayout && Array.isArray(currentSavedLayout) && currentSavedLayout.length > 0) {
      layoutToApply = currentSavedLayout.map(item => {
        const effectiveId = item.id === 'movers' ? 'moversDay' : item.id;
        const def = defaultList.find(d => d.id === effectiveId) || {};
        let w = (Number.isInteger(item.w) && item.w > 0) ? item.w : (def.w || (isMobile ? 1 : 2));
        if (isMobile) {
          w = Math.min(2, Math.max(1, w));
        }
        return {
          ...def,
          ...item,
          id: effectiveId,
          w: w,
          h: (Number.isInteger(item.h) && item.h > 0) ? item.h : (def.h || 2),
          x: Number.isInteger(item.x) ? (isMobile ? Math.min(1, item.x) : item.x) : (def.x !== undefined ? def.x : 0),
          y: Number.isInteger(item.y) ? item.y : (def.y !== undefined ? def.y : 0)
        };
      });
      for (const def of defaultList) {
        if (!layoutToApply.some(item => item.id === def.id)) {
          layoutToApply.push({ ...def });
        }
      }
    } else {
      layoutToApply = defaultList.map(d => ({ ...d }));
    }

    // Filter out hidden widgets
    const visibleWidgets = layoutToApply.filter(item => !hiddenWidgets.has(item.id));

    // CRITICAL: Sort widgets by y ascending, then x ascending so GridStack places them top-to-bottom
    // without triggering cascading collision shifts that alter saved positions!
    visibleWidgets.sort((a, b) => {
      const yDiff = (a.y ?? 0) - (b.y ?? 0);
      if (yDiff !== 0) return yDiff;
      return (a.x ?? 0) - (b.x ?? 0);
    });

    const viewData = getViewData(rawPortfolioData, selectedPortfolioId);

    for (const item of visibleWidgets) {
      const renderer = WIDGET_RENDERERS[item.id];
      if (!renderer) continue;

      const widgetContent = renderer(viewData);

      const widgetNode = {
        id: item.id,
        x: item.x,
        y: item.y,
        w: item.w,
        h: item.h,
        minW: isMobile ? 1 : (item.minW || 2),
        maxW: isMobile ? 2 : undefined,
        minH: item.minH || 2,
        content: `
          <div class="signature-card h-full p-4 flex flex-col justify-between relative group overflow-hidden" data-widget-card-id="${item.id}">
            <div class="widget-controls ${isCustomizing ? '' : 'hidden'} absolute top-1.5 right-1.5 flex items-center space-x-0.5 z-20 bg-white/95 dark:bg-black/90 rounded-lg p-0.5 backdrop-blur shadow-md border border-gray-200/70 dark:border-white/10">
              <button type="button" class="p-1 text-gray-500 hover:text-emerald-600 dark:hover:text-emerald-400 active:scale-90 transition" data-move-widget-up="${item.id}" title="Sposta in alto">
                <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M5 15l7-7 7 7" />
                </svg>
              </button>
              <button type="button" class="p-1 text-gray-500 hover:text-emerald-600 dark:hover:text-emerald-400 active:scale-90 transition" data-move-widget-down="${item.id}" title="Sposta in basso">
                <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M19 9l-7 7-7-7" />
                </svg>
              </button>
              <button type="button" class="widget-hide-btn p-1 text-gray-400 hover:text-red-500 rounded transition" data-hide-widget="${item.id}" title="Nascondi questo widget">
                <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l18 18" />
                </svg>
              </button>
              <div class="widget-drag-handle p-1 text-gray-400 hover:text-gray-900 dark:hover:text-white cursor-move" title="Trascina per spostare">
                <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 8h16M4 16h16" />
                </svg>
              </div>
            </div>
            <div id="widget-body-${item.id}" class="h-full">${widgetContent}</div>
          </div>
        `
      };

      grid.addWidget(widgetNode);
    }

    updateVisibilityDrawerUI();

    setTimeout(() => {
      renderAllCharts(viewData);
    }, 50);
  }

  function openDrawer() {
    const drawer = document.getElementById('customize-drawer');
    const backdrop = document.getElementById('drawer-backdrop');
    drawer?.classList.remove('translate-x-full');
    backdrop?.classList.remove('hidden');
    widgetSearchQuery = '';
    document.querySelectorAll('#widget-search-input').forEach(inp => { inp.value = ''; });
    updateVisibilityDrawerUI();
  }

  function closeDrawer() {
    const drawer = document.getElementById('customize-drawer');
    const backdrop = document.getElementById('drawer-backdrop');
    drawer?.classList.add('translate-x-full');
    backdrop?.classList.add('hidden');
  }

  function toggleCustomization(enable) {
    if (!grid) return;
    const wasCustomizing = isCustomizing;
    isCustomizing = enable !== undefined ? enable : !isCustomizing;

    const banner = document.getElementById('customize-banner');
    const controls = document.querySelectorAll('.widget-controls');

    if (isCustomizing) {
      grid.setStatic(false);
      banner?.classList.remove('hidden');
      controls.forEach(c => c.classList.remove('hidden'));
      closeDrawer();
    } else {
      grid.setStatic(true);
      banner?.classList.add('hidden');
      controls.forEach(c => c.classList.add('hidden'));
      closeDrawer();
      if (wasCustomizing) {
        // Save immediately on exiting customization mode
        scheduleAutoSaveLayout(true);
      }
    }
  }

  async function saveLayout() {
    await saveCurrentLayout(true);
    toggleCustomization(false);
    closeDrawer();
  }

  async function loadSavedLayout() {
    const isMobile = isMobileDashboard();
    const settingKey = getLayoutSettingKey();
    const storageKey = getLayoutStorageKey();

    // 1. Try fetching persisted layout from backend settings API
    try {
      const res = await fetch(`/api/settings/${settingKey}`);
      if (res.ok) {
        const data = await res.json();
        if (data.success && data.value) {
          const parsed = typeof data.value === 'string' ? JSON.parse(data.value) : data.value;
          if (Array.isArray(parsed) && parsed.length > 0) {
            if (isMobile && parsed.some(item => (item.w || 0) > 2)) {
              console.info('[Dashboard] Saved layout for mobile contained desktop width > 2, using mobile default.');
            } else {
              currentSavedLayout = parsed;
              try {
                localStorage.setItem(storageKey, JSON.stringify(parsed));
                if (!isMobile) {
                  localStorage.setItem('foliotrack_dashboard_layout', JSON.stringify(parsed));
                }
              } catch {}
              return parsed;
            }
          }
        }
      }
    } catch (err) {
      console.warn('[Dashboard] Could not fetch saved layout from server, using local fallback:', err);
    }

    // 2. Fallback to localStorage (e.g. during offline or fast server restart)
    try {
      const local = localStorage.getItem(storageKey);
      if (local) {
        const parsed = JSON.parse(local);
        if (Array.isArray(parsed) && parsed.length > 0) {
          if (isMobile && parsed.some(item => (item.w || 0) > 2)) {
            console.info('[Dashboard] Local layout for mobile contained desktop width > 2, skipping.');
          } else {
            currentSavedLayout = parsed;
            return parsed;
          }
        }
      }
    } catch {}

    if (isMobile) {
      currentSavedLayout = MOBILE_DEFAULT_LAYOUT.map(d => ({ ...d }));
      return currentSavedLayout;
    }

    return null;
  }

  /**
   * Synchronizes and populates both desktop and mobile portfolio select dropdowns
   */
  function syncPortfolioDropdowns() {
    const desktopSel = document.getElementById('dashboardPortfolioSelect');
    const mobileSel = document.getElementById('mDashboardPortfolioSelect');

    const portfolios = rawPortfolioData?.portfolios || [];
    const optionsHtml = `
      <option value="all">🌐 Tutti i Portafogli (Aggregato)</option>
      ${portfolios.map(p => `<option value="${p.id}">${p.name} (${p.currency})</option>`).join('')}
    `;

    [desktopSel, mobileSel].forEach(sel => {
      if (!sel) return;
      sel.innerHTML = optionsHtml;
      if (portfolios.some(p => String(p.id) === String(selectedPortfolioId)) || selectedPortfolioId === 'all') {
        sel.value = selectedPortfolioId;
      } else {
        sel.value = 'all';
        selectedPortfolioId = 'all';
      }

      sel.onchange = async (e) => {
        selectedPortfolioId = e.target.value;
        localStorage.setItem('foliotrack_selected_portfolio', selectedPortfolioId);
        if (desktopSel && desktopSel !== e.target) desktopSel.value = selectedPortfolioId;
        if (mobileSel && mobileSel !== e.target) mobileSel.value = selectedPortfolioId;
        await fetchPerformanceMetrics(selectedPortfolioId);
        const activeView = getViewData(rawPortfolioData, selectedPortfolioId);
        updateWidgetContents(activeView);
        renderPerformanceChart(selectedPortfolioId, activeHistoryRange, activeHistoryMetric);
      };
    });
  }

  // Fetches live portfolio metrics and renders dashboard
  async function refreshDashboard(reinitGrid = false) {
    try {
      const res = await fetch('/api/portfolios');
      if (res.ok) {
        const data = await res.json();
        if (data.success) {
          rawPortfolioData = data;

          // Determine selected portfolio from URL or localStorage
          const urlParam = new URLSearchParams(window.location.search).get('portfolioId');
          const stored = localStorage.getItem('foliotrack_selected_portfolio');
          selectedPortfolioId = urlParam || stored || 'all';

          syncPortfolioDropdowns();

          await Promise.all([
            loadHiddenWidgets(),
            fetchPerformanceMetrics(selectedPortfolioId)
          ]);

          if (!grid || reinitGrid) {
            const savedLayout = await loadSavedLayout();
            await initGrid(savedLayout);
          } else {
            const activeView = getViewData(rawPortfolioData, selectedPortfolioId);
            updateWidgetContents(activeView);
          }
        }
      }
    } catch (err) {
      console.error('[Dashboard Error] Failed to refresh portfolio:', err);
    }
  }

  let marketSyncToastTimeout = null;

  function showMarketSyncToast(info = {}) {
    const toast = document.getElementById('market-sync-toast');
    const msgEl = document.getElementById('market-sync-toast-msg');
    if (!toast) return;

    if (msgEl) {
      if (info.updated !== undefined && info.total !== undefined) {
        msgEl.textContent = `Mercato riletto: ${info.updated}/${info.total} titoli aggiornati`;
      } else if (info.ticker) {
        msgEl.textContent = `Prezzo aggiornato per ${info.ticker}: widget allineati`;
      } else {
        msgEl.textContent = `Dati di mercato riletti: widget aggiornati`;
      }
    }

    toast.classList.remove('hidden');
    toast.classList.add('flex');

    if (marketSyncToastTimeout) clearTimeout(marketSyncToastTimeout);
    marketSyncToastTimeout = setTimeout(() => {
      toast.classList.add('hidden');
      toast.classList.remove('flex');
    }, 4000);
  }

  /**
   * Initializes real-time listener for market data update events via SSE stream
   * and cross-tab BroadcastChannel, immediately triggering widget refreshes.
   */
  function initMarketEventsListener() {
    // 1. Server-Sent Events (SSE) stream
    if (typeof EventSource !== 'undefined') {
      try {
        const es = new EventSource('/api/market/stream');
        es.onmessage = (e) => {
          try {
            const data = JSON.parse(e.data);
            if (data.type === 'MARKET_UPDATED') {
              console.log('[Dashboard SSE] Notifica rilettura mercato ricevuta:', data);
              refreshDashboard(false);
              showMarketSyncToast(data);
            }
          } catch (err) {
            // Ignore parse errors on ping
          }
        };
        es.onerror = () => {
          // EventSource handles reconnection automatically
        };
      } catch (err) {
        console.warn('[Dashboard SSE] Non disponibile:', err);
      }
    }

    // 2. Cross-tab BroadcastChannel
    if (typeof BroadcastChannel !== 'undefined') {
      try {
        const bc = new BroadcastChannel('foliotrack_market');
        bc.onmessage = (msg) => {
          if (msg.data?.type === 'MARKET_UPDATED') {
            refreshDashboard(false);
            showMarketSyncToast(msg.data);
          }
        };
      } catch {}
    }

    // 3. Window DOM event for intra-page interactions (e.g. from transaction modal or settings)
    window.addEventListener('marketUpdated', (e) => {
      refreshDashboard(false);
      showMarketSyncToast(e.detail || {});
    });
  }

  /**
   * Manually triggers a batch market price refresh from the dashboard toolbar
   */
  async function handleManualMarketRefresh(btnEl) {
    const icon = document.getElementById('refreshMarketIcon') || document.getElementById('mobileRefreshMarketIcon') || btnEl?.querySelector('svg');
    if (btnEl?.disabled) return;

    if (btnEl) btnEl.disabled = true;
    if (icon) icon.classList.add('animate-spin');

    try {
      const res = await fetch('/api/market/update-all', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ delayMs: 100 })
      });
      const data = await res.json();
      if (data.success) {
        await refreshDashboard(false);
        showMarketSyncToast(data);
      }
    } catch (err) {
      console.error('[Dashboard Manual Refresh Error]:', err);
    } finally {
      if (btnEl) btnEl.disabled = false;
      if (icon) icon.classList.remove('animate-spin');
    }
  }

  // Initialize page components
  document.addEventListener('DOMContentLoaded', async () => {
    await refreshDashboard();
    initMarketEventsListener();

    // Bind customize and visibility buttons
    document.getElementById('customizeDashboardBtn')?.addEventListener('click', () => toggleCustomization(true));
    document.getElementById('mobileCustomizeBtn')?.addEventListener('click', () => toggleCustomization(true));
    document.getElementById('drawerStartCustomizeBtn')?.addEventListener('click', () => {
      closeDrawer();
      toggleCustomization(true);
    });
    document.getElementById('widgetVisibilityBtn')?.addEventListener('click', openDrawer);
    document.getElementById('mobileVisibilityBtn')?.addEventListener('click', openDrawer);
    document.getElementById('bannerVisibilityBtn')?.addEventListener('click', openDrawer);
    document.getElementById('cancelCustomizeBtn')?.addEventListener('click', () => toggleCustomization(false));
    document.getElementById('saveLayoutBtn')?.addEventListener('click', saveLayout);
    document.getElementById('closeDrawerBtn')?.addEventListener('click', closeDrawer);
    document.getElementById('closeDrawerFooterBtn')?.addEventListener('click', closeDrawer);
    document.getElementById('cancelDrawerBtn')?.addEventListener('click', closeDrawer);
    document.getElementById('drawer-backdrop')?.addEventListener('click', closeDrawer);
    document.getElementById('drawerShowAllBtn')?.addEventListener('click', showAllWidgets);
    document.getElementById('drawerResetDefaultBtn')?.addEventListener('click', resetDefaultWidgets);

    // Global click listener for touch-friendly move widget buttons (▲ and ▼)
    document.addEventListener('click', async (e) => {
      const upBtn = e.target.closest('[data-move-widget-up]');
      if (upBtn) {
        e.preventDefault();
        e.stopPropagation();
        const id = upBtn.getAttribute('data-move-widget-up');
        if (id) await moveWidgetUp(id);
        return;
      }
      const downBtn = e.target.closest('[data-move-widget-down]');
      if (downBtn) {
        e.preventDefault();
        e.stopPropagation();
        const id = downBtn.getAttribute('data-move-widget-down');
        if (id) await moveWidgetDown(id);
        return;
      }
    });

    // Bind manual market refresh buttons
    document.getElementById('refreshMarketBtn')?.addEventListener('click', (e) => {
      handleManualMarketRefresh(e.currentTarget);
    });
    document.getElementById('mobileRefreshMarketBtn')?.addEventListener('click', (e) => {
      handleManualMarketRefresh(e.currentTarget);
    });

    // Bind search filter for widgets in drawer
    document.querySelectorAll('#widget-search-input').forEach(inp => {
      inp.addEventListener('input', (e) => {
        widgetSearchQuery = e.target.value;
        updateVisibilityDrawerUI();
      });
    });

    // Escape key closes drawer
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        closeDrawer();
      }
    });

    // Bind New Transaction button with current portfolio context
    const handleNewTx = () => {
      if (window.TransactionModal) {
        const pIdNum = selectedPortfolioId !== 'all' ? parseInt(selectedPortfolioId, 10) : undefined;
        window.TransactionModal.open({ portfolioId: pIdNum });
      }
    };
    document.getElementById('newTxBtn')?.addEventListener('click', handleNewTx);
    document.getElementById('mobileAddTxBtn')?.addEventListener('click', handleNewTx);

    // Listen to themeChanged event to re-render charts
    document.addEventListener('themeChanged', () => {
      const viewData = getViewData(rawPortfolioData, selectedPortfolioId);
      renderAllCharts(viewData);
    });

    // Listen to widgetTypographyChanged event to update charts with active typography
    document.addEventListener('widgetTypographyChanged', () => {
      const viewData = getViewData(rawPortfolioData, selectedPortfolioId);
      renderAllCharts(viewData);
    });

    // Listen to transaction updates
    document.addEventListener('transactionSaved', () => {
      refreshDashboard();
    });

    // Delegated click listeners
    document.addEventListener('click', (e) => {
      // 1. Metric toggle on Performance Chart (Valore € vs Rendimento %)
      const metricBtn = e.target.closest('[data-perf-metric]');
      if (metricBtn) {
        const m = metricBtn.getAttribute('data-perf-metric');
        if (m && m !== activeHistoryMetric) {
          activeHistoryMetric = m;
          localStorage.setItem('foliotrack_perf_metric', m);
          document.querySelectorAll('[data-perf-metric]').forEach(btn => {
            const isTarget = btn.getAttribute('data-perf-metric') === m;
            btn.className = `perf-metric-btn px-2.5 py-1 rounded-md transition text-[11px] ${isTarget ? 'bg-white dark:bg-[#1f1f22] text-gray-900 dark:text-white font-bold shadow-xs' : 'text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white'}`;
          });
          renderPerformanceChart(selectedPortfolioId, activeHistoryRange, activeHistoryMetric);
        }
      }

      // 2. Range toggle on Performance Chart (1M, 3M, 6M, 1Y, 3Y, 5Y, ALL)
      const rangeBtn = e.target.closest('[data-perf-range]');
      if (rangeBtn) {
        const r = rangeBtn.getAttribute('data-perf-range');
        if (r && r !== activeHistoryRange) {
          activeHistoryRange = r;
          localStorage.setItem('foliotrack_perf_range', r);
          document.querySelectorAll('[data-perf-range]').forEach(btn => {
            const isTarget = btn.getAttribute('data-perf-range') === r;
            btn.className = `perf-tf-btn px-2.5 py-1 rounded-lg text-[10px] font-mono font-medium transition ${isTarget ? 'bg-emerald-600 text-white font-bold shadow-xs' : 'text-gray-500 hover:text-gray-900 dark:text-gray-400 dark:hover:text-white bg-gray-100 dark:bg-white/5'}`;
          });
          renderPerformanceChart(selectedPortfolioId, activeHistoryRange, activeHistoryMetric);
        }
      }

      // 1b. TWRR period toggle on TWRR widget
      const twrrBtn = e.target.closest('[data-twrr-period]');
      if (twrrBtn) {
        const p = twrrBtn.getAttribute('data-twrr-period');
        if (p && p !== activeTwrrPeriod) {
          activeTwrrPeriod = p;
          localStorage.setItem('foliotrack_twrr_period', p);
          const activeView = getViewData(rawPortfolioData, selectedPortfolioId);
          const bodyEl = document.getElementById('widget-body-twrr');
          if (bodyEl && WIDGET_RENDERERS.twrr) {
            bodyEl.innerHTML = WIDGET_RENDERERS.twrr(activeView);
          }
        }
      }

      // 2b. Recalculate Performance on Demand
      const recalcBtn = e.target.closest('#btn-recalculate-perf') || e.target.closest('[data-action="recalculate-perf"]');
      if (recalcBtn) {
        handleRecalculatePerformance(recalcBtn);
      }

      // 3. Hide widget button on widget card
      const hideBtn = e.target.closest('[data-hide-widget]');
      if (hideBtn) {
        const wId = hideBtn.getAttribute('data-hide-widget');
        if (wId) {
          setWidgetVisibility(wId, false);
        }
      }

      // 4. Sparkline period toggle on Titoli widget
      const sparkBtn = e.target.closest('[data-sparkline-period]');
      if (sparkBtn) {
        const p = sparkBtn.getAttribute('data-sparkline-period');
        if (p && p !== activeSparklinePeriod) {
          activeSparklinePeriod = p;
          const activeView = getViewData(rawPortfolioData, selectedPortfolioId);
          const bodyEl = document.getElementById('widget-body-composition');
          if (bodyEl && WIDGET_RENDERERS.composition) {
            bodyEl.innerHTML = WIDGET_RENDERERS.composition(activeView);
          }
        }
      }

      // 5. Sort toggle on Titoli widget
      const sortBtn = e.target.closest('[data-comp-sort]');
      if (sortBtn) {
        const s = sortBtn.getAttribute('data-comp-sort');
        if (s && s !== activeCompositionSort) {
          activeCompositionSort = s;
          localStorage.setItem('foliotrack_comp_sort', s);
          const activeView = getViewData(rawPortfolioData, selectedPortfolioId);
          const bodyEl = document.getElementById('widget-body-composition');
          if (bodyEl && WIDGET_RENDERERS.composition) {
            bodyEl.innerHTML = WIDGET_RENDERERS.composition(activeView);
          }
        }
      }

      // 5b. Sort toggle on Titoli Compatti widget
      const compactSortBtn = e.target.closest('[data-compact-sort]');
      if (compactSortBtn) {
        const s = compactSortBtn.getAttribute('data-compact-sort');
        if (s && s !== activeCompactSort) {
          activeCompactSort = s;
          localStorage.setItem('foliotrack_compact_sort', s);
          const activeView = getViewData(rawPortfolioData, selectedPortfolioId);
          const bodyEl = document.getElementById('widget-body-holdingsCompact');
          if (bodyEl && WIDGET_RENDERERS.holdingsCompact) {
            bodyEl.innerHTML = WIDGET_RENDERERS.holdingsCompact(activeView);
          }
        }
      }

      // 6. Open Asset Detail Drawer
      const assetCard = e.target.closest('[data-open-asset]');
      if (assetCard && !isCustomizing) {
        if (e.target.closest('[data-sparkline-period]') || e.target.closest('[data-comp-sort]')) return;
        const ticker = assetCard.getAttribute('data-open-asset');
        if (ticker) {
          openAssetDetail(ticker);
        }
      }

      // 7. Category Accordion Toggle (Photos 1 & 2)
      const catHeader = e.target.closest('[data-toggle-category]');
      if (catHeader) {
        const catId = catHeader.getAttribute('data-toggle-category');
        toggleCategoryAccordion(catId);
        return;
      }

      // 8. Movers Mode Toggle (% vs Valore - Photo 3)
      const moversModeBtn = e.target.closest('[data-movers-mode]');
      if (moversModeBtn) {
        const mode = moversModeBtn.getAttribute('data-movers-mode');
        setMoversMode(mode);
        return;
      }
    });

    // Checkbox change for widget visibility
    document.addEventListener('change', (e) => {
      const chk = e.target.closest('[data-widget-checkbox]');
      if (chk) {
        const wId = chk.getAttribute('data-widget-checkbox');
        if (wId) {
          setWidgetVisibility(wId, chk.checked);
        }
      }
    });
  });

  function toggleCategoryAccordion(catId) {
    if (collapsedCategorySet.has(catId)) {
      collapsedCategorySet.delete(catId);
    } else {
      collapsedCategorySet.add(catId);
    }
    localStorage.setItem('foliotrack_collapsed_categories', JSON.stringify([...collapsedCategorySet]));

    const bodyEl = document.getElementById(`cat-body-${catId}`);
    const chevronEl = document.getElementById(`cat-chevron-${catId}`);
    if (bodyEl) {
      if (collapsedCategorySet.has(catId)) {
        bodyEl.classList.add('hidden');
        if (chevronEl) chevronEl.classList.add('-rotate-90');
      } else {
        bodyEl.classList.remove('hidden');
        if (chevronEl) chevronEl.classList.remove('-rotate-90');
      }
    }
  }

  function setMoversMode(mode) {
    if (mode === activeMoversMode) return;
    activeMoversMode = mode;
    localStorage.setItem('foliotrack_movers_mode', mode);
    if (rawPortfolioData) {
      const activeView = getViewData(rawPortfolioData, selectedPortfolioId);
      const moversEl = document.getElementById('widget-body-moversDay');
      if (moversEl && WIDGET_RENDERERS.moversDay) {
        moversEl.innerHTML = WIDGET_RENDERERS.moversDay(activeView);
      }
    }
  }

  function openAssetDetail(ticker) {
    if (!ticker) return;
    const activeView = getViewData(rawPortfolioData, selectedPortfolioId);
    const holdings = activeView?.activeHoldings || [];
    const holding = holdings.find(h => (h.ticker || '').toUpperCase() === ticker.toUpperCase());
    if (holding && window.AssetDrawer) {
      window.AssetDrawer.open(holding, selectedPortfolioId);
    } else if (window.AssetDrawer) {
      window.AssetDrawer.open({ ticker: ticker }, selectedPortfolioId);
    }
  }

  window.FolioTrackDashboard = {
    refresh: refreshDashboard,
    refreshMarket: handleManualMarketRefresh,
    refreshNews: () => loadPortfolioNews(true),
    loadNews: () => loadPortfolioNews(false),
    isAssetMarketClosed,
    getAssetMarketStatusInfo,
    toggleCustomization,
    openDrawer,
    closeDrawer,
    saveLayout,
    saveCurrentLayout,
    getCurrentGridLayout,
    loadSavedLayout,
    setWidgetVisibility,
    showAllWidgets,
    resetDefaultWidgets,
    openAssetDetail,
    toggleCategoryAccordion,
    setMoversMode,
    setCompactSort: (s) => {
      activeCompactSort = s;
      try { localStorage.setItem('foliotrack_compact_sort', s); } catch {}
      const activeView = getViewData(rawPortfolioData, selectedPortfolioId);
      const bodyEl = document.getElementById('widget-body-holdingsCompact');
      if (bodyEl && WIDGET_RENDERERS.holdingsCompact) {
        bodyEl.innerHTML = WIDGET_RENDERERS.holdingsCompact(activeView);
      }
    },
    WIDGET_DEFINITIONS,
    WIDGET_RENDERERS,
    MOBILE_DEFAULT_LAYOUT,
    isMobileDashboard,
    moveWidgetUp,
    moveWidgetDown,
    repackMobileCoordinates
  };
  window.refreshDashboard = refreshDashboard;
})();
