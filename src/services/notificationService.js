const { getDb, getSetting, setSetting } = require('../db');
const pushService = require('./pushService');

// In-memory cache for asset alert triggers during the trading day to prevent notification fatigue
const notifiedAssetsCache = new Map(); // key: `${todayStr}_${userId}_${ticker}` -> lastNotifiedPercent

/**
 * Checks whether European/US financial markets are open based on Rome CET/CEST time.
 * Standard trading session: Weekdays Monday - Friday from 09:00 to 22:00 CET.
 *
 * @param {Date} [date=new Date()]
 * @returns {{isOpen: boolean, reason: string, currentHHMM: string, dayOfWeek: string}}
 */
function isFinancialMarketOpen(date = new Date()) {
  const timeFormatter = new Intl.DateTimeFormat('it-IT', {
    timeZone: 'Europe/Rome',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  });
  const dayFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Rome',
    weekday: 'short'
  });

  const dayOfWeek = dayFormatter.format(date);
  const currentHHMM = timeFormatter.format(date);

  if (['Sat', 'Sun'].includes(dayOfWeek)) {
    return {
      isOpen: false,
      reason: `Fine settimana (${dayOfWeek}) — Borse chiuse`,
      currentHHMM,
      dayOfWeek
    };
  }

  // European session opens at 09:00 CET, US evening session closes at 22:00 CET
  const openHHMM = '09:00';
  const closeHHMM = '22:00';

  if (currentHHMM >= openHHMM && currentHHMM < closeHHMM) {
    return {
      isOpen: true,
      reason: `Mercati aperti (${openHHMM} - ${closeHHMM} CET)`,
      currentHHMM,
      dayOfWeek
    };
  }

  return {
    isOpen: false,
    reason: `Fuori orario di contrattazione (${currentHHMM} CET, sessione aperta 09:00 - 22:00)`,
    currentHHMM,
    dayOfWeek
  };
}

/**
 * Retrieves configured push notification preferences for a user with sensible defaults.
 *
 * @param {number} userId
 * @returns {object}
 */
function getNotificationSettings(userId) {
  const marketOpenSetting = getSetting(userId, 'notif_market_open_enabled', false);
  const assetChangeSetting = getSetting(userId, 'notif_asset_change_enabled', false);
  const assetThresholdSetting = getSetting(userId, 'notif_asset_change_threshold', false);
  const portfolioChangeSetting = getSetting(userId, 'notif_portfolio_change_enabled', false);
  const portfolioThresholdSetting = getSetting(userId, 'notif_portfolio_change_threshold', false);
  const syncOnlyMarketHoursSetting = getSetting(userId, 'sync_only_market_hours', false);
  const lastPortfolioTotal = getSetting(userId, 'notif_last_notified_portfolio_total', false);

  return {
    marketOpenEnabled: marketOpenSetting !== 'false', // default true
    assetChangeEnabled: assetChangeSetting !== 'false', // default true
    assetChangeThreshold: assetThresholdSetting ? parseFloat(assetThresholdSetting) : 5.0, // default 5.0%
    portfolioChangeEnabled: portfolioChangeSetting !== 'false', // default true
    portfolioChangeThreshold: portfolioThresholdSetting ? parseFloat(portfolioThresholdSetting) : 300.0, // default 300 EUR
    syncOnlyMarketHours: syncOnlyMarketHoursSetting !== 'false', // default true
    lastNotifiedPortfolioTotal: lastPortfolioTotal !== null && !isNaN(parseFloat(lastPortfolioTotal)) ? parseFloat(lastPortfolioTotal) : null
  };
}

/**
 * Saves updated notification settings for a user.
 *
 * @param {number} userId
 * @param {object} settings
 * @returns {object}
 */
function saveNotificationSettings(userId, settings = {}) {
  if (settings.marketOpenEnabled !== undefined) {
    setSetting(userId, 'notif_market_open_enabled', settings.marketOpenEnabled ? 'true' : 'false', false);
  }

  if (settings.assetChangeEnabled !== undefined) {
    setSetting(userId, 'notif_asset_change_enabled', settings.assetChangeEnabled ? 'true' : 'false', false);
  }

  if (settings.assetChangeThreshold !== undefined) {
    const val = parseFloat(settings.assetChangeThreshold);
    if (!isNaN(val) && val > 0) {
      setSetting(userId, 'notif_asset_change_threshold', val.toString(), false);
    }
  }

  if (settings.portfolioChangeEnabled !== undefined) {
    setSetting(userId, 'notif_portfolio_change_enabled', settings.portfolioChangeEnabled ? 'true' : 'false', false);
  }

  if (settings.portfolioChangeThreshold !== undefined) {
    const val = parseFloat(settings.portfolioChangeThreshold);
    if (!isNaN(val) && val > 0) {
      setSetting(userId, 'notif_portfolio_change_threshold', val.toString(), false);
    }
  }

  if (settings.syncOnlyMarketHours !== undefined) {
    setSetting(userId, 'sync_only_market_hours', settings.syncOnlyMarketHours ? 'true' : 'false', false);
  }

  return getNotificationSettings(userId);
}

/**
 * Evaluates whether to send the "Market Open" notification.
 * Triggered on weekdays at or after 09:00 CET once per trading day.
 *
 * @param {number} userId
 * @param {Date} [now=new Date()]
 * @returns {Promise<{sent: boolean, reason?: string}>}
 */
async function checkMarketOpenNotification(userId, now = new Date()) {
  const settings = getNotificationSettings(userId);
  if (!settings.marketOpenEnabled) {
    return { sent: false, reason: 'Notifica apertura mercati disattivata dall\'utente' };
  }

  let todayRomeStr = '';
  let dayOfWeek = '';
  let currentHHMM = '';
  try {
    todayRomeStr = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome' }).format(now);
    dayOfWeek = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Rome', weekday: 'short' }).format(now);
    currentHHMM = new Intl.DateTimeFormat('it-IT', { timeZone: 'Europe/Rome', hour: '2-digit', minute: '2-digit', hour12: false }).format(now);
  } catch {
    todayRomeStr = now.toISOString().split('T')[0];
    currentHHMM = '09:01';
    dayOfWeek = 'Mon';
  }

  // Only Monday to Friday
  if (['Sat', 'Sun'].includes(dayOfWeek)) {
    return { sent: false, reason: 'Weekend: mercati chiusi' };
  }

  // Only at or after 09:00 CET, preferentially in the morning session up to 12:00
  if (currentHHMM < '09:00') {
    return { sent: false, reason: 'Mercati non ancora aperti' };
  }

  const lastNotifiedDate = getSetting(userId, 'notif_last_market_open_date', false);
  if (lastNotifiedDate === todayRomeStr) {
    return { sent: false, reason: `Notifica già inviata per la data ${todayRomeStr}` };
  }

  // Send push notification
  const payload = {
    title: '🔔 Apertura Mercati Finanziari',
    body: 'I mercati europei hanno aperto la sessione odierna (09:00 CET). Quotazioni e book attivi.',
    icon: '/icons/icon-192.png',
    badge: '/favicon.svg',
    url: '/dashboard',
    tag: `market-open-${todayRomeStr}`
  };

  const result = await pushService.sendPushNotification(userId, payload);
  setSetting(userId, 'notif_last_market_open_date', todayRomeStr, false);

  return {
    sent: true,
    result
  };
}

/**
 * Evaluates whether any tracked asset has exceeded the configured percentage variation threshold.
 * (e.g. >= 5% or <= -5%).
 *
 * @param {number} userId
 * @param {Date} [now=new Date()]
 * @returns {Promise<{checked: number, triggered: Array<object>}>}
 */
async function checkAssetChangeNotifications(userId, now = new Date()) {
  const settings = getNotificationSettings(userId);
  if (!settings.assetChangeEnabled) {
    return { checked: 0, triggered: [], skipped: true };
  }

  const threshold = settings.assetChangeThreshold || 5.0;
  const db = getDb();

  let todayStr = '';
  try {
    todayStr = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome' }).format(now);
  } catch {
    todayStr = now.toISOString().split('T')[0];
  }

  // Find assets in the user's portfolios whose abs(changePercent) >= threshold
  const user = db.prepare('SELECT role FROM users WHERE id = ?').get(userId);
  let rows;
  if (user && user.role === 'admin') {
    rows = db.prepare(`
      SELECT DISTINCT a.ticker, a.name, a.currentPrice, a.changePercent, a.changeValue, a.currency
      FROM assets a
      JOIN transactions t ON t.assetTicker = a.ticker
      JOIN portfolios p ON p.id = t.portfolioId
      WHERE a.currentPrice > 0
        AND a.changePercent IS NOT NULL
        AND abs(a.changePercent) >= ?
        AND (a.dataSource IS NULL OR a.dataSource != 'DELISTED')
    `).all(threshold);
  } else {
    rows = db.prepare(`
      SELECT DISTINCT a.ticker, a.name, a.currentPrice, a.changePercent, a.changeValue, a.currency
      FROM assets a
      JOIN transactions t ON t.assetTicker = a.ticker
      JOIN portfolios p ON p.id = t.portfolioId
      INNER JOIN portfolio_users pu ON pu.portfolio_id = p.id
      WHERE pu.user_id = ?
        AND a.currentPrice > 0
        AND a.changePercent IS NOT NULL
        AND abs(a.changePercent) >= ?
        AND (a.dataSource IS NULL OR a.dataSource != 'DELISTED')
    `).all(userId, threshold);
  }

  const triggered = [];

  for (const asset of rows) {
    const cacheKey = `${todayStr}_${userId}_${asset.ticker}`;
    const lastNotified = notifiedAssetsCache.get(cacheKey);

    // If already notified today and difference is less than 2% further shift, skip duplicate spam
    if (lastNotified !== undefined && Math.abs(asset.changePercent - lastNotified) < 2.0) {
      continue;
    }

    const isPos = asset.changePercent >= 0;
    const sign = isPos ? '+' : '';
    const icon = isPos ? '📈' : '📉';
    const pctStr = `${sign}${asset.changePercent.toFixed(2)}%`;
    const priceStr = `${asset.currentPrice.toFixed(2)} ${asset.currency || 'EUR'}`;

    const payload = {
      title: `${icon} Allerta Titolo: ${asset.ticker} (${pctStr})`,
      body: `${asset.name || asset.ticker} registra una forte variazione del ${pctStr} (Prezzo: ${priceStr}).`,
      icon: '/icons/icon-192.png',
      badge: '/favicon.svg',
      url: `/dashboard`,
      tag: `asset-change-${asset.ticker}-${todayStr}`
    };

    try {
      await pushService.sendPushNotification(userId, payload);
      notifiedAssetsCache.set(cacheKey, asset.changePercent);
      triggered.push({
        ticker: asset.ticker,
        changePercent: asset.changePercent,
        price: asset.currentPrice
      });
    } catch (err) {
      console.warn(`[Notification] Error sending push for asset ${asset.ticker}:`, err.message);
    }
  }

  return {
    checked: rows.length,
    triggered
  };
}

/**
 * Calculates current total portfolio value for a user.
 *
 * @param {number} userId
 * @returns {number}
 */
function getTotalPortfolioValue(userId) {
  const db = getDb();
  const user = db.prepare('SELECT role FROM users WHERE id = ?').get(userId);
  let row;
  if (user && user.role === 'admin') {
    row = db.prepare(`
      SELECT SUM(totalValue) as total
      FROM portfolios
      WHERE (include_in_totals = 1 OR include_in_totals IS NULL)
    `).get();
  } else {
    row = db.prepare(`
      SELECT SUM(p.totalValue) as total
      FROM portfolios p
      INNER JOIN portfolio_users pu ON pu.portfolio_id = p.id
      WHERE pu.user_id = ? AND (p.include_in_totals = 1 OR p.include_in_totals IS NULL)
    `).get(userId);
  }

  return row && row.total ? parseFloat(row.total) : 0;
}

/**
 * Evaluates whether total portfolio value has changed by more than the configured EUR threshold
 * compared to the previous notification of this type.
 *
 * @param {number} userId
 * @returns {Promise<{sent: boolean, currentTotal: number, lastTotal?: number, diff?: number, reason?: string}>}
 */
async function checkPortfolioChangeNotification(userId) {
  const settings = getNotificationSettings(userId);
  if (!settings.portfolioChangeEnabled) {
    return { sent: false, currentTotal: 0, reason: 'Notifica variazione portafoglio disattivata' };
  }

  const threshold = settings.portfolioChangeThreshold || 300.0;
  const currentTotal = getTotalPortfolioValue(userId);

  if (currentTotal <= 0) {
    return { sent: false, currentTotal, reason: 'Nessun portafoglio valorizzato per questo utente' };
  }

  const lastTotal = settings.lastNotifiedPortfolioTotal;

  // If no prior notification baseline exists, set current total as baseline without firing
  if (lastTotal === null || isNaN(lastTotal)) {
    setSetting(userId, 'notif_last_notified_portfolio_total', currentTotal.toString(), false);
    return {
      sent: false,
      currentTotal,
      reason: 'Baseline iniziale portafoglio registrata'
    };
  }

  const diff = currentTotal - lastTotal;
  const absDiff = Math.abs(diff);

  if (absDiff >= threshold) {
    const isUp = diff >= 0;
    const sign = isUp ? '+' : '-';
    const icon = isUp ? '🟢' : '🔴';
    const diffFormatted = `${sign}€${absDiff.toLocaleString('it-IT', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    const totalFormatted = `€${currentTotal.toLocaleString('it-IT', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

    const payload = {
      title: `💼 Variazione Portafoglio: ${diffFormatted}`,
      body: `Il patrimonio complessivo è variato di ${diffFormatted} rispetto alla precedente notifica (Nuovo Totale: ${totalFormatted}).`,
      icon: '/icons/icon-192.png',
      badge: '/favicon.svg',
      url: '/portfolios',
      tag: `portfolio-change-${Date.now()}`
    };

    const result = await pushService.sendPushNotification(userId, payload);
    // Update baseline to the current total after successfully recording the notification
    setSetting(userId, 'notif_last_notified_portfolio_total', currentTotal.toString(), false);

    return {
      sent: true,
      diff,
      absDiff,
      currentTotal,
      previousTotal: lastTotal,
      result
    };
  }

  return {
    sent: false,
    diff,
    absDiff,
    currentTotal,
    previousTotal: lastTotal,
    threshold,
    reason: `Variazione (€${absDiff.toFixed(2)}) inferiore alla soglia impostata (€${threshold.toFixed(2)})`
  };
}

/**
 * Sends a simulated test notification of the specified type directly to the user's registered smartphone / browser.
 *
 * @param {number} userId
 * @param {'market_open'|'asset_change'|'portfolio_change'} type
 * @returns {Promise<{success: boolean, message: string, result?: object}>}
 */
async function sendTestNotification(userId, type) {
  const currentTotal = getTotalPortfolioValue(userId);
  let payload = null;

  switch (type) {
    case 'market_open':
      payload = {
        title: '🔔 [TEST] Apertura Mercati Finanziari',
        body: 'I mercati europei hanno aperto la sessione odierna (09:00 CET). Quotazioni e book attivi.',
        icon: '/icons/icon-192.png',
        badge: '/favicon.svg',
        url: '/dashboard',
        tag: `test-market-open-${Date.now()}`
      };
      break;

    case 'asset_change':
      payload = {
        title: '📈 [TEST] Allerta Titolo: ENEL.MI (+5.40%)',
        body: 'Enel S.p.A. registra una forte variazione odierna di +5.40% (superata soglia del 5%). Prezzo: 6.84 EUR.',
        icon: '/icons/icon-192.png',
        badge: '/favicon.svg',
        url: '/dashboard',
        tag: `test-asset-change-${Date.now()}`
      };
      break;

    case 'portfolio_change': {
      const simulatedTotal = currentTotal > 0 ? currentTotal : 28500.0;
      payload = {
        title: '💼 [TEST] Variazione Portafoglio: +€300,00',
        body: `Il patrimonio complessivo è variato di +€300,00 rispetto alla precedente notifica. Totale simulato: €${simulatedTotal.toLocaleString('it-IT', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}.`,
        icon: '/icons/icon-192.png',
        badge: '/favicon.svg',
        url: '/portfolios',
        tag: `test-portfolio-change-${Date.now()}`
      };
      break;
    }

    default:
      throw new Error(`Tipo notifica di test sconosciuto: '${type}'. Tipi ammessi: 'market_open', 'asset_change', 'portfolio_change'.`);
  }

  const result = await pushService.sendPushNotification(userId, payload);
  if (result.sent === 0) {
    return {
      success: false,
      message: 'Nessun dispositivo registrato o autorizzato per ricevere notifiche push su questo account. Clicca su "Attiva Notifiche su questo Smartphone" prima di eseguire il test.',
      result
    };
  }

  return {
    success: true,
    message: `Notifica di test inviata con successo (${result.sent} dispositivo/i recapitato/i).`,
    result
  };
}

module.exports = {
  isFinancialMarketOpen,
  getNotificationSettings,
  saveNotificationSettings,
  checkMarketOpenNotification,
  checkAssetChangeNotifications,
  checkPortfolioChangeNotification,
  sendTestNotification,
  getTotalPortfolioValue
};
