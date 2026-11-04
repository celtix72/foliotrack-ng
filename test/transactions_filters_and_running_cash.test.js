const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const path = require('path');
const fs = require('fs');

const TEST_DB = path.join(__dirname, 'test_tx_filters_running_cash.db');
process.env.DB_PATH = TEST_DB;
process.env.JWT_SECRET = 'test_jwt_secret_tx_filters_running_cash_998877';
process.env.NODE_ENV = 'test';

const { initDb, getDb, closeDb } = require('../src/db');
const app = require('../src/app');
const { computeTransactionCashDelta } = require('../src/utils/finance');

describe('Transactions Advanced Filters & Running Cash Balance Engine', () => {
  let server;
  let baseUrl;
  let authToken;
  let portfolioId;

  before(async () => {
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    initDb(TEST_DB);

    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, resolve));
    const port = server.address().port;
    baseUrl = `http://127.0.0.1:${port}`;

    // Login as admin
    const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin123' })
    });
    const loginData = await loginRes.json();
    authToken = loginData.token;

    // Create a portfolio with initialCash = 10000
    const pRes = await fetch(`${baseUrl}/api/portfolios`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`
      },
      body: JSON.stringify({
        name: 'Running Cash Test Portfolio',
        type: 'Investimento',
        currency: 'EUR',
        startDate: '2024-01-01',
        initialCash: 10000.0
      })
    });
    const pData = await pRes.json();
    portfolioId = pData.portfolio.id;

    // Seed diverse assets in the catalog (EQUITY, ETF, BOND)
    const db = getDb();
    db.prepare(`
      INSERT OR REPLACE INTO assets (ticker, name, type, currentPrice, currency)
      VALUES
        ('AAPL', 'Apple Inc', 'EQUITY', 150.0, 'EUR'),
        ('SWDA.MI', 'iShares Core MSCI World', 'ETF', 80.0, 'EUR'),
        ('BTP.MI', 'BTP Dec 2030', 'BOND', 100.0, 'EUR')
    `).run();

    // Sequence of 5 transactions on distinct dates:
    // 1. 2024-01-10: BUY 10 AAPL @ 150.0 (comm: 5, tax: 0) -> delta: -1505 -> runningCash: 10000 - 1505 = 8495
    // 2. 2024-02-15: BUY 20 SWDA.MI @ 80.0 (comm: 4, tax: 0) -> delta: -1604 -> runningCash: 8495 - 1604 = 6891
    // 3. 2024-03-20: DIVIDEND AAPL (amount: 50.0) -> delta: +50 -> runningCash: 6891 + 50 = 6941
    // 4. 2024-04-10: SELL 5 AAPL @ 160.0 (comm: 5, tax: 10) -> delta: 800 - 15 = +785 -> runningCash: 6941 + 785 = 7726
    // 5. 2024-05-01: WITHDRAWAL (amount: 2000.0) -> delta: -2000 -> runningCash: 7726 - 2000 = 5726

    const txsToInsert = [
      { date: '2024-01-10', type: 'BUY', assetTicker: 'AAPL', quantity: 10, price: 150.0, commission: 5, tax: 0, amount: 1505, notes: 'Acquisto tech' },
      { date: '2024-02-15', type: 'BUY', assetTicker: 'SWDA.MI', quantity: 20, price: 80.0, commission: 4, tax: 0, amount: 1604, notes: 'PAC ETF World' },
      { date: '2024-03-20', type: 'DIVIDEND', assetTicker: 'AAPL', quantity: 0, price: 0, commission: 0, tax: 0, amount: 50.0, notes: 'Stacco dividendo' },
      { date: '2024-04-10', type: 'SELL', assetTicker: 'AAPL', quantity: 5, price: 160.0, commission: 5, tax: 10, amount: 785.0, notes: 'Presa profitto' },
      { date: '2024-05-01', type: 'WITHDRAWAL', assetTicker: null, quantity: 0, price: 0, commission: 0, tax: 0, amount: 2000.0, notes: 'Prelievo liquidità' }
    ];

    for (const tx of txsToInsert) {
      const res = await fetch(`${baseUrl}/api/transactions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${authToken}`
        },
        body: JSON.stringify({
          portfolioId,
          ...tx
        })
      });
      assert.strictEqual(res.status, 201);
    }
  });

  after(async () => {
    if (server) await new Promise((res) => server.close(res));
    closeDb();
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  });

  test('computeTransactionCashDelta accurately computes inflows and outflows', () => {
    assert.strictEqual(computeTransactionCashDelta({ type: 'DEPOSIT', amount: 5000 }), 5000);
    assert.strictEqual(computeTransactionCashDelta({ type: 'WITHDRAWAL', amount: 1200 }), -1200);
    assert.strictEqual(computeTransactionCashDelta({ type: 'TRANSFER', amount: 300 }), 300);
    assert.strictEqual(computeTransactionCashDelta({ type: 'BUY', quantity: 10, price: 100, commission: 5, tax: 2 }), -1007);
    assert.strictEqual(computeTransactionCashDelta({ type: 'SELL', quantity: 10, price: 100, commission: 5, tax: 2 }), 993);
    assert.strictEqual(computeTransactionCashDelta({ type: 'DIVIDEND', amount: 45 }), 45);
    assert.strictEqual(computeTransactionCashDelta({ type: 'FEE', amount: 15 }), -15);
    assert.strictEqual(computeTransactionCashDelta({ type: 'SPLIT', quantity: 2 }), 0);
  });

  test('GET /api/transactions returns runningCash balance after each movement', async () => {
    const res = await fetch(`${baseUrl}/api/transactions?portfolioId=${portfolioId}`, {
      headers: { Authorization: `Bearer ${authToken}` }
    });
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.success, true);
    assert.strictEqual(data.total, 6);

    // Returned in DESC order (latest first):
    // Index 0: 2024-05-01 WITHDRAWAL -> runningCash should be 5726.0
    // Index 1: 2024-04-10 SELL -> runningCash should be 7726.0
    // Index 2: 2024-03-20 DIVIDEND -> runningCash should be 6941.0
    // Index 3: 2024-02-15 BUY -> runningCash should be 6891.0
    // Index 4: 2024-01-10 BUY -> runningCash should be 8495.0
    // Index 5: 2024-01-01 DEPOSIT (initial deposit) -> runningCash should be 10000.0

    const txs = data.transactions;
    assert.strictEqual(txs[0].type, 'WITHDRAWAL');
    assert.strictEqual(txs[0].runningCash, 5726.0);
    assert.strictEqual(txs[0].cashDelta, -2000.0);

    assert.strictEqual(txs[1].type, 'SELL');
    assert.strictEqual(txs[1].runningCash, 7726.0);
    assert.strictEqual(txs[1].cashDelta, 785.0);

    assert.strictEqual(txs[2].type, 'DIVIDEND');
    assert.strictEqual(txs[2].runningCash, 6941.0);
    assert.strictEqual(txs[2].cashDelta, 50.0);

    assert.strictEqual(txs[3].type, 'BUY');
    assert.strictEqual(txs[3].runningCash, 6891.0);
    assert.strictEqual(txs[3].cashDelta, -1604.0);

    assert.strictEqual(txs[4].type, 'BUY');
    assert.strictEqual(txs[4].runningCash, 8495.0);
    assert.strictEqual(txs[4].cashDelta, -1505.0);

    assert.strictEqual(txs[5].type, 'DEPOSIT');
    assert.strictEqual(txs[5].runningCash, 10000.0);
    assert.strictEqual(txs[5].cashDelta, 10000.0);
    assert.strictEqual(txs[5].notes, 'Deposito iniziale');

    // Verify summary stats
    assert.ok(data.summary);
    assert.strictEqual(data.summary.totalCount, 6);
    // Inflows: 10000 (DEPOSIT) + 50 (DIVIDEND) + 785 (SELL) = 10835
    assert.strictEqual(data.summary.totalInflow, 10835.0);
    // Outflows: 1505 (BUY) + 1604 (BUY) + 2000 (WITHDRAWAL) = 5109
    assert.strictEqual(data.summary.totalOutflow, 5109.0);
    assert.strictEqual(data.summary.netFlow, 10835.0 - 5109.0);
  });

  test('GET /api/transactions supports multi-type filtering (e.g. type=BUY,SELL)', async () => {
    const res = await fetch(`${baseUrl}/api/transactions?portfolioId=${portfolioId}&type=BUY,SELL`, {
      headers: { Authorization: `Bearer ${authToken}` }
    });
    const data = await res.json();
    assert.strictEqual(data.success, true);
    assert.strictEqual(data.total, 3); // 2 BUYs and 1 SELL

    for (const t of data.transactions) {
      assert.ok(['BUY', 'SELL'].includes(t.type));
      // runningCash still reflects true chronological account balance!
      assert.ok(typeof t.runningCash === 'number');
    }
  });

  test('GET /api/transactions supports instrument / assetType filtering (EQUITY, ETF, CASH)', async () => {
    // 1. Filter by EQUITY
    const resEquity = await fetch(`${baseUrl}/api/transactions?portfolioId=${portfolioId}&assetType=EQUITY`, {
      headers: { Authorization: `Bearer ${authToken}` }
    });
    const dEquity = await resEquity.json();
    assert.strictEqual(dEquity.success, true);
    assert.strictEqual(dEquity.total, 3); // 2 AAPL buys/sells + 1 dividend
    for (const t of dEquity.transactions) {
      assert.strictEqual(t.assetTicker, 'AAPL');
    }

    // 2. Filter by ETF
    const resEtf = await fetch(`${baseUrl}/api/transactions?portfolioId=${portfolioId}&assetType=ETF`, {
      headers: { Authorization: `Bearer ${authToken}` }
    });
    const dEtf = await resEtf.json();
    assert.strictEqual(dEtf.success, true);
    assert.strictEqual(dEtf.total, 1);
    assert.strictEqual(dEtf.transactions[0].assetTicker, 'SWDA.MI');

    // 3. Filter by CASH (pure cash movements: 1 WITHDRAWAL + 1 initial DEPOSIT)
    const resCash = await fetch(`${baseUrl}/api/transactions?portfolioId=${portfolioId}&assetType=CASH`, {
      headers: { Authorization: `Bearer ${authToken}` }
    });
    const dCash = await resCash.json();
    assert.strictEqual(dCash.success, true);
    assert.strictEqual(dCash.total, 2);
    assert.ok(dCash.transactions.some(t => t.type === 'WITHDRAWAL'));
    assert.ok(dCash.transactions.some(t => t.type === 'DEPOSIT'));
  });

  test('GET /api/transactions supports date range filtering (startDate and endDate)', async () => {
    const res = await fetch(`${baseUrl}/api/transactions?portfolioId=${portfolioId}&startDate=2024-02-01&endDate=2024-03-31`, {
      headers: { Authorization: `Bearer ${authToken}` }
    });
    const data = await res.json();
    assert.strictEqual(data.success, true);
    assert.strictEqual(data.total, 2); // 2024-02-15 BUY SWDA and 2024-03-20 DIVIDEND AAPL

    assert.strictEqual(data.transactions[0].date, '2024-03-20');
    assert.strictEqual(data.transactions[0].runningCash, 6941.0);
    assert.strictEqual(data.transactions[1].date, '2024-02-15');
    assert.strictEqual(data.transactions[1].runningCash, 6891.0);
  });

  test('GET /api/transactions supports search across ticker, name, and notes', async () => {
    // Search by note 'PAC'
    const resNote = await fetch(`${baseUrl}/api/transactions?portfolioId=${portfolioId}&search=PAC`, {
      headers: { Authorization: `Bearer ${authToken}` }
    });
    const dNote = await resNote.json();
    assert.strictEqual(dNote.success, true);
    assert.strictEqual(dNote.total, 1);
    assert.strictEqual(dNote.transactions[0].notes, 'PAC ETF World');

    // Search by asset name 'Apple'
    const resName = await fetch(`${baseUrl}/api/transactions?portfolioId=${portfolioId}&search=Apple`, {
      headers: { Authorization: `Bearer ${authToken}` }
    });
    const dName = await resName.json();
    assert.strictEqual(dName.success, true);
    assert.strictEqual(dName.total, 3);
  });
});

