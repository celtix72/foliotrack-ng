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
      crossOriginOpenerPolicy: isHttps ? { policy: 'same-origin' } : false,
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
 * Determines whether an incoming Origin is same-origin, a trusted local/LAN network,
 * or explicitly allowed via ALLOWED_ORIGINS.
 *
 * @param {string|undefined} origin
 * @param {import('express').Request} req
 * @returns {boolean}
 */
function isSameOriginOrAllowed(origin, req) {
  // Requests without an Origin header (e.g. mobile apps, curl, postman, same-host navigation) are allowed
  if (!origin) {
    return true;
  }

  try {
    const originUrl = new URL(origin);
    const originHost = originUrl.host.toLowerCase();
    const originHostname = originUrl.hostname.toLowerCase();

    // 1. Same-Host matching: compares with server's own Host and X-Forwarded-Host
    const hostHeader = (req?.headers ? (req.headers['x-forwarded-host'] || req.headers.host || '') : '').toLowerCase();
    if (hostHeader) {
      const hostOnly = hostHeader.split(':')[0];
      if (originHost === hostHeader || originHostname === hostOnly || originHostname === hostHeader) {
        return true;
      }
    }

    // 2. Localhost & Loopback (IPv4 & IPv6)
    if (originHostname === 'localhost' || originHostname === '127.0.0.1' || originHostname === '::1') {
      return true;
    }

    // 3. Private / Local LAN Networks (RFC 1918 & mDNS .local)
    // 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, *.local
    if (
      originHostname.endsWith('.local') ||
      /^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(originHostname) ||
      /^192\.168\.\d{1,3}\.\d{1,3}$/.test(originHostname) ||
      /^172\.(1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3}$/.test(originHostname)
    ) {
      return true;
    }

    // 4. Configured ALLOWED_ORIGINS environment variable
    const allowedOriginsEnv = process.env.ALLOWED_ORIGINS;
    if (allowedOriginsEnv) {
      const allowedList = allowedOriginsEnv
        .split(',')
        .map(o => o.trim().toLowerCase())
        .filter(Boolean);

      if (allowedList.includes('*') || allowedList.includes(origin.toLowerCase())) {
        return true;
      }

      for (const allowed of allowedList) {
        try {
          const allowedUrl = new URL(allowed);
          if (allowedUrl.host === originHost || allowedUrl.hostname === originHostname) {
            return true;
          }
        } catch {
          // not a full URL
        }
      }
    }

    // 5. In non-production without configured ALLOWED_ORIGINS, allow for development ease
    if (process.env.NODE_ENV !== 'production' && !allowedOriginsEnv) {
      return true;
    }

    return false;
  } catch {
    return false;
  }
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
    return next();
  }

  if (isSameOriginOrAllowed(origin, req)) {
    return next();
  }

  return res.status(403).json({
    success: false,
    error: 'Richiesta cross-origin non autorizzata (CSRF protection).'
  });
}

/**
 * CORS Middleware configuration with credentials, dynamic same-origin support,
 * and allowed origins from ENV.
 */
function corsSecurity() {
  return cors((req, callback) => {
    const origin = req.headers.origin;

    if (isSameOriginOrAllowed(origin, req)) {
      return callback(null, {
        origin: true,
        credentials: true,
        methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
        allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With']
      });
    }

    const corsErr = new Error(`CORS origin not allowed: ${origin}`);
    corsErr.status = 403;
    return callback(corsErr);
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

