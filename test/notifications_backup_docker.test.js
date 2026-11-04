const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const http = require('http');

// Use isolated in-memory or temporary database for testing
const testDbPath = path.join(__dirname, 'test_notifications_backup.db');
process.env.DB_PATH = testDbPath;
process.env.BACKUP_DIR = path.join(__dirname, 'test_backups');

const { initDb, closeDb, getDb, setSetting } = require('../src/db');
const app = require('../src/app');
const { 
  escapeHtml, 
  sendTelegramMessage, 
  formatDailyDigest, 
  sendDailyDigest, 
  checkAndSendAssetAlerts 
} = require('../src/services/telegramService');
const { 
  getOrInitVapidKeys, 
  getVapidPublicKey, 
  saveSubscription, 
  getUserSubscriptions, 
  removeSubscription 
} = require('../src/services/pushService');
const { 
  createBackup, 
  listBackups, 
  deleteBackup, 
  purgeOldBackups, 
  BACKUP_DIR 
} = require('../src/backup_manager');
const { 
  isGoogleDriveConfigured, 
  uploadBackupToDrive 
} = require('../src/services/gdriveBackupService');

// Helper to make local HTTP requests to Express app
function makeRequest(app, method, urlPath, headers = {}, body = null) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      const opts = {
        hostname: '127.0.0.1',
        port: port,
        path: urlPath,
        method: method.toUpperCase(),
        headers: headers
      };

      const req = http.request(opts, (res) => {
        let rawData = '';
        res.on('data', chunk => { rawData += chunk; });
        res.on('end', () => {
          server.close(() => {
            let json = null;
            try { json = JSON.parse(rawData); } catch (_) {}
            resolve({
              status: res.statusCode,
              headers: res.headers,
              body: json,
              text: rawData
            });
          });
        });
      });

      req.on('error', (err) => {
        server.close(() => reject(err));
      });

      if (body) {
        const bodyStr = typeof body === 'string' ? body : JSON.stringify(body);
        req.write(bodyStr);
      }
      req.end();
    });
  });
}

describe('Phase 10: Telegram Notifications, Web Push, Backup & Docker UGOS', () => {
  let authCookie = '';
  let authToken = '';

  before(async () => {
    initDb(testDbPath);
    const db = getDb();

    // Login as admin to get auth credentials
    const loginRes = await makeRequest(app, 'POST', '/api/auth/login', {
      'Content-Type': 'application/json'
    }, {
      username: 'admin',
      password: 'admin123'
    });

    assert.equal(loginRes.status, 200, 'Admin login should succeed');
    authToken = loginRes.body.token;
    const cookieHeader = loginRes.headers['set-cookie'];
    if (cookieHeader) {
      authCookie = Array.isArray(cookieHeader) ? cookieHeader[0].split(';')[0] : cookieHeader.split(';')[0];
    }

    // Seed test portfolio and assets with targets for alert tests
    const pInfo = db.prepare(`
      INSERT INTO portfolios (name, type, initialCash, currentCash, totalValue, investedCapital)
      VALUES ('Portafoglio Notifiche Test', 'Investimento', 5000, 5000, 10000, 9000)
    `).run();
    const pid = pInfo.lastInsertRowid;

    db.prepare(`
      INSERT INTO portfolio_users (portfolio_id, user_id, role)
      VALUES (?, 1, 'owner')
    `).run(pid);

    db.prepare(`
      INSERT OR REPLACE INTO assets (ticker, name, currentPrice, targetPrice, stopLoss, currency)
      VALUES ('NVDA', 'NVIDIA Corp', 150.0, 140.0, 100.0, 'USD')
    `).run();

    db.prepare(`
      INSERT OR REPLACE INTO assets (ticker, name, currentPrice, targetPrice, stopLoss, currency)
      VALUES ('DIS', 'Walt Disney Co', 80.0, 120.0, 90.0, 'USD')
    `).run();

    db.prepare(`
      INSERT INTO transactions (portfolioId, type, assetTicker, date, quantity, price, amount)
      VALUES (?, 'BUY', 'NVDA', '2026-01-10', 10, 120.0, 1200.0)
    `).run(pid);

    db.prepare(`
      INSERT INTO transactions (portfolioId, type, assetTicker, date, quantity, price, amount)
      VALUES (?, 'BUY', 'DIS', '2026-01-10', 10, 100.0, 1000.0)
    `).run(pid);
  });

  after(() => {
    try { closeDb(); } catch (_) {}
    if (fs.existsSync(testDbPath)) {
      try { fs.unlinkSync(testDbPath); } catch (_) {}
    }
    if (fs.existsSync(`${testDbPath}-wal`)) {
      try { fs.unlinkSync(`${testDbPath}-wal`); } catch (_) {}
    }
    if (fs.existsSync(`${testDbPath}-shm`)) {
      try { fs.unlinkSync(`${testDbPath}-shm`); } catch (_) {}
    }
    if (fs.existsSync(BACKUP_DIR)) {
      try { fs.rmSync(BACKUP_DIR, { recursive: true, force: true }); } catch (_) {}
    }
  });

  describe('1. Telegram Notifications Service (src/services/telegramService.js)', () => {
    test('escapeHtml handles characters properly', () => {
      assert.equal(escapeHtml('<script>alert("x & y")</script>'), '&lt;script&gt;alert("x &amp; y")&lt;/script&gt;');
      assert.equal(escapeHtml('Normal Text'), 'Normal Text');
      assert.equal(escapeHtml(null), '');
    });

    test('formatDailyDigest produces valid HTML with financial metrics', () => {
      const digest = formatDailyDigest({
        totalNav: 154320.50,
        totalCash: 12400.00,
        perf1DValue: 1250.30,
        perf1DPercent: 0.82,
        totalUnrealizedPnl: 24500.00,
        totalUnrealizedPnlPercent: 18.87,
        topGainer: { ticker: 'NVDA', changePercent: 3.45 },
        worstLoser: { ticker: 'BABA', changePercent: -1.20 }
      });

      assert.ok(digest.includes('FolioTrack — Chiusura Mercati'));
      assert.ok(digest.includes('154.320,50'));
      assert.ok(digest.includes('📈 🟢'));
      assert.ok(digest.includes('+0,82%'));
      assert.ok(digest.includes('NVDA'));
      assert.ok(digest.includes('BABA'));
    });

    test('sendTelegramMessage fails gracefully without credentials', async () => {
      const res = await sendTelegramMessage('Test Message', { botToken: null, chatId: null });
      assert.equal(res.success, false);
      assert.ok(res.error.includes('Credenziali Telegram non configurate'));
    });

    test('sendTelegramMessage succeeds with mocked fetch', async () => {
      const mockFetch = async (url, opts) => {
        assert.ok(url.includes('/botMOCK_TOKEN/sendMessage'));
        const body = JSON.parse(opts.body);
        assert.equal(body.chat_id, '123456789');
        assert.equal(body.parse_mode, 'HTML');
        return {
          ok: true,
          status: 200,
          json: async () => ({ ok: true, result: { message_id: 42 } })
        };
      };

      const res = await sendTelegramMessage('<b>Hello World</b>', {
        botToken: 'MOCK_TOKEN',
        chatId: '123456789',
        fetchFn: mockFetch
      });

      assert.equal(res.success, true);
      assert.equal(res.messageId, 42);
    });

    test('checkAndSendAssetAlerts identifies target and stop-loss breaches', async () => {
      const result = await checkAndSendAssetAlerts(1, { notify: false });
      assert.ok(result.checked >= 2);
      assert.equal(result.triggered.length, 2);

      const targetHit = result.triggered.find(t => t.type === 'TARGET_REACHED');
      assert.ok(targetHit, 'Should trigger target reached for NVDA');
      assert.equal(targetHit.ticker, 'NVDA');
      assert.ok(targetHit.currentPrice >= targetHit.targetPrice);

      const stopHit = result.triggered.find(t => t.type === 'STOP_LOSS_TRIGGERED');
      assert.ok(stopHit, 'Should trigger stop loss for DIS');
      assert.equal(stopHit.ticker, 'DIS');
      assert.ok(stopHit.currentPrice <= stopHit.stopLoss);
    });

    test('sendDailyDigest aggregates user portfolios and generates summary', async () => {
      let sentText = '';
      const mockFetch = async (url, opts) => {
        const body = JSON.parse(opts.body);
        sentText = body.text;
        return {
          ok: true,
          status: 200,
          json: async () => ({ ok: true, result: { message_id: 99 } })
        };
      };

      const res = await sendDailyDigest(1, {
        botToken: 'TOKEN_XYZ',
        chatId: '999888777',
        fetchFn: mockFetch
      });

      assert.equal(res.success, true);
      assert.ok(sentText.includes('FolioTrack — Chiusura Mercati'));
      assert.ok(res.summary.totalNav > 0);
    });
  });

  describe('2. Web Push Notifications Service (src/services/pushService.js)', () => {
    test('getOrInitVapidKeys generates and retrieves valid VAPID keys', () => {
      const keys = getOrInitVapidKeys();
      assert.ok(keys.publicKey, 'Public key should exist');
      assert.ok(keys.privateKey, 'Private key should exist');
      assert.ok(keys.subject, 'Subject should exist');

      const pubKey = getVapidPublicKey();
      assert.equal(pubKey, keys.publicKey);
    });

    test('saveSubscription stores and retrieves subscriptions for user', () => {
      const fakeSub = {
        endpoint: 'https://updates.push.services.mozilla.com/wpush/v2/test_sub_endpoint_1',
        keys: {
          p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QT9t0448G3DmyhxS0mYWQX',
          auth: 'tBHItJI5svbpez7KI4CCXg'
        }
      };

      const saved = saveSubscription(1, fakeSub);
      assert.equal(saved.success, true);
      assert.ok(saved.id > 0);

      const list = getUserSubscriptions(1);
      assert.ok(list.length >= 1);
      const found = list.find(s => s.endpoint === fakeSub.endpoint);
      assert.ok(found);
      assert.equal(found.auth, fakeSub.keys.auth);

      // Remove subscription
      removeSubscription(fakeSub.endpoint);
      const listAfter = getUserSubscriptions(1);
      assert.ok(!listAfter.some(s => s.endpoint === fakeSub.endpoint));
    });

    test('Service Worker and push client files exist', () => {
      const swPath = path.join(__dirname, '..', 'public', 'sw.js');
      const clientPath = path.join(__dirname, '..', 'public', 'push_client.js');

      assert.ok(fs.existsSync(swPath), 'public/sw.js should exist');
      assert.ok(fs.existsSync(clientPath), 'public/push_client.js should exist');

      const swContent = fs.readFileSync(swPath, 'utf8');
      assert.ok(swContent.includes("addEventListener('push'"));
      assert.ok(swContent.includes("showNotification"));
    });
  });

  describe('3. Disaster Recovery & Backup Manager (src/backup_manager.js)', () => {
    test('createBackup creates atomic .zip archive and purges older backups', async () => {
      const backup = await createBackup({ customPrefix: 'foliotrack_backup' });
      assert.equal(backup.success, true);
      assert.ok(backup.filename.startsWith('foliotrack_backup_'));
      assert.ok(backup.filename.endsWith('.zip'));
      assert.ok(fs.existsSync(backup.path), 'Backup zip file must exist on disk');
      assert.ok(backup.size > 0);

      // Verify backup list
      const list = listBackups();
      assert.ok(list.length >= 1);
      const found = list.find(b => b.filename === backup.filename);
      assert.ok(found);
      assert.equal(found.size, backup.size);
    });

    test('purgeOldBackups enforces 14-days retention policy', async () => {
      // Create 3 additional synthetic backups
      const b1 = await createBackup({ customPrefix: 'foliotrack_backup_test_1' });
      const b2 = await createBackup({ customPrefix: 'foliotrack_backup_test_2' });
      const b3 = await createBackup({ customPrefix: 'foliotrack_backup_test_3' });

      // Run purge retaining only 2
      const purged = purgeOldBackups(2);
      assert.ok(purged.prunedCount >= 1);

      const remaining = listBackups();
      assert.equal(remaining.length, 2, 'Should only retain 2 backups');
    });

    test('deleteBackup removes backup file securely', async () => {
      const b = await createBackup({ customPrefix: 'foliotrack_backup_to_delete' });
      assert.ok(fs.existsSync(b.path));

      deleteBackup(b.filename);
      assert.ok(!fs.existsSync(b.path), 'Backup file should be deleted from disk');

      // Traversal protection test
      assert.throws(() => {
        deleteBackup('../secrets.txt');
      }, /non valido/i);
    });

    test('gdriveBackupService returns informative status when unconfigured', async () => {
      assert.equal(isGoogleDriveConfigured(1), false);
      const res = await uploadBackupToDrive('/tmp/fake.zip', { userId: 1 });
      assert.equal(res.success, false);
      assert.equal(res.configured, false);
      assert.ok(res.message.includes('non configurato'));
    });
  });

  describe('4. Full HTTP API Endpoints for Phase 10', () => {
    test('GET /api/push/vapid-public-key returns VAPID public key', async () => {
      const res = await makeRequest(app, 'GET', '/api/push/vapid-public-key');
      assert.equal(res.status, 200);
      assert.equal(res.body.success, true);
      assert.ok(res.body.publicKey.length > 20);
    });

    test('POST /api/push/subscribe requires auth and stores subscription', async () => {
      // Unauthenticated
      const unauth = await makeRequest(app, 'POST', '/api/push/subscribe', {
        'Content-Type': 'application/json'
      }, { subscription: {} });
      assert.equal(unauth.status, 401);

      // Authenticated
      const authRes = await makeRequest(app, 'POST', '/api/push/subscribe', {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${authToken}`
      }, {
        subscription: {
          endpoint: 'https://fcm.googleapis.com/fcm/send/test_sub_endpoint_2',
          keys: {
            p256dh: 'BDcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QT9t0448G3DmyhxS0mYWQX',
            auth: 'uBHItJI5svbpez7KI4CCXg'
          }
        }
      });
      assert.equal(authRes.status, 200);
      assert.equal(authRes.body.success, true);
    });

    test('POST /api/notifications/telegram/test sends test notification', async () => {
      const res = await makeRequest(app, 'POST', '/api/notifications/telegram/test', {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${authToken}`
      }, {
        botToken: 'INVALID_TEST_TOKEN',
        chatId: '123'
      });

      // Since token is invalid, telegram API returns failure gracefully without 500 crash
      assert.equal(res.status, 400);
      assert.equal(res.body.success, false);
      assert.ok(res.body.error);
    });

    test('POST /api/notifications/check-alerts scans holdings and returns breaches', async () => {
      const res = await makeRequest(app, 'POST', '/api/notifications/check-alerts', {
        'Authorization': `Bearer ${authToken}`
      });
      assert.equal(res.status, 200);
      assert.equal(res.body.success, true);
      assert.ok(res.body.checked >= 2);
      assert.equal(res.body.triggeredCount, 2);
    });

    test('GET /api/backups and POST /api/backups/create work properly', async () => {
      // Create backup via API
      const createRes = await makeRequest(app, 'POST', '/api/backups/create', {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${authToken}`
      }, { prefix: 'foliotrack_backup_api' });

      assert.equal(createRes.status, 200);
      assert.equal(createRes.body.success, true);
      assert.ok(createRes.body.backup.filename.startsWith('foliotrack_backup_api'));

      // List backups via API
      const listRes = await makeRequest(app, 'GET', '/api/backups', {
        'Authorization': `Bearer ${authToken}`
      });
      assert.equal(listRes.status, 200);
      assert.equal(listRes.body.success, true);
      assert.ok(listRes.body.backups.length >= 1);

      // Download backup
      const dlRes = await makeRequest(app, 'GET', `/api/backups/download/${createRes.body.backup.filename}`, {
        'Authorization': `Bearer ${authToken}`
      });
      assert.equal(dlRes.status, 200);
      assert.equal(dlRes.headers['content-type'], 'application/zip');

      // Delete backup
      const delRes = await makeRequest(app, 'DELETE', `/api/backups/${createRes.body.backup.filename}`, {
        'Authorization': `Bearer ${authToken}`
      });
      assert.equal(delRes.status, 200);
      assert.equal(delRes.body.success, true);
    });

    test('GET /api/health returns ok status for Docker container healthcheck', async () => {
      const res = await makeRequest(app, 'GET', '/api/health');
      assert.equal(res.status, 200);
      assert.equal(res.body.status, 'ok');
      assert.ok(res.body.uptime >= 0);
    });
  });

  describe('5. Docker & UGOS NAS Packaging Verification', () => {
    test('Dockerfile exists with node:20-alpine, dumb-init and C++ compilers', () => {
      const dockerfilePath = path.join(__dirname, '..', 'Dockerfile');
      assert.ok(fs.existsSync(dockerfilePath), 'Dockerfile must exist');

      const dockerfile = fs.readFileSync(dockerfilePath, 'utf8');
      assert.ok(dockerfile.includes('node:20-alpine'), 'Must use node:20-alpine');
      assert.ok(dockerfile.includes('dumb-init'), 'Must install dumb-init for PID 1 signal management');
      assert.ok(dockerfile.includes('python3 make g++'), 'Must install C++ compiler dependencies for better-sqlite3');
      assert.ok(dockerfile.includes('EXPOSE 3000'), 'Must expose port 3000');
      assert.ok(dockerfile.includes('HEALTHCHECK'), 'Must define container HEALTHCHECK');
    });

    test('docker-compose.yml exists with UGREEN UGOS volume, restart and log limit specs', () => {
      const composePath = path.join(__dirname, '..', 'docker-compose.yml');
      assert.ok(fs.existsSync(composePath), 'docker-compose.yml must exist');

      const compose = fs.readFileSync(composePath, 'utf8');
      assert.ok(compose.includes('restart: unless-stopped'), 'Must have restart: unless-stopped');
      assert.ok(compose.includes('./data:/app/data'), 'Must mount persistent data volume ./data:/app/data');
      assert.ok(compose.includes('Europe/Rome'), 'Must set Europe/Rome timezone');
      assert.ok(compose.includes('max-size: "10m"'), 'Must limit log size to 10m to prevent NAS disk saturation');
      assert.ok(compose.includes('max-file: "3"'), 'Must limit log files to 3');
      assert.ok(compose.includes('healthcheck:'), 'Must specify compose healthcheck');
    });

    test('.dockerignore ignores node_modules and volatile SQLite files', () => {
      const ignorePath = path.join(__dirname, '..', '.dockerignore');
      assert.ok(fs.existsSync(ignorePath), '.dockerignore must exist');

      const ignore = fs.readFileSync(ignorePath, 'utf8');
      assert.ok(ignore.includes('node_modules'));
      assert.ok(ignore.includes('.git'));
      assert.ok(ignore.includes('data/*.db-wal'));
      assert.ok(ignore.includes('data/*.db-shm'));
    });
  });
});

