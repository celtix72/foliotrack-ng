const express = require('express');
const router = express.Router();
const { getDb } = require('../db');
const yahooFinance = require('../services/yahooFinance');
const marketService = require('../services/marketService');

/**
 * Computes historical percentage changes for 1W, 1M, 3M, 1Y, 3Y.
 *
 * @param {object} db - SQLite database instance
 * @param {string} ticker - Asset symbol
 * @param {number} currentPrice - Latest available price
 * @returns {object} Percentage changes across 1W, 1M, 3M, 1Y, 3Y
 */
function computePeriodChanges(db, ticker, currentPrice) {
  if (!currentPrice || currentPrice <= 0) {
    return { '1W': null, '1M': null, '3M': null, '1Y': null, '3Y': null };
  }

  const now = new Date();
  const getRefDate = (daysAgo) => {
    const d = new Date(now.getTime() - daysAgo * 24 * 60 * 60 * 1000);
    return d.toISOString().split('T')[0];
  };

  const d1w = getRefDate(7);
  const d1m = getRefDate(30);
  const d3m = getRefDate(90);
  const d1y = getRefDate(365);
  const d3y = getRefDate(1095);

  const stmt = db.prepare(`
    SELECT date, close
    FROM asset_quotes
    WHERE ticker = ? AND date <= ?
    ORDER BY date DESC
    LIMIT 1
  `);

  const p1w = stmt.get(ticker, d1w)?.close;
  const p1m = stmt.get(ticker, d1m)?.close;
  const p3m = stmt.get(ticker, d3m)?.close;
  const p1y = stmt.get(ticker, d1y)?.close;
  const p3y = stmt.get(ticker, d3y)?.close;

  const pct = (oldP) => (oldP && oldP > 0) ? Number((((currentPrice - oldP) / oldP) * 100).toFixed(2)) : null;

  return {
    '1W': pct(p1w),
    '1M': pct(p1m),
    '3M': pct(p3m),
    '1Y': pct(p1y),
    '3Y': pct(p3y)
  };
}

/**
 * GET /api/analysis
 * Returns all equity assets present in portfolios and tracked watchlist assets,
 * with real-time quotes, 1W/1M/3M/1Y/3Y % performance variations, and SL/TP target statuses.
 */
router.get('/', async (req, res) => {
  try {
    const db = getDb();

    // 1. Portfolio Equities (from actual transactions)
    const portfolioEquities = db.prepare(`
      SELECT DISTINCT
        t.assetTicker as ticker,
        COALESCE(a.name, t.assetTicker) as name,
        COALESCE(a.type, 'EQUITY') as type,
        COALESCE(a.currentPrice, 0.0) as currentPrice,
        COALESCE(a.currency, 'EUR') as currency,
        a.previousClose
      FROM transactions t
      JOIN assets a ON t.assetTicker = a.ticker
      WHERE UPPER(a.type) IN ('EQUITY', 'STOCK')
    `).all();

    // 2. Watchlist / Monitored Items
    let watchlistRows = [];
    try {
      watchlistRows = db.prepare(`
        SELECT
          w.ticker,
          w.name as watchlistName,
          w.stopLoss,
          w.takeProfit,
          w.notes,
          w.isMonitored,
          COALESCE(a.name, w.name, w.ticker) as assetName,
          COALESCE(a.type, 'EQUITY') as type,
          COALESCE(a.currentPrice, 0.0) as currentPrice,
          COALESCE(a.currency, 'EUR') as currency,
          a.previousClose
        FROM analysis_watchlist w
        LEFT JOIN assets a ON w.ticker = a.ticker
      `).all();
    } catch (err) {
      console.warn('[Analysis] Watchlist query fallback:', err.message);
    }

    const watchlistMap = new Map();
    for (const w of watchlistRows) {
      watchlistMap.set(w.ticker.toUpperCase(), w);
    }

    const itemsMap = new Map();

    // Add portfolio equities
    for (const eq of portfolioEquities) {
      const sym = eq.ticker.toUpperCase();
      const w = watchlistMap.get(sym);
      itemsMap.set(sym, {
        ticker: sym,
        name: eq.name,
        type: eq.type || 'EQUITY',
        currentPrice: Number(eq.currentPrice) || 0.0,
        currency: eq.currency || 'EUR',
        previousClose: Number(eq.previousClose) || Number(eq.currentPrice) || 0.0,
        inPortfolio: true,
        isMonitored: Boolean(w && w.isMonitored),
        stopLoss: w && w.stopLoss !== null ? Number(w.stopLoss) : null,
        takeProfit: w && w.takeProfit !== null ? Number(w.takeProfit) : null,
        notes: w ? w.notes : null
      });
    }

    // Add standalone monitored assets (not in portfolio)
    for (const w of watchlistRows) {
      const sym = w.ticker.toUpperCase();
      if (!itemsMap.has(sym) && w.isMonitored) {
        itemsMap.set(sym, {
          ticker: sym,
          name: w.assetName || w.watchlistName || sym,
          type: w.type || 'EQUITY',
          currentPrice: Number(w.currentPrice) || 0.0,
          currency: w.currency || 'EUR',
          previousClose: Number(w.previousClose) || Number(w.currentPrice) || 0.0,
          inPortfolio: false,
          isMonitored: true,
          stopLoss: w.stopLoss !== null ? Number(w.stopLoss) : null,
          takeProfit: w.takeProfit !== null ? Number(w.takeProfit) : null,
          notes: w.notes || null
        });
      }
    }

    const assets = Array.from(itemsMap.values()).map(item => {
      const p = item.currentPrice;
      const variations = computePeriodChanges(db, item.ticker, p);

      // Stop Loss status
      let slStatus = 'NORMAL';
      if (item.stopLoss !== null && item.stopLoss > 0 && p > 0) {
        if (p <= item.stopLoss) {
          slStatus = 'TRIGGERED';
        } else if ((p - item.stopLoss) / p <= 0.035) {
          slStatus = 'NEAR';
        }
      }

      // Take Profit status
      let tpStatus = 'NORMAL';
      if (item.takeProfit !== null && item.takeProfit > 0 && p > 0) {
        if (p >= item.takeProfit) {
          tpStatus = 'REACHED';
        } else if ((item.takeProfit - p) / p <= 0.035) {
          tpStatus = 'NEAR';
        }
      }

      return {
        ...item,
        variations,
        slStatus,
        tpStatus
      };
    });

    // Sort: inPortfolio first, then alphabetically by ticker
    assets.sort((a, b) => {
      if (a.inPortfolio !== b.inPortfolio) return a.inPortfolio ? -1 : 1;
      return a.ticker.localeCompare(b.ticker);
    });

    // Compute stats
    const stats = {
      totalEquities: assets.length,
      portfolioCount: assets.filter(x => x.inPortfolio).length,
      monitoredCount: assets.filter(x => x.isMonitored).length,
      slTriggeredCount: assets.filter(x => x.slStatus === 'TRIGGERED').length,
      tpReachedCount: assets.filter(x => x.tpStatus === 'REACHED').length,
      gainers1mCount: assets.filter(x => x.variations['1M'] !== null && x.variations['1M'] > 0).length,
      gainers1yCount: assets.filter(x => x.variations['1Y'] !== null && x.variations['1Y'] > 0).length
    };

    res.json({
      success: true,
      assets,
      stats
    });
  } catch (err) {
    console.error('[Analysis GET Error]', err);
    res.status(500).json({ success: false, error: 'Errore durante il recupero degli asset di analisi: ' + err.message });
  }
});

/**
 * GET /api/analysis/:ticker/fundamentals
 * Returns fundamental analysis metrics from Yahoo Finance with caching.
 */
router.get('/:ticker/fundamentals', async (req, res) => {
  const ticker = (req.params.ticker || '').trim().toUpperCase();
  if (!ticker) {
    return res.status(400).json({ success: false, error: 'Ticker obbligatorio' });
  }

  try {
    const db = getDb();

    // Check cache in database (valid for 4 hours)
    let cached = null;
    try {
      cached = db.prepare(`
        SELECT data, updatedAt,
               ((julianday('now') - julianday(updatedAt)) * 24) as ageHours
        FROM analysis_fundamentals_cache
        WHERE ticker = ?
      `).get(ticker);
    } catch {}

    if (cached && cached.data && cached.ageHours < 4) {
      try {
        const parsed = JSON.parse(cached.data);
        return res.json({
          success: true,
          ticker,
          fundamentals: parsed,
          cachedAt: cached.updatedAt,
          source: 'CACHE'
        });
      } catch {}
    }

    // Fetch live from Yahoo Finance
    const liveFundamentals = await yahooFinance.getFundamentals(ticker);

    if (liveFundamentals) {
      // Upsert into cache
      try {
        db.prepare(`
          INSERT INTO analysis_fundamentals_cache (ticker, data, updatedAt)
          VALUES (?, ?, datetime('now'))
          ON CONFLICT(ticker) DO UPDATE SET
            data = excluded.data,
            updatedAt = datetime('now')
        `).run(ticker, JSON.stringify(liveFundamentals));
      } catch (cacheErr) {
        console.warn('[Analysis] Cache save error:', cacheErr.message);
      }

      return res.json({
        success: true,
        ticker,
        fundamentals: liveFundamentals,
        cachedAt: new Date().toISOString(),
        source: 'LIVE'
      });
    }

    // If live fetch returned null but we have an older cached version, serve that
    if (cached && cached.data) {
      try {
        const parsed = JSON.parse(cached.data);
        return res.json({
          success: true,
          ticker,
          fundamentals: parsed,
          cachedAt: cached.updatedAt,
          source: 'STALE_CACHE'
        });
      } catch {}
    }

    return res.status(404).json({
      success: false,
      error: `Dati fondamentali non disponibili per il ticker ${ticker}. Verifica che il simbolo sia corretto.`
    });
  } catch (err) {
    console.error(`[Analysis Fundamentals Error for ${ticker}]`, err);
    res.status(500).json({ success: false, error: 'Errore recupero fondamentali: ' + err.message });
  }
});

/**
 * POST /api/analysis/watchlist
 * Adds or tracks a new stock in the analysis section with optional SL/TP.
 */
router.post('/watchlist', async (req, res) => {
  const { ticker, name, stopLoss, takeProfit, notes } = req.body || {};
  const cleanTicker = (ticker || '').trim().toUpperCase();

  if (!cleanTicker) {
    return res.status(400).json({ success: false, error: 'Ticker azionario obbligatorio' });
  }

  try {
    const db = getDb();

    // Check if asset exists in catalog; if not, query Yahoo Finance quote & history
    let existingAsset = db.prepare('SELECT * FROM assets WHERE ticker = ?').get(cleanTicker);
    if (!existingAsset) {
      try {
        await marketService.fetchUnifiedQuote(cleanTicker);
        existingAsset = db.prepare('SELECT * FROM assets WHERE ticker = ?').get(cleanTicker);
      } catch (qErr) {
        console.warn('[Analysis Watchlist] Quote lookup warning:', qErr.message);
      }
    }

    // Ensure historical quotes are loaded for 1W/1M/3M/1Y/3Y
    try {
      const quotesCount = db.prepare('SELECT COUNT(*) as c FROM asset_quotes WHERE ticker = ?').get(cleanTicker).c;
      if (quotesCount < 10) {
        await marketService.fetchUnifiedHistorical(cleanTicker, '5Y');
      }
    } catch (hErr) {
      console.warn('[Analysis Watchlist] Historical quotes warning:', hErr.message);
    }

    const slVal = stopLoss !== undefined && stopLoss !== null && stopLoss !== '' ? parseFloat(stopLoss) : null;
    const tpVal = takeProfit !== undefined && takeProfit !== null && takeProfit !== '' ? parseFloat(takeProfit) : null;
    const finalName = name || existingAsset?.name || cleanTicker;

    db.prepare(`
      INSERT INTO analysis_watchlist (ticker, name, stopLoss, takeProfit, notes, isMonitored, updatedAt)
      VALUES (?, ?, ?, ?, ?, 1, datetime('now'))
      ON CONFLICT(ticker) DO UPDATE SET
        name = COALESCE(excluded.name, analysis_watchlist.name),
        stopLoss = excluded.stopLoss,
        takeProfit = excluded.takeProfit,
        notes = excluded.notes,
        isMonitored = 1,
        updatedAt = datetime('now')
    `).run(cleanTicker, finalName, slVal, tpVal, notes || null);

    res.status(201).json({
      success: true,
      ticker: cleanTicker,
      name: finalName,
      stopLoss: slVal,
      takeProfit: tpVal
    });
  } catch (err) {
    console.error('[Analysis Watchlist Post Error]', err);
    res.status(500).json({ success: false, error: 'Errore salvataggio asset monitorato: ' + err.message });
  }
});

/**
 * PUT /api/analysis/:ticker/targets
 * Updates Stop Loss and Take Profit levels for an equity asset.
 */
router.put('/:ticker/targets', async (req, res) => {
  const ticker = (req.params.ticker || '').trim().toUpperCase();
  const { stopLoss, takeProfit, notes } = req.body || {};

  if (!ticker) {
    return res.status(400).json({ success: false, error: 'Ticker obbligatorio' });
  }

  const slVal = stopLoss !== undefined && stopLoss !== null && stopLoss !== '' ? parseFloat(stopLoss) : null;
  const tpVal = takeProfit !== undefined && takeProfit !== null && takeProfit !== '' ? parseFloat(takeProfit) : null;

  try {
    const db = getDb();
    const asset = db.prepare('SELECT name FROM assets WHERE ticker = ?').get(ticker);
    const assetName = asset?.name || ticker;

    db.prepare(`
      INSERT INTO analysis_watchlist (ticker, name, stopLoss, takeProfit, notes, isMonitored, updatedAt)
      VALUES (?, ?, ?, ?, ?, 1, datetime('now'))
      ON CONFLICT(ticker) DO UPDATE SET
        stopLoss = excluded.stopLoss,
        takeProfit = excluded.takeProfit,
        notes = COALESCE(excluded.notes, analysis_watchlist.notes),
        updatedAt = datetime('now')
    `).run(ticker, assetName, slVal, tpVal, notes !== undefined ? notes : null);

    res.json({
      success: true,
      ticker,
      stopLoss: slVal,
      takeProfit: tpVal
    });
  } catch (err) {
    console.error('[Analysis Targets PUT Error]', err);
    res.status(500).json({ success: false, error: 'Errore aggiornamento target SL/TP: ' + err.message });
  }
});

/**
 * DELETE /api/analysis/watchlist/:ticker
 * Removes a monitored asset or resets SL/TP if the asset is in portfolio.
 */
router.delete('/watchlist/:ticker', async (req, res) => {
  const ticker = (req.params.ticker || '').trim().toUpperCase();
  if (!ticker) {
    return res.status(400).json({ success: false, error: 'Ticker obbligatorio' });
  }

  try {
    const db = getDb();
    const isInPortfolio = db.prepare(`
      SELECT COUNT(*) as c
      FROM transactions t
      JOIN assets a ON t.assetTicker = a.ticker
      WHERE t.assetTicker = ? AND UPPER(a.type) IN ('EQUITY', 'STOCK')
    `).get(ticker).c > 0;

    if (isInPortfolio) {
      // If it is in portfolio, do not delete from the view, simply clear SL/TP and monitored flag
      db.prepare(`
        UPDATE analysis_watchlist
        SET isMonitored = 0, stopLoss = NULL, takeProfit = NULL, updatedAt = datetime('now')
        WHERE ticker = ?
      `).run(ticker);
    } else {
      // If it was only a monitored watchlist asset, remove it completely
      db.prepare('DELETE FROM analysis_watchlist WHERE ticker = ?').run(ticker);
    }

    res.json({
      success: true,
      ticker,
      removed: !isInPortfolio,
      targetsCleared: isInPortfolio
    });
  } catch (err) {
    console.error('[Analysis Watchlist DELETE Error]', err);
    res.status(500).json({ success: false, error: 'Errore rimozione asset monitorato: ' + err.message });
  }
});

module.exports = router;
