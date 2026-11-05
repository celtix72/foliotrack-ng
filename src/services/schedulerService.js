const { getDb, getSetting } = require('../db');
const { recordDailySnapshot } = require('../routes/history');
const { createBackup } = require('../backup_manager');
const { sendDailyDigest, checkAndSendAssetAlerts } = require('./telegramService');
const { sendPushNotification } = require('./pushService');
const { updateAllAssetPrices, resetDailyAssetDeltas } = require('./marketService');

let schedulerInterval = null;
let lastResetDate = null;
let lastSnapshotDate = null;
let lastBackupDate = null;
let lastDigestDate = null;
let lastQuotesSyncTime = null;
let cachedFrequencyMinutes = null;

/**
 * Retrieves the configured realtime quote sync frequency in minutes.
 * Defaults to 30 minutes.
 *
 * @returns {number}
 */
function getQuoteSyncFrequencyMinutes() {
  try {
    const db = getDb();
    let effectiveFrequency = cachedFrequencyMinutes || 30;

    const row = db.prepare(`
      SELECT value FROM settings
      WHERE key = 'quote_sync_frequency_minutes'
      LIMIT 1
    `).get();
    if (row && row.value) {
      const parsed = parseInt(row.value, 10);
      if (parsed > 0 && !isNaN(parsed)) {
        effectiveFrequency = parsed;
      }
    }

    // Check if any enabled provider has a tighter frequency configured (e.g. YAHOO set to 1 min)
    const providerRows = db.prepare(`
      SELECT value FROM settings
      WHERE key LIKE 'provider_config_%'
    `).all();
    for (const pr of providerRows) {
      try {
        const pcfg = JSON.parse(pr.value);
        if (pcfg && pcfg.enabled !== false && pcfg.frequencyMinutes) {
          const f = parseInt(pcfg.frequencyMinutes, 10);
          if (f > 0 && f < effectiveFrequency) {
            effectiveFrequency = f;
          }
        }
      } catch {}
    }

    cachedFrequencyMinutes = effectiveFrequency;
    return effectiveFrequency;
  } catch (err) {
    // fallback to cached or default
  }
  return cachedFrequencyMinutes || 30;
}

/**
 * Manually updates the cached frequency in minutes.
 *
 * @param {number} minutes
 */
function setQuoteSyncFrequencyMinutes(minutes) {
  const val = Math.max(1, parseInt(minutes, 10) || 30);
  cachedFrequencyMinutes = val;
  return val;
}

/**
 * Returns current scheduler status for quote syncing.
 */
function getQuotesSchedulerStatus() {
  const frequencyMinutes = getQuoteSyncFrequencyMinutes();
  const freqMs = frequencyMinutes * 60 * 1000;
  const now = Date.now();
  const lastSync = lastQuotesSyncTime ? new Date(lastQuotesSyncTime).toISOString() : null;
  const nextSync = lastQuotesSyncTime
    ? new Date(lastQuotesSyncTime + freqMs).toISOString()
    : new Date(now + freqMs).toISOString();

  return {
    frequencyMinutes,
    lastSyncAt: lastSync,
    nextSyncAt: nextSync
  };
}

/**
 * Runs scheduled checks:
 * 0. Realtime Quotes refresh (configurable frequency in minutes, default 30 min).
 * 1. Alerts check (price targets & stop losses) every hour or check interval.
 * 2. Daily market close digest (e.g., at 18:30 Europe/Rome or once daily).
 * 3. Daily NAV snapshot (once daily at close).
 * 4. Daily backup (nightly, e.g. at 02:00 or once daily).
 */
async function runScheduledTick() {
  const now = new Date();
  const currentDateStr = now.toISOString().split('T')[0];
  const currentHour = now.getHours();
  const nowMs = now.getTime();

  let todayRomeStr = '';
  try {
    todayRomeStr = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome' }).format(now);
  } catch {
    todayRomeStr = currentDateStr;
  }

  // At the start of every trading day (or on startup), reset prior day deltas so today's session starts strictly at 0 delta
  if (lastResetDate !== todayRomeStr) {
    try {
      resetDailyAssetDeltas();
      lastResetDate = todayRomeStr;
    } catch (err) {
      console.warn('[Scheduler] Errore azzeramento delta inizio giornata:', err.message);
    }
  }

  // 0. Configurable Realtime Quote Sync (Default 30 min)
  const freqMinutes = getQuoteSyncFrequencyMinutes();
  const freqMs = freqMinutes * 60 * 1000;

  if (lastQuotesSyncTime === null) {
    try {
      const db = getDb();
      const row = db.prepare('SELECT MAX(lastSyncAt) as latest FROM assets').get();
      if (row && row.latest) {
        lastQuotesSyncTime = new Date(row.latest).getTime();
      }
    } catch {}
  }

  if (lastQuotesSyncTime === null || isNaN(lastQuotesSyncTime) || (nowMs - lastQuotesSyncTime) >= freqMs) {
    lastQuotesSyncTime = nowMs;
    try {
      console.log(`[Scheduler] Esecuzione aggiornamento periodico quotazioni realtime (frequenza: ${freqMinutes}m)...`);
      const res = await updateAllAssetPrices({ delayMs: 150 });
      console.log(`[Scheduler] Aggiornamento quotazioni completato: ${res.updated}/${res.total} (errori: ${res.failed})`);
    } catch (err) {
      console.warn('[Scheduler] Errore aggiornamento automatico quotazioni:', err.message);
    }
  }

  // 1. Asset Price Alerts check
  try {
    const alertResult = await checkAndSendAssetAlerts(null, { notify: true });
    if (alertResult.triggered && alertResult.triggered.length > 0) {
      console.log(`[Scheduler] Price alerts triggered: ${alertResult.triggered.length}`);
    }
  } catch (err) {
    console.warn('[Scheduler] Errore verifica alert:', err.message);
  }

  // 2. Daily Snapshot check (runs once per day, preferentially after 18:00 or if not done)
  if (lastSnapshotDate !== currentDateStr && currentHour >= 18) {
    try {
      recordDailySnapshot();
      lastSnapshotDate = currentDateStr;
      console.log(`[Scheduler] Snapshot NAV registrato con successo per la data ${currentDateStr}`);
    } catch (err) {
      console.warn('[Scheduler] Errore registrazione snapshot NAV:', err.message);
    }
  }

  // 3. Daily Market Digest check (runs once per day around 18:30 or later)
  if (lastDigestDate !== currentDateStr && currentHour >= 18) {
    try {
      const db = getDb();
      // Find all users who have configured Telegram or Push
      const users = db.prepare('SELECT id, username FROM users').all();
      for (const user of users) {
        const tgToken = getSetting(user.id, 'telegram_bot_token') || process.env.TELEGRAM_BOT_TOKEN;
        const tgChat = getSetting(user.id, 'telegram_chat_id') || process.env.TELEGRAM_CHAT_ID;
        if (tgToken && tgChat) {
          await sendDailyDigest(user.id);
        }
      }
      lastDigestDate = currentDateStr;
    } catch (err) {
      console.warn('[Scheduler] Errore invio daily market digest:', err.message);
    }
  }

  // 4. Daily Database Backup check (runs once per day, preferably at night around 02:00-04:00 or first run)
  if (lastBackupDate !== currentDateStr && (currentHour >= 2 || !lastBackupDate)) {
    try {
      const backup = await createBackup();
      lastBackupDate = currentDateStr;
      console.log(`[Scheduler] Backup automatico creato: ${backup.filename} (${backup.sizeFormatted})`);
    } catch (err) {
      console.warn('[Scheduler] Errore creazione backup automatico:', err.message);
    }
  }
}

/**
 * Starts the background scheduler.
 * @param {number} [intervalMs=60000] - Default: 60 seconds tick to evaluate minute-based schedules
 */
function startScheduler(intervalMs = 60000) {
  if (schedulerInterval) return;

  console.log(`[Scheduler] Avviato servizio schedulatore automatico (intervallo controllo: ${Math.round(intervalMs / 1000)}s)`);

  // Run initial tick with non-blocking delay
  setTimeout(() => {
    runScheduledTick().catch(e => console.warn('[Scheduler] Error on first tick:', e.message));
  }, 2000);

  schedulerInterval = setInterval(() => {
    runScheduledTick().catch(e => console.warn('[Scheduler] Error on tick:', e.message));
  }, intervalMs);

  // Unref interval so it does not keep Node process alive during test teardown if needed
  if (schedulerInterval.unref) {
    schedulerInterval.unref();
  }
}

/**
 * Stops the background scheduler.
 */
function stopScheduler() {
  if (schedulerInterval) {
    clearInterval(schedulerInterval);
    schedulerInterval = null;
    console.log('[Scheduler] Schedulatore automatico arrestato.');
  }
}

module.exports = {
  runScheduledTick,
  startScheduler,
  stopScheduler,
  getQuoteSyncFrequencyMinutes,
  setQuoteSyncFrequencyMinutes,
  getQuotesSchedulerStatus
};

