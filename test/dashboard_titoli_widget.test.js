const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const http = require('http');

const TEST_DB = path.join(__dirname, 'test_dashboard_titoli.db');
process.env.DB_PATH = TEST_DB;
process.env.JWT_SECRET = 'test-secret-jwt-very-long-and-secure-titoli-test';
process.env.ADMIN_PASSWORD = 'adminTitoliPassword123!';

const { initDb, closeDb, getDb } = require('../src/db');
const app = require('../src/app');

let server;
let baseUrl;
let authToken;
let portfolioId;

describe('Dashboard Widget Titoli: Mini Grafico Storico & Variazioni DAY e Complessiva', () => {
  before(async () => {
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    initDb(TEST_DB);
    const db = getDb();

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
      body: JSON.stringify({ username: 'admin', password: 'adminTitoliPassword123!' })
    });
    const loginData = await loginRes.json();
    authToken = loginData.token;

    // Create portfolio
    const portRes = await fetch(`${baseUrl}/api/portfolios`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`
      },
      body: JSON.stringify({
        name: 'Portafoglio Titoli Test',
        currency: 'EUR',
        initialCash: 50000
      })
    });
    const portData = await portRes.json();
    portfolioId = portData.portfolio.id;

    // Create asset with quotes
    db.prepare(`
      INSERT INTO assets (ticker, name, type, currency, currentPrice, changePercent, changeValue, dataSource)
      VALUES ('TITOLO_TEST', 'Test Titolo Holding SpA', 'EQUITY', 'EUR', 150.00, 2.50, 3.65, 'YAHOO')
    `).run();

    // Insert 6 months of simulated quotes
    const quoteStmt = db.prepare(`
      INSERT INTO asset_quotes (ticker, date, close, volume, source)
      VALUES ('TITOLO_TEST', ?, ?, 10000, 'YAHOO')
    `);

    const now = new Date();
    for (let i = 180; i >= 0; i -= 2) {
      const d = new Date(now.getTime() - i * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
      const price = 100 + (180 - i) * 0.25;
      quoteStmt.run(d, price);
    }

    // Buy transaction
    await fetch(`${baseUrl}/api/transactions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`
      },
      body: JSON.stringify({
        portfolioId,
        type: 'BUY',
        assetTicker: 'TITOLO_TEST',
        date: '2024-01-15',
        quantity: 100,
        price: 110.00
      })
    });
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

  test('GET /api/portfolios enriches holdings with sparkline quote history and day change values', async () => {
    const res = await fetch(`${baseUrl}/api/portfolios`, {
      headers: { Authorization: `Bearer ${authToken}` }
    });

    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.ok(Array.isArray(body.portfolios));

    const p = body.portfolios.find(x => x.id === portfolioId);
    assert.ok(p);
    assert.ok(p.metrics);
    assert.ok(Array.isArray(p.metrics.holdings));
    assert.equal(p.metrics.holdings.length, 1);

    const h = p.metrics.holdings[0];
    assert.equal(h.ticker, 'TITOLO_TEST');
    assert.equal(h.quantity, 100);
    assert.equal(h.currentPrice, 150);
    assert.equal(h.changePercent, 2.5);
    assert.equal(h.changeValue, 3.65);

    // Sparkline array present with historical dates & close prices
    assert.ok(Array.isArray(h.sparkline));
    assert.ok(h.sparkline.length > 50);
    assert.ok(h.sparkline[0].date);
    assert.ok(typeof h.sparkline[0].close === 'number');
  });

  test('public/dashboard.js defines mini chart generator, 3M default period, and DAY/Complessiva metrics', async () => {
    const res = await fetch(`${baseUrl}/dashboard.js`);
    assert.equal(res.status, 200);
    const text = await res.text();

    assert.ok(text.includes("activeSparklinePeriod = '3M'"), 'Must default to 3M period for sparklines');
    assert.ok(text.includes('generateSparklineData'), 'Must define sparkline curve generator function');
    assert.ok(text.includes('formatEurSigned'), 'Must support signed currency formatting (+/- €)');
    assert.ok(text.includes('data-sparkline-period'), 'Must provide period selector buttons');
    assert.ok(text.includes('Var. DAY'), 'Must display DAY variation section');
    assert.ok(text.includes('Complessiva'), 'Must display Complessiva variation section');
  });
});

