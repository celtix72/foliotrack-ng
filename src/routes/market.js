const express = require('express');
const yahoo = require('../services/yahooFinance');
const borsa = require('../services/borsaItaliana');
const google = require('../services/googleFinance');
const marketService = require('../services/marketService');
const { db, setSetting } = require('../db');
const { requireAuth, optionalAuth } = require('../middlewares/authMiddleware');
const { getQuotesSchedulerStatus, setQuoteSyncFrequencyMinutes } = require('../services/schedulerService');
const { recalculateAndReconstructHistoricalPerformance } = require('./history');
const { marketEvents, broadcastMarketUpdate } = require('../services/marketEvents');

const router = express.Router();

/**
 * Default configurations for supported market data providers.
 */
const DEFAULT_PROVIDER_CONFIGS = {
  YAHOO: {
    id: 'YAHOO',
    name: 'Yahoo Finance',
    description: 'Provider primario globale (Azioni, ETF, Crypto, Valute FX)',
    frequencyMinutes: 30,
    marketOpen: '09:00',
    marketClose: '22:00',
    onlyMarketHours: true,
    enabled: true,
    supportsRealtime: true,
    supportsHistorical: true,
    sampleTickers: ['AAPL', 'SWDA.MI', 'BTC-USD', 'EURUSD=X']
  },
  BORSA_ITALIANA: {
    id: 'BORSA_ITALIANA',
    name: 'Borsa Italiana / Euronext Milan',
    description: 'Primario Titoli di Stato, BOT, BTP e Obbligazioni MOT/EuroTLX con ISIN',
    frequencyMinutes: 15,
    marketOpen: '09:00',
    marketClose: '17:30',
    onlyMarketHours: true,
    enabled: true,
    supportsRealtime: true,
    supportsHistorical: true,
    sampleTickers: ['IT0005436693', 'IT0005518524', 'IT0005534141']
  },
  GOOGLE: {
    id: 'GOOGLE',
    name: 'Google Finance',
    description: 'Scraping secondario e fallback realtime per quotazioni istantanee',
    frequencyMinutes: 60,
    marketOpen: '09:00',
    marketClose: '22:00',
    onlyMarketHours: true,
    enabled: true,
    supportsRealtime: true,
    supportsHistorical: false,
    sampleTickers: ['NASDAQ:GOOGL', 'SWDA:BIT', 'ETR:VWCE']
  }
};

/**
 * Retrieves the configuration for a provider, merged with persisted user/admin settings.
 */
function getProviderConfig(providerId) {
  const cleanId = (providerId || '').toUpperCase().trim();
  const defaultConfig = DEFAULT_PROVIDER_CONFIGS[cleanId];
  if (!defaultConfig) return null;

  try {
    const row = db.prepare("SELECT value FROM settings WHERE key = ? LIMIT 1")
      .get(`provider_config_${cleanId}`);
    if (row && row.value) {
      const parsed = JSON.parse(row.value);
      return { ...defaultConfig, ...parsed };
    }
  } catch {
    // fallback to default
  }
  return { ...defaultConfig };
}

/**
 * Persists an updated configuration for a provider.
 */
function saveProviderConfig(providerId, configUpdate) {
  const cleanId = (providerId || '').toUpperCase().trim();
  const current = getProviderConfig(cleanId);
  if (!current) throw new Error(`Provider sconosciuto: ${providerId}`);

  const merged = {
    ...current,
    ...configUpdate,
    id: cleanId
  };

  const adminUser = db.prepare("SELECT id FROM users WHERE role = 'admin' LIMIT 1").get();
  const adminId = adminUser ? adminUser.id : 1;

  setSetting(adminId, `provider_config_${cleanId}`, JSON.stringify(merged));
  return merged;
}

/**
 * Checks whether market is currently open according to provider's opening/closing hours.
 */
function isProviderMarketOpen(config, date = new Date()) {
  if (!config.onlyMarketHours) {
    return { isOpen: true, reason: 'Nessuna restrizione orari mercato' };
  }

  const timeFormatter = new Intl.DateTimeFormat('it-IT', {
    timeZone: 'Europe/Rome',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  });
  const dayFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Rome',
    weekday: 'short'
  });

  const dayOfWeek = dayFormatter.format(date);
  if (['Sat', 'Sun'].includes(dayOfWeek)) {
    return {
      isOpen: false,
      reason: `Mercato chiuso nel fine settimana (${dayOfWeek})`
    };
  }

  const currentHHMM = timeFormatter.format(date);
  const open = config.marketOpen || '09:00';
  const close = config.marketClose || '17:30';

  if (currentHHMM >= open && currentHHMM <= close) {
    return {
      isOpen: true,
      currentHHMM,
      marketOpen: open,
      marketClose: close,
      reason: `Mercato aperto (${open} - ${close}, ora CET: ${currentHHMM})`
    };
  }

  return {
    isOpen: false,
    currentHHMM,
    marketOpen: open,
    marketClose: close,
    reason: `Mercato chiuso (orari: ${open} - ${close}, ora CET: ${currentHHMM})`
  };
}

/**
 * GET /api/market/indices
 * Realtime world indices for Live Ticker Bar (publicly available for UI).
 */
router.get('/indices', async (req, res) => {
  try {
    const force = req.query.force === 'true';
    const config = marketService.getTickerConfig();
    const indices = await marketService.fetchWorldIndices(force);
    return res.json({
      success: true,
      indices,
      refreshSeconds: config.refreshSeconds,
      scrollSpeed: config.scrollSpeed,
      updatedAt: new Date().toISOString()
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

/**
 * GET /api/market/indices-config
 * Retrieves ticker banner configuration and preset catalog.
 */
router.get('/indices-config', (req, res) => {
  try {
    const config = marketService.getTickerConfig();
    return res.json({
      success: true,
      config,
      presets: marketService.PRESET_INDICES
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * PUT /api/market/indices-config
 * Updates ticker banner indices list, scroll speed, and refresh frequency.
 */
router.put('/indices-config', requireAuth, (req, res) => {
  try {
    const newConfig = req.body;
    const saved = marketService.setTickerConfig(newConfig, req.user?.id || 1);
    return res.json({
      success: true,
      message: 'Configurazione barra indici salvata con successo.',
      config: saved
    });
  } catch (err) {
    return res.status(400).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/market/indices-config/reset
 * Resets ticker banner to factory default configuration.
 */
router.post('/indices-config/reset', requireAuth, (req, res) => {
  try {
    const resetConfig = marketService.resetTickerConfig(req.user?.id || 1);
    return res.json({
      success: true,
      message: 'Configurazione barra indici ripristinata ai valori predefiniti.',
      config: resetConfig
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/market/indices/refresh
 * Forces immediate cache purge and refresh for live ticker banner.
 */
router.post('/indices/refresh', async (req, res) => {
  try {
    marketService.invalidateIndicesCache();
    const config = marketService.getTickerConfig();
    const indices = await marketService.fetchWorldIndices(true);
    return res.json({
      success: true,
      message: 'Quotazioni barra indici aggiornate.',
      indices,
      refreshSeconds: config.refreshSeconds,
      scrollSpeed: config.scrollSpeed,
      updatedAt: new Date().toISOString()
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/market/status
 * Returns market data provider statuses and cache metrics.
 */
router.get('/status', requireAuth, (req, res) => {
  try {
    const stats = db.prepare(`
      SELECT COUNT(*) as totalQuotes,
             COUNT(DISTINCT ticker) as distinctTickers,
             MIN(date) as oldestDate,
             MAX(date) as newestDate
      FROM asset_quotes
    `).get();

    const assetsWithSource = db.prepare(`
      SELECT COALESCE(dataSource, 'YAHOO') as source, COUNT(*) as count
      FROM assets
      GROUP BY source
    `).all();

    const fxStats = db.prepare(`
      SELECT COUNT(*) as totalPairs, MAX(updatedAt) as lastFxUpdate
      FROM currency_rates
    `).get();

    const failedSync = db.prepare(`
      SELECT COUNT(*) as count
      FROM assets
      WHERE lastSyncStatus = 'ERROR' OR historicalSyncStatus = 'ERROR'
    `).get();

    const providerList = Object.keys(DEFAULT_PROVIDER_CONFIGS).map(id => {
      const cfg = getProviderConfig(id);
      return {
        ...cfg,
        marketStatus: isProviderMarketOpen(cfg)
      };
    });

    return res.json({
      success: true,
      providers: providerList,
      cache: {
        totalQuotes: stats.totalQuotes || 0,
        distinctTickers: stats.distinctTickers || 0,
        oldestDate: stats.oldestDate || null,
        newestDate: stats.newestDate || null,
        defaultHistoricalPeriod: '5Y (5 Anni)'
      },
      sourcesDistribution: assetsWithSource,
      fx: fxStats,
      scheduler: getQuotesSchedulerStatus(),
      failedAssetsCount: failedSync?.count || 0
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/market/schedule
 * Retrieves the quotes sync scheduler status & configured frequency.
 */
router.get('/schedule', requireAuth, (req, res) => {
  try {
    const status = getQuotesSchedulerStatus();
    return res.json({
      success: true,
      ...status
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/market/stream
 * Server-Sent Events (SSE) stream broadcasting real-time market sync notifications.
 * Allows client dashboards to immediately react and refresh widgets after market quotes are re-read.
 */
router.get('/stream', optionalAuth, (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  if (typeof res.flushHeaders === 'function') {
    res.flushHeaders();
  }

  // Initial connection handshake
  res.write(`data: ${JSON.stringify({ type: 'CONNECTED', timestamp: new Date().toISOString() })}\n\n`);

  const onUpdate = (eventData) => {
    try {
      res.write(`data: ${JSON.stringify(eventData)}\n\n`);
    } catch {}
  };

  marketEvents.on('market-updated', onUpdate);

  // Periodic heartbeat every 20 seconds to keep connection open through reverse proxies
  const heartbeat = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch {}
  }, 20000);

  req.on('close', () => {
    clearInterval(heartbeat);
    marketEvents.off('market-updated', onUpdate);
  });
});

/**
 * PUT /api/market/schedule
 * Updates the realtime quotes sync frequency in minutes (default: 30).
 */
router.put('/schedule', requireAuth, (req, res) => {
  try {
    const { frequencyMinutes } = req.body || {};
    const minutes = parseInt(frequencyMinutes, 10);
    if (!minutes || isNaN(minutes) || minutes < 1) {
      return res.status(400).json({
        success: false,
        error: 'La frequenza deve essere un numero intero positivo maggiore o uguale a 1 minuto.'
      });
    }

    setSetting(req.user.id, 'quote_sync_frequency_minutes', minutes);
    setQuoteSyncFrequencyMinutes(minutes);

    const status = getQuotesSchedulerStatus();
    return res.json({
      success: true,
      message: `Frequenza di aggiornamento realtime configurata a ${minutes} minuti.`,
      ...status
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/market/search
 * Multi-provider search endpoint (Yahoo Finance + ISIN detection).
 */
router.get('/search', optionalAuth, async (req, res) => {
  const query = req.query.q || req.query.query;
  if (!query || typeof query !== 'string') {
    return res.json({ success: true, results: [] });
  }

  const cleanQuery = query.trim();

  // If query is an ISIN, try Borsa Italiana first
  if (borsa.isIsin(cleanQuery)) {
    try {
      const borsaQuote = await borsa.fetchRealtimeQuote(cleanQuery);
      if (borsaQuote) {
        return res.json({
          success: true,
          results: [{
            ticker: borsaQuote.ticker,
            name: borsaQuote.name,
            type: borsaQuote.type,
            exchange: borsaQuote.exchange,
            currency: borsaQuote.currency,
            price: borsaQuote.currentPrice
          }]
        });
      }
    } catch {}
  }

  try {
    const results = await yahoo.search(cleanQuery);
    return res.json({
      success: true,
      results
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

/**
 * GET /api/market/quote/:ticker
 * Retrieves real-time quote for a specific ticker/ISIN.
 */
router.get('/quote/:ticker', optionalAuth, async (req, res) => {
  const ticker = req.params.ticker;
  const exchange = req.query.exchange;

  try {
    const quote = await marketService.fetchUnifiedQuote(ticker, exchange);
    if (!quote) {
      return res.status(404).json({
        success: false,
        error: `Quotazione non trovata per il titolo '${ticker}'.`
      });
    }

    return res.json({
      success: true,
      quote
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

/**
 * GET /api/market/chart/:ticker
 * Retrieves historical close prices/candlesticks for charting. Defaults to 5Y.
 */
router.get('/chart/:ticker', optionalAuth, async (req, res) => {
  const ticker = req.params.ticker;
  const period = req.query.period || req.query.range || '1Y';

  try {
    let points = await marketService.fetchUnifiedHistorical(ticker, period);

    // Fallback to asset_quotes cache if live provider returned empty
    if (!points || points.length === 0) {
      let daysBack = 365;
      if (period === '1M') daysBack = 30;
      else if (period === '3M') daysBack = 90;
      else if (period === '6M') daysBack = 180;
      else if (period === '1Y') daysBack = 365;
      else if (period === '5Y') daysBack = 1825;
      else if (period === 'ALL') daysBack = 3650;

      points = db.prepare(`
        SELECT date, close, volume FROM asset_quotes
        WHERE ticker = ? AND date >= date('now', '-' || ? || ' days')
        ORDER BY date ASC
      `).all(ticker, daysBack);
    }

    // Ensure latest quote from assets table (updated today) is included as the final point
    try {
      const asset = db.prepare('SELECT currentPrice, previousClose, quoteDate, currency FROM assets WHERE ticker = ?').get(ticker.toUpperCase());
      if (asset && asset.currentPrice > 0 && points && points.length > 0) {
        const lastPt = points[points.length - 1];
        const todayStr = new Date().toISOString().split('T')[0];
        const quoteDate = asset.quoteDate ? String(asset.quoteDate).slice(0, 10) : todayStr;
        
        if (lastPt.date < quoteDate) {
          points.push({
            date: quoteDate,
            open: lastPt.close || asset.previousClose || asset.currentPrice,
            high: Math.max(lastPt.close || asset.currentPrice, asset.currentPrice),
            low: Math.min(lastPt.close || asset.currentPrice, asset.currentPrice),
            close: asset.currentPrice,
            volume: 0,
            source: 'LIVE_TODAY'
          });
        } else if (lastPt.date === quoteDate && asset.currentPrice !== lastPt.close) {
          lastPt.close = asset.currentPrice;
        }
      }
    } catch {}

    return res.json({
      success: true,
      ticker: ticker.toUpperCase(),
      period,
      count: (points || []).length,
      points: points || [],
      data: points || []
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

/**
 * POST /api/market/update-all
 * Batch price update job for all portfolio assets.
 */
router.post('/update-all', requireAuth, async (req, res) => {
  try {
    const delayMs = req.body && req.body.delayMs !== undefined ? Number(req.body.delayMs) : 150;
    const updateResult = await marketService.updateAllAssetPrices({ delayMs });

    return res.json({
      success: true,
      message: `Aggiornamento completato: ${updateResult.updated}/${updateResult.total} titoli aggiornati.`,
      ...updateResult
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

/**
 * POST /api/market/reconstruct-history
 * Reconstructs daily portfolio NAV snapshots across 5 years and recalculates quantitative performance indicators.
 */
router.post('/reconstruct-history', requireAuth, async (req, res) => {
  try {
    const { portfolioId, daysBack = 1825 } = req.body || {};
    const pId = portfolioId && portfolioId !== 'all' ? parseInt(portfolioId, 10) : null;

    const result = await recalculateAndReconstructHistoricalPerformance(pId, {
      daysBack: Number(daysBack) || 1825,
      userId: req.user.id,
      userRole: req.user.role
    });

    broadcastMarketUpdate({
      reason: 'RECONSTRUCT_HISTORY',
      portfolioId: pId,
      pointsReconstructed: result.pointsReconstructed
    });

    return res.json({
      success: true,
      ...result,
      message: `Ricostruzione completata: generati ${result.pointsReconstructed} snapshot storici giornalieri (5Y).`
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/market/clear-cache
 * Purges asset quotes older than 5 years.
 */
router.post('/clear-cache', requireAuth, (req, res) => {
  try {
    const info = db.prepare("DELETE FROM asset_quotes WHERE date < date('now', '-5 years')").run();
    return res.json({
      success: true,
      message: `Pulizia completata: rimossi ${info.changes} punti storici obsoleti (>5Y).`
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/market/providers
 * Returns all market data providers with their configuration and market status.
 */
router.get('/providers', requireAuth, (req, res) => {
  try {
    const providers = Object.keys(DEFAULT_PROVIDER_CONFIGS).map(id => {
      const cfg = getProviderConfig(id);
      return {
        ...cfg,
        marketStatus: isProviderMarketOpen(cfg)
      };
    });

    return res.json({
      success: true,
      providers
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/market/providers/:id
 * Retrieves specific provider configuration and market hours status.
 */
router.get('/providers/:id', requireAuth, (req, res) => {
  try {
    const providerId = (req.params.id || '').toUpperCase().trim();
    const cfg = getProviderConfig(providerId);
    if (!cfg) {
      return res.status(404).json({ success: false, error: `Provider '${providerId}' non trovato.` });
    }

    return res.json({
      success: true,
      provider: {
        ...cfg,
        marketStatus: isProviderMarketOpen(cfg)
      }
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * PUT /api/market/providers/:id
 * Updates provider configuration (frequencyMinutes, marketOpen, marketClose, onlyMarketHours, enabled).
 */
router.put('/providers/:id', requireAuth, (req, res) => {
  const providerId = (req.params.id || '').toUpperCase().trim();
  const cfg = getProviderConfig(providerId);
  if (!cfg) {
    return res.status(404).json({ success: false, error: `Provider '${providerId}' non trovato.` });
  }

  const {
    frequencyMinutes,
    marketOpen,
    marketClose,
    onlyMarketHours,
    enabled
  } = req.body || {};

  const updates = {};

  if (frequencyMinutes !== undefined) {
    const freq = parseInt(frequencyMinutes, 10);
    if (isNaN(freq) || freq < 1) {
      return res.status(400).json({ success: false, error: 'La frequenza deve essere un numero intero positivo maggiore di 0 minuti.' });
    }
    updates.frequencyMinutes = freq;
  }

  if (marketOpen !== undefined) {
    if (!/^\d{2}:\d{2}$/.test(marketOpen)) {
      return res.status(400).json({ success: false, error: 'Orario di apertura non valido. Usa il formato HH:MM (es. 09:00).' });
    }
    updates.marketOpen = marketOpen;
  }

  if (marketClose !== undefined) {
    if (!/^\d{2}:\d{2}$/.test(marketClose)) {
      return res.status(400).json({ success: false, error: 'Orario di chiusura non valido. Usa il formato HH:MM (es. 17:30).' });
    }
    updates.marketClose = marketClose;
  }

  if (onlyMarketHours !== undefined) {
    updates.onlyMarketHours = !!onlyMarketHours;
  }

  if (enabled !== undefined) {
    updates.enabled = !!enabled;
  }

  try {
    const updated = saveProviderConfig(providerId, updates);
    if (updates.frequencyMinutes !== undefined) {
      setSetting(req.user.id, 'quote_sync_frequency_minutes', updates.frequencyMinutes);
      setQuoteSyncFrequencyMinutes(updates.frequencyMinutes);
    }
    const marketStatus = isProviderMarketOpen(updated);
    return res.json({
      success: true,
      message: `Configurazione di ${updated.name} aggiornata con successo.`,
      provider: {
        ...updated,
        marketStatus
      }
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/market/providers/:id/test-quote
 * Tests real-time quote retrieval for a specific ticker/ISIN with latency measurement.
 */
router.post('/providers/:id/test-quote', requireAuth, async (req, res) => {
  const providerId = (req.params.id || '').toUpperCase().trim();
  const { ticker, exchange } = req.body || {};

  if (!ticker || !ticker.trim()) {
    return res.status(400).json({ success: false, error: 'Ticker o codice ISIN obbligatorio per il test.' });
  }

  const cleanTicker = ticker.trim().toUpperCase();
  const cfg = getProviderConfig(providerId);
  if (!cfg) {
    return res.status(404).json({ success: false, error: `Provider '${providerId}' non trovato.` });
  }

  const startTime = Date.now();
  let quote = null;
  let errorMsg = null;

  try {
    if (providerId === 'YAHOO') {
      quote = await yahoo.getQuote(cleanTicker);
    } else if (providerId === 'BORSA_ITALIANA') {
      quote = await borsa.fetchRealtimeQuote(cleanTicker);
    } else if (providerId === 'GOOGLE') {
      quote = await google.fetchQuote(cleanTicker, exchange);
    } else {
      return res.status(400).json({ success: false, error: `Provider ${providerId} non supportato per test.` });
    }
  } catch (err) {
    errorMsg = err.message;
  }

  const durationMs = Date.now() - startTime;
  const isSuccess = !!quote && (quote.currentPrice > 0 || !!quote.name);

  return res.json({
    success: isSuccess,
    provider: cfg.name,
    providerId,
    ticker: cleanTicker,
    durationMs,
    quote: quote || null,
    error: errorMsg || (isSuccess ? null : 'Nessuna quotazione valida restituita dal provider.')
  });
});

/**
 * POST /api/market/providers/:id/test-history
 * Tests historical series retrieval (e.g. 5Y) for a specific ticker/ISIN with latency measurement.
 */
router.post('/providers/:id/test-history', requireAuth, async (req, res) => {
  const providerId = (req.params.id || '').toUpperCase().trim();
  const { ticker, period = '5Y' } = req.body || {};

  if (!ticker || !ticker.trim()) {
    return res.status(400).json({ success: false, error: 'Ticker o codice ISIN obbligatorio per il test.' });
  }

  const cleanTicker = ticker.trim().toUpperCase();
  const cfg = getProviderConfig(providerId);
  if (!cfg) {
    return res.status(404).json({ success: false, error: `Provider '${providerId}' non trovato.` });
  }

  if (!cfg.supportsHistorical) {
    return res.status(400).json({
      success: false,
      providerId,
      error: `Il provider ${cfg.name} supporta solo quotazioni realtime (non supporta serie storiche). Usa Yahoo Finance o Borsa Italiana per i dati storici.`
    });
  }

  const startTime = Date.now();
  let points = [];
  let errorMsg = null;

  try {
    if (providerId === 'YAHOO') {
      let period1 = '2020-01-01';
      const now = new Date();
      if (period === '1M') period1 = new Date(now.setMonth(now.getMonth() - 1)).toISOString().split('T')[0];
      else if (period === '3M') period1 = new Date(now.setMonth(now.getMonth() - 3)).toISOString().split('T')[0];
      else if (period === '6M') period1 = new Date(now.setMonth(now.getMonth() - 6)).toISOString().split('T')[0];
      else if (period === '1Y') period1 = new Date(now.setFullYear(now.getFullYear() - 1)).toISOString().split('T')[0];
      else if (period === '5Y') period1 = new Date(now.setFullYear(now.getFullYear() - 5)).toISOString().split('T')[0];
      else if (/^\d{4}-\d{2}-\d{2}$/.test(period)) period1 = period;

      points = await yahoo.getHistorical(cleanTicker, period1);
    } else if (providerId === 'BORSA_ITALIANA') {
      points = await borsa.fetchHistorical(cleanTicker, period);
    } else {
      return res.status(400).json({ success: false, error: `Provider ${providerId} non supporta test serie storiche.` });
    }
  } catch (err) {
    errorMsg = err.message;
  }

  const durationMs = Date.now() - startTime;
  const isSuccess = Array.isArray(points) && points.length > 0;

  return res.json({
    success: isSuccess,
    provider: cfg.name,
    providerId,
    ticker: cleanTicker,
    period,
    durationMs,
    count: points ? points.length : 0,
    firstDate: points && points.length > 0 ? points[0].date : null,
    lastDate: points && points.length > 0 ? points[points.length - 1].date : null,
    firstPrice: points && points.length > 0 ? points[0].close : null,
    lastPrice: points && points.length > 0 ? points[points.length - 1].close : null,
    samplePoints: points ? points.slice(-5) : [],
    error: errorMsg || (isSuccess ? null : 'Nessun punto storico restituito dal provider per questo ticker.')
  });
});

module.exports = router;
module.exports.getProviderConfig = getProviderConfig;
module.exports.saveProviderConfig = saveProviderConfig;
module.exports.isProviderMarketOpen = isProviderMarketOpen;
module.exports.DEFAULT_PROVIDER_CONFIGS = DEFAULT_PROVIDER_CONFIGS;
