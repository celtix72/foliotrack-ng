const { GICS_SECTORS } = require('./constants');

/**
 * Calculates Extended Internal Rate of Return (XIRR) using the Newton-Raphson method
 * with bisection fallback for irregular cash flow series.
 *
 * Cash flows conventions:
 * - Negative amounts are cash invested (outflows from investor into portfolio)
 * - Positive amounts are cash returned or current terminal portfolio valuation (inflows to investor)
 *
 * @param {Array<{ date: string|Date, amount: number }>} cashFlows
 * @param {number} [guess=0.1] - Initial guess (10% annual return)
 * @returns {number} - Annualized rate of return as a decimal (e.g. 0.125 for 12.5%)
 */
function calculateXIRR(cashFlows, guess = 0.1) {
  if (!Array.isArray(cashFlows) || cashFlows.length < 2) {
    return 0.0;
  }

  // Filter out zero amount flows and parse dates
  const flows = cashFlows
    .map(cf => ({
      date: new Date(cf.date).getTime(),
      amount: Number(cf.amount)
    }))
    .filter(cf => !isNaN(cf.date) && isFinite(cf.amount) && Math.abs(cf.amount) > 1e-6);

  if (flows.length < 2) {
    return 0.0;
  }

  // Ensure there is at least one positive and one negative cash flow
  const hasPositive = flows.some(cf => cf.amount > 0);
  const hasNegative = flows.some(cf => cf.amount < 0);
  if (!hasPositive || !hasNegative) {
    return 0.0;
  }

  // Sort flows chronologically
  flows.sort((a, b) => a.date - b.date);
  const d0 = flows[0].date;

  const MS_PER_DAY = 1000 * 60 * 60 * 24;
  const DAYS_PER_YEAR = 365.0;

  // Precalculate normalized year fraction t_i
  const items = flows.map(cf => ({
    t: (cf.date - d0) / (MS_PER_DAY * DAYS_PER_YEAR),
    amount: cf.amount
  }));

  // Net Present Value function: f(r) = sum( C_i / (1 + r)^t_i )
  const npv = (r) => {
    if (r <= -1.0) return Infinity;
    let sum = 0.0;
    for (const item of items) {
      sum += item.amount / Math.pow(1.0 + r, item.t);
    }
    return sum;
  };

  // Derivative: f'(r) = - sum( t_i * C_i / (1 + r)^(t_i + 1) )
  const npvDerivative = (r) => {
    if (r <= -1.0) return Infinity;
    let sum = 0.0;
    for (const item of items) {
      sum -= (item.t * item.amount) / Math.pow(1.0 + r, item.t + 1.0);
    }
    return sum;
  };

  // Newton-Raphson iteration
  let r = guess;
  const maxIterations = 100;
  const tolerance = 1e-6;

  for (let i = 0; i < maxIterations; i++) {
    const fValue = npv(r);
    if (Math.abs(fValue) < tolerance) {
      return isFinite(r) ? r : 0.0;
    }

    const fPrime = npvDerivative(r);
    if (!isFinite(fPrime) || Math.abs(fPrime) < 1e-9) {
      break; // Derivative too flat, switch to bisection
    }

    const nextR = r - fValue / fPrime;

    // Guard against stepping into invalid zone (r <= -1) or exploding
    if (nextR <= -0.999 || nextR > 100.0 || Math.abs(nextR - r) > 2.0) {
      break; // Diverging, switch to bisection
    }

    if (Math.abs(nextR - r) < tolerance) {
      return isFinite(nextR) ? nextR : 0.0;
    }

    r = nextR;
  }

  // Fallback: Bisection Method between -0.99 and 10.0 (i.e. -99% to +1000%)
  let low = -0.99;
  let high = 10.0;
  let fLow = npv(low);
  let fHigh = npv(high);

  if (fLow * fHigh > 0) {
    // If signs are equal, expand high bound once
    high = 50.0;
    fHigh = npv(high);
    if (fLow * fHigh > 0) {
      return 0.0; // Root not bracketed
    }
  }

  for (let i = 0; i < 100; i++) {
    const mid = (low + high) / 2.0;
    const fMid = npv(mid);

    if (Math.abs(fMid) < tolerance || (high - low) / 2.0 < tolerance) {
      return isFinite(mid) ? mid : 0.0;
    }

    if (fLow * fMid < 0) {
      high = mid;
      fHigh = fMid;
    } else {
      low = mid;
      fLow = fMid;
    }
  }

  const finalRate = (low + high) / 2.0;
  return isFinite(finalRate) ? finalRate : 0.0;
}

/**
 * Calculates Time-Weighted Return (TWR) by chaining period returns.
 * TWR = Product(1 + R_i) - 1
 *
 * @param {Array<{ startVal: number, endVal: number, cashFlow: number }>} subPeriods
 * @returns {number}
 */
function calculateTWR(subPeriods) {
  if (!Array.isArray(subPeriods) || subPeriods.length === 0) {
    return 0.0;
  }

  let compound = 1.0;
  for (const period of subPeriods) {
    const base = period.startVal + (period.cashFlow || 0.0);
    if (base > 0) {
      const r_i = (period.endVal - base) / base;
      compound *= (1.0 + r_i);
    }
  }

  return compound - 1.0;
}

/**
 * Calculates Standard ROI: (Total Portfolio Value / Net Deposits) - 1
 *
 * @param {number} totalValue
 * @param {number} netDeposits
 * @returns {number}
 */
function calculateROI(totalValue, netDeposits) {
  if (!netDeposits || netDeposits <= 0) {
    return 0.0;
  }
  return (totalValue - netDeposits) / netDeposits;
}

/**
 * Returns exchange conversion multiplier from fromCurrency to toCurrency.
 * E.g., from USD to EUR with EUR/USD = 1.085 returns 1 / 1.085 (~0.9216).
 */
function getCurrencyRate(fromCurrency, toCurrency, currencyRatesMap = {}) {
  const from = (fromCurrency || 'EUR').toUpperCase();
  const to = (toCurrency || 'EUR').toUpperCase();
  if (from === to) return 1.0;

  const directPair = `${from}/${to}`;
  if (currencyRatesMap && currencyRatesMap[directPair] && Number(currencyRatesMap[directPair]) > 0) {
    return Number(currencyRatesMap[directPair]);
  }

  const inversePair = `${to}/${from}`;
  if (currencyRatesMap && currencyRatesMap[inversePair] && Number(currencyRatesMap[inversePair]) > 0) {
    return 1.0 / Number(currencyRatesMap[inversePair]);
  }

  if (from === 'USD' && to === 'EUR') return 1.0 / 1.085;
  if (from === 'EUR' && to === 'USD') return 1.085;
  if (from === 'GBP' && to === 'EUR') return 1.1695;
  if (from === 'CHF' && to === 'EUR') return 1.0638;

  return 1.0;
}

/**
 * Core Financial Ledger Engine.
 * Processes transactions chronologically using either WAC (Prezzo Medio Ponderato) or FIFO,
 * builds holdings breakdown, calculates cash, realized P&L, unrealized P&L, allocations, ROI, and XIRR.
 *
 * @param {Array<object>} transactions - Array of transaction rows
 * @param {Record<string, object>} assetsMap - Map of ticker -> asset DB record
 * @param {number} [initialCash=0.0] - Starting cash for the portfolio
 * @param {'WAC'|'FIFO'} [costBasisMethod='WAC'] - Cost basis method
 * @param {string} [portfolioCurrency='EUR'] - Base currency of portfolio
 * @param {Record<string, number>} [currencyRatesMap={}] - FX pair conversion rates
 * @returns {object} Full financial snapshot of portfolio
 */
function calculateHoldingsAndMetrics(transactions = [], assetsMap = {}, initialCash = 0.0, costBasisMethod = 'WAC', portfolioCurrency = 'EUR', currencyRatesMap = {}) {
  let currentCash = Number(initialCash) || 0.0;
  let netDeposits = Number(initialCash) || 0.0;
  let totalDividends = 0.0;
  let realizedPnl = 0.0;

  // Track realized closed/partial positions from SELL operations
  const realizedPositions = [];

  // Map to track active positions by assetTicker:
  // For WAC: { quantity, totalCost, pmc }
  // For FIFO: { quantity, lots: [{ quantity, costPerUnit }] }
  const positions = {};

  // Track external cash flows for XIRR:
  // Negative = cash invested into portfolio; Positive = withdrawals out
  const xirrCashFlows = [];

  if (initialCash > 0) {
    // Starting cash acts as initial deposit at earliest date or now
    const earliestDate = transactions.length > 0 && transactions[0].date ? transactions[0].date : new Date().toISOString().split('T')[0];
    xirrCashFlows.push({ date: earliestDate, amount: -initialCash });
  }

  // Sort transactions chronologically
  const sortedTx = [...transactions].sort((a, b) => {
    const dDiff = new Date(a.date).getTime() - new Date(b.date).getTime();
    if (dDiff !== 0) return dDiff;
    return (a.id || 0) - (b.id || 0);
  });

  for (const tx of sortedTx) {
    const type = (tx.type || '').toUpperCase();
    const ticker = tx.assetTicker ? tx.assetTicker.toUpperCase().trim() : null;
    const qty = Number(tx.quantity) || 0.0;
    const price = Number(tx.price) || 0.0;
    const commission = Number(tx.commission) || 0.0;
    const tax = Number(tx.tax) || 0.0;
    const fxRate = Number(tx.exchangeRate) || 1.0;
    const specifiedAmount = Number(tx.amount) || 0.0;

    switch (type) {
      case 'DEPOSIT': {
        const amount = specifiedAmount > 0 ? specifiedAmount : (qty > 0 && price > 0 ? qty * price : 0.0);
        currentCash += amount;
        netDeposits += amount;
        xirrCashFlows.push({ date: tx.date, amount: -amount });
        break;
      }

      case 'WITHDRAWAL': {
        const amount = specifiedAmount > 0 ? specifiedAmount : (qty > 0 && price > 0 ? qty * price : 0.0);
        currentCash -= amount;
        netDeposits -= amount;
        xirrCashFlows.push({ date: tx.date, amount: amount });
        break;
      }

      case 'TRANSFER': {
        // Positive amount means incoming transfer, negative outgoing
        const amount = specifiedAmount;
        currentCash += amount;
        netDeposits += amount;
        if (amount > 0) {
          xirrCashFlows.push({ date: tx.date, amount: -amount });
        } else if (amount < 0) {
          xirrCashFlows.push({ date: tx.date, amount: Math.abs(amount) });
        }
        break;
      }

      case 'BUY': {
        if (!ticker || qty <= 0) break;
        const totalCostEur = specifiedAmount > 0
          ? specifiedAmount
          : (fxRate !== 1.0 && fxRate > 0 ? ((qty * price + commission) / fxRate + tax) : ((qty * price) + commission + tax));
        currentCash -= totalCostEur;

        if (!positions[ticker]) {
          positions[ticker] = {
            quantity: 0.0,
            pmc: 0.0,
            totalCost: 0.0,
            pmcNative: 0.0,
            totalCostNative: 0.0,
            realizedPnl: 0.0,
            realizedPnlNative: 0.0,
            dividends: 0.0,
            dividendsNative: 0.0,
            lots: []
          };
        }

        const pos = positions[ticker];
        const totalCostNative = (qty * price + commission);
        const newTotalCostNative = (pos.quantity * pos.pmcNative) + totalCostNative;

        if (costBasisMethod === 'FIFO') {
          const unitCost = totalCostEur / qty;
          pos.lots.push({
            date: tx.date,
            quantity: qty,
            costPerUnit: unitCost
          });
          pos.quantity += qty;
          pos.totalCost += totalCostEur;
          pos.pmc = pos.quantity > 0 ? pos.totalCost / pos.quantity : 0.0;
          pos.pmcNative = pos.quantity > 0 ? newTotalCostNative / pos.quantity : 0.0;
          pos.totalCostNative = pos.quantity * pos.pmcNative;
        } else {
          // Standard WAC (Prezzo Medio di Carico progressivo comprensivo di oneri accessori)
          const newTotalCost = (pos.quantity * pos.pmc) + totalCostEur;
          pos.quantity += qty;
          pos.pmc = pos.quantity > 0 ? newTotalCost / pos.quantity : 0.0;
          pos.totalCost = pos.quantity * pos.pmc;
          pos.pmcNative = pos.quantity > 0 ? newTotalCostNative / pos.quantity : 0.0;
          pos.totalCostNative = pos.quantity * pos.pmcNative;
        }
        break;
      }

      case 'SELL': {
        if (!ticker || qty <= 0) break;
        const netProceedsEur = specifiedAmount > 0
          ? specifiedAmount
          : (fxRate !== 1.0 && fxRate > 0 ? ((qty * price - commission) / fxRate - tax) : ((qty * price) - commission - tax));
        currentCash += netProceedsEur;

        if (!positions[ticker]) {
          positions[ticker] = {
            quantity: 0.0,
            pmc: 0.0,
            totalCost: 0.0,
            pmcNative: 0.0,
            totalCostNative: 0.0,
            realizedPnl: 0.0,
            realizedPnlNative: 0.0,
            dividends: 0.0,
            dividendsNative: 0.0,
            lots: []
          };
        }

        const pos = positions[ticker];
        let costBasisOfSold = 0.0;
        const pmcAtSell = pos.pmc;
        const pmcNativeAtSell = pos.pmcNative;

        if (costBasisMethod === 'FIFO') {
          let remainingToSell = qty;
          while (remainingToSell > 0 && pos.lots.length > 0) {
            const lot = pos.lots[0];
            const take = Math.min(remainingToSell, lot.quantity);
            costBasisOfSold += take * lot.costPerUnit;
            lot.quantity -= take;
            remainingToSell -= take;

            if (lot.quantity <= 1e-9) {
              pos.lots.shift(); // lot completely consumed
            }
          }

          pos.quantity = Math.max(0.0, pos.quantity - qty);
          pos.totalCost = pos.lots.reduce((acc, l) => acc + (l.quantity * l.costPerUnit), 0.0);
          pos.pmc = pos.quantity > 1e-9 ? pos.totalCost / pos.quantity : 0.0;
        } else {
          // Standard WAC
          costBasisOfSold = qty * pos.pmc;
          pos.quantity = Math.max(0.0, pos.quantity - qty);
          if (pos.quantity <= 1e-9) {
            pos.quantity = 0.0;
            pos.pmc = 0.0;
            pos.totalCost = 0.0;
            pos.pmcNative = 0.0;
            pos.totalCostNative = 0.0;
          } else {
            pos.totalCost = pos.quantity * pos.pmc;
            pos.totalCostNative = pos.quantity * pos.pmcNative;
          }
        }

        const pnl = netProceedsEur - costBasisOfSold;
        const netProceedsNative = (qty * price - commission);
        const costBasisSoldNative = qty * pmcNativeAtSell;
        pos.realizedPnl = (pos.realizedPnl || 0.0) + pnl;
        pos.realizedPnlNative = (pos.realizedPnlNative || 0.0) + (netProceedsNative - costBasisSoldNative);
        realizedPnl += pnl;

        const isTotalClose = pos.quantity <= 1e-9;
        const pnlPct = costBasisOfSold > 0 ? (pnl / costBasisOfSold) * 100.0 : 0.0;
        const effectivePmcSold = qty > 0 ? (costBasisOfSold / qty) : pmcAtSell;
        const assetInfo = assetsMap[ticker] || {
          ticker,
          name: tx.notes || ticker,
          type: 'EQUITY',
          sector: 'Unclassified',
          region: 'Global',
          currency: portfolioCurrency
        };

        realizedPositions.push({
          id: tx.id,
          date: tx.date,
          ticker,
          name: assetInfo.name || tx.notes || ticker,
          type: assetInfo.type || 'EQUITY',
          sector: assetInfo.sector || 'Unclassified',
          region: assetInfo.region || 'Global',
          quantity: qty,
          pmc: effectivePmcSold,
          pmcNative: pmcNativeAtSell,
          sellPrice: price,
          costBasis: costBasisOfSold,
          costBasisNative: costBasisSoldNative,
          proceeds: netProceedsEur,
          proceedsNative: netProceedsNative,
          realizedPnl: pnl,
          realizedPnlNative: (netProceedsNative - costBasisSoldNative),
          realizedPnlPercent: pnlPct,
          isTotal: isTotalClose,
          closeType: isTotalClose ? 'TOTALE' : 'PARZIALE',
          remainingQuantity: pos.quantity,
          commission,
          tax,
          notes: tx.notes || '',
          currency: (tx.currency || assetInfo.currency || portfolioCurrency || 'EUR').toUpperCase()
        });
        break;
      }

      case 'DIVIDEND':
      case 'INTEREST': {
        const netIncome = specifiedAmount > 0
          ? specifiedAmount
          : ((qty > 0 && price > 0 ? qty * price : 0.0) - tax);
        currentCash += netIncome;
        totalDividends += netIncome;
        if (ticker && positions[ticker]) {
          positions[ticker].dividends = (positions[ticker].dividends || 0.0) + netIncome;
          const netNative = (qty > 0 && price > 0) ? (qty * price - tax) : (fxRate > 0 && fxRate !== 1.0 ? netIncome * fxRate : netIncome);
          positions[ticker].dividendsNative = (positions[ticker].dividendsNative || 0.0) + netNative;
        }
        break;
      }

      case 'FEE':
      case 'TAX': {
        const feeAmount = specifiedAmount > 0 ? specifiedAmount : commission + tax;
        currentCash -= feeAmount;
        break;
      }

      case 'SPLIT': {
        if (ticker && positions[ticker] && qty > 0) {
          // In a split, qty is the split ratio (e.g. 2 for 2-for-1 split, or 0.1 for reverse)
          const ratio = qty;
          const pos = positions[ticker];
          pos.quantity *= ratio;
          pos.pmc /= ratio;
          if (pos.lots) {
            for (const lot of pos.lots) {
              lot.quantity *= ratio;
              lot.costPerUnit /= ratio;
            }
          }
        }
        break;
      }

      default:
        break;
    }
  }

  // Construct holdings list and compute market values
  const holdings = [];
  let totalAssetValue = 0.0;
  let totalCostBasis = 0.0;

  for (const [ticker, pos] of Object.entries(positions)) {
    if (pos.quantity > 1e-6) {
      const asset = assetsMap[ticker] || {
        ticker,
        name: ticker,
        type: 'EQUITY',
        currentPrice: pos.pmc, // Fallback to PMC if market price is not yet fetched
        currency: 'EUR',
        sector: 'Unclassified',
        region: 'Global',
        country: '',
        dividendYield: 0.0
      };

      const rawPrice = Number(asset.currentPrice) || pos.pmcNative || pos.pmc;
      const assetCurrency = (asset.currency || portfolioCurrency || 'EUR').toUpperCase();
      const fxRateToPortfolio = getCurrencyRate(assetCurrency, portfolioCurrency, currencyRatesMap);
      const currentPrice = rawPrice * fxRateToPortfolio;
      const marketValue = pos.quantity * currentPrice;
      const bookValue = pos.quantity * pos.pmc;
      const unrealizedPnl = marketValue - bookValue;
      const unrealizedPnlPercent = bookValue > 0 ? (unrealizedPnl / bookValue) * 100.0 : 0.0;

      const currentPriceNative = rawPrice;
      const pmcNative = pos.pmcNative > 0 ? pos.pmcNative : (fxRateToPortfolio > 0 ? (pos.pmc / fxRateToPortfolio) : pos.pmc);
      const bookValueNative = pos.quantity * pmcNative;
      const marketValueNative = pos.quantity * currentPriceNative;
      const unrealizedPnlNative = marketValueNative - bookValueNative;
      const unrealizedPnlPercentNative = bookValueNative > 0 ? (unrealizedPnlNative / bookValueNative) * 100.0 : 0.0;

      const changeVal = Number(asset.changeValue) || 0.0;
      const changePct = Number(asset.changePercent !== undefined ? asset.changePercent : (asset.change24h || 0.0)) || 0.0;
      const dayPnlNative = changeVal * pos.quantity;
      const dayPnlEur = dayPnlNative * fxRateToPortfolio;

      // Currency effect (Effetto Cambio in EUR):
      // Difference between total EUR unrealized PnL and local asset PnL converted to EUR at current FX
      const fxImpact = unrealizedPnl - (unrealizedPnlNative * fxRateToPortfolio);

      const priceReturnPercent = pmcNative > 0 ? ((currentPriceNative - pmcNative) / pmcNative) * 100.0 : 0.0;
      const dividendsNative = pos.dividendsNative || 0.0;
      const totalReturnNative = unrealizedPnlNative + dividendsNative;
      const totalReturnPercentNative = bookValueNative > 0 ? (totalReturnNative / bookValueNative) * 100.0 : 0.0;

      const openPrice = Number(asset.openPrice) || currentPriceNative;
      const highPrice = Number(asset.highPrice) || currentPriceNative;
      const lowPrice = Number(asset.lowPrice) || currentPriceNative;
      const closePrice = currentPriceNative;
      const previousClose = Number(asset.previousClose) || (currentPriceNative - changeVal);

      totalAssetValue += marketValue;
      totalCostBasis += bookValue;

      holdings.push({
        ticker,
        name: asset.name || ticker,
        type: asset.type || 'EQUITY',
        currency: assetCurrency,
        rawPrice: currentPriceNative,
        currentPriceNative,
        currentPrice,
        pmc: pos.pmc,
        pmcNative,
        costBasis: pos.pmc,
        costBasisNative: pmcNative,
        bookValue,
        bookValueNative,
        marketValue,
        marketValueNative,
        unrealizedPnl,
        unrealizedPnL: unrealizedPnl,
        unrealizedPnlPercent,
        unrealizedPnLPercent: unrealizedPnlPercent,
        unrealizedPnlNative,
        unrealizedPnlPercentNative,
        realizedPnl: pos.realizedPnl || 0.0,
        realizedPnlNative: pos.realizedPnlNative || 0.0,
        dividends: pos.dividends || 0.0,
        dividendsNative,
        fxImpact,
        priceReturnPercent,
        totalReturnNative,
        totalReturnPercentNative,
        changePercent: changePct,
        change24h: changePct,
        changeValue: changeVal,
        dayPnlNative,
        dayPnlEur,
        openPrice,
        highPrice,
        lowPrice,
        closePrice,
        previousClose,
        sector: asset.sector || 'Unclassified',
        region: asset.region || 'Global',
        country: asset.country || '',
        exchange: asset.exchange || '',
        dataSource: asset.dataSource || '',
        quoteDate: asset.quoteDate || null,
        marketState: asset.marketState || null,
        regularMarketTime: asset.regularMarketTime || null,
        lastSyncAt: asset.lastSyncAt || asset.updatedAt || null,
        updatedAt: asset.updatedAt || null,
        quantity: pos.quantity,
        dividendYield: asset.dividendYield || 0.0,
        riskCategory: asset.riskCategory || 'MEDIUM',
        weight: 0.0 // Computed below once totalPortfolioValue is known
      });
    }
  }

  const totalPortfolioValue = currentCash + totalAssetValue;
  const totalUnrealizedPnl = totalAssetValue - totalCostBasis;
  const totalUnrealizedPnlPercent = totalCostBasis > 0 ? (totalUnrealizedPnl / totalCostBasis) * 100.0 : 0.0;

  // Compute weights for each holding
  for (const h of holdings) {
    h.weight = totalPortfolioValue > 0 ? (h.marketValue / totalPortfolioValue) * 100.0 : 0.0;
  }

  // Sort holdings by market value descending
  holdings.sort((a, b) => b.marketValue - a.marketValue);

  // Compute Multi-Dimensional Allocations
  const byAssetClass = {};
  const bySector = {};
  const byRegion = {};

  // Add Cash to Asset Class allocation
  if (currentCash !== 0) {
    byAssetClass['CASH'] = {
      value: currentCash,
      weight: totalPortfolioValue > 0 ? (currentCash / totalPortfolioValue) * 100.0 : 0.0
    };
  }

  for (const h of holdings) {
    // 1. Asset Class
    const cls = (h.type || 'EQUITY').toUpperCase();
    if (!byAssetClass[cls]) byAssetClass[cls] = { value: 0.0, weight: 0.0 };
    byAssetClass[cls].value += h.marketValue;

    // 2. GICS Sector
    const sec = h.sector || 'Unclassified';
    if (!bySector[sec]) bySector[sec] = { value: 0.0, weight: 0.0 };
    bySector[sec].value += h.marketValue;

    // 3. Region
    const reg = h.region || 'Global';
    if (!byRegion[reg]) byRegion[reg] = { value: 0.0, weight: 0.0 };
    byRegion[reg].value += h.marketValue;
  }

  // Finalize allocation weights
  for (const map of [byAssetClass, bySector, byRegion]) {
    for (const key of Object.keys(map)) {
      map[key].weight = totalPortfolioValue > 0 ? (map[key].value / totalPortfolioValue) * 100.0 : 0.0;
    }
  }

  // Calculate XIRR with current terminal valuation
  if (totalPortfolioValue > 0) {
    const todayStr = new Date().toISOString().split('T')[0];
    xirrCashFlows.push({ date: todayStr, amount: totalPortfolioValue });
  }

  const xirr = calculateXIRR(xirrCashFlows);
  const roi = calculateROI(totalPortfolioValue, netDeposits);

  const totalDayPnl = holdings.reduce((sum, h) => sum + (Number(h.dayPnlEur) || 0.0), 0.0);
  const baselineValue = totalPortfolioValue - totalDayPnl;
  const totalDayPnlPercent = baselineValue > 0 ? (totalDayPnl / baselineValue) * 100.0 : 0.0;

  return {
    currentCash,
    totalAssetValue,
    totalValue: totalPortfolioValue,
    totalCost: totalCostBasis,
    investedCapital: netDeposits,
    realizedPnl,
    unrealizedPnl: totalUnrealizedPnl,
    unrealizedPnlPercent: totalUnrealizedPnlPercent,
    totalDividends,
    assetCount: holdings.length,
    dayPnl: totalDayPnl,
    dayPnlPercent: totalDayPnlPercent,
    roi,
    xirr,
    twr: roi, // Fallback to ROI when intra-day time series snapshots are not yet built
    holdings,
    closedPositions: realizedPositions,
    realizedPositions,
    allocations: {
      byAssetClass,
      bySector,
      byRegion
    }
  };
}

/**
 * Computes the exact net cash impact of a transaction.
 * Positive = cash added to portfolio liquid balance.
 * Negative = cash subtracted from portfolio liquid balance.
 *
 * @param {object} tx - Transaction row or payload
 * @returns {number} Cash delta
 */
function computeTransactionCashDelta(tx) {
  const type = (tx.type || '').toUpperCase();
  const qty = Number(tx.quantity) || 0.0;
  const price = Number(tx.price) || 0.0;
  const commission = Number(tx.commission) || 0.0;
  const tax = Number(tx.tax) || 0.0;
  const fxRate = Number(tx.exchangeRate) || 1.0;
  const specifiedAmount = Number(tx.amount) || 0.0;

  switch (type) {
    case 'DEPOSIT':
      return specifiedAmount > 0 ? specifiedAmount : (qty > 0 && price > 0 ? qty * price : 0.0);
    case 'WITHDRAWAL':
      return -(specifiedAmount > 0 ? specifiedAmount : (qty > 0 && price > 0 ? qty * price : 0.0));
    case 'TRANSFER':
      return specifiedAmount;
    case 'BUY': {
      if (specifiedAmount > 0) return -specifiedAmount;
      const grossEur = (fxRate !== 1.0 && fxRate > 0) ? ((qty * price) / fxRate) : (qty * price);
      const commEur = (fxRate !== 1.0 && fxRate > 0 && commission > 0) ? (commission / fxRate) : commission;
      return -(grossEur + commEur + tax);
    }
    case 'SELL': {
      if (specifiedAmount > 0) return specifiedAmount;
      const grossEur = (fxRate !== 1.0 && fxRate > 0) ? ((qty * price) / fxRate) : (qty * price);
      const commEur = (fxRate !== 1.0 && fxRate > 0 && commission > 0) ? (commission / fxRate) : commission;
      return grossEur - commEur - tax;
    }
    case 'DIVIDEND':
    case 'INTEREST':
      return specifiedAmount > 0 ? specifiedAmount : ((qty > 0 && price > 0 ? qty * price : 0.0) - tax);
    case 'FEE':
    case 'TAX':
      return -(specifiedAmount > 0 ? specifiedAmount : (commission + tax));
    case 'SPLIT':
    default:
      return 0.0;
  }
}

module.exports = {
  calculateXIRR,
  calculateTWR,
  calculateROI,
  calculateHoldingsAndMetrics,
  computeTransactionCashDelta,
  getCurrencyRate
};

