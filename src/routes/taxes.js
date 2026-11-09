/**
 * Fiscal Module & Italian Tax Backpack ("Zainetto Fiscale") for FolioTrack
 * Tracks capital losses (minusvalenze) with 4-year legal expiration (D.Lgs. 461/1997),
 * manages automatic capital gain compensation, and calculates 26% and 12.5% tax savings.
 */

const express = require('express');
const { db } = require('../db');
const { requireAuth } = require('../middlewares/authMiddleware');
const { checkPortfolioAccess } = require('./portfolios');
const { resolveAssetTaxInfo } = require('../utils/taxEngine');

const router = express.Router();

router.use(requireAuth);

/**
 * Automatically offsets realized capital gains against available unexpired tax losses (FIFO).
 * Rule: Minusvalenze compensate only within the SAME portfolio and on the SAME asset category.
 *
 * @param {number} portfolioId
 * @param {number} capitalGain Positive realized capital gain
 * @param {string} [assetType='EQUITY'] 'EQUITY' (26%) or 'BOND' (12.5%)
 * @returns {{ originalGain: number, compensatedAmount: number, taxableGain: number, remainingLosses: number, taxRate: number, taxDue: number, netGain: number }}
 */
function compensateTaxGain(portfolioId, capitalGain, assetType = 'EQUITY') {
  const gain = Math.max(0.0, Number(capitalGain) || 0.0);
  const cleanCat = (String(assetType).toUpperCase().trim() === 'BOND') ? 'BOND' : 'EQUITY';
  const taxRate = cleanCat === 'BOND' ? 0.125 : 0.26;

  if (gain <= 0.0) {
    return { originalGain: 0.0, compensatedAmount: 0.0, taxableGain: 0.0, remainingLosses: 0.0, taxRate, taxDue: 0.0, netGain: 0.0 };
  }

  const todayStr = new Date().toISOString().split('T')[0];

  // Fetch active unexpired losses for the SAME portfolio AND SAME asset category, ordered by earliest expiry (FIFO)
  const activeLosses = db.prepare(`
    SELECT * FROM portfolio_losses
    WHERE portfolioId = ?
      AND (assetType = ? OR (assetType IS NULL AND ? = 'EQUITY'))
      AND residualAmount > 0.001
      AND expiryDate >= ?
    ORDER BY expiryDate ASC, id ASC
  `).all(portfolioId, cleanCat, cleanCat, todayStr);

  let gainRemaining = gain;
  let totalCompensated = 0.0;

  const updateStmt = db.prepare(`
    UPDATE portfolio_losses
    SET residualAmount = ?,
        updatedAt = datetime('now')
    WHERE id = ?
  `);

  const runAtomic = db.transaction(() => {
    for (const loss of activeLosses) {
      if (gainRemaining <= 0.001) break;

      const avail = loss.residualAmount;
      const offset = Math.min(gainRemaining, avail);

      const newResidual = Math.max(0.0, avail - offset);
      updateStmt.run(newResidual, loss.id);

      gainRemaining -= offset;
      totalCompensated += offset;
    }
  });

  runAtomic();

  // Sum remaining active losses for this category and portfolio
  const totalRemRow = db.prepare(`
    SELECT SUM(residualAmount) as rem
    FROM portfolio_losses
    WHERE portfolioId = ?
      AND (assetType = ? OR (assetType IS NULL AND ? = 'EQUITY'))
      AND residualAmount > 0.001
      AND expiryDate >= ?
  `).get(portfolioId, cleanCat, cleanCat, todayStr);

  const remainingLosses = totalRemRow ? (Number(totalRemRow.rem) || 0.0) : 0.0;
  const taxableGain = Math.max(0.0, gainRemaining);
  const taxDue = taxableGain * taxRate;
  const netGain = gain - taxDue;

  return {
    originalGain: gain,
    compensatedAmount: totalCompensated,
    taxableGain,
    remainingLosses,
    taxRate,
    taxDue,
    netGain
  };
}

/**
 * Records a new realized capital loss in the portfolio's tax backpack.
 * Scadenza: 31 dicembre del 4° anno successivo a quello di realizzo.
 *
 * @param {number} portfolioId
 * @param {number} capitalLoss Positive number representing realized loss
 * @param {string} [dateStr=null]
 * @param {string} [notes='']
 * @param {string} [assetType='EQUITY'] 'EQUITY' (26%) or 'BOND' (12.5%)
 * @param {number} [taxRate=null]
 */
function recordTaxLoss(portfolioId, capitalLoss, dateStr = null, notes = '', assetType = 'EQUITY', taxRate = null) {
  const lossAmount = Math.abs(Number(capitalLoss) || 0.0);
  if (lossAmount <= 0.0) return null;

  const cleanCat = (String(assetType).toUpperCase().trim() === 'BOND') ? 'BOND' : 'EQUITY';
  const cleanRate = (taxRate !== null && taxRate !== undefined && !isNaN(Number(taxRate)))
    ? Number(taxRate)
    : (cleanCat === 'BOND' ? 0.125 : 0.26);

  const date = dateStr || new Date().toISOString().split('T')[0];
  const year = parseInt(date.slice(0, 4), 10);
  const expiryDate = `${year + 4}-12-31`;

  const insertStmt = db.prepare(`
    INSERT INTO portfolio_losses (
      portfolioId, year, amount, residualAmount, expiryDate, notes, assetType, taxRate, createdAt, updatedAt
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
  `);

  const info = insertStmt.run(portfolioId, year, lossAmount, lossAmount, expiryDate, notes, cleanCat, cleanRate);
  return info.lastInsertRowid;
}

/**
 * GET /api/taxes/zainetto
 * Retrieves the Italian capital loss backpack with remaining days and expiration stats.
 */
router.get('/zainetto', (req, res) => {
  const { portfolioId } = req.query;
  const userId = req.user.id;
  const userRole = req.user.role;

  let where = '';
  const params = [];

  if (userRole !== 'admin') {
    where = 'WHERE pl.portfolioId IN (SELECT portfolio_id FROM portfolio_users WHERE user_id = ?)';
    params.push(userId);
  }

  if (portfolioId && portfolioId !== 'all') {
    const pId = parseInt(portfolioId, 10);
    if (!isNaN(pId)) {
      where += where ? ' AND pl.portfolioId = ?' : 'WHERE pl.portfolioId = ?';
      params.push(pId);
    }
  }

  const rows = db.prepare(`
    SELECT pl.*, p.name as portfolioName
    FROM portfolio_losses pl
    LEFT JOIN portfolios p ON p.id = pl.portfolioId
    ${where}
    ORDER BY pl.expiryDate ASC, pl.year ASC
  `).all(...params);

  const now = new Date();
  const currentYear = now.getFullYear();
  const todayMs = now.getTime();

  let totalResidual = 0.0;
  let expiringThisYear = 0.0;
  let totalPotentialTaxSavings = 0.0;
  let equityResidual = 0.0;
  let equitySavings = 0.0;
  let bondResidual = 0.0;
  let bondSavings = 0.0;

  const enriched = rows.map(r => {
    const expDate = new Date(r.expiryDate + 'T23:59:59');
    const diffMs = expDate.getTime() - todayMs;
    const daysRemaining = Math.max(0, Math.ceil(diffMs / (1000 * 60 * 60 * 24)));
    const isExpired = diffMs < 0;
    const expYear = parseInt(r.expiryDate.slice(0, 4), 10);
    const isExpiringThisYear = expYear === currentYear && !isExpired;

    const origAmt = Number(r.amount) || 0.0;
    const resAmt = Number(r.residualAmount) || 0.0;
    const pctResidual = origAmt > 0 ? (resAmt / origAmt) * 100.0 : 0.0;

    const cat = (String(r.assetType).toUpperCase().trim() === 'BOND' || r.taxRate === 0.125) ? 'BOND' : 'EQUITY';
    const rate = (r.taxRate !== undefined && r.taxRate !== null && !isNaN(Number(r.taxRate)))
      ? Number(r.taxRate)
      : (cat === 'BOND' ? 0.125 : 0.26);
    const potSaving = resAmt * rate;

    if (!isExpired) {
      totalResidual += resAmt;
      totalPotentialTaxSavings += potSaving;
      if (cat === 'BOND') {
        bondResidual += resAmt;
        bondSavings += potSaving;
      } else {
        equityResidual += resAmt;
        equitySavings += potSaving;
      }
      if (isExpiringThisYear) {
        expiringThisYear += resAmt;
      }
    }

    return {
      id: r.id,
      portfolioId: r.portfolioId,
      portfolioName: r.portfolioName || `Portafoglio #${r.portfolioId}`,
      year: r.year,
      amount: origAmt,
      residualAmount: resAmt,
      expiryDate: r.expiryDate,
      notes: r.notes || '',
      daysRemaining,
      isExpired,
      isExpiringThisYear,
      percentResidual: pctResidual,
      assetType: cat,
      taxCategory: cat,
      taxRate: rate,
      taxRateFormatted: rate === 0.125 ? '12,5%' : '26%',
      categoryLabel: cat === 'BOND' ? 'BOND / Monetario' : 'Azioni / ETF',
      potentialTaxSaving: potSaving
    };
  });

  return res.json({
    success: true,
    summary: {
      totalResidualLosses: totalResidual,
      expiringThisYearAmount: expiringThisYear,
      taxSavingsPotential: totalPotentialTaxSavings,
      countActive: enriched.filter(x => !x.isExpired && x.residualAmount > 0).length,
      byCategory: {
        equity: {
          residualAmount: equityResidual,
          taxSavingsPotential: equitySavings,
          taxRate: 0.26,
          taxRateFormatted: '26%'
        },
        bond: {
          residualAmount: bondResidual,
          taxSavingsPotential: bondSavings,
          taxRate: 0.125,
          taxRateFormatted: '12,5%'
        }
      }
    },
    losses: enriched
  });
});

/**
 * POST /api/taxes/losses
 * Manually adds an existing or carried-over capital loss record.
 */
router.post('/losses', (req, res) => {
  const {
    portfolioId,
    year = new Date().getFullYear(),
    amount,
    residualAmount,
    expiryDate,
    notes = '',
    assetType = 'EQUITY',
    taxRate = null
  } = req.body || {};

  const pId = parseInt(portfolioId, 10);
  if (isNaN(pId)) {
    return res.status(400).json({ success: false, error: 'portfolioId obbligatorio.' });
  }

  const access = checkPortfolioAccess(pId, req.user.id, req.user.role);
  if (!access.isOwner) {
    return res.status(403).json({ success: false, error: 'Accesso negato: solo il proprietario può registrare minusvalenze.' });
  }

  const amt = Math.abs(parseFloat(amount)) || 0.0;
  if (amt <= 0.0) {
    return res.status(400).json({ success: false, error: 'Importo minusvalenza non valido.' });
  }

  const cleanCat = (String(assetType).toUpperCase().trim() === 'BOND') ? 'BOND' : 'EQUITY';
  const cleanRate = (taxRate !== null && taxRate !== undefined && !isNaN(Number(taxRate)))
    ? Number(taxRate)
    : (cleanCat === 'BOND' ? 0.125 : 0.26);

  const yr = parseInt(year, 10) || new Date().getFullYear();
  const resAmt = residualAmount !== undefined ? Math.abs(parseFloat(residualAmount)) : amt;
  const expDate = expiryDate || `${yr + 4}-12-31`;

  const info = db.prepare(`
    INSERT INTO portfolio_losses (
      portfolioId, year, amount, residualAmount, expiryDate, notes, assetType, taxRate, createdAt, updatedAt
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
  `).run(pId, yr, amt, resAmt, expDate, notes, cleanCat, cleanRate);

  const created = db.prepare('SELECT * FROM portfolio_losses WHERE id = ?').get(info.lastInsertRowid);

  return res.status(201).json({
    success: true,
    loss: created
  });
});

/**
 * DELETE /api/taxes/losses/:id
 * Deletes a loss record.
 */
router.delete('/losses/:id', (req, res) => {
  const lossId = parseInt(req.params.id, 10);
  if (isNaN(lossId)) {
    return res.status(400).json({ success: false, error: 'ID non valido.' });
  }

  const existing = db.prepare('SELECT * FROM portfolio_losses WHERE id = ?').get(lossId);
  if (!existing) {
    return res.status(404).json({ success: false, error: 'Minusvalenza non trovata.' });
  }

  const access = checkPortfolioAccess(existing.portfolioId, req.user.id, req.user.role);
  if (!access.isOwner) {
    return res.status(403).json({ success: false, error: 'Accesso negato.' });
  }

  db.prepare('DELETE FROM portfolio_losses WHERE id = ?').run(lossId);

  return res.json({
    success: true,
    message: 'Minusvalenza rimossa con successo.'
  });
});

module.exports = {
  router,
  compensateTaxGain,
  recordTaxLoss
};

