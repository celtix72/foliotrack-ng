const express = require('express');
const { db } = require('../db');
const { requireAuth } = require('../middlewares/authMiddleware');
const { recalculatePortfolio, getAssetsMap, checkPortfolioAccess } = require('./portfolios');
const {
  resolveAssetTaxInfo,
  calculatePortfolioUnrealizedTax,
  processPortfolioClosedPositionsTaxes
} = require('../utils/taxEngine');

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
    let pPotentialTaxSaving = 0.0;

    const detailedLosses = lossRows.map(l => {
      const expDate = new Date(l.expiryDate + 'T23:59:59');
      const diffMs = expDate.getTime() - todayMs;
      const daysRemaining = Math.max(0, Math.ceil(diffMs / (1000 * 60 * 60 * 24)));
      const isExpired = diffMs < 0;
      const expYear = parseInt(String(l.expiryDate).slice(0, 4), 10);
      const isExpiringThisYear = expYear === currentYear && !isExpired;
      const resAmt = Number(l.residualAmount) || 0.0;
      const origAmt = Number(l.amount) || 0.0;

      const cat = (String(l.assetType).toUpperCase().trim() === 'BOND' || l.taxRate === 0.125) ? 'BOND' : 'EQUITY';
      const rate = (l.taxRate !== undefined && l.taxRate !== null && !isNaN(Number(l.taxRate)))
        ? Number(l.taxRate)
        : (cat === 'BOND' ? 0.125 : 0.26);
      const potSaving = resAmt * rate;

      if (!isExpired && resAmt > 0) {
        pResidualLosses += resAmt;
        pPotentialTaxSaving += potSaving;
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
        assetType: cat,
        taxCategory: cat,
        taxRate: rate,
        taxRateFormatted: rate === 0.125 ? '12,5%' : '26%',
        potentialTaxSaving: potSaving
      };
    });

    // Formatted and enriched holdings list with tax resolution
    let portfolioLatentLosses = 0.0;
    const formattedHoldings = holdings.map(h => {
      const qta = Number(h.quantity) || 0.0;
      const pmc = Number(h.pmc) || 0.0;
      const curPrice = Number(h.currentPrice) || 0.0;
      const val = Number(h.marketValue) || (qta * curPrice);
      const pnl = Number(h.unrealizedPnl) || 0.0;
      const pnlPct = Number(h.unrealizedPnlPercent) || 0.0;
      const weight = totalVal > 0 ? (val / totalVal) * 100.0 : 0.0;

      const taxInfo = resolveAssetTaxInfo(h);

      if (pnl < 0) {
        portfolioLatentLosses += Math.abs(pnl);
      }

      const estTax = pnl > 0 ? (pnl * taxInfo.taxRate) : 0.0;
      const netHoldingGain = pnl - estTax;

      return {
        ticker: h.ticker,
        name: h.name || h.ticker,
        type: h.type || 'EQUITY',
        taxCategory: taxInfo.taxCategory,
        taxCategoryLabel: taxInfo.label,
        taxRate: taxInfo.taxRate,
        taxRatePercent: taxInfo.taxRatePercent,
        taxRateFormatted: taxInfo.taxRateFormatted,
        currency: h.currency || p.currency || 'EUR',
        quantity: qta,
        pmc: pmc,
        currentPrice: curPrice,
        currentValue: val,
        bookValue: Number(h.bookValue) || (qta * pmc),
        gain: pnl,
        gainPercent: pnlPct,
        estimatedTax: estTax,
        netGain: netHoldingGain,
        weight: weight
      };
    });

    // Sort holdings by currentValue descending
    formattedHoldings.sort((a, b) => b.currentValue - a.currentValue);

    // Calculate portfolio unrealized capital gains tax taking into account minusvalenze compensation strictly within same portfolio and same category
    const portfolioTax = calculatePortfolioUnrealizedTax(formattedHoldings, detailedLosses);

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
      taxation: portfolioTax,
      estimatedTax: portfolioTax.totalEstimatedTax,
      netGain: totalGain - portfolioTax.totalEstimatedTax,
      minusvalenze: {
        totalResidual: pResidualLosses,
        potentialTaxSaving: pPotentialTaxSaving,
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

  // Consolidated grand taxation summary
  const grandTotalEstimatedTax = enrichedPortfolios.reduce((sum, p) => sum + (p.estimatedTax || 0.0), 0.0);
  const grandPotentialTaxSaving = enrichedPortfolios.reduce((sum, p) => sum + (p.minusvalenze?.potentialTaxSaving || 0.0), 0.0);
  const grandEquityTaxable = enrichedPortfolios.reduce((sum, p) => sum + (p.taxation?.equity?.taxableGain || 0.0), 0.0);
  const grandEquityTax = enrichedPortfolios.reduce((sum, p) => sum + (p.taxation?.equity?.taxDue || 0.0), 0.0);
  const grandBondTaxable = enrichedPortfolios.reduce((sum, p) => sum + (p.taxation?.bond?.taxableGain || 0.0), 0.0);
  const grandBondTax = enrichedPortfolios.reduce((sum, p) => sum + (p.taxation?.bond?.taxDue || 0.0), 0.0);

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
      totalEstimatedTax: grandTotalEstimatedTax,
      totalNetGain: grandTotalGain - grandTotalEstimatedTax,
      totalMinusvalenze: grandMinusvalenze,
      potentialTaxSaving: grandPotentialTaxSaving,
      expiringThisYear: grandMinusvalenzeExpiringThisYear,
      totalLatentLosses: grandLatentLosses,
      portfolioCount: enrichedPortfolios.length,
      assetCount: enrichedPortfolios.reduce((sum, p) => sum + p.assetCount, 0),
      taxation: {
        equity: {
          taxableGain: grandEquityTaxable,
          taxDue: grandEquityTax,
          taxRate: 0.26,
          taxRateFormatted: '26%'
        },
        bond: {
          taxableGain: grandBondTaxable,
          taxDue: grandBondTax,
          taxRate: 0.125,
          taxRateFormatted: '12,5%'
        },
        totalTaxDue: grandTotalEstimatedTax,
        netGain: grandTotalGain - grandTotalEstimatedTax
      }
    },
    portfolios: enrichedPortfolios
  });
});

/**
 * GET /api/reports/closed-positions
 * Retrieves all closed operations and realized gains across years:
 * - Query filters: portfolioId (optional, 'all' or id), year (optional, 'all' or specific year)
 * - Operations with sell date, quantity, buy price (PMC), sell price, total cost, net proceeds, realized PnL (€ and %)
 * - Grouped by calendar year with annual subtotals, win rate, and overall totals.
 */
router.get('/closed-positions', (req, res) => {
  const { portfolioId, year } = req.query;
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
  const allOperations = [];

  for (const p of portfolios) {
    const full = recalculatePortfolio(p.id, assetsMap);
    if (!full || !full.metrics || !Array.isArray(full.metrics.closedPositions)) continue;

    // Fetch active losses for this portfolio to allow category-based compensation
    const pLosses = db.prepare(`
      SELECT * FROM portfolio_losses
      WHERE portfolioId = ?
      ORDER BY expiryDate ASC, year ASC
    `).all(p.id);

    const portfolioOps = [];
    for (const cp of full.metrics.closedPositions) {
      const opDate = cp.date || '';
      const opYear = opDate ? parseInt(opDate.slice(0, 4), 10) : null;

      // Filter by year if requested
      if (year && year !== 'all' && !isNaN(parseInt(year, 10))) {
        if (opYear !== parseInt(year, 10)) continue;
      }

      portfolioOps.push({
        ...cp,
        portfolioId: p.id,
        portfolioName: p.name,
        currency: p.currency || 'EUR',
        year: opYear
      });
    }

    // Process taxes & compensation strictly within this portfolio and same asset category
    const processed = processPortfolioClosedPositionsTaxes(portfolioOps, pLosses);
    allOperations.push(...processed);
  }

  // Sort operations by date DESC (most recent first), then id DESC
  allOperations.sort((a, b) => {
    const dDiff = new Date(b.date).getTime() - new Date(a.date).getTime();
    if (dDiff !== 0) return dDiff;
    return (b.id || 0) - (a.id || 0);
  });

  // Collect distinct available years
  const distinctYears = Array.from(new Set(allOperations.map(o => o.year).filter(Boolean))).sort((a, b) => b - a);

  // Group operations by year
  const yearGroups = {};
  for (const y of distinctYears) {
    yearGroups[y] = {
      year: y,
      totalRealizedGain: 0.0,
      totalProfits: 0.0,
      totalLosses: 0.0,
      totalTaxDue: 0.0,
      totalNetRealizedGain: 0.0,
      totalCompensatedLosses: 0.0,
      totalCostBasis: 0.0,
      totalProceeds: 0.0,
      tradeCount: 0,
      winCount: 0,
      lossCount: 0,
      equityTaxable: 0.0,
      equityTaxDue: 0.0,
      bondTaxable: 0.0,
      bondTaxDue: 0.0,
      operations: []
    };
  }

  let grandRealizedGain = 0.0;
  let grandProfits = 0.0;
  let grandLosses = 0.0;
  let grandCostBasis = 0.0;
  let grandProceeds = 0.0;
  let grandTaxDue = 0.0;
  let grandNetRealizedGain = 0.0;
  let grandCompensatedLosses = 0.0;
  let grandEquityTaxable = 0.0;
  let grandEquityTaxDue = 0.0;
  let grandBondTaxable = 0.0;
  let grandBondTaxDue = 0.0;
  let grandWinCount = 0;
  let grandLossCount = 0;

  for (const op of allOperations) {
    const y = op.year;
    const pnl = Number(op.realizedPnl) || 0.0;
    const cost = Number(op.costBasis) || 0.0;
    const proc = Number(op.proceeds) || 0.0;
    const taxDue = Number(op.taxDue) || 0.0;
    const netGain = Number(op.netRealizedGain !== undefined ? op.netRealizedGain : (pnl - taxDue)) || 0.0;
    const compLoss = Number(op.compensatedLoss) || 0.0;
    const isBond = op.taxCategory === 'BOND';

    grandRealizedGain += pnl;
    grandCostBasis += cost;
    grandProceeds += proc;
    grandTaxDue += taxDue;
    grandNetRealizedGain += netGain;
    grandCompensatedLosses += compLoss;

    if (isBond) {
      grandBondTaxable += Number(op.taxableGain) || 0.0;
      grandBondTaxDue += taxDue;
    } else {
      grandEquityTaxable += Number(op.taxableGain) || 0.0;
      grandEquityTaxDue += taxDue;
    }

    if (pnl >= 0) {
      grandProfits += pnl;
      grandWinCount++;
    } else {
      grandLosses += pnl;
      grandLossCount++;
    }

    if (yearGroups[y]) {
      const yg = yearGroups[y];
      yg.totalRealizedGain += pnl;
      yg.totalCostBasis += cost;
      yg.totalProceeds += proc;
      yg.totalTaxDue += taxDue;
      yg.totalNetRealizedGain += netGain;
      yg.totalCompensatedLosses += compLoss;
      yg.tradeCount++;
      if (isBond) {
        yg.bondTaxable += Number(op.taxableGain) || 0.0;
        yg.bondTaxDue += taxDue;
      } else {
        yg.equityTaxable += Number(op.taxableGain) || 0.0;
        yg.equityTaxDue += taxDue;
      }
      if (pnl >= 0) {
        yg.totalProfits += pnl;
        yg.winCount++;
      } else {
        yg.totalLosses += pnl;
        yg.lossCount++;
      }
      yg.operations.push(op);
    }
  }

  // Finalize year statistics
  const byYear = distinctYears.map(y => {
    const yg = yearGroups[y];
    const gainPct = yg.totalCostBasis > 0 ? (yg.totalRealizedGain / yg.totalCostBasis) * 100.0 : 0.0;
    const winRate = yg.tradeCount > 0 ? (yg.winCount / yg.tradeCount) * 100.0 : 0.0;
    return {
      ...yg,
      gainPercent: gainPct,
      winRate: winRate,
      taxation: {
        equity: {
          taxableGain: yg.equityTaxable,
          taxDue: yg.equityTaxDue,
          taxRate: 0.26,
          taxRateFormatted: '26%'
        },
        bond: {
          taxableGain: yg.bondTaxable,
          taxDue: yg.bondTaxDue,
          taxRate: 0.125,
          taxRateFormatted: '12,5%'
        },
        totalTaxDue: yg.totalTaxDue,
        netGain: yg.totalNetRealizedGain
      }
    };
  });

  const grandGainPercent = grandCostBasis > 0 ? (grandRealizedGain / grandCostBasis) * 100.0 : 0.0;
  const grandWinRate = allOperations.length > 0 ? (grandWinCount / allOperations.length) * 100.0 : 0.0;

  const today = new Date();
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
      totalRealizedGain: grandRealizedGain,
      totalProfits: grandProfits,
      totalLosses: grandLosses,
      totalCostBasis: grandCostBasis,
      totalProceeds: grandProceeds,
      totalTaxDue: grandTaxDue,
      totalNetRealizedGain: grandNetRealizedGain,
      totalCompensatedLosses: grandCompensatedLosses,
      gainPercent: grandGainPercent,
      operationCount: allOperations.length,
      winCount: grandWinCount,
      lossCount: grandLossCount,
      winRate: grandWinRate,
      taxation: {
        equity: {
          taxableGain: grandEquityTaxable,
          taxDue: grandEquityTaxDue,
          taxRate: 0.26,
          taxRateFormatted: '26%'
        },
        bond: {
          taxableGain: grandBondTaxable,
          taxDue: grandBondTaxDue,
          taxRate: 0.125,
          taxRateFormatted: '12,5%'
        },
        totalTaxDue: grandTaxDue,
        netGain: grandNetRealizedGain
      }
    },
    years: distinctYears,
    byYear,
    operations: allOperations
  });
});

module.exports = router;

