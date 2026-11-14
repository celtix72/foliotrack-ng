const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const http = require('http');

const TEST_DB = path.join(__dirname, 'test_portfolio_crud.db');
process.env.DB_PATH = TEST_DB;
process.env.JWT_SECRET = 'test-secret-jwt-very-long-and-secure-crud-test';
process.env.ADMIN_PASSWORD = 'adminCrudPassword123!';

const { initDb, closeDb, getDb } = require('../src/db');
const app = require('../src/app');

let server;
let baseUrl;
let authToken;

describe('Portfolio Full CRUD & Multi-Portfolio Selector Verification', () => {
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
      body: JSON.stringify({ username: 'admin', password: 'adminCrudPassword123!' })
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

  test('POST /api/portfolios creates portfolio with all README specified fields', async () => {
    const payload = {
      name: 'Portafoglio Trading Attivo',
      type: 'Trading',
      currency: 'USD',
      costBasisMethod: 'FIFO',
      startDate: '2025-06-15',
      initialCash: 12500,
      color: '#b89a4c',
      include_in_totals: 1
    };

    const res = await fetch(`${baseUrl}/api/portfolios`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`
      },
      body: JSON.stringify(payload)
    });

    assert.equal(res.status, 201);
    const data = await res.json();
    assert.equal(data.success, true);
    assert.equal(data.portfolio.name, payload.name);
    assert.equal(data.portfolio.type, payload.type);
    assert.equal(data.portfolio.currency, payload.currency);
    assert.equal(data.portfolio.costBasisMethod, payload.costBasisMethod);
    assert.equal(data.portfolio.startDate, payload.startDate);
    assert.equal(data.portfolio.initialCash, payload.initialCash);
    assert.equal(data.portfolio.currentCash, payload.initialCash);
    assert.equal(data.portfolio.color, payload.color);
    assert.equal(data.portfolio.include_in_totals, 1);
  });

  test('PUT /api/portfolios/:id updates all fields including initialCash and recalculates', async () => {
    // 1. Get created portfolio
    const listRes = await fetch(`${baseUrl}/api/portfolios`, {
      headers: { Authorization: `Bearer ${authToken}` }
    });
    const listData = await listRes.json();
    const p = listData.portfolios.find(x => x.name === 'Portafoglio Trading Attivo');
    assert.ok(p, 'Created portfolio should be found');

    // 2. Update with PUT
    const updatePayload = {
      name: 'Portafoglio Trading Ridenominato',
      type: 'Investimento',
      currency: 'EUR',
      costBasisMethod: 'WAC',
      startDate: '2025-01-01',
      initialCash: 18000,
      color: '#357941',
      include_in_totals: 0
    };

    const putRes = await fetch(`${baseUrl}/api/portfolios/${p.id}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`
      },
      body: JSON.stringify(updatePayload)
    });

    assert.equal(putRes.status, 200);
    const putData = await putRes.json();
    assert.equal(putData.success, true);
    assert.equal(putData.portfolio.name, updatePayload.name);
    assert.equal(putData.portfolio.type, updatePayload.type);
    assert.equal(putData.portfolio.currency, updatePayload.currency);
    assert.equal(putData.portfolio.costBasisMethod, updatePayload.costBasisMethod);
    assert.equal(putData.portfolio.startDate, updatePayload.startDate);
    assert.equal(putData.portfolio.initialCash, 18000);
    assert.equal(putData.portfolio.currentCash, 18000);
    assert.equal(putData.portfolio.color, updatePayload.color);
    assert.equal(putData.portfolio.include_in_totals, 0);
  });

  test('DELETE /api/portfolios/:id cascades and removes all associated movements and data', async () => {
    const db = getDb();

    // 1. Create a dedicated portfolio for deletion test
    const createRes = await fetch(`${baseUrl}/api/portfolios`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`
      },
      body: JSON.stringify({
        name: 'Portafoglio Da Eliminare',
        type: 'Trading',
        currency: 'EUR',
        costBasisMethod: 'WAC',
        initialCash: 5000
      })
    });
    const createData = await createRes.json();
    const delPortfolioId = createData.portfolio.id;

    // 2. Add asset and transactions to it
    db.prepare(`
      INSERT OR IGNORE INTO assets (ticker, name, type, currency, currentPrice)
      VALUES ('DELTEST.MI', 'Delete Test Asset', 'EQUITY', 'EUR', 100.0)
    `).run();

    db.prepare(`
      INSERT INTO transactions (portfolioId, type, assetTicker, date, quantity, price, amount)
      VALUES (?, 'BUY', 'DELTEST.MI', '2025-02-01', 10, 100.0, 1000.0)
    `).run(delPortfolioId);

    db.prepare(`
      INSERT INTO dividend_projections (portfolioId, assetTicker, projectedAnnualIncome)
      VALUES (?, 'DELTEST.MI', 50.0)
    `).run(delPortfolioId);

    db.prepare(`
      INSERT INTO portfolio_history (portfolioId, date, totalValue, cashValue, assetValue, netDeposits, user_id)
      VALUES (?, '2025-02-01', 5000, 4000, 1000, 5000, 1)
    `).run(delPortfolioId);

    db.prepare(`
      INSERT INTO portfolio_losses (portfolioId, year, expiryDate, amount, residualAmount)
      VALUES (?, 2024, '2028-12-31', 300, 300)
    `).run(delPortfolioId);

    // Verify records exist before delete (initial deposit + buy transaction = 2)
    assert.equal(db.prepare('SELECT COUNT(*) as c FROM transactions WHERE portfolioId = ?').get(delPortfolioId).c, 2);
    assert.equal(db.prepare('SELECT COUNT(*) as c FROM dividend_projections WHERE portfolioId = ?').get(delPortfolioId).c, 1);
    assert.equal(db.prepare('SELECT COUNT(*) as c FROM portfolio_history WHERE portfolioId = ?').get(delPortfolioId).c, 1);
    assert.equal(db.prepare('SELECT COUNT(*) as c FROM portfolio_losses WHERE portfolioId = ?').get(delPortfolioId).c, 1);

    // 3. Perform DELETE
    const delRes = await fetch(`${baseUrl}/api/portfolios/${delPortfolioId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${authToken}` }
    });
    assert.equal(delRes.status, 200);
    const delData = await delRes.json();
    assert.equal(delData.success, true);

    // 4. Assert ALL associated records are purged from the database
    assert.equal(db.prepare('SELECT COUNT(*) as c FROM portfolios WHERE id = ?').get(delPortfolioId).c, 0);
    assert.equal(db.prepare('SELECT COUNT(*) as c FROM transactions WHERE portfolioId = ?').get(delPortfolioId).c, 0);
    assert.equal(db.prepare('SELECT COUNT(*) as c FROM dividend_projections WHERE portfolioId = ?').get(delPortfolioId).c, 0);
    assert.equal(db.prepare('SELECT COUNT(*) as c FROM portfolio_history WHERE portfolioId = ?').get(delPortfolioId).c, 0);
    assert.equal(db.prepare('SELECT COUNT(*) as c FROM portfolio_losses WHERE portfolioId = ?').get(delPortfolioId).c, 0);
    assert.equal(db.prepare('SELECT COUNT(*) as c FROM portfolio_users WHERE portfolio_id = ?').get(delPortfolioId).c, 0);
  });

  test('UI Views Dual-Rendering and Portfolio Selectors', async () => {
    // Desktop Portfolios View
    const desktopRes = await fetch(`${baseUrl}/portfolios`, {
      headers: { Cookie: `token=${authToken}` }
    });
    assert.equal(desktopRes.status, 200);
    const desktopHtml = await desktopRes.text();
    assert.ok(desktopHtml.includes('modalPortfolioName'));
    assert.ok(desktopHtml.includes('modalPortfolioCostBasis'));
    assert.ok(desktopHtml.includes('modalPortfolioStartDate'));
    assert.ok(desktopHtml.includes('modalPortfolioInitialCash'));

    // Mobile Portfolios View
    const mobileRes = await fetch(`${baseUrl}/portfolios?view=mobile`, {
      headers: { Cookie: `token=${authToken}` }
    });
    assert.equal(mobileRes.status, 200);
    const mobileHtml = await mobileRes.text();
    assert.ok(mobileHtml.includes('modalPortfolioName'));
    assert.ok(mobileHtml.includes('modalPortfolioCostBasis'));
    assert.ok(mobileHtml.includes('modalPortfolioInitialCash'));
    assert.ok(mobileHtml.includes('portfolios-list'));

    // Dashboard Desktop & Mobile Selectors
    const dashDesktopRes = await fetch(`${baseUrl}/`, {
      headers: { Cookie: `token=${authToken}` }
    });
    const dashDesktopHtml = await dashDesktopRes.text();
    assert.ok(dashDesktopHtml.includes('dashboardPortfolioSelect'));

    const dashMobileRes = await fetch(`${baseUrl}/?view=mobile`, {
      headers: { Cookie: `token=${authToken}` }
    });
    const dashMobileHtml = await dashMobileRes.text();
    assert.ok(dashMobileHtml.includes('mDashboardPortfolioSelect'));
  });

  test('Mobile portfolios page renders compact layout focusing on Controvalore and Liquidità', () => {
    const pageJs = fs.readFileSync(path.join(__dirname, '../public/portfolios_page.js'), 'utf8');

    // Syntax validity of portfolios_page.js
    assert.doesNotThrow(() => {
      new Function(pageJs);
    }, 'portfolios_page.js must be syntactically valid JS');

    assert.ok(pageJs.includes('function renderMobilePortfolios'), 'portfolios_page.js must contain renderMobilePortfolios');
    assert.ok(pageJs.includes('function renderDesktopPortfolios'), 'portfolios_page.js must contain renderDesktopPortfolios');
    assert.ok(pageJs.includes('Controvalore'), 'mobile layout must show Controvalore');
    assert.ok(pageJs.includes('Liquidità'), 'mobile layout must show Liquidità');
  });
});
