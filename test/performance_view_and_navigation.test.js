const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const http = require('http');
const vm = require('vm');

const TEST_DB = path.join(__dirname, 'test_perf_nav.db');
process.env.NODE_ENV = 'test';
process.env.DB_PATH = TEST_DB;
process.env.ADMIN_USERNAME = 'admin';
process.env.JWT_SECRET = 'test-secret-jwt-very-long-and-secure-perf-nav';
process.env.ADMIN_PASSWORD = 'adminPerfPassword123!';

const { initDb, closeDb } = require('../src/db');
const app = require('../src/app');

let server;
let baseUrl;
let authCookie;

describe('Performance Menu & Dedicated Multi-Period Views', () => {
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
      body: JSON.stringify({ username: 'admin', password: 'adminPerfPassword123!' })
    });
    const setCookie = loginRes.headers.get('set-cookie');
    authCookie = setCookie.split(';')[0];
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

  test('Sidebar partial includes first-level Performance navigation link', () => {
    const sidebarHtml = fs.readFileSync(path.join(__dirname, '../private_views/partials/sidebar_partial.html'), 'utf8');
    assert.ok(sidebarHtml.includes('href="/performance"'), 'Sidebar must contain link to /performance');
    assert.ok(sidebarHtml.includes('data-page="performance"'), 'Sidebar must specify data-page="performance"');
    assert.ok(sidebarHtml.includes('<span>Performance</span>'), 'Sidebar must label menu item as Performance');

    // Verify ordering: Dashboard -> Performance -> Portafogli
    const dashIdx = sidebarHtml.indexOf('data-page="dashboard"');
    const perfIdx = sidebarHtml.indexOf('data-page="performance"');
    const portIdx = sidebarHtml.indexOf('data-page="portfolios"');
    assert.ok(dashIdx >= 0 && perfIdx > dashIdx && portIdx > perfIdx, 'Performance must be placed right after Dashboard and before Portafogli');
  });

  test('Mobile nav partial includes Performance item and active state matching', () => {
    const mobileNavHtml = fs.readFileSync(path.join(__dirname, '../private_views/partials/mobile_nav_partial.html'), 'utf8');
    assert.ok(mobileNavHtml.includes('href="/performance"'), 'Mobile nav must contain href="/performance"');
    assert.ok(mobileNavHtml.includes('data-mobile-page="performance"'), 'Mobile nav must contain data-mobile-page="performance"');
    assert.ok(mobileNavHtml.includes('Performance</span>'), 'Mobile nav must display Performance');
    assert.ok(mobileNavHtml.includes("p.startsWith('/performance')"), 'Mobile nav script must match /performance route');
  });

  test('GET /performance requires authentication and redirects unauthenticated requests', async () => {
    const res = await fetch(`${baseUrl}/performance`, { redirect: 'manual' });
    assert.equal(res.status, 302);
    assert.ok(res.headers.get('location').includes('login.html'));
  });

  test('GET /performance serves desktop performance view with injected sidebar', async () => {
    const res = await fetch(`${baseUrl}/performance`, {
      headers: { Cookie: authCookie }
    });
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.ok(text.includes('Performance & Rendimenti | FolioTrack'), 'Desktop view must have title Performance & Rendimenti');
    assert.ok(text.includes('data-page="performance"'), 'Desktop view must have data-page="performance"');
    assert.ok(text.includes('>PERF</h1>'), 'Header tag must display PERF');
    assert.ok(text.includes('id="dashboardPortfolioSelect"'), 'Must have portfolio select dropdown');
    assert.ok(text.includes('id="btn-recalculate-perf"'), 'Must have recalculate metrics button');
    assert.ok(text.includes('8 / 8'), 'Visible widgets count badge should initialize to 8 / 8');
    assert.ok(text.includes('id="app-sidebar"'), 'Must contain injected sidebar partial');
    assert.ok(text.includes('href="/performance"'), 'Sidebar in response must include /performance');
  });

  test('GET /performance?view=mobile serves mobile performance view with injected bottom nav', async () => {
    const res = await fetch(`${baseUrl}/performance?view=mobile`, {
      headers: { Cookie: authCookie }
    });
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.ok(text.includes('FolioTrack Mobile - Performance'), 'Mobile view must have mobile title');
    assert.ok(text.includes('data-page="performance"'), 'Mobile view must have data-page="performance"');
    assert.ok(text.includes('>PERF</span>'), 'Mobile portfolio selector bar must show PERF');
    assert.ok(text.includes('id="mDashboardPortfolioSelect"'), 'Must have mobile portfolio select dropdown');
    assert.ok(text.includes('8 / 8'), 'Mobile drawer badge should initialize to 8 / 8');
    assert.ok(text.includes('id="mobile-bottom-nav"'), 'Must contain injected mobile nav partial');
    assert.ok(text.includes('data-mobile-page="performance"'), 'Mobile nav in response must have performance item');
  });

  test('GET / serves dashboard view with 18 widgets and DASH title', async () => {
    const res = await fetch(`${baseUrl}/`, {
      headers: { Cookie: authCookie }
    });
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.ok(text.includes('>DASH</h1>'), 'Dashboard header must show DASH');
    assert.ok(text.includes('18 / 18'), 'Dashboard drawer badge should show 18 / 18');
    assert.ok(text.includes('id="app-sidebar"'), 'Dashboard must contain injected sidebar');
  });

  test('public/dashboard.js partitions widgets between Performance and Dashboard cleanly', () => {
    const code = fs.readFileSync(path.join(__dirname, '../public/dashboard.js'), 'utf8');

    // Create a mock DOM context to evaluate dashboard.js logic
    const dom = {
      location: { pathname: '/performance' },
      document: {
        querySelector: (sel) => null,
        getElementById: (id) => null,
        querySelectorAll: () => [],
        addEventListener: () => {},
        body: { getAttribute: (attr) => attr === 'data-page' ? 'performance' : null }
      },
      localStorage: {
        getItem: () => null,
        setItem: () => {},
        removeItem: () => {}
      },
      window: {},
      console: { log: () => {}, warn: () => {}, error: () => {}, info: () => {} }
    };
    dom.window = dom;

    const script = new vm.Script(code);
    const context = vm.createContext(dom);
    script.runInContext(context);

    const api = dom.window.FolioTrackDashboard;
    assert.ok(api, 'FolioTrackDashboard must be exposed on window');

    // Verify widget groups
    const perfIds = Array.from(api.PERFORMANCE_WIDGET_IDS);
    assert.equal(perfIds.length, 8, 'Must have exactly 8 performance widgets');
    assert.ok(perfIds.includes('performanceChart'), 'performanceChart must be in Performance');
    assert.ok(perfIds.includes('twrr'), 'twrr must be in Performance');
    assert.ok(perfIds.includes('mwrr'), 'mwrr must be in Performance');
    assert.ok(perfIds.includes('drawdown'), 'drawdown must be in Performance');
    assert.ok(perfIds.includes('riskMetrics'), 'riskMetrics must be in Performance');
    assert.ok(perfIds.includes('performanceMatrix'), 'performanceMatrix must be in Performance');
    assert.ok(perfIds.includes('moversAllTime'), 'moversAllTime must be in Performance');
    assert.ok(perfIds.includes('categoryGains'), 'categoryGains must be in Performance');

    // Verify Performance desktop & mobile layout lengths
    assert.equal(api.PERFORMANCE_DESKTOP_LAYOUT.length, 8);
    assert.equal(api.PERFORMANCE_MOBILE_LAYOUT.length, 8);

    // Verify Dashboard desktop & mobile layout lengths (26 - 8 = 18)
    assert.equal(api.DASHBOARD_DESKTOP_LAYOUT.length, 18);
    assert.equal(api.DASHBOARD_MOBILE_LAYOUT.length, 18);
    assert.equal(api.WIDGET_DEFINITIONS.length, 26);

    // Verify none of the performance widgets are in Dashboard layouts
    for (const item of api.DASHBOARD_DESKTOP_LAYOUT) {
      assert.ok(!api.PERFORMANCE_WIDGET_IDS.has(item.id), `Dashboard layout must not contain performance widget: ${item.id}`);
    }
    for (const item of api.DASHBOARD_MOBILE_LAYOUT) {
      assert.ok(!api.PERFORMANCE_WIDGET_IDS.has(item.id), `Dashboard mobile layout must not contain performance widget: ${item.id}`);
    }

    // Verify day variation and complex today data widgets remain in Dashboard
    const dashIds = api.DASHBOARD_DESKTOP_LAYOUT.map(d => d.id);
    assert.ok(dashIds.includes('dayChange'), 'dayChange must remain in Dashboard');
    assert.ok(dashIds.includes('moversDay'), 'moversDay must remain in Dashboard');
    assert.ok(dashIds.includes('categoryQuotes'), 'categoryQuotes must remain in Dashboard');
    assert.ok(dashIds.includes('holdingsCompact'), 'holdingsCompact must remain in Dashboard');
    assert.ok(dashIds.includes('value'), 'value must remain in Dashboard');
    assert.ok(dashIds.includes('pnl'), 'pnl must remain in Dashboard');
    assert.ok(dashIds.includes('cash'), 'cash must remain in Dashboard');
    assert.ok(dashIds.includes('invested'), 'invested must remain in Dashboard');
    assert.ok(dashIds.includes('bookCost'), 'bookCost must remain in Dashboard');
    assert.ok(!dashIds.includes('categoryGains'), 'categoryGains must NOT be in Dashboard');

    // Verify isPerformancePage detection
    assert.equal(api.isPerformancePage(), true, 'isPerformancePage() should return true when pathname is /performance');
    const perfDefs = api.getActiveWidgetDefinitions();
    assert.equal(perfDefs.length, 8, 'getActiveWidgetDefinitions() on performance page must return 8 widgets');

    // Simulate switching to dashboard page
    dom.location.pathname = '/';
    dom.document.body.getAttribute = () => null;
    assert.equal(api.isPerformancePage(), false, 'isPerformancePage() should return false on /');
    const dashDefs = api.getActiveWidgetDefinitions();
    assert.equal(dashDefs.length, 18, 'getActiveWidgetDefinitions() on dashboard page must return 18 widgets');
  });
});

