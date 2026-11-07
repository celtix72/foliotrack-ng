const express = require('express');
const path = require('path');
const fs = require('fs');
const { db, resetFinancialDatabase } = require('../db');
const { requireAuth, requireRole } = require('../middlewares/authMiddleware');
const { 
  listBackups, 
  createBackup, 
  deleteBackup, 
  BACKUP_DIR 
} = require('../backup_manager');
const { 
  uploadBackupToDrive, 
  isGoogleDriveConfigured 
} = require('../services/gdriveBackupService');

const router = express.Router();

// All backup routes require authentication and admin privileges
router.use(requireAuth, requireRole('admin'));

/**
 * GET /api/backups
 * Returns list of all available backups and Google Drive configuration status.
 */
router.get('/', (req, res) => {
  try {
    const backups = listBackups();
    const gdriveConfigured = isGoogleDriveConfigured(req.user.id);

    return res.json({
      success: true,
      count: backups.length,
      backups,
      gdriveConfigured
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

/**
 * POST /api/backups/create
 * Creates an immediate atomic backup of the database in .zip format.
 */
router.post('/create', async (req, res) => {
  try {
    const backup = await createBackup({
      customPrefix: req.body.prefix,
      retentionCount: req.body.retentionCount ? parseInt(req.body.retentionCount, 10) : 14
    });

    let gdriveResult = null;
    if (req.body.uploadToGoogleDrive) {
      gdriveResult = await uploadBackupToDrive(backup.path, { userId: req.user.id });
    }

    return res.json({
      success: true,
      message: `Backup '${backup.filename}' generato con successo (${backup.sizeFormatted}).`,
      backup,
      gdrive: gdriveResult
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

/**
 * GET /api/backups/download/:filename
 * Downloads the requested backup .zip file.
 */
router.get('/download/:filename', (req, res) => {
  try {
    const safeFilename = path.basename(req.params.filename);
    if (!safeFilename.startsWith('foliotrack_backup_') || !safeFilename.endsWith('.zip')) {
      return res.status(400).json({
        success: false,
        error: 'Nome file di backup non valido.'
      });
    }

    const filePath = path.join(BACKUP_DIR, safeFilename);
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({
        success: false,
        error: 'File di backup non trovato sul server.'
      });
    }

    return res.download(filePath, safeFilename);
  } catch (err) {
    return res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

/**
 * DELETE /api/backups/:filename
 * Deletes a backup from disk.
 */
router.delete('/:filename', (req, res) => {
  try {
    const safeFilename = path.basename(req.params.filename);
    deleteBackup(safeFilename);

    return res.json({
      success: true,
      message: `Backup '${safeFilename}' eliminato con successo.`
    });
  } catch (err) {
    return res.status(400).json({
      success: false,
      error: err.message
    });
  }
});

/**
 * POST /api/backups/gdrive-upload/:filename
 * Uploads an existing backup to Google Drive.
 */
router.post('/gdrive-upload/:filename', async (req, res) => {
  try {
    const safeFilename = path.basename(req.params.filename);
    const filePath = path.join(BACKUP_DIR, safeFilename);

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({
        success: false,
        error: 'File di backup non trovato sul server.'
      });
    }

    const result = await uploadBackupToDrive(filePath, { userId: req.user.id });
    if (!result.success) {
      return res.status(400).json(result);
    }

    return res.json(result);
  } catch (err) {
    return res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

/**
 * POST /api/backups/reset-database
 * Completely resets all financial data (portfolios, transactions, assets, quotes)
 * starting completely empty. Alias for /api/settings/reset-financial-data.
 */
router.post('/reset-database', async (req, res) => {
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

