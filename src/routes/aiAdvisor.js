/**
 * AI Advisor API Routes for FolioTrack
 */

const express = require('express');
const { db, getSetting } = require('../db');
const { requireAuth } = require('../middlewares/authMiddleware');
const { recalculatePortfolio, checkPortfolioAccess, getAssetsMap } = require('./portfolios');
const {
  generatePortfolioAiAssessment,
  chatWithPortfolioAi,
  buildWeeklyReportPrompt
} = require('../services/aiService');

const router = express.Router();

router.use(requireAuth);

/**
 * Resolves API key from request payload or stored user encrypted settings or environment.
 */
function resolveApiKey(provider, userKey, userId) {
  if (userKey && String(userKey).trim()) return String(userKey).trim();

  if (provider === 'nvidia' || provider === 'nemotron') {
    const k = getSetting(userId, 'nvidia_api_key', true) || process.env.NVIDIA_API_KEY || null;
    return k ? String(k).trim() : null;
  }
  if (provider === 'gemini') {
    const k = getSetting(userId, 'gemini_api_key', true) || process.env.GEMINI_API_KEY || null;
    return k ? String(k).trim() : null;
  }
  if (provider === 'openai') {
    const k = getSetting(userId, 'openai_api_key', true) || process.env.OPENAI_API_KEY || null;
    return k ? String(k).trim() : null;
  }
  if (provider === 'openrouter') {
    const k = getSetting(userId, 'openrouter_api_key', true) || process.env.OPENROUTER_API_KEY || null;
    return k ? String(k).trim() : null;
  }

  // Auto: prefer Gemini, then NVIDIA, then OpenAI, then OpenRouter
  const k = getSetting(userId, 'gemini_api_key', true) || process.env.GEMINI_API_KEY
    || getSetting(userId, 'nvidia_api_key', true) || process.env.NVIDIA_API_KEY
    || getSetting(userId, 'openai_api_key', true) || process.env.OPENAI_API_KEY
    || getSetting(userId, 'openrouter_api_key', true) || process.env.OPENROUTER_API_KEY
    || null;
  return k ? String(k).trim() : null;
}

/**
 * Retrieves specific portfolio or compiles aggregated snapshot of all user portfolios.
 */
function getPortfolioOrAggregated(portfolioId, userId, userRole) {
  if (portfolioId === 'all' || portfolioId === null || portfolioId === undefined || portfolioId === '') {
    let portfolios = [];
    if (userRole === 'admin') {
      portfolios = db.prepare('SELECT * FROM portfolios ORDER BY id ASC').all();
    } else {
      portfolios = db.prepare(`
        SELECT p.*
        FROM portfolios p
        INNER JOIN portfolio_users pu ON pu.portfolio_id = p.id
        WHERE pu.user_id = ?
        ORDER BY p.id ASC
      `).all(userId);
    }

    const assetsMap = getAssetsMap();
    let grandTotalValue = 0.0;
    let grandTotalCash = 0.0;
    let grandTotalDeposits = 0.0;
    let grandInvestedCapital = 0.0;
    let grandRealizedPnl = 0.0;
    let grandUnrealizedPnl = 0.0;
    let grandTotalDividends = 0.0;
    const allHoldingsMap = new Map();
    const aggregatedAssetClass = {};
    const aggregatedSector = {};
    const aggregatedRegion = {};

    for (const p of portfolios) {
      const full = recalculatePortfolio(p.id, assetsMap);
      if (!full) continue;
      if (full.include_in_totals) {
        grandTotalValue += (full.metrics.totalValue || 0);
        grandTotalCash += (full.metrics.currentCash || 0);
        grandInvestedCapital += (full.metrics.investedCapital || 0);
        grandRealizedPnl += (full.metrics.realizedPnl || 0);
        grandUnrealizedPnl += (full.metrics.unrealizedPnl || 0);
        grandTotalDividends += (full.metrics.totalDividends || 0);

        for (const h of (full.metrics.holdings || [])) {
          const normType = String(h.type || '').toUpperCase();
          const isDeposit = normType === 'DEPOSITO_VINCOLATO' || (h.ticker || '').toUpperCase().startsWith('CD_') || (h.ticker || '').toUpperCase().startsWith('CD-') || (h.ticker || '').toUpperCase().includes('IFIS') || (h.ticker || '').toUpperCase().includes('RENDIMAX');
          const assetClass = isDeposit ? 'LIQUIDITA' : (h.type || 'Altro');

          if (!allHoldingsMap.has(h.ticker)) {
            allHoldingsMap.set(h.ticker, {
              ticker: h.ticker,
              name: h.name || h.ticker,
              type: assetClass,
              macroCategory: isDeposit ? 'Liquidità' : (h.macroCategory || 'Altro'),
              isLiquidity: isDeposit || h.type === 'CASH' || h.type === 'LIQUIDITA',
              sector: isDeposit ? 'Liquidità' : h.sector,
              region: isDeposit ? 'Italia / Eurozona' : h.region,
              quantity: 0,
              currentPrice: h.currentPrice,
              currentValue: 0,
              investedValue: 0,
              unrealizedPnL: 0
            });
          }
          const item = allHoldingsMap.get(h.ticker);
          item.quantity += (h.quantity || 0);
          item.currentValue += (h.currentValue || 0);
          item.investedValue += ((h.averagePrice || 0) * (h.quantity || 0));
          item.unrealizedPnL += (h.unrealizedPnL || 0);
          if (isDeposit) {
            grandTotalDeposits += (h.currentValue || 0);
          }
        }

        if (full.metrics.allocations) {
          const rawClass = full.metrics.allocations.byAssetClass || full.metrics.allocations.byClass || {};
          for (const [cls, data] of Object.entries(rawClass)) {
            const mappedCls = (cls === 'DEPOSITO_VINCOLATO' || cls === 'CONTO_DEPOSITO' || cls === 'LIQUIDITA') ? 'CASH' : cls;
            if (!aggregatedAssetClass[mappedCls]) aggregatedAssetClass[mappedCls] = { value: 0.0, percentage: 0.0 };
            aggregatedAssetClass[mappedCls].value += (data.value || 0);
          }
          if (full.metrics.allocations.bySector) {
            for (const [sec, data] of Object.entries(full.metrics.allocations.bySector)) {
              if (!aggregatedSector[sec]) aggregatedSector[sec] = { value: 0.0, percentage: 0.0 };
              aggregatedSector[sec].value += (data.value || 0);
            }
          }
          if (full.metrics.allocations.byRegion) {
            for (const [reg, data] of Object.entries(full.metrics.allocations.byRegion)) {
              if (!aggregatedRegion[reg]) aggregatedRegion[reg] = { value: 0.0, percentage: 0.0 };
              aggregatedRegion[reg].value += (data.value || 0);
            }
          }
        }
      }
    }

    const holdings = Array.from(allHoldingsMap.values()).map(h => {
      const weight = grandTotalValue > 0 ? (h.currentValue / grandTotalValue) * 100 : 0;
      const averagePrice = h.quantity > 0 ? h.investedValue / h.quantity : 0;
      const unrealizedPnLPercent = h.investedValue > 0 ? (h.unrealizedPnL / h.investedValue) * 100 : 0;
      return {
        ...h,
        averagePrice,
        weight,
        unrealizedPnLPercent
      };
    }).sort((a, b) => b.currentValue - a.currentValue);

    for (const allocMap of [aggregatedAssetClass, aggregatedSector, aggregatedRegion]) {
      for (const key of Object.keys(allocMap)) {
        allocMap[key].percentage = grandTotalValue > 0 ? (allocMap[key].value / grandTotalValue) * 100 : 0;
      }
    }

    return {
      id: 'all',
      name: 'Tutti i Portafogli (Globale Aggregato)',
      currency: 'EUR',
      isAggregated: true,
      totalValue: grandTotalValue,
      currentCash: grandTotalCash,
      totalDeposits: grandTotalDeposits,
      totalLiquidity: grandTotalCash + grandTotalDeposits,
      metrics: {
        totalValue: grandTotalValue,
        currentCash: grandTotalCash,
        totalDeposits: grandTotalDeposits,
        totalLiquidity: grandTotalCash + grandTotalDeposits,
        investedCapital: grandInvestedCapital,
        realizedPnl: grandRealizedPnl,
        unrealizedPnl: grandUnrealizedPnl,
        totalDividends: grandTotalDividends,
        holdings,
        allocations: {
          byAssetClass: aggregatedAssetClass,
          byClass: aggregatedAssetClass,
          bySector: aggregatedSector,
          byRegion: aggregatedRegion
        }
      }
    };
  }

  // Specific portfolio ID
  const pId = parseInt(portfolioId, 10);
  if (isNaN(pId)) return null;

  const access = checkPortfolioAccess(pId, userId, userRole);
  if (!access.hasAccess) {
    return { error: 'Accesso negato al portafoglio.', status: 403 };
  }

  const portfolio = recalculatePortfolio(pId);
  if (!portfolio) {
    return { error: 'Portafoglio non trovato.', status: 404 };
  }

  return portfolio;
}

/**
 * GET /api/ai/status
 * Returns availability of AI API keys and default models for the user.
 */
router.get('/status', (req, res) => {
  const geminiKey = getSetting(req.user.id, 'gemini_api_key', true) || process.env.GEMINI_API_KEY || null;
  const nvidiaKey = getSetting(req.user.id, 'nvidia_api_key', true) || process.env.NVIDIA_API_KEY || null;
  const openaiKey = getSetting(req.user.id, 'openai_api_key', true) || process.env.OPENAI_API_KEY || null;
  const openrouterKey = getSetting(req.user.id, 'openrouter_api_key', true) || process.env.OPENROUTER_API_KEY || null;
  const tavilyKey = getSetting(req.user.id, 'tavily_api_key', true) || process.env.TAVILY_API_KEY || null;

  let defaultModel = 'gemini-2.0-flash';
  if (geminiKey) {
    defaultModel = 'gemini-2.0-flash';
  } else if (openrouterKey) {
    defaultModel = 'deepseek/deepseek-chat';
  } else if (nvidiaKey) {
    defaultModel = 'nvidia/nemotron-3-ultra-550b-a55b';
  } else if (openaiKey) {
    defaultModel = 'gpt-4o-mini';
  }

  return res.json({
    success: true,
    hasGeminiKey: !!geminiKey,
    hasNvidiaKey: !!nvidiaKey,
    hasOpenAiKey: !!openaiKey,
    hasOpenRouterKey: !!openrouterKey,
    hasTavilyKey: !!tavilyKey,
    geminiKeyMasked: geminiKey ? (String(geminiKey).slice(0, 6) + '...' + String(geminiKey).slice(-4)) : null,
    nvidiaKeyMasked: nvidiaKey ? (String(nvidiaKey).slice(0, 7) + '...' + String(nvidiaKey).slice(-4)) : null,
    openrouterKeyMasked: openrouterKey ? (String(openrouterKey).slice(0, 9) + '...' + String(openrouterKey).slice(-4)) : null,
    openaiKeyMasked: openaiKey ? (String(openaiKey).slice(0, 7) + '...' + String(openaiKey).slice(-4)) : null,
    defaultModel
  });
});

/**
 * GET /api/ai/prompts/weekly-report
 * Returns pre-filled weekly AI report prompt populated with the selected portfolio data.
 */
router.get('/prompts/weekly-report', (req, res) => {
  const { portfolioId = 'all' } = req.query;
  const portfolio = getPortfolioOrAggregated(portfolioId, req.user.id, req.user.role);
  if (!portfolio) {
    return res.status(404).json({ success: false, error: 'Portafoglio non trovato.' });
  }
  if (portfolio.error) {
    return res.status(portfolio.status || 400).json({ success: false, error: portfolio.error });
  }

  const promptData = buildWeeklyReportPrompt(portfolio);
  return res.json({
    success: true,
    prompt: promptData.prompt,
    portfolioId,
    portfolioName: portfolio.name || 'Tutti i Portafogli',
    currency: promptData.currency,
    startDate: promptData.startDate,
    endDate: promptData.endDate,
    holdingsCount: promptData.holdingsCount
  });
});

/**
 * Saves generated AI report into chronological archive table.
 */
function saveAiReportRecord({ userId, portfolioId, portfolioName, reportType, reportTitle, model, provider, prompt, content, metadata }) {
  try {
    const stmt = db.prepare(`
      INSERT INTO ai_reports (user_id, portfolio_id, portfolio_name, report_type, report_title, model, provider, prompt, content, metadata, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now', 'localtime'))
    `);
    const info = stmt.run(
      userId,
      String(portfolioId || 'all'),
      portfolioName || 'Tutti i Portafogli',
      reportType || 'CHAT_ADVISOR',
      reportTitle || 'Analisi AI Portfolio',
      model || 'gemini',
      provider || 'gemini',
      prompt || '',
      content || '',
      metadata ? (typeof metadata === 'string' ? metadata : JSON.stringify(metadata)) : null
    );
    return info.lastInsertRowid;
  } catch (err) {
    console.warn('[AI Reports DB Warning]:', err.message);
    return null;
  }
}

/**
 * GET /api/ai/reports
 * Returns chronological list of all saved AI reports for current user.
 */
router.get('/reports', (req, res) => {
  const { portfolioId } = req.query;
  try {
    let rows;
    if (portfolioId && portfolioId !== 'all') {
      rows = db.prepare(`
        SELECT id, user_id, portfolio_id, portfolio_name, report_type, report_title, model, provider, prompt, content,
               substr(content, 1, 240) as preview,
               created_at
        FROM ai_reports
        WHERE user_id = ? AND (portfolio_id = ? OR portfolio_id = 'all')
        ORDER BY id DESC
      `).all(req.user.id, String(portfolioId));
    } else {
      rows = db.prepare(`
        SELECT id, user_id, portfolio_id, portfolio_name, report_type, report_title, model, provider, prompt, content,
               substr(content, 1, 240) as preview,
               created_at
        FROM ai_reports
        WHERE user_id = ?
        ORDER BY id DESC
      `).all(req.user.id);
    }
    return res.json({ success: true, reports: rows });
  } catch (err) {
    console.error('[AI Reports GET Error]:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/ai/reports/:id
 * Returns single full saved report by ID.
 */
router.get('/reports/:id', (req, res) => {
  const { id } = req.params;
  try {
    const row = db.prepare(`SELECT * FROM ai_reports WHERE id = ?`).get(id);
    if (!row) {
      return res.status(404).json({ success: false, error: 'Report non trovato.' });
    }
    if (row.user_id !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ success: false, error: 'Accesso negato al report.' });
    }
    return res.json({ success: true, report: row });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * DELETE /api/ai/reports/:id
 * Deletes single saved report by ID.
 */
router.delete('/reports/:id', (req, res) => {
  const { id } = req.params;
  try {
    const row = db.prepare(`SELECT * FROM ai_reports WHERE id = ?`).get(id);
    if (!row) {
      return res.status(404).json({ success: false, error: 'Report non trovato.' });
    }
    if (row.user_id !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ success: false, error: 'Accesso negato al report.' });
    }
    db.prepare(`DELETE FROM ai_reports WHERE id = ?`).run(id);
    return res.json({ success: true, message: 'Report eliminato con successo.' });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/ai/chat
 * Free-form conversational prompt analysis with Gemini AI Pro, NVIDIA NIM Nemotron, OpenRouter, or chosen provider.
 */
router.post('/chat', async (req, res) => {
  let {
    portfolioId = 'all',
    prompt,
    history = [],
    provider = 'auto',
    model = 'gemini-2.0-flash',
    apiKey,
    customBaseUrl
  } = req.body || {};

  // Auto-detect or align provider based on model names if provider is not explicitly provided
  if (!provider || provider === 'auto') {
    if (model && (model.startsWith('gpt-') || model.startsWith('o1-') || model.startsWith('o3-'))) {
      provider = 'openai';
    } else if (model && model.startsWith('gemini-')) {
      provider = 'gemini';
    } else if (
      model && (
        model.includes(':free') ||
        model.startsWith('openrouter') ||
        model.startsWith('deepseek/') ||
        model.startsWith('anthropic/') ||
        model.startsWith('meta-llama/') ||
        model.startsWith('qwen/') ||
        model.startsWith('mistralai/')
      )
    ) {
      provider = 'openrouter';
    } else if (model && (model.startsWith('nvidia/') || model.includes('nemotron') || model.includes('ultramon'))) {
      provider = 'nvidia';
    } else if (model && model.includes('/')) {
      provider = 'openrouter';
    }
  }

  if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
    return res.status(400).json({ success: false, error: 'Il prompt / domanda è obbligatorio.' });
  }

  const portfolio = getPortfolioOrAggregated(portfolioId, req.user.id, req.user.role);
  if (!portfolio) {
    return res.status(404).json({ success: false, error: 'Portafoglio non trovato.' });
  }
  if (portfolio.error) {
    return res.status(portfolio.status || 400).json({ success: false, error: portfolio.error });
  }

  const effectiveKey = resolveApiKey(provider, apiKey, req.user.id);

  try {
    const result = await chatWithPortfolioAi({
      portfolio,
      userPrompt: prompt.trim(),
      chatHistory: history,
      provider,
      model,
      apiKey: effectiveKey,
      customBaseUrl
    });

    // Automatically save generated report in chronological history
    let reportType = 'CHAT_ADVISOR';
    let reportTitle = prompt.trim().length > 60 ? (prompt.trim().slice(0, 57) + '...') : prompt.trim();
    if (prompt.includes('analista finanziario senior') || prompt.includes('report settimanale') || prompt.includes('Tabella Riepilogativa delle Performance')) {
      reportType = 'REPORT_SETTIMANALE';
      reportTitle = 'Report Settimanale Performance & News';
    } else if (prompt.includes('Rischio & Concentrazione') || prompt.includes('principali rischi')) {
      reportTitle = 'Analisi Rischio & Concentrazione';
    } else if (prompt.includes('Strategia Ribilanciamento') || prompt.includes('ribilanciare')) {
      reportTitle = 'Strategia di Ribilanciamento';
    } else if (prompt.includes('Stress test') || prompt.includes('Stress Test')) {
      reportTitle = 'Stress Test Macro';
    } else if (prompt.includes('fiscale') || prompt.includes('plusvalenze')) {
      reportTitle = 'Analisi Fiscale & Minusvalenze';
    } else if (prompt.includes('geografica') || prompt.includes('home bias')) {
      reportTitle = 'Esposizione Geografica & Valutaria';
    } else if (prompt.includes('top titoli') || prompt.includes('Top Titoli') || prompt.includes('3 titoli')) {
      reportTitle = 'Check-up Top Titoli';
    }

    const savedId = saveAiReportRecord({
      userId: req.user.id,
      portfolioId,
      portfolioName: portfolio.name || 'Tutti i Portafogli',
      reportType,
      reportTitle,
      model: result.model || model,
      provider: result.provider || provider,
      prompt: prompt.trim(),
      content: result.message
    });

    return res.json({
      success: true,
      response: result.message,
      provider: result.provider,
      model: result.model,
      reportId: savedId
    });
  } catch (err) {
    console.error('[AI Advisor Chat Error]:', err.message);
    return res.status(200).json({
      success: false,
      error: err.message
    });
  }
});

/**
 * POST /api/ai/analyze
 * Generates structured AI advisor analysis for a portfolio.
 */
router.post('/analyze', async (req, res) => {
  let {
    portfolioId = 'all',
    provider = 'auto',
    model,
    apiKey,
    tavilyKey,
    customBaseUrl
  } = req.body || {};

  if (model && (model.startsWith('nvidia/') || model.includes('nemotron') || model.includes('ultramon'))) {
    if (provider === 'auto') provider = 'nvidia';
  } else if (model && (
    model.startsWith('openrouter') ||
    model.startsWith('deepseek/') ||
    model.startsWith('anthropic/') ||
    model.startsWith('meta-llama/') ||
    model.startsWith('qwen/') ||
    model.startsWith('mistralai/')
  )) {
    if (provider === 'auto') provider = 'openrouter';
  }

  const portfolio = getPortfolioOrAggregated(portfolioId, req.user.id, req.user.role);
  if (!portfolio) {
    return res.status(404).json({ success: false, error: 'Portafoglio non trovato.' });
  }
  if (portfolio.error) {
    return res.status(portfolio.status || 400).json({ success: false, error: portfolio.error });
  }

  const effectiveKey = resolveApiKey(provider, apiKey, req.user.id);
  const effectiveTavily = tavilyKey || getSetting(req.user.id, 'tavily_api_key', true) || process.env.TAVILY_API_KEY || null;

  try {
    const analysis = await generatePortfolioAiAssessment({
      portfolio,
      provider,
      model,
      apiKey: effectiveKey,
      tavilyKey: effectiveTavily,
      customBaseUrl
    });

    const savedId = saveAiReportRecord({
      userId: req.user.id,
      portfolioId,
      portfolioName: portfolio.name || 'Tutti i Portafogli',
      reportType: 'SCORECARD_QUANTITATIVA',
      reportTitle: `Scorecard Quantitativa (${analysis.assetAllocationQuality || 'Asset Allocation'})`,
      model: analysis.model || model || 'Gemini / Euristico',
      provider: analysis.provider || provider,
      prompt: 'Analisi qualitativa e quantitativa con Scorecard di Rischio e Diversificazione',
      content: `### Scorecard Quantitativa Asset Allocation\n\n- **Qualità Allocazione:** ${analysis.assetAllocationQuality}\n- **Punteggio di Rischio:** ${analysis.riskScore}/100\n- **Punteggio Diversificazione:** ${analysis.diversificationScore}/100\n\n#### Punti di Forza:\n${(analysis.strengths || []).map(s => `- ${s}`).join('\n')}\n\n#### Aree di Attenzione & Concentrazione:\n${(analysis.weaknesses || []).map(w => `- ${w}`).join('\n')}\n\n#### Raccomandazioni Tattiche:\n${(analysis.tacticalRecommendations || []).map(t => `- ${t}`).join('\n')}\n\n#### Raccomandazioni Strategiche:\n${(analysis.strategicRecommendations || []).map(s => `- ${s}`).join('\n')}\n\n#### Contesto di Mercato:\n${analysis.marketContextSummary || '-'}`,
      metadata: analysis
    });

    return res.json({
      success: true,
      analysis,
      reportId: savedId
    });
  } catch (err) {
    console.error('[AI Advisor Analyze Error]:', err.message);
    return res.status(200).json({
      success: false,
      error: `Errore durante l'analisi AI: ${err.message}`
    });
  }
});

module.exports = router;
