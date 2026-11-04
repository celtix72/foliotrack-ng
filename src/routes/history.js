/**
 * Portfolio History & Daily Snapshot Engine for FolioTrack
 * Records immutable daily NAV snapshots and generates performance & drawdown time-series.
 */

const express = require('express');
const { db } = require('../db');
const { requireAuth } = require('../middlewares/authMiddleware');
const { recalculatePortfolio, checkPortfolioAccess } = require('./portfolios');
const { reconstructPortfolioHistoryFromQuotes, ensureHistoricalQuotesIfMissing } = require('../services/marketService');
const { calculateXIRR, calculateTWR } = require('../utils/finance');

const router = express.Router();

router.use(requireAuth);

/**
 * Records an immutable snapshot of portfolio values for a given date.
 * If no date is given, defaults to current date (YYYY-MM-DD).
 *
 * @param {number|null} [portfolioId=null]
 * @param {string|null} [snapshotDate=null]
 * @returns {object[]} Array of recorded snapshot rows
 */
function recordDailySnapshot(portfolioId = null, snapshotDate = null) {
  const dateStr = snapshotDate || new Date().toISOString().split('T')[0];

  let portfoliosToProcess = [];
  if (portfolioId) {
    const p = db.prepare('SELECT * FROM portfolios WHERE id = ?').get(portfolioId);
    if (p) portfoliosToProcess.push(p);
  } else {
    portfoliosToProcess = db.prepare('SELECT * FROM portfolios').all();
  }

  const upsertStmt = db.prepare(`
    INSERT INTO portfolio_history (
      portfolioId, date, totalValue, cashValue, assetValue, netDeposits, user_id, createdAt
    ) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(portfolioId, date) DO UPDATE SET
      totalValue = excluded.totalValue,
      cashValue = excluded.cashValue,
      assetValue = excluded.assetValue,
      netDeposits = excluded.netDeposits,
      createdAt = datetime('now')
  `);

  const results = [];

  const runAtomic = db.transaction(() => {
    for (const p of portfoliosToProcess) {
      const recalculated = recalculatePortfolio(p.id) || p;
      const totalVal = Number(recalculated.totalValue) || 0.0;
      const cashVal = Number(recalculated.currentCash) || 0.0;
      const assetVal = Math.max(0.0, totalVal - cashVal);
      const netDeps = Number(recalculated.investedCapital) || 0.0;

      // Find owner user_id
      const owner = db.prepare(`
        SELECT user_id FROM portfolio_users
        WHERE portfolio_id = ? AND role = 'owner'
        LIMIT 1
      `).get(p.id);

      const userId = owner ? owner.user_id : null;

      upsertStmt.run(p.id, dateStr, totalVal, cashVal, assetVal, netDeps, userId);

      results.push({
        portfolioId: p.id,
        date: dateStr,
        totalValue: totalVal,
        cashValue: cashVal,
        assetValue: assetVal,
        netDeposits: netDeps
      });
    }
  });

  runAtomic();
  return results;
}

/**
 * Ensures real quantitative portfolio history exists.
 * Reconstructs daily NAV series from real transactions and historical asset quotes.
 *
 * @param {number} portfolioId
 * @param {number} [days=1825]
 */
function ensureRealPortfolioHistory(portfolioId, days = 1825) {
  const txCount = db.prepare('SELECT COUNT(*) as c FROM transactions WHERE portfolioId = ?').get(portfolioId).c;
  if (txCount === 0) {
    recordDailySnapshot(portfolioId);
    return;
  }

  // Count real historical points with valid value
  const histCount = db.prepare('SELECT COUNT(*) as c FROM portfolio_history WHERE portfolioId = ? AND totalValue > 0').get(portfolioId).c;
  const latestTx = db.prepare('SELECT MAX(date) as maxD FROM transactions WHERE portfolioId = ?').get(portfolioId).maxD;
  const latestHist = db.prepare('SELECT MAX(date) as maxD FROM portfolio_history WHERE portfolioId = ?').get(portfolioId).maxD;

  if (histCount < 2 || !latestHist || (latestTx && latestTx > latestHist)) {
    reconstructPortfolioHistoryFromQuotes(portfolioId, days);
  }
}

function backfillHistoryIfEmpty(portfolioId, days = 1825) {
  return ensureRealPortfolioHistory(portfolioId, days);
}

/**
 * GET /api/history/performance
 * Returns historical NAV time-series, cumulative returns %, and drawdown series.
 */
router.get('/performance', (req, res) => {
  const { portfolioId, range = '1Y' } = req.query;
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

  // Ensure real history is reconstructed from real transactions and quotes
  try {
    if (pId) {
      ensureRealPortfolioHistory(pId, 1825);
      recordDailySnapshot(pId);
    } else {
      let portfoliosToCheck = [];
      if (userRole === 'admin') {
        portfoliosToCheck = db.prepare('SELECT id FROM portfolios WHERE include_in_totals = 1').all();
      } else {
        portfoliosToCheck = db.prepare(`
          SELECT p.id FROM portfolios p
          JOIN portfolio_users pu ON p.id = pu.portfolio_id
          WHERE pu.user_id = ? AND p.include_in_totals = 1
        `).all(userId);
      }
      for (const p of portfoliosToCheck) {
        ensureRealPortfolioHistory(p.id, 1825);
        recordDailySnapshot(p.id);
      }
    }
  } catch (err) {
    console.warn('[History Warning] Failed to ensure history:', err.message);
  }

  // Determine date filter based on range
  let daysBack = 365;
  switch (range.toUpperCase()) {
    case '1M': daysBack = 30; break;
    case '3M': daysBack = 90; break;
    case '6M': daysBack = 180; break;
    case '1Y': daysBack = 365; break;
    case '3Y': daysBack = 1095; break;
    case '5Y': daysBack = 1825; break;
    case 'ALL': daysBack = 3650; break;
    default: daysBack = 365; break;
  }

  const conditions = ["date >= date('now', '-' || ? || ' days')"];
  const params = [daysBack];

  // Exclude empty pre-creation dates with 0 value and 0 deposits
  conditions.push('(totalValue > 0 OR netDeposits > 0 OR cashValue != 0 OR assetValue > 0)');

  if (pId) {
    conditions.push('portfolioId = ?');
    params.push(pId);
  } else if (userRole === 'admin') {
    conditions.push(`portfolioId IN (
      SELECT id FROM portfolios WHERE include_in_totals = 1
    )`);
  } else {
    conditions.push(`portfolioId IN (
      SELECT p.id FROM portfolios p
      JOIN portfolio_users pu ON p.id = pu.portfolio_id
      WHERE pu.user_id = ? AND p.include_in_totals = 1
    )`);
    params.push(userId);
  }

  const whereClause = `WHERE ${conditions.join(' AND ')}`;

  // Query daily history (grouped by date if aggregating multiple portfolios)
  const rows = db.prepare(`
    SELECT date,
           SUM(totalValue) as totalValue,
           SUM(cashValue) as cashValue,
           SUM(assetValue) as assetValue,
           SUM(netDeposits) as netDeposits
    FROM portfolio_history
    ${whereClause}
    GROUP BY date
    ORDER BY date ASC
  `).all(...params);

  // Compute peak, return %, and drawdown
  let peak = 0.0;
  let maxDrawdown = 0.0;
  const series = [];

  // Compute Time-Weighted Return (TWR) for the period to isolate pure market performance from deposits/withdrawals
  let cumFactor = 1.0;

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const totalVal = Number(r.totalValue) || 0.0;
    const netDeps = Number(r.netDeposits) || 0.0;

    if (totalVal > peak) {
      peak = totalVal;
    }

    // Drawdown from peak (% drop)
    const drawdownPct = peak > 0 ? ((peak - totalVal) / peak) * 100.0 : 0.0;
    if (drawdownPct > maxDrawdown) {
      maxDrawdown = drawdownPct;
    }

    // Cumulative return % from inception: (totalValue - netDeposits) / netDeposits
    const gain = totalVal - netDeps;
    const returnPct = netDeps > 0 ? (gain / netDeps) * 100.0 : 0.0;

    // Time-weighted return relative to the start of this requested period
    let periodReturnPct = 0.0;
    if (i === 0) {
      cumFactor = 1.0;
      periodReturnPct = 0.0;
    } else {
      const prev = rows[i - 1];
      const prevVal = Number(prev.totalValue) || 0.0;
      const flow = netDeps - (Number(prev.netDeposits) || 0.0);
      const rDay = prevVal > 0 ? (totalVal - flow - prevVal) / prevVal : 0.0;
      cumFactor *= (1.0 + rDay);
      periodReturnPct = Number(((cumFactor - 1.0) * 100.0).toFixed(2));
    }

    series.push({
      date: r.date,
      totalValue: totalVal,
      cashValue: Number(r.cashValue) || 0.0,
      assetValue: Number(r.assetValue) || 0.0,
      netDeposits: netDeps,
      gain,
      returnPercent: returnPct,
      periodReturnPercent: periodReturnPct,
      drawdownPercent: drawdownPct,
      peak
    });
  }

  // Summary period metrics
  let periodGain = 0.0;
  let periodReturnPercent = 0.0;
  if (series.length > 0) {
    const first = series[0];
    const last = series[series.length - 1];
    periodGain = (last.totalValue - first.totalValue) - (last.netDeposits - first.netDeposits);
    periodReturnPercent = Number(((cumFactor - 1.0) * 100.0).toFixed(2));
  }

  return res.json({
    success: true,
    range,
    periodGain,
    periodReturnPercent,
    maxDrawdown,
    currentPeak: peak,
    pointCount: series.length,
    series
  });
});

/**
 * GET /api/history/metrics
 * Returns fast real-time quantitative performance indicators (TWR across multiple periods, XIRR/MWRR,
 * Max Drawdown, Current Drawdown, ATH/Peak, Volatility, Sharpe Ratio, Period Gains)
 * for the requested portfolio or aggregated portfolios.
 */
router.get('/metrics', (req, res) => {
  const { portfolioId } = req.query;
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

  try {
    let portfolios = [];
    if (pId) {
      const p = db.prepare('SELECT * FROM portfolios WHERE id = ?').get(pId);
      if (p) portfolios.push(p);
    } else if (userRole === 'admin') {
      portfolios = db.prepare('SELECT * FROM portfolios WHERE include_in_totals = 1').all();
    } else {
      portfolios = db.prepare(`
        SELECT p.* FROM portfolios p
        JOIN portfolio_users pu ON p.id = pu.portfolio_id
        WHERE pu.user_id = ? AND p.include_in_totals = 1
      `).all(userId);
    }

    if (portfolios.length === 0) {
      return res.json({
        success: true,
        portfolioId: portfolioId || 'all',
        metrics: computePerformanceMetricsFromHistory([], [], [])
      });
    }

    const portfolioIds = portfolios.map(p => p.id);

    // Ensure real history exists if missing
    for (const p of portfolios) {
      try {
        ensureRealPortfolioHistory(p.id, 1825);
        recordDailySnapshot(p.id);
      } catch (e) {
        // Non-blocking warning
      }
    }

    const placeholders = portfolioIds.map(() => '?').join(',');
    const historyRows = db.prepare(`
      SELECT date,
             SUM(totalValue) as totalValue,
             SUM(cashValue) as cashValue,
             SUM(assetValue) as assetValue,
             SUM(netDeposits) as netDeposits
      FROM portfolio_history
      WHERE portfolioId IN (${placeholders})
        AND (totalValue > 0 OR netDeposits > 0 OR cashValue != 0 OR assetValue > 0)
      GROUP BY date
      ORDER BY date ASC
    `).all(...portfolioIds);

    const metrics = computePerformanceMetricsFromHistory(historyRows, portfolioIds, portfolios);

    return res.json({
      success: true,
      portfolioId: portfolioId || 'all',
      metrics
    });
  } catch (err) {
    console.error('[History Metrics Error]:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/history/snapshot
 * Triggers an immediate daily snapshot for today.
 */
router.post('/snapshot', (req, res) => {
  const pId = req.body.portfolioId ? parseInt(req.body.portfolioId, 10) : null;
  const date = req.body.date || null;

  try {
    const snapshots = recordDailySnapshot(pId, date);
    return res.status(201).json({
      success: true,
      message: `Registrati con successo ${snapshots.length} snapshot.`,
      snapshots
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      error: `Errore nella registrazione dello snapshot: ${err.message}`
    });
  }
});

/**
 * Computes comprehensive quantitative performance indicators from daily history rows.
 *
 * @param {Array<object>} historyRows
 * @param {Array<number>} portfolioIds
 * @param {Array<object>} [portfolios=[]]
 * @returns {object}
 */
function computePerformanceMetricsFromHistory(historyRows, portfolioIds, portfolios = []) {
  if (!historyRows || historyRows.length === 0) {
    return {
      twr: { '1M': 0, '3M': 0, '6M': 0, '1Y': 0, '3Y': 0, '5Y': 0, 'ALL': 0 },
      periodGain: { '1M': 0, '3M': 0, '6M': 0, '1Y': 0, '3Y': 0, '5Y': 0, 'ALL': 0 },
      xirr: 0,
      roi: 0,
      totalValue: 0,
      investedCapital: 0,
      totalGain: 0,
      maxDrawdown: 0,
      maxDrawdownDate: null,
      currentDrawdown: 0,
      peak: 0,
      peakDate: null,
      annualizedVolatility: 0,
      sharpeRatio: 0,
      dailyPointsCount: 0
    };
  }

  const latest = historyRows[historyRows.length - 1];
  const latestValue = Number(latest.totalValue) || 0.0;
  const latestNetDeposits = Number(latest.netDeposits) || 0.0;
  const totalGain = latestValue - latestNetDeposits;
  const roi = latestNetDeposits > 0 ? (totalGain / latestNetDeposits) * 100.0 : 0.0;

  // Track Peak and Drawdowns
  let peak = 0.0;
  let peakDate = null;
  let maxDrawdown = 0.0;
  let maxDrawdownDate = null;

  for (const r of historyRows) {
    const val = Number(r.totalValue) || 0.0;
    if (val > peak) {
      peak = val;
      peakDate = r.date;
    }
    const dd = peak > 0 ? ((peak - val) / peak) * 100.0 : 0.0;
    if (dd > maxDrawdown) {
      maxDrawdown = dd;
      maxDrawdownDate = r.date;
    }
  }

  const currentDrawdown = peak > 0 ? ((peak - latestValue) / peak) * 100.0 : 0.0;

  // Daily returns for annualized volatility
  const dailyReturns = [];
  for (let i = 1; i < historyRows.length; i++) {
    const prev = historyRows[i - 1];
    const curr = historyRows[i];
    const prevVal = Number(prev.totalValue) || 0.0;
    const currVal = Number(curr.totalValue) || 0.0;
    const flow = (Number(curr.netDeposits) || 0.0) - (Number(prev.netDeposits) || 0.0);
    if (prevVal > 0) {
      const r = (currVal - flow - prevVal) / prevVal;
      dailyReturns.push(r);
    }
  }

  let annualizedVolatility = 0.0;
  if (dailyReturns.length > 5) {
    const mean = dailyReturns.reduce((a, b) => a + b, 0) / dailyReturns.length;
    const variance = dailyReturns.reduce((sum, r) => sum + Math.pow(r - mean, 2), 0) / (dailyReturns.length - 1);
    annualizedVolatility = Math.sqrt(variance) * Math.sqrt(252) * 100.0;
  }

  // Multi-period TWR and Period Gains
  const timeframes = [
    { key: '1M', days: 30 },
    { key: '3M', days: 90 },
    { key: '6M', days: 180 },
    { key: '1Y', days: 365 },
    { key: '3Y', days: 1095 },
    { key: '5Y', days: 1825 },
    { key: 'ALL', days: 36500 }
  ];

  const twr = {};
  const periodGain = {};
  const now = new Date();

  for (const tf of timeframes) {
    const cutOff = new Date(now.getTime() - tf.days * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const subRows = historyRows.filter(r => r.date >= cutOff);

    if (subRows.length < 2) {
      twr[tf.key] = 0.0;
      periodGain[tf.key] = 0.0;
      continue;
    }

    let cum = 1.0;
    for (let i = 1; i < subRows.length; i++) {
      const prev = subRows[i - 1];
      const curr = subRows[i];
      const prevVal = Number(prev.totalValue) || 0.0;
      const currVal = Number(curr.totalValue) || 0.0;
      const flow = (Number(curr.netDeposits) || 0.0) - (Number(prev.netDeposits) || 0.0);
      if (prevVal > 0) {
        const rDay = (currVal - flow - prevVal) / prevVal;
        cum *= (1.0 + rDay);
      }
    }
    twr[tf.key] = Number(((cum - 1.0) * 100.0).toFixed(2));

    const first = subRows[0];
    const last = subRows[subRows.length - 1];
    const gainVal = (Number(last.totalValue) || 0) - (Number(first.totalValue) || 0) -
                    ((Number(last.netDeposits) || 0) - (Number(first.netDeposits) || 0));
    periodGain[tf.key] = Number(gainVal.toFixed(2));
  }

  // Calculate XIRR with Newton-Raphson from external cash flows
  let xirr = 0.0;
  try {
    const placeholders = portfolioIds.map(() => '?').join(',');
    const txs = db.prepare(`
      SELECT type, amount, quantity, price, date, notes, portfolioId
      FROM transactions
      WHERE portfolioId IN (${placeholders})
        AND type IN ('DEPOSIT', 'WITHDRAWAL', 'TAX')
      ORDER BY date ASC, id ASC
    `).all(...portfolioIds);

    const cashFlows = [];

    const hasInitialDepositByPort = {};
    for (const t of txs) {
      if (t.type === 'DEPOSIT' && t.notes === 'Deposito iniziale') {
        hasInitialDepositByPort[t.portfolioId] = true;
      }
    }

    // Add initial cash flows if not already present as a DEPOSIT transaction
    for (const p of portfolios) {
      if (hasInitialDepositByPort[p.id]) continue;
      const initC = Number(p.initialCash) || 0.0;
      if (initC > 0) {
        const sDate = p.startDate || (txs.length > 0 ? txs[0].date : new Date().toISOString().split('T')[0]);
        cashFlows.push({ date: sDate, amount: -initC });
      }
    }

    for (const tx of txs) {
      const amt = Number(tx.amount) || (Number(tx.quantity) * Number(tx.price)) || 0.0;
      if (amt <= 0) continue;
      if (tx.type === 'DEPOSIT') {
        cashFlows.push({ date: tx.date, amount: -amt }); // Outflow from investor to portfolio
      } else if (tx.type === 'WITHDRAWAL') {
        cashFlows.push({ date: tx.date, amount: amt });  // Inflow to investor from portfolio
      }
    }

    // Terminal value as of today
    if (latestValue > 0) {
      cashFlows.push({ date: latest.date, amount: latestValue });
    }

    if (cashFlows.length >= 2) {
      const xirrDecimal = calculateXIRR(cashFlows);
      xirr = Number((xirrDecimal * 100.0).toFixed(2));
    }
  } catch (err) {
    console.warn('[History Metrics] XIRR calculation warning:', err.message);
  }

  // Sharpe Ratio (assume 2.5% EUR risk-free rate)
  const annualizedReturn = twr['1Y'] || roi;
  const sharpeRatio = annualizedVolatility > 0
    ? Number(((annualizedReturn - 2.5) / annualizedVolatility).toFixed(2))
    : 0.0;

  return {
    twr,
    periodGain,
    xirr,
    roi: Number(roi.toFixed(2)),
    totalValue: Number(latestValue.toFixed(2)),
    investedCapital: Number(latestNetDeposits.toFixed(2)),
    totalGain: Number(totalGain.toFixed(2)),
    maxDrawdown: Number(maxDrawdown.toFixed(2)),
    maxDrawdownDate,
    currentDrawdown: Number(currentDrawdown.toFixed(2)),
    peak: Number(peak.toFixed(2)),
    peakDate,
    annualizedVolatility: Number(annualizedVolatility.toFixed(2)),
    sharpeRatio,
    dailyPointsCount: historyRows.length
  };
}

/**
 * Reconstructs the complete daily history and recalculates quantitative performance indicators
 * (TWR, XIRR, Max Drawdown, Volatility, Sharpe, Period Returns) on demand.
 *
 * @param {number|null} [portfolioId=null] - Specific portfolio ID or null/'all' for all portfolios
 * @param {object} [options={}]
 * @param {number} [options.daysBack=1825] - Default 5 years (1825 days)
 * @param {boolean} [options.syncQuotes=true] - Ensure missing historical quotes for all assets
 * @param {number} [options.userId=null] - Optional user context
 * @param {string} [options.userRole=null] - Optional user role ('admin' / 'user')
 * @returns {Promise<object>} Complete metrics and reconstruction summary
 */
async function recalculateAndReconstructHistoricalPerformance(portfolioId = null, options = {}) {
  const daysBack = parseInt(options.daysBack, 10) || 1825;
  const syncQuotes = options.syncQuotes !== false;
  const userId = options.userId || null;
  const userRole = options.userRole || null;

  // 1. Identify target portfolios
  let portfolios = [];
  if (portfolioId && portfolioId !== 'all') {
    const p = db.prepare('SELECT * FROM portfolios WHERE id = ?').get(portfolioId);
    if (!p) throw new Error(`Portafoglio con ID ${portfolioId} non trovato.`);
    portfolios.push(p);
  } else if (userRole === 'admin' || !userId) {
    portfolios = db.prepare('SELECT * FROM portfolios WHERE include_in_totals = 1').all();
  } else {
    portfolios = db.prepare(`
      SELECT p.* FROM portfolios p
      JOIN portfolio_users pu ON p.id = pu.portfolio_id
      WHERE pu.user_id = ? AND p.include_in_totals = 1
    `).all(userId);
  }

  if (portfolios.length === 0) {
    return {
      success: true,
      pointsReconstructed: 0,
      message: 'Nessun portafoglio da ricostruire.',
      metrics: null
    };
  }

  const portfolioIds = portfolios.map(p => p.id);

  // 2. Sync missing quotes for assets in these portfolios if requested
  if (syncQuotes) {
    const placeholders = portfolioIds.map(() => '?').join(',');
    const txTickers = db.prepare(`
      SELECT DISTINCT assetTicker as ticker
      FROM transactions
      WHERE portfolioId IN (${placeholders})
        AND assetTicker IS NOT NULL
        AND trim(assetTicker) != ''
    `).all(...portfolioIds);

    for (const row of txTickers) {
      try {
        await ensureHistoricalQuotesIfMissing(row.ticker);
      } catch (err) {
        console.warn(`[History Sync] Quote sync warning for ${row.ticker}:`, err.message);
      }
    }
  }

  // 3. Recalculate each portfolio baseline metrics (holdings, PMC, cash, dividends)
  let totalPointsReconstructed = 0;
  for (const p of portfolios) {
    try {
      recalculatePortfolio(p.id);
    } catch (e) {
      console.warn(`[History Recalculate] Warning recalculating portfolio ${p.id}:`, e.message);
    }

    // 4. Reconstruct daily NAV series for this portfolio
    const recon = reconstructPortfolioHistoryFromQuotes(p.id, daysBack);
    if (recon && recon.pointsReconstructed) {
      totalPointsReconstructed += recon.pointsReconstructed;
    }

    // 5. Take today's snapshot
    recordDailySnapshot(p.id);
  }

  // 6. Compute multi-period performance indicators from daily history
  const placeholders = portfolioIds.map(() => '?').join(',');
  const historyRows = db.prepare(`
    SELECT date,
           SUM(totalValue) as totalValue,
           SUM(cashValue) as cashValue,
           SUM(assetValue) as assetValue,
           SUM(netDeposits) as netDeposits
    FROM portfolio_history
    WHERE portfolioId IN (${placeholders})
      AND (totalValue > 0 OR netDeposits > 0 OR cashValue != 0 OR assetValue > 0)
    GROUP BY date
    ORDER BY date ASC
  `).all(...portfolioIds);

  const metrics = computePerformanceMetricsFromHistory(historyRows, portfolioIds, portfolios);

  return {
    success: true,
    portfolioId: portfolioId || 'all',
    portfoliosCount: portfolios.length,
    daysBack,
    pointsReconstructed: totalPointsReconstructed,
    message: `Ricostruzione completata: generati ${totalPointsReconstructed} snapshot storici giornalieri.`,
    metrics
  };
}

/**
 * POST /api/history/recalculate-performance
 * On-demand complete reconstruction of historical daily NAV series and recalculation
 * of all quantitative performance indicators (TWR, XIRR, Max Drawdown, Volatility, Sharpe).
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
    console.error('[History Recalculate Error]:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/history/reconstruct
 * Triggers quantitative reconstruction of real daily history for a portfolio or all portfolios.
 */
router.post('/reconstruct', (req, res) => {
  const pId = req.body.portfolioId ? parseInt(req.body.portfolioId, 10) : null;
  const days = req.body.daysBack ? parseInt(req.body.daysBack, 10) : 1825;

  try {
    const result = reconstructPortfolioHistoryFromQuotes(pId, days);
    return res.json({
      success: true,
      message: `Ricostruzione completata con successo (${result.pointsReconstructed} punti generati).`,
      result
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      error: `Errore nella ricostruzione: ${err.message}`
    });
  }
});

module.exports = {
  router,
  recordDailySnapshot,
  ensureRealPortfolioHistory,
  backfillHistoryIfEmpty,
  computePerformanceMetricsFromHistory,
  recalculateAndReconstructHistoricalPerformance
};

