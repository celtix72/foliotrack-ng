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

const server = app.listen(PORT, () => {
  console.log(`=================================================`);
  console.log(`🚀 FolioTrack Backend Server running on port ${PORT}`);
  console.log(`🔗 Healthcheck: http://localhost:${PORT}/api/health`);
  console.log(`🔒 Environment: ${process.env.NODE_ENV || 'development'}`);
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
