const express = require('express');
const { db, getSetting, setSetting, encrypt, decrypt, resetFinancialDatabase } = require('../db');
const { requireAuth } = require('../middlewares/authMiddleware');

const router = express.Router();

// All settings routes require authentication
router.use(requireAuth);

/**
 * GET /api/settings
 * Retrieves all settings for the authenticated user.
 */
router.get('/', (req, res) => {
  const userId = req.user.id;
  const raw = req.query.raw === 'true';

  const rows = db.prepare('SELECT key, value FROM settings WHERE user_id = ?').all(userId);
  const settings = {};

  for (const row of rows) {
    if (raw) {
      settings[row.key] = row.value;
    } else {
      try {
        settings[row.key] = decrypt(row.value);
      } catch (err) {
        settings[row.key] = row.value;
      }
    }
  }

  return res.json({
    success: true,
    settings
  });
});

/**
 * GET /api/settings/:key
 * Retrieves a single setting by key.
 */
router.get('/:key', (req, res) => {
  const userId = req.user.id;
  const { key } = req.params;
  const raw = req.query.raw === 'true';

  const val = getSetting(userId, key, !raw);
  if (val === null) {
    return res.status(404).json({
      success: false,
      error: `Impostazione '${key}' non trovata.`
    });
  }

  return res.json({
    success: true,
    key,
    value: val
  });
});

/**
 * PUT /api/settings
 * Saves one or multiple settings.
 * Supports:
 * - { key: 'name', value: 'val', encrypted: true|false }
 * - OR multiple key-value pairs { key1: 'val1', key2: 'val2' }
 */
router.put('/', (req, res) => {
  const userId = req.user.id;
  const body = req.body;

  if (!body || typeof body !== 'object') {
    return res.status(400).json({
      success: false,
      error: 'Formato payload non valido.'
    });
  }

  // Single key format with explicit encrypted flag
  if (typeof body.key === 'string' && 'value' in body) {
    const shouldEncrypt = Boolean(body.encrypted);
    setSetting(userId, body.key, body.value, shouldEncrypt);
    return res.json({
      success: true,
      message: `Impostazione '${body.key}' salvata con successo.`,
      encrypted: shouldEncrypt
    });
  }

  // Multiple key-values dictionary format
  const keys = Object.keys(body);
  const saveMany = db.transaction(() => {
    for (const key of keys) {
      const val = body[key];
      // Automatically encrypt keys containing 'key', 'secret', 'token', 'password'
      const shouldEncrypt = /key|secret|token|password|api/i.test(key);
      setSetting(userId, key, val, shouldEncrypt);
    }
  });

  saveMany();

  return res.json({
    success: true,
    message: `${keys.length} impostazioni salvate con successo.`
  });
});

/**
 * DELETE /api/settings/:key
 * Deletes a setting.
 */
router.delete('/:key', (req, res) => {
  const userId = req.user.id;
  const { key } = req.params;

  const result = db.prepare('DELETE FROM settings WHERE user_id = ? AND key = ?').run(userId, key);

  if (result.changes === 0) {
    return res.status(404).json({
      success: false,
      error: `Impostazione '${key}' non trovata.`
    });
  }

  return res.json({
    success: true,
    message: `Impostazione '${key}' eliminata con successo.`
  });
});

/**
 * POST /api/settings/reset-financial-data
 * Completely resets all financial data (portfolios, transactions, assets, quotes, history, losses)
 * while preserving users, settings, and currency rates.
 * Requires admin role and explicit confirmation.
 */
router.post('/reset-financial-data', async (req, res) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({
      success: false,
      error: 'Accesso negato: solo gli amministratori possono azzerare il database finanziario.'
    });
  }

  const confirmation = (req.body && (req.body.confirmation || req.body.confirm || ''))
    .toString().trim().toUpperCase();

  if (confirmation !== 'RESET' && confirmation !== 'CONFERMA' && confirmation !== 'TRUE') {
    return res.status(400).json({
      success: false,
      error: 'Conferma esplicita richiesta: inviare confirmation: "RESET" per procedere all\'azzeramento.'
    });
  }

  const createBackup = req.body.createBackup !== false && req.body.createBackup !== 'false';

  try {
    const result = await resetFinancialDatabase({ createSafetyBackup: createBackup });

    try {
      db.prepare('INSERT INTO audit_logs (user_id, action, details) VALUES (?, ?, ?)')
        .run(req.user.id, 'DATABASE_RESET', JSON.stringify(result.deleted));
    } catch {}

    return res.json({
      success: true,
      message: 'Database finanziario azzerato con successo. Tutti i portafogli, movimenti e titoli sono stati rimossi.',
      deleted: result.deleted,
      backup: result.backup
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      error: `Errore durante l'azzeramento del database: ${err.message}`
    });
  }
});

module.exports = router;

