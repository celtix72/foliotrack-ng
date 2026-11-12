const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const http = require('http');

const TEST_DB = path.join(__dirname, 'test_tools_nav.db');
process.env.NODE_ENV = 'test';
process.env.DB_PATH = TEST_DB;
process.env.ADMIN_USERNAME = 'admin';
process.env.JWT_SECRET = 'test-secret-jwt-very-long-and-secure-tools-nav';
process.env.ADMIN_PASSWORD = 'adminToolsPassword123!';

const { initDb, closeDb } = require('../src/db');
const app = require('../src/app');

let server;
let baseUrl;
let authCookie;

describe('Navigation: Unified Strumenti (Tools) Hub & Submenu', () => {
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

    const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'adminToolsPassword123!' })
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

  test('GET /tools and /strumenti serve desktop tools hub with sidebar partial', async () => {
    for (const endpoint of ['/tools', '/strumenti']) {
      const res = await fetch(`${baseUrl}${endpoint}`, {
        headers: { Cookie: authCookie }
      });
      assert.equal(res.status, 200);
      const text = await res.text();
      assert.ok(text.includes('Strumenti & Analisi'), `Response should contain Strumenti & Analisi for ${endpoint}`);
      assert.ok(text.includes('Ribilanciamento Portafoglio'), `Response should list rebalance card`);
      assert.ok(text.includes('AI Financial Advisor'), `Response should list AI advisor card`);
      assert.ok(text.includes('Flussi, Dividendi & Fisco'), `Response should list dividends/tax card`);
      assert.ok(text.includes('href="/dist/style.css"'), `Response should load /dist/style.css for ${endpoint}`);
      assert.ok(!text.includes('/css/output.css'), `Response should not have broken /css/output.css`);
      // Sidebar partial check
      assert.ok(text.includes('id="nav-tools-group"'), `Sidebar partial should contain #nav-tools-group`);
      assert.ok(text.includes('id="btn-toggle-tools"'), `Sidebar partial should contain #btn-toggle-tools`);
      assert.ok(text.includes('<span>Strumenti</span>'), `Sidebar partial should contain Strumenti`);
      assert.ok(text.includes('href="/tools"'), `Sidebar should include /tools`);
    }
  });

  test('GET /tools?view=mobile serves mobile tools hub with bottom navigation partial', async () => {
    const res = await fetch(`${baseUrl}/tools?view=mobile`, {
      headers: { Cookie: authCookie }
    });
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.ok(text.includes('Strumenti | FolioTrack Mobile') || text.includes('Sezioni e Tool Analitici'));
    assert.ok(text.includes('href="/dist/style.css"'), 'Mobile tools should load /dist/style.css');
    assert.ok(!text.includes('/css/output.css'), 'Mobile tools should not load broken /css/output.css');
    assert.ok(text.includes('id="mobile-bottom-nav"'), 'Should contain mobile bottom nav partial');
    assert.ok(text.includes('data-mobile-page="tools"'), 'Mobile bottom nav should contain data-mobile-page="tools"');
    assert.ok(text.includes('>Strumenti</span>'), 'Mobile bottom nav should show Strumenti');
    // Ensure no standalone rebalance, ai-advisor or dividends in mobile bottom nav
    assert.ok(!text.includes('data-mobile-page="rebalance"'), 'Mobile bottom nav should NOT contain standalone rebalance page');
    assert.ok(!text.includes('data-mobile-page="ai-advisor"'), 'Mobile bottom nav should NOT contain standalone ai-advisor page');
    assert.ok(!text.includes('data-mobile-page="dividends"'), 'Mobile bottom nav should NOT contain standalone dividends page');
  });

  test('Existing routes /rebalance, /ai-advisor and /dividends remain accessible', async () => {
    const rebRes = await fetch(`${baseUrl}/rebalance`, {
      headers: { Cookie: authCookie }
    });
    assert.equal(rebRes.status, 200);

    const aiRes = await fetch(`${baseUrl}/ai-advisor`, {
      headers: { Cookie: authCookie }
    });
    assert.equal(aiRes.status, 200);

    const divRes = await fetch(`${baseUrl}/dividends`, {
      headers: { Cookie: authCookie }
    });
    assert.equal(divRes.status, 200);
  });

  test('sidebar_partial.html has unified Strumenti accordion and sub-items including Flussi & Fisco', () => {
    const sidebarHtml = fs.readFileSync(path.join(__dirname, '../private_views/partials/sidebar_partial.html'), 'utf8');
    assert.ok(sidebarHtml.includes('id="nav-tools-group"'));
    assert.ok(sidebarHtml.includes('id="btn-toggle-tools"'));
    assert.ok(sidebarHtml.includes('id="nav-tools-sub"'));
    assert.ok(sidebarHtml.includes('href="/rebalance"'));
    assert.ok(sidebarHtml.includes('href="/ai-advisor"'));
    assert.ok(sidebarHtml.includes('href="/tools"'));
    assert.ok(sidebarHtml.includes('href="/dividends"'));
    assert.ok(sidebarHtml.includes('data-subpage="dividends"'));
    assert.ok(!sidebarHtml.includes('data-page="dividends"'), 'Sidebar should not have dividends as top-level data-page');
    assert.ok(sidebarHtml.includes('foliotrack_tools_menu_open'));
  });

  test('mobile_nav_partial.html has 5 unified items and tools route highlight logic', () => {
    const mobileHtml = fs.readFileSync(path.join(__dirname, '../private_views/partials/mobile_nav_partial.html'), 'utf8');
    assert.ok(mobileHtml.includes('data-mobile-page="tools"'));
    assert.ok(mobileHtml.includes('>Strumenti</span>'));
    assert.ok(!mobileHtml.includes('data-mobile-page="rebalance"'));
    assert.ok(!mobileHtml.includes('data-mobile-page="ai-advisor"'));
    assert.ok(!mobileHtml.includes('data-mobile-page="dividends"'));
    assert.ok(mobileHtml.includes("page === 'tools'"));
    // Count navigation items in mobile bottom nav: at least 5 items
    const linkMatches = mobileHtml.match(/<a href="[^"]+" data-mobile-page="/g);
    assert.ok(linkMatches.length >= 5, 'Should have at least 5 mobile navigation items');
  });
});
