const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const http = require('http');

const TEST_DB = path.join(__dirname, 'test_mobile_widgets.db');
process.env.DB_PATH = TEST_DB;
process.env.JWT_SECRET = 'test-secret-mobile-widgets-views';
process.env.ADMIN_PASSWORD = 'adminPassMobile123!';
process.env.NODE_ENV = 'test';

const { initDb, closeDb } = require('../src/db');
const app = require('../src/app');

let server;
let baseUrl;
let authToken;

describe('Mobile Custom Widgets: Category Quotes & Top Winner/Loser 1D (Photos 1, 2, 3)', () => {
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
      body: JSON.stringify({ username: 'admin', password: 'adminPassMobile123!' })
    });
    const loginData = await loginRes.json();
    authToken = loginData.token;
  });

  after(() => {
    if (server) server.close();
    closeDb();
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  });

  test('public/dashboard.js defines categoryQuotes and moversDay in WIDGET_DEFINITIONS and MOBILE_DEFAULT_LAYOUT', () => {
    const code = fs.readFileSync(path.join(__dirname, '../public/dashboard.js'), 'utf8');

    assert.ok(code.includes("id: 'categoryQuotes'"), 'categoryQuotes must be in WIDGET_DEFINITIONS');
    assert.ok(code.includes("name: 'Quotazioni per Categoria'"), 'categoryQuotes must have descriptive title');
    assert.ok(code.includes("id: 'moversDay'"), 'moversDay must be in WIDGET_DEFINITIONS');

    // Verify MOBILE_DEFAULT_LAYOUT includes both widgets
    assert.ok(code.includes("{ id: 'categoryQuotes', name: 'Quotazioni per Categoria'"), 'categoryQuotes must be in MOBILE_DEFAULT_LAYOUT');
    assert.ok(code.includes("{ id: 'moversDay', name: 'Movers Giornalieri (1D)'"), 'moversDay must be in MOBILE_DEFAULT_LAYOUT');
  });

  test('WIDGET_RENDERERS.categoryQuotes renders warm yellow accordion, DAILY delta, total return, and 4-column table (Photos 1 & 2)', () => {
    const code = fs.readFileSync(path.join(__dirname, '../public/dashboard.js'), 'utf8');

    // Run isolated VM with helper functions and WIDGET_RENDERERS
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
      this.renderCategoryQuotes = WIDGET_RENDERERS.categoryQuotes;
      this.renderMoversDay = WIDGET_RENDERERS.moversDay;
    `, evalEnv);

    const now = new Date();
    const todayIso = now.toISOString().split('T')[0];

    const mockHoldings = {
      activeHoldings: [
        // European Stocks (AZIONI EUR)
        {
          ticker: 'MSF.DE',
          type: 'EQUITY',
          currency: 'EUR',
          quantity: 10,
          currentPrice: 485.00,
          pmc: 400.00,
          marketValue: 4850.00,
          unrealizedPnl: 850.00,
          changePercent: 0.0,
          changeValue: 0.0,
          dayPnlEur: 0.0,
          quoteDate: todayIso,
          regularMarketTime: `${todayIso}T11:00:00.000Z`
        },
        {
          ticker: 'PRX.AS',
          type: 'EQUITY',
          currency: 'EUR',
          quantity: 20,
          currentPrice: 37.93,
          pmc: 35.00,
          marketValue: 758.60,
          unrealizedPnl: 58.60,
          changePercent: -0.2,
          changeValue: -0.08,
          dayPnlEur: -11.43,
          quoteDate: todayIso,
          regularMarketTime: `${todayIso}T11:00:00.000Z`
        },
        // US Stocks (AZIONI USD)
        {
          ticker: 'ABNB',
          type: 'EQUITY',
          currency: 'USD',
          quantity: 15,
          currentPrice: 170.13,
          currentPriceNative: 170.13,
          pmcNative: 150.00,
          marketValue: 2551.95,
          marketValueNative: 2551.95,
          unrealizedPnlNative: 301.95,
          changePercent: 0.0,
          quoteDate: '2026-11-05', // Closed yesterday
          regularMarketTime: '2026-11-05T21:00:00.000Z'
        },
        // ETF
        {
          ticker: 'VWCE.DE',
          type: 'ETF',
          currency: 'EUR',
          quantity: 50,
          currentPrice: 114.80,
          pmc: 100.00,
          marketValue: 5740.00,
          unrealizedPnl: 740.00,
          changePercent: -2.1,
          dayPnlEur: -123.00,
          quoteDate: todayIso,
          regularMarketTime: `${todayIso}T11:00:00.000Z`
        }
      ]
    };

    const html = evalEnv.renderCategoryQuotes(mockHoldings);

    // 1. Check Category Headers
    assert.ok(html.includes('AZIONI EUR'), 'Must render AZIONI EUR category header');
    assert.ok(html.includes('AZIONI USD'), 'Must render AZIONI USD category header');
    assert.ok(html.includes('ETF'), 'Must render ETF category header');

    // 2. Check Warm Yellow Header banner style
    assert.ok(html.includes('background-color: #FEF9C3'), 'Category header must use yellow banner #FEF9C3');
    assert.ok(html.includes('DAILY'), 'Must have DAILY indicator label');

    // 3. Check Table Column Headers
    assert.ok(html.includes('TICKER'), 'Table header must include TICKER');
    assert.ok(html.includes('PREZZO'), 'Table header must include PREZZO');
    assert.ok(html.includes('% GIORNO'), 'Table header must include % GIORNO');
    assert.ok(html.includes('VAL GIORNO'), 'Table header must include VAL GIORNO');

    // 4. Check Rows & Badges
    assert.ok(html.includes('MSF.DE'), 'Must render MSF.DE ticker');
    assert.ok(html.includes('485,00 €'), 'Must format EUR price');
    assert.ok(html.includes('0,00%') || html.includes('0.0%'), 'Must format day variation badge');

    assert.ok(html.includes('PRX.AS'), 'Must render PRX.AS ticker');
    assert.ok(html.includes('-11 €') || html.includes('-11,43 €'), 'Must format negative day value delta');

    // 5. Check US Stocks CHIUSO badge
    assert.ok(html.includes('ABNB'), 'Must render ABNB ticker');
    assert.ok(html.includes('170,13 $'), 'Must format USD price with dollar symbol');
    assert.ok(html.includes('CHIUSO'), 'Must show CHIUSO badge for closed US market');
  });

  test('WIDGET_RENDERERS.categoryQuotes provides compact layout, category pills, select dropdown, and category filtering', () => {
    const code = fs.readFileSync(path.join(__dirname, '../public/dashboard.js'), 'utf8');

    const renderersMatch = code.match(/const WIDGET_RENDERERS = \{([\s\S]*?)\n  \};/);
    const evalEnv = vm.createContext({
      localStorage: {
        getItem: (k) => k === 'foliotrack_catquotes_filter' ? 'ALL' : null,
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
      this.renderCategoryQuotes = WIDGET_RENDERERS.categoryQuotes;
      this.getFilter = () => activeCategoryQuotesFilter;
      this.setFilterDirect = (f) => { activeCategoryQuotesFilter = f; };
    `, evalEnv);

    const mockHoldings = {
      activeHoldings: [
        {
          ticker: 'MSF.DE',
          type: 'EQUITY',
          currency: 'EUR',
          quantity: 10,
          currentPrice: 485.00,
          pmc: 400.00,
          marketValue: 4850.00,
          unrealizedPnl: 850.00,
          changePercent: 1.5,
          changeValue: 7.2,
          dayPnlEur: 72.0,
          quoteDate: new Date().toISOString().split('T')[0]
        },
        {
          ticker: 'VWCE.DE',
          type: 'ETF',
          currency: 'EUR',
          quantity: 50,
          currentPrice: 114.80,
          pmc: 100.00,
          marketValue: 5740.00,
          unrealizedPnl: 740.00,
          changePercent: -0.5,
          dayPnlEur: -28.7,
          quoteDate: new Date().toISOString().split('T')[0]
        }
      ]
    };

    // 1. All view renders category selector pills and dropdown
    const allHtml = evalEnv.renderCategoryQuotes(mockHoldings);
    assert.ok(allHtml.includes('data-catquotes-filter="ALL"'), 'Must have "Tutte" category filter pill');
    assert.ok(allHtml.includes('data-catquotes-filter="AZIONI_EUR"'), 'Must have AZIONI_EUR pill');
    assert.ok(allHtml.includes('data-catquotes-filter="ETF"'), 'Must have ETF pill');
    assert.ok(allHtml.includes('data-catquotes-select'), 'Must have category select dropdown');
    assert.ok(allHtml.includes('MSF.DE'), 'All view must show MSF.DE');
    assert.ok(allHtml.includes('VWCE.DE'), 'All view must show VWCE.DE');

    // 2. Filter to ETF only
    evalEnv.setFilterDirect('ETF');
    const etfHtml = evalEnv.renderCategoryQuotes(mockHoldings);
    assert.ok(etfHtml.includes('VWCE.DE'), 'Filtered view must include VWCE.DE');
    assert.ok(!etfHtml.includes('MSF.DE'), 'Filtered ETF view must not include MSF.DE');
  });

  test('WIDGET_RENDERERS.moversDay renders TOP WINNER / LOSER (1D) with % and Valore toggle (Photo 3)', () => {
    const code = fs.readFileSync(path.join(__dirname, '../public/dashboard.js'), 'utf8');

    const renderersMatch = code.match(/const WIDGET_RENDERERS = \{([\s\S]*?)\n  \};/);
    const evalEnv = vm.createContext({
      localStorage: {
        getItem: (k) => k === 'foliotrack_movers_mode' ? 'pct' : null,
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
      this.renderMoversDay = WIDGET_RENDERERS.moversDay;
    `, evalEnv);

    const now = new Date();
    const todayIso = now.toISOString().split('T')[0];

    const testData = {
      activeHoldings: [
        {
          ticker: 'XEO.DE',
          quoteDate: todayIso,
          regularMarketTime: `${todayIso}T10:00:00.000Z`,
          marketValue: 5000.00,
          changePercent: 0.0,
          dayPnlEur: 6.00
        },
        {
          ticker: 'NEXI.MI',
          quoteDate: todayIso,
          regularMarketTime: `${todayIso}T10:00:00.000Z`,
          marketValue: 5400.00,
          changePercent: -3.5,
          dayPnlEur: -189.00
        },
        {
          ticker: 'ISP.MI',
          quoteDate: todayIso,
          regularMarketTime: `${todayIso}T10:00:00.000Z`,
          marketValue: 12000.00,
          changePercent: -0.9,
          dayPnlEur: -115.00
        }
      ]
    };

    const html = evalEnv.renderMoversDay(testData);

    // 1. Header & Toggle
    assert.ok(html.includes('TOP WINNER / LOSER (1D)'), 'Header must read TOP WINNER / LOSER (1D)');
    assert.ok(html.includes('data-movers-mode="pct"'), 'Must have % toggle button');
    assert.ok(html.includes('data-movers-mode="val"'), 'Must have Valore toggle button');

    // 2. Columns
    assert.ok(html.includes('MIGLIORI (1D)'), 'Must have MIGLIORI (1D) column');
    assert.ok(html.includes('PEGGIORI (1D)'), 'Must have PEGGIORI (1D) column');

    // 3. Gainer XEO with +0.0% / +0,00% (+€ 6,00)
    assert.ok(html.includes('XEO.DE'), 'Gainer XEO must be present');
    assert.ok(html.includes('+0,00%') || html.includes('+0.00%') || html.includes('+0.0%'), 'Must report +0.0% or +0,00%');
    assert.ok(html.includes('+€ 6') || html.includes('+€ 6,00'), 'Must report +€ 6');

    // 4. Losers NEXI.MI and ISP.MI
    assert.ok(html.includes('NEXI.MI'), 'Loser NEXI must be present');
    assert.ok(html.includes('-3,50%') || html.includes('-3.50%'), 'Must report -3.50%');
    assert.ok(html.includes('-€ 189') || html.includes('-€ 189,00'), 'Must report -€ 189');
  });

  test('Mobile Dashboard HTML served at /?view=mobile includes 24 widgets in drawer and scripts', async () => {
    const res = await fetch(`${baseUrl}/?view=mobile`, {
      headers: {
        Authorization: `Bearer ${authToken}`,
        Cookie: `foliotrack_token=${authToken}`
      }
    });
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.ok(html.includes('grid-stack-2'), 'Must have grid-stack-2');
    assert.ok(html.includes('24 / 24'), 'Drawer count must be 24 / 24');
  });
});
