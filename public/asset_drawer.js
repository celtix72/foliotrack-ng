/**
 * FolioTrack Asset Detail Drawer
 * Comprehensive slide-over panel displaying native currency figures (USD/EUR),
 * position details, performance & FX impact, daily range, interactive Chart.js price chart,
 * fundamentals, and dividend history.
 */

(function () {
  let drawerContainer = null;
  let chartInstance = null;
  let currentAssetData = null;
  let currentPortfolioId = null;

  function fmtNumber(v, decimals = 2) {
    const num = Number(v) || 0;
    return num.toLocaleString('it-IT', {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals
    });
  }

  function fmtCurrency(v, currency = 'EUR', decimals = null) {
    const num = Number(v) || 0;
    const curr = (currency || 'EUR').toUpperCase();
    const dec = decimals !== null ? decimals : (Math.abs(num) > 999 ? 2 : (curr === 'EUR' ? 2 : 2));
    const formatted = fmtNumber(num, dec);
    if (curr === 'USD') return `${formatted} USD`;
    if (curr === 'EUR') return `€ ${formatted}`;
    return `${formatted} ${curr}`;
  }

  function fmtCurrencySigned(v, currency = 'EUR', decimals = 2) {
    const num = Number(v) || 0;
    const sign = num > 0 ? '+' : (num < 0 ? '-' : '');
    const abs = Math.abs(num);
    const curr = (currency || 'EUR').toUpperCase();
    const formatted = fmtNumber(abs, decimals);
    if (curr === 'USD') return `${sign}${formatted} USD`;
    if (curr === 'EUR') return `${sign}€ ${formatted}`;
    return `${sign}${formatted} ${curr}`;
  }

  function fmtPercent(v, decimals = 2) {
    const num = Number(v) || 0;
    const sign = num > 0 ? '+' : (num < 0 ? '-' : '');
    return `${sign}${Math.abs(num).toFixed(decimals)}%`;
  }

  function createDrawerHtml() {
    const existing = document.getElementById('asset-drawer-backdrop');
    if (existing) existing.remove();

    const div = document.createElement('div');
    div.id = 'asset-drawer-backdrop';
    div.className = 'fixed inset-0 z-50 overflow-hidden bg-black/60 backdrop-blur-xs hidden transition-opacity duration-300';

    div.innerHTML = `
      <div class="fixed inset-y-0 right-0 max-w-full flex pl-4 sm:pl-6 md:pl-10">
        <div id="asset-drawer-panel" class="w-screen max-w-xl sm:max-w-xl md:max-w-2xl bg-white dark:bg-[#161618] shadow-2xl border-l border-gray-200 dark:border-white/10 flex flex-col transform translate-x-full transition-transform duration-300 ease-in-out">
          
          <!-- Drawer Header -->
          <div class="px-4 py-3 sm:px-5 sm:py-3.5 border-b border-gray-100 dark:border-white/5 flex items-center justify-between bg-gray-50/70 dark:bg-white/[0.02]">
            <div class="flex items-center space-x-2.5 truncate">
              <span id="drawerAssetTypeBadge" class="px-2 py-0.5 rounded-full text-[10px] font-bold font-mono bg-emerald-100 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300">
                EQUITY
              </span>
              <span id="drawerCurrencyBadge" class="px-2 py-0.5 rounded text-[10px] font-bold font-mono bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/20">
                USD
              </span>
              <div class="truncate">
                <h3 id="drawerAssetTicker" class="text-lg sm:text-xl font-bold font-mono text-gray-900 dark:text-white leading-tight">-</h3>
                <p id="drawerAssetName" class="text-xs text-gray-500 dark:text-gray-400 truncate max-w-[200px] sm:max-w-sm">-</p>
              </div>
            </div>
            <button type="button" id="drawerCloseBtn" class="p-1.5 text-gray-400 hover:text-gray-700 dark:hover:text-white rounded-lg hover:bg-gray-100 dark:hover:bg-white/5 transition" title="Chiudi">
              <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          <!-- Drawer Body (Scrollable, High Information Density) -->
          <div class="flex-1 overflow-y-auto p-3.5 sm:p-4 space-y-3.5 text-xs font-mono">

            <!-- 1. Principali Indicatori (Hero Highlights Strip) -->
            <div class="p-3 sm:p-3.5 rounded-xl bg-gray-50/80 dark:bg-white/[0.02] border border-gray-200/80 dark:border-white/10 shadow-2xs">
              <div class="grid grid-cols-2 sm:grid-cols-4 gap-2.5 sm:gap-3 tabular-nums">
                
                <!-- 1.1 Prezzo & Variazione 1D -->
                <div class="p-2 sm:p-2.5 rounded-lg bg-white dark:bg-white/[0.03] border border-gray-100 dark:border-white/5 flex flex-col justify-between">
                  <div class="flex items-center justify-between">
                    <span class="text-[10px] uppercase font-semibold text-gray-400">Prezzo Attuale</span>
                    <span id="drawerCurrentPriceEur" class="text-[10px] text-gray-400"></span>
                  </div>
                  <div class="mt-1">
                    <strong id="drawerCurrentPrice" class="text-base sm:text-lg font-bold text-gray-900 dark:text-white block leading-tight">0,00 USD</strong>
                  </div>
                  <div class="mt-1.5 pt-1 border-t border-gray-100 dark:border-white/5">
                    <div id="drawerDayChangeBadge" class="text-[10px] font-bold px-1.5 py-0.5 rounded inline-block">
                      0,00 USD (+0,00%)
                    </div>
                  </div>
                </div>

                <!-- 1.2 Controvalore di Mercato -->
                <div class="p-2 sm:p-2.5 rounded-lg bg-white dark:bg-white/[0.03] border border-gray-100 dark:border-white/5 flex flex-col justify-between">
                  <div class="flex items-center justify-between">
                    <span class="text-[10px] uppercase font-semibold text-gray-400">Controvalore</span>
                    <span id="drawerMarketValueEur" class="text-[10px] text-gray-400"></span>
                  </div>
                  <div class="mt-1">
                    <strong id="drawerMarketValue" class="text-base sm:text-lg font-extrabold text-gray-900 dark:text-white block leading-tight">0,00 USD</strong>
                  </div>
                  <div class="mt-1.5 pt-1 border-t border-gray-100 dark:border-white/5 flex items-center justify-between text-[10px] text-gray-500 dark:text-gray-400">
                    <span id="drawerSharesQty" class="truncate font-medium">0 quote</span>
                    <span id="drawerPortfolioWeight" class="font-bold text-gray-700 dark:text-gray-300 ml-1">0,00%</span>
                  </div>
                </div>

                <!-- 1.3 Prezzo Medio di Carico (PMC) & Valore di Carico -->
                <div class="p-2 sm:p-2.5 rounded-lg bg-white dark:bg-white/[0.03] border border-gray-100 dark:border-white/5 flex flex-col justify-between">
                  <div class="flex items-center justify-between">
                    <span class="text-[10px] uppercase font-semibold text-gray-400">PMC / Carico</span>
                    <span id="drawerAverageCostEur" class="text-[10px] text-gray-400"></span>
                  </div>
                  <div class="mt-1">
                    <strong id="drawerAverageCost" class="text-base sm:text-lg font-bold text-gray-900 dark:text-white block leading-tight">0,0000 USD</strong>
                  </div>
                  <div class="mt-1.5 pt-1 border-t border-gray-100 dark:border-white/5 flex items-center justify-between text-[10px] text-gray-500 dark:text-gray-400">
                    <span class="truncate">Carico:</span>
                    <div class="text-right truncate ml-1">
                      <strong id="drawerBookValue" class="text-gray-800 dark:text-gray-200 font-semibold">0,00 USD</strong>
                      <span id="drawerBookValueEur" class="text-[9px] text-gray-400 ml-0.5"></span>
                    </div>
                  </div>
                </div>

                <!-- 1.4 P&L Non Realizzato -->
                <div class="p-2 sm:p-2.5 rounded-lg bg-white dark:bg-white/[0.03] border border-gray-100 dark:border-white/5 flex flex-col justify-between">
                  <div class="flex items-center justify-between">
                    <span class="text-[10px] uppercase font-semibold text-gray-400">P&L Non Realizzato</span>
                    <span id="drawerPerfPriceReturn" class="text-[10px] text-gray-400">0,00%</span>
                  </div>
                  <div class="mt-1">
                    <strong id="drawerPerfUnrealizedPnl" class="text-base sm:text-lg font-bold block leading-tight">0,00 USD</strong>
                  </div>
                  <div class="mt-1.5 pt-1 border-t border-gray-100 dark:border-white/5 flex items-center justify-between text-[10px]">
                    <span class="text-gray-400">Rendimento:</span>
                    <span id="drawerPerfUnrealizedPct" class="font-bold">0,00%</span>
                  </div>
                </div>

              </div>
            </div>

            <!-- 2. Interactive Historical Chart with Operations (SUBITO SOTTO I PRINCIPALI INDICATORI) -->
            <div class="p-3 sm:p-3.5 rounded-xl bg-gray-50/80 dark:bg-white/[0.02] border border-gray-200/80 dark:border-white/10 shadow-2xs space-y-2">
              <div class="flex items-center justify-between">
                <div>
                  <h4 class="text-[11px] font-bold uppercase tracking-wider text-gray-700 dark:text-gray-300">Andamento & Operazioni</h4>
                  <p class="text-[9px] text-gray-400 font-mono">Prezzi storici con eseguiti BUY, SELL e dividendi</p>
                </div>
                <div class="flex items-center space-x-1 font-mono text-[10px]" id="chartRangeButtons">
                  <button data-range="1M" class="px-2 py-0.5 rounded-md text-gray-500 hover:text-gray-900 dark:hover:text-white">1M</button>
                  <button data-range="3M" class="px-2 py-0.5 rounded-md text-gray-500 hover:text-gray-900 dark:hover:text-white">3M</button>
                  <button data-range="6M" class="px-2 py-0.5 rounded-md text-gray-500 hover:text-gray-900 dark:hover:text-white">6M</button>
                  <button data-range="1Y" class="px-2 py-0.5 rounded-md bg-emerald-600 text-white font-bold">1Y</button>
                  <button data-range="5Y" class="px-2 py-0.5 rounded-md text-gray-500 hover:text-gray-900 dark:hover:text-white">5Y</button>
                  <button data-range="ALL" class="px-2 py-0.5 rounded-md text-gray-500 hover:text-gray-900 dark:hover:text-white">ALL</button>
                </div>
              </div>
              <div class="relative w-full rounded-lg bg-white dark:bg-white/[0.03] p-2 sm:p-2.5 border border-gray-100 dark:border-white/5">
                <div class="h-48 sm:h-52 relative w-full">
                  <canvas id="drawerChartCanvas"></canvas>
                  <div id="drawerChartLoading" class="hidden absolute inset-0 bg-white/70 dark:bg-black/70 backdrop-blur-2xs flex items-center justify-center text-xs font-mono text-gray-500">
                    Caricamento grafico e operazioni...
                  </div>
                </div>

                <!-- Operations Legend & Summary -->
                <div id="drawerTxSummaryBar" class="mt-2 pt-2 border-t border-gray-100 dark:border-white/5 flex flex-wrap items-center justify-between gap-1.5 text-[10px] font-mono">
                  <div class="flex items-center space-x-2.5 sm:space-x-3.5">
                    <span class="inline-flex items-center space-x-1">
                      <span class="w-2 h-2 rounded-full bg-emerald-500 inline-block shadow-2xs"></span>
                      <span class="font-semibold text-emerald-700 dark:text-emerald-300">BUY</span>
                    </span>
                    <span class="inline-flex items-center space-x-1">
                      <span class="w-2 h-2 rounded-full bg-rose-500 inline-block shadow-2xs"></span>
                      <span class="font-semibold text-rose-700 dark:text-rose-300">SELL</span>
                    </span>
                    <span class="inline-flex items-center space-x-1">
                      <span class="w-2 h-2 rounded-full bg-amber-500 inline-block shadow-2xs"></span>
                      <span class="font-semibold text-amber-700 dark:text-amber-300">DIV</span>
                    </span>
                  </div>
                  <div id="drawerTxCountsBadge" class="text-gray-400 font-medium truncate">
                    0 operazioni nel periodo
                  </div>
                </div>
              </div>
            </div>

            <!-- 3. Dettaglio Performance -->
            <div class="p-3 sm:p-3.5 rounded-xl bg-gray-50/80 dark:bg-white/[0.02] border border-gray-200/80 dark:border-white/10 shadow-2xs space-y-2">
              <div class="flex items-center justify-between border-b border-gray-100 dark:border-white/5 pb-1.5">
                <h4 class="text-[11px] font-bold uppercase tracking-wider text-gray-700 dark:text-gray-300">Dettaglio Performance</h4>
                <span class="text-[10px] text-gray-400 font-medium">G/P & Rendimenti</span>
              </div>
              <div class="grid grid-cols-2 sm:grid-cols-4 gap-2 tabular-nums">
                <div class="p-2 rounded-lg bg-white dark:bg-white/[0.03] border border-gray-100 dark:border-white/5">
                  <span class="text-gray-400 block text-[9px] uppercase">Rendimento Oggi</span>
                  <strong id="drawerPerfDayPnl" class="text-xs font-bold block mt-0.5">0,00 USD</strong>
                  <span id="drawerPerfDayPct" class="text-[10px] font-semibold block mt-0.5">+0,00%</span>
                </div>
                <div class="p-2 rounded-lg bg-white dark:bg-white/[0.03] border border-gray-100 dark:border-white/5">
                  <span class="text-gray-400 block text-[9px] uppercase">G/P Realizzato</span>
                  <strong id="drawerPerfRealizedPnl" class="text-xs font-bold text-gray-900 dark:text-white block mt-0.5">N/D</strong>
                  <span class="text-[10px] text-gray-400 block mt-0.5">Vendite chiuse</span>
                </div>
                <div class="p-2 rounded-lg bg-white dark:bg-white/[0.03] border border-gray-100 dark:border-white/5">
                  <span class="text-gray-400 block text-[9px] uppercase">Dividendi Incassati</span>
                  <strong id="drawerPerfIncome" class="text-xs font-bold text-emerald-600 dark:text-emerald-400 block mt-0.5">0,00 USD</strong>
                  <span class="text-[10px] text-gray-400 block mt-0.5">Reddito cedole</span>
                </div>
                <div class="p-2 rounded-lg bg-white dark:bg-white/[0.03] border border-gray-100 dark:border-white/5">
                  <span class="text-gray-400 block text-[9px] uppercase">Effetto Cambio</span>
                  <strong id="drawerPerfFxImpact" class="text-xs font-bold block mt-0.5">+0,00 €</strong>
                  <span class="text-[10px] text-gray-400 block mt-0.5">Impatto FX EUR</span>
                </div>
                <div class="p-2 rounded-lg bg-white dark:bg-white/[0.03] border border-gray-100 dark:border-white/5">
                  <span class="text-gray-400 block text-[9px] uppercase">G/P Totale</span>
                  <strong id="drawerPerfTotalPnl" class="text-xs font-bold block mt-0.5">0,00 USD</strong>
                  <span id="drawerPerfTotalPct" class="text-[10px] font-semibold block mt-0.5">0,00%</span>
                </div>
                <div class="p-2 rounded-lg bg-white dark:bg-white/[0.03] border border-gray-100 dark:border-white/5 col-span-1 sm:col-span-3">
                  <div class="flex items-center justify-between">
                    <div>
                      <span class="text-gray-400 block text-[9px] uppercase">Rendimento Totale Complessivo (Total Return)</span>
                      <strong id="drawerPerfTotalReturn" class="text-xs sm:text-sm font-extrabold block mt-0.5">0,00 USD</strong>
                    </div>
                    <div class="text-right">
                      <span class="text-gray-400 block text-[9px] uppercase">% Totale</span>
                      <strong id="drawerPerfTotalReturnPct" class="text-xs sm:text-sm font-extrabold block mt-0.5">0,00%</strong>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <!-- 4. Sessione di Borsa & Dati Fondamentali (2 Colonne Compatte) -->
            <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <!-- Sessione Borsa -->
              <div class="p-3 rounded-xl bg-gray-50/80 dark:bg-white/[0.02] border border-gray-200/80 dark:border-white/10 shadow-2xs space-y-2">
                <div class="flex items-center justify-between border-b border-gray-100 dark:border-white/5 pb-1">
                  <h4 class="text-[10px] font-bold uppercase tracking-wider text-gray-700 dark:text-gray-300">Sessione Borsa</h4>
                  <span class="text-[9px] text-gray-400">Range Odierno</span>
                </div>
                <div class="grid grid-cols-2 gap-1.5 text-[10px] tabular-nums">
                  <div class="p-1.5 rounded-md bg-white dark:bg-white/[0.03] border border-gray-100 dark:border-white/5">
                    <span class="text-gray-400 block text-[9px]">Apertura</span>
                    <strong id="drawerRangeOpen" class="text-gray-900 dark:text-white block truncate">0,00 USD</strong>
                  </div>
                  <div class="p-1.5 rounded-md bg-white dark:bg-white/[0.03] border border-gray-100 dark:border-white/5">
                    <span class="text-gray-400 block text-[9px]">Chiusura</span>
                    <strong id="drawerRangeClose" class="text-gray-900 dark:text-white block truncate">0,00 USD</strong>
                  </div>
                  <div class="p-1.5 rounded-md bg-white dark:bg-white/[0.03] border border-gray-100 dark:border-white/5">
                    <span class="text-gray-400 block text-[9px]">Minimo</span>
                    <strong id="drawerRangeLow" class="text-gray-900 dark:text-white block truncate">0,00 USD</strong>
                  </div>
                  <div class="p-1.5 rounded-md bg-white dark:bg-white/[0.03] border border-gray-100 dark:border-white/5">
                    <span class="text-gray-400 block text-[9px]">Massimo</span>
                    <strong id="drawerRangeHigh" class="text-gray-900 dark:text-white block truncate">0,00 USD</strong>
                  </div>
                  <div class="p-1.5 rounded-md bg-white dark:bg-white/[0.03] border border-gray-100 dark:border-white/5 col-span-2">
                    <span class="text-gray-400 block text-[9px]">Chiusura rettificata / prec.</span>
                    <strong id="drawerRangeAdjClose" class="text-gray-900 dark:text-white block truncate">0,00 USD</strong>
                  </div>
                </div>
              </div>

              <!-- Dati Fondamentali -->
              <div class="p-3 rounded-xl bg-gray-50/80 dark:bg-white/[0.02] border border-gray-200/80 dark:border-white/10 shadow-2xs space-y-2">
                <div class="flex items-center justify-between border-b border-gray-100 dark:border-white/5 pb-1">
                  <h4 class="text-[10px] font-bold uppercase tracking-wider text-gray-700 dark:text-gray-300">Dati Fondamentali</h4>
                  <span class="text-[9px] text-gray-400">Tassonomia</span>
                </div>
                <div class="grid grid-cols-2 gap-1.5 text-[10px] tabular-nums">
                  <div class="p-1.5 rounded-md bg-white dark:bg-white/[0.03] border border-gray-100 dark:border-white/5">
                    <span class="text-gray-400 block text-[9px]">Settore GICS</span>
                    <strong id="drawerSector" class="text-gray-900 dark:text-white block truncate">-</strong>
                  </div>
                  <div class="p-1.5 rounded-md bg-white dark:bg-white/[0.03] border border-gray-100 dark:border-white/5">
                    <span class="text-gray-400 block text-[9px]">Paese / Regione</span>
                    <strong id="drawerRegion" class="text-gray-900 dark:text-white block truncate">-</strong>
                  </div>
                  <div class="p-1.5 rounded-md bg-white dark:bg-white/[0.03] border border-gray-100 dark:border-white/5">
                    <span class="text-gray-400 block text-[9px]">Rapporto P/E</span>
                    <strong id="drawerPE" class="text-gray-900 dark:text-white block truncate">-</strong>
                  </div>
                  <div class="p-1.5 rounded-md bg-white dark:bg-white/[0.03] border border-gray-100 dark:border-white/5">
                    <span class="text-gray-400 block text-[9px]">Dividend Yield</span>
                    <strong id="drawerDivYield" class="text-gray-900 dark:text-white block truncate">0,00%</strong>
                  </div>
                </div>
              </div>
            </div>

            <!-- 5. Storico Dividendi Percepiti -->
            <div class="p-3 sm:p-3.5 rounded-xl bg-gray-50/80 dark:bg-white/[0.02] border border-gray-200/80 dark:border-white/10 shadow-2xs space-y-2">
              <div class="flex items-center justify-between border-b border-gray-100 dark:border-white/5 pb-1.5">
                <h4 class="text-[11px] font-bold uppercase tracking-wider text-gray-700 dark:text-gray-300">Dividendi & Cedole</h4>
                <span class="text-xs font-mono font-bold text-emerald-600 dark:text-emerald-400" id="drawerTotalDividends">
                  Totale: 0,00 USD
                </span>
              </div>
              <div class="overflow-hidden rounded-lg border border-gray-200/60 dark:border-white/10 max-h-36 overflow-y-auto">
                <table class="min-w-full divide-y divide-gray-200 dark:divide-white/5 text-left text-xs font-mono">
                  <thead class="bg-gray-100/70 dark:bg-white/5 text-gray-500 sticky top-0 text-[10px]">
                    <tr>
                      <th class="px-3 py-1.5 font-semibold">Data</th>
                      <th class="px-3 py-1.5 text-right font-semibold">Importo Netto</th>
                      <th class="px-3 py-1.5 font-semibold">Note</th>
                    </tr>
                  </thead>
                  <tbody id="drawerDividendsTbody" class="divide-y divide-gray-200/50 dark:divide-white/5 tabular-nums text-[11px]">
                    <tr><td colspan="3" class="px-3 py-2 text-center text-gray-400">Caricamento storico dividendi...</td></tr>
                  </tbody>
                </table>
              </div>
            </div>

          </div>

          <!-- Drawer Footer Actions -->
          <div class="px-4 py-2.5 sm:px-5 sm:py-3 bg-gray-50 dark:bg-white/[0.02] border-t border-gray-100 dark:border-white/5 flex items-center justify-between">
            <button type="button" id="drawerCloseBtn2" class="btn-pill px-3.5 py-1.5 text-xs font-medium text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-white/10 transition">
              Chiudi
            </button>
            <button type="button" id="drawerNewTxBtn" class="btn-pill px-3.5 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-semibold transition shadow-md shadow-emerald-600/20">
              + Nuova Operazione
            </button>
          </div>
        </div>
      </div>
    `;

    document.body.appendChild(div);
    return div;
  }

  async function loadHistoricalChart(ticker, range = '1Y', currency = 'EUR', portfolioId = null) {
    if (portfolioId === null && currentPortfolioId) {
      portfolioId = currentPortfolioId;
    }
    const canvas = document.getElementById('drawerChartCanvas');
    if (!canvas || typeof Chart === 'undefined') return;

    const loadingEl = document.getElementById('drawerChartLoading');
    if (loadingEl) loadingEl.classList.remove('hidden');

    try {
      // 1. Fetch historical quotes
      const chartRes = await fetch(`/api/market/chart/${encodeURIComponent(ticker)}?range=${encodeURIComponent(range)}`);
      const chartData = await chartRes.json();
      const points = (chartData && (chartData.points || chartData.data)) || [];

      if (!points || points.length === 0) {
        if (loadingEl) loadingEl.classList.add('hidden');
        return;
      }

      // 2. Fetch all transactions for this asset
      let txUrl = `/api/transactions?assetTicker=${encodeURIComponent(ticker)}&limit=500`;
      if (portfolioId && portfolioId !== 'all') {
        txUrl += `&portfolioId=${encodeURIComponent(portfolioId)}`;
      }
      let allTxs = [];
      try {
        const txRes = await fetch(txUrl);
        const txData = await txRes.json();
        if (txData.success && Array.isArray(txData.transactions)) {
          allTxs = txData.transactions;
        }
      } catch (e) {
        console.warn('Failed to fetch transactions for asset chart:', e);
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
      const countsBadge = document.getElementById('drawerTxCountsBadge');
      if (countsBadge) {
        countsBadge.textContent = `${visibleTxs.length} operazioni nel periodo (${buyCount} acq, ${sellCount} vend, ${divCount} div)`;
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

      if (chartInstance) {
        chartInstance.destroy();
        chartInstance = null;
      }

      const isDark = document.documentElement.classList.contains('dark');
      const isPositive = prices.length > 0 && prices[prices.length - 1] >= prices[0];
      const strokeColor = isPositive ? '#10b981' : '#f43f5e';
      const fillColor = isPositive ? 'rgba(16, 185, 129, 0.08)' : 'rgba(244, 63, 94, 0.08)';

      // Custom Plugin to Draw Operation Badges/Labels above/below dots
      const transactionLabelsPlugin = {
        id: 'drawerTransactionLabels',
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
              text += ` +${fmtCurrency(primaryTx.amount, currency, 0)}`;
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

      chartInstance = new Chart(canvas, {
        type: 'line',
        plugins: [transactionLabelsPlugin],
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
            // Dataset 1: Operation dots overlay with custom colors
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
                  return p ? `Data: ${p.date}` : '';
                },
                label: (ctx) => {
                  const idx = ctx.dataIndex;
                  if (ctx.datasetIndex === 0) {
                    return ` Prezzo: ${fmtCurrency(ctx.raw, currency)}`;
                  } else {
                    const txList = txMapByPointIndex[idx];
                    if (!txList || txList.length === 0) return '';
                    return txList.map(t => {
                      const isB = t.type === 'BUY';
                      const isS = t.type === 'SELL';
                      const isD = t.type === 'DIVIDEND';
                      const typeLabel = isB ? '🟢 ACQUISTO (BUY)' : (isS ? '🔴 VENDITA (SELL)' : (isD ? '🟡 DIVIDENDO' : `🟣 ${t.type}`));
                      const qStr = t.quantity ? `${Math.round(t.quantity)} quote` : '';
                      const pStr = t.price ? `@ ${fmtCurrency(t.price, currency)}` : '';
                      const amtStr = t.amount ? `[Tot: ${fmtCurrency(t.amount, currency)}]` : '';
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
                callback: (v) => fmtCurrency(v, currency)
              }
            }
          }
        }
      });
    } catch (err) {
      console.warn('Error loading asset chart:', err);
    } finally {
      if (loadingEl) loadingEl.classList.add('hidden');
    }
  }

  async function loadDividendHistory(ticker, portfolioId, currency = 'EUR') {
    const tbody = document.getElementById('drawerDividendsTbody');
    const totalEl = document.getElementById('drawerTotalDividends');
    if (!tbody) return;

    try {
      let url = `/api/transactions?type=DIVIDEND&assetTicker=${encodeURIComponent(ticker)}&limit=100`;
      if (portfolioId && portfolioId !== 'all') url += `&portfolioId=${portfolioId}`;

      const res = await fetch(url);
      const data = await res.json();

      if (data.success && data.transactions && data.transactions.length > 0) {
        let sum = 0;
        tbody.innerHTML = data.transactions.map(t => {
          const amt = Number(t.amount) || 0;
          sum += amt;
          return `
            <tr class="hover:bg-gray-50/50 dark:hover:bg-white/5 transition">
              <td class="px-3 py-2 text-gray-500">${t.date}</td>
              <td class="px-3 py-2 text-right font-bold text-emerald-600 dark:text-emerald-400">${fmtCurrency(amt, currency)}</td>
              <td class="px-3 py-2 text-gray-400 truncate max-w-[120px]" title="${t.notes || ''}">${t.notes || '-'}</td>
            </tr>
          `;
        }).join('');

        totalEl.textContent = `Totale: ${fmtCurrency(sum, currency)}`;
      } else {
        tbody.innerHTML = '<tr><td colspan="3" class="px-3 py-3 text-center text-gray-400">Nessun dividendo registrato per questo titolo</td></tr>';
        totalEl.textContent = `Totale: ${fmtCurrency(0, currency)}`;
      }
    } catch (err) {
      console.warn('Error loading dividend history:', err);
    }
  }

  function setupEvents() {
    const close = () => {
      const panel = document.getElementById('asset-drawer-panel');
      const backdrop = document.getElementById('asset-drawer-backdrop');
      if (panel) panel.classList.add('translate-x-full');
      setTimeout(() => {
        if (backdrop) backdrop.classList.add('hidden');
        document.body.classList.remove('overflow-hidden');
      }, 300);
    };

    document.getElementById('drawerCloseBtn').addEventListener('click', close);
    document.getElementById('drawerCloseBtn2').addEventListener('click', close);

    document.getElementById('asset-drawer-backdrop').addEventListener('click', (e) => {
      if (e.target.id === 'asset-drawer-backdrop') close();
    });

    // Range selector
    document.getElementById('chartRangeButtons').addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-range]');
      if (!btn || !currentAssetData) return;

      document.querySelectorAll('#chartRangeButtons button').forEach(b => {
        b.className = 'px-2 py-0.5 rounded-md text-gray-500 hover:text-gray-900 dark:hover:text-white';
      });
      btn.className = 'px-2 py-0.5 rounded-md bg-emerald-600 text-white font-bold';

      const range = btn.getAttribute('data-range');
      loadHistoricalChart(currentAssetData.ticker, range, currentAssetData.currency || 'EUR', currentPortfolioId);
    });

    // New transaction button inside drawer
    document.getElementById('drawerNewTxBtn').addEventListener('click', () => {
      close();
      if (window.TransactionModal && currentAssetData) {
        window.TransactionModal.open({
          portfolioId: currentPortfolioId !== 'all' ? currentPortfolioId : null,
          assetTicker: currentAssetData.ticker,
          type: 'BUY'
        });
      }
    });
  }

  function open(holding, portfolioId = null) {
    if (!holding || !holding.ticker) return;

    currentAssetData = holding;
    currentPortfolioId = portfolioId;

    if (!drawerContainer) {
      drawerContainer = createDrawerHtml();
      setupEvents();
    }

    const curr = (holding.currency || 'EUR').toUpperCase();
    const isUSD = curr === 'USD';
    const isNonEur = curr !== 'EUR';

    // Header badges
    document.getElementById('drawerAssetTicker').textContent = holding.ticker;
    document.getElementById('drawerAssetName').textContent = holding.name || holding.ticker;
    document.getElementById('drawerAssetTypeBadge').textContent = holding.type || 'EQUITY';

    const currBadge = document.getElementById('drawerCurrencyBadge');
    currBadge.textContent = curr;
    if (isUSD) {
      currBadge.className = 'px-2 py-0.5 rounded text-[10px] font-bold font-mono bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/20';
    } else {
      currBadge.className = 'px-2 py-0.5 rounded text-[10px] font-bold font-mono bg-blue-500/10 text-blue-600 dark:text-blue-400 border border-blue-500/20';
    }

    // Hero Highlights
    const qty = Number(holding.quantity) || 0;
    document.getElementById('drawerSharesQty').textContent = `${fmtNumber(qty, qty % 1 === 0 ? 0 : 4)} azioni / quote`;

    const mvNative = holding.marketValueNative !== undefined ? holding.marketValueNative : (isNonEur ? (holding.quantity * (holding.currentPriceNative || holding.rawPrice || 0)) : holding.marketValue);
    document.getElementById('drawerMarketValue').textContent = fmtCurrency(mvNative, curr);

    const mvEurEl = document.getElementById('drawerMarketValueEur');
    if (isNonEur && holding.marketValue) {
      mvEurEl.textContent = `(≈ € ${fmtNumber(holding.marketValue)})`;
    } else {
      mvEurEl.textContent = '';
    }

    const priceNative = holding.currentPriceNative !== undefined ? holding.currentPriceNative : (holding.rawPrice || holding.currentPrice);
    document.getElementById('drawerCurrentPrice').textContent = fmtCurrency(priceNative, curr);

    const priceEurEl = document.getElementById('drawerCurrentPriceEur');
    if (isNonEur && holding.currentPrice) {
      priceEurEl.textContent = `(€ ${fmtNumber(holding.currentPrice)})`;
    } else {
      priceEurEl.textContent = '';
    }

    // 1D Change Badge
    const dayBadge = document.getElementById('drawerDayChangeBadge');
    const dayChgPct = Number(holding.changePercent !== undefined ? holding.changePercent : (holding.change24h || 0)) || 0;
    const dayPnlVal = holding.dayPnlNative !== undefined ? holding.dayPnlNative : ((Number(holding.changeValue) || 0) * qty);
    dayBadge.textContent = `${fmtCurrencySigned(dayPnlVal, curr)} (${fmtPercent(dayChgPct)})`;
    dayBadge.className = `mt-1 text-[11px] font-bold px-2 py-0.5 rounded-md inline-block ${dayChgPct >= 0 ? 'badge-profit' : 'badge-loss'}`;

    // 1. Posizione (Position)
    const bvNative = holding.bookValueNative !== undefined ? holding.bookValueNative : (isNonEur && holding.pmcNative ? qty * holding.pmcNative : holding.bookValue);
    document.getElementById('drawerBookValue').textContent = fmtCurrency(bvNative, curr);

    const bvEurEl = document.getElementById('drawerBookValueEur');
    if (isNonEur && holding.bookValue) {
      bvEurEl.textContent = `≈ € ${fmtNumber(holding.bookValue)}`;
    } else {
      bvEurEl.textContent = '';
    }

    const pmcNative = holding.pmcNative !== undefined ? holding.pmcNative : (holding.costBasisNative || holding.pmc);
    document.getElementById('drawerAverageCost').textContent = fmtCurrency(pmcNative, curr, 4);

    const pmcEurEl = document.getElementById('drawerAverageCostEur');
    if (isNonEur && holding.pmc) {
      pmcEurEl.textContent = `PMC base: € ${fmtNumber(holding.pmc, 4)}`;
    } else {
      pmcEurEl.textContent = '';
    }

    const weight = Number(holding.weight) || 0;
    document.getElementById('drawerPortfolioWeight').textContent = `${weight.toFixed(2)}%`;

    // 2. Performance
    // Rendimento di oggi
    const perfDayEl = document.getElementById('drawerPerfDayPnl');
    perfDayEl.textContent = fmtCurrencySigned(dayPnlVal, curr);
    perfDayEl.className = `text-xs sm:text-sm font-bold block mt-0.5 ${dayPnlVal >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}`;
    const perfDayPctEl = document.getElementById('drawerPerfDayPct');
    perfDayPctEl.textContent = fmtPercent(dayChgPct);
    perfDayPctEl.className = `text-[10px] font-semibold block mt-0.5 ${dayChgPct >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}`;

    // G/P non realizzato
    const unrealizedPnlNative = holding.unrealizedPnlNative !== undefined ? holding.unrealizedPnlNative : (mvNative - bvNative);
    const unrealizedPnlPctNative = holding.unrealizedPnlPercentNative !== undefined ? holding.unrealizedPnlPercentNative : (bvNative > 0 ? (unrealizedPnlNative / bvNative) * 100 : 0);

    const perfUnrealizedEl = document.getElementById('drawerPerfUnrealizedPnl');
    perfUnrealizedEl.textContent = fmtCurrencySigned(unrealizedPnlNative, curr);
    perfUnrealizedEl.className = `text-xs sm:text-sm font-bold block mt-0.5 ${unrealizedPnlNative >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}`;
    const perfUnrealizedPctEl = document.getElementById('drawerPerfUnrealizedPct');
    perfUnrealizedPctEl.textContent = fmtPercent(unrealizedPnlPctNative);
    perfUnrealizedPctEl.className = `text-[10px] font-semibold block mt-0.5 ${unrealizedPnlPctNative >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}`;

    // G/P realizzato
    const perfRealizedEl = document.getElementById('drawerPerfRealizedPnl');
    if (holding.realizedPnlNative && Math.abs(holding.realizedPnlNative) > 0.001) {
      perfRealizedEl.textContent = fmtCurrencySigned(holding.realizedPnlNative, curr);
      perfRealizedEl.className = `text-xs sm:text-sm font-bold block mt-0.5 ${holding.realizedPnlNative >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}`;
    } else {
      perfRealizedEl.textContent = 'N/D';
      perfRealizedEl.className = 'text-xs sm:text-sm font-bold text-gray-400 block mt-0.5';
    }

    // Reddito (Dividendi)
    const incomeNative = holding.dividendsNative !== undefined ? holding.dividendsNative : (holding.dividends || 0);
    document.getElementById('drawerPerfIncome').textContent = fmtCurrency(incomeNative, curr);

    // Effetto cambio (sempre in EUR)
    const fxImpact = holding.fxImpact !== undefined ? holding.fxImpact : (isNonEur ? ((holding.unrealizedPnl || 0) - (unrealizedPnlNative * 0.9216)) : 0);
    const fxEl = document.getElementById('drawerPerfFxImpact');
    fxEl.textContent = isNonEur ? fmtCurrencySigned(fxImpact, 'EUR') : '0,00 € (N/A)';
    fxEl.className = `text-xs sm:text-sm font-bold block mt-0.5 ${fxImpact >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}`;

    // Rendimento da prezzo
    const priceReturnPct = holding.priceReturnPercent !== undefined ? holding.priceReturnPercent : (pmcNative > 0 ? ((priceNative - pmcNative) / pmcNative) * 100 : 0);
    const priceRetEl = document.getElementById('drawerPerfPriceReturn');
    priceRetEl.textContent = fmtPercent(priceReturnPct);
    priceRetEl.className = `text-xs sm:text-sm font-bold block mt-0.5 ${priceReturnPct >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}`;

    // G/P totale
    const perfTotalPnlEl = document.getElementById('drawerPerfTotalPnl');
    perfTotalPnlEl.textContent = fmtCurrencySigned(unrealizedPnlNative, curr);
    perfTotalPnlEl.className = `text-xs sm:text-sm font-bold block mt-0.5 ${unrealizedPnlNative >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}`;
    const perfTotalPctEl = document.getElementById('drawerPerfTotalPct');
    perfTotalPctEl.textContent = fmtPercent(unrealizedPnlPctNative);
    perfTotalPctEl.className = `text-[10px] font-semibold block mt-0.5 ${unrealizedPnlPctNative >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}`;

    // Rendimento totale
    const totalReturnNative = holding.totalReturnNative !== undefined ? holding.totalReturnNative : (unrealizedPnlNative + incomeNative);
    const totalReturnPctNative = holding.totalReturnPercentNative !== undefined ? holding.totalReturnPercentNative : (bvNative > 0 ? (totalReturnNative / bvNative) * 100 : 0);

    const perfTotalRetEl = document.getElementById('drawerPerfTotalReturn');
    perfTotalRetEl.textContent = fmtCurrencySigned(totalReturnNative, curr);
    perfTotalRetEl.className = `text-xs sm:text-sm font-bold block mt-0.5 ${totalReturnNative >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}`;
    const perfTotalRetPctEl = document.getElementById('drawerPerfTotalReturnPct');
    perfTotalRetPctEl.textContent = fmtPercent(totalReturnPctNative);
    perfTotalRetPctEl.className = `text-[10px] font-semibold block mt-0.5 ${totalReturnPctNative >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}`;

    // 3. Intervallo giornaliero
    const openP = holding.openPrice !== undefined && holding.openPrice > 0 ? holding.openPrice : priceNative;
    const closeP = holding.closePrice !== undefined && holding.closePrice > 0 ? holding.closePrice : priceNative;
    const highP = holding.highPrice !== undefined && holding.highPrice > 0 ? holding.highPrice : Math.max(openP, closeP);
    const lowP = holding.lowPrice !== undefined && holding.lowPrice > 0 ? holding.lowPrice : Math.min(openP, closeP);
    const adjCloseP = holding.previousClose !== undefined && holding.previousClose > 0 ? holding.previousClose : closeP;

    document.getElementById('drawerRangeOpen').textContent = fmtCurrency(openP, curr);
    document.getElementById('drawerRangeClose').textContent = fmtCurrency(closeP, curr);
    document.getElementById('drawerRangeHigh').textContent = fmtCurrency(highP, curr);
    document.getElementById('drawerRangeLow').textContent = fmtCurrency(lowP, curr);
    document.getElementById('drawerRangeAdjClose').textContent = fmtCurrency(adjCloseP, curr);

    // 5. Tassonomia & Fondamentali
    document.getElementById('drawerSector').textContent = holding.sector || 'N/D';
    document.getElementById('drawerRegion').textContent = holding.region || holding.country || 'N/D';
    document.getElementById('drawerPE').textContent = holding.pe ? Number(holding.pe).toFixed(1) : 'N/D';
    document.getElementById('drawerDivYield').textContent = holding.dividendYield ? fmtPercent(holding.dividendYield) : '0,00%';

    // Load interactive chart and dividend history
    loadHistoricalChart(holding.ticker, '1Y', curr, portfolioId);
    loadDividendHistory(holding.ticker, portfolioId, curr);

    // Asynchronously fetch extra asset data from API if any daily values were fallback
    fetch(`/api/assets/${encodeURIComponent(holding.ticker)}`)
      .then(res => res.json())
      .then(assetRes => {
        if (assetRes.success && assetRes.asset) {
          const a = assetRes.asset;
          if (a.openPrice) document.getElementById('drawerRangeOpen').textContent = fmtCurrency(a.openPrice, curr);
          if (a.currentPrice) document.getElementById('drawerRangeClose').textContent = fmtCurrency(a.currentPrice, curr);
          if (a.highPrice) document.getElementById('drawerRangeHigh').textContent = fmtCurrency(a.highPrice, curr);
          if (a.lowPrice) document.getElementById('drawerRangeLow').textContent = fmtCurrency(a.lowPrice, curr);
          if (a.previousClose) document.getElementById('drawerRangeAdjClose').textContent = fmtCurrency(a.previousClose, curr);
          if (a.pe) document.getElementById('drawerPE').textContent = Number(a.pe).toFixed(1);
          if (a.dividendYield) document.getElementById('drawerDivYield').textContent = fmtPercent(a.dividendYield);
          if (a.sector) document.getElementById('drawerSector').textContent = a.sector;
          if (a.country || a.region) document.getElementById('drawerRegion').textContent = a.country || a.region;
        }
      })
      .catch(() => {});

    // Show backdrop & slide panel
    const backdrop = document.getElementById('asset-drawer-backdrop');
    const panel = document.getElementById('asset-drawer-panel');
    backdrop.classList.remove('hidden');
    document.body.classList.add('overflow-hidden');

    setTimeout(() => {
      panel.classList.remove('translate-x-full');
    }, 10);
  }

  window.AssetDrawer = {
    open
  };
})();
