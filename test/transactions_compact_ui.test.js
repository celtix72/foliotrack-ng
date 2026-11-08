const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const path = require('path');
const fs = require('fs');

process.env.NODE_ENV = 'test';
process.env.ADMIN_USERNAME = 'admin';
process.env.ADMIN_PASSWORD = 'admin123';

const { initDb, closeDb } = require('../src/db');
const app = require('../src/app');

describe('Transactions Compact UI Layout (Desktop vs Mobile)', () => {
  let server;
  let baseUrl;
  let authToken;
  const testDbPath = path.join(__dirname, 'test_tx_compact_ui.db');

  before(async () => {
    if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
    initDb(testDbPath);

    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, resolve));
    const port = server.address().port;
    baseUrl = `http://127.0.0.1:${port}`;

    const res = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin123' })
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    authToken = data.token;
  });

  after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    closeDb();
    if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
  });

  test('Desktop transactions view includes runningCash (Liquidità Cumulativa) and compact table rows', async () => {
    const res = await fetch(`${baseUrl}/transactions?view=desktop`, {
      headers: {
        Authorization: `Bearer ${authToken}`,
        Cookie: `foliotrack_token=${authToken}`
      }
    });
    assert.equal(res.status, 200);
    const html = await res.text();

    // Verify runningCash is included on desktop
    assert.ok(html.includes('Liquidità Cumulativa'), 'Desktop view must include Liquidità Cumulativa header');
    assert.ok(html.includes('runningCashColor'), 'Desktop view must include running cash color computation');
    assert.ok(html.includes('t.runningCash'), 'Desktop view must format and render t.runningCash');

    // Verify compact row styling (py-1 and px-2.5)
    assert.ok(html.includes('px-2.5 py-1 whitespace-nowrap'), 'Desktop view must use compact px-2.5 py-1 data rows');
    assert.ok(html.includes('px-2.5 py-1.5 whitespace-nowrap'), 'Desktop view must use compact px-2.5 py-1.5 table header');

    // Verify accessible responsive table container
    assert.ok(html.includes('role="region"'), 'Desktop table must have accessible role="region"');
    assert.ok(html.includes('tabindex="0"'), 'Desktop table must have tabindex="0" for keyboard scrolling');
  });

  test('Mobile transactions view omits runningCash and enforces MAX 2 lines per transaction', async () => {
    const res = await fetch(`${baseUrl}/transactions?view=mobile`, {
      headers: {
        Authorization: `Bearer ${authToken}`,
        Cookie: `foliotrack_token=${authToken}`
      }
    });
    assert.equal(res.status, 200);
    const html = await res.text();

    // Verify runningCash is completely excluded on mobile
    assert.ok(!html.includes('Saldo Cassa post-mov'), 'Mobile view must NOT display Saldo Cassa post-mov');
    assert.ok(!html.includes('runningCashColor'), 'Mobile view must NOT include running cash styling in card');

    // Verify MAX 2 lines per transaction
    assert.ok(html.includes('Line 1:'), 'Mobile view card must have Line 1');
    assert.ok(html.includes('Line 2:'), 'Mobile view card must have Line 2');
    assert.ok(!html.includes('Line 3:'), 'Mobile view card must NOT have Line 3');
    assert.ok(!html.includes('Line 4:'), 'Mobile view card must NOT have Line 4');

    // Verify compact padding styling
    assert.ok(html.includes('padding: 0.35rem 0.5rem'), 'Mobile view must use ultra-compact signature-card padding');
    assert.ok(html.includes('space-y-1'), 'Mobile transaction container must use tight space-y-1');

    // Verify quick action buttons exist on Line 2
    assert.ok(html.includes('data-m-edit='), 'Mobile view must have edit action');
    assert.ok(html.includes('data-m-del='), 'Mobile view must have delete action');
  });
});
