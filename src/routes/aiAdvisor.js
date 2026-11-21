/**
 * AI Advisor API Routes for FolioTrack
 */

const express = require('express');
const { db, getSetting } = require('../db');
const { requireAuth } = require('../middlewares/authMiddleware');
const { recalculatePortfolio, checkPortfolioAccess, getAssetsMap } = require('./portfolios');
const {
  generatePortfolioAiAssessment,
  chatWithPortfolioAi
} = require('../services/aiService');

const router = express.Router();

router.use(requireAuth);

/**
 * Resolves API key from request payload or stored user encrypted settings or environment.
 */
function resolveApiKey(provider, userKey, userId) {
  if (userKey) return userKey;

  if (provider === 'gemini') {
    return getSetting(userId, 'gemini_api_key', true) || process.env.GEMINI_API_KEY || null;
  }
  if (provider === 'openai') {
    return getSetting(userId, 'openai_api_key', true) || process.env.OPENAI_API_KEY || null;
  }
  if (provider === 'openrouter') {
    return getSetting(userId, 'openrouter_api_key', true) || process.env.OPENROUTER_API_KEY || null;
  }

  // Auto: prefer Gemini, then OpenAI, then OpenRouter
  return getSetting(userId, 'gemini_api_key', true) || process.env.GEMINI_API_KEY
    || getSetting(userId, 'openai_api_key', true) || process.env.OPENAI_API_KEY
    || getSetting(userId, 'openrouter_api_key', true) || process.env.OPENROUTER_API_KEY
    || null;
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
          if (!allHoldingsMap.has(h.ticker)) {
            allHoldingsMap.set(h.ticker, {
              ticker: h.ticker,
              name: h.name || h.ticker,
              type: h.type || 'Altro',
              sector: h.sector,
              region: h.region,
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
        }

        if (full.metrics.allocations) {
          const rawClass = full.metrics.allocations.byAssetClass || full.metrics.allocations.byClass || {};
          for (const [cls, data] of Object.entries(rawClass)) {
            if (!aggregatedAssetClass[cls]) aggregatedAssetClass[cls] = { value: 0.0, percentage: 0.0 };
            aggregatedAssetClass[cls].value += (data.value || 0);
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
      metrics: {
        totalValue: grandTotalValue,
        currentCash: grandTotalCash,
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
  const openaiKey = getSetting(req.user.id, 'openai_api_key', true) || process.env.OPENAI_API_KEY || null;
  const tavilyKey = getSetting(req.user.id, 'tavily_api_key', true) || process.env.TAVILY_API_KEY || null;

  return res.json({
    success: true,
    hasGeminiKey: !!geminiKey,
    hasOpenAiKey: !!openaiKey,
    hasTavilyKey: !!tavilyKey,
    geminiKeyMasked: geminiKey ? (geminiKey.slice(0, 6) + '...' + geminiKey.slice(-4)) : null,
    defaultModel: 'gemini-1.5-pro'
  });
});

/**
 * POST /api/ai/chat
 * Free-form conversational prompt analysis with Gemini AI Pro or chosen provider.
 */
router.post('/chat', async (req, res) => {
  const {
    portfolioId = 'all',
    prompt,
    history = [],
    provider = 'gemini',
    model = 'gemini-1.5-pro',
    apiKey,
    customBaseUrl
  } = req.body || {};

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

    return res.json({
      success: true,
      response: result.message,
      provider: result.provider,
      model: result.model
    });
  } catch (err) {
    return res.status(500).json({
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
  const {
    portfolioId = 'all',
    provider = 'auto',
    model,
    apiKey,
    tavilyKey,
    customBaseUrl
  } = req.body || {};

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

    return res.json({
      success: true,
      analysis
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      error: `Errore durante l'analisi AI: ${err.message}`
    });
  }
});

module.exports = router;
