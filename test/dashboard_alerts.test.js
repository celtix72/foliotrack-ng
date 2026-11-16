const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const http = require('http');

const TEST_DB = path.join(__dirname, 'test_dashboard_alerts.db');
process.env.DB_PATH = TEST_DB;
process.env.JWT_SECRET = 'test-secret-dashboard-alerts-very-secure';
process.env.ADMIN_USERNAME = 'admin';
process.env.ADMIN_PASSWORD = 'adminAlertsPass123!';

const { initDb, closeDb, getDb } = require('../src/db');
const app = require('../src/app');

let server;
let baseUrl;
let authToken;

describe('Dashboard Earnings & Dividend Alerts with Acquisition System', () => {
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
      body: JSON.stringify({ username: 'admin', password: 'adminAlertsPass123!' })
    });
    const loginData = await loginRes.json();
    authToken = loginData.token;
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

  test('GET /api/alerts requires authentication', async () => {
    const res = await fetch(`${baseUrl}/api/alerts`);
    assert.equal(res.status, 401);
  });

  test('POST /api/alerts/test creates test EARNINGS and DIVIDEND alerts', async () => {
    // 1. Create EARNINGS test alert
    const earnRes = await fetch(`${baseUrl}/api/alerts/test`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`
      },
      body: JSON.stringify({
        ticker: 'NVDA',
        type: 'EARNINGS',
        title: 'Trimestrale Rilasciata: NVDA',
        message: 'NVIDIA ha superato le stime con un EPS di 0.81 (+15% sorpresa).'
      })
    });
    assert.equal(earnRes.status, 200);
    const earnData = await earnRes.json();
    assert.equal(earnData.success, true);
    assert.ok(earnData.alert);
    assert.equal(earnData.alert.ticker, 'NVDA');
    assert.equal(earnData.alert.type, 'EARNINGS');

    // 2. Create DIVIDEND test alert
    const divRes = await fetch(`${baseUrl}/api/alerts/test`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`
      },
      body: JSON.stringify({
        ticker: 'ISP.MI',
        type: 'DIVIDEND',
        title: 'Stacco Dividendo Oggi: ISP.MI',
        message: 'Oggi è previsto lo stacco dell acconto cedola per Intesa Sanpaolo (€0.17 per azione).'
      })
    });
    assert.equal(divRes.status, 200);
    const divData = await divRes.json();
    assert.equal(divData.success, true);
    assert.equal(divData.alert.ticker, 'ISP.MI');
    assert.equal(divData.alert.type, 'DIVIDEND');
  });

  test('GET /api/alerts returns active unacknowledged alerts', async () => {
    const res = await fetch(`${baseUrl}/api/alerts`, {
      headers: { Authorization: `Bearer ${authToken}` }
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.success, true);
    assert.ok(data.count >= 2);
    assert.ok(data.alerts.some(a => a.ticker === 'NVDA' && a.type === 'EARNINGS'));
    assert.ok(data.alerts.some(a => a.ticker === 'ISP.MI' && a.type === 'DIVIDEND'));
  });

  test('POST /api/alerts/:id/acknowledge marks alert as acknowledged and removes from active list', async () => {
    const listRes = await fetch(`${baseUrl}/api/alerts`, {
      headers: { Authorization: `Bearer ${authToken}` }
    });
    const listData = await listRes.json();
    const nvdaAlert = listData.alerts.find(a => a.ticker === 'NVDA');
    assert.ok(nvdaAlert, 'NVDA alert must be present');

    // Acknowledge single alert
    const ackRes = await fetch(`${baseUrl}/api/alerts/${nvdaAlert.id}/acknowledge`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${authToken}` }
    });
    assert.equal(ackRes.status, 200);
    const ackData = await ackRes.json();
    assert.equal(ackData.success, true);
    assert.equal(ackData.id, nvdaAlert.id);

    // Verify it is no longer returned
    const listAfterRes = await fetch(`${baseUrl}/api/alerts`, {
      headers: { Authorization: `Bearer ${authToken}` }
    });
    const listAfterData = await listAfterRes.json();
    assert.ok(!listAfterData.alerts.some(a => a.id === nvdaAlert.id), 'NVDA alert must no longer appear');
    assert.ok(listAfterData.alerts.some(a => a.ticker === 'ISP.MI'), 'ISP.MI alert should still remain');
  });

  test('POST /api/alerts/acknowledge-all marks all pending alerts as acknowledged', async () => {
    const ackAllRes = await fetch(`${baseUrl}/api/alerts/acknowledge-all`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${authToken}` }
    });
    assert.equal(ackAllRes.status, 200);
    const ackAllData = await ackAllRes.json();
    assert.equal(ackAllData.success, true);
    assert.ok(ackAllData.acknowledgedCount >= 1);

    // Verify list is now empty
    const listRes = await fetch(`${baseUrl}/api/alerts`, {
      headers: { Authorization: `Bearer ${authToken}` }
    });
    const listData = await listRes.json();
    assert.equal(listData.count, 0);
    assert.equal(listData.alerts.length, 0);
  });

  test('Automatic detection of earnings release from fundamentals cache for portfolio holdings', async () => {
    const db = getDb();
    const todayStr = new Date().toISOString().split('T')[0];

    // Create a portfolio and holding for AAPL
    const pfStmt = db.prepare("INSERT INTO portfolios (name, currency) VALUES ('Trading Test', 'EUR')");
    const pfRes = pfStmt.run();
    const pfId = pfRes.lastInsertRowid;

    db.prepare(`
      INSERT INTO transactions (portfolioId, type, assetTicker, quantity, price, date)
      VALUES (?, 'BUY', 'AAPL', 10, 150.0, '2026-01-10')
    `).run(pfId);

    // Insert fundamentals cache with reportedDate today
    const fundamentalsData = {
      ticker: 'AAPL',
      companyName: 'Apple Inc.',
      latestQuarter: {
        quarter: '4Q2026',
        reportedDate: todayStr,
        epsActual: 1.64,
        epsEstimate: 1.60,
        surprisePercent: 2.5,
        revenue: 94930000000
      }
    };

    db.prepare(`
      INSERT INTO analysis_fundamentals_cache (ticker, data, updatedAt)
      VALUES ('AAPL', ?, datetime('now'))
      ON CONFLICT(ticker) DO UPDATE SET data = excluded.data, updatedAt = datetime('now')
    `).run(JSON.stringify(fundamentalsData));

    // Call GET /api/alerts
    const res = await fetch(`${baseUrl}/api/alerts`, {
      headers: { Authorization: `Bearer ${authToken}` }
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.success, true);
    const aaplAlert = data.alerts.find(a => a.ticker === 'AAPL' && a.type === 'EARNINGS');
    assert.ok(aaplAlert, 'AAPL earnings alert must be detected and generated');
    assert.equal(aaplAlert.event_date, todayStr);
    assert.ok(aaplAlert.title.includes('AAPL'));
    assert.ok(aaplAlert.message.includes('Apple Inc.'));
  });

  test('Automatic detection of ex-dividend date from fundamentals cache', async () => {
    const db = getDb();
    const todayStr = new Date().toISOString().split('T')[0];

    // Create a holding for KO (Coca-Cola)
    const pfRow = db.prepare('SELECT id FROM portfolios LIMIT 1').get();
    db.prepare(`
      INSERT INTO transactions (portfolioId, type, assetTicker, quantity, price, date)
      VALUES (?, 'BUY', 'KO', 50, 60.0, '2026-01-10')
    `).run(pfRow.id);

    // Insert fundamentals cache with exDividendDate today
    const koFundamentals = {
      ticker: 'KO',
      companyName: 'The Coca-Cola Company',
      exDividendDate: todayStr,
      dividendRate: 1.94,
      dividendYield: 3.1
    };

    db.prepare(`
      INSERT INTO analysis_fundamentals_cache (ticker, data, updatedAt)
      VALUES ('KO', ?, datetime('now'))
      ON CONFLICT(ticker) DO UPDATE SET data = excluded.data, updatedAt = datetime('now')
    `).run(JSON.stringify(koFundamentals));

    // Call GET /api/alerts
    const res = await fetch(`${baseUrl}/api/alerts`, {
      headers: { Authorization: `Bearer ${authToken}` }
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.success, true);
    const koAlert = data.alerts.find(a => a.ticker === 'KO' && a.type === 'DIVIDEND');
    assert.ok(koAlert, 'KO ex-dividend alert must be detected and generated');
    assert.equal(koAlert.event_date, todayStr);
    assert.ok(koAlert.title.includes('KO'));
    assert.ok(koAlert.message.includes('The Coca-Cola Company'));
  });

  test('Alerts are integrated as a specific auto-collapsing dashboard widget in public/dashboard.js', () => {
    const desktopHtml = fs.readFileSync(path.join(__dirname, '../private_views/dashboard.html'), 'utf8');
    assert.equal(desktopHtml.includes('id="dashboardAlertsContainer"'), false, 'Desktop dashboard should not have outer non-widget alerts container');

    const mobileHtml = fs.readFileSync(path.join(__dirname, '../private_views/dashboard_mobile.html'), 'utf8');
    assert.equal(mobileHtml.includes('id="mDashboardAlertsContainer"'), false, 'Mobile dashboard should not have outer non-widget alerts container');

    const dashboardJs = fs.readFileSync(path.join(__dirname, '../public/dashboard.js'), 'utf8');
    // Widget definition & layouts
    assert.ok(dashboardJs.includes("id: 'alerts'"), 'dashboard.js must contain alerts widget definition');
    assert.ok(dashboardJs.includes("category: 'Avvisi'"), 'alerts widget must have category Avvisi');
    assert.ok(dashboardJs.includes("alerts: () => {"), 'WIDGET_RENDERERS must include alerts renderer');

    // Auto-collapse and zero space occupancy logic
    assert.ok(dashboardJs.includes("collapseAlertsWidget"), 'dashboard.js must contain collapseAlertsWidget function');
    assert.ok(dashboardJs.includes("syncAlertsWidgetWithGrid"), 'dashboard.js must contain syncAlertsWidgetWithGrid function');
    assert.ok(dashboardJs.includes("visibleWidgets.filter(item => item.id !== 'alerts')"), 'Empty alerts widget must be filtered out to occupy zero space');

    // Acquisition buttons
    assert.ok(dashboardJs.includes('data-ack-alert'), 'dashboard.js must handle data-ack-alert click');
    assert.ok(dashboardJs.includes('data-ack-all-alerts'), 'dashboard.js must handle data-ack-all-alerts click');
  });
});
