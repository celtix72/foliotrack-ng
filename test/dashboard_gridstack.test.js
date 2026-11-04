const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const http = require('http');

const TEST_DB = path.join(__dirname, 'test_phase5.db');
process.env.DB_PATH = TEST_DB;
process.env.JWT_SECRET = 'test-secret-jwt-very-long-and-secure-phase5';
process.env.ADMIN_PASSWORD = 'adminPhase5Password!';

const { initDb, closeDb } = require('../src/db');
const app = require('../src/app');

let server;
let baseUrl;
let authToken;
let authCookie;

describe('Phase 5: 12-Column GridStack Dashboard, 14 Widgets & Transaction Modal', () => {
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

    const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'adminPhase5Password!' })
    });
    const loginData = await loginRes.json();
    authToken = loginData.token;
    authCookie = loginRes.headers.get('set-cookie').split(';')[0];
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    closeDb();
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    const walFile = `${TEST_DB}-wal`;
    const shmFile = `${TEST_DB}-shm`;
    if (fs.existsSync(walFile)) fs.unlinkSync(walFile);
    if (fs.existsSync(shmFile)) fs.unlinkSync(shmFile);
  });

  test('All vendor libraries (GridStack.js and Chart.js) are accessible statically', async () => {
    const gsJs = await fetch(`${baseUrl}/vendor/gridstack/gridstack-all.js`);
    assert.equal(gsJs.status, 200);

    const gsCss = await fetch(`${baseUrl}/vendor/gridstack/gridstack.min.css`);
    assert.equal(gsCss.status, 200);

    const chartJs = await fetch(`${baseUrl}/vendor/chartjs/chart.umd.min.js`);
    assert.equal(chartJs.status, 200);
  });

  test('Dashboard and Transaction Modal frontend scripts are served', async () => {
    const dashJs = await fetch(`${baseUrl}/dashboard.js`);
    assert.equal(dashJs.status, 200);
    const dashText = await dashJs.text();

    // Verify all official widgets are declared in dashboard.js
    const officialWidgets = [
      'value', 'cash', 'invested', 'bookCost', 'pnl',
      'accounts', 'classes', 'regions', 'sectors', 'composition',
      'targets', 'breakdown', 'moversDay', 'moversAllTime', 'concentration'
    ];

    for (const wId of officialWidgets) {
      assert.ok(dashText.includes(`id: '${wId}'`), `Widget ${wId} must be declared in dashboard.js`);
    }

    const modalJs = await fetch(`${baseUrl}/transaction_modal.js`);
    assert.equal(modalJs.status, 200);
    const modalText = await modalJs.text();
    assert.ok(modalText.includes('TransactionModal'));
  });

  test('Desktop dashboard view integrates GridStack container, drawer and 14 widgets', async () => {
    const res = await fetch(`${baseUrl}/dashboard`, {
      headers: { Cookie: authCookie }
    });
    assert.equal(res.status, 200);
    const html = await res.text();

    assert.ok(html.includes('class="grid-stack"'), 'GridStack container must be present');
    assert.ok(html.includes('id="customize-banner"'), 'Customization banner must be present');
    assert.ok(html.includes('id="customize-drawer"'), 'Customization drawer must be present');
    assert.ok(html.includes('gridstack-all.js'), 'Must load gridstack-all.js');
    assert.ok(html.includes('chart.umd.min.js'), 'Must load chart.umd.min.js');
    assert.ok(html.includes('transaction_modal.js'), 'Must load transaction_modal.js');
  });

  test('Mobile dashboard view integrates responsive GridStack and floating action button', async () => {
    const res = await fetch(`${baseUrl}/dashboard?view=mobile`, {
      headers: { Cookie: authCookie }
    });
    assert.equal(res.status, 200);
    const html = await res.text();

    assert.ok(html.includes('grid-stack'), 'Mobile grid-stack container must be present');
    assert.ok(html.includes('mobileAddTxBtn'), 'Floating action button must be present on mobile');
  });

  test('Dashboard Layout can be saved to PUT /api/settings and restored from GET /api/settings', async () => {
    const testLayout = [
      { id: 'value', x: 0, y: 0, w: 4, h: 2 },
      { id: 'cash', x: 4, y: 0, w: 2, h: 2 },
      { id: 'invested', x: 6, y: 0, w: 2, h: 2 },
      { id: 'targets', x: 8, y: 0, w: 4, h: 6 }
    ];

    // Save layout
    const putRes = await fetch(`${baseUrl}/api/settings`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`
      },
      body: JSON.stringify({
        key: 'insightsOverviewLayout',
        value: JSON.stringify(testLayout),
        encrypted: false
      })
    });
    assert.equal(putRes.status, 200);

    // Retrieve layout
    const getRes = await fetch(`${baseUrl}/api/settings/insightsOverviewLayout`, {
      headers: { Authorization: `Bearer ${authToken}` }
    });
    assert.equal(getRes.status, 200);
    const getData = await getRes.json();
    assert.equal(getData.success, true);

    const parsed = JSON.parse(getData.value);
    assert.equal(parsed.length, 4);
    assert.equal(parsed[0].id, 'value');
    assert.equal(parsed[3].id, 'targets');
  });

  test('Transaction Modal API integration: submits new transaction and recalculates NAV', async () => {
    // 1. Create test portfolio
    const pRes = await fetch(`${baseUrl}/api/portfolios`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`
      },
      body: JSON.stringify({
        name: 'Portfolio Modal Test',
        initialCash: 5000.0
      })
    });
    const pData = await pRes.json();
    const portfolioId = pData.portfolio.id;

    // 2. Submit BUY transaction via POST /api/transactions
    const txRes = await fetch(`${baseUrl}/api/transactions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`
      },
      body: JSON.stringify({
        portfolioId,
        type: 'BUY',
        assetTicker: 'AAPL',
        date: '2023-05-10',
        quantity: 5,
        price: 150.0,
        commission: 2.0
      })
    });

    assert.equal(txRes.status, 201);
    const txData = await txRes.json();
    assert.equal(txData.success, true);
    // Cost: 5 * 150 + 2 = 752. Cash: 5000 - 752 = 4248
    assert.equal(txData.portfolio.currentCash, 4248.0);
    assert.equal(txData.portfolio.assetCount, 1);
  });
});

