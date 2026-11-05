const express = require('express');
const { db } = require('../db');
const { requireAuth } = require('../middlewares/authMiddleware');
const { calculateHoldingsAndMetrics, calculateROI, calculateXIRR } = require('../utils/finance');
const { PORTFOLIO_TYPES, CURRENCIES } = require('../utils/constants');
const { exportWealthfolioCsv } = require('../utils/exportFormats');

const router = express.Router();

router.use(requireAuth);

/**
 * Helper to fetch all assets as a dictionary keyed by upper-cased ticker.
 * @returns {Record<string, object>}
 */
function getAssetsMap() {
  const assets = db.prepare('SELECT * FROM assets').all();
  const map = {};
  for (const a of assets) {
    map[a.ticker.toUpperCase()] = a;
  }
  return map;
}

/**
 * Checks if the current user has access to a specific portfolio.
 * Admins have global access.
 *
 * @param {number} portfolioId
 * @param {number} userId
 * @param {string} userRole
 * @returns {{ hasAccess: boolean, isOwner: boolean, role: string|null }}
 */
function checkPortfolioAccess(portfolioId, userId, userRole) {
  if (userRole === 'admin') {
    return { hasAccess: true, isOwner: true, role: 'owner' };
  }

  const link = db.prepare(`
    SELECT role FROM portfolio_users
    WHERE portfolio_id = ? AND user_id = ?
  `).get(portfolioId, userId);

  if (!link) {
    return { hasAccess: false, isOwner: false, role: null };
  }

  return {
    hasAccess: true,
    isOwner: link.role === 'owner',
    role: link.role
  };
}

/**
 * Recalculates and updates portfolio metrics inside SQLite, returning the calculated result.
 *
 * @param {number} portfolioId
 * @param {Record<string, object>} [assetsMap]
 * @returns {object|null}
 */
function recalculatePortfolio(portfolioId, assetsMap = null) {
  const portfolio = db.prepare('SELECT * FROM portfolios WHERE id = ?').get(portfolioId);
  if (!portfolio) return null;

  const map = assetsMap || getAssetsMap();
  const txs = db.prepare(`
    SELECT * FROM transactions
    WHERE portfolioId = ?
    ORDER BY date ASC, id ASC
  `).all(portfolioId);

  // Load currency rates map
  let currencyRatesMap = {};
  try {
    const rateRows = db.prepare('SELECT pair, rate FROM currency_rates').all();
    for (const r of rateRows) {
      currencyRatesMap[r.pair] = Number(r.rate);
    }
  } catch (e) {
    currencyRatesMap = {};
  }

  // If the initial deposit transaction is present in transactions, do not double-count initialCash
  const hasInitialDepositTx = txs.some(t => t.type === 'DEPOSIT' && t.notes === 'Deposito iniziale');
  const startingCash = hasInitialDepositTx ? 0.0 : (Number(portfolio.initialCash) || 0.0);

  const metrics = calculateHoldingsAndMetrics(
    txs,
    map,
    startingCash,
    portfolio.costBasisMethod || 'WAC',
    portfolio.currency || 'EUR',
    currencyRatesMap
  );

  // Update portfolios table
  const updateStmt = db.prepare(`
    UPDATE portfolios
    SET currentCash = ?,
        totalValue = ?,
        totalDividends = ?,
        investedCapital = ?,
        assetCount = ?,
        updatedAt = datetime('now')
    WHERE id = ?
  `);

  updateStmt.run(
    metrics.currentCash,
    metrics.totalValue,
    metrics.totalDividends,
    metrics.investedCapital,
    metrics.assetCount,
    portfolioId
  );

  // Enrich holdings with sparkline history from asset_quotes
  if (Array.isArray(metrics.holdings) && metrics.holdings.length > 0) {
    const quotesStmt = db.prepare(`
      SELECT date, close FROM asset_quotes
      WHERE ticker = ? AND date >= date('now', '-5 years')
      ORDER BY date ASC
    `);

    for (const h of metrics.holdings) {
      try {
        const qRows = quotesStmt.all(h.ticker);
        if (qRows && qRows.length > 0) {
          h.sparkline = qRows;
        } else if (h.pmc && h.currentPrice) {
          h.sparkline = [
            { date: 'Carico', close: h.pmc },
            { date: 'Attuale', close: h.currentPrice }
          ];
        } else {
          h.sparkline = [];
        }
      } catch {
        h.sparkline = [];
      }
    }
  }

  return {
    ...portfolio,
    currentCash: metrics.currentCash,
    totalValue: metrics.totalValue,
    totalDividends: metrics.totalDividends,
    investedCapital: metrics.investedCapital,
    assetCount: metrics.assetCount,
    dayPnl: metrics.dayPnl,
    dayPnlPercent: metrics.dayPnlPercent,
    performance1D: metrics.dayPnlPercent,
    closedPositions: metrics.closedPositions || [],
    metrics
  };
}

/**
 * Resets daily deltas for assets quoted prior to today.
 */
function resetPriorDayAssetDeltas() {
  let todayRome = '';
  try {
    todayRome = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome' }).format(new Date());
  } catch {
    todayRome = new Date().toISOString().split('T')[0];
  }
  try {
    db.prepare(`
      UPDATE assets
      SET previousClose = currentPrice,
          changeValue = 0.0,
          changePercent = 0.0
      WHERE quoteDate IS NOT NULL AND trim(quoteDate) != '' AND quoteDate < ?
    `).run(todayRome);
  } catch {}
}

/**
 * GET /api/portfolios
 * Lists all portfolios accessible by the authenticated user, along with aggregated totals.
 */
router.get('/', (req, res) => {
  resetPriorDayAssetDeltas();
  const userId = req.user.id;
  const userRole = req.user.role;

  let portfolios = [];
  if (userRole === 'admin') {
    portfolios = db.prepare('SELECT * FROM portfolios ORDER BY id ASC').all();
  } else {
    portfolios = db.prepare(`
      SELECT p.*
      FROM portfolios p
      INNER JOIN portfolio_users pu ON pu.portfolio_id = p.id
      WHERE pu.user_id = ?
      ORDER BY p.id ASC
    `).all(userId);
  }

  const assetsMap = getAssetsMap();
  const enriched = [];

  let grandTotalValue = 0.0;
  let grandTotalCash = 0.0;
  let grandInvestedCapital = 0.0;
  let grandRealizedPnl = 0.0;
  let grandUnrealizedPnl = 0.0;
  let grandTotalDividends = 0.0;
  let grandDayPnl = 0.0;
  const aggregatedAssetClass = {};
  const aggregatedSector = {};
  const aggregatedRegion = {};

  for (const p of portfolios) {
    const full = recalculatePortfolio(p.id, assetsMap);
    if (!full) continue;
    enriched.push(full);

    // Aggregate totals if included in totals
    if (full.include_in_totals) {
      grandTotalValue += full.metrics.totalValue;
      grandTotalCash += full.metrics.currentCash;
      grandInvestedCapital += full.metrics.investedCapital;
      grandRealizedPnl += full.metrics.realizedPnl;
      grandUnrealizedPnl += full.metrics.unrealizedPnl;
      grandTotalDividends += full.metrics.totalDividends;
      grandDayPnl += (full.metrics.dayPnl || 0.0);

      // Merge allocations
      for (const [cls, data] of Object.entries(full.metrics.allocations.byAssetClass)) {
        if (!aggregatedAssetClass[cls]) aggregatedAssetClass[cls] = { value: 0.0, weight: 0.0 };
        aggregatedAssetClass[cls].value += data.value;
      }
      for (const [sec, data] of Object.entries(full.metrics.allocations.bySector)) {
        if (!aggregatedSector[sec]) aggregatedSector[sec] = { value: 0.0, weight: 0.0 };
        aggregatedSector[sec].value += data.value;
      }
      for (const [reg, data] of Object.entries(full.metrics.allocations.byRegion)) {
        if (!aggregatedRegion[reg]) aggregatedRegion[reg] = { value: 0.0, weight: 0.0 };
        aggregatedRegion[reg].value += data.value;
      }
    }
  }

  // Finalize aggregated weights
  for (const map of [aggregatedAssetClass, aggregatedSector, aggregatedRegion]) {
    for (const key of Object.keys(map)) {
      map[key].weight = grandTotalValue > 0 ? (map[key].value / grandTotalValue) * 100.0 : 0.0;
    }
  }

  const grandRoi = calculateROI(grandTotalValue, grandInvestedCapital);
  const grandCostBasis = grandTotalValue - grandUnrealizedPnl - grandTotalCash;
  const grandUnrealizedPnlPercent = grandCostBasis > 0 ? (grandUnrealizedPnl / grandCostBasis) * 100.0 : 0.0;
  const grandPrevValue = grandTotalValue - grandDayPnl;
  const grandDayPnlPercent = grandPrevValue > 0 ? (grandDayPnl / grandPrevValue) * 100.0 : 0.0;

  return res.json({
    success: true,
    portfolios: enriched,
    totals: {
      totalValue: grandTotalValue,
      currentCash: grandTotalCash,
      totalAssetValue: grandTotalValue - grandTotalCash,
      investedCapital: grandInvestedCapital,
      realizedPnl: grandRealizedPnl,
      unrealizedPnl: grandUnrealizedPnl,
      unrealizedPnlPercent: grandUnrealizedPnlPercent,
      totalDividends: grandTotalDividends,
      dayPnl: grandDayPnl,
      dayPnlPercent: grandDayPnlPercent,
      roi: grandRoi,
      allocations: {
        byAssetClass: aggregatedAssetClass,
        bySector: aggregatedSector,
        byRegion: aggregatedRegion
      }
    }
  });
});

/**
 * GET /api/portfolios/:id
 * Retrieves full details and holdings for a single portfolio.
 */
router.get('/:id', (req, res) => {
  const portfolioId = parseInt(req.params.id, 10);
  if (isNaN(portfolioId)) {
    return res.status(400).json({ success: false, error: 'ID portafoglio non valido.' });
  }

  const access = checkPortfolioAccess(portfolioId, req.user.id, req.user.role);
  if (!access.hasAccess) {
    return res.status(403).json({ success: false, error: 'Accesso negato al portafoglio.' });
  }

  const full = recalculatePortfolio(portfolioId);
  if (!full) {
    return res.status(404).json({ success: false, error: 'Portafoglio non trovato.' });
  }

  return res.json({
    success: true,
    portfolio: full,
    userRole: access.role
  });
});

/**
 * POST /api/portfolios
 * Creates a new portfolio with base currency and cost basis method (WAC/FIFO).
 */
router.post('/', (req, res) => {
  const {
    name,
    type = 'Investimento',
    currency = 'EUR',
    costBasisMethod = 'WAC',
    initialCash = 0.0,
    startDate = new Date().toISOString().split('T')[0],
    color = '#4f6b92',
    include_in_totals = 1
  } = req.body || {};

  if (!name || typeof name !== 'string' || name.trim().length === 0) {
    return res.status(400).json({ success: false, error: 'Il nome del portafoglio è obbligatorio.' });
  }

  if (!PORTFOLIO_TYPES.includes(type)) {
    return res.status(400).json({ success: false, error: `Tipo portafoglio non valido. Tipi ammessi: ${PORTFOLIO_TYPES.join(', ')}` });
  }

  if (!['WAC', 'FIFO'].includes(costBasisMethod.toUpperCase())) {
    return res.status(400).json({ success: false, error: "Metodo di costo non valido. Ammessi: 'WAC' o 'FIFO'." });
  }

  const initCashNum = Number(initialCash) || 0.0;
  const includeTotalsNum = include_in_totals ? 1 : 0;

  const createTx = db.transaction(() => {
    const insertPortfolio = db.prepare(`
      INSERT INTO portfolios (
        name, type, currency, costBasisMethod, startDate,
        initialCash, currentCash, investedCapital, color, include_in_totals
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const info = insertPortfolio.run(
      name.trim(),
      type,
      currency.toUpperCase(),
      costBasisMethod.toUpperCase(),
      startDate,
      initCashNum,
      initCashNum,
      initCashNum,
      color,
      includeTotalsNum
    );

    const portfolioId = info.lastInsertRowid;

    // Link user as owner
    db.prepare(`
      INSERT INTO portfolio_users (portfolio_id, user_id, role)
      VALUES (?, ?, 'owner')
    `).run(portfolioId, req.user.id);

    // If initial cash was specified, insert it as the first DEPOSIT transaction of the portfolio
    if (initCashNum > 0) {
      db.prepare(`
        INSERT INTO transactions (
          portfolioId, type, date, amount, quantity, price, notes
        ) VALUES (?, 'DEPOSIT', ?, ?, 1, ?, 'Deposito iniziale')
      `).run(portfolioId, startDate, initCashNum, initCashNum);
    }

    return portfolioId;
  });

  const newPortfolioId = createTx();
  const createdPortfolio = recalculatePortfolio(newPortfolioId);

  return res.status(201).json({
    success: true,
    portfolio: createdPortfolio
  });
});

/**
 * PUT /api/portfolios/:id
 * Updates portfolio settings and triggers recalculation.
 */
router.put('/:id', (req, res) => {
  const portfolioId = parseInt(req.params.id, 10);
  if (isNaN(portfolioId)) {
    return res.status(400).json({ success: false, error: 'ID portafoglio non valido.' });
  }

  const access = checkPortfolioAccess(portfolioId, req.user.id, req.user.role);
  if (!access.isOwner) {
    return res.status(403).json({ success: false, error: 'Solo il proprietario o un amministratore può modificare il portafoglio.' });
  }

  const portfolio = db.prepare('SELECT * FROM portfolios WHERE id = ?').get(portfolioId);
  if (!portfolio) {
    return res.status(404).json({ success: false, error: 'Portafoglio non trovato.' });
  }

  const {
    name,
    type,
    currency,
    costBasisMethod,
    color,
    include_in_totals,
    startDate,
    initialCash
  } = req.body || {};

  const updatedName = name !== undefined ? name.trim() : portfolio.name;
  const updatedType = type !== undefined ? type : portfolio.type;
  const updatedCurrency = currency !== undefined ? currency.toUpperCase() : portfolio.currency;
  const updatedCostBasis = costBasisMethod !== undefined ? costBasisMethod.toUpperCase() : portfolio.costBasisMethod;
  const updatedColor = color !== undefined ? color : portfolio.color;
  const updatedInclude = include_in_totals !== undefined ? (include_in_totals ? 1 : 0) : portfolio.include_in_totals;
  const updatedStartDate = startDate !== undefined ? startDate : portfolio.startDate;
  const updatedInitialCash = initialCash !== undefined ? Number(initialCash) || 0.0 : portfolio.initialCash;

  db.prepare(`
    UPDATE portfolios
    SET name = ?,
        type = ?,
        currency = ?,
        costBasisMethod = ?,
        color = ?,
        include_in_totals = ?,
        startDate = ?,
        initialCash = ?,
        updatedAt = datetime('now')
    WHERE id = ?
  `).run(
    updatedName,
    updatedType,
    updatedCurrency,
    updatedCostBasis,
    updatedColor,
    updatedInclude,
    updatedStartDate,
    updatedInitialCash,
    portfolioId
  );

  // If initialCash is updated, sync the corresponding initial DEPOSIT transaction
  if (initialCash !== undefined) {
    const initDeposit = db.prepare(`
      SELECT id FROM transactions
      WHERE portfolioId = ? AND type = 'DEPOSIT' AND notes = 'Deposito iniziale'
      ORDER BY date ASC, id ASC
      LIMIT 1
    `).get(portfolioId);

    if (initDeposit) {
      if (updatedInitialCash > 0) {
        db.prepare(`
          UPDATE transactions
          SET amount = ?, price = ?, date = ?
          WHERE id = ?
        `).run(updatedInitialCash, updatedInitialCash, updatedStartDate, initDeposit.id);
      } else {
        db.prepare('DELETE FROM transactions WHERE id = ?').run(initDeposit.id);
      }
    } else if (updatedInitialCash > 0) {
      db.prepare(`
        INSERT INTO transactions (
          portfolioId, type, date, amount, quantity, price, notes
        ) VALUES (?, 'DEPOSIT', ?, ?, 1, ?, 'Deposito iniziale')
      `).run(portfolioId, updatedStartDate, updatedInitialCash, updatedInitialCash);
    }
  }

  const recalculated = recalculatePortfolio(portfolioId);

  return res.json({
    success: true,
    portfolio: recalculated
  });
});

/**
 * GET /api/portfolios/:id/export/wealthfolio
 * Exports all transactions for a portfolio as a Wealthfolio-compatible CSV.
 */
router.get('/:id/export/wealthfolio', (req, res) => {
  const portfolioId = parseInt(req.params.id, 10);
  if (isNaN(portfolioId)) {
    return res.status(400).json({ success: false, error: 'ID portafoglio non valido.' });
  }

  const access = checkPortfolioAccess(portfolioId, req.user.id, req.user.role);
  if (!access.hasAccess) {
    return res.status(403).json({ success: false, error: 'Accesso negato al portafoglio.' });
  }

  const portfolio = db.prepare('SELECT * FROM portfolios WHERE id = ?').get(portfolioId);
  if (!portfolio) {
    return res.status(404).json({ success: false, error: 'Portafoglio non trovato.' });
  }

  const transactions = db.prepare(`
    SELECT * FROM transactions
    WHERE portfolioId = ?
    ORDER BY date ASC, id ASC
  `).all(portfolioId);

  const assetsMap = getAssetsMap();
  const csvData = exportWealthfolioCsv(transactions, assetsMap, portfolio.currency);

  const safeName = (portfolio.name || 'portfolio').replace(/[^a-zA-Z0-9_-]/g, '_');
  const dateStr = new Date().toISOString().split('T')[0];
  const filename = `wealthfolio_${safeName}_${portfolioId}_${dateStr}.csv`;

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  return res.status(200).send(csvData);
});

/**
 * DELETE /api/portfolios/:id
 * Deletes portfolio and cascades to portfolio_users and transactions.
 */
router.delete('/:id', (req, res) => {
  const portfolioId = parseInt(req.params.id, 10);
  if (isNaN(portfolioId)) {
    return res.status(400).json({ success: false, error: 'ID portafoglio non valido.' });
  }

  const access = checkPortfolioAccess(portfolioId, req.user.id, req.user.role);
  if (!access.isOwner) {
    return res.status(403).json({ success: false, error: 'Solo il proprietario o un amministratore può eliminare il portafoglio.' });
  }

  const deleteTx = db.transaction(() => {
    db.prepare('DELETE FROM transactions WHERE portfolioId = ?').run(portfolioId);
    db.prepare('DELETE FROM dividend_projections WHERE portfolioId = ?').run(portfolioId);
    db.prepare('DELETE FROM portfolio_history WHERE portfolioId = ?').run(portfolioId);
    db.prepare('DELETE FROM portfolio_losses WHERE portfolioId = ?').run(portfolioId);
    db.prepare('DELETE FROM portfolio_users WHERE portfolio_id = ?').run(portfolioId);
    const result = db.prepare('DELETE FROM portfolios WHERE id = ?').run(portfolioId);
    return result.changes > 0;
  });

  const deleted = deleteTx();
  if (!deleted) {
    return res.status(404).json({ success: false, error: 'Portafoglio non trovato.' });
  }

  return res.json({
    success: true,
    message: 'Portafoglio eliminato con successo.'
  });
});

module.exports = {
  router,
  recalculatePortfolio,
  checkPortfolioAccess,
  getAssetsMap
};
