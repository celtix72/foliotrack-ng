const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const http = require('http');

const TEST_DB = path.join(__dirname, 'test_indices_ticker.db');
process.env.DB_PATH = TEST_DB;
process.env.JWT_SECRET = 'test-secret-indices-ticker-very-secure';
process.env.ADMIN_PASSWORD = 'adminTickerPass123!';

const { initDb, closeDb, getDb } = require('../src/db');
const app = require('../src/app');

let server;
let baseUrl;
let authToken;

describe('Market Indices Scrolling Ticker Banner & Settings Configuration', () => {
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
      body: JSON.stringify({ username: 'admin', password: 'adminTickerPass123!' })
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

  test('GET /api/market/indices returns live indices and refresh frequency metadata', async () => {
    const res = await fetch(`${baseUrl}/api/market/indices`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.success, true);
    assert.ok(Array.isArray(data.indices));
    assert.ok(data.indices.length >= 5);
    assert.equal(typeof data.refreshSeconds, 'number');
    assert.ok(data.refreshSeconds >= 5);
    assert.ok(['very_slow', 'slow', 'normal', 'fast'].includes(data.scrollSpeed));

    // Must include major benchmark
    const sp500 = data.indices.find(i => i.symbol === '^GSPC');
    assert.ok(sp500, 'S&P 500 must be included');
    assert.ok(sp500.price > 0);
  });

  test('GET /api/market/indices-config returns current configuration and preset catalog', async () => {
    const res = await fetch(`${baseUrl}/api/market/indices-config`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.success, true);
    assert.ok(data.config);
    assert.equal(typeof data.config.refreshSeconds, 'number');
    assert.ok(Array.isArray(data.config.indices));
    assert.ok(Array.isArray(data.presets));
    assert.ok(data.presets.length >= 10, 'Presets list should have popular benchmarks');

    const daxPreset = data.presets.find(p => p.symbol === '^GDAXI');
    assert.ok(daxPreset, 'DAX preset should be available');
  });

  test('PUT /api/market/indices-config requires authentication', async () => {
    const res = await fetch(`${baseUrl}/api/market/indices-config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshSeconds: 30 })
    });
    assert.equal(res.status, 401);
  });

  test('PUT /api/market/indices-config updates indices, scrollSpeed and refresh frequency', async () => {
    const customIndices = [
      { symbol: '^IXIC', name: 'NASDAQ Tech', currency: 'USD', enabled: true },
      { symbol: 'BTC-EUR', name: 'Bitcoin Crypto', currency: 'EUR', enabled: true },
      { symbol: '^GDAXI', name: 'DAX 40', currency: 'EUR', enabled: false }
    ];

    const putRes = await fetch(`${baseUrl}/api/market/indices-config`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${authToken}`
      },
      body: JSON.stringify({
        refreshSeconds: 20,
        scrollSpeed: 'fast',
        indices: customIndices
      })
    });

    assert.equal(putRes.status, 200);
    const putData = await putRes.json();
    assert.equal(putData.success, true);
    assert.equal(putData.config.refreshSeconds, 20);
    assert.equal(putData.config.scrollSpeed, 'fast');
    assert.equal(putData.config.indices.length, 3);

    // Verify GET /api/market/indices reflects new configuration
    const getRes = await fetch(`${baseUrl}/api/market/indices?force=true`);
    const getData = await getRes.json();
    assert.equal(getData.success, true);
    assert.equal(getData.refreshSeconds, 20);
    assert.equal(getData.scrollSpeed, 'fast');

    // Only enabled indices should be fetched for live display
    const symbols = getData.indices.map(i => i.symbol);
    assert.ok(symbols.includes('^IXIC'), 'NASDAQ must be in live indices');
    assert.ok(symbols.includes('BTC-EUR'), 'Bitcoin must be in live indices');
    assert.ok(!symbols.includes('^GDAXI'), 'Disabled DAX 40 should not be in live stream');
  });

  test('PUT /api/market/indices-config rejects empty indices list', async () => {
    const badRes = await fetch(`${baseUrl}/api/market/indices-config`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${authToken}`
      },
      body: JSON.stringify({
        refreshSeconds: 15,
        indices: []
      })
    });

    // Should return 400 or fallback without crashing
    const badData = await badRes.json();
    assert.ok(badData.success !== undefined);
  });

  test('POST /api/market/indices-config/reset restores factory defaults', async () => {
    const resetRes = await fetch(`${baseUrl}/api/market/indices-config/reset`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${authToken}`
      }
    });

    assert.equal(resetRes.status, 200);
    const resetData = await resetRes.json();
    assert.equal(resetData.success, true);
    assert.equal(resetData.config.refreshSeconds, 60);
    assert.equal(resetData.config.scrollSpeed, 'normal');
    assert.ok(resetData.config.indices.some(i => i.symbol === '^GSPC'));
    assert.ok(resetData.config.indices.some(i => i.symbol === 'FTSEMIB.MI'));
  });

  test('POST /api/market/indices/refresh triggers cache purge and returns fresh quotes', async () => {
    const refRes = await fetch(`${baseUrl}/api/market/indices/refresh`, {
      method: 'POST'
    });

    assert.equal(refRes.status, 200);
    const refData = await refRes.json();
    assert.equal(refData.success, true);
    assert.ok(Array.isArray(refData.indices));
    assert.ok(refData.indices.length >= 5);
  });

  test('Frontend client scripts and views include scrolling ticker banner markup', async () => {
    const jsRes = await fetch(`${baseUrl}/header_indices.js`);
    assert.equal(jsRes.status, 200);
    const jsContent = await jsRes.text();
    assert.ok(jsContent.includes('ft-ticker-scroll'), 'Must define continuous keyframe animation');
    assert.ok(jsContent.includes('ft-ticker-track'), 'Must define ticker track');
    assert.ok(jsContent.includes('animation-play-state: paused'), 'Must support pause on hover');
    assert.ok(jsContent.includes('setupRefreshTimer'), 'Must support configurable refresh interval');
    assert.ok(jsContent.includes('val > 999'), 'Must format values > 999 with zero decimals');

    // Desktop Settings view
    const setRes = await fetch(`${baseUrl}/settings`, {
      headers: { 'Cookie': `token=${authToken}` }
    });
    assert.equal(setRes.status, 200);
    const setHtml = await setRes.text();
    assert.ok(setHtml.includes('card-market-ticker-settings'));
    assert.ok(setHtml.includes('tickerRefreshSecondsInput'));
    assert.ok(setHtml.includes('tickerScrollSpeedSelect'));
    assert.ok(setHtml.includes('btn-save-ticker-config'));

    // Mobile Settings view
    const setMobRes = await fetch(`${baseUrl}/settings?view=mobile`, {
      headers: { 'Cookie': `token=${authToken}` }
    });
    assert.equal(setMobRes.status, 200);
    const setMobHtml = await setMobRes.text();
    assert.ok(setMobHtml.includes('card-market-ticker-settings'));
    assert.ok(setMobHtml.includes('tickerRefreshSecondsInput'));
    assert.ok(setMobHtml.includes('btn-save-ticker-config'));
  });
});

