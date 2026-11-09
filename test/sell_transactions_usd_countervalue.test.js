const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const http = require('http');

const TEST_DB = path.join(__dirname, 'test_sell_usd_validation.db');
process.env.DB_PATH = TEST_DB;
process.env.JWT_SECRET = 'test-secret-sell-usd-validation-12345';
process.env.ADMIN_PASSWORD = 'adminTestPassword123!';

const { initDb, closeDb, getDb } = require('../src/db');
const app = require('../src/app');

let server;
let baseUrl;
let authToken;
let portfolioId;

describe('SELL Transactions Validation & USD Countervalue Checks', () => {
  before(async () => {
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    const walFile = `${TEST_DB}-wal`;
    const shmFile = `${TEST_DB}-shm`;
    if (fs.existsSync(walFile)) fs.unlinkSync(walFile);
    if (fs.existsSync(shmFile)) fs.unlinkSync(shmFile);

    initDb(TEST_DB);

    await new Promise((resolve) => {
      server = http.createServer(app);
      server.listen(0, '127.0.0.1', () => {
        const port = server.address().port;
        baseUrl = `http://127.0.0.1:${port}`;
        resolve();
      });
    });

    const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'adminTestPassword123!' })
    });
    const loginData = await loginRes.json();
    authToken = loginData.token;

    // Create a test portfolio
    const pRes = await fetch(`${baseUrl}/api/portfolios`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`
      },
      body: JSON.stringify({
        name: 'US Growth Portfolio',
        currency: 'EUR',
        costBasisMethod: 'WAC',
        description: 'Portfolio for testing USD SELL mechanics'
      })
    });
    const pData = await pRes.json();
    assert.equal(pRes.status, 201);
    assert.equal(pData.success, true);
    portfolioId = pData.portfolio.id;

    // Deposit cash into portfolio
    const depRes = await fetch(`${baseUrl}/api/transactions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`
      },
      body: JSON.stringify({
        portfolioId,
        type: 'DEPOSIT',
        date: '2025-01-01',
        amount: 10000.0,
        notes: 'Initial Cash Deposit'
      })
    });
    const depData = await depRes.json();
    assert.equal(depRes.status, 201);
    assert.equal(depData.success, true);
  });

  after(async () => {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
    closeDb();
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    const walFile = `${TEST_DB}-wal`;
    const shmFile = `${TEST_DB}-shm`;
    if (fs.existsSync(walFile)) fs.unlinkSync(walFile);
    if (fs.existsSync(shmFile)) fs.unlinkSync(shmFile);
  });

  test('Reject SELL if ticker is not present in portfolio', async () => {
    const res = await fetch(`${baseUrl}/api/transactions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`
      },
      body: JSON.stringify({
        portfolioId,
        type: 'SELL',
        assetTicker: 'MSFT',
        date: '2025-01-05',
        quantity: 10,
        price: 400.0,
        exchangeRate: 1.08
      })
    });
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.equal(data.success, false);
    assert.ok(data.error.includes('non è presente in questo portafoglio'));
  });

  test('Reject SELL if price <= 0 or quantity <= 0', async () => {
    // Buy 10 AAPL first
    const buyRes = await fetch(`${baseUrl}/api/transactions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`
      },
      body: JSON.stringify({
        portfolioId,
        type: 'BUY',
        assetTicker: 'AAPL',
        date: '2025-01-02',
        quantity: 10,
        price: 150.0, // $150
        commission: 2.0, // $2
        exchangeRate: 1.08 // 1 EUR = 1.08 USD
      })
    });
    assert.equal(buyRes.status, 201);

    // Try SELL with price = 0
    const zeroPriceRes = await fetch(`${baseUrl}/api/transactions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`
      },
      body: JSON.stringify({
        portfolioId,
        type: 'SELL',
        assetTicker: 'AAPL',
        date: '2025-01-05',
        quantity: 5,
        price: 0,
        exchangeRate: 1.08
      })
    });
    assert.equal(zeroPriceRes.status, 400);
    const zeroPriceData = await zeroPriceRes.json();
    assert.ok(zeroPriceData.error.includes('maggiore di 0'));

    // Try SELL with quantity = 0
    const zeroQtyRes = await fetch(`${baseUrl}/api/transactions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`
      },
      body: JSON.stringify({
        portfolioId,
        type: 'SELL',
        assetTicker: 'AAPL',
        date: '2025-01-05',
        quantity: 0,
        price: 160.0,
        exchangeRate: 1.08
      })
    });
    assert.equal(zeroQtyRes.status, 400);
  });

  test('Reject SELL if quantity exceeds available holding inventory', async () => {
    // We currently hold 10 AAPL. Try selling 15.
    const excessRes = await fetch(`${baseUrl}/api/transactions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`
      },
      body: JSON.stringify({
        portfolioId,
        type: 'SELL',
        assetTicker: 'AAPL',
        date: '2025-01-05',
        quantity: 15,
        price: 180.0,
        exchangeRate: 1.08
      })
    });
    assert.equal(excessRes.status, 400);
    const excessData = await excessRes.json();
    assert.equal(excessData.success, false);
    assert.ok(excessData.error.includes('Quantità insufficiente in portafoglio'));
    assert.ok(excessData.error.includes('possedute 10'));
  });

  test('Execute USD SELL and verify correct FX division for cash proceeds (no inversion)', async () => {
    // Current inventory: 10 AAPL.
    // Sell 4 AAPL @ $200.00.
    // Gross USD: 4 * 200 = 800 USD.
    // Comm USD: 2.00 USD.
    // Net USD: 800 - 2 = 798 USD.
    // FX: 1.08 USD per EUR.
    // Cash EUR proceeds: 798 / 1.08 = 738.8888... EUR.
    // (Previously buggy formula did (qty * prc * fx) which would give 800 * 1.08 = 864 EUR!)
    const sellRes = await fetch(`${baseUrl}/api/transactions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`
      },
      body: JSON.stringify({
        portfolioId,
        type: 'SELL',
        assetTicker: 'AAPL',
        date: '2025-01-06',
        quantity: 4,
        price: 200.0,
        commission: 2.0,
        exchangeRate: 1.08
      })
    });
    assert.equal(sellRes.status, 201);
    const sellData = await sellRes.json();
    assert.equal(sellData.success, true);
    assert.ok(sellData.transaction && sellData.transaction.id > 0);

    // Verify stored transaction amount
    const db = getDb();
    const txRow = db.prepare('SELECT * FROM transactions WHERE id = ?').get(sellData.transaction.id);
    assert.ok(txRow);
    const expectedEur = (800 / 1.08) - (2 / 1.08); // (grossEur - commEur)
    assert.ok(Math.abs(txRow.amount - expectedEur) < 0.01, `Stored amount ${txRow.amount} should match expected EUR ${expectedEur}`);

    // Verify remaining quantity is 6
    const pDetailRes = await fetch(`${baseUrl}/api/portfolios/${portfolioId}`, {
      headers: { Authorization: `Bearer ${authToken}` }
    });
    const pDetail = await pDetailRes.json();
    assert.equal(pDetail.success, true);
    const aaplPos = pDetail.portfolio.metrics.holdings.find(h => h.ticker === 'AAPL');
    assert.ok(aaplPos);
    assert.equal(aaplPos.quantity, 6);
  });

  test('PUT /api/transactions/:id rejects edit if SELL causes negative holding inventory', async () => {
    // We currently hold 6 AAPL.
    // Try to update the previous SELL (which was 4) to 12.
    // Total bought was 10, so 12 would lead to -2 shares!
    const db = getDb();
    const sellTx = db.prepare("SELECT id FROM transactions WHERE portfolioId = ? AND type = 'SELL'").get(portfolioId);
    assert.ok(sellTx);

    const editRes = await fetch(`${baseUrl}/api/transactions/${sellTx.id}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`
      },
      body: JSON.stringify({
        portfolioId,
        type: 'SELL',
        assetTicker: 'AAPL',
        date: '2025-01-06',
        quantity: 12, // exceeds 10 bought
        price: 200.0,
        commission: 2.0,
        exchangeRate: 1.08
      })
    });
    assert.equal(editRes.status, 400);
    const editData = await editRes.json();
    assert.equal(editData.success, false);
    assert.ok(editData.error.includes('quantità negativa') || editData.error.includes('non valida'));
  });

  test('Frontend asset_drawer.js contains dedicated SELL button and opens TransactionModal with SELL', () => {
    const drawerPath = path.join(__dirname, '../public/asset_drawer.js');
    const content = fs.readFileSync(drawerPath, 'utf8');

    assert.ok(content.includes('id="drawerSellBtn"'), 'Must have drawerSellBtn in drawer footer');
    assert.ok(content.includes('🔴 Vendi Titolo (SELL)'), 'Must display "🔴 Vendi Titolo (SELL)" label');
    assert.ok(content.includes("type: 'SELL'"), 'Must trigger TransactionModal.open with type SELL');
  });

  test('Frontend transaction_modal.js proposes native currency ($) and validates SELL', () => {
    const modalPath = path.join(__dirname, '../public/transaction_modal.js');
    const content = fs.readFileSync(modalPath, 'utf8');

    assert.ok(content.includes('function getCurrencySymbol'), 'Must support currency symbols');
    assert.ok(content.includes('Controvalore Vendita'), 'Must label countervalue as Controvalore Vendita');
    assert.ok(content.includes('countervalueFxRow'), 'Must display secondary EUR equivalent');
    assert.ok(content.includes('validateSellQuantity'), 'Must have validateSellQuantity function');
    assert.ok(content.includes('txPortfolioHoldingPick'), 'Must provide quick-pick selector for holdings in portfolio');
    assert.ok(content.includes('Conferma Vendita (SELL)'), 'Must feature dedicated SELL confirmation button');
  });
});
