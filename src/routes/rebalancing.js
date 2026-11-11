/**
 * Rebalancing & Target Allocation API Routes
 * Implements Wealthfolio-compatible portfolio rebalancing worksheet,
 * drift tracking, preset models, and execution engine.
 */

const express = require('express');
const { db } = require('../db');
const { requireAuth } = require('../middlewares/authMiddleware');
const { recalculatePortfolio, checkPortfolioAccess } = require('./portfolios');
const { recalculateDividendProjections } = require('./dividends');
const {
  PRESET_TARGET_MODELS,
  DYNAMIC_PRESET_MODELS,
  calculateRebalanceWorksheet,
  generateRebalanceCsv,
  generateClipboardOrderText
} = require('../utils/rebalanceEngine');

const router = express.Router();

router.use(requireAuth);

/**
 * GET /api/rebalancing/presets
 * Returns available preset allocation models.
 */
router.get('/presets', (req, res) => {
  return res.json({
    success: true,
    presets: [...PRESET_TARGET_MODELS, ...DYNAMIC_PRESET_MODELS]
  });
});

/**
 * GET /api/rebalancing/targets
 * Lists custom targets saved for the current user or portfolio.
 */
router.get('/targets', (req, res) => {
  const userId = req.user.id;
  const portfolioId = req.query.portfolioId ? parseInt(req.query.portfolioId, 10) : null;

  let query = 'SELECT * FROM rebalance_targets WHERE user_id = ?';
  const params = [userId];

  if (portfolioId && !isNaN(portfolioId)) {
    query += ' AND (portfolio_id = ? OR portfolio_id IS NULL)';
    params.push(portfolioId);
  }

  query += ' ORDER BY id DESC';

  const rows = db.prepare(query).all(...params);
  const targets = rows.map((r) => {
    let allocations = [];
    try {
      allocations = JSON.parse(r.allocations || '[]');
    } catch {}
    return {
      ...r,
      allowFractional: Boolean(r.allowFractional),
      allocations
    };
  });

  return res.json({
    success: true,
    targets,
    presets: [...PRESET_TARGET_MODELS, ...DYNAMIC_PRESET_MODELS]
  });
});

/**
 * POST /api/rebalancing/targets
 * Creates a new target allocation model.
 */
router.post('/targets', (req, res) => {
  const userId = req.user.id;
  const {
    portfolioId = null,
    name,
    type = 'ASSET_CLASS',
    toleranceBand = 2.0,
    rebalanceMode = 'CASH_FIRST',
    allowFractional = false,
    minTradeSize = 25.0,
    cashBuffer = 0.0,
    allocations = []
  } = req.body || {};

  if (!name || typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ success: false, error: 'Il nome del modello di allocazione è obbligatorio.' });
  }

  if (!Array.isArray(allocations) || allocations.length === 0) {
    return res.status(400).json({ success: false, error: 'Inserisci almeno una categoria o asset con peso percentuale.' });
  }

  // Validate sum of allocations
  const sum = allocations.reduce((acc, a) => acc + (Number(a.targetPercent) || 0), 0);
  if (Math.abs(sum - 100) > 0.5) {
    return res.status(400).json({
      success: false,
      error: `La somma delle percentuali target deve essere 100% (attuale: ${sum.toFixed(1)}%).`
    });
  }

  const pId = portfolioId ? parseInt(portfolioId, 10) : null;
  const stmt = db.prepare(`
    INSERT INTO rebalance_targets (
      user_id, portfolio_id, name, type, toleranceBand,
      rebalanceMode, allowFractional, minTradeSize, cashBuffer,
      allocations, createdAt, updatedAt
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
  `);

  const info = stmt.run(
    userId,
    pId && !isNaN(pId) ? pId : null,
    name.trim(),
    type === 'HOLDING' ? 'HOLDING' : 'ASSET_CLASS',
    Number(toleranceBand) || 2.0,
    rebalanceMode === 'FULL_REBALANCE' ? 'FULL_REBALANCE' : 'CASH_FIRST',
    allowFractional ? 1 : 0,
    Number(minTradeSize) || 25.0,
    Number(cashBuffer) || 0.0,
    JSON.stringify(allocations)
  );

  return res.status(201).json({
    success: true,
    target: {
      id: info.lastInsertRowid,
      name: name.trim(),
      type,
      toleranceBand,
      rebalanceMode,
      allowFractional,
      allocations
    }
  });
});

/**
 * PUT /api/rebalancing/targets/:id
 * Updates an existing target model.
 */
router.put('/targets/:id', (req, res) => {
  const userId = req.user.id;
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ success: false, error: 'ID non valido.' });

  const existing = db.prepare('SELECT * FROM rebalance_targets WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ success: false, error: 'Modello target non trovato.' });

  if (existing.user_id !== userId && req.user.role !== 'admin') {
    return res.status(403).json({ success: false, error: 'Accesso non autorizzato.' });
  }

  const {
    name = existing.name,
    toleranceBand = existing.toleranceBand,
    rebalanceMode = existing.rebalanceMode,
    allowFractional = existing.allowFractional,
    minTradeSize = existing.minTradeSize,
    cashBuffer = existing.cashBuffer,
    allocations = null
  } = req.body || {};

  let allocationsJson = existing.allocations;
  if (Array.isArray(allocations)) {
    const sum = allocations.reduce((acc, a) => acc + (Number(a.targetPercent) || 0), 0);
    if (Math.abs(sum - 100) > 0.5) {
      return res.status(400).json({
        success: false,
        error: `La somma delle percentuali target deve essere 100% (attuale: ${sum.toFixed(1)}%).`
      });
    }
    allocationsJson = JSON.stringify(allocations);
  }

  db.prepare(`
    UPDATE rebalance_targets
    SET name = ?,
        toleranceBand = ?,
        rebalanceMode = ?,
        allowFractional = ?,
        minTradeSize = ?,
        cashBuffer = ?,
        allocations = ?,
        updatedAt = datetime('now')
    WHERE id = ?
  `).run(
    String(name).trim(),
    Number(toleranceBand) || 2.0,
    rebalanceMode === 'FULL_REBALANCE' ? 'FULL_REBALANCE' : 'CASH_FIRST',
    allowFractional ? 1 : 0,
    Number(minTradeSize) || 25.0,
    Number(cashBuffer) || 0.0,
    allocationsJson,
    id
  );

  return res.json({ success: true, message: 'Modello aggiornato con successo.' });
});

/**
 * DELETE /api/rebalancing/targets/:id
 */
router.delete('/targets/:id', (req, res) => {
  const userId = req.user.id;
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ success: false, error: 'ID non valido.' });

  const existing = db.prepare('SELECT * FROM rebalance_targets WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ success: false, error: 'Modello target non trovato.' });

  if (existing.user_id !== userId && req.user.role !== 'admin') {
    return res.status(403).json({ success: false, error: 'Accesso non autorizzato.' });
  }

  db.prepare('DELETE FROM rebalance_targets WHERE id = ?').run(id);
  return res.json({ success: true, message: 'Modello eliminato con successo.' });
});

/**
 * Helper to fetch portfolio holdings and cash.
 */
function getPortfolioHoldingsAndCash(portfolioId, userId, userRole) {
  let holdings = [];
  let currentCash = 0.0;
  let portfolioName = 'Tutti i Portafogli';
  let currency = 'EUR';

  if (portfolioId && portfolioId !== 'all') {
    const pId = parseInt(portfolioId, 10);
    const access = checkPortfolioAccess(pId, userId, userRole);
    if (!access.hasAccess) throw new Error('Accesso non autorizzato al portafoglio.');

    const p = recalculatePortfolio(pId);
    if (!p) throw new Error('Portafoglio non trovato.');

    portfolioName = p.name;
    currency = p.currency || 'EUR';
    currentCash = Number(p.currentCash) || 0.0;
    holdings = p.metrics?.holdings || [];
  } else {
    // All user portfolios aggregated
    let portfolios = [];
    if (userRole === 'admin') {
      portfolios = db.prepare('SELECT * FROM portfolios').all();
    } else {
      portfolios = db.prepare(`
        SELECT p.* FROM portfolios p
        INNER JOIN portfolio_users pu ON pu.portfolio_id = p.id
        WHERE pu.user_id = ?
      `).all(userId);
    }

    const map = new Map();
    for (const p of portfolios) {
      if (!p.include_in_totals) continue;
      const full = recalculatePortfolio(p.id);
      if (!full) continue;
      currentCash += (Number(full.currentCash) || 0.0);

      const pHoldings = full.metrics?.holdings || [];
      for (const h of pHoldings) {
        const key = h.ticker.toUpperCase();
        if (!map.has(key)) {
          map.set(key, { ...h });
        } else {
          const item = map.get(key);
          item.quantity += (Number(h.quantity) || 0.0);
          item.marketValue += (Number(h.marketValue) || 0.0);
          item.bookValue += (Number(h.bookValue) || 0.0);
        }
      }
    }
    holdings = Array.from(map.values());
  }

  return { holdings, currentCash, portfolioName, currency };
}

/**
 * POST /api/rebalancing/calculate
 * Computes the full interactive Rebalancing Worksheet.
 */
router.post('/calculate', (req, res) => {
  const userId = req.user.id;
  const userRole = req.user.role;

  const {
    portfolioId = 'all',
    targetId = null,
    presetId = null,
    customAllocations = null,
    targetType = 'ASSET_CLASS',
    strategy = 'CASH_FIRST',
    addedCash = 0.0,
    toleranceBand = 2.0,
    allowFractional = false,
    minTradeSize = 25.0,
    cashBuffer = 0.0
  } = req.body || {};

  try {
    const { holdings, currentCash, portfolioName, currency } = getPortfolioHoldingsAndCash(
      portfolioId,
      userId,
      userRole
    );

    // Resolve target allocations
    let resolvedAllocations = [];
    let effectiveTargetType = targetType;
    let targetName = 'Modello Personalizzato';

    if (customAllocations && Array.isArray(customAllocations) && customAllocations.length > 0) {
      resolvedAllocations = customAllocations;
    } else if (presetId === 'all_holdings' || presetId === 'equal_weight_holdings') {
      effectiveTargetType = 'HOLDING';
      const count = holdings.length;
      if (count > 0) {
        if (presetId === 'equal_weight_holdings') {
          targetName = 'Equipesato su Tutti i Titoli (Equal Weight)';
          const eqWeight = Number((100.0 / count).toFixed(2));
          let running = 0.0;
          resolvedAllocations = holdings.map((h, i) => {
            const w = (i === count - 1) ? Number((100.0 - running).toFixed(2)) : eqWeight;
            running += w;
            return {
              id: h.ticker,
              ticker: h.ticker,
              label: h.name || h.ticker,
              targetPercent: w
            };
          });
        } else {
          targetName = 'Pesi Attuali Portafoglio (Tutti i Titoli)';
          const totalHoldingsVal = holdings.reduce((sum, h) => sum + (Number(h.marketValue) || 0), 0);
          let runningSum = 0.0;
          resolvedAllocations = holdings.map((h, i) => {
            const curVal = Number(h.marketValue) || 0;
            const w = totalHoldingsVal > 0 ? Number(((curVal / totalHoldingsVal) * 100).toFixed(2)) : 0;
            if (i === count - 1) {
              return {
                id: h.ticker,
                ticker: h.ticker,
                label: h.name || h.ticker,
                targetPercent: Number(Math.max(0, 100.0 - runningSum).toFixed(2))
              };
            }
            runningSum += w;
            return {
              id: h.ticker,
              ticker: h.ticker,
              label: h.name || h.ticker,
              targetPercent: w
            };
          });
        }
      }
    } else if (presetId) {
      const allPresets = [...PRESET_TARGET_MODELS, ...DYNAMIC_PRESET_MODELS];
      const preset = allPresets.find((p) => p.id === presetId);
      if (preset) {
        resolvedAllocations = preset.allocations;
        effectiveTargetType = preset.type;
        targetName = preset.name;
      }
    } else if (targetId) {
      const tRow = db.prepare('SELECT * FROM rebalance_targets WHERE id = ?').get(parseInt(targetId, 10));
      if (tRow) {
        try {
          resolvedAllocations = JSON.parse(tRow.allocations || '[]');
          effectiveTargetType = tRow.type;
          targetName = tRow.name;
        } catch {}
      }
    }

    // Fallback to Classic 60/40 if no target specified
    if (!resolvedAllocations || resolvedAllocations.length === 0) {
      resolvedAllocations = PRESET_TARGET_MODELS[0].allocations;
      effectiveTargetType = PRESET_TARGET_MODELS[0].type;
      targetName = PRESET_TARGET_MODELS[0].name;
    }

    const worksheet = calculateRebalanceWorksheet({
      holdings,
      currentCash,
      addedCash: Number(addedCash) || 0.0,
      targetAllocations: resolvedAllocations,
      targetType: effectiveTargetType,
      strategy: strategy === 'FULL_REBALANCE' ? 'FULL_REBALANCE' : 'CASH_FIRST',
      options: {
        toleranceBand: Number(toleranceBand) || 2.0,
        allowFractional: Boolean(allowFractional),
        minTradeSize: Number(minTradeSize) || 25.0,
        cashBuffer: Number(cashBuffer) || 0.0
      }
    });

    const clipboardText = generateClipboardOrderText(worksheet, portfolioName);

    return res.json({
      success: true,
      targetName,
      portfolioName,
      currency,
      worksheet,
      clipboardText
    });
  } catch (err) {
    console.error('[Rebalance Calculate Error]', err);
    return res.status(400).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/rebalancing/apply
 * Applies the calculated proposed orders directly into the portfolio transactions.
 */
router.post('/apply', (req, res) => {
  const userId = req.user.id;
  const userRole = req.user.role;
  const { portfolioId, orders = [], note = 'Ribilanciamento portafoglio' } = req.body || {};

  if (!portfolioId || portfolioId === 'all') {
    return res.status(400).json({
      success: false,
      error: 'Seleziona uno specifico portafoglio su cui applicare le transazioni di ribilanciamento.'
    });
  }

  const pId = parseInt(portfolioId, 10);
  if (isNaN(pId)) return res.status(400).json({ success: false, error: 'ID portafoglio non valido.' });

  const access = checkPortfolioAccess(pId, userId, userRole);
  if (!access.hasAccess || !access.isOwner) {
    return res.status(403).json({ success: false, error: 'Permessi insufficienti per registrare transazioni in questo portafoglio.' });
  }

  if (!Array.isArray(orders) || orders.length === 0) {
    return res.status(400).json({ success: false, error: 'Nessun ordine fornito da registrare.' });
  }

  const validTrades = orders.filter((o) => (o.action === 'BUY' || o.action === 'SELL') && Number(o.quantity) > 0);
  if (validTrades.length === 0) {
    return res.status(400).json({ success: false, error: 'Nessun ordine BUY o SELL valido da applicare.' });
  }

  const todayStr = new Date().toISOString().split('T')[0];

  try {
    const insertTx = db.prepare(`
      INSERT INTO transactions (
        portfolioId, type, assetTicker, date, quantity, price,
        commission, tax, exchangeRate, amount, notes, linkedTransactionId, createdAt
      ) VALUES (?, ?, ?, ?, ?, ?, 0.0, 0.0, 1.0, ?, ?, NULL, datetime('now'))
    `);

    const applyBatch = db.transaction((trades) => {
      let count = 0;
      for (const t of trades) {
        const ticker = String(t.ticker).toUpperCase().trim();
        const type = t.action.toUpperCase();
        const qty = Number(t.quantity);
        const price = Number(t.price || t.currentPrice);
        const amount = qty * price;
        const txNote = `${note} (${type === 'BUY' ? 'Acquisto' : 'Vendita'})`;

        insertTx.run(pId, type, ticker, todayStr, qty, price, amount, txNote);
        count++;
      }
      return count;
    });

    const appliedCount = applyBatch(validTrades);

    // Recalculate portfolio & dividend projections
    recalculatePortfolio(pId);
    try {
      recalculateDividendProjections(pId);
    } catch {}

    return res.json({
      success: true,
      message: `${appliedCount} ordini di ribilanciamento registrati con successo nel portafoglio.`,
      appliedCount
    });
  } catch (err) {
    console.error('[Rebalance Apply Error]', err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/rebalancing/export-csv
 * Exports the rebalance worksheet as a Wealthfolio-compatible CSV.
 */
router.post('/export-csv', (req, res) => {
  const { worksheet, portfolioName = 'Portfolio' } = req.body || {};
  if (!worksheet || !Array.isArray(worksheet.lines)) {
    return res.status(400).json({ success: false, error: 'Dati foglio di lavoro non validi.' });
  }

  const csvContent = generateRebalanceCsv(worksheet, portfolioName);
  const dateStr = new Date().toISOString().split('T')[0];
  const filename = `rebalancing-worksheet-${portfolioName.replace(/[^a-zA-Z0-9_-]/g, '_')}-${dateStr}.csv`;

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  return res.send(csvContent);
});

module.exports = router;

