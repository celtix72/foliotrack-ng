/**
 * Dividend & Cash Flow Forecast Engine for FolioTrack
 *
 * Implements:
 * 1. Historical annual dividends breakdown (by year, with YoY growth and asset details)
 * 2. Current year remaining months forecast (expected dividends/coupons for unexpired months)
 * 3. Next year forward projections based on active portfolio holdings
 * 4. Automatic dynamic recalculation on buy/sell transactions
 */

const MONTH_NAMES = [
  'Gennaio', 'Febbraio', 'Marzo', 'Aprile', 'Maggio', 'Giugno',
  'Luglio', 'Agosto', 'Settembre', 'Ottobre', 'Novembre', 'Dicembre'
];

const MONTH_SHORT_NAMES = [
  'Gen', 'Feb', 'Mar', 'Apr', 'Mag', 'Giu',
  'Lug', 'Ago', 'Set', 'Ott', 'Nov', 'Dic'
];

/**
 * Authoritative payment schedule registry for known government bonds and equities.
 * Prevents incorrect quarterly fallback for annual/semi-annual payers (e.g. Rai Way, Nexi, Intesa Sanpaolo, Prosus, BTP Valore).
 */
const KNOWN_ASSET_SCHEDULES = {
  // BTP Valore 4ª emissione (Maggio 2024 - Maggio 2030): trimestrale a Feb, Mag, Ago, Nov (14 Nov 2026)
  'IT0005594483': {
    payoutMonths: [2, 5, 8, 11],
    frequency: 'QUARTERLY',
    dayOfMonth: 14,
    expectedPayment: 219.84,
    note: '14 Nov (BTP Valore Mg30)'
  },
  // BTP Valore 3ª emissione (Marzo 2024 - Marzo 2030): trimestrale a Mar, Giu, Set, Dic (5 Dic 2026)
  'IT0005583486': {
    payoutMonths: [3, 6, 9, 12],
    frequency: 'QUARTERLY',
    dayOfMonth: 5,
    expectedPayment: 213.43,
    note: '5 Dic (BTP Valore Mz30)'
  },
  // BTP 2039: semestrale 1° Marzo e 1° Settembre
  'IT0004532559': {
    payoutMonths: [3, 9],
    frequency: 'SEMI_ANNUAL',
    dayOfMonth: 1,
    note: '1 Mar / 1 Set'
  },
  // Mediobanca Bond: annuale a Luglio
  'XS3021378388': {
    payoutMonths: [7],
    frequency: 'ANNUAL',
    dayOfMonth: 16,
    note: '16 Lug'
  },
  // Intesa Sanpaolo: saldo a Maggio, acconto deliberato CdA per il 25 Novembre 2026
  'ISP.MI': {
    payoutMonths: [5, 11],
    frequency: 'SEMI_ANNUAL',
    dayOfMonth: 25,
    interimAmountPerShare: 0.17, // Acconto deliberato dal CdA (€ 0.17/azione)
    note: '25 Nov deliberato CdA'
  },
  // Rai Way: dividendo annuale staccato solo a Maggio (nessun dividendo a fine anno)
  'RWAY.MI': {
    payoutMonths: [5],
    frequency: 'ANNUAL',
    note: 'Annuale a Maggio (già staccato)'
  },
  // Nexi: dividendo annuale staccato solo a Maggio (nessun dividendo a fine anno)
  'NEXI.MI': {
    payoutMonths: [5],
    frequency: 'ANNUAL',
    note: 'Annuale a Maggio (già staccato)'
  },
  // Prosus: dividendo annuale a Dicembre
  'PRX.AS': {
    payoutMonths: [12],
    frequency: 'ANNUAL',
    note: 'Annuale a Dicembre'
  },
  // Nomad Foods: trimestrale Feb, Mag, Ago, Nov
  'NOMD': {
    payoutMonths: [2, 5, 8, 11],
    frequency: 'QUARTERLY',
    note: 'Trimestrale Nov'
  },
  // PayPal Holdings: trimestrale Mar, Giu, Set, Dic (23 Dic 2026)
  'PYPL': {
    payoutMonths: [3, 6, 9, 12],
    frequency: 'QUARTERLY',
    dayOfMonth: 23,
    note: '23 Dic'
  },
  // Micron Technology: trimestrale con stacco a Dicembre
  'MU': {
    payoutMonths: [3, 6, 9, 12],
    frequency: 'QUARTERLY',
    note: 'Dicembre'
  },
  // UnitedHealth Group: trimestrale Mar, Giu, Set, Dic
  'UNH': {
    payoutMonths: [3, 6, 9, 12],
    frequency: 'QUARTERLY',
    note: 'Dicembre'
  },
  // VanEck Developed Markets Dividend ETF: trimestrale Mar, Giu, Set, Dic
  'TDIV.AS': {
    payoutMonths: [3, 6, 9, 12],
    frequency: 'QUARTERLY',
    note: 'Dicembre'
  },
  // Meta Platforms: trimestrale Mar, Giu, Set, Dic
  'META': {
    payoutMonths: [3, 6, 9, 12],
    frequency: 'QUARTERLY',
    note: 'Dicembre'
  },
  // Alibaba Group: annuale a Luglio
  'BABA': {
    payoutMonths: [7],
    frequency: 'ANNUAL'
  },
  // JD.com: annuale ad Aprile
  'JD': {
    payoutMonths: [4],
    frequency: 'ANNUAL'
  },
  // Salesforce: trimestrale Gen, Apr, Lug, Ott
  'CRM': {
    payoutMonths: [1, 4, 7, 10],
    frequency: 'QUARTERLY'
  },
  // Novo Nordisk: semestrale Aprile, Agosto
  'NOV.DE': {
    payoutMonths: [4, 8],
    frequency: 'SEMI_ANNUAL'
  },
  // Kaspi.kz: trimestrale Mar, Giu, Set
  'KSPI': {
    payoutMonths: [3, 6, 9],
    frequency: 'QUARTERLY'
  }
};

/**
 * Calculates historical dividends and interest grouped by calendar year.
 *
 * @param {Array<object>} transactions - Array of transaction objects
 * @param {object} [assetsMap={}] - Dictionary of asset details by ticker
 * @returns {Array<object>} Annual records sorted descending by year
 */
function calculateAnnualDividendsHistory(transactions = [], assetsMap = {}) {
  const yearsMap = new Map();

  for (const t of transactions) {
    if (t.type !== 'DIVIDEND' && t.type !== 'INTEREST') continue;
    if (!t.date) continue;
    const yr = parseInt(String(t.date).slice(0, 4), 10);
    const mth = String(t.date).slice(5, 7);
    if (isNaN(yr)) continue;

    if (!yearsMap.has(yr)) {
      yearsMap.set(yr, {
        year: yr,
        total: 0.0,
        dividends: 0.0,
        interest: 0.0,
        count: 0,
        assetMap: new Map()
      });
    }

    const yEntry = yearsMap.get(yr);
    const amt = Number(t.amount) || 0.0;
    yEntry.total += amt;
    yEntry.count += 1;
    if (t.type === 'DIVIDEND') yEntry.dividends += amt;
    if (t.type === 'INTEREST') yEntry.interest += amt;

    const tkr = (t.assetTicker || 'UNKNOWN').toUpperCase();
    if (!yEntry.assetMap.has(tkr)) {
      const a = assetsMap[tkr] || {};
      yEntry.assetMap.set(tkr, {
        ticker: tkr,
        name: a.name || tkr,
        type: a.type || (t.type === 'INTEREST' ? 'BOND' : 'EQUITY'),
        amount: 0.0,
        count: 0,
        months: new Set()
      });
    }
    const aEntry = yEntry.assetMap.get(tkr);
    aEntry.amount += amt;
    aEntry.count += 1;
    if (mth) aEntry.months.add(mth);
  }

  // Convert to array and sort descending by year
  const sortedYears = Array.from(yearsMap.keys()).sort((a, b) => b - a);
  const result = [];

  for (let i = 0; i < sortedYears.length; i++) {
    const yr = sortedYears[i];
    const item = yearsMap.get(yr);

    // Calculate YoY growth rate vs previous calendar year (yr - 1)
    const prevYearItem = yearsMap.get(yr - 1);
    let yoyGrowthRate = null;
    if (prevYearItem && prevYearItem.total > 0) {
      yoyGrowthRate = Number((((item.total - prevYearItem.total) / prevYearItem.total) * 100).toFixed(2));
    }

    const assetsList = Array.from(item.assetMap.values()).map(a => ({
      ticker: a.ticker,
      name: a.name,
      type: a.type,
      amount: Number(a.amount.toFixed(2)),
      count: a.count,
      months: Array.from(a.months).sort()
    })).sort((a, b) => b.amount - a.amount);

    result.push({
      year: yr,
      total: Number(item.total.toFixed(2)),
      dividends: Number(item.dividends.toFixed(2)),
      interest: Number(item.interest.toFixed(2)),
      count: item.count,
      yoyGrowthRate,
      assets: assetsList
    });
  }

  return result;
}

/**
 * Calculates current year remaining dividend forecast and next year full projection
 * based on currently active portfolio holdings and historical payment schedules.
 *
 * @param {Array<object>} activeHoldings - Currently active positions (quantity > 0)
 * @param {Array<object>} transactions - Historical transaction log
 * @param {object} [assetsMap={}] - Dictionary of asset metadata by ticker
 * @param {object} [options={}] - Options (e.g. { currentDate: Date })
 * @returns {object} Forecast object containing currentYearForecast and nextYearForecast
 */
function calculateDividendForecast(activeHoldings = [], transactions = [], assetsMap = {}, options = {}) {
  const currentDate = options.currentDate || new Date();
  const currentYear = currentDate.getFullYear();
  const currentMonth = currentDate.getMonth() + 1; // 1-12
  const nextYear = currentYear + 1;

  // 1. Transactions already collected in the current year
  const currentYearTx = transactions.filter(t => {
    if (t.type !== 'DIVIDEND' && t.type !== 'INTEREST') return false;
    if (!t.date) return false;
    return parseInt(String(t.date).slice(0, 4), 10) === currentYear;
  });

  const collectedSoFar = currentYearTx.reduce((sum, t) => sum + (Number(t.amount) || 0.0), 0.0);

  // Group historical dividend payments by ticker and month to discover payout patterns
  const assetHistoryMap = new Map();
  for (const t of transactions) {
    if (t.type !== 'DIVIDEND' && t.type !== 'INTEREST') continue;
    if (!t.date || !t.assetTicker) continue;
    const tkr = t.assetTicker.toUpperCase();
    const yr = parseInt(String(t.date).slice(0, 4), 10);
    const mth = parseInt(String(t.date).slice(5, 7), 10);
    const amt = Number(t.amount) || 0.0;

    if (!assetHistoryMap.has(tkr)) {
      assetHistoryMap.set(tkr, []);
    }
    assetHistoryMap.get(tkr).push({ yr, mth, amt, date: t.date });
  }

  let totalProjectedNextYear = 0.0;
  let remainingExpectedThisYear = 0.0;
  const holdingProjections = [];
  const expectedRemainingPayments = [];
  const nextYearMonthlyMap = new Array(12).fill(0.0);

  let totalHoldingsMarketValue = 0.0;

  for (const h of activeHoldings) {
    const qty = Number(h.quantity) || 0.0;
    if (qty <= 1e-6) continue;

    const tkr = String(h.ticker || '').toUpperCase();
    const a = assetsMap[tkr] || {};
    const price = Number(h.currentPrice) || Number(a.currentPrice) || Number(h.rawPrice) || 0.0;
    const marketValue = Number(h.marketValue) || (qty * price);
    totalHoldingsMarketValue += marketValue;

    let yieldPct = Number(h.dividendYield) || Number(a.dividendYield) || 0.0;
    let annualIncome = 0.0;

    const history = assetHistoryMap.get(tkr) || [];
    // Identify payout months from recent history (last 2 years)
    const recentHistory = history.filter(t => t.yr >= currentYear - 1);
    const historyMonths = Array.from(new Set(recentHistory.map(t => t.mth))).sort((x, y) => x - y);

    const sched = KNOWN_ASSET_SCHEDULES[tkr];
    let payoutMonths = sched && sched.payoutMonths ? sched.payoutMonths : historyMonths;
    if (!payoutMonths || payoutMonths.length === 0) {
      // Default quarterly if unknown
      payoutMonths = [3, 6, 9, 12];
    }

    if (yieldPct > 0) {
      annualIncome = qty * price * (yieldPct / 100.0);
    } else if (sched && sched.expectedPayment && sched.payoutMonths) {
      annualIncome = sched.expectedPayment * sched.payoutMonths.length;
      if (marketValue > 0) {
        yieldPct = Number(((annualIncome / marketValue) * 100).toFixed(2));
      }
    } else if (history.length > 0) {
      // Deducing coupon / dividend from historical payments (e.g. Italian BTPs)
      const txPrevYear = history.filter(t => t.yr === currentYear - 1);
      if (txPrevYear.length >= (historyMonths.length || 1) && txPrevYear.length > 0) {
        annualIncome = txPrevYear.reduce((s, t) => s + t.amt, 0.0);
      } else if (recentHistory.length > 0) {
        const avgPayment = recentHistory.reduce((s, t) => s + t.amt, 0.0) / recentHistory.length;
        annualIncome = avgPayment * (historyMonths.length || 1);
      } else {
        annualIncome = history.reduce((s, t) => s + t.amt, 0.0) / history.length;
      }
      if (marketValue > 0) {
        yieldPct = Number(((annualIncome / marketValue) * 100).toFixed(2));
      }
    }

    if (annualIncome <= 0 && (!sched || !sched.expectedPayment)) {
      continue;
    }

    totalProjectedNextYear += annualIncome;

    let perPayment = annualIncome / payoutMonths.length;
    if (sched && sched.expectedPayment) {
      perPayment = sched.expectedPayment;
    } else if (sched && sched.interimAmountPerShare) {
      perPayment = qty * sched.interimAmountPerShare;
    } else if (sched && sched.frequency === 'ANNUAL') {
      perPayment = annualIncome;
    }

    // Remaining payments for the CURRENT year
    let holdingRemainingThisYear = 0.0;
    for (const m of payoutMonths) {
      if (m >= currentMonth) {
        // Check if already paid in this specific month during currentYear
        const alreadyPaid = currentYearTx.some(t => {
          if (String(t.assetTicker).toUpperCase() !== tkr) return false;
          const tMth = parseInt(String(t.date).slice(5, 7), 10);
          return tMth === m;
        });

        if (!alreadyPaid) {
          holdingRemainingThisYear += perPayment;
          const day = sched && sched.dayOfMonth ? sched.dayOfMonth : null;
          const dateLabel = day ? `${day} ${MONTH_SHORT_NAMES[m - 1]}` : MONTH_SHORT_NAMES[m - 1];

          expectedRemainingPayments.push({
            ticker: tkr,
            name: a.name || h.name || tkr,
            type: a.type || h.type || 'EQUITY',
            month: m,
            monthName: MONTH_NAMES[m - 1],
            monthShort: MONTH_SHORT_NAMES[m - 1],
            dayOfMonth: day,
            dateLabel,
            expectedAmount: Number(perPayment.toFixed(2)),
            note: sched && sched.note ? sched.note : ''
          });
        }
      }
    }

    remainingExpectedThisYear += holdingRemainingThisYear;

    // Distribute into NEXT year months
    for (const m of payoutMonths) {
      nextYearMonthlyMap[m - 1] += perPayment;
    }

    holdingProjections.push({
      ticker: tkr,
      name: a.name || h.name || tkr,
      type: a.type || h.type || 'EQUITY',
      quantity: qty,
      currentPrice: price,
      marketValue: Number(marketValue.toFixed(2)),
      dividendYield: Number(yieldPct.toFixed(2)),
      projectedAnnualIncome: Number(annualIncome.toFixed(2)),
      projectedMonthlyIncome: Number((annualIncome / 12.0).toFixed(2)),
      remainingThisYear: Number(holdingRemainingThisYear.toFixed(2)),
      payoutMonths
    });
  }

  // Sort holding projections descending by annual income
  holdingProjections.sort((a, b) => b.projectedAnnualIncome - a.projectedAnnualIncome);

  // Sort expected remaining payments by month ascending, then dayOfMonth ascending (or amount descending)
  expectedRemainingPayments.sort((a, b) => {
    if (a.month !== b.month) return a.month - b.month;
    if (a.dayOfMonth && b.dayOfMonth) return a.dayOfMonth - b.dayOfMonth;
    if (a.dayOfMonth && !b.dayOfMonth) return -1;
    if (!a.dayOfMonth && b.dayOfMonth) return 1;
    return b.expectedAmount - a.expectedAmount;
  });

  const projectedYearEndTotal = collectedSoFar + remainingExpectedThisYear;

  // Next year monthly breakdown
  const nextYearMonthlyBreakdown = nextYearMonthlyMap.map((amt, idx) => ({
    month: idx + 1,
    monthName: MONTH_NAMES[idx],
    monthShort: MONTH_SHORT_NAMES[idx],
    amount: Number(amt.toFixed(2))
  }));

  const portfolioYield = totalHoldingsMarketValue > 0
    ? Number(((totalProjectedNextYear / totalHoldingsMarketValue) * 100).toFixed(2))
    : 0.0;

  const yoyGrowthVsCurrentYear = projectedYearEndTotal > 0
    ? Number((((totalProjectedNextYear - projectedYearEndTotal) / projectedYearEndTotal) * 100).toFixed(2))
    : 0.0;

  return {
    currentYearForecast: {
      currentYear,
      currentMonth,
      collectedSoFar: Number(collectedSoFar.toFixed(2)),
      remainingMonthsCount: Math.max(0, 12 - currentMonth + 1),
      remainingMonths: Array.from({ length: 12 - currentMonth + 1 }, (_, i) => currentMonth + i),
      remainingExpected: Number(remainingExpectedThisYear.toFixed(2)),
      projectedYearEndTotal: Number(projectedYearEndTotal.toFixed(2)),
      expectedRemainingPayments
    },
    nextYearForecast: {
      nextYear,
      totalProjected: Number(totalProjectedNextYear.toFixed(2)),
      monthlyAverage: Number((totalProjectedNextYear / 12.0).toFixed(2)),
      portfolioYield,
      yoyGrowthVsCurrentYear,
      monthlyBreakdown: nextYearMonthlyBreakdown,
      holdingProjections
    }
  };
}

module.exports = {
  MONTH_NAMES,
  MONTH_SHORT_NAMES,
  KNOWN_ASSET_SCHEDULES,
  calculateAnnualDividendsHistory,
  calculateDividendForecast
};
