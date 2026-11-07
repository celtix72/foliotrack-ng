const webPush = require('web-push');
const { getDb, getSetting, setSetting } = require('../db');

let vapidConfigured = false;
let currentVapidKeys = null;

/**
 * Ensures VAPID keys exist (either from env, DB settings, or auto-generated).
 * Configures the web-push client.
 * @returns {{publicKey: string, privateKey: string, subject: string}}
 */
function getOrInitVapidKeys() {
  if (currentVapidKeys && vapidConfigured) {
    return currentVapidKeys;
  }

  let publicKey = process.env.VAPID_PUBLIC_KEY;
  let privateKey = process.env.VAPID_PRIVATE_KEY;
  let subject = process.env.VAPID_SUBJECT || 'mailto:admin@foliotrack.local';

  // Check in database settings (system user id 1) if not in process.env
  if (!publicKey || !privateKey) {
    try {
      const pubSetting = getSetting(1, 'vapid_public_key', false);
      const privSetting = getSetting(1, 'vapid_private_key', true);
      if (pubSetting && privSetting) {
        publicKey = pubSetting;
        privateKey = privSetting;
      }
    } catch (err) {
      console.warn('[Push Service] Warning reading existing VAPID keys:', err.message);
      publicKey = null;
      privateKey = null;
    }
  }

  // Attempt to configure webPush with existing or loaded keys
  let configuredSuccessfully = false;
  if (publicKey && privateKey) {
    try {
      webPush.setVapidDetails(subject, publicKey, privateKey);
      configuredSuccessfully = true;
    } catch (err) {
      console.warn('[Push Service] Chiavi VAPID esistenti non valide o non compatibili. Verranno rigenerate:', err.message);
      configuredSuccessfully = false;
      publicKey = null;
      privateKey = null;
    }
  }

  // If still not configured, generate fresh valid VAPID keys and persist them
  if (!configuredSuccessfully || !publicKey || !privateKey) {
    const generated = webPush.generateVAPIDKeys();
    publicKey = generated.publicKey;
    privateKey = generated.privateKey;
    try {
      setSetting(1, 'vapid_public_key', publicKey, false);
      setSetting(1, 'vapid_private_key', privateKey, true);
      console.log('[Push Service] Nuova coppia di chiavi VAPID generata e salvata con successo.');
    } catch (err) {
      console.warn('[Push Service] Impossibile salvare le chiavi VAPID nel database:', err.message);
    }

    try {
      webPush.setVapidDetails(subject, publicKey, privateKey);
      configuredSuccessfully = true;
    } catch (err) {
      console.error('[Push Service] Errore critico configurazione VAPID con le nuove chiavi:', err.message);
    }
  }

  currentVapidKeys = { publicKey, privateKey, subject };
  vapidConfigured = configuredSuccessfully;

  return currentVapidKeys;
}

/**
 * Retrieves the public VAPID key to send to browsers.
 * @returns {string}
 */
function getVapidPublicKey() {
  const keys = getOrInitVapidKeys();
  return keys.publicKey;
}

/**
 * Saves a browser push subscription to the database.
 * @param {number} userId 
 * @param {object} subscription - { endpoint, keys: { p256dh, auth } }
 * @returns {{success: boolean, id?: number}}
 */
function saveSubscription(userId, subscription) {
  if (!subscription || !subscription.endpoint || !subscription.keys || !subscription.keys.p256dh || !subscription.keys.auth) {
    throw new Error('Subscription non valida. Endpoint e chiavi (p256dh, auth) sono obbligatori.');
  }

  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(endpoint) DO UPDATE SET
      user_id = excluded.user_id,
      p256dh = excluded.p256dh,
      auth = excluded.auth,
      created_at = datetime('now')
  `);

  const info = stmt.run(userId, subscription.endpoint, subscription.keys.p256dh, subscription.keys.auth);
  return {
    success: true,
    id: info.lastInsertRowid
  };
}

/**
 * Removes a subscription from the database.
 * @param {string} endpoint 
 * @returns {{success: boolean}}
 */
function removeSubscription(endpoint) {
  const db = getDb();
  db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(endpoint);
  return { success: true };
}

/**
 * Returns all active subscriptions for a given user.
 * @param {number} userId 
 * @returns {Array}
 */
function getUserSubscriptions(userId) {
  const db = getDb();
  return db.prepare('SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ?').all(userId);
}

/**
 * Sends a native push notification to all subscriptions registered by a user.
 * Automatically prunes expired or unregistered subscriptions (HTTP 410 or 404).
 * @param {number} userId 
 * @param {object} payload - { title, body, icon, badge, url, tag, data }
 * @returns {Promise<{sent: number, failed: number, pruned: number}>}
 */
async function sendPushNotification(userId, payload) {
  getOrInitVapidKeys();
  const subscriptions = getUserSubscriptions(userId);

  if (subscriptions.length === 0) {
    return { sent: 0, failed: 0, pruned: 0, message: 'Nessun dispositivo registrato per questo utente.' };
  }

  const stringifiedPayload = JSON.stringify({
    title: payload.title || 'FolioTrack',
    body: payload.body || '',
    icon: payload.icon || '/favicon.svg',
    badge: payload.badge || '/favicon.svg',
    url: payload.url || '/',
    tag: payload.tag || 'foliotrack-notification',
    timestamp: Date.now(),
    data: payload.data || {}
  });

  let sent = 0;
  let failed = 0;
  let pruned = 0;

  for (const sub of subscriptions) {
    const pushSubscription = {
      endpoint: sub.endpoint,
      keys: {
        p256dh: sub.p256dh,
        auth: sub.auth
      }
    };

    try {
      await webPush.sendNotification(pushSubscription, stringifiedPayload);
      sent++;
    } catch (err) {
      failed++;
      // If endpoint is expired or unsubscribed, remove from DB
      if (err.statusCode === 410 || err.statusCode === 404) {
        removeSubscription(sub.endpoint);
        pruned++;
      } else {
        console.warn(`[Push Service] Error sending push to endpoint ${sub.endpoint.slice(0, 30)}...:`, err.message);
      }
    }
  }

  return { sent, failed, pruned };
}

module.exports = {
  getOrInitVapidKeys,
  getVapidPublicKey,
  saveSubscription,
  removeSubscription,
  getUserSubscriptions,
  sendPushNotification
};

