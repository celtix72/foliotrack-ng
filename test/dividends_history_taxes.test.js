const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');

const TEST_DB = path.join(__dirname, 'test_phase8.db');
process.env.DB_PATH = TEST_DB;
process.env.JWT_SECRET = 'test-jwt-secret-phase8-dividends-history-taxes';
process.env.ADMIN_PASSWORD = 'adminPhase8Password!';
process.env.NODE_ENV = 'test';

const { initDb, closeDb, db } = require('../src/db');
const app = require('../src/app');
const { recalculateDividendProjections } = require('../src/routes/dividends');
const { recordDailySnapshot } = require('../src/routes/history');
const { compensateTaxGain, recordTaxLoss } = require('../src/routes/taxes');

let server;
let baseUrl;
let authToken;
let portfolioId;

describe('Phase 8: Dividends, Income Projections, Portfolio Snapshots & Italian Tax Backpack', () => {
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
      body: JSON.stringify({ username: 'admin', password: 'adminPhase8Password!' })
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
        name: 'Income & Dividends Alpha',
        type: 'Investimento',
        currency: 'EUR',
        initialCash: 15000
      })
    });
    const portData = await portRes.json();
    portfolioId = portData.portfolio.id;

    // Create dividend-paying assets
    // 1. High dividend equity: ENI (yield 6.5%)
    await fetch(`${baseUrl}/api/assets`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`
      },
      body: JSON.stringify({
        ticker: 'ENI.MI',
        name: 'Eni S.p.A.',
        type: 'EQUITY',
        currency: 'EUR',
        currentPrice: 14.50,
        dividendYield: 6.5,
        sector: 'Energy',
        region: 'Europe'
      })
    });

    // 2. Bond with coupon: BTP 2037 (yield 4.0%)
    await fetch(`${baseUrl}/api/assets`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`
      },
      body: JSON.stringify({
        ticker: 'IT0005438004',
        name: 'BTP 01FB37 4.00%',
        type: 'BOND',
        currency: 'EUR',
        currentPrice: 101.50,
        dividendYield: 4.0,
        sector: 'Financials',
        region: 'Europe'
      })
    });

    // Buy 200 shares of ENI (200 * 14.50 = 2900)
    await fetch(`${baseUrl}/api/transactions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`
      },
      body: JSON.stringify({
        portfolioId,
        type: 'BUY',
        assetTicker: 'ENI.MI',
        date: '2024-01-10',
        quantity: 200,
        price: 14.50,
        commission: 4.0
      })
    });

    // Buy 50 quotes of BTP (50 * 101.50 = 5075)
    await fetch(`${baseUrl}/api/transactions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`
      },
      body: JSON.stringify({
        portfolioId,
        type: 'BUY',
        assetTicker: 'IT0005438004',
        date: '2024-01-15',
        quantity: 50,
        price: 101.50,
        commission: 5.0
      })
    });

    // Record stock dividend: ENI
    await fetch(`${baseUrl}/api/transactions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`
      },
      body: JSON.stringify({
        portfolioId,
        type: 'DIVIDEND',
        assetTicker: 'ENI.MI',
        date: '2024-05-20',
        amount: 94.0,
        notes: 'Acconto dividendo Eni'
      })
    });

    // Record bond coupon: BTP
    await fetch(`${baseUrl}/api/transactions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`
      },
      body: JSON.stringify({
        portfolioId,
        type: 'INTEREST',
        assetTicker: 'IT0005438004',
        date: '2024-08-01',
        amount: 101.5,
        notes: 'Cedola semestrale BTP'
      })
    });
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

  describe('1. Income Summary & 12-Month Projections (src/routes/dividends.js)', () => {
    test('recalculateDividendProjections computes forward annual and monthly projections', () => {
      const projections = recalculateDividendProjections(portfolioId);
      assert.strictEqual(projections.length, 2);

      const eni = projections.find(p => p.assetTicker === 'ENI.MI');
      assert.ok(eni);
      assert.strictEqual(eni.sharesHeld, 200);
      assert.strictEqual(eni.dividendYield, 6.5);
      // 200 * 14.50 * 0.065 = 188.50
      assert.ok(Math.abs(eni.projectedAnnualIncome - 188.50) < 0.1);
      assert.ok(Math.abs(eni.projectedMonthlyIncome - (188.50 / 12)) < 0.1);

      const btp = projections.find(p => p.assetTicker === 'IT0005438004');
      assert.ok(btp);
      assert.strictEqual(btp.sharesHeld, 50);
      // 50 * 101.50 * 0.04 = 203.00
      assert.ok(Math.abs(btp.projectedAnnualIncome - 203.00) < 0.1);
    });

    test('GET /api/dividends/income-summary returns structured breakdowns and projections', async () => {
      const res = await fetch(`${baseUrl}/api/dividends/income-summary?portfolioId=${portfolioId}`, {
        headers: { Authorization: `Bearer ${authToken}` }
      });
      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.strictEqual(data.success, true);
      const s = data.summary;

      // Total received: 94 + 101.5 = 195.5
      assert.strictEqual(s.totalReceived, 195.5);

      // byType distinction
      assert.strictEqual(s.byType.dividends, 94.0);
      assert.strictEqual(s.byType.interest, 101.5);
      assert.strictEqual(s.byType.total, 195.5);

      // byMonth grouping
      assert.ok(s.byMonth.length >= 2);
      const may2024 = s.byMonth.find(m => m.month === '2024-05');
      assert.ok(may2024);
      assert.strictEqual(may2024.dividends, 94.0);

      // byAsset ranking
      assert.strictEqual(s.byAsset.length, 2);
      assert.strictEqual(s.byAsset[0].ticker, 'IT0005438004'); // 101.5 > 94.0

      // Projections: 188.50 + 203.00 = 391.50
      assert.ok(Math.abs(s.projectedNext12Months - 391.50) < 0.5);
      assert.ok(s.projectedMonthlyAverage > 0);
    });
  });

  describe('2. Daily NAV Snapshot & Historical Performance (src/routes/history.js)', () => {
    test('recordDailySnapshot captures immutable portfolio NAV', () => {
      const snapshots = recordDailySnapshot(portfolioId, '2024-08-01');
      assert.strictEqual(snapshots.length, 1);
      assert.strictEqual(snapshots[0].date, '2024-08-01');
      assert.ok(snapshots[0].totalValue > 0);
      assert.ok(snapshots[0].cashValue > 0);

      const row = db.prepare('SELECT * FROM portfolio_history WHERE portfolioId = ? AND date = ?').get(portfolioId, '2024-08-01');
      assert.ok(row);
      assert.strictEqual(row.totalValue, snapshots[0].totalValue);
    });

    test('POST /api/history/snapshot triggers snapshot via API', async () => {
      const res = await fetch(`${baseUrl}/api/history/snapshot`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${authToken}`
        },
        body: JSON.stringify({ portfolioId, date: '2024-08-02' })
      });
      assert.strictEqual(res.status, 201);
      const data = await res.json();
      assert.strictEqual(data.success, true);
      assert.ok(data.snapshots.length >= 1);
    });

    test('GET /api/history/performance calculates returns and drawdown curve', async () => {
      // Record a higher peak earlier and a lower value later to simulate a drawdown
      const peakDate = new Date(Date.now() - 30 * 86400000).toISOString().split('T')[0];
      const dropDate = new Date(Date.now() - 10 * 86400000).toISOString().split('T')[0];

      db.prepare(`
        INSERT OR REPLACE INTO portfolio_history (portfolioId, date, totalValue, cashValue, assetValue, netDeposits)
        VALUES (?, ?, 25000, 10000, 15000, 20000)
      `).run(portfolioId, peakDate);

      db.prepare(`
        INSERT OR REPLACE INTO portfolio_history (portfolioId, date, totalValue, cashValue, assetValue, netDeposits)
        VALUES (?, ?, 20000, 8000, 12000, 20000)
      `).run(portfolioId, dropDate);

      const res = await fetch(`${baseUrl}/api/history/performance?portfolioId=${portfolioId}&range=1Y`, {
        headers: { Authorization: `Bearer ${authToken}` }
      });
      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.strictEqual(data.success, true);
      assert.ok(data.series.length >= 2);
      // Peak was 25000, dropped to 20000 -> (25000 - 20000) / 25000 = 20% drawdown
      assert.ok(data.maxDrawdown >= 20.0);
    });
  });

  describe('3. Italian Tax Backpack (Zainetto Fiscale) & Compensation (src/routes/taxes.js)', () => {
    test('POST /api/taxes/losses records minusvalenza with 4-year legal expiry', async () => {
      const res = await fetch(`${baseUrl}/api/taxes/losses`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${authToken}`
        },
        body: JSON.stringify({
          portfolioId,
          year: 2023,
          amount: 1000.0,
          notes: 'Minusvalenza certificata Directa 2023'
        })
      });
      assert.strictEqual(res.status, 201);
      const data = await res.json();
      assert.strictEqual(data.success, true);
      assert.strictEqual(data.loss.year, 2023);
      assert.strictEqual(data.loss.amount, 1000.0);
      assert.strictEqual(data.loss.residualAmount, 1000.0);
      // D.Lgs. 461/97: 4 subsequent years -> 2023 + 4 = 2027-12-31
      assert.strictEqual(data.loss.expiryDate, '2027-12-31');
    });

    test('GET /api/taxes/zainetto returns summary and calculates potential 26% tax savings', async () => {
      const res = await fetch(`${baseUrl}/api/taxes/zainetto?portfolioId=${portfolioId}`, {
        headers: { Authorization: `Bearer ${authToken}` }
      });
      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.strictEqual(data.success, true);
      assert.strictEqual(data.summary.totalResidualLosses, 1000.0);
      // 1000 * 0.26 = 260.00
      assert.strictEqual(data.summary.taxSavingsPotential, 260.0);
      assert.strictEqual(data.losses.length, 1);
      assert.ok(data.losses[0].daysRemaining > 0);
      assert.strictEqual(data.losses[0].isExpired, false);
    });

    test('compensateTaxGain offsets capital gains against active losses FIFO-style', () => {
      // Plusvalenza di 400 €
      const result = compensateTaxGain(portfolioId, 400.0);
      assert.strictEqual(result.originalGain, 400.0);
      assert.strictEqual(result.compensatedAmount, 400.0);
      assert.strictEqual(result.taxableGain, 0.0); // Fully offset, 0 taxes due!
      assert.strictEqual(result.remainingLosses, 600.0); // 1000 - 400 = 600 residual

      // Check DB
      const loss = db.prepare('SELECT residualAmount FROM portfolio_losses WHERE portfolioId = ?').get(portfolioId);
      assert.strictEqual(loss.residualAmount, 600.0);
    });

    test('recordTaxLoss generates a new capital loss with 4-year legal expiry', () => {
      const lossId = recordTaxLoss(portfolioId, 250.0, '2024-03-15', 'Nuova perdita');
      assert.ok(lossId > 0);

      const row = db.prepare('SELECT * FROM portfolio_losses WHERE id = ?').get(lossId);
      assert.strictEqual(row.year, 2024);
      assert.strictEqual(row.amount, 250.0);
      assert.strictEqual(row.residualAmount, 250.0);
      assert.strictEqual(row.expiryDate, '2028-12-31');
    });
  });

  describe('4. Dual-View History & Dividends Frontend Pages', () => {
    test('GET /history and GET /dividends serve desktop history view with injected sidebar', async () => {
      const res = await fetch(`${baseUrl}/history`, {
        headers: { Cookie: `foliotrack_token=${authToken}` }
      });
      assert.strictEqual(res.status, 200);
      const html = await res.text();
      assert.ok(html.includes('Flussi, Dividendi & Fisco'));
      assert.ok(html.includes('monthlyIncomeChart'));
      assert.ok(html.includes('dividendChartLegend'), 'Must contain dividendChartLegend for annual totals');
      assert.ok(html.includes('1 - Gen') && html.includes('12 - Dic'), 'Must define month 1-12 labels');
      assert.ok(html.includes('performanceChart'));
      assert.ok(html.includes('taxLossesTbody'));
      assert.ok(html.includes('Zainetto Fiscale'));
    });

    test('GET /history?view=mobile serves mobile layout', async () => {
      const res = await fetch(`${baseUrl}/history?view=mobile`, {
        headers: { Cookie: `foliotrack_token=${authToken}` }
      });
      assert.strictEqual(res.status, 200);
      const html = await res.text();
      assert.ok(html.includes('mMonthlyIncomeChart'));
      assert.ok(html.includes('mDividendChartLegend'), 'Must contain mobile dividendChartLegend for annual totals');
      assert.ok(html.includes('mPerformanceChart'));
      assert.ok(html.includes('mTaxLossesContainer'));
    });
  });
});
