const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { db } = require('../db');
const { hashToken } = require('../crypto');
const { requireAuth, JWT_SECRET } = require('../middlewares/authMiddleware');
const { strictLoginLimiter, credentialChangeLimiter, isRequestHttps } = require('../middlewares/securityMiddleware');

const router = express.Router();

const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '7d';
const SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/**
 * Helper to record failed login attempts.
 */
function recordFailedLogin(ip, username) {
  try {
    const stmt = db.prepare('INSERT INTO failed_logins (ip_address, username) VALUES (?, ?)');
    stmt.run(ip, username || null);
  } catch (err) {
    console.error('[Auth] Error recording failed login:', err.message);
  }
}

/**
 * Helper to record audit logs.
 */
function recordAuditLog(userId, action, details, ip) {
  try {
    const stmt = db.prepare('INSERT INTO audit_logs (user_id, action, details, ip_address) VALUES (?, ?, ?, ?)');
    stmt.run(userId || null, action, details || null, ip || null);
  } catch (err) {
    console.error('[Auth] Error recording audit log:', err.message);
  }
}

/**
 * POST /api/auth/login
 * Strict rate-limited login endpoint.
 */
router.post('/login', strictLoginLimiter, (req, res) => {
  const { username, password } = req.body || {};
  const clientIp = req.ip || req.connection?.remoteAddress || '127.0.0.1';
  const userAgent = req.get('user-agent') || 'unknown';

  if (!username || !password) {
    recordFailedLogin(clientIp, username);
    return res.status(400).json({
      success: false,
      error: 'Username ed email e password sono richiesti.'
    });
  }

  // Look up user by username or email
  const user = db.prepare(`
    SELECT id, username, email, password_hash, role, createdAt
    FROM users
    WHERE username = ? OR email = ?
  `).get(username.trim(), username.trim());

  if (!user) {
    recordFailedLogin(clientIp, username);
    return res.status(401).json({
      success: false,
      error: 'Credenziali non valide.'
    });
  }

  const isPasswordValid = bcrypt.compareSync(password, user.password_hash);
  if (!isPasswordValid) {
    recordFailedLogin(clientIp, username);
    return res.status(401).json({
      success: false,
      error: 'Credenziali non valide.'
    });
  }

  // Sign JWT token
  const tokenPayload = {
    id: user.id,
    username: user.username,
    role: user.role
  };
  const token = jwt.sign(tokenPayload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });

  // Generate session record
  const sessionId = crypto.randomUUID();
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + SESSION_MAX_AGE_MS).toISOString();

  try {
    const insertSession = db.prepare(`
      INSERT INTO user_sessions (id, user_id, token_hash, ip_address, user_agent, expires_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    insertSession.run(sessionId, user.id, tokenHash, clientIp, userAgent, expiresAt);
  } catch (err) {
    console.error('[Auth] Error saving session to database:', err.message);
  }

  // Audit log
  recordAuditLog(user.id, 'LOGIN', `User ${user.username} logged in successfully`, clientIp);

  // Set httpOnly cookie
  const isHttps = isRequestHttps(req);
  res.cookie('foliotrack_token', token, {
    httpOnly: true,
    secure: isHttps,
    sameSite: 'lax',
    maxAge: SESSION_MAX_AGE_MS,
    path: '/'
  });

  return res.json({
    success: true,
    token,
    user: {
      id: user.id,
      username: user.username,
      email: user.email,
      role: user.role,
      createdAt: user.createdAt
    }
  });
});

/**
 * POST /api/auth/logout
 * Clears session cookie and invalidates user session.
 */
router.post('/logout', (req, res) => {
  const clientIp = req.ip || req.connection?.remoteAddress || '127.0.0.1';
  let token = null;

  if (req.cookies && req.cookies.foliotrack_token) {
    token = req.cookies.foliotrack_token;
  } else if (req.headers.authorization) {
    const parts = req.headers.authorization.split(' ');
    if (parts.length === 2 && /^Bearer$/i.test(parts[0])) {
      token = parts[1];
    }
  }

  if (token) {
    try {
      const decoded = jwt.decode(token);
      const tokenHash = hashToken(token);

      // Remove session from DB
      db.prepare('DELETE FROM user_sessions WHERE token_hash = ?').run(tokenHash);

      if (decoded && decoded.id) {
        recordAuditLog(decoded.id, 'LOGOUT', `User ${decoded.username} logged out`, clientIp);
      }
    } catch (err) {
      console.warn('[Auth] Error during logout session invalidation:', err.message);
    }
  }

  const isHttps = isRequestHttps(req);
  res.clearCookie('foliotrack_token', {
    httpOnly: true,
    secure: isHttps,
    sameSite: 'lax',
    path: '/'
  });
  res.clearCookie('token', {
    httpOnly: true,
    secure: isHttps,
    sameSite: 'lax',
    path: '/'
  });

  return res.json({
    success: true,
    message: 'Logout effettuato con successo.'
  });
});

/**
 * GET /api/auth/me
 * Retrieves current authenticated user profile.
 */
router.get('/me', requireAuth, (req, res) => {
  return res.json({
    success: true,
    user: req.user
  });
});

/**
 * Controller to handle credential updates (username and/or password and/or email).
 */
async function handleChangeCredentials(req, res) {
  const userId = req.user.id;
  const clientIp = req.ip || req.connection?.remoteAddress || '127.0.0.1';
  const { currentPassword, newUsername, newPassword, newEmail } = req.body || {};

  // 1. Current password is required for security verification
  if (!currentPassword || typeof currentPassword !== 'string') {
    return res.status(400).json({
      success: false,
      error: 'La password attuale è obbligatoria per confermare le modifiche.'
    });
  }

  // 2. Fetch user with password_hash from DB
  const user = db.prepare('SELECT id, username, email, password_hash, role FROM users WHERE id = ?').get(userId);
  if (!user) {
    return res.status(404).json({
      success: false,
      error: 'Utente non trovato.'
    });
  }

  // 3. Verify current password
  const isMatch = bcrypt.compareSync(currentPassword, user.password_hash);
  if (!isMatch) {
    recordAuditLog(userId, 'FAILED_CREDENTIAL_CHANGE', 'Tentativo di modifica credenziali con password errata', clientIp);
    return res.status(401).json({
      success: false,
      error: 'Password attuale non corretta.'
    });
  }

  let updatedUsername = user.username;
  let updatedEmail = user.email;
  let updatedPasswordHash = user.password_hash;
  const auditChanges = [];

  // 4. Validate and prepare username change
  if (newUsername !== undefined && newUsername !== null) {
    const trimmedUsername = String(newUsername).trim();
    if (!trimmedUsername) {
      return res.status(400).json({
        success: false,
        error: 'Il nuovo username non può essere vuoto.'
      });
    }

    if (trimmedUsername !== user.username) {
      // Username validation: alphanumeric, dot, underscore, hyphen, 3-30 chars
      const usernameRegex = /^[a-zA-Z0-9_.-]{3,30}$/;
      if (!usernameRegex.test(trimmedUsername)) {
        return res.status(400).json({
          success: false,
          error: 'Lo username deve avere tra 3 e 30 caratteri alfanumerici (lettere, numeri, _, -, .).'
        });
      }

      // Check collision (case-insensitive)
      const existingUser = db.prepare('SELECT id FROM users WHERE username = ? COLLATE NOCASE AND id != ?').get(trimmedUsername, userId);
      if (existingUser) {
        return res.status(409).json({
          success: false,
          error: `Lo username "${trimmedUsername}" è già utilizzato da un altro utente.`
        });
      }

      updatedUsername = trimmedUsername;
      auditChanges.push(`username da "${user.username}" a "${trimmedUsername}"`);
    }
  }

  // 5. Validate and prepare password change
  if (newPassword !== undefined && newPassword !== null && String(newPassword).length > 0) {
    const trimmedPassword = String(newPassword);
    if (trimmedPassword.length < 8) {
      return res.status(400).json({
        success: false,
        error: 'La nuova password deve contenere almeno 8 caratteri.'
      });
    }

    if (bcrypt.compareSync(trimmedPassword, user.password_hash)) {
      return res.status(400).json({
        success: false,
        error: 'La nuova password deve essere diversa da quella attuale.'
      });
    }

    const salt = bcrypt.genSaltSync(12);
    updatedPasswordHash = bcrypt.hashSync(trimmedPassword, salt);
    auditChanges.push('password aggiornata');
  }

  // 6. Validate and prepare email change
  if (newEmail !== undefined && newEmail !== null) {
    const trimmedEmail = String(newEmail).trim();
    if (trimmedEmail && trimmedEmail !== user.email) {
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(trimmedEmail)) {
        return res.status(400).json({
          success: false,
          error: 'Formato indirizzo email non valido.'
        });
      }

      const existingEmail = db.prepare('SELECT id FROM users WHERE email = ? COLLATE NOCASE AND id != ?').get(trimmedEmail, userId);
      if (existingEmail) {
        return res.status(409).json({
          success: false,
          error: 'L\'indirizzo email è già registrato per un altro utente.'
        });
      }

      updatedEmail = trimmedEmail;
      auditChanges.push(`email da "${user.email}" a "${trimmedEmail}"`);
    }
  }

  if (auditChanges.length === 0) {
    return res.status(400).json({
      success: false,
      error: 'Nessuna modifica rilevata nei dati inseriti.'
    });
  }

  // 7. Update database atomically
  try {
    db.transaction(() => {
      db.prepare(`
        UPDATE users
        SET username = ?, email = ?, password_hash = ?
        WHERE id = ?
      `).run(updatedUsername, updatedEmail, updatedPasswordHash, userId);

      // If password was changed, revoke all other active sessions for security
      if (updatedPasswordHash !== user.password_hash) {
        const currentTokenHash = req.token ? hashToken(req.token) : null;
        if (currentTokenHash) {
          db.prepare('DELETE FROM user_sessions WHERE user_id = ? AND token_hash != ?').run(userId, currentTokenHash);
        } else {
          db.prepare('DELETE FROM user_sessions WHERE user_id = ?').run(userId);
        }
      }
    })();
  } catch (err) {
    console.error('[Auth Error] Error updating user credentials:', err);
    return res.status(500).json({
      success: false,
      error: 'Errore interno durante il salvataggio delle credenziali.'
    });
  }

  // 8. Sign new JWT token with updated username
  const tokenPayload = {
    id: user.id,
    username: updatedUsername,
    role: user.role
  };
  const newToken = jwt.sign(tokenPayload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
  const newTokenHash = hashToken(newToken);
  const expiresAt = new Date(Date.now() + SESSION_MAX_AGE_MS).toISOString();
  const userAgent = req.get('user-agent') || 'unknown';

  try {
    const currentTokenHash = req.token ? hashToken(req.token) : null;
    if (currentTokenHash) {
      db.prepare('UPDATE user_sessions SET token_hash = ?, expires_at = ? WHERE token_hash = ?').run(newTokenHash, expiresAt, currentTokenHash);
    } else {
      const sessionId = crypto.randomUUID();
      db.prepare(`
        INSERT INTO user_sessions (id, user_id, token_hash, ip_address, user_agent, expires_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(sessionId, user.id, newTokenHash, clientIp, userAgent, expiresAt);
    }
  } catch (err) {
    console.warn('[Auth] Error updating session with new token:', err.message);
  }

  // 9. Re-issue cookie
  const isHttps = isRequestHttps(req);
  res.cookie('foliotrack_token', newToken, {
    httpOnly: true,
    secure: isHttps || process.env.COOKIE_SECURE === 'true',
    sameSite: 'lax',
    maxAge: SESSION_MAX_AGE_MS,
    path: '/'
  });

  // 10. Audit log
  recordAuditLog(userId, 'CHANGE_CREDENTIALS', `Credenziali modificate: ${auditChanges.join(', ')}`, clientIp);

  return res.json({
    success: true,
    message: 'Credenziali aggiornate con successo.',
    token: newToken,
    user: {
      id: user.id,
      username: updatedUsername,
      email: updatedEmail,
      role: user.role
    }
  });
}

/**
 * POST /api/auth/change-credentials
 * POST /api/auth/change-password
 * POST /api/auth/change-username
 * Secure endpoints for updating username, password, or email.
 */
router.post('/change-credentials', credentialChangeLimiter, requireAuth, handleChangeCredentials);
router.post('/change-password', credentialChangeLimiter, requireAuth, handleChangeCredentials);
router.post('/change-username', credentialChangeLimiter, requireAuth, handleChangeCredentials);

/**
 * GET /api/auth/security-status
 * Live diagnostic check for Internet exposure readiness and account security.
 */
router.get('/security-status', requireAuth, (req, res) => {
  const userId = req.user.id;
  const user = db.prepare('SELECT id, username, email, password_hash FROM users WHERE id = ?').get(userId);

  const isDefaultPassword = Boolean(user && bcrypt.compareSync('admin123', user.password_hash));
  const isDefaultJwtSecret = !process.env.JWT_SECRET || process.env.JWT_SECRET === 'foliotrack-super-secret-jwt-key-change-in-production-min32chars' || process.env.JWT_SECRET.length < 32;
  const isDefaultEncryptionKey = !process.env.SETTINGS_ENCRYPTION_KEY || process.env.SETTINGS_ENCRYPTION_KEY === 'foliotrack-encryption-secret-key-32chars' || process.env.SETTINGS_ENCRYPTION_KEY.length < 32;
  const isHttps = isRequestHttps(req);
  const isProduction = process.env.NODE_ENV === 'production';
  const trustProxy = Boolean(req.app.get('trust proxy'));

  // Active sessions count
  const sessionRow = db.prepare(`
    SELECT COUNT(*) as count FROM user_sessions
    WHERE user_id = ? AND expires_at > datetime('now')
  `).get(userId);
  const activeSessionsCount = sessionRow ? sessionRow.count : 1;

  // Failed logins last 24 hours
  const failedRow = db.prepare(`
    SELECT COUNT(*) as count FROM failed_logins
    WHERE attempted_at >= datetime('now', '-24 hours')
  `).get();
  const failedLogins24h = failedRow ? failedRow.count : 0;

  // Compute security score & recommendations
  const recommendations = [];
  let score = 100;

  if (isDefaultPassword) {
    score -= 40;
    recommendations.push({
      level: 'CRITICAL',
      title: 'Password predefinita attiva',
      message: 'L\'account sta ancora usando la password predefinita "admin123". Cambiala immediatamente prima di esporre l\'app su Internet.'
    });
  }

  if (isDefaultJwtSecret) {
    score -= 25;
    recommendations.push({
      level: 'HIGH',
      title: 'Chiave JWT predefinita o debole',
      message: 'Imposta una variabile JWT_SECRET casuale di almeno 32 caratteri in .env per impedire la contraffazione dei token.'
    });
  }

  if (isDefaultEncryptionKey) {
    score -= 20;
    recommendations.push({
      level: 'HIGH',
      title: 'Chiave crittografia impostazioni predefinita',
      message: 'Imposta una chiave SETTINGS_ENCRYPTION_KEY dedicata a 32 caratteri per proteggere i dati sensibili.'
    });
  }

  if (!isHttps) {
    score -= 15;
    recommendations.push({
      level: 'MEDIUM',
      title: 'Connessione HTTP non crittografata',
      message: 'Attiva HTTPS o usa un Reverse Proxy (NGINX, Caddy, Traefik, Cloudflare) per proteggere i dati in transito.'
    });
  }

  return res.json({
    success: true,
    status: {
      score: Math.max(0, score),
      isDefaultPassword,
      isDefaultJwtSecret,
      isDefaultEncryptionKey,
      isHttps,
      isProduction,
      trustProxy,
      activeSessionsCount,
      failedLogins24h,
      recommendations
    }
  });
});

/**
 * GET /api/auth/sessions
 * Returns all active sessions for the current authenticated user.
 */
router.get('/sessions', requireAuth, (req, res) => {
  const userId = req.user.id;
  const currentTokenHash = req.token ? hashToken(req.token) : null;

  const rows = db.prepare(`
    SELECT id, ip_address, user_agent, created_at, expires_at, token_hash
    FROM user_sessions
    WHERE user_id = ? AND expires_at > datetime('now')
    ORDER BY created_at DESC
  `).all(userId);

  const sessions = rows.map(s => ({
    id: s.id,
    ipAddress: s.ip_address || '127.0.0.1',
    userAgent: s.user_agent || 'Sconosciuto',
    createdAt: s.created_at,
    expiresAt: s.expires_at,
    isCurrent: Boolean(currentTokenHash && s.token_hash === currentTokenHash)
  }));

  return res.json({
    success: true,
    sessions
  });
});

/**
 * DELETE /api/auth/sessions
 * Revokes all active sessions for this user except the current active session.
 */
router.delete('/sessions', requireAuth, (req, res) => {
  const userId = req.user.id;
  const clientIp = req.ip || req.connection?.remoteAddress || '127.0.0.1';
  const currentTokenHash = req.token ? hashToken(req.token) : null;

  if (currentTokenHash) {
    db.prepare('DELETE FROM user_sessions WHERE user_id = ? AND token_hash != ?').run(userId, currentTokenHash);
  } else {
    db.prepare('DELETE FROM user_sessions WHERE user_id = ?').run(userId);
  }

  recordAuditLog(userId, 'REVOKE_SESSIONS', 'Revocate tutte le altre sessioni attive', clientIp);

  return res.json({
    success: true,
    message: 'Tutte le altre sessioni sono state revocate con successo.'
  });
});

/**
 * GET /api/auth/audit-logs
 * Retrieves the recent security audit log entries for the current user.
 */
router.get('/audit-logs', requireAuth, (req, res) => {
  const userId = req.user.id;
  const logs = db.prepare(`
    SELECT id, action, details, ip_address, created_at
    FROM audit_logs
    WHERE user_id = ?
    ORDER BY id DESC
    LIMIT 25
  `).all(userId);

  return res.json({
    success: true,
    logs
  });
});

module.exports = router;

