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
    const changePercent = Number(q.regularMarketChangePercent) || 0.0;

    let dividendYield = 0.0;
    if (q.dividendYield !== undefined && q.dividendYield !== null) {
      // Yahoo sometimes returns decimal (e.g. 0.015) or percentage (1.5)
      dividendYield = q.dividendYield < 0.2 ? q.dividendYield * 100 : q.dividendYield;
    }

    return {
      ticker: cleanSymbol,
      name: q.shortName || q.longName || cleanSymbol,
      type: mapQuoteType(q.quoteType),
      currentPrice: price,
      changeValue: change,
      changePercent,
      openPrice: Number(q.regularMarketOpen) || price,
      highPrice: Number(q.regularMarketDayHigh) || price,
      lowPrice: Number(q.regularMarketDayLow) || price,
      previousClose: Number(q.regularMarketPreviousClose) || (price - change),
      pe: q.trailingPE || null,
      forwardPE: q.forwardPE || null,
      eps: q.epsTrailingTwelveMonths || null,
      dividendYield,
      currency: q.currency || 'EUR',
      exchange: q.exchange || '',
      quoteDate: q.regularMarketTime
        ? new Date(q.regularMarketTime).toISOString().split('T')[0]
        : new Date().toISOString().split('T')[0],
      marketState: q.marketState || null,
      regularMarketTime: q.regularMarketTime
        ? (q.regularMarketTime instanceof Date
            ? q.regularMarketTime.toISOString()
            : new Date(Number(q.regularMarketTime) * (Number(q.regularMarketTime) < 1e11 ? 1000 : 1)).toISOString())
        : null,
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

module.exports = {
  search,
  getQuote,
  getHistorical
};
