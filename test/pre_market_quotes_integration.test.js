const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const TEST_DB = path.join(__dirname, 'test_pre_market.db');
process.env.DB_PATH = TEST_DB;
process.env.JWT_SECRET = 'test-secret-pre-market';
process.env.ADMIN_PASSWORD = 'adminPassPreMarket123!';
process.env.NODE_ENV = 'test';

const { initDb, closeDb, getDb } = require('../src/db');
const { calculateHoldingsAndMetrics } = require('../src/utils/finance');

describe('Pre-Market Quotes Integration for Closed Exchanges Across Widgets', () => {
  before(() => {
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    initDb(TEST_DB);
  });

  after(() => {
    closeDb();
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  });

  test('Database schema includes preMarket and postMarket columns on assets table', () => {
    const db = getDb();
    const tableInfo = db.prepare('PRAGMA table_info(assets)').all();
    const columnNames = tableInfo.map(c => c.name);

    assert.ok(columnNames.includes('preMarketPrice'), 'preMarketPrice column missing');
    assert.ok(columnNames.includes('preMarketChange'), 'preMarketChange column missing');
    assert.ok(columnNames.includes('preMarketChangePercent'), 'preMarketChangePercent column missing');
    assert.ok(columnNames.includes('preMarketTime'), 'preMarketTime column missing');
    assert.ok(columnNames.includes('postMarketPrice'), 'postMarketPrice column missing');
    assert.ok(columnNames.includes('postMarketChange'), 'postMarketChange column missing');
    assert.ok(columnNames.includes('postMarketChangePercent'), 'postMarketChangePercent column missing');
    assert.ok(columnNames.includes('postMarketTime'), 'postMarketTime column missing');
  });

  test('calculateHoldingsAndMetrics computes preMarketPnlNative and preMarketPnlEur', () => {
    const transactions = [
      {
        id: 1,
        portfolioId: 1,
        assetTicker: 'NVDA',
        type: 'BUY',
        quantity: 10,
        price: 100.0,
        date: '2026-01-10T10:00:00Z',
        fees: 0
      }
    ];

    const assetsMap = {
      NVDA: {
        ticker: 'NVDA',
        name: 'NVIDIA Corp',
        type: 'EQUITY',
        currentPrice: 120.0,
        currency: 'USD',
        previousClose: 120.0,
        quoteDate: '2026-01-10',
        marketState: 'PRE',
        preMarketPrice: 126.50,
        preMarketChange: 6.50,
        preMarketChangePercent: 5.42,
        preMarketTime: '2026-01-11T12:00:00Z'
      }
    };

    const initialCash = 10000;
    // Portfolio EUR currency, fxRate USD -> EUR is 0.92
    const result = calculateHoldingsAndMetrics(transactions, assetsMap, initialCash, 'WAC', null, { 'USD/EUR': 0.92 });
    assert.equal(result.holdings.length, 1);
    const h = result.holdings[0];

    assert.equal(h.preMarketPrice, 126.50);
    assert.equal(h.preMarketChange, 6.50);
    assert.equal(h.preMarketChangePercent, 5.42);
    // 10 shares * 6.50 = 65.0 USD
    assert.equal(h.preMarketPnlNative, 65.0);
    // 65.0 USD * 0.92 = 59.8 EUR
    assert.ok(Math.abs(h.preMarketPnlEur - 59.8) < 0.001);
  });

  test('public/dashboard.js: categoryQuotes renders pre-market pill and pre-market price when exchange is closed', () => {
    const code = fs.readFileSync(path.join(__dirname, '../public/dashboard.js'), 'utf8');

    // Run isolated VM with helper functions and WIDGET_RENDERERS
    const renderersMatch = code.match(/const WIDGET_RENDERERS = \{([\s\S]*?)\n  \};/);
    assert.ok(renderersMatch, 'WIDGET_RENDERERS must be defined');

    const evalEnv = vm.createContext({
      isMobileDashboard: () => false,
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
      this.renderHoldingsCompact = WIDGET_RENDERERS.holdingsCompact;
      this.renderComposition = WIDGET_RENDERERS.composition;
      this.renderBreakdown = WIDGET_RENDERERS.breakdown;
      this.renderMoversDay = WIDGET_RENDERERS.moversDay;
      this.getHoldingPreMarketInfo = getHoldingPreMarketInfo;
    `, evalEnv);

    // Test getHoldingPreMarketInfo
    const closedHolding = {
      ticker: 'AAPL',
      type: 'EQUITY',
      currency: 'USD',
      exchange: 'NASDAQ',
      quoteDate: '2026-01-01', // old date -> market closed
      quantity: 5,
      currentPrice: 200.0,
      preMarketPrice: 208.50,
      preMarketChange: 8.50,
      preMarketChangePercent: 4.25,
      preMarketPnlNative: 42.50,
      preMarketPnlEur: 39.10,
      weight: 15.0
    };

    const preInfo = evalEnv.getHoldingPreMarketInfo(closedHolding);
    assert.equal(preInfo.hasPreMarket, true);
    assert.equal(preInfo.price, 208.50);
    assert.equal(preInfo.changePercent, 4.25);
    assert.equal(preInfo.pnlEur, 39.10);

    const mockData = {
      activeHoldings: [closedHolding]
    };

    // Category quotes
    const catHtml = evalEnv.renderCategoryQuotes(mockData);
    assert.ok(catHtml.includes('PRE'), 'categoryQuotes must display PRE badge');
    assert.ok(catHtml.includes('208,50'), 'categoryQuotes must display pre-market price');
    assert.ok(catHtml.includes('+4,25%'), 'categoryQuotes must display pre-market percentage');

    // Holdings compact
    const compactHtml = evalEnv.renderHoldingsCompact(mockData);
    assert.ok(compactHtml.includes('PRE'), 'holdingsCompact must display PRE pill badge');
    assert.ok(compactHtml.includes('+4,25%'), 'holdingsCompact must display pre-market percent');

    // Breakdown table
    const breakdownHtml = evalEnv.renderBreakdown(mockData);
    assert.ok(breakdownHtml.includes('PRE-MKT'), 'breakdown must display PRE-MKT badge for closed asset with pre-market');
    assert.ok(breakdownHtml.includes('PRE: 208,50 $'), 'breakdown must display PRE price');

    // Movers Day
    const moversHtml = evalEnv.renderMoversDay(mockData);
    assert.ok(moversHtml.includes('AAPL'), 'moversDay must include pre-market mover');
    assert.ok(moversHtml.includes('PRE'), 'moversDay must display PRE badge');
    assert.ok(moversHtml.includes('+4,25%'), 'moversDay must display pre-market gain percentage');
  });

  test('public/asset_drawer.js contains pre-market display elements and logic', () => {
    const code = fs.readFileSync(path.join(__dirname, '../public/asset_drawer.js'), 'utf8');

    assert.ok(code.includes('drawerPreMarketWrap'), 'asset_drawer.js must define drawerPreMarketWrap container');
    assert.ok(code.includes('drawerPreMarketText'), 'asset_drawer.js must define drawerPreMarketText element');
    assert.ok(code.includes('drawerMarketStateBadge'), 'asset_drawer.js must define drawerMarketStateBadge element');
    assert.ok(code.includes('preMarketPrice'), 'asset_drawer.js must check preMarketPrice');
    assert.ok(code.includes('PRE-MKT'), 'asset_drawer.js must badge PRE-MKT state');
  });

  test('public/analysis.js and src/routes/analysis.js support pre-market price display', () => {
    const routeCode = fs.readFileSync(path.join(__dirname, '../src/routes/analysis.js'), 'utf8');
    assert.ok(routeCode.includes('preMarketPrice'), 'routes/analysis.js must query and pass preMarketPrice');
    assert.ok(routeCode.includes('preMarketChangePercent'), 'routes/analysis.js must pass preMarketChangePercent');

    const analysisCode = fs.readFileSync(path.join(__dirname, '../public/analysis.js'), 'utf8');
    assert.ok(analysisCode.includes('preMarketPrice'), 'public/analysis.js must check preMarketPrice');
    assert.ok(analysisCode.includes('PRE:'), 'public/analysis.js must format PRE price in table and modal');
  });
});
