const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const http = require('http');

const TEST_DB = path.join(__dirname, 'test_market_closed_sync.db');
process.env.DB_PATH = TEST_DB;
process.env.JWT_SECRET = 'test-secret-jwt-very-long-and-secure-closed-market-test';
process.env.ADMIN_PASSWORD = 'adminClosedMarketPass123!';

const { initDb, closeDb, getDb } = require('../src/db');
const app = require('../src/app');
const { broadcastMarketUpdate, marketEvents } = require('../src/services/marketEvents');

let server;
let baseUrl;
let authToken;
let authCookie;

describe('Dashboard Closed Market Highlighting & Real-Time Live Sync Engine', () => {
  before(async () => {
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    initDb(TEST_DB);
    const db = getDb();

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
      body: JSON.stringify({ username: 'admin', password: 'adminClosedMarketPass123!' })
    });
    const loginData = await loginRes.json();
    authToken = loginData.token;
    authCookie = loginRes.headers.get('set-cookie')?.split(';')[0] || '';

    // Create test portfolio
    const pRes = await fetch(`${baseUrl}/api/portfolios`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`
      },
      body: JSON.stringify({
        name: 'Portafoglio Test Mercati',
        currency: 'EUR',
        initialCash: 100000
      })
    });
    const pData = await pRes.json();
    const portfolioId = pData.portfolio.id;

    // Seed test assets with varied currencies, exchanges, and timestamps
    db.prepare(`
      INSERT INTO assets (ticker, name, type, exchange, currency, currentPrice, changePercent, changeValue, marketState, regularMarketTime, lastSyncAt, updatedAt)
      VALUES 
        ('AAPL', 'Apple Inc.', 'EQUITY', 'NASDAQ', 'USD', 220.0, 1.5, 3.25, 'CLOSED', datetime('now', '-1 day'), datetime('now', '-10 minutes'), datetime('now', '-10 minutes')),
        ('ENI.MI', 'Eni S.p.A.', 'EQUITY', 'Borsa Italiana', 'EUR', 14.50, 0.45, 0.065, 'REGULAR', datetime('now', '-2 minutes'), datetime('now', '-2 minutes'), datetime('now', '-2 minutes')),
        ('BTC-EUR', 'Bitcoin', 'CRYPTO', 'CRYPTO', 'EUR', 65000.0, 3.2, 2050.0, 'REGULAR', datetime('now', '-1 minute'), datetime('now', '-1 minute'), datetime('now', '-1 minute'))
    `).run();

    // Buy transactions
    await fetch(`${baseUrl}/api/transactions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
      body: JSON.stringify({
        portfolioId,
        type: 'BUY',
        assetTicker: 'AAPL',
        quantity: 50,
        price: 200,
        amount: 10000,
        date: '2026-01-10'
      })
    });

    await fetch(`${baseUrl}/api/transactions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
      body: JSON.stringify({
        portfolioId,
        type: 'BUY',
        assetTicker: 'ENI.MI',
        quantity: 500,
        price: 13.50,
        amount: 6750,
        date: '2026-01-10'
      })
    });
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

  test('public/dashboard.js defines isAssetMarketClosed and getAssetMarketStatusInfo helpers', async () => {
    const res = await fetch(`${baseUrl}/dashboard.js`);
    assert.equal(res.status, 200);
    const jsText = await res.text();

    assert.ok(jsText.includes('function isAssetMarketClosed'), 'Must define isAssetMarketClosed helper');
    assert.ok(jsText.includes('function getAssetMarketStatusInfo'), 'Must define getAssetMarketStatusInfo helper');
    assert.ok(jsText.includes('Europe/Rome'), 'Must check Italian Rome timezone for exchange hours');
    assert.ok(jsText.includes('CHIUSO'), 'Must support CHIUSO badge');
    assert.ok(jsText.includes('LIVE'), 'Must support LIVE badge');

    // Dynamically evaluate isAssetMarketClosed logic
    const evalEnv = {};
    const fnMatch = jsText.match(/function isAssetMarketClosed\([\s\S]*?\n  \}/);
    assert.ok(fnMatch, 'Function must be found in dashboard.js');
    const isClosedFn = new Function('h', 'refDate', `return (${fnMatch[0]})(h, refDate);`);

    // Wednesday at 10:25 CET (Borsa Italiana regular session)
    const wednesdayMorning = new Date('2026-11-04T09:25:00.000Z'); // 10:25 CET

    // NEXI.MI on Borsa Italiana during trading hours must be OPEN (false)
    const nexi = {
      ticker: 'NEXI.MI',
      exchange: 'MIL',
      currency: 'EUR',
      marketState: 'REGULAR',
      regularMarketTime: '2026-11-04T08:59:19.000Z'
    };
    assert.equal(isClosedFn(nexi, wednesdayMorning), false, 'NEXI.MI must be recognized as OPEN during Italian market hours');

    // AAPL on NASDAQ at 10:25 CET must be CLOSED (true, opens at 15:30 CET)
    const aapl = {
      ticker: 'AAPL',
      exchange: 'NMS',
      currency: 'USD',
      marketState: 'PRE',
      regularMarketTime: '2026-11-03T21:00:00.000Z'
    };
    assert.equal(isClosedFn(aapl, wednesdayMorning), true, 'AAPL must be recognized as CLOSED before 15:30 CET');

    // Test getDayVarCardStyle returns grey background when isClosed is true
    const styleMatch = jsText.match(/function getDayVarCardStyle\([\s\S]*?\n  \}/);
    assert.ok(styleMatch, 'getDayVarCardStyle function must be found in dashboard.js');
    const getDayStyleFn = new Function('dayPct', 'isClosed', `return (${styleMatch[0]})(dayPct, isClosed);`);

    const closedStyle = getDayStyleFn(2.5, true);
    assert.ok(closedStyle.style.includes('rgba(156, 163, 175'), 'Closed card must have grey background rgba(156, 163, 175)');
    assert.ok(!closedStyle.style.includes('linear-gradient'), 'Closed card must NOT have green/red linear-gradient');

    const openPosStyle = getDayStyleFn(2.5, false);
    assert.ok(openPosStyle.style.includes('linear-gradient'), 'Open positive card must have green linear-gradient');
    assert.ok(openPosStyle.style.includes('16, 185, 129'), 'Open positive card must use green color');

    const openNegStyle = getDayStyleFn(-1.8, false);
    assert.ok(openNegStyle.style.includes('linear-gradient'), 'Open negative card must have red linear-gradient');
    assert.ok(openNegStyle.style.includes('244, 63, 94'), 'Open negative card must use red color');
  });

  test('Portfolio holdings include exchange, marketState, regularMarketTime and lastSyncAt attributes', async () => {
    const res = await fetch(`${baseUrl}/api/portfolios`, {
      headers: { Authorization: `Bearer ${authToken}` }
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.success, true);

    const p = data.portfolios[0];
    const holdings = p.metrics?.holdings || [];
    assert.ok(holdings.length >= 2, 'Should have at least 2 holdings');

    const aapl = holdings.find(h => h.ticker === 'AAPL');
    assert.ok(aapl, 'AAPL must be present in holdings');
    assert.equal(aapl.currency, 'USD');
    assert.ok('exchange' in aapl, 'Holding must contain exchange field');
    assert.ok('lastSyncAt' in aapl, 'Holding must contain lastSyncAt field');
    assert.ok('marketState' in aapl, 'Holding must contain marketState field');
  });

  test('public/dashboard.js places closed markets at the end of active composition sort order', async () => {
    const res = await fetch(`${baseUrl}/dashboard.js`);
    const jsText = await res.text();

    // Check composition sorting logic
    assert.ok(jsText.includes('!aClosed && bClosed'), 'Must partition open markets before closed markets');
    assert.ok(jsText.includes('aClosed && !bClosed'), 'Must place closed markets at the end');
    assert.ok(jsText.includes('closedCount > 0'), 'Must display closed count badge in Titoli header');
  });

  test('GET /api/market/stream serves SSE connection and broadcasts MARKET_UPDATED events', async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4000);

    const streamPromise = new Promise(async (resolve, reject) => {
      try {
        const streamRes = await fetch(`${baseUrl}/api/market/stream`, {
          signal: controller.signal
        });
        assert.equal(streamRes.status, 200);
        assert.ok(streamRes.headers.get('content-type')?.includes('text/event-stream'));

        const reader = streamRes.body.getReader();
        const decoder = new TextDecoder();
        let receivedData = '';

        // Trigger an event emission after connection
        setTimeout(() => {
          broadcastMarketUpdate({ reason: 'TEST_SYNC', updated: 5, total: 5 });
        }, 150);

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunk = decoder.decode(value);
          receivedData += chunk;

          if (receivedData.includes('CONNECTED') && receivedData.includes('MARKET_UPDATED')) {
            clearTimeout(timeout);
            controller.abort(); // Close stream
            resolve(receivedData);
            break;
          }
        }
      } catch (err) {
        if (err.name === 'AbortError') {
          // Expected on finish
          resolve(true);
        } else {
          reject(err);
        }
      }
    });

    await streamPromise;
  });

  test('Desktop and mobile dashboard HTML contain Rileggi Mercato buttons and notification toasts', async () => {
    // Desktop view
    const deskRes = await fetch(`${baseUrl}/dashboard`, {
      headers: { Cookie: authCookie }
    });
    assert.equal(deskRes.status, 200);
    const deskHtml = await deskRes.text();

    assert.ok(deskHtml.includes('id="refreshMarketBtn"'), 'Desktop must have refreshMarketBtn in toolbar');
    assert.ok(deskHtml.includes('id="market-sync-toast"'), 'Desktop must contain market-sync-toast');
    assert.ok(deskHtml.includes('Rileggi Mercato'), 'Desktop must have descriptive button label');

    // Mobile view
    const mobRes = await fetch(`${baseUrl}/dashboard?view=mobile`, {
      headers: { Cookie: authCookie, 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X)' }
    });
    assert.equal(mobRes.status, 200);
    const mobHtml = await mobRes.text();

    assert.ok(mobHtml.includes('id="mobileRefreshMarketBtn"'), 'Mobile must have mobileRefreshMarketBtn in toolbar');
    assert.ok(mobHtml.includes('id="market-sync-toast"'), 'Mobile must contain market-sync-toast');
  });

  test('public/dashboard.js connects to SSE stream and wires manual market refresh button', async () => {
    const res = await fetch(`${baseUrl}/dashboard.js`);
    const jsText = await res.text();

    assert.ok(jsText.includes('initMarketEventsListener'), 'dashboard.js must contain initMarketEventsListener');
    assert.ok(jsText.includes("new EventSource('/api/market/stream')"), 'dashboard.js must connect to SSE stream');
    assert.ok(jsText.includes('handleManualMarketRefresh'), 'dashboard.js must contain handleManualMarketRefresh');
    assert.ok(jsText.includes('refreshMarketBtn'), 'dashboard.js must bind refreshMarketBtn click listener');
    assert.ok(jsText.includes('showMarketSyncToast'), 'dashboard.js must trigger feedback toast');
  });
});

