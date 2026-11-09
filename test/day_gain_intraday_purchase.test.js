const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const http = require('http');

const TEST_DB = path.join(__dirname, 'test_day_gain_intraday.db');
process.env.DB_PATH = TEST_DB;
process.env.JWT_SECRET = 'test-secret-jwt-very-long-and-secure-day-gain-intraday';
process.env.ADMIN_PASSWORD = 'adminIntradayPass123!';

const { initDb, closeDb, getDb } = require('../src/db');
const app = require('../src/app');
const { calculateHoldingsAndMetrics } = require('../src/utils/finance');
const { getTradingDateStr } = require('../src/services/marketService');

let server;
let baseUrl;
let authToken;

describe('Intraday Purchase Day Gain Engine (Purchase Price Baseline vs Previous Close)', () => {
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
      body: JSON.stringify({ username: 'admin', password: 'adminIntradayPass123!' })
    });
    const loginData = await loginRes.json();
    authToken = loginData.token;
  });

  after(() => {
    if (server) server.close();
    closeDb();
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  });

  test('Intraday purchase: day gain uses purchase price (valore di acquisto) instead of previous close', () => {
    const todayStr = getTradingDateStr();
    const yesterdayDate = new Date();
    yesterdayDate.setDate(yesterdayDate.getDate() - 1);
    const yesterdayStr = getTradingDateStr(yesterdayDate);

    // Asset MU:
    // Closed yesterday at $95. Today it opened at $100.
    // At 14:00 today, user buys 10 shares of MU at $105 (purchase price = 105).
    // Current market price is $110 (changeValue vs yesterday is 110 - 95 = 15).
    const transactions = [
      { id: 1, type: 'DEPOSIT', amount: 5000, date: yesterdayStr },
      { id: 2, type: 'BUY', assetTicker: 'MU', quantity: 10, price: 105.0, commission: 0, date: todayStr }
    ];

    const assetsMap = {
      'MU': {
        ticker: 'MU',
        name: 'Micron Technology Inc.',
        currentPrice: 110.0,
        changeValue: 15.0,
        changePercent: 15.79,
        previousClose: 95.0,
        quoteDate: todayStr,
        currency: 'USD'
      }
    };

    const fxRateEurUsd = 0.90; // 1 USD = 0.90 EUR
    const currencyRatesMap = { 'USD/EUR': 0.90 };

    const res = calculateHoldingsAndMetrics(transactions, assetsMap, 5000, 'WAC', 'EUR', currencyRatesMap);
    const muHolding = res.holdings.find(h => h.ticker === 'MU');

    assert.ok(muHolding, 'MU holding must exist');

    // Day gain must be 10 * ($110 - $105) = +$50.0 (NOT 10 * ($110 - $95) = +$150.0)
    assert.equal(muHolding.dayPnlNative, 50.0, 'Day gain in native USD must be exactly 10 * (110 - 105) = +50.0');
    assert.equal(muHolding.dayPnlEur, 50.0 * fxRateEurUsd, 'Day gain in EUR must be 50 * 0.90 = +45.0');

    // Day change percent must be based on purchase price: (50 / 1050) * 100 = 4.7619%
    const expectedPct = (50.0 / (10 * 105.0)) * 100.0;
    assert.ok(Math.abs(muHolding.changePercent - expectedPct) < 0.001, `changePercent must be ~${expectedPct.toFixed(2)}%, got ${muHolding.changePercent}`);
    assert.equal(muHolding.changeValue, 5.0, 'Per-share changeValue must be 110 - 105 = 5.0');

    // Total portfolio day PnL must be 45.0 EUR
    assert.equal(res.dayPnl, 45.0, 'Total portfolio day PnL must strictly match MU day gain');
  });

  test('Intraday purchase where market price has not moved since purchase: day gain is strictly 0', () => {
    const todayStr = getTradingDateStr();

    // User bought 10 shares of XYZ today at 100.0 EUR.
    // Current price is still 100.0 EUR. Yesterday close was 80.0 EUR (market up +25%).
    const transactions = [
      { id: 1, type: 'DEPOSIT', amount: 5000, date: todayStr },
      { id: 2, type: 'BUY', assetTicker: 'XYZ', quantity: 10, price: 100.0, commission: 0, date: todayStr }
    ];

    const assetsMap = {
      'XYZ': {
        ticker: 'XYZ',
        name: 'XYZ Corp',
        currentPrice: 100.0,
        changeValue: 20.0,
        changePercent: 25.0,
        previousClose: 80.0,
        quoteDate: todayStr,
        currency: 'EUR'
      }
    };

    const res = calculateHoldingsAndMetrics(transactions, assetsMap, 5000, 'WAC', 'EUR', {});
    const xyzHolding = res.holdings.find(h => h.ticker === 'XYZ');

    assert.ok(xyzHolding, 'XYZ holding must exist');
    assert.equal(xyzHolding.dayPnlNative, 0.0, 'Day gain must be strictly 0.0 since price has not moved from purchase');
    assert.equal(xyzHolding.dayPnlEur, 0.0, 'Day gain in EUR must be 0.0');
    assert.equal(xyzHolding.changePercent, 0.0, 'changePercent must be 0.0%');
    assert.equal(xyzHolding.changeValue, 0.0, 'changeValue must be 0.0');
    assert.equal(res.dayPnl, 0.0, 'Portfolio day PnL must be 0.0');
  });

  test('Intraday purchase that dropped below purchase price records a negative day gain even if market is green vs yesterday', () => {
    const todayStr = getTradingDateStr();

    // Yesterday close was $90. User bought today at $100. Price subsequently dropped to $95.
    // Stock on market is +5.55% vs yesterday close, but user lost -$5 per share!
    const transactions = [
      { id: 1, type: 'DEPOSIT', amount: 5000, date: todayStr },
      { id: 2, type: 'BUY', assetTicker: 'FALL', quantity: 20, price: 100.0, commission: 0, date: todayStr }
    ];

    const assetsMap = {
      'FALL': {
        ticker: 'FALL',
        name: 'Fall Corp',
        currentPrice: 95.0,
        changeValue: 5.0,
        changePercent: 5.56,
        previousClose: 90.0,
        quoteDate: todayStr,
        currency: 'EUR'
      }
    };

    const res = calculateHoldingsAndMetrics(transactions, assetsMap, 5000, 'WAC', 'EUR', {});
    const fallHolding = res.holdings.find(h => h.ticker === 'FALL');

    assert.ok(fallHolding, 'FALL holding must exist');
    // 20 * (95 - 100) = -100.0
    assert.equal(fallHolding.dayPnlNative, -100.0, 'Day gain must be negative (-100.0)');
    assert.equal(fallHolding.dayPnlEur, -100.0);
    assert.equal(fallHolding.changePercent, -5.0, 'changePercent must be -5.0%');
    assert.equal(fallHolding.changeValue, -5.0, 'changeValue must be -5.0');
    assert.equal(res.dayPnl, -100.0);
  });

  test('Mixed position: prior shares use previous close, intraday bought shares use purchase price', () => {
    const todayStr = getTradingDateStr();
    const yesterdayDate = new Date();
    yesterdayDate.setDate(yesterdayDate.getDate() - 1);
    const yesterdayStr = getTradingDateStr(yesterdayDate);

    // 10 shares bought yesterday at 140.0. Yesterday close = 150.0.
    // 10 shares bought today at 170.0.
    // Current price = 175.0.
    // Expected:
    // Prior shares (10): 10 * (175 - 150) = +250.0
    // Today shares (10): 10 * (175 - 170) = +50.0
    // Total day gain: 250 + 50 = +300.0 (NOT 20 * 25 = 500.0)
    const transactions = [
      { id: 1, type: 'DEPOSIT', amount: 10000, date: yesterdayStr },
      { id: 2, type: 'BUY', assetTicker: 'AAPL', quantity: 10, price: 140.0, commission: 0, date: yesterdayStr },
      { id: 3, type: 'BUY', assetTicker: 'AAPL', quantity: 10, price: 170.0, commission: 0, date: todayStr }
    ];

    const assetsMap = {
      'AAPL': {
        ticker: 'AAPL',
        name: 'Apple Inc.',
        currentPrice: 175.0,
        changeValue: 25.0,
        changePercent: 16.67,
        previousClose: 150.0,
        quoteDate: todayStr,
        currency: 'EUR'
      }
    };

    const res = calculateHoldingsAndMetrics(transactions, assetsMap, 10000, 'WAC', 'EUR', {});
    const aaplHolding = res.holdings.find(h => h.ticker === 'AAPL');

    assert.ok(aaplHolding, 'AAPL holding must exist');
    assert.equal(aaplHolding.dayPnlNative, 300.0, 'Mixed position dayPnlNative must be 250 + 50 = 300.0');
    assert.equal(aaplHolding.dayPnlEur, 300.0);

    // Baseline: (10 * 150) + (10 * 170) = 1500 + 1700 = 3200
    // % change: (300 / 3200) * 100 = 9.375%
    const expectedPct = (300.0 / 3200.0) * 100.0;
    assert.ok(Math.abs(aaplHolding.changePercent - expectedPct) < 0.001);
    assert.equal(aaplHolding.changeValue, 300.0 / 20.0, 'changeValue per share must be 15.0');
  });

  test('API Integration: GET /api/portfolios/:id returns holdings with accurate dayPnl on intraday purchase', async () => {
    const todayStr = getTradingDateStr();
    const db = getDb();

    // 1. Create portfolio
    const pRes = await fetch(`${baseUrl}/api/portfolios`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`
      },
      body: JSON.stringify({
        name: 'Intraday Buy Portfolio Test',
        currency: 'EUR',
        initialCash: 20000
      })
    });
    const pData = await pRes.json();
    const portfolioId = pData.portfolio.id;

    // 2. Insert asset with today quoteDate
    db.prepare(`
      INSERT OR REPLACE INTO assets (ticker, name, currentPrice, changeValue, changePercent, previousClose, quoteDate, currency)
      VALUES ('MU_TEST', 'Micron Test', 110.0, 15.0, 15.79, 95.0, ?, 'EUR')
    `).run(todayStr);

    // 3. Insert transaction of BUY today at 105.0
    await fetch(`${baseUrl}/api/transactions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`
      },
      body: JSON.stringify({
        portfolioId,
        type: 'BUY',
        assetTicker: 'MU_TEST',
        quantity: 10,
        price: 105.0,
        commission: 0,
        date: todayStr
      })
    });

    // 4. Query portfolio details
    const getRes = await fetch(`${baseUrl}/api/portfolios/${portfolioId}`, {
      headers: { Authorization: `Bearer ${authToken}` }
    });
    const getData = await getRes.json();
    assert.equal(getRes.status, 200);

    const holding = getData.portfolio.metrics.holdings.find(h => h.ticker === 'MU_TEST');
    assert.ok(holding, 'MU_TEST holding must exist');

    // Day gain must be 10 * (110 - 105) = +50.0
    assert.equal(holding.dayPnlEur, 50.0, 'Holding dayPnlEur must be 50.0 (NOT 150.0)');
    assert.equal(getData.portfolio.metrics.dayPnl, 50.0, 'Portfolio metrics dayPnl must be 50.0');
    assert.equal(getData.portfolio.dayPnl, 50.0, 'Portfolio root dayPnl must be 50.0');
  });
});
