const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');

const TEST_DB = path.join(__dirname, 'test_phase7.db');
process.env.DB_PATH = TEST_DB;
process.env.JWT_SECRET = 'test-secret-phase7-full-stack-frontend';
process.env.ADMIN_PASSWORD = 'adminPhase7Password!';
process.env.NODE_ENV = 'test';

const { initDb, closeDb, db } = require('../src/db');
const app = require('../src/app');

let server;
let baseUrl;
let authToken;
let testPortfolioId;
let testTxId;

describe('Phase 7: Portfolio Detail, Transactions Register & Bulk CSV Uploader', () => {
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
      body: JSON.stringify({ username: 'admin', password: 'adminPhase7Password!' })
    });
    const loginData = await loginRes.json();
    authToken = loginData.token;

    // Create a portfolio with initial cash
    const portRes = await fetch(`${baseUrl}/api/portfolios`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`
      },
      body: JSON.stringify({
        name: 'Tech & Growth Alpha',
        type: 'Investimento',
        currency: 'EUR',
        initialCash: 10000
      })
    });
    const portData = await portRes.json();
    testPortfolioId = portData.portfolio.id;

    // Create an asset with GICS sector and region
    await fetch(`${baseUrl}/api/assets`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`
      },
      body: JSON.stringify({
        ticker: 'MSFT',
        name: 'Microsoft Corporation',
        type: 'EQUITY',
        currency: 'EUR',
        currentPrice: 400.0,
        sector: 'Information Technology',
        region: 'Americas'
      })
    });

    // Buy 10 shares of MSFT
    const buyRes = await fetch(`${baseUrl}/api/transactions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`
      },
      body: JSON.stringify({
        portfolioId: testPortfolioId,
        type: 'BUY',
        assetTicker: 'MSFT',
        date: '2024-01-15',
        quantity: 10,
        price: 380.0,
        commission: 5.0,
        notes: 'Initial MSFT purchase'
      })
    });
    const buyData = await buyRes.json();
    testTxId = buyData.transaction.id;
  });

  after(async () => {
    if (server) await new Promise((res) => server.close(res));
    closeDb();
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    const wal = `${TEST_DB}-wal`;
    const shm = `${TEST_DB}-shm`;
    if (fs.existsSync(wal)) fs.unlinkSync(wal);
    if (fs.existsSync(shm)) fs.unlinkSync(shm);
  });

  describe('1. Static Frontend Assets for Phase 7', () => {
    test('serves public/bulk_import.js with BulkImportModal API', async () => {
      const res = await fetch(`${baseUrl}/bulk_import.js`);
      assert.strictEqual(res.status, 200);
      const text = await res.text();
      assert.ok(text.includes('BulkImportModal'));
      assert.ok(text.includes('dropZone'));
      assert.ok(text.includes('previewContainer'));
    });

    test('serves public/asset_drawer.js with AssetDrawer API and Chart.js integration', async () => {
      const res = await fetch(`${baseUrl}/asset_drawer.js`);
      assert.strictEqual(res.status, 200);
      const text = await res.text();
      assert.ok(text.includes('AssetDrawer'));
      assert.ok(text.includes('drawerChartCanvas'));
      assert.ok(text.includes('loadHistoricalChart'));
      assert.ok(text.includes('loadDividendHistory'));
    });
  });

  describe('2. Dual-View Routing for Portfolio Detail & Transactions', () => {
    test('GET /portfolios/:id redirects to login if unauthenticated', async () => {
      const res = await fetch(`${baseUrl}/portfolios/${testPortfolioId}`, {
        redirect: 'manual'
      });
      assert.strictEqual(res.status, 302);
      assert.ok(res.headers.get('location').includes('login.html'));
    });

    test('GET /portfolios/:id serves desktop portfolio_detail with injected sidebar', async () => {
      const res = await fetch(`${baseUrl}/portfolios/${testPortfolioId}`, {
        headers: { Cookie: `foliotrack_token=${authToken}` }
      });
      assert.strictEqual(res.status, 200);
      const html = await res.text();
      assert.ok(html.includes('Posizioni Aperte (Holdings)'));
      assert.ok(html.includes('Posizioni Chiuse'));
      assert.ok(html.includes('closedTbody'));
      assert.ok(html.includes('data-holding-sort'));
      assert.ok(html.includes('data-closed-sort'));
      assert.ok(html.includes('Settore GICS'));
      assert.ok(html.includes('sidebar-container') || html.includes('FolioTrack'));
      assert.ok(html.includes('/bulk_import.js'));
      assert.ok(html.includes('/asset_drawer.js'));
    });

    test('GET /portfolios/:id?view=mobile serves mobile portfolio detail layout', async () => {
      const res = await fetch(`${baseUrl}/portfolios/${testPortfolioId}?view=mobile`, {
        headers: { Cookie: `foliotrack_token=${authToken}` }
      });
      assert.strictEqual(res.status, 200);
      const html = await res.text();
      assert.ok(html.includes('mHoldingsContainer'));
      assert.ok(html.includes('mStatNav'));
      assert.ok(html.includes('mTabClosed'));
      assert.ok(html.includes('mClosedContainer'));
      assert.ok(html.includes('mNewTxFab'));
    });

    test('GET /transactions serves desktop transaction register with filters & pagination', async () => {
      const res = await fetch(`${baseUrl}/transactions`, {
        headers: { Cookie: `foliotrack_token=${authToken}` }
      });
      assert.strictEqual(res.status, 200);
      const html = await res.text();
      assert.ok(html.includes('Registro Movimenti'));
      assert.ok(html.includes('filterPortfolio'));
      assert.ok(html.includes('filterType'));
      assert.ok(html.includes('exportWealthfolioBtn'));
      assert.ok(html.includes('deleteConfirmModal'));
    });

    test('GET /transactions?view=mobile serves mobile transactions register', async () => {
      const res = await fetch(`${baseUrl}/transactions?view=mobile`, {
        headers: { Cookie: `foliotrack_token=${authToken}` }
      });
      assert.strictEqual(res.status, 200);
      const html = await res.text();
      assert.ok(html.includes('mTxListContainer'));
      assert.ok(html.includes('mToggleFiltersBtn'));
      assert.ok(html.includes('mExportBtn'));
    });
  });

  describe('3. Functional Backend API for Detail & Register Operations', () => {
    test('GET /api/portfolios/:id returns holdings with GICS sectors, weights and PMC', async () => {
      const res = await fetch(`${baseUrl}/api/portfolios/${testPortfolioId}`, {
        headers: { Authorization: `Bearer ${authToken}` }
      });
      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.strictEqual(data.success, true);
      assert.ok(data.portfolio);
      assert.strictEqual(data.portfolio.name, 'Tech & Growth Alpha');

      const holdings = data.portfolio.metrics.holdings;
      assert.strictEqual(holdings.length, 1);
      const msft = holdings[0];
      assert.strictEqual(msft.ticker, 'MSFT');
      assert.strictEqual(msft.sector, 'Information Technology');
      assert.strictEqual(msft.region, 'Americas');
      assert.strictEqual(msft.quantity, 10);
      assert.strictEqual(msft.currentPrice, 400);
      assert.strictEqual(msft.marketValue, 4000);
      // Cost basis: (10 * 380 + 5) / 10 = 380.5
      assert.strictEqual(msft.costBasis, 380.5);
      // Unrealized PnL: 4000 - 3805 = 195
      assert.strictEqual(msft.unrealizedPnL, 195);
      assert.ok(msft.weight > 0);
    });

    test('GET /api/transactions supports multi-criteria filtering', async () => {
      // Filter by ticker
      const resTicker = await fetch(`${baseUrl}/api/transactions?portfolioId=${testPortfolioId}&assetTicker=MSFT`, {
        headers: { Authorization: `Bearer ${authToken}` }
      });
      const dataTicker = await resTicker.json();
      assert.strictEqual(dataTicker.success, true);
      assert.strictEqual(dataTicker.total, 1);
      assert.strictEqual(dataTicker.transactions[0].assetTicker, 'MSFT');

      // Filter by type
      const resType = await fetch(`${baseUrl}/api/transactions?portfolioId=${testPortfolioId}&type=SELL`, {
        headers: { Authorization: `Bearer ${authToken}` }
      });
      const dataType = await resType.json();
      assert.strictEqual(dataType.success, true);
      assert.strictEqual(dataType.total, 0); // No sells yet
    });

    test('PUT /api/transactions/:id updates transaction and recalculates metrics', async () => {
      const updateRes = await fetch(`${baseUrl}/api/transactions/${testTxId}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${authToken}`
        },
        body: JSON.stringify({
          quantity: 12,
          price: 375.0,
          commission: 3.0,
          notes: 'Updated purchase 12 shares'
        })
      });
      assert.strictEqual(updateRes.status, 200);
      const updateData = await updateRes.json();
      assert.strictEqual(updateData.success, true);
      assert.strictEqual(updateData.transaction.quantity, 12);
      assert.strictEqual(updateData.transaction.price, 375.0);

      // Verify portfolio metrics updated
      const portRes = await fetch(`${baseUrl}/api/portfolios/${testPortfolioId}`, {
        headers: { Authorization: `Bearer ${authToken}` }
      });
      const portData = await portRes.json();
      const msft = portData.portfolio.metrics.holdings[0];
      assert.strictEqual(msft.quantity, 12);
      assert.strictEqual(msft.marketValue, 12 * 400);
    });

    test('DELETE /api/transactions/:id deletes transaction and recalculates cash', async () => {
      const delRes = await fetch(`${baseUrl}/api/transactions/${testTxId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${authToken}` }
      });
      assert.strictEqual(delRes.status, 200);
      const delData = await delRes.json();
      assert.strictEqual(delData.success, true);

      // Verify BUY transaction no longer in DB (only initial DEPOSIT remains)
      const listRes = await fetch(`${baseUrl}/api/transactions?portfolioId=${testPortfolioId}`, {
        headers: { Authorization: `Bearer ${authToken}` }
      });
      const listData = await listRes.json();
      assert.strictEqual(listData.total, 1);
      assert.strictEqual(listData.transactions[0].type, 'DEPOSIT');

      // Verify portfolio cash restored to initial cash
      const portRes = await fetch(`${baseUrl}/api/portfolios/${testPortfolioId}`, {
        headers: { Authorization: `Bearer ${authToken}` }
      });
      const portData = await portRes.json();
      assert.strictEqual(portData.portfolio.currentCash, 10000);
      assert.strictEqual(portData.portfolio.metrics.holdings.length, 0);
    });

    test('POST BUY and SELL generates closedPositions with partial and total realization metrics', async () => {
      // 1. BUY 20 shares of MSFT at 100 EUR
      const buyRes = await fetch(`${baseUrl}/api/transactions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${authToken}`
        },
        body: JSON.stringify({
          portfolioId: testPortfolioId,
          type: 'BUY',
          assetTicker: 'MSFT',
          quantity: 20,
          price: 100.0,
          commission: 0,
          tax: 0,
          date: '2026-03-01'
        })
      });
      assert.strictEqual(buyRes.status, 201);

      // 2. Partial SELL: 10 shares of MSFT at 150 EUR
      const sellPartRes = await fetch(`${baseUrl}/api/transactions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${authToken}`
        },
        body: JSON.stringify({
          portfolioId: testPortfolioId,
          type: 'SELL',
          assetTicker: 'MSFT',
          quantity: 10,
          price: 150.0,
          commission: 5.0,
          tax: 0,
          date: '2026-03-15'
        })
      });
      assert.strictEqual(sellPartRes.status, 201);

      // 3. Total SELL: remaining 10 shares of MSFT at 200 EUR
      const sellTotRes = await fetch(`${baseUrl}/api/transactions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${authToken}`
        },
        body: JSON.stringify({
          portfolioId: testPortfolioId,
          type: 'SELL',
          assetTicker: 'MSFT',
          quantity: 10,
          price: 200.0,
          commission: 5.0,
          tax: 0,
          date: '2026-04-01'
        })
      });
      assert.strictEqual(sellTotRes.status, 201);

      // 4. Check portfolio closedPositions
      const pRes = await fetch(`${baseUrl}/api/portfolios/${testPortfolioId}`, {
        headers: { Authorization: `Bearer ${authToken}` }
      });
      const pData = await pRes.json();
      assert.strictEqual(pData.success, true);
      const closed = pData.portfolio.closedPositions || pData.portfolio.metrics.closedPositions;
      assert.ok(Array.isArray(closed));
      assert.strictEqual(closed.length, 2);

      // First sell: partial
      assert.strictEqual(closed[0].ticker, 'MSFT');
      assert.strictEqual(closed[0].closeType, 'PARZIALE');
      assert.strictEqual(closed[0].quantity, 10);
      assert.strictEqual(closed[0].sellPrice, 150);
      // Cost: 10 * 100 = 1000. Proceeds: 10 * 150 - 5 = 1495. Realized PnL: 495.
      assert.strictEqual(closed[0].realizedPnl, 495);

      // Second sell: total
      assert.strictEqual(closed[1].ticker, 'MSFT');
      assert.strictEqual(closed[1].closeType, 'TOTALE');
      assert.strictEqual(closed[1].quantity, 10);
      assert.strictEqual(closed[1].sellPrice, 200);
      // Cost: 10 * 100 = 1000. Proceeds: 10 * 200 - 5 = 1995. Realized PnL: 995.
      assert.strictEqual(closed[1].realizedPnl, 995);
    });
  });
});

