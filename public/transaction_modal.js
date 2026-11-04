/**
 * FolioTrack Universal Transaction Modal
 * Interactive modal for creating and editing multi-asset transactions
 * with live ticker search, automatic countervalue calculation, and FX conversion.
 */

(function () {
  let modalContainer = null;
  let currentEditingTxId = null;
  let searchDebounceTimer = null;
  let userPortfolios = [];

  function createModalHtml() {
    const div = document.createElement('div');
    div.id = 'transaction-modal-backdrop';
    div.className = 'fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm hidden animate-fade-in';

    div.innerHTML = `
      <div id="transaction-modal-card" class="signature-card w-full max-w-xl max-h-[90vh] flex flex-col overflow-hidden shadow-2xl border border-gray-200 dark:border-white/10 bg-white dark:bg-[#18181a]">
        <!-- Header -->
        <div class="px-6 py-4 border-b border-gray-100 dark:border-white/5 flex items-center justify-between">
          <div class="flex items-center space-x-2">
            <span class="w-2.5 h-2.5 rounded-full bg-emerald-500"></span>
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

          <!-- Ticker Search & Autocomplete -->
          <div id="tickerRow" class="relative">
            <label for="txTicker" class="block text-xs font-semibold uppercase tracking-wider text-gray-600 dark:text-gray-300">
              Ticker o ISIN <span id="tickerRequiredStar">*</span>
            </label>
            <div class="mt-1 relative">
              <input type="text" id="txTicker" name="assetTicker" autocomplete="off"
                placeholder="Cerca es. CSPX.MI, AAPL, IT0005518524..."
                class="block w-full px-3 py-2 rounded-xl border border-gray-300 dark:border-white/10 bg-gray-50/50 dark:bg-[#141416] text-gray-900 dark:text-white text-xs font-mono uppercase focus:ring-2 focus:ring-emerald-500 focus:outline-none">
              <span id="tickerSearchSpinner" class="hidden absolute right-3 top-2.5 animate-spin w-4 h-4 border-2 border-emerald-500 border-t-transparent rounded-full"></span>
            </div>

            <!-- Autocomplete Results Dropdown -->
            <div id="tickerDropdown" class="hidden absolute left-0 right-0 top-full mt-1 max-h-48 overflow-y-auto bg-white dark:bg-[#1a1a1c] border border-gray-200 dark:border-white/10 rounded-xl shadow-xl z-50 divide-y divide-gray-100 dark:divide-white/5">
            </div>
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
                Quantità Quote
              </label>
              <input type="number" step="any" min="0" id="txQuantity" name="quantity" placeholder="0.00"
                class="mt-1 block w-full px-3 py-2 rounded-xl border border-gray-300 dark:border-white/10 bg-gray-50/50 dark:bg-[#141416] text-gray-900 dark:text-white text-xs font-mono tabular-nums focus:ring-2 focus:ring-emerald-500 focus:outline-none">
            </div>
          </div>

          <!-- Price & Currency / FX -->
          <div class="grid grid-cols-1 sm:grid-cols-3 gap-3" id="priceRow">
            <div class="sm:col-span-1">
              <label for="txPrice" class="block text-xs font-semibold uppercase tracking-wider text-gray-600 dark:text-gray-300">
                Prezzo Unitario
              </label>
              <input type="number" step="any" min="0" id="txPrice" name="price" placeholder="0.00"
                class="mt-1 block w-full px-3 py-2 rounded-xl border border-gray-300 dark:border-white/10 bg-gray-50/50 dark:bg-[#141416] text-gray-900 dark:text-white text-xs font-mono tabular-nums focus:ring-2 focus:ring-emerald-500 focus:outline-none">
            </div>

            <div>
              <label for="txCurrency" class="block text-xs font-semibold uppercase tracking-wider text-gray-600 dark:text-gray-300">
                Valuta
              </label>
              <select id="txCurrency"
                class="mt-1 block w-full px-3 py-2 rounded-xl border border-gray-300 dark:border-white/10 bg-gray-50/50 dark:bg-[#141416] text-gray-900 dark:text-white text-xs font-mono focus:ring-2 focus:ring-emerald-500 focus:outline-none">
                <option value="EUR">EUR (€)</option>
                <option value="USD">USD ($)</option>
                <option value="GBP">GBP (£)</option>
                <option value="CHF">CHF</option>
              </select>
            </div>

            <div>
              <label for="txFxRate" class="block text-xs font-semibold uppercase tracking-wider text-gray-600 dark:text-gray-300">
                Cambio FX
              </label>
              <input type="number" step="any" min="0" id="txFxRate" name="exchangeRate" value="1.0"
                class="mt-1 block w-full px-3 py-2 rounded-xl border border-gray-300 dark:border-white/10 bg-gray-50/50 dark:bg-[#141416] text-gray-900 dark:text-white text-xs font-mono tabular-nums focus:ring-2 focus:ring-emerald-500 focus:outline-none">
            </div>
          </div>

          <!-- Commission & Tax -->
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-4" id="feesRow">
            <div>
              <label for="txCommission" class="block text-xs font-semibold uppercase tracking-wider text-gray-600 dark:text-gray-300">
                Commissione (€)
              </label>
              <input type="number" step="any" min="0" id="txCommission" name="commission" value="0.00"
                class="mt-1 block w-full px-3 py-2 rounded-xl border border-gray-300 dark:border-white/10 bg-gray-50/50 dark:bg-[#141416] text-gray-900 dark:text-white text-xs font-mono tabular-nums focus:ring-2 focus:ring-emerald-500 focus:outline-none">
            </div>

            <div>
              <label for="txTax" class="block text-xs font-semibold uppercase tracking-wider text-gray-600 dark:text-gray-300">
                Ritenute / Tasse (€)
              </label>
              <input type="number" step="any" min="0" id="txTax" name="tax" value="0.00"
                class="mt-1 block w-full px-3 py-2 rounded-xl border border-gray-300 dark:border-white/10 bg-gray-50/50 dark:bg-[#141416] text-gray-900 dark:text-white text-xs font-mono tabular-nums focus:ring-2 focus:ring-emerald-500 focus:outline-none">
            </div>
          </div>

          <!-- Direct Amount (for Cash / Dividends) -->
          <div id="directAmountRow" class="hidden">
            <label for="txAmount" class="block text-xs font-semibold uppercase tracking-wider text-gray-600 dark:text-gray-300">
              Importo Diretto (€) *
            </label>
            <input type="number" step="any" min="0" id="txAmount" name="amount" placeholder="0.00"
              class="mt-1 block w-full px-3 py-2 rounded-xl border border-gray-300 dark:border-white/10 bg-gray-50/50 dark:bg-[#141416] text-gray-900 dark:text-white text-xs font-mono tabular-nums focus:ring-2 focus:ring-emerald-500 focus:outline-none">
          </div>

          <!-- Notes -->
          <div>
            <label for="txNotes" class="block text-xs font-semibold uppercase tracking-wider text-gray-600 dark:text-gray-300">
              Note (Opzionale)
            </label>
            <input type="text" id="txNotes" name="notes" placeholder="es. PAC mensile, dividendo straordinario..."
              class="mt-1 block w-full px-3 py-2 rounded-xl border border-gray-300 dark:border-white/10 bg-gray-50/50 dark:bg-[#141416] text-gray-900 dark:text-white text-xs focus:ring-2 focus:ring-emerald-500 focus:outline-none">
          </div>

          <!-- Countervalue Preview Card -->
          <div class="signature-card p-4 bg-gray-50/60 dark:bg-white/5 border border-gray-200/60 dark:border-white/5 flex items-center justify-between">
            <span class="text-xs text-gray-500 dark:text-gray-400 font-medium">Controvalore Calcolato:</span>
            <span id="calculatedCountervalue" class="text-base font-bold font-mono tabular-nums text-emerald-600 dark:text-emerald-400">€ 0,00</span>
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

  function recalculateModalCountervalue() {
    const type = document.getElementById('txType').value;
    const qty = parseFloat(document.getElementById('txQuantity').value) || 0;
    const price = parseFloat(document.getElementById('txPrice').value) || 0;
    const comm = parseFloat(document.getElementById('txCommission').value) || 0;
    const tax = parseFloat(document.getElementById('txTax').value) || 0;
    const fx = parseFloat(document.getElementById('txFxRate').value) || 1;
    const directAmt = parseFloat(document.getElementById('txAmount').value) || 0;

    let totalEur = 0;

    if (['DEPOSIT', 'WITHDRAWAL', 'TRANSFER'].includes(type)) {
      totalEur = directAmt > 0 ? directAmt : (qty * price * fx);
    } else if (type === 'BUY') {
      totalEur = (qty * price * fx) + comm + tax;
    } else if (type === 'SELL') {
      totalEur = (qty * price * fx) - comm - tax;
    } else if (type === 'DIVIDEND' || type === 'INTEREST') {
      totalEur = directAmt > 0 ? directAmt : ((qty * price * fx) - tax);
    } else if (type === 'FEE' || type === 'TAX') {
      totalEur = directAmt > 0 ? directAmt : (comm + tax);
    }

    const fmt = '€ ' + (totalEur || 0).toLocaleString('it-IT', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    document.getElementById('calculatedCountervalue').textContent = fmt;
  }

  function handleTypeChange() {
    const type = document.getElementById('txType').value;
    const tickerRow = document.getElementById('tickerRow');
    const tickerRequiredStar = document.getElementById('tickerRequiredStar');
    const directAmountRow = document.getElementById('directAmountRow');
    const feesRow = document.getElementById('feesRow');
    const priceRow = document.getElementById('priceRow');
    const quantityCol = document.getElementById('quantityCol');

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
                  document.getElementById('txCurrency').value = qData.quote.currency;
                  if (qData.quote.currency === 'USD') {
                    // Approximate USD/EUR rate or 1.08
                    document.getElementById('txFxRate').value = 0.92;
                  } else {
                    document.getElementById('txFxRate').value = 1.0;
                  }
                }
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
          select.innerHTML = userPortfolios.map(p => `
            <option value="${p.id}">${p.name} (${p.currency} - ${p.costBasisMethod})</option>
          `).join('');
        }
      }
    } catch (err) {
      console.warn('Error loading portfolios in modal:', err);
    }
  }

  function open(options = {}) {
    if (!modalContainer) {
      modalContainer = createModalHtml();
      setupEvents();
    }

    loadUserPortfolios();

    currentEditingTxId = options.id || null;
    const titleEl = document.getElementById('txModalTitle');
    titleEl.textContent = currentEditingTxId ? 'Modifica Transazione' : 'Nuova Transazione';

    // Set default date to today
    document.getElementById('txDate').value = options.date || new Date().toISOString().split('T')[0];

    if (options.portfolioId) document.getElementById('txPortfolio').value = options.portfolioId;
    if (options.type) document.getElementById('txType').value = options.type;
    if (options.assetTicker) document.getElementById('txTicker').value = options.assetTicker;
    if (options.quantity) document.getElementById('txQuantity').value = options.quantity;
    if (options.price) document.getElementById('txPrice').value = options.price;
    if (options.commission) document.getElementById('txCommission').value = options.commission;
    if (options.tax) document.getElementById('txTax').value = options.tax;
    if (options.exchangeRate) document.getElementById('txFxRate').value = options.exchangeRate;
    if (options.amount) document.getElementById('txAmount').value = options.amount;
    if (options.notes) document.getElementById('txNotes').value = options.notes;

    handleTypeChange();
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

    document.getElementById('txType').addEventListener('change', handleTypeChange);

    // Dynamic countervalue updates
    ['txQuantity', 'txPrice', 'txCommission', 'txTax', 'txFxRate', 'txAmount'].forEach(id => {
      document.getElementById(id).addEventListener('input', recalculateModalCountervalue);
    });

    // Ticker autocomplete search debounce
    document.getElementById('txTicker').addEventListener('input', (e) => {
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

      submitBtn.disabled = true;
      submitBtn.textContent = 'Salvataggio...';

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
        } else {
          alertBox.className = 'p-3 rounded-xl text-xs font-medium font-mono bg-red-50 text-red-700 dark:bg-red-950/40 dark:text-red-300 border border-red-200 dark:border-red-800/40';
          alertBox.textContent = data.error || 'Errore nel salvataggio della transazione.';
          alertBox.classList.remove('hidden');
        }
      } catch (err) {
        alertBox.className = 'p-3 rounded-xl text-xs font-medium font-mono bg-red-50 text-red-700 dark:bg-red-950/40 dark:text-red-300 border border-red-200 dark:border-red-800/40';
        alertBox.textContent = 'Errore di connessione: ' + err.message;
        alertBox.classList.remove('hidden');
      } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Salva Movimento';
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
    close
  };
})();

