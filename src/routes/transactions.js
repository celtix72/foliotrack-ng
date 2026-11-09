const express = require('express');
const multer = require('multer');
const { db, getSetting } = require('../db');
const { requireAuth } = require('../middlewares/authMiddleware');
const { recalculatePortfolio, checkPortfolioAccess, getAssetsMap } = require('./portfolios');
const { computeTransactionCashDelta } = require('../utils/finance');
const { TRANSACTION_TYPES } = require('../utils/constants');
const { parseBrokerCsv, detectBroker } = require('../utils/brokerParsers');
const { exportWealthfolioCsv } = require('../utils/exportFormats');
const { validateImportActivities } = require('../utils/importValidator');
const { compensateTaxGain, recordTaxLoss } = require('./taxes');
const { resolveAssetTaxInfo } = require('../utils/taxEngine');
const { recalculateDividendProjections } = require('./dividends');
const { recalculateAndReconstructHistoricalPerformance } = require('./history');
const { fetchUnifiedQuote, ensureHistoricalQuotesIfMissing, reconstructPortfolioHistoryFromQuotes } = require('../services/marketService');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB limit
});

const router = express.Router();

router.use(requireAuth);

/**
 * Ensures an asset exists in the assets table.
 * If not present, creates a base record.
 *
 * @param {string} ticker
 * @param {number} currentPrice
 * @param {string} currency
 */
function ensureAssetExists(ticker, currentPrice = 0.0, currency = 'EUR') {
  if (!ticker) return;
  const cleanTicker = ticker.toUpperCase().trim();
  const existing = db.prepare('SELECT ticker FROM assets WHERE ticker = ?').get(cleanTicker);

  if (!existing) {
    db.prepare(`
      INSERT INTO assets (ticker, name, type, currency, currentPrice, sector, region)
      VALUES (?, ?, 'EQUITY', ?, ?, 'Unclassified', 'Global')
    `).run(cleanTicker, cleanTicker, currency, Number(currentPrice) || 0.0);
  }
}

/**
 * Resolves an asset for a ticker in the specified order:
 * 1. Search in internal asset catalog (assets table)
 * 2. If not found internally, search default providers (Borsa Italiana, Yahoo, Google)
 * 3. Fallback to basic manual asset creation
 *
 * @param {string} ticker
 * @param {number} [price=0.0]
 * @param {string} [currency='EUR']
 * @returns {Promise<{ asset: object, source: 'INTERNAL'|'PROVIDER'|'MANUAL', matched: boolean, ticker: string, name: string }>}
 */
async function resolveAssetForTicker(ticker, price = 0.0, currency = 'EUR') {
  if (!ticker) return null;
  const cleanTicker = ticker.toUpperCase().trim();

  // Pseudo-simboli di cassa (standard Wealthfolio $CASH-EUR, CASH)
  if (cleanTicker === 'CASH' || cleanTicker.startsWith('$CASH')) {
    return {
      asset: null,
      source: 'INTERNAL',
      matched: true,
      ticker: cleanTicker,
      name: 'Liquidità / Cash'
    };
  }

  // 1. PRIMA RICERCA: lista titoli interna già presente nel database
  const internalAsset = db.prepare('SELECT * FROM assets WHERE ticker = ? COLLATE NOCASE').get(cleanTicker);
  if (internalAsset) {
    return {
      asset: internalAsset,
      source: 'INTERNAL',
      matched: true,
      ticker: internalAsset.ticker,
      name: internalAsset.name
    };
  }

  // 2. SECONDA RICERCA: se non presente, ricerca sui provider di default (Yahoo, Borsa Italiana, Google)
  try {
    const quote = await fetchUnifiedQuote(cleanTicker);
    if (quote && (quote.currentPrice > 0 || quote.name)) {
      ensureHistoricalQuotesIfMissing(cleanTicker).catch(() => {});
      const savedAsset = db.prepare('SELECT * FROM assets WHERE ticker = ?').get(cleanTicker);
      return {
        asset: savedAsset || quote,
        source: 'PROVIDER',
        provider: quote.source || 'YAHOO',
        matched: true,
        ticker: cleanTicker,
        name: quote.name || cleanTicker
      };
    }
  } catch (err) {
    console.warn(`[CSV Asset Lookup] Provider search failed for ${cleanTicker}:`, err.message);
  }

  // 3. FALLBACK: se non presente sui provider, crea record base
  ensureAssetExists(cleanTicker, price, currency);
  const created = db.prepare('SELECT * FROM assets WHERE ticker = ?').get(cleanTicker);
  return {
    asset: created,
    source: 'MANUAL',
    matched: false,
    ticker: cleanTicker,
    name: cleanTicker
  };
}

/**
 * Calculates net cash amount impact of a transaction.
 */
function computeTransactionAmount(type, quantity, price, commission, tax, exchangeRate, rawAmount) {
  const qty = Number(quantity) || 0.0;
  const prc = Number(price) || 0.0;
  const comm = Number(commission) || 0.0;
  const tx = Number(tax) || 0.0;
  const fx = Number(exchangeRate) || 1.0;
  const specified = Number(rawAmount) || 0.0;

  if (specified > 0) {
    return specified;
  }

  const grossEur = (fx !== 1.0 && fx > 0) ? ((qty * prc) / fx) : (qty * prc);
  const commEur = (fx !== 1.0 && fx > 0 && comm > 0) ? (comm / fx) : comm;

  switch (type) {
    case 'BUY':
      return grossEur + commEur + tx;
    case 'SELL':
      return Math.max(0, grossEur - commEur - tx);
    case 'DIVIDEND':
    case 'INTEREST':
      return Math.max(0, grossEur - tx);
    case 'DEPOSIT':
    case 'WITHDRAWAL':
      return grossEur;
    case 'FEE':
    case 'TAX':
      return commEur + tx;
    default:
      return grossEur;
  }
}

/**
 * GET /api/transactions
 * Lists transactions with rich multi-criteria filtering, pagination, and running cash balance.
 */
router.get('/', (req, res) => {
  const {
    portfolioId,
    type,
    activityType,
    assetTicker,
    assetType,
    instrumentType,
    startDate,
    dateFrom,
    endDate,
    dateTo,
    search,
    q,
    limit = 50,
    offset = 0
  } = req.query;

  const userId = req.user.id;
  const userRole = req.user.role;

  const conditions = [];
  const params = [];

  // Security: retrieve accessible portfolios
  let accessiblePortfolios = [];
  if (userRole === 'admin') {
    accessiblePortfolios = db.prepare('SELECT id, initialCash, currency, name FROM portfolios ORDER BY id ASC').all();
  } else {
    accessiblePortfolios = db.prepare(`
      SELECT p.id, p.initialCash, p.currency, p.name
      FROM portfolios p
      INNER JOIN portfolio_users pu ON pu.portfolio_id = p.id
      WHERE pu.user_id = ?
      ORDER BY p.id ASC
    `).all(userId);
  }

  const accessiblePortIds = accessiblePortfolios.map(p => p.id);
  if (accessiblePortIds.length === 0) {
    return res.json({
      success: true,
      total: 0,
      limit: parseInt(limit, 10) || 50,
      offset: parseInt(offset, 10) || 0,
      summary: { totalCount: 0, totalInflow: 0, totalOutflow: 0, netFlow: 0 },
      transactions: []
    });
  }

  if (userRole !== 'admin') {
    const portPlaceholders = accessiblePortIds.map(() => '?').join(', ');
    conditions.push(`t.portfolioId IN (${portPlaceholders})`);
    params.push(...accessiblePortIds);
  }

  // Portfolio filter (single or comma-separated list of IDs)
  if (portfolioId && portfolioId !== 'all') {
    const pIds = String(portfolioId)
      .split(',')
      .map(s => parseInt(s.trim(), 10))
      .filter(n => !isNaN(n));
    if (pIds.length === 1) {
      conditions.push('t.portfolioId = ?');
      params.push(pIds[0]);
    } else if (pIds.length > 1) {
      const ph = pIds.map(() => '?').join(', ');
      conditions.push(`t.portfolioId IN (${ph})`);
      params.push(...pIds);
    }
  }

  // Activity type filter (supports single or comma-separated list, e.g. BUY,SELL,DIVIDEND)
  const rawType = type || activityType;
  if (rawType && rawType !== 'all') {
    const types = String(rawType)
      .split(',')
      .map(s => s.trim().toUpperCase())
      .filter(Boolean);
    if (types.length === 1) {
      conditions.push('t.type = ?');
      params.push(types[0]);
    } else if (types.length > 1) {
      const ph = types.map(() => '?').join(', ');
      conditions.push(`t.type IN (${ph})`);
      params.push(...types);
    }
  }

  // Instrument / Asset Type filter (supports single or comma-separated, e.g. EQUITY,BOND,ETF,CASH,CRYPTO,COMMODITY)
  const rawAssetType = assetType || instrumentType;
  if (rawAssetType && rawAssetType !== 'all') {
    const types = String(rawAssetType)
      .split(',')
      .map(s => s.trim().toUpperCase())
      .filter(Boolean);
    const subConds = [];
    for (const at of types) {
      if (at === 'CASH') {
        subConds.push("(t.assetTicker IS NULL OR UPPER(a.type) = 'CASH' OR t.type IN ('DEPOSIT', 'WITHDRAWAL', 'TRANSFER'))");
      } else if (at === 'EQUITY' || at === 'STOCK') {
        subConds.push("UPPER(a.type) IN ('EQUITY', 'STOCK')");
      } else if (at === 'BOND') {
        subConds.push("UPPER(a.type) IN ('BOND', 'OBBLIGAZIONE', 'OBBLIGAZIONI', 'FIXED_INCOME')");
      } else if (at === 'ETF') {
        subConds.push("UPPER(a.type) = 'ETF'");
      } else if (at === 'CRYPTO') {
        subConds.push("UPPER(a.type) = 'CRYPTO'");
      } else if (at === 'COMMODITY') {
        subConds.push("UPPER(a.type) = 'COMMODITY'");
      } else {
        subConds.push("UPPER(a.type) = ?");
        params.push(at);
      }
    }
    if (subConds.length > 0) {
      conditions.push(`(${subConds.join(' OR ')})`);
    }
  }

  // Search filter (query string matching ticker, asset name, or notes)
  const searchStr = search || q;
  if (searchStr && searchStr.trim()) {
    const term = `%${searchStr.trim()}%`;
    conditions.push('(t.assetTicker LIKE ? OR a.name LIKE ? OR t.notes LIKE ?)');
    params.push(term, term, term);
  } else if (assetTicker) {
    conditions.push('t.assetTicker = ? COLLATE NOCASE');
    params.push(assetTicker.trim().toUpperCase());
  }

  // Date filters (startDate/dateFrom and endDate/dateTo)
  const from = startDate || dateFrom;
  if (from) {
    conditions.push('t.date >= ?');
    params.push(from);
  }

  const to = endDate || dateTo;
  if (to) {
    conditions.push('t.date <= ?');
    params.push(to);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  // Get total count
  const countRow = db.prepare(`
    SELECT COUNT(*) as total
    FROM transactions t
    LEFT JOIN assets a ON a.ticker = t.assetTicker
    ${whereClause}
  `).get(...params);

  // Compute summary stats for the filtered transaction set
  const summaryRow = db.prepare(`
    SELECT
      SUM(CASE WHEN t.type IN ('DEPOSIT', 'SELL', 'DIVIDEND', 'INTEREST') THEN t.amount ELSE 0 END) as totalInflow,
      SUM(CASE WHEN t.type IN ('BUY', 'WITHDRAWAL', 'FEE', 'TAX') THEN t.amount ELSE 0 END) as totalOutflow
    FROM transactions t
    LEFT JOIN assets a ON a.ticker = t.assetTicker
    ${whereClause}
  `).get(...params);

  // Pagination
  const limitNum = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 500);
  const offsetNum = Math.max(parseInt(offset, 10) || 0, 0);

  const queryParams = [...params, limitNum, offsetNum];
  const transactions = db.prepare(`
    SELECT t.*,
           p.name AS portfolioName,
           p.currency AS portfolioCurrency,
           a.name AS assetName,
           a.type AS assetType,
           a.sector AS assetSector,
           a.region AS assetRegion,
           a.currentPrice AS assetCurrentPrice
    FROM transactions t
    LEFT JOIN portfolios p ON p.id = t.portfolioId
    LEFT JOIN assets a ON a.ticker = t.assetTicker
    ${whereClause}
    ORDER BY t.date DESC, t.id DESC
    LIMIT ? OFFSET ?
  `).all(...queryParams);

  // Calculate Cumulative Running Cash for each movement across accessible portfolios
  const phAcc = accessiblePortIds.map(() => '?').join(', ');
  const allAccessibleTxs = db.prepare(`
    SELECT id, portfolioId, type, quantity, price, commission, tax, exchangeRate, amount, date, notes
    FROM transactions
    WHERE portfolioId IN (${phAcc})
    ORDER BY date ASC, id ASC
  `).all(...accessiblePortIds);

  const hasInitialDepositByPort = {};
  for (const tx of allAccessibleTxs) {
    if (tx.type === 'DEPOSIT' && tx.notes === 'Deposito iniziale') {
      hasInitialDepositByPort[tx.portfolioId] = true;
    }
  }

  const portCash = {};
  let globalCash = 0;
  for (const p of accessiblePortfolios) {
    const initC = hasInitialDepositByPort[p.id] ? 0.0 : (Number(p.initialCash) || 0.0);
    portCash[p.id] = initC;
    globalCash += initC;
  }

  const runningCashMap = {};
  const globalCashMap = {};
  const cashDeltaMap = {};

  for (const tx of allAccessibleTxs) {
    const delta = computeTransactionCashDelta(tx);
    portCash[tx.portfolioId] = (portCash[tx.portfolioId] || 0.0) + delta;
    globalCash += delta;
    runningCashMap[tx.id] = portCash[tx.portfolioId];
    globalCashMap[tx.id] = globalCash;
    cashDeltaMap[tx.id] = delta;
  }

  for (const t of transactions) {
    t.runningCash = runningCashMap[t.id] !== undefined ? Math.round(runningCashMap[t.id] * 100) / 100 : 0.0;
    t.globalRunningCash = globalCashMap[t.id] !== undefined ? Math.round(globalCashMap[t.id] * 100) / 100 : 0.0;
    t.cashDelta = cashDeltaMap[t.id] !== undefined ? Math.round(cashDeltaMap[t.id] * 100) / 100 : 0.0;
  }

  return res.json({
    success: true,
    total: countRow.total,
    limit: limitNum,
    offset: offsetNum,
    summary: {
      totalCount: countRow.total,
      totalInflow: Math.round((Number(summaryRow.totalInflow) || 0.0) * 100) / 100,
      totalOutflow: Math.round((Number(summaryRow.totalOutflow) || 0.0) * 100) / 100,
      netFlow: Math.round(((Number(summaryRow.totalInflow) || 0.0) - (Number(summaryRow.totalOutflow) || 0.0)) * 100) / 100
    },
    transactions
  });
});

/**
 * GET /api/transactions/export/wealthfolio
 * Exports transactions as Wealthfolio-compatible CSV.
 * Accepts ?portfolioId=123 (or exports all accessible portfolios if omitted).
 */
router.get('/export/wealthfolio', (req, res) => {
  const portfolioId = req.query.portfolioId ? parseInt(req.query.portfolioId, 10) : null;
  const userId = req.user.id;
  const userRole = req.user.role;

  let transactions = [];
  let defaultCurrency = 'EUR';
  let filename = `wealthfolio_export_${new Date().toISOString().split('T')[0]}.csv`;

  if (portfolioId) {
    if (isNaN(portfolioId)) {
      return res.status(400).json({ success: false, error: 'portfolioId non valido.' });
    }
    const access = checkPortfolioAccess(portfolioId, userId, userRole);
    if (!access.hasAccess) {
      return res.status(403).json({ success: false, error: 'Accesso negato al portafoglio.' });
    }
    const p = db.prepare('SELECT * FROM portfolios WHERE id = ?').get(portfolioId);
    if (!p) {
      return res.status(404).json({ success: false, error: 'Portafoglio non trovato.' });
    }
    defaultCurrency = p.currency || 'EUR';
    filename = `wealthfolio_${(p.name || 'portfolio').replace(/[^a-zA-Z0-9_-]/g, '_')}_${portfolioId}.csv`;
    transactions = db.prepare(`
      SELECT * FROM transactions
      WHERE portfolioId = ?
      ORDER BY date ASC, id ASC
    `).all(portfolioId);
  } else {
    let portFilter = '';
    const params = [];
    if (userRole !== 'admin') {
      portFilter = 'WHERE portfolioId IN (SELECT portfolio_id FROM portfolio_users WHERE user_id = ?)';
      params.push(userId);
    }
    transactions = db.prepare(`
      SELECT * FROM transactions
      ${portFilter}
      ORDER BY date ASC, id ASC
    `).all(...params);
  }

  const assetsMap = getAssetsMap();
  const csvData = exportWealthfolioCsv(transactions, assetsMap, defaultCurrency);

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  return res.status(200).send(csvData);
});

/**
 * POST /api/transactions/import-csv
 * Imports transactions from CSV with auto-detection of broker format (Directa, IFIS, Wealthfolio, Generic).
 * Supports custom column mapping, 3-tier ticker resolution, default portfolio fallback,
 * preview mode (preview=true) and atomic database commit.
 */
router.post('/import-csv', upload.single('file'), async (req, res) => {
  let pId = parseInt(req.body.portfolioId || req.query.portfolioId, 10);
  let defaultPortfolioProposed = false;

  // Se nel CSV / richiesta non è presente il portafoglio, proponi/usa quello di default
  if (isNaN(pId) || !pId) {
    let defaultPort;
    const defSetting = getSetting(req.user.id, 'default_portfolio_id');
    if (defSetting) {
      const parsedDef = parseInt(defSetting, 10);
      if (!isNaN(parsedDef)) {
        defaultPort = db.prepare('SELECT * FROM portfolios WHERE id = ?').get(parsedDef);
      }
    }

    if (!defaultPort) {
      if (req.user.role === 'admin') {
        defaultPort = db.prepare('SELECT * FROM portfolios ORDER BY id ASC LIMIT 1').get();
      } else {
        defaultPort = db.prepare(`
          SELECT p.* FROM portfolios p
          JOIN portfolio_users pu ON pu.portfolio_id = p.id
          WHERE pu.user_id = ?
          ORDER BY p.id ASC
          LIMIT 1
        `).get(req.user.id);
      }
    }

    if (defaultPort) {
      pId = defaultPort.id;
      defaultPortfolioProposed = true;
    } else {
      return res.status(400).json({
        success: false,
        error: 'Nessun portafoglio specificato e nessun portafoglio predefinito trovato per questo utente.'
      });
    }
  }

  const access = checkPortfolioAccess(pId, req.user.id, req.user.role);
  if (!access.isOwner) {
    return res.status(403).json({ success: false, error: 'Accesso negato: devi essere proprietario del portafoglio per importare movimenti.' });
  }

  const portfolio = db.prepare('SELECT * FROM portfolios WHERE id = ?').get(pId);
  if (!portfolio) {
    return res.status(404).json({ success: false, error: 'Portafoglio non trovato.' });
  }

  // Extract CSV text from file buffer or body
  let csvText = '';
  if (req.file && req.file.buffer) {
    csvText = req.file.buffer.toString('utf-8');
  } else if (req.body && req.body.csvText) {
    csvText = String(req.body.csvText);
  }

  if (!csvText || !csvText.trim()) {
    return res.status(400).json({ success: false, error: 'Nessun file CSV o testo inviato.' });
  }

  const isPreview = req.body.preview === true || req.body.preview === 'true' ||
                    req.query.preview === true || req.query.preview === 'true';
  const forcedBroker = req.body.broker || req.query.broker || null;

  // Custom mapping can be sent as object or JSON string
  let customMapping = null;
  if (req.body.customMapping) {
    try {
      customMapping = typeof req.body.customMapping === 'string'
        ? JSON.parse(req.body.customMapping)
        : req.body.customMapping;
    } catch {
      customMapping = null;
    }
  }

  try {
    const parseResult = parseBrokerCsv(csvText, portfolio.currency, forcedBroker, customMapping);

    // Se l'import automatico fallisce ma abbiamo le intestazioni delle colonne,
    // consentiamo all'utente di associare manualmente ciascuna colonna a un campo
    if (parseResult.transactions.length === 0 && parseResult.errors.length > 0) {
      return res.status(200).json({
        success: false,
        needsMapping: true,
        detectedBroker: parseResult.broker,
        headers: parseResult.headers || [],
        sampleRows: parseResult.sampleRows || [],
        hasPortfolioColumn: parseResult.hasPortfolioColumn || false,
        defaultPortfolio: { id: portfolio.id, name: portfolio.name, currency: portfolio.currency },
        defaultPortfolioProposed,
        error: parseResult.errors.join(', ') || 'Formato CSV non riconosciuto automaticamente. Associa le colonne manualmente.'
      });
    }

    // Risoluzione titoli (3 livelli: 1° DB interno, 2° Provider di default con cache, 3° Fallback manuale)
    const distinctTickers = [...new Set(parseResult.transactions.map(t => t.assetTicker).filter(Boolean))];
    const tickerResolutionMap = {};
    for (const t of distinctTickers) {
      try {
        const resolved = await resolveAssetForTicker(t, 0, portfolio.currency);
        tickerResolutionMap[t] = resolved;
      } catch (e) {
        tickerResolutionMap[t] = {
          asset: null,
          source: 'MANUAL',
          matched: false,
          ticker: t,
          name: t
        };
      }
    }

    // Query existing portfolio transactions for duplicate detection and health checks
    const existingTransactions = db.prepare(`
      SELECT * FROM transactions
      WHERE portfolioId = ?
      ORDER BY date ASC, id ASC
    `).all(pId);

    // Run Wealthfolio-aligned Validation & Health Check Engine
    const validationResult = validateImportActivities(
      parseResult.transactions,
      portfolio,
      existingTransactions,
      tickerResolutionMap
    );

    if (isPreview) {
      return res.json({
        success: true,
        preview: true,
        detectedBroker: parseResult.broker,
        totalRows: parseResult.totalRows,
        parsedCount: parseResult.transactions.length,
        duplicateCount: validationResult.summary.duplicateCount,
        warningCount: validationResult.summary.warningCount,
        errorCount: validationResult.summary.errorCount,
        newCount: validationResult.summary.newCount,
        importableCount: validationResult.summary.importableCount,
        summary: validationResult.summary,
        transactions: validationResult.transactions,
        errors: parseResult.errors,
        headers: parseResult.headers || [],
        sampleRows: parseResult.sampleRows || [],
        hasPortfolioColumn: parseResult.hasPortfolioColumn || false,
        defaultPortfolio: { id: portfolio.id, name: portfolio.name, currency: portfolio.currency },
        defaultPortfolioProposed
      });
    }

    // Selected indices support (optional selective import from preview UI)
    let selectedIndices = null;
    if (req.body.selectedIndices !== undefined && req.body.selectedIndices !== null) {
      try {
        selectedIndices = typeof req.body.selectedIndices === 'string'
          ? JSON.parse(req.body.selectedIndices)
          : req.body.selectedIndices;
        if (Array.isArray(selectedIndices)) {
          selectedIndices = selectedIndices.map(n => Number(n));
        } else {
          selectedIndices = null;
        }
      } catch {
        selectedIndices = null;
      }
    }

    // Filter transactions to insert:
    // If selectedIndices is provided, insert matching non-error rows.
    // If not provided, insert all canImport rows (non-duplicate and non-error).
    const transactionsToInsert = validationResult.transactions.filter((tx, idx) => {
      if (tx.validationStatus === 'ERROR') return false;

      if (selectedIndices) {
        const rowIdx = (tx.originalIndex !== undefined) ? tx.originalIndex : idx;
        return selectedIndices.includes(rowIdx);
      }

      return tx.canImport;
    });

    // Atomic Insertion of selected transactions
    const insertAtomic = db.transaction(() => {
      const insertStmt = db.prepare(`
        INSERT INTO transactions (
          portfolioId, type, assetTicker, date, quantity, price,
          commission, tax, exchangeRate, amount, notes
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      const inserted = [];
      for (const tx of transactionsToInsert) {
        const cleanTicker = tx.assetTicker ? tx.assetTicker.toUpperCase().trim() : null;
        const isCashPseudo = !cleanTicker || cleanTicker === 'CASH' || cleanTicker.startsWith('$CASH');
        const isCashType = ['DEPOSIT', 'WITHDRAWAL', 'TRANSFER'].includes(tx.type);
        const finalTicker = (isCashPseudo || isCashType) ? null : cleanTicker;

        if (finalTicker && ['BUY', 'SELL', 'DIVIDEND', 'INTEREST', 'SPLIT'].includes(tx.type)) {
          ensureAssetExists(finalTicker, tx.price, tx.currency || portfolio.currency);
        }

        const finalAmount = computeTransactionAmount(
          tx.type,
          tx.quantity,
          tx.price,
          tx.commission,
          tx.tax,
          tx.exchangeRate || 1.0,
          tx.amount
        );

        const info = insertStmt.run(
          pId,
          tx.type,
          finalTicker,
          tx.date,
          tx.quantity,
          tx.price,
          tx.commission,
          tx.tax,
          tx.exchangeRate || 1.0,
          finalAmount,
          tx.notes || ''
        );

        inserted.push({
          id: info.lastInsertRowid,
          ...tx,
          amount: finalAmount,
          assetTicker: finalTicker
        });
      }

      const updatedPortfolio = recalculatePortfolio(pId);
      return { inserted, updatedPortfolio };
    });

    const { inserted, updatedPortfolio } = insertAtomic();

    try {
      reconstructPortfolioHistoryFromQuotes(pId, 1825);
    } catch (recErr) {
      console.warn('[Transactions Warning] History reconstruction error:', recErr.message);
    }

    return res.status(201).json({
      success: true,
      preview: false,
      detectedBroker: parseResult.broker,
      totalRows: parseResult.totalRows,
      parsedCount: parseResult.transactions.length,
      insertedCount: inserted.length,
      duplicateCount: validationResult.summary.duplicateCount,
      warningCount: validationResult.summary.warningCount,
      errorCount: validationResult.summary.errorCount,
      summary: validationResult.summary,
      transactions: inserted,
      portfolio: updatedPortfolio,
      errors: parseResult.errors,
      headers: parseResult.headers || [],
      hasPortfolioColumn: parseResult.hasPortfolioColumn || false,
      defaultPortfolio: { id: portfolio.id, name: portfolio.name, currency: portfolio.currency },
      defaultPortfolioProposed
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      error: `Errore durante l'importazione CSV: ${err.message}`
    });
  }
});

/**
 * GET /api/transactions/:id
 * Retrieves a single transaction.
 */
router.get('/:id', (req, res) => {
  const txId = parseInt(req.params.id, 10);
  if (isNaN(txId)) {
    return res.status(400).json({ success: false, error: 'ID transazione non valido.' });
  }

  const tx = db.prepare(`
    SELECT t.*,
           p.name AS portfolioName,
           a.name AS assetName,
           a.type AS assetType
    FROM transactions t
    LEFT JOIN portfolios p ON p.id = t.portfolioId
    LEFT JOIN assets a ON a.ticker = t.assetTicker
    WHERE t.id = ?
  `).get(txId);

  if (!tx) {
    return res.status(404).json({ success: false, error: 'Transazione non trovata.' });
  }

  const access = checkPortfolioAccess(tx.portfolioId, req.user.id, req.user.role);
  if (!access.hasAccess) {
    return res.status(403).json({ success: false, error: 'Accesso negato alla transazione.' });
  }

  return res.json({
    success: true,
    transaction: tx
  });
});

/**
 * POST /api/transactions
 * Atomically creates a transaction and recalculates portfolio cash and positions.
 */
router.post('/', (req, res) => {
  const {
    portfolioId,
    type,
    assetTicker,
    date = new Date().toISOString().split('T')[0],
    quantity = 0.0,
    price = 0.0,
    commission = 0.0,
    tax = 0.0,
    exchangeRate = 1.0,
    amount,
    notes = '',
    linkedTransactionId = null
  } = req.body || {};

  const pId = parseInt(portfolioId, 10);
  if (isNaN(pId)) {
    return res.status(400).json({ success: false, error: 'portfolioId obbligatorio e valido.' });
  }

  const access = checkPortfolioAccess(pId, req.user.id, req.user.role);
  if (!access.isOwner) {
    return res.status(403).json({ success: false, error: 'Accesso negato: devi essere proprietario per aggiungere transazioni.' });
  }

  const portfolio = db.prepare('SELECT * FROM portfolios WHERE id = ?').get(pId);
  if (!portfolio) {
    return res.status(404).json({ success: false, error: 'Portafoglio non trovato.' });
  }

  const cleanType = (type || '').toUpperCase().trim();
  if (!TRANSACTION_TYPES.includes(cleanType)) {
    return res.status(400).json({
      success: false,
      error: `Tipo transazione non valido. Valori ammessi: ${TRANSACTION_TYPES.join(', ')}`
    });
  }

  const cleanTicker = assetTicker ? assetTicker.toUpperCase().trim() : null;
  const qty = Number(quantity) || 0.0;
  const prc = Number(price) || 0.0;
  const comm = Number(commission) || 0.0;
  const tx = Number(tax) || 0.0;
  const fx = Number(exchangeRate) || 1.0;

  // Validation rules for BUY and SELL
  if (cleanType === 'BUY' || cleanType === 'SELL') {
    if (!cleanTicker) {
      return res.status(400).json({ success: false, error: `Il ticker è obbligatorio per l'operazione ${cleanType}.` });
    }
    if (qty <= 0) {
      return res.status(400).json({ success: false, error: 'La quantità deve essere maggiore di 0.' });
    }
    if (cleanType === 'BUY' && prc < 0) {
      return res.status(400).json({ success: false, error: 'Il prezzo non può essere negativo.' });
    }
    if (cleanType === 'SELL' && prc <= 0) {
      return res.status(400).json({ success: false, error: 'Il prezzo di vendita deve essere maggiore di 0.' });
    }
    if (comm < 0 || tx < 0) {
      return res.status(400).json({ success: false, error: 'Commissioni e imposte non possono essere negative.' });
    }
    if (fx <= 0) {
      return res.status(400).json({ success: false, error: 'Il tasso di cambio FX deve essere maggiore di 0.' });
    }

    if (cleanType === 'SELL') {
      const currentSnapshot = recalculatePortfolio(pId);
      const currentPos = currentSnapshot.metrics.holdings.find(h => h.ticker === cleanTicker);
      const availableQty = currentPos ? currentPos.quantity : 0.0;
      if (!currentPos || availableQty <= 1e-9) {
        return res.status(400).json({
          success: false,
          error: `Impossibile registrare la vendita: il titolo ${cleanTicker} non è presente in questo portafoglio.`
        });
      }
      if (availableQty < qty - 1e-9) {
        return res.status(400).json({
          success: false,
          error: `Quantità insufficiente in portafoglio per la vendita di ${cleanTicker}: possedute ${availableQty}, richieste ${qty}.`
        });
      }
    }

    // Auto-create asset entry if missing
    ensureAssetExists(cleanTicker, prc, portfolio.currency);
  }

  const calculatedAmount = computeTransactionAmount(cleanType, qty, prc, comm, tx, fx, amount);

  // Execute atomic transaction
  try {
    const runAtomic = db.transaction(() => {
      // If SELL: check that portfolio has enough quantity to sell and handle tax gain/loss
      if (cleanType === 'SELL') {
        const currentSnapshot = recalculatePortfolio(pId);
        const currentPos = currentSnapshot.metrics.holdings.find(h => h.ticker === cleanTicker);
        const availableQty = currentPos ? currentPos.quantity : 0.0;
        if (availableQty < qty - 1e-9) {
          throw new Error(`Quantità insufficiente in portafoglio per la vendita: possedute ${availableQty}, richieste ${qty}.`);
        }

        const costBasisUnit = currentPos ? (currentPos.costBasis || currentPos.pmc || 0.0) : 0.0;
        const grossEur = (fx !== 1.0 && fx > 0) ? ((qty * prc) / fx) : (qty * prc);
        const commEur = (fx !== 1.0 && fx > 0 && comm > 0) ? (comm / fx) : comm;
        const netProceeds = calculatedAmount > 0 ? calculatedAmount : Math.max(0, grossEur - commEur - tx);
        const totalCost = qty * costBasisUnit;
        const gainOrLoss = netProceeds - totalCost;

        const assetRow = db.prepare('SELECT * FROM assets WHERE ticker = ?').get(cleanTicker);
        const assetInfo = assetRow || currentPos || { ticker: cleanTicker };
        const assetTax = resolveAssetTaxInfo(assetInfo);

        if (gainOrLoss > 0.01) {
          compensateTaxGain(pId, gainOrLoss, assetTax.taxCategory);
        } else if (gainOrLoss < -0.01) {
          const categoryTag = assetTax.taxCategory === 'BOND' ? 'Bond/Monetario 12,5%' : 'Azioni/ETF 26%';
          recordTaxLoss(
            pId,
            Math.abs(gainOrLoss),
            date,
            notes || `Minusvalenza da vendita ${cleanTicker} (${categoryTag})`,
            assetTax.taxCategory,
            assetTax.taxRate
          );
        }
      }

      // Insert transaction
      const stmt = db.prepare(`
        INSERT INTO transactions (
          portfolioId, type, assetTicker, date, quantity, price,
          commission, tax, exchangeRate, amount, notes, linkedTransactionId
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      const info = stmt.run(
        pId,
        cleanType,
        cleanTicker,
        date,
        qty,
        prc,
        comm,
        tx,
        fx,
        calculatedAmount,
        notes,
        linkedTransactionId
      );

      const txId = info.lastInsertRowid;

      // Recalculate portfolio metrics and persist currentCash, totalValue, etc.
      const updatedPortfolio = recalculatePortfolio(pId);
      recalculateDividendProjections(pId);

      return { txId, updatedPortfolio };
    });

    const result = runAtomic();
    try {
      reconstructPortfolioHistoryFromQuotes(pId, 1825);
    } catch {}

    const createdTx = db.prepare('SELECT * FROM transactions WHERE id = ?').get(result.txId);

    return res.status(201).json({
      success: true,
      transaction: createdTx,
      portfolio: result.updatedPortfolio
    });
  } catch (err) {
    return res.status(400).json({
      success: false,
      error: err.message
    });
  }
});

/**
 * PUT /api/transactions/:id
 * Atomically updates a transaction and recalculates the portfolio.
 */
router.put('/:id', (req, res) => {
  const txId = parseInt(req.params.id, 10);
  if (isNaN(txId)) {
    return res.status(400).json({ success: false, error: 'ID transazione non valido.' });
  }

  const existingTx = db.prepare('SELECT * FROM transactions WHERE id = ?').get(txId);
  if (!existingTx) {
    return res.status(404).json({ success: false, error: 'Transazione non trovata.' });
  }

  const access = checkPortfolioAccess(existingTx.portfolioId, req.user.id, req.user.role);
  if (!access.isOwner) {
    return res.status(403).json({ success: false, error: 'Accesso negato: solo il proprietario può modificare le transazioni.' });
  }

  const {
    type = existingTx.type,
    assetTicker = existingTx.assetTicker,
    date = existingTx.date,
    quantity = existingTx.quantity,
    price = existingTx.price,
    commission = existingTx.commission,
    tax = existingTx.tax,
    exchangeRate = existingTx.exchangeRate,
    amount,
    notes = existingTx.notes
  } = req.body || {};

  const cleanType = type.toUpperCase().trim();
  const cleanTicker = assetTicker ? assetTicker.toUpperCase().trim() : null;
  const qty = Number(quantity) || 0.0;
  const prc = Number(price) || 0.0;
  const comm = Number(commission) || 0.0;
  const tx = Number(tax) || 0.0;
  const fx = Number(exchangeRate) || 1.0;

  if (cleanType === 'SELL') {
    if (qty <= 0) {
      return res.status(400).json({ success: false, error: 'La quantità da vendere deve essere maggiore di 0.' });
    }
    if (prc <= 0) {
      return res.status(400).json({ success: false, error: 'Il prezzo di vendita deve essere maggiore di 0.' });
    }
    if (comm < 0 || tx < 0) {
      return res.status(400).json({ success: false, error: 'Commissioni e imposte non possono essere negative.' });
    }
    if (fx <= 0) {
      return res.status(400).json({ success: false, error: 'Il tasso di cambio FX deve essere maggiore di 0.' });
    }
  }

  const finalAmount = computeTransactionAmount(cleanType, qty, prc, comm, tx, fx, amount);

  try {
    const updateAtomic = db.transaction(() => {
      db.prepare(`
        UPDATE transactions
        SET type = ?,
            assetTicker = ?,
            date = ?,
            quantity = ?,
            price = ?,
            commission = ?,
            tax = ?,
            exchangeRate = ?,
            amount = ?,
            notes = ?
        WHERE id = ?
      `).run(
        cleanType,
        cleanTicker,
        date,
        qty,
        prc,
        comm,
        tx,
        fx,
        finalAmount,
        notes,
        txId
      );

      // Recalculate portfolio to verify consistency
      const tickersToCheck = new Set([cleanTicker, existingTx.assetTicker].filter(Boolean));
      for (const tkr of tickersToCheck) {
        const txs = db.prepare(`
          SELECT type, quantity, date, id
          FROM transactions
          WHERE portfolioId = ? AND assetTicker = ?
          ORDER BY date ASC, id ASC
        `).all(existingTx.portfolioId, tkr);

        let runningQty = 0.0;
        for (const t of txs) {
          if (t.type === 'BUY') runningQty += Number(t.quantity) || 0.0;
          else if (t.type === 'SELL') runningQty -= Number(t.quantity) || 0.0;
          if (runningQty < -1e-9) {
            throw new Error(`Modifica operazione non valida: la vendita comporta una quantità negativa (${runningQty.toFixed(4)}) per il titolo ${tkr}.`);
          }
        }
      }

      const updatedPortfolio = recalculatePortfolio(existingTx.portfolioId);
      return updatedPortfolio;
    });

    const updatedPortfolio = updateAtomic();
    try {
      reconstructPortfolioHistoryFromQuotes(existingTx.portfolioId, 1825);
    } catch {}
    const updatedTx = db.prepare('SELECT * FROM transactions WHERE id = ?').get(txId);

    return res.json({
      success: true,
      transaction: updatedTx,
      portfolio: updatedPortfolio
    });
  } catch (err) {
    return res.status(400).json({
      success: false,
      error: err.message
    });
  }
});

/**
 * DELETE /api/transactions/:id
 * Atomically deletes a transaction and recalculates portfolio cash and metrics.
 */
router.delete('/:id', (req, res) => {
  const txId = parseInt(req.params.id, 10);
  if (isNaN(txId)) {
    return res.status(400).json({ success: false, error: 'ID transazione non valido.' });
  }

  const existingTx = db.prepare('SELECT * FROM transactions WHERE id = ?').get(txId);
  if (!existingTx) {
    return res.status(404).json({ success: false, error: 'Transazione non trovata.' });
  }

  const access = checkPortfolioAccess(existingTx.portfolioId, req.user.id, req.user.role);
  if (!access.isOwner) {
    return res.status(403).json({ success: false, error: 'Accesso negato: solo il proprietario può eliminare le transazioni.' });
  }

  try {
    const deleteAtomic = db.transaction(() => {
      db.prepare('DELETE FROM transactions WHERE id = ?').run(txId);
      const updatedPortfolio = recalculatePortfolio(existingTx.portfolioId);
      return updatedPortfolio;
    });

    const updatedPortfolio = deleteAtomic();
    try {
      reconstructPortfolioHistoryFromQuotes(existingTx.portfolioId, 1825);
    } catch {}

    return res.json({
      success: true,
      message: 'Transazione eliminata con successo.',
      portfolio: updatedPortfolio
    });
  } catch (err) {
    return res.status(400).json({
      success: false,
      error: err.message
    });
  }
});

/**
 * POST /api/transactions/recalculate-performance
 * Triggers historical performance recalculation and history reconstruction from transactions.
 */
router.post('/recalculate-performance', async (req, res) => {
  try {
    const { portfolioId, daysBack = 1825, syncQuotes = true } = req.body || {};
    const userId = req.user.id;
    const userRole = req.user.role;

    let pId = null;
    if (portfolioId && portfolioId !== 'all') {
      pId = parseInt(portfolioId, 10);
      if (isNaN(pId)) {
        return res.status(400).json({ success: false, error: 'portfolioId non valido.' });
      }
      const access = checkPortfolioAccess(pId, userId, userRole);
      if (!access.hasAccess) {
        return res.status(403).json({ success: false, error: 'Accesso negato al portafoglio.' });
      }
    }

    const result = await recalculateAndReconstructHistoricalPerformance(pId, {
      daysBack: Number(daysBack) || 1825,
      syncQuotes: Boolean(syncQuotes),
      userId,
      userRole
    });

    return res.json(result);
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;

