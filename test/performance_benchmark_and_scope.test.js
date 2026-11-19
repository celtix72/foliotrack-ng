const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const path = require('path');
const fs = require('fs');

const TEST_DB = path.join(__dirname, 'test_perf_benchmark_scope.db');
process.env.DB_PATH = TEST_DB;
process.env.JWT_SECRET = 'test_jwt_secret_perf_benchmark_scope_998877';
process.env.NODE_ENV = 'test';

const { initDb, getDb, closeDb } = require('../src/db');
const app = require('../src/app');
const { reconstructPortfolioHistoryFromQuotes, addDaysToDateStr } = require('../src/services/marketService');

describe('Performance Chart Benchmark Index Comparison & Asset Scope Filtering', () => {
  let server;
  let baseUrl;
  let authToken;
  let investmentPortfolioId;
  let liquidityPortfolioId;

  before(async () => {
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    initDb(TEST_DB);

    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, resolve));
    const port = server.address().port;
    baseUrl = `http://127.0.0.1:${port}`;

    // Admin login
    const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin123' })
    });
    const loginData = await loginRes.json();
    authToken = loginData.token;

    // 1. Create an Investment portfolio (Investimento)
    const p1Res = await fetch(`${baseUrl}/api/portfolios`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`
      },
      body: JSON.stringify({
        name: 'Azionario & Bond Portfolio',
        type: 'Investimento',
        currency: 'EUR',
        initialCash: 10000.0,
        include_in_totals: 1
      })
    });
    const p1Data = await p1Res.json();
    investmentPortfolioId = p1Data.portfolio.id;

    // 2. Create a Liquidity portfolio (Liquidità)
    const p2Res = await fetch(`${baseUrl}/api/portfolios`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`
      },
      body: JSON.stringify({
        name: 'Conto Deposito & Emergenza',
        type: 'Liquidità',
        currency: 'EUR',
        initialCash: 50000.0,
        include_in_totals: 1
      })
    });
    const p2Data = await p2Res.json();
    liquidityPortfolioId = p2Data.portfolio.id;

    // Seed assets: 1 Equity (AAPL), 1 Bond (BTP-2030), 1 Benchmark (^GSPC)
    const db = getDb();
    db.prepare(`
      INSERT OR REPLACE INTO assets (ticker, name, type, sector, currentPrice, currency)
      VALUES 
        ('AAPL', 'Apple Inc', 'EQUITY', 'Information Technology', 200.0, 'EUR'),
        ('BTP-2030', 'BTP 2030 3.5%', 'BOND', 'Government', 100.0, 'EUR'),
        ('^GSPC', 'S&P 500', 'EQUITY', 'Broad Market', 5800.0, 'USD')
    `).run();

    // Seed historical quotes for the past 10 days
    const today = new Date().toISOString().split('T')[0];
    const insertQuote = db.prepare(`
      INSERT OR REPLACE INTO asset_quotes (ticker, date, close, volume, source)
      VALUES (?, ?, ?, 1000, 'TEST')
    `);

    for (let i = 10; i >= 0; i--) {
      const d = addDaysToDateStr(today, -i);
      // AAPL increases from 180 to 200 (+11.11%)
      insertQuote.run('AAPL', d, 180 + (200 - 180) * ((10 - i) / 10));
      // BTP stays around 100
      insertQuote.run('BTP-2030', d, 100.0);
      // S&P 500 increases from 5500 to 5800 (+5.45%)
      insertQuote.run('^GSPC', d, 5500 + (5800 - 5500) * ((10 - i) / 10));
    }

    // Buy AAPL and BTP in Investment portfolio 8 days ago
    const buyDate = addDaysToDateStr(today, -8);
    await fetch(`${baseUrl}/api/transactions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`
      },
      body: JSON.stringify({
        portfolioId: investmentPortfolioId,
        type: 'BUY',
        assetTicker: 'AAPL',
        date: `${buyDate} 10:00:00`,
        quantity: 20,
        price: 180.0,
        commission: 5.0
      })
    });

    await fetch(`${baseUrl}/api/transactions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`
      },
      body: JSON.stringify({
        portfolioId: investmentPortfolioId,
        type: 'BUY',
        assetTicker: 'BTP-2030',
        date: `${buyDate} 10:05:00`,
        quantity: 30,
        price: 100.0,
        commission: 5.0
      })
    });

    // Reconstruct history
    reconstructPortfolioHistoryFromQuotes(investmentPortfolioId, 30);
    reconstructPortfolioHistoryFromQuotes(liquidityPortfolioId, 30);
  });

  after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    closeDb();
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  });

  test('GET /api/history/performance returns benchmark comparison series and period metrics', async () => {
    const res = await fetch(`${baseUrl}/api/history/performance?range=1M&benchmark=^GSPC&portfolioId=${investmentPortfolioId}`, {
      headers: { Authorization: `Bearer ${authToken}` }
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.success, true);
    assert.ok(data.benchmark, 'Response must include benchmark data');
    assert.equal(data.benchmark.symbol, '^GSPC');
    assert.equal(data.benchmark.name, 'S&P 500');
    assert.ok(Array.isArray(data.benchmark.series), 'Benchmark series must be an array');
    assert.equal(data.benchmark.series.length, data.series.length, 'Benchmark series must align 1:1 with portfolio dates');
    assert.ok(typeof data.benchmark.periodReturnPercent === 'number', 'Benchmark must include periodReturnPercent');
  });

  test('GET /api/history/performance with scope=equity_only isolates Azioni & ETF Azionari', async () => {
    const res = await fetch(`${baseUrl}/api/history/performance?range=1M&scope=equity_only&portfolioId=${investmentPortfolioId}`, {
      headers: { Authorization: `Bearer ${authToken}` }
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.success, true);
    assert.equal(data.scope, 'equity_only');
    assert.ok(data.series.length > 0);
    
    // In equity_only, cashValue is 0 and totalValue equals equity asset value
    const lastPoint = data.series[data.series.length - 1];
    assert.equal(lastPoint.cashValue, 0);
    // 20 shares of AAPL at 200.0 = 4000.0
    assert.ok(lastPoint.totalValue >= 3600.0 && lastPoint.totalValue <= 4100.0);
    // Period return of equity is strictly positive
    assert.ok(data.periodReturnPercent > 0);
  });

  test('GET /api/history/performance with scope=all_no_liquidity excludes portfolios of type "Liquidità"', async () => {
    // When querying all portfolios without scope or with scope=all, liquidity portfolio (50000 cash) is included
    const allRes = await fetch(`${baseUrl}/api/history/performance?range=1M&portfolioId=all`, {
      headers: { Authorization: `Bearer ${authToken}` }
    });
    const allData = await allRes.json();
    const allLastVal = allData.series[allData.series.length - 1].totalValue;

    // When querying with scope=all_no_liquidity, liquidity portfolio (50000 cash) must be excluded
    const noLiqRes = await fetch(`${baseUrl}/api/history/performance?range=1M&scope=all_no_liquidity&portfolioId=all`, {
      headers: { Authorization: `Bearer ${authToken}` }
    });
    assert.equal(noLiqRes.status, 200);
    const noLiqData = await noLiqRes.json();
    assert.equal(noLiqData.success, true);
    const noLiqLastVal = noLiqData.series[noLiqData.series.length - 1].totalValue;

    assert.ok(allLastVal >= 55000.0, 'Total with liquidity portfolio should be > 55,000 €');
    assert.ok(noLiqLastVal < 15000.0, 'Total without liquidity portfolio should exclude the 50,000 € account');
  });

  test('Frontend dashboard.js contains benchmark and scope selectors', () => {
    const js = fs.readFileSync(path.join(__dirname, '../public/dashboard.js'), 'utf8');
    assert.ok(js.includes('id="perf-benchmark-select"'), 'Must define perf-benchmark-select element');
    assert.ok(js.includes('id="perf-scope-select"'), 'Must define perf-scope-select element');
    assert.ok(js.includes('activePerfBenchmark'), 'Must track activePerfBenchmark state');
    assert.ok(js.includes('activePerfScope'), 'Must track activePerfScope state');
    assert.ok(js.includes("b.symbol === '^GSPC'") || js.includes('^GSPC'), 'Must support S&P 500 benchmark');
    assert.ok(js.includes('FTSEMIB.MI'), 'Must support FTSE MIB benchmark');
    assert.ok(js.includes('equity_only'), 'Must support equity_only scope');
    assert.ok(js.includes('all_no_liquidity'), 'Must support all_no_liquidity scope');
  });

  test('GET /api/history/performance returns portfolio annualized volatility and rolling volatility per date', async () => {
    const res = await fetch(`${baseUrl}/api/history/performance?range=1M&portfolioId=${investmentPortfolioId}`, {
      headers: { Authorization: `Bearer ${authToken}` }
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.success, true);
    assert.ok(typeof data.portfolioVolatility === 'number', 'Response must include portfolioVolatility');
    assert.ok(data.series.length > 0);
    assert.ok(typeof data.series[0].rollingVolatility === 'number', 'Every point must include rollingVolatility');
  });

  test('GET /api/history/performance with benchmark returns comparative volatility, Beta and Correlation', async () => {
    const res = await fetch(`${baseUrl}/api/history/performance?range=1M&benchmark=^GSPC&portfolioId=${investmentPortfolioId}`, {
      headers: { Authorization: `Bearer ${authToken}` }
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.success, true);
    assert.ok(data.benchmark, 'Benchmark must be present');
    assert.ok(typeof data.benchmark.annualizedVolatility === 'number', 'Benchmark must include annualizedVolatility');
    assert.ok(data.benchmark.volatilityComparison, 'Benchmark must include volatilityComparison');
    
    const vc = data.benchmark.volatilityComparison;
    assert.ok(typeof vc.portfolioVolatility === 'number', 'volatilityComparison must have portfolioVolatility');
    assert.ok(typeof vc.benchmarkVolatility === 'number', 'volatilityComparison must have benchmarkVolatility');
    assert.ok(typeof vc.diff === 'number', 'volatilityComparison must have diff');
    assert.ok(typeof vc.ratio === 'number', 'volatilityComparison must have ratio');
    assert.ok(typeof vc.beta === 'number', 'volatilityComparison must have beta');
    assert.ok(typeof vc.correlation === 'number', 'volatilityComparison must have correlation');
    assert.ok(typeof vc.isLessVolatile === 'boolean', 'volatilityComparison must have isLessVolatile');
    assert.ok(typeof vc.summary === 'string' && vc.summary.length > 0, 'volatilityComparison must have summary');
  });

  test('Frontend dashboard.js defines indicator tooltips and volatility chart modes', () => {
    const js = fs.readFileSync(path.join(__dirname, '../public/dashboard.js'), 'utf8');
    assert.ok(js.includes('function renderTooltip'), 'Must define renderTooltip helper');
    assert.ok(js.includes('ft-tooltip-wrapper'), 'Must use ft-tooltip-wrapper class');
    assert.ok(js.includes('ft-tooltip-popup'), 'Must use ft-tooltip-popup class');
    assert.ok(js.includes('data-perf-metric="VOLATILITY"'), 'Must have VOLATILITY metric toggle button');
    assert.ok(js.includes('id="perf-volatility-box"'), 'Must have perf-volatility-box element');
    assert.ok(js.includes('id="perf-display-vol"'), 'Must have perf-display-vol element');
  });
});
