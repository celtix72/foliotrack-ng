const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const http = require('http');

const TEST_DB = path.join(__dirname, 'test_security.db');
process.env.DB_PATH = TEST_DB;

const { initDb, closeDb } = require('../src/db');
const app = require('../src/app');

let server;
let baseUrl;

describe('Security Middlewares (Helmet, CORS, Rate Limiting)', () => {
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

  test('Helmet sends Content-Security-Policy with required domains and no upgrade-insecure on HTTP', async () => {
    const res = await fetch(`${baseUrl}/api/health`);
    const csp = res.headers.get('content-security-policy');

    assert.ok(csp, 'CSP header must be present');
    assert.ok(csp.includes('cdn.jsdelivr.net'), 'CSP must include cdn.jsdelivr.net');
    assert.ok(csp.includes('cdnjs.cloudflare.com'), 'CSP must include cdnjs.cloudflare.com');
    assert.ok(csp.includes('fonts.googleapis.com'), 'CSP must include Google Fonts');
    assert.ok(!csp.includes('upgrade-insecure-requests'), 'HTTP request should NOT include upgrade-insecure-requests');
  });

  test('Helmet includes upgrade-insecure-requests when forwarded as HTTPS', async () => {
    const res = await fetch(`${baseUrl}/api/health`, {
      headers: {
        'x-forwarded-proto': 'https'
      }
    });
    const csp = res.headers.get('content-security-policy');
    assert.ok(csp, 'CSP header must be present');
    assert.ok(csp.includes('upgrade-insecure-requests'), 'HTTPS request must include upgrade-insecure-requests');
  });

  test('CORS handles credentials and preflight options', async () => {
    const res = await fetch(`${baseUrl}/api/health`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'http://localhost:3000',
        'Access-Control-Request-Method': 'GET'
      }
    });

    assert.equal(res.status, 204);
    assert.equal(res.headers.get('access-control-allow-credentials'), 'true');
    assert.equal(res.headers.get('access-control-allow-origin'), 'http://localhost:3000');
  });

  test('Rate limiter headers are present on API requests', async () => {
    const res = await fetch(`${baseUrl}/api/health`);
    assert.ok(res.headers.has('ratelimit-limit') || res.headers.has('x-ratelimit-limit'));
  });

  test('Strict login rate limiter triggers 429 after 15 failed requests', async () => {
    let triggered429 = false;

    // Send 16 requests to /api/auth/login
    for (let i = 0; i < 17; i++) {
      const res = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'nonexistent', password: 'bad' })
      });

      if (res.status === 429) {
        triggered429 = true;
        const data = await res.json();
        assert.equal(data.success, false);
        assert.ok(data.error.includes('Troppi tentativi'));
        break;
      }
    }

    assert.equal(triggered429, true, 'Rate limiter should have returned 429 status');
  });
});

