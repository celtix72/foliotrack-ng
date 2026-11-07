const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const http = require('http');

const TEST_DB = path.join(__dirname, 'test_settings_market.db');
process.env.DB_PATH = TEST_DB;
process.env.JWT_SECRET = 'test-secret-jwt-very-long-and-secure-settings-test';
process.env.ADMIN_PASSWORD = 'adminSettingsPassword123!';

const { initDb, closeDb, getDb } = require('../src/db');
const app = require('../src/app');

let server;
let baseUrl;
let authToken;

describe('Settings, FX, Assets Market Sources & 5Y History Reconstruction', () => {
  before(async () => {
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    initDb(TEST_DB);

    await new Promise((resolve) => {
      server = http.createServer(app);
      server.listen(0, '127.0.0.1', () => {
        const port = server.address().port;
        baseUrl = `http://127.0.0.1:${port}`;
        resolve();
      });
    });

    // Login as admin
    const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'adminSettingsPassword123!' })
    });
    const loginData = await loginRes.json();
    authToken = loginData.token;
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    closeDb();
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    const walFile = `${TEST_DB}-wal`;
    const shmFile = `${TEST_DB}-shm`;
    if (fs.existsSync(walFile)) fs.unlinkSync(walFile);
    if (fs.existsSync(shmFile)) fs.unlinkSync(shmFile);
  });

  // ==========================================
  // 1. FX CURRENCY RATES (CAMBIO VALUTA)
  // ==========================================
  test('GET /api/currencies returns seeded currency pairs', async () => {
    const res = await fetch(`${baseUrl}/api/currencies`, {
      headers: { Authorization: `Bearer ${authToken}` }
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.success, true);
    assert.ok(Array.isArray(data.rates));
    assert.ok(data.rates.length >= 10);
    const eurUsd = data.rates.find(r => r.pair === 'EUR/USD');
    assert.ok(eurUsd);
    assert.ok(eurUsd.rate > 0);
  });

  test('POST /api/currencies creates a new FX rate pair', async () => {
    const res = await fetch(`${baseUrl}/api/currencies`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`
      },
      body: JSON.stringify({
        from: 'EUR',
        to: 'CAD',
        rate: 1.4850,
        source: 'MANUAL'
      })
    });
    assert.equal(res.status, 201);
    const data = await res.json();
    assert.equal(data.success, true);
    assert.equal(data.rate.pair, 'EUR/CAD');
    assert.equal(data.rate.rate, 1.4850);
  });

  test('PUT /api/currencies/:pair updates an existing FX pair rate', async () => {
    const res = await fetch(`${baseUrl}/api/currencies/${encodeURIComponent('EUR/CAD')}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`
      },
      body: JSON.stringify({
        rate: 1.5120,
        source: 'MANUAL'
      })
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.success, true);
    assert.equal(data.rate.rate, 1.5120);
  });

  test('DELETE /api/currencies/:pair removes the currency pair', async () => {
    const res = await fetch(`${baseUrl}/api/currencies/${encodeURIComponent('EUR/CAD')}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${authToken}` }
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.success, true);

    // Verify deletion
    const getRes = await fetch(`${baseUrl}/api/currencies`, {
      headers: { Authorization: `Bearer ${authToken}` }
    });
    const getData = await getRes.json();
    const found = getData.rates.find(r => r.pair === 'EUR/CAD');
    assert.equal(found, undefined);
  });

  test('POST /api/currencies/sync triggers bulk synchronization', async () => {
    const res = await fetch(`${baseUrl}/api/currencies/sync`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${authToken}` }
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.success, true);
    assert.ok(data.total >= 10);
  });

  // ==========================================
  // 2. ASSETS & MARKET DATA SOURCES (YAHOO, BORSA, GOOGLE, MANUAL)
  // ==========================================
  test('POST /api/assets creates an asset with custom dataSource', async () => {
    const res = await fetch(`${baseUrl}/api/assets`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`
      },
      body: JSON.stringify({
        ticker: 'IT0005240830',
        name: 'BTP 2.8% 01/12/2028',
        type: 'BOND',
        currency: 'EUR',
        currentPrice: 99.45,
        dataSource: 'BORSA_ITALIANA',
        sector: 'Financials',
        region: 'Europe'
      })
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.success, true);
    assert.equal(data.asset.ticker, 'IT0005240830');
    assert.equal(data.asset.dataSource, 'BORSA_ITALIANA');
  });

  test('PUT /api/assets/:ticker updates dataSource to MANUAL or GOOGLE', async () => {
    const res = await fetch(`${baseUrl}/api/assets/IT0005240830`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`
      },
      body: JSON.stringify({
        dataSource: 'MANUAL',
        currentPrice: 100.15
      })
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.success, true);
    assert.equal(data.asset.dataSource, 'MANUAL');
    assert.equal(data.asset.currentPrice, 100.15);
  });

  test('GET /api/assets joins asset_quotes stats and supports dataSource filter', async () => {
    const res = await fetch(`${baseUrl}/api/assets?dataSource=MANUAL`, {
      headers: { Authorization: `Bearer ${authToken}` }
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.success, true);
    assert.ok(data.assets.length >= 1);
    assert.equal(data.assets[0].ticker, 'IT0005240830');
    assert.equal(data.assets[0].dataSource, 'MANUAL');
    assert.equal(typeof data.assets[0].quotesCount, 'number');
  });

  test('PUT /api/assets/:ticker sets dataSource to DELISTED and skips updates while preserving history', async () => {
    // 1. Set asset to DELISTED
    const putRes = await fetch(`${baseUrl}/api/assets/IT0005240830`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`
      },
      body: JSON.stringify({
        dataSource: 'DELISTED',
        currentPrice: 100.15
      })
    });
    assert.equal(putRes.status, 200);
    const putData = await putRes.json();
    assert.equal(putData.success, true);
    assert.equal(putData.asset.dataSource, 'DELISTED');
    assert.equal(putData.asset.lastSyncStatus, 'DELISTED');
    assert.equal(putData.asset.lastSyncError, null);

    // 2. Query filter with dataSource=DELISTED
    const filterRes = await fetch(`${baseUrl}/api/assets?dataSource=DELISTED`, {
      headers: { Authorization: `Bearer ${authToken}` }
    });
    assert.equal(filterRes.status, 200);
    const filterData = await filterRes.json();
    assert.equal(filterData.success, true);
    const delistedAsset = filterData.assets.find(a => a.ticker === 'IT0005240830');
    assert.ok(delistedAsset, 'Asset must be returned by DELISTED filter');
    assert.equal(delistedAsset.dataSource, 'DELISTED');

    // 3. POST sync-quote returns message and does NOT scrape external market
    const syncRes = await fetch(`${baseUrl}/api/assets/IT0005240830/sync-quote`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${authToken}` }
    });
    assert.equal(syncRes.status, 200);
    const syncData = await syncRes.json();
    assert.equal(syncData.success, true);
    assert.equal(syncData.quote.source, 'DELISTED');
    assert.equal(syncData.quote.isDelisted, true);
    assert.equal(syncData.asset.currentPrice, 100.15);

    // 4. POST sync-history preserves cached quotes without error
    const histRes = await fetch(`${baseUrl}/api/assets/IT0005240830/sync-history`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`
      },
      body: JSON.stringify({ period: '5Y' })
    });
    assert.equal(histRes.status, 200);
    const histData = await histRes.json();
    assert.equal(histData.success, true);
    assert.ok(histData.message.includes('DELISTED'));

    // Revert to MANUAL for remaining tests
    await fetch(`${baseUrl}/api/assets/IT0005240830`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`
      },
      body: JSON.stringify({ dataSource: 'MANUAL' })
    });
  });

  // ==========================================
  // 3. TAXONOMY & RAPID CLASSIFICATION
  // ==========================================
  test('PUT /api/assets/:ticker/classification updates taxonomy and GET /api/assets/classifications recalculates', async () => {
    // 1. Rapid classification update
    const putRes = await fetch(`${baseUrl}/api/assets/IT0005240830/classification`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`
      },
      body: JSON.stringify({
        type: 'BOND',
        sector: 'Government',
        region: 'Europe'
      })
    });
    assert.equal(putRes.status, 200);
    const putData = await putRes.json();
    assert.equal(putData.success, true);
    assert.equal(putData.asset.sector, 'Government');

    // 2. Check summary distribution
    const getRes = await fetch(`${baseUrl}/api/assets/classifications`, {
      headers: { Authorization: `Bearer ${authToken}` }
    });
    assert.equal(getRes.status, 200);
    const classData = await getRes.json();
    assert.equal(classData.success, true);
    assert.ok(classData.classifications.bySector['Government']);
    assert.ok(classData.classifications.byType['BOND']);
    assert.ok(classData.classifications.byRegion['Europe']);
  });

  // ==========================================
  // 4. MARKET DATA CACHE, 5Y SYNC & RECONSTRUCTION
  // ==========================================
  test('POST /api/assets/:ticker/sync-quote updates quote respecting dataSource', async () => {
    // For MANUAL asset, sync-quote should gracefully retain or return manual price without network overwrite
    const res = await fetch(`${baseUrl}/api/assets/IT0005240830/sync-quote`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${authToken}` }
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.success, true);
    assert.equal(data.asset.dataSource, 'MANUAL');
    assert.equal(data.quote.source, 'MANUAL');
    assert.equal(data.quote.isManual, true);
  });

  test('POST /api/assets/:ticker/sync-history and /api/assets/sync-all-history', async () => {
    const res = await fetch(`${baseUrl}/api/assets/IT0005240830/sync-history`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`
      },
      body: JSON.stringify({ period: '5y' })
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.success, true);
    assert.ok(data.message.includes('MANUAL'));
    assert.equal(typeof data.count, 'number');

    // Bulk history sync test
    const bulkRes = await fetch(`${baseUrl}/api/assets/sync-all-history`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`
      },
      body: JSON.stringify({ delayMs: 10 })
    });
    assert.equal(bulkRes.status, 200);
    const bulkData = await bulkRes.json();
    assert.equal(bulkData.success, true);
    assert.ok(bulkData.total >= 1);
  });

  test('GET /api/market/status returns cache metrics and provider status', async () => {
    const res = await fetch(`${baseUrl}/api/market/status`, {
      headers: { Authorization: `Bearer ${authToken}` }
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.success, true);
    assert.ok(Array.isArray(data.providers));
    assert.ok(data.cache);
    assert.equal(typeof data.cache.totalQuotes, 'number');
    assert.ok(data.fx);
    assert.ok(data.fx.totalPairs >= 10);
  });

  test('POST /api/market/reconstruct-history reconstructs 5Y daily NAV for portfolios', async () => {
    const db = getDb();

    // 1. Create a test portfolio
    const pInfo = db.prepare(`
      INSERT INTO portfolios (name, type, currency, costBasisMethod, startDate, initialCash, currentCash, totalValue, color, include_in_totals)
      VALUES ('Portafoglio 5Y Test', 'Trading', 'EUR', 'FIFO', '2023-01-01', 10000, 5000, 10000, '#357941', 1)
    `).run();
    const portfolioId = pInfo.lastInsertRowid;

    // 2. Add sample transactions
    db.prepare(`
      INSERT INTO transactions (portfolioId, assetTicker, type, date, quantity, price, amount, commission, notes)
      VALUES (?, 'IT0005240830', 'BUY', '2023-01-10', 50, 100, 5000, 0, 'Test purchase')
    `).run(portfolioId);

    // 3. Add sample historical quotes in asset_quotes
    const insertQuote = db.prepare(`
      INSERT OR REPLACE INTO asset_quotes (ticker, date, close, volume, source)
      VALUES (?, ?, ?, ?, ?)
    `);
    insertQuote.run('IT0005240830', '2023-01-10', 100, 1000, 'TEST');
    insertQuote.run('IT0005240830', '2023-06-15', 102, 1000, 'TEST');
    insertQuote.run('IT0005240830', '2024-01-10', 104, 1000, 'TEST');

    // 4. Trigger 5Y reconstruction
    const res = await fetch(`${baseUrl}/api/market/reconstruct-history`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`
      },
      body: JSON.stringify({ portfolioId, daysBack: 1000 })
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.success, true);
    assert.ok(data.pointsReconstructed > 0);

    // 5. Verify portfolio_history entries exist
    const historyRows = db.prepare('SELECT * FROM portfolio_history WHERE portfolioId = ? ORDER BY date ASC').all(portfolioId);
    assert.ok(historyRows.length > 0);
    assert.ok(historyRows[0].totalValue > 0);
  });

  test('POST /api/market/clear-cache purges quotes older than 5 years', async () => {
    const res = await fetch(`${baseUrl}/api/market/clear-cache`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${authToken}` }
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.success, true);
    assert.ok(data.message.includes('Pulizia completata'));
  });

  // ==========================================
  // 5. UI SERVING & RESPONSIVE VIEWS
  // ==========================================
  test('GET /settings serves desktop view with all 8 subsections', async () => {
    const res = await fetch(`${baseUrl}/settings`, {
      headers: {
        Cookie: `token=${authToken}`,
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)'
      }
    });
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.ok(html.includes('Cambio Valuta FX'));
    assert.ok(html.includes('Titoli & Asset'));
    assert.ok(html.includes('Classificazioni'));
    assert.ok(html.includes('Dati di Mercato & 5Y'));
    assert.ok(html.includes('Ricostruisci Andamento Storico Portafoglio (5Y)'));
    assert.ok(html.includes('data-settings-tab="fx"'));
    assert.ok(html.includes('quotesHistoryModal'));
    assert.ok(html.includes('syncFrequencyInput'));
    assert.ok(html.includes('chart.umd.min.js'));
  });

  // ==========================================
  // 6. HISTORICAL QUOTES CONSULTATION & SCHEDULE FREQUENCY
  // ==========================================
  test('GET /api/assets/:ticker/quotes returns historical quotes and stats', async () => {
    const res = await fetch(`${baseUrl}/api/assets/IT0005240830/quotes`, {
      headers: { Authorization: `Bearer ${authToken}` }
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.success, true);
    assert.equal(data.asset.ticker, 'IT0005240830');
    assert.ok(data.stats);
    assert.ok(data.stats.count >= 3);
    assert.ok(data.stats.minPrice <= data.stats.maxPrice);
    assert.ok(Array.isArray(data.quotes));
    assert.ok(data.quotes.length >= 3);
    assert.ok(data.quotes[0].date);
    assert.ok(data.quotes[0].close > 0);
  });

  test('GET and PUT /api/market/schedule configures realtime sync frequency', async () => {
    // 1. Get initial schedule (default 30 minutes)
    const getRes = await fetch(`${baseUrl}/api/market/schedule`, {
      headers: { Authorization: `Bearer ${authToken}` }
    });
    assert.equal(getRes.status, 200);
    const getData = await getRes.json();
    assert.equal(getData.success, true);
    assert.ok(getData.frequencyMinutes > 0);

    // 2. Put invalid frequency (< 1)
    const badRes = await fetch(`${baseUrl}/api/market/schedule`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`
      },
      body: JSON.stringify({ frequencyMinutes: 0 })
    });
    assert.equal(badRes.status, 400);

    // 3. Put valid frequency (e.g. 15 minutes)
    const putRes = await fetch(`${baseUrl}/api/market/schedule`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`
      },
      body: JSON.stringify({ frequencyMinutes: 15 })
    });
    assert.equal(putRes.status, 200);
    const putData = await putRes.json();
    assert.equal(putData.success, true);
    assert.equal(putData.frequencyMinutes, 15);
    assert.ok(putData.nextSyncAt);

    // 4. Verify updated schedule via GET
    const verifyRes = await fetch(`${baseUrl}/api/market/schedule`, {
      headers: { Authorization: `Bearer ${authToken}` }
    });
    assert.equal(verifyRes.status, 200);
    const verifyData = await verifyRes.json();
    assert.equal(verifyData.frequencyMinutes, 15);
  });

  test('Asset error status tracking sets alert flag when sync fails', async () => {
    const db = getDb();
    // Simulate error state on an asset
    db.prepare(`
      UPDATE assets
      SET lastSyncStatus = 'ERROR',
          lastSyncError = 'Simulated timeout provider',
          lastSyncAt = datetime('now')
      WHERE ticker = 'IT0005240830'
    `).run();

    const res = await fetch(`${baseUrl}/api/assets/IT0005240830`, {
      headers: { Authorization: `Bearer ${authToken}` }
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.asset.lastSyncStatus, 'ERROR');
    assert.equal(data.asset.lastSyncError, 'Simulated timeout provider');
  });

  test('GET /settings?view=mobile serves mobile view', async () => {
    const res = await fetch(`${baseUrl}/settings?view=mobile`, {
      headers: {
        Cookie: `token=${authToken}`
      }
    });
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.ok(html.includes('FolioTrack Mobile'));
    assert.ok(html.includes('data-settings-tab="market"'));
    assert.ok(html.includes('btn-sync-all-quotes'));
    assert.ok(html.includes('mobile-bottom-nav'));
    assert.ok(html.includes('mobileSettingsSectionSelect'));
  });
});
