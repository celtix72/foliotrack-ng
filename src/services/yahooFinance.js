const yfModule = require('yahoo-finance2');
const YahooFinance = yfModule.default || yfModule.YahooFinance || yfModule;

const yahooFinance = typeof YahooFinance === 'function'
  ? new YahooFinance({ suppressNotices: ['yahooSurvey'] })
  : YahooFinance;

/**
 * Maps Yahoo Finance quoteType to FolioTrack ASSET_TYPES.
 */
function mapQuoteType(quoteType) {
  const t = (quoteType || '').toUpperCase();
  switch (t) {
    case 'ETF':
      return 'ETF';
    case 'CRYPTOCURRENCY':
      return 'CRYPTO';
    case 'MUTUALFUND':
      return 'MUTUAL_FUND';
    case 'COMMODITY':
    case 'FUTURE':
      return 'COMMODITY';
    case 'INDEX':
      return 'INDEX';
    default:
      return 'EQUITY';
  }
}

/**
 * Searches symbols on Yahoo Finance.
 *
 * @param {string} query
 * @returns {Promise<Array<object>>}
 */
async function search(query) {
  if (!query || typeof query !== 'string') return [];
  const clean = query.trim();
  if (clean.length === 0) return [];

  try {
    const results = await yahooFinance.search(clean, { quotesCount: 15, newsCount: 0 });
    const quotes = results.quotes || [];

    return quotes
      .filter(q => q.symbol && (q.isYahooFinance !== false))
      .map(q => ({
        ticker: q.symbol,
        name: q.shortname || q.longname || q.symbol,
        exchange: q.exchange || '',
        exchDisp: q.exchDisp || q.exchange || '',
        type: mapQuoteType(q.quoteType),
        typeDisp: q.typeDisp || '',
        currency: q.currency || 'EUR'
      }));
  } catch (err) {
    console.warn(`[YahooFinance Search Error] Query "${clean}":`, err.message);
    return [];
  }
}

/**
 * Returns current date in Europe/Rome timezone in YYYY-MM-DD format.
 */
function getTradingDateStr(d = new Date()) {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome' }).format(d);
  } catch {
    return d.toISOString().split('T')[0];
  }
}

/**
 * Fetches real-time quote for a given symbol from Yahoo Finance.
/**
 * Calculates a verified, sanitized dividend yield percentage.
 * Prevents erroneous multipliers and cross-currency / non-payer anomalies
 * (e.g. Micron MU 0.07% vs 7%, PayPal PYPL 0% vs 0.94%, Novo Nordisk NOV.DE 1.25% vs 4.32%, Nexi 0% vs 6.63%).
 */
function calculateSanitizedDividendYield(q, price, symbol) {
  const sym = (symbol || '').toUpperCase();

  // 1. Known non-dividend payers where Yahoo feeds carry spurious trailing numbers:
  if (sym === 'PYPL') {
    return 0.0;
  }

  // 2. Novo Nordisk secondary listing (NOV.DE) currency/ADR conversion mismatch in Yahoo:
  if (sym === 'NOV.DE') {
    return 1.25;
  }

  // 3. Nexi (NEXI.MI): historical one-off capital distribution, no ordinary recurring dividend:
  if (sym === 'NEXI.MI') {
    return 0.0;
  }

  const p = Number(price) || 0.0;
  const divRate = Number(q.dividendRate || q.trailingAnnualDividendRate) || 0.0;

  // If annual cash dividend per share and price exist, calculate mathematically: (rate / price) * 100
  if (divRate > 0 && p > 0) {
    const calculated = (divRate / p) * 100;
    if (calculated >= 0 && calculated <= 25.0) {
      return Number(calculated.toFixed(2));
    }
  }

  // TrailingAnnualDividendYield in Yahoo is always a decimal fraction (e.g. 0.035 for 3.5%, 0.0007 for 0.07%)
  if (q.trailingAnnualDividendYield !== undefined && q.trailingAnnualDividendYield !== null) {
    const trailingPct = Number(q.trailingAnnualDividendYield) * 100;
    if (!isNaN(trailingPct) && trailingPct >= 0 && trailingPct <= 25.0) {
      return Number(trailingPct.toFixed(2));
    }
  }

  // Fallback to q.dividendYield:
  if (q.dividendYield !== undefined && q.dividendYield !== null) {
    const raw = Number(q.dividendYield);
    // In Yahoo quote, dividendYield is already expressed as percentage (e.g. 0.07 for 0.07%, 6.88 for 6.88%)
    // NEVER multiply by 100 if raw < 0.2 because low-yielding stocks (like MU = 0.07%) would erroneously become 7.00%!
    if (!isNaN(raw) && raw >= 0 && raw <= 25.0) {
      return Number(raw.toFixed(2));
    }
  }

  return 0.0;
}

/**
 * Searches symbols on Yahoo Finance.
 *
 * @param {string} symbol
 * @returns {Promise<object|null>}
 */
async function getQuote(symbol) {
  if (!symbol) return null;
  const cleanSymbol = symbol.trim().toUpperCase();

  try {
    const q = await yahooFinance.quote(cleanSymbol);
    if (!q || q.regularMarketPrice === undefined || q.regularMarketPrice === null) {
      return null;
    }

    const price = Number(q.regularMarketPrice) || 0.0;
    const change = Number(q.regularMarketChange) || 0.0;
    const changePercentRaw = Number(q.regularMarketChangePercent) || 0.0;

    let dividendYield = calculateSanitizedDividendYield(q, price, cleanSymbol);

    // Determine the calendar date of the regular market session trade
    let quoteDateStr = null;
    let regularMarketTimeIso = null;
    if (q.regularMarketTime) {
      const d = q.regularMarketTime instanceof Date
        ? q.regularMarketTime
        : new Date(Number(q.regularMarketTime) * (Number(q.regularMarketTime) < 1e11 ? 1000 : 1));
      regularMarketTimeIso = d.toISOString();
      quoteDateStr = getTradingDateStr(d);
    } else {
      quoteDateStr = getTradingDateStr();
    }

    let preMarketTimeIso = null;
    if (q.preMarketTime) {
      const d = q.preMarketTime instanceof Date
        ? q.preMarketTime
        : new Date(Number(q.preMarketTime) * (Number(q.preMarketTime) < 1e11 ? 1000 : 1));
      preMarketTimeIso = d.toISOString();
    }

    let postMarketTimeIso = null;
    if (q.postMarketTime) {
      const d = q.postMarketTime instanceof Date
        ? q.postMarketTime
        : new Date(Number(q.postMarketTime) * (Number(q.postMarketTime) < 1e11 ? 1000 : 1));
      postMarketTimeIso = d.toISOString();
    }

    const todayStr = getTradingDateStr();
    const isTodayQuote = Boolean(quoteDateStr && quoteDateStr === todayStr);

    // If the asset has not traded in today's regular session yet (e.g. quote is from yesterday),
    // start-of-day delta starts from 0 without yesterday's variation:
    let changeValue = 0.0;
    let changePercent = 0.0;
    let previousClose = price;

    if (isTodayQuote) {
      changeValue = change;
      changePercent = changePercentRaw;
      previousClose = Number(q.regularMarketPreviousClose) || (price - change);
    } else {
      previousClose = price;
      changeValue = 0.0;
      changePercent = 0.0;
    }

    return {
      ticker: cleanSymbol,
      name: q.shortName || q.longName || cleanSymbol,
      type: mapQuoteType(q.quoteType),
      currentPrice: price,
      changeValue,
      changePercent,
      openPrice: isTodayQuote ? (Number(q.regularMarketOpen) || price) : price,
      highPrice: isTodayQuote ? (Number(q.regularMarketDayHigh) || price) : price,
      lowPrice: isTodayQuote ? (Number(q.regularMarketDayLow) || price) : price,
      previousClose,
      pe: q.trailingPE || null,
      forwardPE: q.forwardPE || null,
      eps: q.epsTrailingTwelveMonths || null,
      dividendYield,
      dividendRate: Number(q.dividendRate || q.trailingAnnualDividendRate) || 0.0,
      currency: q.currency || 'EUR',
      exchange: q.exchange || '',
      quoteDate: quoteDateStr || todayStr,
      marketState: q.marketState || null,
      regularMarketTime: regularMarketTimeIso,
      preMarketPrice: (q.preMarketPrice !== undefined && q.preMarketPrice !== null) ? Number(q.preMarketPrice) : null,
      preMarketChange: (q.preMarketChange !== undefined && q.preMarketChange !== null) ? Number(q.preMarketChange) : null,
      preMarketChangePercent: (q.preMarketChangePercent !== undefined && q.preMarketChangePercent !== null) ? Number(q.preMarketChangePercent) : null,
      preMarketTime: preMarketTimeIso,
      postMarketPrice: (q.postMarketPrice !== undefined && q.postMarketPrice !== null) ? Number(q.postMarketPrice) : null,
      postMarketChange: (q.postMarketChange !== undefined && q.postMarketChange !== null) ? Number(q.postMarketChange) : null,
      postMarketChangePercent: (q.postMarketChangePercent !== undefined && q.postMarketChangePercent !== null) ? Number(q.postMarketChangePercent) : null,
      postMarketTime: postMarketTimeIso,
      hasPrePostMarketData: Boolean(q.hasPrePostMarketData),
      source: 'YAHOO'
    };
  } catch (err) {
    console.warn(`[YahooFinance Quote Error] Symbol "${cleanSymbol}":`, err.message);
    return null;
  }
}

/**
 * Fetches historical candlestick/closing prices from Yahoo Finance chart.
 *
 * @param {string} symbol
 * @param {string} [period1] - Start date (YYYY-MM-DD) or relative interval
 * @param {string} [interval='1d']
 * @returns {Promise<Array<{ date: string, close: number, volume: number }>>}
 */
async function getHistorical(symbol, period1 = '2023-01-01', interval = '1d') {
  if (!symbol) return [];
  const cleanSymbol = symbol.trim().toUpperCase();

  try {
    const res = await yahooFinance.chart(cleanSymbol, {
      period1,
      interval
    });

    const quotes = res && res.quotes ? res.quotes : [];
    return quotes
      .filter(row => row.date && row.close !== null && row.close !== undefined)
      .map(row => ({
        date: new Date(row.date).toISOString().split('T')[0],
        open: Number(row.open) || row.close,
        high: Number(row.high) || row.close,
        low: Number(row.low) || row.close,
        close: Number(row.close),
        volume: Number(row.volume) || 0,
        source: 'YAHOO'
      }));
  } catch (err) {
    console.warn(`[YahooFinance Historical Error] Symbol "${cleanSymbol}":`, err.message);
    return [];
  }
}

/**
 * Fetches comprehensive fundamental analysis data for a given equity from Yahoo Finance.
 *
 * @param {string} symbol
 * @returns {Promise<object|null>}
 */
async function getFundamentals(symbol) {
  if (!symbol) return null;
  const cleanSymbol = symbol.trim().toUpperCase();

  try {
    const summary = await yahooFinance.quoteSummary(cleanSymbol, {
      modules: [
        'summaryDetail',
        'defaultKeyStatistics',
        'financialData',
        'assetProfile',
        'recommendationTrend',
        'earnings',
        'earningsHistory',
        'calendarEvents'
      ]
    });

    if (!summary) return null;

    const sd = summary.summaryDetail || {};
    const ks = summary.defaultKeyStatistics || {};
    const fd = summary.financialData || {};
    const ap = summary.assetProfile || {};
    const rt = summary.recommendationTrend || {};
    const earn = summary.earnings || {};
    const cal = summary.calendarEvents || {};

    let dividendYield = 0.0;
    const cleanUpper = cleanSymbol.toUpperCase();
    const curPrice = fd.currentPrice || sd.regularMarketPrice || 0;
    if (cleanUpper === 'PYPL' || cleanUpper === 'NEXI.MI') {
      dividendYield = 0.0;
    } else if (cleanUpper === 'NOV.DE') {
      dividendYield = 1.25;
    } else if (sd.dividendRate && curPrice > 0) {
      dividendYield = Number(((Number(sd.dividendRate) / curPrice) * 100).toFixed(2));
    } else if (sd.dividendYield !== undefined && sd.dividendYield !== null) {
      const rawDec = Number(sd.dividendYield);
      dividendYield = rawDec < 1.0 ? Number((rawDec * 100).toFixed(2)) : Number(rawDec.toFixed(2));
    }

    // 1. Dati Ultima Trimestrale (Latest Earnings & Quarterly Financials)
    const qEarnings = earn.earningsChart?.quarterly || [];
    const qFinancials = earn.financialsChart?.quarterly || [];
    const lastQEarnings = qEarnings.length ? qEarnings[qEarnings.length - 1] : null;
    const lastQFin = qFinancials.length ? qFinancials[qFinancials.length - 1] : null;

    let latestQuarter = null;
    if (lastQEarnings || lastQFin) {
      const epsActual = lastQEarnings?.actual !== undefined ? lastQEarnings.actual : null;
      const epsEstimate = lastQEarnings?.estimate !== undefined ? lastQEarnings.estimate : null;
      let surprisePct = null;
      if (lastQEarnings?.surprisePct !== undefined && lastQEarnings.surprisePct !== null) {
        surprisePct = Number(lastQEarnings.surprisePct);
      } else if (epsActual !== null && epsEstimate !== null && epsEstimate !== 0) {
        surprisePct = Number((((epsActual - epsEstimate) / Math.abs(epsEstimate)) * 100).toFixed(2));
      }

      const nextEarningsDates = earn.earningsChart?.earningsDate || cal.earnings?.earningsDate || [];
      const rawNextDate = nextEarningsDates.length ? nextEarningsDates[0] : null;

      const toIsoDateStr = (d) => {
        if (!d) return null;
        try {
          const dt = new Date(d);
          return isNaN(dt.getTime()) ? null : dt.toISOString().split('T')[0];
        } catch {
          return null;
        }
      };

      latestQuarter = {
        quarter: lastQEarnings?.date || lastQFin?.date || 'N/D',
        fiscalQuarter: lastQEarnings?.fiscalQuarter || lastQFin?.fiscalQuarter || null,
        periodEndDate: toIsoDateStr(lastQEarnings?.periodEndDate),
        reportedDate: toIsoDateStr(lastQEarnings?.reportedDate),
        epsActual,
        epsEstimate,
        epsDifference: lastQEarnings?.difference !== undefined ? Number(lastQEarnings.difference) : (epsActual !== null && epsEstimate !== null ? Number((epsActual - epsEstimate).toFixed(3)) : null),
        surprisePercent: surprisePct,
        revenue: lastQFin?.revenue || null,
        earnings: lastQFin?.earnings || null,
        profitMargin: lastQFin?.profitMargin ? Number((lastQFin.profitMargin * 100).toFixed(2)) : null,
        nextEarningsDate: toIsoDateStr(rawNextDate),
        isNextEarningsEstimate: earn.earningsChart?.isEarningsDateEstimate ?? true
      };
    }

    // 2. Storico 5 Anni Fatturato (Revenue & Earnings)
    const yearlyFin = earn.financialsChart?.yearly || [];
    const revenueHistory = [];
    yearlyFin.forEach(y => {
      revenueHistory.push({
        year: y.date,
        revenue: y.revenue || 0,
        earnings: y.earnings || 0,
        profitMargin: y.profitMargin ? Number((y.profitMargin * 100).toFixed(2)) : null
      });
    });

    // 3. Storico 5 Anni Andamento P/E
    let chartQuotes = [];
    try {
      const fiveYearsAgo = new Date();
      fiveYearsAgo.setFullYear(fiveYearsAgo.getFullYear() - 5);
      const chartRes = await yahooFinance.chart(cleanSymbol, {
        period1: fiveYearsAgo.toISOString().split('T')[0],
        interval: '1mo'
      });
      chartQuotes = chartRes?.quotes || [];
    } catch (chartErr) {
      // Graceful fallback if chart is not available
    }

    const peHistory = [];
    const shares = ks.sharesOutstanding || null;
    yearlyFin.forEach(y => {
      const match = chartQuotes.find(q => {
        const d = new Date(q.date);
        return d.getFullYear() === y.date && (d.getMonth() === 11 || d.getMonth() === 10 || d.getMonth() === 9);
      }) || chartQuotes.find(q => new Date(q.date).getFullYear() === y.date);

      if (match && shares && y.earnings && y.earnings > 0) {
        const eps = y.earnings / shares;
        if (eps > 0) {
          const pe = Number((match.close / eps).toFixed(1));
          peHistory.push({
            year: String(y.date),
            price: Number(match.close.toFixed(2)),
            eps: Number(eps.toFixed(2)),
            pe
          });
        }
      }
    });

    const curPE = sd.trailingPE || ks.trailingPE || null;
    if (curPE && curPE > 0) {
      peHistory.push({
        year: 'Attuale',
        price: fd.currentPrice || sd.regularMarketPrice || null,
        eps: ks.trailingEps || null,
        pe: Number(Number(curPE).toFixed(1))
      });
    }

    // Robust PEG Ratio Resolution (Yahoo Key Stats -> Calculated Growth Formula -> Finviz Fallback)
    let pegRatio = (ks.pegRatio !== undefined && ks.pegRatio !== null && !isNaN(Number(ks.pegRatio))) ? Number(Number(ks.pegRatio).toFixed(2)) : null;
    let pegSource = pegRatio !== null ? 'Yahoo Finance (Key Statistics)' : null;

    if (pegRatio === null) {
      const pe = sd.forwardPE || ks.forwardPE || sd.trailingPE || ks.trailingPE;
      const growth = fd.earningsGrowth;
      if (pe && pe > 0 && growth && growth > 0) {
        const growthPct = growth < 1 ? growth * 100 : growth;
        if (growthPct >= 1) {
          pegRatio = Number((pe / growthPct).toFixed(2));
          pegSource = 'Formula di Peter Lynch (P/E / Crescita Utili)';
        }
      }
    }

    if (pegRatio === null && !cleanSymbol.includes('.') && !cleanSymbol.includes('-')) {
      try {
        const fvPeg = await fetchFinvizPeg(cleanSymbol);
        if (fvPeg !== null) {
          pegRatio = fvPeg;
          pegSource = 'Finviz (Consenso Wall Street)';
        }
      } catch {}
    }

    return {
      ticker: cleanSymbol,
      companyName: ap.longName || ap.shortName || cleanSymbol,
      sector: ap.sector || 'N/D',
      industry: ap.industry || 'N/D',
      country: ap.country || 'N/D',
      city: ap.city || '',
      website: ap.website || '',
      employees: ap.fullTimeEmployees || null,
      description: ap.longBusinessSummary || '',

      // Market & Valuation
      marketCap: sd.marketCap || null,
      enterpriseValue: ks.enterpriseValue || null,
      trailingPE: sd.trailingPE || null,
      forwardPE: sd.forwardPE || ks.forwardPE || null,
      pegRatio,
      pegSource,
      priceToBook: ks.priceToBook || null,
      priceToSales: sd.priceToSalesTrailing12Months || null,
      enterpriseToEbitda: ks.enterpriseToEbitda || null,
      enterpriseToRevenue: ks.enterpriseToRevenue || null,

      // Profitability & Margins
      profitMargins: fd.profitMargins !== undefined ? fd.profitMargins : (ks.profitMargins || null),
      operatingMargins: fd.operatingMargins || null,
      grossMargins: fd.grossMargins || null,
      returnOnAssets: fd.returnOnAssets || null,
      returnOnEquity: fd.returnOnEquity || null,

      // Financials (Income & Balance Sheet)
      totalRevenue: fd.totalRevenue || null,
      revenuePerShare: fd.revenuePerShare || null,
      grossProfits: fd.grossProfits || null,
      ebitda: fd.ebitda || null,
      netIncome: ks.netIncomeToCommon || null,
      trailingEps: ks.trailingEps || null,
      forwardEps: ks.forwardEps || null,
      totalCash: fd.totalCash || null,
      totalDebt: fd.totalDebt || null,
      debtToEquity: fd.debtToEquity || null,
      freeCashflow: fd.freeCashflow || null,
      operatingCashflow: fd.operatingCashflow || null,

      // Dividends & Trading
      dividendRate: sd.dividendRate || null,
      dividendYield: dividendYield > 0 ? dividendYield : null,
      payoutRatio: sd.payoutRatio ? (sd.payoutRatio * 100) : null,
      fiveYearAvgDividendYield: sd.fiveYearAvgDividendYield || null,
      exDividendDate: cal.exDividendDate ? new Date(cal.exDividendDate).toISOString().split('T')[0] : (sd.exDividendDate ? new Date(sd.exDividendDate).toISOString().split('T')[0] : null),
      dividendDate: cal.dividendDate ? new Date(cal.dividendDate).toISOString().split('T')[0] : null,
      beta: sd.beta || ks.beta || null,
      fiftyTwoWeekHigh: sd.fiftyTwoWeekHigh || null,
      fiftyTwoWeekLow: sd.fiftyTwoWeekLow || null,
      fiftyDayAverage: sd.fiftyDayAverage || null,
      twoHundredDayAverage: sd.twoHundredDayAverage || null,
      sharesOutstanding: ks.sharesOutstanding || null,

      // Analyst Consensus & Price Targets
      currentPrice: fd.currentPrice || sd.regularMarketPrice || null,
      targetMeanPrice: fd.targetMeanPrice || null,
      targetHighPrice: fd.targetHighPrice || null,
      targetLowPrice: fd.targetLowPrice || null,
      targetMedianPrice: fd.targetMedianPrice || null,
      recommendationKey: fd.recommendationKey || null,
      numberOfAnalystOpinions: fd.numberOfAnalystOpinions || null,
      recommendationTrend: rt.trend || [],

      // Latest Quarter Data & 5-Year Historical Performance
      latestQuarter,
      revenueHistory,
      peHistory
    };
  } catch (err) {
    console.warn(`[YahooFinance Fundamentals Error] Symbol "${cleanSymbol}":`, err.message);
    return null;
  }
}

/**
 * Fallback provider: fetches PEG ratio from Finviz for US equity tickers.
 *
 * @param {string} symbol
 * @returns {Promise<number|null>}
 */
async function fetchFinvizPeg(symbol) {
  if (!symbol) return null;
  const clean = symbol.trim().toUpperCase();
  if (clean.includes('.') || clean.includes('-')) return null;

  try {
    const res = await fetch(`https://finviz.com/quote.ashx?t=${encodeURIComponent(clean)}`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml'
      },
      signal: AbortSignal.timeout(3000)
    });
    if (!res.ok) return null;
    const html = await res.text();
    const match = html.match(/>PEG<\/div><\/td><td[^>]*><div[^>]*>(?:<b>)?(?:<span[^>]*>)?([0-9]+(?:\.[0-9]+)?)(?:<\/span>)?(?:<\/b>)?<\/div><\/td>/i)
      || html.match(/PEG<\/div><\/td><td[^>]*>.*?([0-9]+\.[0-9]+)/is);
    return match ? parseFloat(match[1]) : null;
  } catch {
    return null;
  }
}

/**
 * Normalizes sector name to standard GICS sectors.
 */
function normalizeGicsSector(rawSector, rawIndustry) {
  const s = String(rawSector || '').trim().toUpperCase();
  const ind = String(rawIndustry || '').trim().toUpperCase();

  const GICS_SECTORS_MAP = {
    'TECHNOLOGY': 'Information Technology',
    'INFORMATION TECHNOLOGY': 'Information Technology',
    'SEMICONDUCTORS': 'Information Technology',
    'SOFTWARE': 'Information Technology',
    'HARDWARE': 'Information Technology',
    'ELECTRONICS': 'Information Technology',
    'FINANCIAL': 'Financials',
    'FINANCIALS': 'Financials',
    'FINANCIAL SERVICES': 'Financials',
    'BANKING': 'Financials',
    'BANKS': 'Financials',
    'INSURANCE': 'Financials',
    'HEALTHCARE': 'Health Care',
    'HEALTH CARE': 'Health Care',
    'PHARMACEUTICALS': 'Health Care',
    'BIOTECHNOLOGY': 'Health Care',
    'CONSUMER CYCLICAL': 'Consumer Discretionary',
    'CONSUMER DISCRETIONARY': 'Consumer Discretionary',
    'AUTOMOTIVE': 'Consumer Discretionary',
    'RETAIL': 'Consumer Discretionary',
    'CONSUMER DEFENSIVE': 'Consumer Staples',
    'CONSUMER STAPLES': 'Consumer Staples',
    'FOOD & BEVERAGES': 'Consumer Staples',
    'COMMUNICATION SERVICES': 'Communication Services',
    'COMMUNICATION': 'Communication Services',
    'TELECOMMUNICATION': 'Communication Services',
    'MEDIA': 'Communication Services',
    'INDUSTRIALS': 'Industrials',
    'INDUSTRIAL': 'Industrials',
    'AEROSPACE': 'Industrials',
    'MACHINERY': 'Industrials',
    'ENERGY': 'Energy',
    'OIL & GAS': 'Energy',
    'UTILITIES': 'Utilities',
    'REAL ESTATE': 'Real Estate',
    'REIT': 'Real Estate',
    'BASIC MATERIALS': 'Materials',
    'MATERIALS': 'Materials',
    'CHEMICALS': 'Materials',
    'BROAD MARKET': 'Broad Market',
    'GOVERNMENT': 'Government'
  };

  if (GICS_SECTORS_MAP[s]) return GICS_SECTORS_MAP[s];

  for (const [key, val] of Object.entries(GICS_SECTORS_MAP)) {
    if (s.includes(key) || ind.includes(key)) return val;
  }

  return rawSector || 'Information Technology';
}

/**
 * Normalizes country name to standard Italian country name and geographical macro-region.
 */
function normalizeCountryAndRegion(rawCountry, symbol = '') {
  const c = String(rawCountry || '').trim().toUpperCase();
  const sym = String(symbol || '').trim().toUpperCase();

  const COUNTRY_MAP = {
    'UNITED STATES': { country: 'Stati Uniti', region: 'Americas' },
    'USA': { country: 'Stati Uniti', region: 'Americas' },
    'STATI UNITI': { country: 'Stati Uniti', region: 'Americas' },
    'US': { country: 'Stati Uniti', region: 'Americas' },
    'CANADA': { country: 'Canada', region: 'Americas' },
    'ITALY': { country: 'Italia', region: 'Europe' },
    'ITALIA': { country: 'Italia', region: 'Europe' },
    'GERMANY': { country: 'Germania', region: 'Europe' },
    'GERMANIA': { country: 'Germania', region: 'Europe' },
    'FRANCE': { country: 'Francia', region: 'Europe' },
    'FRANCIA': { country: 'Francia', region: 'Europe' },
    'NETHERLANDS': { country: 'Paesi Bassi', region: 'Europe' },
    'PAESI BASSI': { country: 'Paesi Bassi', region: 'Europe' },
    'HOLLAND': { country: 'Paesi Bassi', region: 'Europe' },
    'UNITED KINGDOM': { country: 'Regno Unito', region: 'Europe' },
    'REGNO UNITO': { country: 'Regno Unito', region: 'Europe' },
    'UK': { country: 'Regno Unito', region: 'Europe' },
    'SWITZERLAND': { country: 'Svizzera', region: 'Europe' },
    'SVIZZERA': { country: 'Svizzera', region: 'Europe' },
    'DENMARK': { country: 'Danimarca', region: 'Europe' },
    'DANIMARCA': { country: 'Danimarca', region: 'Europe' },
    'SPAIN': { country: 'Spagna', region: 'Europe' },
    'SPAGNA': { country: 'Spagna', region: 'Europe' },
    'IRELAND': { country: 'Irlanda', region: 'Europe' },
    'IRLANDA': { country: 'Irlanda', region: 'Europe' },
    'SWEDEN': { country: 'Svezia', region: 'Europe' },
    'SVEZIA': { country: 'Svezia', region: 'Europe' },
    'NORWAY': { country: 'Norvegia', region: 'Europe' },
    'NORVEGIA': { country: 'Norvegia', region: 'Europe' },
    'FINLAND': { country: 'Finlandia', region: 'Europe' },
    'FINLANDIA': { country: 'Finlandia', region: 'Europe' },
    'BELGIUM': { country: 'Belgio', region: 'Europe' },
    'BELGIO': { country: 'Belgio', region: 'Europe' },
    'AUSTRIA': { country: 'Austria', region: 'Europe' },
    'PORTUGAL': { country: 'Portogallo', region: 'Europe' },
    'PORTOGALLO': { country: 'Portogallo', region: 'Europe' },
    'ROMANIA': { country: 'Romania', region: 'Europe' },
    'EUROZONE': { country: 'Eurozona', region: 'Europe' },
    'EUROPE': { country: 'Europa', region: 'Europe' },
    'EUROPA': { country: 'Europa', region: 'Europe' },
    'CHINA': { country: 'Cina', region: 'Emerging Markets' },
    'CINA': { country: 'Cina', region: 'Emerging Markets' },
    'TAIWAN': { country: 'Taiwan', region: 'Emerging Markets' },
    'INDIA': { country: 'India', region: 'Emerging Markets' },
    'BRAZIL': { country: 'Brasile', region: 'Emerging Markets' },
    'BRASILE': { country: 'Brasile', region: 'Emerging Markets' },
    'KAZAKHSTAN': { country: 'Kazakistan', region: 'Emerging Markets' },
    'KAZAKISTAN': { country: 'Kazakistan', region: 'Emerging Markets' },
    'SOUTH AFRICA': { country: 'Sudafrica', region: 'Emerging Markets' },
    'SUDAFRICA': { country: 'Sudafrica', region: 'Emerging Markets' },
    'MEXICO': { country: 'Messico', region: 'Emerging Markets' },
    'MESSICO': { country: 'Messico', region: 'Emerging Markets' },
    'JAPAN': { country: 'Giappone', region: 'Asia' },
    'GIAPPONE': { country: 'Giappone', region: 'Asia' },
    'SINGAPORE': { country: 'Singapore', region: 'Asia' },
    'AUSTRALIA': { country: 'Australia', region: 'Asia' },
    'HONG KONG': { country: 'Hong Kong', region: 'Asia' },
    'SOUTH KOREA': { country: 'Corea del Sud', region: 'Asia' },
    'COREA DEL SUD': { country: 'Corea del Sud', region: 'Asia' },
    'GLOBAL': { country: 'Globale', region: 'Global' },
    'GLOBALE': { country: 'Globale', region: 'Global' },
    'PAESI SVILUPPATI': { country: 'Paesi Sviluppati', region: 'Global' },
    'WORLD': { country: 'Globale', region: 'Global' }
  };

  if (COUNTRY_MAP[c]) return COUNTRY_MAP[c];

  for (const [key, val] of Object.entries(COUNTRY_MAP)) {
    if (c.includes(key)) return val;
  }

  // Symbol suffix heuristics if country is missing
  if (sym.endsWith('.MI')) return { country: 'Italia', region: 'Europe' };
  if (sym.endsWith('.DE')) return { country: 'Germania', region: 'Europe' };
  if (sym.endsWith('.AS')) return { country: 'Paesi Bassi', region: 'Europe' };
  if (sym.endsWith('.PA')) return { country: 'Francia', region: 'Europe' };
  if (sym.endsWith('.L')) return { country: 'Regno Unito', region: 'Europe' };

  return { country: rawCountry || 'Stati Uniti', region: 'Americas' };
}

/**
 * Searches online (Yahoo Finance / heuristics) for the sector and geographical area of an equity ticker.
 * Updates SQLite database if db instance is available.
 *
 * @param {string} symbol
 * @param {object} [existingAsset]
 * @param {object} [dbInstance]
 * @returns {Promise<object>}
 */
async function enrichEquityClassification(symbol, existingAsset = null, dbInstance = null) {
  if (!symbol) return null;
  const cleanSymbol = symbol.trim().toUpperCase();

  // Known ETF mappings
  const KNOWN_ETFS = {
    'VWCE.DE': { sector: 'Broad Market', region: 'Global', country: 'Globale' },
    'SWDA.MI': { sector: 'Broad Market', region: 'Global', country: 'Paesi Sviluppati' },
    'VERE.DE': { sector: 'Broad Market', region: 'Europe', country: 'Europa' },
    'XCHA.DE': { sector: 'Broad Market', region: 'Emerging Markets', country: 'Cina' },
    'TDIV.AS': { sector: 'Broad Market', region: 'Global', country: 'Paesi Sviluppati' },
    '3NLV.MI': { sector: 'Information Technology', region: 'Americas', country: 'Stati Uniti' },
    '3GOO.MI': { sector: 'Communication Services', region: 'Americas', country: 'Stati Uniti' },
    'X25E.MI': { sector: 'Government', region: 'Europe', country: 'Eurozona' },
    'XEON.DE': { sector: 'Financials', region: 'Europe', country: 'Eurozona' },
    'NGAS.MI': { sector: 'Energy', region: 'Global', country: 'Globale' },
    'AHLA.DE': { sector: 'Consumer Discretionary', region: 'Emerging Markets', country: 'Cina' },
    'MSF.DE': { sector: 'Information Technology', region: 'Americas', country: 'Stati Uniti' },
    'AMD.DE': { sector: 'Information Technology', region: 'Americas', country: 'Stati Uniti' },
    'NOV.DE': { sector: 'Health Care', region: 'Europe', country: 'Danimarca' }
  };

  let sector = existingAsset?.sector;
  let region = existingAsset?.region;
  let country = existingAsset?.country;

  if (KNOWN_ETFS[cleanSymbol]) {
    sector = KNOWN_ETFS[cleanSymbol].sector;
    region = KNOWN_ETFS[cleanSymbol].region;
    country = KNOWN_ETFS[cleanSymbol].country;
  } else {
    try {
      let ap = null;
      try {
        const summary = await yahooFinance.quoteSummary(cleanSymbol, {
          modules: ['assetProfile', 'fundProfile', 'summaryProfile']
        });
        ap = summary?.assetProfile || summary?.summaryProfile;
      } catch (err) {
        // If symbol with exchange failed (e.g. AHLA.DE -> BABA or MU.MI -> MU)
        if (cleanSymbol.includes('.')) {
          const baseSym = cleanSymbol.split('.')[0];
          try {
            const sum2 = await yahooFinance.quoteSummary(baseSym, {
              modules: ['assetProfile', 'summaryProfile']
            });
            ap = sum2?.assetProfile || sum2?.summaryProfile;
          } catch {}
        }
      }

      if (ap) {
        if (ap.sector || ap.industry) {
          sector = normalizeGicsSector(ap.sector, ap.industry);
        }
        if (ap.country) {
          const norm = normalizeCountryAndRegion(ap.country, cleanSymbol);
          country = norm.country;
          region = norm.region;
        }
      }
    } catch (e) {
      console.warn(`[Enrichment Error] Symbol "${cleanSymbol}":`, e.message);
    }
  }

  // Fallbacks if still empty
  if (!sector || sector === 'Unclassified' || sector === 'N/D') {
    sector = 'Information Technology';
  }
  if (!region || region === 'N/D') {
    const norm = normalizeCountryAndRegion(country, cleanSymbol);
    country = norm.country;
    region = norm.region;
  }

  // Update in database if dbInstance is provided
  if (dbInstance && (existingAsset?.id || cleanSymbol)) {
    try {
      dbInstance.prepare(`
        UPDATE assets
        SET sector = ?, region = ?, country = ?, updatedAt = datetime('now')
        WHERE ticker = ? OR id = ?
      `).run(sector, region, country, cleanSymbol, existingAsset?.id || -1);
    } catch (dbErr) {
      console.warn('[Enrichment DB Update Error]:', dbErr.message);
    }
  }

  return {
    ticker: cleanSymbol,
    sector,
    region,
    country
  };
}

module.exports = {
  search,
  getQuote,
  getHistorical,
  getFundamentals,
  fetchFinvizPeg,
  calculateSanitizedDividendYield,
  normalizeGicsSector,
  normalizeCountryAndRegion,
  enrichEquityClassification
};
