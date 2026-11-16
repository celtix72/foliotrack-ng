const express = require('express');
const { getDb } = require('../db');
const { requireAuth } = require('../middlewares/authMiddleware');
const { KNOWN_ASSET_SCHEDULES } = require('../utils/dividendForecast');

const router = express.Router();
router.use(requireAuth);

/**
 * Normalizes any date value into YYYY-MM-DD format.
 * @param {string|Date|number} val
 * @returns {string|null}
 */
function toDateStr(val) {
  if (!val) return null;
  try {
    const d = new Date(val);
    if (isNaN(d.getTime())) return null;
    return d.toISOString().split('T')[0];
  } catch {
    return null;
  }
}

/**
 * Evaluates active holdings and watchlist assets for earnings and dividend events today.
 * Inserts any newly detected alerts into dashboard_alerts using INSERT OR IGNORE,
 * preserving acknowledged status of previously closed alerts.
 *
 * @param {number} userId
 * @param {object} db
 * @returns {Array} List of active unacknowledged alerts
 */
function evaluateAlertsForUser(userId, db) {
  const todayStr = new Date().toISOString().split('T')[0];
  const now = new Date();
  const currentMonth = now.getMonth() + 1;
  const currentDay = now.getDate();

  // 1. Collect user's active holdings
  const holdingsRows = db.prepare(`
    SELECT
      TRIM(UPPER(t.assetTicker)) as ticker,
      t.portfolioId,
      MAX(p.name) as portfolioName
    FROM transactions t
    JOIN portfolios p ON t.portfolioId = p.id
    WHERE t.assetTicker IS NOT NULL
      AND TRIM(t.assetTicker) != ''
      AND TRIM(UPPER(t.assetTicker)) NOT IN ('CASH', 'EUR', 'USD', 'DEPOSIT', 'WITHDRAWAL')
    GROUP BY t.portfolioId, TRIM(UPPER(t.assetTicker))
    HAVING SUM(CASE WHEN t.type = 'BUY' THEN t.quantity WHEN t.type = 'SELL' THEN -t.quantity ELSE 0 END) > 1e-6
  `).all();

  // 2. Collect user's watchlist items
  let watchlistRows = [];
  try {
    watchlistRows = db.prepare(`
      SELECT DISTINCT TRIM(UPPER(ticker)) as ticker
      FROM analysis_watchlist
    `).all();
  } catch {}

  const candidateMap = new Map();
  for (const row of holdingsRows) {
    if (!row.ticker) continue;
    candidateMap.set(row.ticker, {
      ticker: row.ticker,
      portfolioId: row.portfolioId,
      portfolioName: row.portfolioName,
      inPortfolio: true
    });
  }

  for (const row of watchlistRows) {
    if (!row.ticker) continue;
    if (!candidateMap.has(row.ticker)) {
      candidateMap.set(row.ticker, {
        ticker: row.ticker,
        portfolioId: null,
        portfolioName: null,
        inPortfolio: false
      });
    }
  }

  // Prepared statements for lookup & upsert
  const getFundStmt = db.prepare('SELECT data FROM analysis_fundamentals_cache WHERE ticker = ? COLLATE NOCASE');
  const getAssetStmt = db.prepare('SELECT name, currency, currentPrice, dividendYield FROM assets WHERE ticker = ? COLLATE NOCASE');
  const insertAlertStmt = db.prepare(`
    INSERT OR IGNORE INTO dashboard_alerts (
      user_id, portfolio_id, ticker, type, event_date, title, message, details, is_acknowledged, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, datetime('now'))
  `);

  for (const [ticker, meta] of candidateMap.entries()) {
    let fund = null;
    const cacheRow = getFundStmt.get(ticker);
    if (cacheRow && cacheRow.data) {
      try {
        fund = JSON.parse(cacheRow.data);
      } catch {}
    }

    const asset = getAssetStmt.get(ticker);
    const companyName = asset?.name || fund?.companyName || ticker;

    // ---------------------------------------------------------
    // A. EARNINGS CHECK (Trimestrale)
    // ---------------------------------------------------------
    if (fund && fund.latestQuarter) {
      const lq = fund.latestQuarter;
      const reported = toDateStr(lq.reportedDate);
      const nextDate = toDateStr(lq.nextEarningsDate);

      if (reported === todayStr) {
        // Earnings report released today
        const qLabel = lq.quarter && lq.quarter !== 'N/D' ? lq.quarter : 'Trimestrale';
        const parts = [];
        if (lq.epsActual !== null && lq.epsActual !== undefined) parts.push(`EPS: ${lq.epsActual}`);
        if (lq.surprisePercent !== null && lq.surprisePercent !== undefined) {
          const sign = lq.surprisePercent > 0 ? '+' : '';
          parts.push(`Sorpresa: ${sign}${lq.surprisePercent}%`);
        }
        const extraText = parts.length > 0 ? ` (${parts.join(' | ')})` : '';
        const title = `Trimestrale Rilasciata: ${ticker}`;
        const message = `Pubblicati i risultati di bilancio ${qLabel} per ${companyName}${extraText}.`;
        const details = JSON.stringify({
          quarter: lq.quarter,
          reportedDate: todayStr,
          epsActual: lq.epsActual,
          epsEstimate: lq.epsEstimate,
          surprisePercent: lq.surprisePercent,
          revenue: lq.revenue
        });

        insertAlertStmt.run(userId, meta.portfolioId, ticker, 'EARNINGS', todayStr, title, message, details);
      } else if (nextDate === todayStr) {
        // Earnings scheduled for today
        const qLabel = lq.quarter && lq.quarter !== 'N/D' ? lq.quarter : 'Trimestrale';
        const estText = (lq.epsEstimate !== null && lq.epsEstimate !== undefined) ? ` Stima EPS attesa: ${lq.epsEstimate}.` : '';
        const title = `Trimestrale Prevista Oggi: ${ticker}`;
        const message = `Oggi è prevista la pubblicazione dei risultati trimestrali (${qLabel}) per ${companyName}.${estText}`;
        const details = JSON.stringify({
          quarter: lq.quarter,
          nextEarningsDate: todayStr,
          epsEstimate: lq.epsEstimate
        });

        insertAlertStmt.run(userId, meta.portfolioId, ticker, 'EARNINGS', todayStr, title, message, details);
      }
    }

    // ---------------------------------------------------------
    // B. DIVIDEND / EX-DATE CHECK (Stacco dividendo / cedola)
    // ---------------------------------------------------------
    let dividendDetected = false;

    // Check fundamentals cache ex-dividend date
    if (fund) {
      const fundExDate = toDateStr(fund.exDividendDate);
      if (fundExDate === todayStr) {
        dividendDetected = true;
        const rateText = fund.dividendRate ? ` Cedola/Importo: €${fund.dividendRate} per azione.` : '';
        const yieldText = fund.dividendYield ? ` (Rendimento: ${fund.dividendYield}%)` : '';
        const title = `Stacco Dividendo Oggi: ${ticker}`;
        const message = `Oggi è la data di stacco dividendo (Ex-Dividend Date) per ${companyName}.${rateText}${yieldText}`;
        const details = JSON.stringify({
          exDividendDate: todayStr,
          dividendRate: fund.dividendRate,
          dividendYield: fund.dividendYield
        });

        insertAlertStmt.run(userId, meta.portfolioId, ticker, 'DIVIDEND', todayStr, title, message, details);
      }
    }

    // Check KNOWN_ASSET_SCHEDULES for government bonds, semi-annual / quarterly payers
    if (!dividendDetected && KNOWN_ASSET_SCHEDULES && KNOWN_ASSET_SCHEDULES[ticker]) {
      const sched = KNOWN_ASSET_SCHEDULES[ticker];
      if (Array.isArray(sched.payoutMonths) && sched.payoutMonths.includes(currentMonth) && sched.dayOfMonth === currentDay) {
        dividendDetected = true;
        const noteText = sched.note ? ` - ${sched.note}` : '';
        const paymentText = sched.expectedPayment ? ` Pagamento atteso: €${sched.expectedPayment}.` : '';
        const title = `Stacco Cedola / Dividendo: ${ticker}`;
        const message = `Oggi è previsto lo stacco cedola o dividendo per ${companyName}${noteText}.${paymentText}`;
        const details = JSON.stringify({
          exDividendDate: todayStr,
          note: sched.note,
          expectedPayment: sched.expectedPayment,
          interimAmountPerShare: sched.interimAmountPerShare
        });

        insertAlertStmt.run(userId, meta.portfolioId, ticker, 'DIVIDEND', todayStr, title, message, details);
      }
    }
  }

  // Return all unacknowledged alerts for the user
  const activeAlerts = db.prepare(`
    SELECT
      id,
      user_id,
      portfolio_id,
      ticker,
      type,
      event_date,
      title,
      message,
      details,
      is_acknowledged,
      acknowledged_at,
      created_at
    FROM dashboard_alerts
    WHERE user_id = ? AND is_acknowledged = 0
    ORDER BY id DESC
  `).all(userId);

  return activeAlerts.map(a => {
    let parsedDetails = null;
    if (a.details) {
      try { parsedDetails = JSON.parse(a.details); } catch { parsedDetails = a.details; }
    }
    return {
      ...a,
      details: parsedDetails
    };
  });
}

/**
 * GET /api/alerts
 * Scans user assets and returns unacknowledged dashboard alerts.
 */
router.get('/', (req, res) => {
  try {
    const db = getDb();
    const userId = req.user?.id || 1;
    const alerts = evaluateAlertsForUser(userId, db);
    res.json({
      success: true,
      count: alerts.length,
      alerts
    });
  } catch (err) {
    console.error('[Alerts Route Error]', err);
    res.status(500).json({
      success: false,
      error: `Errore durante il recupero degli alert: ${err.message}`
    });
  }
});

/**
 * POST or PUT /api/alerts/:id/acknowledge
 * Acknowledges a specific alert.
 */
function acknowledgeAlertHandler(req, res) {
  try {
    const db = getDb();
    const userId = req.user?.id || 1;
    const alertId = parseInt(req.params.id, 10);

    if (isNaN(alertId) || alertId <= 0) {
      return res.status(400).json({ success: false, error: 'ID notifica non valido' });
    }

    const result = db.prepare(`
      UPDATE dashboard_alerts
      SET is_acknowledged = 1, acknowledged_at = datetime('now')
      WHERE id = ? AND user_id = ?
    `).run(alertId, userId);

    if (result.changes === 0) {
      return res.status(404).json({ success: false, error: 'Notifica non trovata o già acquisita.' });
    }

    res.json({
      success: true,
      message: 'Notifica acquisita con successo.',
      id: alertId
    });
  } catch (err) {
    console.error('[Alert Acknowledge Error]', err);
    res.status(500).json({
      success: false,
      error: `Errore durante l'acquisizione della notifica: ${err.message}`
    });
  }
}

router.post('/:id/acknowledge', acknowledgeAlertHandler);
router.put('/:id/acknowledge', acknowledgeAlertHandler);

/**
 * POST /api/alerts/acknowledge-all
 * Marks all pending alerts for the current user as acknowledged.
 */
router.post('/acknowledge-all', (req, res) => {
  try {
    const db = getDb();
    const userId = req.user?.id || 1;

    const result = db.prepare(`
      UPDATE dashboard_alerts
      SET is_acknowledged = 1, acknowledged_at = datetime('now')
      WHERE user_id = ? AND is_acknowledged = 0
    `).run(userId);

    res.json({
      success: true,
      message: `${result.changes} notifiche acquisite con successo.`,
      acknowledgedCount: result.changes
    });
  } catch (err) {
    console.error('[Alert Acknowledge All Error]', err);
    res.status(500).json({
      success: false,
      error: `Errore durante l'acquisizione cumulativa delle notifiche: ${err.message}`
    });
  }
});

/**
 * POST /api/alerts/test
 * Injects or updates a test alert for testing and preview verification.
 */
router.post('/test', (req, res) => {
  try {
    const db = getDb();
    const userId = req.user?.id || 1;
    const {
      ticker = 'AAPL',
      type = 'EARNINGS',
      title,
      message,
      event_date,
      details
    } = req.body || {};

    const cleanType = String(type).toUpperCase() === 'DIVIDEND' ? 'DIVIDEND' : 'EARNINGS';
    const cleanTicker = String(ticker).trim().toUpperCase();
    const eventDate = event_date || new Date().toISOString().split('T')[0];

    const defaultTitle = cleanType === 'DIVIDEND'
      ? `Stacco Dividendo Oggi: ${cleanTicker}`
      : `Trimestrale Rilasciata: ${cleanTicker}`;

    const defaultMessage = cleanType === 'DIVIDEND'
      ? `Oggi è la data di stacco dividendo per ${cleanTicker}.`
      : `Sono stati pubblicati i risultati trimestrali di ${cleanTicker}.`;

    const alertTitle = title || defaultTitle;
    const alertMsg = message || defaultMessage;
    const detailsStr = details ? (typeof details === 'object' ? JSON.stringify(details) : String(details)) : JSON.stringify({ isTest: true });

    db.prepare(`
      INSERT INTO dashboard_alerts (
        user_id, portfolio_id, ticker, type, event_date, title, message, details, is_acknowledged, acknowledged_at, created_at
      ) VALUES (?, NULL, ?, ?, ?, ?, ?, ?, 0, NULL, datetime('now'))
      ON CONFLICT(user_id, ticker, type, event_date) DO UPDATE SET
        title = excluded.title,
        message = excluded.message,
        details = excluded.details,
        is_acknowledged = 0,
        acknowledged_at = NULL,
        created_at = datetime('now')
    `).run(userId, cleanTicker, cleanType, eventDate, alertTitle, alertMsg, detailsStr);

    const alert = db.prepare(`
      SELECT * FROM dashboard_alerts
      WHERE user_id = ? AND ticker = ? AND type = ? AND event_date = ?
    `).get(userId, cleanTicker, cleanType, eventDate);

    res.json({
      success: true,
      message: 'Alert di test creato/ripristinato con successo.',
      alert
    });
  } catch (err) {
    console.error('[Alert Test Error]', err);
    res.status(500).json({
      success: false,
      error: `Errore nella creazione dell'alert di test: ${err.message}`
    });
  }
});

module.exports = {
  router,
  evaluateAlertsForUser
};
