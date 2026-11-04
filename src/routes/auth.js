const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { db } = require('../db');
const { hashToken } = require('../crypto');
const { requireAuth, JWT_SECRET } = require('../middlewares/authMiddleware');
const { strictLoginLimiter, isRequestHttps } = require('../middlewares/securityMiddleware');

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

module.exports = router;

