const { getDb, getSetting } = require('../db');
const { recalculatePortfolio } = require('../routes/portfolios');

/**
 * Escapes HTML characters for Telegram HTML mode.
 * @param {string} text 
 * @returns {string}
 */
function escapeHtml(text) {
  if (!text) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Sends a message via Telegram Bot API using parse_mode: 'HTML'.
 * @param {string} text - The formatted HTML message
 * @param {object} [options]
 * @param {string} [options.botToken] - Explicit token override
 * @param {string|number} [options.chatId] - Explicit chat ID override
 * @param {number} [options.userId] - User ID to load settings for
 * @param {Function} [options.fetchFn] - Custom fetch function (for unit tests)
 * @returns {Promise<{success: boolean, messageId?: number, error?: string}>}
 */
async function sendTelegramMessage(text, options = {}) {
  const fetchFn = options.fetchFn || global.fetch;
  let botToken = options.botToken;
  let chatId = options.chatId;

  // Resolve botToken and chatId from user settings or environment variables
  if (!botToken && options.userId) {
    botToken = getSetting(options.userId, 'telegram_bot_token');
  }
  if (!botToken) {
    botToken = process.env.TELEGRAM_BOT_TOKEN;
  }

  if (!chatId && options.userId) {
    chatId = getSetting(options.userId, 'telegram_chat_id');
  }
  if (!chatId) {
    chatId = process.env.TELEGRAM_CHAT_ID;
  }

  if (!botToken || !chatId) {
    return {
      success: false,
      error: 'Credenziali Telegram non configurate (botToken o chatId mancante).'
    };
  }

  const endpoint = `https://api.telegram.org/bot${botToken}/sendMessage`;
  const payload = {
    chat_id: chatId,
    text: text,
    parse_mode: options.parse_mode || 'HTML',
    disable_web_page_preview: true
  };

  try {
    const res = await fetchFn(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const data = await res.json();
    if (!res.ok || !data.ok) {
      const errMsg = data.description || `HTTP ${res.status}`;
      return { success: false, error: errMsg };
    }

    return {
      success: true,
      messageId: data.result?.message_id
    };
  } catch (err) {
    return {
      success: false,
      error: `Errore di connessione a Telegram API: ${err.message}`
    };
  }
}

/**
 * Formats a clean, professional financial market digest in HTML for Telegram.
 * @param {object} data
 * @returns {string}
 */
function formatDailyDigest(data) {
  const {
    date = new Date().toLocaleDateString('it-IT', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }),
    totalNav = 0,
    totalCash = 0,
    perf1DValue = 0,
    perf1DPercent = 0,
    totalUnrealizedPnl = 0,
    totalUnrealizedPnlPercent = 0,
    topGainer = null,
    worstLoser = null,
    portfolioName = 'Tutti i Portafogli'
  } = data;

  const isPos1D = perf1DPercent >= 0;
  const isPosTot = totalUnrealizedPnl >= 0;
  const emoji1D = perf1DPercent > 0.05 ? '📈 🟢' : (perf1DPercent < -0.05 ? '📉 🔴' : '➖ ⚪');
  const sign1D = isPos1D ? '+' : '';
  const signTot = isPosTot ? '+' : '';

  const fmtEur = (n) => (Number(n) || 0).toLocaleString('it-IT', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const fmtPct = (n) => (Number(n) || 0).toLocaleString('it-IT', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  let msg = `🏛 <b>FolioTrack — Chiusura Mercati</b>\n`;
  msg += `🗓 <i>${escapeHtml(date)}</i>\n`;
  msg += `📁 <b>Portafoglio:</b> <i>${escapeHtml(portfolioName)}</i>\n\n`;

  msg += `💰 <b>Patrimonio (NAV):</b> <code>€${fmtEur(totalNav)}</code>\n`;
  msg += `${emoji1D} <b>Performance 1D:</b> <code>${sign1D}€${fmtEur(perf1DValue)} (${sign1D}${fmtPct(perf1DPercent)}%)</code>\n`;
  msg += `💵 <b>Liquidità Residua:</b> <code>€${fmtEur(totalCash)}</code>\n`;
  msg += `📊 <b>P&L Non Realizzato:</b> <code>${signTot}€${fmtEur(totalUnrealizedPnl)} (${signTot}${fmtPct(totalUnrealizedPnlPercent)}%)</code>\n\n`;

  if (topGainer || worstLoser) {
    msg += `<b>Migliori e Peggiori di Giornata:</b>\n`;
    if (topGainer) {
      const gPct = (topGainer.changePercent || 0) >= 0 ? `+${fmtPct(topGainer.changePercent)}%` : `${fmtPct(topGainer.changePercent)}%`;
      msg += `🏆 <b>Top Gainer:</b> <code>${escapeHtml(topGainer.ticker)}</code> <i>(${gPct})</i>\n`;
    }
    if (worstLoser) {
      const lPct = (worstLoser.changePercent || 0) >= 0 ? `+${fmtPct(worstLoser.changePercent)}%` : `${fmtPct(worstLoser.changePercent)}%`;
      msg += `⚠️ <b>Worst Performer:</b> <code>${escapeHtml(worstLoser.ticker)}</code> <i>(${lPct})</i>\n`;
    }
    msg += `\n`;
  }

  msg += `⚡ <i>FolioTrack Self-Hosted Engine</i>`;
  return msg;
}

/**
 * Compiles user portfolio summary and sends daily digest via Telegram.
 * @param {number} userId 
 * @param {object} [options]
 * @returns {Promise<{success: boolean, messageId?: number, error?: string, summary?: object}>}
 */
async function sendDailyDigest(userId, options = {}) {
  const db = getDb();

  // Find user's accessible portfolios
  const portfolios = db.prepare(`
    SELECT p.* FROM portfolios p
    JOIN portfolio_users pu ON pu.portfolio_id = p.id
    WHERE pu.user_id = ?
    ORDER BY p.id ASC
  `).all(userId);

  if (portfolios.length === 0) {
    return { success: false, error: 'Nessun portafoglio trovato per l\'utente.' };
  }

  // Aggregate metrics
  let totalNav = 0;
  let totalCash = 0;
  let total1DVal = 0;
  let totalInvested = 0;
  const allHoldings = [];

  for (const p of portfolios) {
    const pMetrics = recalculatePortfolio(p.id);
    if (!pMetrics) continue;
    totalNav += pMetrics.totalValue || 0;
    totalCash += pMetrics.currentCash || 0;
    totalInvested += pMetrics.investedCapital || 0;

    for (const h of (pMetrics.holdings || [])) {
      allHoldings.push(h);
      if (h.changeValue && h.shares) {
        total1DVal += (h.changeValue * h.shares);
      }
    }
  }

  const prevNav = totalNav - total1DVal;
  const perf1DPercent = prevNav > 0 ? (total1DVal / prevNav) * 100 : 0;
  const totalUnrealizedPnl = totalNav - totalInvested;
  const totalUnrealizedPnlPercent = totalInvested > 0 ? (totalUnrealizedPnl / totalInvested) * 100 : 0;

  // Find top gainer and worst performer among holdings (excluding unmonitored assets)
  let topGainer = null;
  let worstLoser = null;

  let unmonitoredSet = new Set();
  try {
    const unmonitoredRows = db.prepare('SELECT ticker FROM analysis_watchlist WHERE isMonitored = 0').all();
    unmonitoredSet = new Set(unmonitoredRows.map(r => r.ticker.toUpperCase().trim()));
  } catch {}

  const eligibleHoldings = allHoldings.filter(h => !unmonitoredSet.has((h.ticker || '').toUpperCase().trim()));

  if (eligibleHoldings.length > 0) {
    const sorted = [...eligibleHoldings].sort((a, b) => (b.changePercent || 0) - (a.changePercent || 0));
    topGainer = sorted[0];
    worstLoser = sorted[sorted.length - 1];
    if (topGainer && topGainer.changePercent <= 0) {
      topGainer = null;
    }
    if (worstLoser && worstLoser.changePercent >= 0) {
      worstLoser = null;
    }
  }

  const summary = {
    totalNav,
    totalCash,
    perf1DValue: total1DVal,
    perf1DPercent,
    totalUnrealizedPnl,
    totalUnrealizedPnlPercent,
    topGainer,
    worstLoser,
    portfolioName: portfolios.length === 1 ? portfolios[0].name : `Tutti (${portfolios.length} Portafogli)`
  };

  const message = formatDailyDigest(summary);
  const result = await sendTelegramMessage(message, { userId, ...options });

  return {
    ...result,
    summary
  };
}

/**
 * Checks price alerts (targetPrice and stopLoss) across all assets and sends notifications.
 * @param {number} [userId] - Optional user filter
 * @param {object} [options]
 * @returns {Promise<{checked: number, triggered: Array}>}
 */
async function checkAndSendAssetAlerts(userId = null, options = {}) {
  const db = getDb();
  const user = userId ? db.prepare('SELECT role FROM users WHERE id = ?').get(userId) : null;
  const isAdmin = user && user.role === 'admin';

  let query = '';
  const params = [];

  if (userId && !isAdmin) {
    query = `
      SELECT DISTINCT
        a.ticker,
        a.name,
        a.currentPrice,
        COALESCE(w.takeProfit, a.targetPrice) as targetPrice,
        COALESCE(w.stopLoss, a.stopLoss) as stopLoss,
        a.currency
      FROM assets a
      JOIN transactions t ON t.assetTicker = a.ticker
      JOIN portfolio_users pu ON pu.portfolio_id = t.portfolioId
      LEFT JOIN analysis_watchlist w ON w.ticker = a.ticker
      WHERE pu.user_id = ?
        AND (w.isMonitored IS NULL OR w.isMonitored = 1)
    `;
    params.push(userId);
  } else {
    query = `
      SELECT DISTINCT
        a.ticker,
        a.name,
        a.currentPrice,
        COALESCE(w.takeProfit, a.targetPrice) as targetPrice,
        COALESCE(w.stopLoss, a.stopLoss) as stopLoss,
        a.currency
      FROM assets a
      JOIN transactions t ON t.assetTicker = a.ticker
      LEFT JOIN analysis_watchlist w ON w.ticker = a.ticker
      WHERE (w.isMonitored IS NULL OR w.isMonitored = 1)
    `;
  }

  const assets = db.prepare(query).all(...params);
  const triggered = [];

  for (const asset of assets) {
    const price = Number(asset.currentPrice) || 0;
    const target = Number(asset.targetPrice);
    const stopLoss = Number(asset.stopLoss);
    const curr = asset.currency || 'EUR';

    if (target > 0 && price >= target) {
      const alert = {
        type: 'TARGET_REACHED',
        ticker: asset.ticker,
        name: asset.name,
        currentPrice: price,
        targetPrice: target,
        currency: curr,
        message: `🎯 <b>Prezzo Target Raggiunto!</b>\nL'asset <b>${escapeHtml(asset.name)}</b> (<code>${escapeHtml(asset.ticker)}</code>) ha toccato <b>${price.toFixed(2)} ${curr}</b>, superando il target di <b>${target.toFixed(2)} ${curr}</b>.`
      };
      triggered.push(alert);
      if (options.notify !== false) {
        await sendTelegramMessage(alert.message, { userId, ...options });
      }
    }

    if (stopLoss > 0 && price <= stopLoss) {
      const alert = {
        type: 'STOP_LOSS_TRIGGERED',
        ticker: asset.ticker,
        name: asset.name,
        currentPrice: price,
        stopLoss: stopLoss,
        currency: curr,
        message: `🚨 <b>STOP LOSS ATTIVATO!</b>\nL'asset <b>${escapeHtml(asset.name)}</b> (<code>${escapeHtml(asset.ticker)}</code>) è sceso a <b>${price.toFixed(2)} ${curr}</b>, violando lo stop loss impostato a <b>${stopLoss.toFixed(2)} ${curr}</b>.`
      };
      triggered.push(alert);
      if (options.notify !== false) {
        await sendTelegramMessage(alert.message, { userId, ...options });
      }
    }
  }

  return {
    checked: assets.length,
    triggered
  };
}

module.exports = {
  escapeHtml,
  sendTelegramMessage,
  formatDailyDigest,
  sendDailyDigest,
  checkAndSendAssetAlerts
};
