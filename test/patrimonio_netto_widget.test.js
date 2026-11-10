const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const http = require('http');

const TEST_DB = path.join(__dirname, 'test_patrimonio_netto.db');
process.env.DB_PATH = TEST_DB;
process.env.JWT_SECRET = 'test-secret-patrimonio-netto';
process.env.ADMIN_PASSWORD = 'adminPassNetto123!';
process.env.NODE_ENV = 'test';

const { initDb, closeDb, db } = require('../src/db');
const app = require('../src/app');

let server;
let baseUrl;
let authToken;

describe('Patrimonio Lordo & Patrimonio Netto Engine & Dashboard Widget', () => {
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

    // Log in as default admin
    const res = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'admin',
        password: 'adminPassNetto123!'
      })
    });
    const data = await res.json();
    assert.equal(data.success, true);
    authToken = data.token;
  });

  after(() => {
    if (server) server.close();
    closeDb();
    if (fs.existsSync(TEST_DB)) {
      try { fs.unlinkSync(TEST_DB); } catch (_) {}
    }
    const wal = TEST_DB + '-wal';
    const shm = TEST_DB + '-shm';
    if (fs.existsSync(wal)) try { fs.unlinkSync(wal); } catch (_) {}
    if (fs.existsSync(shm)) try { fs.unlinkSync(shm); } catch (_) {}
  });

  test('1. Recalculate portfolio computes netValue, estimatedTax (26% equity, 12.5% bond) with minusvalenze compensation', async () => {
    // Create Portfolio 1
    const pRes = await fetch(`${baseUrl}/api/portfolios`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`
      },
      body: JSON.stringify({
        name: 'Portafoglio Alpha',
        currency: 'EUR',
        initialCash: 10000
      })
    });
    const pData = await pRes.json();
    assert.equal(pData.success, true);
    const pId = pData.portfolio.id;

    // Seed Equity asset (AAPL, 26% tax) and Bond asset (BTP_ITA, 12.5% tax)
    db.prepare(`
      INSERT OR REPLACE INTO assets (ticker, name, type, taxCategory, taxRate, currentPrice, currency)
      VALUES 
        ('AAPL', 'Apple Inc', 'EQUITY', 'EQUITY', 0.26, 200.0, 'EUR'),
        ('BTP_ITA', 'BTP Valore 2030', 'BOND', 'BOND', 0.125, 110.0, 'EUR')
    `).run();

    // Buy 10 AAPL @ 150 EUR (cost 1500, current 2000 => unrealized gain +500 EUR)
    await fetch(`${baseUrl}/api/transactions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`
      },
      body: JSON.stringify({
        portfolioId: pId,
        type: 'BUY',
        assetTicker: 'AAPL',
        date: '2026-01-10',
        quantity: 10,
        price: 150.0,
        commission: 0,
        tax: 0,
        exchangeRate: 1
      })
    });

    // Buy 20 BTP_ITA @ 100 EUR (cost 2000, current 2200 => unrealized gain +200 EUR)
    await fetch(`${baseUrl}/api/transactions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`
      },
      body: JSON.stringify({
        portfolioId: pId,
        type: 'BUY',
        assetTicker: 'BTP_ITA',
        date: '2026-01-11',
        quantity: 20,
        price: 100.0,
        commission: 0,
        tax: 0,
        exchangeRate: 1
      })
    });

    // Add minusvalenze to Portafoglio Alpha:
    // 100 EUR minusvalenza on EQUITY (leaving 500 - 100 = 400 EUR taxable @ 26% = 104 EUR)
    // 50 EUR minusvalenza on BOND (leaving 200 - 50 = 150 EUR taxable @ 12.5% = 18.75 EUR)
    // Total estimated tax = 104 + 18.75 = 122.75 EUR
    db.prepare(`
      INSERT INTO portfolio_losses (portfolioId, year, amount, residualAmount, expiryDate, assetType, taxRate)
      VALUES 
        (?, 2025, 100.0, 100.0, '2029-12-31', 'EQUITY', 0.26),
        (?, 2025, 50.0, 50.0, '2029-12-31', 'BOND', 0.125)
    `).run(pId, pId);

    // Fetch single portfolio
    const getRes = await fetch(`${baseUrl}/api/portfolios/${pId}`, {
      headers: { Authorization: `Bearer ${authToken}` }
    });
    const getData = await getRes.json();
    assert.equal(getData.success, true);

    const port = getData.portfolio;
    // Cash: 10000 - 1500 (AAPL) - 2000 (BTP) = 6500 EUR
    // Asset value: 10 * 200 (AAPL: 2000) + 20 * 110 (BTP: 2200) = 4200 EUR
    // Total gross value: 6500 + 4200 = 10700 EUR
    assert.equal(port.totalValue, 10700);

    // Expected estimated tax: 104 + 18.75 = 122.75 EUR
    assert.equal(Math.round(port.estimatedTax * 100) / 100, 122.75);

    // Expected netValue: 10700 - 122.75 = 10577.25 EUR
    assert.equal(Math.round(port.netValue * 100) / 100, 10577.25);
  });

  test('2. Consolidated GET /api/portfolios aggregates totalValue, netValue and estimatedTax across portfolios', async () => {
    // Create Portfolio 2 (Portafoglio Beta)
    const pRes = await fetch(`${baseUrl}/api/portfolios`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`
      },
      body: JSON.stringify({
        name: 'Portafoglio Beta',
        currency: 'EUR',
        initialCash: 5000
      })
    });
    const pData = await pRes.json();
    const pId2 = pData.portfolio.id;

    // Buy 10 AAPL @ 180 EUR (cost 1800, current 2000 => unrealized gain +200 EUR on EQUITY)
    await fetch(`${baseUrl}/api/transactions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`
      },
      body: JSON.stringify({
        portfolioId: pId2,
        type: 'BUY',
        assetTicker: 'AAPL',
        date: '2026-02-01',
        quantity: 10,
        price: 180.0,
        commission: 0,
        tax: 0,
        exchangeRate: 1
      })
    });

    // In Portafoglio Beta: No minusvalenze.
    // Gain: 200 EUR on EQUITY @ 26% = 52 EUR estimated tax.
    // Cash: 5000 - 1800 = 3200 EUR. Asset: 2000 EUR. TotalValue = 5200 EUR.
    // NetValue = 5200 - 52 = 5148 EUR.

    const allRes = await fetch(`${baseUrl}/api/portfolios`, {
      headers: { Authorization: `Bearer ${authToken}` }
    });
    const allData = await allRes.json();
    assert.equal(allData.success, true);

    const totals = allData.totals;
    // Alpha totalValue: 10700, Beta totalValue: 5200 => GrandTotalValue = 15900 EUR
    assert.equal(totals.totalValue, 15900);

    // Alpha estimatedTax: 122.75, Beta estimatedTax: 52 => GrandTotalEstimatedTax = 174.75 EUR
    assert.equal(Math.round(totals.totalEstimatedTax * 100) / 100, 174.75);

    // GrandNetValue = Alpha netValue (10577.25) + Beta netValue (5148) = 15725.25 EUR
    assert.equal(Math.round(totals.netValue * 100) / 100, 15725.25);
  });

  test('3. WIDGET_RENDERERS.value renders both P.Lordo and P.Netto in dashboard widget', () => {
    const code = fs.readFileSync(path.join(__dirname, '../public/dashboard.js'), 'utf8');

    const renderersMatch = code.match(/const WIDGET_RENDERERS = \{([\s\S]*?)\n  \};/);
    assert.ok(renderersMatch, 'Must find WIDGET_RENDERERS in dashboard.js');

    const evalEnv = vm.createContext({
      localStorage: { getItem: () => null, setItem: () => {} },
      document: { getElementById: () => null, querySelector: () => ({}) }
    });

    vm.runInContext(`
      ${code.substring(code.indexOf('function formatEur'), code.indexOf('const WIDGET_RENDERERS'))}
      const WIDGET_RENDERERS = {
        ${renderersMatch[1]}
      };
      this.renderValue = WIDGET_RENDERERS.value;
    `, evalEnv);

    // Test with mock data containing both totalValue and netValue
    const mockData = {
      totals: {
        totalValue: 150000,
        netValue: 147500,
        totalEstimatedTax: 2500,
        estimatedTax: 2500,
        unrealizedPnlPercent: 8.5,
        unrealizedPnl: 12500
      },
      isAggregate: true
    };

    const html = evalEnv.renderValue(mockData);

    // Check P.Lordo label and formatted amount
    assert.ok(html.includes('P.Lordo'), 'Must contain P.Lordo');
    assert.ok(html.includes('150,0k'), 'Must contain formatted gross value 150,0k');

    // Check P.Netto label and formatted amount
    assert.ok(html.includes('P.Netto'), 'Must contain P.Netto');
    assert.ok(html.includes('147,5k'), 'Must contain formatted net value 147,5k');

    // Check tax indicator badge or footer
    assert.ok(html.includes('2,5k'), 'Must display estimated tax 2,5k');

    // Test with daily variation data (Var. Oggi)
    const mockWithDay = {
      totals: {
        totalValue: 150000,
        netValue: 147500,
        totalEstimatedTax: 2500,
        estimatedTax: 2500,
        dayPnl: 1250,
        dayPnlPercent: 0.84,
        unrealizedPnlPercent: 8.5,
        unrealizedPnl: 12500
      },
      isAggregate: true
    };
    const htmlWithDay = evalEnv.renderValue(mockWithDay);
    assert.ok(htmlWithDay.includes('Var. Oggi'), 'Must contain Var. Oggi in 3-column layout');
    assert.ok(htmlWithDay.includes('+1,3k'), 'Must contain formatted daily variation value');
    assert.ok(htmlWithDay.includes('+0,84% 1D'), 'Must contain formatted daily variation percentage badge');
  });
});
