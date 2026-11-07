/**
 * FolioTrack Settings, FX, Assets & Market Data Controller
 * Manages 8 settings subsections:
 * 1. FX Currency Rates
 * 2. Assets & Market Data Sources (Yahoo, Borsa Italiana, Google, Manual) + 5Y History
 * 3. Taxonomy Classifications (GICS, Asset Classes, Regions)
 * 4. Market Data Providers & 5Y History Reconstruction
 * 5. Notifications (Telegram & Web Push)
 * 6. Backups & Disaster Recovery
 * 7. AI & API Keys
 * 8. Visual Appearance
 */

let currentAssetsList = [];
let editingFxPair = null;
let editingAssetTicker = null;
let assetDebounceTimer = null;

document.addEventListener('DOMContentLoaded', () => {
  initTabs();
  initEventListeners();

  // Load all initial data
  loadCurrencies();
  loadAssets();
  loadSyncSchedule();
  loadClassifications();
  loadMarketStatus();
  loadTickerBannerConfig();
  loadSettings();
  initPushControls();
  loadBackups();
  loadSecurityDiagnostics();
  initSecurityModule();
});

// ==========================================
// TOAST NOTIFICATIONS
// ==========================================
function showToast(msg, isError = false) {
  const toast = document.createElement('div');
  toast.className = `fixed bottom-6 right-6 z-50 px-4 py-3 rounded-xl shadow-lg border text-xs font-mono transition-all transform duration-300 ${
    isError 
      ? 'bg-rose-50 dark:bg-rose-950/80 border-rose-500/30 text-rose-700 dark:text-rose-300' 
      : 'bg-emerald-50 dark:bg-emerald-950/80 border-emerald-500/30 text-emerald-700 dark:text-emerald-300'
  }`;
  toast.innerHTML = msg;
  document.body.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    setTimeout(() => toast.remove(), 300);
  }, 4000);
}

// ==========================================
// 0. TAB SWITCHER CONTROLLER
// ==========================================
function initTabs() {
  const tabButtons = document.querySelectorAll('[data-settings-tab]');
  const savedTab = localStorage.getItem('foliotrack_settings_tab') || 'fx';

  tabButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      const targetTab = btn.getAttribute('data-settings-tab');
      switchTab(targetTab);
    });
  });

  const mobileSelect = document.getElementById('mobileSettingsSectionSelect');
  if (mobileSelect) {
    mobileSelect.addEventListener('change', (e) => {
      switchTab(e.target.value);
    });
  }

  // Activate initial tab
  switchTab(savedTab);
}

function switchTab(tabId) {
  const tabButtons = document.querySelectorAll('[data-settings-tab]');
  const panels = document.querySelectorAll('.tab-panel');

  let found = false;
  panels.forEach(p => {
    if (p.id === `panel-${tabId}`) {
      p.classList.remove('hidden');
      found = true;
    } else {
      p.classList.add('hidden');
    }
  });

  if (!found && panels.length > 0) {
    panels[0].classList.remove('hidden');
    tabId = panels[0].id.replace('panel-', '');
  }

  tabButtons.forEach(btn => {
    const isTarget = btn.getAttribute('data-settings-tab') === tabId;
    if (isTarget) {
      btn.className = 'btn-pill shrink-0 whitespace-nowrap px-3.5 py-1.5 text-xs font-mono font-bold bg-emerald-600 text-white shadow-sm flex items-center space-x-1.5 transition';
      try {
        btn.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
      } catch {}
    } else {
      btn.className = 'btn-pill shrink-0 whitespace-nowrap px-3.5 py-1.5 text-xs font-mono font-medium text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-white/5 flex items-center space-x-1.5 transition';
    }
  });

  const mobileSelect = document.getElementById('mobileSettingsSectionSelect');
  if (mobileSelect && mobileSelect.value !== tabId) {
    mobileSelect.value = tabId;
  }

  localStorage.setItem('foliotrack_settings_tab', tabId);

  // Lazy refresh if tab switched
  if (tabId === 'fx') loadCurrencies();
  if (tabId === 'assets') {
    loadAssets();
    loadSyncSchedule();
  }
  if (tabId === 'classifications') loadClassifications();
  if (tabId === 'market') loadMarketStatus();
  if (tabId === 'security') loadSecurityDiagnostics();
}

// ==========================================
// EVENT LISTENERS INITIALIZATION
// ==========================================
function initEventListeners() {
  // FX buttons
  document.getElementById('btn-sync-fx')?.addEventListener('click', handleSyncFx);
  document.getElementById('btn-add-fx')?.addEventListener('click', openAddFxModal);
  document.getElementById('closeFxModalBtn')?.addEventListener('click', closeFxModal);
  document.getElementById('cancelFxModalBtn')?.addEventListener('click', closeFxModal);
  document.getElementById('fxForm')?.addEventListener('submit', handleSaveFxPair);

  // Assets buttons & filters
  document.getElementById('btn-sync-all-quotes')?.addEventListener('click', handleSyncAllQuotes);
  document.getElementById('btn-sync-all-history')?.addEventListener('click', handleSyncAllHistory);
  document.getElementById('btn-add-asset')?.addEventListener('click', openAddAssetModal);
  document.getElementById('closeAssetModalBtn')?.addEventListener('click', closeAssetModal);
  document.getElementById('cancelAssetModalBtn')?.addEventListener('click', closeAssetModal);
  document.getElementById('assetForm')?.addEventListener('submit', handleSaveAsset);

  document.getElementById('assetSearchInput')?.addEventListener('input', () => {
    clearTimeout(assetDebounceTimer);
    assetDebounceTimer = setTimeout(loadAssets, 250);
  });
  document.getElementById('assetTypeFilter')?.addEventListener('change', loadAssets);
  document.getElementById('assetSourceFilter')?.addEventListener('change', loadAssets);

  // Assets table event delegation
  const assetsTableBody = document.getElementById('assets-table-body');
  if (assetsTableBody) {
    assetsTableBody.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-action]');
      if (!btn) return;
      const action = btn.dataset.action;
      const ticker = btn.dataset.ticker;
      if (!ticker) return;

      if (action === 'sync-quote') syncSingleQuote(ticker);
      else if (action === 'sync-history') syncSingleHistory(ticker);
      else if (action === 'view-history') openQuotesHistoryModal(ticker);
      else if (action === 'edit-asset') openEditAssetModal(ticker);
      else if (action === 'delete-asset') handleDeleteAsset(ticker);
    });

    assetsTableBody.addEventListener('change', (e) => {
      const sel = e.target.closest('select[data-action="change-source"]');
      if (!sel) return;
      const ticker = sel.dataset.ticker;
      if (ticker) handleAssetSourceChange(ticker, sel.value);
    });
  }

  // FX table event delegation
  const fxTableBody = document.getElementById('fx-table-body');
  if (fxTableBody) {
    fxTableBody.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-action]');
      if (!btn) return;
      const action = btn.dataset.action;
      const pair = btn.dataset.pair;
      const rate = parseFloat(btn.dataset.rate) || 0;
      if (!pair) return;

      if (action === 'edit-fx') openEditFxModal(pair, rate);
      else if (action === 'delete-fx') handleDeleteFx(pair);
    });
  }

  // Backups table event delegation
  const backupsTableBody = document.getElementById('backups-table-body');
  if (backupsTableBody) {
    backupsTableBody.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-action]');
      if (!btn) return;
      const action = btn.dataset.action;
      const filename = btn.dataset.filename;
      if (!filename) return;

      if (action === 'delete-backup') deleteBackupItem(filename);
    });
  }

  // Taxonomy table event delegation
  const taxBody = document.getElementById('taxonomy-table-body');
  if (taxBody) {
    taxBody.addEventListener('change', (e) => {
      const sel = e.target.closest('select[data-tax-ticker]');
      if (!sel) return;
      const ticker = sel.dataset.taxTicker;
      if (ticker) saveTaxonomy(ticker);
    });
  }

  // Market & 5Y buttons
  document.getElementById('btn-reconstruct-history')?.addEventListener('click', handleReconstructHistory);
  document.getElementById('btn-clear-market-cache')?.addEventListener('click', handleClearMarketCache);

  // Market Providers delegation & modal buttons
  document.getElementById('market-providers-container')?.addEventListener('click', (e) => {
    const btn = e.target.closest('.btn-configure-provider');
    if (btn && btn.dataset.providerId) {
      openProviderConfigModal(btn.dataset.providerId);
    }
  });
  document.getElementById('btnSaveProviderConfig')?.addEventListener('click', handleSaveProviderConfig);
  document.getElementById('btnRunQuoteTest')?.addEventListener('click', handleRunQuoteTest);
  document.getElementById('btnRunHistoryTest')?.addEventListener('click', handleRunHistoryTest);
  document.getElementById('closeProviderModalBtn')?.addEventListener('click', closeProviderConfigModal);
  document.getElementById('closeProviderModalBtn2')?.addEventListener('click', closeProviderConfigModal);

  // Realtime Sync Frequency button
  document.getElementById('btn-save-sync-freq')?.addEventListener('click', handleSaveSyncFrequency);

  // Ticker Banner Configuration listeners
  document.getElementById('btn-save-ticker-config')?.addEventListener('click', handleSaveTickerConfig);
  document.getElementById('btn-reset-ticker-config')?.addEventListener('click', handleResetTickerConfig);
  document.getElementById('btn-force-refresh-ticker')?.addEventListener('click', handleForceRefreshTicker);
  document.getElementById('btn-add-custom-ticker')?.addEventListener('click', handleAddCustomTicker);

  // Quick frequency buttons
  document.querySelectorAll('.btn-freq-quick').forEach(btn => {
    btn.addEventListener('click', () => {
      const val = btn.dataset.freq;
      const inp = document.getElementById('tickerRefreshSecondsInput');
      if (inp && val) inp.value = val;
    });
  });

  // Delegation on ticker table (toggle checkbox, delete button)
  const tickerTbody = document.getElementById('ticker-indices-tbody');
  if (tickerTbody) {
    tickerTbody.addEventListener('click', (e) => {
      const delBtn = e.target.closest('.btn-delete-ticker');
      if (delBtn) {
        const idx = parseInt(delBtn.dataset.idx, 10);
        if (!isNaN(idx) && currentTickerConfig.indices[idx]) {
          currentTickerConfig.indices.splice(idx, 1);
          renderTickerSettingsUI();
        }
        return;
      }
    });

    tickerTbody.addEventListener('change', (e) => {
      const cb = e.target.closest('.ticker-enable-checkbox');
      if (cb) {
        const idx = parseInt(cb.dataset.idx, 10);
        if (!isNaN(idx) && currentTickerConfig.indices[idx]) {
          currentTickerConfig.indices[idx].enabled = cb.checked;
        }
      }
    });
  }

  // Preset pills click
  const presetsContainer = document.getElementById('ticker-presets-pills');
  if (presetsContainer) {
    presetsContainer.addEventListener('click', (e) => {
      const btn = e.target.closest('.btn-preset-ticker');
      if (!btn) return;
      const symbol = btn.dataset.symbol;
      const name = btn.dataset.name;
      const currency = btn.dataset.currency;
      const isYield = btn.dataset.yield === 'true';

      const existingIdx = currentTickerConfig.indices.findIndex(i => i.symbol === symbol);
      if (existingIdx >= 0) {
        // Toggle enabled state
        currentTickerConfig.indices[existingIdx].enabled = !currentTickerConfig.indices[existingIdx].enabled;
      } else {
        currentTickerConfig.indices.push({
          symbol,
          name,
          currency,
          isYield,
          enabled: true
        });
      }
      renderTickerSettingsUI();
    });
  }

  // Quotes History Modal
  document.getElementById('closeQuotesHistoryModalBtn')?.addEventListener('click', closeQuotesHistoryModal);
  document.getElementById('cancelQuotesHistoryModalBtn')?.addEventListener('click', closeQuotesHistoryModal);
  document.getElementById('btn-force-sync-history')?.addEventListener('click', async () => {
    if (!currentHistoryTicker) return;
    const btn = document.getElementById('btn-force-sync-history');
    if (btn) btn.disabled = true;
    try {
      await syncSingleHistory(currentHistoryTicker);
      await openQuotesHistoryModal(currentHistoryTicker);
    } finally {
      if (btn) btn.disabled = false;
    }
  });

  // Notifications & Backups
  document.getElementById('settings-form')?.addEventListener('submit', handleSaveSettings);
  document.getElementById('btn-save-settings-ai')?.addEventListener('click', handleSaveSettings);
  document.getElementById('btn-telegram-test')?.addEventListener('click', handleTelegramTest);
  document.getElementById('btn-telegram-digest')?.addEventListener('click', handleTelegramDigest);
  document.getElementById('btn-check-alerts')?.addEventListener('click', handleCheckAlerts);
  document.getElementById('btn-create-backup')?.addEventListener('click', handleCreateBackup);
  document.getElementById('btn-reset-financial-db')?.addEventListener('click', handleResetFinancialDatabase);
  document.getElementById('btn-reset-financial-db-mobile')?.addEventListener('click', handleResetFinancialDatabase);
}

// ==========================================
// 1. CAMBIO VALUTA FX CONTROLLER
// ==========================================
async function loadCurrencies() {
  const tableBody = document.getElementById('fx-table-body');
  const cardsGrid = document.getElementById('fx-cards-grid');

  try {
    const res = await fetch('/api/currencies');
    const data = await res.json();
    if (!data.success) return;

    const rates = data.rates || [];

    // Render KPI Cards (for top 4 pairs EUR/USD, EUR/GBP, EUR/CHF, EUR/JPY)
    if (cardsGrid) {
      const topPairs = ['EUR/USD', 'EUR/GBP', 'EUR/CHF', 'EUR/JPY'];
      const topData = topPairs.map(p => rates.find(r => r.pair === p) || { pair: p, rate: 0, source: 'N/D' });
      cardsGrid.innerHTML = topData.map(item => `
        <div class="signature-card p-4 space-y-1">
          <div class="flex items-center justify-between">
            <span class="text-xs font-mono font-bold text-gray-500">${item.pair}</span>
            <span class="text-[10px] font-mono px-1.5 py-0.5 rounded bg-gray-100 dark:bg-white/10 text-gray-600 dark:text-gray-300">${item.source || 'YAHOO'}</span>
          </div>
          <div class="text-xl font-bold font-mono tabular-nums text-gray-900 dark:text-white">
            ${item.rate ? item.rate.toFixed(4) : '-'}
          </div>
          <span class="text-[10px] text-gray-400 font-mono block">1 EUR = ${item.rate ? item.rate.toFixed(4) : '-'} ${item.pair.split('/')[1] || ''}</span>
        </div>
      `).join('');
    }

    // Render FX Table
    if (tableBody) {
      if (rates.length === 0) {
        tableBody.innerHTML = `
          <tr>
            <td colspan="7" class="px-4 py-8 text-center text-gray-400">Nessuna coppia valutaria presente. Clicca su "Nuova Coppia FX" o "Sincronizza".</td>
          </tr>
        `;
        return;
      }

      tableBody.innerHTML = rates.map(r => {
        const invRate = r.rate > 0 ? (1 / r.rate).toFixed(4) : '-';
        const formattedDate = r.updatedAt ? new Date(r.updatedAt).toLocaleString('it-IT') : '-';
        const isYahoo = r.source === 'YAHOO';
        return `
          <tr class="border-b border-gray-100 dark:border-white/5 hover:bg-gray-50/50 dark:hover:bg-white/[0.02]">
            <td class="px-5 py-3 font-bold text-gray-900 dark:text-white">
              <span class="px-2 py-0.5 rounded bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20">${r.pair}</span>
            </td>
            <td class="px-4 py-3 text-gray-500 font-mono text-xs">
              ${r.fromCurrency} ➔ ${r.toCurrency}
            </td>
            <td class="px-4 py-3 text-right font-bold tabular-nums text-gray-900 dark:text-white">
              ${r.rate.toFixed(4)}
            </td>
            <td class="px-4 py-3 text-right font-mono tabular-nums text-gray-500 dark:text-gray-400">
              ${invRate}
            </td>
            <td class="px-4 py-3">
              <span class="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-mono ${
                isYahoo 
                  ? 'bg-blue-500/10 text-blue-600 dark:text-blue-400 border border-blue-500/20' 
                  : 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/20'
              }">
                ${r.source}
              </span>
            </td>
            <td class="px-4 py-3 text-gray-400 font-mono text-[11px]">
              ${formattedDate}
            </td>
            <td class="px-4 py-3 text-right space-x-1">
              <button type="button" data-action="edit-fx" data-pair="${r.pair}" data-rate="${r.rate}" class="btn-pill px-2.5 py-1 text-xs border border-gray-300 dark:border-white/10 hover:bg-gray-100 dark:hover:bg-white/5" title="Modifica Tasso FX">
                ✏️
              </button>
              <button type="button" data-action="delete-fx" data-pair="${r.pair}" class="btn-pill px-2.5 py-1 text-xs border border-rose-500/30 text-rose-600 hover:bg-rose-500/10" title="Elimina Coppia FX">
                🗑️
              </button>
            </td>
          </tr>
        `;
      }).join('');
    }
  } catch (err) {
    console.error('Errore caricamento cambi valuta FX:', err);
  }
}

async function handleSyncFx() {
  const btn = document.getElementById('btn-sync-fx');
  if (btn) btn.disabled = true;

  try {
    const res = await fetch('/api/currencies/sync', { method: 'POST' });
    const data = await res.json();
    if (data.success) {
      showToast(`✓ Sincronizzazione FX completata: ${data.updated} tassi aggiornati.`);
      loadCurrencies();
    } else {
      showToast(data.error || 'Errore sincronizzazione tassi FX', true);
    }
  } catch (err) {
    showToast('Errore di connessione durante la sincronizzazione FX', true);
  } finally {
    if (btn) btn.disabled = false;
  }
}

function openAddFxModal() {
  editingFxPair = null;
  document.getElementById('fxModalTitle').textContent = 'Nuova Coppia FX';
  document.getElementById('modalFxFrom').value = '';
  document.getElementById('modalFxFrom').disabled = false;
  document.getElementById('modalFxTo').value = '';
  document.getElementById('modalFxTo').disabled = false;
  document.getElementById('modalFxRate').value = '';
  document.getElementById('fxModal').classList.remove('hidden');
}

function openEditFxModal(pair, currentRate) {
  editingFxPair = pair;
  const parts = pair.split('/');
  document.getElementById('fxModalTitle').textContent = `Modifica Tasso ${pair}`;
  document.getElementById('modalFxFrom').value = parts[0] || '';
  document.getElementById('modalFxFrom').disabled = true;
  document.getElementById('modalFxTo').value = parts[1] || '';
  document.getElementById('modalFxTo').disabled = true;
  document.getElementById('modalFxRate').value = currentRate;
  document.getElementById('fxModal').classList.remove('hidden');
}

function closeFxModal() {
  document.getElementById('fxModal')?.classList.add('hidden');
}

async function handleSaveFxPair(e) {
  e.preventDefault();
  const from = document.getElementById('modalFxFrom').value.trim().toUpperCase();
  const to = document.getElementById('modalFxTo').value.trim().toUpperCase();
  const rate = parseFloat(document.getElementById('modalFxRate').value);

  if (!from || !to || isNaN(rate) || rate <= 0) {
    showToast('Inserisci valori validi per la coppia e il tasso di cambio', true);
    return;
  }

  try {
    let res;
    if (editingFxPair) {
      res = await fetch(`/api/currencies/${encodeURIComponent(editingFxPair)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rate, source: 'MANUAL' })
      });
    } else {
      res = await fetch('/api/currencies', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ from, to, rate, source: 'MANUAL' })
      });
    }

    const data = await res.json();
    if (data.success) {
      showToast(`✓ Tasso FX ${from}/${to} salvato con successo!`);
      closeFxModal();
      loadCurrencies();
    } else {
      showToast(data.error || 'Errore salvataggio coppia FX', true);
    }
  } catch (err) {
    showToast('Errore durante il salvataggio della coppia FX', true);
  }
}

async function handleDeleteFx(pair) {
  if (!confirm(`Sei sicuro di voler eliminare il tasso FX ${pair}?`)) return;

  try {
    const res = await fetch(`/api/currencies/${encodeURIComponent(pair)}`, { method: 'DELETE' });
    const data = await res.json();
    if (data.success) {
      showToast(`✓ Coppia ${pair} eliminata.`);
      loadCurrencies();
    } else {
      showToast(data.error || 'Errore eliminazione coppia FX', true);
    }
  } catch (err) {
    showToast('Errore durante l\'eliminazione della coppia FX', true);
  }
}

window.openEditFxModal = openEditFxModal;
window.handleDeleteFx = handleDeleteFx;

// ==========================================
// 2. TITOLI, FONTI DATI & STORICO 5Y
// ==========================================
function formatCompactSyncTime(syncDateStr) {
  if (!syncDateStr) return null;
  const dateObj = (syncDateStr.includes('T') || syncDateStr.endsWith('Z'))
    ? new Date(syncDateStr)
    : new Date(syncDateStr.replace(' ', 'T') + 'Z');

  if (isNaN(dateObj.getTime())) return null;

  const now = new Date();
  const isToday = (
    dateObj.getDate() === now.getDate() &&
    dateObj.getMonth() === now.getMonth() &&
    dateObj.getFullYear() === now.getFullYear()
  );

  const hours = String(dateObj.getHours()).padStart(2, '0');
  const minutes = String(dateObj.getMinutes()).padStart(2, '0');
  const timePart = `${hours}:${minutes}`;

  if (isToday) {
    return {
      compact: timePart,
      full: dateObj.toLocaleString('it-IT')
    };
  } else {
    const day = String(dateObj.getDate()).padStart(2, '0');
    const month = String(dateObj.getMonth() + 1).padStart(2, '0');
    return {
      compact: `${day}/${month} ${timePart}`,
      full: dateObj.toLocaleString('it-IT')
    };
  }
}

async function loadAssets() {
  const tableBody = document.getElementById('assets-table-body');
  if (!tableBody) return;

  const query = document.getElementById('assetSearchInput')?.value.trim() || '';
  const type = document.getElementById('assetTypeFilter')?.value || '';
  const source = document.getElementById('assetSourceFilter')?.value || '';

  const params = new URLSearchParams();
  if (query) params.append('query', query);
  if (type) params.append('type', type);
  if (source) params.append('dataSource', source);

  try {
    const res = await fetch(`/api/assets?${params.toString()}`);
    const data = await res.json();
    if (!data.success) return;

    currentAssetsList = data.assets || [];

    if (currentAssetsList.length === 0) {
      tableBody.innerHTML = `
        <tr>
          <td colspan="7" class="px-4 py-10 text-center text-gray-400 font-mono">
            Nessun titolo trovato con i filtri correnti.
          </td>
        </tr>
      `;
      return;
    }

    tableBody.innerHTML = currentAssetsList.map(a => {
      const formattedPrice = a.currentPrice 
        ? `${a.currency === 'USD' ? '$' : a.currency === 'GBP' ? '£' : '€'} ${Number(a.currentPrice).toFixed(2)}`
        : '-';

      const quotesCount = a.quotesCount || 0;
      let quotesBadgeClass = 'bg-gray-100 text-gray-600 dark:bg-white/10 dark:text-gray-400';
      if (quotesCount > 100) quotesBadgeClass = 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20';
      else if (quotesCount > 0) quotesBadgeClass = 'bg-blue-500/10 text-blue-600 dark:text-blue-400 border border-blue-500/20';

      const quotesTitle = quotesCount > 0 
        ? `Dal ${a.oldestQuote || '-'} al ${a.newestQuote || '-'}`
        : 'Nessun prezzo storico 5Y scaricato';

      const sourceVal = a.dataSource || 'YAHOO';
      const isDelisted = sourceVal === 'DELISTED';
      const isManual = sourceVal === 'MANUAL';
      const isCustomManaged = isDelisted || isManual;

      // Check sync errors (suppressed for DELISTED and MANUAL assets)
      const isRealtimeError = !isCustomManaged && a.lastSyncStatus === 'ERROR';
      const isHistoricalError = !isCustomManaged && a.historicalSyncStatus === 'ERROR';

      // Live Tag state & compact time formatting
      const syncTimeInfo = (!isRealtimeError && a.lastSyncAt) ? formatCompactSyncTime(a.lastSyncAt) : null;

      let liveBtnLabel = '⚡ Live';
      let liveBtnClass = 'bg-blue-600/10 text-blue-600 dark:text-blue-400 border border-blue-500/20 hover:bg-blue-600/20';
      let liveBtnTitle = 'Scarica Prezzo Realtime - Clicca per aggiornare';

      if (isRealtimeError) {
        liveBtnLabel = '⚡ Errore';
        liveBtnClass = 'bg-rose-600 text-white font-semibold border border-rose-700 hover:bg-rose-700 shadow-2xs cursor-pointer';
        liveBtnTitle = `${a.lastSyncError || 'Errore durante la lettura della quotazione'}\nClicca per riprovare l'aggiornamento`;
      } else if (isDelisted) {
        liveBtnLabel = '⚡ Delisted';
        liveBtnClass = 'bg-purple-500/10 text-purple-600 dark:text-purple-400 border border-purple-500/20 hover:bg-purple-500/20';
        liveBtnTitle = 'Titolo Delistato (aggiornamenti live disattivati) - Clicca per sincronizzare manualmente';
      } else if (isManual) {
        liveBtnLabel = '⚡ Manuale';
        liveBtnClass = 'bg-gray-500/10 text-gray-600 dark:text-gray-400 border border-gray-500/20 hover:bg-gray-500/20';
        liveBtnTitle = 'Prezzo Manuale (aggiornamenti automatici disattivati) - Clicca per sincronizzare';
      } else if (syncTimeInfo) {
        liveBtnLabel = `⚡ ${syncTimeInfo.compact}`;
        liveBtnClass = 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/25 hover:bg-emerald-500/20 font-mono';
        liveBtnTitle = `Ultimo aggiornamento riuscito: ${syncTimeInfo.full}\nClicca per forzare aggiornamento live`;
      }

      const alertBadgeHtml = isHistoricalError
        ? `<span class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-bold bg-amber-500/15 text-amber-600 dark:text-amber-400 border border-amber-500/30 ml-2 shadow-2xs cursor-help" title="Errore download serie storica 5Y: ${escapeHtml(a.historicalSyncError || 'Fallito')}">
            <span>⚠️</span>
            <span>Errore 5Y</span>
          </span>`
        : '';

      const customBadgeHtml = isDelisted
        ? `<span class="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-mono font-bold bg-purple-500/15 text-purple-600 dark:text-purple-400 border border-purple-500/30 ml-2 shadow-2xs" title="Titolo Delistato: storico e movimenti mantenuti, aggiornamento disattivato">
            DELISTED
          </span>`
        : (isManual ? `<span class="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-mono font-bold bg-gray-500/15 text-gray-600 dark:text-gray-400 border border-gray-500/30 ml-2 shadow-2xs" title="Gestione Manuale: nessun aggiornamento automatico da provider">
            MANUALE
          </span>` : '');

      return `
        <tr class="border-b border-gray-100 dark:border-white/5 hover:bg-gray-50/50 dark:hover:bg-white/[0.02]">
          <td class="px-4 py-2.5 max-w-[260px]">
            <div class="flex items-center gap-1.5 flex-wrap mb-0.5">
              <span class="font-mono text-xs font-bold px-1.5 py-0.5 rounded bg-black/5 dark:bg-white/5 border border-gray-200 dark:border-white/10 text-gray-900 dark:text-white">
                ${a.ticker}
              </span>
              ${customBadgeHtml}
              ${alertBadgeHtml}
            </div>
            <div class="text-[11px] text-gray-500 dark:text-gray-400 truncate leading-tight" title="${escapeHtml(a.name)}">
              ${escapeHtml(a.name)}
            </div>
          </td>
          <td class="px-3 py-2.5 text-xs text-gray-500">
            <span class="px-2 py-0.5 rounded text-[10px] font-mono bg-gray-100 dark:bg-white/10">
              ${a.type || 'EQUITY'}
            </span>
          </td>
          <td class="px-3 py-2.5 text-xs text-gray-400 font-mono">
            ${a.currency || 'EUR'} ${a.exchange ? '• ' + a.exchange : ''}
          </td>
          <td class="px-3 py-2.5">
            <select data-action="change-source" data-ticker="${a.ticker}" onchange="handleAssetSourceChange('${a.ticker}', this.value)" 
              class="px-2 py-1 rounded-lg text-xs font-mono font-semibold border ${
                sourceVal === 'YAHOO' ? 'border-blue-500/30 text-blue-600 bg-blue-500/5 dark:text-blue-400' :
                sourceVal === 'BORSA_ITALIANA' ? 'border-emerald-500/30 text-emerald-600 bg-emerald-500/5 dark:text-emerald-400' :
                sourceVal === 'GOOGLE' ? 'border-amber-500/30 text-amber-600 bg-amber-500/5 dark:text-amber-400' :
                sourceVal === 'DELISTED' ? 'border-purple-500/30 text-purple-600 bg-purple-500/5 dark:text-purple-400' :
                'border-gray-500/30 text-gray-600 bg-gray-500/5 dark:text-gray-400'
              }">
              <option value="YAHOO" ${sourceVal === 'YAHOO' ? 'selected' : ''}>Yahoo</option>
              <option value="BORSA_ITALIANA" ${sourceVal === 'BORSA_ITALIANA' ? 'selected' : ''}>Borsa IT</option>
              <option value="GOOGLE" ${sourceVal === 'GOOGLE' ? 'selected' : ''}>Google</option>
              <option value="MANUAL" ${sourceVal === 'MANUAL' ? 'selected' : ''}>Manuale</option>
              <option value="DELISTED" ${sourceVal === 'DELISTED' ? 'selected' : ''}>Delisted</option>
            </select>
          </td>
          <td class="px-4 py-2.5 text-right font-mono font-bold tabular-nums text-gray-900 dark:text-white">
            ${formattedPrice}
          </td>
          <td class="px-4 py-2.5 text-center">
            <button type="button" data-action="view-history" data-ticker="${a.ticker}" 
              class="inline-flex items-center space-x-1 px-2.5 py-1 rounded-lg text-[10px] font-mono ${quotesBadgeClass} hover:ring-2 hover:ring-blue-500/40 transition cursor-pointer" 
              title="${quotesTitle} - Clicca per visualizzare grafico e quote scaricate">
              <span>📊</span>
              <span>${quotesCount} quote</span>
            </button>
          </td>
          <td class="px-4 py-2.5 text-right space-x-1 whitespace-nowrap">
            <button type="button" data-action="sync-quote" data-ticker="${a.ticker}" class="btn-pill px-2 py-1 text-xs ${liveBtnClass}" title="${escapeHtml(liveBtnTitle)}">
              ${liveBtnLabel}
            </button>
            <button type="button" data-action="view-history" data-ticker="${a.ticker}" class="btn-pill px-2 py-1 text-xs bg-indigo-600/10 text-indigo-600 dark:text-indigo-400 border border-indigo-500/20 hover:bg-indigo-600/20" title="Consulta Storico Quotazioni Scaricate">
              📊 Storico
            </button>
            <button type="button" data-action="sync-history" data-ticker="${a.ticker}" class="btn-pill px-2 py-1 text-xs bg-emerald-600/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20 hover:bg-emerald-600/20" title="Scarica Serie Storica 5Y">
              📥 5Y
            </button>
            <button type="button" data-action="edit-asset" data-ticker="${a.ticker}" class="btn-pill px-2 py-1 text-xs border border-gray-300 dark:border-white/10 hover:bg-gray-100 dark:hover:bg-white/5" title="Modifica Titolo">
              ✏️
            </button>
            <button type="button" data-action="delete-asset" data-ticker="${a.ticker}" class="btn-pill px-2 py-1 text-xs border border-rose-500/30 text-rose-600 hover:bg-rose-500/10" title="Elimina Titolo">
              🗑️
            </button>
          </td>
        </tr>
      `;
    }).join('');
  } catch (err) {
    console.error('Errore caricamento lista asset:', err);
  }
}

async function handleAssetSourceChange(ticker, newSource) {
  try {
    const res = await fetch(`/api/assets/${encodeURIComponent(ticker)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dataSource: newSource })
    });
    const data = await res.json();
    if (data.success) {
      showToast(`✓ Fonte dati per ${ticker} impostata su ${newSource}`);
      loadAssets();
    } else {
      showToast(data.error || 'Errore modifica fonte dati', true);
    }
  } catch (err) {
    showToast('Errore di connessione', true);
  }
}

async function syncSingleQuote(ticker) {
  const btn = document.querySelector(`button[data-action="sync-quote"][data-ticker="${ticker}"]`);
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '⚡ ...';
  }

  try {
    showToast(`⚡ Aggiornamento prezzo live per ${ticker}...`);
    const res = await fetch(`/api/assets/${encodeURIComponent(ticker)}/sync-quote`, { method: 'POST' });
    const data = await res.json();
    if (data.success) {
      const p = data.quote?.currentPrice || data.quote?.price || data.asset?.currentPrice;
      const priceStr = (p !== undefined && p !== null) ? Number(p).toFixed(2) : '-';
      showToast(`✓ Prezzo aggiornato per ${ticker}: ${priceStr}`);
    } else {
      showToast(data.error || `Errore scaricamento prezzo per ${ticker}`, true);
    }
  } catch (err) {
    showToast(`Errore connessione per ${ticker}`, true);
  } finally {
    await loadAssets();
  }
}

async function syncSingleHistory(ticker) {
  try {
    showToast(`📥 Scaricamento storico 5Y per ${ticker}...`);
    const res = await fetch(`/api/assets/${encodeURIComponent(ticker)}/sync-history`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ period: '5y' })
    });
    const data = await res.json();
    if (data.success) {
      const ptCount = data.count !== undefined ? data.count : (data.points !== undefined ? data.points : 0);
      showToast(`✓ Storico 5Y scaricato per ${ticker}: ${ptCount} punti.`);
      loadAssets();
      loadMarketStatus();
    } else {
      showToast(data.error || `Errore download storico per ${ticker}`, true);
    }
  } catch (err) {
    showToast(`Errore durante il download storico per ${ticker}`, true);
  }
}

async function handleSyncAllQuotes() {
  const btn = document.getElementById('btn-sync-all-quotes');
  if (btn) btn.disabled = true;

  try {
    showToast('⚡ Aggiornamento prezzi realtime per tutti i titoli in corso...');
    const res = await fetch('/api/market/update-all', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ delayMs: 150 })
    });
    const data = await res.json();
    if (data.success) {
      showToast(`✓ ${data.message}`);
      loadAssets();
    } else {
      showToast(data.error || 'Errore aggiornamento generale prezzi', true);
    }
  } catch (err) {
    showToast('Errore connessione durante l\'aggiornamento prezzi', true);
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function handleSyncAllHistory() {
  const btn = document.getElementById('btn-sync-all-history');
  if (btn) btn.disabled = true;

  try {
    showToast('📥 Download storico 5Y avviato per tutti i titoli... Attendere.');
    const res = await fetch('/api/assets/sync-all-history', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ delayMs: 200 })
    });
    const data = await res.json();
    if (data.success) {
      showToast(`✓ ${data.message}`);
      loadAssets();
      loadMarketStatus();
    } else {
      showToast(data.error || 'Errore download storico 5Y per tutti', true);
    }
  } catch (err) {
    showToast('Errore di connessione durante il download dello storico', true);
  } finally {
    if (btn) btn.disabled = false;
  }
}

// Helper for safe HTML escaping
function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ==========================================
// REALTIME SYNC SCHEDULE CONTROLLER
// ==========================================
async function loadSyncSchedule() {
  try {
    const res = await fetch('/api/market/schedule');
    const data = await res.json();
    if (!data.success) return;

    const freqInput = document.getElementById('syncFrequencyInput');
    if (freqInput && data.frequencyMinutes) {
      freqInput.value = data.frequencyMinutes;
    }

    const statusEl = document.getElementById('syncScheduleStatusText');
    if (statusEl) {
      const lastStr = data.lastSyncAt ? new Date(data.lastSyncAt).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' }) : 'N/D';
      const nextStr = data.nextSyncAt ? new Date(data.nextSyncAt).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' }) : 'in attesa';
      statusEl.textContent = `Frequenza attiva: ogni ${data.frequencyMinutes} min • Ultimo run: ${lastStr} • Prossimo: ${nextStr}`;
    }
  } catch (err) {
    console.warn('Errore recupero schedulazione quotazioni:', err);
  }
}

async function handleSaveSyncFrequency() {
  const input = document.getElementById('syncFrequencyInput');
  if (!input) return;

  const minutes = parseInt(input.value, 10);
  if (!minutes || isNaN(minutes) || minutes < 1) {
    showToast('Inserisci un valore valido in minuti (minimo 1)', true);
    return;
  }

  try {
    const res = await fetch('/api/market/schedule', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ frequencyMinutes: minutes })
    });
    const data = await res.json();
    if (data.success) {
      showToast(`✓ Frequenza aggiornamento realtime impostata a ${minutes} min!`);
      loadSyncSchedule();
    } else {
      showToast(data.error || 'Errore salvataggio frequenza', true);
    }
  } catch (err) {
    showToast('Errore di connessione', true);
  }
}

// ==========================================
// MODAL STORICO QUOTAZIONI (ASSET_QUOTES)
// ==========================================
let quotesChartInstance = null;
let currentHistoryTicker = null;

async function openQuotesHistoryModal(ticker) {
  currentHistoryTicker = ticker;
  const modal = document.getElementById('quotesHistoryModal');
  if (!modal) return;

  modal.classList.remove('hidden');

  // Reset modal elements
  document.getElementById('quotesHistoryModalTitle').textContent = `Storico Quotazioni - ${ticker}`;
  document.getElementById('quotesHistoryTickerBadge').textContent = ticker;
  const sourceBadge = document.getElementById('quotesHistorySourceBadge');
  sourceBadge.textContent = 'Caricamento...';
  sourceBadge.className = 'text-[10px] font-mono px-2 py-0.5 rounded bg-gray-100 text-gray-600 dark:bg-white/10 dark:text-gray-400';

  const alertBox = document.getElementById('quotesHistoryAlertBox');
  alertBox.classList.add('hidden');

  document.getElementById('qh-stat-count').textContent = '...';
  document.getElementById('qh-stat-range').textContent = '...';
  document.getElementById('qh-stat-minmax').textContent = '...';
  document.getElementById('qh-stat-latest').textContent = '...';

  const tableBody = document.getElementById('quotesHistoryTableBody');
  tableBody.innerHTML = `
    <tr>
      <td colspan="5" class="px-4 py-8 text-center text-gray-400 font-mono">
        Caricamento dati storici dal database locale...
      </td>
    </tr>
  `;

  if (quotesChartInstance) {
    quotesChartInstance.destroy();
    quotesChartInstance = null;
  }

  try {
    const res = await fetch(`/api/assets/${encodeURIComponent(ticker)}/quotes`);
    const data = await res.json();
    if (!data.success) {
      tableBody.innerHTML = `
        <tr>
          <td colspan="5" class="px-4 py-6 text-center text-rose-500 font-mono">
            ${data.error || 'Errore caricamento quote'}
          </td>
        </tr>
      `;
      return;
    }

    const asset = data.asset;
    const stats = data.stats;
    const quotes = data.quotes || [];

    // Header updates
    document.getElementById('quotesHistoryModalTitle').textContent = `Storico Quotazioni - ${asset.name || ticker}`;
    sourceBadge.textContent = asset.dataSource || 'YAHOO';
    sourceBadge.className = `text-[10px] font-mono px-2 py-0.5 rounded ${
      asset.dataSource === 'YAHOO' ? 'bg-blue-500/10 text-blue-600 dark:text-blue-400 border border-blue-500/20' :
      asset.dataSource === 'BORSA_ITALIANA' ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20' :
      asset.dataSource === 'GOOGLE' ? 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/20' :
      asset.dataSource === 'DELISTED' ? 'bg-purple-500/10 text-purple-600 dark:text-purple-400 border border-purple-500/20' :
      'bg-gray-500/10 text-gray-600 dark:text-gray-400 border border-gray-500/20'
    }`;

    // Sync Alerts
    const isRtErr = asset.lastSyncStatus === 'ERROR';
    const isHistErr = asset.historicalSyncStatus === 'ERROR';
    if (isRtErr || isHistErr) {
      alertBox.classList.remove('hidden');
      const errParts = [];
      if (isRtErr) errParts.push(`Realtime: ${asset.lastSyncError || 'Errore sincronizzazione quotazione live'}${asset.lastSyncAt ? ' (' + new Date(asset.lastSyncAt).toLocaleString('it-IT') + ')' : ''}`);
      if (isHistErr) errParts.push(`Storico: ${asset.historicalSyncError || 'Errore scaricamento serie 5Y'}${asset.historicalSyncAt ? ' (' + new Date(asset.historicalSyncAt).toLocaleString('it-IT') + ')' : ''}`);
      document.getElementById('quotesHistoryAlertTitle').textContent = 'Stato Sincronizzazione: Errore Rilevato';
      document.getElementById('quotesHistoryAlertDesc').textContent = errParts.join(' • ');
    } else {
      alertBox.classList.add('hidden');
    }

    const curr = asset.currency === 'USD' ? '$' : asset.currency === 'GBP' ? '£' : '€';

    // Stats
    document.getElementById('qh-stat-count').textContent = stats.count;
    document.getElementById('qh-stat-range').textContent = (stats.minDate && stats.maxDate) ? `${stats.minDate} ➔ ${stats.maxDate}` : 'N/D';
    document.getElementById('qh-stat-minmax').textContent = stats.count > 0 ? `${curr} ${stats.minPrice.toFixed(2)} / ${curr} ${stats.maxPrice.toFixed(2)}` : 'N/D';
    document.getElementById('qh-stat-latest').textContent = stats.latestPrice ? `${curr} ${Number(stats.latestPrice).toFixed(2)}` : '-';

    document.getElementById('qh-table-subtitle').textContent = quotes.length > 0
      ? `Visualizzati ${Math.min(quotes.length, 500)} di ${stats.count} record`
      : 'Nessun record presente';

    // Table
    if (quotes.length === 0) {
      tableBody.innerHTML = `
        <tr>
          <td colspan="5" class="px-4 py-8 text-center text-gray-400 font-mono">
            Nessuna quotazione presente in archivio per ${ticker}.<br>
            Clicca su "Forza Riscarico Storico (5Y)" per scaricare la serie completa.
          </td>
        </tr>
      `;
    } else {
      tableBody.innerHTML = quotes.slice(0, 500).map(q => {
        const downloadDate = q.updatedAt ? new Date(q.updatedAt).toLocaleDateString('it-IT') : '-';
        return `
          <tr class="hover:bg-gray-50/50 dark:hover:bg-white/[0.02] text-xs">
            <td class="px-4 py-2 font-mono font-bold text-gray-800 dark:text-gray-200">${q.date}</td>
            <td class="px-4 py-2 text-right font-mono font-bold text-gray-900 dark:text-white tabular-nums">${curr} ${Number(q.close).toFixed(2)}</td>
            <td class="px-4 py-2 text-right font-mono text-gray-500 tabular-nums">${q.volume ? Number(q.volume).toLocaleString('it-IT') : '-'}</td>
            <td class="px-4 py-2 text-[11px] font-mono"><span class="px-1.5 py-0.5 rounded bg-black/5 dark:bg-white/5 border border-gray-200 dark:border-white/10">${q.source || 'YAHOO'}</span></td>
            <td class="px-4 py-2 text-right font-mono text-[11px] text-gray-400">${downloadDate}</td>
          </tr>
        `;
      }).join('');
    }

    // Chart
    renderQuotesChart(quotes, asset.currency);

  } catch (err) {
    tableBody.innerHTML = `
      <tr>
        <td colspan="5" class="px-4 py-6 text-center text-rose-500 font-mono">
          Errore di connessione durante il recupero dei dati storici.
        </td>
      </tr>
    `;
  }
}

function closeQuotesHistoryModal() {
  const modal = document.getElementById('quotesHistoryModal');
  if (modal) modal.classList.add('hidden');
  if (quotesChartInstance) {
    quotesChartInstance.destroy();
    quotesChartInstance = null;
  }
  currentHistoryTicker = null;
}

function renderQuotesChart(quotes, currency = 'EUR') {
  const canvas = document.getElementById('quotesHistoryChart');
  if (!canvas || typeof Chart === 'undefined') return;

  if (quotesChartInstance) {
    quotesChartInstance.destroy();
    quotesChartInstance = null;
  }

  if (!quotes || quotes.length === 0) return;

  // Chronological order (oldest to newest)
  const sorted = [...quotes].sort((a, b) => a.date.localeCompare(b.date));
  const labels = sorted.map(q => q.date);
  const dataPoints = sorted.map(q => q.close);

  const isDark = document.documentElement.classList.contains('dark') || document.body.classList.contains('dark');
  const lineColor = '#10b981';
  const gridColor = isDark ? 'rgba(255, 255, 255, 0.05)' : 'rgba(0, 0, 0, 0.05)';
  const textColor = isDark ? '#9ca3af' : '#6b7280';

  const ctx = canvas.getContext('2d');
  quotesChartInstance = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [{
        label: 'Prezzo Chiusura',
        data: dataPoints,
        borderColor: lineColor,
        backgroundColor: 'rgba(16, 185, 129, 0.1)',
        fill: true,
        tension: 0.1,
        pointRadius: labels.length > 100 ? 0 : 2,
        pointHoverRadius: 5,
        borderWidth: 2
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
          callbacks: {
            label: (ctx) => ` ${ctx.parsed.y.toFixed(2)} ${currency}`
          }
        }
      },
      scales: {
        x: {
          grid: { color: gridColor },
          ticks: {
            color: textColor,
            maxTicksLimit: 8,
            font: { family: 'ui-monospace, monospace', size: 10 }
          }
        },
        y: {
          grid: { color: gridColor },
          ticks: {
            color: textColor,
            font: { family: 'ui-monospace, monospace', size: 10 },
            callback: (val) => val.toFixed(2)
          }
        }
      }
    }
  });
  window.quotesChartInstance = quotesChartInstance;
}

window.openQuotesHistoryModal = openQuotesHistoryModal;
window.closeQuotesHistoryModal = closeQuotesHistoryModal;
window.loadSyncSchedule = loadSyncSchedule;
window.handleSaveSyncFrequency = handleSaveSyncFrequency;

function openAddAssetModal() {
  editingAssetTicker = null;
  document.getElementById('assetModalTitle').textContent = 'Nuovo Titolo nel Catalogo';
  document.getElementById('modalAssetTicker').value = '';
  document.getElementById('modalAssetTicker').disabled = false;
  document.getElementById('modalAssetName').value = '';
  document.getElementById('modalAssetType').value = 'EQUITY';
  document.getElementById('modalAssetCurrency').value = 'EUR';
  document.getElementById('modalAssetDataSource').value = 'YAHOO';
  document.getElementById('modalAssetSector').value = 'Unclassified';
  document.getElementById('modalAssetRegion').value = 'Global';
  document.getElementById('modalAssetPrice').value = '';
  document.getElementById('modalAssetExchange').value = '';
  document.getElementById('assetModal').classList.remove('hidden');
}

async function openEditAssetModal(ticker) {
  let a = currentAssetsList.find(item => item.ticker.toUpperCase() === ticker.toUpperCase());
  if (!a) {
    try {
      const res = await fetch(`/api/assets/${encodeURIComponent(ticker)}`);
      const data = await res.json();
      if (data.success && data.asset) a = data.asset;
    } catch (err) {}
  }
  if (!a) {
    showToast(`Titolo ${ticker} non trovato`, true);
    return;
  }

  editingAssetTicker = a.ticker;
  document.getElementById('assetModalTitle').textContent = `Modifica ${a.ticker}`;
  document.getElementById('modalAssetTicker').value = a.ticker;
  document.getElementById('modalAssetTicker').disabled = true;
  document.getElementById('modalAssetName').value = a.name || '';
  document.getElementById('modalAssetType').value = a.type || 'EQUITY';
  document.getElementById('modalAssetCurrency').value = a.currency || 'EUR';
  document.getElementById('modalAssetDataSource').value = a.dataSource || 'YAHOO';
  document.getElementById('modalAssetSector').value = a.sector || 'Unclassified';
  document.getElementById('modalAssetRegion').value = a.region || 'Global';
  document.getElementById('modalAssetPrice').value = a.currentPrice !== undefined && a.currentPrice !== null ? a.currentPrice : '';
  document.getElementById('modalAssetExchange').value = a.exchange || '';
  document.getElementById('assetModal').classList.remove('hidden');
}

function closeAssetModal() {
  document.getElementById('assetModal')?.classList.add('hidden');
}

async function handleSaveAsset(e) {
  e.preventDefault();
  const ticker = document.getElementById('modalAssetTicker').value.trim().toUpperCase();
  const name = document.getElementById('modalAssetName').value.trim();
  const type = document.getElementById('modalAssetType').value;
  const currency = document.getElementById('modalAssetCurrency').value;
  const dataSource = document.getElementById('modalAssetDataSource').value;
  const sector = document.getElementById('modalAssetSector').value;
  const region = document.getElementById('modalAssetRegion').value;
  const currentPrice = parseFloat(document.getElementById('modalAssetPrice').value) || 0;
  const exchange = document.getElementById('modalAssetExchange').value.trim();

  if (!ticker || !name) {
    showToast('Ticker e Nome sono campi obbligatori', true);
    return;
  }

  const payload = {
    ticker,
    name,
    type,
    currency,
    dataSource,
    sector,
    region,
    currentPrice,
    exchange
  };

  try {
    let res;
    if (editingAssetTicker) {
      res = await fetch(`/api/assets/${encodeURIComponent(editingAssetTicker)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
    } else {
      res = await fetch('/api/assets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
    }

    const data = await res.json();
    if (data.success) {
      showToast(`✓ Titolo ${ticker} salvato con successo!`);
      closeAssetModal();
      loadAssets();
      loadClassifications();
    } else {
      showToast(data.error || 'Errore salvataggio titolo', true);
    }
  } catch (err) {
    showToast('Errore durante il salvataggio del titolo', true);
  }
}

async function handleDeleteAsset(ticker) {
  if (!confirm(`Sei sicuro di voler eliminare il titolo ${ticker} dal catalogo e tutte le sue quotazioni storiche?`)) return;

  try {
    const res = await fetch(`/api/assets/${encodeURIComponent(ticker)}`, { method: 'DELETE' });
    const data = await res.json();
    if (data.success) {
      showToast(`✓ Titolo ${ticker} rimosso con successo.`);
      loadAssets();
      loadClassifications();
      loadMarketStatus();
    } else {
      showToast(data.error || 'Errore rimozione titolo', true);
    }
  } catch (err) {
    showToast('Errore durante l\'eliminazione del titolo', true);
  }
}

window.handleAssetSourceChange = handleAssetSourceChange;
window.syncSingleQuote = syncSingleQuote;
window.syncSingleHistory = syncSingleHistory;
window.openEditAssetModal = openEditAssetModal;
window.handleDeleteAsset = handleDeleteAsset;

// ==========================================
// 3. CLASSIFICAZIONI CONTROLLER
// ==========================================
async function loadClassifications() {
  const classList = document.getElementById('class-distribution-list');
  const sectorList = document.getElementById('sector-distribution-list');
  const regionList = document.getElementById('region-distribution-list');
  const taxBody = document.getElementById('taxonomy-table-body');

  try {
    const res = await fetch('/api/assets/classifications');
    const data = await res.json();
    if (!data.success) return;

    const { byType, bySector, byRegion } = data.classifications || {};
    const total = data.totalAssets || 0;

    // Render Asset Classes
    if (classList) {
      const typeKeys = Object.keys(byType);
      document.getElementById('class-count-badge').textContent = `${typeKeys.length} classi`;
      classList.innerHTML = typeKeys.map(k => {
        const cnt = byType[k].count;
        const pct = total > 0 ? ((cnt / total) * 100).toFixed(0) : 0;
        return `
          <div class="flex items-center justify-between py-1 border-b border-gray-100/50 dark:border-white/5">
            <span class="text-gray-700 dark:text-gray-300 font-medium">${k}</span>
            <div class="flex items-center space-x-2">
              <div class="w-16 h-1.5 bg-gray-200 dark:bg-white/10 rounded-full overflow-hidden">
                <div class="h-full bg-emerald-500 rounded-full" style="width: ${pct}%"></div>
              </div>
              <span class="text-gray-400 tabular-nums w-8 text-right">${cnt}</span>
            </div>
          </div>
        `;
      }).join('');
    }

    // Render GICS Sectors
    if (sectorList) {
      const sectorKeys = Object.keys(bySector);
      document.getElementById('sector-count-badge').textContent = `${sectorKeys.length} settori`;
      sectorList.innerHTML = sectorKeys.map(k => {
        const cnt = bySector[k].count;
        return `
          <div class="flex items-center justify-between py-1 border-b border-gray-100/50 dark:border-white/5">
            <span class="text-gray-700 dark:text-gray-300 truncate max-w-[150px]" title="${k}">${k}</span>
            <span class="text-gray-400 tabular-nums font-mono">${cnt}</span>
          </div>
        `;
      }).join('');
    }

    // Render Geographic Regions
    if (regionList) {
      const regionKeys = Object.keys(byRegion);
      document.getElementById('region-count-badge').textContent = `${regionKeys.length} regioni`;
      regionList.innerHTML = regionKeys.map(k => {
        const cnt = byRegion[k].count;
        return `
          <div class="flex items-center justify-between py-1 border-b border-gray-100/50 dark:border-white/5">
            <span class="text-gray-700 dark:text-gray-300 font-medium">${k}</span>
            <span class="text-gray-400 tabular-nums font-mono">${cnt}</span>
          </div>
        `;
      }).join('');
    }

    // Render Rapid Taxonomy Assignment Table
    if (taxBody) {
      // Re-fetch assets list for the taxonomy assignment
      const aRes = await fetch('/api/assets');
      const aData = await aRes.json();
      const assets = aData.assets || [];

      const gicsList = [
        'Unclassified', 'Information Technology', 'Financials', 'Health Care',
        'Consumer Discretionary', 'Consumer Staples', 'Industrials', 'Energy',
        'Utilities', 'Materials', 'Real Estate', 'Communication Services',
        'Government', 'Broad Market'
      ];
      const typeList = ['EQUITY', 'ETF', 'BOND', 'COMMODITY', 'CRYPTO', 'CASH'];
      const regList = ['Global', 'Americas', 'Europe', 'Asia', 'Emerging Markets'];

      taxBody.innerHTML = assets.map(a => `
        <tr class="border-b border-gray-100 dark:border-white/5 hover:bg-gray-50/50 dark:hover:bg-white/[0.02]">
          <td class="px-4 py-3">
            <div class="font-bold text-gray-900 dark:text-white font-mono text-xs">${a.ticker}</div>
            <div class="text-[11px] text-gray-400 truncate max-w-[160px]">${a.name}</div>
          </td>
          <td class="px-4 py-3">
            <select id="tax-type-${a.ticker}" data-tax-ticker="${a.ticker}" onchange="saveTaxonomy('${a.ticker}')" class="px-2 py-1 rounded-lg text-xs font-mono bg-gray-50 dark:bg-black/20 border border-gray-300 dark:border-white/10">
              ${typeList.map(t => `<option value="${t}" ${a.type === t ? 'selected' : ''}>${t}</option>`).join('')}
            </select>
          </td>
          <td class="px-4 py-3">
            <select id="tax-sector-${a.ticker}" data-tax-ticker="${a.ticker}" onchange="saveTaxonomy('${a.ticker}')" class="px-2 py-1 rounded-lg text-xs font-mono bg-gray-50 dark:bg-black/20 border border-gray-300 dark:border-white/10 max-w-[180px]">
              ${gicsList.map(s => `<option value="${s}" ${a.sector === s ? 'selected' : ''}>${s}</option>`).join('')}
            </select>
          </td>
          <td class="px-4 py-3">
            <select id="tax-region-${a.ticker}" data-tax-ticker="${a.ticker}" onchange="saveTaxonomy('${a.ticker}')" class="px-2 py-1 rounded-lg text-xs font-mono bg-gray-50 dark:bg-black/20 border border-gray-300 dark:border-white/10">
              ${regList.map(r => `<option value="${r}" ${a.region === r ? 'selected' : ''}>${r}</option>`).join('')}
            </select>
          </td>
          <td class="px-4 py-3 text-right">
            <span id="tax-status-${a.ticker}" class="text-[11px] font-mono text-gray-400">●</span>
          </td>
        </tr>
      `).join('');
    }
  } catch (err) {
    console.error('Errore caricamento tassonomie:', err);
  }
}

async function saveTaxonomy(ticker) {
  const typeEl = document.getElementById(`tax-type-${ticker}`);
  const sectorEl = document.getElementById(`tax-sector-${ticker}`);
  const regionEl = document.getElementById(`tax-region-${ticker}`);
  const statusEl = document.getElementById(`tax-status-${ticker}`);

  if (!typeEl || !sectorEl || !regionEl) return;

  const payload = {
    type: typeEl.value,
    sector: sectorEl.value,
    region: regionEl.value
  };

  if (statusEl) {
    statusEl.innerHTML = '<span class="text-amber-500">Salvataggio...</span>';
  }

  try {
    const res = await fetch(`/api/assets/${encodeURIComponent(ticker)}/classification`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (data.success) {
      if (statusEl) {
        statusEl.innerHTML = '<span class="text-emerald-500 font-bold">✓ Salvato</span>';
        setTimeout(() => {
          statusEl.innerHTML = '<span class="text-gray-400">●</span>';
        }, 2000);
      }
      // Refresh counts without full table reload
      const distRes = await fetch('/api/assets/classifications');
      const distData = await distRes.json();
      if (distData.success) {
        const { byType, bySector, byRegion } = distData.classifications || {};
        const total = distData.totalAssets || 0;
        const classList = document.getElementById('class-distribution-list');
        const sectorList = document.getElementById('sector-distribution-list');
        const regionList = document.getElementById('region-distribution-list');

        if (classList) {
          classList.innerHTML = Object.keys(byType).map(k => {
            const cnt = byType[k].count;
            const pct = total > 0 ? ((cnt / total) * 100).toFixed(0) : 0;
            return `
              <div class="flex items-center justify-between py-1 border-b border-gray-100/50 dark:border-white/5">
                <span class="text-gray-700 dark:text-gray-300 font-medium">${k}</span>
                <div class="flex items-center space-x-2">
                  <div class="w-16 h-1.5 bg-gray-200 dark:bg-white/10 rounded-full overflow-hidden">
                    <div class="h-full bg-emerald-500 rounded-full" style="width: ${pct}%"></div>
                  </div>
                  <span class="text-gray-400 tabular-nums w-8 text-right">${cnt}</span>
                </div>
              </div>
            `;
          }).join('');
        }
      }
    } else {
      if (statusEl) statusEl.innerHTML = '<span class="text-rose-500">Errore</span>';
      showToast(data.error || 'Errore salvataggio tassonomia', true);
    }
  } catch (err) {
    if (statusEl) statusEl.innerHTML = '<span class="text-rose-500">Errore</span>';
  }
}

window.saveTaxonomy = saveTaxonomy;

// ==========================================
// 4. DATI DI MERCATO & RICOSTRUZIONE 5Y
// ==========================================
let currentProviderModalId = null;
let currentProviderData = null;

async function loadMarketProviders() {
  const container = document.getElementById('market-providers-container');
  if (!container) return;

  try {
    const res = await fetch('/api/market/providers');
    const data = await res.json();
    if (!data.success || !Array.isArray(data.providers)) return;

    container.innerHTML = data.providers.map(p => {
      const isEnabled = p.enabled !== false;
      const isOpen = p.marketStatus && p.marketStatus.isOpen;

      const borderClass = p.id === 'YAHOO'
        ? 'border-emerald-500/20 bg-emerald-500/5'
        : (p.id === 'BORSA_ITALIANA' ? 'border-blue-500/20 bg-blue-500/5' : 'border-amber-500/20 bg-amber-500/5');

      return `
        <div class="signature-card p-5 space-y-3 ${borderClass} flex flex-col justify-between">
          <div class="space-y-2">
            <div class="flex items-center justify-between">
              <span class="font-bold text-sm text-gray-900 dark:text-white">${escapeHtml(p.name)}</span>
              <div class="flex items-center space-x-1.5">
                <span class="${isEnabled ? 'badge-profit' : 'badge-loss'} text-[10px]">${isEnabled ? 'Attivo' : 'Disabilitato'}</span>
                <span class="px-2 py-0.5 rounded-full text-[10px] font-mono font-bold ${isOpen ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300' : 'bg-gray-100 text-gray-700 dark:bg-white/10 dark:text-gray-300'}" title="${escapeHtml(p.marketStatus?.reason || '')}">
                  ${isOpen ? '🟢 Aperto' : '⚪ Chiuso'}
                </span>
              </div>
            </div>

            <p class="text-xs text-gray-500 dark:text-gray-400 font-mono line-clamp-2">
              ${escapeHtml(p.description || '')}
            </p>

            <div class="p-2.5 rounded-xl bg-gray-50/80 dark:bg-black/20 border border-gray-200/50 dark:border-white/5 space-y-1 text-[11px] font-mono">
              <div class="flex justify-between text-gray-600 dark:text-gray-400">
                <span>Frequenza Sync:</span>
                <strong class="text-gray-900 dark:text-white">Ogni ${p.frequencyMinutes} min</strong>
              </div>
              <div class="flex justify-between text-gray-600 dark:text-gray-400">
                <span>Orari Mercato:</span>
                <strong class="text-gray-900 dark:text-white">${p.marketOpen} - ${p.marketClose}</strong>
              </div>
              <div class="flex justify-between text-gray-600 dark:text-gray-400">
                <span>Solo Orari Apertura:</span>
                <span class="text-gray-900 dark:text-white font-medium">${p.onlyMarketHours ? '✓ Sì' : '✗ No (24/7)'}</span>
              </div>
            </div>
          </div>

          <button type="button" class="btn-configure-provider w-full btn-pill px-3 py-2 border border-gray-300 dark:border-white/10 hover:bg-gray-100 dark:hover:bg-white/5 text-xs font-semibold flex items-center justify-center space-x-1.5 transition" data-provider-id="${p.id}">
            <span>⚙️</span>
            <span>Configura & Esegui Test</span>
          </button>
        </div>
      `;
    }).join('');
  } catch (err) {
    console.warn('Errore caricamento providers mercato:', err);
  }
}

async function openProviderConfigModal(providerId) {
  const modal = document.getElementById('providerConfigModal');
  if (!modal) return;

  currentProviderModalId = providerId;
  hideProviderTestResult();

  try {
    const res = await fetch(`/api/market/providers/${providerId}`);
    const data = await res.json();
    if (!data.success || !data.provider) {
      showToast(data.error || 'Provider non trovato', true);
      return;
    }

    const p = data.provider;
    currentProviderData = p;

    document.getElementById('providerModalTitle').textContent = `${p.name} - Configurazione & Test`;
    document.getElementById('providerModalDesc').textContent = p.description || '';
    document.getElementById('providerConfigFreq').value = p.frequencyMinutes || 30;
    document.getElementById('providerConfigOpen').value = p.marketOpen || '09:00';
    document.getElementById('providerConfigClose').value = p.marketClose || '17:30';
    document.getElementById('providerConfigOnlyHours').checked = !!p.onlyMarketHours;
    document.getElementById('providerConfigEnabled').checked = p.enabled !== false;

    const statusBadge = document.getElementById('providerMarketStatusBadge');
    if (statusBadge) {
      const isOpen = p.marketStatus && p.marketStatus.isOpen;
      statusBadge.className = `text-xs font-mono font-bold ${isOpen ? 'text-emerald-600 dark:text-emerald-400' : 'text-gray-500'}`;
      statusBadge.textContent = p.marketStatus?.reason || (isOpen ? 'Mercato Aperto' : 'Mercato Chiuso');
    }

    // Sample tickers pills
    const pillsContainer = document.getElementById('providerSampleTickersPills');
    const tickerInput = document.getElementById('providerTestTickerInput');
    if (pillsContainer && Array.isArray(p.sampleTickers)) {
      pillsContainer.innerHTML = p.sampleTickers.map(tk => `
        <button type="button" class="btn-sample-ticker px-2 py-0.5 rounded bg-gray-100 hover:bg-gray-200 dark:bg-white/10 dark:hover:bg-white/15 text-gray-800 dark:text-gray-200 transition font-bold" data-ticker="${tk}">
          ${tk}
        </button>
      `).join('');

      pillsContainer.querySelectorAll('.btn-sample-ticker').forEach(btn => {
        btn.addEventListener('click', () => {
          if (tickerInput) tickerInput.value = btn.dataset.ticker;
        });
      });

      if (p.sampleTickers.length > 0 && tickerInput && !tickerInput.value) {
        tickerInput.value = p.sampleTickers[0];
      }
    }

    // Historical button visibility/disabled
    const histBtn = document.getElementById('btnRunHistoryTest');
    if (histBtn) {
      if (p.supportsHistorical) {
        histBtn.disabled = false;
        histBtn.classList.remove('opacity-40', 'cursor-not-allowed');
        histBtn.title = 'Esegui test recupero serie storica 5Y';
      } else {
        histBtn.disabled = true;
        histBtn.classList.add('opacity-40', 'cursor-not-allowed');
        histBtn.title = 'Questo provider supporta solo quotazioni realtime (nessuna serie storica)';
      }
    }

    modal.classList.remove('hidden');
    document.body.classList.add('overflow-hidden');
  } catch (err) {
    showToast('Errore di comunicazione: ' + err.message, true);
  }
}

function closeProviderConfigModal() {
  const modal = document.getElementById('providerConfigModal');
  if (modal) {
    modal.classList.add('hidden');
    document.body.classList.remove('overflow-hidden');
    hideProviderTestResult();
  }
}

async function handleSaveProviderConfig() {
  if (!currentProviderModalId) return;

  const freq = parseInt(document.getElementById('providerConfigFreq')?.value, 10);
  const openTime = document.getElementById('providerConfigOpen')?.value?.trim();
  const closeTime = document.getElementById('providerConfigClose')?.value?.trim();
  const onlyHours = document.getElementById('providerConfigOnlyHours')?.checked;
  const enabled = document.getElementById('providerConfigEnabled')?.checked;

  if (!freq || isNaN(freq) || freq < 1) {
    showToast('Frequenza non valida (minimo 1 minuto)', true);
    return;
  }
  if (!/^\d{2}:\d{2}$/.test(openTime)) {
    showToast('Orario apertura non valido (formato HH:MM, es. 09:00)', true);
    return;
  }
  if (!/^\d{2}:\d{2}$/.test(closeTime)) {
    showToast('Orario chiusura non valido (formato HH:MM, es. 17:30)', true);
    return;
  }

  const btn = document.getElementById('btnSaveProviderConfig');
  if (btn) btn.disabled = true;

  try {
    const res = await fetch(`/api/market/providers/${currentProviderModalId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        frequencyMinutes: freq,
        marketOpen: openTime,
        marketClose: closeTime,
        onlyMarketHours: onlyHours,
        enabled: enabled
      })
    });

    const data = await res.json();
    if (data.success) {
      showToast(`✓ Configurazione salvata per ${data.provider?.name || currentProviderModalId}`);
      loadMarketProviders();
      loadMarketStatus();
      if (data.provider?.marketStatus) {
        const statusBadge = document.getElementById('providerMarketStatusBadge');
        if (statusBadge) {
          const isOpen = data.provider.marketStatus.isOpen;
          statusBadge.className = `text-xs font-mono font-bold ${isOpen ? 'text-emerald-600 dark:text-emerald-400' : 'text-gray-500'}`;
          statusBadge.textContent = data.provider.marketStatus.reason || '';
        }
      }
    } else {
      showToast(data.error || 'Errore salvataggio configurazione', true);
    }
  } catch (err) {
    showToast('Errore di connessione: ' + err.message, true);
  } finally {
    if (btn) btn.disabled = false;
  }
}

function showProviderTestResult(status, title, durationMs, contentHtml) {
  const box = document.getElementById('providerTestResultBox');
  const badge = document.getElementById('testResultStatusBadge');
  const titleEl = document.getElementById('testResultTitle');
  const durEl = document.getElementById('testResultDuration');
  const contentEl = document.getElementById('testResultContent');
  if (!box || !badge || !titleEl || !contentEl) return;

  box.classList.remove('hidden', 'bg-emerald-50/50', 'dark:bg-emerald-950/20', 'border-emerald-500/30', 'bg-rose-50/50', 'dark:bg-rose-950/20', 'border-rose-500/30', 'bg-blue-50/50', 'dark:bg-blue-950/20', 'border-blue-500/30');

  if (status === 'LOADING') {
    box.classList.add('bg-blue-50/50', 'dark:bg-blue-950/20', 'border-blue-500/30');
    badge.className = 'px-2 py-0.5 rounded-full text-[10px] font-bold bg-blue-100 text-blue-800 dark:bg-blue-900/50 dark:text-blue-200';
    badge.textContent = 'IN CORSO...';
    titleEl.textContent = title;
    durEl.textContent = '';
    contentEl.innerHTML = '<div class="flex items-center space-x-2 text-gray-500"><span class="animate-spin text-base">⏳</span><span>Interrogazione provider in tempo reale...</span></div>';
  } else if (status === 'OK') {
    box.classList.add('bg-emerald-50/50', 'dark:bg-emerald-950/20', 'border-emerald-500/30');
    badge.className = 'px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-100 text-emerald-800 dark:bg-emerald-900/50 dark:text-emerald-200';
    badge.textContent = 'SUCCESSO (OK)';
    titleEl.textContent = title;
    durEl.textContent = `Latenza: ${durationMs} ms`;
    contentEl.innerHTML = contentHtml;
  } else {
    box.classList.add('bg-rose-50/50', 'dark:bg-rose-950/20', 'border-rose-500/30');
    badge.className = 'px-2 py-0.5 rounded-full text-[10px] font-bold bg-rose-100 text-rose-800 dark:bg-rose-900/50 dark:text-rose-200';
    badge.textContent = 'ERRORE';
    titleEl.textContent = title;
    durEl.textContent = durationMs ? `Latenza: ${durationMs} ms` : '';
    contentEl.innerHTML = contentHtml;
  }
}

function hideProviderTestResult() {
  const box = document.getElementById('providerTestResultBox');
  if (box) box.classList.add('hidden');
}

async function handleRunQuoteTest() {
  if (!currentProviderModalId) return;
  const ticker = document.getElementById('providerTestTickerInput')?.value?.trim();
  if (!ticker) {
    showToast('Inserisci un ticker o codice ISIN per il test', true);
    return;
  }

  const btn = document.getElementById('btnRunQuoteTest');
  if (btn) btn.disabled = true;
  showProviderTestResult('LOADING', `Test Quotazione Realtime: ${ticker.toUpperCase()}`, 0, '');

  try {
    const res = await fetch(`/api/market/providers/${currentProviderModalId}/test-quote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ticker })
    });
    const data = await res.json();

    if (data.success && data.quote) {
      const q = data.quote;
      const html = `
        <div class="grid grid-cols-2 sm:grid-cols-4 gap-2 pt-1">
          <div class="p-2 rounded bg-white dark:bg-black/30 border border-gray-200/50 dark:border-white/5">
            <span class="text-gray-400 text-[10px] block uppercase">Prezzo Realtime</span>
            <span class="text-base font-bold text-gray-900 dark:text-white tabular-nums">${escapeHtml(q.currency || 'EUR')} ${(Number(q.currentPrice) || 0).toLocaleString('it-IT', { minimumFractionDigits: 2, maximumFractionDigits: 4 })}</span>
          </div>
          <div class="p-2 rounded bg-white dark:bg-black/30 border border-gray-200/50 dark:border-white/5">
            <span class="text-gray-400 text-[10px] block uppercase">Variazione</span>
            <span class="text-base font-bold tabular-nums ${(q.changePercent || 0) >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}">${(q.changePercent || 0) >= 0 ? '+' : ''}${(Number(q.changePercent) || 0).toFixed(2)}%</span>
          </div>
          <div class="p-2 rounded bg-white dark:bg-black/30 border border-gray-200/50 dark:border-white/5">
            <span class="text-gray-400 text-[10px] block uppercase">Exchange / Borsa</span>
            <span class="text-sm font-semibold text-gray-800 dark:text-gray-200 truncate block">${escapeHtml(q.exchange || 'N/D')}</span>
          </div>
          <div class="p-2 rounded bg-white dark:bg-black/30 border border-gray-200/50 dark:border-white/5">
            <span class="text-gray-400 text-[10px] block uppercase">Nome Strumento</span>
            <span class="text-sm font-semibold text-gray-800 dark:text-gray-200 truncate block" title="${escapeHtml(q.name || '')}">${escapeHtml(q.name || q.ticker)}</span>
          </div>
        </div>
        <details class="text-[11px] pt-1 text-gray-500 cursor-pointer">
          <summary class="hover:text-gray-700 dark:hover:text-gray-300 font-bold">Visualizza Payload JSON Completo</summary>
          <pre class="mt-1 p-2 rounded bg-black/5 dark:bg-black/40 overflow-x-auto text-[10px] font-mono">${escapeHtml(JSON.stringify(q, null, 2))}</pre>
        </details>
      `;
      showProviderTestResult('OK', `Test Quotazione Realtime Riuscito (${ticker.toUpperCase()})`, data.durationMs, html);
    } else {
      const errHtml = `
        <p class="text-rose-600 dark:text-rose-400 font-semibold">${escapeHtml(data.error || 'Nessun dato restituito dal provider.')}</p>
        <p class="text-gray-500 text-[11px]">Verifica che il simbolo/ISIN sia corretto per questo provider (es. ticker .MI per Borsa Italiana o prefisso exchange).</p>
      `;
      showProviderTestResult('ERROR', `Test Quotazione Fallito (${ticker.toUpperCase()})`, data.durationMs, errHtml);
    }
  } catch (err) {
    showProviderTestResult('ERROR', `Errore Connessione Provider`, 0, `<p class="text-rose-600">${escapeHtml(err.message)}</p>`);
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function handleRunHistoryTest() {
  if (!currentProviderModalId) return;
  const ticker = document.getElementById('providerTestTickerInput')?.value?.trim();
  if (!ticker) {
    showToast('Inserisci un ticker o codice ISIN per il test', true);
    return;
  }

  const btn = document.getElementById('btnRunHistoryTest');
  if (btn) btn.disabled = true;
  showProviderTestResult('LOADING', `Test Serie Storica 5Y: ${ticker.toUpperCase()}`, 0, '');

  try {
    const res = await fetch(`/api/market/providers/${currentProviderModalId}/test-history`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ticker, period: '5Y' })
    });
    const data = await res.json();

    if (data.success && data.count > 0) {
      const fmtP = (v) => (Number(v) || 0).toLocaleString('it-IT', { minimumFractionDigits: 2, maximumFractionDigits: 4 });
      const sampleRows = (data.samplePoints || []).map(p => `
        <tr class="hover:bg-white/5">
          <td class="px-2 py-1">${escapeHtml(p.date)}</td>
          <td class="px-2 py-1 text-right font-bold tabular-nums">€ ${fmtP(p.close)}</td>
          <td class="px-2 py-1 text-right tabular-nums text-gray-400">${p.volume ? p.volume.toLocaleString('it-IT') : '-'}</td>
        </tr>
      `).join('');

      const html = `
        <div class="grid grid-cols-2 sm:grid-cols-4 gap-2 pt-1">
          <div class="p-2 rounded bg-white dark:bg-black/30 border border-gray-200/50 dark:border-white/5">
            <span class="text-gray-400 text-[10px] block uppercase">Punti Storici Scaricati</span>
            <span class="text-base font-bold text-gray-900 dark:text-white tabular-nums">${data.count} candele</span>
          </div>
          <div class="p-2 rounded bg-white dark:bg-black/30 border border-gray-200/50 dark:border-white/5">
            <span class="text-gray-400 text-[10px] block uppercase">Range Date</span>
            <span class="text-xs font-bold text-gray-800 dark:text-gray-200 block truncate" title="${data.firstDate} -> ${data.lastDate}">${escapeHtml(data.firstDate)} → ${escapeHtml(data.lastDate)}</span>
          </div>
          <div class="p-2 rounded bg-white dark:bg-black/30 border border-gray-200/50 dark:border-white/5">
            <span class="text-gray-400 text-[10px] block uppercase">Prezzo Iniziale</span>
            <span class="text-sm font-bold tabular-nums text-gray-700 dark:text-gray-300">€ ${fmtP(data.firstPrice)}</span>
          </div>
          <div class="p-2 rounded bg-white dark:bg-black/30 border border-gray-200/50 dark:border-white/5">
            <span class="text-gray-400 text-[10px] block uppercase">Ultima Chiusura</span>
            <span class="text-sm font-bold tabular-nums text-emerald-600 dark:text-emerald-400">€ ${fmtP(data.lastPrice)}</span>
          </div>
        </div>
        <div class="pt-2">
          <span class="text-[11px] font-bold text-gray-600 dark:text-gray-400 block mb-1">Campione ultime 5 chiusure storiche:</span>
          <table class="w-full text-left text-[11px] font-mono border border-gray-200/50 dark:border-white/5 rounded-lg overflow-hidden">
            <thead class="bg-gray-100 dark:bg-white/5 text-gray-500">
              <tr>
                <th class="px-2 py-1">Data</th>
                <th class="px-2 py-1 text-right">Chiusura</th>
                <th class="px-2 py-1 text-right">Volume</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-gray-100 dark:divide-white/5">
              ${sampleRows}
            </tbody>
          </table>
        </div>
      `;
      showProviderTestResult('OK', `Test Serie Storica 5Y Riuscito (${ticker.toUpperCase()})`, data.durationMs, html);
    } else {
      const errHtml = `
        <p class="text-rose-600 dark:text-rose-400 font-semibold">${escapeHtml(data.error || 'Nessun punto storico restituito dal provider.')}</p>
        <p class="text-gray-500 text-[11px]">Verifica che il titolo sia quotato da abbastanza tempo o che il codice sia valido per serie storiche.</p>
      `;
      showProviderTestResult('ERROR', `Test Storico 5Y Fallito (${ticker.toUpperCase()})`, data.durationMs, errHtml);
    }
  } catch (err) {
    showProviderTestResult('ERROR', `Errore Connessione Provider`, 0, `<p class="text-rose-600">${escapeHtml(err.message)}</p>`);
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function loadMarketStatus() {
  loadMarketProviders();
  loadTickerBannerConfig();
  try {
    const res = await fetch('/api/market/status');
    const data = await res.json();
    if (!data.success) return;

    const cache = data.cache || {};
    const totalEl = document.getElementById('market-total-quotes');
    const tickersEl = document.getElementById('market-distinct-tickers');
    const oldestEl = document.getElementById('market-oldest-date');
    const newestEl = document.getElementById('market-newest-date');

    if (totalEl) totalEl.textContent = cache.totalQuotes || '0';
    if (tickersEl) tickersEl.textContent = cache.distinctTickers || '0';
    if (oldestEl) oldestEl.textContent = cache.oldestDate || '-';
    if (newestEl) newestEl.textContent = cache.newestDate || '-';
  } catch (err) {
    console.error('Errore caricamento stato mercato:', err);
  }
}

// ==========================================
// TICKER BANNER CONFIGURATION CONTROLLER
// ==========================================
let currentTickerConfig = {
  refreshSeconds: 60,
  scrollSpeed: 'normal',
  indices: []
};
let availablePresets = [];

async function loadTickerBannerConfig() {
  try {
    const res = await fetch('/api/market/indices-config');
    const data = await res.json();
    if (!data.success) return;

    currentTickerConfig = data.config || { refreshSeconds: 60, scrollSpeed: 'normal', indices: [] };
    availablePresets = data.presets || [];

    renderTickerSettingsUI();
  } catch (err) {
    console.error('Errore caricamento configurazione barra indici:', err);
  }
}

function renderTickerSettingsUI() {
  const freqInput = document.getElementById('tickerRefreshSecondsInput');
  if (freqInput) freqInput.value = currentTickerConfig.refreshSeconds || 60;

  const speedSelect = document.getElementById('tickerScrollSpeedSelect');
  if (speedSelect) speedSelect.value = currentTickerConfig.scrollSpeed || 'normal';

  const countEl = document.getElementById('ticker-indices-count');
  if (countEl) countEl.textContent = currentTickerConfig.indices.length;

  // Render Table rows
  const tbody = document.getElementById('ticker-indices-tbody');
  if (tbody) {
    tbody.innerHTML = currentTickerConfig.indices.map((item, idx) => {
      const isYield = item.isYield || item.currency === '%';
      return `
        <tr class="hover:bg-gray-50/50 dark:hover:bg-white/[0.02] transition" data-index-idx="${idx}">
          <td class="px-4 py-2.5 text-center">
            <input type="checkbox" class="ticker-enable-checkbox h-4 w-4 rounded text-emerald-600 focus:ring-emerald-500 cursor-pointer" ${item.enabled !== false ? 'checked' : ''} data-idx="${idx}">
          </td>
          <td class="px-4 py-2.5 font-bold text-gray-900 dark:text-white font-mono">
            ${escapeHtml(item.symbol)}
          </td>
          <td class="px-4 py-2.5">
            <input type="text" class="ticker-name-input w-full max-w-xs px-2 py-1 rounded bg-transparent border border-transparent hover:border-gray-300 dark:hover:border-white/20 focus:border-emerald-500 focus:bg-white dark:focus:bg-black/40 text-xs font-mono" value="${escapeHtml(item.name || item.symbol)}" data-idx="${idx}">
          </td>
          <td class="px-4 py-2.5">
            <span class="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-bold ${isYield ? 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300' : 'bg-gray-100 dark:bg-white/10 text-gray-700 dark:text-gray-300'}">
              ${escapeHtml(item.currency || (isYield ? '%' : 'Forex'))}
            </span>
          </td>
          <td class="px-4 py-2.5 text-center">
            <button type="button" class="btn-delete-ticker p-1 text-gray-400 hover:text-rose-600 transition font-bold" data-idx="${idx}" title="Rimuovi indice">
              ✕
            </button>
          </td>
        </tr>
      `;
    }).join('') || '<tr><td colspan="5" class="py-6 text-center text-gray-400">Nessun indice configurato. Aggiungine uno sotto!</td></tr>';
  }

  // Render Presets Pills
  const pillsContainer = document.getElementById('ticker-presets-pills');
  if (pillsContainer) {
    pillsContainer.innerHTML = availablePresets.map(p => {
      const alreadyAdded = currentTickerConfig.indices.some(i => i.symbol === p.symbol);
      return `
        <button type="button" class="btn-preset-ticker px-2.5 py-1 rounded-lg text-xs font-mono transition border ${alreadyAdded ? 'bg-emerald-50 text-emerald-700 border-emerald-300 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-800' : 'bg-white dark:bg-white/5 border-gray-200 dark:border-white/10 hover:border-emerald-500 text-gray-700 dark:text-gray-300'}" data-symbol="${escapeHtml(p.symbol)}" data-name="${escapeHtml(p.name)}" data-currency="${escapeHtml(p.currency || '')}" data-yield="${p.isYield ? 'true' : 'false'}">
          ${alreadyAdded ? '✓' : '+'} ${escapeHtml(p.name)} <span class="opacity-60 text-[10px]">(${escapeHtml(p.symbol)})</span>
        </button>
      `;
    }).join('');
  }
}

async function handleSaveTickerConfig() {
  const saveBtn = document.getElementById('btn-save-ticker-config');
  if (saveBtn) saveBtn.disabled = true;

  try {
    const freqInput = document.getElementById('tickerRefreshSecondsInput');
    const speedSelect = document.getElementById('tickerScrollSpeedSelect');

    const refreshSeconds = parseInt(freqInput?.value, 10) || 60;
    const scrollSpeed = speedSelect?.value || 'normal';

    // Synchronize latest input edits
    const nameInputs = document.querySelectorAll('.ticker-name-input');
    nameInputs.forEach(input => {
      const idx = parseInt(input.dataset.idx, 10);
      if (currentTickerConfig.indices[idx]) {
        currentTickerConfig.indices[idx].name = input.value.trim() || currentTickerConfig.indices[idx].symbol;
      }
    });

    const checkboxes = document.querySelectorAll('.ticker-enable-checkbox');
    checkboxes.forEach(cb => {
      const idx = parseInt(cb.dataset.idx, 10);
      if (currentTickerConfig.indices[idx]) {
        currentTickerConfig.indices[idx].enabled = cb.checked;
      }
    });

    const payload = {
      refreshSeconds,
      scrollSpeed,
      indices: currentTickerConfig.indices
    };

    const res = await fetch('/api/market/indices-config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const data = await res.json();
    if (data.success) {
      showToast('✓ Configurazione barra indici salvata con successo');
      currentTickerConfig = data.config;
      renderTickerSettingsUI();

      // Notify live ticker component
      window.dispatchEvent(new CustomEvent('foliotrack:ticker-config-updated', { detail: data.config }));
      localStorage.setItem('foliotrack_ticker_updated', String(Date.now()));
    } else {
      showToast(data.error || 'Errore salvataggio barra indici', true);
    }
  } catch (err) {
    showToast('Errore di connessione durante il salvataggio', true);
  } finally {
    if (saveBtn) saveBtn.disabled = false;
  }
}

async function handleResetTickerConfig() {
  if (!confirm('Vuoi ripristinare gli indici e la frequenza di aggiornamento ai valori predefiniti?')) return;

  try {
    const res = await fetch('/api/market/indices-config/reset', { method: 'POST' });
    const data = await res.json();
    if (data.success) {
      showToast('✓ Configurazione barra indici ripristinata ai default');
      currentTickerConfig = data.config;
      renderTickerSettingsUI();

      window.dispatchEvent(new CustomEvent('foliotrack:ticker-config-updated', { detail: data.config }));
      localStorage.setItem('foliotrack_ticker_updated', String(Date.now()));
    } else {
      showToast(data.error || 'Errore ripristino default', true);
    }
  } catch (err) {
    showToast('Errore di connessione durante il ripristino', true);
  }
}

async function handleForceRefreshTicker() {
  const btn = document.getElementById('btn-force-refresh-ticker');
  if (btn) btn.disabled = true;

  try {
    showToast('⚡ Aggiornamento forzato banner indici in corso...');
    const res = await fetch('/api/market/indices/refresh', { method: 'POST' });
    const data = await res.json();
    if (data.success) {
      showToast('✓ Banner indici aggiornato con quotazioni in tempo reale.');
      window.dispatchEvent(new CustomEvent('foliotrack:ticker-config-updated', { detail: data }));
    } else {
      showToast(data.error || 'Errore aggiornamento banner', true);
    }
  } catch (err) {
    showToast('Errore di connessione', true);
  } finally {
    if (btn) btn.disabled = false;
  }
}

function handleAddCustomTicker() {
  const symInput = document.getElementById('newTickerSymbolInput');
  const nameInput = document.getElementById('newTickerNameInput');
  const currSelect = document.getElementById('newTickerCurrencySelect');

  const symbol = symInput?.value?.trim().toUpperCase();
  const name = nameInput?.value?.trim() || symbol;
  const currency = currSelect?.value || '';

  if (!symbol) {
    showToast('Inserisci un simbolo o ticker valido', true);
    return;
  }

  // Check duplicate
  if (currentTickerConfig.indices.some(i => i.symbol === symbol)) {
    showToast(`L'indice ${symbol} è già presente nella lista`, true);
    return;
  }

  currentTickerConfig.indices.push({
    symbol,
    name,
    currency,
    isYield: currency === '%',
    enabled: true
  });

  if (symInput) symInput.value = '';
  if (nameInput) nameInput.value = '';

  renderTickerSettingsUI();
  showToast(`✓ Indice ${symbol} aggiunto. Clicca su "Salva" per applicare.`);
}

async function handleReconstructHistory() {
  const btn = document.getElementById('btn-reconstruct-history');
  const statusEl = document.getElementById('reconstruct-status');
  if (btn) btn.disabled = true;
  if (statusEl) statusEl.textContent = 'Ricostruzione 5Y in corso...';

  try {
    showToast('🚀 Avvio ricostruzione serie storica portafoglio 5Y...');
    const res = await fetch('/api/market/reconstruct-history', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ daysBack: 1825 })
    });
    const data = await res.json();
    if (data.success) {
      showToast(`✓ ${data.message}`);
      if (statusEl) {
        const m = data.metrics;
        if (m) {
          const twr1y = m.twr && m.twr['1Y'] !== undefined ? `${m.twr['1Y'] >= 0 ? '+' : ''}${m.twr['1Y']}%` : 'N/D';
          const twrAll = m.twr && m.twr['ALL'] !== undefined ? `${m.twr['ALL'] >= 0 ? '+' : ''}${m.twr['ALL']}%` : 'N/D';
          const xirrStr = m.xirr !== undefined ? `${m.xirr >= 0 ? '+' : ''}${m.xirr}%` : 'N/D';
          const ddStr = m.maxDrawdown !== undefined ? `-${m.maxDrawdown}%` : 'N/D';
          statusEl.innerHTML = `
            <span class="text-emerald-500 font-bold block mt-1">✓ Completato: ${data.pointsReconstructed} snapshot generati.</span>
            <span class="text-[11px] text-gray-400 font-mono block mt-1">Indicatori ricalcolati: TWR 1A: <b class="text-gray-200">${twr1y}</b> | TWR Inception: <b class="text-gray-200">${twrAll}</b> | XIRR: <b class="text-gray-200">${xirrStr}</b> | Max DD: <b class="text-rose-400">${ddStr}</b> | Volatilità: <b class="text-gray-200">${m.annualizedVolatility || 0}%</b></span>
          `;
        } else {
          statusEl.textContent = `Completato: ${data.pointsReconstructed} snapshot generati.`;
        }
      }
      loadMarketStatus();
    } else {
      showToast(data.error || 'Errore ricostruzione andamento storico', true);
      if (statusEl) statusEl.textContent = 'Errore durante la ricostruzione.';
    }
  } catch (err) {
    showToast('Errore di connessione durante la ricostruzione', true);
    if (statusEl) statusEl.textContent = 'Errore di connessione.';
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function handleClearMarketCache() {
  if (!confirm('Sei sicuro di voler pulire la cache dei dati di mercato più vecchi di 5 anni?')) return;

  try {
    const res = await fetch('/api/market/clear-cache', { method: 'POST' });
    const data = await res.json();
    if (data.success) {
      showToast(`✓ ${data.message}`);
      loadMarketStatus();
    } else {
      showToast(data.error || 'Errore pulizia cache', true);
    }
  } catch (err) {
    showToast('Errore di connessione durante la pulizia', true);
  }
}

// ==========================================
// 5. NOTIFICHE TELEGRAM & WEB PUSH
// ==========================================
async function handleTelegramTest() {
  const btn = document.getElementById('btn-telegram-test');
  if (btn) btn.disabled = true;

  try {
    const res = await fetch('/api/notifications/telegram/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        botToken: document.getElementById('telegram_bot_token')?.value,
        chatId: document.getElementById('telegram_chat_id')?.value
      })
    });
    const data = await res.json();
    if (data.success) {
      showToast('✓ Messaggio di test Telegram inviato con successo!');
    } else {
      showToast(data.error || 'Errore invio Telegram', true);
    }
  } catch (err) {
    showToast('Errore durante la chiamata API Telegram', true);
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function handleTelegramDigest() {
  const btn = document.getElementById('btn-telegram-digest');
  if (btn) btn.disabled = true;

  try {
    const res = await fetch('/api/notifications/telegram/digest', { method: 'POST' });
    const data = await res.json();
    if (data.success) {
      showToast('✓ Daily Digest inviato a Telegram!');
    } else {
      showToast(data.error || 'Errore invio Daily Digest', true);
    }
  } catch (err) {
    showToast('Errore durante la chiamata Daily Digest', true);
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function handleCheckAlerts() {
  try {
    const res = await fetch('/api/notifications/check-alerts', { method: 'POST' });
    const data = await res.json();
    if (data.success) {
      if (data.triggeredCount > 0) {
        showToast(`🚨 Triggerati ${data.triggeredCount} alert di prezzo!`);
      } else {
        showToast(`✓ Controllati ${data.checked} asset. Nessun alert superato.`);
      }
    }
  } catch (err) {
    showToast('Errore controllo alert', true);
  }
}

async function initPushControls() {
  const statusEl = document.getElementById('push-status-text');
  const btnToggle = document.getElementById('btn-toggle-push');
  const btnTest = document.getElementById('btn-test-push');

  // Load existing notification preferences
  loadNotificationSettings();

  // Attach save button
  const btnSave = document.getElementById('btn-save-notification-settings');
  btnSave?.addEventListener('click', saveNotificationSettings);

  // Attach font style preview and auto-persistence
  const fontStyleSelect = document.getElementById('notif_font_style');
  fontStyleSelect?.addEventListener('change', async (e) => {
    updateFontPreview(e.target.value);
    await saveNotificationSettings();
  });

  // Attach individual test buttons
  document.getElementById('btn-test-notif-market-open')?.addEventListener('click', function() {
    handleSendTestNotification('market_open', this);
  });
  document.getElementById('btn-test-notif-asset-change')?.addEventListener('click', function() {
    handleSendTestNotification('asset_change', this);
  });
  document.getElementById('btn-test-notif-portfolio-change')?.addEventListener('click', function() {
    handleSendTestNotification('portfolio_change', this);
  });

  if (!window.FolioTrackPush) return;

  const status = await window.FolioTrackPush.checkPushSubscriptionStatus();
  if (!status.supported) {
    if (statusEl) statusEl.textContent = 'Non supportato in questo browser';
    if (btnToggle) btnToggle.disabled = true;
    return;
  }

  if (status.subscribed) {
    if (statusEl) statusEl.innerHTML = '<span class="text-emerald-500 font-bold">Attivo e Sottoscritto</span>';
    if (btnToggle) btnToggle.textContent = 'Disattiva Notifiche Push';
    if (btnTest) btnTest.classList.remove('hidden');
  } else {
    if (statusEl) statusEl.innerHTML = '<span class="text-gray-400 font-bold">Non attivo</span>';
    if (btnToggle) btnToggle.textContent = 'Attiva Notifiche su questo Smartphone';
    if (btnTest) btnTest.classList.add('hidden');
  }

  btnToggle?.addEventListener('click', async () => {
    btnToggle.disabled = true;
    try {
      const current = await window.FolioTrackPush.checkPushSubscriptionStatus();
      if (current.subscribed) {
        await window.FolioTrackPush.unsubscribeUserFromPush();
        showToast('Notifiche Push disattivate.');
      } else {
        await window.FolioTrackPush.subscribeUserToPush();
        showToast('✓ Notifiche Push attivate con successo!');
      }
      initPushControls();
    } catch (err) {
      showToast(err.message, true);
    } finally {
      btnToggle.disabled = false;
    }
  });

  btnTest?.addEventListener('click', async () => {
    btnTest.disabled = true;
    try {
      const res = await fetch('/api/push/send-test', { method: 'POST' });
      const data = await res.json();
      if (data.success) {
        showToast('✓ Notifica Push di prova inviata!');
      } else {
        showToast(data.error || 'Errore invio notifica push', true);
      }
    } catch (err) {
      showToast('Errore di connessione', true);
    } finally {
      btnTest.disabled = false;
    }
  });
}

function updateFontPreview(style) {
  const previewEl = document.getElementById('notif-font-preview');
  if (!previewEl) return;
  const sample = 'NVDA     +4,3%  (+€145)';
  let transformed = sample;
  if (style === 'sans_bold') {
    transformed = '𝗡𝗩𝗗𝗔     +𝟰,𝟯%  (+€𝟭𝟰𝟱)';
  } else if (style === 'sans') {
    transformed = '𝖭𝖵𝖣𝖠     +𝟦,𝟥%  (+€𝟣𝟦𝟧)';
  } else if (style === 'serif') {
    transformed = '𝐍𝐕𝐃𝐀     +𝟒,𝟑%  (+€𝟏𝟒𝟓)';
  } else if (style === 'monospace') {
    transformed = '𝙽𝚅𝙳𝙰     +𝟺,𝟹%  (+€𝟷𝟺𝟻)';
  }
  previewEl.textContent = `Anteprima: 🚀 ${transformed}`;
}

async function loadNotificationSettings() {
  try {
    const res = await fetch('/api/notifications/settings');
    const data = await res.json();
    if (!data.success || !data.settings) return;

    const s = data.settings;
    const marketOpenCb = document.getElementById('notif_market_open_enabled');
    const assetChangeCb = document.getElementById('notif_asset_change_enabled');
    const assetThresholdInp = document.getElementById('notif_asset_change_threshold');
    const portfolioChangeCb = document.getElementById('notif_portfolio_change_enabled');
    const portfolioThresholdInp = document.getElementById('notif_portfolio_change_threshold');
    const syncOnlyMarketHoursCb = document.getElementById('sync_only_market_hours');
    const fontStyleSelect = document.getElementById('notif_font_style');

    if (marketOpenCb) marketOpenCb.checked = s.marketOpenEnabled;
    if (assetChangeCb) assetChangeCb.checked = s.assetChangeEnabled;
    if (assetThresholdInp) assetThresholdInp.value = s.assetChangeThreshold ?? 5;
    if (portfolioChangeCb) portfolioChangeCb.checked = s.portfolioChangeEnabled;
    if (portfolioThresholdInp) portfolioThresholdInp.value = s.portfolioChangeThreshold ?? 300;
    if (syncOnlyMarketHoursCb) syncOnlyMarketHoursCb.checked = s.syncOnlyMarketHours;
    if (fontStyleSelect && s.fontStyle) {
      fontStyleSelect.value = s.fontStyle;
      updateFontPreview(s.fontStyle);
    }
  } catch (err) {
    console.warn('[Settings] Impossibile caricare le impostazioni notifiche:', err);
  }
}

async function saveNotificationSettings() {
  const saveBtn = document.getElementById('btn-save-notification-settings');
  const statusEl = document.getElementById('notif-save-status');

  const payload = {
    marketOpenEnabled: document.getElementById('notif_market_open_enabled')?.checked ?? true,
    assetChangeEnabled: document.getElementById('notif_asset_change_enabled')?.checked ?? true,
    assetChangeThreshold: parseFloat(document.getElementById('notif_asset_change_threshold')?.value) || 5.0,
    portfolioChangeEnabled: document.getElementById('notif_portfolio_change_enabled')?.checked ?? true,
    portfolioChangeThreshold: parseFloat(document.getElementById('notif_portfolio_change_threshold')?.value) || 300.0,
    syncOnlyMarketHours: document.getElementById('sync_only_market_hours')?.checked ?? true,
    fontStyle: document.getElementById('notif_font_style')?.value || 'standard'
  };

  if (saveBtn) saveBtn.disabled = true;
  if (statusEl) statusEl.textContent = 'Salvataggio in corso...';

  try {
    const res = await fetch('/api/notifications/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (data.success) {
      showToast('✓ Impostazioni notifiche salvate!');
      if (statusEl) {
        statusEl.textContent = '✓ Salvato con successo';
        setTimeout(() => { statusEl.textContent = ''; }, 3000);
      }
    } else {
      showToast(data.error || 'Errore salvataggio impostazioni notifiche', true);
      if (statusEl) statusEl.textContent = 'Errore salvataggio';
    }
  } catch (err) {
    showToast('Errore di connessione', true);
    if (statusEl) statusEl.textContent = 'Errore di connessione';
  } finally {
    if (saveBtn) saveBtn.disabled = false;
  }
}

async function handleSendTestNotification(type, btnEl) {
  if (btnEl) btnEl.disabled = true;
  try {
    // Ensure latest settings including font selection are persisted
    await saveNotificationSettings();
    const res = await fetch(`/api/notifications/test/${type}`, { method: 'POST' });
    const data = await res.json();
    if (data.success) {
      showToast(`✓ ${data.message}`);
    } else {
      showToast(data.message || data.error || 'Errore invio notifica test', true);
    }
  } catch (err) {
    showToast('Errore di connessione al server', true);
  } finally {
    if (btnEl) btnEl.disabled = false;
  }
}

// ==========================================
// 6. BACKUP & DISASTER RECOVERY CONTROLLER
// ==========================================
async function loadBackups() {
  const container = document.getElementById('backups-table-body');
  if (!container) return;

  try {
    const res = await fetch('/api/backups');
    const data = await res.json();
    if (!data.success) return;

    if (data.backups.length === 0) {
      container.innerHTML = `
        <tr>
          <td colspan="4" class="px-4 py-6 text-center text-xs font-mono text-gray-400">
            Nessun backup trovato in data/backups/. Clicca su "Crea Backup Immediato" per iniziare.
          </td>
        </tr>
      `;
      return;
    }

    container.innerHTML = data.backups.map(b => `
      <tr class="border-b border-gray-100 dark:border-white/5 hover:bg-gray-50/50 dark:hover:bg-white/[0.02]">
        <td class="px-4 py-3 text-xs font-mono font-medium text-gray-900 dark:text-gray-100">
          <div class="flex items-center space-x-2">
            <span>📦</span>
            <span>${b.filename}</span>
          </div>
        </td>
        <td class="px-4 py-3 text-xs font-mono tabular-nums text-gray-600 dark:text-gray-400">
          ${b.sizeFormatted}
        </td>
        <td class="px-4 py-3 text-xs font-mono text-gray-500 dark:text-gray-400">
          ${new Date(b.createdAt).toLocaleString('it-IT')}
        </td>
        <td class="px-4 py-3 text-right space-x-2">
          <a href="/api/backups/download/${encodeURIComponent(b.filename)}" download class="btn-pill px-3 py-1 text-xs border border-gray-300 dark:border-white/10 hover:bg-gray-100 dark:hover:bg-white/5 inline-flex items-center">
            ⬇️ Scarica
          </a>
          <button type="button" data-action="delete-backup" data-filename="${b.filename}" class="btn-pill px-3 py-1 text-xs border border-rose-500/30 text-rose-600 hover:bg-rose-500/10 inline-flex items-center">
            🗑️ Elimina
          </button>
        </td>
      </tr>
    `).join('');
  } catch (err) {
    console.error('Errore caricamento lista backup:', err);
  }
}

async function handleCreateBackup() {
  const btn = document.getElementById('btn-create-backup');
  if (btn) btn.disabled = true;

  try {
    const res = await fetch('/api/backups/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    const data = await res.json();
    if (data.success) {
      showToast(`✓ ${data.message}`);
      loadBackups();
    } else {
      showToast(data.error || 'Errore creazione backup', true);
    }
  } catch (err) {
    showToast('Errore durante la richiesta di backup', true);
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function deleteBackupItem(filename) {
  if (!confirm(`Sei sicuro di voler eliminare definitivamente il backup ${filename}?`)) {
    return;
  }

  try {
    const res = await fetch(`/api/backups/${encodeURIComponent(filename)}`, { method: 'DELETE' });
    const data = await res.json();
    if (data.success) {
      showToast('✓ Backup eliminato con successo');
      loadBackups();
    } else {
      showToast(data.error || 'Errore eliminazione backup', true);
    }
  } catch (err) {
    showToast('Errore durante l\'eliminazione del backup', true);
  }
}

async function handleResetFinancialDatabase() {
  const confirmText = prompt(
    "⚠️ ATTENZIONE: Sei sicuro di voler azzerare completamente il database finanziario?\n\n" +
    "Verranno eliminati TUTTI i portafogli, movimenti, titoli, quotazioni e storico NAV, ripartendo da un database completamente vuoto.\n" +
    "Verrà generato automaticamente un backup di sicurezza ZIP preventivo in data/backups/.\n\n" +
    "Per confermare l'azzeramento definitivo, digita 'RESET':"
  );

  if (!confirmText || confirmText.trim().toUpperCase() !== 'RESET') {
    showToast('Operazione annullata. Nessuna modifica apportata.');
    return;
  }

  const btn = document.getElementById('btn-reset-financial-db');
  const btnMobile = document.getElementById('btn-reset-financial-db-mobile');
  if (btn) btn.disabled = true;
  if (btnMobile) btnMobile.disabled = true;

  showToast('⏳ Creazione backup di sicurezza e azzeramento database in corso...');

  try {
    const res = await fetch('/api/settings/reset-financial-data', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirmation: 'RESET', createBackup: true })
    });

    const data = await res.json();
    if (!res.ok || !data.success) {
      showToast(data.error || 'Errore durante il reset del database', true);
      return;
    }

    const del = data.deleted || {};
    const backupMsg = data.backup ? `\n(Backup preventivo: ${data.backup.filename})` : '';
    alert(
      `✅ DATABASE FINANZIARIO AZZERATO CON SUCCESSO!\n\n` +
      `Elementi eliminati:\n` +
      `• Movimenti: ${del.transactions || 0}\n` +
      `• Portafogli: ${del.portfolios || 0}\n` +
      `• Titoli: ${del.assets || 0}\n` +
      `• Quotazioni storiche: ${del.asset_quotes || 0}\n\n` +
      `Il database è ora completamente vuoto e pronto per nuovi inserimenti o importazioni CSV.${backupMsg}`
    );

    loadBackups();
    loadAssets();
    window.location.reload();
  } catch (err) {
    showToast(`Errore di comunicazione: ${err.message}`, true);
  } finally {
    if (btn) btn.disabled = false;
    if (btnMobile) btnMobile.disabled = false;
  }
}

window.deleteBackupItem = deleteBackupItem;
window.handleResetFinancialDatabase = handleResetFinancialDatabase;

// ==========================================
// 7. SETTINGS & AI KEYS CONTROLLER
// ==========================================
async function loadSettings() {
  try {
    const res = await fetch('/api/settings');
    const data = await res.json();
    if (!data.success) return;

    const s = data.settings || {};
    const setVal = (id, val) => {
      const el = document.getElementById(id);
      if (el && val) el.value = val;
    };

    setVal('telegram_bot_token', s.telegram_bot_token);
    setVal('telegram_chat_id', s.telegram_chat_id);
    setVal('gemini_api_key', s.gemini_api_key);
    setVal('openai_api_key', s.openai_api_key);
    setVal('tavily_api_key', s.tavily_api_key);
    setVal('gdrive_client_email', s.gdrive_client_email);
    setVal('gdrive_folder_id', s.gdrive_folder_id);
  } catch (err) {
    console.error('Errore caricamento impostazioni:', err);
  }
}

async function handleSaveSettings(e) {
  if (e && e.preventDefault) e.preventDefault();
  const btn = document.getElementById('btn-save-settings') || document.getElementById('btn-save-settings-ai');
  if (btn) btn.disabled = true;

  const payload = {
    telegram_bot_token: document.getElementById('telegram_bot_token')?.value || '',
    telegram_chat_id: document.getElementById('telegram_chat_id')?.value || '',
    gemini_api_key: document.getElementById('gemini_api_key')?.value || '',
    openai_api_key: document.getElementById('openai_api_key')?.value || '',
    tavily_api_key: document.getElementById('tavily_api_key')?.value || '',
    gdrive_client_email: document.getElementById('gdrive_client_email')?.value || '',
    gdrive_folder_id: document.getElementById('gdrive_folder_id')?.value || ''
  };

  try {
    const res = await fetch('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (data.success) {
      showToast('✓ Impostazioni crittografate salvate con successo');
    } else {
      showToast(data.error || 'Errore salvataggio impostazioni', true);
    }
  } catch (err) {
    showToast('Errore di connessione durante il salvataggio', true);
  } finally {
    if (btn) btn.disabled = false;
  }
}

// ==========================================
// 8. SECURITY & CREDENTIALS CONTROLLER
// ==========================================

async function loadSecurityDiagnostics() {
  try {
    // 1. Fetch current user to display current username in forms
    const meRes = await fetch('/api/auth/me');
    const meData = await meRes.json();
    if (meData.success && meData.user) {
      const uDisplay = document.getElementById('sec-current-username-display');
      if (uDisplay) uDisplay.value = meData.user.username;
      const uDisplayM = document.getElementById('sec-current-username-display-m');
      if (uDisplayM) uDisplayM.value = meData.user.username;
    }

    // 2. Fetch security diagnostic status
    const secRes = await fetch('/api/auth/security-status');
    const secData = await secRes.json();
    if (!secData.success || !secData.status) return;

    const s = secData.status;

    // Default password alert banner
    const alertBox = document.getElementById('security-default-pwd-alert');
    if (alertBox) {
      if (s.isDefaultPassword) alertBox.classList.remove('hidden');
      else alertBox.classList.add('hidden');
    }
    const alertBoxM = document.getElementById('security-default-pwd-alert-m');
    if (alertBoxM) {
      if (s.isDefaultPassword) alertBoxM.classList.remove('hidden');
      else alertBoxM.classList.add('hidden');
    }

    // Score badge
    const badge = document.getElementById('security-score-badge');
    const badgeM = document.getElementById('security-score-badge-m');
    const badgeText = s.score >= 80 ? `● Punteggio: ${s.score}/100 (Ottimale)` : `⚠️ Punteggio: ${s.score}/100 (Attenzione)`;
    const badgeClass = s.score >= 80 
      ? 'inline-flex items-center px-3 py-1 rounded-full text-xs font-mono font-bold bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20'
      : 'inline-flex items-center px-3 py-1 rounded-full text-xs font-mono font-bold bg-rose-500/10 text-rose-600 dark:text-rose-400 border border-rose-500/20';

    if (badge) {
      badge.textContent = badgeText;
      badge.className = badgeClass;
    }
    if (badgeM) {
      badgeM.textContent = `${s.score}/100`;
      badgeM.className = `px-2 py-0.5 rounded-full text-[10px] font-mono font-bold ${s.score >= 80 ? 'bg-emerald-500/10 text-emerald-500' : 'bg-rose-500/10 text-rose-500'}`;
    }

    // HTTPS Status
    const httpsEl = document.getElementById('diag-https-status');
    const httpsElM = document.getElementById('diag-https-status-m');
    const httpsHtml = s.isHttps 
      ? '<span class="text-emerald-500">✓ Crittografato (HTTPS)</span>' 
      : '<span class="text-amber-500">⚠️ HTTP plain (Non crittografato)</span>';
    if (httpsEl) httpsEl.innerHTML = httpsHtml;
    if (httpsElM) httpsElM.innerHTML = s.isHttps ? '<span class="text-emerald-500">✓ HTTPS</span>' : '<span class="text-amber-500">⚠️ HTTP</span>';

    // JWT Secret Status
    const jwtEl = document.getElementById('diag-jwt-status');
    const jwtElM = document.getElementById('diag-jwt-status-m');
    const jwtHtml = s.isDefaultJwtSecret 
      ? '<span class="text-rose-500">⚠️ Chiave default</span>' 
      : '<span class="text-emerald-500">✓ Chiave custom (32+ car.)</span>';
    if (jwtEl) jwtEl.innerHTML = jwtHtml;
    if (jwtElM) jwtElM.innerHTML = s.isDefaultJwtSecret ? '<span class="text-rose-500">⚠️ Default</span>' : '<span class="text-emerald-500">✓ Sicura</span>';

    // Crypto Status
    const cryptoEl = document.getElementById('diag-crypto-status');
    if (cryptoEl) {
      cryptoEl.innerHTML = s.isDefaultEncryptionKey 
        ? '<span class="text-rose-500">⚠️ Chiave default</span>' 
        : '<span class="text-emerald-500">✓ AES-256-GCM custom</span>';
    }

    // Recommendations
    const recBox = document.getElementById('security-recommendations-box');
    const recList = document.getElementById('security-recommendations-list');
    const recBoxM = document.getElementById('security-recommendations-box-m');
    const recListM = document.getElementById('security-recommendations-list-m');

    if (s.recommendations && s.recommendations.length > 0) {
      const itemsHtml = s.recommendations.map(r => `<li><strong>${escapeHtml(r.title)}</strong>: ${escapeHtml(r.message)}</li>`).join('');
      if (recList) recList.innerHTML = itemsHtml;
      if (recBox) recBox.classList.remove('hidden');

      const itemsHtmlM = s.recommendations.map(r => `<li>${escapeHtml(r.title)}</li>`).join('');
      if (recListM) recListM.innerHTML = itemsHtmlM;
      if (recBoxM) recBoxM.classList.remove('hidden');
    } else {
      if (recBox) recBox.classList.add('hidden');
      if (recBoxM) recBoxM.classList.add('hidden');
    }

    // Load active sessions & audit logs
    loadActiveSessions();
    loadAuditLogs();
  } catch (err) {
    console.error('[Security Diagnostics Error]', err);
  }
}

async function loadActiveSessions() {
  try {
    const res = await fetch('/api/auth/sessions');
    const data = await res.json();
    if (!data.success || !data.sessions) return;

    const tbody = document.getElementById('sessions-table-body');
    const containerM = document.getElementById('sessions-list-m');

    if (tbody) {
      if (data.sessions.length === 0) {
        tbody.innerHTML = '<tr><td colspan="4" class="py-3 text-center text-gray-400">Nessuna sessione attiva trovata</td></tr>';
      } else {
        tbody.innerHTML = data.sessions.map(s => `
          <tr class="hover:bg-gray-50/50 dark:hover:bg-white/[0.02]">
            <td class="py-2.5 font-bold">${escapeHtml(s.ipAddress)}</td>
            <td class="py-2.5 text-gray-500 dark:text-gray-400 truncate max-w-xs" title="${escapeHtml(s.userAgent)}">${escapeHtml(s.userAgent.substring(0, 40))}...</td>
            <td class="py-2.5 text-gray-400">${new Date(s.createdAt).toLocaleString('it-IT')}</td>
            <td class="py-2.5 text-right">
              ${s.isCurrent 
                ? '<span class="px-2 py-0.5 rounded-full text-[10px] bg-emerald-500/10 text-emerald-500 font-bold border border-emerald-500/20">Sessione Attuale</span>' 
                : '<span class="px-2 py-0.5 rounded-full text-[10px] bg-gray-100 dark:bg-white/5 text-gray-400">Remota</span>'}
            </td>
          </tr>
        `).join('');
      }
    }

    if (containerM) {
      if (data.sessions.length === 0) {
        containerM.innerHTML = '<div class="text-gray-400 text-center py-2">Nessuna sessione attiva</div>';
      } else {
        containerM.innerHTML = data.sessions.map(s => `
          <div class="p-2.5 rounded-lg bg-gray-50 dark:bg-black/20 border border-gray-200/50 dark:border-white/5 flex items-center justify-between text-[11px]">
            <div>
              <div class="font-bold">${escapeHtml(s.ipAddress)}</div>
              <div class="text-[10px] text-gray-400">${new Date(s.createdAt).toLocaleDateString('it-IT')}</div>
            </div>
            ${s.isCurrent 
              ? '<span class="px-2 py-0.5 rounded text-[9px] bg-emerald-500/10 text-emerald-500 font-bold">Attuale</span>' 
              : '<span class="px-2 py-0.5 rounded text-[9px] bg-gray-100 dark:bg-white/5 text-gray-400">Remota</span>'}
          </div>
        `).join('');
      }
    }
  } catch (err) {
    console.error('[Load Sessions Error]', err);
  }
}

async function loadAuditLogs() {
  try {
    const res = await fetch('/api/auth/audit-logs');
    const data = await res.json();
    if (!data.success || !data.logs) return;

    const tbody = document.getElementById('audit-table-body');
    if (!tbody) return;

    if (data.logs.length === 0) {
      tbody.innerHTML = '<tr><td colspan="4" class="py-3 text-center text-gray-400">Nessun evento registrato</td></tr>';
      return;
    }

    tbody.innerHTML = data.logs.map(l => `
      <tr class="hover:bg-gray-50/50 dark:hover:bg-white/[0.02]">
        <td class="py-2.5 font-bold text-gray-900 dark:text-white">${escapeHtml(l.action)}</td>
        <td class="py-2.5 text-gray-600 dark:text-gray-300">${escapeHtml(l.details || '-')}</td>
        <td class="py-2.5 text-gray-400">${escapeHtml(l.ip_address || '-')}</td>
        <td class="py-2.5 text-right text-gray-400">${new Date(l.created_at).toLocaleString('it-IT')}</td>
      </tr>
    `).join('');
  } catch (err) {
    console.error('[Load Audit Logs Error]', err);
  }
}

function initSecurityModule() {
  // 1. Desktop: Change Username Form
  const uForm = document.getElementById('form-change-username');
  if (uForm) {
    uForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = document.getElementById('btn-save-username');
      const newUsername = document.getElementById('sec-new-username')?.value.trim();
      const currentPassword = document.getElementById('sec-username-confirm-pwd')?.value;

      if (!newUsername || !currentPassword) {
        showToast('Tutti i campi sono obbligatori', true);
        return;
      }

      if (btn) btn.disabled = true;
      try {
        const res = await fetch('/api/auth/change-credentials', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ newUsername, currentPassword })
        });
        const data = await res.json();
        if (data.success) {
          showToast(`✓ Username aggiornato con successo a "${data.user.username}"`);
          const disp = document.getElementById('sec-current-username-display');
          if (disp) disp.value = data.user.username;
          document.getElementById('sec-new-username').value = '';
          document.getElementById('sec-username-confirm-pwd').value = '';

          // Update sidebar username display if present
          const sbUser = document.getElementById('sidebar-username');
          if (sbUser) sbUser.textContent = data.user.username;

          loadSecurityDiagnostics();
        } else {
          showToast(data.error || 'Errore durante la modifica dello username', true);
        }
      } catch (err) {
        showToast('Errore di connessione', true);
      } finally {
        if (btn) btn.disabled = false;
      }
    });
  }

  // 2. Mobile: Change Username Form
  const uFormM = document.getElementById('form-change-username-m');
  if (uFormM) {
    uFormM.addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = document.getElementById('btn-save-username-m');
      const newUsername = document.getElementById('sec-new-username-m')?.value.trim();
      const currentPassword = document.getElementById('sec-username-confirm-pwd-m')?.value;

      if (!newUsername || !currentPassword) {
        showToast('Tutti i campi sono obbligatori', true);
        return;
      }

      if (btn) btn.disabled = true;
      try {
        const res = await fetch('/api/auth/change-credentials', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ newUsername, currentPassword })
        });
        const data = await res.json();
        if (data.success) {
          showToast(`✓ Username aggiornato: "${data.user.username}"`);
          const disp = document.getElementById('sec-current-username-display-m');
          if (disp) disp.value = data.user.username;
          document.getElementById('sec-new-username-m').value = '';
          document.getElementById('sec-username-confirm-pwd-m').value = '';
          loadSecurityDiagnostics();
        } else {
          showToast(data.error || 'Errore modifica username', true);
        }
      } catch (err) {
        showToast('Errore di connessione', true);
      } finally {
        if (btn) btn.disabled = false;
      }
    });
  }

  // 3. Desktop: Change Password Form
  const pForm = document.getElementById('form-change-password');
  if (pForm) {
    pForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = document.getElementById('btn-save-password');
      const currentPassword = document.getElementById('sec-current-pwd')?.value;
      const newPassword = document.getElementById('sec-new-pwd')?.value;
      const confirmPassword = document.getElementById('sec-confirm-pwd')?.value;

      if (!currentPassword || !newPassword || !confirmPassword) {
        showToast('Compila tutti i campi della password', true);
        return;
      }

      if (newPassword !== confirmPassword) {
        showToast('La nuova password e la conferma non coincidono', true);
        return;
      }

      if (newPassword.length < 8) {
        showToast('La nuova password deve contenere almeno 8 caratteri', true);
        return;
      }

      if (btn) btn.disabled = true;
      try {
        const res = await fetch('/api/auth/change-password', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ currentPassword, newPassword })
        });
        const data = await res.json();
        if (data.success) {
          showToast('✓ Password modificata con successo!');
          document.getElementById('sec-current-pwd').value = '';
          document.getElementById('sec-new-pwd').value = '';
          document.getElementById('sec-confirm-pwd').value = '';
          loadSecurityDiagnostics();
        } else {
          showToast(data.error || 'Errore modifica password', true);
        }
      } catch (err) {
        showToast('Errore di connessione', true);
      } finally {
        if (btn) btn.disabled = false;
      }
    });
  }

  // 4. Mobile: Change Password Form
  const pFormM = document.getElementById('form-change-password-m');
  if (pFormM) {
    pFormM.addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = document.getElementById('btn-save-password-m');
      const currentPassword = document.getElementById('sec-current-pwd-m')?.value;
      const newPassword = document.getElementById('sec-new-pwd-m')?.value;
      const confirmPassword = document.getElementById('sec-confirm-pwd-m')?.value;

      if (!currentPassword || !newPassword || !confirmPassword) {
        showToast('Compila tutti i campi', true);
        return;
      }

      if (newPassword !== confirmPassword) {
        showToast('Le password non coincidono', true);
        return;
      }

      if (newPassword.length < 8) {
        showToast('La password deve avere almeno 8 caratteri', true);
        return;
      }

      if (btn) btn.disabled = true;
      try {
        const res = await fetch('/api/auth/change-password', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ currentPassword, newPassword })
        });
        const data = await res.json();
        if (data.success) {
          showToast('✓ Password aggiornata!');
          document.getElementById('sec-current-pwd-m').value = '';
          document.getElementById('sec-new-pwd-m').value = '';
          document.getElementById('sec-confirm-pwd-m').value = '';
          loadSecurityDiagnostics();
        } else {
          showToast(data.error || 'Errore modifica password', true);
        }
      } catch (err) {
        showToast('Errore di connessione', true);
      } finally {
        if (btn) btn.disabled = false;
      }
    });
  }

  // 5. Revoke Other Sessions
  const revokeBtn = document.getElementById('btn-revoke-other-sessions');
  const revokeBtnM = document.getElementById('btn-revoke-other-sessions-m');
  const handleRevoke = async () => {
    if (!confirm('Sei sicuro di voler disconnettere tutte le altre sessioni attive?')) return;
    try {
      const res = await fetch('/api/auth/sessions', { method: 'DELETE' });
      const data = await res.json();
      if (data.success) {
        showToast('✓ Altre sessioni revocate con successo');
        loadActiveSessions();
        loadAuditLogs();
      } else {
        showToast(data.error || 'Errore revoca sessioni', true);
      }
    } catch {
      showToast('Errore di connessione', true);
    }
  };

  if (revokeBtn) revokeBtn.addEventListener('click', handleRevoke);
  if (revokeBtnM) revokeBtnM.addEventListener('click', handleRevoke);
}
