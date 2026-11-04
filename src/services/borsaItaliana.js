const BORSA_ITALIANA_BEARER =
  'eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJzdWIiOiItMSIsImV4cCI6NDkwNTU4MzU3MiwiaWF0IjoxNzUxOTgzNTcyLCJhdXRob3JpdGllcyI6W119.d7Eh_LOGqA44BH58HIiPrPIz1SLskVOPj4BRsae05cI';

const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/**
 * Checks if a string conforms to the 12-character international ISIN format.
 *
 * @param {string} code
 * @returns {boolean}
 */
function isIsin(code) {
  if (!code || typeof code !== 'string') return false;
  return /^[A-Z]{2}[A-Z0-9]{9}[0-9]$/i.test(code.trim());
}

/**
 * Parses Italian number format (e.g. '101,45' or '1.050,20') to Javascript float.
 *
 * @param {string} str
 * @returns {number}
 */
function parseItalianNumber(str) {
  if (!str) return 0.0;
  const clean = String(str).trim().replace(/\./g, '').replace(',', '.');
  const num = parseFloat(clean);
  return isNaN(num) ? 0.0 : num;
}

/**
 * Scrapes realtime price of an ISIN from Borsa Italiana website.
 *
 * @param {string} isin
 * @returns {Promise<object|null>}
 */
async function fetchRealtimeQuote(isin) {
  if (!isIsin(isin)) return null;
  const cleanIsin = isin.trim().toUpperCase();

  const url = `https://www.borsaitaliana.it/borsa/search/scheda.html?code=${encodeURIComponent(cleanIsin)}&lang=it`;

  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': DEFAULT_USER_AGENT,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7'
      }
    });

    if (!res.ok) {
      return null;
    }

    const html = await res.text();

    // Target selector: span.-formatPrice strong
    const priceMatch =
      html.match(/<span[^>]*class=\"[^\"]*-formatPrice[^\"]*\"[^>]*>\s*<strong>([^<]+)<\/strong>/i) ||
      html.match(/<span[^>]*class=\"-formatPrice\"[^>]*>\s*<strong>([^<]+)<\/strong>/i) ||
      html.match(/-formatPrice[^>]*>\s*<strong[^>]*>([0-9.,]+)<\/strong>/i);

    if (!priceMatch) {
      return null;
    }

    const currentPrice = parseItalianNumber(priceMatch[1]);
    if (currentPrice <= 0) return null;

    // Optional percent change extraction
    let changePercent = 0.0;
    const pctMatch = html.match(/-formatPercent[^>]*>\s*<strong[^>]*>([+-]?[0-9.,]+)%?<\/strong>/i);
    if (pctMatch) {
      changePercent = parseItalianNumber(pctMatch[1]);
    }

    // Optional instrument title extraction
    let name = cleanIsin;
    const titleMatch = html.match(/<h1[^>]*class=\"[^\"]*t-text[^\"]*\"[^>]*>([^<]+)<\/h1>/i);
    if (titleMatch && titleMatch[1]) {
      name = titleMatch[1].trim();
    }

    // Identify if BTP/Bond or ETF
    const isBtp = cleanIsin.startsWith('IT000') || /btp|cct|bot|bond|obbligazion/i.test(name);
    const type = isBtp ? 'BOND' : 'ETF';

    return {
      ticker: cleanIsin,
      name,
      type,
      currentPrice,
      changePercent,
      changeValue: 0.0,
      currency: 'EUR',
      exchange: 'Borsa Italiana',
      quoteDate: new Date().toISOString().split('T')[0],
      source: 'BORSA_ITALIANA'
    };
  } catch (err) {
    console.warn(`[BorsaItaliana Scraping Error] ISIN "${cleanIsin}":`, err.message);
    return null;
  }
}

/**
 * Fetches historical quote series for BTP, MOT bonds, and Italian ETFs from the internal REST API.
 *
 * @param {string} isin
 * @param {string} [period='5Y'] - e.g. '1M', '3M', '6M', '1Y', '5Y'
 * @returns {Promise<Array<{ date: string, close: number, volume: number, source: string }>>}
 */
async function fetchHistorical(isin, period = '5Y') {
  if (!isIsin(isin)) return [];
  const cleanIsin = isin.trim().toUpperCase();

  const url = `https://grafici.borsaitaliana.it/api/instruments/${cleanIsin},XMIL,ISIN/history/period?period=${encodeURIComponent(period)}&adjustment=true&add-last-price=true`;

  try {
    const res = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${BORSA_ITALIANA_BEARER}`,
        'User-Agent': DEFAULT_USER_AGENT,
        'Accept': 'application/json'
      }
    });

    if (!res.ok) {
      return [];
    }

    const data = await res.json();
    if (!data) return [];

    // The series is in data.history.historyDt or directly data.historyDt
    const historyList = (data.history && data.history.historyDt) || data.historyDt || [];

    return historyList
      .filter(item => item && item.dt && item.closePx !== undefined)
      .map(item => {
        // dt is formatted as YYYYMMDD (e.g. '20240315')
        const dtStr = String(item.dt);
        const year = dtStr.substring(0, 4);
        const month = dtStr.substring(4, 6);
        const day = dtStr.substring(6, 8);
        const formattedDate = `${year}-${month}-${day}`;

        return {
          date: formattedDate,
          open: Number(item.openPx) || Number(item.closePx),
          high: Number(item.highPx) || Number(item.closePx),
          low: Number(item.lowPx) || Number(item.closePx),
          close: Number(item.closePx),
          volume: Number(item.qty) || 0,
          source: 'BORSA_ITALIANA'
        };
      });
  } catch (err) {
    console.warn(`[BorsaItaliana Historical Error] ISIN "${cleanIsin}":`, err.message);
    return [];
  }
}

module.exports = {
  isIsin,
  parseItalianNumber,
  fetchRealtimeQuote,
  fetchHistorical,
  BORSA_ITALIANA_BEARER
};

