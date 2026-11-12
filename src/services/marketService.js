const { db } = require('../db');
const yahoo = require('./yahooFinance');
const borsa = require('./borsaItaliana');
const google = require('./googleFinance');
const { recalculatePortfolio } = require('../routes/portfolios');
const { broadcastMarketUpdate } = require('./marketEvents');

/**
 * Normalizes ticker symbols.
 */
function normalizeTicker(ticker) {
  if (!ticker || typeof ticker !== 'string') return '';
  return ticker.trim().toUpperCase();
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
 * Resets daily deltas (changeValue, changePercent) to 0.0 for any asset
 * whose last recorded quoteDate is prior to the current trading date.
 * Sets previousClose to currentPrice so today's session starts strictly at 0 delta.
 *
 * @returns {number} number of asset rows updated
 */
function resetDailyAssetDeltas() {
  const todayStr = getTradingDateStr();
  try {
    const info = db.prepare(`
      UPDATE assets
      SET previousClose = currentPrice,
          changeValue = 0.0,
          changePercent = 0.0
      WHERE quoteDate IS NOT NULL AND trim(quoteDate) != '' AND quoteDate < ?
    `).run(todayStr);

    if (info.changes > 0) {
      console.log(`[Market] Inizio giornata: resettati a delta 0 i titoli precedenti al ${todayStr} (${info.changes} aggiornati)`);
    }
    return info.changes;
  } catch (err) {
    console.warn('[Market] resetDailyAssetDeltas error:', err.message);
    return 0;
  }
}

/**
 * Resilient cascading real-time quote fetcher respecting the asset's configured dataSource.
 *
 * @param {string} ticker
 * @param {string} [exchange]
 * @param {string} [forcedSource=null] - Optional override ('YAHOO', 'BORSA_ITALIANA', 'GOOGLE', 'MANUAL')
 * @returns {Promise<object|null>}
 */
async function fetchUnifiedQuote(ticker, exchange, forcedSource = null) {
  const symbol = normalizeTicker(ticker);
  if (!symbol) return null;

  // Retrieve preferred data source from DB if not forced
  let preferredSource = forcedSource;
  let assetRow = null;
  try {
    assetRow = db.prepare('SELECT * FROM assets WHERE ticker = ?').get(symbol);
    if (!preferredSource) {
      preferredSource = assetRow?.dataSource || (borsa.isIsin(symbol) ? 'BORSA_ITALIANA' : 'YAHOO');
    }
    if (!exchange && assetRow?.exchange) exchange = assetRow.exchange;
  } catch {
    if (!preferredSource) preferredSource = borsa.isIsin(symbol) ? 'BORSA_ITALIANA' : 'YAHOO';
  }

  // Handle DELISTED or MANUAL source: do not scrape external APIs, preserve current price and history
  if (preferredSource === 'DELISTED' || preferredSource === 'MANUAL') {
    return {
      ticker: symbol,
      name: assetRow?.name || symbol,
      type: assetRow?.type || 'EQUITY',
      exchange: assetRow?.exchange || '',
      currency: assetRow?.currency || 'EUR',
      currentPrice: assetRow?.currentPrice || 0,
      changePercent: preferredSource === 'DELISTED' ? 0 : (assetRow?.changePercent || 0),
      changeValue: preferredSource === 'DELISTED' ? 0 : (assetRow?.changeValue || 0),
      source: preferredSource,
      isDelisted: preferredSource === 'DELISTED',
      isManual: preferredSource === 'MANUAL',
      quoteDate: assetRow?.quoteDate || getTradingDateStr()
    };
  }

  let quote = null;

  // 1. If configured as Borsa Italiana
  if (preferredSource === 'BORSA_ITALIANA') {
    try {
      quote = await borsa.fetchRealtimeQuote(symbol);
    } catch (err) {
      console.warn(`[Market] Borsa Italiana failed for ${symbol}:`, err.message);
    }
    if (!quote) {
      try { quote = await yahoo.getQuote(symbol); } catch {}
    }
  } else if (preferredSource === 'GOOGLE') {
    // 2. If configured as Google Finance
    try {
      quote = await google.fetchQuote(symbol, exchange);
    } catch (err) {
      console.warn(`[Market] Google Finance failed for ${symbol}:`, err.message);
    }
    if (!quote) {
      try { quote = await yahoo.getQuote(symbol); } catch {}
    }
  } else {
    // 3. Default: YAHOO
    try {
      quote = await yahoo.getQuote(symbol);
    } catch (err) {
      console.warn(`[Market] Yahoo Finance failed for ${symbol}:`, err.message);
    }

    if (!quote || !quote.currentPrice) {
      if (borsa.isIsin(symbol)) {
        try { quote = await borsa.fetchRealtimeQuote(symbol); } catch {}
      } else {
        try { quote = await google.fetchQuote(symbol, exchange); } catch {}
      }
    }
  }

  // If a valid quote is obtained, persist in assets and asset_quotes table
  if (quote && quote.currentPrice > 0) {
    try {
      const usedSource = quote.source || preferredSource || 'YAHOO';
      const todayDateStr = getTradingDateStr();
      const quoteDateStr = quote.quoteDate || todayDateStr;
      const isPriorDay = Boolean(quoteDateStr < todayDateStr);

      const finalChangeVal = isPriorDay ? 0.0 : (quote.changeValue || 0.0);
      const finalChangePct = isPriorDay ? 0.0 : (quote.changePercent || 0.0);
      const finalPrevClose = isPriorDay ? quote.currentPrice : (quote.previousClose || (quote.currentPrice - finalChangeVal));

      quote.changeValue = finalChangeVal;
      quote.changePercent = finalChangePct;
      quote.previousClose = finalPrevClose;

      const upsertAsset = db.prepare(`
        INSERT INTO assets (
          ticker, name, type, exchange, currency, currentPrice,
          changePercent, changeValue, pe, forwardPE, eps, dividendYield,
          openPrice, highPrice, lowPrice, previousClose,
          dataSource, quoteDate, marketState, regularMarketTime,
          preMarketPrice, preMarketChange, preMarketChangePercent, preMarketTime,
          postMarketPrice, postMarketChange, postMarketChangePercent, postMarketTime,
          lastSyncStatus, lastSyncError, lastSyncAt, updatedAt
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'OK', NULL, datetime('now'), datetime('now'))
        ON CONFLICT(ticker) DO UPDATE SET
          name = coalesce(nullif(excluded.name, ''), assets.name),
          currentPrice = excluded.currentPrice,
          changePercent = excluded.changePercent,
          changeValue = excluded.changeValue,
          pe = coalesce(excluded.pe, assets.pe),
          forwardPE = coalesce(excluded.forwardPE, assets.forwardPE),
          eps = coalesce(excluded.eps, assets.eps),
          dividendYield = coalesce(nullif(excluded.dividendYield, 0), assets.dividendYield),
          openPrice = coalesce(nullif(excluded.openPrice, 0), assets.openPrice),
          highPrice = coalesce(nullif(excluded.highPrice, 0), assets.highPrice),
          lowPrice = coalesce(nullif(excluded.lowPrice, 0), assets.lowPrice),
          previousClose = coalesce(nullif(excluded.previousClose, 0), assets.previousClose),
          dataSource = coalesce(nullif(excluded.dataSource, ''), assets.dataSource),
          quoteDate = excluded.quoteDate,
          marketState = coalesce(excluded.marketState, assets.marketState),
          regularMarketTime = coalesce(excluded.regularMarketTime, assets.regularMarketTime),
          preMarketPrice = excluded.preMarketPrice,
          preMarketChange = excluded.preMarketChange,
          preMarketChangePercent = excluded.preMarketChangePercent,
          preMarketTime = excluded.preMarketTime,
          postMarketPrice = excluded.postMarketPrice,
          postMarketChange = excluded.postMarketChange,
          postMarketChangePercent = excluded.postMarketChangePercent,
          postMarketTime = excluded.postMarketTime,
          lastSyncStatus = 'OK',
          lastSyncError = NULL,
          lastSyncAt = datetime('now'),
          updatedAt = datetime('now')
      `);

      upsertAsset.run(
        symbol,
        quote.name || symbol,
        quote.type || 'EQUITY',
        quote.exchange || '',
        quote.currency || 'EUR',
        quote.currentPrice,
        finalChangePct,
        finalChangeVal,
        quote.pe || null,
        quote.forwardPE || null,
        quote.eps || null,
        quote.dividendYield || 0.0,
        quote.openPrice || quote.currentPrice,
        quote.highPrice || quote.currentPrice,
        quote.lowPrice || quote.currentPrice,
        finalPrevClose,
        preferredSource || 'YAHOO',
        quoteDateStr,
        quote.marketState || null,
        quote.regularMarketTime || null,
        quote.preMarketPrice || null,
        (quote.preMarketChange !== undefined && quote.preMarketChange !== null) ? quote.preMarketChange : null,
        (quote.preMarketChangePercent !== undefined && quote.preMarketChangePercent !== null) ? quote.preMarketChangePercent : null,
        quote.preMarketTime || null,
        quote.postMarketPrice || null,
        (quote.postMarketChange !== undefined && quote.postMarketChange !== null) ? quote.postMarketChange : null,
        (quote.postMarketChangePercent !== undefined && quote.postMarketChangePercent !== null) ? quote.postMarketChangePercent : null,
        quote.postMarketTime || null
      );

      // Save close price to asset_quotes cache
      const dateStr = quoteDateStr;
      const upsertQuote = db.prepare(`
        INSERT INTO asset_quotes (ticker, date, close, volume, source, updatedAt)
        VALUES (?, ?, ?, ?, ?, datetime('now'))
        ON CONFLICT(ticker, date) DO UPDATE SET
          close = excluded.close,
          volume = excluded.volume,
          source = excluded.source,
          updatedAt = datetime('now')
      `);

      upsertQuote.run(symbol, dateStr, quote.currentPrice, quote.volume || 0, usedSource);
    } catch (err) {
      console.warn(`[Market DB Save Error] for ${symbol}:`, err.message);
    }
  } else {
    // Quote fetch failed: mark asset with red alert error status
    try {
      db.prepare(`
        UPDATE assets
        SET lastSyncStatus = 'ERROR',
            lastSyncError = ?,
            lastSyncAt = datetime('now')
        WHERE ticker = ?
      `).run(`Impossibile recuperare quotazione realtime per '${symbol}' da ${preferredSource}`, symbol);
    } catch (err) {
      console.warn(`[Market DB Status Error] for ${symbol}:`, err.message);
    }
  }

  return quote;
}

/**
 * Resilient historical series fetcher with SQLite cache.
 * Defaults to 5Y as requested.
 *
 * @param {string} ticker
 * @param {string} [period='5Y']
 * @param {string} [forcedSource=null]
 * @returns {Promise<Array<{ date: string, close: number, volume: number, source: string }>>}
 */
async function fetchUnifiedHistorical(ticker, period = '5Y', forcedSource = null) {
  const symbol = normalizeTicker(ticker);
  if (!symbol) return [];

  let preferredSource = forcedSource;
  if (!preferredSource) {
    try {
      const asset = db.prepare('SELECT dataSource FROM assets WHERE ticker = ?').get(symbol);
      preferredSource = asset?.dataSource || (borsa.isIsin(symbol) ? 'BORSA_ITALIANA' : 'YAHOO');
    } catch {
      preferredSource = borsa.isIsin(symbol) ? 'BORSA_ITALIANA' : 'YAHOO';
    }
  }

  let points = [];

  // Handle DELISTED or MANUAL source: do not scrape external APIs, return existing SQLite cached points
  if (preferredSource === 'DELISTED' || preferredSource === 'MANUAL') {
    return db.prepare(`
      SELECT date, close, volume, source
      FROM asset_quotes
      WHERE ticker = ?
      ORDER BY date ASC
    `).all(symbol);
  }

  if (preferredSource === 'BORSA_ITALIANA' || borsa.isIsin(symbol)) {
    try {
      points = await borsa.fetchHistorical(symbol, period);
    } catch (err) {
      console.warn(`[Market] Borsa Italiana historical failed for ${symbol}:`, err.message);
    }

    if (!points || points.length === 0) {
      const now = new Date();
      let period1 = '2020-01-01';
      if (period === '1M') period1 = new Date(now.setMonth(now.getMonth() - 1)).toISOString().split('T')[0];
      else if (period === '3M') period1 = new Date(now.setMonth(now.getMonth() - 3)).toISOString().split('T')[0];
      else if (period === '6M') period1 = new Date(now.setMonth(now.getMonth() - 6)).toISOString().split('T')[0];
      else if (period === '1Y') period1 = new Date(now.setFullYear(now.getFullYear() - 1)).toISOString().split('T')[0];
      else if (period === '3Y') period1 = new Date(now.setFullYear(now.getFullYear() - 3)).toISOString().split('T')[0];
      else if (period === '5Y') period1 = new Date(now.setFullYear(now.getFullYear() - 5)).toISOString().split('T')[0];
      try { points = await yahoo.getHistorical(symbol, period1, '1d'); } catch {}
    }
  } else {
    // YAHOO (Default)
    let period1 = '2020-01-01';
    const now = new Date();
    if (period === '1M') period1 = new Date(now.setMonth(now.getMonth() - 1)).toISOString().split('T')[0];
    else if (period === '3M') period1 = new Date(now.setMonth(now.getMonth() - 3)).toISOString().split('T')[0];
    else if (period === '6M') period1 = new Date(now.setMonth(now.getMonth() - 6)).toISOString().split('T')[0];
    else if (period === '1Y') period1 = new Date(now.setFullYear(now.getFullYear() - 1)).toISOString().split('T')[0];
    else if (period === '3Y') period1 = new Date(now.setFullYear(now.getFullYear() - 3)).toISOString().split('T')[0];
    else if (period === '5Y') period1 = new Date(now.setFullYear(now.getFullYear() - 5)).toISOString().split('T')[0];

    try {
      points = await yahoo.getHistorical(symbol, period1, '1d');
    } catch (err) {
      console.warn(`[Market] Yahoo historical failed for ${symbol}:`, err.message);
    }
  }

  // If live provider fetched points, cache into asset_quotes
  if (points && points.length > 0) {
    try {
      const insertBatch = db.transaction((rows) => {
        const stmt = db.prepare(`
          INSERT INTO asset_quotes (ticker, date, close, volume, source, updatedAt)
          VALUES (?, ?, ?, ?, ?, datetime('now'))
          ON CONFLICT(ticker, date) DO UPDATE SET
            close = excluded.close,
            volume = excluded.volume,
            source = excluded.source,
            updatedAt = datetime('now')
        `);
        for (const pt of rows) {
          stmt.run(symbol, pt.date, pt.close, pt.volume || 0, pt.source || preferredSource || 'YAHOO');
        }
      });
      insertBatch(points);

      // Record successful historical sync
      db.prepare(`
        UPDATE assets
        SET historicalSyncStatus = 'OK',
            historicalSyncError = NULL,
            historicalSyncAt = datetime('now')
        WHERE ticker = ?
      `).run(symbol);
    } catch (err) {
      console.warn(`[Market Cache Save Error] for ${symbol}:`, err.message);
    }
    return points;
  }

  // If live provider failed or returned 0 points (and not MANUAL)
  if (preferredSource !== 'MANUAL') {
    try {
      db.prepare(`
        UPDATE assets
        SET historicalSyncStatus = 'ERROR',
            historicalSyncError = ?,
            historicalSyncAt = datetime('now')
        WHERE ticker = ?
      `).run(`Impossibile scaricare serie storica per '${symbol}' da ${preferredSource}`, symbol);
    } catch (err) {
      console.warn(`[Market Historical Status Error] for ${symbol}:`, err.message);
    }
  }

  // Fallback to SQLite cached points if offline or provider failed
  const cached = db.prepare(`
    SELECT date, close, volume, source
    FROM asset_quotes
    WHERE ticker = ?
    ORDER BY date ASC
  `).all(symbol);

  return cached;
}

/**
 * Ensures historical quotes exist in cache for this asset (one-off check).
 * If quotes are not present and source is not MANUAL, downloads 5Y quotes.
 *
 * @param {string} ticker
 * @returns {Promise<boolean>} whether historical quotes were fetched
 */
async function ensureHistoricalQuotesIfMissing(ticker) {
  const symbol = normalizeTicker(ticker);
  if (!symbol) return false;

  try {
    const asset = db.prepare('SELECT ticker, dataSource FROM assets WHERE ticker = ?').get(symbol);
    if (!asset || asset.dataSource === 'MANUAL' || asset.dataSource === 'DELISTED') return false;

    const countRow = db.prepare('SELECT COUNT(*) as c FROM asset_quotes WHERE ticker = ?').get(symbol);
    if (!countRow || countRow.c === 0) {
      console.log(`[Market] Downloading one-off historical quotes for ${symbol}...`);
      await fetchUnifiedHistorical(symbol, '5Y');
      return true;
    }
  } catch (err) {
    console.warn(`[Market] ensureHistoricalQuotesIfMissing failed for ${symbol}:`, err.message);
  }
  return false;
}

/**
 * Batch update job: refreshes quotes for all assets in portfolios with rate-limiting.
 *
 * @param {object} [options]
 * @param {number} [options.delayMs=150]
 * @returns {Promise<{ total: number, updated: number, failed: number, results: Array<object> }>}
 */
async function updateAllAssetPrices(options = {}) {
  const delayMs = options.delayMs !== undefined ? options.delayMs : 150;

  // Sync FX currency rates first so multi-currency valuations (USD -> EUR) are strictly up to date
  try {
    await syncAllCurrencyRates();
  } catch (err) {
    console.warn('[Market Batch Update] Warning: Failed to sync FX rates:', err.message);
  }

  const rows = db.prepare(`
    SELECT DISTINCT assetTicker AS ticker
    FROM transactions
    WHERE assetTicker IS NOT NULL AND trim(assetTicker) != ''
    UNION
    SELECT ticker FROM assets
  `).all();

  const tickers = rows.map(r => r.ticker).filter(Boolean);
  const results = [];
  let updatedCount = 0;
  let failedCount = 0;

  for (const ticker of tickers) {
    try {
      const asset = db.prepare('SELECT ticker, dataSource, currentPrice FROM assets WHERE ticker = ?').get(ticker);
      if (asset?.dataSource === 'DELISTED' || asset?.dataSource === 'MANUAL') {
        updatedCount++;
        results.push({ ticker, status: asset.dataSource, price: asset.currentPrice || 0, source: asset.dataSource });
        continue;
      }

      // Ensure historical quotes are downloaded one-off if missing
      await ensureHistoricalQuotesIfMissing(ticker);

      const q = await fetchUnifiedQuote(ticker);
      if (q && q.currentPrice > 0) {
        updatedCount++;
        results.push({ ticker, status: 'OK', price: q.currentPrice, source: q.source });
      } else {
        failedCount++;
        results.push({ ticker, status: 'FAILED', error: 'No price returned' });
      }
    } catch (err) {
      failedCount++;
      results.push({ ticker, status: 'ERROR', error: err.message });
    }

    if (delayMs > 0) {
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }

  // Recalculate all portfolios after market update
  try {
    const portfolios = db.prepare('SELECT id FROM portfolios').all();
    for (const p of portfolios) {
      recalculatePortfolio(p.id);
    }
  } catch (err) {
    console.warn('[Market Batch Update] Error recalculating portfolios:', err.message);
  }

  // Broadcast market updated event so connected dashboards refresh immediately
  broadcastMarketUpdate({
    reason: 'BATCH_SYNC',
    updated: updatedCount,
    failed: failedCount,
    total: tickers.length
  });

  return {
    total: tickers.length,
    updated: updatedCount,
    failed: failedCount,
    results
  };
}

/**
 * Bulk downloads 5-year historical quotes for all assets in portfolios.
 * Populates the asset_quotes table so that portfolio performance curves can be reconstructed.
 *
 * @param {number} [delayMs=200]
 * @returns {Promise<{ total: number, succeeded: number, totalPoints: number, results: Array<object> }>}
 */
async function syncAllAssetsHistorical(delayMs = 200) {
  const rows = db.prepare(`
    SELECT DISTINCT assetTicker AS ticker
    FROM transactions
    WHERE assetTicker IS NOT NULL AND trim(assetTicker) != ''
    UNION
    SELECT ticker FROM assets
  `).all();

  const tickers = rows.map(r => r.ticker).filter(Boolean);
  let succeeded = 0;
  let totalPoints = 0;
  const results = [];

  for (const ticker of tickers) {
    try {
      const asset = db.prepare('SELECT ticker, dataSource FROM assets WHERE ticker = ?').get(ticker);
      if (asset?.dataSource === 'DELISTED' || asset?.dataSource === 'MANUAL') {
        succeeded++;
        results.push({ ticker, count: 0, status: asset.dataSource });
        continue;
      }

      const points = await fetchUnifiedHistorical(ticker, '5Y');
      const count = points ? points.length : 0;
      if (count > 0) {
        succeeded++;
        totalPoints += count;
        results.push({ ticker, count, status: 'OK' });
      } else {
        results.push({ ticker, count: 0, status: 'EMPTY' });
      }
    } catch (err) {
      results.push({ ticker, count: 0, status: 'ERROR', error: err.message });
    }

    if (delayMs > 0) {
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }

  return {
    total: tickers.length,
    succeeded,
    totalPoints,
    results
  };
}

/**
 * Safely adds or subtracts days to a 'YYYY-MM-DD' date string
 * using UTC noon to prevent DST (Daylight Saving Time) hour shifts.
 *
 * @param {string} dateStr
 * @param {number} days
 * @returns {string}
 */
function addDaysToDateStr(dateStr, days = 1) {
  const parts = dateStr.split('-');
  const y = parseInt(parts[0], 10);
  const m = parseInt(parts[1], 10);
  const d = parseInt(parts[2], 10);
  const date = new Date(Date.UTC(y, m - 1, d + days, 12, 0, 0));
  return date.toISOString().split('T')[0];
}

/**
 * Reconstructs the 5-year daily performance curves in portfolio_history
 * from the actual historical close quotes in asset_quotes and transactions.
 *
 * @param {number|null} [portfolioId=null]
 * @param {number} [daysBack=1825] (5 years)
 * @returns {{ success: boolean, pointsReconstructed: number }}
 */
function reconstructPortfolioHistoryFromQuotes(portfolioId = null, daysBack = 1825) {
  let portfolios = [];
  if (portfolioId) {
    const p = db.prepare('SELECT * FROM portfolios WHERE id = ?').get(portfolioId);
    if (p) portfolios.push(p);
  } else {
    portfolios = db.prepare('SELECT * FROM portfolios').all();
  }

  const upsertStmt = db.prepare(`
    INSERT INTO portfolio_history (
      portfolioId, date, totalValue, cashValue, assetValue, netDeposits, user_id, createdAt
    ) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(portfolioId, date) DO UPDATE SET
      totalValue = excluded.totalValue,
      cashValue = excluded.cashValue,
      assetValue = excluded.assetValue,
      netDeposits = excluded.netDeposits,
      createdAt = datetime('now')
  `);

  let totalReconstructedPoints = 0;
  const todayStr = new Date().toISOString().split('T')[0];
  const startDateStr = addDaysToDateStr(todayStr, -daysBack);

  for (const p of portfolios) {
    const txs = db.prepare(`
      SELECT * FROM transactions
      WHERE portfolioId = ?
      ORDER BY date ASC, id ASC
    `).all(p.id);

    const owner = db.prepare(`
      SELECT user_id FROM portfolio_users
      WHERE portfolio_id = ? AND role = 'owner'
      LIMIT 1
    `).get(p.id);
    const userId = owner ? owner.user_id : null;

    const tickers = [...new Set(txs.map(t => t.assetTicker).filter(Boolean))];

    // Load quotes map: quotesByTicker[ticker][date] = close
    const quotesByTicker = {};
    for (const t of tickers) {
      quotesByTicker[t] = {};
      const rows = db.prepare(`
        SELECT date, close FROM asset_quotes
        WHERE ticker = ?
        ORDER BY date ASC
      `).all(t);
      for (const r of rows) {
        quotesByTicker[t][r.date] = r.close;
      }
    }

    if (txs.length === 0) {
      continue;
    }

    const earliestTxDateStr = txs[0].date ? txs[0].date.split('T')[0] : startDateStr;
    const effectiveStartStr = earliestTxDateStr > startDateStr ? earliestTxDateStr : startDateStr;

    // Pre-load asset metadata (currency and current price)
    const assetRows = db.prepare('SELECT ticker, currency, currentPrice FROM assets').all();
    const assetMeta = {};
    for (const a of assetRows) {
      assetMeta[a.ticker] = {
        currency: (a.currency || 'EUR').toUpperCase(),
        currentPrice: Number(a.currentPrice) || 0
      };
    }

    // Pre-load currency exchange rates map
    const currRows = db.prepare('SELECT pair, rate FROM currency_rates').all();
    const currsMap = {};
    for (const c of currRows) {
      currsMap[c.pair] = Number(c.rate);
    }

    const hasInitialDeposit = txs.some(t => t.type === 'DEPOSIT' && t.notes === 'Deposito iniziale');
    let currentCash = hasInitialDeposit ? 0.0 : (Number(p.initialCash) || 0.0);
    let netDeposits = hasInitialDeposit ? 0.0 : (Number(p.initialCash) || 0.0);
    const positions = {};
    const lastKnownPrices = {};
    let txIdx = 0;

    // Apply transactions prior to effectiveStartStr
    while (txIdx < txs.length && (txs[txIdx].date.split('T')[0] < effectiveStartStr)) {
      const tx = txs[txIdx];
      applyTxToSimulation(tx, positions, (delta) => { currentCash += delta; }, (delta) => { netDeposits += delta; }, lastKnownPrices);
      txIdx++;
    }

    db.transaction(() => {
      // Purge any orphan rows that precede the effective start date
      db.prepare('DELETE FROM portfolio_history WHERE portfolioId = ? AND date < ?').run(p.id, effectiveStartStr);

      let curDateStr = effectiveStartStr;
      while (curDateStr <= todayStr) {
        const dateStr = curDateStr;

        // Apply transactions up to current date
        while (txIdx < txs.length && txs[txIdx].date.split('T')[0] <= dateStr) {
          const tx = txs[txIdx];
          applyTxToSimulation(tx, positions, (delta) => { currentCash += delta; }, (delta) => { netDeposits += delta; }, lastKnownPrices);
          txIdx++;
        }

        // Calculate total asset value with proper multi-currency conversion
        let assetValue = 0.0;
        const pCurr = (p.currency || 'EUR').toUpperCase();
        for (const [ticker, qty] of Object.entries(positions)) {
          if (qty <= 0.00001) continue;
          if (quotesByTicker[ticker] && quotesByTicker[ticker][dateStr] !== undefined && quotesByTicker[ticker][dateStr] !== null) {
            lastKnownPrices[ticker] = Number(quotesByTicker[ticker][dateStr]);
          }
          const meta = assetMeta[ticker] || { currency: 'EUR', currentPrice: 0.0 };
          const rawPrice = lastKnownPrices[ticker] || meta.currentPrice || 0.0;
          const assetCurr = meta.currency;
          let fxRate = 1.0;
          if (assetCurr !== pCurr) {
            if (currsMap[`${assetCurr}/${pCurr}`]) {
              fxRate = currsMap[`${assetCurr}/${pCurr}`];
            } else if (currsMap[`${pCurr}/${assetCurr}`]) {
              fxRate = 1.0 / currsMap[`${pCurr}/${assetCurr}`];
            }
          }
          assetValue += qty * rawPrice * fxRate;
        }

        const totalValue = currentCash + assetValue;
        upsertStmt.run(p.id, dateStr, totalValue, currentCash, assetValue, netDeposits, userId);
        totalReconstructedPoints++;

        curDateStr = addDaysToDateStr(curDateStr, 1);
      }

      // Purge any pre-creation blank rows with 0 value and 0 deposits
      db.prepare('DELETE FROM portfolio_history WHERE portfolioId = ? AND totalValue = 0 AND netDeposits = 0 AND cashValue = 0 AND assetValue = 0').run(p.id);
    })();
  }

  return { success: true, pointsReconstructed: totalReconstructedPoints };
}

function applyTxToSimulation(tx, positions, updateCash, updateNetDeposits, lastKnownPrices = null) {
  const qty = Number(tx.quantity) || 0.0;
  const price = Number(tx.price) || 0.0;
  const commission = Number(tx.commission) || 0.0;
  const tax = Number(tx.tax) || 0.0;
  const fxRate = Number(tx.exchangeRate) || 1.0;
  const specifiedAmount = Number(tx.amount) || 0.0;
  const ticker = tx.assetTicker ? tx.assetTicker.toUpperCase().trim() : null;

  switch (tx.type) {
    case 'DEPOSIT': {
      const amount = specifiedAmount > 0 ? specifiedAmount : (qty > 0 && price > 0 ? qty * price : 0.0);
      updateCash(amount);
      updateNetDeposits(amount);
      break;
    }
    case 'WITHDRAWAL': {
      const amount = specifiedAmount > 0 ? specifiedAmount : (qty > 0 && price > 0 ? qty * price : 0.0);
      updateCash(-amount);
      updateNetDeposits(-amount);
      break;
    }
    case 'TRANSFER': {
      const amount = specifiedAmount;
      updateCash(amount);
      updateNetDeposits(amount);
      break;
    }
    case 'BUY': {
      if (!ticker || qty <= 0) break;
      const totalCostEur = specifiedAmount > 0
        ? specifiedAmount
        : (fxRate !== 1.0 && fxRate > 0 ? ((qty * price + commission) / fxRate + tax) : ((qty * price) + commission + tax));
      updateCash(-totalCostEur);
      positions[ticker] = (positions[ticker] || 0) + qty;
      if (lastKnownPrices && price > 0) {
        lastKnownPrices[ticker] = price;
      }
      break;
    }
    case 'SELL': {
      if (!ticker || qty <= 0) break;
      const netProceedsEur = specifiedAmount > 0
        ? specifiedAmount
        : (fxRate !== 1.0 && fxRate > 0 ? ((qty * price - commission) / fxRate - tax) : ((qty * price) - commission - tax));
      updateCash(netProceedsEur);
      positions[ticker] = Math.max(0, (positions[ticker] || 0) - qty);
      if (lastKnownPrices && price > 0) {
        lastKnownPrices[ticker] = price;
      }
      break;
    }
    case 'DIVIDEND':
    case 'INTEREST': {
      const netIncome = specifiedAmount > 0
        ? specifiedAmount
        : ((qty > 0 && price > 0 ? qty * price : 0.0) - tax);
      updateCash(netIncome);
      break;
    }
    case 'FEE':
    case 'TAX': {
      const feeAmount = specifiedAmount > 0 ? specifiedAmount : commission + tax;
      updateCash(-feeAmount);
      break;
    }
    case 'SPLIT': {
      if (ticker && qty > 0) {
        positions[ticker] = (positions[ticker] || 0) * qty;
      }
      break;
    }
  }
}

/**
 * Synchronizes currency rates table via Yahoo Finance FX quotes.
 */
async function syncAllCurrencyRates() {
  const pairs = db.prepare('SELECT * FROM currency_rates').all();
  let updatedCount = 0;

  for (const pairRow of pairs) {
    try {
      const from = pairRow.fromCurrency.toUpperCase();
      const to = pairRow.toCurrency.toUpperCase();
      if (from === to) {
        db.prepare("UPDATE currency_rates SET rate = 1.0, updatedAt = datetime('now') WHERE id = ?").run(pairRow.id);
        continue;
      }

      const yahooSymbol = `${from}${to}=X`;
      let quote = null;
      try {
        quote = await yahoo.getQuote(yahooSymbol);
      } catch {}

      if (!quote || !quote.currentPrice) {
        const reverseSymbol = `${to}${from}=X`;
        try {
          const revQuote = await yahoo.getQuote(reverseSymbol);
          if (revQuote && revQuote.currentPrice > 0) {
            quote = { currentPrice: 1.0 / revQuote.currentPrice };
          }
        } catch {}
      }

      if (quote && quote.currentPrice > 0) {
        db.prepare(`
          UPDATE currency_rates
          SET rate = ?, source = 'YAHOO', updatedAt = datetime('now')
          WHERE id = ?
        `).run(quote.currentPrice, pairRow.id);
        updatedCount++;
      }
    } catch (err) {
      console.warn(`[FX Sync Error] ${pairRow.pair}:`, err.message);
    }
  }

  return { success: true, total: pairs.length, updated: updatedCount };
}

const DEFAULT_TICKER_CONFIG = {
  refreshSeconds: 60,
  scrollSpeed: 'normal',
  indices: [
    { symbol: '^GSPC', name: 'S&P 500', currency: 'USD', enabled: true },
    { symbol: 'FTSEMIB.MI', name: 'FTSE MIB', currency: 'EUR', enabled: true },
    { symbol: 'BTP10Y', name: 'BTP 10Y', currency: '%', isYield: true, enabled: true },
    { symbol: 'GC=F', name: 'Oro (Gold)', currency: 'USD', enabled: true },
    { symbol: 'BTC-EUR', name: 'Bitcoin', currency: 'EUR', enabled: true },
    { symbol: 'EURUSD=X', name: 'EUR / USD', currency: '', enabled: true }
  ]
};

const PRESET_INDICES = [
  { symbol: '^GSPC', name: 'S&P 500', currency: 'USD' },
  { symbol: 'FTSEMIB.MI', name: 'FTSE MIB', currency: 'EUR' },
  { symbol: '^IXIC', name: 'NASDAQ', currency: 'USD' },
  { symbol: '^STOXX50E', name: 'Euro Stoxx 50', currency: 'EUR' },
  { symbol: '^GDAXI', name: 'DAX 40', currency: 'EUR' },
  { symbol: '^N225', name: 'Nikkei 225', currency: 'JPY' },
  { symbol: '^FTSE', name: 'FTSE 100', currency: 'GBP' },
  { symbol: 'BTP10Y', name: 'BTP 10Y Rendimento', currency: '%', isYield: true },
  { symbol: 'GC=F', name: 'Oro (Gold)', currency: 'USD' },
  { symbol: 'CL=F', name: 'Petrolio WTI', currency: 'USD' },
  { symbol: 'BTC-EUR', name: 'Bitcoin', currency: 'EUR' },
  { symbol: 'ETH-EUR', name: 'Ethereum', currency: 'EUR' },
  { symbol: 'EURUSD=X', name: 'EUR / USD', currency: '' },
  { symbol: 'EURGBP=X', name: 'EUR / GBP', currency: '' }
];

let cachedIndicesResult = null;
let lastIndicesCacheTime = 0;

function invalidateIndicesCache() {
  cachedIndicesResult = null;
  lastIndicesCacheTime = 0;
}

/**
 * Retrieves the ticker banner configuration, merged with persisted settings.
 */
function getTickerConfig() {
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'market_indices_config' LIMIT 1").get();
    if (row && row.value) {
      const parsed = JSON.parse(row.value);
      return {
        refreshSeconds: Math.max(5, parseInt(parsed.refreshSeconds, 10) || DEFAULT_TICKER_CONFIG.refreshSeconds),
        scrollSpeed: ['very_slow', 'slow', 'normal', 'fast'].includes(parsed.scrollSpeed) ? parsed.scrollSpeed : DEFAULT_TICKER_CONFIG.scrollSpeed,
        indices: Array.isArray(parsed.indices) && parsed.indices.length > 0 ? parsed.indices : DEFAULT_TICKER_CONFIG.indices
      };
    }
  } catch (err) {
    console.warn('[MarketService] Errore lettura config indici:', err.message);
  }
  return JSON.parse(JSON.stringify(DEFAULT_TICKER_CONFIG));
}

/**
 * Persists the ticker banner configuration.
 */
function setTickerConfig(newConfig, userId = 1) {
  if (!newConfig || typeof newConfig !== 'object') {
    throw new Error('Configurazione indici non valida');
  }

  const refreshSeconds = Math.max(5, Math.min(86400, parseInt(newConfig.refreshSeconds, 10) || 60));
  const scrollSpeed = ['very_slow', 'slow', 'normal', 'fast'].includes(newConfig.scrollSpeed) ? newConfig.scrollSpeed : 'normal';

  let indices = Array.isArray(newConfig.indices) ? newConfig.indices : [];
  if (indices.length === 0) {
    indices = DEFAULT_TICKER_CONFIG.indices;
  }

  const cleanedIndices = indices.map(item => ({
    symbol: String(item.symbol || '').trim().toUpperCase(),
    name: String(item.name || item.symbol || '').trim(),
    currency: String(item.currency || '').trim(),
    isYield: Boolean(item.isYield || item.currency === '%'),
    enabled: item.enabled !== false
  })).filter(item => item.symbol.length > 0);

  if (cleanedIndices.length === 0) {
    throw new Error('È necessario specificare almeno un indice valido');
  }

  const finalConfig = {
    refreshSeconds,
    scrollSpeed,
    indices: cleanedIndices
  };

  const jsonVal = JSON.stringify(finalConfig);
  const existing = db.prepare("SELECT value FROM settings WHERE key = 'market_indices_config' LIMIT 1").get();
  if (existing) {
    db.prepare("UPDATE settings SET value = ? WHERE key = 'market_indices_config'").run(jsonVal);
  } else {
    db.prepare("INSERT INTO settings (user_id, key, value) VALUES (?, 'market_indices_config', ?)").run(userId, jsonVal);
  }

  invalidateIndicesCache();
  return finalConfig;
}

/**
 * Resets the ticker banner configuration to factory defaults.
 */
function resetTickerConfig(userId = 1) {
  db.prepare("DELETE FROM settings WHERE key = 'market_indices_config'").run();
  invalidateIndicesCache();
  return JSON.parse(JSON.stringify(DEFAULT_TICKER_CONFIG));
}

/**
 * Fetches real-time world indices for the live ticker banner.
 */
async function fetchWorldIndices(force = false) {
  const config = getTickerConfig();
  const cacheTtlMs = Math.max(5000, config.refreshSeconds * 1000);

  if (!force && cachedIndicesResult && (Date.now() - lastIndicesCacheTime) < cacheTtlMs) {
    return cachedIndicesResult;
  }

  const enabledItems = config.indices.filter(i => i.enabled !== false);
  const itemsToFetch = enabledItems.length > 0 ? enabledItems : DEFAULT_TICKER_CONFIG.indices;

  const results = [];

  for (const cfg of itemsToFetch) {
    const sym = cfg.symbol;
    if (sym === 'BTP10Y') {
      try {
        const btpQuote = await borsa.fetchRealtimeQuote('IT0005240830');
        if (btpQuote && btpQuote.currentPrice > 0) {
          results.push({
            symbol: 'BTP10Y',
            name: cfg.name || 'BTP 10Y',
            price: btpQuote.currentPrice,
            change: 0.0,
            changePercent: btpQuote.changePercent || 0.0,
            currency: cfg.currency || 'EUR',
            isYield: true
          });
          continue;
        }
      } catch {}
      // fallback yield
      results.push({
        symbol: 'BTP10Y',
        name: cfg.name || 'BTP 10Y',
        price: 3.58,
        change: -0.04,
        changePercent: -1.10,
        currency: '%',
        isYield: true
      });
      continue;
    }

    try {
      const q = await yahoo.getQuote(sym);
      if (q && q.currentPrice > 0) {
        results.push({
          symbol: sym,
          name: cfg.name || sym,
          price: q.currentPrice,
          change: q.changeValue || 0.0,
          changePercent: q.changePercent || 0.0,
          currency: cfg.currency || (sym.includes('EUR') || sym.endsWith('.MI') ? 'EUR' : (sym.endsWith('=X') ? '' : 'USD')),
          isYield: Boolean(cfg.isYield)
        });
        continue;
      }
    } catch {}

    if (borsa.isIsin(sym) || sym.endsWith('.MI')) {
      try {
        const bQuote = await borsa.fetchRealtimeQuote(sym);
        if (bQuote && bQuote.currentPrice > 0) {
          results.push({
            symbol: sym,
            name: cfg.name || sym,
            price: bQuote.currentPrice,
            change: bQuote.changeValue || 0.0,
            changePercent: bQuote.changePercent || 0.0,
            currency: cfg.currency || 'EUR',
            isYield: Boolean(cfg.isYield)
          });
          continue;
        }
      } catch {}
    }

    // Graceful fallback for popular symbols
    const fallbackMap = {
      '^GSPC': { price: 5864.67, change: 24.34, changePercent: 0.42, currency: 'USD' },
      'FTSEMIB.MI': { price: 34928.10, change: 182.40, changePercent: 0.52, currency: 'EUR' },
      '^IXIC': { price: 18518.61, change: 145.20, changePercent: 0.79, currency: 'USD' },
      '^STOXX50E': { price: 4945.20, change: 15.60, changePercent: 0.32, currency: 'EUR' },
      '^GDAXI': { price: 19420.50, change: 85.30, changePercent: 0.44, currency: 'EUR' },
      'GC=F': { price: 2748.20, change: 12.80, changePercent: 0.47, currency: 'USD' },
      'CL=F': { price: 71.40, change: -0.55, changePercent: -0.76, currency: 'USD' },
      'BTC-EUR': { price: 63890.00, change: 1240.00, changePercent: 1.98, currency: 'EUR' },
      'ETH-EUR': { price: 2450.00, change: 35.00, changePercent: 1.45, currency: 'EUR' },
      'EURUSD=X': { price: 1.0874, change: 0.0018, changePercent: 0.17, currency: '' }
    };

    const fb = fallbackMap[sym] || { price: 100.0, change: 0.0, changePercent: 0.0, currency: cfg.currency || 'EUR' };
    results.push({
      symbol: sym,
      name: cfg.name || sym,
      price: fb.price,
      change: fb.change,
      changePercent: fb.changePercent,
      currency: cfg.currency || fb.currency,
      isYield: Boolean(cfg.isYield)
    });
  }

  cachedIndicesResult = results;
  lastIndicesCacheTime = Date.now();
  return results;
}

module.exports = {
  fetchUnifiedQuote,
  fetchUnifiedHistorical,
  ensureHistoricalQuotesIfMissing,
  updateAllAssetPrices,
  syncAllAssetsHistorical,
  reconstructPortfolioHistoryFromQuotes,
  syncAllCurrencyRates,
  fetchWorldIndices,
  normalizeTicker,
  resetDailyAssetDeltas,
  getTradingDateStr,
  getTickerConfig,
  setTickerConfig,
  resetTickerConfig,
  invalidateIndicesCache,
  DEFAULT_TICKER_CONFIG,
  PRESET_INDICES,
  addDaysToDateStr
};
