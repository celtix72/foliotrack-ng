const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const http = require('http');

const TEST_DB = path.join(__dirname, 'test_portfolio_crud.db');
process.env.DB_PATH = TEST_DB;
process.env.JWT_SECRET = 'test-secret-jwt-very-long-and-secure-crud-test';
process.env.ADMIN_USERNAME = 'admin';
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
    assert.ok(pageJs.includes('fmtEurSigned'), 'portfolios_page.js must implement fmtEurSigned');
    assert.ok(pageJs.includes('Gain Posizioni Aperte'), 'desktop layout must show Gain Posizioni Aperte');
    assert.ok(pageJs.includes('Gain Pos. Aperte'), 'mobile layout must show Gain Pos. Aperte');
    assert.ok(pageJs.includes('Gain Posizioni Chiuse'), 'desktop layout must show Gain Posizioni Chiuse');
    assert.ok(pageJs.includes('Gain Pos. Chiuse'), 'mobile layout must show Gain Pos. Chiuse');
    assert.ok(pageJs.includes('togglePortfolioInclude'), 'portfolios_page.js must implement togglePortfolioInclude');
    assert.ok(pageJs.includes('input type="checkbox" switch'), 'card templates must render switch checkbox');
    assert.ok(pageJs.includes('ft-pillow-switch'), 'card templates must render ft-pillow-switch');
    assert.ok(pageJs.includes('ft-switch-knob'), 'card templates must render ft-switch-knob');
  });

  test('Portfolios API reports total unrealized and realized Gain for open and closed positions', async () => {
    const res = await fetch(`${baseUrl}/api/portfolios`, {
      headers: { Authorization: `Bearer ${authToken}` }
    });
    const data = await res.json();
    assert.equal(data.success, true);
    assert.ok(Array.isArray(data.portfolios));
    for (const p of data.portfolios) {
      assert.notEqual(p.unrealizedPnl, undefined, `Portfolio ${p.id} must expose unrealizedPnl at root`);
      assert.notEqual(p.unrealizedPnlPercent, undefined, `Portfolio ${p.id} must expose unrealizedPnlPercent at root`);
      assert.notEqual(p.realizedPnl, undefined, `Portfolio ${p.id} must expose realizedPnl at root`);
      assert.notEqual(p.metrics?.unrealizedPnl, undefined, `Portfolio ${p.id} metrics must expose unrealizedPnl`);
      assert.notEqual(p.metrics?.realizedPnl, undefined, `Portfolio ${p.id} metrics must expose realizedPnl`);
    }
  });

  test('Portfolio inclusion flag (include_in_totals) toggle and global calculation exclusion', async () => {
    // 1. Create two portfolios with distinct initial cash
    const p1Res = await fetch(`${baseUrl}/api/portfolios`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
      body: JSON.stringify({
        name: 'Portafoglio Alpha Inactive Test',
        type: 'Investimento',
        currency: 'EUR',
        initialCash: 10000,
        include_in_totals: 1
      })
    });
    const p1Data = await p1Res.json();
    assert.equal(p1Data.success, true);
    const p1Id = p1Data.portfolio.id;

    const p2Res = await fetch(`${baseUrl}/api/portfolios`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
      body: JSON.stringify({
        name: 'Portafoglio Beta Active Test',
        type: 'Investimento',
        currency: 'EUR',
        initialCash: 25000,
        include_in_totals: 1
      })
    });
    const p2Data = await p2Res.json();
    assert.equal(p2Data.success, true);
    const p2Id = p2Data.portfolio.id;

    // Both are active initially
    let getList = await (await fetch(`${baseUrl}/api/portfolios`, {
      headers: { Authorization: `Bearer ${authToken}` }
    })).json();
    assert.ok(getList.totals.currentCash >= 35000);

    // 2. Deactivate P1 via PATCH /api/portfolios/:id with include_in_totals: 0
    const patchRes = await fetch(`${baseUrl}/api/portfolios/${p1Id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
      body: JSON.stringify({ include_in_totals: 0 })
    });
    const patchData = await patchRes.json();
    assert.equal(patchData.success, true);
    assert.equal(patchData.portfolio.include_in_totals, 0);

    // 3. Verify GET /api/portfolios totals exclude P1 cash (10000)
    getList = await (await fetch(`${baseUrl}/api/portfolios`, {
      headers: { Authorization: `Bearer ${authToken}` }
    })).json();
    const excludedP1 = getList.portfolios.find(p => p.id === p1Id);
    assert.ok(excludedP1, 'Deactivated portfolio must still be returned in list');
    assert.equal(excludedP1.include_in_totals, 0);
    assert.equal(excludedP1.currentCash, 10000, 'Deactivated portfolio retains its own details');

    const includedP2 = getList.portfolios.find(p => p.id === p2Id);
    assert.equal(includedP2.include_in_totals, 1);

    // Grand total cash should include P2 (25000) and NOT P1 (10000)
    assert.ok(getList.totals.currentCash < 35000);
    assert.ok(getList.totals.currentCash >= 25000);

    // 4. Verify single portfolio detail GET /api/portfolios/:id is accessible even if deactivated
    const singleRes = await fetch(`${baseUrl}/api/portfolios/${p1Id}`, {
      headers: { Authorization: `Bearer ${authToken}` }
    });
    assert.equal(singleRes.status, 200);
    const singleData = await singleRes.json();
    assert.equal(singleData.success, true);
    assert.equal(singleData.portfolio.id, p1Id);
    assert.equal(singleData.portfolio.currentCash, 10000);

    // 5. Verify transactions can still be recorded for the deactivated portfolio
    const txRes = await fetch(`${baseUrl}/api/transactions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
      body: JSON.stringify({
        portfolioId: p1Id,
        type: 'BUY',
        date: new Date().toISOString().split('T')[0],
        assetTicker: 'AAPL',
        quantity: 10,
        price: 150,
        commission: 2
      })
    });
    const txData = await txRes.json();
    assert.equal(txData.success, true);

    // 6. Verify Reports API includes all portfolios regardless of include_in_totals switch
    const reportRes = await fetch(`${baseUrl}/api/reports/portfolio-data`, {
      headers: { Authorization: `Bearer ${authToken}` }
    });
    const reportData = await reportRes.json();
    assert.equal(reportData.success, true);
    const repP1 = reportData.portfolios.find(p => p.id === p1Id);
    // P1 is included in the consolidated report
    assert.ok(repP1, 'Reports API must include all portfolios regardless of include_in_totals switch');
    assert.equal(repP1.id, p1Id);

    // And querying P1 specifically returns its report
    const singleRepRes = await fetch(`${baseUrl}/api/reports/portfolio-data?portfolioId=${p1Id}`, {
      headers: { Authorization: `Bearer ${authToken}` }
    });
    const singleRepData = await singleRepRes.json();
    assert.equal(singleRepData.success, true);
    assert.equal(singleRepData.portfolios.length, 1);
    assert.equal(singleRepData.portfolios[0].id, p1Id);

    // 7. Reactivate P1 via PUT /api/portfolios/:id with include_in_totals: 1
    const putRes = await fetch(`${baseUrl}/api/portfolios/${p1Id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
      body: JSON.stringify({ include_in_totals: 1 })
    });
    const putData = await putRes.json();
    assert.equal(putData.success, true);
    assert.equal(putData.portfolio.include_in_totals, 1);

    // Verify it is re-included in grand totals
    getList = await (await fetch(`${baseUrl}/api/portfolios`, {
      headers: { Authorization: `Bearer ${authToken}` }
    })).json();
    assert.ok(getList.totals.currentCash >= 33498); // 25000 + (10000 - 1502)
  });

  test('Pensione Portfolio: taxRate setting, NAV taxation, and Lordo / Netto calculation', async () => {
    // 1. Create a Pensione portfolio with initial cash 20000 and taxRate 15%
    const createRes = await fetch(`${baseUrl}/api/portfolios`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
      body: JSON.stringify({
        name: 'Fondo Pensione Integrativo',
        type: 'Pensione',
        currency: 'EUR',
        costBasisMethod: 'WAC',
        initialCash: 20000,
        taxRate: 15.0,
        include_in_totals: 1
      })
    });
    assert.equal(createRes.status, 201);
    const createData = await createRes.json();
    assert.equal(createData.success, true);
    const pensionPort = createData.portfolio;
    assert.equal(pensionPort.type, 'Pensione');
    assert.equal(pensionPort.taxRate, 15.0);
    assert.equal(pensionPort.totalValue, 20000);
    // NAV Lordo = 20000, tax 15% = 3000, NAV Netto = 17000
    assert.equal(pensionPort.estimatedTax, 3000);
    assert.equal(pensionPort.netValue, 17000);
    assert.equal(pensionPort.taxation.isPension, true);
    assert.equal(pensionPort.taxation.taxRate, 15.0);

    // 2. Update taxRate to 9.0% (e.g. after 35 years of contribution)
    const updateRes = await fetch(`${baseUrl}/api/portfolios/${pensionPort.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
      body: JSON.stringify({
        taxRate: 9.0
      })
    });
    assert.equal(updateRes.status, 200);
    const updateData = await updateRes.json();
    assert.equal(updateData.success, true);
    assert.equal(updateData.portfolio.taxRate, 9.0);
    // NAV Lordo = 20000, tax 9% = 1800, NAV Netto = 18200
    assert.equal(updateData.portfolio.estimatedTax, 1800);
    assert.equal(updateData.portfolio.netValue, 18200);

    // 3. Verify GET /api/portfolios returns pension portfolio with Lordo & Netto
    const listRes = await fetch(`${baseUrl}/api/portfolios`, {
      headers: { Authorization: `Bearer ${authToken}` }
    });
    const listData = await listRes.json();
    const found = listData.portfolios.find(p => p.id === pensionPort.id);
    assert.ok(found);
    assert.equal(found.totalValue, 20000);
    assert.equal(found.netValue, 18200);
    assert.equal(found.estimatedTax, 1800);

    // 4. Verify Reports API returns pension tax breakdown
    const repRes = await fetch(`${baseUrl}/api/reports/portfolio-data?portfolioId=${pensionPort.id}`, {
      headers: { Authorization: `Bearer ${authToken}` }
    });
    const repData = await repRes.json();
    assert.equal(repData.success, true);
    const pReport = repData.portfolios[0];
    assert.equal(pReport.type, 'Pensione');
    assert.equal(pReport.taxRate, 9.0);
    assert.equal(pReport.totalValue, 20000);
    assert.equal(pReport.netValue, 18200);
    assert.equal(pReport.estimatedTax, 1800);
    assert.equal(pReport.taxation.isPension, true);

    // 5. Template and script file verification
    const desktopHtml = fs.readFileSync(path.join(__dirname, '../private_views/portfolios.html'), 'utf8');
    const mobileHtml = fs.readFileSync(path.join(__dirname, '../private_views/portfolios_mobile.html'), 'utf8');
    const pageJs = fs.readFileSync(path.join(__dirname, '../public/portfolios_page.js'), 'utf8');
    const detailDesktopHtml = fs.readFileSync(path.join(__dirname, '../private_views/portfolio_detail.html'), 'utf8');
    const detailMobileHtml = fs.readFileSync(path.join(__dirname, '../private_views/portfolio_detail_mobile.html'), 'utf8');

    assert.ok(desktopHtml.includes('modalPensionTaxGroup'));
    assert.ok(desktopHtml.includes('modalPortfolioTaxRate'));
    assert.ok(mobileHtml.includes('modalPensionTaxGroup'));
    assert.ok(mobileHtml.includes('modalPortfolioTaxRate'));
    assert.ok(pageJs.includes('modalPensionTaxGroup'));
    assert.ok(pageJs.includes('pensionTaxRate'));
    assert.ok(pageJs.includes('Netto'));
    assert.ok(detailDesktopHtml.includes('statNavLabel'));
    assert.ok(detailMobileHtml.includes('mStatNavLabel'));
  });
});
