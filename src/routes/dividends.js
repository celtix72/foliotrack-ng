/**
 * Income & Dividends Route for FolioTrack
 * Tracks historical dividends/interest cash flows, computes 12-month forward projections,
 * YoY dividend growth, and breakdowns by asset, account, and type.
 */

const express = require('express');
const { db } = require('../db');
const { requireAuth } = require('../middlewares/authMiddleware');
const { recalculatePortfolio, checkPortfolioAccess, getAssetsMap } = require('./portfolios');
const { calculateAnnualDividendsHistory, calculateDividendForecast } = require('../utils/dividendForecast');

const router = express.Router();

router.use(requireAuth);

/**
 * Recalculates and updates forward 12-month dividend projections for a portfolio.
 *
 * @param {number} portfolioId
 * @returns {object[]} Array of updated projection rows
 */
function recalculateDividendProjections(portfolioId) {
  const pId = parseInt(portfolioId, 10);
  if (isNaN(pId)) return [];

  const snapshot = recalculatePortfolio(pId);
  if (!snapshot || !snapshot.metrics || !snapshot.metrics.holdings) return [];

  const holdings = snapshot.metrics.holdings;
  const currentTickers = new Set();

  const upsertStmt = db.prepare(`
    INSERT INTO dividend_projections (
      portfolioId, assetTicker, projectedAnnualIncome, projectedMonthlyIncome,
      dividendYield, sharesHeld, currentPrice, currency, calculatedAt
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(portfolioId, assetTicker) DO UPDATE SET
      projectedAnnualIncome = excluded.projectedAnnualIncome,
      projectedMonthlyIncome = excluded.projectedMonthlyIncome,
      dividendYield = excluded.dividendYield,
      sharesHeld = excluded.sharesHeld,
      currentPrice = excluded.currentPrice,
      currency = excluded.currency,
      calculatedAt = datetime('now')
  `);

  const runAtomic = db.transaction(() => {
    for (const h of holdings) {
      if (h.quantity > 1e-6) {
        const tkr = h.ticker.toUpperCase();
        currentTickers.add(tkr);
        let yieldPct = Number(h.dividendYield) || 0.0;
        const currentPrice = Number(h.currentPrice) || 0.0;
        let annualIncome = (yieldPct > 0) ? (h.quantity * currentPrice * (yieldPct / 100.0)) : 0.0;

        // Deducing coupon/dividend yield from historical payments for bonds/assets with 0 yield
        if (annualIncome <= 0) {
          const hist = db.prepare(`
            SELECT SUM(amount) as total
            FROM transactions
            WHERE UPPER(assetTicker) = ? AND type IN ('DIVIDEND', 'INTEREST')
              AND date >= date('now', '-1 year')
          `).get(tkr);
          if (hist && hist.total > 0) {
            annualIncome = Number(hist.total) || 0.0;
            if (h.quantity * currentPrice > 0) {
              yieldPct = Number(((annualIncome / (h.quantity * currentPrice)) * 100).toFixed(2));
            }
          }
        }

        const monthlyIncome = annualIncome / 12.0;

        upsertStmt.run(
          pId,
          tkr,
          annualIncome,
          monthlyIncome,
          yieldPct,
          h.quantity,
          currentPrice,
          snapshot.currency || 'EUR'
        );
      }
    }

    // Delete projections for positions that have been closed (0 shares)
    const existing = db.prepare('SELECT assetTicker FROM dividend_projections WHERE portfolioId = ?').all(pId);
    const deleteStmt = db.prepare('DELETE FROM dividend_projections WHERE portfolioId = ? AND assetTicker = ?');
    for (const row of existing) {
      if (!currentTickers.has(row.assetTicker.toUpperCase())) {
        deleteStmt.run(pId, row.assetTicker);
      }
    }
  });

  runAtomic();

  return db.prepare('SELECT * FROM dividend_projections WHERE portfolioId = ?').all(pId);
}

/**
 * GET /api/dividends/income-summary
 * Aggregates dividend and interest cash flows by month, asset, account, and type,
 * along with YoY growth and 12-month forward projections.
 */
router.get('/income-summary', (req, res) => {
  const { portfolioId } = req.query;
  const userId = req.user.id;
  const userRole = req.user.role;

  // Build portfolio filter condition
  const conditions = ["t.type IN ('DIVIDEND', 'INTEREST')"];
  const params = [];

  if (userRole !== 'admin') {
    conditions.push(`t.portfolioId IN (
      SELECT portfolio_id FROM portfolio_users WHERE user_id = ?
    )`);
    params.push(userId);
  }

  if (portfolioId && portfolioId !== 'all') {
    const pId = parseInt(portfolioId, 10);
    if (!isNaN(pId)) {
      const access = checkPortfolioAccess(pId, userId, userRole);
      if (!access.hasAccess) {
        return res.status(403).json({ success: false, error: 'Accesso negato al portafoglio.' });
      }
      conditions.push('t.portfolioId = ?');
      params.push(pId);
    }
  }

  const whereClause = `WHERE ${conditions.join(' AND ')}`;

  // 1. Total received cash flows
  const totalRow = db.prepare(`
    SELECT SUM(t.amount) as total
    FROM transactions t
    ${whereClause}
  `).get(...params);
  const totalReceived = totalRow ? (Number(totalRow.total) || 0.0) : 0.0;

  // 2. Breakdown by Type (DIVIDEND vs INTEREST)
  const byTypeRows = db.prepare(`
    SELECT t.type, SUM(t.amount) as amount, COUNT(*) as count
    FROM transactions t
    ${whereClause}
    GROUP BY t.type
  `).all(...params);

  const byType = {
    dividends: 0.0,
    interest: 0.0,
    total: totalReceived
  };

  for (const row of byTypeRows) {
    if (row.type === 'DIVIDEND') byType.dividends = Number(row.amount) || 0.0;
    if (row.type === 'INTEREST') byType.interest = Number(row.amount) || 0.0;
  }

  // 3. Breakdown by Month (last 48 months to cover 3 full calendar years)
  const monthlyRows = db.prepare(`
    SELECT strftime('%Y-%m', t.date) as month,
           t.type,
           SUM(t.amount) as amount
    FROM transactions t
    ${whereClause}
      AND t.date >= date('now', '-48 months')
    GROUP BY month, t.type
    ORDER BY month ASC
  `).all(...params);

  const monthMap = {};
  for (const row of monthlyRows) {
    if (!monthMap[row.month]) {
      monthMap[row.month] = { month: row.month, dividends: 0.0, interest: 0.0, total: 0.0 };
    }
    const amt = Number(row.amount) || 0.0;
    if (row.type === 'DIVIDEND') monthMap[row.month].dividends += amt;
    if (row.type === 'INTEREST') monthMap[row.month].interest += amt;
    monthMap[row.month].total += amt;
  }

  const byMonth = Object.values(monthMap).sort((a, b) => a.month.localeCompare(b.month));

  // 4. Breakdown by Asset (ranking of most profitable titles)
  const assetRows = db.prepare(`
    SELECT t.assetTicker,
           a.name as assetName,
           a.type as assetType,
           SUM(t.amount) as amount,
           COUNT(*) as count
    FROM transactions t
    LEFT JOIN assets a ON a.ticker = t.assetTicker
    ${whereClause}
    GROUP BY t.assetTicker
    ORDER BY amount DESC
  `).all(...params);

  const byAsset = assetRows.map(row => ({
    ticker: row.assetTicker || 'UNKNOWN',
    name: row.assetName || row.assetTicker || 'Unclassified',
    type: row.assetType || 'EQUITY',
    amount: Number(row.amount) || 0.0,
    count: row.count,
    percentOfTotal: totalReceived > 0 ? ((Number(row.amount) || 0.0) / totalReceived) * 100.0 : 0.0
  }));

  // 5. Breakdown by Account / Broker
  const accountRows = db.prepare(`
    SELECT t.portfolioId,
           p.name as portfolioName,
           p.currency,
           SUM(t.amount) as amount,
           COUNT(*) as count
    FROM transactions t
    LEFT JOIN portfolios p ON p.id = t.portfolioId
    ${whereClause}
    GROUP BY t.portfolioId
    ORDER BY amount DESC
  `).all(...params);

  const byAccount = accountRows.map(row => ({
    portfolioId: row.portfolioId,
    portfolioName: row.portfolioName || `Portafoglio #${row.portfolioId}`,
    currency: row.currency || 'EUR',
    amount: Number(row.amount) || 0.0,
    count: row.count,
    percentOfTotal: totalReceived > 0 ? ((Number(row.amount) || 0.0) / totalReceived) * 100.0 : 0.0
  }));

  // 6. Year-over-Year (YoY) Growth calculation
  const currentYear = new Date().getFullYear();
  const yearlyRows = db.prepare(`
    SELECT strftime('%Y', t.date) as yr,
           SUM(t.amount) as amount
    FROM transactions t
    ${whereClause}
    GROUP BY yr
    ORDER BY yr ASC
  `).all(...params);

  const yoyMap = {};
  for (const r of yearlyRows) {
    yoyMap[r.yr] = Number(r.amount) || 0.0;
  }

  const prevYear = String(currentYear - 1);
  const curYearStr = String(currentYear);
  const prevAmount = yoyMap[prevYear] || 0.0;
  const curAmount = yoyMap[curYearStr] || 0.0;

  const yoyGrowthRate = prevAmount > 0 ? ((curAmount - prevAmount) / prevAmount) * 100.0 : 0.0;

  const yoyGrowth = {
    history: yoyMap,
    currentYear: curAmount,
    previousYear: prevAmount,
    growthRatePct: yoyGrowthRate
  };

  // 7. Forward 12-Month Dividend Projections
  let projConditions = '';
  const projParams = [];
  if (userRole !== 'admin') {
    projConditions += 'WHERE dp.portfolioId IN (SELECT portfolio_id FROM portfolio_users WHERE user_id = ?)';
    projParams.push(userId);
  }
  if (portfolioId && portfolioId !== 'all') {
    const pId = parseInt(portfolioId, 10);
    if (!isNaN(pId)) {
      projConditions += projConditions ? ' AND dp.portfolioId = ?' : 'WHERE dp.portfolioId = ?';
      projParams.push(pId);
    }
  }

  const projections = db.prepare(`
    SELECT dp.*, a.name as assetName
    FROM dividend_projections dp
    LEFT JOIN assets a ON a.ticker = dp.assetTicker
    ${projConditions}
    ORDER BY dp.projectedAnnualIncome DESC
  `).all(...projParams);

  let projectedNext12Months = 0.0;
  let projectedMonthlyAverage = 0.0;

  for (const p of projections) {
    projectedNext12Months += Number(p.projectedAnnualIncome) || 0.0;
    projectedMonthlyAverage += Number(p.projectedMonthlyIncome) || 0.0;
  }

  // 8. Historical Annual Dividends & Dynamic Projections
  const allFilteredTx = db.prepare(`
    SELECT t.*
    FROM transactions t
    ${whereClause}
    ORDER BY t.date ASC
  `).all(...params);

  const assetsMap = getAssetsMap ? getAssetsMap() : {};

  let activeHoldings = [];
  if (portfolioId && portfolioId !== 'all') {
    const pId = parseInt(portfolioId, 10);
    if (!isNaN(pId)) {
      const snap = recalculatePortfolio(pId, assetsMap);
      if (snap && snap.metrics && snap.metrics.holdings) {
        activeHoldings = snap.metrics.holdings.filter(h => h.quantity > 1e-6);
      }
    }
  } else {
    let userPortfolios = [];
    if (userRole === 'admin') {
      userPortfolios = db.prepare('SELECT id, name, currency FROM portfolios').all();
    } else {
      userPortfolios = db.prepare(`
        SELECT p.id, p.name, p.currency
        FROM portfolios p
        INNER JOIN portfolio_users pu ON pu.portfolio_id = p.id
        WHERE pu.user_id = ?
      `).all(userId);
    }
    const mergedMap = new Map();
    for (const p of userPortfolios) {
      const snap = recalculatePortfolio(p.id, assetsMap);
      if (!snap || !snap.metrics || !snap.metrics.holdings) continue;
      for (const h of snap.metrics.holdings) {
        if (h.quantity <= 1e-6) continue;
        const tkr = h.ticker.toUpperCase();
        if (!mergedMap.has(tkr)) {
          mergedMap.set(tkr, {
            ticker: tkr,
            name: h.name || tkr,
            type: h.type || 'EQUITY',
            quantity: 0,
            marketValue: 0,
            currentPrice: h.currentPrice || 0,
            dividendYield: Number(h.dividendYield) || 0
          });
        }
        const existing = mergedMap.get(tkr);
        existing.quantity += Number(h.quantity) || 0;
        existing.marketValue += Number(h.marketValue) || 0;
        if (Number(h.dividendYield) > 0) existing.dividendYield = Number(h.dividendYield);
        if (Number(h.currentPrice) > 0) existing.currentPrice = Number(h.currentPrice);
      }
    }
    activeHoldings = Array.from(mergedMap.values());
  }

  const annualDividends = calculateAnnualDividendsHistory(allFilteredTx, assetsMap);
  const forecast = calculateDividendForecast(activeHoldings, allFilteredTx, assetsMap);

  return res.json({
    success: true,
    summary: {
      totalReceived,
      projectedNext12Months: (forecast.nextYearForecast && forecast.nextYearForecast.totalProjected > 0)
        ? forecast.nextYearForecast.totalProjected
        : projectedNext12Months,
      projectedMonthlyAverage: (forecast.nextYearForecast && forecast.nextYearForecast.monthlyAverage > 0)
        ? forecast.nextYearForecast.monthlyAverage
        : projectedMonthlyAverage,
      byMonth,
      byAsset,
      byAccount,
      byType,
      yoyGrowth,
      projections,
      annualDividends,
      currentYearForecast: forecast.currentYearForecast,
      nextYearForecast: forecast.nextYearForecast
    }
  });
});

/**
 * GET /api/dividends/projections
 * Lists active forward dividend projections.
 */
router.get('/projections', (req, res) => {
  const { portfolioId } = req.query;
  const userId = req.user.id;
  const userRole = req.user.role;

  let where = '';
  const params = [];

  if (userRole !== 'admin') {
    where = 'WHERE dp.portfolioId IN (SELECT portfolio_id FROM portfolio_users WHERE user_id = ?)';
    params.push(userId);
  }

  if (portfolioId) {
    const pId = parseInt(portfolioId, 10);
    if (!isNaN(pId)) {
      where += where ? ' AND dp.portfolioId = ?' : 'WHERE dp.portfolioId = ?';
      params.push(pId);
    }
  }

  const rows = db.prepare(`
    SELECT dp.*, a.name as assetName, p.name as portfolioName
    FROM dividend_projections dp
    LEFT JOIN assets a ON a.ticker = dp.assetTicker
    LEFT JOIN portfolios p ON p.id = dp.portfolioId
    ${where}
    ORDER BY dp.projectedAnnualIncome DESC
  `).all(...params);

  return res.json({
    success: true,
    projections: rows
  });
});

/**
 * POST /api/dividends/recalculate
 * Triggers re-computation of forward projections for a portfolio.
 */
router.post('/recalculate', (req, res) => {
  const portfolioId = parseInt(req.body.portfolioId || req.query.portfolioId, 10);
  if (isNaN(portfolioId)) {
    return res.status(400).json({ success: false, error: 'portfolioId obbligatorio.' });
  }

  const access = checkPortfolioAccess(portfolioId, req.user.id, req.user.role);
  if (!access.hasAccess) {
    return res.status(403).json({ success: false, error: 'Accesso negato al portafoglio.' });
  }

  const updatedProjections = recalculateDividendProjections(portfolioId);

  return res.json({
    success: true,
    message: 'Proiezioni dividendi ricalcolate con successo.',
    projections: updatedProjections
  });
});

module.exports = {
  router,
  recalculateDividendProjections
};

