const express = require('express');
const { requireAuth } = require('../middlewares/authMiddleware');
const { 
  getLatestPortfolioNews, 
  scrapePortfolioNews 
} = require('../services/newsService');

const router = express.Router();
router.use(requireAuth);

/**
 * GET /api/news
 * Retrieves the latest news for all assets in the user's portfolios.
 * Defaults to 5 news items.
 */
router.get('/', async (req, res) => {
  try {
    const limit = Math.min(20, Math.max(1, parseInt(req.query.limit, 10) || 5));
    const news = await getLatestPortfolioNews(req.user.id, limit);

    return res.json({
      success: true,
      count: news.length,
      news
    });
  } catch (err) {
    console.error('[API News Error]:', err);
    return res.status(500).json({
      success: false,
      error: 'Impossibile recuperare le notizie del portafoglio: ' + err.message
    });
  }
});

/**
 * POST /api/news/refresh
 * Triggers an immediate scrape of news for all active portfolio assets and returns the fresh top 5 news.
 */
router.post('/refresh', async (req, res) => {
  try {
    const limit = Math.min(20, Math.max(1, parseInt(req.query.limit, 10) || 5));
    const stats = await scrapePortfolioNews(req.user.id);
    const news = await getLatestPortfolioNews(req.user.id, limit);

    return res.json({
      success: true,
      message: `Scrape completato: verificate ${stats.checkedAssets} posizioni, ${stats.newArticlesCount} nuove notizie acquisite.`,
      stats,
      count: news.length,
      news
    });
  } catch (err) {
    console.error('[API News Refresh Error]:', err);
    return res.status(500).json({
      success: false,
      error: 'Errore durante l\'aggiornamento delle notizie: ' + err.message
    });
  }
});

module.exports = router;
