/**
 * FolioTrack - Rebalancing Worksheet & Target Allocation Engine Client Script
 * Wealthfolio-style portfolio rebalancing, drift tracking, and interactive trade planning.
 */

(function () {
  'use strict';

  // --- STATE ---
  let state = {
    portfolioId: 'all',
    selectedTargetKey: 'classic_60_40', // 'preset:classic_60_40' or 'target:123'
    strategy: 'CASH_FIRST', // 'CASH_FIRST' or 'FULL_REBALANCE'
    addedCash: 0.0,
    toleranceBand: 2.0,
    allowFractional: false,
    minTradeSize: 25.0,
    cashBuffer: 0.0,
    portfolios: [],
    presets: [],
    customTargets: [],
    worksheet: null,
    targetName: '',
    portfolioName: 'Tutti i Portafogli',
    currency: 'EUR'
  };

  // --- FORMATTERS ---
  const fmtEur = (v) => {
    const num = Number(v) || 0;
    return '€ ' + num.toLocaleString('it-IT', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  };

  const fmtEurSigned = (v) => {
    const num = Number(v) || 0;
    const sign = num > 0 ? '+' : '';
    return `${sign}€ ` + num.toLocaleString('it-IT', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  };

  const fmtPct = (v) => {
    const num = Number(v) || 0;
    return num.toFixed(2) + '%';
  };

  const fmtPctSigned = (v) => {
    const num = Number(v) || 0;
    const sign = num > 0 ? '+' : '';
    return `${sign}${num.toFixed(2)}%`;
  };

  const fmtQty = (q, allowDec = false) => {
    const num = Number(q) || 0;
    return allowDec
      ? num.toLocaleString('it-IT', { minimumFractionDigits: 0, maximumFractionDigits: 4 })
      : Math.round(num).toLocaleString('it-IT');
  };

  // --- TOAST HELPER ---
  function showToast(msg, type = 'success') {
    const existing = document.getElementById('rebalance-toast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.id = 'rebalance-toast';
    const bg = type === 'success' ? 'bg-emerald-600' : (type === 'error' ? 'bg-rose-600' : 'bg-gray-800');
    toast.className = `fixed top-5 left-1/2 -translate-x-1/2 z-50 px-4 py-2.5 rounded-xl ${bg} text-white text-xs font-semibold shadow-xl backdrop-blur animate-fade-in font-sans flex items-center space-x-2`;
    toast.innerHTML = `<span>${msg}</span>`;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 4000);
  }

  // --- INIT & DATA LOADING ---
  async function init() {
    setupEventListeners();
    await loadPortfolios();
    await loadTargets();

    // Check query params (e.g. ?portfolioId=2)
    const urlParams = new URLSearchParams(window.location.search);
    const pParam = urlParams.get('portfolioId');
    if (pParam) {
      state.portfolioId = pParam;
      const portSelect = document.getElementById('rebalancePortfolioSelect');
      if (portSelect) portSelect.value = pParam;
    }

    await calculateWorksheet();
  }

  async function loadPortfolios() {
    try {
      const res = await fetch('/api/portfolios');
      const data = await res.json();
      if (data && data.success && Array.isArray(data.portfolios)) {
        state.portfolios = data.portfolios;
        populatePortfolioSelects();
      }
    } catch (err) {
      console.warn('[Rebalance] Errore caricamento portafogli:', err);
    }
  }

  function populatePortfolioSelects() {
    const selects = [
      document.getElementById('rebalancePortfolioSelect'),
      document.getElementById('targetModalPortfolio')
    ];

    selects.forEach((sel) => {
      if (!sel) return;
      const curVal = sel.value;
      const isModal = sel.id === 'targetModalPortfolio';
      sel.innerHTML = isModal
        ? '<option value="">Globale (Tutti i Portafogli)</option>'
        : '<option value="all">Tutti i Portafogli (Aggregato)</option>';

      state.portfolios.forEach((p) => {
        const opt = document.createElement('option');
        opt.value = p.id;
        opt.textContent = `${p.name} (${fmtEur(p.totalValue)})`;
        sel.appendChild(opt);
      });

      if (curVal) sel.value = curVal;
    });
  }

  async function loadTargets() {
    try {
      const res = await fetch('/api/rebalancing/targets');
      const data = await res.json();
      if (data && data.success) {
        state.presets = data.presets || [];
        state.customTargets = data.targets || [];
        populateTargetSelect();
      }
    } catch (err) {
      console.warn('[Rebalance] Errore caricamento target:', err);
    }
  }

  function populateTargetSelect() {
    const sel = document.getElementById('rebalanceTargetSelect');
    if (!sel) return;

    sel.innerHTML = '';

    // 1. Presets Group
    const presetGroup = document.createElement('optgroup');
    presetGroup.label = 'Modelli Predefiniti (Wealthfolio Models)';
    state.presets.forEach((p) => {
      const opt = document.createElement('option');
      opt.value = `preset:${p.id}`;
      opt.textContent = p.name;
      presetGroup.appendChild(opt);
    });
    sel.appendChild(presetGroup);

    // 2. Custom Targets Group
    if (state.customTargets.length > 0) {
      const customGroup = document.createElement('optgroup');
      customGroup.label = 'Modelli Personalizzati';
      state.customTargets.forEach((t) => {
        const opt = document.createElement('option');
        opt.value = `target:${t.id}`;
        opt.textContent = `${t.name} (±${t.toleranceBand}%)`;
        customGroup.appendChild(opt);
      });
      sel.appendChild(customGroup);
    }

    // Default or restore selection
    if (state.selectedTargetKey) {
      sel.value = state.selectedTargetKey.startsWith('preset:') || state.selectedTargetKey.startsWith('target:')
        ? state.selectedTargetKey
        : `preset:${state.selectedTargetKey}`;
    }
  }

  // --- CALCULATION ---
  async function calculateWorksheet() {
    showLoading(true);

    const targetKey = state.selectedTargetKey || 'preset:classic_60_40';
    let presetId = null;
    let targetId = null;

    if (targetKey.startsWith('preset:')) {
      presetId = targetKey.replace('preset:', '');
    } else if (targetKey.startsWith('target:')) {
      targetId = parseInt(targetKey.replace('target:', ''), 10);
    } else {
      presetId = targetKey;
    }

    const payload = {
      portfolioId: state.portfolioId,
      presetId,
      targetId,
      strategy: state.strategy,
      addedCash: Number(state.addedCash) || 0.0,
      toleranceBand: Number(state.toleranceBand) || 2.0,
      allowFractional: Boolean(state.allowFractional),
      minTradeSize: Number(state.minTradeSize) || 25.0,
      cashBuffer: Number(state.cashBuffer) || 0.0
    };

    try {
      const res = await fetch('/api/rebalancing/calculate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await res.json();

      if (data && data.success && data.worksheet) {
        state.worksheet = data.worksheet;
        state.targetName = data.targetName;
        state.portfolioName = data.portfolioName;
        state.currency = data.currency || 'EUR';

        renderSummaryKpis(data.worksheet);
        renderWorksheetTable(data.worksheet);
        renderDriftChart(data.worksheet);
      } else {
        showToast(data.error || 'Errore durante il calcolo del ribilanciamento', 'error');
      }
    } catch (err) {
      console.error('[Rebalance] Errore API:', err);
      showToast('Errore di connessione durante il calcolo del ribilanciamento.', 'error');
    } finally {
      showLoading(false);
    }
  }

  function showLoading(isLoading) {
    const spinner = document.getElementById('rebalanceLoading');
    if (spinner) {
      spinner.classList.toggle('hidden', !isLoading);
    }
  }

  // --- RENDERING KPIS ---
  function renderSummaryKpis(w) {
    // 1. Total Portfolio Value
    const totalValEl = document.getElementById('kpiTotalPortfolioValue');
    if (totalValEl) totalValEl.textContent = fmtEur(w.totalPortfolioValue);

    // 2. Available Cash & Injected Cash
    const cashEl = document.getElementById('kpiAvailableCash');
    if (cashEl) {
      cashEl.textContent = fmtEur(w.availableCash);
      const sub = document.getElementById('kpiAvailableCashSub');
      if (sub) {
        sub.textContent = w.addedCash > 0
          ? `(Inclusi +${fmtEur(w.addedCash)} versamento)`
          : `Liquidità netta disponibile`;
      }
    }

    // 3. Planned Orders (Buys / Sells)
    const ordersEl = document.getElementById('kpiTotalTrades');
    if (ordersEl) {
      const buys = fmtEur(w.totalBuys);
      const sells = fmtEur(w.totalSells);
      if (w.strategy === 'CASH_FIRST') {
        ordersEl.textContent = buys;
        const sub = document.getElementById('kpiTotalTradesSub');
        if (sub) sub.textContent = `${w.tradeCount} ordini di acquisto`;
      } else {
        ordersEl.textContent = `${buys} / ${sells}`;
        const sub = document.getElementById('kpiTotalTradesSub');
        if (sub) sub.textContent = `Acquisti: ${buys} | Vendite: ${sells}`;
      }
    }

    // 4. Funding Left (Cassa residua)
    const fundingEl = document.getElementById('kpiFundingLeft');
    if (fundingEl) {
      fundingEl.textContent = fmtEur(w.fundingLeft);
      fundingEl.className = `text-xl sm:text-2xl font-bold font-mono ${w.fundingLeft >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}`;
    }

    // 5. Drift Improvement
    const driftEl = document.getElementById('kpiMaxDrift');
    if (driftEl) {
      driftEl.innerHTML = `
        <span class="text-rose-500 font-mono">${w.maxDriftBefore.toFixed(2)}%</span>
        <span class="text-gray-400 font-sans mx-1">➔</span>
        <span class="text-emerald-500 font-mono font-bold">${w.maxDriftAfter.toFixed(2)}%</span>
      `;
    }

    // 6. Target Coverage Badge
    const coverageEl = document.getElementById('kpiCoverage');
    if (coverageEl) {
      coverageEl.textContent = `${w.inBandAfter} di ${w.totalCategories} In Tolleranza (±${w.toleranceBand}%)`;
    }
  }

  // --- RENDERING WORKSHEET TABLE ---
  function renderWorksheetTable(w) {
    const tbody = document.getElementById('rebalanceWorksheetTbody');
    if (!tbody) return;

    if (!w.lines || w.lines.length === 0) {
      tbody.innerHTML = `
        <tr>
          <td colspan="8" class="text-center py-10 text-gray-400 font-mono text-xs">
            Nessuna posizione trovata per il portafoglio selezionato.
          </td>
        </tr>
      `;
      return;
    }

    tbody.innerHTML = w.lines.map((line, idx) => {
      // Status badge
      let statusBadge = '';
      if (line.status === 'IN_BAND') {
        statusBadge = '<span class="px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20">In Tolleranza</span>';
      } else if (line.status === 'OVERWEIGHT') {
        statusBadge = '<span class="px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/20">Sovrappesato</span>';
      } else {
        statusBadge = '<span class="px-2 py-0.5 rounded-full text-[10px] font-bold bg-blue-500/10 text-blue-600 dark:text-blue-400 border border-blue-500/20">Sottopesato</span>';
      }

      // Action badge
      let actionBadge = '';
      if (line.action === 'BUY') {
        actionBadge = '<span class="px-2 py-0.5 rounded-md text-[10px] font-bold bg-emerald-600 text-white shadow-sm">COMPRA</span>';
      } else if (line.action === 'SELL') {
        actionBadge = '<span class="px-2 py-0.5 rounded-md text-[10px] font-bold bg-rose-600 text-white shadow-sm">VENDI</span>';
      } else {
        actionBadge = '<span class="px-2 py-0.5 rounded-md text-[10px] font-medium bg-gray-100 dark:bg-white/5 text-gray-500">HOLD</span>';
      }

      // Drift formatting
      const driftColor = line.driftPercent > 0
        ? 'text-amber-600 dark:text-amber-400'
        : (line.driftPercent < 0 ? 'text-blue-600 dark:text-blue-400' : 'text-gray-400');

      const projDriftColor = line.projectedInBand
        ? 'text-emerald-600 dark:text-emerald-400 font-bold'
        : (line.projectedDriftPercent > 0 ? 'text-amber-600 dark:text-amber-400' : 'text-blue-600 dark:text-blue-400');

      return `
        <tr class="hover:bg-gray-50/70 dark:hover:bg-white/5 transition border-b border-gray-100 dark:border-white/5 text-xs font-mono" data-line-index="${idx}">
          <!-- 1. Category / Ticker -->
          <td class="px-4 py-3 whitespace-nowrap">
            <div class="flex items-center space-x-2">
              <span class="font-bold text-gray-900 dark:text-white">${line.ticker}</span>
              <span class="text-gray-400 text-[11px] font-sans truncate max-w-[150px]" title="${line.name}">${line.name}</span>
            </div>
            <div class="text-[10px] text-gray-400 font-mono mt-0.5">Prezzo: ${fmtEur(line.currentPrice)}</div>
          </td>

          <!-- 2. Current State (Valore & Peso) -->
          <td class="px-4 py-3 whitespace-nowrap text-right">
            <div class="font-bold text-gray-900 dark:text-white">${fmtEur(line.currentValue)}</div>
            <div class="text-[11px] text-gray-500">${fmtPct(line.currentPercent)} (${fmtQty(line.currentQuantity, w.allowFractional)} quote)</div>
          </td>

          <!-- 3. Target Weight -->
          <td class="px-4 py-3 whitespace-nowrap text-center">
            <span class="font-bold text-base text-gray-900 dark:text-white font-mono">${fmtPct(line.targetPercent)}</span>
            <div class="text-[10px] text-gray-400">Target: ${fmtEur(line.targetValue)}</div>
          </td>

          <!-- 4. Drift (Scostamento) -->
          <td class="px-4 py-3 whitespace-nowrap text-right">
            <div class="font-bold ${driftColor} text-sm">${fmtPctSigned(line.driftPercent)}</div>
            <div class="text-[10px] text-gray-400">${fmtEurSigned(line.driftValue)}</div>
            <div class="mt-1">${statusBadge}</div>
          </td>

          <!-- 5. Proposed Action -->
          <td class="px-4 py-3 whitespace-nowrap text-center">
            ${actionBadge}
          </td>

          <!-- 6. Interactive Order Quantity & Amount -->
          <td class="px-4 py-3 whitespace-nowrap">
            <div class="flex items-center justify-center space-x-1">
              <button type="button" class="btn-qty-minus p-1 rounded-md bg-gray-100 hover:bg-gray-200 dark:bg-white/10 dark:hover:bg-white/20 text-gray-700 dark:text-gray-300 font-bold leading-none w-6 h-6 flex items-center justify-center text-xs" data-idx="${idx}">-</button>
              <input type="number" step="${w.allowFractional ? '0.01' : '1'}" min="0" value="${line.suggestedQuantity}" 
                class="input-qty w-16 px-1.5 py-1 text-center rounded-lg border border-gray-200 dark:border-white/10 bg-white dark:bg-[#141416] text-xs font-mono font-bold text-gray-900 dark:text-white focus:outline-none focus:ring-1 focus:ring-emerald-500" data-idx="${idx}">
              <button type="button" class="btn-qty-plus p-1 rounded-md bg-gray-100 hover:bg-gray-200 dark:bg-white/10 dark:hover:bg-white/20 text-gray-700 dark:text-gray-300 font-bold leading-none w-6 h-6 flex items-center justify-center text-xs" data-idx="${idx}">+</button>
            </div>
            <div class="text-center text-[10px] text-gray-400 mt-1 font-mono">
              Tot: <span class="line-order-amount font-bold text-gray-800 dark:text-gray-200">${fmtEur(line.suggestedAmount)}</span>
            </div>
          </td>

          <!-- 7. Projected Outcome (Valore & Peso Previsto) -->
          <td class="px-4 py-3 whitespace-nowrap text-right">
            <div class="font-bold text-gray-900 dark:text-white line-proj-val">${fmtEur(line.projectedValue)}</div>
            <div class="text-[11px] font-semibold ${projDriftColor}">
              <span class="line-proj-pct">${fmtPct(line.projectedPercent)}</span>
              (<span class="line-proj-drift">${fmtPctSigned(line.projectedDriftPercent)}</span>)
            </div>
          </td>
        </tr>
      `;
    }).join('');

    // Attach interactive listeners for quantity tweaking
    tbody.querySelectorAll('.btn-qty-minus').forEach((btn) => {
      btn.addEventListener('click', () => {
        const idx = parseInt(btn.getAttribute('data-idx'), 10);
        updateLineQuantity(idx, -1);
      });
    });

    tbody.querySelectorAll('.btn-qty-plus').forEach((btn) => {
      btn.addEventListener('click', () => {
        const idx = parseInt(btn.getAttribute('data-idx'), 10);
        updateLineQuantity(idx, 1);
      });
    });

    tbody.querySelectorAll('.input-qty').forEach((inp) => {
      inp.addEventListener('input', () => {
        const idx = parseInt(inp.getAttribute('data-idx'), 10);
        const val = parseFloat(inp.value) || 0;
        setLineQuantity(idx, val);
      });
    });
  }

  // Interactive quantity adjustment on worksheet line
  function updateLineQuantity(idx, delta) {
    if (!state.worksheet || !state.worksheet.lines[idx]) return;
    const line = state.worksheet.lines[idx];
    const currentQty = Number(line.suggestedQuantity) || 0;
    const newQty = Math.max(0, currentQty + delta);
    setLineQuantity(idx, newQty);
  }

  function setLineQuantity(idx, newQty) {
    if (!state.worksheet || !state.worksheet.lines[idx]) return;
    const line = state.worksheet.lines[idx];
    line.suggestedQuantity = newQty;
    line.suggestedAmount = newQty * line.currentPrice;

    // Recalculate action
    if (newQty <= 0) {
      line.action = 'HOLD';
    } else if (line.action === 'HOLD') {
      line.action = line.driftPercent < 0 ? 'BUY' : 'SELL';
    }

    // Recalculate projected values
    const qtyChange = line.action === 'BUY'
      ? line.suggestedQuantity
      : (line.action === 'SELL' ? -line.suggestedQuantity : 0.0);

    line.projectedQuantity = Math.max(0, line.currentQuantity + qtyChange);
    line.projectedValue = line.projectedQuantity * line.currentPrice;

    // Recalculate total buys / sells and funding left
    let totalBuys = 0.0;
    let totalSells = 0.0;
    for (const l of state.worksheet.lines) {
      if (l.action === 'BUY') totalBuys += Number(l.suggestedAmount) || 0;
      if (l.action === 'SELL') totalSells += Number(l.suggestedAmount) || 0;
    }

    state.worksheet.totalBuys = totalBuys;
    state.worksheet.totalSells = totalSells;
    state.worksheet.fundingLeft = (state.worksheet.currentCash + state.worksheet.addedCash - totalBuys + totalSells);

    const totalVal = state.worksheet.totalPortfolioValue;
    for (const l of state.worksheet.lines) {
      l.projectedPercent = totalVal > 0 ? (l.projectedValue / totalVal) * 100 : 0;
      l.projectedDriftPercent = l.projectedPercent - l.targetPercent;
      l.projectedInBand = Math.abs(l.projectedDriftPercent) <= state.worksheet.toleranceBand;
    }

    state.worksheet.maxDriftAfter = state.worksheet.lines.reduce((max, l) => Math.max(max, Math.abs(l.projectedDriftPercent)), 0);
    state.worksheet.inBandAfter = state.worksheet.lines.filter(l => l.projectedInBand).length;

    // Update UI elements in-place without losing input focus
    renderSummaryKpis(state.worksheet);

    const tr = document.querySelector(`tr[data-line-index="${idx}"]`);
    if (tr) {
      const inp = tr.querySelector('.input-qty');
      if (inp && parseFloat(inp.value) !== newQty) inp.value = newQty;

      const amtEl = tr.querySelector('.line-order-amount');
      if (amtEl) amtEl.textContent = fmtEur(line.suggestedAmount);

      const valEl = tr.querySelector('.line-proj-val');
      if (valEl) valEl.textContent = fmtEur(line.projectedValue);

      const pctEl = tr.querySelector('.line-proj-pct');
      if (pctEl) pctEl.textContent = fmtPct(line.projectedPercent);

      const driftEl = tr.querySelector('.line-proj-drift');
      if (driftEl) driftEl.textContent = fmtPctSigned(line.projectedDriftPercent);
    }
  }

  // --- DRIFT VISUAL CHART (Mini Bars) ---
  function renderDriftChart(w) {
    const container = document.getElementById('rebalanceDriftChartContainer');
    if (!container) return;

    if (!w.lines || w.lines.length === 0) {
      container.innerHTML = '';
      return;
    }

    container.innerHTML = `
      <div class="space-y-2">
        ${w.lines.map((l) => {
          const curPct = Math.min(100, Math.max(0, l.currentPercent));
          const targetPct = Math.min(100, Math.max(0, l.targetPercent));
          const projPct = Math.min(100, Math.max(0, l.projectedPercent));

          return `
            <div class="space-y-1">
              <div class="flex items-center justify-between text-[11px] font-mono">
                <span class="font-bold text-gray-900 dark:text-white truncate">${l.ticker}</span>
                <span class="text-gray-400">Attuale: <strong class="text-gray-700 dark:text-gray-200">${curPct.toFixed(1)}%</strong> ➔ Previsto: <strong class="text-emerald-500">${projPct.toFixed(1)}%</strong> (Target: ${targetPct.toFixed(1)}%)</span>
              </div>
              <div class="relative w-full h-3 rounded-full bg-gray-100 dark:bg-white/5 overflow-hidden">
                <!-- Target Marker Line -->
                <div class="absolute top-0 bottom-0 w-0.5 bg-gray-900 dark:bg-white z-20 shadow-sm" style="left: ${targetPct}%" title="Target: ${targetPct.toFixed(1)}%"></div>
                <!-- Current Bar -->
                <div class="absolute top-0 bottom-0 left-0 bg-gray-400/30 rounded-full z-10" style="width: ${curPct}%"></div>
                <!-- Projected Bar -->
                <div class="absolute top-0 bottom-0 left-0 bg-emerald-500/80 rounded-full transition-all duration-300" style="width: ${projPct}%"></div>
              </div>
            </div>
          `;
        }).join('')}
      </div>
    `;
  }

  // --- ACTIONS: CLIPBOARD, CSV, APPLY ---
  async function copyOrdersToClipboard() {
    if (!state.worksheet) return;
    try {
      const res = await fetch('/api/rebalancing/calculate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          portfolioId: state.portfolioId,
          presetId: state.selectedTargetKey.startsWith('preset:') ? state.selectedTargetKey.replace('preset:', '') : null,
          targetId: state.selectedTargetKey.startsWith('target:') ? parseInt(state.selectedTargetKey.replace('target:', ''), 10) : null,
          strategy: state.strategy,
          addedCash: Number(state.addedCash) || 0.0,
          toleranceBand: Number(state.toleranceBand) || 2.0
        })
      });
      const data = await res.json();
      if (data && data.clipboardText) {
        await navigator.clipboard.writeText(data.clipboardText);
        showToast('📋 Lista ordini copiata negli appunti! Pronta da incollare nel tuo broker.', 'success');
      }
    } catch (err) {
      console.error('[Rebalance Copy Error]', err);
      showToast('Impossibile copiare negli appunti.', 'error');
    }
  }

  async function exportCsv() {
    if (!state.worksheet) return;
    try {
      const res = await fetch('/api/rebalancing/export-csv', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          worksheet: state.worksheet,
          portfolioName: state.portfolioName
        })
      });

      if (!res.ok) throw new Error('Download CSV fallito.');
      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `rebalancing-worksheet-${new Date().toISOString().split('T')[0]}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(url);
      showToast('📥 Foglio di rebalancing esportato in CSV con successo.', 'success');
    } catch (err) {
      showToast('Errore durante l\'esportazione del file CSV.', 'error');
    }
  }

  function openApplyModal() {
    if (!state.worksheet) return;
    if (state.portfolioId === 'all') {
      showToast('Seleziona uno specifico portafoglio per poter applicare gli ordini.', 'error');
      return;
    }

    const trades = state.worksheet.lines.filter(l => (l.action === 'BUY' || l.action === 'SELL') && l.suggestedQuantity > 0);
    if (trades.length === 0) {
      showToast('Nessun ordine BUY o SELL presente da applicare.', 'info');
      return;
    }

    const modal = document.getElementById('applyTradesModal');
    const listEl = document.getElementById('applyTradesList');
    if (!modal || !listEl) return;

    listEl.innerHTML = trades.map((t) => {
      const isBuy = t.action === 'BUY';
      return `
        <div class="flex items-center justify-between p-3 rounded-xl bg-gray-50 dark:bg-white/5 border border-gray-100 dark:border-white/5 text-xs font-mono">
          <div class="flex items-center space-x-2">
            <span class="px-2 py-0.5 rounded font-bold text-[10px] ${isBuy ? 'bg-emerald-600 text-white' : 'bg-rose-600 text-white'}">
              ${t.action}
            </span>
            <span class="font-bold text-gray-900 dark:text-white">${t.ticker}</span>
          </div>
          <div class="text-right">
            <span class="font-bold text-gray-900 dark:text-white">${fmtQty(t.suggestedQuantity, state.worksheet.allowFractional)} quote</span>
            <span class="text-gray-400 block text-[11px]">${fmtEur(t.suggestedAmount)}</span>
          </div>
        </div>
      `;
    }).join('');

    modal.classList.remove('hidden');
  }

  async function confirmApplyTrades() {
    if (!state.worksheet || !state.portfolioId || state.portfolioId === 'all') return;
    const trades = state.worksheet.lines.filter(l => (l.action === 'BUY' || l.action === 'SELL') && l.suggestedQuantity > 0);

    const btn = document.getElementById('btnConfirmApplyTrades');
    if (btn) btn.disabled = true;

    try {
      const res = await fetch('/api/rebalancing/apply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          portfolioId: state.portfolioId,
          orders: trades.map(t => ({
            ticker: t.ticker,
            action: t.action,
            quantity: t.suggestedQuantity,
            price: t.currentPrice
          })),
          note: `Ribilanciamento Wealthfolio: ${state.targetName}`
        })
      });

      const data = await res.json();
      if (data && data.success) {
        showToast(`✅ ${data.appliedCount} transazioni registrate con successo!`, 'success');
        document.getElementById('applyTradesModal')?.classList.add('hidden');
        await calculateWorksheet();
      } else {
        showToast(data.error || 'Errore durante la registrazione delle transazioni.', 'error');
      }
    } catch (err) {
      showToast('Errore di comunicazione con il server.', 'error');
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  // --- TARGET ALLOCATION MODAL (CREATE / EDIT) ---
  let modalAllocations = [];

  function openCreateTargetModal() {
    modalAllocations = [
      { id: 'EQUITY', label: 'Azioni (Equity)', targetPercent: 60.0 },
      { id: 'BOND', label: 'Obbligazioni (Bond)', targetPercent: 30.0 },
      { id: 'CASH', label: 'Liquidità (Cash)', targetPercent: 10.0 }
    ];

    document.getElementById('targetModalTitle').textContent = 'Nuovo Modello di Allocazione';
    document.getElementById('targetModalName').value = '';
    document.getElementById('targetModalTolerance').value = '2.0';
    document.getElementById('targetModalMode').value = 'CASH_FIRST';
    document.getElementById('targetModalPortfolio').value = '';

    renderModalAllocations();
    document.getElementById('targetModal').classList.remove('hidden');
  }

  function renderModalAllocations() {
    const list = document.getElementById('targetModalAllocationsList');
    if (!list) return;

    list.innerHTML = modalAllocations.map((a, i) => `
      <div class="flex items-center space-x-2 p-2 rounded-xl bg-gray-50 dark:bg-white/5 border border-gray-100 dark:border-white/5">
        <input type="text" value="${a.label || a.id}" placeholder="Es. Azioni Mondiali o SWDA" 
          class="flex-1 px-3 py-1.5 rounded-lg border border-gray-200 dark:border-white/10 bg-white dark:bg-[#141416] text-xs font-medium text-gray-900 dark:text-white"
          onchange="window.RebalancePage.updateModalItem(${i}, 'label', this.value)">
        
        <div class="flex items-center space-x-1">
          <input type="number" step="0.5" min="0" max="100" value="${a.targetPercent}" 
            class="w-16 px-2 py-1.5 rounded-lg border border-gray-200 dark:border-white/10 bg-white dark:bg-[#141416] text-xs font-mono font-bold text-center text-gray-900 dark:text-white"
            oninput="window.RebalancePage.updateModalItem(${i}, 'targetPercent', parseFloat(this.value) || 0)">
          <span class="text-xs text-gray-400 font-mono">%</span>
        </div>

        <button type="button" onclick="window.RebalancePage.removeModalItem(${i})" class="p-1 text-gray-400 hover:text-red-500 rounded-lg">✕</button>
      </div>
    `).join('');

    updateModalSum();
  }

  function updateModalSum() {
    const sum = modalAllocations.reduce((acc, a) => acc + (Number(a.targetPercent) || 0), 0);
    const sumEl = document.getElementById('targetModalSum');
    const barEl = document.getElementById('targetModalSumBar');
    const saveBtn = document.getElementById('btnSaveTargetModal');

    if (sumEl) sumEl.textContent = `${sum.toFixed(1)}%`;
    if (barEl) {
      barEl.style.width = `${Math.min(100, sum)}%`;
      if (Math.abs(sum - 100) < 0.1) {
        barEl.className = 'h-full bg-emerald-500 transition-all';
        sumEl.className = 'font-mono font-bold text-emerald-500';
        if (saveBtn) saveBtn.disabled = false;
      } else {
        barEl.className = 'h-full bg-amber-500 transition-all';
        sumEl.className = 'font-mono font-bold text-amber-500';
        if (saveBtn) saveBtn.disabled = true;
      }
    }
  }

  function addModalItem() {
    modalAllocations.push({ id: 'NEW_ASSET', label: 'Nuova Categoria / Ticker', targetPercent: 0.0 });
    renderModalAllocations();
  }

  function removeModalItem(i) {
    if (modalAllocations.length <= 1) return;
    modalAllocations.splice(i, 1);
    renderModalAllocations();
  }

  function updateModalItem(i, field, val) {
    if (!modalAllocations[i]) return;
    modalAllocations[i][field] = val;
    if (field === 'label' && (!modalAllocations[i].id || modalAllocations[i].id === 'NEW_ASSET')) {
      modalAllocations[i].id = String(val).toUpperCase().replace(/[^A-Z0-9_]/g, '_');
    }
    updateModalSum();
  }

  async function saveTargetModal() {
    const name = document.getElementById('targetModalName')?.value.trim();
    if (!name) {
      showToast('Inserisci un nome per il modello di allocazione.', 'error');
      return;
    }

    const toleranceBand = parseFloat(document.getElementById('targetModalTolerance')?.value) || 2.0;
    const rebalanceMode = document.getElementById('targetModalMode')?.value || 'CASH_FIRST';
    const portfolioId = document.getElementById('targetModalPortfolio')?.value || null;

    try {
      const res = await fetch('/api/rebalancing/targets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          portfolioId,
          name,
          type: 'ASSET_CLASS',
          toleranceBand,
          rebalanceMode,
          allocations: modalAllocations
        })
      });

      const data = await res.json();
      if (data && data.success) {
        showToast('Modello di allocazione salvato con successo!', 'success');
        document.getElementById('targetModal')?.classList.add('hidden');
        await loadTargets();
        state.selectedTargetKey = `target:${data.target.id}`;
        populateTargetSelect();
        await calculateWorksheet();
      } else {
        showToast(data.error || 'Errore durante il salvataggio del modello.', 'error');
      }
    } catch (err) {
      showToast('Errore di connessione durante il salvataggio.', 'error');
    }
  }

  // --- EVENT LISTENERS ---
  function setupEventListeners() {
    // Portfolio change
    document.getElementById('rebalancePortfolioSelect')?.addEventListener('change', (e) => {
      state.portfolioId = e.target.value;
      calculateWorksheet();
    });

    // Target change
    document.getElementById('rebalanceTargetSelect')?.addEventListener('change', (e) => {
      state.selectedTargetKey = e.target.value;
      calculateWorksheet();
    });

    // Strategy pill buttons (CASH_FIRST vs FULL_REBALANCE)
    document.querySelectorAll('[data-strategy-btn]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const strat = btn.getAttribute('data-strategy-btn');
        state.strategy = strat;
        document.querySelectorAll('[data-strategy-btn]').forEach((b) => {
          b.classList.remove('bg-emerald-600', 'text-white', 'shadow-sm');
          b.classList.add('text-gray-600', 'dark:text-gray-400');
        });
        btn.classList.add('bg-emerald-600', 'text-white', 'shadow-sm');
        btn.classList.remove('text-gray-600', 'dark:text-gray-400');
        calculateWorksheet();
      });
    });

    // Added Cash input
    const addedCashInp = document.getElementById('rebalanceAddedCash');
    if (addedCashInp) {
      let debounceTimer;
      addedCashInp.addEventListener('input', (e) => {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          state.addedCash = parseFloat(e.target.value) || 0.0;
          calculateWorksheet();
        }, 300);
      });
    }

    // Advanced settings toggles
    document.getElementById('btnToggleAdvancedSettings')?.addEventListener('click', () => {
      const panel = document.getElementById('rebalanceAdvancedPanel');
      if (panel) panel.classList.toggle('hidden');
    });

    document.getElementById('rebalanceToleranceBand')?.addEventListener('change', (e) => {
      state.toleranceBand = parseFloat(e.target.value) || 2.0;
      calculateWorksheet();
    });

    document.getElementById('rebalanceAllowFractional')?.addEventListener('change', (e) => {
      state.allowFractional = e.target.checked;
      calculateWorksheet();
    });

    document.getElementById('rebalanceMinTradeSize')?.addEventListener('change', (e) => {
      state.minTradeSize = parseFloat(e.target.value) || 25.0;
      calculateWorksheet();
    });

    document.getElementById('rebalanceCashBuffer')?.addEventListener('change', (e) => {
      state.cashBuffer = parseFloat(e.target.value) || 0.0;
      calculateWorksheet();
    });

    // Action buttons
    document.getElementById('btnCopyOrders')?.addEventListener('click', copyOrdersToClipboard);
    document.getElementById('btnExportCsv')?.addEventListener('click', exportCsv);
    document.getElementById('btnApplyTrades')?.addEventListener('click', openApplyModal);
    document.getElementById('btnConfirmApplyTrades')?.addEventListener('click', confirmApplyTrades);
    document.getElementById('btnCancelApplyTrades')?.addEventListener('click', () => {
      document.getElementById('applyTradesModal')?.classList.add('hidden');
    });

    // Target modal buttons
    document.getElementById('btnOpenNewTargetModal')?.addEventListener('click', openCreateTargetModal);
    document.getElementById('btnCloseTargetModal')?.addEventListener('click', () => {
      document.getElementById('targetModal')?.classList.add('hidden');
    });
    document.getElementById('btnAddModalAllocation')?.addEventListener('click', addModalItem);
    document.getElementById('btnSaveTargetModal')?.addEventListener('click', saveTargetModal);
  }

  // Expose global methods for inline HTML event handlers
  window.RebalancePage = {
    init,
    calculateWorksheet,
    openCreateTargetModal,
    addModalItem,
    removeModalItem,
    updateModalItem,
    saveTargetModal,
    copyOrdersToClipboard,
    exportCsv,
    openApplyModal,
    confirmApplyTrades
  };

  // Run on DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();

