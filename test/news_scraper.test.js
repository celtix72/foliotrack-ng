const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const http = require('http');

const testDbPath = path.join(__dirname, 'test_news_scraper.db');
process.env.DB_PATH = testDbPath;

const { initDb, closeDb, getDb } = require('../src/db');
const app = require('../src/app');
const {
  getUserPortfolioAssets,
  cleanCompanyName,
  decodeHtmlEntities,
  formatRelativeTime,
  saveNewsArticles,
  getLatestPortfolioNews
} = require('../src/services/newsService');

function makeRequest(app, method, urlPath, headers = {}, body = null) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      const opts = {
        hostname: '127.0.0.1',
        port: port,
        path: urlPath,
        method: method.toUpperCase(),
        headers: headers
      };

      const req = http.request(opts, (res) => {
        let rawData = '';
        res.on('data', chunk => { rawData += chunk; });
        res.on('end', () => {
          server.close(() => {
            let json = null;
            try { json = JSON.parse(rawData); } catch (_) {}
            resolve({
              status: res.statusCode,
              headers: res.headers,
              body: json,
              text: rawData
            });
          });
        });
      });

      req.on('error', (err) => {
        server.close(() => reject(err));
      });

      if (body) {
        const bodyStr = typeof body === 'string' ? body : JSON.stringify(body);
        req.write(bodyStr);
      }
      req.end();
    });
  });
}

describe('Portfolio News Scraper & Dashboard Widget Engine', () => {
  let authCookie = '';

  before(async () => {
    initDb(testDbPath);

    // Login as default admin
    const loginRes = await makeRequest(app, 'POST', '/api/auth/login', {
      'Content-Type': 'application/json'
    }, {
      username: 'admin',
      password: 'admin123'
    });

    assert.equal(loginRes.status, 200);
    const cookieHeader = loginRes.headers['set-cookie'];
    authCookie = Array.isArray(cookieHeader) ? cookieHeader[0].split(';')[0] : cookieHeader.split(';')[0];

    // Seed test portfolio and assets
    const db = getDb();
    const portInfo = db.prepare(`
      INSERT INTO portfolios (name, currentCash, totalValue, investedCapital, include_in_totals)
      VALUES ('News Test Port', 1000, 10000, 9000, 1)
    `).run();
    const pId = portInfo.lastInsertRowid;

    db.prepare("INSERT INTO portfolio_users (portfolio_id, user_id, role) VALUES (?, 1, 'owner')").run(pId);

    db.prepare(`
      INSERT OR REPLACE INTO assets (ticker, name, currentPrice, currency, type)
      VALUES ('ENEL.MI', 'Enel S.p.A.', 6.80, 'EUR', 'EQUITY'),
             ('NVDA', 'NVIDIA Corporation', 140.0, 'USD', 'EQUITY'),
             ('SWDA.MI', 'iShares Core MSCI World', 95.0, 'EUR', 'ETF')
    `).run();

    db.prepare(`
      INSERT INTO transactions (portfolioId, type, assetTicker, date, quantity, price, amount)
      VALUES (?, 'BUY', 'ENEL.MI', '2026-01-10', 100, 6.50, 650),
             (?, 'BUY', 'NVDA', '2026-02-15', 10, 120.0, 1200),
             (?, 'BUY', 'SWDA.MI', '2026-03-01', 50, 90.0, 4500)
    `).run(pId, pId, pId);
  });

  after(() => {
    closeDb();
    if (fs.existsSync(testDbPath)) {
      try { fs.unlinkSync(testDbPath); } catch (_) {}
    }
    const wal = testDbPath + '-wal';
    const shm = testDbPath + '-shm';
    if (fs.existsSync(wal)) try { fs.unlinkSync(wal); } catch (_) {}
    if (fs.existsSync(shm)) try { fs.unlinkSync(shm); } catch (_) {}
  });

  describe('1. Parsing & Normalization Utilities', () => {
    test('cleanCompanyName strips corporate suffixes while preserving brand names', () => {
      assert.equal(cleanCompanyName('Enel S.p.A.', 'ENEL.MI'), 'Enel');
      assert.equal(cleanCompanyName('NVIDIA Corporation', 'NVDA'), 'NVIDIA');
      assert.equal(cleanCompanyName('Apple Inc.', 'AAPL'), 'Apple');
      assert.equal(cleanCompanyName('iShares Core MSCI World UCITS ETF', 'SWDA.MI'), 'iShares Core MSCI World UCITS ETF');
    });

    test('decodeHtmlEntities decodes common and numeric entities', () => {
      const encoded = 'Enel &quot;supera&quot; le attese: ricavi a +12% &amp; dividendo confermato &#39;record&#39;';
      const expected = 'Enel "supera" le attese: ricavi a +12% & dividendo confermato \'record\'';
      assert.equal(decodeHtmlEntities(encoded), expected);
    });

    test('formatRelativeTime calculates relative time in Italian', () => {
      const now = Date.now();
      assert.equal(formatRelativeTime(new Date(now - 1000 * 30).toISOString()), 'Proprio ora');
      assert.equal(formatRelativeTime(new Date(now - 1000 * 60 * 15).toISOString()), '15 min fa');
      assert.equal(formatRelativeTime(new Date(now - 1000 * 60 * 60 * 3).toISOString()), '3 ore fa');
      assert.equal(formatRelativeTime(new Date(now - 1000 * 60 * 60 * 25).toISOString()), 'Ieri');
    });

    test('getUserPortfolioAssets extracts non-cash tickers held in portfolio', () => {
      const assets = getUserPortfolioAssets(1);
      const tickers = assets.map(a => a.ticker);
      assert.ok(tickers.includes('ENEL.MI'));
      assert.ok(tickers.includes('NVDA'));
      assert.ok(tickers.includes('SWDA.MI'));
      assert.ok(!tickers.includes('EUR'));
      assert.ok(!tickers.includes('CASH'));
    });
  });

  describe('2. News Storage and Retrieval Engine', () => {
    test('saveNewsArticles stores articles and prevents duplicate URLs', () => {
      const articles = [
        {
          ticker: 'ENEL.MI',
          title: 'Enel presenta il nuovo piano strategico per le rinnovabili',
          link: 'https://news.example.com/enel-piano-2026',
          publisher: 'Il Sole 24 Ore',
          pubDate: new Date().toISOString(),
          source: 'GOOGLE_NEWS'
        },
        {
          ticker: 'NVDA',
          title: 'Nvidia registra nuovi massimi storici con la domanda AI',
          link: 'https://news.example.com/nvda-ai-record',
          publisher: 'Milano Finanza',
          pubDate: new Date(Date.now() - 1000 * 60 * 60).toISOString(),
          source: 'YAHOO_FINANCE'
        }
      ];

      const inserted = saveNewsArticles(articles);
      assert.equal(inserted, 2);

      // Inserting exact same URLs should be ignored due to UNIQUE(link)
      const duplicateInsert = saveNewsArticles(articles);
      assert.equal(duplicateInsert, 0);
    });

    test('getLatestPortfolioNews retrieves top 5 latest news sorted by date', async () => {
      const news = await getLatestPortfolioNews(1, 5);
      assert.ok(Array.isArray(news));
      assert.ok(news.length >= 2);
      assert.ok(news.length <= 5);

      // Verify structure
      const item = news[0];
      assert.ok(item.ticker);
      assert.ok(item.title);
      assert.ok(item.link);
      assert.ok(item.publisher);
      assert.ok(item.timeAgo);
      assert.ok(item.pubDate);

      // Verify descending order
      for (let i = 0; i < news.length - 1; i++) {
        assert.ok(new Date(news[i].pubDate) >= new Date(news[i + 1].pubDate));
      }
    });
  });

  describe('3. News API Endpoints (/api/news)', () => {
    test('GET /api/news returns latest portfolio news items', async () => {
      const res = await makeRequest(app, 'GET', '/api/news?limit=5', {
        Cookie: authCookie
      });

      assert.equal(res.status, 200);
      assert.equal(res.body.success, true);
      assert.ok(Array.isArray(res.body.news));
      assert.ok(res.body.count >= 2);
      assert.ok(res.body.count <= 5);
    });

    test('POST /api/news/refresh triggers immediate scrape and returns updated articles', async () => {
      const res = await makeRequest(app, 'POST', '/api/news/refresh', {
        Cookie: authCookie
      });

      assert.equal(res.status, 200);
      assert.equal(res.body.success, true);
      assert.ok(res.body.message.includes('Scrape completato'));
      assert.ok(res.body.stats);
      assert.ok(typeof res.body.stats.checkedAssets === 'number');
      assert.ok(Array.isArray(res.body.news));
    });

    test('GET /api/news requires authentication', async () => {
      const res = await makeRequest(app, 'GET', '/api/news');
      assert.equal(res.status, 401);
    });
  });

  describe('4. Dashboard News Widget Integration', () => {
    test('Dashboard script exposes news widget in WIDGET_DEFINITIONS and MOBILE_DEFAULT_LAYOUT', () => {
      const dashboardScriptPath = path.join(__dirname, '..', 'public', 'dashboard.js');
      const content = fs.readFileSync(dashboardScriptPath, 'utf8');

      // Widget definitions
      assert.ok(content.includes("id: 'news'"), 'Must declare news widget id');
      assert.ok(content.includes('Ultime Notizie Portafoglio'), 'Must name news widget');
      assert.ok(content.includes('news: (data) =>'), 'Must implement news renderer in WIDGET_RENDERERS');
      assert.ok(content.includes('loadPortfolioNews'), 'Must implement loadPortfolioNews');
      assert.ok(content.includes('refreshNews'), 'Must export refreshNews');
    });
  });
});
