const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const http = require('http');

const TEST_DB = path.join(__dirname, 'test_pwa_android.db');
process.env.DB_PATH = TEST_DB;
process.env.JWT_SECRET = 'test-secret-jwt-very-long-and-secure-pwa-android';
process.env.ADMIN_PASSWORD = 'adminPwaPass123!';

const { initDb, closeDb, getDb } = require('../src/db');
const app = require('../src/app');

let server;
let baseUrl;
let authCookie;

describe('Android PWA Standalone Web App Installation & Criteria', () => {
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

    // Login as admin
    const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'adminPwaPass123!' })
    });
    authCookie = loginRes.headers.get('set-cookie')?.split(';')[0] || '';
  });

  after(() => {
    if (server) server.close();
    closeDb();
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  });

  test('GET /manifest.webmanifest serves valid PWA manifest with standalone display', async () => {
    const res = await fetch(`${baseUrl}/manifest.webmanifest`);
    assert.equal(res.status, 200, 'Manifest endpoint must return 200');

    const contentType = res.headers.get('content-type') || '';
    assert.ok(
      contentType.includes('application/manifest+json') || contentType.includes('application/json'),
      `Content-Type should be manifest json, got ${contentType}`
    );

    const manifest = await res.json();
    assert.equal(manifest.name, 'FolioTrack - Portfolio Tracker');
    assert.equal(manifest.short_name, 'FolioTrack');
    assert.equal(manifest.display, 'standalone', 'PWA display must be standalone for native Android experience');
    assert.ok(manifest.start_url, 'Must have start_url');

    // Verify icons meet Chrome PWA criteria
    assert.ok(Array.isArray(manifest.icons) && manifest.icons.length >= 2, 'Manifest must contain icons');
    const has192 = manifest.icons.some(i => i.sizes === '192x192');
    const has512 = manifest.icons.some(i => i.sizes === '512x512');
    const hasMaskable = manifest.icons.some(i => i.purpose && i.purpose.includes('maskable'));

    assert.ok(has192, 'Manifest must include 192x192 icon');
    assert.ok(has512, 'Manifest must include 512x512 icon');
    assert.ok(hasMaskable, 'Manifest must include maskable icon for Android adaptive icons');
  });

  test('GET /manifest.json serves identical manifest for backward compatibility', async () => {
    const res = await fetch(`${baseUrl}/manifest.json`);
    assert.equal(res.status, 200);
    const manifest = await res.json();
    assert.equal(manifest.short_name, 'FolioTrack');
    assert.equal(manifest.display, 'standalone');
  });

  test('GET /sw.js serves Service Worker with fetch listener for Chrome PWA installability', async () => {
    const res = await fetch(`${baseUrl}/sw.js`);
    assert.equal(res.status, 200);
    const code = await res.text();

    assert.ok(code.includes("addEventListener('fetch'"), 'SW must have fetch event listener for PWA installability');
    assert.ok(code.includes("addEventListener('install'"), 'SW must have install listener');
    assert.ok(code.includes("addEventListener('activate'"), 'SW must have activate listener');
  });

  test('PWA icon assets are served and exist on disk', async () => {
    const res192 = await fetch(`${baseUrl}/icons/icon-192.png`);
    assert.equal(res192.status, 200, 'icon-192.png must be accessible');
    assert.ok(res192.headers.get('content-type')?.includes('image/png'));

    const res512 = await fetch(`${baseUrl}/icons/icon-512.png`);
    assert.equal(res512.status, 200, 'icon-512.png must be accessible');

    const resSvg = await fetch(`${baseUrl}/icons/icon.svg`);
    assert.equal(resSvg.status, 200, 'icon.svg must be accessible');
  });

  test('HTML views include PWA meta tags, manifest link and installer script', async () => {
    // 1. Static Login page
    const loginRes = await fetch(`${baseUrl}/login.html`);
    const loginHtml = await loginRes.text();
    assert.ok(loginHtml.includes('manifest.webmanifest'), 'login.html must link to manifest');
    assert.ok(loginHtml.includes('mobile-web-app-capable'), 'login.html must have mobile-web-app-capable');
    assert.ok(loginHtml.includes('pwa_installer.js'), 'login.html must include pwa_installer.js');

    // 2. Authenticated Dashboard view
    const dashRes = await fetch(`${baseUrl}/dashboard`, {
      headers: { Cookie: authCookie }
    });
    const dashHtml = await dashRes.text();
    assert.ok(dashHtml.includes('manifest.webmanifest'), 'dashboard must link to manifest');
    assert.ok(dashHtml.includes('pwa_installer.js'), 'dashboard must include pwa_installer.js');
    assert.ok(dashHtml.includes('apple-mobile-web-app-capable'), 'dashboard must have apple-mobile-web-app-capable');
  });

  test('Security Middleware CSP headers permit manifest and service worker', async () => {
    const res = await fetch(`${baseUrl}/login.html`);
    const csp = res.headers.get('content-security-policy') || '';
    assert.ok(csp.includes("manifest-src 'self'"), 'CSP must allow manifest-src');
    assert.ok(csp.includes("worker-src 'self'"), 'CSP must allow worker-src');
  });
});

