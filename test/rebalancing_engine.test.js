const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');

const TEST_DB = path.join(__dirname, 'test_rebalancing.db');
process.env.DB_PATH = TEST_DB;
process.env.JWT_SECRET = 'test-jwt-secret-rebalancing-wealthfolio';
process.env.ADMIN_PASSWORD = 'adminRebalancePass123!';
process.env.NODE_ENV = 'test';

const { initDb, closeDb, db } = require('../src/db');
const app = require('../src/app');
const {
  PRESET_TARGET_MODELS,
  normalizeAssetClass,
  calculateRebalanceWorksheet,
  generateRebalanceCsv,
  generateClipboardOrderText
} = require('../src/utils/rebalanceEngine');

let server;
let baseUrl;
let authToken;
let portfolioId;

describe('Wealthfolio-Compatible Target Allocation & Rebalancing Engine Tests', () => {
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
      body: JSON.stringify({ username: 'admin', password: 'adminRebalancePass123!' })
    });
    const loginData = await loginRes.json();
    authToken = loginData.token;

    // Create a portfolio for testing rebalance
    const portRes = await fetch(`${baseUrl}/api/portfolios`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`
      },
      body: JSON.stringify({
        name: 'Portafoglio Rebalancing Test',
        currency: 'EUR',
        initialCash: 1000.0,
        description: 'Test portfolio for Wealthfolio rebalancing'
      })
    });
    const portData = await portRes.json();
    portfolioId = portData.portfolio.id;

    // Initial deposit
    await fetch(`${baseUrl}/api/transactions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`
      },
      body: JSON.stringify({
        portfolioId,
        type: 'DEPOSIT',
        date: '2026-01-01',
        amount: 2000.0
      })
    });

    // Add asset info into database
    db.prepare(`
      INSERT OR REPLACE INTO assets (ticker, name, type, currency, currentPrice, updatedAt)
      VALUES ('VWCE.DE', 'Vanguard FTSE All-World UCITS ETF', 'ETF', 'EUR', 100.0, datetime('now')),
             ('AGGH.MI', 'iShares Global Aggregate Bond UCITS ETF', 'BOND', 'EUR', 5.0, datetime('now')),
             ('SGLD.MI', 'Invesco Physical Gold ETC', 'COMMODITY', 'EUR', 50.0, datetime('now'))
    `).run();

    // Buy holdings
    await fetch(`${baseUrl}/api/transactions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`
      },
      body: JSON.stringify({
        portfolioId,
        type: 'BUY',
        assetTicker: 'VWCE.DE',
        date: '2026-01-02',
        quantity: 10,
        price: 100.0
      })
    });

    await fetch(`${baseUrl}/api/transactions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`
      },
      body: JSON.stringify({
        portfolioId,
        type: 'BUY',
        assetTicker: 'AGGH.MI',
        date: '2026-01-02',
        quantity: 50,
        price: 5.0
      })
    });
  });

  after(() => {
    if (server) server.close();
    closeDb();
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  });

  // --- UNIT TESTS: REBALANCE ENGINE ---

  test('Preset Models: all models should sum up to 100%', () => {
    assert.ok(Array.isArray(PRESET_TARGET_MODELS));
    assert.ok(PRESET_TARGET_MODELS.length >= 5);

    for (const preset of PRESET_TARGET_MODELS) {
      assert.ok(preset.id && preset.name);
      const total = preset.allocations.reduce((sum, a) => sum + a.targetPercent, 0);
      assert.strictEqual(Math.round(total), 100, `Preset ${preset.id} does not sum to 100%`);
    }
  });

  test('normalizeAssetClass: handles different asset types correctly', () => {
    assert.strictEqual(normalizeAssetClass('STOCK'), 'EQUITY');
    assert.strictEqual(normalizeAssetClass('ETF'), 'EQUITY');
    assert.strictEqual(normalizeAssetClass('BOND'), 'BOND');
    assert.strictEqual(normalizeAssetClass('GOVERNMENT_BOND'), 'BOND');
    assert.strictEqual(normalizeAssetClass('GOLD'), 'COMMODITY');
    assert.strictEqual(normalizeAssetClass('CRYPTO'), 'CRYPTO');
    assert.strictEqual(normalizeAssetClass('CASH'), 'CASH');
  });

  test('calculateRebalanceWorksheet: CASH_FIRST strategy (Buy-Only) with deposit', () => {
    const holdings = [
      { ticker: 'VWCE.DE', name: 'Vanguard All-World', type: 'ETF', quantity: 80, currentPrice: 100.0, marketValue: 8000.0 },
      { ticker: 'AGGH.MI', name: 'iShares Global Bond', type: 'BOND', quantity: 200, currentPrice: 10.0, marketValue: 2000.0 }
    ];
    // Total current = 10,000 EUR (80% VWCE, 20% AGGH)
    // Target: 60% VWCE, 40% AGGH
    // With addedCash = 5000 EUR: new total = 15,000 EUR
    // Target values: VWCE = 9,000 EUR (needs +1,000 EUR), AGGH = 6,000 EUR (needs +4,000 EUR)
    const targetAllocations = [
      { id: 'VWCE.DE', label: 'VWCE', targetPercent: 60.0 },
      { id: 'AGGH.MI', label: 'AGGH', targetPercent: 40.0 }
    ];

    const worksheet = calculateRebalanceWorksheet({
      holdings,
      currentCash: 0,
      addedCash: 5000.0,
      targetAllocations,
      targetType: 'HOLDING',
      strategy: 'CASH_FIRST',
      options: { toleranceBand: 2.0, allowFractional: false }
    });

    assert.strictEqual(worksheet.strategy, 'CASH_FIRST');
    assert.strictEqual(worksheet.totalPortfolioValue, 15000.0);
    assert.strictEqual(worksheet.availableCash, 5000.0);

    const vwceLine = worksheet.lines.find(l => l.ticker === 'VWCE.DE');
    const agghLine = worksheet.lines.find(l => l.ticker === 'AGGH.MI');

    assert.ok(vwceLine);
    assert.ok(agghLine);

    // In CASH_FIRST, neither should be SELL
    assert.ok(vwceLine.action === 'BUY' || vwceLine.action === 'HOLD');
    assert.strictEqual(agghLine.action, 'BUY');

    // AGGH was at 20%, target is 40% -> Underweight
    assert.strictEqual(agghLine.status, 'UNDERWEIGHT');
    assert.ok(agghLine.suggestedQuantity > 0);
    assert.strictEqual(agghLine.suggestedQuantity, 400);

    // Projected totals
    assert.ok(worksheet.fundingLeft >= 0);
  });

  test('calculateRebalanceWorksheet: FULL_REBALANCE strategy triggers SELL for overweight', () => {
    const holdings = [
      { ticker: 'VWCE.DE', name: 'Vanguard All-World', type: 'ETF', quantity: 90, currentPrice: 100.0, marketValue: 9000.0 },
      { ticker: 'AGGH.MI', name: 'iShares Global Bond', type: 'BOND', quantity: 100, currentPrice: 10.0, marketValue: 1000.0 }
    ];
    // Total = 10,000 EUR. 90% VWCE, 10% AGGH.
    // Target: 50% VWCE, 50% AGGH. No added cash.
    // VWCE needs to sell 4000 EUR (40 shares).
    // AGGH needs to buy 4000 EUR (400 shares).
    const targetAllocations = [
      { id: 'VWCE.DE', label: 'VWCE', targetPercent: 50.0 },
      { id: 'AGGH.MI', label: 'AGGH', targetPercent: 50.0 }
    ];

    const worksheet = calculateRebalanceWorksheet({
      holdings,
      currentCash: 0,
      addedCash: 0,
      targetAllocations,
      targetType: 'HOLDING',
      strategy: 'FULL_REBALANCE',
      options: { toleranceBand: 2.0, allowFractional: false }
    });

    const vwceLine = worksheet.lines.find(l => l.ticker === 'VWCE.DE');
    const agghLine = worksheet.lines.find(l => l.ticker === 'AGGH.MI');

    assert.strictEqual(vwceLine.status, 'OVERWEIGHT');
    assert.strictEqual(vwceLine.action, 'SELL');
    assert.strictEqual(vwceLine.suggestedQuantity, 40);

    assert.strictEqual(agghLine.status, 'UNDERWEIGHT');
    assert.strictEqual(agghLine.action, 'BUY');
    assert.strictEqual(agghLine.suggestedQuantity, 400);
  });

  test('generateRebalanceCsv and generateClipboardOrderText generate proper formatting', () => {
    const mockWorksheet = {
      strategy: 'CASH_FIRST',
      toleranceBand: 2.0,
      allowFractional: false,
      totalPortfolioValue: 10000,
      currentCash: 500,
      addedCash: 0,
      availableCash: 500,
      totalBuys: 500,
      totalSells: 0,
      fundingLeft: 0,
      maxDriftBefore: 5.0,
      maxDriftAfter: 0.0,
      lines: [
        {
          id: 'VWCE.DE',
          ticker: 'VWCE.DE',
          name: 'Vanguard All-World',
          type: 'ETF',
          currentPrice: 100,
          currentQuantity: 50,
          currentValue: 5000,
          currentPercent: 50,
          targetPercent: 55,
          targetValue: 5500,
          driftPercent: -5,
          action: 'BUY',
          suggestedQuantity: 5,
          suggestedAmount: 500,
          projectedQuantity: 55,
          projectedValue: 5500,
          projectedPercent: 55,
          projectedDriftPercent: 0
        }
      ]
    };

    const csv = generateRebalanceCsv(mockWorksheet, 'TestPort');
    assert.ok(csv.includes('Ticker,Nome / Categoria,Prezzo Attuale'));
    assert.ok(csv.includes('VWCE.DE'));
    assert.ok(csv.includes('BUY'));

    const text = generateClipboardOrderText(mockWorksheet, 'TestPort');
    assert.ok(text.includes('PIANO DI RIBILANCIAMENTO FOLIOTRACK - TESTPORT'));
    assert.ok(text.includes('COMPRA VWCE.DE: 5 quote @ ~€100.00'));
  });

  // --- INTEGRATION TESTS: ROUTES ---

  test('GET /api/rebalancing/presets: returns built-in presets', async () => {
    const res = await fetch(`${baseUrl}/api/rebalancing/presets`, {
      headers: { Authorization: `Bearer ${authToken}` }
    });
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.success, true);
    assert.ok(Array.isArray(data.presets));
    assert.ok(data.presets.some(p => p.id === 'classic_60_40'));
  });

  test('POST /api/rebalancing/targets: validates target percentages sum to 100%', async () => {
    // Bad request: sum != 100
    const badRes = await fetch(`${baseUrl}/api/rebalancing/targets`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`
      },
      body: JSON.stringify({
        name: 'Invalid Model',
        allocations: [
          { id: 'EQUITY', label: 'Equity', targetPercent: 50 }
        ]
      })
    });
    assert.strictEqual(badRes.status, 400);

    // Good request: sum == 100
    const goodRes = await fetch(`${baseUrl}/api/rebalancing/targets`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`
      },
      body: JSON.stringify({
        name: 'Custom 70/30 Test',
        type: 'ASSET_CLASS',
        toleranceBand: 3.0,
        rebalanceMode: 'CASH_FIRST',
        allowFractional: false,
        allocations: [
          { id: 'EQUITY', label: 'Equity', targetPercent: 70 },
          { id: 'BOND', label: 'Bond', targetPercent: 30 }
        ]
      })
    });
    assert.strictEqual(goodRes.status, 201);
    const goodData = await goodRes.json();
    assert.strictEqual(goodData.success, true);
    assert.ok(goodData.target.id);

    // Verify target in GET /api/rebalancing/targets
    const listRes = await fetch(`${baseUrl}/api/rebalancing/targets`, {
      headers: { Authorization: `Bearer ${authToken}` }
    });
    const listData = await listRes.json();
    assert.strictEqual(listData.success, true);
    assert.ok(listData.targets.some(t => t.name === 'Custom 70/30 Test'));

    // Test PUT /api/rebalancing/targets/:id
    const targetId = goodData.target.id;
    const updateRes = await fetch(`${baseUrl}/api/rebalancing/targets/${targetId}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`
      },
      body: JSON.stringify({
        name: 'Custom 70/30 Renamed',
        toleranceBand: 2.5
      })
    });
    assert.strictEqual(updateRes.status, 200);

    // Test DELETE /api/rebalancing/targets/:id
    const delRes = await fetch(`${baseUrl}/api/rebalancing/targets/${targetId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${authToken}` }
    });
    assert.strictEqual(delRes.status, 200);
  });

  test('POST /api/rebalancing/calculate: calculates worksheet for portfolio', async () => {
    const res = await fetch(`${baseUrl}/api/rebalancing/calculate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`
      },
      body: JSON.stringify({
        portfolioId,
        presetId: 'classic_60_40',
        strategy: 'CASH_FIRST',
        addedCash: 500.0
      })
    });

    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.success, true);
    assert.ok(data.worksheet);
    assert.ok(Array.isArray(data.worksheet.lines));
    assert.ok(data.worksheet.totalPortfolioValue > 0);
    assert.ok(data.clipboardText);
  });

  test('POST /api/rebalancing/apply: executes rebalance trades on portfolio', async () => {
    const applyRes = await fetch(`${baseUrl}/api/rebalancing/apply`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`
      },
      body: JSON.stringify({
        portfolioId,
        orders: [
          { ticker: 'AGGH.MI', action: 'BUY', quantity: 10, price: 5.0 }
        ],
        note: 'Test Rebalance Application'
      })
    });

    assert.strictEqual(applyRes.status, 200);
    const applyData = await applyRes.json();
    assert.strictEqual(applyData.success, true);
    assert.strictEqual(applyData.appliedCount, 1);

    // Check transaction inserted in DB
    const tx = db.prepare('SELECT * FROM transactions WHERE portfolioId = ? AND notes LIKE ?').get(portfolioId, '%Test Rebalance Application%');
    assert.ok(tx);
    assert.strictEqual(tx.assetTicker, 'AGGH.MI');
    assert.strictEqual(tx.type, 'BUY');
    assert.strictEqual(tx.quantity, 10);
  });

  test('POST /api/rebalancing/export-csv: downloads CSV formatted response', async () => {
    const res = await fetch(`${baseUrl}/api/rebalancing/export-csv`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`
      },
      body: JSON.stringify({
        portfolioName: 'TestPort',
        worksheet: {
          strategy: 'CASH_FIRST',
          allowFractional: false,
          lines: [
            {
              ticker: 'VWCE.DE',
              name: 'Vanguard All-World',
              currentPrice: 100,
              currentQuantity: 8,
              currentValue: 800,
              currentPercent: 80,
              targetPercent: 80,
              driftPercent: 0,
              action: 'HOLD',
              suggestedQuantity: 0,
              suggestedAmount: 0,
              projectedQuantity: 8,
              projectedValue: 800,
              projectedPercent: 80,
              projectedDriftPercent: 0
            }
          ]
        }
      })
    });

    assert.strictEqual(res.status, 200);
    assert.ok(res.headers.get('content-type').includes('text/csv'));
    const text = await res.text();
    assert.ok(text.includes('VWCE.DE'));
  });

  test('Dual-View UI routing: /rebalance serves desktop and mobile views', async () => {
    // Desktop request
    const desktopRes = await fetch(`${baseUrl}/rebalance`, {
      headers: {
        'Cookie': `foliotrack_token=${authToken}`,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });
    assert.strictEqual(desktopRes.status, 200);
    const desktopHtml = await desktopRes.text();
    assert.ok(desktopHtml.includes('Ribilanciamento Portafoglio'));
    assert.ok(desktopHtml.includes('btnCopyOrders'));

    // Mobile request
    const mobileRes = await fetch(`${baseUrl}/rebalance`, {
      headers: {
        'Cookie': `foliotrack_token=${authToken}`,
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15'
      }
    });
    assert.strictEqual(mobileRes.status, 200);
    const mobileHtml = await mobileRes.text();
    assert.ok(mobileHtml.includes('Ribilanciamento'));
    assert.ok(mobileHtml.includes('safe-area-bottom'));
  });
});
