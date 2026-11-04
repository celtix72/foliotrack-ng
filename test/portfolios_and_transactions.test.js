const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const http = require('http');

const TEST_DB = path.join(__dirname, 'test_phase2.db');
process.env.DB_PATH = TEST_DB;
process.env.JWT_SECRET = 'test-secret-jwt-very-long-and-secure-phase2';
process.env.ADMIN_PASSWORD = 'adminPhase2Password!';

const { initDb, closeDb, getDb } = require('../src/db');
const app = require('../src/app');

let server;
let baseUrl;
let authToken;

describe('Phase 2: Financial Engine, Taxonomy & Multi-Portfolio API', () => {
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

    // Login as admin to get auth token
    const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'adminPhase2Password!' })
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

  test('GET /api/assets/taxonomy returns complete GICS sectors and taxonomy', async () => {
    const res = await fetch(`${baseUrl}/api/assets/taxonomy`, {
      headers: { Authorization: `Bearer ${authToken}` }
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.success, true);
    assert.equal(data.taxonomy.sectors.length, 11);
    assert.ok(data.taxonomy.sectors.includes('Information Technology'));
    assert.ok(data.taxonomy.sectors.includes('Financials'));
    assert.ok(data.taxonomy.sectors.includes('Health Care'));
    assert.ok(data.taxonomy.assetTypes.includes('EQUITY'));
    assert.ok(data.taxonomy.assetTypes.includes('ETF'));
    assert.ok(data.taxonomy.assetTypes.includes('BOND'));
  });

  test('POST /api/assets creates and updates asset with sector and region', async () => {
    const res = await fetch(`${baseUrl}/api/assets`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`
      },
      body: JSON.stringify({
        ticker: 'CSPX.MI',
        name: 'iShares Core S&P 500 UCITS ETF',
        type: 'ETF',
        currency: 'EUR',
        currentPrice: 500.0,
        sector: 'Information Technology',
        region: 'Americas',
        country: 'US',
        riskCategory: 'MEDIUM',
        dividendYield: 1.2
      })
    });

    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.success, true);
    assert.equal(data.asset.ticker, 'CSPX.MI');
    assert.equal(data.asset.sector, 'Information Technology');
    assert.equal(data.asset.region, 'Americas');
  });

  let portfolioId;

  test('POST /api/portfolios creates new portfolio with WAC cost basis', async () => {
    const res = await fetch(`${baseUrl}/api/portfolios`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`
      },
      body: JSON.stringify({
        name: 'Portafoglio Core ETF',
        type: 'Investimento',
        currency: 'EUR',
        costBasisMethod: 'WAC',
        initialCash: 10000.0,
        color: '#357941',
        include_in_totals: true
      })
    });

    assert.equal(res.status, 201);
    const data = await res.json();
    assert.equal(data.success, true);
    portfolioId = data.portfolio.id;
    assert.equal(data.portfolio.name, 'Portafoglio Core ETF');
    assert.equal(data.portfolio.currentCash, 10000.0);
    assert.equal(data.portfolio.investedCapital, 10000.0);
    assert.equal(data.portfolio.costBasisMethod, 'WAC');
  });

  test('POST /api/transactions buys asset and calculates PMC and cash', async () => {
    // Buy 10 shares of CSPX.MI at 450 EUR each, 5 EUR commission
    const res = await fetch(`${baseUrl}/api/transactions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`
      },
      body: JSON.stringify({
        portfolioId,
        type: 'BUY',
        assetTicker: 'CSPX.MI',
        date: '2023-01-15',
        quantity: 10,
        price: 450.0,
        commission: 5.0,
        tax: 0.0
      })
    });

    assert.equal(res.status, 201);
    const data = await res.json();
    assert.equal(data.success, true);
    // Cost = 10 * 450 + 5 = 4505 EUR
    assert.equal(data.transaction.amount, 4505.0);

    // Cash check: 10000 - 4505 = 5495 EUR
    assert.equal(data.portfolio.currentCash, 5495.0);

    // Holding check: 10 shares, PMC = 4505 / 10 = 450.5 EUR
    assert.equal(data.portfolio.metrics.holdings.length, 1);
    const h = data.portfolio.metrics.holdings[0];
    assert.equal(h.ticker, 'CSPX.MI');
    assert.equal(h.quantity, 10);
    assert.equal(h.pmc, 450.5);

    // Market price in DB is 500 EUR -> Market value = 5000 EUR
    assert.equal(h.marketValue, 5000.0);
    // Unrealized PnL = 5000 - 4505 = 495 EUR
    assert.equal(h.unrealizedPnl, 495.0);
  });

  test('POST /api/transactions prevents selling more shares than held', async () => {
    const res = await fetch(`${baseUrl}/api/transactions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`
      },
      body: JSON.stringify({
        portfolioId,
        type: 'SELL',
        assetTicker: 'CSPX.MI',
        date: '2023-02-01',
        quantity: 20, // Only 10 held!
        price: 520.0
      })
    });

    assert.equal(res.status, 400);
    const data = await res.json();
    assert.equal(data.success, false);
    assert.ok(data.error.includes('Quantità insufficiente'));
  });

  test('POST /api/transactions sells partial shares and records realized P&L', async () => {
    // Sell 4 shares of CSPX.MI at 520 EUR, commission 5 EUR
    const res = await fetch(`${baseUrl}/api/transactions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`
      },
      body: JSON.stringify({
        portfolioId,
        type: 'SELL',
        assetTicker: 'CSPX.MI',
        date: '2023-02-15',
        quantity: 4,
        price: 520.0,
        commission: 5.0,
        tax: 0.0
      })
    });

    assert.equal(res.status, 201);
    const data = await res.json();
    assert.equal(data.success, true);

    // Net proceeds: 4 * 520 - 5 = 2075 EUR
    assert.equal(data.transaction.amount, 2075.0);

    // Cash check: 5495 + 2075 = 7570 EUR
    assert.equal(data.portfolio.currentCash, 7570.0);

    // Realized P&L: Proceeds (2075) - Cost of 4 shares (4 * 450.5 = 1802) = 273 EUR
    assert.equal(data.portfolio.metrics.realizedPnl, 273.0);

    // Remaining quantity: 6 shares. PMC remains 450.5 EUR!
    const h = data.portfolio.metrics.holdings[0];
    assert.equal(h.quantity, 6);
    assert.equal(h.pmc, 450.5);
  });

  test('POST /api/transactions records dividend receipt', async () => {
    const res = await fetch(`${baseUrl}/api/transactions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`
      },
      body: JSON.stringify({
        portfolioId,
        type: 'DIVIDEND',
        assetTicker: 'CSPX.MI',
        date: '2023-03-01',
        amount: 35.0,
        notes: 'Dividendo trimestrale'
      })
    });

    assert.equal(res.status, 201);
    const data = await res.json();
    assert.equal(data.portfolio.metrics.totalDividends, 35.0);
    // Cash increases: 7570 + 35 = 7605 EUR
    assert.equal(data.portfolio.currentCash, 7605.0);
  });

  test('GET /api/portfolios returns list with aggregated totals and allocations', async () => {
    const res = await fetch(`${baseUrl}/api/portfolios`, {
      headers: { Authorization: `Bearer ${authToken}` }
    });

    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.success, true);
    assert.ok(data.portfolios.length >= 1);
    assert.ok(data.totals);
    assert.ok(data.totals.totalValue > 0);
    assert.ok(data.totals.allocations.byAssetClass['ETF']);
    assert.ok(data.totals.allocations.byAssetClass['CASH']);
    assert.ok(data.totals.allocations.bySector['Information Technology']);
    assert.ok(data.totals.allocations.byRegion['Americas']);
  });

  test('GET /api/transactions with filtering and pagination', async () => {
    const res = await fetch(`${baseUrl}/api/transactions?portfolioId=${portfolioId}&type=BUY`, {
      headers: { Authorization: `Bearer ${authToken}` }
    });

    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.success, true);
    assert.equal(data.transactions.length, 1);
    assert.equal(data.transactions[0].type, 'BUY');
    assert.equal(data.transactions[0].assetTicker, 'CSPX.MI');
    assert.equal(data.transactions[0].assetName, 'iShares Core S&P 500 UCITS ETF');
  });

  test('PUT and DELETE /api/portfolios/:id', async () => {
    // Update portfolio name
    const putRes = await fetch(`${baseUrl}/api/portfolios/${portfolioId}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`
      },
      body: JSON.stringify({ name: 'Portafoglio Core ETF Modificato' })
    });
    assert.equal(putRes.status, 200);
    const putData = await putRes.json();
    assert.equal(putData.portfolio.name, 'Portafoglio Core ETF Modificato');

    // Delete portfolio
    const delRes = await fetch(`${baseUrl}/api/portfolios/${portfolioId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${authToken}` }
    });
    assert.equal(delRes.status, 200);

    // Verify it is gone
    const getRes = await fetch(`${baseUrl}/api/portfolios/${portfolioId}`, {
      headers: { Authorization: `Bearer ${authToken}` }
    });
    assert.equal(getRes.status, 404);
  });
});
