const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const http = require('http');

const TEST_DB = path.join(__dirname, 'test_perfmatrix_widget.db');
process.env.DB_PATH = TEST_DB;
process.env.JWT_SECRET = 'test-secret-perfmatrix-widget';
process.env.ADMIN_PASSWORD = 'adminPassPerfMatrix123!';
process.env.ADMIN_USERNAME = 'admin';
process.env.NODE_ENV = 'test';

const { initDb, closeDb } = require('../src/db');
const app = require('../src/app');

let server;
let baseUrl;
let authToken;

describe('Performance Matrix Compact Redesign (matching categoryQuotes density)', () => {
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
      body: JSON.stringify({ username: 'admin', password: 'adminPassPerfMatrix123!' })
    });
    const loginData = await loginRes.json();
    authToken = loginData.token;
  });

  after(() => {
    if (server) server.close();
    closeDb();
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  });

  test('public/dashboard.js defines compact performanceMatrix layout and functions', () => {
    const code = fs.readFileSync(path.join(__dirname, '../public/dashboard.js'), 'utf8');

    assert.ok(code.includes("id: 'performanceMatrix'"), 'performanceMatrix must be in WIDGET_DEFINITIONS');
    assert.ok(code.includes("performanceMatrix:"), 'performanceMatrix renderer must exist');
    assert.ok(code.includes('-m-2 sm:-m-3'), 'Must have flush outer container margin offset like categoryQuotes');
    assert.ok(code.includes('data-perfmatrix-filter'), 'Must support data-perfmatrix-filter pill buttons');
    assert.ok(code.includes('data-perfmatrix-select'), 'Must support data-perfmatrix-select dropdown');
    assert.ok(code.includes('setPerfMatrixFilter'), 'Must define setPerfMatrixFilter');
    assert.ok(code.includes('py-[2px]'), 'Must use ultra-compact py-[2px] row density');
    assert.ok(code.includes('grid-template-columns: 1.25fr 1.15fr 1.2fr 1.1fr'), 'Must use 4-column balanced grid layout');
  });

  test('private_views/dashboard_mobile.html applies matching ultra-compact card padding to performanceMatrix', () => {
    const mobileHtml = fs.readFileSync(path.join(__dirname, '../private_views/dashboard_mobile.html'), 'utf8');
    assert.ok(mobileHtml.includes('.grid-stack-item[gs-id="performanceMatrix"] .signature-card'),
      'Mobile CSS must target performanceMatrix signature-card for compact padding');
    assert.ok(mobileHtml.includes('padding: 0.5rem 0.35rem !important;'),
      'Must apply 0.5rem 0.35rem padding identical to categoryQuotes');
  });

  test('WIDGET_RENDERERS.performanceMatrix generates compact 4-column rows and handles filters', () => {
    const code = fs.readFileSync(path.join(__dirname, '../public/dashboard.js'), 'utf8');

    const renderersMatch = code.match(/const WIDGET_RENDERERS = \{([\s\S]*?)\n  \};/);
    assert.ok(renderersMatch, 'WIDGET_RENDERERS must be defined');

    const evalEnv = vm.createContext({
      localStorage: {
        getItem: (k) => null,
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
      this.renderPerformanceMatrix = WIDGET_RENDERERS.performanceMatrix;
      this.setFilter = (f) => { activePerfMatrixFilter = f; };
    `, evalEnv);

    assert.ok(typeof evalEnv.renderPerformanceMatrix === 'function', 'performanceMatrix renderer must be a function');

    const mockData = {
      performanceMetrics: {
        twr: {
          '1M': 2.45,
          '3M': -1.82,
          '6M': 5.12,
          '1Y': 14.80,
          '3Y': 32.50,
          '5Y': 68.20,
          'ALL': 75.40
        },
        periodGain: {
          '1M': 1250,
          '3M': -850,
          '6M': 2400,
          '1Y': 6500,
          '3Y': 15200,
          '5Y': 28900,
          'ALL': 35400
        }
      }
    };

    // 1. Render all 7 periods by default
    const fullHtml = evalEnv.renderPerformanceMatrix(mockData);
    assert.ok(fullHtml.includes('Matrice Rendimenti'), 'Must contain header title');
    assert.ok(fullHtml.includes('TWRR'), 'Must contain TWRR badge');
    assert.ok(fullHtml.includes('1M'), 'Must render 1M period badge');
    assert.ok(fullHtml.includes('3M'), 'Must render 3M period badge');
    assert.ok(fullHtml.includes('1Y'), 'Must render 1Y period badge');
    assert.ok(fullHtml.includes('ALL'), 'Must render ALL period badge');
    assert.ok(fullHtml.includes('+2,45%'), 'Must format positive TWRR with sign and comma');
    assert.ok(fullHtml.includes('-1,82%'), 'Must format negative TWRR with sign and comma');
    assert.ok(fullHtml.includes('+1,3k') || fullHtml.includes('+1,2k'), 'Must format values in K for thousands');
    assert.ok(fullHtml.includes('% a.') || fullHtml.includes('p.a.'), 'Must format annualized rate');

    // 2. Filter to SHORT (Breve)
    evalEnv.setFilter('SHORT');
    const shortHtml = evalEnv.renderPerformanceMatrix(mockData);
    assert.ok(shortHtml.includes('1M'), 'SHORT filter must include 1M');
    assert.ok(shortHtml.includes('1Y'), 'SHORT filter must include 1Y');
    assert.ok(!shortHtml.includes('>3 Anni<'), 'SHORT filter must NOT include 3 Anni in rows');
    assert.ok(!shortHtml.includes('>5 Anni<'), 'SHORT filter must NOT include 5 Anni in rows');

    // 3. Filter to LONG (Lungo)
    evalEnv.setFilter('LONG');
    const longHtml = evalEnv.renderPerformanceMatrix(mockData);
    assert.ok(!longHtml.includes('>1 Mese<'), 'LONG filter must NOT include 1 Mese in rows');
    assert.ok(longHtml.includes('3Y'), 'LONG filter must include 3Y');
    assert.ok(longHtml.includes('5Y'), 'LONG filter must include 5Y');
    assert.ok(longHtml.includes('ALL'), 'LONG filter must include ALL');
  });
});
