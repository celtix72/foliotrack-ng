const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { getSetting } = require('../db');

/**
 * Creates a signed JWT for Google Service Account OAuth2 flow.
 * Uses native Node crypto module (zero external dependencies).
 * @param {string} clientEmail 
 * @param {string} privateKeyPem 
 * @param {string} scope 
 * @returns {string}
 */
function createServiceAccountJwt(clientEmail, privateKeyPem, scope = 'https://www.googleapis.com/auth/drive.file') {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const claimSet = {
    iss: clientEmail,
    scope: scope,
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now
  };

  const base64Url = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const encodedHeader = base64Url(header);
  const encodedClaimSet = base64Url(claimSet);
  const signInput = `${encodedHeader}.${encodedClaimSet}`;

  const signer = crypto.createSign('RSA-SHA256');
  signer.update(signInput);
  signer.end();

  // Normalize private key with newlines if passed in inline format
  let cleanKey = privateKeyPem;
  if (!cleanKey.includes('\n') && cleanKey.includes('-----BEGIN')) {
    cleanKey = cleanKey.replace(/\\n/g, '\n');
  }

  const signature = signer.sign(cleanKey, 'base64url');
  return `${signInput}.${signature}`;
}

/**
 * Exchanges a Service Account JWT for a short-lived Google OAuth2 access token.
 * @param {string} clientEmail 
 * @param {string} privateKeyPem 
 * @param {Function} [fetchFn]
 * @returns {Promise<string>}
 */
async function getGoogleAccessToken(clientEmail, privateKeyPem, fetchFn = global.fetch) {
  const jwt = createServiceAccountJwt(clientEmail, privateKeyPem);
  const res = await fetchFn('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt
    }).toString()
  });

  const data = await res.json();
  if (!res.ok || !data.access_token) {
    throw new Error(data.error_description || data.error || 'Autenticazione Google OAuth2 fallita.');
  }

  return data.access_token;
}

/**
 * Uploads a local file to Google Drive.
 * @param {string} filePath - Absolute or relative path to the local backup file
 * @param {object} [options]
 * @param {number} [options.userId=1]
 * @param {string} [options.folderId]
 * @param {Function} [options.fetchFn]
 * @returns {Promise<{success: boolean, fileId?: string, name?: string, message?: string, error?: string}>}
 */
async function uploadBackupToDrive(filePath, options = {}) {
  const fetchFn = options.fetchFn || global.fetch;
  const userId = options.userId || 1;

  // 1. Resolve configuration from environment or settings
  let clientEmail = process.env.GDRIVE_CLIENT_EMAIL || getSetting(userId, 'gdrive_client_email');
  let privateKey = process.env.GDRIVE_PRIVATE_KEY || getSetting(userId, 'gdrive_private_key');
  let folderId = options.folderId || process.env.GDRIVE_FOLDER_ID || getSetting(userId, 'gdrive_folder_id');
  let accessToken = process.env.GDRIVE_ACCESS_TOKEN || getSetting(userId, 'gdrive_access_token');

  if (!accessToken && (!clientEmail || !privateKey)) {
    return {
      success: false,
      configured: false,
      message: 'Google Drive non configurato: specificare GDRIVE_CLIENT_EMAIL e GDRIVE_PRIVATE_KEY (o token OAuth).'
    };
  }

  if (!fs.existsSync(filePath)) {
    return {
      success: false,
      error: `File non trovato: ${filePath}`
    };
  }

  try {
    // 2. Get Access Token if not already supplied
    if (!accessToken) {
      accessToken = await getGoogleAccessToken(clientEmail, privateKey, fetchFn);
    }

    const filename = path.basename(filePath);
    const fileContent = fs.readFileSync(filePath);

    // 3. Prepare multipart upload to Google Drive v3
    const metadata = {
      name: filename,
      mimeType: 'application/zip'
    };
    if (folderId) {
      metadata.parents = [folderId];
    }

    const boundary = '-------314159265358979323846';
    const delimiter = `\r\n--${boundary}\r\n`;
    const closeDelimiter = `\r\n--${boundary}--`;

    const multipartRequestBody = Buffer.concat([
      Buffer.from(
        delimiter +
        'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
        JSON.stringify(metadata) +
        delimiter +
        'Content-Type: application/zip\r\n\r\n'
      ),
      fileContent,
      Buffer.from(closeDelimiter)
    ]);

    const uploadRes = await fetchFn('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': `multipart/related; boundary=${boundary}`,
        'Content-Length': multipartRequestBody.length.toString()
      },
      body: multipartRequestBody
    });

    const uploadData = await uploadRes.json();
    if (!uploadRes.ok || !uploadData.id) {
      const err = uploadData.error?.message || `HTTP ${uploadRes.status}`;
      return { success: false, error: `Errore caricamento su Google Drive: ${err}` };
    }

    return {
      success: true,
      configured: true,
      fileId: uploadData.id,
      name: uploadData.name || filename,
      message: `File '${filename}' caricato con successo su Google Drive (ID: ${uploadData.id}).`
    };
  } catch (err) {
    return {
      success: false,
      error: `Errore servizio Google Drive: ${err.message}`
    };
  }
}

/**
 * Checks whether Google Drive credentials are configured.
 * @param {number} [userId=1]
 * @returns {boolean}
 */
function isGoogleDriveConfigured(userId = 1) {
  const clientEmail = process.env.GDRIVE_CLIENT_EMAIL || getSetting(userId, 'gdrive_client_email');
  const privateKey = process.env.GDRIVE_PRIVATE_KEY || getSetting(userId, 'gdrive_private_key');
  const accessToken = process.env.GDRIVE_ACCESS_TOKEN || getSetting(userId, 'gdrive_access_token');
  return Boolean(accessToken || (clientEmail && privateKey));
}

module.exports = {
  createServiceAccountJwt,
  getGoogleAccessToken,
  uploadBackupToDrive,
  isGoogleDriveConfigured
};

