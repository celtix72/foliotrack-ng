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
      crossOriginEmbedderPolicy: false
    });

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

      if (allowedList.length === 0 || allowedList.includes('*') || allowedList.includes(origin)) {
        return callback(null, true);
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

      return callback(new Error(`CORS origin not allowed: ${origin}`));
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
  corsSecurity,
  isRequestHttps
};

