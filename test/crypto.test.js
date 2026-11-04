const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { encrypt, decrypt, generateRandomToken, hashToken, PREFIX } = require('../src/crypto');

describe('Cryptographic Manager (AES-256-GCM)', () => {
  test('encrypt should produce prefix enc:v1: with iv, tag, and ciphertext', () => {
    const secret = 'my-secret-api-key-12345';
    const encrypted = encrypt(secret);

    assert.ok(typeof encrypted === 'string');
    assert.ok(encrypted.startsWith(PREFIX));

    const parts = encrypted.slice(PREFIX.length).split(':');
    assert.equal(parts.length, 3);
    assert.equal(parts[0].length, 24); // 12 bytes hex
    assert.equal(parts[1].length, 32); // 16 bytes auth tag hex
    assert.ok(parts[2].length > 0);
  });

  test('decrypt should recover original plaintext', () => {
    const original = 'Tavily-API-Key-987654321';
    const encrypted = encrypt(original);
    const decrypted = decrypt(encrypted);

    assert.equal(decrypted, original);
  });

  test('encryption should be non-deterministic (different IVs for same plaintext)', () => {
    const text = 'same-string';
    const enc1 = encrypt(text);
    const enc2 = encrypt(text);

    assert.notEqual(enc1, enc2);
    assert.equal(decrypt(enc1), text);
    assert.equal(decrypt(enc2), text);
  });

  test('decrypt should return unencrypted strings untouched', () => {
    const raw = 'plain_unencrypted_setting_value';
    assert.equal(decrypt(raw), raw);
  });

  test('decrypt should throw on tampered ciphertext', () => {
    const encrypted = encrypt('sensitive-data');
    const parts = encrypted.split(':');
    // parts: ['enc', 'v1', iv, tag, cipher]
    const originalCipher = parts[4];
    const tamperedChar = originalCipher[0] === 'a' ? 'b' : 'a';
    parts[4] = tamperedChar + originalCipher.slice(1);
    const tampered = parts.join(':');

    assert.throws(() => {
      decrypt(tampered);
    });
  });

  test('hashToken and generateRandomToken helpers work correctly', () => {
    const token = generateRandomToken(16);
    assert.equal(token.length, 32);

    const hash1 = hashToken(token);
    const hash2 = hashToken(token);
    assert.equal(hash1, hash2);
    assert.equal(hash1.length, 64);
  });
});
