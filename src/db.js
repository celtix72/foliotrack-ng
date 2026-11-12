const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const { encrypt, decrypt } = require('./crypto');

let dbInstance = null;
let currentDbPath = null;

/**
 * Returns the current active database instance, initializing it if necessary.
 * @returns {Database.Database}
 */
function getDb() {
  if (!dbInstance || !dbInstance.open) {
    initDb(currentDbPath);
  }
  return dbInstance;
}

/**
 * Initializes and returns the SQLite database connection.
 * @param {string} [customPath] - Optional override for DB path (useful for testing)
 * @returns {Database.Database}
 */
function initDb(customPath = null) {
  if (dbInstance && dbInstance.open) {
    if (customPath && customPath !== currentDbPath) {
      closeDb();
    } else {
      return dbInstance;
    }
  }

  const dbPath = customPath || process.env.DB_PATH || path.join(__dirname, '..', 'data', 'foliotrack.db');
  currentDbPath = dbPath;

  // Ensure the directory exists if not an in-memory database
  if (dbPath !== ':memory:') {
    const dbDir = path.dirname(path.resolve(dbPath));
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }
  }

  dbInstance = new Database(dbPath);

  // Enable WAL mode for high concurrency and Foreign Keys enforcement
  dbInstance.pragma('journal_mode = WAL');
  dbInstance.pragma('foreign_keys = ON');

  // Create tables schema
  createSchema(dbInstance);

  // Seed initial admin user if table is empty
  seedInitialAdmin(dbInstance);

  return dbInstance;
}

/**
 * Creates the complete DDL schema for Phase 1.
 * @param {Database.Database} database
 */
function createSchema(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      email TEXT UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user' CHECK(role IN ('admin', 'user', 'viewer')),
      createdAt TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS settings (
      user_id INTEGER NOT NULL,
      key TEXT NOT NULL,
      value TEXT,
      PRIMARY KEY (user_id, key),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS user_sessions (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      token_hash TEXT,
      ip_address TEXT,
      user_agent TEXT,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      action TEXT NOT NULL,
      details TEXT,
      ip_address TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS failed_logins (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ip_address TEXT NOT NULL,
      username TEXT,
      attempted_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS push_subscriptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      endpoint TEXT NOT NULL UNIQUE,
      p256dh TEXT NOT NULL,
      auth TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS portfolios (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'Investimento' CHECK(type IN ('Investimento', 'Pensione', 'Trading', 'Liquidità')),
      currency TEXT NOT NULL DEFAULT 'EUR',
      costBasisMethod TEXT NOT NULL DEFAULT 'WAC' CHECK(costBasisMethod IN ('WAC', 'FIFO')),
      startDate TEXT,
      initialCash REAL NOT NULL DEFAULT 0.0,
      currentCash REAL NOT NULL DEFAULT 0.0,
      totalValue REAL NOT NULL DEFAULT 0.0,
      netValue REAL NOT NULL DEFAULT 0.0,
      estimatedTax REAL NOT NULL DEFAULT 0.0,
      performance1D REAL NOT NULL DEFAULT 0.0,
      performance1DPrePost REAL NOT NULL DEFAULT 0.0,
      totalDividends REAL NOT NULL DEFAULT 0.0,
      investedCapital REAL NOT NULL DEFAULT 0.0,
      assetCount INTEGER NOT NULL DEFAULT 0,
      color TEXT DEFAULT '#4f6b92',
      include_in_totals INTEGER NOT NULL DEFAULT 1,
      createdAt TEXT NOT NULL DEFAULT (datetime('now')),
      updatedAt TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS portfolio_users (
      portfolio_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      role TEXT NOT NULL DEFAULT 'owner' CHECK(role IN ('owner', 'viewer')),
      PRIMARY KEY (portfolio_id, user_id),
      FOREIGN KEY (portfolio_id) REFERENCES portfolios(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS assets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticker TEXT NOT NULL UNIQUE COLLATE NOCASE,
      name TEXT NOT NULL,
      type TEXT DEFAULT 'EQUITY',
      exchange TEXT,
      currency TEXT NOT NULL DEFAULT 'EUR',
      currentPrice REAL NOT NULL DEFAULT 0.0,
      changePercent REAL DEFAULT 0.0,
      changeValue REAL DEFAULT 0.0,
      pe REAL,
      forwardPE REAL,
      eps REAL,
      beta REAL,
      dividendYield REAL DEFAULT 0.0,
      country TEXT,
      region TEXT,
      sector TEXT,
      riskCategory TEXT DEFAULT 'MEDIUM' CHECK(riskCategory IN ('LOW', 'MEDIUM', 'HIGH')),
      targetPrice REAL,
      stopLoss REAL,
      openPrice REAL DEFAULT 0.0,
      highPrice REAL DEFAULT 0.0,
      lowPrice REAL DEFAULT 0.0,
      previousClose REAL DEFAULT 0.0,
      dataSource TEXT DEFAULT 'YAHOO' CHECK(dataSource IN ('YAHOO', 'BORSA_ITALIANA', 'GOOGLE', 'MANUAL', 'DELISTED')),
      quoteDate TEXT,
      marketState TEXT,
      regularMarketTime TEXT,
      preMarketPrice REAL DEFAULT NULL,
      preMarketChange REAL DEFAULT NULL,
      preMarketChangePercent REAL DEFAULT NULL,
      preMarketTime TEXT DEFAULT NULL,
      postMarketPrice REAL DEFAULT NULL,
      postMarketChange REAL DEFAULT NULL,
      postMarketChangePercent REAL DEFAULT NULL,
      postMarketTime TEXT DEFAULT NULL,
      lastSyncStatus TEXT DEFAULT 'OK',
      lastSyncError TEXT,
      lastSyncAt TEXT,
      historicalSyncStatus TEXT,
      historicalSyncError TEXT,
      historicalSyncAt TEXT,
      updatedAt TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      portfolioId INTEGER NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('BUY', 'SELL', 'DIVIDEND', 'INTEREST', 'DEPOSIT', 'WITHDRAWAL', 'TRANSFER', 'SPLIT', 'FEE', 'TAX')),
      assetTicker TEXT,
      date TEXT NOT NULL,
      quantity REAL NOT NULL DEFAULT 0.0,
      price REAL NOT NULL DEFAULT 0.0,
      commission REAL NOT NULL DEFAULT 0.0,
      tax REAL NOT NULL DEFAULT 0.0,
      exchangeRate REAL NOT NULL DEFAULT 1.0,
      amount REAL NOT NULL DEFAULT 0.0,
      notes TEXT,
      linkedTransactionId INTEGER,
      createdAt TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (portfolioId) REFERENCES portfolios(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS asset_quotes (
      ticker TEXT NOT NULL COLLATE NOCASE,
      date TEXT NOT NULL,
      close REAL NOT NULL,
      volume REAL,
      source TEXT NOT NULL,
      updatedAt TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (ticker, date)
    );

    CREATE TABLE IF NOT EXISTS dividend_projections (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      portfolioId INTEGER NOT NULL,
      assetTicker TEXT NOT NULL COLLATE NOCASE,
      projectedAnnualIncome REAL NOT NULL DEFAULT 0.0,
      projectedMonthlyIncome REAL NOT NULL DEFAULT 0.0,
      dividendYield REAL DEFAULT 0.0,
      sharesHeld REAL NOT NULL DEFAULT 0.0,
      currentPrice REAL NOT NULL DEFAULT 0.0,
      currency TEXT NOT NULL DEFAULT 'EUR',
      source TEXT DEFAULT 'AUTO',
      providerYield REAL DEFAULT 0.0,
      portfolioYield REAL DEFAULT 0.0,
      manualYield REAL DEFAULT NULL,
      isConfirmed INTEGER DEFAULT 0,
      notes TEXT DEFAULT NULL,
      calculatedAt TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(portfolioId, assetTicker),
      FOREIGN KEY (portfolioId) REFERENCES portfolios(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS portfolio_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      portfolioId INTEGER NOT NULL,
      date TEXT NOT NULL,
      totalValue REAL NOT NULL,
      cashValue REAL NOT NULL,
      assetValue REAL NOT NULL,
      netDeposits REAL NOT NULL,
      user_id INTEGER,
      createdAt TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(portfolioId, date),
      FOREIGN KEY (portfolioId) REFERENCES portfolios(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS portfolio_losses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      portfolioId INTEGER NOT NULL,
      year INTEGER NOT NULL,
      amount REAL NOT NULL,
      residualAmount REAL NOT NULL,
      expiryDate TEXT NOT NULL,
      notes TEXT,
      assetType TEXT NOT NULL DEFAULT 'EQUITY',
      taxRate REAL NOT NULL DEFAULT 0.26,
      createdAt TEXT NOT NULL DEFAULT (datetime('now')),
      updatedAt TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (portfolioId) REFERENCES portfolios(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS currency_rates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pair TEXT NOT NULL UNIQUE,
      fromCurrency TEXT NOT NULL,
      toCurrency TEXT NOT NULL,
      rate REAL NOT NULL,
      source TEXT DEFAULT 'YAHOO',
      updatedAt TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS rebalance_targets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      portfolio_id INTEGER,
      name TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'ASSET_CLASS' CHECK(type IN ('ASSET_CLASS', 'HOLDING')),
      toleranceBand REAL NOT NULL DEFAULT 2.0,
      rebalanceMode TEXT NOT NULL DEFAULT 'CASH_FIRST' CHECK(rebalanceMode IN ('CASH_FIRST', 'FULL_REBALANCE')),
      allowFractional INTEGER NOT NULL DEFAULT 0,
      minTradeSize REAL NOT NULL DEFAULT 25.0,
      cashBuffer REAL NOT NULL DEFAULT 0.0,
      allocations TEXT NOT NULL,
      createdAt TEXT NOT NULL DEFAULT (datetime('now')),
      updatedAt TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (portfolio_id) REFERENCES portfolios(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS portfolio_news (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticker TEXT NOT NULL COLLATE NOCASE,
      title TEXT NOT NULL,
      link TEXT NOT NULL UNIQUE,
      publisher TEXT,
      pubDate TEXT NOT NULL,
      summary TEXT,
      source TEXT DEFAULT 'GOOGLE_NEWS',
      createdAt TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS analysis_watchlist (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticker TEXT NOT NULL UNIQUE COLLATE NOCASE,
      name TEXT,
      stopLoss REAL DEFAULT NULL,
      takeProfit REAL DEFAULT NULL,
      notes TEXT DEFAULT NULL,
      isMonitored INTEGER DEFAULT 1,
      createdAt TEXT NOT NULL DEFAULT (datetime('now')),
      updatedAt TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS analysis_fundamentals_cache (
      ticker TEXT PRIMARY KEY COLLATE NOCASE,
      data TEXT NOT NULL,
      updatedAt TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_analysis_watchlist_ticker ON analysis_watchlist(ticker);
    CREATE INDEX IF NOT EXISTS idx_portfolio_news_ticker ON portfolio_news(ticker);
    CREATE INDEX IF NOT EXISTS idx_portfolio_news_pubDate ON portfolio_news(pubDate DESC);

    CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
    CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
    CREATE INDEX IF NOT EXISTS idx_user_sessions_user_id ON user_sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_user_sessions_expires_at ON user_sessions(expires_at);
    CREATE INDEX IF NOT EXISTS idx_audit_logs_user_id ON audit_logs(user_id);
    CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs(created_at);
    CREATE INDEX IF NOT EXISTS idx_failed_logins_ip_time ON failed_logins(ip_address, attempted_at);
    CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user_id ON push_subscriptions(user_id);
    CREATE INDEX IF NOT EXISTS idx_portfolios_name ON portfolios(name);
    CREATE INDEX IF NOT EXISTS idx_portfolio_users_user ON portfolio_users(user_id);
    CREATE INDEX IF NOT EXISTS idx_portfolio_users_portfolio ON portfolio_users(portfolio_id);
    CREATE INDEX IF NOT EXISTS idx_assets_ticker ON assets(ticker);
    CREATE INDEX IF NOT EXISTS idx_currency_rates_pair ON currency_rates(pair);
    CREATE INDEX IF NOT EXISTS idx_transactions_portfolio ON transactions(portfolioId);
    CREATE INDEX IF NOT EXISTS idx_transactions_ticker ON transactions(assetTicker);
    CREATE INDEX IF NOT EXISTS idx_transactions_date ON transactions(date);
    CREATE INDEX IF NOT EXISTS idx_asset_quotes_ticker ON asset_quotes(ticker);
    CREATE INDEX IF NOT EXISTS idx_asset_quotes_date ON asset_quotes(date);
    CREATE INDEX IF NOT EXISTS idx_dividend_projections_port ON dividend_projections(portfolioId);
    CREATE INDEX IF NOT EXISTS idx_portfolio_history_port_date ON portfolio_history(portfolioId, date);
    CREATE INDEX IF NOT EXISTS idx_portfolio_losses_port_exp ON portfolio_losses(portfolioId, expiryDate);
    CREATE INDEX IF NOT EXISTS idx_rebalance_targets_user ON rebalance_targets(user_id);
    CREATE INDEX IF NOT EXISTS idx_rebalance_targets_port ON rebalance_targets(portfolio_id);
  `);

  // Safe migration checks for existing databases
  try {
    database.exec("ALTER TABLE assets ADD COLUMN dataSource TEXT DEFAULT 'YAHOO'");
  } catch {}
  try { database.exec("ALTER TABLE assets ADD COLUMN lastSyncStatus TEXT DEFAULT 'OK'"); } catch {}
  try { database.exec("ALTER TABLE assets ADD COLUMN lastSyncError TEXT DEFAULT NULL"); } catch {}
  try { database.exec("ALTER TABLE assets ADD COLUMN lastSyncAt TEXT DEFAULT NULL"); } catch {}
  try { database.exec("ALTER TABLE assets ADD COLUMN historicalSyncStatus TEXT DEFAULT NULL"); } catch {}
  try { database.exec("ALTER TABLE assets ADD COLUMN historicalSyncError TEXT DEFAULT NULL"); } catch {}
  try { database.exec("ALTER TABLE assets ADD COLUMN historicalSyncAt TEXT DEFAULT NULL"); } catch {}
  try { database.exec("ALTER TABLE assets ADD COLUMN openPrice REAL DEFAULT 0.0"); } catch {}
  try { database.exec("ALTER TABLE assets ADD COLUMN highPrice REAL DEFAULT 0.0"); } catch {}
  try { database.exec("ALTER TABLE assets ADD COLUMN lowPrice REAL DEFAULT 0.0"); } catch {}
  try { database.exec("ALTER TABLE assets ADD COLUMN previousClose REAL DEFAULT 0.0"); } catch {}
  try { database.exec("ALTER TABLE assets ADD COLUMN marketState TEXT DEFAULT NULL"); } catch {}
  try { database.exec("ALTER TABLE assets ADD COLUMN regularMarketTime TEXT DEFAULT NULL"); } catch {}
  try { database.exec("ALTER TABLE assets ADD COLUMN preMarketPrice REAL DEFAULT NULL"); } catch {}
  try { database.exec("ALTER TABLE assets ADD COLUMN preMarketChange REAL DEFAULT NULL"); } catch {}
  try { database.exec("ALTER TABLE assets ADD COLUMN preMarketChangePercent REAL DEFAULT NULL"); } catch {}
  try { database.exec("ALTER TABLE assets ADD COLUMN preMarketTime TEXT DEFAULT NULL"); } catch {}
  try { database.exec("ALTER TABLE assets ADD COLUMN postMarketPrice REAL DEFAULT NULL"); } catch {}
  try { database.exec("ALTER TABLE assets ADD COLUMN postMarketChange REAL DEFAULT NULL"); } catch {}
  try { database.exec("ALTER TABLE assets ADD COLUMN postMarketChangePercent REAL DEFAULT NULL"); } catch {}
  try { database.exec("ALTER TABLE assets ADD COLUMN postMarketTime TEXT DEFAULT NULL"); } catch {}
  try { database.exec("ALTER TABLE assets ADD COLUMN taxRate REAL DEFAULT NULL"); } catch {}
  try { database.exec("ALTER TABLE assets ADD COLUMN taxCategory TEXT DEFAULT NULL"); } catch {}
  try { database.exec("ALTER TABLE portfolio_losses ADD COLUMN assetType TEXT DEFAULT 'EQUITY'"); } catch {}
  try { database.exec("ALTER TABLE portfolio_losses ADD COLUMN taxRate REAL DEFAULT 0.26"); } catch {}
  try { database.exec("CREATE INDEX IF NOT EXISTS idx_portfolio_losses_port_type_exp ON portfolio_losses(portfolioId, assetType, expiryDate)"); } catch {}
  try { database.exec("ALTER TABLE portfolios ADD COLUMN netValue REAL DEFAULT 0.0"); } catch {}
  try { database.exec("ALTER TABLE portfolios ADD COLUMN estimatedTax REAL DEFAULT 0.0"); } catch {}
  try { database.exec("ALTER TABLE dividend_projections ADD COLUMN source TEXT DEFAULT 'AUTO'"); } catch {}
  try { database.exec("ALTER TABLE dividend_projections ADD COLUMN providerYield REAL DEFAULT 0.0"); } catch {}
  try { database.exec("ALTER TABLE dividend_projections ADD COLUMN portfolioYield REAL DEFAULT 0.0"); } catch {}
  try { database.exec("ALTER TABLE dividend_projections ADD COLUMN manualYield REAL DEFAULT NULL"); } catch {}
  try { database.exec("ALTER TABLE dividend_projections ADD COLUMN isConfirmed INTEGER DEFAULT 0"); } catch {}
  try { database.exec("ALTER TABLE dividend_projections ADD COLUMN notes TEXT DEFAULT NULL"); } catch {}

  try {
    database.exec(`
      CREATE TABLE IF NOT EXISTS analysis_watchlist (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ticker TEXT NOT NULL UNIQUE COLLATE NOCASE,
        name TEXT,
        stopLoss REAL DEFAULT NULL,
        takeProfit REAL DEFAULT NULL,
        notes TEXT DEFAULT NULL,
        isMonitored INTEGER DEFAULT 1,
        createdAt TEXT NOT NULL DEFAULT (datetime('now')),
        updatedAt TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS analysis_fundamentals_cache (
        ticker TEXT PRIMARY KEY COLLATE NOCASE,
        data TEXT NOT NULL,
        updatedAt TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_analysis_watchlist_ticker ON analysis_watchlist(ticker);
    `);
  } catch {}

  seedCurrencies(database);
}

/**
 * Seeds default admin user if users table is empty.
 * Never defaults to insecure "admin123" in production.
 * @param {Database.Database} database
 */
function seedInitialAdmin(database) {
  const row = database.prepare('SELECT COUNT(*) as count FROM users').get();
  if (row.count === 0) {
    const isTestEnv = process.env.NODE_ENV === 'test';
    const adminUsername = process.env.ADMIN_USERNAME || (isTestEnv ? 'admin' : 'foliotrack_admin');
    const adminEmail = process.env.ADMIN_EMAIL || 'admin@foliotrack.local';
    
    // In production or default mode, NEVER use "admin123"
    let adminPassword = process.env.ADMIN_PASSWORD;
    if (!adminPassword || (!isTestEnv && adminPassword === 'admin123')) {
      if (isTestEnv) {
        adminPassword = 'admin123';
      } else {
        const crypto = require('crypto');
        adminPassword = crypto.randomBytes(16).toString('hex');
        console.warn(`[Security Alert] Generated one-time strong admin password: "${adminPassword}". Change it immediately!`);
      }
    }

    const salt = bcrypt.genSaltSync(12);
    const passwordHash = bcrypt.hashSync(adminPassword, salt);

    const insertUser = database.prepare(`
      INSERT INTO users (username, email, password_hash, role)
      VALUES (?, ?, ?, 'admin')
    `);
    const info = insertUser.run(adminUsername, adminEmail, passwordHash);

    // Audit log
    const logSeed = database.prepare(`
      INSERT INTO audit_logs (user_id, action, details, ip_address)
      VALUES (?, 'SYSTEM_SEED', 'Created initial secure admin account', '127.0.0.1')
    `);
    logSeed.run(info.lastInsertRowid);

    console.log(`[Database Seed] Admin created: username="${adminUsername}", email="${adminEmail}".`);
  }
}

/**
 * Seeds default currency exchange rates if currency_rates table is empty.
 * @param {Database.Database} database
 */
function seedCurrencies(database) {
  const row = database.prepare('SELECT COUNT(*) as count FROM currency_rates').get();
  if (row.count === 0) {
    const defaultRates = [
      { pair: 'EUR/USD', from: 'EUR', to: 'USD', rate: 1.1194 },
      { pair: 'EUR/GBP', from: 'EUR', to: 'GBP', rate: 0.8344 },
      { pair: 'EUR/CHF', from: 'EUR', to: 'CHF', rate: 0.9188 },
      { pair: 'EUR/JPY', from: 'EUR', to: 'JPY', rate: 177.64 },
      { pair: 'USD/EUR', from: 'USD', to: 'EUR', rate: 0.8933 },
      { pair: 'GBP/EUR', from: 'GBP', to: 'EUR', rate: 1.1980 },
      { pair: 'CHF/EUR', from: 'CHF', to: 'EUR', rate: 1.0878 },
      { pair: 'JPY/EUR', from: 'JPY', to: 'EUR', rate: 0.00563 },
      { pair: 'USD/CHF', from: 'USD', to: 'CHF', rate: 0.8210 },
      { pair: 'GBP/USD', from: 'GBP', to: 'USD', rate: 1.3413 }
    ];

    const insert = database.prepare(`
      INSERT OR IGNORE INTO currency_rates (pair, fromCurrency, toCurrency, rate, source)
      VALUES (?, ?, ?, ?, 'DEFAULT')
    `);

    database.transaction(() => {
      for (const r of defaultRates) {
        insert.run(r.pair, r.from, r.to, r.rate);
      }
    })();
  }
}

/**
 * Retrieves a setting for a user.
 * Automatically decrypts if the value is encrypted.
 *
 * @param {number} userId
 * @param {string} key
 * @param {boolean} [shouldDecrypt=true]
 * @returns {string|null}
 */
function getSetting(userId, key, shouldDecrypt = true) {
  const activeDb = getDb();
  const statement = activeDb.prepare('SELECT value FROM settings WHERE user_id = ? AND key = ?');
  const row = statement.get(userId, key);
  if (!row || row.value === null) {
    return null;
  }
  if (!shouldDecrypt) {
    return row.value;
  }
  try {
    return decrypt(row.value);
  } catch (err) {
    console.warn(`[DB getSetting] Impossibile decifrare "${key}" per l'utente ${userId} (chiave modificata o dato non valido): ${err.message}`);
    return null;
  }
}

/**
 * Sets a setting for a user.
 * Optionally encrypts the value with AES-256-GCM.
 *
 * @param {number} userId
 * @param {string} key
 * @param {string|object} value
 * @param {boolean} [shouldEncrypt=false]
 */
function setSetting(userId, key, value, shouldEncrypt = false) {
  const activeDb = getDb();
  const valueToStore = shouldEncrypt ? encrypt(value) : (typeof value === 'object' ? JSON.stringify(value) : String(value));
  const statement = activeDb.prepare(`
    INSERT INTO settings (user_id, key, value)
    VALUES (?, ?, ?)
    ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value
  `);
  statement.run(userId, key, valueToStore);
}

/**
 * Safely closes the database connection.
 */
function closeDb() {
  if (dbInstance && dbInstance.open) {
    dbInstance.close();
  }
  dbInstance = null;
}

/**
 * Transparent proxy to the active database connection.
 * Solves module destructuring issues when db is re-opened.
 */
const db = new Proxy({}, {
  get(target, prop) {
    const activeDb = getDb();
    const val = activeDb[prop];
    return typeof val === 'function' ? val.bind(activeDb) : val;
  }
});

/**
 * Completely resets all financial data (transactions, portfolios, assets,
 * quotes, history, losses, dividend projections) starting completely empty,
 * while preserving users, settings, and currency rates.
 * Optionally creates an automatic safety backup before wiping.
 *
 * @param {object} [options]
 * @param {boolean} [options.createSafetyBackup=true]
 * @returns {Promise<{
 *   success: boolean,
 *   backup: object|null,
 *   deleted: {
 *     transactions: number,
 *     portfolio_losses: number,
 *     portfolio_history: number,
 *     dividend_projections: number,
 *     portfolio_users: number,
 *     portfolios: number,
 *     asset_quotes: number,
 *     assets: number
 *   }
 * }>}
 */
async function resetFinancialDatabase(options = {}) {
  const shouldBackup = options.createSafetyBackup !== false;
  let backupInfo = null;

  if (shouldBackup) {
    try {
      const { createBackup } = require('./backup_manager');
      backupInfo = await createBackup({ customPrefix: 'foliotrack_backup_pre_reset' });
    } catch (err) {
      console.warn('[DB Reset] Impossibile creare backup di sicurezza preventivo:', err.message);
    }
  }

  const database = getDb();

  const wipeAtomic = database.transaction(() => {
    // Disable foreign keys temporarily for clean cascade deletion
    database.pragma('foreign_keys = OFF');

    const delTransactions = database.prepare('DELETE FROM transactions').run().changes;
    const delLosses = database.prepare('DELETE FROM portfolio_losses').run().changes;
    const delHistory = database.prepare('DELETE FROM portfolio_history').run().changes;
    const delDividends = database.prepare('DELETE FROM dividend_projections').run().changes;
    const delPortfolioUsers = database.prepare('DELETE FROM portfolio_users').run().changes;
    const delPortfolios = database.prepare('DELETE FROM portfolios').run().changes;
    const delQuotes = database.prepare('DELETE FROM asset_quotes').run().changes;
    const delAssets = database.prepare('DELETE FROM assets').run().changes;
    try { database.prepare('DELETE FROM analysis_watchlist').run(); } catch {}
    try { database.prepare('DELETE FROM analysis_fundamentals_cache').run(); } catch {}

    // Reset SQLite auto-increment sequences for wiped tables
    try {
      database.prepare(`
        DELETE FROM sqlite_sequence
        WHERE name IN ('transactions', 'portfolio_losses', 'portfolio_history', 'dividend_projections', 'portfolio_users', 'portfolios', 'assets', 'analysis_watchlist')
      `).run();
    } catch {}

    // Clean up portfolio pointers from settings
    try {
      database.prepare("DELETE FROM settings WHERE key IN ('default_portfolio_id', 'active_portfolio_id')").run();
    } catch {}

    database.pragma('foreign_keys = ON');

    return {
      transactions: delTransactions,
      portfolio_losses: delLosses,
      portfolio_history: delHistory,
      dividend_projections: delDividends,
      portfolio_users: delPortfolioUsers,
      portfolios: delPortfolios,
      asset_quotes: delQuotes,
      assets: delAssets
    };
  });

  const deletedCounts = wipeAtomic();

  // Clear in-memory caches
  try {
    const { clearCache } = require('./utils/viewRenderer');
    clearCache();
  } catch {}
  try {
    const { invalidateIndicesCache } = require('./services/marketService');
    invalidateIndicesCache();
  } catch {}

  // Compact database file
  try {
    database.exec('VACUUM');
  } catch {}

  return {
    success: true,
    backup: backupInfo,
    deleted: deletedCounts
  };
}

module.exports = {
  db,
  getDb,
  initDb,
  closeDb,
  encrypt,
  decrypt,
  getSetting,
  setSetting,
  resetFinancialDatabase
};
