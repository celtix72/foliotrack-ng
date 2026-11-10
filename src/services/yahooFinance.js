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
        type: mapQuoteType(q.quoteType),
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

    let dividendYield = 0.0;
    if (q.dividendYield !== undefined && q.dividendYield !== null) {
      // Yahoo sometimes returns decimal (e.g. 0.015) or percentage (1.5)
      dividendYield = q.dividendYield < 0.2 ? q.dividendYield * 100 : q.dividendYield;
    }

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
      currency: q.currency || 'EUR',
      exchange: q.exchange || '',
      quoteDate: quoteDateStr || todayStr,
      marketState: q.marketState || null,
      regularMarketTime: regularMarketTimeIso,
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
    if (sd.dividendYield !== undefined && sd.dividendYield !== null) {
      dividendYield = sd.dividendYield < 0.2 ? sd.dividendYield * 100 : sd.dividendYield;
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
      const nextEarningsDate = nextEarningsDates.length ? nextEarningsDates[0] : null;

      latestQuarter = {
        quarter: lastQEarnings?.date || lastQFin?.date || 'N/D',
        fiscalQuarter: lastQEarnings?.fiscalQuarter || lastQFin?.fiscalQuarter || null,
        periodEndDate: lastQEarnings?.periodEndDate || null,
        reportedDate: lastQEarnings?.reportedDate || null,
        epsActual,
        epsEstimate,
        epsDifference: lastQEarnings?.difference !== undefined ? Number(lastQEarnings.difference) : (epsActual !== null && epsEstimate !== null ? Number((epsActual - epsEstimate).toFixed(3)) : null),
        surprisePercent: surprisePct,
        revenue: lastQFin?.revenue || null,
        earnings: lastQFin?.earnings || null,
        profitMargin: lastQFin?.profitMargin ? Number((lastQFin.profitMargin * 100).toFixed(2)) : null,
        nextEarningsDate,
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

module.exports = {
  search,
  getQuote,
  getHistorical,
  getFundamentals,
  fetchFinvizPeg
};
