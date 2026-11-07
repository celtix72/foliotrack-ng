const express = require('express');
const { db } = require('../db');
const { requireAuth } = require('../middlewares/authMiddleware');
const {
  GICS_SECTORS,
  ASSET_TYPES,
  PORTFOLIO_TYPES,
  RISK_CATEGORIES,
  REGIONS,
  CURRENCIES
} = require('../utils/constants');
const {
  fetchUnifiedQuote,
  fetchUnifiedHistorical,
  ensureHistoricalQuotesIfMissing,
  syncAllAssetsHistorical
} = require('../services/marketService');
const { broadcastMarketUpdate } = require('../services/marketEvents');

const router = express.Router();

router.use(requireAuth);

/**
 * GET /api/assets/taxonomy
 * Returns complete multidimensional taxonomy definitions.
 */
router.get('/taxonomy', (req, res) => {
  return res.json({
    success: true,
    taxonomy: {
      sectors: GICS_SECTORS,
      assetTypes: ASSET_TYPES,
      portfolioTypes: PORTFOLIO_TYPES,
      riskCategories: RISK_CATEGORIES,
      regions: REGIONS,
      currencies: CURRENCIES,
      dataSources: ['YAHOO', 'BORSA_ITALIANA', 'GOOGLE', 'MANUAL', 'DELISTED']
    }
  });
});

/**
 * GET /api/assets/classifications
 * Returns taxonomy distribution and asset counts by class, sector, and region.
 */
router.get('/classifications', (req, res) => {
  try {
    const assets = db.prepare('SELECT ticker, name, type, sector, region, currentPrice FROM assets ORDER BY ticker ASC').all();

    const byType = {};
    const bySector = {};
    const byRegion = {};

    for (const a of assets) {
      const t = a.type || 'EQUITY';
      const s = a.sector || 'Unclassified';
      const r = a.region || 'Global';

      if (!byType[t]) byType[t] = { count: 0, tickers: [] };
      byType[t].count++;
      byType[t].tickers.push(a.ticker);

      if (!bySector[s]) bySector[s] = { count: 0, tickers: [] };
      bySector[s].count++;
      bySector[s].tickers.push(a.ticker);

      if (!byRegion[r]) byRegion[r] = { count: 0, tickers: [] };
      byRegion[r].count++;
      byRegion[r].tickers.push(a.ticker);
    }

    return res.json({
      success: true,
      totalAssets: assets.length,
      classifications: {
        byType,
        bySector,
        byRegion
      }
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/assets
 * Lists or searches assets with quote counts and data sources.
 */
router.get('/', (req, res) => {
  const { query, sector, type, region, dataSource } = req.query;

  const conditions = [];
  const params = [];

  if (query) {
    conditions.push('(a.ticker LIKE ? OR a.name LIKE ?)');
    params.push(`%${query}%`, `%${query}%`);
  }

  if (sector) {
    conditions.push('a.sector = ?');
    params.push(sector);
  }

  if (type) {
    conditions.push('a.type = ?');
    params.push(type.toUpperCase());
  }

  if (region) {
    conditions.push('a.region = ?');
    params.push(region);
  }

  if (dataSource) {
    conditions.push('a.dataSource = ?');
    params.push(dataSource.toUpperCase());
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const assets = db.prepare(`
    SELECT a.*,
           COALESCE(q.quotesCount, 0) AS quotesCount,
           q.oldestQuote,
           q.newestQuote
    FROM assets a
    LEFT JOIN (
      SELECT ticker,
             COUNT(*) as quotesCount,
             MIN(date) as oldestQuote,
             MAX(date) as newestQuote
      FROM asset_quotes
      GROUP BY ticker
    ) q ON q.ticker = a.ticker
    ${whereClause}
    ORDER BY a.ticker ASC
  `).all(...params);

  return res.json({
    success: true,
    count: assets.length,
    assets
  });
});

/**
 * POST /api/assets/sync-all-history
 * Bulk download of 5Y historical daily quotes for all assets in the catalog.
 */
router.post('/sync-all-history', async (req, res) => {
  try {
    const delayMs = req.body && req.body.delayMs !== undefined ? Number(req.body.delayMs) : 150;
    const result = await syncAllAssetsHistorical(delayMs);

    broadcastMarketUpdate({
      reason: 'HISTORY_SYNC',
      succeeded: result.succeeded,
      total: result.total
    });

    return res.json({
      success: true,
      message: `Download storico 5Y completato: ${result.succeeded}/${result.total} titoli con ${result.totalPoints} punti memorizzati.`,
      ...result
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/assets/:ticker
 * Retrieves single asset details.
 */
router.get('/:ticker', (req, res) => {
  const ticker = req.params.ticker.toUpperCase().trim();
  const asset = db.prepare(`
    SELECT a.*,
           COALESCE(q.quotesCount, 0) AS quotesCount,
           q.oldestQuote,
           q.newestQuote
    FROM assets a
    LEFT JOIN (
      SELECT ticker,
             COUNT(*) as quotesCount,
             MIN(date) as oldestQuote,
             MAX(date) as newestQuote
      FROM asset_quotes
      WHERE ticker = ?
    ) q ON q.ticker = a.ticker
    WHERE a.ticker = ?
  `).get(ticker, ticker);

  if (!asset) {
    return res.status(404).json({
      success: false,
      error: `Asset con ticker '${ticker}' non trovato.`
    });
  }

  return res.json({
    success: true,
    asset
  });
});

/**
 * GET /api/assets/:ticker/quotes
 * Retrieves historical quotes cache for an asset with aggregate statistics.
 */
router.get('/:ticker/quotes', (req, res) => {
  const ticker = req.params.ticker.toUpperCase().trim();
  const asset = db.prepare('SELECT * FROM assets WHERE ticker = ?').get(ticker);

  if (!asset) {
    return res.status(404).json({
      success: false,
      error: `Titolo '${ticker}' non trovato nel catalogo.`
    });
  }

  const stats = db.prepare(`
    SELECT COUNT(*) as count,
           MIN(date) as minDate,
           MAX(date) as maxDate,
           MIN(close) as minPrice,
           MAX(close) as maxPrice,
           (SELECT close FROM asset_quotes WHERE ticker = ? ORDER BY date DESC LIMIT 1) as latestPrice
    FROM asset_quotes
    WHERE ticker = ?
  `).get(ticker, ticker);

  const limit = req.query.limit ? Math.min(5000, parseInt(req.query.limit, 10)) : 2000;
  const quotes = db.prepare(`
    SELECT date, close, volume, source, updatedAt
    FROM asset_quotes
    WHERE ticker = ?
    ORDER BY date DESC
    LIMIT ?
  `).all(ticker, limit);

  return res.json({
    success: true,
    asset,
    stats: {
      count: stats.count || 0,
      minDate: stats.minDate || null,
      maxDate: stats.maxDate || null,
      minPrice: stats.minPrice || 0,
      maxPrice: stats.maxPrice || 0,
      latestPrice: stats.latestPrice || asset.currentPrice || 0
    },
    quotes
  });
});

/**
 * POST /api/assets
 * Upserts an asset into the catalog with data source configuration.
 */
router.post('/', (req, res) => {
  const {
    ticker,
    name,
    type = 'EQUITY',
    exchange = '',
    currency = 'EUR',
    currentPrice = 0.0,
    sector = 'Unclassified',
    region = 'Global',
    country = '',
    riskCategory = 'MEDIUM',
    targetPrice = null,
    stopLoss = null,
    dividendYield = 0.0,
    dataSource = 'YAHOO',
    pe = null
  } = req.body || {};

  if (!ticker || typeof ticker !== 'string') {
    return res.status(400).json({ success: false, error: 'Ticker obbligatorio.' });
  }

  const cleanTicker = ticker.toUpperCase().trim();
  const cleanName = (name || cleanTicker).trim();
  const validSource = ['YAHOO', 'BORSA_ITALIANA', 'GOOGLE', 'MANUAL', 'DELISTED'].includes(dataSource.toUpperCase())
    ? dataSource.toUpperCase()
    : 'YAHOO';

  const stmt = db.prepare(`
    INSERT INTO assets (
      ticker, name, type, exchange, currency, currentPrice,
      sector, region, country, riskCategory, targetPrice, stopLoss, dividendYield,
      dataSource, pe, updatedAt
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(ticker) DO UPDATE SET
      name = excluded.name,
      type = excluded.type,
      exchange = excluded.exchange,
      currency = excluded.currency,
      currentPrice = excluded.currentPrice,
      sector = excluded.sector,
      region = excluded.region,
      country = excluded.country,
      riskCategory = excluded.riskCategory,
      targetPrice = excluded.targetPrice,
      stopLoss = excluded.stopLoss,
      dividendYield = excluded.dividendYield,
      dataSource = excluded.dataSource,
      pe = excluded.pe,
      updatedAt = datetime('now')
  `);

  stmt.run(
    cleanTicker,
    cleanName,
    type.toUpperCase(),
    exchange,
    currency.toUpperCase(),
    Number(currentPrice) || 0.0,
    sector,
    region,
    country,
    riskCategory.toUpperCase(),
    targetPrice ? Number(targetPrice) : null,
    stopLoss ? Number(stopLoss) : null,
    Number(dividendYield) || 0.0,
    validSource,
    pe ? Number(pe) : null
  );

  const saved = db.prepare('SELECT * FROM assets WHERE ticker = ?').get(cleanTicker);

  // Download realtime quote and ensure 5Y historical quotes una tantum if not manual and not delisted
  if (validSource !== 'MANUAL' && validSource !== 'DELISTED') {
    fetchUnifiedQuote(cleanTicker)
      .catch(e => console.warn(`[Asset Create] Realtime quote fetch failed for ${cleanTicker}:`, e.message));
    ensureHistoricalQuotesIfMissing(cleanTicker)
      .catch(e => console.warn(`[Asset Create] Historical quotes fetch failed for ${cleanTicker}:`, e.message));
  }

  return res.json({
    success: true,
    asset: saved
  });
});

/**
 * PUT /api/assets/:ticker
 * Updates asset settings including data source, name, type, sector, etc.
 */
router.put('/:ticker', (req, res) => {
  const ticker = req.params.ticker.toUpperCase().trim();
  const existing = db.prepare('SELECT * FROM assets WHERE ticker = ?').get(ticker);

  if (!existing) {
    return res.status(404).json({ success: false, error: `Titolo '${ticker}' non trovato.` });
  }

  const {
    name,
    type,
    exchange,
    currency,
    currentPrice,
    sector,
    region,
    country,
    riskCategory,
    targetPrice,
    stopLoss,
    dividendYield,
    dataSource,
    pe
  } = req.body || {};

  const cleanName = name !== undefined ? String(name).trim() : existing.name;
  const cleanType = type !== undefined ? String(type).toUpperCase() : existing.type;
  const cleanExchange = exchange !== undefined ? String(exchange).trim() : existing.exchange;
  const cleanCurrency = currency !== undefined ? String(currency).toUpperCase() : existing.currency;
  const cleanPrice = currentPrice !== undefined ? Number(currentPrice) || 0.0 : existing.currentPrice;
  const cleanSector = sector !== undefined ? String(sector) : existing.sector;
  const cleanRegion = region !== undefined ? String(region) : existing.region;
  const cleanCountry = country !== undefined ? String(country) : existing.country;
  const cleanRisk = riskCategory !== undefined ? String(riskCategory).toUpperCase() : existing.riskCategory;
  const cleanTarget = targetPrice !== undefined ? (targetPrice ? Number(targetPrice) : null) : existing.targetPrice;
  const cleanStop = stopLoss !== undefined ? (stopLoss ? Number(stopLoss) : null) : existing.stopLoss;
  const cleanDiv = dividendYield !== undefined ? Number(dividendYield) || 0.0 : existing.dividendYield;
  const cleanPe = pe !== undefined ? (pe ? Number(pe) : null) : existing.pe;

  let cleanSource = existing.dataSource || 'YAHOO';
  if (dataSource !== undefined) {
    cleanSource = ['YAHOO', 'BORSA_ITALIANA', 'GOOGLE', 'MANUAL', 'DELISTED'].includes(String(dataSource).toUpperCase())
      ? String(dataSource).toUpperCase()
      : cleanSource;
  }

  const isCustomManaged = cleanSource === 'DELISTED' || cleanSource === 'MANUAL';

  db.prepare(`
    UPDATE assets
    SET name = ?,
        type = ?,
        exchange = ?,
        currency = ?,
        currentPrice = ?,
        sector = ?,
        region = ?,
        country = ?,
        riskCategory = ?,
        targetPrice = ?,
        stopLoss = ?,
        dividendYield = ?,
        dataSource = ?,
        pe = ?,
        lastSyncStatus = CASE WHEN ? THEN ? ELSE lastSyncStatus END,
        lastSyncError = CASE WHEN ? THEN NULL ELSE lastSyncError END,
        historicalSyncStatus = CASE WHEN ? THEN ? ELSE historicalSyncStatus END,
        historicalSyncError = CASE WHEN ? THEN NULL ELSE historicalSyncError END,
        updatedAt = datetime('now')
    WHERE ticker = ?
  `).run(
    cleanName,
    cleanType,
    cleanExchange,
    cleanCurrency,
    cleanPrice,
    cleanSector,
    cleanRegion,
    cleanCountry,
    cleanRisk,
    cleanTarget,
    cleanStop,
    cleanDiv,
    cleanSource,
    cleanPe,
    isCustomManaged ? 1 : 0,
    cleanSource,
    isCustomManaged ? 1 : 0,
    isCustomManaged ? 1 : 0,
    cleanSource,
    isCustomManaged ? 1 : 0,
    ticker
  );

  const updated = db.prepare('SELECT * FROM assets WHERE ticker = ?').get(ticker);
  return res.json({
    success: true,
    asset: updated
  });
});

/**
 * PUT /api/assets/:ticker/classification
 * Rapidly updates type, sector, and region for an asset.
 */
router.put('/:ticker/classification', (req, res) => {
  const ticker = req.params.ticker.toUpperCase().trim();
  const { type, sector, region } = req.body || {};

  const existing = db.prepare('SELECT * FROM assets WHERE ticker = ?').get(ticker);
  if (!existing) {
    return res.status(404).json({ success: false, error: `Titolo '${ticker}' non trovato.` });
  }

  const cleanType = type !== undefined ? String(type).toUpperCase() : existing.type;
  const cleanSector = sector !== undefined ? String(sector) : existing.sector;
  const cleanRegion = region !== undefined ? String(region) : existing.region;

  db.prepare(`
    UPDATE assets
    SET type = ?, sector = ?, region = ?, updatedAt = datetime('now')
    WHERE ticker = ?
  `).run(cleanType, cleanSector, cleanRegion, ticker);

  const updated = db.prepare('SELECT * FROM assets WHERE ticker = ?').get(ticker);
  return res.json({
    success: true,
    asset: updated
  });
});

/**
 * POST /api/assets/:ticker/sync-quote
 * Refreshes live real-time price using the configured dataSource.
 */
router.post('/:ticker/sync-quote', async (req, res) => {
  const ticker = req.params.ticker.toUpperCase().trim();
  try {
    const asset = db.prepare('SELECT * FROM assets WHERE ticker = ?').get(ticker);
    if (!asset) {
      return res.status(404).json({
        success: false,
        error: `Titolo '${ticker}' non trovato nel catalogo.`
      });
    }

    if (asset.dataSource === 'DELISTED' || asset.dataSource === 'MANUAL') {
      return res.json({
        success: true,
        message: `Titolo '${ticker}' è contrassegnato come ${asset.dataSource}. Aggiornamento quotazioni live disattivato.`,
        quote: {
          ticker,
          name: asset.name,
          currentPrice: asset.currentPrice,
          changePercent: asset.dataSource === 'DELISTED' ? 0 : (asset.changePercent || 0),
          changeValue: asset.dataSource === 'DELISTED' ? 0 : (asset.changeValue || 0),
          source: asset.dataSource,
          isManual: asset.dataSource === 'MANUAL',
          isDelisted: asset.dataSource === 'DELISTED'
        },
        asset
      });
    }

    const quote = await fetchUnifiedQuote(ticker);
    if (!quote) {
      return res.status(404).json({
        success: false,
        error: `Impossibile recuperare quotazione in tempo reale per '${ticker}'.`
      });
    }

    const updated = db.prepare('SELECT * FROM assets WHERE ticker = ?').get(ticker);
    broadcastMarketUpdate({
      reason: 'SINGLE_QUOTE',
      ticker,
      price: quote.currentPrice
    });

    return res.json({
      success: true,
      quote,
      asset: updated
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/assets/:ticker/sync-history
 * Downloads 5-year historical daily quotes for this ticker and saves to asset_quotes.
 */
router.post('/:ticker/sync-history', async (req, res) => {
  const ticker = req.params.ticker.toUpperCase().trim();
  const period = req.body?.period || '5Y';

  try {
    const asset = db.prepare('SELECT * FROM assets WHERE ticker = ?').get(ticker);
    if (asset && (asset.dataSource === 'DELISTED' || asset.dataSource === 'MANUAL')) {
      const count = db.prepare('SELECT COUNT(*) as c FROM asset_quotes WHERE ticker = ?').get(ticker).c;
      return res.json({
        success: true,
        ticker,
        period,
        count,
        message: `Titolo '${ticker}' è contrassegnato come ${asset.dataSource}. Storico esistente mantenuto (${count} punti).`
      });
    }

    const points = await fetchUnifiedHistorical(ticker, period);
    const count = points ? points.length : 0;

    return res.json({
      success: true,
      ticker,
      period,
      count,
      message: `Scaricati e memorizzati ${count} punti storici per ${ticker}.`
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * DELETE /api/assets/:ticker
 * Deletes an asset from the catalog if not used in transactions.
 */
router.delete('/:ticker', (req, res) => {
  const ticker = req.params.ticker.toUpperCase().trim();

  // Check if ticker is used in transactions
  const txCount = db.prepare('SELECT COUNT(*) as c FROM transactions WHERE assetTicker = ?').get(ticker).c;
  if (txCount > 0) {
    return res.status(400).json({
      success: false,
      error: `Impossibile eliminare '${ticker}': sono presenti ${txCount} transazioni collegate.`
    });
  }

  db.prepare('DELETE FROM asset_quotes WHERE ticker = ?').run(ticker);
  const result = db.prepare('DELETE FROM assets WHERE ticker = ?').run(ticker);

  if (result.changes === 0) {
    return res.status(404).json({ success: false, error: `Titolo '${ticker}' non trovato.` });
  }

  return res.json({
    success: true,
    message: `Titolo '${ticker}' rimosso con successo dal catalogo.`
  });
});

module.exports = router;
