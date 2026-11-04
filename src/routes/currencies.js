const express = require('express');
const { db } = require('../db');
const { requireAuth } = require('../middlewares/authMiddleware');
const { syncAllCurrencyRates } = require('../services/marketService');

const router = express.Router();

router.use(requireAuth);

/**
 * GET /api/currencies
 * Lists all currency exchange rate pairs with current values.
 */
router.get('/', (req, res) => {
  try {
    const rates = db.prepare(`
      SELECT * FROM currency_rates
      ORDER BY fromCurrency ASC, toCurrency ASC
    `).all();

    return res.json({
      success: true,
      rates
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/currencies
 * Adds a new currency pair.
 */
router.post('/', (req, res) => {
  const { from, to, rate, source = 'MANUAL' } = req.body || {};

  if (!from || !to) {
    return res.status(400).json({ success: false, error: 'Valute sorgente e destinazione obbligatorie (es. EUR, USD).' });
  }

  const cleanFrom = from.trim().toUpperCase();
  const cleanTo = to.trim().toUpperCase();
  const pair = `${cleanFrom}/${cleanTo}`;
  const numRate = Number(rate) || 1.0;

  try {
    const stmt = db.prepare(`
      INSERT INTO currency_rates (pair, fromCurrency, toCurrency, rate, source, updatedAt)
      VALUES (?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(pair) DO UPDATE SET
        rate = excluded.rate,
        source = excluded.source,
        updatedAt = datetime('now')
    `);

    stmt.run(pair, cleanFrom, cleanTo, numRate, source);

    const saved = db.prepare('SELECT * FROM currency_rates WHERE pair = ?').get(pair);
    return res.status(201).json({
      success: true,
      rate: saved
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * PUT /api/currencies/:pair
 * Updates an existing currency pair rate manually.
 */
router.put('/:pair', (req, res) => {
  const pairParam = decodeURIComponent(req.params.pair).toUpperCase().trim();
  const { rate, source = 'MANUAL' } = req.body || {};

  if (rate === undefined || isNaN(Number(rate)) || Number(rate) <= 0) {
    return res.status(400).json({ success: false, error: 'Tasso di cambio valido maggiore di 0 obbligatorio.' });
  }

  try {
    const numRate = Number(rate);
    const result = db.prepare(`
      UPDATE currency_rates
      SET rate = ?, source = ?, updatedAt = datetime('now')
      WHERE pair = ?
    `).run(numRate, source, pairParam);

    if (result.changes === 0) {
      return res.status(404).json({ success: false, error: `Coppia valutaria '${pairParam}' non trovata.` });
    }

    const updated = db.prepare('SELECT * FROM currency_rates WHERE pair = ?').get(pairParam);
    return res.json({
      success: true,
      rate: updated
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * DELETE /api/currencies/:pair
 * Deletes a currency pair.
 */
router.delete('/:pair', (req, res) => {
  const pairParam = decodeURIComponent(req.params.pair).toUpperCase().trim();

  try {
    const result = db.prepare('DELETE FROM currency_rates WHERE pair = ?').run(pairParam);
    if (result.changes === 0) {
      return res.status(404).json({ success: false, error: `Coppia valutaria '${pairParam}' non trovata.` });
    }

    return res.json({
      success: true,
      message: `Coppia valutaria '${pairParam}' eliminata con successo.`
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/currencies/sync
 * Syncs real-time FX rates from Yahoo Finance.
 */
router.post('/sync', async (req, res) => {
  try {
    const result = await syncAllCurrencyRates();
    return res.json({
      success: true,
      message: `Sincronizzazione FX completata: ${result.updated}/${result.total} tassi aggiornati.`,
      ...result
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;

