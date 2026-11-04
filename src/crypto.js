const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';
const PREFIX = 'enc:v1:';
const IV_LENGTH = 12; // 96-bit IV recommended for AES-GCM
const TAG_LENGTH = 16; // 128-bit authentication tag

/**
 * Derives a deterministic 32-byte (256-bit) key from the configured secret.
 * Uses SETTINGS_ENCRYPTION_KEY or falls back to JWT_SECRET.
 */
function getDerivedKey() {
  const secret = process.env.SETTINGS_ENCRYPTION_KEY || process.env.JWT_SECRET || 'foliotrack-default-secret-change-me-in-production';
  return crypto.createHash('sha256').update(String(secret)).digest();
}

/**
 * Encrypts a plaintext string (or serializable object) using AES-256-GCM.
 * Output format: enc:v1:<iv_hex>:<auth_tag_hex>:<ciphertext_hex>
 *
 * @param {string|number|object} plainText
 * @returns {string}
 */
function encrypt(plainText) {
  if (plainText === null || plainText === undefined) {
    return plainText;
  }

  const key = getDerivedKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  const textToEncrypt = typeof plainText === 'object' ? JSON.stringify(plainText) : String(plainText);
  let encrypted = cipher.update(textToEncrypt, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag().toString('hex');

  return `${PREFIX}${iv.toString('hex')}:${authTag}:${encrypted}`;
}

/**
 * Decrypts a ciphertext string formatted with prefix enc:v1:.
 * If the string does not start with enc:v1:, returns it untouched.
 *
 * @param {string} cipherText
 * @returns {string}
 */
function decrypt(cipherText) {
  if (typeof cipherText !== 'string' || !cipherText.startsWith(PREFIX)) {
    return cipherText;
  }

  const parts = cipherText.slice(PREFIX.length).split(':');
  if (parts.length !== 3) {
    throw new Error('Invalid encrypted format: expected iv:tag:ciphertext');
  }

  const [ivHex, authTagHex, encryptedHex] = parts;
  const key = getDerivedKey();
  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');

  if (iv.length !== IV_LENGTH || authTag.length !== TAG_LENGTH) {
    throw new Error('Invalid IV or auth tag length');
  }

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  let decrypted = decipher.update(encryptedHex, 'hex', 'utf8');
  decrypted += decipher.final('utf8');

  return decrypted;
}

/**
 * Generates a cryptographically secure random token (hex string).
 * @param {number} [bytes=32]
 * @returns {string}
 */
function generateRandomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('hex');
}

/**
 * Creates a sha256 hash of a string (useful for hashing session tokens in DB).
 * @param {string} input
 * @returns {string}
 */
function hashToken(input) {
  return crypto.createHash('sha256').update(String(input)).digest('hex');
}

module.exports = {
  encrypt,
  decrypt,
  generateRandomToken,
  hashToken,
  PREFIX
};

