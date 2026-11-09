/**
 * Tax Engine for FolioTrackNG
 * Implements Italian fiscal rules for capital gains and capital losses (D.Lgs. 461/1997):
 * - 26.0% tax rate on STOCKS (Azioni) and EQUITY ETFs (ETF Azionari).
 * - 12.5% tax rate on BONDS (Titoli di Stato, obbligazioni) and MONETARY ETFs (ETF Monetari / Governativi).
 * - Minusvalenze compensation applies strictly within the SAME portfolio and on the SAME asset category.
 */

const TAX_RATES = {
  EQUITY: 0.26,
  BOND: 0.125
};

const TAX_CATEGORIES = {
  EQUITY: 'EQUITY', // Azioni ed ETF Azionari (26%)
  BOND: 'BOND'      // BOND ed ETF Monetari (12.5%)
};

/**
 * Resolves the tax category and tax rate for an asset.
 *
 * @param {object|null} asset Asset object or holding item
 * @returns {{
 *   taxCategory: 'EQUITY'|'BOND'|'CASH',
 *   taxRate: number,
 *   taxRatePercent: number,
 *   taxRateFormatted: string,
 *   label: string
 * }}
 */
function resolveAssetTaxInfo(asset) {
  if (!asset) {
    return {
      taxCategory: 'EQUITY',
      taxRate: 0.26,
      taxRatePercent: 26.0,
      taxRateFormatted: '26%',
      label: 'Azioni / ETF'
    };
  }

  // 1. Explicit manual override on asset
  if (asset.taxRate !== undefined && asset.taxRate !== null && !isNaN(Number(asset.taxRate))) {
    const rateNum = Number(asset.taxRate);
    if (rateNum === 0.125 || rateNum === 12.5) {
      return {
        taxCategory: 'BOND',
        taxRate: 0.125,
        taxRatePercent: 12.5,
        taxRateFormatted: '12,5%',
        label: 'BOND / Monetario'
      };
    }
    if (rateNum === 0.26 || rateNum === 26) {
      return {
        taxCategory: 'EQUITY',
        taxRate: 0.26,
        taxRatePercent: 26.0,
        taxRateFormatted: '26%',
        label: 'Azioni / ETF'
      };
    }
    if (rateNum === 0) {
      return {
        taxCategory: 'CASH',
        taxRate: 0.0,
        taxRatePercent: 0.0,
        taxRateFormatted: '0%',
        label: 'Liquidità'
      };
    }
  }

  if (asset.taxCategory) {
    const cat = String(asset.taxCategory).toUpperCase().trim();
    if (cat === 'BOND') {
      return {
        taxCategory: 'BOND',
        taxRate: 0.125,
        taxRatePercent: 12.5,
        taxRateFormatted: '12,5%',
        label: 'BOND / Monetario'
      };
    }
    if (cat === 'EQUITY') {
      return {
        taxCategory: 'EQUITY',
        taxRate: 0.26,
        taxRatePercent: 26.0,
        taxRateFormatted: '26%',
        label: 'Azioni / ETF'
      };
    }
  }

  const rawType = (asset.type || '').toUpperCase().trim();
  const rawSector = (asset.sector || '').toUpperCase().trim();
  const nameStr = `${asset.name || ''} ${asset.ticker || ''}`.toLowerCase();

  // CASH
  if (rawType === 'CASH') {
    return {
      taxCategory: 'CASH',
      taxRate: 0.0,
      taxRatePercent: 0.0,
      taxRateFormatted: '0%',
      label: 'Liquidità'
    };
  }

  // BONDS: Titoli di Stato, obbligazioni (BOND) -> 12.5%
  if (rawType === 'BOND') {
    return {
      taxCategory: 'BOND',
      taxRate: 0.125,
      taxRatePercent: 12.5,
      taxRateFormatted: '12,5%',
      label: 'BOND (Titoli di Stato)'
    };
  }

  // ETFs: Check if Monetary / Government Bond ETF -> 12.5%, otherwise Equity ETF -> 26%
  if (rawType === 'ETF') {
    const isMonetaryOrGov =
      rawSector === 'GOVERNMENT' ||
      rawSector === 'BONDS' ||
      rawSector === 'FIXED INCOME' ||
      rawSector === 'MONEY MARKET' ||
      /(?:monetar|overnight|money\s*market|rate\s*swap|xeon|c3m|smart|leon|liquidity|treasury|govt|government|btp|bot|cct|ctz|obbligazion|bond|fed\s*fund|estr|euribor)/i.test(nameStr);

    if (isMonetaryOrGov) {
      return {
        taxCategory: 'BOND',
        taxRate: 0.125,
        taxRatePercent: 12.5,
        taxRateFormatted: '12,5%',
        label: 'ETF Monetario / Governativo'
      };
    }

    return {
      taxCategory: 'EQUITY',
      taxRate: 0.26,
      taxRatePercent: 26.0,
      taxRateFormatted: '26%',
      label: 'ETF Azionario'
    };
  }

  // EQUITY / STOCK -> 26%
  if (rawType === 'EQUITY' || rawType === 'STOCK') {
    return {
      taxCategory: 'EQUITY',
      taxRate: 0.26,
      taxRatePercent: 26.0,
      taxRateFormatted: '26%',
      label: 'Azioni'
    };
  }

  // Fallback default (Crypto, Commodity, others) -> 26%
  return {
    taxCategory: 'EQUITY',
    taxRate: 0.26,
    taxRatePercent: 26.0,
    taxRateFormatted: '26%',
    label: rawType || 'Azioni / ETF'
  };
}

/**
 * Calculates capital gains taxation for a single portfolio with compensation on the same asset category.
 *
 * @param {Array<object>} holdings List of holdings with .gain or .unrealizedPnl
 * @param {Array<object>} portfolioLosses List of active unexpired minusvalenze for this portfolio
 * @returns {object} Detailed tax breakdown for equity (26%) and bond/monetary (12.5%)
 */
function calculatePortfolioUnrealizedTax(holdings = [], portfolioLosses = []) {
  let equityGrossGain = 0.0;
  let bondGrossGain = 0.0;

  for (const h of holdings) {
    const gain = Number(h.gain !== undefined ? h.gain : h.unrealizedPnl) || 0.0;
    if (gain > 0) {
      const taxInfo = resolveAssetTaxInfo(h);
      if (taxInfo.taxCategory === 'BOND') {
        bondGrossGain += gain;
      } else {
        equityGrossGain += gain;
      }
    }
  }

  // Separate available losses by category
  let equityLosses = 0.0;
  let bondLosses = 0.0;

  for (const l of portfolioLosses) {
    if (l.isExpired) continue;
    const res = Number(l.residualAmount) || 0.0;
    if (res <= 0.0001) continue;
    const cat = (l.assetType || '').toUpperCase().trim();
    if (cat === 'BOND' || l.taxRate === 0.125) {
      bondLosses += res;
    } else {
      equityLosses += res;
    }
  }

  // Compensation strictly within same portfolio and same category
  const equityCompensated = Math.min(equityGrossGain, equityLosses);
  const equityTaxable = Math.max(0.0, equityGrossGain - equityCompensated);
  const equityTax = equityTaxable * 0.26;

  const bondCompensated = Math.min(bondGrossGain, bondLosses);
  const bondTaxable = Math.max(0.0, bondGrossGain - bondCompensated);
  const bondTax = bondTaxable * 0.125;

  const totalEstimatedTax = equityTax + bondTax;
  const potentialTaxSaving = (equityLosses * 0.26) + (bondLosses * 0.125);

  return {
    equity: {
      grossGain: equityGrossGain,
      availableMinusvalenze: equityLosses,
      compensatedAmount: equityCompensated,
      taxableGain: equityTaxable,
      taxRate: 0.26,
      taxRateFormatted: '26%',
      taxDue: equityTax,
      netGain: equityGrossGain - equityTax
    },
    bond: {
      grossGain: bondGrossGain,
      availableMinusvalenze: bondLosses,
      compensatedAmount: bondCompensated,
      taxableGain: bondTaxable,
      taxRate: 0.125,
      taxRateFormatted: '12,5%',
      taxDue: bondTax,
      netGain: bondGrossGain - bondTax
    },
    totalGrossGain: equityGrossGain + bondGrossGain,
    totalCompensated: equityCompensated + bondCompensated,
    totalTaxable: equityTaxable + bondTaxable,
    totalEstimatedTax,
    potentialTaxSaving
  };
}

/**
 * Processes closed operations for a portfolio chronologically and calculates realized taxes
 * with compensation against available minusvalenze of the same category in the same portfolio.
 *
 * @param {Array<object>} operations Closed positions for a single portfolio
 * @param {Array<object>} initialLosses Optional pre-existing unexpired losses in portfolio
 * @returns {Array<object>} Operations enriched with taxRate, taxCategory, compensatedLoss, taxableGain, taxDue, netRealizedGain
 */
function processPortfolioClosedPositionsTaxes(operations = [], initialLosses = []) {
  // Accumulated unexpired losses buckets by category for this portfolio
  const lossBuckets = {
    EQUITY: 0.0,
    BOND: 0.0
  };

  for (const l of initialLosses) {
    if (l.isExpired) continue;
    const res = Number(l.residualAmount) || 0.0;
    if (res <= 0.0001) continue;
    const cat = (l.assetType === 'BOND' || l.taxRate === 0.125) ? 'BOND' : 'EQUITY';
    lossBuckets[cat] += res;
  }

  // Clone and sort chronologically ASC (oldest first)
  const sorted = [...operations].sort((a, b) => {
    const dDiff = new Date(a.date).getTime() - new Date(b.date).getTime();
    if (dDiff !== 0) return dDiff;
    return (a.id || 0) - (b.id || 0);
  });

  for (const op of sorted) {
    const taxInfo = resolveAssetTaxInfo(op);
    const cat = taxInfo.taxCategory;
    const rate = taxInfo.taxRate;
    const pnl = Number(op.realizedPnl) || 0.0;

    op.taxCategory = cat;
    op.taxCategoryLabel = taxInfo.label;
    op.taxRate = rate;
    op.taxRatePercent = taxInfo.taxRatePercent;
    op.taxRateFormatted = taxInfo.taxRateFormatted;

    if (pnl > 0.0001) {
      // Capital gain: check available losses of same category
      const avail = lossBuckets[cat] || 0.0;
      const offset = Math.min(pnl, avail);
      lossBuckets[cat] = Math.max(0.0, avail - offset);

      const taxable = Math.max(0.0, pnl - offset);
      const taxDue = taxable * rate;
      const netGain = pnl - taxDue;

      op.compensatedLoss = offset;
      op.taxableGain = taxable;
      op.taxDue = taxDue;
      op.netRealizedGain = netGain;
    } else {
      // Capital loss: adds to portfolio loss bucket of this category
      const lossAmt = Math.abs(pnl);
      lossBuckets[cat] = (lossBuckets[cat] || 0.0) + lossAmt;

      op.compensatedLoss = 0.0;
      op.taxableGain = 0.0;
      op.taxDue = 0.0;
      op.netRealizedGain = pnl;
    }
  }

  return sorted;
}

module.exports = {
  TAX_RATES,
  TAX_CATEGORIES,
  resolveAssetTaxInfo,
  calculatePortfolioUnrealizedTax,
  processPortfolioClosedPositionsTaxes
};
