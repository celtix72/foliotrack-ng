const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');

const TEST_DB = path.join(__dirname, 'test_phase9.db');
process.env.DB_PATH = TEST_DB;
process.env.JWT_SECRET = 'test-jwt-secret-phase9-retirement-monte-carlo';
process.env.ADMIN_PASSWORD = 'adminPhase9Password!';
process.env.NODE_ENV = 'test';

const { initDb, closeDb, db } = require('../src/db');
const app = require('../src/app');
const { runMonteCarloRetirement, quantile, randomNormal } = require('../src/utils/retirement');
const { generatePortfolioAiAssessment, generateHeuristicAnalysis } = require('../src/services/aiService');

let server;
let baseUrl;
let authToken;
let portfolioId;

describe('Phase 9: Retirement & FIRE Monte Carlo Simulator and AI Advisor', () => {
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
      body: JSON.stringify({ username: 'admin', password: 'adminPhase9Password!' })
    });
    const loginData = await loginRes.json();
    authToken = loginData.token;

    // Create a portfolio for simulation
    const portRes = await fetch(`${baseUrl}/api/portfolios`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`
      },
      body: JSON.stringify({
        name: 'FIRE Retirement Portfolio',
        type: 'Pensione',
        currency: 'EUR',
        initialCash: 50000
      })
    });
    const portData = await portRes.json();
    portfolioId = portData.portfolio.id;

    // Add assets to portfolio for AI testing
    await fetch(`${baseUrl}/api/assets`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`
      },
      body: JSON.stringify({
        ticker: 'VWCE.DE',
        name: 'Vanguard FTSE All-World UCITS ETF',
        type: 'ETF',
        currency: 'EUR',
        currentPrice: 120.0,
        dividendYield: 1.8,
        sector: 'Information Technology',
        region: 'Global'
      })
    });

    await fetch(`${baseUrl}/api/transactions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`
      },
      body: JSON.stringify({
        portfolioId,
        type: 'BUY',
        assetTicker: 'VWCE.DE',
        date: '2024-01-10',
        quantity: 250,
        price: 120.0,
        commission: 5.0
      })
    });
  });

  after(async () => {
    if (server) await new Promise((res) => server.close(res));
    closeDb();
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    const wal = `${TEST_DB}-wal`;
    const shm = `${TEST_DB}-shm`;
    if (fs.existsSync(wal)) fs.unlinkSync(wal);
    if (fs.existsSync(shm)) fs.unlinkSync(shm);
  });

  describe('1. Quantitative Monte Carlo & SORR Engine (src/utils/retirement.js)', () => {
    test('quantile and randomNormal statistical functions work properly', () => {
      const sorted = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
      assert.strictEqual(quantile(sorted, 0), 10);
      assert.strictEqual(quantile(sorted, 1), 100);
      assert.strictEqual(quantile(sorted, 0.5), 55);

      const norm = randomNormal(10, 2);
      assert.ok(!isNaN(norm));
    });

    test('runMonteCarloRetirement runs 1000 iterations and computes percentiles & FIRE number', () => {
      const res = runMonteCarloRetirement({
        currentAge: 35,
        retirementAge: 60,
        lifeExpectancy: 85,
        currentWealth: 50000,
        monthlySavings: 600,
        monthlyExpenses: 2500,
        expectedReturn: 0.07,
        volatility: 0.14,
        inflationRate: 0.02,
        iterations: 1000
      });

      assert.ok(res.params);
      assert.ok(res.metrics);
      // FIRE Number: 2500 * 12 * 25 = 750,000 EUR
      assert.strictEqual(res.metrics.fireNumber, 750000);
      assert.ok(res.metrics.successRate >= 0 && res.metrics.successRate <= 100);
      assert.strictEqual(res.percentiles.length, 51); // 35 to 85 = 50 years + start year 0

      // Verify P90 >= P50 >= P10 at retirement age 60
      const pRetirement = res.percentiles.find(p => p.age === 60);
      assert.ok(pRetirement);
      assert.ok(pRetirement.p90 >= pRetirement.p50);
      assert.ok(pRetirement.p50 >= pRetirement.p10);

      // Verify SORR trajectory exists
      assert.strictEqual(res.sorr.length, 51);
      assert.strictEqual(res.sorr[0].age, 35);
    });
  });

  describe('2. Goals API Endpoints (src/routes/goals.js)', () => {
    test('POST /api/goals/simulate returns simulation metrics', async () => {
      const res = await fetch(`${baseUrl}/api/goals/simulate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${authToken}`
        },
        body: JSON.stringify({
          portfolioId,
          currentAge: 30,
          retirementAge: 55,
          monthlySavings: 800,
          monthlyExpenses: 2200
        })
      });
      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.strictEqual(data.success, true);
      assert.ok(data.metrics);
      // 2200 * 12 * 25 = 660,000
      assert.strictEqual(data.metrics.fireNumber, 660000);
      assert.ok(data.percentiles.length > 0);
      assert.ok(data.sorr.length > 0);
    });

    test('POST /api/goals/save and GET /api/goals/saved persists parameters in settings', async () => {
      const saveRes = await fetch(`${baseUrl}/api/goals/save`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${authToken}`
        },
        body: JSON.stringify({
          currentAge: 32,
          retirementAge: 58,
          monthlySavings: 750,
          monthlyExpenses: 2400
        })
      });
      assert.strictEqual(saveRes.status, 200);

      const getRes = await fetch(`${baseUrl}/api/goals/saved`, {
        headers: { Authorization: `Bearer ${authToken}` }
      });
      assert.strictEqual(getRes.status, 200);
      const data = await getRes.json();
      assert.strictEqual(data.success, true);
      assert.strictEqual(data.params.currentAge, 32);
      assert.strictEqual(data.params.retirementAge, 58);
      assert.strictEqual(data.params.monthlySavings, 750);
    });
  });

  describe('3. AI Advisor Service & Endpoints (src/services/aiService.js & src/routes/aiAdvisor.js)', () => {
    test('generatePortfolioAiAssessment returns structured scores using heuristic engine', async () => {
      const p = {
        name: 'Test Portfolio',
        totalValue: 100000,
        currentCash: 15000,
        metrics: {
          holdings: [
            { ticker: 'VWCE.DE', weight: 60, type: 'ETF' },
            { ticker: 'BTP', weight: 25, type: 'BOND' }
          ],
          allocations: {
            byClass: {
              ETF: { percentage: 60 },
              BOND: { percentage: 25 },
              CASH: { percentage: 15 }
            },
            bySector: {
              'Information Technology': 30,
              'Financials': 25,
              'Industrials': 20
            }
          }
        }
      };

      const result = await generatePortfolioAiAssessment({ portfolio: p, provider: 'heuristic' });
      assert.ok(result.riskScore >= 1 && result.riskScore <= 100);
      assert.ok(result.diversificationScore >= 1 && result.diversificationScore <= 100);
      assert.ok(['Eccellente', 'Buona', 'Migliorabile', 'Sbilanciata'].includes(result.assetAllocationQuality));
      assert.ok(result.strengths.length >= 1);
      assert.ok(result.weaknesses.length >= 1);
      assert.ok(result.tacticalRecommendations.length >= 1);
      assert.ok(result.strategicRecommendations.length >= 1);
    });

    test('POST /api/ai/analyze returns AI assessment for active portfolio', async () => {
      const res = await fetch(`${baseUrl}/api/ai/analyze`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${authToken}`
        },
        body: JSON.stringify({ portfolioId, provider: 'heuristic' })
      });
      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.strictEqual(data.success, true);
      assert.ok(data.analysis);
      assert.ok(data.analysis.riskScore > 0);
      assert.ok(data.analysis.diversificationScore > 0);
    });

    test('POST /api/ai/analyze supports aggregated portfolioId: "all"', async () => {
      const res = await fetch(`${baseUrl}/api/ai/analyze`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${authToken}`
        },
        body: JSON.stringify({ portfolioId: 'all', provider: 'heuristic' })
      });
      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.strictEqual(data.success, true);
      assert.ok(data.analysis);
      assert.ok(data.analysis.riskScore > 0);
    });

    test('GET /api/ai/status returns provider key status including NVIDIA and Gemini', async () => {
      const res = await fetch(`${baseUrl}/api/ai/status`, {
        headers: { Authorization: `Bearer ${authToken}` }
      });
      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.strictEqual(data.success, true);
      assert.strictEqual(typeof data.hasGeminiKey, 'boolean');
      assert.strictEqual(typeof data.hasNvidiaKey, 'boolean');
      assert.strictEqual(typeof data.hasOpenAiKey, 'boolean');
      assert.strictEqual(typeof data.hasOpenRouterKey, 'boolean');
      assert.ok(data.defaultModel);
    });

    test('PUT /api/settings saves nvidia_api_key and GET /api/ai/status reflects it', async () => {
      const putRes = await fetch(`${baseUrl}/api/settings`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${authToken}`
        },
        body: JSON.stringify({
          nvidia_api_key: 'nvapi-test-key-mock-12345',
          openrouter_api_key: 'sk-or-v1-mock-key'
        })
      });
      assert.strictEqual(putRes.status, 200);

      const statusRes = await fetch(`${baseUrl}/api/ai/status`, {
        headers: { Authorization: `Bearer ${authToken}` }
      });
      const statusData = await statusRes.json();
      assert.strictEqual(statusData.hasNvidiaKey, true);
      assert.strictEqual(statusData.hasOpenRouterKey, true);
      assert.ok(statusData.nvidiaKeyMasked.startsWith('nvapi-t'));
    });

    test('POST /api/ai/chat supports NVIDIA Nemotron Free model routing and fallback', async () => {
      const res = await fetch(`${baseUrl}/api/ai/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${authToken}`
        },
        body: JSON.stringify({
          portfolioId,
          prompt: 'Qual è il rischio del mio portafoglio?',
          model: 'nvidia/llama-3.1-nemotron-70b-instruct'
        })
      });
      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.strictEqual(data.success, true);
      assert.ok(data.response);
      assert.ok(data.response.length > 20);
    });

    test('POST /api/ai/chat returns interactive response for portfolio prompt', async () => {
      const res = await fetch(`${baseUrl}/api/ai/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${authToken}`
        },
        body: JSON.stringify({
          portfolioId,
          prompt: 'Quali sono i punti di forza del mio portafoglio?',
          provider: 'heuristic',
          model: 'gemini-1.5-pro'
        })
      });
      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.strictEqual(data.success, true);
      assert.ok(typeof data.response === 'string' && data.response.length > 20);
      assert.ok(data.response.includes('Analisi') || data.response.includes('Portafoglio'));
    });

    test('POST /api/ai/chat fails gracefully with 400 on empty prompt', async () => {
      const res = await fetch(`${baseUrl}/api/ai/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${authToken}`
        },
        body: JSON.stringify({
          portfolioId,
          prompt: '   '
        })
      });
      assert.strictEqual(res.status, 400);
      const data = await res.json();
      assert.strictEqual(data.success, false);
      assert.ok(data.error.includes('obbligatorio'));
    });
  });

  describe('4. Dual-View Reports & Client-Side Scripts', () => {
    test('serves public/ai_reports.js and public/pdf_report.js', async () => {
      const resAi = await fetch(`${baseUrl}/ai_reports.js`);
      assert.strictEqual(resAi.status, 200);
      const textAi = await resAi.text();
      assert.ok(textAi.includes('runMonteCarloRetirement') || textAi.includes('AiReportsController'));

      const resPdf = await fetch(`${baseUrl}/pdf_report.js`);
      assert.strictEqual(resPdf.status, 200);
      const textPdf = await resPdf.text();
      assert.ok(textPdf.includes('PdfReport'));
    });

    test('GET /goals, /ai-advisor and /reports serve desktop reports view with injected sidebar', async () => {
      const res = await fetch(`${baseUrl}/ai-advisor`, {
        headers: { Cookie: `foliotrack_token=${authToken}` }
      });
      assert.strictEqual(res.status, 200);
      const html = await res.text();
      assert.ok(html.includes('AI Portfolio Advisor'));
      assert.ok(!html.includes('monteCarloChart'), 'monteCarloChart should be removed');
      assert.ok(!html.includes('statFireNumber'), 'statFireNumber should be removed');
      assert.ok(html.includes('aiRiskScore'));
      assert.ok(html.includes('aiDiversificationScore'));
      assert.ok(html.includes('aiPromptInput'), 'Should contain interactive AI prompt input');
      assert.ok(html.includes('chatModelSelect'), 'Should contain model selector');
      assert.ok(html.includes('nvidia/nemotron-3-ultra-550b-a55b'), 'Should contain NVIDIA Nemotron option');
      assert.ok(html.includes('/settings#ai'), 'Should link to settings AI keys panel');
      assert.ok(html.includes('/ai_reports.js'));
      assert.ok(html.includes('/pdf_report.js'));
      assert.ok(!html.includes('Pensione & FIRE'), 'Pensione & FIRE link should be removed from sidebar');
    });

    test('GET /goals?view=mobile serves mobile layout', async () => {
      const res = await fetch(`${baseUrl}/ai-advisor?view=mobile`, {
        headers: { Cookie: `foliotrack_token=${authToken}` }
      });
      assert.strictEqual(res.status, 200);
      const html = await res.text();
      assert.ok(html.includes('AI Advisor'));
      assert.ok(!html.includes('monteCarloChart'), 'monteCarloChart should be removed on mobile');
      assert.ok(!html.includes('statFireNumber'), 'statFireNumber should be removed on mobile');
      assert.ok(html.includes('aiRiskScore'));
      assert.ok(html.includes('aiDiversificationScore'));
      assert.ok(html.includes('aiPromptInput'), 'Mobile view should contain prompt input');
      assert.ok(html.includes('chatModelSelect'), 'Mobile view should contain model selector');
      assert.ok(html.includes('nvidia/nemotron-3-ultra-550b-a55b'), 'Mobile view should contain NVIDIA Nemotron option');
      assert.ok(html.includes('/settings?tab=ai'), 'Mobile view should link to settings AI tab');
    });

    test('Settings UI (desktop and mobile) renders centralized AI and Tavily configuration', async () => {
      const deskRes = await fetch(`${baseUrl}/settings`, {
        headers: { Cookie: `foliotrack_token=${authToken}` }
      });
      assert.strictEqual(deskRes.status, 200);
      const deskHtml = await deskRes.text();
      assert.ok(deskHtml.includes('id="gemini_api_key"'));
      assert.ok(deskHtml.includes('id="nvidia_api_key"'));
      assert.ok(deskHtml.includes('id="openai_api_key"'));
      assert.ok(deskHtml.includes('id="openrouter_api_key"'));
      assert.ok(deskHtml.includes('id="tavily_api_key"'));
      assert.ok(deskHtml.includes('NVIDIA NIM'));

      const mobRes = await fetch(`${baseUrl}/settings?view=mobile`, {
        headers: { Cookie: `foliotrack_token=${authToken}` }
      });
      assert.strictEqual(mobRes.status, 200);
      const mobHtml = await mobRes.text();
      assert.ok(mobHtml.includes('id="gemini_api_key"'));
      assert.ok(mobHtml.includes('id="nvidia_api_key"'));
      assert.ok(mobHtml.includes('id="openai_api_key"'));
      assert.ok(mobHtml.includes('id="tavily_api_key"'));
      assert.ok(mobHtml.includes('NVIDIA NIM'));
    });
  });
});

