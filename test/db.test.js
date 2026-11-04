const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { initDb, closeDb, getSetting, setSetting, getDb } = require('../src/db');
const bcrypt = require('bcryptjs');

const TEST_DB_PATH = path.join(__dirname, 'test_foliotrack.db');

describe('Database Layer & DDL Schema', () => {
  before(() => {
    if (fs.existsSync(TEST_DB_PATH)) {
      fs.unlinkSync(TEST_DB_PATH);
    }
    initDb(TEST_DB_PATH);
  });

  after(() => {
    closeDb();
    if (fs.existsSync(TEST_DB_PATH)) {
      fs.unlinkSync(TEST_DB_PATH);
    }
    const walFile = `${TEST_DB_PATH}-wal`;
    const shmFile = `${TEST_DB_PATH}-shm`;
    if (fs.existsSync(walFile)) fs.unlinkSync(walFile);
    if (fs.existsSync(shmFile)) fs.unlinkSync(shmFile);
  });

  test('pragmas WAL and foreign_keys are enabled', () => {
    const database = getDb();
    const journalMode = database.pragma('journal_mode', { simple: true });
    assert.equal(journalMode.toLowerCase(), 'wal');

    const foreignKeys = database.pragma('foreign_keys', { simple: true });
    assert.equal(foreignKeys, 1);
  });

  test('all required Phase 1 tables exist', () => {
    const database = getDb();
    const tables = database.prepare(`
      SELECT name FROM sqlite_master WHERE type='table'
    `).all().map(t => t.name);

    assert.ok(tables.includes('users'), 'users table missing');
    assert.ok(tables.includes('settings'), 'settings table missing');
    assert.ok(tables.includes('user_sessions'), 'user_sessions table missing');
    assert.ok(tables.includes('audit_logs'), 'audit_logs table missing');
    assert.ok(tables.includes('failed_logins'), 'failed_logins table missing');
    assert.ok(tables.includes('push_subscriptions'), 'push_subscriptions table missing');
  });

  test('initial admin user is seeded with secure password hash', () => {
    const database = getDb();
    const user = database.prepare('SELECT * FROM users WHERE username = ?').get('admin');
    assert.ok(user, 'Admin user should be seeded');
    assert.equal(user.role, 'admin');
    assert.ok(user.password_hash.startsWith('$2'));

    const isValid = bcrypt.compareSync('admin123', user.password_hash);
    assert.equal(isValid, true, 'Default admin password should be admin123');

    // Audit log should contain SYSTEM_SEED action
    const audit = database.prepare('SELECT * FROM audit_logs WHERE action = ?').get('SYSTEM_SEED');
    assert.ok(audit, 'Audit log for system seed should exist');
  });

  test('settings table stores plaintext and encrypted values with getSetting/setSetting', () => {
    const database = getDb();
    const adminUser = database.prepare('SELECT id FROM users WHERE username = ?').get('admin');

    // Plaintext setting
    setSetting(adminUser.id, 'theme', 'dark', false);
    const theme = getSetting(adminUser.id, 'theme');
    assert.equal(theme, 'dark');

    // Encrypted setting (e.g. API key)
    const secretKey = 'sk-live-1234567890abcdef';
    setSetting(adminUser.id, 'gemini_api_key', secretKey, true);

    // Retrieve decrypted
    const decryptedKey = getSetting(adminUser.id, 'gemini_api_key', true);
    assert.equal(decryptedKey, secretKey);

    // Verify it is stored encrypted in raw SQL
    const rawRow = database.prepare('SELECT value FROM settings WHERE user_id = ? AND key = ?').get(adminUser.id, 'gemini_api_key');
    assert.ok(rawRow, 'Row should exist in settings table');
    assert.ok(rawRow.value.startsWith('enc:v1:'));
  });
});
