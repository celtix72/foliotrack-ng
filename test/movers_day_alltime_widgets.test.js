const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

describe('Movers Widgets: Movers Giornalieri (1D) vs Movers All-Time', () => {
  let dashboardCode;
  let mockWindow;

  function createSandbox() {
    dashboardCode = fs.readFileSync(path.join(__dirname, '../public/dashboard.js'), 'utf8');

    // Create browser mock environment
    mockWindow = {
      GridStack: {
        init: () => ({
          destroy: () => {},
          on: () => {},
          save: () => [],
          load: () => {},
          getGridItems: () => []
        })
      },
      Chart: function() {},
      localStorage: {
        getItem: () => null,
        setItem: () => {},
        removeItem: () => {}
      },
      document: {
        querySelector: () => null,
        querySelectorAll: () => [],
        getElementById: () => null,
        addEventListener: () => {}
      },
      setTimeout: (fn) => setTimeout(fn, 0),
      clearTimeout: (id) => clearTimeout(id)
    };

    const context = vm.createContext({
      window: mockWindow,
      document: mockWindow.document,
      localStorage: mockWindow.localStorage,
      GridStack: mockWindow.GridStack,
      Chart: mockWindow.Chart,
      setTimeout: mockWindow.setTimeout,
      clearTimeout: mockWindow.clearTimeout,
      fetch: async () => ({ ok: true, json: async () => ({}) }),
      console: { log: () => {}, warn: () => {}, error: () => {} }
    });

    return context;
  }

  test('WIDGET_DEFINITIONS contains moversDay and moversAllTime with 22 total widgets', () => {
    const code = fs.readFileSync(path.join(__dirname, '../public/dashboard.js'), 'utf8');

    assert.ok(code.includes("id: 'moversDay'"), "moversDay must be in WIDGET_DEFINITIONS");
    assert.ok(code.includes("id: 'moversAllTime'"), "moversAllTime must be in WIDGET_DEFINITIONS");
    assert.ok(code.includes("name: 'Movers Giornalieri (1D)'"));
    assert.ok(code.includes("name: 'Movers All-Time'"));
  });

  test('moversDay filters holdings strictly for current trading day and excludes previous days', () => {
    const now = new Date();
    const todayIso = now.toISOString().split('T')[0];
    const prevDate = '2026-11-03';

    const testData = {
      activeHoldings: [
        {
          ticker: 'NOV.DE',
          quoteDate: todayIso,
          regularMarketTime: `${todayIso}T10:47:35.000Z`,
          marketValue: 3705.00,
          changePercent: 2.66,
          dayPnlEur: 96.00,
          unrealizedPnl: 450.00,
          unrealizedPnlPercent: 13.82
        },
        {
          ticker: 'PRX.AS',
          quoteDate: todayIso,
          regularMarketTime: `${todayIso}T10:47:00.000Z`,
          marketValue: 4573.90,
          changePercent: 2.11,
          dayPnlEur: 94.61,
          unrealizedPnl: 320.00,
          unrealizedPnlPercent: 7.52
        },
        {
          ticker: 'MSFT',
          quoteDate: prevDate, // Yesterday's quote (US market not opened today)
          regularMarketTime: `${prevDate}T21:00:00.000Z`,
          marketValue: 12500.00,
          changePercent: 4.50,
          dayPnlEur: 540.00,
          unrealizedPnl: 2800.00,
          unrealizedPnlPercent: 28.87
        },
        {
          ticker: 'TSLA',
          quoteDate: prevDate, // Yesterday's quote
          regularMarketTime: `${prevDate}T21:00:00.000Z`,
          marketValue: 8000.00,
          changePercent: -3.20,
          dayPnlEur: -264.00,
          unrealizedPnl: -500.00,
          unrealizedPnlPercent: -5.88
        }
      ]
    };

    // Extract WIDGET_RENDERERS and helper functions from public/dashboard.js
    const code = fs.readFileSync(path.join(__dirname, '../public/dashboard.js'), 'utf8');

    // Run in VM with extracted scope
    const script = new vm.Script(`
      ${code}
    `);
    const ctx = createSandbox();
    script.runInContext(ctx);

    // Test extraction via regex/eval on WIDGET_RENDERERS
    const renderersMatch = code.match(/const WIDGET_RENDERERS = \{([\s\S]*?)\n  \};/);
    assert.ok(renderersMatch, 'WIDGET_RENDERERS must be defined');

    const helpersMatch = code.match(/function formatEur[\s\S]*?function getDayVarCardStyle/);
    assert.ok(helpersMatch, 'formatEur and helpers must be present');

    // Evaluate in an isolated sub-context
    const evalEnv = vm.createContext({});
    vm.runInContext(`
      ${code.substring(code.indexOf('function formatEur'), code.indexOf('const WIDGET_RENDERERS'))}
      const WIDGET_RENDERERS = {
        ${renderersMatch[1]}
      };
      this.renderDay = WIDGET_RENDERERS.moversDay;
      this.renderAllTime = WIDGET_RENDERERS.moversAllTime;
    `, evalEnv);

    const htmlDay = evalEnv.renderDay(testData);

    // NOV.DE and PRX.AS should be included
    assert.ok(htmlDay.includes('NOV.DE'), 'NOV.DE should be included in moversDay');
    assert.ok(htmlDay.includes('+2,66%') || htmlDay.includes('+2.66%'), 'NOV.DE % variation should be reported');
    assert.ok(htmlDay.includes('+€ 96,00'), 'NOV.DE monetary variation of total position should be reported');

    assert.ok(htmlDay.includes('PRX.AS'), 'PRX.AS should be included in moversDay');
    assert.ok(htmlDay.includes('+2,11%') || htmlDay.includes('+2.11%'), 'PRX.AS % variation should be reported');
    assert.ok(htmlDay.includes('+€ 94,61'), 'PRX.AS monetary variation of total position should be reported');

    // MSFT and TSLA from previous day MUST be excluded!
    assert.ok(!htmlDay.includes('MSFT'), 'MSFT from previous day must be excluded from moversDay');
    assert.ok(!htmlDay.includes('TSLA'), 'TSLA from previous day must be excluded from moversDay');

    // Also check moversAllTime includes MSFT and TSLA
    const htmlAllTime = evalEnv.renderAllTime(testData);
    assert.ok(htmlAllTime.includes('MSFT'), 'MSFT should be included in moversAllTime');
    assert.ok(htmlAllTime.includes('TSLA'), 'TSLA should be included in moversAllTime');
    assert.ok(htmlAllTime.includes('+28,87%') || htmlAllTime.includes('+28.87%'), 'MSFT all-time % gain should be reported');
    assert.ok(htmlAllTime.includes('-5,88%') || htmlAllTime.includes('-5.88%'), 'TSLA all-time % loss should be reported');
  });

  test('moversDay handles empty state when no titles have traded today', () => {
    const code = fs.readFileSync(path.join(__dirname, '../public/dashboard.js'), 'utf8');
    const renderersMatch = code.match(/const WIDGET_RENDERERS = \{([\s\S]*?)\n  \};/);

    const evalEnv = vm.createContext({});
    vm.runInContext(`
      ${code.substring(code.indexOf('function formatEur'), code.indexOf('const WIDGET_RENDERERS'))}
      const WIDGET_RENDERERS = {
        ${renderersMatch[1]}
      };
      this.renderDay = WIDGET_RENDERERS.moversDay;
    `, evalEnv);

    // Pass holdings that were all quoted on an old date
    const testData = {
      activeHoldings: [
        { ticker: 'OLD1', quoteDate: '2026-10-01', changePercent: 1.5, dayPnlEur: 20 },
        { ticker: 'OLD2', quoteDate: '2026-10-02', changePercent: -2.0, dayPnlEur: -40 }
      ]
    };

    const html = evalEnv.renderDay(testData);
    assert.ok(html.includes('Nessun titolo con scambi nella seduta odierna'), 'Should display empty state for today');
  });
});

