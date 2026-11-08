const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');

const TEST_DB = path.join(__dirname, 'test_reports_pdf.db');
process.env.DB_PATH = TEST_DB;
process.env.JWT_SECRET = 'test-jwt-secret-reports-pdf-section-2026';
process.env.ADMIN_PASSWORD = 'adminPdfReportPassword123!';
process.env.NODE_ENV = 'test';

const { initDb, closeDb, db } = require('../src/db');
const app = require('../src/app');

let server;
let baseUrl;
let authToken;
let portfolio1Id;
let portfolio2Id;

describe('Reports & PDF Section under Strumenti (/reports & /api/reports)', () => {
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
      body: JSON.stringify({ username: 'admin', password: 'adminPdfReportPassword123!' })
    });
    const loginData = await loginRes.json();
    authToken = loginData.token;

    // Create Portfolio 1: Core Investment
    const p1Res = await fetch(`${baseUrl}/api/portfolios`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`
      },
      body: JSON.stringify({
        name: 'Portafoglio Core PAC',
        type: 'Investimento',
        currency: 'EUR',
        initialCash: 10000
      })
    });
    const p1Data = await p1Res.json();
    portfolio1Id = p1Data.portfolio.id;

    // Create Portfolio 2: Trading
    const p2Res = await fetch(`${baseUrl}/api/portfolios`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`
      },
      body: JSON.stringify({
        name: 'Portafoglio Trading Azioni',
        type: 'Trading',
        currency: 'EUR',
        initialCash: 5000
      })
    });
    const p2Data = await p2Res.json();
    portfolio2Id = p2Data.portfolio.id;

    // Add Assets
    await fetch(`${baseUrl}/api/assets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
      body: JSON.stringify({
        ticker: 'SWDA.MI',
        name: 'iShares Core MSCI World UCITS ETF',
        type: 'ETF',
        currency: 'EUR',
        currentPrice: 95.50
      })
    });

    await fetch(`${baseUrl}/api/assets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
      body: JSON.stringify({
        ticker: 'AAPL',
        name: 'Apple Inc.',
        type: 'EQUITY',
        currency: 'EUR',
        currentPrice: 210.00
      })
    });

    // Transactions for Portfolio 1: Buy SWDA
    await fetch(`${baseUrl}/api/transactions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
      body: JSON.stringify({
        portfolioId: portfolio1Id,
        type: 'BUY',
        assetTicker: 'SWDA.MI',
        date: '2024-03-01',
        quantity: 50,
        price: 90.00,
        commission: 2.50
      })
    });

    // Transactions for Portfolio 2: Buy AAPL
    await fetch(`${baseUrl}/api/transactions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
      body: JSON.stringify({
        portfolioId: portfolio2Id,
        type: 'BUY',
        assetTicker: 'AAPL',
        date: '2024-05-15',
        quantity: 15,
        price: 180.00,
        commission: 3.00
      })
    });

    // Record a tax loss (minusvalenza) for Portfolio 2
    await fetch(`${baseUrl}/api/taxes/losses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
      body: JSON.stringify({
        portfolioId: portfolio2Id,
        year: 2024,
        amount: 850.00,
        notes: 'Realizzo vendita stop loss obbligazioni 2024'
      })
    });
  });

  after(async () => {
    if (server) {
      await new Promise(r => server.close(r));
    }
    closeDb();
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  });

  test('1. GET /reports serves desktop HTML view with Report PDF sidebar item and print layout', async () => {
    const res = await fetch(`${baseUrl}/reports`, {
      headers: { Cookie: `foliotrack_token=${authToken}` }
    });
    assert.strictEqual(res.status, 200);
    const html = await res.text();
    assert.ok(html.includes('Report Portafogli & PDF'), 'Title should be present');
    assert.ok(html.includes('Scarica Report PDF'), 'Download/Print PDF button should be present');
    assert.ok(html.includes('data-subpage="reports"'), 'Sidebar subpage link should be present');
    assert.ok(html.includes('Zainetto Fiscale & Minusvalenze'), 'Zainetto Fiscale section should be in page');
    assert.ok(html.includes('/pdf_report.js'), 'pdf_report script included');
    // Verify 2-line compacted column headers
    assert.ok(html.includes('Asset / Strumento'), 'Compact col 1 header');
    assert.ok(html.includes('Q.tà / PMC'), 'Compact col 2 header');
    assert.ok(html.includes('Quotaz. / Costo'), 'Compact col 3 header');
    assert.ok(html.includes('Valore Att. / Peso'), 'Compact col 4 header');
    assert.ok(html.includes('Gain / Rend.'), 'Compact col 5 header');
  });

  test('2. GET /reports?view=mobile serves mobile layout', async () => {
    const res = await fetch(`${baseUrl}/reports?view=mobile`, {
      headers: { Cookie: `foliotrack_token=${authToken}` }
    });
    assert.strictEqual(res.status, 200);
    const html = await res.text();
    assert.ok(html.includes('Report PDF'), 'Mobile title should be present');
    assert.ok(html.includes('mobilePrintPdfBtn'), 'Mobile PDF button should be present');
    assert.ok(html.includes('mobilePortfolioSelect'), 'Mobile portfolio selector should be present');
    assert.ok(html.includes('Minusvalenze Totali'), 'Mobile KPI for minusvalenze should be present');
  });

  test('3. GET /tools contains tool card linking to /reports', async () => {
    const res = await fetch(`${baseUrl}/tools`, {
      headers: { Cookie: `foliotrack_token=${authToken}` }
    });
    assert.strictEqual(res.status, 200);
    const html = await res.text();
    assert.ok(html.includes('href="/reports"'), 'Tools page must have link to /reports');
    assert.ok(html.includes('Report Portafogli & PDF'), 'Tools page must have card title');
  });

  test('4. GET /api/reports/portfolio-data returns portfolios with holdings, values, gains, and minusvalenze', async () => {
    const res = await fetch(`${baseUrl}/api/reports/portfolio-data`, {
      headers: { Authorization: `Bearer ${authToken}` }
    });
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.success, true);
    assert.ok(data.totals);
    assert.ok(data.totals.totalValue > 0);
    assert.ok(data.totals.investedCapital > 0);
    assert.ok(data.totals.totalGain > 0);
    assert.strictEqual(data.totals.totalMinusvalenze, 850.00);
    assert.strictEqual(data.totals.potentialTaxSaving, 850.00 * 0.26);

    assert.ok(Array.isArray(data.portfolios));
    assert.strictEqual(data.portfolios.length, 2);

    // Verify Portfolio 1
    const p1 = data.portfolios.find(p => p.id === portfolio1Id);
    assert.ok(p1);
    assert.strictEqual(p1.name, 'Portafoglio Core PAC');
    assert.strictEqual(p1.holdings.length, 1);
    const h1 = p1.holdings[0];
    assert.strictEqual(h1.ticker, 'SWDA.MI');
    assert.strictEqual(h1.quantity, 50);
    assert.ok(h1.pmc > 0);
    assert.strictEqual(h1.currentPrice, 95.50);
    assert.strictEqual(h1.currentValue, 50 * 95.50);
    assert.ok(h1.gain > 0);
    assert.strictEqual(p1.minusvalenze.totalResidual, 0);

    // Verify Portfolio 2 (has minusvalenza)
    const p2 = data.portfolios.find(p => p.id === portfolio2Id);
    assert.ok(p2);
    assert.strictEqual(p2.name, 'Portafoglio Trading Azioni');
    assert.strictEqual(p2.holdings.length, 1);
    const h2 = p2.holdings[0];
    assert.strictEqual(h2.ticker, 'AAPL');
    assert.strictEqual(h2.quantity, 15);
    assert.strictEqual(h2.currentPrice, 210.00);
    assert.strictEqual(h2.currentValue, 15 * 210.00);
    assert.ok(h2.gain > 0);
    assert.strictEqual(p2.minusvalenze.totalResidual, 850.00);
    assert.strictEqual(p2.minusvalenze.potentialTaxSaving, 850.00 * 0.26);
    assert.strictEqual(p2.minusvalenze.items.length, 1);
    assert.strictEqual(p2.minusvalenze.items[0].year, 2024);
  });

  test('5. GET /api/reports/portfolio-data?portfolioId=:id returns single filtered portfolio', async () => {
    const res = await fetch(`${baseUrl}/api/reports/portfolio-data?portfolioId=${portfolio2Id}`, {
      headers: { Authorization: `Bearer ${authToken}` }
    });
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.success, true);
    assert.strictEqual(data.portfolios.length, 1);
    assert.strictEqual(data.portfolios[0].id, portfolio2Id);
    assert.strictEqual(data.totals.totalMinusvalenze, 850.00);
  });

  test('6. GET /ai-advisor continues to serve AI Portfolio Advisor view', async () => {
    const res = await fetch(`${baseUrl}/ai-advisor`, {
      headers: { Cookie: `foliotrack_token=${authToken}` }
    });
    assert.strictEqual(res.status, 200);
    const html = await res.text();
    assert.ok(html.includes('AI Portfolio Advisor'));
    assert.ok(html.includes('aiRiskScore'));
    assert.ok(html.includes('aiDiversificationScore'));
  });
});

