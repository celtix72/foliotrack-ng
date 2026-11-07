const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { initDb, closeDb, getDb } = require('../src/db');
const app = require('../src/app');

describe('Dashboard Mobile Responsive Layout (Max 2 Columns) & Desktop Independence', () => {
  let server;
  let baseUrl;
  let authToken;
  const testDbPath = path.join(__dirname, 'test_dashboard_mobile.db');

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

  test('GET /?view=desktop serves desktop HTML with 12-column GridStack and untouched markup', async () => {
    const res = await fetch(`${baseUrl}/?view=desktop`, {
      headers: {
        Authorization: `Bearer ${authToken}`,
        Cookie: `foliotrack_token=${authToken}`
      }
    });
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.ok(html.includes('class="grid-stack"'), 'Desktop must have grid-stack container');
    assert.ok(!html.includes('grid-stack-2'), 'Desktop must NOT have grid-stack-2 class');
    assert.ok(html.includes('dashboardPortfolioSelect'), 'Desktop must have standard portfolio dropdown');
  });

  test('GET /?view=mobile serves mobile HTML with dedicated 2-column GridStack layout and CSS styles', async () => {
    const res = await fetch(`${baseUrl}/?view=mobile`, {
      headers: {
        Authorization: `Bearer ${authToken}`,
        Cookie: `foliotrack_token=${authToken}`
      }
    });
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.ok(html.includes('grid-stack-2'), 'Mobile view must have grid-stack-2 container');
    assert.ok(html.includes('mDashboardPortfolioSelect'), 'Mobile view must have mobile portfolio dropdown');
    assert.ok(html.includes('.grid-stack-2 > .grid-stack-item'), 'Mobile view must define 2-column GridStack styles');
    assert.ok(html.includes('[gs-w="1"]'), 'Mobile view CSS must define w=1 rule (50% width)');
    assert.ok(html.includes('[gs-w="2"]'), 'Mobile view CSS must define w=2 rule (100% width)');
  });

  test('public/dashboard.js defines MOBILE_DEFAULT_LAYOUT with max 2 columns and paired KPI cards', () => {
    const jsContent = fs.readFileSync(path.join(__dirname, '../public/dashboard.js'), 'utf8');

    assert.ok(jsContent.includes('const MOBILE_DEFAULT_LAYOUT ='), 'MOBILE_DEFAULT_LAYOUT must be defined');
    assert.ok(jsContent.includes('function isMobileDashboard()'), 'isMobileDashboard helper must be defined');
    assert.ok(jsContent.includes('getLayoutSettingKey'), 'getLayoutSettingKey helper must be defined');
    assert.ok(jsContent.includes('getLayoutStorageKey'), 'getLayoutStorageKey helper must be defined');

    // Extract MOBILE_DEFAULT_LAYOUT array via eval in safe sandbox
    const match = jsContent.match(/const MOBILE_DEFAULT_LAYOUT = (\[[\s\S]*?\]);/);
    assert.ok(match, 'MOBILE_DEFAULT_LAYOUT must match array regex');
    const mobileLayout = eval(match[1]);

    assert.equal(mobileLayout.length, 25, 'MOBILE_DEFAULT_LAYOUT must contain all 25 widgets');

    for (const item of mobileLayout) {
      assert.ok(item.w === 1 || item.w === 2, `Widget ${item.id} width must be either 1 or 2 (found ${item.w})`);
      assert.ok(item.x === 0 || item.x === 1, `Widget ${item.id} x position must be either 0 or 1 (found ${item.x})`);
      if (item.w === 2) {
        assert.equal(item.x, 0, `Full-width widget ${item.id} (w=2) must start at x=0`);
      }
    }

    // Verify categoryQuotes widget is 2 columns (full width)
    const categoryQuotes = mobileLayout.find(i => i.id === 'categoryQuotes');
    assert.ok(categoryQuotes, 'categoryQuotes must be present in MOBILE_DEFAULT_LAYOUT');
    assert.equal(categoryQuotes.w, 2, 'categoryQuotes must be 2 columns (full width)');

    // Verify paired KPI cards are 1 column each
    const dayChange = mobileLayout.find(i => i.id === 'dayChange');
    const pnl = mobileLayout.find(i => i.id === 'pnl');
    assert.equal(dayChange.w, 1, 'dayChange must be 1 column (50% width)');
    assert.equal(pnl.w, 1, 'pnl must be 1 column (50% width)');
    assert.equal(dayChange.y, pnl.y, 'dayChange and pnl must be on same row');

    const cash = mobileLayout.find(i => i.id === 'cash');
    const invested = mobileLayout.find(i => i.id === 'invested');
    assert.equal(cash.w, 1, 'cash must be 1 column');
    assert.equal(invested.w, 1, 'invested must be 1 column');
    assert.equal(cash.y, invested.y, 'cash and invested must be on same row');

    const twrr = mobileLayout.find(i => i.id === 'twrr');
    const mwrr = mobileLayout.find(i => i.id === 'mwrr');
    assert.equal(twrr.w, 1, 'twrr must be 1 column');
    assert.equal(mwrr.w, 1, 'mwrr must be 1 column');
    assert.equal(twrr.y, mwrr.y, 'twrr and mwrr must be on same row');

    // Verify complex widgets are 2 columns (full width)
    const perfChart = mobileLayout.find(i => i.id === 'performanceChart');
    assert.equal(perfChart.w, 2, 'performanceChart must be 2 columns (full width)');
    const composition = mobileLayout.find(i => i.id === 'composition');
    assert.equal(composition.w, 2, 'composition must be 2 columns (full width)');
  });

  test('Desktop (insightsOverviewLayout) and Mobile (insightsOverviewLayoutMobile) persist independently in DB', async () => {
    const desktopLayout = [
      { id: 'value', x: 0, y: 0, w: 4, h: 2 },
      { id: 'dayChange', x: 4, y: 0, w: 4, h: 2 },
      { id: 'performanceChart', x: 0, y: 2, w: 12, h: 5 }
    ];

    const mobileLayout = [
      { id: 'value', x: 0, y: 0, w: 2, h: 2 },
      { id: 'dayChange', x: 0, y: 2, w: 1, h: 2 },
      { id: 'pnl', x: 1, y: 2, w: 1, h: 2 }
    ];

    // Save desktop layout
    const deskPut = await fetch(`${baseUrl}/api/settings`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`
      },
      body: JSON.stringify({
        key: 'insightsOverviewLayout',
        value: JSON.stringify(desktopLayout),
        encrypted: false
      })
    });
    assert.equal(deskPut.status, 200);

    // Save mobile layout
    const mobPut = await fetch(`${baseUrl}/api/settings`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`
      },
      body: JSON.stringify({
        key: 'insightsOverviewLayoutMobile',
        value: JSON.stringify(mobileLayout),
        encrypted: false
      })
    });
    assert.equal(mobPut.status, 200);

    // Fetch desktop layout
    const deskGet = await fetch(`${baseUrl}/api/settings/insightsOverviewLayout`, {
      headers: { Authorization: `Bearer ${authToken}` }
    });
    const deskData = await deskGet.json();
    const retrievedDesk = JSON.parse(deskData.value);
    assert.equal(retrievedDesk[2].w, 12, 'Desktop performanceChart must remain 12 columns wide');

    // Fetch mobile layout
    const mobGet = await fetch(`${baseUrl}/api/settings/insightsOverviewLayoutMobile`, {
      headers: { Authorization: `Bearer ${authToken}` }
    });
    const mobData = await mobGet.json();
    const retrievedMob = JSON.parse(mobData.value);
    assert.equal(retrievedMob[0].w, 2, 'Mobile value must be 2 columns wide');
    assert.equal(retrievedMob[1].w, 1, 'Mobile dayChange must be 1 column wide');
  });

  test('dashboard_mobile.html contains mobile customize button, customize banner and quick move buttons', () => {
    const html = fs.readFileSync(path.join(__dirname, '../private_views/dashboard_mobile.html'), 'utf8');
    assert.ok(html.includes('id="mobileCustomizeBtn"'), 'Must have mobileCustomizeBtn in header');
    assert.ok(html.includes('id="customize-banner"'), 'Must have customize-banner');
    assert.ok(html.includes('id="drawerStartCustomizeBtn"'), 'Must have drawerStartCustomizeBtn in drawer');
  });

  test('public/dashboard.js implements repackMobileCoordinates, moveWidgetUp and moveWidgetDown', () => {
    const jsContent = fs.readFileSync(path.join(__dirname, '../public/dashboard.js'), 'utf8');
    assert.ok(jsContent.includes('function repackMobileCoordinates'), 'Must define repackMobileCoordinates');
    assert.ok(jsContent.includes('async function moveWidgetUp'), 'Must define moveWidgetUp');
    assert.ok(jsContent.includes('async function moveWidgetDown'), 'Must define moveWidgetDown');
    assert.ok(jsContent.includes('data-move-widget-up'), 'Must use data-move-widget-up attributes');
    assert.ok(jsContent.includes('data-move-widget-down'), 'Must use data-move-widget-down attributes');

    // Extract repackMobileCoordinates to test packing logic
    const fnMatch = jsContent.match(/function repackMobileCoordinates\(orderedItems\) \{([\s\S]*?)\n  \}/);
    assert.ok(fnMatch, 'repackMobileCoordinates function body matched');
    const repackFn = new Function('orderedItems', fnMatch[1]);

    const sample = [
      { id: 'w1', w: 1, h: 2 },
      { id: 'w2', w: 1, h: 2 },
      { id: 'hero', w: 2, h: 5 },
      { id: 'w3', w: 1, h: 2 }
    ];

    const repacked = repackFn(sample);
    // w1 at (0, 0)
    assert.equal(repacked[0].x, 0);
    assert.equal(repacked[0].y, 0);
    // w2 at (1, 0)
    assert.equal(repacked[1].x, 1);
    assert.equal(repacked[1].y, 0);
    // hero at (0, 2)
    assert.equal(repacked[2].x, 0);
    assert.equal(repacked[2].y, 2);
    // w3 at (0, 7)
    assert.equal(repacked[3].x, 0);
    assert.equal(repacked[3].y, 7);
  });

  test('All other mobile views use compact screen margins (px-1.5 py-2) and compact card padding', () => {
    const mobileViews = [
      'portfolios_mobile.html',
      'portfolio_detail_mobile.html',
      'transactions_mobile.html',
      'history_mobile.html',
      'reports_mobile.html',
      'settings_mobile.html'
    ];

    for (const view of mobileViews) {
      const content = fs.readFileSync(path.join(__dirname, '../private_views', view), 'utf8');
      assert.ok(content.includes('px-1.5'), `${view} must use compact horizontal gutter (px-1.5)`);
      assert.ok(content.includes('signature-card'), `${view} must include signature-card styling`);
    }
  });
});
