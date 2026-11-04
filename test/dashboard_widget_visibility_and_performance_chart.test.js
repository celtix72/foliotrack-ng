const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const http = require('http');

const TEST_DB = path.join(__dirname, 'test_widget_visibility_perf.db');
process.env.DB_PATH = TEST_DB;
process.env.JWT_SECRET = 'test-secret-jwt-very-long-and-secure-widget-perf';
process.env.ADMIN_PASSWORD = 'adminWidgetPerfPass123!';

const { initDb, closeDb, db } = require('../src/db');
const app = require('../src/app');

let server;
let baseUrl;
let authToken;
let authCookie;
let createdPortfolioId;

describe('Dashboard Widget Visibility & Historical Performance Chart Tests', () => {
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
      body: JSON.stringify({ username: 'admin', password: 'adminWidgetPerfPass123!' })
    });
    const loginData = await loginRes.json();
    authToken = loginData.token;
    authCookie = loginRes.headers.get('set-cookie').split(';')[0];

    // Create a portfolio with holdings and transactions for rich testing
    const pRes = await fetch(`${baseUrl}/api/portfolios`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`
      },
      body: JSON.stringify({
        name: 'Portafoglio Core Growth',
        currency: 'EUR',
        include_in_totals: 1
      })
    });
    const pData = await pRes.json();
    assert.equal(pData.success, true);
    createdPortfolioId = pData.portfolio.id;

    // Add cash deposit
    const depRes = await fetch(`${baseUrl}/api/transactions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`
      },
      body: JSON.stringify({
        portfolioId: createdPortfolioId,
        type: 'DEPOSIT',
        amount: 15000,
        date: new Date(Date.now() - 60 * 24 * 3600 * 1000).toISOString().split('T')[0]
      })
    });
    const depData = await depRes.json();
    assert.equal(depData.success, true);

    // Buy an asset
    const buyRes = await fetch(`${baseUrl}/api/transactions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`
      },
      body: JSON.stringify({
        portfolioId: createdPortfolioId,
        type: 'BUY',
        assetTicker: 'IWDA.AS',
        quantity: 100,
        price: 90,
        amount: 9000,
        date: new Date(Date.now() - 45 * 24 * 3600 * 1000).toISOString().split('T')[0]
      })
    });
    const buyData = await buyRes.json();
    assert.equal(buyData.success, true);
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

  test('public/dashboard.js serves the 15 widgets including performanceChart and visibility controls', async () => {
    const res = await fetch(`${baseUrl}/dashboard.js`);
    assert.equal(res.status, 200);
    const jsText = await res.text();

    // Check performanceChart widget definition
    assert.ok(jsText.includes("id: 'performanceChart'"), 'performanceChart must be in WIDGET_DEFINITIONS');
    assert.ok(jsText.includes('Andamento Patrimonio & Performance'), 'Must have descriptive Italian title');

    // Check performanceChart renderer and line chart helper
    assert.ok(jsText.includes('performanceChart:'), 'WIDGET_RENDERERS must include performanceChart');
    assert.ok(jsText.includes('renderPerformanceChart'), 'Must include renderPerformanceChart function');
    assert.ok(jsText.includes('chart-performance'), 'Must reference chart-performance canvas');

    // Check visibility toggle functions
    assert.ok(jsText.includes('setWidgetVisibility'), 'Must include setWidgetVisibility');
    assert.ok(jsText.includes('updateVisibilityDrawerUI'), 'Must include updateVisibilityDrawerUI');
    assert.ok(jsText.includes('showAllWidgets'), 'Must include showAllWidgets');
    assert.ok(jsText.includes('resetDefaultWidgets'), 'Must include resetDefaultWidgets');
    assert.ok(jsText.includes('foliotrack_hidden_widgets'), 'Must use foliotrack_hidden_widgets localStorage key');
  });

  test('Desktop and mobile dashboard HTML contain visibility buttons and drawer panel', async () => {
    // Desktop view
    const deskRes = await fetch(`${baseUrl}/dashboard`, {
      headers: { Cookie: authCookie }
    });
    assert.equal(deskRes.status, 200);
    const deskHtml = await deskRes.text();

    assert.ok(deskHtml.includes('id="widgetVisibilityBtn"'), 'Desktop must have widget visibility button');
    assert.ok(deskHtml.includes('id="visible-widgets-count"'), 'Desktop must display visible widgets counter');
    assert.ok(deskHtml.includes('id="customize-drawer"'), 'Desktop must contain customization/visibility drawer');
    assert.ok(deskHtml.includes('id="widget-visibility-list"'), 'Desktop drawer must contain widget-visibility-list');
    assert.ok(deskHtml.includes('id="widget-search-input"'), 'Desktop drawer must contain search filter input');

    // Mobile view
    const mobRes = await fetch(`${baseUrl}/dashboard?view=mobile`, {
      headers: { Cookie: authCookie, 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X)' }
    });
    assert.equal(mobRes.status, 200);
    const mobHtml = await mobRes.text();

    assert.ok(mobHtml.includes('id="mobileVisibilityBtn"'), 'Mobile must have visibility toggle button');
    assert.ok(mobHtml.includes('id="customize-drawer"'), 'Mobile must contain customize-drawer');
    assert.ok(mobHtml.includes('id="widget-search-input"'), 'Mobile drawer must contain search filter input');
  });

  test('GET /api/history/performance returns historical time series for specific portfolio and aggregate', async () => {
    // 1. Single portfolio
    const singleRes = await fetch(`${baseUrl}/api/history/performance?portfolioId=${createdPortfolioId}&range=1Y`, {
      headers: { Authorization: `Bearer ${authToken}` }
    });
    assert.equal(singleRes.status, 200);
    const singleData = await singleRes.json();

    assert.equal(singleData.success, true);
    assert.equal(singleData.range, '1Y');
    assert.ok(Array.isArray(singleData.series));
    assert.ok(singleData.series.length > 0, 'Series must contain data points');

    const firstPoint = singleData.series[0];
    assert.ok('date' in firstPoint, 'Point must have date');
    assert.ok('totalValue' in firstPoint, 'Point must have totalValue');
    assert.ok('returnPercent' in firstPoint, 'Point must have returnPercent');
    assert.ok('drawdownPercent' in firstPoint, 'Point must have drawdownPercent');
    assert.ok('cashValue' in firstPoint, 'Point must have cashValue');
    assert.ok('netDeposits' in firstPoint, 'Point must have netDeposits');

    // 2. Aggregate ('all')
    const aggRes = await fetch(`${baseUrl}/api/history/performance?portfolioId=all&range=6M`, {
      headers: { Authorization: `Bearer ${authToken}` }
    });
    assert.equal(aggRes.status, 200);
    const aggData = await aggRes.json();

    assert.equal(aggData.success, true);
    assert.equal(aggData.range, '6M');
    assert.ok(Array.isArray(aggData.series));
    assert.ok(aggData.series.length > 0);
  });

  test('GET /api/history/performance supports all required timeframes (1M, 3M, 6M, 1Y, 3Y, 5Y, ALL)', async () => {
    const timeframes = ['1M', '3M', '6M', '1Y', '3Y', '5Y', 'ALL'];
    for (const tf of timeframes) {
      const res = await fetch(`${baseUrl}/api/history/performance?portfolioId=${createdPortfolioId}&range=${tf}`, {
        headers: { Authorization: `Bearer ${authToken}` }
      });
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.success, true);
      assert.equal(data.range, tf);
      assert.ok(Array.isArray(data.series));
    }
  });

  test('Settings API allows persisting and retrieving hidden widgets state', async () => {
    const hiddenToSave = ['accounts', 'targets', 'concentration'];

    // Save hiddenWidgets setting
    const putRes = await fetch(`${baseUrl}/api/settings`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`
      },
      body: JSON.stringify({
        key: 'hiddenWidgets',
        value: JSON.stringify(hiddenToSave),
        isEncrypted: 0
      })
    });
    assert.equal(putRes.status, 200);

    // Retrieve setting
    const getRes = await fetch(`${baseUrl}/api/settings/hiddenWidgets`, {
      headers: { Authorization: `Bearer ${authToken}` }
    });
    assert.equal(getRes.status, 200);
    const getData = await getRes.json();
    assert.equal(getData.success, true);

    const parsed = typeof getData.value === 'string' ? JSON.parse(getData.value) : getData.value;
    assert.deepEqual(parsed, hiddenToSave);
  });

  test('GET /api/history/metrics returns quantitative indicators (TWR, XIRR, Drawdown, Sharpe, Volatility)', async () => {
    const res = await fetch(`${baseUrl}/api/history/metrics?portfolioId=${createdPortfolioId}`, {
      headers: { Authorization: `Bearer ${authToken}` }
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.success, true);
    assert.ok(data.metrics, 'Metrics object must be returned');

    const m = data.metrics;
    assert.equal(typeof m.twr, 'object');
    assert.ok(m.twr['1M'] !== undefined, 'TWR 1M must be defined');
    assert.ok(m.twr['1Y'] !== undefined, 'TWR 1Y must be defined');
    assert.ok(m.twr['ALL'] !== undefined, 'TWR ALL must be defined');
    assert.equal(typeof m.periodGain, 'object');
    assert.ok(m.periodGain['1Y'] !== undefined);
    assert.equal(typeof m.xirr, 'number');
    assert.equal(typeof m.maxDrawdown, 'number');
    assert.equal(typeof m.currentDrawdown, 'number');
    assert.equal(typeof m.annualizedVolatility, 'number');
    assert.equal(typeof m.sharpeRatio, 'number');
  });

  test('public/dashboard.js defines and renders modular performance widgets (twrr, mwrr, drawdown, riskMetrics, performanceMatrix)', async () => {
    const res = await fetch(`${baseUrl}/dashboard.js`);
    assert.equal(res.status, 200);
    const jsText = await res.text();

    const perfWidgets = ['twrr', 'mwrr', 'drawdown', 'riskMetrics', 'performanceMatrix'];
    for (const w of perfWidgets) {
      assert.ok(jsText.includes(`id: '${w}'`), `Widget ${w} must be defined in WIDGET_DEFINITIONS`);
      assert.ok(jsText.includes(`${w}:`), `Renderer for ${w} must be defined in WIDGET_RENDERERS`);
    }

    assert.ok(jsText.includes('fetchPerformanceMetrics'), 'dashboard.js must contain fetchPerformanceMetrics');
    assert.ok(jsText.includes('data-twrr-period'), 'dashboard.js must support data-twrr-period toggle');
  });

  test('public/dashboard.js and GET /api/portfolios support dayChange daily variation widget', async () => {
    // 1. Check dashboard.js definitions and renderers
    const jsRes = await fetch(`${baseUrl}/dashboard.js`);
    assert.equal(jsRes.status, 200);
    const jsText = await jsRes.text();

    assert.ok(jsText.includes("id: 'dayChange'"), 'dayChange must be in WIDGET_DEFINITIONS');
    assert.ok(jsText.includes('Variazione Giornaliera (Oggi)'), 'Must have descriptive Italian title');
    assert.ok(jsText.includes('dayChange:'), 'dayChange must be in WIDGET_RENDERERS');
    assert.ok(jsText.includes('formatEurSignedDec'), 'Must define formatEurSignedDec');

    // 2. Check GET /api/portfolios returns dayPnl and dayPnlPercent in totals and portfolios
    const portRes = await fetch(`${baseUrl}/api/portfolios`, {
      headers: { Authorization: `Bearer ${authToken}` }
    });
    assert.equal(portRes.status, 200);
    const portData = await portRes.json();

    assert.equal(portData.success, true);
    assert.ok(portData.totals !== undefined, 'totals must be present');
    assert.ok('dayPnl' in portData.totals, 'totals must include dayPnl');
    assert.ok('dayPnlPercent' in portData.totals, 'totals must include dayPnlPercent');
    assert.equal(typeof portData.totals.dayPnl, 'number');
    assert.equal(typeof portData.totals.dayPnlPercent, 'number');

    if (portData.portfolios && portData.portfolios.length > 0) {
      const p0 = portData.portfolios[0];
      assert.ok('dayPnl' in p0, 'portfolio must include dayPnl');
      assert.ok('dayPnlPercent' in p0, 'portfolio must include dayPnlPercent');
      assert.equal(typeof p0.dayPnl, 'number');
      assert.equal(typeof p0.dayPnlPercent, 'number');
    }
  });
});

