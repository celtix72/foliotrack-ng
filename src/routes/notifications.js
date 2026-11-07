const express = require('express');
const { requireAuth } = require('../middlewares/authMiddleware');
const { 
  getVapidPublicKey, 
  saveSubscription, 
  removeSubscription, 
  sendPushNotification 
} = require('../services/pushService');
const {
  getNotificationSettings,
  saveNotificationSettings,
  sendTestNotification
} = require('../services/notificationService');
const { 
  sendTelegramMessage, 
  sendDailyDigest, 
  checkAndSendAssetAlerts 
} = require('../services/telegramService');

const router = express.Router();

/**
 * Public or authenticated endpoint for frontend to get VAPID Public Key.
 * GET /api/push/vapid-public-key
 */
router.get('/vapid-public-key', (req, res) => {
  try {
    const publicKey = getVapidPublicKey();
    return res.json({
      success: true,
      publicKey
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      error: `Errore recupero chiave VAPID: ${err.message}`
    });
  }
});

// All remaining notification actions require user authentication
router.use(requireAuth);

/**
 * POST /api/push/subscribe
 * Registers a browser push subscription for the logged-in user.
 */
router.post('/subscribe', (req, res) => {
  try {
    const { subscription } = req.body;
    if (!subscription) {
      return res.status(400).json({
        success: false,
        error: 'Oggetto subscription mancante.'
      });
    }

    const result = saveSubscription(req.user.id, subscription);
    return res.json({
      success: true,
      message: 'Sottoscrizione Web Push registrata con successo.',
      id: result.id
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

/**
 * POST /api/push/unsubscribe
 * Removes a browser push subscription.
 */
router.post('/unsubscribe', (req, res) => {
  try {
    const { endpoint } = req.body;
    if (!endpoint) {
      return res.status(400).json({
        success: false,
        error: 'Endpoint mancante.'
      });
    }

    removeSubscription(endpoint);
    return res.json({
      success: true,
      message: 'Sottoscrizione rimossa.'
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

/**
 * POST /api/push/send-test
 * Sends a test push notification to the logged-in user's devices.
 */
router.post('/send-test', async (req, res) => {
  try {
    const result = await sendPushNotification(req.user.id, {
      title: 'FolioTrack — Notifica Push di Prova',
      body: 'Le notifiche push del tuo browser sono configurate e funzionanti con successo! 🎉',
      url: '/settings',
      tag: 'foliotrack-test-push'
    });

    return res.json({
      success: true,
      message: `Inviata con successo: ${result.sent} recapitate, ${result.failed} fallite, ${result.pruned} rimosse.`,
      result
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

/**
 * GET /api/notifications/settings
 * Retrieves user's smartphone push notification preferences.
 */
router.get('/settings', (req, res) => {
  try {
    const settings = getNotificationSettings(req.user.id);
    return res.json({
      success: true,
      settings
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

/**
 * PUT /api/notifications/settings
 * Saves user's smartphone push notification preferences.
 */
router.put('/settings', (req, res) => {
  try {
    const updated = saveNotificationSettings(req.user.id, req.body || {});
    return res.json({
      success: true,
      message: 'Impostazioni notifiche smartphone salvate con successo.',
      settings: updated
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

/**
 * POST /api/notifications/test/:type
 * Sends an individual test push notification for a specific notification type:
 * - 'market_open'
 * - 'asset_change'
 * - 'portfolio_change'
 */
router.post('/test/:type', async (req, res) => {
  try {
    const { type } = req.params;
    const testRes = await sendTestNotification(req.user.id, type);
    return res.json(testRes);
  } catch (err) {
    return res.status(400).json({
      success: false,
      error: err.message
    });
  }
});

/**
 * POST /api/notifications/telegram/test
 * Sends a test message to the user's configured Telegram bot / chat.
 */
router.post('/telegram/test', async (req, res) => {
  try {
    const { botToken, chatId, message } = req.body;
    const testMsg = message || `🔔 <b>FolioTrack</b>\nMessaggio di test ricevuto correttamente dal Bot Telegram! 🚀\n<i>Orario server: ${new Date().toLocaleTimeString('it-IT')}</i>`;

    const result = await sendTelegramMessage(testMsg, {
      userId: req.user.id,
      botToken,
      chatId
    });

    if (!result.success) {
      return res.status(400).json(result);
    }

    return res.json({
      success: true,
      message: 'Messaggio inviato con successo a Telegram.',
      messageId: result.messageId
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

/**
 * POST /api/notifications/telegram/digest
 * Triggers the daily market close digest and sends it to Telegram.
 */
router.post('/telegram/digest', async (req, res) => {
  try {
    const result = await sendDailyDigest(req.user.id);
    if (!result.success) {
      return res.status(400).json(result);
    }

    return res.json({
      success: true,
      message: 'Daily market digest inviato con successo a Telegram.',
      summary: result.summary,
      messageId: result.messageId
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

/**
 * POST /api/notifications/check-alerts
 * Evaluates target price and stop loss levels for holdings and triggers alerts.
 */
router.post('/check-alerts', async (req, res) => {
  try {
    const result = await checkAndSendAssetAlerts(req.user.id);
    return res.json({
      success: true,
      checked: result.checked,
      triggeredCount: result.triggered.length,
      triggered: result.triggered
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

module.exports = router;

