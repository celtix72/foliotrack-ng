const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const http = require('http');

const TEST_DB = path.join(__dirname, 'test_phase3.db');
process.env.DB_PATH = TEST_DB;
process.env.JWT_SECRET = 'test-secret-jwt-very-long-and-secure-phase3';
process.env.ADMIN_PASSWORD = 'adminPhase3Password!';

const { initDb, closeDb } = require('../src/db');
const app = require('../src/app');
const { isMobile, readFileCached, clearCache } = require('../src/utils/viewRenderer');

let server;
let baseUrl;
let authCookie;

describe('Phase 3: Frontend Signature Layout & Dual-View Engine', () => {
  before(async () => {
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    initDb(TEST_DB);

    await new Promise((resolve) => {
      server = http.createServer(app);
      server.listen(0, '127.0.0.1', () => {
        const port = server.address().port;
        baseUrl = `http://127.0.0.1:${port}`;
        resolve();
      });
    });

    // Login to get session cookie
    const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'adminPhase3Password!' })
    });
    const setCookie = loginRes.headers.get('set-cookie');
    authCookie = setCookie.split(';')[0];
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    closeDb();
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    const walFile = `${TEST_DB}-wal`;
    const shmFile = `${TEST_DB}-shm`;
    if (fs.existsSync(walFile)) fs.unlinkSync(walFile);
    if (fs.existsSync(shmFile)) fs.unlinkSync(shmFile);
  });

  test('isMobile detects view query override and user-agents', () => {
    // Explicit override
    assert.equal(isMobile({ query: { view: 'mobile' }, get: () => 'Mozilla/5.0' }), true);
    assert.equal(isMobile({ query: { view: 'desktop' }, get: () => 'iPhone' }), false);

    // Mobile user-agents
    assert.equal(isMobile({ query: {}, get: () => 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)' }), true);
    assert.equal(isMobile({ query: {}, get: () => 'Mozilla/5.0 (Linux; Android 14; Pixel 8)' }), true);

    // Desktop user-agent
    assert.equal(isMobile({ query: {}, get: () => 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' }), false);
  });

  test('readFileCached caches file and invalidates on mtime modification', () => {
    clearCache();
    const tempFile = path.join(__dirname, 'temp_cache_test.txt');
    fs.writeFileSync(tempFile, 'Version 1');

    const firstRead = readFileCached(tempFile);
    assert.equal(firstRead, 'Version 1');

    // Overwrite file with new timestamp
    const futureTime = new Date(Date.now() + 2000);
    fs.writeFileSync(tempFile, 'Version 2');
    fs.utimesSync(tempFile, futureTime, futureTime);

    const secondRead = readFileCached(tempFile);
    assert.equal(secondRead, 'Version 2');

    fs.unlinkSync(tempFile);
  });

  test('Static frontend assets are served correctly', async () => {
    // Login page
    const loginRes = await fetch(`${baseUrl}/login.html`);
    assert.equal(loginRes.status, 200);
    const loginHtml = await loginRes.text();
    assert.ok(loginHtml.includes('FolioTrack'));
    assert.ok(loginHtml.includes('theme.js'));

    // Theme manager JS
    const themeRes = await fetch(`${baseUrl}/theme.js`);
    assert.equal(themeRes.status, 200);
    const themeJs = await themeRes.text();
    assert.ok(themeJs.includes('toggleTheme'));

    // Live ticker JS
    const tickerRes = await fetch(`${baseUrl}/header_indices.js`);
    assert.equal(tickerRes.status, 200);
    const tickerJs = await tickerRes.text();
    assert.ok(tickerJs.includes('FolioTrack Live Market Ticker'));

    // Compiled CSS
    const cssRes = await fetch(`${baseUrl}/dist/style.css`);
    assert.equal(cssRes.status, 200);
    const css = await cssRes.text();
    assert.ok(css.includes('font-variant-numeric:tabular-nums') || css.includes('tabular-nums'));
  });

  test('GET / redirects unauthenticated requests to login.html', async () => {
    const res = await fetch(`${baseUrl}/`, { redirect: 'manual' });
    assert.equal(res.status, 302);
    const location = res.headers.get('location');
    assert.ok(location.includes('/login.html'));
  });

  test('GET / serves desktop dashboard with injected sidebar when authenticated', async () => {
    const res = await fetch(`${baseUrl}/`, {
      headers: { Cookie: authCookie }
    });
    assert.equal(res.status, 200);
    const html = await res.text();

    // Verify desktop view
    assert.ok(html.includes('id="app-sidebar"'), 'Sidebar partial must be injected into desktop view');
    assert.ok(html.includes('Dashboard'), 'Must contain navigation title');
    assert.ok(html.includes('live-ticker-container'), 'Must contain live ticker element');
  });

  test('GET /?view=mobile serves mobile dashboard layout', async () => {
    const res = await fetch(`${baseUrl}/?view=mobile`, {
      headers: { Cookie: authCookie }
    });
    assert.equal(res.status, 200);
    const html = await res.text();

    // Verify mobile view features
    assert.ok(html.includes('FolioTrack Mobile'), 'Must serve mobile view');
    assert.ok(html.includes('safe-area-bottom'), 'Must contain mobile tab bar');
    assert.ok(!html.includes('id="app-sidebar"'), 'Mobile view should not contain desktop sidebar');
  });
});

