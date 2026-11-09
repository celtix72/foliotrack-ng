/**
 * FolioTrack Universal Transaction Modal
 * Interactive modal for creating and editing multi-asset transactions
 * with live ticker search, automatic countervalue calculation in native currency ($/€),
 * dynamic FX conversion, and strict validation controls for SELL operations.
 */

(function () {
  let modalContainer = null;
  let currentEditingTxId = null;
  let searchDebounceTimer = null;
  let userPortfolios = [];

  function getCurrencySymbol(curr) {
    const c = (curr || 'EUR').toUpperCase();
    if (c === 'USD') return '$';
    if (c === 'GBP') return '£';
    if (c === 'CHF') return 'CHF';
    return '€';
  }

  function getPortfolioHoldings(portfolioId) {
    if (!portfolioId) return [];
    const p = userPortfolios.find(x => String(x.id) === String(portfolioId));
    return (p && p.metrics && Array.isArray(p.metrics.holdings)) ? p.metrics.holdings : [];
  }

  function getHoldingInPortfolio(portfolioId, ticker) {
    if (!ticker) return null;
    const cleanTicker = ticker.trim().toUpperCase();
    const holdings = getPortfolioHoldings(portfolioId);
    return holdings.find(h => (h.ticker || '').toUpperCase() === cleanTicker) || null;
  }

  async function fetchLiveFxRate(currency) {
    const c = (currency || 'EUR').toUpperCase();
    if (c === 'EUR') return 1.0;
    if (c === 'USD') {
      try {
        const res = await fetch('/api/market/quote/EURUSD=X');
        const data = await res.json();
        if (data.success && data.quote && Number(data.quote.currentPrice) > 0) {
          return Number(Number(data.quote.currentPrice).toFixed(4));
        }
      } catch {}
      return 1.085;
    }
    if (c === 'GBP') return 0.855;
    if (c === 'CHF') return 0.94;
    return 1.0;
  }

  function createModalHtml() {
    const div = document.createElement('div');
    div.id = 'transaction-modal-backdrop';
    div.className = 'fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm hidden animate-fade-in';

    div.innerHTML = `
      <div id="transaction-modal-card" class="signature-card w-full max-w-xl max-h-[90vh] flex flex-col overflow-hidden shadow-2xl border border-gray-200 dark:border-white/10 bg-white dark:bg-[#18181a]">
        <!-- Header -->
        <div class="px-6 py-4 border-b border-gray-100 dark:border-white/5 flex items-center justify-between">
          <div class="flex items-center space-x-2">
            <span id="txModalBadgeDot" class="w-2.5 h-2.5 rounded-full bg-emerald-500"></span>
            <h3 id="txModalTitle" class="text-base font-bold text-gray-900 dark:text-white">Nuova Transazione</h3>
          </div>
          <button type="button" id="txModalCloseBtn" class="p-1.5 text-gray-400 hover:text-gray-700 dark:hover:text-white rounded-lg hover:bg-gray-100 dark:hover:bg-white/5 transition">
            <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <!-- Body Form (Scrollable) -->
        <form id="transactionForm" class="p-6 space-y-4 overflow-y-auto font-sans flex-1">
          <!-- Alert Box -->
          <div id="txModalAlert" class="hidden p-3 rounded-xl text-xs font-medium font-mono"></div>

          <!-- Portfolio & Type -->
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label for="txPortfolio" class="block text-xs font-semibold uppercase tracking-wider text-gray-600 dark:text-gray-300">
                Portafoglio *
              </label>
              <select id="txPortfolio" name="portfolioId" required
                class="mt-1 block w-full px-3 py-2 rounded-xl border border-gray-300 dark:border-white/10 bg-gray-50/50 dark:bg-[#141416] text-gray-900 dark:text-white text-xs font-medium focus:ring-2 focus:ring-emerald-500 focus:outline-none">
                <!-- Dynamically loaded -->
              </select>
            </div>

            <div>
              <label for="txType" class="block text-xs font-semibold uppercase tracking-wider text-gray-600 dark:text-gray-300">
                Tipo Operazione *
              </label>
              <select id="txType" name="type" required
                class="mt-1 block w-full px-3 py-2 rounded-xl border border-gray-300 dark:border-white/10 bg-gray-50/50 dark:bg-[#141416] text-gray-900 dark:text-white text-xs font-semibold focus:ring-2 focus:ring-emerald-500 focus:outline-none font-mono">
                <option value="BUY">BUY - Acquisto Titolo</option>
                <option value="SELL">SELL - Vendita Titolo</option>
                <option value="DIVIDEND">DIVIDEND - Incasso Dividendo</option>
                <option value="INTEREST">INTEREST - Cedola Obbligazione / BTP</option>
                <option value="DEPOSIT">DEPOSIT - Versamento Liquidità</option>
                <option value="WITHDRAWAL">WITHDRAWAL - Prelievo Liquidità</option>
                <option value="FEE">FEE - Commissioni di Gestione</option>
                <option value="TAX">TAX - Imposta di Bollo / Capital Gain</option>
                <option value="SPLIT">SPLIT - Frazionamento Azionario</option>
              </select>
            </div>
          </div>

          <!-- Quick-Pick Holdings in Portfolio (Visible on SELL) -->
          <div id="holdingsQuickPickRow" class="hidden">
            <label for="txPortfolioHoldingPick" class="block text-xs font-semibold uppercase tracking-wider text-gray-600 dark:text-gray-300 flex items-center justify-between">
              <span>Seleziona Titolo in Portafoglio da Vendere</span>
              <span class="text-[10px] text-gray-400 font-mono font-normal">Solo titoli posseduti</span>
            </label>
            <select id="txPortfolioHoldingPick"
              class="mt-1 block w-full px-3 py-2 rounded-xl border border-gray-300 dark:border-white/10 bg-gray-50/50 dark:bg-[#141416] text-gray-900 dark:text-white text-xs font-mono font-medium focus:ring-2 focus:ring-rose-500 focus:outline-none">
              <option value="">-- Seleziona un titolo da vendere --</option>
            </select>
          </div>

          <!-- Ticker Search & Autocomplete -->
          <div id="tickerRow" class="relative">
            <label for="txTicker" class="block text-xs font-semibold uppercase tracking-wider text-gray-600 dark:text-gray-300">
              Ticker o ISIN <span id="tickerRequiredStar">*</span>
            </label>
            <div class="mt-1 relative">
              <input type="text" id="txTicker" name="assetTicker" autocomplete="off"
                placeholder="Cerca es. AAPL, NVDA, CSPX.MI, IT0005518524..."
                class="block w-full px-3 py-2 rounded-xl border border-gray-300 dark:border-white/10 bg-gray-50/50 dark:bg-[#141416] text-gray-900 dark:text-white text-xs font-mono uppercase focus:ring-2 focus:ring-emerald-500 focus:outline-none">
              <span id="tickerSearchSpinner" class="hidden absolute right-3 top-2.5 animate-spin w-4 h-4 border-2 border-emerald-500 border-t-transparent rounded-full"></span>
            </div>

            <!-- Autocomplete Results Dropdown -->
            <div id="tickerDropdown" class="hidden absolute left-0 right-0 top-full mt-1 max-h-48 overflow-y-auto bg-white dark:bg-[#1a1a1c] border border-gray-200 dark:border-white/10 rounded-xl shadow-xl z-50 divide-y divide-gray-100 dark:divide-white/5">
            </div>

            <!-- Holding Info Banner (Quote possedute, PMC, etc) -->
            <div id="holdingInfoBanner" class="hidden mt-2 p-2.5 rounded-xl text-xs font-mono border"></div>
          </div>

          <!-- Date & Quantity -->
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label for="txDate" class="block text-xs font-semibold uppercase tracking-wider text-gray-600 dark:text-gray-300">
                Data Operazione *
              </label>
              <input type="date" id="txDate" name="date" required
                class="mt-1 block w-full px-3 py-2 rounded-xl border border-gray-300 dark:border-white/10 bg-gray-50/50 dark:bg-[#141416] text-gray-900 dark:text-white text-xs font-mono focus:ring-2 focus:ring-emerald-500 focus:outline-none">
            </div>

            <div id="quantityCol">
              <label for="txQuantity" class="block text-xs font-semibold uppercase tracking-wider text-gray-600 dark:text-gray-300">
                Quantità Quote *
              </label>
              <input type="number" step="any" min="0" id="txQuantity" name="quantity" placeholder="0.00"
                class="mt-1 block w-full px-3 py-2 rounded-xl border border-gray-300 dark:border-white/10 bg-gray-50/50 dark:bg-[#141416] text-gray-900 dark:text-white text-xs font-mono tabular-nums focus:ring-2 focus:ring-emerald-500 focus:outline-none">
            </div>
          </div>

          <!-- Price & Currency / FX -->
          <div class="grid grid-cols-1 sm:grid-cols-3 gap-3" id="priceRow">
            <div class="sm:col-span-1">
              <label for="txPrice" class="block text-xs font-semibold uppercase tracking-wider text-gray-600 dark:text-gray-300">
                Prezzo Unitario <span id="txPriceCurrencyLabel" class="text-emerald-600 dark:text-emerald-400 font-mono font-bold">(€)</span> *
              </label>
              <input type="number" step="any" min="0" id="txPrice" name="price" placeholder="0.00"
                class="mt-1 block w-full px-3 py-2 rounded-xl border border-gray-300 dark:border-white/10 bg-gray-50/50 dark:bg-[#141416] text-gray-900 dark:text-white text-xs font-mono tabular-nums focus:ring-2 focus:ring-emerald-500 focus:outline-none">
            </div>

            <div>
              <label for="txCurrency" class="block text-xs font-semibold uppercase tracking-wider text-gray-600 dark:text-gray-300">
                Valuta Titolo
              </label>
              <select id="txCurrency"
                class="mt-1 block w-full px-3 py-2 rounded-xl border border-gray-300 dark:border-white/10 bg-gray-50/50 dark:bg-[#141416] text-gray-900 dark:text-white text-xs font-mono focus:ring-2 focus:ring-emerald-500 focus:outline-none font-bold">
                <option value="EUR">EUR (€)</option>
                <option value="USD">USD ($)</option>
                <option value="GBP">GBP (£)</option>
                <option value="CHF">CHF</option>
              </select>
            </div>

            <div>
              <label for="txFxRate" class="block text-xs font-semibold uppercase tracking-wider text-gray-600 dark:text-gray-300">
                Cambio FX <span id="txFxCurrencyHint" class="text-gray-400 font-mono text-[10px]">(EUR/USD)</span>
              </label>
              <input type="number" step="any" min="0.0001" id="txFxRate" name="exchangeRate" value="1.0"
                class="mt-1 block w-full px-3 py-2 rounded-xl border border-gray-300 dark:border-white/10 bg-gray-50/50 dark:bg-[#141416] text-gray-900 dark:text-white text-xs font-mono tabular-nums focus:ring-2 focus:ring-emerald-500 focus:outline-none">
            </div>
          </div>

          <!-- Commission & Tax -->
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-4" id="feesRow">
            <div>
              <label for="txCommission" class="block text-xs font-semibold uppercase tracking-wider text-gray-600 dark:text-gray-300">
                Commissione <span id="txCommCurrencyLabel" class="text-gray-400 font-mono">(€)</span>
              </label>
              <input type="number" step="any" min="0" id="txCommission" name="commission" value="0.00"
                class="mt-1 block w-full px-3 py-2 rounded-xl border border-gray-300 dark:border-white/10 bg-gray-50/50 dark:bg-[#141416] text-gray-900 dark:text-white text-xs font-mono tabular-nums focus:ring-2 focus:ring-emerald-500 focus:outline-none">
            </div>

            <div>
              <label for="txTax" class="block text-xs font-semibold uppercase tracking-wider text-gray-600 dark:text-gray-300">
                Ritenute / Tasse <span id="txTaxCurrencyLabel" class="text-gray-400 font-mono">(€)</span>
              </label>
              <input type="number" step="any" min="0" id="txTax" name="tax" value="0.00"
                class="mt-1 block w-full px-3 py-2 rounded-xl border border-gray-300 dark:border-white/10 bg-gray-50/50 dark:bg-[#141416] text-gray-900 dark:text-white text-xs font-mono tabular-nums focus:ring-2 focus:ring-emerald-500 focus:outline-none">
            </div>
          </div>

          <!-- Direct Amount (for Cash / Dividends) -->
          <div id="directAmountRow" class="hidden">
            <label for="txAmount" class="block text-xs font-semibold uppercase tracking-wider text-gray-600 dark:text-gray-300">
              Importo Diretto <span id="txAmountCurrencyLabel" class="text-gray-400 font-mono">(€)</span> *
            </label>
            <input type="number" step="any" min="0" id="txAmount" name="amount" placeholder="0.00"
              class="mt-1 block w-full px-3 py-2 rounded-xl border border-gray-300 dark:border-white/10 bg-gray-50/50 dark:bg-[#141416] text-gray-900 dark:text-white text-xs font-mono tabular-nums focus:ring-2 focus:ring-emerald-500 focus:outline-none">
          </div>

          <!-- Notes -->
          <div>
            <label for="txNotes" class="block text-xs font-semibold uppercase tracking-wider text-gray-600 dark:text-gray-300">
              Note (Opzionale)
            </label>
            <input type="text" id="txNotes" name="notes" placeholder="es. Vendita parziale, realizzo profitto, PAC..."
              class="mt-1 block w-full px-3 py-2 rounded-xl border border-gray-300 dark:border-white/10 bg-gray-50/50 dark:bg-[#141416] text-gray-900 dark:text-white text-xs focus:ring-2 focus:ring-emerald-500 focus:outline-none">
          </div>

          <!-- Countervalue Preview Card -->
          <div class="signature-card p-4 bg-gray-50/70 dark:bg-white/[0.03] border border-gray-200/80 dark:border-white/10 flex flex-col space-y-1.5 shadow-2xs">
            <div class="flex items-center justify-between">
              <span id="countervalueLabel" class="text-xs text-gray-500 dark:text-gray-400 font-medium font-mono uppercase">Controvalore Calcolato:</span>
              <span id="calculatedCountervalue" class="text-lg font-bold font-mono tabular-nums text-emerald-600 dark:text-emerald-400">€ 0,00</span>
            </div>
            <div id="countervalueFxRow" class="hidden text-[11px] font-mono text-gray-400 flex items-center justify-between pt-1.5 border-t border-gray-200/50 dark:border-white/5">
              <span>Controvalore Cassa Stimato (EUR):</span>
              <strong id="countervalueEur" class="text-gray-800 dark:text-gray-200 font-bold">€ 0,00</strong>
            </div>
          </div>

          <!-- Footer Actions -->
          <div class="pt-4 flex items-center justify-end space-x-3">
            <button type="button" id="txModalCancelBtn" class="btn-pill px-4 py-2 border border-gray-300 dark:border-white/10 text-gray-700 dark:text-gray-300 text-xs font-medium hover:bg-gray-100 dark:hover:bg-white/5 transition">
              Annulla
            </button>
            <button type="submit" id="txModalSubmitBtn" class="btn-pill px-6 py-2 bg-emerald-600 hover:bg-emerald-700 active:bg-emerald-800 text-white text-xs font-medium transition shadow-md shadow-emerald-600/20">
              Salva Movimento
            </button>
          </div>
        </form>
      </div>
    `;

    document.body.appendChild(div);
    return div;
  }

  function updateCurrencyLabels() {
    const curr = (document.getElementById('txCurrency')?.value || 'EUR').toUpperCase();
    const currSym = getCurrencySymbol(curr);

    const priceLabel = document.getElementById('txPriceCurrencyLabel');
    if (priceLabel) priceLabel.textContent = `(${currSym})`;

    const commLabel = document.getElementById('txCommCurrencyLabel');
    if (commLabel) commLabel.textContent = `(${currSym})`;

    const taxLabel = document.getElementById('txTaxCurrencyLabel');
    if (taxLabel) taxLabel.textContent = curr === 'EUR' ? '(€)' : `(EUR / ${currSym})`;

    const amtLabel = document.getElementById('txAmountCurrencyLabel');
    if (amtLabel) amtLabel.textContent = `(${currSym})`;

    const fxHint = document.getElementById('txFxCurrencyHint');
    if (fxHint) {
      fxHint.textContent = curr === 'EUR' ? '(1.0)' : `(EUR/${curr})`;
    }
  }

  function updateHoldingsQuickPick() {
    const type = document.getElementById('txType')?.value;
    const pId = document.getElementById('txPortfolio')?.value;
    const quickPickRow = document.getElementById('holdingsQuickPickRow');
    const select = document.getElementById('txPortfolioHoldingPick');

    if (!quickPickRow || !select) return;

    if (type !== 'SELL' || !pId) {
      quickPickRow.classList.add('hidden');
      select.innerHTML = '<option value="">-- Seleziona un titolo da vendere --</option>';
      return;
    }

    const holdings = getPortfolioHoldings(pId);
    if (!holdings || holdings.length === 0) {
      quickPickRow.classList.remove('hidden');
      select.innerHTML = '<option value="">Nessun titolo aperto in questo portafoglio</option>';
      return;
    }

    quickPickRow.classList.remove('hidden');
    select.innerHTML = '<option value="">-- Seleziona un titolo da vendere (' + holdings.length + ' in portafoglio) --</option>' +
      holdings.map(h => {
        const curr = (h.currency || 'EUR').toUpperCase();
        const currSym = getCurrencySymbol(curr);
        const qty = Number(h.quantity) || 0;
        const prc = Number(h.currentPriceNative || h.currentPrice || h.pmc || 0);
        return `<option value="${h.ticker}" data-curr="${curr}" data-qty="${qty}" data-prc="${prc}" data-pmc="${h.pmc || 0}">
          ${h.ticker} - ${h.name || h.ticker} (${qty} quote - ${currSym} ${prc.toFixed(2)})
        </option>`;
      }).join('');
  }

  function validateSellQuantity() {
    const type = document.getElementById('txType')?.value;
    const ticker = (document.getElementById('txTicker')?.value || '').trim().toUpperCase();
    const pId = document.getElementById('txPortfolio')?.value;
    const qty = parseFloat(document.getElementById('txQuantity')?.value) || 0;
    const price = parseFloat(document.getElementById('txPrice')?.value) || 0;
    const alertBox = document.getElementById('txModalAlert');
    const submitBtn = document.getElementById('txModalSubmitBtn');
    const banner = document.getElementById('holdingInfoBanner');

    if (type !== 'SELL' || !pId || !ticker) {
      if (banner) banner.classList.add('hidden');
      if (alertBox && alertBox.dataset.sellError) {
        alertBox.classList.add('hidden');
        delete alertBox.dataset.sellError;
      }
      if (submitBtn) submitBtn.disabled = false;
      return true;
    }

    const holding = getHoldingInPortfolio(pId, ticker);
    if (!holding || (Number(holding.quantity) || 0) <= 1e-9) {
      if (banner) {
        banner.className = 'mt-2 p-2.5 rounded-xl text-xs font-mono bg-rose-500/10 text-rose-700 dark:text-rose-300 border border-rose-500/20';
        banner.innerHTML = `⚠️ <strong>Nessuna quota posseduta:</strong> il titolo <strong>${ticker}</strong> non è presente in questo portafoglio. Impossibile registrare una vendita.`;
        banner.classList.remove('hidden');
      }
      if (submitBtn) submitBtn.disabled = true;
      return false;
    }

    const availableQty = Number(holding.quantity) || 0;
    const curr = (holding.currency || 'EUR').toUpperCase();
    const currSym = getCurrencySymbol(curr);
    const pmc = holding.pmcNative || holding.pmc || 0;
    const curP = holding.currentPriceNative || holding.currentPrice || pmc;

    if (banner) {
      banner.className = 'mt-2 p-2.5 rounded-xl text-xs font-mono bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border border-emerald-500/20 flex items-center justify-between';
      banner.innerHTML = `
        <div class="truncate mr-2">
          <span>In Portafoglio: <strong>${availableQty} quote</strong> (${curr})</span>
          <span class="text-[10px] text-gray-500 dark:text-gray-400 block">PMC: ${currSym} ${Number(pmc).toFixed(2)} | Attuale: ${currSym} ${Number(curP).toFixed(2)}</span>
        </div>
        <button type="button" id="btnSellAll" class="shrink-0 px-2.5 py-1 rounded-lg bg-rose-600 hover:bg-rose-700 active:scale-95 text-white text-[10px] font-bold transition shadow-xs">
          Vendi Tutte (${availableQty})
        </button>
      `;
      banner.classList.remove('hidden');

      const btnSellAll = document.getElementById('btnSellAll');
      if (btnSellAll) {
        btnSellAll.onclick = (e) => {
          e.preventDefault();
          document.getElementById('txQuantity').value = availableQty;
          recalculateModalCountervalue();
        };
      }
    }

    if (qty > availableQty + 1e-9) {
      if (alertBox) {
        alertBox.className = 'p-3 rounded-xl text-xs font-medium font-mono bg-rose-50 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300 border border-rose-200 dark:border-rose-800/40';
        alertBox.textContent = `⚠️ Quantità da vendere (${qty}) superiore alle ${availableQty} quote possedute in portafoglio!`;
        alertBox.classList.remove('hidden');
        alertBox.dataset.sellError = 'true';
      }
      if (submitBtn) submitBtn.disabled = true;
      return false;
    }

    if (qty <= 0) {
      if (submitBtn) submitBtn.disabled = true;
      return false;
    }

    if (price <= 0) {
      if (submitBtn) submitBtn.disabled = true;
      return false;
    }

    if (alertBox && alertBox.dataset.sellError) {
      alertBox.classList.add('hidden');
      delete alertBox.dataset.sellError;
    }
    if (submitBtn) submitBtn.disabled = false;
    return true;
  }

  function recalculateModalCountervalue() {
    const type = document.getElementById('txType')?.value || 'BUY';
    const qty = parseFloat(document.getElementById('txQuantity')?.value) || 0;
    const price = parseFloat(document.getElementById('txPrice')?.value) || 0;
    const comm = parseFloat(document.getElementById('txCommission')?.value) || 0;
    const tax = parseFloat(document.getElementById('txTax')?.value) || 0;
    const fx = parseFloat(document.getElementById('txFxRate')?.value) || 1.0;
    const directAmt = parseFloat(document.getElementById('txAmount')?.value) || 0;
    const curr = (document.getElementById('txCurrency')?.value || 'EUR').toUpperCase();
    const currSym = getCurrencySymbol(curr);

    updateCurrencyLabels();
    validateSellQuantity();

    // 1. Calculate native countervalue in asset currency ($ if USD, € if EUR)
    let grossNative = qty * price;
    let netNative = grossNative;

    if (type === 'SELL') {
      netNative = Math.max(0, grossNative - comm);
    } else if (type === 'BUY') {
      netNative = grossNative + comm;
    } else if (['DEPOSIT', 'WITHDRAWAL', 'TRANSFER'].includes(type)) {
      netNative = directAmt > 0 ? directAmt : grossNative;
    } else if (type === 'DIVIDEND' || type === 'INTEREST') {
      netNative = directAmt > 0 ? directAmt : Math.max(0, grossNative - tax);
    } else if (type === 'FEE' || type === 'TAX') {
      netNative = directAmt > 0 ? directAmt : (comm + tax);
    }

    // Format native countervalue string
    const fmtNative = currSym + ' ' + netNative.toLocaleString('it-IT', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    });

    const mainCounterEl = document.getElementById('calculatedCountervalue');
    if (mainCounterEl) {
      mainCounterEl.textContent = fmtNative;
      mainCounterEl.className = 'text-lg font-bold font-mono tabular-nums ' +
        (type === 'SELL' ? 'text-rose-600 dark:text-rose-400' : 'text-emerald-600 dark:text-emerald-400');
    }

    const counterLabelEl = document.getElementById('countervalueLabel');
    if (counterLabelEl) {
      if (type === 'SELL') {
        counterLabelEl.textContent = `Controvalore Vendita (${curr}):`;
      } else if (type === 'BUY') {
        counterLabelEl.textContent = `Controvalore Acquisto (${curr}):`;
      } else {
        counterLabelEl.textContent = `Controvalore (${curr}):`;
      }
    }

    // 2. Converted EUR equivalent when currency is foreign (e.g. USD $)
    const fxRow = document.getElementById('countervalueFxRow');
    const eurValEl = document.getElementById('countervalueEur');
    if (fxRow && eurValEl) {
      if (curr !== 'EUR' && fx > 0) {
        fxRow.classList.remove('hidden');
        const grossEur = (qty * price) / fx;
        const commEur = comm > 0 ? (comm / fx) : 0;
        let netEur = 0;
        if (type === 'SELL') {
          netEur = Math.max(0, grossEur - commEur - tax);
        } else if (type === 'BUY') {
          netEur = grossEur + commEur + tax;
        } else {
          netEur = grossEur;
        }
        eurValEl.textContent = '€ ' + netEur.toLocaleString('it-IT', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) +
          ` (@ FX 1 EUR = ${Number(fx).toFixed(4)} ${curr})`;
      } else {
        fxRow.classList.add('hidden');
      }
    }
  }

  function handleTypeChange() {
    const type = document.getElementById('txType').value;
    const tickerRow = document.getElementById('tickerRow');
    const tickerRequiredStar = document.getElementById('tickerRequiredStar');
    const directAmountRow = document.getElementById('directAmountRow');
    const feesRow = document.getElementById('feesRow');
    const priceRow = document.getElementById('priceRow');
    const quantityCol = document.getElementById('quantityCol');
    const badgeDot = document.getElementById('txModalBadgeDot');
    const submitBtn = document.getElementById('txModalSubmitBtn');

    if (['DEPOSIT', 'WITHDRAWAL', 'TRANSFER'].includes(type)) {
      tickerRow.classList.add('hidden');
      tickerRequiredStar.classList.add('hidden');
      directAmountRow.classList.remove('hidden');
      feesRow.classList.add('hidden');
      priceRow.classList.add('hidden');
      quantityCol.classList.add('hidden');
    } else {
      tickerRow.classList.remove('hidden');
      tickerRequiredStar.classList.remove('hidden');
      directAmountRow.classList.add('hidden');
      feesRow.classList.remove('hidden');
      priceRow.classList.remove('hidden');
      quantityCol.classList.remove('hidden');
    }

    if (badgeDot && submitBtn) {
      if (type === 'SELL') {
        badgeDot.className = 'w-2.5 h-2.5 rounded-full bg-rose-500';
        submitBtn.className = 'btn-pill px-6 py-2 bg-rose-600 hover:bg-rose-700 active:bg-rose-800 text-white text-xs font-medium transition shadow-md shadow-rose-600/20';
        submitBtn.textContent = 'Conferma Vendita (SELL)';
      } else {
        badgeDot.className = 'w-2.5 h-2.5 rounded-full bg-emerald-500';
        submitBtn.className = 'btn-pill px-6 py-2 bg-emerald-600 hover:bg-emerald-700 active:bg-emerald-800 text-white text-xs font-medium transition shadow-md shadow-emerald-600/20';
        submitBtn.textContent = currentEditingTxId ? 'Aggiorna Movimento' : 'Salva Movimento';
      }
    }

    updateHoldingsQuickPick();
    updateCurrencyLabels();
    recalculateModalCountervalue();
  }

  async function searchTickers(query) {
    const dropdown = document.getElementById('tickerDropdown');
    const spinner = document.getElementById('tickerSearchSpinner');

    if (!query || query.trim().length < 2) {
      dropdown.classList.add('hidden');
      dropdown.innerHTML = '';
      return;
    }

    spinner.classList.remove('hidden');

    try {
      const res = await fetch(`/api/market/search?q=${encodeURIComponent(query)}`);
      const data = await res.json();
      spinner.classList.add('hidden');

      if (data.success && data.results && data.results.length > 0) {
        dropdown.innerHTML = data.results.slice(0, 8).map(item => `
          <div class="px-4 py-2 hover:bg-emerald-50 dark:hover:bg-white/5 cursor-pointer flex items-center justify-between transition" data-select-ticker="${item.ticker}">
            <div class="truncate pr-2">
              <span class="font-bold font-mono text-xs text-gray-900 dark:text-white">${item.ticker}</span>
              <span class="text-[11px] text-gray-500 dark:text-gray-400 truncate block">${item.name || ''}</span>
            </div>
            <span class="badge-profit uppercase text-[9px] font-mono shrink-0">${item.type || 'ASSET'}</span>
          </div>
        `).join('');

        dropdown.classList.remove('hidden');

        dropdown.querySelectorAll('[data-select-ticker]').forEach(el => {
          el.addEventListener('click', async () => {
            const ticker = el.getAttribute('data-select-ticker');
            document.getElementById('txTicker').value = ticker;
            dropdown.classList.add('hidden');

            // Auto-fetch real-time price & currency
            try {
              const qRes = await fetch(`/api/market/quote/${encodeURIComponent(ticker)}`);
              const qData = await qRes.json();
              if (qData.success && qData.quote) {
                if (qData.quote.currentPrice) {
                  document.getElementById('txPrice').value = qData.quote.currentPrice;
                }
                if (qData.quote.currency) {
                  const curr = (qData.quote.currency || 'EUR').toUpperCase();
                  document.getElementById('txCurrency').value = curr;
                  const fxRate = await fetchLiveFxRate(curr);
                  document.getElementById('txFxRate').value = fxRate;
                }
                updateCurrencyLabels();
                recalculateModalCountervalue();
              }
            } catch {}
          });
        });
      } else {
        dropdown.innerHTML = '<div class="p-3 text-xs text-gray-400 text-center font-mono">Nessun titolo trovato</div>';
        dropdown.classList.remove('hidden');
      }
    } catch {
      spinner.classList.add('hidden');
    }
  }

  async function loadUserPortfolios() {
    try {
      const res = await fetch('/api/portfolios');
      const data = await res.json();
      if (data.success && data.portfolios) {
        userPortfolios = data.portfolios;
        const select = document.getElementById('txPortfolio');
        if (select) {
          const currentVal = select.value;
          select.innerHTML = userPortfolios.map(p => `
            <option value="${p.id}">${p.name} (${p.currency} - ${p.costBasisMethod})</option>
          `).join('');
          if (currentVal && select.querySelector(`option[value="${currentVal}"]`)) {
            select.value = currentVal;
          }
        }
        updateHoldingsQuickPick();
      }
    } catch (err) {
      console.warn('Error loading portfolios in modal:', err);
    }
  }

  async function open(options = {}) {
    if (!modalContainer) {
      modalContainer = createModalHtml();
      setupEvents();
    }

    await loadUserPortfolios();

    currentEditingTxId = options.id || null;
    const titleEl = document.getElementById('txModalTitle');
    const isSell = options.type === 'SELL';
    titleEl.textContent = currentEditingTxId
      ? 'Modifica Transazione'
      : (isSell ? 'Nuova Vendita Titolo (SELL)' : 'Nuova Transazione');

    // Set default date to today
    document.getElementById('txDate').value = options.date || new Date().toISOString().split('T')[0];

    if (options.portfolioId) document.getElementById('txPortfolio').value = options.portfolioId;
    if (options.type) document.getElementById('txType').value = options.type;
    if (options.assetTicker) document.getElementById('txTicker').value = options.assetTicker;
    if (options.quantity) document.getElementById('txQuantity').value = options.quantity;
    if (options.price) document.getElementById('txPrice').value = options.price;
    if (options.commission) document.getElementById('txCommission').value = options.commission;
    if (options.tax) document.getElementById('txTax').value = options.tax;
    if (options.notes) document.getElementById('txNotes').value = options.notes;
    if (options.amount) document.getElementById('txAmount').value = options.amount;

    // Currency handling
    let curr = options.currency ? options.currency.toUpperCase() : 'EUR';
    // If not passed explicitly, check if assetTicker is in portfolio
    if (!options.currency && options.assetTicker) {
      const h = getHoldingInPortfolio(options.portfolioId || document.getElementById('txPortfolio').value, options.assetTicker);
      if (h && h.currency) curr = h.currency.toUpperCase();
    }
    document.getElementById('txCurrency').value = curr;

    // Exchange rate handling
    if (options.exchangeRate && Number(options.exchangeRate) > 0) {
      document.getElementById('txFxRate').value = options.exchangeRate;
    } else {
      const fxRate = await fetchLiveFxRate(curr);
      document.getElementById('txFxRate').value = fxRate;
    }

    handleTypeChange();
    updateHoldingsQuickPick();
    updateCurrencyLabels();
    recalculateModalCountervalue();

    modalContainer.classList.remove('hidden');
    document.body.classList.add('overflow-hidden');
  }

  function close() {
    if (modalContainer) {
      modalContainer.classList.add('hidden');
      document.body.classList.remove('overflow-hidden');
      document.getElementById('transactionForm').reset();
      document.getElementById('txModalAlert').classList.add('hidden');
      currentEditingTxId = null;
    }
  }

  function setupEvents() {
    document.getElementById('txModalCloseBtn').addEventListener('click', close);
    document.getElementById('txModalCancelBtn').addEventListener('click', close);

    document.getElementById('txPortfolio').addEventListener('change', () => {
      updateHoldingsQuickPick();
      validateSellQuantity();
      recalculateModalCountervalue();
    });

    document.getElementById('txType').addEventListener('change', handleTypeChange);

    // Quick-pick holding in portfolio for SELL
    document.getElementById('txPortfolioHoldingPick')?.addEventListener('change', async (e) => {
      const ticker = e.target.value;
      if (!ticker) return;

      const pId = document.getElementById('txPortfolio').value;
      const h = getHoldingInPortfolio(pId, ticker);
      if (h) {
        document.getElementById('txTicker').value = h.ticker;
        const curr = (h.currency || 'EUR').toUpperCase();
        document.getElementById('txCurrency').value = curr;

        const prc = h.currentPriceNative || h.currentPrice || h.pmcNative || h.pmc || 0;
        document.getElementById('txPrice').value = Number(prc) > 0 ? Number(prc).toFixed(2) : '';

        // If user hasn't typed quantity yet, propose full quantity
        const currentQty = parseFloat(document.getElementById('txQuantity').value) || 0;
        if (currentQty <= 0) {
          document.getElementById('txQuantity').value = h.quantity;
        }

        const fxRate = await fetchLiveFxRate(curr);
        document.getElementById('txFxRate').value = fxRate;

        updateCurrencyLabels();
        recalculateModalCountervalue();
      }
    });

    // Valuta change event
    document.getElementById('txCurrency').addEventListener('change', async (e) => {
      const curr = e.target.value;
      const fxRate = await fetchLiveFxRate(curr);
      document.getElementById('txFxRate').value = fxRate;
      updateCurrencyLabels();
      recalculateModalCountervalue();
    });

    // Dynamic countervalue and validation updates
    ['txQuantity', 'txPrice', 'txCommission', 'txTax', 'txFxRate', 'txAmount'].forEach(id => {
      document.getElementById(id).addEventListener('input', recalculateModalCountervalue);
    });

    document.getElementById('txTicker').addEventListener('input', (e) => {
      validateSellQuantity();
      recalculateModalCountervalue();
      clearTimeout(searchDebounceTimer);
      const val = e.target.value;
      searchDebounceTimer = setTimeout(() => searchTickers(val), 250);
    });

    // Close autocomplete on click outside
    document.addEventListener('click', (e) => {
      if (!e.target.closest('#tickerRow')) {
        const dd = document.getElementById('tickerDropdown');
        if (dd) dd.classList.add('hidden');
      }
    });

    // Form submission
    document.getElementById('transactionForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const alertBox = document.getElementById('txModalAlert');
      const submitBtn = document.getElementById('txModalSubmitBtn');

      const formData = new FormData(e.target);
      const payload = {
        portfolioId: parseInt(formData.get('portfolioId'), 10),
        type: formData.get('type'),
        assetTicker: formData.get('assetTicker') ? formData.get('assetTicker').trim().toUpperCase() : null,
        date: formData.get('date'),
        quantity: parseFloat(formData.get('quantity')) || 0,
        price: parseFloat(formData.get('price')) || 0,
        commission: parseFloat(formData.get('commission')) || 0,
        tax: parseFloat(formData.get('tax')) || 0,
        exchangeRate: parseFloat(formData.get('exchangeRate')) || 1.0,
        amount: parseFloat(formData.get('amount')) || 0,
        notes: formData.get('notes') ? formData.get('notes').trim() : ''
      };

      // Strict validation before dispatch
      if (payload.type === 'SELL') {
        if (!validateSellQuantity()) {
          return;
        }
        if (payload.price <= 0) {
          alertBox.className = 'p-3 rounded-xl text-xs font-medium font-mono bg-rose-50 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300 border border-rose-200 dark:border-rose-800/40';
          alertBox.textContent = 'Errore: Il prezzo di vendita deve essere maggiore di 0.';
          alertBox.classList.remove('hidden');
          return;
        }
      }

      submitBtn.disabled = true;
      submitBtn.textContent = 'Salvataggio in corso...';

      try {
        const url = currentEditingTxId ? `/api/transactions/${currentEditingTxId}` : '/api/transactions';
        const method = currentEditingTxId ? 'PUT' : 'POST';

        const res = await fetch(url, {
          method,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });

        const data = await res.json();

        if (res.ok && data.success) {
          close();
          // Dispatch custom event to refresh dashboard or transactions table
          document.dispatchEvent(new CustomEvent('transactionSaved', { detail: data }));
          if (typeof window.refreshDashboard === 'function') {
            window.refreshDashboard();
          }
          if (typeof window.loadTransactions === 'function') {
            window.loadTransactions();
          }
          if (typeof window.loadPortfolioDetail === 'function') {
            window.loadPortfolioDetail();
          }
        } else {
          alertBox.className = 'p-3 rounded-xl text-xs font-medium font-mono bg-rose-50 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300 border border-rose-200 dark:border-rose-800/40';
          alertBox.textContent = data.error || 'Errore nel salvataggio della transazione.';
          alertBox.classList.remove('hidden');
        }
      } catch (err) {
        alertBox.className = 'p-3 rounded-xl text-xs font-medium font-mono bg-rose-50 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300 border border-rose-200 dark:border-rose-800/40';
        alertBox.textContent = 'Errore di connessione: ' + err.message;
        alertBox.classList.remove('hidden');
      } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = payload.type === 'SELL' ? 'Conferma Vendita (SELL)' : 'Salva Movimento';
      }
    });
  }

  // Auto-bind any button with [data-open-tx-modal] or id="newTxBtn"
  document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('[data-open-tx-modal], #newTxBtn, #addTxBtn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        open();
      });
    });
  });

  window.TransactionModal = {
    open,
    close,
    recalculateModalCountervalue,
    validateSellQuantity,
    getCurrencySymbol
  };
})();
