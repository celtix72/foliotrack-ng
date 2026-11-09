const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const path = require('path');
const fs = require('fs');

process.env.NODE_ENV = 'test';
process.env.ADMIN_USERNAME = 'admin';
process.env.ADMIN_PASSWORD = 'admin123';

const { initDb, closeDb, getDb } = require('../src/db');
const app = require('../src/app');

describe('Stock Analysis & Watchlist Section (Analisi, SL/TP & Fundamentals)', () => {
  let server;
  let baseUrl;
  let authToken;
  let portfolioId;
  const testDbPath = path.join(__dirname, 'test_analysis_section.db');

  before(async () => {
    if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
    initDb(testDbPath);

    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, resolve));
    const port = server.address().port;
    baseUrl = `http://127.0.0.1:${port}`;

    // Login as admin
    const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin123' })
    });
    assert.equal(loginRes.status, 200);
    const loginData = await loginRes.json();
    authToken = loginData.token;

    // Create portfolio and seed transactions with equities
    const db = getDb();
    const pInfo = db.prepare(`
      INSERT INTO portfolios (name, type, currency, initialCash)
      VALUES ('Analisi Test Portfolio', 'Trading', 'EUR', 10000.0)
    `).run();
    portfolioId = pInfo.lastInsertRowid;

    // Seed test equity assets
    db.prepare(`
      INSERT OR REPLACE INTO assets (ticker, name, type, currentPrice, currency)
      VALUES
        ('AAPL', 'Apple Inc.', 'EQUITY', 180.0, 'USD'),
        ('ISP.MI', 'Intesa Sanpaolo', 'EQUITY', 3.50, 'EUR'),
        ('SWDA.MI', 'MSCI World ETF', 'ETF', 90.0, 'EUR')
    `).run();

    // Seed transaction for AAPL and ISP.MI (SWDA is ETF, so excluded from pure equity analysis)
    db.prepare(`
      INSERT INTO transactions (portfolioId, date, type, assetTicker, quantity, price, amount)
      VALUES
        (?, '2024-01-15', 'BUY', 'AAPL', 10, 150.0, 1500.0),
        (?, '2024-02-20', 'BUY', 'ISP.MI', 1000, 3.0, 3000.0),
        (?, '2024-03-01', 'BUY', 'SWDA.MI', 20, 85.0, 1700.0)
    `).run(portfolioId, portfolioId, portfolioId);

    // Seed historical quotes for AAPL to compute variations
    const today = new Date();
    const dateMinus = (d) => new Date(today.getTime() - d * 86400000).toISOString().split('T')[0];

    const quoteStmt = db.prepare(`
      INSERT OR REPLACE INTO asset_quotes (ticker, date, close, volume, source)
      VALUES (?, ?, ?, 1000, 'YAHOO')
    `);

    quoteStmt.run('AAPL', dateMinus(8), 170.0);   // ~1W ago: close = 170 -> variation ~ +5.88%
    quoteStmt.run('AAPL', dateMinus(35), 160.0);  // ~1M ago: close = 160 -> variation ~ +12.5%
    quoteStmt.run('AAPL', dateMinus(95), 150.0);  // ~3M ago: close = 150 -> variation ~ +20.0%
    quoteStmt.run('AAPL', dateMinus(370), 140.0); // ~1Y ago: close = 140 -> variation ~ +28.57%
    quoteStmt.run('AAPL', dateMinus(1100), 120.0);// ~3Y ago: close = 120 -> variation ~ +50.0%
  });

  after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    closeDb();
    if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
  });

  test('GET /analysis serves Desktop HTML with dedicated sidebar menu item and native dialogs', async () => {
    const res = await fetch(`${baseUrl}/analysis?view=desktop`, {
      headers: {
        Authorization: `Bearer ${authToken}`,
        Cookie: `foliotrack_token=${authToken}`
      }
    });
    assert.equal(res.status, 200);
    const html = await res.text();

    assert.ok(html.includes('Analisi Titoli Azionari'), 'Must include main title');
    assert.ok(html.includes('data-page="analysis"'), 'Sidebar must include dedicated Analisi nav item');
    assert.ok(html.includes('dialog id="fundamentalsModal"'), 'Must include native dialog for fundamentals');
    assert.ok(html.includes('dialog id="addAssetModal"'), 'Must include native dialog for adding monitored asset');
    assert.ok(html.includes('dialog id="editTargetsModal"'), 'Must include native dialog for editing SL/TP');
    assert.ok(html.includes('Stop Loss (SL)'), 'Must include Stop Loss column');
    assert.ok(html.includes('Take Profit (TP)'), 'Must include Take Profit column');
    assert.ok(html.includes('PEG'), 'Must include PEG column');
    assert.ok(html.includes('chart.umd.min.js'), 'Must include Chart.js vendor script');
  });

  test('GET /analysis?view=mobile serves Mobile HTML with bottom nav item and compact layout', async () => {
    const res = await fetch(`${baseUrl}/analysis?view=mobile`, {
      headers: {
        Authorization: `Bearer ${authToken}`,
        Cookie: `foliotrack_token=${authToken}`
      }
    });
    assert.equal(res.status, 200);
    const html = await res.text();

    assert.ok(html.includes('Analisi Azionaria'), 'Must include mobile title');
    assert.ok(html.includes('id="mobile-bottom-nav"'), 'Must include mobile bottom nav');
    assert.ok(html.includes('data-mobile-page="tools"'), 'Mobile nav must include Strumenti');
    assert.ok(html.includes('mAnalysisListContainer'), 'Must include mobile list container');
    assert.ok(html.includes('dialog id="fundamentalsModal"'), 'Must include mobile dialog for fundamentals');
  });

  test('GET /api/analysis returns portfolio equity assets with 1W, 1M, 3M, 1Y, 3Y variations and target levels', async () => {
    const res = await fetch(`${baseUrl}/api/analysis`, {
      headers: { Authorization: `Bearer ${authToken}` }
    });
    assert.equal(res.status, 200);
    const data = await res.json();

    assert.equal(data.success, true);
    assert.ok(Array.isArray(data.assets), 'Assets must be an array');
    assert.ok(data.stats, 'Must return stats summary');

    // AAPL and ISP.MI should be present (both are equities from transactions)
    const aapl = data.assets.find(x => x.ticker === 'AAPL');
    assert.ok(aapl, 'AAPL must be present in analysis assets');
    assert.equal(aapl.inPortfolio, true);
    assert.equal(aapl.currentPrice, 180.0);

    // Verify variations
    assert.ok(aapl.variations, 'Must have variations object');
    assert.equal(typeof aapl.variations['1W'], 'number');
    assert.equal(typeof aapl.variations['1M'], 'number');
    assert.equal(typeof aapl.variations['3M'], 'number');
    assert.equal(typeof aapl.variations['1Y'], 'number');
    assert.equal(typeof aapl.variations['3Y'], 'number');
    assert.ok(aapl.variations['1W'] > 5.0, '1W variation should reflect price change (180 vs 170)');

    // SWDA.MI should NOT be present (it is an ETF, not an equity/stock)
    const swda = data.assets.find(x => x.ticker === 'SWDA.MI');
    assert.equal(swda, undefined, 'ETFs must not be included in equity analysis list');
  });

  test('POST /api/analysis/watchlist adds a new monitored equity asset with SL & TP', async () => {
    const postRes = await fetch(`${baseUrl}/api/analysis/watchlist`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`
      },
      body: JSON.stringify({
        ticker: 'NVDA',
        name: 'NVIDIA Corporation',
        stopLoss: 110.0,
        takeProfit: 160.0,
        notes: 'Watchlist AI chipmaker'
      })
    });
    assert.equal(postRes.status, 201);
    const postData = await postRes.json();
    assert.equal(postData.success, true);
    assert.equal(postData.ticker, 'NVDA');
    assert.equal(postData.stopLoss, 110.0);
    assert.equal(postData.takeProfit, 160.0);

    // Verify it appears in GET /api/analysis
    const listRes = await fetch(`${baseUrl}/api/analysis`, {
      headers: { Authorization: `Bearer ${authToken}` }
    });
    const listData = await listRes.json();
    const nvda = listData.assets.find(x => x.ticker === 'NVDA');
    assert.ok(nvda, 'NVDA must be present in analysis list');
    assert.equal(nvda.inPortfolio, false);
    assert.equal(nvda.isMonitored, true);
    assert.equal(nvda.stopLoss, 110.0);
    assert.equal(nvda.takeProfit, 160.0);
  });

  test('PUT /api/analysis/:ticker/targets updates Stop Loss and Take Profit levels and flags alert status', async () => {
    // Set SL for AAPL to 185.0 (AAPL price is 180.0, so currentPrice <= SL -> TRIGGERED)
    const putRes = await fetch(`${baseUrl}/api/analysis/AAPL/targets`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`
      },
      body: JSON.stringify({
        stopLoss: 185.0,
        takeProfit: 220.0
      })
    });
    assert.equal(putRes.status, 200);
    const putData = await putRes.json();
    assert.equal(putData.success, true);
    assert.equal(putData.stopLoss, 185.0);
    assert.equal(putData.takeProfit, 220.0);

    // Check GET /api/analysis reflecting TRIGGERED SL status
    const listRes = await fetch(`${baseUrl}/api/analysis`, {
      headers: { Authorization: `Bearer ${authToken}` }
    });
    const listData = await listRes.json();
    const aapl = listData.assets.find(x => x.ticker === 'AAPL');
    assert.equal(aapl.slStatus, 'TRIGGERED', 'AAPL slStatus must be TRIGGERED because price 180 <= SL 185');
  });

  test('GET /api/analysis/:ticker/fundamentals returns Yahoo Finance fundamental metrics and caches result', async () => {
    // Seed fundamentals cache directly to test endpoint contract and caching
    const db = getDb();
    const mockFundamentals = {
      ticker: 'AAPL',
      companyName: 'Apple Inc.',
      sector: 'Technology',
      industry: 'Consumer Electronics',
      marketCap: 2800000000000,
      trailingPE: 28.5,
      forwardPE: 25.0,
      pegRatio: 2.1,
      priceToBook: 42.0,
      priceToSales: 7.5,
      dividendYield: 0.55,
      targetMeanPrice: 210.0,
      recommendationKey: 'buy',
      numberOfAnalystOpinions: 38,
      latestQuarter: {
        quarter: '3Q2026',
        epsActual: 2.10,
        epsEstimate: 1.98,
        surprisePercent: 6.06,
        revenue: 114000000000,
        earnings: 30000000000,
        profitMargin: 26.3
      },
      revenueHistory: [
        { year: 2023, revenue: 383000000000, earnings: 96000000000 },
        { year: 2024, revenue: 391000000000, earnings: 93000000000 }
      ],
      peHistory: [
        { year: '2023', pe: 25.6 },
        { year: '2024', pe: 35.0 },
        { year: 'Attuale', pe: 28.5 }
      ]
    };

    db.prepare(`
      INSERT OR REPLACE INTO analysis_fundamentals_cache (ticker, data, updatedAt)
      VALUES ('AAPL', ?, datetime('now'))
    `).run(JSON.stringify(mockFundamentals));

    const res = await fetch(`${baseUrl}/api/analysis/AAPL/fundamentals`, {
      headers: { Authorization: `Bearer ${authToken}` }
    });
    assert.equal(res.status, 200);
    const data = await res.json();

    assert.equal(data.success, true);
    assert.equal(data.ticker, 'AAPL');
    assert.ok(data.fundamentals, 'Must return fundamentals');
    assert.equal(data.fundamentals.sector, 'Technology');
    assert.equal(data.fundamentals.trailingPE, 28.5);
    assert.equal(data.fundamentals.pegRatio, 2.1);
    assert.equal(data.fundamentals.recommendationKey, 'buy');
    assert.ok(data.fundamentals.latestQuarter, 'Must return latestQuarter data');
    assert.equal(data.fundamentals.latestQuarter.quarter, '3Q2026');
    assert.equal(data.fundamentals.latestQuarter.surprisePercent, 6.06);
    assert.ok(Array.isArray(data.fundamentals.revenueHistory), 'Must return revenueHistory array');
    assert.equal(data.fundamentals.revenueHistory.length, 2);
    assert.ok(Array.isArray(data.fundamentals.peHistory), 'Must return peHistory array');
    assert.equal(data.fundamentals.peHistory.length, 3);
    assert.equal(data.source, 'CACHE');
  });

  test('DELETE /api/analysis/watchlist/:ticker removes monitored asset from watchlist', async () => {
    const delRes = await fetch(`${baseUrl}/api/analysis/watchlist/NVDA`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${authToken}` }
    });
    assert.equal(delRes.status, 200);
    const delData = await delRes.json();
    assert.equal(delData.success, true);
    assert.equal(delData.removed, true);

    // Verify it is no longer in GET /api/analysis
    const listRes = await fetch(`${baseUrl}/api/analysis`, {
      headers: { Authorization: `Bearer ${authToken}` }
    });
    const listData = await listRes.json();
    const nvda = listData.assets.find(x => x.ticker === 'NVDA');
    assert.equal(nvda, undefined, 'NVDA should be removed from analysis list');
  });

  test('PUT /api/analysis/:ticker/monitoring toggles notification monitoring state and persists in SQLite', async () => {
    // 1. AAPL is in portfolio and initially isMonitored is true
    const initListRes = await fetch(`${baseUrl}/api/analysis`, {
      headers: { Authorization: `Bearer ${authToken}` }
    });
    const initData = await initListRes.json();
    const aaplInit = initData.assets.find(x => x.ticker === 'AAPL');
    assert.ok(aaplInit);
    assert.equal(aaplInit.isMonitored, true);

    // 2. Disable monitoring for AAPL via PUT
    const putRes1 = await fetch(`${baseUrl}/api/analysis/AAPL/monitoring`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`
      },
      body: JSON.stringify({ isMonitored: false })
    });
    assert.equal(putRes1.status, 200);
    const putData1 = await putRes1.json();
    assert.equal(putData1.success, true);
    assert.equal(putData1.ticker, 'AAPL');
    assert.equal(putData1.isMonitored, false);

    // Verify persisted in SQLite
    const db = getDb();
    const row1 = db.prepare('SELECT isMonitored FROM analysis_watchlist WHERE ticker = ?').get('AAPL');
    assert.ok(row1);
    assert.equal(row1.isMonitored, 0);

    // Verify reflected in GET /api/analysis
    const listResAfter = await fetch(`${baseUrl}/api/analysis`, {
      headers: { Authorization: `Bearer ${authToken}` }
    });
    const dataAfter = await listResAfter.json();
    const aaplAfter = dataAfter.assets.find(x => x.ticker === 'AAPL');
    assert.ok(aaplAfter);
    assert.equal(aaplAfter.isMonitored, false);

    // 3. Re-enable monitoring via toggle (omitted body)
    const putRes2 = await fetch(`${baseUrl}/api/analysis/AAPL/monitoring`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`
      }
    });
    assert.equal(putRes2.status, 200);
    const putData2 = await putRes2.json();
    assert.equal(putData2.success, true);
    assert.equal(putData2.isMonitored, true);

    const row2 = db.prepare('SELECT isMonitored FROM analysis_watchlist WHERE ticker = ?').get('AAPL');
    assert.equal(row2.isMonitored, 1);
  });

  test('Asset notification suppression: disabled asset sends no push notifications or price alerts', async () => {
    const { checkAssetChangeNotifications } = require('../src/services/notificationService');
    const { checkAndSendAssetAlerts } = require('../src/services/telegramService');
    const db = getDb();

    // Set AAPL changePercent to +8.5% (above default 5% threshold) and set Stop Loss to 190.0 (above current 180.0)
    db.prepare("UPDATE assets SET changePercent = 8.5, currentPrice = 180.0 WHERE ticker = 'AAPL'").run();
    db.prepare(`
      INSERT INTO analysis_watchlist (ticker, name, stopLoss, isMonitored, updatedAt)
      VALUES ('AAPL', 'Apple Inc.', 190.0, 1, datetime('now'))
      ON CONFLICT(ticker) DO UPDATE SET stopLoss = 190.0, isMonitored = 1
    `).run();

    // With isMonitored = 1: checkAssetChangeNotifications finds AAPL
    const notifResultActive = await checkAssetChangeNotifications(1);
    const aaplFoundActive = notifResultActive.triggered.find(x => x.ticker === 'AAPL');
    assert.ok(aaplFoundActive, 'When monitored, AAPL must trigger asset change notification');

    const alertResultActive = await checkAndSendAssetAlerts(1, { notify: false });
    const aaplAlertActive = alertResultActive.triggered.find(x => x.ticker === 'AAPL');
    assert.ok(aaplAlertActive, 'When monitored, AAPL must trigger price / SL alert');

    // Now disable monitoring for AAPL (isMonitored = 0)
    db.prepare("UPDATE analysis_watchlist SET isMonitored = 0 WHERE ticker = 'AAPL'").run();

    // Verify checkAssetChangeNotifications does NOT trigger for AAPL
    const notifResultDisabled = await checkAssetChangeNotifications(1);
    const aaplFoundDisabled = notifResultDisabled.triggered.find(x => x.ticker === 'AAPL');
    assert.equal(aaplFoundDisabled, undefined, 'When disabled, AAPL must NOT trigger asset change notification');

    // Verify checkAndSendAssetAlerts does NOT trigger for AAPL
    const alertResultDisabled = await checkAndSendAssetAlerts(1, { notify: false });
    const aaplAlertDisabled = alertResultDisabled.triggered.find(x => x.ticker === 'AAPL');
    assert.equal(aaplAlertDisabled, undefined, 'When disabled, AAPL must NOT trigger price / SL alert');
  });

  test('Frontend analysis.js contains eye icon rendering and toggle action', () => {
    const jsPath = path.join(__dirname, '../public/analysis.js');
    const content = fs.readFileSync(jsPath, 'utf8');

    assert.ok(content.includes('function renderEyeIcon'), 'Must define renderEyeIcon helper');
    assert.ok(content.includes('function toggleAssetMonitoring'), 'Must define toggleAssetMonitoring');
    assert.ok(content.includes('data-action="toggle-monitor"'), 'Must bind toggle-monitor action');
    assert.ok(content.includes('/api/analysis/'), 'Must call analysis API');
    assert.ok(content.includes('/monitoring'), 'Must call /monitoring endpoint');
  });

  test('Stock (e.g. MU) with preexisting watchlist entry and purchased in portfolio is classified as inPortfolio = true (PORTAFOGLIO)', async () => {
    const db = getDb();

    // 1. Initially insert MU in watchlist
    db.prepare(`
      INSERT OR REPLACE INTO analysis_watchlist (ticker, name, isMonitored, updatedAt)
      VALUES ('MU', 'Micron Technology Inc.', 1, datetime('now'))
    `).run();

    // Verify initially it is not in portfolio
    let res = await fetch(`${baseUrl}/api/analysis`, {
      headers: { Authorization: `Bearer ${authToken}` }
    });
    let data = await res.json();
    let mu = data.assets.find(x => x.ticker === 'MU');
    assert.ok(mu, 'MU must exist in analysis list');
    assert.equal(mu.inPortfolio, false, 'Before purchase, MU should be in watchlist only');

    // 2. Insert asset with NULL type (simulating quote fetch without explicit type) and BUY transaction
    db.prepare(`
      INSERT OR REPLACE INTO assets (ticker, name, type, currentPrice, currency)
      VALUES ('MU', 'Micron Technology Inc.', NULL, 110.0, 'USD')
    `).run();

    db.prepare(`
      INSERT INTO transactions (portfolioId, date, type, assetTicker, quantity, price, amount)
      VALUES (?, '2024-04-01', 'BUY', 'MU', 15, 105.0, 1575.0)
    `).run(portfolioId);

    // 3. Query /api/analysis again
    res = await fetch(`${baseUrl}/api/analysis`, {
      headers: { Authorization: `Bearer ${authToken}` }
    });
    data = await res.json();
    mu = data.assets.find(x => x.ticker === 'MU');
    assert.ok(mu, 'MU must exist in analysis list');
    assert.equal(mu.inPortfolio, true, 'After purchase, MU must have inPortfolio = true');
    assert.equal(mu.ticker, 'MU');
  });
});
