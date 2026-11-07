const helmet = require('helmet');
const cors = require('cors');
const { rateLimit } = require('express-rate-limit');

/**
 * Checks whether the incoming request is considered HTTPS.
 * @param {import('express').Request} req
 * @returns {boolean}
 */
function isRequestHttps(req) {
  return Boolean(
    req.secure ||
    req.headers['x-forwarded-proto'] === 'https' ||
    process.env.USE_HTTPS === 'true'
  );
}

/**
 * Helmet Content-Security-Policy & Security Headers Middleware.
 * Differentiates CSP behavior for HTTP vs HTTPS (disabling upgrade-insecure-requests on HTTP).
 */
function helmetSecurity() {
  return (req, res, next) => {
    const isHttps = isRequestHttps(req);

    const helmetHandler = helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: [
            "'self'",
            "'unsafe-inline'",
            "'unsafe-eval'",
            'cdn.jsdelivr.net',
            'cdnjs.cloudflare.com'
          ],
          scriptSrcAttr: ["'unsafe-inline'"],
          styleSrc: [
            "'self'",
            "'unsafe-inline'",
            'cdn.jsdelivr.net',
            'cdnjs.cloudflare.com',
            'fonts.googleapis.com'
          ],
          fontSrc: [
            "'self'",
            'fonts.gstatic.com',
            'cdn.jsdelivr.net',
            'cdnjs.cloudflare.com',
            'data:'
          ],
          imgSrc: ["'self'", 'data:', 'https:', 'blob:'],
          connectSrc: ["'self'", 'cdn.jsdelivr.net', 'cdnjs.cloudflare.com'],
          manifestSrc: ["'self'"],
          workerSrc: ["'self'"],
          objectSrc: ["'none'"],
          upgradeInsecureRequests: isHttps ? [] : null
        }
      },
      crossOriginEmbedderPolicy: false,
      hsts: isHttps ? {
        maxAge: 31536000,
        includeSubDomains: true,
        preload: true
      } : false,
      referrerPolicy: {
        policy: 'strict-origin-when-cross-origin'
      }
    });

    // Set additional hardened headers for Internet exposure
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');

    return helmetHandler(req, res, next);
  };
}

/**
 * General API Rate Limiter (Max 1000 requests per 15 minutes).
 */
const generalApiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 1000,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: 'Troppe richieste. Riprova tra 15 minuti.'
  }
});

/**
 * Strict Login Rate Limiter (Max 15 attempts per 15 minutes).
 */
const strictLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 15,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: 'Troppi tentativi di accesso. Riprova tra 15 minuti.'
  }
});

/**
 * Credential Change Rate Limiter (Max 10 attempts per 15 minutes).
 * Protects against brute-forcing existing passwords via credential change.
 */
const credentialChangeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: 'Troppi tentativi di modifica credenziali. Riprova tra 15 minuti.'
  }
});

/**
 * Cache-Control middleware for sensitive API responses.
 * Prevents intermediate proxies and shared browsers from storing private financial data.
 */
function apiNoCacheMiddleware(req, res, next) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  next();
}

/**
 * State-changing request origin verification (CSRF protection for exposed environments).
 */
function verifyOriginMiddleware(req, res, next) {
  const mutatingMethods = ['POST', 'PUT', 'DELETE', 'PATCH'];
  if (!mutatingMethods.includes(req.method)) {
    return next();
  }

  const origin = req.headers.origin;
  if (!origin) {
    // Same-origin or non-browser client without Origin header
    return next();
  }

  const allowedOriginsEnv = process.env.ALLOWED_ORIGINS;
  let allowedList = [];
  if (allowedOriginsEnv) {
    allowedList = allowedOriginsEnv
      .split(',')
      .map(o => o.trim())
      .filter(Boolean);
  }

  try {
    const originUrl = new URL(origin);
    const hostHeader = req.headers.host;

    // Check matching Host header
    if (hostHeader) {
      const hostOnly = hostHeader.split(':')[0];
      if (originUrl.host === hostHeader || originUrl.hostname === hostOnly) {
        return next();
      }
    }

    // Check localhost
    if (originUrl.hostname === 'localhost' || originUrl.hostname === '127.0.0.1') {
      return next();
    }

    // Check configured allowedList
    if (allowedList.includes(origin) || allowedList.includes('*')) {
      return next();
    }

    return res.status(403).json({
      success: false,
      error: 'Richiesta cross-origin non autorizzata (CSRF protection).'
    });
  } catch {
    return res.status(400).json({
      success: false,
      error: 'Formato header Origin non valido.'
    });
  }
}

/**
 * CORS Middleware configuration with credentials and allowed origins from ENV.
 */
function corsSecurity() {
  const allowedOriginsEnv = process.env.ALLOWED_ORIGINS;
  let allowedList = [];

  if (allowedOriginsEnv) {
    allowedList = allowedOriginsEnv
      .split(',')
      .map(origin => origin.trim())
      .filter(Boolean);
  }

  return cors({
    origin: (origin, callback) => {
      // Allow requests with no origin (e.g. mobile apps, curl, postman, same-host server-to-server)
      if (!origin) {
        return callback(null, true);
      }

      // Check configured allowed list
      if (allowedList.length > 0) {
        if (allowedList.includes(origin) || allowedList.includes('*')) {
          return callback(null, true);
        }
      }

      // Check localhost origins for development ease
      try {
        const url = new URL(origin);
        if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') {
          return callback(null, true);
        }
      } catch (err) {
        // Invalid origin format
      }

      // In non-production without configured allowedList, allow for ease of testing
      if (process.env.NODE_ENV !== 'production' && allowedList.length === 0) {
        return callback(null, true);
      }

      const corsErr = new Error(`CORS origin not allowed: ${origin}`);
      corsErr.status = 403;
      return callback(corsErr);
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With']
  });
}

module.exports = {
  helmetSecurity,
  generalApiLimiter,
  strictLoginLimiter,
  credentialChangeLimiter,
  apiNoCacheMiddleware,
  verifyOriginMiddleware,
  corsSecurity,
  isRequestHttps
};

