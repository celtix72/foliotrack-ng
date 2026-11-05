const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

/**
 * Normalizes a ticker into a Google Finance query format (e.g. AAPL:NASDAQ, SWDA:BIT).
 *
 * @param {string} ticker
 * @param {string} [exchange]
 * @returns {string}
 */
function formatGoogleQuery(ticker, exchange) {
  if (!ticker) return '';
  const clean = ticker.trim().toUpperCase();

  if (clean.includes(':')) {
    return clean;
  }

  // Handle common suffix patterns
  if (clean.endsWith('.MI')) {
    return `${clean.replace('.MI', '')}:BIT`;
  }
  if (clean.endsWith('.DE')) {
    return `${clean.replace('.DE', '')}:ETR`;
  }
  if (clean.endsWith('.PA')) {
    return `${clean.replace('.PA', '')}:EPA`;
  }
  if (clean.endsWith('.L')) {
    return `${clean.replace('.L', '')}:LON`;
  }

  if (exchange) {
    return `${clean}:${exchange.trim().toUpperCase()}`;
  }

  return clean;
}

/**
 * Cleans and converts currency strings (e.g. '$337.32', '€ 104,50') to number.
 *
 * @param {string} rawPrice
 * @returns {{ price: number, currency: string }}
 */
function parsePriceAndCurrency(rawPrice) {
  if (!rawPrice) return { price: 0.0, currency: 'USD' };

  let currency = 'USD';
  if (rawPrice.includes('€')) currency = 'EUR';
  else if (rawPrice.includes('$')) currency = 'USD';
  else if (rawPrice.includes('£')) currency = 'GBP';
  else if (rawPrice.includes('CHF')) currency = 'CHF';

  const cleanNumStr = rawPrice.replace(/[^0-9.,]/g, '').trim();

  // If both . and , are present (e.g. 1,234.56 or 1.234,56)
  let normalized = cleanNumStr;
  if (cleanNumStr.includes(',') && cleanNumStr.includes('.')) {
    if (cleanNumStr.indexOf(',') < cleanNumStr.indexOf('.')) {
      // 1,234.56
      normalized = cleanNumStr.replace(/,/g, '');
    } else {
      // 1.234,56
      normalized = cleanNumStr.replace(/\./g, '').replace(',', '.');
    }
  } else if (cleanNumStr.includes(',')) {
    // 104,50
    normalized = cleanNumStr.replace(',', '.');
  }

  const price = parseFloat(normalized);
  return {
    price: isNaN(price) ? 0.0 : price,
    currency
  };
}

/**
 * Scrapes real-time quote for a symbol from Google Finance as fallback.
 *
 * @param {string} ticker
 * @param {string} [exchange]
 * @returns {Promise<object|null>}
 */
async function fetchQuote(ticker, exchange) {
  if (!ticker) return null;
  const query = formatGoogleQuery(ticker, exchange);

  const url = `https://www.google.com/finance/quote/${encodeURIComponent(query)}`;

  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': DEFAULT_USER_AGENT,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9'
      }
    });

    if (!res.ok) {
      return null;
    }

    const html = await res.text();

    // Check title to verify if page exists
    const titleMatch = html.match(/<title>([^<]+)<\/title>/i);
    if (!titleMatch || /unsupported|error|404/i.test(titleMatch[1])) {
      return null;
    }

    // Name extraction
    let name = ticker;
    const nameMatch = html.match(/class=\"gO24Ff\"[^>]*>([^<]+)<\/div>/i);
    if (nameMatch && nameMatch[1]) {
      name = nameMatch[1].trim();
    }

    // Price extraction: try primary header class selectors
    const mainPriceMatch =
      html.match(/class=\"N6SYTe\"[^>]*>.*?<span>([$€£¥]?[0-9.,]+)<\/span>/is) ||
      html.match(/class=\"ujg0He\"[^>]*>.*?<span>([$€£¥]?[0-9.,]+)<\/span>/is) ||
      html.match(/class=\"[^\"]*YMlKec[^\"]*fxKbKc[^\"]*\"[^>]*>([$€£¥]?[0-9.,]+)</i);

    if (!mainPriceMatch || !mainPriceMatch[1]) {
      return null;
    }

    const { price, currency } = parsePriceAndCurrency(mainPriceMatch[1]);
    if (price <= 0) return null;

    // Percent and value change extraction
    let changePercent = 0.0;
    const pctMatch = html.match(/class=\"ymyBi\"[^>]*>([+-]?[0-9.,]+)%?<\/span>/i);
    if (pctMatch && pctMatch[1]) {
      const cleanPct = pctMatch[1].replace('%', '').replace(',', '.').trim();
      changePercent = parseFloat(cleanPct) || 0.0;
    }

    const changeValue = changePercent !== 0 ? (price - (price / (1 + changePercent / 100))) : 0.0;
    const previousClose = price - changeValue;

    let todayDateStr = '';
    try {
      todayDateStr = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome' }).format(new Date());
    } catch {
      todayDateStr = new Date().toISOString().split('T')[0];
    }

    return {
      ticker: ticker.toUpperCase().trim(),
      name,
      currentPrice: price,
      changePercent,
      changeValue,
      previousClose,
      currency,
      exchange: exchange || 'Google Finance',
      quoteDate: todayDateStr,
      source: 'GOOGLE'
    };
  } catch (err) {
    console.warn(`[GoogleFinance Scraping Error] Query "${query}":`, err.message);
    return null;
  }
}

module.exports = {
  fetchQuote,
  formatGoogleQuery,
  parsePriceAndCurrency
};

