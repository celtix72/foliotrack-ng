require('dotenv').config();
const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const { helmetSecurity, corsSecurity, generalApiLimiter, apiNoCacheMiddleware, verifyOriginMiddleware } = require('./middlewares/securityMiddleware');
const authRouter = require('./routes/auth');
const settingsRouter = require('./routes/settings');
const { router: portfoliosRouter } = require('./routes/portfolios');
const transactionsRouter = require('./routes/transactions');
const assetsRouter = require('./routes/assets');
const marketRouter = require('./routes/market');
const { router: dividendsRouter } = require('./routes/dividends');
const { router: historyRouter } = require('./routes/history');
const { router: taxesRouter } = require('./routes/taxes');
const goalsRouter = require('./routes/goals');
const aiAdvisorRouter = require('./routes/aiAdvisor');
const notificationsRouter = require('./routes/notifications');
const backupsRouter = require('./routes/backups');
const currenciesRouter = require('./routes/currencies');
const rebalancingRouter = require('./routes/rebalancing');
const newsRouter = require('./routes/news');
const analysisRouter = require('./routes/analysis');
const { db } = require('./db');
const { serveWithSidebar, isMobile } = require('./utils/viewRenderer');

const app = express();

// Harden Express against fingerprinting
app.disable('x-powered-by');

// Trust proxy for Docker / reverse proxies (NGINX, Caddy, Cloudflare, Traefik, UGOS)
app.set('trust proxy', 1);

// Security & Headers
app.use(helmetSecurity());
app.use(corsSecurity());

// Robots.txt to prevent indexing of personal finance portal
app.get('/robots.txt', (req, res) => {
  res.type('text/plain');
  res.send('User-agent: *\nDisallow: /\n');
});

// Body & Cookie parsing
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(cookieParser());

// Static Files (Styles, Scripts, Icons, public HTML)
app.use(express.static(path.join(__dirname, '..', 'public')));

// Web App Manifest explicit endpoints for PWA installation on Android
app.get(['/manifest.webmanifest', '/manifest.json'], (req, res) => {
  res.type('application/manifest+json');
  res.sendFile(path.join(__dirname, '..', 'public', 'manifest.webmanifest'));
});

// Anti-CSRF Origin verification on state-changing API requests
app.use('/api', verifyOriginMiddleware);

// Cache-Control: no-cache/no-store on API responses for data confidentiality
app.use('/api', apiNoCacheMiddleware);

// General Rate Limiter for all API routes
app.use('/api/', generalApiLimiter);

// Health check endpoint
app.get('/api/health', (req, res) => {
  try {
    const ping = db.prepare('SELECT 1 as alive').get();
    res.json({
      status: ping && ping.alive === 1 ? 'ok' : 'degraded',
      uptime: process.uptime(),
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    res.status(500).json({
      status: 'error',
      message: err.message
    });
  }
});

// Mount API Routes
app.use('/api/auth', authRouter);
app.use('/api/settings', settingsRouter);
app.use('/api/portfolios', portfoliosRouter);
app.use('/api/transactions', transactionsRouter);
app.use('/api/assets', assetsRouter);
app.use('/api/market', marketRouter);
app.use('/api/dividends', dividendsRouter);
app.use('/api/history', historyRouter);
app.use('/api/taxes', taxesRouter);
app.use('/api/goals', goalsRouter);
app.use('/api/ai', aiAdvisorRouter);
app.use('/api/notifications', notificationsRouter);
app.use('/api/push', notificationsRouter);
app.use('/api/backups', backupsRouter);
app.use('/api/currencies', currenciesRouter);
app.use('/api/rebalancing', rebalancingRouter);
app.use('/api/analysis', analysisRouter);
app.use('/api/news', newsRouter);

// 404 handler for unmatched API routes
app.use('/api', (req, res) => {
  res.status(404).json({
    success: false,
    error: `Endpoint API '${req.originalUrl}' non trovato.`
  });
});

/**
 * Middleware for server-side private HTML views:
 * Redirects to /login.html if unauthenticated.
 */
function requireViewAuth(req, res, next) {
  const token = req.cookies?.foliotrack_token || req.cookies?.token;

  if (!token) {
    if (req.query?.source === 'pwa') {
      return res.status(200).sendFile(path.join(__dirname, '../public/login.html'));
    }
    return res.redirect(`/login.html?redirect=${encodeURIComponent(req.originalUrl)}`);
  }

  try {
    const JWT_SECRET = process.env.JWT_SECRET || 'foliotrack-super-secret-jwt-key-change-in-production-min32chars';
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    return next();
  } catch (err) {
    res.clearCookie('foliotrack_token', { path: '/' });
    res.clearCookie('token', { path: '/' });
    if (req.query?.source === 'pwa') {
      return res.status(200).sendFile(path.join(__dirname, '../public/login.html'));
    }
    return res.redirect(`/login.html?redirect=${encodeURIComponent(req.originalUrl)}`);
  }
}

// Protected Dual-View Routes (Serving desktop or mobile with injected sidebar)
app.get(['/', '/dashboard'], requireViewAuth, (req, res) => {
  serveWithSidebar(req, res, 'dashboard');
});

app.get('/portfolios', requireViewAuth, (req, res) => {
  serveWithSidebar(req, res, 'portfolios');
});

app.get(['/portfolios/:id', '/portfolio/:id'], requireViewAuth, (req, res) => {
  serveWithSidebar(req, res, 'portfolio_detail');
});

app.get('/transactions', requireViewAuth, (req, res) => {
  serveWithSidebar(req, res, 'transactions');
});

app.get(['/analysis', '/analisi'], requireViewAuth, (req, res) => {
  serveWithSidebar(req, res, 'analysis');
});

app.get(['/history', '/dividends'], requireViewAuth, (req, res) => {
  serveWithSidebar(req, res, 'history');
});

app.get(['/tools', '/strumenti'], requireViewAuth, (req, res) => {
  serveWithSidebar(req, res, 'tools');
});

app.get(['/reports', '/goals', '/ai-advisor'], requireViewAuth, (req, res) => {
  serveWithSidebar(req, res, 'reports');
});

app.get(['/rebalance', '/rebalancing'], requireViewAuth, (req, res) => {
  serveWithSidebar(req, res, 'rebalance');
});

app.get('/settings', requireViewAuth, (req, res) => {
  serveWithSidebar(req, res, 'settings');
});

// Global Error Handler
app.use((err, req, res, next) => {
  console.error('[App Error]', err.message || err);
  const statusCode = err.status || 500;
  res.status(statusCode).json({
    success: false,
    error: (process.env.NODE_ENV === 'production' && statusCode >= 500) ? 'Errore interno del server' : err.message
  });
});

// Attach helpers to app for server.js compatibility
app.isMobile = isMobile;
app.serveWithSidebar = serveWithSidebar;

module.exports = app;
