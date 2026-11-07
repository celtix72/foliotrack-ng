const app = require('./app');
const { initDb, closeDb } = require('./db');
const { isMobile, serveWithSidebar } = require('./utils/viewRenderer');
const { startScheduler, stopScheduler } = require('./services/schedulerService');

const PORT = parseInt(process.env.PORT, 10) || 3000;

// Initialize database schema and initial seed
try {
  initDb();
  console.log('[Database] SQLite connected and schema initialized in WAL mode.');
} catch (err) {
  console.error('[Database Fatal Error] Failed to initialize SQLite database:', err);
  process.exit(1);
}

function printSecurityAudit() {
  const isDefaultJwt = !process.env.JWT_SECRET || process.env.JWT_SECRET === 'foliotrack-super-secret-jwt-key-change-in-production-min32chars' || process.env.JWT_SECRET.length < 32;
  const isDefaultKey = !process.env.SETTINGS_ENCRYPTION_KEY || process.env.SETTINGS_ENCRYPTION_KEY === 'foliotrack-encryption-secret-key-32chars' || process.env.SETTINGS_ENCRYPTION_KEY.length < 32;

  console.log(`🛡️  Security Diagnostics (Internet Exposure Readiness):`);
  console.log(`   • Trust Proxy: ENABLED (Express trust proxy = 1)`);
  console.log(`   • Helmet CSP & Security Headers: ACTIVE (X-Robots-Tag, Permissions-Policy, HSTS)`);
  console.log(`   • API Cache-Control & Anti-CSRF: ENFORCED`);
  console.log(`   • Rate Limiting: ACTIVE (API 1000/15m, Login 15/15m, Credentials 10/15m)`);

  if (isDefaultJwt) {
    console.warn(`   ⚠️  JWT_SECRET: Default or weak key detected. Change it in .env before internet exposure!`);
  } else {
    console.log(`   ✓  JWT_SECRET: Configured with custom secret.`);
  }

  if (isDefaultKey) {
    console.warn(`   ⚠️  SETTINGS_ENCRYPTION_KEY: Default or weak key detected. Set a 32-char key in .env!`);
  } else {
    console.log(`   ✓  SETTINGS_ENCRYPTION_KEY: Configured with custom secret.`);
  }
}

const server = app.listen(PORT, () => {
  console.log(`=================================================`);
  console.log(`🚀 FolioTrack Backend Server running on port ${PORT}`);
  console.log(`🔗 Healthcheck: http://localhost:${PORT}/api/health`);
  console.log(`🔒 Environment: ${process.env.NODE_ENV || 'development'}`);
  printSecurityAudit();
  console.log(`=================================================`);

  // Start background recurring tasks (daily snapshot, digest, backup, alerts)
  startScheduler();
});

// Graceful shutdown handling for Docker / system signals
function handleShutdown(signal) {
  console.log(`\n[Server] Received ${signal}. Starting graceful shutdown...`);
  stopScheduler();
  server.close(() => {
    console.log('[Server] HTTP server closed.');
    try {
      closeDb();
      console.log('[Database] SQLite connection closed.');
    } catch (err) {
      console.error('[Database] Error closing SQLite connection:', err);
    }
    process.exit(0);
  });

  // Force close after 5 seconds if not closed
  setTimeout(() => {
    console.error('[Server] Forcefully shutting down after timeout.');
    process.exit(1);
  }, 5000);
}

process.on('SIGINT', () => handleShutdown('SIGINT'));
process.on('SIGTERM', () => handleShutdown('SIGTERM'));

module.exports = {
  app,
  server,
  isMobile,
  serveWithSidebar
};
