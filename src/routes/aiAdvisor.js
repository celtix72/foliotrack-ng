/**
 * AI Advisor API Routes for FolioTrack
 */

const express = require('express');
const { getSetting } = require('../db');
const { requireAuth } = require('../middlewares/authMiddleware');
const { recalculatePortfolio, checkPortfolioAccess } = require('./portfolios');
const { generatePortfolioAiAssessment } = require('../services/aiService');

const router = express.Router();

router.use(requireAuth);

/**
 * POST /api/ai/analyze
 * Generates structured AI advisor analysis for a portfolio.
 */
router.post('/analyze', async (req, res) => {
  const {
    portfolioId,
    provider = 'auto',
    model,
    apiKey,
    tavilyKey,
    customBaseUrl
  } = req.body || {};

  const pId = parseInt(portfolioId, 10);
  if (isNaN(pId)) {
    return res.status(400).json({ success: false, error: 'portfolioId obbligatorio.' });
  }

  const access = checkPortfolioAccess(pId, req.user.id, req.user.role);
  if (!access.hasAccess) {
    return res.status(403).json({ success: false, error: 'Accesso negato al portafoglio.' });
  }

  const portfolio = recalculatePortfolio(pId);
  if (!portfolio) {
    return res.status(404).json({ success: false, error: 'Portafoglio non trovato.' });
  }

  // Check stored encrypted API keys if not supplied in body
  const effectiveKey = apiKey || getSetting(req.user.id, `${provider}_api_key`, null);
  const effectiveTavily = tavilyKey || getSetting(req.user.id, 'tavily_api_key', null);

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

