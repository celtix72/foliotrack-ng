const fs = require('fs');
const path = require('path');
const archiverPkg = require('archiver');
const { getDb } = require('./db');

function createZipArchive(options = { zlib: { level: 9 } }) {
  if (typeof archiverPkg === 'function') {
    return archiverPkg('zip', options);
  }
  if (archiverPkg.ZipArchive) {
    return new archiverPkg.ZipArchive(options);
  }
  if (typeof archiverPkg.default === 'function') {
    return archiverPkg.default('zip', options);
  }
  throw new Error('Modulo archiver non supportato.');
}

const BACKUP_DIR = process.env.BACKUP_DIR || path.join(__dirname, '..', 'data', 'backups');
const MAX_BACKUP_RETENTION = 14;

/**
 * Ensures the backup directory exists.
 */
function ensureBackupDir() {
  if (!fs.existsSync(BACKUP_DIR)) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
  }
  return BACKUP_DIR;
}

/**
 * Formats a date into YYYY-MM-DD_HH-mm-ss string.
 * @param {Date} [d] 
 * @returns {string}
 */
function getTimestampString(d = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  const year = d.getFullYear();
  const month = pad(d.getMonth() + 1);
  const day = pad(d.getDate());
  const hours = pad(d.getHours());
  const minutes = pad(d.getMinutes());
  const seconds = pad(d.getSeconds());
  return `${year}-${month}-${day}_${hours}-${minutes}-${seconds}`;
}

/**
 * Purges older backup files keeping only the latest `maxRetained` backups.
 * @param {number} [maxRetained=14] 
 * @returns {{prunedCount: number, deletedFiles: string[]}}
 */
function purgeOldBackups(maxRetained = MAX_BACKUP_RETENTION) {
  ensureBackupDir();
  const files = fs.readdirSync(BACKUP_DIR)
    .filter(f => f.startsWith('foliotrack_backup_') && f.endsWith('.zip'))
    .map(f => {
      const fullPath = path.join(BACKUP_DIR, f);
      const stat = fs.statSync(fullPath);
      return { filename: f, fullPath, mtime: stat.mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime); // Newest first

  const deletedFiles = [];
  if (files.length > maxRetained) {
    const toDelete = files.slice(maxRetained);
    for (const item of toDelete) {
      try {
        fs.unlinkSync(item.fullPath);
        deletedFiles.push(item.filename);
      } catch (err) {
        console.warn(`[Backup Manager] Impossibile eliminare vecchio backup ${item.filename}:`, err.message);
      }
    }
  }

  return {
    prunedCount: deletedFiles.length,
    deletedFiles
  };
}

/**
 * Lists all existing backups sorted newest first.
 * @returns {Array<{filename: string, size: number, sizeFormatted: string, createdAt: string, path: string}>}
 */
function listBackups() {
  ensureBackupDir();
  const files = fs.readdirSync(BACKUP_DIR)
    .filter(f => f.startsWith('foliotrack_backup_') && f.endsWith('.zip'))
    .map(f => {
      const fullPath = path.join(BACKUP_DIR, f);
      const stat = fs.statSync(fullPath);
      const sizeMb = (stat.size / (1024 * 1024)).toFixed(2);
      const sizeKb = (stat.size / 1024).toFixed(1);
      return {
        filename: f,
        size: stat.size,
        sizeFormatted: stat.size > 1048576 ? `${sizeMb} MB` : `${sizeKb} KB`,
        createdAt: stat.mtime.toISOString(),
        path: fullPath
      };
    })
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  return files;
}

/**
 * Creates an atomic backup of the SQLite database and zips it into data/backups/.
 * Applies retention purge (keeps latest 14).
 * @param {object} [options]
 * @param {string} [options.customPrefix]
 * @param {number} [options.retentionCount]
 * @returns {Promise<{success: boolean, filename: string, path: string, size: number, sizeFormatted: string, purged: object}>}
 */
async function createBackup(options = {}) {
  ensureBackupDir();
  const db = getDb();
  const prefix = options.customPrefix || 'foliotrack_backup';
  const timestamp = getTimestampString();
  const zipFilename = `${prefix}_${timestamp}.zip`;
  const zipPath = path.join(BACKUP_DIR, zipFilename);
  const tempDbPath = path.join(BACKUP_DIR, `temp_${timestamp}.db`);

  try {
    // 1. Perform atomic SQLite backup (safe during concurrent writes in WAL mode)
    if (typeof db.backup === 'function') {
      await db.backup(tempDbPath);
    } else {
      // Fallback: copy file if db.backup not available
      const mainDbPath = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'foliotrack.db');
      fs.copyFileSync(mainDbPath, tempDbPath);
    }

    // 2. Compress the temp database into ZIP
    await new Promise((resolve, reject) => {
      const output = fs.createWriteStream(zipPath);
      const archive = createZipArchive({ zlib: { level: 9 } });

      output.on('close', resolve);
      archive.on('error', reject);

      archive.pipe(output);
      archive.file(tempDbPath, { name: 'foliotrack.db' });
      archive.finalize();
    });

    // 3. Remove temp raw file
    if (fs.existsSync(tempDbPath)) {
      fs.unlinkSync(tempDbPath);
    }

    // 4. Check resulting zip stat
    const stat = fs.statSync(zipPath);
    const sizeMb = (stat.size / (1024 * 1024)).toFixed(2);
    const sizeKb = (stat.size / 1024).toFixed(1);

    // 5. Purge old backups (14 days retention)
    const retentionCount = options.retentionCount || MAX_BACKUP_RETENTION;
    const purged = purgeOldBackups(retentionCount);

    return {
      success: true,
      filename: zipFilename,
      path: zipPath,
      size: stat.size,
      sizeFormatted: stat.size > 1048576 ? `${sizeMb} MB` : `${sizeKb} KB`,
      createdAt: new Date().toISOString(),
      purged
    };
  } catch (err) {
    // Cleanup temp file if error occurs
    if (fs.existsSync(tempDbPath)) {
      try { fs.unlinkSync(tempDbPath); } catch (_) {}
    }
    throw new Error(`Errore durante la creazione del backup: ${err.message}`);
  }
}

/**
 * Deletes a specific backup by filename.
 * @param {string} filename 
 * @returns {boolean}
 */
function deleteBackup(filename) {
  ensureBackupDir();
  // Prevent directory traversal attacks
  const safeFilename = path.basename(filename);
  if (!safeFilename.startsWith('foliotrack_backup_') || !safeFilename.endsWith('.zip')) {
    throw new Error('Nome file di backup non valido.');
  }

  const filePath = path.join(BACKUP_DIR, safeFilename);
  if (!fs.existsSync(filePath)) {
    throw new Error('File di backup non trovato.');
  }

  fs.unlinkSync(filePath);
  return true;
}

module.exports = {
  BACKUP_DIR,
  MAX_BACKUP_RETENTION,
  ensureBackupDir,
  getTimestampString,
  purgeOldBackups,
  listBackups,
  createBackup,
  deleteBackup
};
