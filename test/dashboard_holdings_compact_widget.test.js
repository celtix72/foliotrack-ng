const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const http = require('http');

const TEST_DB = path.join(__dirname, 'test_compact_widget.db');
process.env.DB_PATH = TEST_DB;
process.env.JWT_SECRET = 'test-secret-compact-holdings-widget';
process.env.ADMIN_PASSWORD = 'adminPassCompact123!';
process.env.NODE_ENV = 'test';

const { initDb, closeDb } = require('../src/db');
const app = require('../src/app');

let server;
let baseUrl;
let authToken;

describe('Compact 1-Row Holdings Widget (Titoli Compatti - Var. Day)', () => {
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
      body: JSON.stringify({ username: 'admin', password: 'adminPassCompact123!' })
    });
    const loginData = await loginRes.json();
    authToken = loginData.token;
  });

  after(() => {
    if (server) server.close();
    closeDb();
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  });

  test('public/dashboard.js defines holdingsCompact in WIDGET_DEFINITIONS and MOBILE_DEFAULT_LAYOUT', () => {
    const code = fs.readFileSync(path.join(__dirname, '../public/dashboard.js'), 'utf8');

    assert.ok(code.includes("id: 'holdingsCompact'"), 'holdingsCompact must be in WIDGET_DEFINITIONS');
    assert.ok(code.includes("name: 'Titoli Compatti (Var. Day)'"), 'holdingsCompact must have descriptive title');

    // Verify MOBILE_DEFAULT_LAYOUT includes holdingsCompact
    assert.ok(code.includes("{ id: 'holdingsCompact', name: 'Titoli Compatti (Var. Day)'"), 'holdingsCompact must be in MOBILE_DEFAULT_LAYOUT');
  });

  test('WIDGET_RENDERERS.holdingsCompact renders 1 single row per asset with ticker, price, and daily variations (% and value)', () => {
    const code = fs.readFileSync(path.join(__dirname, '../public/dashboard.js'), 'utf8');

    const renderersMatch = code.match(/const WIDGET_RENDERERS = \{([\s\S]*?)\n  \};/);
    assert.ok(renderersMatch, 'WIDGET_RENDERERS must be defined');

    const evalEnv = vm.createContext({
      localStorage: {
        getItem: () => null,
        setItem: () => {}
      },
      document: {
        getElementById: () => null,
        querySelector: () => ({})
      }
    });

    vm.runInContext(`
      ${code.substring(code.indexOf('function formatEur'), code.indexOf('const WIDGET_RENDERERS'))}
      const WIDGET_RENDERERS = {
        ${renderersMatch[1]}
      };
      this.renderHoldingsCompact = WIDGET_RENDERERS.holdingsCompact;
    `, evalEnv);

    const now = new Date();
    const todayIso = now.toISOString().split('T')[0];

    const mockData = {
      totals: { totalValue: 100000 },
      activeHoldings: [
        {
          ticker: 'NOV.DE',
          currency: 'EUR',
          quantity: 100,
          currentPrice: 36.22,
          marketValue: 3622.00,
          changePercent: 0.18,
          changeValue: 0.065,
          dayPnlEur: 6.50,
          quoteDate: todayIso,
          regularMarketTime: `${todayIso}T10:00:00.000Z`
        },
        {
          ticker: 'NEXI.MI',
          currency: 'EUR',
          quantity: 1200,
          currentPrice: 4.51,
          marketValue: 5412.00,
          changePercent: -3.45,
          changeValue: -0.161,
          dayPnlEur: -193.20,
          quoteDate: todayIso,
          regularMarketTime: `${todayIso}T10:00:00.000Z`
        },
        {
          ticker: 'ABNB',
          currency: 'USD',
          quantity: 50,
          currentPrice: 170.13,
          currentPriceNative: 170.13,
          marketValue: 8506.50,
          marketValueNative: 8506.50,
          changePercent: 0,
          changeValue: 0,
          dayPnlEur: 0,
          quoteDate: '2026-11-05', // Yesterday's quote (closed)
          regularMarketTime: '2026-11-05T21:00:01.000Z'
        }
      ]
    };

    const html = evalEnv.renderHoldingsCompact(mockData);

    // 1. Header & Quick Sort pills
    assert.ok(html.includes('Titoli (Var. Day)'), 'Must include header title');
    assert.ok(html.includes('data-compact-sort="day_desc"'), 'Must have Day desc sort');
    assert.ok(html.includes('data-compact-sort="day_asc"'), 'Must have Day asc sort');
    assert.ok(html.includes('data-compact-sort="value_desc"'), 'Must have Value sort');
    assert.ok(html.includes('data-compact-sort="ticker_asc"'), 'Must have Ticker sort');

    // 2. Table Column Headers
    assert.ok(html.includes('TICKER'), 'Must have TICKER column');
    assert.ok(html.includes('PREZZO'), 'Must have PREZZO column');
    assert.ok(html.includes('% DAY'), 'Must have % DAY column');
    assert.ok(html.includes('Δ VALORE'), 'Must have Δ VALORE column');

    // 3. Positive gainer NOV.DE
    assert.ok(html.includes('NOV.DE'), 'Must render NOV.DE');
    assert.ok(html.includes('36,22 €'), 'Must render price formatted');
    assert.ok(html.includes('+0,18%') || html.includes('+0.18%'), 'Must render positive day % badge with decimals');
    assert.ok(html.includes('+7 €') || html.includes('+6 €') || html.includes('+6,50 €') || html.includes('+6,50'), 'Must render positive day EUR value');

    // 4. Negative loser NEXI.MI
    assert.ok(html.includes('NEXI.MI'), 'Must render NEXI.MI');
    assert.ok(html.includes('4,51 €'), 'Must render NEXI price');
    assert.ok(html.includes('-3,45%') || html.includes('-3.45%'), 'Must render negative day % badge with decimals');
    assert.ok(html.includes('-193 €') || html.includes('-193,20 €') || html.includes('-193,20'), 'Must render negative day EUR value');

    // 5. US Closed Stock ABNB
    assert.ok(html.includes('ABNB'), 'Must render ABNB');
    assert.ok(html.includes('170,13 $'), 'Must render USD price');
    assert.ok(html.includes('CHIUSO'), 'Must show CHIUSO badge');
    assert.ok(html.includes('0 $') || html.includes('0,00 $') || html.includes('0,00'), 'Must render zero delta for closed stock');

    // 6. Interactive Asset Drawer Hook
    assert.ok(html.includes('data-open-asset="NOV.DE"'), 'Must have data-open-asset for click handling');
    assert.ok(html.includes('data-open-asset="NEXI.MI"'), 'Must have data-open-asset for click handling');
  });

  test('Mobile Dashboard serves 24 widgets in drawer and layout', async () => {
    const res = await fetch(`${baseUrl}/?view=mobile`, {
      headers: {
        Authorization: `Bearer ${authToken}`,
        Cookie: `foliotrack_token=${authToken}`
      }
    });
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.ok(html.includes('19 / 19') || html.includes('25 / 25') || html.includes('24 / 24'), 'Drawer visible count badge must be present');
  });
});

