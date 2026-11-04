const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const path = require('path');
const fs = require('fs');

const TEST_DB = path.join(__dirname, 'test_reset_isolated.db');
process.env.DB_PATH = TEST_DB;
process.env.JWT_SECRET = 'test_jwt_secret_reset_12345';
process.env.NODE_ENV = 'test';

const { db, initDb, closeDb, resetFinancialDatabase } = require('../src/db');
const app = require('../src/app');
const bcrypt = require('bcryptjs');

describe('Database Financial Reset (Portfolios, Assets, Transactions Wipe)', () => {
  let server;
  let baseUrl;
  let adminToken;
  let userToken;

  before(async () => {
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    initDb(TEST_DB);

    // Start test server
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, resolve));
    const port = server.address().port;
    baseUrl = `http://127.0.0.1:${port}`;

    // Login as admin
    const adminLoginRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin123' })
    });
    const adminData = await adminLoginRes.json();
    adminToken = adminData.token;

    // Create a regular user to test access control
    const hash = bcrypt.hashSync('user123', 8);
    db.prepare('DELETE FROM users WHERE username = ?').run('test_regular_user');
    db.prepare(`
      INSERT INTO users (username, email, password_hash, role)
      VALUES (?, ?, ?, 'user')
    `).run('test_regular_user', 'regular@foliotrack.test', hash);

    const userLoginRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'test_regular_user', password: 'user123' })
    });
    const userData = await userLoginRes.json();
    userToken = userData.token;
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

  test('POST /api/settings/reset-financial-data requires admin authentication', async () => {
    // 1. Without token -> 401
    const unauthRes = await fetch(`${baseUrl}/api/settings/reset-financial-data`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirmation: 'RESET' })
    });
    assert.strictEqual(unauthRes.status, 401);

    // 2. With regular user token -> 403
    const regularRes = await fetch(`${baseUrl}/api/settings/reset-financial-data`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${userToken}`
      },
      body: JSON.stringify({ confirmation: 'RESET' })
    });
    assert.strictEqual(regularRes.status, 403);
    const regularData = await regularRes.json();
    assert.ok(regularData.error.includes('solo gli amministratori'));
  });

  test('POST /api/settings/reset-financial-data requires confirmation === "RESET"', async () => {
    const res = await fetch(`${baseUrl}/api/settings/reset-financial-data`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`
      },
      body: JSON.stringify({ confirmation: 'wrong_value' })
    });
    assert.strictEqual(res.status, 400);
    const data = await res.json();
    assert.ok(data.error.includes('Conferma esplicita'));
  });

  test('resetFinancialDatabase() completely wipes portfolios, assets and transactions', async () => {
    // 1. Seed some sample assets, portfolios, and transactions
    const assetStmt = db.prepare(`
      INSERT OR REPLACE INTO assets (ticker, name, currency, currentPrice)
      VALUES (?, ?, 'EUR', ?)
    `);
    assetStmt.run('RESET_TEST_1', 'Asset Reset Test 1', 100.0);
    assetStmt.run('RESET_TEST_2', 'Asset Reset Test 2', 50.0);

    const portStmt = db.prepare(`
      INSERT INTO portfolios (name, type, currency, initialCash)
      VALUES (?, 'Investimento', 'EUR', 1000.0)
    `);
    const pInfo = portStmt.run('Reset Portfolio Test');
    const pId = pInfo.lastInsertRowid;

    db.prepare(`
      INSERT INTO transactions (portfolioId, type, assetTicker, date, quantity, price, amount)
      VALUES (?, 'BUY', 'RESET_TEST_1', '2024-01-10', 10, 100, 1000)
    `).run(pId);

    db.prepare(`
      INSERT OR REPLACE INTO asset_quotes (ticker, date, close, source)
      VALUES ('RESET_TEST_1', '2024-01-10', 100.0, 'TEST')
    `).run();

    // Verify sample data exists
    assert.ok(db.prepare('SELECT COUNT(*) as c FROM portfolios').get().c > 0);
    assert.ok(db.prepare('SELECT COUNT(*) as c FROM assets').get().c > 0);
    assert.ok(db.prepare('SELECT COUNT(*) as c FROM transactions').get().c > 0);
    assert.ok(db.prepare('SELECT COUNT(*) as c FROM asset_quotes').get().c > 0);

    // 2. Perform reset
    const res = await fetch(`${baseUrl}/api/settings/reset-financial-data`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`
      },
      body: JSON.stringify({ confirmation: 'RESET', createBackup: false })
    });

    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.success, true);
    assert.ok(data.deleted);

    // 3. Verify all financial tables are now completely empty
    const countPortfolios = db.prepare('SELECT COUNT(*) as c FROM portfolios').get().c;
    const countAssets = db.prepare('SELECT COUNT(*) as c FROM assets').get().c;
    const countTransactions = db.prepare('SELECT COUNT(*) as c FROM transactions').get().c;
    const countQuotes = db.prepare('SELECT COUNT(*) as c FROM asset_quotes').get().c;
    const countHistory = db.prepare('SELECT COUNT(*) as c FROM portfolio_history').get().c;
    const countDividends = db.prepare('SELECT COUNT(*) as c FROM dividend_projections').get().c;
    const countLosses = db.prepare('SELECT COUNT(*) as c FROM portfolio_losses').get().c;

    assert.strictEqual(countPortfolios, 0, 'Portfolios table must be empty');
    assert.strictEqual(countAssets, 0, 'Assets table must be empty');
    assert.strictEqual(countTransactions, 0, 'Transactions table must be empty');
    assert.strictEqual(countQuotes, 0, 'Asset quotes table must be empty');
    assert.strictEqual(countHistory, 0, 'Portfolio history table must be empty');
    assert.strictEqual(countDividends, 0, 'Dividend projections table must be empty');
    assert.strictEqual(countLosses, 0, 'Portfolio losses table must be empty');

    // 4. Verify users and currency rates are still intact
    const countUsers = db.prepare('SELECT COUNT(*) as c FROM users').get().c;
    const countCurrencies = db.prepare('SELECT COUNT(*) as c FROM currency_rates').get().c;
    assert.ok(countUsers >= 2, 'Users table must be preserved');
    assert.ok(countCurrencies > 0, 'Currency rates table must be preserved');

    // 5. Verify creating a new portfolio starts fresh with ID 1
    const newPort = db.prepare(`
      INSERT INTO portfolios (name, type, currency, initialCash)
      VALUES ('Fresh New Portfolio', 'Investimento', 'EUR', 5000.0)
    `).run();
    assert.strictEqual(newPort.lastInsertRowid, 1, 'Auto-increment should reset to 1');
  });

  test('POST /api/backups/reset-database alias functions identically and creates backup', async () => {
    const res = await fetch(`${baseUrl}/api/backups/reset-database`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`
      },
      body: JSON.stringify({ confirmation: 'RESET', createBackup: true })
    });

    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.success, true);
    assert.ok(data.backup);
    assert.ok(data.backup.filename.includes('pre_reset'));
  });
});
