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

  test('7. POST /api/transactions records SELL to generate closed positions', async () => {
    const res = await fetch(`${baseUrl}/api/transactions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
      body: JSON.stringify({
        portfolioId: portfolio2Id,
        type: 'SELL',
        assetTicker: 'AAPL',
        date: '2024-08-20',
        quantity: 5,
        price: 220.00,
        commission: 2.00
      })
    });
    assert.strictEqual(res.status, 201);
  });

  test('8. GET /api/reports/closed-positions returns closed positions grouped by year with gains', async () => {
    const res = await fetch(`${baseUrl}/api/reports/closed-positions`, {
      headers: { Authorization: `Bearer ${authToken}` }
    });
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.success, true);
    assert.ok(data.totals);
    assert.strictEqual(data.totals.operationCount, 1);
    assert.strictEqual(data.totals.winCount, 1);
    assert.ok(data.totals.totalRealizedGain > 0);
    assert.strictEqual(data.totals.winRate, 100);

    assert.ok(Array.isArray(data.years));
    assert.ok(data.years.includes(2024));

    assert.ok(Array.isArray(data.byYear));
    const y2024 = data.byYear.find(y => y.year === 2024);
    assert.ok(y2024);
    assert.strictEqual(y2024.tradeCount, 1);
    assert.ok(y2024.totalRealizedGain > 0);
    assert.strictEqual(y2024.operations.length, 1);

    const op = y2024.operations[0];
    assert.strictEqual(op.ticker, 'AAPL');
    assert.strictEqual(op.quantity, 5);
    assert.strictEqual(op.sellPrice, 220.00);
    assert.strictEqual(op.closeType, 'PARZIALE');
    assert.ok(op.realizedPnl > 0);
    assert.ok(op.proceeds > 0);
  });

  test('9. GET /api/reports/closed-positions supports year and portfolio filtering', async () => {
    // Filter year 2024 -> returns 1 operation
    const res2024 = await fetch(`${baseUrl}/api/reports/closed-positions?year=2024`, {
      headers: { Authorization: `Bearer ${authToken}` }
    });
    const d2024 = await res2024.json();
    assert.strictEqual(d2024.operations.length, 1);

    // Filter year 2020 -> returns 0 operations
    const res2020 = await fetch(`${baseUrl}/api/reports/closed-positions?year=2020`, {
      headers: { Authorization: `Bearer ${authToken}` }
    });
    const d2020 = await res2020.json();
    assert.strictEqual(d2020.operations.length, 0);

    // Filter by portfolio 1 (no sells) -> returns 0 operations
    const resP1 = await fetch(`${baseUrl}/api/reports/closed-positions?portfolioId=${portfolio1Id}`, {
      headers: { Authorization: `Bearer ${authToken}` }
    });
    const dP1 = await resP1.json();
    assert.strictEqual(dP1.operations.length, 0);

    // Filter by portfolio 2 (has sell) -> returns 1 operation
    const resP2 = await fetch(`${baseUrl}/api/reports/closed-positions?portfolioId=${portfolio2Id}`, {
      headers: { Authorization: `Bearer ${authToken}` }
    });
    const dP2 = await resP2.json();
    assert.strictEqual(dP2.operations.length, 1);
  });

  test('10. Desktop and Mobile views render Closed Positions report tab & switcher', async () => {
    // Desktop
    const resDesk = await fetch(`${baseUrl}/reports`, {
      headers: { Cookie: `foliotrack_token=${authToken}` }
    });
    const htmlDesk = await resDesk.text();
    assert.ok(htmlDesk.includes('tabBtnClosed'), 'Desktop has tabBtnClosed');
    assert.ok(htmlDesk.includes('Operazioni Chiuse & Storico Gain'), 'Desktop has closed tab label');
    assert.ok(htmlDesk.includes('sectionClosedReport'), 'Desktop has closed report section');

    // Mobile
    const resMob = await fetch(`${baseUrl}/reports?view=mobile`, {
      headers: { Cookie: `foliotrack_token=${authToken}` }
    });
    const htmlMob = await resMob.text();
    assert.ok(htmlMob.includes('mTabBtnClosed'), 'Mobile has mTabBtnClosed');
    assert.ok(htmlMob.includes('Op. Chiuse'), 'Mobile has closed tab button');
    assert.ok(htmlMob.includes('mSectionClosed'), 'Mobile has closed section');
  });

  test('11. Capital gain taxation on Azioni & ETF Azionari (26%) vs BOND & ETF Monetari (12.5%)', async () => {
    // Register a BOND asset
    await fetch(`${baseUrl}/api/assets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
      body: JSON.stringify({
        ticker: 'BTP-ITALIA-2030',
        name: 'BTP Italia Indicizzato 2030',
        type: 'BOND',
        sector: 'Government',
        currency: 'EUR',
        currentPrice: 102.00
      })
    });

    // Register a Monetary ETF asset
    await fetch(`${baseUrl}/api/assets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
      body: JSON.stringify({
        ticker: 'XEON.MI',
        name: 'Xtrackers II EUR Overnight Rate Swap UCITS ETF',
        type: 'ETF',
        sector: 'Money Market',
        currency: 'EUR',
        currentPrice: 142.50
      })
    });

    // Buy BTP in Portfolio 1
    await fetch(`${baseUrl}/api/transactions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
      body: JSON.stringify({
        portfolioId: portfolio1Id,
        type: 'BUY',
        assetTicker: 'BTP-ITALIA-2030',
        date: '2025-01-15',
        quantity: 10,
        price: 95.00,
        commission: 0.00
      })
    });

    // Check portfolio data has differentiated tax rates: SWDA.MI is 26%, BTP is 12.5%
    const pDataRes = await fetch(`${baseUrl}/api/reports/portfolio-data?portfolioId=${portfolio1Id}`, {
      headers: { Authorization: `Bearer ${authToken}` }
    });
    const pData = await pDataRes.json();
    assert.strictEqual(pData.success, true);
    const p1 = pData.portfolios[0];

    const swdaHolding = p1.holdings.find(h => h.ticker === 'SWDA.MI');
    assert.ok(swdaHolding);
    assert.strictEqual(swdaHolding.taxRate, 0.26);
    assert.strictEqual(swdaHolding.taxCategory, 'EQUITY');

    const bftHolding = p1.holdings.find(h => h.ticker === 'BTP-ITALIA-2030');
    assert.ok(bftHolding);
    assert.strictEqual(bftHolding.taxRate, 0.125);
    assert.strictEqual(bftHolding.taxCategory, 'BOND');

    // Sell BTP at a gain in Portfolio 1 (no losses in Portfolio 1)
    await fetch(`${baseUrl}/api/transactions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
      body: JSON.stringify({
        portfolioId: portfolio1Id,
        type: 'SELL',
        assetTicker: 'BTP-ITALIA-2030',
        date: '2025-06-10',
        quantity: 5,
        price: 105.00, // bought at 95 -> 10 EUR gain/share * 5 = 50 EUR gain
        commission: 0.00
      })
    });

    // Verify closed positions for Portfolio 1: BTP has 12.5% tax rate and calculates 12.5% tax due
    const closedRes = await fetch(`${baseUrl}/api/reports/closed-positions?portfolioId=${portfolio1Id}`, {
      headers: { Authorization: `Bearer ${authToken}` }
    });
    const closedData = await closedRes.json();
    assert.strictEqual(closedData.success, true);
    assert.strictEqual(closedData.operations.length, 1);

    const btpOp = closedData.operations[0];
    assert.strictEqual(btpOp.ticker, 'BTP-ITALIA-2030');
    assert.strictEqual(btpOp.taxCategory, 'BOND');
    assert.strictEqual(btpOp.taxRate, 0.125);
    assert.strictEqual(btpOp.realizedPnl, 50.00);
    assert.strictEqual(btpOp.taxableGain, 50.00);
    assert.strictEqual(btpOp.taxDue, 50.00 * 0.125); // 6.25 EUR
    assert.strictEqual(btpOp.netRealizedGain, 50.00 - (50.00 * 0.125)); // 43.75 EUR
  });

  test('12. Minusvalenze compensation rule: strictly within same portfolio and same asset category', async () => {
    // In Portfolio 2, there is an EQUITY loss (850 EUR from setup).
    // Now sell a BOND in Portfolio 2 at a gain of 100 EUR.
    // The EQUITY loss in Portfolio 2 must NOT compensate the BOND gain!
    await fetch(`${baseUrl}/api/transactions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
      body: JSON.stringify({
        portfolioId: portfolio2Id,
        type: 'BUY',
        assetTicker: 'BTP-ITALIA-2030',
        date: '2025-01-10',
        quantity: 10,
        price: 90.00,
        commission: 0.00
      })
    });

    await fetch(`${baseUrl}/api/transactions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
      body: JSON.stringify({
        portfolioId: portfolio2Id,
        type: 'SELL',
        assetTicker: 'BTP-ITALIA-2030',
        date: '2025-03-10',
        quantity: 5,
        price: 110.00, // bought at 90 -> 20 EUR gain/share * 5 = 100 EUR gain
        commission: 0.00
      })
    });

    const resP2 = await fetch(`${baseUrl}/api/reports/closed-positions?portfolioId=${portfolio2Id}`, {
      headers: { Authorization: `Bearer ${authToken}` }
    });
    const dataP2 = await resP2.json();
    assert.strictEqual(dataP2.success, true);

    const bondSale = dataP2.operations.find(o => o.ticker === 'BTP-ITALIA-2030');
    assert.ok(bondSale);
    assert.strictEqual(bondSale.taxCategory, 'BOND');
    assert.strictEqual(bondSale.taxRate, 0.125);
    assert.strictEqual(bondSale.realizedPnl, 100.00);
    // Because the 850 EUR minusvalenza in Portfolio 2 is EQUITY, it does NOT offset the BOND gain!
    assert.strictEqual(bondSale.compensatedLoss, 0.00);
    assert.strictEqual(bondSale.taxDue, 100.00 * 0.125); // 12.50 EUR
    assert.strictEqual(bondSale.netRealizedGain, 100.00 - 12.50); // 87.50 EUR

    // Now record a BOND loss in Portfolio 2
    const lossRes = await fetch(`${baseUrl}/api/taxes/losses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
      body: JSON.stringify({
        portfolioId: portfolio2Id,
        year: 2024,
        amount: 50.00,
        assetType: 'BOND',
        notes: 'Minusvalenza certificata Bond 2024'
      })
    });
    assert.strictEqual(lossRes.status, 201);

    // Verify GET /api/taxes/zainetto returns differentiated tax savings:
    const zainettoRes = await fetch(`${baseUrl}/api/taxes/zainetto?portfolioId=${portfolio2Id}`, {
      headers: { Authorization: `Bearer ${authToken}` }
    });
    const zData = await zainettoRes.json();
    assert.strictEqual(zData.success, true);
    assert.ok(zData.summary.byCategory);
    assert.strictEqual(zData.summary.byCategory.equity.taxRate, 0.26);
    assert.strictEqual(zData.summary.byCategory.bond.taxRate, 0.125);
    assert.strictEqual(zData.summary.byCategory.bond.residualAmount, 50.00);
    assert.strictEqual(zData.summary.byCategory.bond.taxSavingsPotential, 50.00 * 0.125);
  });
});

