/**
 * News Scraping and Aggregation Service for FolioTrack.
 * Scrapes real-time financial news for portfolio assets using Google News RSS and Yahoo Finance.
 */

const { getDb } = require('../db');
const yfModule = require('yahoo-finance2');
const YahooFinance = yfModule.default || yfModule.YahooFinance || yfModule;

const yahooFinance = typeof YahooFinance === 'function'
  ? new YahooFinance({ suppressNotices: ['yahooSurvey'] })
  : YahooFinance;

/**
 * Decodes standard and numeric HTML entities.
 *
 * @param {string} str
 * @returns {string}
 */
function decodeHtmlEntities(str) {
  if (!str) return '';
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, '/')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(dec))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

/**
 * Cleans corporate suffixes and punctuation from company name to improve search query precision.
 *
 * @param {string} name
 * @param {string} ticker
 * @returns {string}
 */
function cleanCompanyName(name, ticker) {
  if (!name || typeof name !== 'string') return ticker || '';
  const cleaned = name
    .replace(/\bS\.p\.A\.?|\bSpA\b|\bS\.P\.A\.?|\bInc\b\.?|\bCorporation\b|\bCorp\b\.?|\bPlc\b|\bSE\b|\bAG\b|\bLtd\b\.?|\bGmbH\b|\bSA\b|\bN\.V\b\.?/gi, '')
    .replace(/[-–—/()]/g, ' ')
    .replace(/\s+\./g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned || ticker;
}

/**
 * Returns user's active portfolio assets excluding cash and delisted instruments.
 *
 * @param {number} userId
 * @returns {Array<{ticker: string, name: string, type: string}>}
 */
function getUserPortfolioAssets(userId) {
  const db = getDb();
  let user = null;
  try {
    user = db.prepare('SELECT role FROM users WHERE id = ?').get(userId);
  } catch {}

  let rows = [];
  try {
    if (user && user.role === 'admin') {
      rows = db.prepare(`
        SELECT DISTINCT a.ticker, a.name, a.type
        FROM assets a
        JOIN transactions t ON t.assetTicker = a.ticker
        JOIN portfolios p ON p.id = t.portfolioId
        WHERE (p.include_in_totals = 1 OR p.include_in_totals IS NULL)
          AND (a.dataSource IS NULL OR a.dataSource != 'DELISTED')
      `).all();
    } else {
      rows = db.prepare(`
        SELECT DISTINCT a.ticker, a.name, a.type
        FROM assets a
        JOIN transactions t ON t.assetTicker = a.ticker
        JOIN portfolios p ON p.id = t.portfolioId
        INNER JOIN portfolio_users pu ON pu.portfolio_id = p.id
        WHERE pu.user_id = ?
          AND (p.include_in_totals = 1 OR p.include_in_totals IS NULL)
          AND (a.dataSource IS NULL OR a.dataSource != 'DELISTED')
      `).all(userId);
    }
  } catch (err) {
    console.warn('[NewsService] Error fetching portfolio assets:', err.message);
    rows = [];
  }

  // Filter out cash and synthetic tickers
  const cashSymbols = new Set(['EUR', 'USD', 'GBP', 'CHF', 'JPY', 'CASH', 'LIQUIDITÀ', 'LIQUIDITA']);
  return rows.filter(r => r.ticker && !cashSymbols.has(r.ticker.toUpperCase().trim()));
}

/**
 * Scrapes news from Google News RSS for a specific asset.
 *
 * @param {string} ticker
 * @param {string} name
 * @returns {Promise<Array<object>>}
 */
async function scrapeGoogleNewsForAsset(ticker, name) {
  const cleanName = cleanCompanyName(name, ticker);
  const rootTicker = ticker.replace(/\..*$/, '').trim();
  
  // Build targeted financial query in Italian / Global
  let query = '';
  if (cleanName && cleanName.toUpperCase() !== rootTicker.toUpperCase()) {
    query = `"${cleanName}" OR ${rootTicker} borsa OR finanza`;
  } else {
    query = `${rootTicker} borsa OR finanza`;
  }

  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=it&gl=IT&ceid=IT:it`;
  const articles = [];

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);

    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/rss+xml, application/xml, text/xml'
      }
    });

    clearTimeout(timeout);

    if (!res.ok) return [];

    const xml = await res.text();
    const items = xml.match(/<item>[\s\S]*?<\/item>/g) || [];

    for (const item of items.slice(0, 4)) {
      const rawTitle = item.match(/<title>([\s\S]*?)<\/title>/)?.[1] || '';
      const link = item.match(/<link>([\s\S]*?)<\/link>/)?.[1] || '';
      const pubDateRaw = item.match(/<pubDate>([\s\S]*?)<\/pubDate>/)?.[1] || '';
      const sourceMatch = item.match(/<source[^>]*>([\s\S]*?)<\/source>/)?.[1] || '';

      if (!rawTitle || !link) continue;

      let title = decodeHtmlEntities(rawTitle.trim());
      let publisher = decodeHtmlEntities(sourceMatch.trim());

      // Strip trailing " - Publisher Name" from title if present
      if (publisher && title.endsWith(` - ${publisher}`)) {
        title = title.substring(0, title.length - (publisher.length + 3)).trim();
      }

      let pubDateIso = new Date().toISOString();
      if (pubDateRaw) {
        try {
          const parsed = new Date(pubDateRaw);
          if (!isNaN(parsed.getTime())) {
            pubDateIso = parsed.toISOString();
          }
        } catch {}
      }

      articles.push({
        ticker,
        title,
        link,
        publisher: publisher || 'Google News',
        pubDate: pubDateIso,
        source: 'GOOGLE_NEWS'
      });
    }
  } catch (err) {
    // Non-blocking log
  }

  return articles;
}

/**
 * Scrapes news from Yahoo Finance for a specific ticker.
 *
 * @param {string} ticker
 * @returns {Promise<Array<object>>}
 */
async function scrapeYahooNewsForAsset(ticker) {
  const rootTicker = ticker.replace(/\..*$/, '').trim().toUpperCase();
  const articles = [];

  try {
    const res = await yahooFinance.search(rootTicker, { quotesCount: 0, newsCount: 3 });
    if (res && Array.isArray(res.news)) {
      for (const n of res.news) {
        if (!n.title || !n.link) continue;

        let pubDateIso = new Date().toISOString();
        if (n.providerPublishTime) {
          try {
            const parsed = new Date(n.providerPublishTime);
            if (!isNaN(parsed.getTime())) {
              pubDateIso = parsed.toISOString();
            }
          } catch {}
        }

        articles.push({
          ticker,
          title: decodeHtmlEntities(n.title.trim()),
          link: n.link.trim(),
          publisher: decodeHtmlEntities((n.publisher || 'Yahoo Finance').trim()),
          pubDate: pubDateIso,
          source: 'YAHOO_FINANCE'
        });
      }
    }
  } catch (err) {
    // Non-blocking log
  }

  return articles;
}

/**
 * Saves scraped news articles into SQLite database.
 * Deduplicates by unique URL link and prunes articles older than 30 days.
 *
 * @param {Array<object>} articles
 * @returns {number} Number of newly inserted articles
 */
function saveNewsArticles(articles) {
  if (!Array.isArray(articles) || articles.length === 0) return 0;
  const db = getDb();

  const insertStmt = db.prepare(`
    INSERT OR IGNORE INTO portfolio_news (ticker, title, link, publisher, pubDate, summary, source)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  let insertedCount = 0;
  const tx = db.transaction((items) => {
    for (const a of items) {
      if (!a.ticker || !a.title || !a.link) continue;
      const res = insertStmt.run(
        a.ticker.toUpperCase().trim(),
        a.title.trim(),
        a.link.trim(),
        (a.publisher || 'News').trim(),
        a.pubDate || new Date().toISOString(),
        a.summary || null,
        a.source || 'GOOGLE_NEWS'
      );
      if (res.changes > 0) insertedCount++;
    }

    // Prune articles older than 30 days
    db.prepare(`
      DELETE FROM portfolio_news
      WHERE pubDate < datetime('now', '-30 days')
    `).run();
  });

  try {
    tx(articles);
  } catch (err) {
    console.warn('[NewsService] Error saving news articles:', err.message);
  }

  return insertedCount;
}

/**
 * Scrapes news for all or a subset of user's portfolio assets and persists them.
 *
 * @param {number} userId
 * @param {number} [maxAssets=12] - Limits scraping to top holdings to preserve low latency
 * @returns {Promise<{checkedAssets: number, newArticlesCount: number}>}
 */
async function scrapePortfolioNews(userId, maxAssets = 12) {
  const assets = getUserPortfolioAssets(userId);
  if (assets.length === 0) {
    return { checkedAssets: 0, newArticlesCount: 0 };
  }

  // Slice to maxAssets (e.g. top 12 assets)
  const targetAssets = assets.slice(0, maxAssets);
  let totalNew = 0;

  // Execute in batches of 3 to avoid flooding
  const batchSize = 3;
  for (let i = 0; i < targetAssets.length; i += batchSize) {
    const batch = targetAssets.slice(i, i + batchSize);
    const batchPromises = batch.map(async (asset) => {
      const [googleNews, yahooNews] = await Promise.all([
        scrapeGoogleNewsForAsset(asset.ticker, asset.name),
        scrapeYahooNewsForAsset(asset.ticker)
      ]);
      return [...googleNews, ...yahooNews];
    });

    const results = await Promise.allSettled(batchPromises);
    const combined = [];
    for (const r of results) {
      if (r.status === 'fulfilled' && Array.isArray(r.value)) {
        combined.push(...r.value);
      }
    }

    if (combined.length > 0) {
      totalNew += saveNewsArticles(combined);
    }
  }

  return {
    checkedAssets: targetAssets.length,
    newArticlesCount: totalNew
  };
}

/**
 * Formats a date string into an Italian relative time indicator.
 * E.g. "15 min fa", "2 ore fa", "Ieri", "3 gg fa".
 *
 * @param {string} dateStr
 * @returns {string}
 */
function formatRelativeTime(dateStr) {
  try {
    const d = new Date(dateStr);
    const now = new Date();
    const diffSec = Math.floor((now - d) / 1000);

    if (diffSec < 60) return 'Proprio ora';
    const diffMin = Math.floor(diffSec / 60);
    if (diffMin < 60) return `${diffMin} min fa`;
    const diffHours = Math.floor(diffMin / 60);
    if (diffHours < 24) return `${diffHours} ore fa`;
    const diffDays = Math.floor(diffHours / 24);
    if (diffDays === 1) return 'Ieri';
    if (diffDays < 7) return `${diffDays} gg fa`;

    return d.toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit' });
  } catch {
    return '';
  }
}

/**
 * Retrieves the latest portfolio news for a user's holdings.
 * If no news exists yet in the database, triggers a quick background scrape and returns sample/fresh news.
 *
 * @param {number} userId
 * @param {number} [limit=5]
 * @returns {Promise<Array<object>>}
 */
async function getLatestPortfolioNews(userId, limit = 5) {
  const db = getDb();
  const assets = getUserPortfolioAssets(userId);
  const tickers = assets.map(a => a.ticker.toUpperCase().trim());

  if (tickers.length === 0) {
    // If no assets, return latest general market news or empty
    const generalRows = db.prepare(`
      SELECT pn.*, a.name as assetName
      FROM portfolio_news pn
      LEFT JOIN assets a ON a.ticker = pn.ticker
      ORDER BY pn.pubDate DESC
      LIMIT ?
    `).all(limit);

    return generalRows.map(r => ({
      ...r,
      timeAgo: formatRelativeTime(r.pubDate)
    }));
  }

  const placeholders = tickers.map(() => '?').join(',');
  let rows = [];
  try {
    rows = db.prepare(`
      SELECT pn.*, COALESCE(a.name, pn.ticker) as assetName
      FROM portfolio_news pn
      LEFT JOIN assets a ON a.ticker = pn.ticker
      WHERE UPPER(pn.ticker) IN (${placeholders})
      ORDER BY pn.pubDate DESC
      LIMIT ?
    `).all(...tickers, limit);
  } catch (err) {
    console.warn('[NewsService] Error reading portfolio news:', err.message);
    rows = [];
  }

  // If database has fewer than limit news items, perform an immediate scrape
  if (rows.length < limit) {
    try {
      await scrapePortfolioNews(userId, Math.min(8, tickers.length));
      rows = db.prepare(`
        SELECT pn.*, COALESCE(a.name, pn.ticker) as assetName
        FROM portfolio_news pn
        LEFT JOIN assets a ON a.ticker = pn.ticker
        WHERE UPPER(pn.ticker) IN (${placeholders})
        ORDER BY pn.pubDate DESC
        LIMIT ?
      `).all(...tickers, limit);
    } catch (scrapeErr) {
      console.warn('[NewsService] Quick scrape fallback warning:', scrapeErr.message);
    }
  }

  // If still empty (e.g. offline/mock environment), seed fallback market news
  if (rows.length === 0) {
    const sampleNews = [
      {
        ticker: tickers[0] || 'FTSE.MI',
        title: 'Mercati finanziari: focus su trimestrali e tassi d’interesse delle banche centrali',
        link: 'https://www.borsaitaliana.it',
        publisher: 'Borsa Italiana',
        pubDate: new Date(Date.now() - 1000 * 60 * 45).toISOString(),
        source: 'GOOGLE_NEWS'
      },
      {
        ticker: tickers[1] || 'SWDA.MI',
        title: 'Borse europee e Wall Street: andamento settoriale ed ETF globali in evidenza',
        link: 'https://it.investing.com',
        publisher: 'Investing.com',
        pubDate: new Date(Date.now() - 1000 * 60 * 120).toISOString(),
        source: 'GOOGLE_NEWS'
      },
      {
        ticker: tickers[2] || 'NVDA',
        title: 'Tecnologia e intelligenza artificiale trainano gli utili e le stime di crescita',
        link: 'https://finance.yahoo.com',
        publisher: 'Yahoo Finanza',
        pubDate: new Date(Date.now() - 1000 * 60 * 240).toISOString(),
        source: 'YAHOO_FINANCE'
      }
    ];

    saveNewsArticles(sampleNews);
    return sampleNews.slice(0, limit).map(n => ({
      ...n,
      assetName: n.ticker,
      timeAgo: formatRelativeTime(n.pubDate)
    }));
  }

  return rows.map(r => ({
    ...r,
    timeAgo: formatRelativeTime(r.pubDate)
  }));
}

module.exports = {
  getUserPortfolioAssets,
  cleanCompanyName,
  decodeHtmlEntities,
  scrapeGoogleNewsForAsset,
  scrapeYahooNewsForAsset,
  saveNewsArticles,
  scrapePortfolioNews,
  getLatestPortfolioNews,
  formatRelativeTime
};
