const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const http = require('http');

const TEST_DB = path.join(__dirname, 'test_phase4.db');
process.env.DB_PATH = TEST_DB;
process.env.JWT_SECRET = 'test-secret-jwt-very-long-and-secure-phase4';
process.env.ADMIN_PASSWORD = 'adminPhase4Password!';

const { initDb, closeDb, getDb } = require('../src/db');
const app = require('../src/app');
const borsa = require('../src/services/borsaItaliana');
const google = require('../src/services/googleFinance');
const marketService = require('../src/services/marketService');

let server;
let baseUrl;
let authToken;

describe('Phase 4: Market Data Providers, Scraping & Cache', () => {
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

    const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'adminPhase4Password!' })
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

  test('Borsa Italiana utilities: ISIN check and Italian number parsing', () => {
    assert.equal(borsa.isIsin('IT0005518524'), true);
    assert.equal(borsa.isIsin('IE00B4L5Y983'), true);
    assert.equal(borsa.isIsin('US0378331005'), true);
    assert.equal(borsa.isIsin('AAPL'), false);
    assert.equal(borsa.isIsin('CSPX.MI'), false);

    assert.equal(borsa.parseItalianNumber('101,45'), 101.45);
    assert.equal(borsa.parseItalianNumber('1.050,25'), 1050.25);
    assert.equal(borsa.parseItalianNumber('99,539'), 99.539);
  });

  test('Google Finance utilities: query formatting and currency parsing', () => {
    assert.equal(google.formatGoogleQuery('SWDA.MI'), 'SWDA:BIT');
    assert.equal(google.formatGoogleQuery('SAP.DE'), 'SAP:ETR');
    assert.equal(google.formatGoogleQuery('AAPL', 'NASDAQ'), 'AAPL:NASDAQ');

    const eurParsed = google.parsePriceAndCurrency('€ 104,50');
    assert.equal(eurParsed.price, 104.5);
    assert.equal(eurParsed.currency, 'EUR');

    const usdParsed = google.parsePriceAndCurrency('$337.32');
    assert.equal(usdParsed.price, 337.32);
    assert.equal(usdParsed.currency, 'USD');
  });

  test('GET /api/market/indices returns real-time world indices for Live Ticker Bar', async () => {
    const res = await fetch(`${baseUrl}/api/market/indices`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.success, true);
    assert.ok(Array.isArray(data.indices));
    assert.ok(data.indices.length >= 5);

    const sp500 = data.indices.find(i => i.symbol === '^GSPC');
    assert.ok(sp500, 'S&P 500 benchmark must be present');
    assert.ok(sp500.price > 0);

    const btc = data.indices.find(i => i.symbol === 'BTC-EUR');
    assert.ok(btc, 'Bitcoin benchmark must be present');
    assert.ok(btc.price > 0);
  });

  test('GET /api/market/search searches ticker across markets', async () => {
    const res = await fetch(`${baseUrl}/api/market/search?q=Apple`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.success, true);
    assert.ok(Array.isArray(data.results));

    // Should include AAPL
    const aapl = data.results.find(r => r.ticker === 'AAPL');
    assert.ok(aapl, 'Search for Apple should include AAPL');
  });

  test('Borsa Italiana REST API historical BTP fetch with Bearer token', async () => {
    const history = await borsa.fetchHistorical('IT0005240830', '1M');
    // If online, Borsa Italiana returns array with dt and close
    assert.ok(Array.isArray(history));
    if (history.length > 0) {
      assert.ok(history[0].date.includes('-'));
      assert.ok(history[0].close > 0);
      assert.equal(history[0].source, 'BORSA_ITALIANA');
    }
  });

  test('fetchUnifiedQuote fetches, sanitizes and caches in assets and asset_quotes', async () => {
    const quote = await marketService.fetchUnifiedQuote('MSFT');
    assert.ok(quote);
    assert.equal(quote.ticker, 'MSFT');
    assert.ok(quote.currentPrice > 0);

    // Verify row in SQLite assets table
    const assetRow = getDb().prepare('SELECT * FROM assets WHERE ticker = ?').get('MSFT');
    assert.ok(assetRow, 'MSFT must be saved to assets table');
    assert.equal(assetRow.currentPrice, quote.currentPrice);

    // Verify row in SQLite asset_quotes cache table
    const quoteRow = getDb().prepare('SELECT * FROM asset_quotes WHERE ticker = ?').get('MSFT');
    assert.ok(quoteRow, 'MSFT must be cached in asset_quotes table');
    assert.equal(quoteRow.close, quote.currentPrice);
  });

  test('GET /api/market/quote/:ticker endpoint', async () => {
    const res = await fetch(`${baseUrl}/api/market/quote/AAPL`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.success, true);
    assert.equal(data.quote.ticker, 'AAPL');
    assert.ok(data.quote.currentPrice > 0);
  });

  test('GET /api/market/chart/:ticker endpoint returns candlesticks', async () => {
    const res = await fetch(`${baseUrl}/api/market/chart/AAPL?period=1M`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.success, true);
    assert.ok(Array.isArray(data.points));
    assert.ok(data.points.length > 0);
    assert.ok(data.points[0].close > 0);
  });

  test('POST /api/market/update-all batch update job runs successfully', async () => {
    // Insert dummy asset to test batch update
    getDb().prepare(`
      INSERT INTO assets (ticker, name, currentPrice)
      VALUES ('NVDA', 'NVIDIA Corporation', 100.0)
      ON CONFLICT(ticker) DO NOTHING
    `).run();

    const res = await fetch(`${baseUrl}/api/market/update-all`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`
      },
      body: JSON.stringify({ delayMs: 50 })
    });

    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.success, true);
    assert.ok(data.total >= 1);
    assert.ok(data.updated >= 1);
  });
});

