/**
 * FolioTrack Bulk CSV Import Component (Wealthfolio Philosophy & Health Center)
 * Multi-level validation, chronological health checks, composite duplicate detection,
 * responsive viewport sizing (bounded to screen height), client-side pagination,
 * search filtering, selective import, and atomic database commit.
 */

(function () {
  let modalContainer = null;
  let selectedFile = null;
  let fileTextContent = null;
  let currentPortfolioId = null;
  let parsedPreviewData = null;
  let userPortfolios = [];
  let detectedHeaders = [];
  let userCustomMapping = null;

  // Wealthfolio Preview State & Pagination
  let activeFilter = 'ALL'; // 'ALL' | 'VALID' | 'WARNING' | 'DUPLICATE' | 'ERROR'
  let searchQuery = '';
  let currentPage = 1;
  let pageSize = 50; // default 50 rows per page
  const rowSelectionMap = new Map(); // originalIndex -> boolean

  const MAPPING_FIELDS = [
    { key: 'date', label: 'Data Transazione *', required: true, hints: ['data', 'date', 'giorno', 'valuta', 'date_time'] },
    { key: 'type', label: 'Tipo Movimento *', required: true, hints: ['tipo', 'type', 'operazione', 'causale', 'azione', 'segno', 'movimento'] },
    { key: 'ticker', label: 'Ticker / Simbolo / ISIN', required: false, hints: ['ticker', 'isin', 'simbolo', 'symbol', 'asset', 'titolo', 'codice'] },
    { key: 'quantity', label: 'Quantità / Azioni', required: false, hints: ['quantita', 'qta', 'quantity', 'qty', 'shares', 'quote', 'pezzi', 'vol'] },
    { key: 'price', label: 'Prezzo Unitario', required: false, hints: ['prezzo', 'price', 'unit_price', 'corso', 'valore_unitario'] },
    { key: 'amount', label: 'Importo Netto / Totale *', required: false, hints: ['importo', 'amount', 'totale', 'netto', 'controvalore', 'saldo', 'total'] },
    { key: 'commission', label: 'Commissioni / Spese', required: false, hints: ['commissioni', 'commission', 'spese', 'fee', 'fees', 'costi'] },
    { key: 'tax', label: 'Ritenuta / Imposta / Tobin', required: false, hints: ['ritenuta', 'imposta', 'tax', 'tasse', 'tobin', 'capital_gain'] },
    { key: 'exchangeRate', label: 'Tasso di Cambio (FX)', required: false, hints: ['cambio', 'fx', 'exchange_rate', 'rate', 'tasso'] },
    { key: 'portfolio', label: 'Portafoglio Destinazione', required: false, hints: ['portafoglio', 'portfolio', 'conto', 'deposito', 'account'] },
    { key: 'notes', label: 'Note / Descrizione', required: false, hints: ['note', 'descrizione', 'description', 'memo', 'causale_estesa'] }
  ];

  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function createModalHtml() {
    const div = document.createElement('div');
    div.id = 'bulk-import-modal-backdrop';
    div.className = 'fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-5 bg-black/60 backdrop-blur-sm hidden animate-fade-in';

    div.innerHTML = `
      <div id="bulk-import-card" class="signature-card w-full max-w-5xl h-[92vh] max-h-[92vh] flex flex-col overflow-hidden shadow-2xl border border-gray-200 dark:border-white/10 bg-white dark:bg-[#18181a]">
        <!-- Header (Fixed top) -->
        <div class="px-6 py-3.5 border-b border-gray-100 dark:border-white/5 flex items-center justify-between shrink-0">
          <div class="flex items-center space-x-2.5">
            <span class="w-3 h-3 rounded-full bg-blue-500 shadow-sm shadow-blue-500/40"></span>
            <div>
              <h3 class="text-base font-bold text-gray-900 dark:text-white">Importazione Movimenti da CSV</h3>
              <p class="text-xs text-gray-500 dark:text-gray-400">Directa SIM, Banca IFIS, Wealthfolio o personalizzato con Health Check</p>
            </div>
          </div>
          <button type="button" id="bulkImportCloseBtn" class="p-1.5 text-gray-400 hover:text-gray-700 dark:hover:text-white rounded-lg hover:bg-gray-100 dark:hover:bg-white/5 transition">
            <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <!-- Main Workspace (Flex column bounded to modal height) -->
        <div id="bulkImportMainArea" class="flex-1 overflow-y-auto p-4 sm:p-5 space-y-3.5 flex flex-col min-h-0">
          <!-- Step 1 & 2 Container (Upload view, collapsed once preview is active) -->
          <div id="uploadStepContainer" class="space-y-4 shrink-0">
            <!-- Configuration Bar -->
            <div class="grid grid-cols-1 sm:grid-cols-2 gap-4 bg-gray-50 dark:bg-white/5 p-4 rounded-xl border border-gray-200/60 dark:border-white/5">
              <div>
                <label for="bulkImportPortfolioSelect" class="block text-xs font-semibold uppercase tracking-wider text-gray-600 dark:text-gray-300">
                  Portafoglio di destinazione *
                </label>
                <select id="bulkImportPortfolioSelect" class="mt-1 block w-full px-3 py-2 rounded-xl border border-gray-300 dark:border-white/10 bg-white dark:bg-[#141416] text-gray-900 dark:text-white text-xs font-medium focus:ring-2 focus:ring-blue-500 focus:outline-none">
                  <option value="">Caricamento portafogli...</option>
                </select>
              </div>

              <div>
                <label for="bulkImportBrokerSelect" class="block text-xs font-semibold uppercase tracking-wider text-gray-600 dark:text-gray-300">
                  Formato Broker
                </label>
                <select id="bulkImportBrokerSelect" class="mt-1 block w-full px-3 py-2 rounded-xl border border-gray-300 dark:border-white/10 bg-white dark:bg-[#141416] text-gray-900 dark:text-white text-xs font-medium focus:ring-2 focus:ring-blue-500 focus:outline-none font-mono">
                  <option value="">Auto-Detect (Riconoscimento automatico)</option>
                  <option value="DIRECTA">Directa SIM</option>
                  <option value="BANCA_IFIS">Banca IFIS</option>
                  <option value="WEALTHFOLIO">Wealthfolio CSV</option>
                  <option value="CUSTOM">Mappatura Personalizzata Colonne</option>
                  <option value="GENERIC">Generico standard</option>
                </select>
              </div>
            </div>

            <!-- Portfolio Notice Banner -->
            <div id="noPortfolioNotice" class="hidden p-3 rounded-xl bg-blue-50 dark:bg-blue-950/40 border border-blue-200 dark:border-blue-800/40 text-blue-800 dark:text-blue-300 text-xs font-mono flex items-center justify-between">
              <div class="flex items-center space-x-2">
                <span>ℹ️</span>
                <span id="noPortfolioNoticeText">Nessuna colonna "Portafoglio" nel file CSV. Verrà utilizzato il portafoglio selezionato o predefinito.</span>
              </div>
              <span id="defaultPortBadge" class="hidden px-2 py-0.5 rounded-full text-[10px] bg-blue-200 text-blue-900 dark:bg-blue-800 dark:text-blue-100 font-bold uppercase">Predefinito</span>
            </div>

            <!-- Drag and Drop Area -->
            <div id="dropZone" class="border-2 border-dashed border-gray-300 dark:border-white/15 rounded-2xl p-6 text-center cursor-pointer transition hover:border-blue-500 dark:hover:border-blue-500/80 bg-gray-50/50 dark:bg-white/[0.02]">
              <input type="file" id="fileInput" accept=".csv,text/csv,text/plain" class="hidden">
              <div class="flex flex-col items-center justify-center space-y-2">
                <div class="w-10 h-10 rounded-full bg-blue-100 dark:bg-blue-900/30 flex items-center justify-center text-blue-600 dark:text-blue-400">
                  <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
                  </svg>
                </div>
                <p class="text-sm font-medium text-gray-800 dark:text-gray-200">
                  Trascina qui il file CSV, oppure <span class="text-blue-600 dark:text-blue-400 underline">sfoglia</span>
                </p>
                <p class="text-xs text-gray-500 dark:text-gray-400 font-mono">Supporta file anche con migliaia di righe, virgole o punti e virgola</p>
                <div id="selectedFileInfo" class="hidden mt-2 px-3 py-1 bg-blue-50 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300 rounded-full text-xs font-mono font-medium"></div>
              </div>
            </div>
          </div>

          <!-- Compact File Bar (Shown during preview to save vertical screen space) -->
          <div id="compactFileBar" class="hidden p-2.5 rounded-xl bg-gray-50 dark:bg-white/5 border border-gray-200/60 dark:border-white/10 flex flex-wrap items-center justify-between gap-3 text-xs font-mono shrink-0">
            <div class="flex items-center space-x-2">
              <span class="w-2.5 h-2.5 rounded-full bg-emerald-500"></span>
              <span id="compactFileName" class="font-bold text-gray-900 dark:text-white truncate max-w-xs">file.csv</span>
              <span id="compactFileSize" class="text-gray-500 text-[11px]">(0 KB)</span>
              <span class="text-gray-300 dark:text-white/20">•</span>
              <span id="compactPortfolioLabel" class="text-gray-600 dark:text-gray-400 truncate max-w-xs">Portafoglio</span>
            </div>
            <div class="flex items-center space-x-2">
              <button type="button" id="changeFileBtn" class="px-2.5 py-1 text-[11px] font-sans font-semibold rounded-lg bg-gray-200/70 dark:bg-white/10 hover:bg-gray-300 dark:hover:bg-white/15 text-gray-700 dark:text-gray-200 transition">
                📁 Cambia File
              </button>
            </div>
          </div>

          <!-- Alert / Loading box -->
          <div id="importAlertBox" class="hidden p-3 rounded-xl text-xs font-mono font-medium shrink-0"></div>

          <!-- Custom Column Remapping Accordion / Section -->
          <div id="customMappingSection" class="hidden rounded-xl border border-amber-500/30 bg-amber-500/5 p-4 space-y-4 shrink-0">
            <div class="flex items-center justify-between pb-2 border-b border-amber-500/20">
              <div class="flex items-center space-x-2">
                <span class="text-amber-500 text-base">🛠️</span>
                <div>
                  <h4 class="text-xs font-bold uppercase tracking-wider text-gray-900 dark:text-white">Associazione Colonne Personalizzata</h4>
                  <p class="text-[11px] text-gray-500 dark:text-gray-400 font-mono">Associa ciascuna colonna rilevata nel CSV al rispettivo campo richiesto</p>
                </div>
              </div>
              <button type="button" id="hideMappingSectionBtn" class="text-xs text-gray-400 hover:text-gray-600 dark:hover:text-white font-mono">
                ✕ Chiudi
              </button>
            </div>

            <!-- Dynamic Mappings Grid -->
            <div id="mappingFieldsGrid" class="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3 text-xs font-mono">
              <!-- Populated by JS -->
            </div>

            <div class="flex items-center justify-between pt-2">
              <span class="text-[11px] text-gray-500 font-mono">* I campi con asterisco sono essenziali per la registrazione.</span>
              <button type="button" id="applyMappingBtn" class="btn-pill px-4 py-2 bg-amber-600 hover:bg-amber-700 text-white text-xs font-bold shadow-sm shadow-amber-600/20 transition">
                ✓ Applica Mappatura & Rianalizza
              </button>
            </div>
          </div>

          <!-- Step 3: Interactive Preview Section (Flex-1 with auto-sizing) -->
          <div id="previewContainer" class="hidden flex-1 flex flex-col min-h-0 space-y-3">
            <!-- 4 Financial & Health Overview Cards -->
            <div class="grid grid-cols-2 sm:grid-cols-4 gap-2.5 text-xs font-mono shrink-0">
              <div class="p-2.5 rounded-xl bg-gray-50 dark:bg-white/5 border border-gray-200/60 dark:border-white/10">
                <span class="text-[10px] text-gray-500 uppercase tracking-wider block">Tracciato & Date</span>
                <div class="flex items-center justify-between mt-1">
                  <span id="detectedBrokerBadge" class="px-2 py-0.5 rounded-full text-xs font-bold font-mono bg-blue-100 text-blue-800 dark:bg-blue-900/50 dark:text-blue-200">-</span>
                  <span id="statDateRange" class="text-[11px] text-gray-500 font-sans truncate max-w-[110px]">-</span>
                </div>
              </div>

              <div class="p-2.5 rounded-xl bg-gray-50 dark:bg-white/5 border border-gray-200/60 dark:border-white/10">
                <span class="text-[10px] text-gray-500 uppercase tracking-wider block">Flusso Cassa Netto</span>
                <span id="statNetCashFlow" class="text-sm font-bold mt-1 block font-mono text-gray-900 dark:text-white">€ 0,00</span>
              </div>

              <div class="p-2.5 rounded-xl bg-gray-50 dark:bg-white/5 border border-gray-200/60 dark:border-white/10">
                <span class="text-[10px] text-gray-500 uppercase tracking-wider block">Capitale Investito</span>
                <span id="statInvestedCapital" class="text-sm font-bold mt-1 block font-mono text-gray-900 dark:text-white">€ 0,00</span>
              </div>

              <div class="p-2.5 rounded-xl bg-gray-50 dark:bg-white/5 border border-gray-200/60 dark:border-white/10">
                <span class="text-[10px] text-gray-500 uppercase tracking-wider block">Integrità & Salute</span>
                <span id="statHealthStatus" class="text-xs font-bold mt-1 block">Verifica in corso</span>
              </div>
            </div>

            <!-- Health Center Alert Banner -->
            <div id="healthCenterBanner" class="hidden p-3 rounded-xl bg-amber-500/10 border border-amber-500/30 text-amber-900 dark:text-amber-200 text-xs font-mono space-y-1 shrink-0">
              <div class="flex items-center space-x-2 font-bold text-amber-800 dark:text-amber-300">
                <span>🛡️ Wealthfolio Health Center: Segnalazioni di integrità cronologica</span>
              </div>
              <ul id="healthIssuesList" class="list-disc list-inside space-y-0.5 text-[11px] text-amber-700 dark:text-amber-300/90">
              </ul>
            </div>

            <!-- Filter Tabs & Quick Action Toolbar -->
            <div class="flex flex-wrap items-center justify-between gap-2 pt-1 border-b border-gray-100 dark:border-white/5 pb-2 shrink-0">
              <!-- Filter Tabs -->
              <div class="flex flex-wrap items-center gap-1.5" id="previewFilterTabs">
                <button type="button" data-filter="ALL" class="filter-tab px-2.5 py-1 rounded-lg text-xs font-semibold bg-blue-600 text-white shadow-sm transition">
                  Tutti (<span id="tabCountAll">0</span>)
                </button>
                <button type="button" data-filter="VALID" class="filter-tab px-2.5 py-1 rounded-lg text-xs font-semibold text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-white/5 transition">
                  Validi (<span id="tabCountValid">0</span>)
                </button>
                <button type="button" data-filter="WARNING" class="filter-tab px-2.5 py-1 rounded-lg text-xs font-semibold text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-white/5 transition">
                  Avvisi (<span id="tabCountWarning">0</span>)
                </button>
                <button type="button" data-filter="DUPLICATE" class="filter-tab px-2.5 py-1 rounded-lg text-xs font-semibold text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-white/5 transition">
                  Duplicati (<span id="tabCountDuplicate">0</span>)
                </button>
                <button type="button" data-filter="ERROR" class="filter-tab px-2.5 py-1 rounded-lg text-xs font-semibold text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-white/5 transition">
                  Errori (<span id="tabCountError">0</span>)
                </button>
              </div>

              <!-- Quick Search & Actions -->
              <div class="flex items-center space-x-2 text-[11px] font-mono">
                <!-- Text Search -->
                <div class="relative">
                  <input type="text" id="previewSearchInput" placeholder="Cerca ticker, note..."
                    class="w-32 sm:w-40 px-2.5 py-1 pl-6 rounded-lg border border-gray-300 dark:border-white/10 bg-white dark:bg-[#141416] text-gray-900 dark:text-white text-xs placeholder-gray-400 focus:outline-none focus:ring-1 focus:ring-blue-500">
                  <span class="absolute left-2 top-1.5 text-gray-400 text-[11px]">🔍</span>
                </div>

                <span id="selectedCountLabel" class="text-gray-500 dark:text-gray-400 mr-1 font-semibold hidden md:inline">0 selezionati</span>

                <button type="button" id="selectAllValidBtn" class="px-2.5 py-1 rounded-lg bg-gray-100 dark:bg-white/5 hover:bg-gray-200 dark:hover:bg-white/10 text-gray-700 dark:text-gray-300 transition">
                  Seleziona validi
                </button>
                <button type="button" id="deselectAllBtn" class="px-2.5 py-1 rounded-lg bg-gray-100 dark:bg-white/5 hover:bg-gray-200 dark:hover:bg-white/10 text-gray-700 dark:text-gray-300 transition">
                  Deseleziona
                </button>
                <button type="button" id="toggleManualMappingBtn" class="ml-1 text-blue-600 dark:text-blue-400 hover:underline">
                  🛠️ Rimappa
                </button>
              </div>
            </div>

            <!-- Preview Table Container (Auto-scrolls internally with sticky headers, never breaks screen height) -->
            <div id="previewTableContainer" class="flex-1 min-h-[200px] overflow-y-auto overflow-x-auto rounded-xl border border-gray-200/60 dark:border-white/10 bg-white dark:bg-[#141416] shadow-sm relative">
              <table class="min-w-full divide-y divide-gray-200 dark:divide-white/5 text-left text-xs font-mono">
                <thead class="bg-gray-100/95 dark:bg-[#1f1f23] text-gray-600 dark:text-gray-300 sticky top-0 z-20 backdrop-blur-sm shadow-sm">
                  <tr>
                    <th class="px-3 py-2 w-8 text-center bg-inherit">
                      <input type="checkbox" id="masterSelectCheckbox" class="rounded border-gray-300 text-blue-600 focus:ring-blue-500 cursor-pointer">
                    </th>
                    <th class="px-3 py-2 bg-inherit">Stato & Diagnostica</th>
                    <th class="px-3 py-2 bg-inherit">Data</th>
                    <th class="px-3 py-2 bg-inherit">Tipo</th>
                    <th class="px-3 py-2 bg-inherit">Ticker & Associazione</th>
                    <th class="px-3 py-2 text-right bg-inherit">Quantità</th>
                    <th class="px-3 py-2 text-right bg-inherit">Prezzo</th>
                    <th class="px-3 py-2 text-right bg-inherit">Importo</th>
                    <th class="px-3 py-2 bg-inherit">Note</th>
                  </tr>
                </thead>
                <tbody id="previewTableBody" class="divide-y divide-gray-200/50 dark:divide-white/5 tabular-nums">
                  <!-- Populated by JS -->
                </tbody>
              </table>
            </div>

            <!-- Pagination Toolbar (Dedicated bottom controls) -->
            <div id="previewPaginationBar" class="flex flex-wrap items-center justify-between gap-3 px-2 py-1 text-xs font-mono text-gray-500 dark:text-gray-400 shrink-0 border-t border-gray-100 dark:border-white/5">
              <div class="flex items-center space-x-3">
                <span id="paginationInfo">Mostrando 0 - 0 di 0 movimenti</span>
                <div class="flex items-center space-x-1">
                  <span>Righe:</span>
                  <select id="pageSizeSelect" class="px-2 py-0.5 rounded border border-gray-300 dark:border-white/10 bg-white dark:bg-[#18181a] text-gray-800 dark:text-gray-200 font-mono text-xs focus:outline-none">
                    <option value="25">25</option>
                    <option value="50" selected>50</option>
                    <option value="100">100</option>
                    <option value="200">200</option>
                    <option value="all">Tutte</option>
                  </select>
                </div>
              </div>

              <div class="flex items-center space-x-1" id="paginationControls">
                <button type="button" id="firstPageBtn" class="px-2 py-0.5 rounded bg-gray-100 dark:bg-white/5 hover:bg-gray-200 dark:hover:bg-white/10 text-gray-700 dark:text-gray-300 disabled:opacity-30 disabled:cursor-not-allowed">
                  «
                </button>
                <button type="button" id="prevPageBtn" class="px-2.5 py-0.5 rounded bg-gray-100 dark:bg-white/5 hover:bg-gray-200 dark:hover:bg-white/10 text-gray-700 dark:text-gray-300 disabled:opacity-30 disabled:cursor-not-allowed">
                  ‹ Precedente
                </button>
                <span class="px-2 text-gray-700 dark:text-gray-300 font-bold" id="pageIndicator">Pagina 1 di 1</span>
                <button type="button" id="nextPageBtn" class="px-2.5 py-0.5 rounded bg-gray-100 dark:bg-white/5 hover:bg-gray-200 dark:hover:bg-white/10 text-gray-700 dark:text-gray-300 disabled:opacity-30 disabled:cursor-not-allowed">
                  Successiva ›
                </button>
                <button type="button" id="lastPageBtn" class="px-2 py-0.5 rounded bg-gray-100 dark:bg-white/5 hover:bg-gray-200 dark:hover:bg-white/10 text-gray-700 dark:text-gray-300 disabled:opacity-30 disabled:cursor-not-allowed">
                  »
                </button>
              </div>
            </div>
          </div>
        </div>

        <!-- Footer Actions (Fixed bottom) -->
        <div class="px-6 py-3.5 bg-gray-50/80 dark:bg-[#141416] border-t border-gray-100 dark:border-white/5 flex items-center justify-between shrink-0">
          <button type="button" id="bulkImportResetBtn" class="btn-pill px-4 py-2 text-xs font-medium text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-white/10 transition">
            Annulla / Reset
          </button>
          <div class="flex items-center space-x-3">
            <button type="button" id="bulkImportCloseBtn2" class="btn-pill px-4 py-2 text-xs font-medium text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-white/10 transition">
              Chiudi
            </button>
            <button type="button" id="bulkImportSubmitBtn" disabled
              class="btn-pill px-5 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed text-white text-xs font-semibold transition shadow-md shadow-blue-600/20">
              Conferma Importazione
            </button>
          </div>
        </div>
      </div>
    `;

    document.body.appendChild(div);
    return div;
  }

  async function loadUserPortfolios(defaultId = null) {
    try {
      const res = await fetch('/api/portfolios');
      const data = await res.json();
      if (data.success && data.portfolios) {
        userPortfolios = data.portfolios;
        const select = document.getElementById('bulkImportPortfolioSelect');
        if (select) {
          select.innerHTML = userPortfolios.map(p => `
            <option value="${p.id}" ${defaultId && Number(defaultId) === Number(p.id) ? 'selected' : (p.is_default ? 'selected' : '')}>
              ${escapeHtml(p.name)} (${escapeHtml(p.currency)}) ${p.is_default ? '★ Default' : ''}
            </option>
          `).join('');

          if (userPortfolios.length > 0 && !defaultId) {
            const def = userPortfolios.find(p => p.is_default);
            currentPortfolioId = def ? def.id : userPortfolios[0].id;
          } else if (defaultId) {
            currentPortfolioId = defaultId;
          }
        }
      }
    } catch (err) {
      console.warn('Error loading portfolios in bulk import:', err);
    }
  }

  function showAlert(msg, type = 'error') {
    const alert = document.getElementById('importAlertBox');
    if (!alert) return;
    alert.classList.remove('hidden', 'bg-red-50', 'text-red-700', 'border-red-200', 'bg-emerald-50', 'text-emerald-700', 'border-emerald-200', 'bg-blue-50', 'text-blue-700', 'bg-amber-50', 'text-amber-700');

    if (type === 'error') {
      alert.className = 'p-3 rounded-xl text-xs font-mono font-medium bg-red-50 text-red-700 dark:bg-red-950/40 dark:text-red-300 border border-red-200 dark:border-red-800/40 shrink-0';
    } else if (type === 'success') {
      alert.className = 'p-3 rounded-xl text-xs font-mono font-medium bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-800/40 shrink-0';
    } else if (type === 'warning') {
      alert.className = 'p-3 rounded-xl text-xs font-mono font-medium bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300 border border-amber-200 dark:border-amber-800/40 shrink-0';
    } else {
      alert.className = 'p-3 rounded-xl text-xs font-mono font-medium bg-blue-50 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300 border border-blue-200 dark:border-blue-800/40 shrink-0';
    }

    alert.textContent = msg;
    alert.classList.remove('hidden');
  }

  function hideAlert() {
    const alert = document.getElementById('importAlertBox');
    if (alert) alert.classList.add('hidden');
  }

  function renderColumnMappingUI(headers = [], existingMapping = {}) {
    detectedHeaders = headers;
    const grid = document.getElementById('mappingFieldsGrid');
    const section = document.getElementById('customMappingSection');
    if (!grid || !section) return;

    if (headers.length === 0) {
      grid.innerHTML = '<p class="col-span-full text-gray-400">Nessuna colonna rilevata nel file CSV.</p>';
      return;
    }

    const normHeaders = headers.map(h => ({
      raw: h,
      norm: h.toLowerCase().replace(/[^a-z0-9]/g, '_')
    }));

    grid.innerHTML = MAPPING_FIELDS.map(field => {
      let selectedHeader = existingMapping[field.key] || '';

      // Auto-match if not already set
      if (!selectedHeader) {
        for (const hint of field.hints) {
          const match = normHeaders.find(nh => nh.norm.includes(hint));
          if (match) {
            selectedHeader = match.raw;
            break;
          }
        }
      }

      return `
        <div class="space-y-1">
          <label class="block text-[11px] font-semibold text-gray-700 dark:text-gray-300">
            ${field.label}
          </label>
          <select id="map-select-${field.key}" class="w-full px-2.5 py-1.5 rounded-lg border border-gray-300 dark:border-white/10 bg-white dark:bg-[#141416] text-gray-900 dark:text-white text-xs font-mono">
            <option value="">-- Non presente / Ignora --</option>
            ${headers.map(h => `
              <option value="${escapeHtml(h)}" ${h === selectedHeader ? 'selected' : ''}>
                ${escapeHtml(h)}
              </option>
            `).join('')}
          </select>
        </div>
      `;
    }).join('');

    section.classList.remove('hidden');
  }

  function getSelectedCustomMapping() {
    const mapping = {};
    for (const field of MAPPING_FIELDS) {
      const select = document.getElementById(`map-select-${field.key}`);
      if (select && select.value) {
        mapping[field.key] = select.value;
      }
    }
    return mapping;
  }

  function updateSelectionCounts() {
    if (!parsedPreviewData || !parsedPreviewData.transactions) return;

    const allTx = parsedPreviewData.transactions;
    let selectedCount = 0;
    let importableCount = 0;

    allTx.forEach((t, idx) => {
      const rowIdx = t.originalIndex !== undefined ? t.originalIndex : idx;
      if (t.validationStatus !== 'ERROR') {
        importableCount++;
        if (rowSelectionMap.get(rowIdx)) {
          selectedCount++;
        }
      }
    });

    const countLabel = document.getElementById('selectedCountLabel');
    if (countLabel) {
      countLabel.textContent = `${selectedCount} di ${importableCount} selezionati`;
    }

    const submitBtn = document.getElementById('bulkImportSubmitBtn');
    if (submitBtn) {
      if (selectedCount > 0) {
        submitBtn.disabled = false;
        submitBtn.textContent = `Importa ${selectedCount} Movimenti Selezionati`;
      } else {
        submitBtn.disabled = true;
        submitBtn.textContent = 'Nessun movimento selezionato';
      }
    }

    // Update master checkbox state for currently displayed rows
    const masterCb = document.getElementById('masterSelectCheckbox');
    if (masterCb) {
      const matchingTx = getFilteredTransactions();
      const selectableMatching = matchingTx.filter(t => t.validationStatus !== 'ERROR');
      if (selectableMatching.length === 0) {
        masterCb.checked = false;
        masterCb.indeterminate = false;
      } else {
        const checkedCount = selectableMatching.filter(t => {
          const rowIdx = t.originalIndex !== undefined ? t.originalIndex : 0;
          return !!rowSelectionMap.get(rowIdx);
        }).length;

        if (checkedCount === selectableMatching.length) {
          masterCb.checked = true;
          masterCb.indeterminate = false;
        } else if (checkedCount === 0) {
          masterCb.checked = false;
          masterCb.indeterminate = false;
        } else {
          masterCb.checked = false;
          masterCb.indeterminate = true;
        }
      }
    }
  }

  function getFilteredTransactions() {
    if (!parsedPreviewData || !parsedPreviewData.transactions) return [];

    let txs = parsedPreviewData.transactions;

    // 1. Filter by Status Tab
    if (activeFilter === 'VALID') {
      txs = txs.filter(t => t.validationStatus === 'VALID');
    } else if (activeFilter === 'WARNING') {
      txs = txs.filter(t => t.validationStatus === 'WARNING');
    } else if (activeFilter === 'DUPLICATE') {
      txs = txs.filter(t => t.validationStatus === 'DUPLICATE' || t.isDuplicate);
    } else if (activeFilter === 'ERROR') {
      txs = txs.filter(t => t.validationStatus === 'ERROR');
    }

    // 2. Filter by search query
    if (searchQuery) {
      const q = searchQuery.toLowerCase().trim();
      txs = txs.filter(t => {
        const sym = (t.assetTicker || '').toLowerCase();
        const notes = (t.notes || '').toLowerCase();
        const date = (t.date || '').toLowerCase();
        const type = (t.type || '').toLowerCase();
        const issues = (t.issues || []).map(i => i.message.toLowerCase()).join(' ');
        return sym.includes(q) || notes.includes(q) || date.includes(q) || type.includes(q) || issues.includes(q);
      });
    }

    return txs;
  }

  function renderTableRows() {
    const tbody = document.getElementById('previewTableBody');
    if (!tbody || !parsedPreviewData) return;

    const matchingTx = getFilteredTransactions();
    const totalMatching = matchingTx.length;
    const fmtNum = (v) => (Number(v) || 0).toLocaleString('it-IT', { minimumFractionDigits: 2, maximumFractionDigits: 4 });

    // Pagination calculations
    const effectivePageSize = pageSize === 'all' ? Math.max(totalMatching, 1) : Number(pageSize);
    const totalPages = Math.max(1, Math.ceil(totalMatching / effectivePageSize));

    if (currentPage > totalPages) currentPage = totalPages;
    if (currentPage < 1) currentPage = 1;

    const startIndex = (currentPage - 1) * effectivePageSize;
    const endIndex = pageSize === 'all' ? totalMatching : Math.min(startIndex + effectivePageSize, totalMatching);
    const pageRows = matchingTx.slice(startIndex, endIndex);

    // Update Pagination Toolbar
    const paginationInfo = document.getElementById('paginationInfo');
    const pageIndicator = document.getElementById('pageIndicator');
    const firstBtn = document.getElementById('firstPageBtn');
    const prevBtn = document.getElementById('prevPageBtn');
    const nextBtn = document.getElementById('nextPageBtn');
    const lastBtn = document.getElementById('lastPageBtn');

    if (paginationInfo) {
      if (totalMatching === 0) {
        paginationInfo.textContent = 'Mostrando 0 movimenti';
      } else {
        paginationInfo.textContent = `Mostrando ${startIndex + 1} - ${endIndex} di ${totalMatching} movimenti`;
      }
    }

    if (pageIndicator) {
      pageIndicator.textContent = `Pagina ${currentPage} di ${totalPages}`;
    }

    if (firstBtn) firstBtn.disabled = currentPage <= 1;
    if (prevBtn) prevBtn.disabled = currentPage <= 1;
    if (nextBtn) nextBtn.disabled = currentPage >= totalPages;
    if (lastBtn) lastBtn.disabled = currentPage >= totalPages;

    if (pageRows.length === 0) {
      tbody.innerHTML = `
        <tr>
          <td colspan="9" class="px-4 py-8 text-center text-gray-400 font-mono text-xs">
            Nessun movimento trovato con i filtri applicati.
          </td>
        </tr>
      `;
      updateSelectionCounts();
      return;
    }

    tbody.innerHTML = pageRows.map(t => {
      const rowIdx = t.originalIndex !== undefined ? t.originalIndex : 0;
      const isChecked = !!rowSelectionMap.get(rowIdx);
      const isError = t.validationStatus === 'ERROR';

      // Status Badge
      let statusBadge = '';
      let rowBg = '';

      if (t.validationStatus === 'VALID') {
        statusBadge = '<span class="px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-100 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300">✓ Valido</span>';
      } else if (t.validationStatus === 'WARNING') {
        const primaryCode = t.issues?.find(i => i.severity === 'warning')?.code || 'AVVISO';
        let warnText = 'Avviso';
        if (primaryCode === 'NEGATIVE_CASH') warnText = 'Cassa negativa';
        else if (primaryCode === 'INSUFFICIENT_HOLDINGS') warnText = 'Scoperto';
        else if (primaryCode === 'FUTURE_DATE') warnText = 'Data futura';
        else if (primaryCode === 'HIGH_COMMISSION') warnText = 'Spese >15%';
        else if (primaryCode === 'MISSING_FX_RATE') warnText = 'Cambio FX';

        statusBadge = `<span class="px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300" title="${escapeHtml(t.issues?.map(i => i.message).join(' | ') || '')}">⚠️ ${warnText}</span>`;
        rowBg = 'bg-amber-50/20 dark:bg-amber-950/10';
      } else if (t.validationStatus === 'DUPLICATE' || t.isDuplicate) {
        statusBadge = `<span class="px-2 py-0.5 rounded-full text-[10px] font-bold bg-purple-100 text-purple-800 dark:bg-purple-950/60 dark:text-purple-300">🔁 Duplicato #${t.duplicateId || ''}</span>`;
        rowBg = 'bg-purple-50/20 dark:bg-purple-950/10 opacity-75';
      } else if (isError) {
        statusBadge = `<span class="px-2 py-0.5 rounded-full text-[10px] font-bold bg-rose-100 text-rose-800 dark:bg-rose-950/60 dark:text-rose-300" title="${escapeHtml(t.issues?.map(i => i.message).join(' | ') || '')}">❌ Errore</span>`;
        rowBg = 'bg-rose-50/30 dark:bg-rose-950/20';
      }

      // Asset Association Badge
      let assetBadge = '';
      if (t.assetTicker) {
        if (t.assetTicker === 'CASH' || t.assetTicker.startsWith('$CASH')) {
          assetBadge = `<span class="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-gray-100 text-gray-700 dark:bg-white/10 dark:text-gray-300">Liquidità</span>`;
        } else if (t.assetMatch) {
          if (t.assetMatch.source === 'INTERNAL') {
            assetBadge = `<span class="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-blue-100 text-blue-800 dark:bg-blue-900/50 dark:text-blue-300" title="Titolo presente nel catalogo interno">Interno (${escapeHtml(t.assetMatch.name || t.assetTicker)})</span>`;
          } else if (t.assetMatch.source === 'PROVIDER') {
            const pName = t.assetMatch.provider || 'Provider';
            assetBadge = `<span class="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-purple-100 text-purple-800 dark:bg-purple-900/50 dark:text-purple-300" title="Titolo verificato e quotato tramite provider ${pName}">${pName} (${escapeHtml(t.assetMatch.name || t.assetTicker)})</span>`;
          } else {
            assetBadge = `<span class="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-gray-100 text-gray-700 dark:bg-white/10 dark:text-gray-300" title="Titolo non presente sui provider online - creazione manuale">Manuale</span>`;
          }
        }
      } else if (['DEPOSIT', 'WITHDRAWAL', 'TRANSFER'].includes(t.type)) {
        assetBadge = `<span class="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-gray-100 text-gray-700 dark:bg-white/10 dark:text-gray-300">Conto Liquidità</span>`;
      }

      // Issues sub-line
      let issuesHtml = '';
      if (t.issues && t.issues.length > 0) {
        issuesHtml = `<div class="text-[10px] text-amber-600 dark:text-amber-400 mt-0.5 leading-tight">${t.issues.map(i => escapeHtml(i.message)).join('<br>')}</div>`;
      }

      return `
        <tr class="hover:bg-gray-50/50 dark:hover:bg-white/5 transition ${rowBg}">
          <td class="px-3 py-2 text-center">
            <input type="checkbox"
              class="import-row-checkbox rounded border-gray-300 text-blue-600 focus:ring-blue-500 cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed"
              data-idx="${rowIdx}"
              ${isChecked ? 'checked' : ''}
              ${isError ? 'disabled title="Movimento non importabile a causa di errori bloccanti"' : ''}>
          </td>
          <td class="px-3 py-2 whitespace-nowrap">
            ${statusBadge}
            ${issuesHtml}
          </td>
          <td class="px-3 py-2 whitespace-nowrap text-gray-500">${t.date || '-'}</td>
          <td class="px-3 py-2 whitespace-nowrap"><span class="font-bold">${t.type || '-'}</span></td>
          <td class="px-3 py-2 whitespace-nowrap">
            <span class="font-semibold text-gray-900 dark:text-white mr-1.5">${t.assetTicker || '-'}</span>
            ${assetBadge}
          </td>
          <td class="px-3 py-2 text-right">${t.quantity ? fmtNum(t.quantity) : '-'}</td>
          <td class="px-3 py-2 text-right">${t.price ? fmtNum(t.price) : '-'}</td>
          <td class="px-3 py-2 text-right font-bold text-gray-900 dark:text-white">€ ${fmtNum(t.amount)}</td>
          <td class="px-3 py-2 text-gray-500 truncate max-w-xs" title="${escapeHtml(t.notes || '')}">${escapeHtml(t.notes || '-')}</td>
        </tr>
      `;
    }).join('');

    // Attach row checkbox change listeners
    tbody.querySelectorAll('.import-row-checkbox').forEach(cb => {
      cb.addEventListener('change', (e) => {
        const idx = Number(e.target.getAttribute('data-idx'));
        rowSelectionMap.set(idx, e.target.checked);
        updateSelectionCounts();
      });
    });

    updateSelectionCounts();
  }

  function renderPreview(data) {
    parsedPreviewData = data;
    currentPage = 1;

    const container = document.getElementById('previewContainer');
    const uploadContainer = document.getElementById('uploadStepContainer');
    const compactBar = document.getElementById('compactFileBar');
    const compactName = document.getElementById('compactFileName');
    const compactSize = document.getElementById('compactFileSize');
    const compactPort = document.getElementById('compactPortfolioLabel');

    const badge = document.getElementById('detectedBrokerBadge');
    const statDateRange = document.getElementById('statDateRange');
    const statNetCash = document.getElementById('statNetCashFlow');
    const statInvested = document.getElementById('statInvestedCapital');
    const statHealth = document.getElementById('statHealthStatus');
    const healthBanner = document.getElementById('healthCenterBanner');
    const healthList = document.getElementById('healthIssuesList');
    const portfolioNotice = document.getElementById('noPortfolioNotice');
    const portfolioNoticeText = document.getElementById('noPortfolioNoticeText');
    const defaultBadge = document.getElementById('defaultPortBadge');

    badge.textContent = data.detectedBroker || 'GENERIC';

    // Show compact file bar and hide upload drag zone to maximize table workspace
    if (uploadContainer) uploadContainer.classList.add('hidden');
    if (compactBar) {
      if (selectedFile) {
        compactName.textContent = selectedFile.name;
        compactSize.textContent = `(${(selectedFile.size / 1024).toFixed(1)} KB)`;
      } else {
        compactName.textContent = 'Tracciato CSV inserito';
        compactSize.textContent = `(${data.totalRows || 0} righe)`;
      }

      const portSelect = document.getElementById('bulkImportPortfolioSelect');
      const selName = portSelect ? portSelect.options[portSelect.selectedIndex]?.text || '' : '';
      compactPort.textContent = `Portafoglio: ${selName}`;
      compactBar.classList.remove('hidden');
    }

    const summary = data.summary || {};
    const fmtNum = (v) => (Number(v) || 0).toLocaleString('it-IT', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

    // Date Range
    if (summary.dateRange && summary.dateRange.start) {
      statDateRange.textContent = `${summary.dateRange.start} → ${summary.dateRange.end}`;
      statDateRange.title = `Intervallo: da ${summary.dateRange.start} a ${summary.dateRange.end}`;
    } else {
      statDateRange.textContent = `${data.totalRows || 0} righe`;
    }

    // Net Cash Flow
    const netFlow = Number(summary.estimatedNetCashFlow) || 0;
    const flowSign = netFlow > 0 ? '+' : (netFlow < 0 ? '-' : '');
    statNetCash.textContent = `${flowSign}€ ${fmtNum(Math.abs(netFlow))}`;
    if (netFlow > 0) {
      statNetCash.className = 'text-sm font-bold mt-1 block font-mono text-emerald-600 dark:text-emerald-400';
    } else if (netFlow < 0) {
      statNetCash.className = 'text-sm font-bold mt-1 block font-mono text-blue-600 dark:text-blue-400';
    } else {
      statNetCash.className = 'text-sm font-bold mt-1 block font-mono text-gray-900 dark:text-white';
    }

    // Invested Capital
    const invested = Number(summary.estimatedTotalInvestment) || 0;
    statInvested.textContent = `€ ${fmtNum(invested)}`;
    if (summary.affectedTickers && summary.affectedTickers.length > 0) {
      statInvested.title = `Titoli: ${summary.affectedTickers.join(', ')}`;
    }

    // Health Center Status
    if (summary.healthIssues && summary.healthIssues.length > 0) {
      statHealth.innerHTML = `<span class="text-amber-600 dark:text-amber-400">⚠️ ${summary.healthIssues.length} avvisi integrità</span>`;
      healthList.innerHTML = summary.healthIssues.map(issue => `<li>${escapeHtml(issue)}</li>`).join('');
      healthBanner.classList.remove('hidden');
    } else if (summary.errorCount > 0) {
      statHealth.innerHTML = `<span class="text-rose-600 dark:text-rose-400">❌ ${summary.errorCount} errori bloccanti</span>`;
      healthBanner.classList.add('hidden');
    } else {
      statHealth.innerHTML = `<span class="text-emerald-600 dark:text-emerald-400">✓ Controlli superati</span>`;
      healthBanner.classList.add('hidden');
    }

    // Tab counts
    const totalCount = data.transactions ? data.transactions.length : (data.totalRows || 0);
    const validCount = summary.validCount !== undefined ? summary.validCount : (data.newCount || 0);
    const warningCount = summary.warningCount || 0;
    const duplicateCount = summary.duplicateCount !== undefined ? summary.duplicateCount : (data.duplicateCount || 0);
    const errorCount = summary.errorCount || 0;

    document.getElementById('tabCountAll').textContent = totalCount;
    document.getElementById('tabCountValid').textContent = validCount;
    document.getElementById('tabCountWarning').textContent = warningCount;
    document.getElementById('tabCountDuplicate').textContent = duplicateCount;
    document.getElementById('tabCountError').textContent = errorCount;

    // Reset selection map: valid and warning rows checked by default, duplicates/errors unchecked
    rowSelectionMap.clear();
    (data.transactions || []).forEach((t, idx) => {
      const rowIdx = t.originalIndex !== undefined ? t.originalIndex : idx;
      const canImport = t.canImport !== undefined ? t.canImport : (!t.isDuplicate && t.validationStatus !== 'ERROR');
      rowSelectionMap.set(rowIdx, canImport);
    });

    // Default portfolio proposal notice
    if (portfolioNotice) {
      if (data.hasPortfolioColumn === false) {
        portfolioNotice.classList.remove('hidden');
        const portSelect = document.getElementById('bulkImportPortfolioSelect');
        const selName = portSelect ? portSelect.options[portSelect.selectedIndex]?.text || '' : '';
        portfolioNoticeText.textContent = `Nessuna colonna "Portafoglio" nel file CSV: tutti i movimenti verranno associati a "${selName}".`;
        if (data.defaultPortfolioProposed) {
          defaultBadge?.classList.remove('hidden');
        } else {
          defaultBadge?.classList.add('hidden');
        }
      } else {
        portfolioNotice.classList.add('hidden');
      }
    }

    container.classList.remove('hidden');
    renderTableRows();
  }

  async function processPreview(overrideMapping = null) {
    if (!selectedFile && !fileTextContent) return;

    let pId = document.getElementById('bulkImportPortfolioSelect').value;
    const broker = document.getElementById('bulkImportBrokerSelect').value;

    hideAlert();
    showAlert('Analisi file CSV e verifica salute movimenti (Wealthfolio Engine)...', 'info');

    try {
      const formData = new FormData();
      if (pId) formData.append('portfolioId', pId);
      formData.append('preview', 'true');
      if (broker) formData.append('broker', broker);

      if (overrideMapping) {
        userCustomMapping = overrideMapping;
        formData.append('customMapping', JSON.stringify(overrideMapping));
      } else if (userCustomMapping) {
        formData.append('customMapping', JSON.stringify(userCustomMapping));
      }

      if (selectedFile) {
        formData.append('file', selectedFile);
      } else {
        formData.append('csvText', fileTextContent);
      }

      const res = await fetch('/api/transactions/import-csv', {
        method: 'POST',
        body: formData
      });

      const data = await res.json();

      // If remapping is needed or parsing failed
      if (data.needsMapping || (!res.ok && data.headers && data.headers.length > 0)) {
        showAlert(data.error || 'Formato CSV non riconosciuto automaticamente. Associa le colonne manualmente qui sotto.', 'warning');
        renderColumnMappingUI(data.headers || [], userCustomMapping || {});
        return;
      }

      if (!res.ok || !data.success) {
        showAlert(data.error || 'Errore durante la lettura del CSV.');
        return;
      }

      // If server proposed a default portfolio
      if (data.defaultPortfolio && !pId) {
        const select = document.getElementById('bulkImportPortfolioSelect');
        if (select) select.value = data.defaultPortfolio.id;
      }

      hideAlert();
      renderPreview(data);

      if (data.headers && data.headers.length > 0) {
        detectedHeaders = data.headers;
      }
    } catch (err) {
      showAlert('Errore di comunicazione: ' + err.message);
    }
  }

  function handleFileSelected(file) {
    if (!file) return;
    selectedFile = file;
    const info = document.getElementById('selectedFileInfo');
    info.textContent = `File: ${file.name} (${(file.size / 1024).toFixed(1)} KB)`;
    info.classList.remove('hidden');

    const reader = new FileReader();
    reader.onload = (e) => {
      fileTextContent = e.target.result;
      processPreview();
    };
    reader.readAsText(file);
  }

  function setupEvents() {
    const dropZone = document.getElementById('dropZone');
    const fileInput = document.getElementById('fileInput');

    dropZone.addEventListener('click', () => fileInput.click());

    fileInput.addEventListener('change', (e) => {
      if (e.target.files && e.target.files[0]) {
        handleFileSelected(e.target.files[0]);
      }
    });

    ['dragenter', 'dragover'].forEach(name => {
      dropZone.addEventListener(name, (e) => {
        e.preventDefault();
        dropZone.classList.add('border-blue-500', 'bg-blue-50/30', 'dark:bg-blue-900/20');
      });
    });

    ['dragleave', 'drop'].forEach(name => {
      dropZone.addEventListener(name, (e) => {
        e.preventDefault();
        dropZone.classList.remove('border-blue-500', 'bg-blue-50/30', 'dark:bg-blue-900/20');
      });
    });

    dropZone.addEventListener('drop', (e) => {
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]) {
        handleFileSelected(e.dataTransfer.files[0]);
      }
    });

    document.getElementById('bulkImportPortfolioSelect').addEventListener('change', () => {
      if (selectedFile || fileTextContent) processPreview();
    });

    document.getElementById('bulkImportBrokerSelect').addEventListener('change', (e) => {
      if (e.target.value === 'CUSTOM') {
        renderColumnMappingUI(detectedHeaders, userCustomMapping || {});
      }
      if (selectedFile || fileTextContent) processPreview();
    });

    // Cambia file button from compact bar
    document.getElementById('changeFileBtn')?.addEventListener('click', () => {
      document.getElementById('compactFileBar')?.classList.add('hidden');
      document.getElementById('previewContainer')?.classList.add('hidden');
      document.getElementById('uploadStepContainer')?.classList.remove('hidden');
      fileInput.click();
    });

    // Custom Mapping UI toggle & submit
    document.getElementById('toggleManualMappingBtn')?.addEventListener('click', () => {
      renderColumnMappingUI(detectedHeaders, userCustomMapping || {});
    });

    document.getElementById('hideMappingSectionBtn')?.addEventListener('click', () => {
      document.getElementById('customMappingSection')?.classList.add('hidden');
    });

    document.getElementById('applyMappingBtn')?.addEventListener('click', () => {
      const mapping = getSelectedCustomMapping();
      if (!mapping.date && !mapping.type) {
        showAlert('Attenzione: associa almeno le colonne Data e Tipo Operazione per procedere.', 'warning');
        return;
      }
      userCustomMapping = mapping;
      processPreview(mapping);
    });

    // Search input filtering
    document.getElementById('previewSearchInput')?.addEventListener('input', (e) => {
      searchQuery = e.target.value || '';
      currentPage = 1;
      renderTableRows();
    });

    // Page size selection
    document.getElementById('pageSizeSelect')?.addEventListener('change', (e) => {
      pageSize = e.target.value === 'all' ? 'all' : Number(e.target.value);
      currentPage = 1;
      renderTableRows();
    });

    // Pagination controls
    document.getElementById('firstPageBtn')?.addEventListener('click', () => {
      currentPage = 1;
      renderTableRows();
    });
    document.getElementById('prevPageBtn')?.addEventListener('click', () => {
      if (currentPage > 1) {
        currentPage--;
        renderTableRows();
      }
    });
    document.getElementById('nextPageBtn')?.addEventListener('click', () => {
      const matching = getFilteredTransactions();
      const effectivePageSize = pageSize === 'all' ? matching.length : Number(pageSize);
      const totalPages = Math.ceil(matching.length / effectivePageSize);
      if (currentPage < totalPages) {
        currentPage++;
        renderTableRows();
      }
    });
    document.getElementById('lastPageBtn')?.addEventListener('click', () => {
      const matching = getFilteredTransactions();
      const effectivePageSize = pageSize === 'all' ? matching.length : Number(pageSize);
      currentPage = Math.max(1, Math.ceil(matching.length / effectivePageSize));
      renderTableRows();
    });

    // Filter Tabs Click Listeners
    const filterTabsContainer = document.getElementById('previewFilterTabs');
    if (filterTabsContainer) {
      filterTabsContainer.querySelectorAll('.filter-tab').forEach(tab => {
        tab.addEventListener('click', () => {
          activeFilter = tab.getAttribute('data-filter') || 'ALL';
          currentPage = 1;
          // Update active styles
          filterTabsContainer.querySelectorAll('.filter-tab').forEach(t => {
            t.className = 'filter-tab px-2.5 py-1 rounded-lg text-xs font-semibold text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-white/5 transition';
          });
          tab.className = 'filter-tab px-2.5 py-1 rounded-lg text-xs font-semibold bg-blue-600 text-white shadow-sm transition';
          renderTableRows();
        });
      });
    }

    // Master Checkbox Toggle (operates on current matching rows)
    const masterCb = document.getElementById('masterSelectCheckbox');
    if (masterCb) {
      masterCb.addEventListener('change', (e) => {
        const matchingTx = getFilteredTransactions();
        matchingTx.forEach(t => {
          if (t.validationStatus !== 'ERROR') {
            const rowIdx = t.originalIndex !== undefined ? t.originalIndex : 0;
            rowSelectionMap.set(rowIdx, e.target.checked);
          }
        });
        renderTableRows();
      });
    }

    // Select All Valid Button
    document.getElementById('selectAllValidBtn')?.addEventListener('click', () => {
      if (!parsedPreviewData || !parsedPreviewData.transactions) return;
      parsedPreviewData.transactions.forEach((t, idx) => {
        const rowIdx = t.originalIndex !== undefined ? t.originalIndex : idx;
        const canImport = t.canImport !== undefined ? t.canImport : (!t.isDuplicate && t.validationStatus !== 'ERROR');
        rowSelectionMap.set(rowIdx, canImport);
      });
      renderTableRows();
    });

    // Deselect All Button
    document.getElementById('deselectAllBtn')?.addEventListener('click', () => {
      if (!parsedPreviewData || !parsedPreviewData.transactions) return;
      parsedPreviewData.transactions.forEach((t, idx) => {
        const rowIdx = t.originalIndex !== undefined ? t.originalIndex : idx;
        rowSelectionMap.set(rowIdx, false);
      });
      renderTableRows();
    });

    document.getElementById('bulkImportResetBtn').addEventListener('click', reset);
    document.getElementById('bulkImportCloseBtn').addEventListener('click', close);
    document.getElementById('bulkImportCloseBtn2').addEventListener('click', close);

    // Commit Import with Selective Row Support
    document.getElementById('bulkImportSubmitBtn').addEventListener('click', async () => {
      const pId = document.getElementById('bulkImportPortfolioSelect').value;
      const broker = document.getElementById('bulkImportBrokerSelect').value;
      const submitBtn = document.getElementById('bulkImportSubmitBtn');

      // Collect selected row indices
      const selectedIndices = [];
      if (parsedPreviewData && parsedPreviewData.transactions) {
        parsedPreviewData.transactions.forEach((t, idx) => {
          const rowIdx = t.originalIndex !== undefined ? t.originalIndex : idx;
          if (rowSelectionMap.get(rowIdx) && t.validationStatus !== 'ERROR') {
            selectedIndices.push(rowIdx);
          }
        });
      }

      if (selectedIndices.length === 0) {
        showAlert('Seleziona almeno un movimento valido da importare.', 'warning');
        return;
      }

      submitBtn.disabled = true;
      submitBtn.textContent = 'Importazione in corso...';
      showAlert(`Salvataggio atomico di ${selectedIndices.length} movimenti su database...`, 'info');

      try {
        const formData = new FormData();
        if (pId) formData.append('portfolioId', pId);
        formData.append('preview', 'false');
        if (broker) formData.append('broker', broker);
        formData.append('selectedIndices', JSON.stringify(selectedIndices));

        if (userCustomMapping) {
          formData.append('customMapping', JSON.stringify(userCustomMapping));
        }

        if (selectedFile) {
          formData.append('file', selectedFile);
        } else {
          formData.append('csvText', fileTextContent);
        }

        const res = await fetch('/api/transactions/import-csv', {
          method: 'POST',
          body: formData
        });

        const data = await res.json();
        if (!res.ok || !data.success) {
          showAlert(data.error || 'Errore durante l\'importazione definitiva.');
          submitBtn.disabled = false;
          submitBtn.textContent = 'Riprova Importazione';
          return;
        }

        showAlert(`Importazione completata con successo! ${data.insertedCount} movimenti inseriti (${data.duplicateCount} duplicati ignorati).`, 'success');
        document.dispatchEvent(new CustomEvent('transactionsImported', { detail: data }));

        setTimeout(() => {
          close();
          window.location.reload();
        }, 1200);
      } catch (err) {
        showAlert('Errore di comunicazione: ' + err.message);
        submitBtn.disabled = false;
        submitBtn.textContent = 'Riprova Importazione';
      }
    });
  }

  function reset() {
    selectedFile = null;
    fileTextContent = null;
    parsedPreviewData = null;
    userCustomMapping = null;
    detectedHeaders = [];
    activeFilter = 'ALL';
    searchQuery = '';
    currentPage = 1;
    rowSelectionMap.clear();

    const fileInput = document.getElementById('fileInput');
    if (fileInput) fileInput.value = '';
    const info = document.getElementById('selectedFileInfo');
    if (info) info.classList.add('hidden');
    const container = document.getElementById('previewContainer');
    if (container) container.classList.add('hidden');
    const uploadContainer = document.getElementById('uploadStepContainer');
    if (uploadContainer) uploadContainer.classList.remove('hidden');
    const compactBar = document.getElementById('compactFileBar');
    if (compactBar) compactBar.classList.add('hidden');
    const mappingSection = document.getElementById('customMappingSection');
    if (mappingSection) mappingSection.classList.add('hidden');
    const portfolioNotice = document.getElementById('noPortfolioNotice');
    if (portfolioNotice) portfolioNotice.classList.add('hidden');
    const healthBanner = document.getElementById('healthCenterBanner');
    if (healthBanner) healthBanner.classList.add('hidden');
    const searchInput = document.getElementById('previewSearchInput');
    if (searchInput) searchInput.value = '';

    hideAlert();
    const submitBtn = document.getElementById('bulkImportSubmitBtn');
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.textContent = 'Conferma Importazione';
    }
  }

  function open(options = {}) {
    if (!modalContainer) {
      modalContainer = createModalHtml();
      setupEvents();
    }

    reset();
    loadUserPortfolios(options.portfolioId);

    modalContainer.classList.remove('hidden');
    document.body.classList.add('overflow-hidden');
  }

  function close() {
    if (modalContainer) {
      modalContainer.classList.add('hidden');
      document.body.classList.remove('overflow-hidden');
      reset();
    }
  }

  // Global listeners for buttons with [data-open-bulk-import] or id="bulkImportBtn"
  document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('[data-open-bulk-import], #bulkImportBtn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        const pId = btn.getAttribute('data-portfolio-id');
        open({ portfolioId: pId });
      });
    });
  });

  window.BulkImportModal = {
    open,
    close,
    reset,
    renderColumnMappingUI
  };
})();
