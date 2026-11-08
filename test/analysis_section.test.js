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
});
