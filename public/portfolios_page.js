/**
 * FolioTrack Portfolios Page Controller
 * Manages Create, Read, Update, Delete for Portfolios and coordinates multi-portfolio views.
 */

let allPortfolios = [];

document.addEventListener('DOMContentLoaded', () => {
  loadPortfolios();

  document.getElementById('addPortfolioBtn')?.addEventListener('click', () => openPortfolioModal());
  document.getElementById('closePortfolioModalBtn')?.addEventListener('click', closePortfolioModal);
  document.getElementById('cancelPortfolioModalBtn')?.addEventListener('click', closePortfolioModal);
  document.getElementById('portfolioForm')?.addEventListener('submit', handleSavePortfolio);

  // Close modal when clicking on backdrop
  document.getElementById('portfolioModal')?.addEventListener('click', (e) => {
    if (e.target.id === 'portfolioModal') closePortfolioModal();
  });
});

function showToast(msg, isError = false) {
  const toast = document.createElement('div');
  toast.className = `fixed bottom-6 right-6 z-50 px-4 py-3 rounded-2xl shadow-xl border text-xs font-mono transition-all transform duration-300 ${
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

const fmtEur = (v) => '€ ' + Math.round(Number(v) || 0).toLocaleString('it-IT', {
  minimumFractionDigits: 0,
  maximumFractionDigits: 0
});

const fmtPct = (v) => {
  const n = Number(v) || 0;
  return (n >= 0 ? '+' : '') + n.toFixed(2) + '%';
};

/**
 * Loads portfolios from API and renders the cards.
 */
async function loadPortfolios() {
  const container = document.getElementById('portfolios-list');
  if (!container) return;

  try {
    const res = await fetch('/api/portfolios');
    const data = await res.json();
    if (!data.success) {
      container.innerHTML = `<div class="col-span-full text-center py-12 text-xs font-mono text-rose-500">Errore: ${data.error}</div>`;
      return;
    }

    allPortfolios = data.portfolios || [];

    if (allPortfolios.length === 0) {
      container.innerHTML = `
        <div class="col-span-full signature-card p-12 text-center text-xs font-mono text-gray-400 space-y-4">
          <p class="text-base font-bold text-gray-700 dark:text-gray-300">Nessun portafoglio configurato</p>
          <p>Crea il tuo primo portafoglio per iniziare a tracciare titoli, liquidità e movimenti.</p>
          <button onclick="openPortfolioModal()" class="btn-pill px-5 py-2.5 bg-emerald-600 text-white font-semibold shadow-md">
            + Crea Portafoglio Ora
          </button>
        </div>
      `;
      return;
    }

    container.innerHTML = allPortfolios.map(p => {
      const pnl = p.metrics?.unrealizedPnl || 0;
      const pnlPct = p.metrics?.unrealizedPnlPercent || 0;
      const isPos = pnl >= 0;
      const badgePnlClass = isPos ? 'badge-profit' : 'badge-loss';

      return `
        <div class="signature-card p-6 flex flex-col justify-between relative group hover:shadow-lg transition-all duration-200">
          <div>
            <!-- Card Header -->
            <div class="flex items-center justify-between gap-2">
              <div class="flex items-center space-x-2.5">
                <span class="w-3.5 h-3.5 rounded-full shrink-0 shadow-sm" style="background-color: ${p.color || '#4f6b92'};"></span>
                <span class="text-xs font-semibold px-2.5 py-0.5 rounded-full bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 font-mono">
                  ${p.type}
                </span>
                <span class="text-[10px] font-mono px-2 py-0.5 rounded-full bg-gray-100 dark:bg-white/5 text-gray-500 uppercase font-semibold">
                  ${p.currency}
                </span>
                <span class="text-[10px] font-mono px-2 py-0.5 rounded-full bg-gray-100 dark:bg-white/5 text-gray-400 uppercase">
                  ${p.costBasisMethod}
                </span>
              </div>
              
              <span class="text-[10px] font-mono ${p.include_in_totals ? 'text-emerald-500' : 'text-gray-400'}" title="${p.include_in_totals ? 'Incluso nel patrimonio globale' : 'Escluso dai totali globali'}">
                ${p.include_in_totals ? '● Totali' : '○ Isolato'}
              </span>
            </div>

            <!-- Title & Total Value -->
            <div class="mt-4">
              <h3 class="text-lg font-bold text-gray-900 dark:text-white tracking-tight">${p.name}</h3>
              <div class="mt-2 text-3xl font-bold font-mono text-gray-900 dark:text-white tabular-nums tracking-tight">
                ${fmtEur(p.totalValue)}
              </div>
            </div>

            <!-- P&L Badge -->
            <div class="mt-3 flex items-center space-x-2 text-xs font-mono">
              <span class="${badgePnlClass} tabular-nums">${fmtPct(pnlPct)}</span>
              <span class="text-gray-400 text-[11px] tabular-nums">${fmtEur(pnl)} non real.</span>
            </div>

            <!-- Metrics Breakdown Grid -->
            <div class="mt-5 pt-4 border-t border-gray-100 dark:border-white/5 grid grid-cols-2 gap-3 text-xs font-mono">
              <div>
                <span class="text-gray-400 text-[10px] uppercase block">Liquidità</span>
                <span class="font-bold text-gray-800 dark:text-gray-200 tabular-nums">${fmtEur(p.currentCash)}</span>
              </div>
              <div>
                <span class="text-gray-400 text-[10px] uppercase block">Versato</span>
                <span class="font-bold text-gray-800 dark:text-gray-200 tabular-nums">${fmtEur(p.investedCapital)}</span>
              </div>
              <div>
                <span class="text-gray-400 text-[10px] uppercase block">Asset Censiti</span>
                <span class="font-bold text-gray-800 dark:text-gray-200 tabular-nums">${p.assetCount} titoli</span>
              </div>
              <div>
                <span class="text-gray-400 text-[10px] uppercase block">Data Inizio</span>
                <span class="text-gray-600 dark:text-gray-400 tabular-nums">${p.startDate || '-'}</span>
              </div>
            </div>
          </div>

          <!-- Bottom Action Buttons -->
          <div class="mt-6 pt-4 border-t border-gray-100 dark:border-white/5 flex flex-wrap items-center justify-between gap-2 text-xs">
            <div class="flex items-center space-x-1.5">
              <a href="/portfolios/${p.id}" class="btn-pill px-3 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white font-medium inline-flex items-center space-x-1 shadow-sm" title="Scheda Dettaglio">
                <span>🔍 Dettaglio</span>
              </a>
              <a href="/transactions?portfolioId=${p.id}" class="btn-pill px-2 py-1.5 border border-gray-300 dark:border-white/10 text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-white/5 font-mono text-[11px]" title="Movimenti del portafoglio">
                📋 Movimenti
              </a>
              <a href="/history?portfolioId=${p.id}" class="btn-pill px-2 py-1.5 border border-gray-300 dark:border-white/10 text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-white/5 font-mono text-[11px]" title="Flussi & Fisco">
                📈 Flussi
              </a>
            </div>

            <div class="flex items-center space-x-1.5">
              <button onclick="openPortfolioModal(${p.id})" class="btn-pill px-2.5 py-1.5 border border-gray-300 dark:border-white/10 text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-white/5 inline-flex items-center space-x-1" title="Modifica dati portafoglio">
                <span>✏️</span>
              </button>
              <button onclick="deletePortfolio(${p.id}, '${escapeQuote(p.name)}')" class="btn-pill px-2.5 py-1.5 border border-rose-500/30 text-rose-600 hover:bg-rose-500/10 inline-flex items-center space-x-1" title="Elimina portafoglio e tutti i movimenti">
                <span>🗑️</span>
              </button>
            </div>
          </div>
        </div>
      `;
    }).join('');

  } catch (err) {
    container.innerHTML = `<div class="col-span-full text-center py-12 text-xs font-mono text-rose-500">Errore di rete: ${err.message}</div>`;
  }
}

function escapeQuote(str) {
  return String(str || '').replace(/'/g, "\\'").replace(/"/g, '&quot;');
}

/**
 * Opens the modal in create or edit mode.
 * @param {number} [portfolioId]
 */
function openPortfolioModal(portfolioId = null) {
  const modal = document.getElementById('portfolioModal');
  const title = document.getElementById('portfolioModalTitle');
  const form = document.getElementById('portfolioForm');
  if (!modal || !form) return;

  form.reset();
  document.getElementById('modalPortfolioId').value = portfolioId || '';

  if (portfolioId) {
    title.textContent = 'Modifica Portafoglio';
    const p = allPortfolios.find(x => x.id === portfolioId);
    if (p) {
      document.getElementById('modalPortfolioName').value = p.name || '';
      document.getElementById('modalPortfolioType').value = p.type || 'Investimento';
      document.getElementById('modalPortfolioCurrency').value = p.currency || 'EUR';
      document.getElementById('modalPortfolioCostBasis').value = p.costBasisMethod || 'WAC';
      document.getElementById('modalPortfolioStartDate').value = p.startDate || new Date().toISOString().split('T')[0];
      document.getElementById('modalPortfolioInitialCash').value = p.initialCash || 0;
      document.getElementById('modalPortfolioColor').value = p.color || '#4f6b92';
      document.getElementById('modalPortfolioIncludeTotals').checked = Boolean(p.include_in_totals);
    }
  } else {
    title.textContent = 'Nuovo Portafoglio';
    document.getElementById('modalPortfolioStartDate').value = new Date().toISOString().split('T')[0];
    document.getElementById('modalPortfolioInitialCash').value = 0;
    document.getElementById('modalPortfolioColor').value = '#4f6b92';
    document.getElementById('modalPortfolioIncludeTotals').checked = true;
  }

  modal.classList.remove('hidden');
}

function closePortfolioModal() {
  const modal = document.getElementById('portfolioModal');
  if (modal) modal.classList.add('hidden');
}

/**
 * Handles Form submission for Create and Edit.
 */
async function handleSavePortfolio(e) {
  e.preventDefault();
  const saveBtn = document.getElementById('savePortfolioBtn');
  if (saveBtn) saveBtn.disabled = true;

  const id = document.getElementById('modalPortfolioId').value;
  const isEdit = Boolean(id);

  const payload = {
    name: document.getElementById('modalPortfolioName').value.trim(),
    type: document.getElementById('modalPortfolioType').value,
    currency: document.getElementById('modalPortfolioCurrency').value,
    costBasisMethod: document.getElementById('modalPortfolioCostBasis').value,
    startDate: document.getElementById('modalPortfolioStartDate').value,
    initialCash: parseFloat(document.getElementById('modalPortfolioInitialCash').value) || 0,
    color: document.getElementById('modalPortfolioColor').value,
    include_in_totals: document.getElementById('modalPortfolioIncludeTotals').checked ? 1 : 0
  };

  try {
    const url = isEdit ? `/api/portfolios/${id}` : '/api/portfolios';
    const method = isEdit ? 'PUT' : 'POST';

    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const data = await res.json();
    if (!data.success) {
      showToast(data.error || 'Errore salvataggio portafoglio', true);
      return;
    }

    showToast(isEdit ? '✓ Portafoglio aggiornato con successo' : '✓ Nuovo portafoglio creato con successo');
    closePortfolioModal();
    loadPortfolios();
  } catch (err) {
    showToast('Errore di connessione: ' + err.message, true);
  } finally {
    if (saveBtn) saveBtn.disabled = false;
  }
}

/**
 * Deletes a portfolio and all associated transactions, projections and history.
 * @param {number} id 
 * @param {string} name 
 */
async function deletePortfolio(id, name) {
  const confirmation = confirm(`Sei sicuro di voler eliminare definitivamente il portafoglio "${name}"?\n\nATTENZIONE: verranno eliminati anche TUTTI i movimenti (transazioni), dividendi e snapshot storici associati.`);
  if (!confirmation) return;

  try {
    const res = await fetch(`/api/portfolios/${id}`, {
      method: 'DELETE'
    });

    const data = await res.json();
    if (!data.success) {
      showToast(data.error || 'Errore durante l\'eliminazione', true);
      return;
    }

    showToast(`✓ Portafoglio "${name}" e tutti i movimenti associati eliminati con successo`);
    loadPortfolios();
  } catch (err) {
    showToast('Errore di connessione: ' + err.message, true);
  }
}

window.openPortfolioModal = openPortfolioModal;
window.closePortfolioModal = closePortfolioModal;
window.deletePortfolio = deletePortfolio;
