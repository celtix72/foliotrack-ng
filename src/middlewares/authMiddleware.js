const jwt = require('jsonwebtoken');
const { db } = require('../db');

const JWT_SECRET = process.env.JWT_SECRET || 'foliotrack-super-secret-jwt-key-change-in-production-min32chars';

/**
 * Extracts the JWT token from either httpOnly cookies or Authorization Bearer header.
 * @param {import('express').Request} req
 * @returns {string|null}
 */
function extractToken(req) {
  // Check cookies first
  if (req.cookies) {
    if (req.cookies.foliotrack_token) {
      return req.cookies.foliotrack_token;
    }
    if (req.cookies.token) {
      return req.cookies.token;
    }
  }

  // Check Authorization Bearer header
  const authHeader = req.headers.authorization || req.headers.Authorization;
  if (authHeader && typeof authHeader === 'string') {
    const parts = authHeader.split(' ');
    if (parts.length === 2 && /^Bearer$/i.test(parts[0])) {
      return parts[1];
    }
  }

  return null;
}

/**
 * Middleware that requires valid JWT authentication.
 * Populates req.user and req.token.
 */
function requireAuth(req, res, next) {
  const token = extractToken(req);

  if (!token) {
    return res.status(401).json({
      success: false,
      error: 'Autenticazione richiesta. Effettua il login.'
    });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);

    // Verify user still exists in database and is active
    const user = db.prepare('SELECT id, username, email, role, createdAt FROM users WHERE id = ?').get(decoded.id);

    if (!user) {
      return res.status(401).json({
        success: false,
        error: 'Utente non trovato o account non valido.'
      });
    }

    req.user = user;
    req.token = token;
    return next();
  } catch (err) {
    // If token is invalid or expired, clear cookie if present
    if (req.cookies && (req.cookies.foliotrack_token || req.cookies.token)) {
      res.clearCookie('foliotrack_token', { path: '/' });
      res.clearCookie('token', { path: '/' });
    }

    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({
        success: false,
        error: 'Sessione scaduta. Effettua nuovamente il login.'
      });
    }

    return res.status(401).json({
      success: false,
      error: 'Token di autenticazione non valido.'
    });
  }
}

/**
 * Optional authentication middleware: attaches req.user if a valid token is provided,
 * but does not reject the request if unauthenticated.
 */
function optionalAuth(req, res, next) {
  const token = extractToken(req);
  if (!token) {
    req.user = null;
    return next();
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const user = db.prepare('SELECT id, username, email, role, createdAt FROM users WHERE id = ?').get(decoded.id);
    req.user = user || null;
    req.token = token;
  } catch {
    req.user = null;
  }
  return next();
}

/**
 * Role-based access control middleware.
 * Must be preceded by requireAuth.
 * @param  {...string} roles - e.g. 'admin', 'user', 'viewer'
 */
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        error: 'Autenticazione richiesta.'
      });
    }

    if (!roles.includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        error: 'Accesso negato: autorizzazioni insufficienti.'
      });
    }

    return next();
  };
}

module.exports = {
  extractToken,
  requireAuth,
  optionalAuth,
  requireRole,
  JWT_SECRET
};

