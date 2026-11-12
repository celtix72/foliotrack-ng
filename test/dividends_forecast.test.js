const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');

const TEST_DB = path.join(__dirname, 'test_dividends_forecast.db');
process.env.DB_PATH = TEST_DB;
process.env.JWT_SECRET = 'test-jwt-secret-dividends-forecast';
process.env.ADMIN_PASSWORD = 'adminForecastPassword123!';
process.env.NODE_ENV = 'test';

const { initDb, closeDb, db } = require('../src/db');
const app = require('../src/app');
const { calculateAnnualDividendsHistory, calculateDividendForecast } = require('../src/utils/dividendForecast');
const { recalculateDividendProjections } = require('../src/routes/dividends');
const { calculateSanitizedDividendYield } = require('../src/services/yahooFinance');

let server;
let baseUrl;
let authToken;
let portfolioId;

describe('Dividend Annual History & Dynamic Projections Engine', () => {
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
      body: JSON.stringify({ username: 'admin', password: 'adminForecastPassword123!' })
    });
    const loginData = await loginRes.json();
    authToken = loginData.token;

    // Create a portfolio
    const portRes = await fetch(`${baseUrl}/api/portfolios`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`
      },
      body: JSON.stringify({
        name: 'Dividendi & Cash Flow Test',
        type: 'Investimento',
        currency: 'EUR',
        initialCash: 100000
      })
    });
    const portData = await portRes.json();
    portfolioId = portData.portfolio.id;
  });

  after(async () => {
    if (server) await new Promise((r) => server.close(r));
    closeDb();
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  });

  describe('1. Unit Tests: Forecast Engine Functions (src/utils/dividendForecast.js)', () => {
    test('calculateAnnualDividendsHistory aggregates by year, calculates YoY, and splits dividends vs interest', () => {
      const mockTx = [
        { type: 'DIVIDEND', date: '2024-05-15', amount: 500, assetTicker: 'AAPL' },
        { type: 'INTEREST', date: '2024-11-01', amount: 300, assetTicker: 'BTP1' },
        { type: 'DIVIDEND', date: '2025-05-15', amount: 600, assetTicker: 'AAPL' },
        { type: 'INTEREST', date: '2025-11-01', amount: 400, assetTicker: 'BTP1' },
        { type: 'DIVIDEND', date: '2026-03-10', amount: 700, assetTicker: 'AAPL' },
        { type: 'INTEREST', date: '2026-06-01', amount: 500, assetTicker: 'BTP1' }
      ];

      const assetsMap = {
        AAPL: { name: 'Apple Inc.', type: 'EQUITY' },
        BTP1: { name: 'BTP Italia', type: 'BOND' }
      };

      const history = calculateAnnualDividendsHistory(mockTx, assetsMap);

      assert.strictEqual(history.length, 3);
      assert.strictEqual(history[0].year, 2026);
      assert.strictEqual(history[0].total, 1200);
      assert.strictEqual(history[0].dividends, 700);
      assert.strictEqual(history[0].interest, 500);
      assert.strictEqual(history[0].count, 2);
      // 2026 vs 2025: (1200 - 1000) / 1000 = +20%
      assert.strictEqual(history[0].yoyGrowthRate, 20);

      assert.strictEqual(history[1].year, 2025);
      assert.strictEqual(history[1].total, 1000);
      // 2025 vs 2024: (1000 - 800) / 800 = +25%
      assert.strictEqual(history[1].yoyGrowthRate, 25);

      assert.strictEqual(history[2].year, 2024);
      assert.strictEqual(history[2].total, 800);
      assert.strictEqual(history[2].yoyGrowthRate, null);
    });

    test('calculateSanitizedDividendYield correctly sanitizes outliers and erroneous data (MU, PYPL, NEXI, NOV.DE)', () => {
      // Micron: Yahoo returns raw quote dividendYield = 0.07 (meaning 0.07%).
      // Previously < 0.2 was multiplied by 100 yielding 7.00%. Now sanitized.
      const muRawQuote = { dividendYield: 0.07, dividendRate: 0.46 };
      const muYield = calculateSanitizedDividendYield(muRawQuote, 550.0, 'MU');
      assert.strictEqual(muYield, 0.08); // (0.46 / 550) * 100 = 0.0836 -> 0.08%

      // PYPL: Stale trailing rate in Yahoo, strict buyback policy
      const pyplRawQuote = { dividendYield: 0.94, dividendRate: 0.56 };
      const pyplYield = calculateSanitizedDividendYield(pyplRawQuote, 60.0, 'PYPL');
      assert.strictEqual(pyplYield, 0.0);

      // NEXI.MI: One-off distribution in 2024, no recurring dividend
      const nexiRawQuote = { dividendYield: 6.63, dividendRate: 0.35 };
      const nexiYield = calculateSanitizedDividendYield(nexiRawQuote, 4.5, 'NEXI.MI');
      assert.strictEqual(nexiYield, 0.0);

      // NOV.DE: Cross-listing DKK/EUR mismatch
      const novRawQuote = { dividendYield: 4.32, dividendRate: 3.5 };
      const novYield = calculateSanitizedDividendYield(novRawQuote, 80.0, 'NOV.DE');
      assert.strictEqual(novYield, 1.25);

      // Normal stock: e.g. Intesa Sanpaolo (price 6.30, divRate 0.434 -> ~6.89%)
      const ispRawQuote = { dividendRate: 0.434 };
      const ispYield = calculateSanitizedDividendYield(ispRawQuote, 6.30, 'ISP.MI');
      assert.strictEqual(ispYield, 6.89);
    });

    test('calculateDividendForecast accurately forecasts remaining current year months and projects next year', () => {
      // Set current date to 2026-10-15 (October 2026, so Nov and Dec remain)
      const options = { currentDate: new Date('2026-10-15T12:00:00Z') };

      const activeHoldings = [
        {
          ticker: 'AAPL',
          name: 'Apple Inc.',
          type: 'EQUITY',
          quantity: 100,
          currentPrice: 200,
          dividendYield: 2.0 // Annual income = 100 * 200 * 0.02 = 400
        },
        {
          ticker: 'BTP1',
          name: 'BTP Italia',
          type: 'BOND',
          quantity: 1000,
          currentPrice: 100,
          dividendYield: 0 // Yield 0, deduced from history
        }
      ];

      const transactions = [
        // AAPL historical: paid in Mar, Jun, Sep, Dec
        { type: 'DIVIDEND', date: '2025-03-15', amount: 100, assetTicker: 'AAPL' },
        { type: 'DIVIDEND', date: '2025-06-15', amount: 100, assetTicker: 'AAPL' },
        { type: 'DIVIDEND', date: '2025-09-15', amount: 100, assetTicker: 'AAPL' },
        { type: 'DIVIDEND', date: '2025-12-15', amount: 100, assetTicker: 'AAPL' },
        { type: 'DIVIDEND', date: '2026-03-15', amount: 100, assetTicker: 'AAPL' },
        { type: 'DIVIDEND', date: '2026-06-15', amount: 100, assetTicker: 'AAPL' },
        { type: 'DIVIDEND', date: '2026-09-15', amount: 100, assetTicker: 'AAPL' },
        // BTP1 paid in May and Nov: 300 each (annual 600)
        { type: 'INTEREST', date: '2025-05-01', amount: 300, assetTicker: 'BTP1' },
        { type: 'INTEREST', date: '2025-11-01', amount: 300, assetTicker: 'BTP1' },
        { type: 'INTEREST', date: '2026-05-01', amount: 300, assetTicker: 'BTP1' }
      ];

      const result = calculateDividendForecast(activeHoldings, transactions, {}, options);

      // Current Year checks (collected so far in 2026: AAPL 100*3 + BTP1 300 = 600)
      assert.strictEqual(result.currentYearForecast.collectedSoFar, 600);
      assert.strictEqual(result.currentYearForecast.currentYear, 2026);
      assert.strictEqual(result.currentYearForecast.remainingMonthsCount, 3); // Oct, Nov, Dec

      // Remaining expected:
      // AAPL pays in Dec: 400 / 4 = 100
      // BTP1 pays in Nov: 600 / 2 = 300
      // Total remaining expected = 100 + 300 = 400
      assert.strictEqual(result.currentYearForecast.remainingExpected, 400);
      assert.strictEqual(result.currentYearForecast.projectedYearEndTotal, 1000); // 600 + 400

      // Next Year checks (2027)
      // AAPL full year: 400
      // BTP1 full year: 600
      // Total projected = 1000
      assert.strictEqual(result.nextYearForecast.nextYear, 2027);
      assert.strictEqual(result.nextYearForecast.totalProjected, 1000);
      assert.strictEqual(result.nextYearForecast.monthlyAverage, Number((1000 / 12).toFixed(2)));
      assert.strictEqual(result.nextYearForecast.holdingProjections.length, 2);
    });

    test('calculateDividendForecast respects verified calendar (BTP Mg30 Nov, BTP Mz30 Dic, ISP Nov, excludes RWAY/NEXI)', () => {
      // In November 2026:
      const options = { currentDate: new Date('2026-11-10T10:00:00Z') };

      const activeHoldings = [
        { ticker: 'IT0005594483', name: 'BTP Valore Mg30', type: 'BOND', quantity: 300, currentPrice: 100, dividendYield: 0 },
        { ticker: 'IT0005583486', name: 'BTP Valore Mz30', type: 'BOND', quantity: 300, currentPrice: 100, dividendYield: 0 },
        { ticker: 'ISP.MI', name: 'Intesa Sanpaolo', type: 'EQUITY', quantity: 2000, currentPrice: 6.30, dividendYield: 6.88 },
        { ticker: 'RWAY.MI', name: 'Rai Way', type: 'EQUITY', quantity: 2350, currentPrice: 4.10, dividendYield: 7.91 },
        { ticker: 'NEXI.MI', name: 'Nexi', type: 'EQUITY', quantity: 1200, currentPrice: 4.50, dividendYield: 6.63 },
        { ticker: 'PRX.AS', name: 'Prosus', type: 'EQUITY', quantity: 127, currentPrice: 37.0, dividendYield: 0.75 },
        { ticker: 'NOMD', name: 'Nomad Foods', type: 'EQUITY', quantity: 200, currentPrice: 15.0, dividendYield: 5.77 },
        { ticker: 'PYPL', name: 'PayPal', type: 'EQUITY', quantity: 70, currentPrice: 70.0, dividendYield: 0.95 }
      ];

      const result = calculateDividendForecast(activeHoldings, [], {}, options);
      const rem = result.currentYearForecast.expectedRemainingPayments;

      // 1. Check BTP Mg30 (IT0005594483) is scheduled for November (14 Nov)
      const btpMg = rem.find(p => p.ticker === 'IT0005594483');
      assert.ok(btpMg, 'BTP Mg30 must be in remaining payments');
      assert.strictEqual(btpMg.month, 11);
      assert.strictEqual(btpMg.dateLabel, '14 Nov');

      // 2. Check BTP Mz30 (IT0005583486) is scheduled for December (5 Dic)
      const btpMz = rem.find(p => p.ticker === 'IT0005583486');
      assert.ok(btpMz, 'BTP Mz30 must be in remaining payments');
      assert.strictEqual(btpMz.month, 12);
      assert.strictEqual(btpMz.dateLabel, '5 Dic');

      // 3. Check Intesa Sanpaolo (ISP.MI) is scheduled for November (25 Nov) with 0.17/share acconto
      const isp = rem.find(p => p.ticker === 'ISP.MI');
      assert.ok(isp, 'ISP.MI must be in remaining payments');
      assert.strictEqual(isp.month, 11);
      assert.strictEqual(isp.dateLabel, '25 Nov');
      assert.strictEqual(isp.expectedAmount, 340); // 2000 * 0.17

      // 4. Check RWAY.MI and NEXI.MI are EXCLUDED from current year remainder (only pay in May)
      const rway = rem.find(p => p.ticker === 'RWAY.MI');
      const nexi = rem.find(p => p.ticker === 'NEXI.MI');
      assert.strictEqual(rway, undefined, 'RWAY.MI must NOT appear in Nov/Dec remaining payments');
      assert.strictEqual(nexi, undefined, 'NEXI.MI must NOT appear in Nov/Dec remaining payments');

      // 5. Check PRX.AS is scheduled in December
      const prx = rem.find(p => p.ticker === 'PRX.AS');
      assert.ok(prx);
      assert.strictEqual(prx.month, 12);

      // 6. Check PYPL is recognized as non-dividend payer (share buyback policy, months: [])
      const pypl = rem.find(p => p.ticker === 'PYPL');
      assert.strictEqual(pypl, undefined, 'PYPL does not distribute dividends and must not be scheduled');

      // 7. Check that RWAY appears in next year forecast in May, while NEXI has no scheduled recurring payout months
      const nextRway = result.nextYearForecast.holdingProjections.find(h => h.ticker === 'RWAY.MI');
      assert.ok(nextRway);
      assert.deepStrictEqual(nextRway.payoutMonths, [5]);

      const nextNexi = result.nextYearForecast.holdingProjections.find(h => h.ticker === 'NEXI.MI');
      assert.strictEqual(nextNexi, undefined, 'NEXI has 0 recurring dividend and must not be in dividend projections');
    });
  });

  describe('2. Integration: Recalculation on Buy / Sell / Modify Operations', () => {
    test('Buying an income-generating asset creates dividend projections', async () => {
      // Insert asset metadata
      db.prepare(`
        INSERT OR REPLACE INTO assets (ticker, name, type, currentPrice, dividendYield)
        VALUES ('ENI.MI', 'Eni S.p.A.', 'EQUITY', 14.50, 6.20)
      `).run();

      // Execute a BUY transaction
      const buyRes = await fetch(`${baseUrl}/api/transactions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${authToken}`
        },
        body: JSON.stringify({
          portfolioId,
          type: 'BUY',
          date: '2026-01-10',
          assetTicker: 'ENI.MI',
          quantity: 1000,
          price: 14.50,
          amount: 14500,
          notes: 'Acquisto 1000 quote Eni'
        })
      });

      const buyData = await buyRes.json();
      assert.strictEqual(buyData.success, true);

      // Verify dividend_projections has been updated
      const proj = db.prepare('SELECT * FROM dividend_projections WHERE portfolioId = ? AND assetTicker = ?')
        .get(portfolioId, 'ENI.MI');
      assert.ok(proj);
      assert.strictEqual(proj.sharesHeld, 1000);
      // Expected annual income: 1000 * 14.50 * 0.062 = 899
      assert.strictEqual(Math.round(proj.projectedAnnualIncome), 899);

      // Verify GET /api/dividends/income-summary reflects the updated holdings projection
      const sumRes = await fetch(`${baseUrl}/api/dividends/income-summary?portfolioId=${portfolioId}`, {
        headers: { Authorization: `Bearer ${authToken}` }
      });
      const sumData = await sumRes.json();
      assert.strictEqual(sumData.success, true);
      assert.ok(sumData.summary.nextYearForecast);
      assert.ok(sumData.summary.nextYearForecast.totalProjected >= 899);
    });

    test('Selling part of the asset reduces the projected dividend income dynamically', async () => {
      // Execute a SELL transaction of 500 shares (leaving 500)
      const sellRes = await fetch(`${baseUrl}/api/transactions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${authToken}`
        },
        body: JSON.stringify({
          portfolioId,
          type: 'SELL',
          date: '2026-05-15',
          assetTicker: 'ENI.MI',
          quantity: 500,
          price: 15.00,
          amount: 7500,
          notes: 'Vendita parziale 500 quote Eni'
        })
      });

      const sellData = await sellRes.json();
      assert.strictEqual(sellData.success, true);

      // Verify dividend_projections updated to 500 shares
      const proj = db.prepare('SELECT * FROM dividend_projections WHERE portfolioId = ? AND assetTicker = ?')
        .get(portfolioId, 'ENI.MI');
      assert.ok(proj);
      assert.strictEqual(proj.sharesHeld, 500);
      // 500 * 14.50 * 0.062 = 449.5
      assert.strictEqual(Math.round(proj.projectedAnnualIncome), 450);

      // Verify income-summary nextYearForecast reflects the halving
      const sumRes = await fetch(`${baseUrl}/api/dividends/income-summary?portfolioId=${portfolioId}`, {
        headers: { Authorization: `Bearer ${authToken}` }
      });
      const sumData = await sumRes.json();
      assert.strictEqual(sumData.success, true);
      assert.strictEqual(Math.round(sumData.summary.nextYearForecast.totalProjected), 450);
    });

    test('Selling all remaining shares completely removes the ticker from projections', async () => {
      // Execute a SELL transaction of the remaining 500 shares
      const sellAllRes = await fetch(`${baseUrl}/api/transactions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${authToken}`
        },
        body: JSON.stringify({
          portfolioId,
          type: 'SELL',
          date: '2026-06-01',
          assetTicker: 'ENI.MI',
          quantity: 500,
          price: 15.20,
          amount: 7600,
          notes: 'Chiusura posizione Eni'
        })
      });

      const sellAllData = await sellAllRes.json();
      assert.strictEqual(sellAllData.success, true);

      // Verify projection row is deleted
      const proj = db.prepare('SELECT * FROM dividend_projections WHERE portfolioId = ? AND assetTicker = ?')
        .get(portfolioId, 'ENI.MI');
      assert.strictEqual(proj, undefined);

      // Verify income-summary nextYearForecast is now 0
      const sumRes = await fetch(`${baseUrl}/api/dividends/income-summary?portfolioId=${portfolioId}`, {
        headers: { Authorization: `Bearer ${authToken}` }
      });
      const sumData = await sumRes.json();
      assert.strictEqual(sumData.success, true);
      assert.strictEqual(sumData.summary.nextYearForecast.totalProjected, 0);
    });
  });

  describe('3. Frontend HTML Template Verification', () => {
    test('Desktop view history.html contains annual dividends table and forecast widgets', async () => {
      const res = await fetch(`${baseUrl}/history`, {
        headers: {
          Authorization: `Bearer ${authToken}`,
          Cookie: `foliotrack_token=${authToken}`
        }
      });
      assert.strictEqual(res.status, 200);
      const html = await res.text();

      // Verify elements for annual dividends
      assert.ok(html.includes('Dividendi e Cedole Staccati per Anno'));
      assert.ok(html.includes('annualDividendsTbody'));

      // Verify elements for current year forecast
      assert.ok(html.includes('forecastCurYearLabel'));
      assert.ok(html.includes('forecastRemainingBadge'));
      assert.ok(html.includes('forecastCollectedSoFar'));
      assert.ok(html.includes('forecastRemainingExpected'));
      assert.ok(html.includes('forecastProjectedYearEnd'));
      assert.ok(html.includes('remainingPaymentsList'));

      // Verify elements for next year forecast
      assert.ok(html.includes('forecastNextYearLabel'));
      assert.ok(html.includes('forecastYieldBadge'));
      assert.ok(html.includes('forecastNextYearTotal'));
      assert.ok(html.includes('forecastNextYearMonthly'));
      assert.ok(html.includes('nextYearHoldingsList'));

      // Verify elements for interactive dividend projections verification table
      assert.ok(html.includes('dividendProjectionsCard'));
      assert.ok(html.includes('projectionsTbody'));
      assert.ok(html.includes('editProjectionModal'));
      assert.ok(html.includes('recalculateAllProjectionsBtn'));
    });

    test('Mobile view history_mobile.html contains mobile forecast cards and annual list', async () => {
      const res = await fetch(`${baseUrl}/history?view=mobile`, {
        headers: {
          Authorization: `Bearer ${authToken}`,
          Cookie: `foliotrack_token=${authToken}`
        }
      });
      assert.strictEqual(res.status, 200);
      const html = await res.text();

      // Verify mobile elements
      assert.ok(html.includes('mForecastCurYear'));
      assert.ok(html.includes('mForecastRemainingExpected'));
      assert.ok(html.includes('mForecastProjectedYearEnd'));
      assert.ok(html.includes('mRemainingPaymentsList'));
      assert.ok(html.includes('mForecastNextYearTotal'));
      assert.ok(html.includes('mNextYearHoldingsList'));
      assert.ok(html.includes('mAnnualDividendsContainer'));

      // Verify mobile elements for dividend projections verification
      assert.ok(html.includes('mDividendProjectionsCard'));
      assert.ok(html.includes('mProjectionsList'));
      assert.ok(html.includes('mEditProjectionModal'));
      assert.ok(html.includes('mRecalculateProjectionsBtn'));
    });
  });

  describe('4. Multi-Source Dividend Projections Verification API', () => {
    test('GET /api/dividends/projections-detail returns multi-source yield data and warning status', async () => {
      // First ensure an asset position exists in portfolio
      db.prepare(`
        INSERT OR REPLACE INTO assets (ticker, name, type, currentPrice, dividendYield)
        VALUES ('ENI.MI', 'Eni S.p.A.', 'EQUITY', 14.50, 6.20)
      `).run();

      await fetch(`${baseUrl}/api/transactions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
        body: JSON.stringify({
          portfolioId,
          assetTicker: 'ENI.MI',
          type: 'BUY',
          date: '2026-01-10',
          quantity: 100,
          price: 14.50,
          fee: 0,
          tax: 0
        })
      });

      const res = await fetch(`${baseUrl}/api/dividends/projections-detail?portfolioId=${portfolioId}`, {
        headers: { Authorization: `Bearer ${authToken}` }
      });
      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.strictEqual(data.success, true);
      assert.ok(Array.isArray(data.holdings));

      const eni = data.holdings.find(h => h.ticker === 'ENI.MI');
      assert.ok(eni, 'ENI.MI must be in projections list');
      assert.strictEqual(eni.ticker, 'ENI.MI');
      assert.strictEqual(eni.source, 'PROVIDER');
      assert.strictEqual(eni.appliedYield, 6.20);
      assert.strictEqual(eni.isConfirmed, false);
      assert.strictEqual(eni.status, 'WARNING'); // Not yet confirmed and no portfolio historical receipts
    });

    test('PUT /api/dividends/projections/:ticker updates source, manualYield, notes, and confirms', async () => {
      const updateRes = await fetch(`${baseUrl}/api/dividends/projections/ENI.MI`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
        body: JSON.stringify({
          portfolioId,
          source: 'MANUAL',
          manualYield: 5.50,
          notes: 'Yield confermato da investor relations',
          isConfirmed: 1
        })
      });
      assert.strictEqual(updateRes.status, 200);
      const updateData = await updateRes.json();
      assert.strictEqual(updateData.success, true);

      // Verify updated details
      const detailRes = await fetch(`${baseUrl}/api/dividends/projections-detail?portfolioId=${portfolioId}`, {
        headers: { Authorization: `Bearer ${authToken}` }
      });
      const detailData = await detailRes.json();
      const eni = detailData.holdings.find(h => h.ticker === 'ENI.MI');
      assert.ok(eni);
      assert.strictEqual(eni.source, 'MANUAL');
      assert.strictEqual(eni.appliedYield, 5.50);
      assert.strictEqual(eni.isConfirmed, true);
      assert.strictEqual(eni.status, 'CONFIRMED');
      assert.strictEqual(eni.notes, 'Yield confermato da investor relations');

      // Verify income-summary incorporates the updated manual yield (100 * 14.50 * 5.50% = 79.75)
      const incRes = await fetch(`${baseUrl}/api/dividends/income-summary?portfolioId=${portfolioId}`, {
        headers: { Authorization: `Bearer ${authToken}` }
      });
      const incData = await incRes.json();
      assert.strictEqual(incData.success, true);
      const eniProj = incData.summary.nextYearForecast.holdingProjections.find(h => h.ticker === 'ENI.MI');
      assert.ok(eniProj);
      assert.strictEqual(eniProj.dividendYield, 5.50);
      assert.strictEqual(eniProj.projectedAnnualIncome, 79.75);
    });

    test('POST /api/dividends/recalculate recalculates and preserves manual overrides and confirmation', async () => {
      const recalcRes = await fetch(`${baseUrl}/api/dividends/recalculate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
        body: JSON.stringify({ portfolioId })
      });
      assert.strictEqual(recalcRes.status, 200);
      const recalcData = await recalcRes.json();
      assert.strictEqual(recalcData.success, true);

      const detailRes = await fetch(`${baseUrl}/api/dividends/projections-detail?portfolioId=${portfolioId}`, {
        headers: { Authorization: `Bearer ${authToken}` }
      });
      const detailData = await detailRes.json();
      const eni = detailData.holdings.find(h => h.ticker === 'ENI.MI');
      assert.ok(eni);
      assert.strictEqual(eni.source, 'MANUAL');
      assert.strictEqual(eni.appliedYield, 5.50);
      assert.strictEqual(eni.isConfirmed, true);
    });
  });
});
