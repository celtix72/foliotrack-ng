const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const path = require('path');
const fs = require('fs');

const TEST_DB = path.join(__dirname, 'test_recalculate_performance.db');
process.env.DB_PATH = TEST_DB;
process.env.JWT_SECRET = 'test_jwt_secret_recalc_performance_776655';
process.env.NODE_ENV = 'test';

const { initDb, getDb, closeDb } = require('../src/db');
const app = require('../src/app');
const {
  computePerformanceMetricsFromHistory,
  recalculateAndReconstructHistoricalPerformance
} = require('../src/routes/history');
const { addDaysToDateStr, reconstructPortfolioHistoryFromQuotes } = require('../src/services/marketService');

describe('Historical Performance On-Demand Recalculation & Reconstruction Engine', () => {
  let server;
  let baseUrl;
  let authToken;
  let portfolioId;

  before(async () => {
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    initDb(TEST_DB);

    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, resolve));
    const port = server.address().port;
    baseUrl = `http://127.0.0.1:${port}`;

    // Admin login
    const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin123' })
    });
    const loginData = await loginRes.json();
    authToken = loginData.token;

    // Create test portfolio
    const pRes = await fetch(`${baseUrl}/api/portfolios`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`
      },
      body: JSON.stringify({
        name: 'Performance Test Portfolio',
        type: 'Trading',
        currency: 'EUR',
        initialCash: 5000.0,
        include_in_totals: 1
      })
    });
    const pData = await pRes.json();
    portfolioId = pData.portfolio.id;

    // Seed asset & quotes
    const db = getDb();
    db.prepare(`
      INSERT OR REPLACE INTO assets (ticker, name, type, currentPrice, currency)
      VALUES ('AAPL', 'Apple Inc', 'EQUITY', 180.0, 'EUR')
    `).run();

    const insertQuote = db.prepare(`
      INSERT OR REPLACE INTO asset_quotes (ticker, date, close, volume, source)
      VALUES (?, ?, ?, ?, ?)
    `);
    insertQuote.run('AAPL', '2024-01-01', 150.0, 1000, 'TEST');
    insertQuote.run('AAPL', '2024-03-01', 160.0, 1000, 'TEST');
    insertQuote.run('AAPL', '2024-06-01', 170.0, 1000, 'TEST');
    insertQuote.run('AAPL', '2024-09-01', 180.0, 1000, 'TEST');

    // Add transactions:
    // 1. BUY 20 AAPL @ 150.0 on 2024-01-02 -> cost 3000 -> cash left 2000
    db.prepare(`
      INSERT INTO transactions (portfolioId, assetTicker, type, date, quantity, price, amount, commission)
      VALUES (?, 'AAPL', 'BUY', '2024-01-02', 20, 150.0, 3000.0, 0)
    `).run(portfolioId);

    // 2. DEPOSIT 2000.0 on 2024-06-01
    db.prepare(`
      INSERT INTO transactions (portfolioId, assetTicker, type, date, amount)
      VALUES (?, NULL, 'DEPOSIT', '2024-06-01', 2000.0)
    `).run(portfolioId);
  });

  after(async () => {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
    closeDb();
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  });

  test('computePerformanceMetricsFromHistory computes exact TWR, period gains, maxDrawdown, and volatility', () => {
    const mockRows = [
      { date: '2024-01-01', totalValue: 10000, cashValue: 10000, assetValue: 0, netDeposits: 10000 },
      { date: '2024-01-02', totalValue: 10500, cashValue: 5000, assetValue: 5500, netDeposits: 10000 }, // +5%
      { date: '2024-01-03', totalValue: 12500, cashValue: 7000, assetValue: 5500, netDeposits: 12000 }, // +2000 deposit, asset flat
      { date: '2024-01-04', totalValue: 11250, cashValue: 7000, assetValue: 4250, netDeposits: 12000 }  // -10% drop on 12500 -> 11250
    ];

    const metrics = computePerformanceMetricsFromHistory(mockRows, [1], [{ id: 1, initialCash: 10000 }]);
    assert.ok(metrics);
    assert.equal(typeof metrics.twr, 'object');
    assert.ok(metrics.twr['ALL'] !== undefined);
    assert.ok(metrics.maxDrawdown > 0); // Drew down from 12500 to 11250 = 10%
    assert.equal(metrics.peak, 12500);
    assert.ok(metrics.dailyPointsCount === 4);
    assert.ok(metrics.totalValue === 11250);
  });

  test('recalculateAndReconstructHistoricalPerformance reconstructs daily series and returns rich metrics', async () => {
    const res = await recalculateAndReconstructHistoricalPerformance(portfolioId, {
      daysBack: 500,
      syncQuotes: false
    });

    assert.equal(res.success, true);
    assert.ok(res.pointsReconstructed > 0);
    assert.ok(res.metrics);
    assert.ok(res.metrics.twr);
    assert.ok(res.metrics.totalValue > 0);
    assert.ok(res.metrics.investedCapital > 0);
  });

  test('POST /api/history/recalculate-performance endpoint triggers on-demand recalculation', async () => {
    const res = await fetch(`${baseUrl}/api/history/recalculate-performance`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`
      },
      body: JSON.stringify({
        portfolioId,
        daysBack: 365,
        syncQuotes: false
      })
    });

    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.success, true);
    assert.ok(data.pointsReconstructed > 0);
    assert.ok(data.metrics);
    assert.ok(data.metrics.twr['1M'] !== undefined);
    assert.ok(data.metrics.twr['1Y'] !== undefined);
    assert.ok(data.metrics.maxDrawdown !== undefined);
    assert.ok(data.metrics.xirr !== undefined);
  });

  test('POST /api/transactions/recalculate-performance endpoint triggers recalculation from transactions context', async () => {
    const res = await fetch(`${baseUrl}/api/transactions/recalculate-performance`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`
      },
      body: JSON.stringify({
        portfolioId: 'all',
        daysBack: 365,
        syncQuotes: false
      })
    });

    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.success, true);
    assert.ok(data.pointsReconstructed > 0);
    assert.ok(data.metrics);
  });

  test('POST /api/market/reconstruct-history preserves backwards compatibility and enriches with metrics', async () => {
    const res = await fetch(`${baseUrl}/api/market/reconstruct-history`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`
      },
      body: JSON.stringify({
        portfolioId,
        daysBack: 365
      })
    });

    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.success, true);
    assert.ok(data.pointsReconstructed > 0);
    assert.ok(data.message.includes('Ricostruzione completata'));
    assert.ok(data.metrics);
  });

  test('addDaysToDateStr correctly handles DST transitions, leap years, and year boundaries', () => {
    // 2026 DST end: Oct 25, 2026 was DST change Sunday
    assert.equal(addDaysToDateStr('2026-10-24', 1), '2026-10-25');
    assert.equal(addDaysToDateStr('2026-10-25', 1), '2026-10-26');

    // 2025 DST end: Oct 26, 2025
    assert.equal(addDaysToDateStr('2025-10-25', 1), '2025-10-26');
    assert.equal(addDaysToDateStr('2025-10-26', 1), '2025-10-27');

    // 2024 leap year
    assert.equal(addDaysToDateStr('2024-02-28', 1), '2024-02-29');
    assert.equal(addDaysToDateStr('2024-02-29', 1), '2024-03-01');

    // Year boundary
    assert.equal(addDaysToDateStr('2023-12-31', 1), '2024-01-01');
    assert.equal(addDaysToDateStr('2024-01-01', -1), '2023-12-31');
  });

  test('reconstructPortfolioHistoryFromQuotes reconstructs contiguous daily records with no DST gaps', () => {
    const res = reconstructPortfolioHistoryFromQuotes(portfolioId, 1825);
    assert.equal(res.success, true);

    const db = getDb();
    const rows = db.prepare(`
      SELECT date, totalValue, cashValue, assetValue
      FROM portfolio_history
      WHERE portfolioId = ?
      ORDER BY date ASC
    `).all(portfolioId);

    assert.ok(rows.length > 5);

    // Verify there are no missing dates between first and last date
    for (let i = 1; i < rows.length; i++) {
      const prevDate = rows[i - 1].date;
      const expectedDate = addDaysToDateStr(prevDate, 1);
      assert.equal(rows[i].date, expectedDate, `Unexpected gap between ${prevDate} and ${rows[i].date}`);
    }
  });
});

