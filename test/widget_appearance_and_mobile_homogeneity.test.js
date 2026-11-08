const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const http = require('http');

const TEST_DB = path.join(__dirname, 'test_widget_appearance.db');
process.env.DB_PATH = TEST_DB;
process.env.JWT_SECRET = 'test-secret-widget-appearance-homogeneity';
process.env.ADMIN_PASSWORD = 'adminPassAppearance123!';
process.env.NODE_ENV = 'test';

const { initDb, closeDb } = require('../src/db');
const app = require('../src/app');

let server;
let baseUrl;
let authToken;

describe('Widget Appearance, Typography Scaling & Mobile Homogeneity', () => {
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

    // Log in as default admin
    const res = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'admin',
        password: 'adminPassAppearance123!'
      })
    });
    const data = await res.json();
    assert.equal(data.success, true);
    authToken = data.token;
  });

  after(() => {
    if (server) server.close();
    closeDb();
    if (fs.existsSync(TEST_DB)) {
      try { fs.unlinkSync(TEST_DB); } catch (_) {}
    }
    const wal = TEST_DB + '-wal';
    const shm = TEST_DB + '-shm';
    if (fs.existsSync(wal)) try { fs.unlinkSync(wal); } catch (_) {}
    if (fs.existsSync(shm)) try { fs.unlinkSync(shm); } catch (_) {}
  });

  test('Theme & Widget Typography Engine in public/theme.js', () => {
    const code = fs.readFileSync(path.join(__dirname, '../public/theme.js'), 'utf8');

    // Verify core storage keys and exported functions
    assert.ok(code.includes('foliotrack_widget_font_family'), 'Must define widget font family key');
    assert.ok(code.includes('foliotrack_widget_font_size'), 'Must define widget font size key');
    assert.ok(code.includes('foliotrack_widget_font_variant'), 'Must define widget font variant key');
    assert.ok(code.includes('foliotrack_widget_font_weight'), 'Must define widget font weight key');
    assert.ok(code.includes('window.getWidgetTypography'), 'Must expose getWidgetTypography');
    assert.ok(code.includes('window.setWidgetTypography'), 'Must expose setWidgetTypography');
    assert.ok(code.includes('widgetTypographyChanged'), 'Must dispatch widgetTypographyChanged event');

    // Run isolated VM test
    const storage = {};
    const rootProps = {};
    const mockWindow = {
      matchMedia: () => ({ matches: false, addEventListener: () => {} })
    };
    const mockDocument = {
      documentElement: {
        classList: {
          contains: () => false,
          add: () => {},
          remove: () => {}
        },
        style: {
          setProperty: (k, v) => { rootProps[k] = v; }
        }
      },
      dispatchEvent: () => {},
      querySelectorAll: () => [],
      addEventListener: () => {}
    };

    const evalEnv = vm.createContext({
      window: mockWindow,
      document: mockDocument,
      localStorage: {
        getItem: (k) => storage[k] || null,
        setItem: (k, v) => { storage[k] = v; },
        removeItem: (k) => { delete storage[k]; }
      },
      CustomEvent: function (event, opts) { this.event = event; this.detail = opts ? opts.detail : null; },
      console: console,
      fetch: () => Promise.resolve({ json: () => Promise.resolve({ success: true }) })
    });

    vm.runInContext(code, evalEnv);

    assert.ok(typeof evalEnv.window.getWidgetTypography === 'function', 'getWidgetTypography must be exposed');
    assert.ok(typeof evalEnv.window.setWidgetTypography === 'function', 'setWidgetTypography must be exposed');

    // Default values check
    const def = evalEnv.window.getWidgetTypography();
    assert.equal(def.fontFamily, 'inter');
    assert.equal(def.fontSize, 'standard');
    assert.equal(def.fontVariant, 'tabular-mono');
    assert.equal(def.fontWeight, 'balanced');

    // Set new typography
    evalEnv.window.setWidgetTypography({
      fontFamily: 'plus-jakarta',
      fontSize: 'compact',
      fontVariant: 'proportional',
      fontWeight: 'bold'
    });

    const updated = evalEnv.window.getWidgetTypography();
    assert.equal(updated.fontFamily, 'plus-jakarta');
    assert.equal(updated.fontSize, 'compact');
    assert.equal(updated.fontVariant, 'proportional');
    assert.equal(updated.fontWeight, 'bold');

    // Verify CSS variables set on root
    assert.ok(rootProps['--ft-widget-font-family'].includes('Plus Jakarta Sans'));
    assert.equal(rootProps['--ft-widget-font-scale'], 0.9);
    assert.equal(rootProps['--ft-widget-font-weight-title'], '700');
    assert.equal(rootProps['--ft-widget-font-weight-val'], '800');
  });

  test('Desktop Settings UI (private_views/settings.html) includes Widget Typography card and controls', async () => {
    const res = await fetch(`${baseUrl}/settings?view=desktop`, {
      headers: {
        Authorization: `Bearer ${authToken}`,
        Cookie: `foliotrack_token=${authToken}`
      }
    });
    assert.equal(res.status, 200);
    const html = await res.text();

    assert.ok(html.includes('Tipografia & Font dei Widget'), 'Desktop settings must render widget typography section');
    assert.ok(html.includes('widget-font-family-select'), 'Desktop settings must have font family select');
    assert.ok(html.includes('widget-font-size-select'), 'Desktop settings must have font size select');
    assert.ok(html.includes('widget-font-variant-select'), 'Desktop settings must have font variant select');
    assert.ok(html.includes('widget_font_weight'), 'Desktop settings must have font weight radio options');
    assert.ok(html.includes('widget-typography-preview'), 'Desktop settings must have live preview card');
    assert.ok(html.includes('btn-save-widget-typography'), 'Desktop settings must have save typography button');
  });

  test('Mobile Settings UI (private_views/settings_mobile.html) includes Widget Typography card and controls', async () => {
    const res = await fetch(`${baseUrl}/settings?view=mobile`, {
      headers: {
        Authorization: `Bearer ${authToken}`,
        Cookie: `foliotrack_token=${authToken}`
      }
    });
    assert.equal(res.status, 200);
    const html = await res.text();

    assert.ok(html.includes('Tipografia & Font Widget'), 'Mobile settings must render widget typography section');
    assert.ok(html.includes('widget-font-family-select'), 'Mobile settings must have font family select');
    assert.ok(html.includes('widget-font-size-select'), 'Mobile settings must have font size select');
    assert.ok(html.includes('widget-font-variant-select'), 'Mobile settings must have font variant select');
    assert.ok(html.includes('widget_font_weight'), 'Mobile settings must have font weight radio options');
    assert.ok(html.includes('widget-typography-preview'), 'Mobile settings must have live preview card');
    assert.ok(html.includes('btn-save-widget-typography'), 'Mobile settings must have save typography button');
  });

  test('Mobile Dashboard (private_views/dashboard_mobile.html) defines homogeneous styles and font scaling', async () => {
    const res = await fetch(`${baseUrl}/?view=mobile`, {
      headers: {
        Authorization: `Bearer ${authToken}`,
        Cookie: `foliotrack_token=${authToken}`
      }
    });
    assert.equal(res.status, 200);
    const html = await res.text();

    assert.ok(html.includes('--ft-widget-font-family'), 'Mobile view CSS must reference --ft-widget-font-family');
    assert.ok(html.includes('--ft-widget-font-scale'), 'Mobile view CSS must reference --ft-widget-font-scale');
    assert.ok(html.includes('.grid-stack-item[gs-w="1"] .signature-card'), 'Mobile view must style 1-column cards');
    assert.ok(html.includes('.grid-stack-item[gs-w="2"] .signature-card'), 'Mobile view must style 2-column cards');
  });

  test('API endpoints: PUT and GET /api/settings persist widget typography preferences', async () => {
    const putRes = await fetch(`${baseUrl}/api/settings`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`,
        Cookie: `foliotrack_token=${authToken}`
      },
      body: JSON.stringify({
        widget_font_family: 'plus-jakarta',
        widget_font_size: 'large',
        widget_font_variant: 'tabular-mono',
        widget_font_weight: 'bold'
      })
    });
    const putData = await putRes.json();
    assert.equal(putData.success, true);

    const getRes = await fetch(`${baseUrl}/api/settings`, {
      headers: {
        Authorization: `Bearer ${authToken}`,
        Cookie: `foliotrack_token=${authToken}`
      }
    });
    const getData = await getRes.json();
    assert.equal(getData.success, true);
    assert.equal(getData.settings.widget_font_family, 'plus-jakarta');
    assert.equal(getData.settings.widget_font_size, 'large');
    assert.equal(getData.settings.widget_font_variant, 'tabular-mono');
    assert.equal(getData.settings.widget_font_weight, 'bold');
  });

  test('public/dashboard.js homogenizes dayChange and pnl cards with matching layouts and colors', () => {
    const code = fs.readFileSync(path.join(__dirname, '../public/dashboard.js'), 'utf8');

    // Verify dayChange and pnl use unified clean layout and emerald/rose palettes
    assert.ok(code.includes("dayChange: (data) => {"), 'dayChange renderer must exist');
    assert.ok(code.includes("pnl: (data) => {"), 'pnl renderer must exist');
    assert.ok(code.includes("widgetTypographyChanged"), 'dashboard.js must listen to widgetTypographyChanged');

    // Test rendering in mock environment
    const renderersMatch = code.match(/const WIDGET_RENDERERS = \{([\s\S]*?)\n  \};/);
    const evalEnv = vm.createContext({
      localStorage: { getItem: () => null, setItem: () => {} },
      document: { getElementById: () => null, querySelector: () => ({}) },
      activeTwrrPeriod: '1Y'
    });

    vm.runInContext(`
      ${code.substring(code.indexOf('function formatEur'), code.indexOf('const WIDGET_RENDERERS'))}
      const WIDGET_RENDERERS = {
        ${renderersMatch[1]}
      };
      this.formatEur = formatEur;
      this.formatEurSigned = formatEurSigned;
      this.renderDayChange = WIDGET_RENDERERS.dayChange;
      this.renderPnl = WIDGET_RENDERERS.pnl;
    `, evalEnv);

    // Verify formatEur and formatEurSigned format thousands as k (e.g. 410532 -> 410,5k, 1500 -> 1,5k)
    assert.equal(evalEnv.formatEur(410532), '410,5k', '410532 must format as 410,5k');
    assert.equal(evalEnv.formatEur(1500), '1,5k', '1500 must format as 1,5k');
    assert.equal(evalEnv.formatEur(24356), '24,4k', '24356 must format with 1 decimal k');
    assert.equal(evalEnv.formatEur(96), '€ 96', 'Values < 1000 must keep normal euro format');
    assert.equal(evalEnv.formatEurSigned(1500), '+1,5k', 'Positive 1500 signed must be +1,5k');
    assert.equal(evalEnv.formatEurSigned(-1500), '-1,5k', 'Negative 1500 signed must be -1,5k');

    const mockData = {
      totals: {
        totalValue: 100000,
        dayPnl: 1500,
        dayPnlPercent: 1.5,
        unrealizedPnl: 12000,
        unrealizedPnlPercent: 12.0
      },
      isAggregate: true
    };

    const dayHtml = evalEnv.renderDayChange(mockData);
    const pnlHtml = evalEnv.renderPnl(mockData);

    assert.ok(dayHtml.includes('Var. Oggi') || dayHtml.includes('Variazione Oggi'), 'dayChange must have title');
    assert.ok(dayHtml.includes('1,5') || dayHtml.includes('1.5'), 'dayChange must render % badge');
    assert.ok(dayHtml.includes('+1,5k'), 'dayChange must format thousands with k (+1,5k)');
    assert.ok(dayHtml.includes('text-emerald-600 dark:text-emerald-400'), 'dayChange must use unified emerald text');

    assert.ok(pnlHtml.includes('P&L Tot.') || pnlHtml.includes('P&L Totale'), 'pnl must have title');
    assert.ok(pnlHtml.includes('12') || dayHtml.includes('12.0%'), 'pnl must render % badge');
    assert.ok(pnlHtml.includes('12,0k'), 'pnl must format thousands with k (12,0k)');
    assert.ok(pnlHtml.includes('text-emerald-600 dark:text-emerald-400'), 'pnl must use unified emerald text');
  });

  test('Dashboard widgets reflect shortened labels (P.Lordo, MWRR, TWRR, P&L Tot., DD) and mobile performanceChart layout', () => {
    const code = fs.readFileSync(path.join(__dirname, '../public/dashboard.js'), 'utf8');

    // Verify shortened titles in renderers
    const renderersMatch = code.match(/const WIDGET_RENDERERS = \{([\s\S]*?)\n  \};/);
    const evalEnv = vm.createContext({
      localStorage: { getItem: () => null, setItem: () => {} },
      document: { getElementById: () => null, querySelector: () => ({}) },
      activeTwrrPeriod: '1Y'
    });

    vm.runInContext(`
      ${code.substring(code.indexOf('function formatEur'), code.indexOf('const WIDGET_RENDERERS'))}
      const WIDGET_RENDERERS = {
        ${renderersMatch[1]}
      };
      this.renderValue = WIDGET_RENDERERS.value;
      this.renderPnl = WIDGET_RENDERERS.pnl;
      this.renderTwrr = WIDGET_RENDERERS.twrr;
      this.renderMwrr = WIDGET_RENDERERS.mwrr;
      this.renderDrawdown = WIDGET_RENDERERS.drawdown;
    `, evalEnv);

    const mockData = {
      totals: { totalValue: 418200, unrealizedPnlPercent: 5.5, unrealizedPnl: 22000 },
      metrics: { twr: 12.4, twr1y: 10.2, xirr: 11.5, maxDrawdown: 4.8, currentDrawdown: 1.2 },
      isAggregate: true
    };

    const valHtml = evalEnv.renderValue(mockData);
    const pnlHtml = evalEnv.renderPnl(mockData);
    const twrrHtml = evalEnv.renderTwrr(mockData);
    const mwrrHtml = evalEnv.renderMwrr(mockData);
    const ddHtml = evalEnv.renderDrawdown(mockData);

    assert.ok(valHtml.includes('P.Lordo'), 'PATRIMONIO must be abbreviated to P.Lordo');
    assert.ok(pnlHtml.includes('P&L Tot.'), 'P&L TOTALE must be abbreviated to P&L Tot.');
    assert.ok(twrrHtml.includes('TWRR'), 'REND TWRR must be abbreviated to TWRR');
    assert.ok(mwrrHtml.includes('MWRR'), 'REND MWRR must be abbreviated to MWRR');
    assert.ok(ddHtml.includes('DD'), 'DRAWDOWN must be abbreviated to DD');

    // Verify performanceChart mobile layout height is increased to h: 6 for full mobile display
    assert.ok(code.includes("id: 'performanceChart', name: 'Andamento Patrimonio & Performance', category: 'Grafici', w: 2, h: 6"), 'performanceChart mobile default layout must have h: 6');
  });
});
