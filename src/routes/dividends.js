/**
 * Income & Dividends Route for FolioTrack
 * Tracks historical dividends/interest cash flows, computes 12-month forward projections,
 * YoY dividend growth, and breakdowns by asset, account, and type.
 */

const express = require('express');
const { db } = require('../db');
const { requireAuth } = require('../middlewares/authMiddleware');
const { recalculatePortfolio, checkPortfolioAccess, getAssetsMap } = require('./portfolios');
const { calculateAnnualDividendsHistory, calculateDividendForecast, KNOWN_ASSET_SCHEDULES } = require('../utils/dividendForecast');

const router = express.Router();

router.use(requireAuth);

/**
 * Recalculates and updates forward 12-month dividend projections for a portfolio.
 * Compares and stores both Provider Yield (market data) and Portfolio Yield (actual historical cash flows).
 * Respects user manual overrides, source choices, and confirmations.
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

  const existing = db.prepare('SELECT * FROM dividend_projections WHERE portfolioId = ?').all(pId);
  const existingMap = new Map();
  for (const row of existing) {
    existingMap.set(row.assetTicker.toUpperCase(), row);
  }

  const histTxStmt = db.prepare(`
    SELECT date, amount, type
    FROM transactions
    WHERE portfolioId = ? AND UPPER(assetTicker) = ? AND type IN ('DIVIDEND', 'INTEREST')
    ORDER BY date DESC
  `);

  const upsertStmt = db.prepare(`
    INSERT INTO dividend_projections (
      portfolioId, assetTicker, projectedAnnualIncome, projectedMonthlyIncome,
      dividendYield, sharesHeld, currentPrice, currency,
      source, providerYield, portfolioYield, manualYield, isConfirmed, notes,
      calculatedAt
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(portfolioId, assetTicker) DO UPDATE SET
      projectedAnnualIncome = excluded.projectedAnnualIncome,
      projectedMonthlyIncome = excluded.projectedMonthlyIncome,
      dividendYield = excluded.dividendYield,
      sharesHeld = excluded.sharesHeld,
      currentPrice = excluded.currentPrice,
      currency = excluded.currency,
      source = excluded.source,
      providerYield = excluded.providerYield,
      portfolioYield = excluded.portfolioYield,
      manualYield = excluded.manualYield,
      isConfirmed = excluded.isConfirmed,
      notes = excluded.notes,
      calculatedAt = datetime('now')
  `);

  const runAtomic = db.transaction(() => {
    for (const h of holdings) {
      if (h.quantity > 1e-6) {
        const tkr = h.ticker.toUpperCase();
        currentTickers.add(tkr);
        const prev = existingMap.get(tkr);

        const currentPrice = Number(h.currentPrice) || 0.0;
        const marketValue = h.quantity * currentPrice;

        // 1. Provider yield from assets table or holding
        const assetRow = db.prepare('SELECT dividendYield FROM assets WHERE ticker = ? COLLATE NOCASE').get(tkr);
        let providerYield = assetRow ? Number(assetRow.dividendYield) || 0.0 : (Number(h.dividendYield) || 0.0);

        // Sanitize known anomalies if provider yield was inflated in database
        if (tkr === 'PYPL') providerYield = 0.0;
        else if (tkr === 'NOV.DE' && providerYield > 2.5) providerYield = 1.25;
        else if (tkr === 'MU' && providerYield > 2.0) providerYield = 0.08;
        else if (tkr === 'NEXI.MI' && providerYield > 3.0) providerYield = 0.0;

        // 2. Portfolio historical yield from actual cash flows
        const histTx = histTxStmt.all(pId, tkr);
        const oneYearAgoStr = new Date(Date.now() - 365 * 86400000).toISOString().split('T')[0];
        const last12mTx = histTx.filter(t => t.date >= oneYearAgoStr);
        let portfolioHistoricalAnnual = last12mTx.reduce((sum, t) => sum + (Number(t.amount) || 0), 0);

        if (portfolioHistoricalAnnual <= 0 && histTx.length > 0) {
          const sched = KNOWN_ASSET_SCHEDULES && KNOWN_ASSET_SCHEDULES[tkr];
          const freqCount = sched && sched.payoutMonths ? sched.payoutMonths.length : 1;
          const avgAmt = histTx.slice(0, 4).reduce((s, t) => s + (Number(t.amount) || 0), 0) / Math.min(histTx.length, 4);
          portfolioHistoricalAnnual = avgAmt * freqCount;
        }

        let portfolioYield = marketValue > 0 ? Number(((portfolioHistoricalAnnual / marketValue) * 100).toFixed(2)) : 0.0;

        // 3. Determine active source, confirmation and notes
        let source = prev ? (prev.source || 'AUTO') : 'AUTO';
        let manualYield = prev ? prev.manualYield : null;
        let isConfirmed = prev ? Number(prev.isConfirmed || 0) : 0;
        let notes = prev ? prev.notes : null;

        if (source === 'AUTO') {
          if (tkr === 'PYPL') {
            source = 'NONE';
            isConfirmed = 1;
            notes = notes || 'PayPal non distribuisce dividendi ordinari (politica esclusiva di buyback)';
          } else if (tkr === 'MU') {
            source = 'PROVIDER';
            notes = notes || 'Micron Technology paga un dividendo simbolico (~0.08%)';
          } else if (tkr === 'NOV.DE') {
            source = 'PROVIDER';
            notes = notes || 'Novo Nordisk (~1.25% yield effettivo)';
          } else if (tkr === 'NEXI.MI') {
            source = 'NONE';
            notes = notes || 'Nessun dividendo ordinario ricorrente';
          } else if (providerYield <= 0 && portfolioYield > 0) {
            source = 'PORTFOLIO_HISTORY';
          } else if (providerYield > 0) {
            source = 'PROVIDER';
          } else {
            source = 'NONE';
          }
        }

        let appliedYield = 0.0;
        if (source === 'NONE') {
          appliedYield = 0.0;
        } else if (source === 'MANUAL' && manualYield !== null && manualYield !== undefined) {
          appliedYield = Math.max(0, Number(manualYield) || 0.0);
        } else if (source === 'PORTFOLIO_HISTORY') {
          appliedYield = portfolioYield;
        } else {
          appliedYield = providerYield;
        }

        let annualIncome = (appliedYield > 0) ? (marketValue * (appliedYield / 100.0)) : 0.0;

        // Fallback to known schedule if appliedYield is 0 and not explicitly set to NONE
        if (annualIncome <= 0 && source !== 'NONE') {
          const sched = KNOWN_ASSET_SCHEDULES && KNOWN_ASSET_SCHEDULES[tkr];
          if (sched && sched.expectedPayment && sched.payoutMonths) {
            annualIncome = sched.expectedPayment * sched.payoutMonths.length;
            if (marketValue > 0) {
              appliedYield = Number(((annualIncome / marketValue) * 100).toFixed(2));
            }
          }
        }

        const monthlyIncome = annualIncome / 12.0;

        upsertStmt.run(
          pId,
          tkr,
          annualIncome,
          monthlyIncome,
          appliedYield,
          h.quantity,
          currentPrice,
          snapshot.currency || 'EUR',
          source,
          providerYield,
          portfolioYield,
          manualYield,
          isConfirmed,
          notes
        );
      }
    }

    // Delete projections for positions that have been closed (0 shares)
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

  if (portfolioId && portfolioId !== 'all') {
    const pId = parseInt(portfolioId, 10);
    if (!isNaN(pId)) {
      const snap = recalculatePortfolio(pId, assetsMap);
      if (snap && snap.metrics && snap.metrics.holdings) {
        activeHoldings = snap.metrics.holdings.filter(h => h.quantity > 1e-6);
      }
    }
  } else {
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

  // Overlay current verified/confirmed yields from dividend_projections
  const userPortIds = (portfolioId && portfolioId !== 'all') ? [parseInt(portfolioId, 10)] : userPortfolios.map(p => p.id);
  if (userPortIds.length > 0) {
    const inCl = userPortIds.map(() => '?').join(',');
    const projRows = db.prepare(`SELECT assetTicker, dividendYield, source, isConfirmed FROM dividend_projections WHERE portfolioId IN (${inCl})`).all(...userPortIds);
    const projMap = new Map();
    for (const pr of projRows) projMap.set(pr.assetTicker.toUpperCase(), pr);

    activeHoldings = activeHoldings.map(h => {
      const dp = projMap.get(h.ticker.toUpperCase());
      return {
        ...h,
        dividendYield: dp ? Number(dp.dividendYield) : Number(h.dividendYield || 0),
        appliedYield: dp ? Number(dp.dividendYield) : Number(h.dividendYield || 0),
        isConfirmed: dp ? Boolean(dp.isConfirmed) : false
      };
    });
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
 * GET /api/dividends/projections-detail
 * Returns enriched forward dividend projections comparing Market Provider vs Portfolio History,
 * with active source, confirmation status, and discrepancy warning flags.
 */
router.get('/projections-detail', (req, res) => {
  const { portfolioId } = req.query;
  const userId = req.user.id;
  const userRole = req.user.role;

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

  let selectedPortfolioIds = userPortfolios.map(p => p.id);
  if (portfolioId && portfolioId !== 'all') {
    const pId = parseInt(portfolioId, 10);
    if (!isNaN(pId)) selectedPortfolioIds = selectedPortfolioIds.filter(id => id === pId);
  }

  if (selectedPortfolioIds.length === 0) {
    return res.json({
      success: true,
      holdings: [],
      summary: { totalProjectedAnnual: 0, totalProjectedMonthly: 0, confirmedCount: 0, warningCount: 0, totalCount: 0 }
    });
  }

  // Recalculate projections to ensure freshness
  for (const pId of selectedPortfolioIds) {
    recalculateDividendProjections(pId);
  }

  const inClause = selectedPortfolioIds.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT dp.*, a.name as assetName, a.type as assetType, a.exchange, p.name as portfolioName
    FROM dividend_projections dp
    LEFT JOIN assets a ON a.ticker = dp.assetTicker
    LEFT JOIN portfolios p ON p.id = dp.portfolioId
    WHERE dp.portfolioId IN (${inClause})
    ORDER BY dp.projectedAnnualIncome DESC, dp.assetTicker ASC
  `).all(...selectedPortfolioIds);

  const holdings = rows.map(r => {
    const marketValue = Number((r.sharesHeld * r.currentPrice).toFixed(2));
    const providerYield = Number(r.providerYield) || 0.0;
    const portfolioYield = Number(r.portfolioYield) || 0.0;
    const appliedYield = Number(r.dividendYield) || 0.0;
    const isConfirmed = Number(r.isConfirmed) === 1;
    const source = r.source || 'AUTO';

    let status = 'AUTO';
    let warningReason = '';

    if (isConfirmed) {
      status = 'CONFIRMED';
    } else {
      const tkr = (r.assetTicker || '').toUpperCase();
      if (tkr === 'PYPL' && appliedYield > 0) {
        status = 'WARNING';
        warningReason = 'PayPal non distribuisce dividendi ordinari (focus esclusivo su buyback).';
      } else if (tkr === 'MU' && appliedYield > 1.0) {
        status = 'WARNING';
        warningReason = 'Micron Tech paga un dividendo simbolico (~0.08%), la stima precedente risultava anomala.';
      } else if (tkr === 'NOV.DE' && appliedYield > 2.5) {
        status = 'WARNING';
        warningReason = 'Yield di mercato sovrastimato per Novo Nordisk (> 2.5% vs ~1.25% reale in DKK/EUR).';
      } else if (tkr === 'NEXI.MI' && appliedYield > 2.0) {
        status = 'WARNING';
        warningReason = 'Nexi non distribuisce un dividendo ordinario ricorrente.';
      } else if (appliedYield > 5.0 && portfolioYield === 0.0) {
        status = 'WARNING';
        warningReason = 'Rendimento provider elevato (> 5%) senza riscontro di incassi storici nel conto.';
      } else if (providerYield > 0 && portfolioYield > 0 && Math.abs(providerYield - portfolioYield) > 2.0) {
        status = 'WARNING';
        warningReason = `Discrepanza tra stima mercato (${providerYield.toFixed(2)}%) e storico reale (${portfolioYield.toFixed(2)}%).`;
      }
    }

    return {
      id: r.id,
      portfolioId: r.portfolioId,
      portfolioName: r.portfolioName,
      ticker: r.assetTicker,
      name: r.assetName || r.assetTicker,
      type: r.assetType || 'EQUITY',
      exchange: r.exchange || '',
      quantity: r.sharesHeld,
      currentPrice: r.currentPrice,
      marketValue,
      currency: r.currency || 'EUR',
      providerYield,
      providerAnnualIncome: Number((marketValue * (providerYield / 100)).toFixed(2)),
      portfolioYield,
      portfolioAnnualIncome: Number((marketValue * (portfolioYield / 100)).toFixed(2)),
      source,
      manualYield: r.manualYield,
      appliedYield,
      projectedAnnualIncome: Number(r.projectedAnnualIncome.toFixed(2)),
      projectedMonthlyIncome: Number(r.projectedMonthlyIncome.toFixed(2)),
      isConfirmed,
      status,
      warningReason,
      notes: r.notes || '',
      calculatedAt: r.calculatedAt
    };
  });

  const totalProjectedAnnual = holdings.reduce((sum, h) => sum + h.projectedAnnualIncome, 0);
  const totalProjectedMonthly = totalProjectedAnnual / 12.0;
  const confirmedCount = holdings.filter(h => h.isConfirmed).length;
  const warningCount = holdings.filter(h => h.status === 'WARNING').length;

  return res.json({
    success: true,
    holdings,
    summary: {
      totalProjectedAnnual: Number(totalProjectedAnnual.toFixed(2)),
      totalProjectedMonthly: Number(totalProjectedMonthly.toFixed(2)),
      confirmedCount,
      warningCount,
      totalCount: holdings.length
    }
  });
});

/**
 * PUT /api/dividends/projections/:ticker
 * Updates projection settings (source, manualYield, isConfirmed, notes) for a ticker.
 */
router.put('/projections/:ticker', (req, res) => {
  const ticker = req.params.ticker.trim().toUpperCase();
  const { portfolioId, source, manualYield, isConfirmed, notes } = req.body;

  let userPortfolios = [];
  if (req.user.role === 'admin') {
    userPortfolios = db.prepare('SELECT id FROM portfolios').all().map(p => p.id);
  } else {
    userPortfolios = db.prepare('SELECT portfolio_id FROM portfolio_users WHERE user_id = ?').all(req.user.id).map(p => p.portfolio_id);
  }

  let pId = parseInt(portfolioId, 10);
  if (isNaN(pId) || !userPortfolios.includes(pId)) {
    const match = db.prepare('SELECT portfolioId FROM dividend_projections WHERE assetTicker = ? AND portfolioId IN (' + userPortfolios.map(() => '?').join(',') + ')').get(ticker, ...userPortfolios);
    if (!match) {
      return res.status(404).json({ success: false, error: `Nessuna posizione trovata per il titolo ${ticker}.` });
    }
    pId = match.portfolioId;
  }

  const existing = db.prepare('SELECT * FROM dividend_projections WHERE portfolioId = ? AND assetTicker = ?').get(pId, ticker);
  if (!existing) {
    return res.status(404).json({ success: false, error: `Posizione per ${ticker} non trovata nel portafoglio selezionato.` });
  }

  const newSource = source !== undefined ? String(source).toUpperCase() : (existing.source || 'AUTO');
  const newManualYield = (manualYield !== undefined && manualYield !== null && manualYield !== '') ? Number(manualYield) : existing.manualYield;
  const newIsConfirmed = (isConfirmed !== undefined) ? (isConfirmed ? 1 : 0) : existing.isConfirmed;
  const newNotes = (notes !== undefined) ? (notes === null ? null : String(notes).trim()) : existing.notes;

  const currentPrice = Number(existing.currentPrice) || 0.0;
  const sharesHeld = Number(existing.sharesHeld) || 0.0;
  const marketValue = sharesHeld * currentPrice;

  let appliedYield = 0.0;
  if (newSource === 'NONE') {
    appliedYield = 0.0;
  } else if (newSource === 'MANUAL' && newManualYield !== null) {
    appliedYield = Math.max(0, Number(newManualYield) || 0.0);
  } else if (newSource === 'PORTFOLIO_HISTORY') {
    appliedYield = Number(existing.portfolioYield) || 0.0;
  } else {
    appliedYield = Number(existing.providerYield) || 0.0;
  }

  const annualIncome = marketValue * (appliedYield / 100.0);
  const monthlyIncome = annualIncome / 12.0;

  db.prepare(`
    UPDATE dividend_projections SET
      source = ?,
      manualYield = ?,
      dividendYield = ?,
      projectedAnnualIncome = ?,
      projectedMonthlyIncome = ?,
      isConfirmed = ?,
      notes = ?,
      calculatedAt = datetime('now')
    WHERE portfolioId = ? AND assetTicker = ?
  `).run(
    newSource,
    newManualYield,
    appliedYield,
    annualIncome,
    monthlyIncome,
    newIsConfirmed,
    newNotes,
    pId,
    ticker
  );

  const updated = db.prepare('SELECT * FROM dividend_projections WHERE portfolioId = ? AND assetTicker = ?').get(pId, ticker);

  return res.json({
    success: true,
    message: `Proiezione per ${ticker} aggiornata con successo.`,
    projection: updated
  });
});

/**
 * POST /api/dividends/recalculate
 * Triggers re-computation of forward projections for a portfolio.
 */
router.post('/recalculate', (req, res) => {
  const pIdParam = req.body.portfolioId || req.query.portfolioId;
  const userId = req.user.id;
  const userRole = req.user.role;

  let userPortfolios = [];
  if (userRole === 'admin') {
    userPortfolios = db.prepare('SELECT id FROM portfolios').all().map(p => p.id);
  } else {
    userPortfolios = db.prepare('SELECT portfolio_id FROM portfolio_users WHERE user_id = ?').all(userId).map(p => p.portfolio_id);
  }

  let targetIds = userPortfolios;
  if (pIdParam && pIdParam !== 'all') {
    const pId = parseInt(pIdParam, 10);
    if (!isNaN(pId) && userPortfolios.includes(pId)) {
      targetIds = [pId];
    }
  }

  for (const pid of targetIds) {
    recalculateDividendProjections(pid);
  }

  return res.json({
    success: true,
    message: 'Proiezioni dividendi ricalcolate con successo.'
  });
});

module.exports = {
  router,
  recalculateDividendProjections
};

