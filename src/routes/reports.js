const express = require('express');
const { db } = require('../db');
const { requireAuth } = require('../middlewares/authMiddleware');
const { recalculatePortfolio, getAssetsMap, checkPortfolioAccess } = require('./portfolios');
const {
  isManualAssetType,
  getAssetTypeLabel,
  normalizeAssetType
} = require('../utils/constants');
const {
  resolveAssetTaxInfo,
  calculatePortfolioUnrealizedTax,
  processPortfolioClosedPositionsTaxes
} = require('../utils/taxEngine');

const router = express.Router();

router.use(requireAuth);

/**
 * Summarizes an array of manual asset holdings into a categorized financial structure
 * with gross value, estimated taxation, and net expected value.
 */
function summarizeManualCategory(items = [], options = {}) {
  const {
    key = '',
    type = '',
    title = '',
    shortTitle = '',
    icon = '🏛️',
    taxRate = 0.26,
    taxRateFormatted = '26%',
    taxDescription = '',
    portfolioTotalVal = 0.0,
    currency = 'EUR'
  } = options;

  const count = items.length;
  const hasItems = count > 0;
  const grossValue = Math.round(items.reduce((sum, h) => sum + (Number(h.currentValue) || 0.0), 0.0) * 100) / 100;
  const investedCapital = Math.round(items.reduce((sum, h) => sum + (Number(h.bookValue) || 0.0), 0.0) * 100) / 100;
  const grossGain = Math.round(items.reduce((sum, h) => sum + (Number(h.gain) || 0.0), 0.0) * 100) / 100;
  const estimatedTax = Math.round(items.reduce((sum, h) => sum + (Number(h.estimatedTax) || 0.0), 0.0) * 100) / 100;
  const netGain = Math.round(items.reduce((sum, h) => sum + (Number(h.netGain) || 0.0), 0.0) * 100) / 100;
  const netValue = Math.round(items.reduce((sum, h) => {
    if (h.netValue !== undefined && !isNaN(Number(h.netValue))) {
      return sum + Number(h.netValue);
    }
    const val = Number(h.currentValue) || 0.0;
    const tax = Number(h.estimatedTax) || 0.0;
    return sum + (val - tax);
  }, 0.0) * 100) / 100;

  const gainPercent = investedCapital > 0 ? (grossGain / investedCapital) * 100.0 : 0.0;
  const netGainPercent = investedCapital > 0 ? (netGain / investedCapital) * 100.0 : 0.0;
  const weight = portfolioTotalVal > 0 ? (grossValue / portfolioTotalVal) * 100.0 : 0.0;

  return {
    key,
    type,
    title,
    shortTitle,
    icon,
    count,
    hasItems,
    items,
    grossValue,
    investedCapital,
    grossGain,
    gainPercent,
    estimatedTax,
    taxRate,
    taxRateFormatted,
    taxDescription,
    netGain,
    netGainPercent,
    netValue,
    weight,
    currency
  };
}

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
  let grandManualValue = 0.0;
  let grandManualGain = 0.0;
  let grandManualCount = 0;
  let grandMarketValue = 0.0;
  let grandMarketCount = 0;
  const allManualHoldingsSummary = [];

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
      const isManual = isManualAssetType(h.type);
      const manualCatLabel = isManual ? getAssetTypeLabel(h.type) : null;

      if (pnl < 0) {
        portfolioLatentLosses += Math.abs(pnl);
      }

      const estTax = pnl > 0 ? Math.round((pnl * taxInfo.taxRate) * 100) / 100 : 0.0;
      const netHoldingGain = Math.round((pnl - estTax) * 100) / 100;
      const netHoldingValue = Math.round(Math.max(0.0, val - estTax) * 100) / 100;

      return {
        ticker: h.ticker,
        name: h.name || h.ticker,
        type: h.type || 'EQUITY',
        isManualType: isManual,
        manualCategory: manualCatLabel,
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
        netValue: netHoldingValue,
        weight: weight
      };
    });

    // Sort holdings by currentValue descending
    formattedHoldings.sort((a, b) => b.currentValue - a.currentValue);

    // Split holdings into market instruments and manual/administered instruments
    const marketHoldings = formattedHoldings.filter(h => !isManualAssetType(h.type));
    const manualHoldings = formattedHoldings.filter(h => isManualAssetType(h.type));
    const manualHoldingsTotalVal = manualHoldings.reduce((sum, h) => sum + h.currentValue, 0.0);
    const manualHoldingsTotalGain = manualHoldings.reduce((sum, h) => sum + h.gain, 0.0);
    const manualHoldingsWeight = totalVal > 0 ? (manualHoldingsTotalVal / totalVal) * 100.0 : 0.0;

    const marketHoldingsTotalVal = marketHoldings.reduce((sum, h) => sum + h.currentValue, 0.0);
    const marketHoldingsTotalGain = marketHoldings.reduce((sum, h) => sum + h.gain, 0.0);
    const marketHoldingsWeight = totalVal > 0 ? (marketHoldingsTotalVal / totalVal) * 100.0 : 0.0;

    // Calculate portfolio taxation:
    // If portfolio is Pensione, tax is applied directly to NAV based on p.taxRate (default 15%)
    let portfolioTax;
    let portfolioEstimatedTax = 0.0;

    if (p.type === 'Pensione') {
      const pTaxRate = p.taxRate !== undefined && p.taxRate !== null && !isNaN(Number(p.taxRate))
        ? Number(p.taxRate)
        : 15.0;
      const rateFraction = pTaxRate > 1.0 ? pTaxRate / 100.0 : pTaxRate;
      const ratePercent = pTaxRate > 1.0 ? pTaxRate : pTaxRate * 100.0;
      portfolioEstimatedTax = totalVal * rateFraction;

      portfolioTax = {
        isPension: true,
        taxRate: ratePercent,
        taxRateFormatted: `${ratePercent.toLocaleString('it-IT', { maximumFractionDigits: 2 })}%`,
        totalEstimatedTax: portfolioEstimatedTax,
        grossValue: totalVal,
        netValue: Math.max(0.0, totalVal - portfolioEstimatedTax),
        equity: {
          grossGain: 0,
          availableMinusvalenze: 0,
          compensatedAmount: 0,
          taxableGain: 0,
          taxRate: 0.26,
          taxRateFormatted: '26%',
          taxDue: 0,
          netGain: 0
        },
        bond: {
          grossGain: 0,
          availableMinusvalenze: 0,
          compensatedAmount: 0,
          taxableGain: 0,
          taxRate: 0.125,
          taxRateFormatted: '12,5%',
          taxDue: 0,
          netGain: 0
        },
        totalGrossGain: 0,
        totalCompensated: 0,
        totalTaxable: 0,
        potentialTaxSaving: 0
      };
    } else {
      portfolioTax = calculatePortfolioUnrealizedTax(formattedHoldings, detailedLosses);
      portfolioEstimatedTax = Number(portfolioTax.totalEstimatedTax) || 0.0;
    }

    // Split manual holdings into 4 dedicated administered categories:
    // 1. Conti Deposito (DEPOSITO_VINCOLATO - 26%)
    // 2. Buoni Postali (BUONO_POSTALE - 12.5%)
    // 3. TFR (TFR - 17%)
    // 4. Fondi Pensione (FONDO_PENSIONE - 20% or portfolio taxRate)
    const portContiDeposito = summarizeManualCategory(manualHoldings.filter(h => normalizeAssetType(h.type, h.ticker) === 'DEPOSITO_VINCOLATO'), {
      key: 'contiDeposito',
      type: 'DEPOSITO_VINCOLATO',
      title: 'Conti Deposito Vincolati',
      shortTitle: 'Conti Deposito',
      icon: '🏦',
      taxRate: 0.26,
      taxRateFormatted: '26%',
      taxDescription: "Ritenuta a titolo d'imposta 26% sugli interessi attivi (DPR 600/73 art. 26)",
      portfolioTotalVal: totalVal,
      currency: p.currency || 'EUR'
    });

    const portBuoniPostali = summarizeManualCategory(manualHoldings.filter(h => normalizeAssetType(h.type, h.ticker) === 'BUONO_POSTALE'), {
      key: 'buoniPostali',
      type: 'BUONO_POSTALE',
      title: 'Buoni Fruttiferi Postali',
      shortTitle: 'Buoni Postali',
      icon: '📮',
      taxRate: 0.125,
      taxRateFormatted: '12,5%',
      taxDescription: 'Imposta agevolata 12,5% equiparata ai Titoli di Stato ed emessi da CDP (D.Lgs. 239/1996)',
      portfolioTotalVal: totalVal,
      currency: p.currency || 'EUR'
    });

    const portTfr = summarizeManualCategory(manualHoldings.filter(h => normalizeAssetType(h.type, h.ticker) === 'TFR'), {
      key: 'tfr',
      type: 'TFR',
      title: 'Trattamento Fine Rapporto (TFR)',
      shortTitle: 'TFR',
      icon: '📑',
      taxRate: 0.17,
      taxRateFormatted: '17%',
      taxDescription: 'Imposta sostitutiva 17% sulle rivalutazioni annue maturate (D.Lgs. 47/2000)',
      portfolioTotalVal: totalVal,
      currency: p.currency || 'EUR'
    });

    const pensionRateFraction = p.taxRate !== undefined && p.taxRate !== null && !isNaN(Number(p.taxRate))
      ? (Number(p.taxRate) > 1.0 ? Number(p.taxRate) / 100.0 : Number(p.taxRate))
      : 0.20;
    const pensionRatePercent = pensionRateFraction * 100.0;
    const portFondiPensione = summarizeManualCategory(manualHoldings.filter(h => normalizeAssetType(h.type, h.ticker) === 'FONDO_PENSIONE'), {
      key: 'fondiPensione',
      type: 'FONDO_PENSIONE',
      title: 'Fondi Pensione & Previdenza',
      shortTitle: 'Fondi Pensione',
      icon: '🛡️',
      taxRate: pensionRateFraction,
      taxRateFormatted: `${pensionRatePercent.toLocaleString('it-IT', { maximumFractionDigits: 2 })}%`,
      taxDescription: 'Imposta sostitutiva sui rendimenti della previdenza complementare (D.Lgs. 252/2005)',
      portfolioTotalVal: totalVal,
      currency: p.currency || 'EUR'
    });

    const portManualCategories = {
      contiDeposito: portContiDeposito,
      buoniPostali: portBuoniPostali,
      tfr: portTfr,
      fondiPensione: portFondiPensione
    };

    const portfolioReport = {
      id: p.id,
      name: p.name,
      type: p.type || 'Investimento',
      taxRate: p.taxRate,
      currency: p.currency || 'EUR',
      includeInTotals: Boolean(p.include_in_totals),
      totalValue: totalVal,
      netValue: Math.max(0.0, totalVal - portfolioEstimatedTax),
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
      marketHoldings,
      manualHoldings,
      hasManualHoldings: manualHoldings.length > 0,
      hasMarketHoldings: marketHoldings.length > 0,
      manualHoldingsTotalValue: manualHoldingsTotalVal,
      manualHoldingsTotalGain: manualHoldingsTotalGain,
      manualHoldingsWeight,
      marketHoldingsTotalValue: marketHoldingsTotalVal,
      marketHoldingsTotalGain: marketHoldingsTotalGain,
      marketHoldingsWeight,
      manualCategories: portManualCategories,
      hasContiDeposito: portContiDeposito.hasItems,
      hasBuoniPostali: portBuoniPostali.hasItems,
      hasTfr: portTfr.hasItems,
      hasFondiPensione: portFondiPensione.hasItems,
      taxation: portfolioTax,
      estimatedTax: portfolioEstimatedTax,
      netGain: totalGain - portfolioEstimatedTax,
      minusvalenze: {
        totalResidual: pResidualLosses,
        potentialTaxSaving: pPotentialTaxSaving,
        expiringThisYear: pExpiringThisYear,
        latentLosses: portfolioLatentLosses,
        items: detailedLosses
      }
    };

    enrichedPortfolios.push(portfolioReport);

    // Sum consolidated grand totals across all portfolios (reports include and value all portfolios)
    grandTotalValue += totalVal;
    grandInvestedCapital += invCap;
    grandTotalCash += cash;
    grandUnrealizedPnl += unPnl;
    grandRealizedPnl += relPnl;
    grandTotalGain += totalGain;
    grandMinusvalenze += pResidualLosses;
    grandMinusvalenzeExpiringThisYear += pExpiringThisYear;
    grandLatentLosses += portfolioLatentLosses;
    grandManualValue += manualHoldingsTotalVal;
    grandManualGain += manualHoldingsTotalGain;
    grandManualCount += manualHoldings.length;
    grandMarketValue += marketHoldingsTotalVal;
    grandMarketCount += marketHoldings.length;

    manualHoldings.forEach(mh => {
      allManualHoldingsSummary.push({
        portfolioId: p.id,
        portfolioName: p.name,
        portfolioType: p.type || 'Investimento',
        ...mh
      });
    });
  }

  const grandCostBasis = grandTotalValue - grandUnrealizedPnl - grandTotalCash;
  const grandGainPercent = grandCostBasis > 0 ? (grandUnrealizedPnl / grandCostBasis) * 100.0 : (grandInvestedCapital > 0 ? (grandTotalGain / grandInvestedCapital) * 100.0 : 0.0);

  // Consolidated grand taxation summary across all portfolios
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

  // Consolidated grand manual category summaries across all included portfolios
  const grandContiDeposito = summarizeManualCategory(allManualHoldingsSummary.filter(h => normalizeAssetType(h.type, h.ticker) === 'DEPOSITO_VINCOLATO'), {
    key: 'contiDeposito',
    type: 'DEPOSITO_VINCOLATO',
    title: 'Conti Deposito Vincolati',
    shortTitle: 'Conti Deposito',
    icon: '🏦',
    taxRate: 0.26,
    taxRateFormatted: '26%',
    taxDescription: "Ritenuta a titolo d'imposta 26% sugli interessi attivi (DPR 600/73 art. 26)",
    portfolioTotalVal: grandTotalValue,
    currency: 'EUR'
  });

  const grandBuoniPostali = summarizeManualCategory(allManualHoldingsSummary.filter(h => normalizeAssetType(h.type, h.ticker) === 'BUONO_POSTALE'), {
    key: 'buoniPostali',
    type: 'BUONO_POSTALE',
    title: 'Buoni Fruttiferi Postali',
    shortTitle: 'Buoni Postali',
    icon: '📮',
    taxRate: 0.125,
    taxRateFormatted: '12,5%',
    taxDescription: 'Imposta agevolata 12,5% equiparata ai Titoli di Stato ed emessi da CDP (D.Lgs. 239/1996)',
    portfolioTotalVal: grandTotalValue,
    currency: 'EUR'
  });

  const grandTfr = summarizeManualCategory(allManualHoldingsSummary.filter(h => normalizeAssetType(h.type, h.ticker) === 'TFR'), {
    key: 'tfr',
    type: 'TFR',
    title: 'Trattamento Fine Rapporto (TFR)',
    shortTitle: 'TFR',
    icon: '📑',
    taxRate: 0.17,
    taxRateFormatted: '17%',
    taxDescription: 'Imposta sostitutiva 17% sulle rivalutazioni annue maturate (D.Lgs. 47/2000)',
    portfolioTotalVal: grandTotalValue,
    currency: 'EUR'
  });

  const grandFondiPensione = summarizeManualCategory(allManualHoldingsSummary.filter(h => normalizeAssetType(h.type, h.ticker) === 'FONDO_PENSIONE'), {
    key: 'fondiPensione',
    type: 'FONDO_PENSIONE',
    title: 'Fondi Pensione & Previdenza',
    shortTitle: 'Fondi Pensione',
    icon: '🛡️',
    taxRate: 0.20,
    taxRateFormatted: '20%',
    taxDescription: 'Imposta sostitutiva sui rendimenti della previdenza complementare (D.Lgs. 252/2005)',
    portfolioTotalVal: grandTotalValue,
    currency: 'EUR'
  });

  const grandManualCategories = {
    contiDeposito: grandContiDeposito,
    buoniPostali: grandBuoniPostali,
    tfr: grandTfr,
    fondiPensione: grandFondiPensione
  };

  const grandManualEstimatedTax = Math.round((grandContiDeposito.estimatedTax + grandBuoniPostali.estimatedTax + grandTfr.estimatedTax + grandFondiPensione.estimatedTax) * 100) / 100;
  const grandManualNetGain = Math.round((grandContiDeposito.netGain + grandBuoniPostali.netGain + grandTfr.netGain + grandFondiPensione.netGain) * 100) / 100;
  const grandManualNetValue = Math.round((grandContiDeposito.netValue + grandBuoniPostali.netValue + grandTfr.netValue + grandFondiPensione.netValue) * 100) / 100;

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
      manualAssetsValue: grandManualValue,
      manualAssetsGain: grandManualGain,
      manualAssetsCount: grandManualCount,
      manualAssetsEstimatedTax: grandManualEstimatedTax,
      manualAssetsNetGain: grandManualNetGain,
      manualAssetsNetValue: grandManualNetValue,
      manualCategories: grandManualCategories,
      hasContiDeposito: grandContiDeposito.hasItems,
      hasBuoniPostali: grandBuoniPostali.hasItems,
      hasTfr: grandTfr.hasItems,
      hasFondiPensione: grandFondiPensione.hasItems,
      marketAssetsValue: grandMarketValue,
      marketAssetsCount: grandMarketCount,
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
        contiDeposito: {
          taxableGain: grandContiDeposito.grossGain,
          taxDue: grandContiDeposito.estimatedTax,
          taxRate: 0.26,
          taxRateFormatted: '26%'
        },
        buoniPostali: {
          taxableGain: grandBuoniPostali.grossGain,
          taxDue: grandBuoniPostali.estimatedTax,
          taxRate: 0.125,
          taxRateFormatted: '12,5%'
        },
        tfr: {
          taxableGain: grandTfr.grossGain,
          taxDue: grandTfr.estimatedTax,
          taxRate: 0.17,
          taxRateFormatted: '17%'
        },
        fondiPensione: {
          taxableGain: grandFondiPensione.grossGain,
          taxDue: grandFondiPensione.estimatedTax,
          taxRate: 0.20,
          taxRateFormatted: '20%'
        },
        totalTaxDue: grandTotalEstimatedTax,
        netGain: grandTotalGain - grandTotalEstimatedTax
      }
    },
    manualAssetsSummary: allManualHoldingsSummary,
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

