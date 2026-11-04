const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const http = require('http');

const TEST_DB = path.join(__dirname, 'test_auth.db');
process.env.DB_PATH = TEST_DB;
process.env.JWT_SECRET = 'test-secret-jwt-very-long-and-secure-12345';
process.env.ADMIN_PASSWORD = 'superSecretAdminPassword!';

const { initDb, closeDb, getDb } = require('../src/db');
const app = require('../src/app');

let server;
let baseUrl;

describe('Authentication & Security Routes', () => {
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

  test('GET /api/health should return ok and system stats', async () => {
    const res = await fetch(`${baseUrl}/api/health`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.status, 'ok');
    assert.ok(data.uptime >= 0);
  });

  test('POST /api/auth/login should fail with invalid credentials', async () => {
    const res = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'wrongPassword' })
    });

    assert.equal(res.status, 401);
    const data = await res.json();
    assert.equal(data.success, false);
    assert.equal(data.error, 'Credenziali non valide.');

    // Check failed_logins record in DB
    const failed = getDb().prepare('SELECT * FROM failed_logins WHERE username = ?').get('admin');
    assert.ok(failed);
  });

  test('POST /api/auth/login should succeed with valid credentials', async () => {
    const res = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'superSecretAdminPassword!' })
    });

    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.success, true);
    assert.ok(data.token, 'Should return JWT token');
    assert.equal(data.user.username, 'admin');
    assert.equal(data.user.role, 'admin');

    // Check cookie
    const setCookie = res.headers.get('set-cookie');
    assert.ok(setCookie, 'Should set httpOnly cookie');
    assert.ok(setCookie.includes('foliotrack_token='));
    assert.ok(setCookie.includes('HttpOnly'));
    assert.ok(setCookie.includes('SameSite=Lax'));

    // Check session recorded in user_sessions
    const session = getDb().prepare('SELECT * FROM user_sessions WHERE user_id = ?').get(data.user.id);
    assert.ok(session, 'User session should be created in DB');

    // Check audit_logs
    const audit = getDb().prepare('SELECT * FROM audit_logs WHERE user_id = ? AND action = ?').get(data.user.id, 'LOGIN');
    assert.ok(audit, 'Audit log should record successful login');
  });

  test('GET /api/auth/me should require authentication', async () => {
    const unauthRes = await fetch(`${baseUrl}/api/auth/me`);
    assert.equal(unauthRes.status, 401);
  });

  test('GET /api/auth/me should succeed with Bearer header', async () => {
    // Login to get token
    const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'superSecretAdminPassword!' })
    });
    const { token } = await loginRes.json();

    const meRes = await fetch(`${baseUrl}/api/auth/me`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    assert.equal(meRes.status, 200);
    const meData = await meRes.json();
    assert.equal(meData.success, true);
    assert.equal(meData.user.username, 'admin');
  });

  test('GET /api/auth/me should succeed with Cookie header', async () => {
    const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'superSecretAdminPassword!' })
    });
    const setCookie = loginRes.headers.get('set-cookie');
    const cookieHeader = setCookie.split(';')[0];

    const meRes = await fetch(`${baseUrl}/api/auth/me`, {
      headers: { Cookie: cookieHeader }
    });
    assert.equal(meRes.status, 200);
    const meData = await meRes.json();
    assert.equal(meData.success, true);
    assert.equal(meData.user.username, 'admin');
  });

  test('PUT and GET /api/settings should store and retrieve encrypted settings', async () => {
    const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'superSecretAdminPassword!' })
    });
    const { token } = await loginRes.json();

    // Save encrypted setting
    const saveRes = await fetch(`${baseUrl}/api/settings`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify({
        key: 'OPENAI_API_KEY',
        value: 'sk-proj-9876543210-xyz',
        encrypted: true
      })
    });
    assert.equal(saveRes.status, 200);

    // Retrieve setting (auto decrypted)
    const getRes = await fetch(`${baseUrl}/api/settings/OPENAI_API_KEY`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    assert.equal(getRes.status, 200);
    const getData = await getRes.json();
    assert.equal(getData.value, 'sk-proj-9876543210-xyz');

    // Retrieve setting raw (must start with enc:v1:)
    const getRawRes = await fetch(`${baseUrl}/api/settings/OPENAI_API_KEY?raw=true`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const getRawData = await getRawRes.json();
    assert.ok(getRawData.value.startsWith('enc:v1:'));
  });

  test('POST /api/auth/logout should clear session and cookie', async () => {
    const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'superSecretAdminPassword!' })
    });
    const { token } = await loginRes.json();

    const logoutRes = await fetch(`${baseUrl}/api/auth/logout`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` }
    });
    assert.equal(logoutRes.status, 200);
    const logoutData = await logoutRes.json();
    assert.equal(logoutData.success, true);

    const setCookie = logoutRes.headers.get('set-cookie');
    assert.ok(setCookie);
    assert.ok(setCookie.includes('foliotrack_token=;') || setCookie.includes('Max-Age=0'));
  });
});
