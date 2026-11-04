const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const path = require('path');
const fs = require('fs');

const TEST_DB = path.join(__dirname, 'test_csv_validation_isolated.db');
process.env.DB_PATH = TEST_DB;
process.env.JWT_SECRET = 'test_jwt_secret_csv_val_12345';
process.env.NODE_ENV = 'test';

const { db, initDb, closeDb } = require('../src/db');
const app = require('../src/app');
const { validateImportActivities } = require('../src/utils/importValidator');

describe('Wealthfolio CSV Import Validation & Health Check Engine', () => {
  let server;
  let baseUrl;
  let authToken;
  let portfolioId;

  before(async () => {
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    initDb(TEST_DB);

    // Start temporary HTTP test server
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

    // Create a dedicated test portfolio
    const pRes = await fetch(`${baseUrl}/api/portfolios`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`
      },
      body: JSON.stringify({
        name: 'Wealthfolio Validation Test Portfolio',
        type: 'Investimento',
        currency: 'EUR',
        initialCash: 0
      })
    });
    const pData = await pRes.json();
    portfolioId = pData.portfolio.id;
  });

  after(async () => {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
    closeDb();
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    if (fs.existsSync(`${TEST_DB}-wal`)) fs.unlinkSync(`${TEST_DB}-wal`);
    if (fs.existsSync(`${TEST_DB}-shm`)) fs.unlinkSync(`${TEST_DB}-shm`);
  });

  test('validateImportActivities handles cash pseudo-symbols without requiring equity symbols', () => {
    const mockPortfolio = { id: 99, currency: 'EUR', initialCash: 500 };
    const activities = [
      {
        date: '2024-01-10',
        type: 'DEPOSIT',
        assetTicker: '$CASH-EUR',
        quantity: 0,
        price: 0,
        amount: 1000,
        currency: 'EUR'
      },
      {
        date: '2024-01-15',
        type: 'WITHDRAWAL',
        assetTicker: null,
        quantity: 0,
        price: 0,
        amount: 200,
        currency: 'EUR'
      }
    ];

    const result = validateImportActivities(activities, mockPortfolio, []);
    assert.strictEqual(result.summary.errorCount, 0);
    assert.strictEqual(result.summary.validCount, 2);
    assert.strictEqual(result.transactions[0].validationStatus, 'VALID');
    assert.strictEqual(result.transactions[1].validationStatus, 'VALID');
  });

  test('Timeline health check flags negative cash when buy exceeds available funds', () => {
    const mockPortfolio = { id: 99, currency: 'EUR', initialCash: 100 };
    const activities = [
      {
        date: '2024-02-01',
        type: 'BUY',
        assetTicker: 'CSSPX',
        quantity: 10,
        price: 450,
        amount: 4500,
        currency: 'EUR'
      }
    ];

    const result = validateImportActivities(activities, mockPortfolio, []);
    assert.strictEqual(result.transactions[0].validationStatus, 'WARNING');
    const warning = result.transactions[0].issues.find(i => i.code === 'NEGATIVE_CASH');
    assert.ok(warning, 'Expected NEGATIVE_CASH warning issue');
    assert.ok(result.summary.healthIssues.some(h => h.includes('saldo cassa negativo')));
  });

  test('Timeline health check flags insufficient holdings when sell exceeds held shares', () => {
    const mockPortfolio = { id: 99, currency: 'EUR', initialCash: 10000 };
    const activities = [
      {
        date: '2024-03-01',
        type: 'BUY',
        assetTicker: 'AAPL',
        quantity: 5,
        price: 150,
        amount: 750,
        currency: 'EUR'
      },
      {
        date: '2024-03-05',
        type: 'SELL',
        assetTicker: 'AAPL',
        quantity: 10, // sells 10 but only bought 5!
        price: 160,
        amount: 1600,
        currency: 'EUR'
      }
    ];

    const result = validateImportActivities(activities, mockPortfolio, []);
    assert.strictEqual(result.transactions[0].validationStatus, 'VALID');
    assert.strictEqual(result.transactions[1].validationStatus, 'WARNING');
    const oversell = result.transactions[1].issues.find(i => i.code === 'INSUFFICIENT_HOLDINGS');
    assert.ok(oversell, 'Expected INSUFFICIENT_HOLDINGS warning');
    assert.ok(result.summary.healthIssues.some(h => h.includes('superano la quantità di quote')));
  });

  test('Timeline health check flags future dates and excessive fees', () => {
    const mockPortfolio = { id: 99, currency: 'EUR', initialCash: 5000 };
    const futureYear = new Date().getFullYear() + 2;
    const activities = [
      {
        date: `${futureYear}-01-01`,
        type: 'BUY',
        assetTicker: 'VWCE',
        quantity: 1,
        price: 100,
        amount: 100,
        commission: 25, // 25% of 100 is > 15%!
        currency: 'EUR'
      }
    ];

    const result = validateImportActivities(activities, mockPortfolio, []);
    const tx = result.transactions[0];
    assert.strictEqual(tx.validationStatus, 'WARNING');
    assert.ok(tx.issues.some(i => i.code === 'FUTURE_DATE'));
    assert.ok(tx.issues.some(i => i.code === 'HIGH_COMMISSION'));
  });

  test('Flags errors on missing symbol for BUY and unknown activity type', () => {
    const mockPortfolio = { id: 99, currency: 'EUR', initialCash: 5000 };
    const activities = [
      {
        date: '2024-01-01',
        type: 'BUY',
        assetTicker: '', // missing ticker!
        quantity: 1,
        price: 100,
        amount: 100,
        currency: 'EUR'
      },
      {
        date: '2024-01-02',
        type: 'INVALID_TYPE_XYZ',
        assetTicker: 'AAPL',
        quantity: 1,
        price: 100,
        amount: 100,
        currency: 'EUR'
      }
    ];

    const result = validateImportActivities(activities, mockPortfolio, []);
    assert.strictEqual(result.summary.errorCount, 2);
    assert.strictEqual(result.transactions[0].validationStatus, 'ERROR');
    assert.ok(result.transactions[0].issues.some(i => i.code === 'MISSING_SYMBOL'));
    assert.strictEqual(result.transactions[1].validationStatus, 'ERROR');
    assert.ok(result.transactions[1].issues.some(i => i.code === 'UNKNOWN_TYPE'));
  });

  test('Composite duplicate check detects matching transactions', () => {
    const mockPortfolio = { id: 99, currency: 'EUR', initialCash: 5000 };
    const existing = [
      {
        id: 42,
        date: '2024-01-15',
        type: 'BUY',
        assetTicker: 'SWDA',
        quantity: 10,
        price: 80.5,
        amount: 805.0
      }
    ];
    const incoming = [
      {
        date: '2024-01-15',
        type: 'BUY',
        assetTicker: 'SWDA',
        quantity: 10,
        price: 80.5,
        amount: 805.0
      }
    ];

    const result = validateImportActivities(incoming, mockPortfolio, existing);
    assert.strictEqual(result.summary.duplicateCount, 1);
    assert.strictEqual(result.transactions[0].validationStatus, 'DUPLICATE');
    assert.strictEqual(result.transactions[0].duplicateId, 42);
    assert.strictEqual(result.transactions[0].canImport, false);
  });

  test('POST /api/transactions/import-csv preview returns Wealthfolio summary and diagnostics', async () => {
    const wealthfolioCsv = `date,symbol,activityType,quantity,unitPrice,currency,fee,tax,amount
2024-01-01,,DEPOSIT,0,0,EUR,0,0,5000
2024-01-05,VWCE,BUY,20,105.50,EUR,2.50,0,2112.50
2024-01-10,VWCE,SELL,50,110.00,EUR,2.50,0,5497.50`;

    const res = await fetch(`${baseUrl}/api/transactions/import-csv`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`
      },
      body: JSON.stringify({
        portfolioId,
        csvText: wealthfolioCsv,
        preview: true
      })
    });

    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.success, true);
    assert.strictEqual(data.preview, true);
    assert.ok(data.summary);
    assert.strictEqual(data.summary.totalRows, 3);
    assert.ok(data.transactions.length === 3);

    // The third row is overselling (selling 50 while only 20 bought), should have WARNING status
    const oversellTx = data.transactions[2];
    assert.strictEqual(oversellTx.validationStatus, 'WARNING');
    assert.ok(oversellTx.issues.some(i => i.code === 'INSUFFICIENT_HOLDINGS'));
  });

  test('POST /api/transactions/import-csv commit with selectedIndices selectively imports rows', async () => {
    const csvContent = `date,symbol,activityType,quantity,unitPrice,currency,fee,tax,amount
2024-01-02,,DEPOSIT,0,0,EUR,0,0,1000
2024-01-03,SELECTIVE_TEST,BUY,5,100.0,EUR,0,0,500
2024-01-04,UNWANTED_TEST,BUY,10,20.0,EUR,0,0,200`;

    // Only select index 0 (DEPOSIT) and index 1 (SELECTIVE_TEST), omitting index 2
    const res = await fetch(`${baseUrl}/api/transactions/import-csv`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`
      },
      body: JSON.stringify({
        portfolioId,
        csvText: csvContent,
        preview: false,
        selectedIndices: [0, 1]
      })
    });

    assert.strictEqual(res.status, 201);
    const data = await res.json();
    assert.strictEqual(data.success, true);
    assert.strictEqual(data.insertedCount, 2);

    // Verify database only contains DEPOSIT and SELECTIVE_TEST, NOT UNWANTED_TEST
    const rows = db.prepare('SELECT * FROM transactions WHERE portfolioId = ? ORDER BY date ASC').all(portfolioId);
    assert.strictEqual(rows.length, 2);
    assert.strictEqual(rows[0].type, 'DEPOSIT');
    assert.strictEqual(rows[1].assetTicker, 'SELECTIVE_TEST');
  });
});
