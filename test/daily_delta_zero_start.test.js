const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const http = require('http');

const TEST_DB = path.join(__dirname, 'test_daily_delta_zero.db');
process.env.DB_PATH = TEST_DB;
process.env.JWT_SECRET = 'test-secret-jwt-very-long-and-secure-daily-delta-zero';
process.env.ADMIN_PASSWORD = 'adminDailyDeltaPass123!';

const { initDb, closeDb, getDb } = require('../src/db');
const app = require('../src/app');
const { calculateHoldingsAndMetrics } = require('../src/utils/finance');
const { resetDailyAssetDeltas, getTradingDateStr } = require('../src/services/marketService');

let server;
let baseUrl;
let authToken;

describe('Start-of-Day Delta Zero Engine & Prior-Day Variation Isolation', () => {
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
      body: JSON.stringify({ username: 'admin', password: 'adminDailyDeltaPass123!' })
    });
    const loginData = await loginRes.json();
    authToken = loginData.token;
  });

  after(() => {
    if (server) server.close();
    closeDb();
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  });

  test('calculateHoldingsAndMetrics zeroes out day delta for assets quoted on prior day', () => {
    const todayStr = getTradingDateStr();
    const yesterdayDate = new Date();
    yesterdayDate.setDate(yesterdayDate.getDate() - 1);
    const yesterdayStr = getTradingDateStr(yesterdayDate);

    const transactions = [
      { id: 1, type: 'DEPOSIT', amount: 10000, date: yesterdayStr },
      { id: 2, type: 'BUY', assetTicker: 'AAPL', quantity: 10, price: 150, commission: 0, date: yesterdayStr },
      { id: 3, type: 'BUY', assetTicker: 'ENI.MI', quantity: 100, price: 14, commission: 0, date: yesterdayStr }
    ];

    // AAPL: quote is from yesterday with +5.31% change
    // ENI.MI: quote is from today with +1.5% change
    const assetsMap = {
      'AAPL': {
        ticker: 'AAPL',
        name: 'Apple Inc.',
        currentPrice: 170.0,
        changeValue: 8.5,
        changePercent: 5.31,
        previousClose: 161.5,
        quoteDate: yesterdayStr,
        currency: 'EUR'
      },
      'ENI.MI': {
        ticker: 'ENI.MI',
        name: 'Eni S.p.A.',
        currentPrice: 14.5,
        changeValue: 0.25,
        changePercent: 1.75,
        previousClose: 14.25,
        quoteDate: todayStr,
        currency: 'EUR'
      }
    };

    const res = calculateHoldingsAndMetrics(transactions, assetsMap, 10000, 'WAC', 'EUR', {});

    const aaplHolding = res.holdings.find(h => h.ticker === 'AAPL');
    const eniHolding = res.holdings.find(h => h.ticker === 'ENI.MI');

    assert.ok(aaplHolding, 'AAPL holding should exist');
    assert.ok(eniHolding, 'ENI holding should exist');

    // AAPL must have 0 daily variation because its quote is from yesterday
    assert.equal(aaplHolding.changePercent, 0.0, 'Prior-day asset changePercent must be 0');
    assert.equal(aaplHolding.changeValue, 0.0, 'Prior-day asset changeValue must be 0');
    assert.equal(aaplHolding.dayPnlNative, 0.0, 'Prior-day asset dayPnlNative must be 0');
    assert.equal(aaplHolding.dayPnlEur, 0.0, 'Prior-day asset dayPnlEur must be 0');
    assert.equal(aaplHolding.previousClose, 170.0, 'Prior-day previousClose must baseline to currentPrice');

    // ENI.MI traded today, so its daily variation must be preserved
    assert.equal(eniHolding.changePercent, 1.75, 'Today quote changePercent must be preserved');
    assert.equal(eniHolding.changeValue, 0.25, 'Today quote changeValue must be preserved');
    assert.equal(eniHolding.dayPnlNative, 25.0, 'ENI dayPnlNative should be 100 * 0.25 = 25');
    assert.equal(eniHolding.dayPnlEur, 25.0, 'ENI dayPnlEur should be 25');

    // Total portfolio dayPnl must ONLY include ENI (25.0), AAPL must contribute 0.0
    assert.equal(res.dayPnl, 25.0, 'Portfolio dayPnl must strictly exclude prior-day variation');
  });

  test('resetDailyAssetDeltas resets changeValue and changePercent to 0 for prior day assets', () => {
    const db = getDb();
    const yesterdayDate = new Date();
    yesterdayDate.setDate(yesterdayDate.getDate() - 1);
    const yesterdayStr = getTradingDateStr(yesterdayDate);

    db.prepare(`
      INSERT INTO assets (ticker, name, currentPrice, changeValue, changePercent, previousClose, quoteDate)
      VALUES 
        ('OLD_ASSET', 'Old Asset Inc', 50.0, 3.5, 7.5, 46.5, ?),
        ('TODAY_ASSET', 'Today Asset Inc', 80.0, 2.0, 2.5, 78.0, ?)
    `).run(yesterdayStr, getTradingDateStr());

    const changes = resetDailyAssetDeltas();
    assert.ok(changes >= 1, 'Should reset at least 1 asset');

    const oldRow = db.prepare('SELECT * FROM assets WHERE ticker = ?').get('OLD_ASSET');
    const todayRow = db.prepare('SELECT * FROM assets WHERE ticker = ?').get('TODAY_ASSET');

    assert.equal(oldRow.changeValue, 0.0, 'OLD_ASSET changeValue must be reset to 0');
    assert.equal(oldRow.changePercent, 0.0, 'OLD_ASSET changePercent must be reset to 0');
    assert.equal(oldRow.previousClose, 50.0, 'OLD_ASSET previousClose must equal currentPrice');

    assert.equal(todayRow.changeValue, 2.0, 'TODAY_ASSET changeValue must be preserved');
    assert.equal(todayRow.changePercent, 2.5, 'TODAY_ASSET changePercent must be preserved');
  });

  test('GET /api/portfolios returns dayPnl = 0 when holdings have only prior day quotes', async () => {
    const db = getDb();
    const yesterdayDate = new Date();
    yesterdayDate.setDate(yesterdayDate.getDate() - 2);
    const twoDaysAgoStr = getTradingDateStr(yesterdayDate);

    // Create portfolio
    const pRes = await fetch(`${baseUrl}/api/portfolios`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`
      },
      body: JSON.stringify({
        name: 'Portfolio Delta 0 Test',
        currency: 'EUR',
        initialCash: 50000
      })
    });
    const pData = await pRes.json();
    const portfolioId = pData.portfolio.id;

    // Asset with old quote
    db.prepare(`
      INSERT OR REPLACE INTO assets (ticker, name, currentPrice, changeValue, changePercent, previousClose, quoteDate)
      VALUES ('STALE_STOCK', 'Stale Stock Corp', 100.0, 10.0, 11.1, 90.0, ?)
    `).run(twoDaysAgoStr);

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
        assetTicker: 'STALE_STOCK',
        quantity: 20,
        price: 95,
        commission: 0,
        date: twoDaysAgoStr
      })
    });

    const getRes = await fetch(`${baseUrl}/api/portfolios`, {
      headers: { Authorization: `Bearer ${authToken}` }
    });
    const getData = await getRes.json();

    const targetP = getData.portfolios.find(p => p.id === portfolioId);
    assert.ok(targetP, 'Target portfolio should exist');

    assert.equal(targetP.metrics.dayPnl, 0.0, 'Portfolio dayPnl must be 0 for stale quotes');
    assert.equal(targetP.metrics.dayPnlPercent, 0.0, 'Portfolio dayPnlPercent must be 0');
    assert.equal(targetP.dayPnl, 0.0, 'Day PnL on portfolio root must be 0');

    const holding = targetP.metrics.holdings.find(h => h.ticker === 'STALE_STOCK');
    assert.ok(holding, 'Holding STALE_STOCK must exist');
    assert.equal(holding.changePercent, 0.0, 'Holding changePercent must be 0');
    assert.equal(holding.changeValue, 0.0, 'Holding changeValue must be 0');
    assert.equal(holding.dayPnlEur, 0.0, 'Holding dayPnlEur must be 0');
  });
});

