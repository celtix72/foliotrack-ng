const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const http = require('http');

const TEST_DB = path.join(__dirname, 'test_providers_market.db');
process.env.DB_PATH = TEST_DB;
process.env.JWT_SECRET = 'test-secret-jwt-very-long-and-secure-providers-test';
process.env.ADMIN_PASSWORD = 'adminProvidersPassword123!';

const { initDb, closeDb } = require('../src/db');
const app = require('../src/app');

let server;
let baseUrl;
let authToken;

describe('Market Providers Configuration & Interactive Testing API', () => {
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
      body: JSON.stringify({ username: 'admin', password: 'adminProvidersPassword123!' })
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

  test('GET /api/market/providers returns YAHOO, BORSA_ITALIANA, and GOOGLE configurations with market status', async () => {
    const res = await fetch(`${baseUrl}/api/market/providers`, {
      headers: { Authorization: `Bearer ${authToken}` }
    });

    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.ok(Array.isArray(body.providers));
    assert.equal(body.providers.length, 3);

    const yahoo = body.providers.find(p => p.id === 'YAHOO');
    assert.ok(yahoo);
    assert.equal(yahoo.name, 'Yahoo Finance');
    assert.equal(yahoo.supportsRealtime, true);
    assert.equal(yahoo.supportsHistorical, true);
    assert.ok(yahoo.marketStatus);
    assert.equal(typeof yahoo.marketStatus.isOpen, 'boolean');

    const borsa = body.providers.find(p => p.id === 'BORSA_ITALIANA');
    assert.ok(borsa);
    assert.equal(borsa.name, 'Borsa Italiana / Euronext Milan');
    assert.equal(borsa.supportsRealtime, true);
    assert.equal(borsa.supportsHistorical, true);

    const google = body.providers.find(p => p.id === 'GOOGLE');
    assert.ok(google);
    assert.equal(google.supportsRealtime, true);
    assert.equal(google.supportsHistorical, false);
  });

  test('GET /api/market/providers/:id returns single provider details', async () => {
    const res = await fetch(`${baseUrl}/api/market/providers/BORSA_ITALIANA`, {
      headers: { Authorization: `Bearer ${authToken}` }
    });

    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.equal(body.provider.id, 'BORSA_ITALIANA');
    assert.equal(body.provider.marketOpen, '09:00');
    assert.equal(body.provider.marketClose, '17:30');
  });

  test('PUT /api/market/providers/:id updates frequency, opening hours and restrictions', async () => {
    const updatePayload = {
      frequencyMinutes: 10,
      marketOpen: '08:30',
      marketClose: '18:00',
      onlyMarketHours: true,
      enabled: true
    };

    const res = await fetch(`${baseUrl}/api/market/providers/BORSA_ITALIANA`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`
      },
      body: JSON.stringify(updatePayload)
    });

    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.equal(body.provider.frequencyMinutes, 10);
    assert.equal(body.provider.marketOpen, '08:30');
    assert.equal(body.provider.marketClose, '18:00');
    assert.equal(body.provider.onlyMarketHours, true);

    // Verify persistence via GET
    const getRes = await fetch(`${baseUrl}/api/market/providers/BORSA_ITALIANA`, {
      headers: { Authorization: `Bearer ${authToken}` }
    });
    const getBody = await getRes.json();
    assert.equal(getBody.provider.frequencyMinutes, 10);
    assert.equal(getBody.provider.marketOpen, '08:30');
  });

  test('PUT /api/market/providers/:id rejects invalid frequency or time formats', async () => {
    const res1 = await fetch(`${baseUrl}/api/market/providers/YAHOO`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`
      },
      body: JSON.stringify({ frequencyMinutes: 0 })
    });
    assert.equal(res1.status, 400);

    const res2 = await fetch(`${baseUrl}/api/market/providers/YAHOO`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`
      },
      body: JSON.stringify({ marketOpen: '9am' })
    });
    assert.equal(res2.status, 400);
  });

  test('POST /api/market/providers/:id/test-quote tests realtime quote retrieval with latency', async () => {
    const res = await fetch(`${baseUrl}/api/market/providers/YAHOO/test-quote`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`
      },
      body: JSON.stringify({ ticker: 'AAPL' })
    });

    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.providerId, 'YAHOO');
    assert.equal(body.ticker, 'AAPL');
    assert.equal(typeof body.durationMs, 'number');
    assert.ok(body.durationMs >= 0);
  });

  test('POST /api/market/providers/:id/test-history tests historical 5Y series retrieval', async () => {
    const res = await fetch(`${baseUrl}/api/market/providers/YAHOO/test-history`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`
      },
      body: JSON.stringify({ ticker: 'AAPL', period: '1Y' })
    });

    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.providerId, 'YAHOO');
    assert.equal(typeof body.durationMs, 'number');
  });

  test('POST /api/market/providers/:id/test-history on GOOGLE returns clear unsupported error', async () => {
    const res = await fetch(`${baseUrl}/api/market/providers/GOOGLE/test-history`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`
      },
      body: JSON.stringify({ ticker: 'NASDAQ:GOOGL' })
    });

    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.success, false);
    assert.ok(body.error.includes('solo quotazioni realtime'));
  });
});
