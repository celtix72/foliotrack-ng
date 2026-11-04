/**
 * Retirement & FIRE Goals API Routes for FolioTrack
 */

const express = require('express');
const { db, getSetting, setSetting } = require('../db');
const { requireAuth } = require('../middlewares/authMiddleware');
const { runMonteCarloRetirement } = require('../utils/retirement');
const { recalculatePortfolio, checkPortfolioAccess } = require('./portfolios');

const router = express.Router();

router.use(requireAuth);

/**
 * POST /api/goals/simulate
 * Runs Monte Carlo simulation and SORR stress test based on provided or portfolio parameters.
 */
router.post('/simulate', (req, res) => {
  const {
    portfolioId,
    currentAge,
    retirementAge,
    lifeExpectancy,
    currentWealth,
    monthlySavings,
    monthlyExpenses,
    expectedReturn,
    volatility,
    inflationRate,
    iterations
  } = req.body || {};

  let wealth = currentWealth !== undefined ? Number(currentWealth) : null;
  let expReturn = expectedReturn !== undefined ? Number(expectedReturn) : null;
  let vol = volatility !== undefined ? Number(volatility) : null;

  // If a portfolioId is specified and wealth not explicitly given, fetch portfolio's current NAV
  if (portfolioId && portfolioId !== 'all') {
    const pId = parseInt(portfolioId, 10);
    if (!isNaN(pId)) {
      const access = checkPortfolioAccess(pId, req.user.id, req.user.role);
      if (access.hasAccess) {
        const p = recalculatePortfolio(pId);
        if (p) {
          if (wealth === null) wealth = Number(p.totalValue) || 0.0;
        }
      }
    }
  }

  // If wealth still null, calculate user's total aggregate wealth
  if (wealth === null) {
    const where = req.user.role === 'admin'
      ? ''
      : 'WHERE portfolio_id IN (SELECT portfolio_id FROM portfolio_users WHERE user_id = ?)';
    const params = req.user.role === 'admin' ? [] : [req.user.id];
    const totalRow = db.prepare(`SELECT SUM(totalValue) as total FROM portfolios ${where}`).get(...params);
    wealth = totalRow && totalRow.total ? Number(totalRow.total) : 50000;
  }

  const result = runMonteCarloRetirement({
    currentAge: currentAge || 35,
    retirementAge: retirementAge || 60,
    lifeExpectancy: lifeExpectancy || 85,
    currentWealth: wealth,
    monthlySavings: monthlySavings !== undefined ? monthlySavings : 500,
    monthlyExpenses: monthlyExpenses !== undefined ? monthlyExpenses : 2000,
    expectedReturn: expReturn !== null ? expReturn : 0.07,
    volatility: vol !== null ? vol : 0.14,
    inflationRate: inflationRate !== undefined ? inflationRate : 0.02,
    iterations: iterations || 1000
  });

  return res.json({
    success: true,
    ...result
  });
});

/**
 * GET /api/goals/saved
 * Retrieves the saved FIRE goal parameters for the current user.
 */
router.get('/saved', (req, res) => {
  const savedJson = getSetting(req.user.id, 'fire_goal_parameters', null);
  let params = null;
  if (savedJson) {
    try {
      params = JSON.parse(savedJson);
    } catch {
      params = null;
    }
  }

  return res.json({
    success: true,
    params: params || {
      currentAge: 35,
      retirementAge: 60,
      lifeExpectancy: 85,
      monthlySavings: 500,
      monthlyExpenses: 2000,
      expectedReturn: 0.07,
      volatility: 0.14,
      inflationRate: 0.02
    }
  });
});

/**
 * POST /api/goals/save
 * Persists the user's retirement/FIRE parameters.
 */
router.post('/save', (req, res) => {
  const params = req.body || {};
  setSetting(req.user.id, 'fire_goal_parameters', JSON.stringify(params), false);

  return res.json({
    success: true,
    message: 'Parametri FIRE salvati con successo.',
    params
  });
});

module.exports = router;

