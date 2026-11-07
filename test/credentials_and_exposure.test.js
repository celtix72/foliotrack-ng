const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const http = require('http');
const bcrypt = require('bcryptjs');

const TEST_DB = path.join(__dirname, 'test_credentials_exposure.db');
process.env.DB_PATH = TEST_DB;
process.env.JWT_SECRET = 'test-secret-jwt-very-long-and-secure-12345';
process.env.ADMIN_PASSWORD = 'admin123'; // Seed default password to test detection
process.env.ADMIN_USERNAME = 'admin';

const { initDb, closeDb, getDb } = require('../src/db');
const app = require('../src/app');

let server;
let baseUrl;

describe('Credentials Management & Internet Exposure Security', () => {
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

  let authToken;

  test('POST /api/auth/login logs in default admin', async () => {
    const res = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin123' })
    });

    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.success, true);
    authToken = data.token;
  });

  test('GET /api/auth/security-status flags default password and checks internet exposure readiness', async () => {
    const res = await fetch(`${baseUrl}/api/auth/security-status`, {
      headers: { Authorization: `Bearer ${authToken}` }
    });

    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.success, true);
    assert.equal(data.status.isDefaultPassword, true, 'Should detect default password admin123');
    assert.ok(data.status.score < 100, 'Score should be penalized for default password');
    assert.ok(data.status.recommendations.some(r => r.title.includes('Password predefinita')));
  });

  test('POST /api/auth/change-credentials requires currentPassword', async () => {
    const res = await fetch(`${baseUrl}/api/auth/change-credentials`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`
      },
      body: JSON.stringify({ newUsername: 'mauro' })
    });

    assert.equal(res.status, 400);
    const data = await res.json();
    assert.equal(data.success, false);
    assert.ok(data.error.includes('password attuale'));
  });

  test('POST /api/auth/change-credentials rejects incorrect currentPassword', async () => {
    const res = await fetch(`${baseUrl}/api/auth/change-credentials`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`
      },
      body: JSON.stringify({
        currentPassword: 'wrongPassword123',
        newUsername: 'mauro'
      })
    });

    assert.equal(res.status, 401);
    const data = await res.json();
    assert.equal(data.success, false);
    assert.ok(data.error.includes('Password attuale non corretta'));
  });

  test('POST /api/auth/change-credentials validates username format and length', async () => {
    const res = await fetch(`${baseUrl}/api/auth/change-credentials`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`
      },
      body: JSON.stringify({
        currentPassword: 'admin123',
        newUsername: 'ab' // Too short (< 3)
      })
    });

    assert.equal(res.status, 400);
    const data = await res.json();
    assert.equal(data.success, false);
    assert.ok(data.error.includes('tra 3 e 30 caratteri'));
  });

  test('POST /api/auth/change-credentials validates password length (min 8 chars)', async () => {
    const res = await fetch(`${baseUrl}/api/auth/change-credentials`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`
      },
      body: JSON.stringify({
        currentPassword: 'admin123',
        newPassword: 'short' // < 8 chars
      })
    });

    assert.equal(res.status, 400);
    const data = await res.json();
    assert.equal(data.success, false);
    assert.ok(data.error.includes('almeno 8 caratteri'));
  });

  test('POST /api/auth/change-credentials rejects new password identical to current password', async () => {
    const res = await fetch(`${baseUrl}/api/auth/change-credentials`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`
      },
      body: JSON.stringify({
        currentPassword: 'admin123',
        newPassword: 'admin123'
      })
    });

    assert.equal(res.status, 400);
    const data = await res.json();
    assert.equal(data.success, false);
    assert.ok(data.error.includes('diversa da quella attuale'));
  });

  test('POST /api/auth/change-credentials successfully updates username', async () => {
    const res = await fetch(`${baseUrl}/api/auth/change-credentials`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`
      },
      body: JSON.stringify({
        currentPassword: 'admin123',
        newUsername: 'super_investor'
      })
    });

    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.success, true);
    assert.equal(data.user.username, 'super_investor');
    assert.ok(data.token, 'Should return updated JWT token');
    authToken = data.token; // Update token

    // Verify in database
    const dbUser = getDb().prepare('SELECT username FROM users WHERE id = ?').get(data.user.id);
    assert.equal(dbUser.username, 'super_investor');
  });

  test('POST /api/auth/change-password updates password and invalidates previous password', async () => {
    const res = await fetch(`${baseUrl}/api/auth/change-password`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`
      },
      body: JSON.stringify({
        currentPassword: 'admin123',
        newPassword: 'SecureNewPassword2026!'
      })
    });

    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.success, true);
    authToken = data.token;

    // Login with old password should fail
    const oldLoginRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'super_investor', password: 'admin123' })
    });
    assert.equal(oldLoginRes.status, 401);

    // Login with new password should succeed
    const newLoginRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'super_investor', password: 'SecureNewPassword2026!' })
    });
    assert.equal(newLoginRes.status, 200);
    const newLoginData = await newLoginRes.json();
    assert.equal(newLoginData.user.username, 'super_investor');
  });

  test('GET /api/auth/security-status now marks password as safe and not default', async () => {
    const res = await fetch(`${baseUrl}/api/auth/security-status`, {
      headers: { Authorization: `Bearer ${authToken}` }
    });

    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.status.isDefaultPassword, false);
    assert.ok(!data.status.recommendations.some(r => r.title.includes('Password predefinita')));
  });

  test('GET /api/auth/sessions returns active sessions with isCurrent flag', async () => {
    const res = await fetch(`${baseUrl}/api/auth/sessions`, {
      headers: { Authorization: `Bearer ${authToken}` }
    });

    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.success, true);
    assert.ok(Array.isArray(data.sessions));
    assert.ok(data.sessions.length > 0);
    assert.ok(data.sessions.some(s => s.isCurrent === true));
  });

  test('DELETE /api/auth/sessions revokes other sessions', async () => {
    const res = await fetch(`${baseUrl}/api/auth/sessions`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${authToken}` }
    });

    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.success, true);
  });

  test('GET /api/auth/audit-logs returns recent security events', async () => {
    const res = await fetch(`${baseUrl}/api/auth/audit-logs`, {
      headers: { Authorization: `Bearer ${authToken}` }
    });

    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.success, true);
    assert.ok(Array.isArray(data.logs));
    assert.ok(data.logs.some(l => l.action === 'CHANGE_CREDENTIALS'));
  });

  test('GET /robots.txt disallows web crawling for security/privacy', async () => {
    const res = await fetch(`${baseUrl}/robots.txt`);
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.ok(text.includes('User-agent: *'));
    assert.ok(text.includes('Disallow: /'));
  });

  test('API responses include Cache-Control no-store headers and X-Robots-Tag', async () => {
    const res = await fetch(`${baseUrl}/api/health`);
    assert.equal(res.status, 200);
    const cacheControl = res.headers.get('cache-control');
    assert.ok(cacheControl && cacheControl.includes('no-store'));
    const robotsTag = res.headers.get('x-robots-tag');
    assert.ok(robotsTag && robotsTag.includes('noindex'));
  });

  test('CSRF protection blocks mutating requests with unauthorized cross-origin Origin header', async () => {
    const res = await fetch(`${baseUrl}/api/auth/change-password`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`,
        Origin: 'https://malicious-cross-origin.com'
      },
      body: JSON.stringify({ currentPassword: 'SecureNewPassword2026!' })
    });

    assert.equal(res.status, 403);
    const data = await res.json();
    assert.equal(data.success, false);
    assert.ok(data.error.includes('CORS origin not allowed') || data.error.includes('cross-origin non autorizzata'));
  });
});
