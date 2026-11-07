const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const http = require('http');

const testDbPath = path.join(__dirname, 'test_smartphone_notifications.db');
process.env.DB_PATH = testDbPath;

const { initDb, closeDb, getDb, setSetting } = require('../src/db');
const app = require('../src/app');
const {
  isFinancialMarketOpen,
  getNotificationSettings,
  saveNotificationSettings,
  checkMarketOpenNotification,
  checkAssetChangeNotifications,
  checkPortfolioChangeNotification,
  sendTestNotification,
  buildMoversTableText,
  formatPortfolioK,
  toMonospace,
  applyNotificationFont
} = require('../src/services/notificationService');
const pushService = require('../src/services/pushService');
const { saveSubscription } = pushService;

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

describe('Smartphone App Push Notifications & Market Closed Logic', () => {
  let authCookie = '';

  before(async () => {
    initDb(testDbPath);

    // Login as admin
    const loginRes = await makeRequest(app, 'POST', '/api/auth/login', {
      'Content-Type': 'application/json'
    }, {
      username: 'admin',
      password: 'admin123'
    });

    assert.equal(loginRes.status, 200);
    const cookieHeader = loginRes.headers['set-cookie'];
    authCookie = Array.isArray(cookieHeader) ? cookieHeader[0].split(';')[0] : cookieHeader.split(';')[0];
  });

  after(() => {
    closeDb();
    if (fs.existsSync(testDbPath)) {
      try { fs.unlinkSync(testDbPath); } catch (_) {}
    }
    const wal = testDbPath + '-wal';
    const shm = testDbPath + '-shm';
    if (fs.existsSync(wal)) try { fs.unlinkSync(wal); } catch (_) {}
    if (fs.existsSync(shm)) try { fs.unlinkSync(shm); } catch (_) {}
  });

  describe('1. Financial Market Hours Logic (Rome CET)', () => {
    test('isFinancialMarketOpen correctly detects weekend as closed', () => {
      // Saturday 2026-11-07 14:00 UTC = 15:00 CET
      const saturday = new Date('2026-11-07T14:00:00Z');
      const satRes = isFinancialMarketOpen(saturday);
      assert.equal(satRes.isOpen, false);
      assert.ok(satRes.reason.includes('Fine settimana'));

      // Sunday 2026-11-08 10:00 UTC = 11:00 CET
      const sunday = new Date('2026-11-08T10:00:00Z');
      const sunRes = isFinancialMarketOpen(sunday);
      assert.equal(sunRes.isOpen, false);
      assert.ok(sunRes.reason.includes('Fine settimana'));
    });

    test('isFinancialMarketOpen detects open session on weekdays 09:00 - 22:00 CET', () => {
      // Wednesday 2026-11-11 10:30 UTC = 11:30 CET
      const wednesdayDay = new Date('2026-11-11T10:30:00Z');
      const openRes = isFinancialMarketOpen(wednesdayDay);
      assert.equal(openRes.isOpen, true);
      assert.ok(openRes.reason.includes('Mercati aperti'));
    });

    test('isFinancialMarketOpen detects closed session at night on weekdays', () => {
      // Wednesday 2026-11-11 23:30 UTC = Thursday 00:30 CET
      const wednesdayNight = new Date('2026-11-11T23:30:00Z');
      const closedRes = isFinancialMarketOpen(wednesdayNight);
      assert.equal(closedRes.isOpen, false);
      assert.ok(closedRes.reason.includes('Fuori orario'));
    });
  });

  describe('2. Notification Settings API (GET & PUT /api/notifications/settings)', () => {
    test('GET /api/notifications/settings returns default preferences', async () => {
      const res = await makeRequest(app, 'GET', '/api/notifications/settings', {
        Cookie: authCookie
      });

      assert.equal(res.status, 200);
      assert.equal(res.body.success, true);
      const s = res.body.settings;
      assert.equal(s.marketOpenEnabled, true);
      assert.equal(s.assetChangeEnabled, true);
      assert.equal(s.assetChangeThreshold, 5.0);
      assert.equal(s.portfolioChangeEnabled, true);
      assert.equal(s.portfolioChangeThreshold, 300.0);
      assert.equal(s.syncOnlyMarketHours, true);
      assert.equal(s.fontStyle, 'standard');
    });

    test('PUT /api/notifications/settings updates toggles and custom thresholds', async () => {
      const res = await makeRequest(app, 'PUT', '/api/notifications/settings', {
        Cookie: authCookie,
        'Content-Type': 'application/json'
      }, {
        marketOpenEnabled: false,
        assetChangeEnabled: true,
        assetChangeThreshold: 7.5,
        portfolioChangeEnabled: true,
        portfolioChangeThreshold: 500.0,
        syncOnlyMarketHours: true,
        fontStyle: 'sans_bold'
      });

      assert.equal(res.status, 200);
      assert.equal(res.body.success, true);
      const updated = res.body.settings;
      assert.equal(updated.marketOpenEnabled, false);
      assert.equal(updated.assetChangeEnabled, true);
      assert.equal(updated.assetChangeThreshold, 7.5);
      assert.equal(updated.portfolioChangeEnabled, true);
      assert.equal(updated.portfolioChangeThreshold, 500.0);
      assert.equal(updated.fontStyle, 'sans_bold');

      // Verify persistence with a subsequent GET
      const getRes = await makeRequest(app, 'GET', '/api/notifications/settings', {
        Cookie: authCookie
      });
      assert.equal(getRes.body.settings.assetChangeThreshold, 7.5);
      assert.equal(getRes.body.settings.portfolioChangeThreshold, 500.0);
      assert.equal(getRes.body.settings.marketOpenEnabled, false);
      assert.equal(getRes.body.settings.fontStyle, 'sans_bold');
    });
  });

  describe('3. Core Notification Trigger Engines', () => {
    test('checkMarketOpenNotification respects disabled setting and weekend', async () => {
      // Currently disabled from previous test
      const resDisabled = await checkMarketOpenNotification(1, new Date('2026-11-11T09:15:00Z'));
      assert.equal(resDisabled.sent, false);

      // Re-enable
      saveNotificationSettings(1, { marketOpenEnabled: true });

      // Saturday check
      const satRes = await checkMarketOpenNotification(1, new Date('2026-11-07T09:15:00Z'));
      assert.equal(satRes.sent, false);
      assert.ok(satRes.reason.includes('Weekend'));
    });

    test('checkPortfolioChangeNotification establishes initial baseline and fires on delta >= threshold', async () => {
      const db = getDb();

      // Clean prior notifications setting
      db.prepare("DELETE FROM settings WHERE key = 'notif_last_notified_portfolio_total'").run();

      // Create a test portfolio for user 1
      const portInfo = db.prepare(`
        INSERT INTO portfolios (name, currentCash, totalValue, investedCapital, include_in_totals)
        VALUES ('Portafoglio Notifiche Test', 1000, 10000, 9000, 1)
      `).run();
      const portfolioId = portInfo.lastInsertRowid;
      db.prepare(`
        INSERT INTO portfolio_users (portfolio_id, user_id, role)
        VALUES (?, 1, 'owner')
      `).run(portfolioId);

      // First run should initialize baseline without sending
      const firstRun = await checkPortfolioChangeNotification(1);
      assert.equal(firstRun.sent, false);
      assert.equal(firstRun.currentTotal, 10000);

      // Small change (+100 EUR, less than threshold 500) -> should NOT fire
      db.prepare('UPDATE portfolios SET totalValue = 10100 WHERE id = ?').run(portfolioId);
      const smallRun = await checkPortfolioChangeNotification(1);
      assert.equal(smallRun.sent, false);

      // Large change (+600 EUR, exceeds threshold 500) -> should trigger notification
      db.prepare('UPDATE portfolios SET totalValue = 10600 WHERE id = ?').run(portfolioId);
      const largeRun = await checkPortfolioChangeNotification(1);
      assert.equal(largeRun.sent, true);
      assert.equal(largeRun.diff, 600);
      assert.equal(largeRun.currentTotal, 10600);

      // Clean up test portfolio
      db.prepare('DELETE FROM portfolios WHERE id = ?').run(portfolioId);
    });

    test('buildMoversTableText outputs top 3 and flop 3 with value creation, monospace characters and no TOP/FLOP labels', () => {
      const tableText = buildMoversTableText(1, true);
      assert.ok(!tableText.includes('TOP'), 'Must not include TOP label');
      assert.ok(!tableText.includes('FLOP'), 'Must not include FLOP label');
      assert.ok(tableText.includes('€'));
      assert.ok(tableText.includes('%'));
      assert.ok(tableText.includes('🚀') || tableText.includes('🟢'));
      assert.ok(tableText.includes('💥') || tableText.includes('🔴'));

      // Verify line counts: 3 top items and 3 bottom items
      const lines = tableText.split('\n').filter(l => l.trim().length > 0);
      assert.equal(lines.length, 6, 'Should have exactly 3 top movers and 3 flop movers');

      // Verify percentages have 1 decimal digit and variation values have 0 decimal digits in monospace
      for (const line of lines) {
        // e.g. "🚀 𝙽𝚅𝙳𝙰     +𝟺,𝟹%  (+€𝟷𝟺𝟻)"
        assert.match(line, /[+-]\p{Nd}+,\p{Nd}+%/u, 'Percentages must have exactly 1 decimal digit');
        assert.match(line, /\([+-]€\p{Nd}+\)/u, 'Variation values must have 0 decimal digits');
      }
    });

    test('formatPortfolioK abbreviates portfolio values in K with 1 decimal digit', () => {
      assert.equal(formatPortfolioK(418200), '418,2K');
      assert.equal(formatPortfolioK(45350), '45,4K');
      assert.equal(formatPortfolioK(28500), '28,5K');
      assert.equal(formatPortfolioK(1000), '1,0K');
      assert.equal(formatPortfolioK(300), '0,3K');
    });

    test('applyNotificationFont correctly transforms text across supported font styles', () => {
      assert.equal(applyNotificationFont('NVDA 123', 'standard'), 'NVDA 123');
      assert.equal(applyNotificationFont('NVDA 123', 'sans_bold'), '𝗡𝗩𝗗𝗔 𝟭𝟮𝟯');
      assert.equal(applyNotificationFont('NVDA 123', 'sans'), '𝖭𝖵𝖣𝖠 𝟣𝟤𝟥');
      assert.equal(applyNotificationFont('NVDA 123', 'serif'), '𝐍𝐕𝐃𝐀 𝟏𝟐𝟑');
      assert.equal(applyNotificationFont('NVDA 123', 'monospace'), '𝙽𝚅𝙳𝙰 𝟷𝟸𝟹');
    });

    test('toMonospace converts latin letters and digits to Unicode mathematical monospace', () => {
      assert.equal(toMonospace('NVDA 123'), '𝙽𝚅𝙳𝙰 𝟷𝟸𝟹');
      assert.equal(toMonospace('+4,3% (+€145)'), '+𝟺,𝟹% (+€𝟷𝟺𝟻)');
    });
  });

  describe('4. Individual Test Push Notifications (POST /api/notifications/test/:type)', () => {
    let originalSendPush;
    let lastCapturedPayload = null;

    before(() => {
      originalSendPush = pushService.sendPushNotification;
      // Stub pushService.sendPushNotification to capture payloads and simulate delivery
      pushService.sendPushNotification = async (userId, payload) => {
        lastCapturedPayload = payload;
        return { sent: 1, failed: 0, pruned: 0 };
      };
    });

    after(() => {
      pushService.sendPushNotification = originalSendPush;
    });

    test('POST /api/notifications/test/market_open includes top 3 and flop 3 table with value creation and emoticons without TOP/FLOP labels', async () => {
      const res = await makeRequest(app, 'POST', '/api/notifications/test/market_open', {
        Cookie: authCookie
      });

      assert.equal(res.status, 200);
      assert.equal(res.body.success, true);
      assert.ok(res.body.message.includes('inviata con successo'));
      assert.ok(lastCapturedPayload);
      assert.ok(!lastCapturedPayload.body.includes('TOP'));
      assert.ok(!lastCapturedPayload.body.includes('FLOP'));
      assert.ok(lastCapturedPayload.body.includes('€'));
      assert.ok(lastCapturedPayload.body.includes('%'));
      assert.ok(lastCapturedPayload.body.includes('🚀') || lastCapturedPayload.body.includes('🟢'));
      assert.ok(lastCapturedPayload.body.includes('💥') || lastCapturedPayload.body.includes('🔴'));
    });

    test('POST /api/notifications/test/asset_change sends test asset variation notification', async () => {
      const res = await makeRequest(app, 'POST', '/api/notifications/test/asset_change', {
        Cookie: authCookie
      });

      assert.equal(res.status, 200);
      assert.equal(res.body.success, true);
      assert.ok(res.body.message.includes('inviata con successo'));
      assert.ok(lastCapturedPayload);
      assert.ok(lastCapturedPayload.title.includes('+5,4%'));
      assert.ok(lastCapturedPayload.body.includes('+5,4%'));
    });

    test('POST /api/notifications/test/portfolio_change includes top 3 and flop 3 table with value creation and emoticons without TOP/FLOP labels', async () => {
      const res = await makeRequest(app, 'POST', '/api/notifications/test/portfolio_change', {
        Cookie: authCookie
      });

      assert.equal(res.status, 200);
      assert.equal(res.body.success, true);
      assert.ok(res.body.message.includes('inviata con successo'));
      assert.ok(lastCapturedPayload);
      assert.ok(lastCapturedPayload.title.includes('+€300'));
      assert.ok(!lastCapturedPayload.title.includes('€300,00'));
      assert.ok(lastCapturedPayload.body.includes('K'));
      assert.ok(lastCapturedPayload.body.includes('(+€300)'));
      assert.ok(!lastCapturedPayload.body.includes('TOP'));
      assert.ok(!lastCapturedPayload.body.includes('FLOP'));
      assert.ok(lastCapturedPayload.body.includes('€'));
      assert.ok(lastCapturedPayload.body.includes('%'));
      assert.ok(lastCapturedPayload.body.includes('🚀') || lastCapturedPayload.body.includes('🟢'));
      assert.ok(lastCapturedPayload.body.includes('💥') || lastCapturedPayload.body.includes('🔴'));
    });

    test('POST /api/notifications/test/invalid_type returns 400 error', async () => {
      const res = await makeRequest(app, 'POST', '/api/notifications/test/invalid_type', {
        Cookie: authCookie
      });

      assert.equal(res.status, 400);
      assert.equal(res.body.success, false);
      assert.ok(res.body.error.includes('Tipo notifica di test sconosciuto'));
    });
  });

  describe('5. Settings UI Template Verification', () => {
    test('Desktop settings view renders smartphone notification section & controls', async () => {
      const res = await makeRequest(app, 'GET', '/settings', {
        Cookie: authCookie
      });

      assert.equal(res.status, 200);
      const html = res.text;
      assert.ok(html.includes('notif_market_open_enabled'));
      assert.ok(html.includes('notif_asset_change_enabled'));
      assert.ok(html.includes('notif_asset_change_threshold'));
      assert.ok(html.includes('notif_portfolio_change_enabled'));
      assert.ok(html.includes('notif_portfolio_change_threshold'));
      assert.ok(html.includes('btn-test-notif-market-open'));
      assert.ok(html.includes('btn-test-notif-asset-change'));
      assert.ok(html.includes('btn-test-notif-portfolio-change'));
      assert.ok(html.includes('sync_only_market_hours'));
      assert.ok(html.includes('notif_font_style'));
      assert.ok(html.includes('notif-font-preview'));
    });

    test('Mobile settings view renders smartphone notification section & controls', async () => {
      const res = await makeRequest(app, 'GET', '/settings?view=mobile', {
        Cookie: authCookie
      });

      assert.equal(res.status, 200);
      const html = res.text;
      assert.ok(html.includes('notif_market_open_enabled'));
      assert.ok(html.includes('notif_asset_change_enabled'));
      assert.ok(html.includes('notif_asset_change_threshold'));
      assert.ok(html.includes('notif_portfolio_change_enabled'));
      assert.ok(html.includes('notif_portfolio_change_threshold'));
      assert.ok(html.includes('btn-test-notif-market-open'));
      assert.ok(html.includes('btn-test-notif-asset-change'));
      assert.ok(html.includes('btn-test-notif-portfolio-change'));
      assert.ok(html.includes('sync_only_market_hours'));
      assert.ok(html.includes('notif_font_style'));
      assert.ok(html.includes('notif-font-preview'));
    });
  });
});
