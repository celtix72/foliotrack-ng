const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { initDb, closeDb, getDb } = require('../src/db');
const app = require('../src/app');

describe('Dashboard Layout Automatic Persistence & Server Restart Restoration', () => {
  let server;
  let baseUrl;
  let authToken;
  const testDbPath = path.join(__dirname, 'test_layout_persistence.db');

  before(async () => {
    // Ensure clean state
    if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
    initDb(testDbPath);

    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, resolve));
    const port = server.address().port;
    baseUrl = `http://127.0.0.1:${port}`;

    // Login as admin
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

  test('Layout can be saved with full integer coordinates (w, h, x, y) via PUT /api/settings', async () => {
    const customLayout = [
      { id: 'dayChange', x: 0, y: 0, w: 4, h: 2 },
      { id: 'value', x: 4, y: 0, w: 4, h: 2 },
      { id: 'cash', x: 8, y: 0, w: 4, h: 2 },
      { id: 'performanceChart', x: 0, y: 2, w: 12, h: 5 },
      { id: 'composition', x: 0, y: 7, w: 12, h: 8 }
    ];

    const putRes = await fetch(`${baseUrl}/api/settings`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`
      },
      body: JSON.stringify({
        key: 'insightsOverviewLayout',
        value: JSON.stringify(customLayout),
        encrypted: false
      })
    });
    assert.equal(putRes.status, 200);
    const putData = await putRes.json();
    assert.equal(putData.success, true);

    // Verify it is physically stored in SQLite settings table
    const db = getDb();
    const row = db.prepare("SELECT value FROM settings WHERE key = 'insightsOverviewLayout'").get();
    assert.ok(row, 'Setting insightsOverviewLayout must exist in DB');
    const stored = JSON.parse(row.value);
    assert.equal(stored.length, 5);
    assert.equal(stored[0].id, 'dayChange');
    assert.equal(stored[0].w, 4);
    assert.equal(stored[0].h, 2);
  });

  test('Simulated Server Restart preserves layout in DB and GET /api/settings/:key restores it', async () => {
    // Simulate server restart: close and re-open DB from disk
    closeDb();
    initDb(testDbPath);

    const getRes = await fetch(`${baseUrl}/api/settings/insightsOverviewLayout`, {
      headers: { Authorization: `Bearer ${authToken}` }
    });
    assert.equal(getRes.status, 200);
    const getData = await getRes.json();
    assert.equal(getData.success, true);

    const layout = JSON.parse(getData.value);
    assert.equal(layout.length, 5);
    assert.equal(layout[0].id, 'dayChange');
    assert.equal(layout[1].id, 'value');
    assert.equal(layout[2].id, 'cash');
    assert.equal(layout[3].id, 'performanceChart');
    assert.equal(layout[4].id, 'composition');
  });

  test('Hidden widgets settings persist and restore seamlessly alongside layout', async () => {
    const hiddenList = ['classes', 'sectors', 'regions', 'targets'];

    const putRes = await fetch(`${baseUrl}/api/settings`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`
      },
      body: JSON.stringify({
        key: 'hiddenWidgets',
        value: JSON.stringify(hiddenList),
        encrypted: false
      })
    });
    assert.equal(putRes.status, 200);

    const getRes = await fetch(`${baseUrl}/api/settings/hiddenWidgets`, {
      headers: { Authorization: `Bearer ${authToken}` }
    });
    assert.equal(getRes.status, 200);
    const getData = await getRes.json();
    assert.equal(getData.success, true);
    const retrieved = JSON.parse(getData.value);
    assert.deepEqual(retrieved, hiddenList);
  });

  test('dashboard.js contains auto-save listeners on grid events and y/x sort order', () => {
    const jsContent = fs.readFileSync(path.join(__dirname, '../public/dashboard.js'), 'utf8');

    // Verify auto-save events on grid
    assert.ok(jsContent.includes("grid.on('change'"), 'grid.on(change) auto-save listener must be present');
    assert.ok(jsContent.includes("grid.on('dragstop'"), 'grid.on(dragstop) auto-save listener must be present');
    assert.ok(jsContent.includes("grid.on('resizestop'"), 'grid.on(resizestop) auto-save listener must be present');

    // Verify debounced auto-save function
    assert.ok(jsContent.includes('scheduleAutoSaveLayout'), 'scheduleAutoSaveLayout function must be defined');
    assert.ok(jsContent.includes('saveCurrentLayout'), 'saveCurrentLayout function must be defined');
    assert.ok(jsContent.includes('getCurrentGridLayout'), 'getCurrentGridLayout function must be defined');

    // Verify sorting by y ascending then x ascending before adding to grid
    assert.ok(jsContent.includes('(a.y ?? 0) - (b.y ?? 0)'), 'Widgets must be sorted by y ascending');

    // Verify localStorage fallback
    assert.ok(jsContent.includes('foliotrack_dashboard_layout'), 'localStorage cache foliotrack_dashboard_layout must be used');
  });
});

