const express = require('express');
const { db } = require('../db');
const { requireAuth } = require('../middlewares/authMiddleware');
const { recalculatePortfolio, getAssetsMap, checkPortfolioAccess } = require('./portfolios');

const router = express.Router();

router.use(requireAuth);

/**
 * GET /api/reports/portfolio-data
 * Retrieves comprehensive report data for one or all portfolios:
 * - Portfolio list with total value, invested capital, current cash, gain, gain %, and minusvalenze.
 * - List of assets divided by portfolio with quantity, average cost price (PMC), current price, current value, gain (€ and %).
 * - Tax loss backpack ("zainetto fiscale") details per portfolio with year, expiry date, residual amount and 26% potential tax savings.
 */
router.get('/portfolio-data', (req, res) => {
  const { portfolioId } = req.query;
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

  // Filter single portfolio if requested and valid
  if (portfolioId && portfolioId !== 'all') {
    const pId = parseInt(portfolioId, 10);
    if (!isNaN(pId)) {
      const access = checkPortfolioAccess(pId, userId, userRole);
      if (!access.hasAccess) {
        return res.status(403).json({ success: false, error: 'Accesso negato al portafoglio specificato.' });
      }
      portfolios = portfolios.filter(p => p.id === pId);
    }
  }

  const assetsMap = getAssetsMap();
  const today = new Date();
  const currentYear = today.getFullYear();
  const todayMs = today.getTime();
  const todayStr = today.toISOString().split('T')[0];

  const enrichedPortfolios = [];
  let grandTotalValue = 0.0;
  let grandInvestedCapital = 0.0;
  let grandTotalCash = 0.0;
  let grandUnrealizedPnl = 0.0;
  let grandRealizedPnl = 0.0;
  let grandTotalGain = 0.0;
  let grandMinusvalenze = 0.0;
  let grandMinusvalenzeExpiringThisYear = 0.0;
  let grandLatentLosses = 0.0;

  for (const p of portfolios) {
    const full = recalculatePortfolio(p.id, assetsMap);
    if (!full) continue;

    const metrics = full.metrics || {};
    const holdings = metrics.holdings || [];
    const totalVal = Number(metrics.totalValue) || 0.0;
    const invCap = Number(metrics.investedCapital) || 0.0;
    const cash = Number(metrics.currentCash) || 0.0;
    const unPnl = Number(metrics.unrealizedPnl) || 0.0;
    const relPnl = Number(metrics.realizedPnl) || 0.0;
    const totalGain = unPnl + relPnl;
    const costBasis = totalVal - unPnl - cash;
    const gainPct = costBasis > 0 ? (unPnl / costBasis) * 100.0 : (invCap > 0 ? (totalGain / invCap) * 100.0 : 0.0);

    // Fetch tax losses (zainetto fiscale) for this portfolio
    const lossRows = db.prepare(`
      SELECT * FROM portfolio_losses
      WHERE portfolioId = ?
      ORDER BY expiryDate ASC, year ASC
    `).all(p.id);

    let pResidualLosses = 0.0;
    let pExpiringThisYear = 0.0;

    const detailedLosses = lossRows.map(l => {
      const expDate = new Date(l.expiryDate + 'T23:59:59');
      const diffMs = expDate.getTime() - todayMs;
      const daysRemaining = Math.max(0, Math.ceil(diffMs / (1000 * 60 * 60 * 24)));
      const isExpired = diffMs < 0;
      const expYear = parseInt(String(l.expiryDate).slice(0, 4), 10);
      const isExpiringThisYear = expYear === currentYear && !isExpired;
      const resAmt = Number(l.residualAmount) || 0.0;
      const origAmt = Number(l.amount) || 0.0;

      if (!isExpired && resAmt > 0) {
        pResidualLosses += resAmt;
        if (isExpiringThisYear) {
          pExpiringThisYear += resAmt;
        }
      }

      return {
        id: l.id,
        year: l.year,
        amount: origAmt,
        residualAmount: resAmt,
        expiryDate: l.expiryDate,
        notes: l.notes || '',
        daysRemaining,
        isExpired,
        isExpiringThisYear,
        potentialTaxSaving: resAmt * 0.26
      };
    });

    // Formatted and enriched holdings list
    let portfolioLatentLosses = 0.0;
    const formattedHoldings = holdings.map(h => {
      const qta = Number(h.quantity) || 0.0;
      const pmc = Number(h.pmc) || 0.0;
      const curPrice = Number(h.currentPrice) || 0.0;
      const val = Number(h.marketValue) || (qta * curPrice);
      const pnl = Number(h.unrealizedPnl) || 0.0;
      const pnlPct = Number(h.unrealizedPnlPercent) || 0.0;
      const weight = totalVal > 0 ? (val / totalVal) * 100.0 : 0.0;

      if (pnl < 0) {
        portfolioLatentLosses += Math.abs(pnl);
      }

      return {
        ticker: h.ticker,
        name: h.name || h.ticker,
        type: h.type || 'EQUITY',
        currency: h.currency || p.currency || 'EUR',
        quantity: qta,
        pmc: pmc,
        currentPrice: curPrice,
        currentValue: val,
        bookValue: Number(h.bookValue) || (qta * pmc),
        gain: pnl,
        gainPercent: pnlPct,
        weight: weight
      };
    });

    // Sort holdings by currentValue descending
    formattedHoldings.sort((a, b) => b.currentValue - a.currentValue);

    const portfolioReport = {
      id: p.id,
      name: p.name,
      type: p.type || 'Investimento',
      currency: p.currency || 'EUR',
      includeInTotals: Boolean(p.include_in_totals),
      totalValue: totalVal,
      investedCapital: invCap,
      currentCash: cash,
      unrealizedPnl: unPnl,
      realizedPnl: relPnl,
      totalGain: totalGain,
      gainPercent: gainPct,
      dayPnl: Number(metrics.dayPnl) || 0.0,
      dayPnlPercent: Number(metrics.dayPnlPercent) || 0.0,
      assetCount: formattedHoldings.length,
      holdings: formattedHoldings,
      minusvalenze: {
        totalResidual: pResidualLosses,
        potentialTaxSaving: pResidualLosses * 0.26,
        expiringThisYear: pExpiringThisYear,
        latentLosses: portfolioLatentLosses,
        items: detailedLosses
      }
    };

    enrichedPortfolios.push(portfolioReport);

    // Sum consolidated grand totals
    grandTotalValue += totalVal;
    grandInvestedCapital += invCap;
    grandTotalCash += cash;
    grandUnrealizedPnl += unPnl;
    grandRealizedPnl += relPnl;
    grandTotalGain += totalGain;
    grandMinusvalenze += pResidualLosses;
    grandMinusvalenzeExpiringThisYear += pExpiringThisYear;
    grandLatentLosses += portfolioLatentLosses;
  }

  const grandCostBasis = grandTotalValue - grandUnrealizedPnl - grandTotalCash;
  const grandGainPercent = grandCostBasis > 0 ? (grandUnrealizedPnl / grandCostBasis) * 100.0 : (grandInvestedCapital > 0 ? (grandTotalGain / grandInvestedCapital) * 100.0 : 0.0);

  const formattedDate = today.toLocaleDateString('it-IT', {
    day: '2-digit',
    month: 'long',
    year: 'numeric'
  });
  const formattedTime = today.toLocaleTimeString('it-IT', {
    hour: '2-digit',
    minute: '2-digit'
  });

  return res.json({
    success: true,
    generatedAt: today.toISOString(),
    formattedDateTime: `${formattedDate} alle ${formattedTime}`,
    totals: {
      totalValue: grandTotalValue,
      investedCapital: grandInvestedCapital,
      currentCash: grandTotalCash,
      unrealizedPnl: grandUnrealizedPnl,
      realizedPnl: grandRealizedPnl,
      totalGain: grandTotalGain,
      gainPercent: grandGainPercent,
      totalMinusvalenze: grandMinusvalenze,
      potentialTaxSaving: grandMinusvalenze * 0.26,
      expiringThisYear: grandMinusvalenzeExpiringThisYear,
      totalLatentLosses: grandLatentLosses,
      portfolioCount: enrichedPortfolios.length,
      assetCount: enrichedPortfolios.reduce((sum, p) => sum + p.assetCount, 0)
    },
    portfolios: enrichedPortfolios
  });
});

module.exports = router;

