const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

describe('Category Gains Widget: Gain Categorie (Aperte / Chiuse)', () => {
  let evalEnv;

  function setupEnvironment() {
    const code = fs.readFileSync(path.join(__dirname, '../public/dashboard.js'), 'utf8');

    evalEnv = vm.createContext({
      localStorage: {
        _store: {},
        getItem(k) { return this._store[k] || null; },
        setItem(k, v) { this._store[k] = String(v); },
        removeItem(k) { delete this._store[k]; }
      },
      document: {
        getElementById: () => null,
        querySelector: () => ({}),
        querySelectorAll: () => [],
        addEventListener: () => {}
      },
      window: {
        FolioTrackDashboard: {}
      },
      console: { log: () => {}, warn: () => {}, error: () => {} }
    });

    // Execute dashboard code in VM sandbox
    vm.runInContext(code, evalEnv);
  }

  test('public/dashboard.js registers categoryGains in WIDGET_DEFINITIONS and MOBILE_DEFAULT_LAYOUT', () => {
    const code = fs.readFileSync(path.join(__dirname, '../public/dashboard.js'), 'utf8');

    assert.ok(code.includes("id: 'categoryGains'"), 'categoryGains must be in WIDGET_DEFINITIONS');
    assert.ok(code.includes("name: 'Gain Categorie (Aperte / Chiuse)'"), 'Descriptive Italian name must be defined');
    assert.ok(code.includes("{ id: 'categoryGains', name: 'Gain Categorie (Aperte / Chiuse)'"), 'Must be in MOBILE_DEFAULT_LAYOUT');
  });

  test('groupGainsByCategory aggregates open holdings, closed positions and mixed positions correctly', () => {
    setupEnvironment();
    const groupGainsByCategory = evalEnv.window.FolioTrackDashboard.groupGainsByCategory;
    assert.equal(typeof groupGainsByCategory, 'function', 'groupGainsByCategory must be exposed');

    const mockOpenHoldings = [
      // Open position only
      {
        ticker: 'MSF.DE',
        type: 'EQUITY',
        currency: 'EUR',
        quantity: 10,
        totalCost: 4000.00,
        marketValue: 4850.00,
        unrealizedPnl: 850.00
      },
      // Mixed position (open part)
      {
        ticker: 'ISP.MI',
        type: 'EQUITY',
        currency: 'EUR',
        quantity: 1000,
        totalCost: 2500.00,
        marketValue: 3700.00,
        unrealizedPnl: 1200.00
      },
      // ETF Open
      {
        ticker: 'VWCE.DE',
        type: 'ETF',
        currency: 'EUR',
        quantity: 50,
        totalCost: 5000.00,
        marketValue: 5740.00,
        unrealizedPnl: 740.00
      }
    ];

    const mockClosedPositions = [
      // Mixed position (closed part)
      {
        ticker: 'ISP.MI',
        type: 'EQUITY',
        currency: 'EUR',
        quantity: 500,
        costBasis: 1200.00,
        proceeds: 1500.00,
        realizedPnl: 300.00
      },
      // Closed position only
      {
        ticker: 'TSLA',
        type: 'EQUITY',
        currency: 'USD',
        quantity: 20,
        costBasis: 3000.00,
        proceeds: 3600.00,
        realizedPnl: 600.00
      }
    ];

    const categories = groupGainsByCategory(mockOpenHoldings, mockClosedPositions);

    // Verify category classification
    assert.ok(categories.length >= 3, 'Must contain at least AZIONI EUR, ETF, AZIONI USD');
    const azEur = categories.find(c => c.key === 'AZIONI EUR');
    const etf = categories.find(c => c.key === 'ETF');
    const azUsd = categories.find(c => c.key === 'AZIONI USD');

    assert.ok(azEur, 'AZIONI EUR must exist');
    assert.ok(etf, 'ETF must exist');
    assert.ok(azUsd, 'AZIONI USD must exist');

    // Check items in AZIONI EUR (MSF.DE open, ISP.MI mixed)
    const msf = azEur.items.find(i => i.ticker === 'MSF.DE');
    const isp = azEur.items.find(i => i.ticker === 'ISP.MI');

    assert.ok(msf, 'MSF.DE must be in AZIONI EUR');
    assert.equal(msf.status, 'APERTA');
    assert.equal(msf.hasOpen, true);
    assert.equal(msf.hasClosed, false);
    assert.equal(msf.openGain, 850.00);
    assert.equal(msf.closedGain, 0);
    assert.equal(msf.totalGain, 850.00);
    assert.equal(msf.openPct.toFixed(1), '21.3');

    assert.ok(isp, 'ISP.MI must be in AZIONI EUR');
    assert.equal(isp.status, 'MISTA');
    assert.equal(isp.hasOpen, true);
    assert.equal(isp.hasClosed, true);
    assert.equal(isp.openGain, 1200.00);
    assert.equal(isp.closedGain, 300.00);
    assert.equal(isp.totalGain, 1500.00);
    assert.equal(isp.totalCost, 3700.00);
    assert.equal(isp.totalPct.toFixed(2), '40.54');

    // Check closed only position in AZIONI USD (TSLA)
    const tsla = azUsd.items.find(i => i.ticker === 'TSLA');
    assert.ok(tsla, 'TSLA must be in AZIONI USD');
    assert.equal(tsla.status, 'CHIUSA');
    assert.equal(tsla.hasOpen, false);
    assert.equal(tsla.hasClosed, true);
    assert.equal(tsla.openGain, 0);
    assert.equal(tsla.closedGain, 600.00);
    assert.equal(tsla.totalGain, 600.00);
  });

  test('WIDGET_RENDERERS.categoryGains renders accordion, KPIs, pills, and 4-column rows', () => {
    setupEnvironment();
    const render = evalEnv.window.FolioTrackDashboard.WIDGET_RENDERERS.categoryGains;
    assert.equal(typeof render, 'function', 'WIDGET_RENDERERS.categoryGains must exist');

    // Empty state
    const emptyHtml = render({ activeHoldings: [], closedPositions: [] });
    assert.ok(emptyHtml.includes('Nessuna posizione aperta o chiusa'), 'Must render empty state message');

    const testData = {
      activeHoldings: [
        {
          ticker: 'MSF.DE',
          type: 'EQUITY',
          currency: 'EUR',
          quantity: 10,
          totalCost: 4000.00,
          marketValue: 4850.00,
          unrealizedPnl: 850.00
        },
        {
          ticker: 'ISP.MI',
          type: 'EQUITY',
          currency: 'EUR',
          quantity: 1000,
          totalCost: 2500.00,
          marketValue: 3700.00,
          unrealizedPnl: 1200.00
        }
      ],
      closedPositions: [
        {
          ticker: 'ISP.MI',
          type: 'EQUITY',
          currency: 'EUR',
          quantity: 500,
          costBasis: 1200.00,
          proceeds: 1500.00,
          realizedPnl: 300.00
        },
        {
          ticker: 'NEXI.MI',
          type: 'EQUITY',
          currency: 'EUR',
          quantity: 200,
          costBasis: 1400.00,
          proceeds: 1100.00,
          realizedPnl: -300.00
        }
      ]
    };

    const html = render(testData);

    // 1. Scope summary and KPIs
    assert.ok(html.includes('Gain Categorie'), 'Must contain header title');
    assert.ok(html.includes('APERTO'), 'Must contain APERTO scope label');
    assert.ok(html.includes('CHIUSO'), 'Must contain CHIUSO scope label');
    assert.ok(html.includes('TOTALE'), 'Must contain TOTALE scope label');

    // 2. Filter Pills and Status Selectors
    assert.ok(html.includes('data-catgains-filter="ALL"'), 'Must have Tutte category filter pill');
    assert.ok(html.includes('data-catgains-select'), 'Must have category select dropdown');
    assert.ok(html.includes('data-catgains-status="ALL"'), 'Must have status filter Tutti');
    assert.ok(html.includes('data-catgains-status="OPEN"'), 'Must have status filter Aperte');
    assert.ok(html.includes('data-catgains-status="CLOSED"'), 'Must have status filter Chiuse');

    // 3. Table Column Headers
    assert.ok(html.includes('TICKER / STATO'), 'Must have TICKER / STATO header');
    assert.ok(html.includes('GAIN APERTO'), 'Must have GAIN APERTO header');
    assert.ok(html.includes('GAIN CHIUSO'), 'Must have GAIN CHIUSO header');
    assert.ok(html.includes('GAIN TOTALE'), 'Must have GAIN TOTALE header');

    // 4. Accordion Category Banner matching #FEF9C3
    assert.ok(html.includes('style="background-color: #FEF9C3;"'), 'Must have signature yellow accordion header banner');
    assert.ok(html.includes('data-toggle-category-gains="AZIONI_EUR"'), 'Must have category accordion toggle attribute');

    // 5. Items and Status Badges
    assert.ok(html.includes('data-open-asset="MSF.DE"'), 'MSF.DE must have open asset drawer attribute');
    assert.ok(html.includes('data-open-asset="ISP.MI"'), 'ISP.MI must have open asset drawer attribute');
    assert.ok(html.includes('data-open-asset="NEXI.MI"'), 'NEXI.MI must have open asset drawer attribute');

    // Check status badges: AP for MSF, MIX for ISP, CH for NEXI
    assert.ok(html.includes('>AP</span>'), 'Must display AP badge for open position');
    assert.ok(html.includes('>MIX</span>'), 'Must display MIX badge for mixed position');
    assert.ok(html.includes('>CH</span>'), 'Must display CH badge for closed position');

    // Total Gain numbers formatted
    assert.ok(html.includes('+1,5k €') || html.includes('+1.500 €'), 'ISP.MI total gain must be formatted');
    assert.ok(html.includes('+850 €'), 'MSF.DE total gain must be +850 €');
    assert.ok(html.includes('-300 €'), 'NEXI.MI total loss must be -300 €');
  });
});
