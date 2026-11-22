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

    test('POST /api/ai/chat supports OpenRouter model routing (e.g. DeepSeek V3)', async () => {
      const res = await fetch(`${baseUrl}/api/ai/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${authToken}`
        },
        body: JSON.stringify({
          portfolioId,
          prompt: 'Qual è il rischio del mio portafoglio?',
          model: 'deepseek/deepseek-chat'
        })
      });
      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.strictEqual(data.success, true);
      assert.ok(data.response);
      assert.ok(data.response.length > 20);
    });

    test('POST /api/ai/chat supports NVIDIA Nemotron Ultra via OpenRouter routing', async () => {
      const res = await fetch(`${baseUrl}/api/ai/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${authToken}`
        },
        body: JSON.stringify({
          portfolioId,
          prompt: 'Qual è il rischio del mio portafoglio?',
          provider: 'openrouter',
          model: 'nvidia/nemotron-3-ultra-550b-a55b'
        })
      });
      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.strictEqual(data.success, true);
      assert.ok(data.response);
      assert.ok(data.response.length > 20);
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

    test('GET /api/ai/prompts/weekly-report returns prompt pre-filled with live portfolio data', async () => {
      const res = await fetch(`${baseUrl}/api/ai/prompts/weekly-report?portfolioId=${portfolioId}`, {
        headers: { Authorization: `Bearer ${authToken}` }
      });
      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.strictEqual(data.success, true);
      assert.ok(data.prompt);
      assert.ok(data.prompt.includes('### RUOLO'));
      assert.ok(data.prompt.includes('analista finanziario senior specializzato in mercati azionari europei'));
      assert.ok(data.prompt.includes('### CONTESTO E DATI DI INPUT'));
      assert.ok(data.prompt.includes('### ISTRUZIONI DI ANALISI'));
      assert.ok(data.prompt.includes('### FORMATO DI OUTPUT RICHIESTO'));
      assert.ok(data.prompt.includes('Sintesi Esecutiva'));
      assert.ok(data.prompt.includes('Tabella Riepilogativa delle Performance'));
      assert.ok(data.prompt.includes('Analisi delle News per Singolo Asset'));
      assert.ok(data.prompt.includes('Contesto Macro Settimanale'));
      assert.ok(data.prompt.includes('| Ticker | Nome | Mercato | Quantità | Prezzo Inizio Settimana | Prezzo Fine Settimana | Valuta |'));
    });

    test('POST /api/ai/chat executes weekly report prompt and adheres to required 4-part structure', async () => {
      const promptRes = await fetch(`${baseUrl}/api/ai/prompts/weekly-report?portfolioId=${portfolioId}`, {
        headers: { Authorization: `Bearer ${authToken}` }
      });
      const promptData = await promptRes.json();

      const chatRes = await fetch(`${baseUrl}/api/ai/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${authToken}`
        },
        body: JSON.stringify({
          portfolioId,
          prompt: promptData.prompt,
          provider: 'heuristic'
        })
      });
      assert.strictEqual(chatRes.status, 200);
      const chatData = await chatRes.json();
      assert.strictEqual(chatData.success, true);
      assert.ok(chatData.response);
      assert.ok(chatData.response.includes('1. Sintesi Esecutiva'));
      assert.ok(chatData.response.includes('2. Tabella Riepilogativa delle Performance'));
      assert.ok(chatData.response.includes('3. Analisi delle News per Singolo Asset'));
      assert.ok(chatData.response.includes('4. Contesto Macro Settimanale'));
      assert.ok(chatData.response.includes('TOTALE PORTAFOGLIO'));
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

    test('Saves AI reports chronologically and allows fetching, viewing and deleting them', async () => {
      // 1. Fetch reports list
      const listRes = await fetch(`${baseUrl}/api/ai/reports`, {
        headers: { Authorization: `Bearer ${authToken}` }
      });
      assert.strictEqual(listRes.status, 200);
      const listData = await listRes.json();
      assert.strictEqual(listData.success, true);
      assert.ok(Array.isArray(listData.reports));
      assert.ok(listData.reports.length >= 2, 'Should contain at least 2 saved reports from previous test chat prompts');

      const latestReport = listData.reports[0];
      assert.ok(latestReport.id);
      assert.ok(latestReport.created_at, 'Should contain created_at timestamp');
      assert.ok(latestReport.model, 'Should contain model');
      assert.ok(latestReport.report_type, 'Should contain report_type');

      // 2. Fetch single report detail
      const singleRes = await fetch(`${baseUrl}/api/ai/reports/${latestReport.id}`, {
        headers: { Authorization: `Bearer ${authToken}` }
      });
      assert.strictEqual(singleRes.status, 200);
      const singleData = await singleRes.json();
      assert.strictEqual(singleData.success, true);
      assert.strictEqual(singleData.report.id, latestReport.id);
      assert.ok(singleData.report.content.length > 0, 'Should return full markdown content');

      // 3. Delete the report
      const delRes = await fetch(`${baseUrl}/api/ai/reports/${latestReport.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${authToken}` }
      });
      assert.strictEqual(delRes.status, 200);
      const delData = await delRes.json();
      assert.strictEqual(delData.success, true);

      // 4. Verify 404 after deletion
      const checkRes = await fetch(`${baseUrl}/api/ai/reports/${latestReport.id}`, {
        headers: { Authorization: `Bearer ${authToken}` }
      });
      assert.strictEqual(checkRes.status, 404);
    });
  });

  describe('4. Dual-View Reports & Client-Side Scripts', () => {
    test('serves public/ai_reports.js and public/pdf_report.js', async () => {
      const resAi = await fetch(`${baseUrl}/ai_reports.js`);
      assert.strictEqual(resAi.status, 200);
      const textAi = await resAi.text();
      assert.ok(textAi.includes('runMonteCarloRetirement') || textAi.includes('AiReportsController'));
      assert.ok(textAi.includes('initPromptChipsLogic'), 'Should contain initPromptChipsLogic');
      assert.ok(textAi.includes('loadPromptIntoInput'), 'Should contain loadPromptIntoInput');
      assert.ok(textAi.includes('btnSaveCustomPrompt'), 'Should handle btnSaveCustomPrompt');
      assert.ok(textAi.includes('fetchAiReports'), 'Should contain fetchAiReports');
      assert.ok(textAi.includes('renderAiReportsTable'), 'Should contain renderAiReportsTable');
      assert.ok(textAi.includes('openAiReportViewer'), 'Should contain openAiReportViewer');
      assert.ok(textAi.includes('deleteAiReport'), 'Should contain deleteAiReport');
      assert.ok(textAi.includes('report-accordion'), 'Should render collapsed accordion list items');
      assert.ok(textAi.includes('btn-toggle-all-reports'), 'Should contain toggle all expand/collapse button');

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
      assert.ok(html.includes('deepseek/deepseek-chat'), 'Should contain OpenRouter DeepSeek option');
      assert.ok(html.includes('nvidia/nemotron-3-ultra-550b-a55b'), 'Should contain NVIDIA Nemotron option');
      assert.ok(html.includes('btnSaveCustomPrompt'), 'Should contain save prompt button');
      assert.ok(html.includes('quickPromptChips'), 'Should contain quick suggestion chips');
      assert.ok(html.includes('weekly-report-chip'), 'Should contain weekly report chip');
      assert.ok(html.includes('customPromptChipsContainer'), 'Should contain custom saved prompt chips container');
      assert.ok(html.includes('btnOpenReportsArchive'), 'Should contain archive button');
      assert.ok(html.includes('aiReportsArchiveModal'), 'Should contain reports archive modal');
      assert.ok(html.includes('aiReportViewerModal'), 'Should contain report viewer modal');
      assert.ok(html.includes('/settings#ai'), 'Should link to settings AI keys panel');
      assert.ok(html.includes('/ai_reports.js'));
      assert.ok(html.includes('/pdf_report.js'));
      assert.ok(!html.includes('Pensione & FIRE'), 'Pensione & FIRE link should be removed from sidebar');

      const repRes = await fetch(`${baseUrl}/reports`, {
        headers: { Cookie: `foliotrack_token=${authToken}` }
      });
      assert.strictEqual(repRes.status, 200);
      const repHtml = await repRes.text();
      assert.ok(repHtml.includes('/ai-advisor?prompt=weekly-report'), 'Reports page should link to weekly AI report');
      assert.ok(repHtml.includes('tabBtnAiReports'), 'Reports page should contain AI reports tab button');
      assert.ok(repHtml.includes('sectionAiReports'), 'Reports page should contain AI reports section');
      assert.ok(repHtml.includes('aiReportViewerModal'), 'Reports page should contain report viewer modal');
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
      assert.ok(html.includes('deepseek/deepseek-chat'), 'Mobile view should contain OpenRouter DeepSeek option');
      assert.ok(html.includes('nvidia/nemotron-3-ultra-550b-a55b'), 'Mobile view should contain NVIDIA Nemotron option');
      assert.ok(html.includes('btnSaveCustomPrompt'), 'Mobile view should contain save prompt button');
      assert.ok(html.includes('quickPromptChips'), 'Mobile view should contain quick suggestion chips');
      assert.ok(html.includes('weekly-report-chip'), 'Mobile view should contain weekly report chip');
      assert.ok(html.includes('btnOpenReportsArchive'), 'Mobile view should contain archive button');
      assert.ok(html.includes('aiReportsArchiveModal'), 'Mobile view should contain archive modal');
      assert.ok(html.includes('aiReportViewerModal'), 'Mobile view should contain viewer modal');
      assert.ok(html.includes('/settings?tab=ai'), 'Mobile view should link to settings AI tab');

      const repMobRes = await fetch(`${baseUrl}/reports?view=mobile`, {
        headers: { Cookie: `foliotrack_token=${authToken}` }
      });
      assert.strictEqual(repMobRes.status, 200);
      const repMobHtml = await repMobRes.text();
      assert.ok(repMobHtml.includes('/ai-advisor?prompt=weekly-report'), 'Reports mobile page should link to weekly AI report');
      assert.ok(repMobHtml.includes('mTabBtnAiReports'), 'Reports mobile should contain AI reports tab button');
      assert.ok(repMobHtml.includes('mSectionAiReports'), 'Reports mobile should contain AI reports section');
      assert.ok(repMobHtml.includes('aiReportViewerModal'), 'Reports mobile should contain viewer modal');
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

    test('CD_IFIS and DEPOSITO_VINCOLATO are strictly treated as Liquidità (never Equity) in AI Advisor and Analysis', async () => {
      const {
        buildWeeklyReportPrompt,
        buildPortfolioPromptContext,
        generateHeuristicChatResponse,
        generateHeuristicAnalysis,
        resolveMarketName
      } = require('../src/services/aiService');

      // 1. resolveMarketName treats DEPOSITO_VINCOLATO and CD_* as unquoted liquidity
      assert.strictEqual(resolveMarketName('CD_IFIS', 'EUR', '', 'DEPOSITO_VINCOLATO'), 'Liquidità / Deposito Vincolato (Non quotato)');
      assert.strictEqual(resolveMarketName('CD_RENDIMAX', 'EUR'), 'Liquidità / Deposito Vincolato (Non quotato)');

      const mockPortfolio = {
        id: 1,
        name: 'Portafoglio Test Liquidità',
        currency: 'EUR',
        currentCash: 5000,
        totalValue: 55000,
        metrics: {
          totalValue: 55000,
          currentCash: 5000,
          investedCapital: 50000,
          unrealizedPnl: 5000,
          realizedPnl: 0,
          totalDividends: 0,
          holdings: [
            {
              ticker: 'ISP.MI',
              name: 'Intesa Sanpaolo',
              type: 'EQUITY',
              currency: 'EUR',
              quantity: 5000,
              currentPrice: 3.0,
              currentPriceNative: 3.0,
              previousClose: 2.9,
              currentValue: 15000,
              marketValue: 15000,
              weight: 27.27
            },
            {
              ticker: 'AAPL',
              name: 'Apple Inc',
              type: 'EQUITY',
              currency: 'USD',
              quantity: 100,
              currentPrice: 150.0,
              currentPriceNative: 150.0,
              previousClose: 145.0,
              currentValue: 15000,
              marketValue: 15000,
              weight: 27.27
            },
            {
              ticker: 'CD_IFIS',
              name: 'Conto Deposito Vincolato Banca IFIS',
              type: 'DEPOSITO_VINCOLATO',
              currency: 'EUR',
              quantity: 25000,
              currentPrice: 1.0,
              currentPriceNative: 1.0,
              previousClose: 1.0,
              currentValue: 25000,
              marketValue: 25000,
              weight: 45.45
            }
          ],
          allocations: {
            byAssetClass: {
              EQUITY: { value: 30000, percentage: 54.55 },
              DEPOSITO_VINCOLATO: { value: 25000, percentage: 45.45 }
            }
          }
        }
      };

      // 2. buildWeeklyReportPrompt format and instruction verification
      const weeklyPromptData = buildWeeklyReportPrompt(mockPortfolio);
      assert.ok(weeklyPromptData.prompt.includes('| CD_IFIS | Conto Deposito Vincolato Banca IFIS | Liquidità / Deposito Vincolato (Non quotato) | 25000 | 1.00 | 1.00 | EUR |'));
      assert.ok(weeklyPromptData.prompt.includes('REGOLA FONDAMENTALE DI CLASSIFICAZIONE'));
      assert.ok(weeklyPromptData.prompt.includes('NON devono essere inclusi nel conteggio delle azioni'));

      // 3. generateHeuristicChatResponse (weekly report prompt) isolates CD_IFIS into Liquidità & Depositi Vincolati
      const weeklyResp = generateHeuristicChatResponse(mockPortfolio, 'Fornisci un report settimanale sul portafoglio azionario con Tabella Riepilogativa delle Performance');
      assert.ok(weeklyResp.includes('### Liquidità & Depositi Vincolati'));
      assert.ok(weeklyResp.includes('CD_IFIS'));
      assert.ok(weeklyResp.includes('garantito (Liquidità)'));
      // Intesa is in Borsa Italiana, Apple in Borsa Americana, CD_IFIS is NOT in Borsa Italiana
      const borsaItSection = weeklyResp.substring(weeklyResp.indexOf('### Borsa Italiana'), weeklyResp.indexOf('### Borsa Americana'));
      assert.ok(borsaItSection.includes('ISP.MI'));
      assert.ok(!borsaItSection.includes('CD_IFIS'), 'CD_IFIS must not appear under Borsa Italiana section');

      // 4. generateHeuristicChatResponse (general chat) shows total liquidity with deposits
      const generalResp = generateHeuristicChatResponse(mockPortfolio, 'Come sta andando il portafoglio?');
      assert.ok(generalResp.includes('**Liquidità Totale (Cash + Depositi Vincolati):** € 30.000 (54.5%)'));
      assert.ok(generalResp.includes('Depositi Vincolati: € 25.000'));

      // 5. buildPortfolioPromptContext includes CD_IFIS as Liquidità
      const ctxJson = JSON.parse(buildPortfolioPromptContext(mockPortfolio));
      assert.strictEqual(ctxJson.totalLiquidityEur, '€ 30.000 (54.5%)');
      assert.strictEqual(ctxJson.depositsVincolatiEur, '€ 25.000');
      const ifisItem = ctxJson.holdings.find(h => h.ticker === 'CD_IFIS');
      assert.ok(ifisItem);
      assert.strictEqual(ifisItem.assetClass, 'LIQUIDITA (Deposito Vincolato)');
      assert.strictEqual(ifisItem.macroCategory, 'Liquidità');
      assert.strictEqual(ifisItem.isLiquidity, true);

      // 6. Quantitative Heuristic Analysis includes deposits in cashWeight
      const quant = generateHeuristicAnalysis(mockPortfolio);
      assert.ok(quant.strengths.some(s => s.includes('Liquidità disponibile al 54.5%')));

      // 7. Stock Analysis endpoint (/api/analysis) excludes CD_IFIS
      // Insert a transaction for CD_IFIS and ensure it does not appear in stock analysis
      const pRes = await fetch(`${baseUrl}/api/portfolios`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: `foliotrack_token=${authToken}` },
        body: JSON.stringify({ name: 'Portafoglio Test Analysis Liquidity', currency: 'EUR' })
      });
      const pData = await pRes.json();
      assert.ok(pData.portfolio && pData.portfolio.id);

      // Create transaction for CD_IFIS
      await fetch(`${baseUrl}/api/transactions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: `foliotrack_token=${authToken}` },
        body: JSON.stringify({
          portfolioId: pData.portfolio.id,
          type: 'BUY',
          assetTicker: 'CD_IFIS',
          quantity: 10000,
          price: 1,
          date: '2026-01-15'
        })
      });

      const analysisRes = await fetch(`${baseUrl}/api/analysis`, {
        headers: { Cookie: `foliotrack_token=${authToken}` }
      });
      assert.strictEqual(analysisRes.status, 200);
      const analysisData = await analysisRes.json();
      assert.ok(analysisData.success);
      const foundIfisInAnalysis = (analysisData.items || []).some(item => item.ticker === 'CD_IFIS');
      assert.strictEqual(foundIfisInAnalysis, false, 'CD_IFIS must not appear in /api/analysis stock overview');
    });
  });
});

