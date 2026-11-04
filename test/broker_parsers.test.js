const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');

// Point to test database
const TEST_DB_PATH = path.join(__dirname, 'test_parsers.db');
process.env.DB_PATH = TEST_DB_PATH;
process.env.JWT_SECRET = 'test_jwt_secret_broker_parsers_12345';
process.env.NODE_ENV = 'test';

const { initDb, closeDb, db } = require('../src/db');
const app = require('../src/app');
const {
  detectBroker,
  detectDelimiter,
  parseItalianNumber,
  parseItalianDate,
  parseBrokerCsv,
  extractTickerFromText
} = require('../src/utils/brokerParsers');
const {
  exportWealthfolioCsv,
  mapToWealthfolioInstrumentType,
  mapToWealthfolioActivityType
} = require('../src/utils/exportFormats');

describe('Phase 6: Broker CSV Parsers & Wealthfolio Import/Export Engine', () => {
  let server;
  let baseUrl;
  let adminToken;
  let portfolioId;

  before(async () => {
    if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
    initDb();

    await new Promise((resolve) => {
      server = http.createServer(app);
      server.listen(0, '127.0.0.1', () => {
        const port = server.address().port;
        baseUrl = `http://127.0.0.1:${port}`;
        resolve();
      });
    });

    // Login as admin
    const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin123' })
    });
    const loginData = await loginRes.json();
    adminToken = loginData.token;

    // Create a test portfolio for imports
    const portRes = await fetch(`${baseUrl}/api/portfolios`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`
      },
      body: JSON.stringify({
        name: 'Directa & IFIS Test Portfolio',
        type: 'Investimento',
        currency: 'EUR',
        initialCash: 0
      })
    });
    const portData = await portRes.json();
    portfolioId = portData.portfolio.id;
  });

  after(async () => {
    if (server) await new Promise((res) => server.close(res));
    closeDb();
    if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
    const wal = `${TEST_DB_PATH}-wal`;
    const shm = `${TEST_DB_PATH}-shm`;
    if (fs.existsSync(wal)) fs.unlinkSync(wal);
    if (fs.existsSync(shm)) fs.unlinkSync(shm);
  });

  describe('1. Parsing & Detection Utilities', () => {
    test('parseItalianNumber handles Italian, English and edge-case formats', () => {
      assert.strictEqual(parseItalianNumber('1.234,56'), 1234.56);
      assert.strictEqual(parseItalianNumber('1,234.56'), 1234.56);
      assert.strictEqual(parseItalianNumber('€ 2.500,00'), 2500);
      assert.strictEqual(parseItalianNumber('-150,75'), -150.75);
      assert.strictEqual(parseItalianNumber('150,75-'), -150.75);
      assert.strictEqual(parseItalianNumber('(500,20)'), -500.2);
      assert.strictEqual(parseItalianNumber(''), 0);
      assert.strictEqual(parseItalianNumber(null), 0);
      assert.strictEqual(parseItalianNumber(42.5), 42.5);
    });

    test('parseItalianDate handles DD/MM/YYYY, DD-MM-YYYY and ISO', () => {
      assert.strictEqual(parseItalianDate('25/12/2023'), '2023-12-25');
      assert.strictEqual(parseItalianDate('05-04-2024'), '2024-04-05');
      assert.strictEqual(parseItalianDate('1/2/2024'), '2024-02-01');
      assert.strictEqual(parseItalianDate('2024-01-15'), '2024-01-15');
      assert.strictEqual(parseItalianDate('invalid'), null);
    });

    test('extractTickerFromText identifies tickers and ISINs', () => {
      assert.strictEqual(extractTickerFromText('SWDA - ISHARES CORE MSCI WORLD'), 'SWDA');
      assert.strictEqual(extractTickerFromText('Apple Inc (AAPL)'), 'AAPL');
      assert.strictEqual(extractTickerFromText('BTP TF 4% 2037 ISIN IT0005438004'), 'IT0005438004');
      assert.strictEqual(extractTickerFromText('BTC-EUR'), 'BTC-EUR');
    });

    test('detectBroker accurately detects Directa, Banca IFIS, Wealthfolio, and Generic', () => {
      const directaCsv = 'Data operazione;Tipo operazione;Riferimento ordine;Descrizione;Quantità;Prezzo;Importo\n01/02/2024;Acquisto;12345;SWDA;10;85,50;855,00';
      assert.strictEqual(detectBroker(directaCsv), 'DIRECTA');

      const ifisCsv = 'Data contabile;Data valuta;Causale;Importo;Descrizione\n05/01/2024;05/01/2024;Accredito interessi;150,25;Interessi conto';
      assert.strictEqual(detectBroker(ifisCsv), 'BANCA_IFIS');

      const wealthfolioCsv = 'date,symbol,instrumentType,quantity,activityType,unitPrice,currency,fee,tax,amount,fxRate,subtype\n2024-01-01,AAPL,EQUITY,10,BUY,180,USD,1,0,1801,1.08,tech';
      assert.strictEqual(detectBroker(wealthfolioCsv), 'WEALTHFOLIO');

      const genericCsv = 'Date,Type,Ticker,Quantity,Price,Amount\n2024-01-01,BUY,MSFT,5,400,2000';
      assert.strictEqual(detectBroker(genericCsv), 'GENERIC');
    });
  });

  describe('2. Directa SIM CSV Parsing', () => {
    test('parses Directa movements with causali mapping and number conversion', () => {
      const directaCsv = `Data operazione;Tipo operazione;Riferimento ordine;Descrizione;Quantità;Prezzo;Commissioni;Importo
02/01/2024;Acquisto;ORD001;SWDA - ISHARES CORE MSCI WORLD;15;80,00;5,00;1205,00
10/01/2024;Vendita;ORD002;SWDA - ISHARES CORE MSCI WORLD;5;85,00;5,00;420,00
15/01/2024;Incasso dividendi;DIV001;SWDA;0;0;0;25,50
20/01/2024;Conferimento con bonifico;BON001;Bonifico da CC;0;0;0;1000,00
25/01/2024;Prelievo;BON002;Prelievo verso CC;0;0;0;300,00`;

      const result = parseBrokerCsv(directaCsv, 'EUR');
      assert.strictEqual(result.broker, 'DIRECTA');
      assert.strictEqual(result.transactions.length, 5);

      const [buy, sell, div, dep, wit] = result.transactions;

      assert.strictEqual(buy.type, 'BUY');
      assert.strictEqual(buy.assetTicker, 'SWDA');
      assert.strictEqual(buy.quantity, 15);
      assert.strictEqual(buy.price, 80);
      assert.strictEqual(buy.commission, 5);
      assert.strictEqual(buy.amount, 1205);
      assert.strictEqual(buy.date, '2024-01-02');

      assert.strictEqual(sell.type, 'SELL');
      assert.strictEqual(sell.quantity, 5);
      assert.strictEqual(sell.price, 85);

      assert.strictEqual(div.type, 'DIVIDEND');
      assert.strictEqual(div.amount, 25.5);

      assert.strictEqual(dep.type, 'DEPOSIT');
      assert.strictEqual(dep.assetTicker, null);
      assert.strictEqual(dep.amount, 1000);

      assert.strictEqual(wit.type, 'WITHDRAWAL');
      assert.strictEqual(wit.amount, 300);
    });
  });

  describe('3. Banca IFIS CSV Parsing', () => {
    test('parses Banca IFIS interest, taxes and transfers', () => {
      const ifisCsv = `Data contabile;Data valuta;Causale;Importo;Descrizione
31/12/2023;31/12/2023;Accredito interessi lordi;250,00;Interessi fine trimestre
31/12/2023;31/12/2023;Ritenuta fiscale 26%;-65,00;Ritenuta interessi
02/01/2024;02/01/2024;Bonifico in accredito;5000,00;Versamento vincolo
15/01/2024;15/01/2024;Bonifico in addebito;-1000,00;Giroconto`;

      const result = parseBrokerCsv(ifisCsv, 'EUR');
      assert.strictEqual(result.broker, 'BANCA_IFIS');
      assert.strictEqual(result.transactions.length, 4);

      const [interest, tax, dep, wit] = result.transactions;
      assert.strictEqual(interest.type, 'INTEREST');
      assert.strictEqual(interest.amount, 250);

      assert.strictEqual(tax.type, 'TAX');
      assert.strictEqual(tax.amount, 65);

      assert.strictEqual(dep.type, 'DEPOSIT');
      assert.strictEqual(dep.amount, 5000);

      assert.strictEqual(wit.type, 'WITHDRAWAL');
      assert.strictEqual(wit.amount, 1000);
    });
  });

  describe('4. Wealthfolio CSV Export & Mapping', () => {
    test('maps instrument types and activity types accurately', () => {
      assert.strictEqual(mapToWealthfolioInstrumentType('EQUITY'), 'EQUITY');
      assert.strictEqual(mapToWealthfolioInstrumentType('ETF'), 'ETF');
      assert.strictEqual(mapToWealthfolioInstrumentType('BOND'), 'BOND');
      assert.strictEqual(mapToWealthfolioInstrumentType('CRYPTO'), 'CRYPTO');
      assert.strictEqual(mapToWealthfolioInstrumentType('COMMODITY'), 'COMMODITY');
      assert.strictEqual(mapToWealthfolioInstrumentType('CASH', 'DEPOSIT'), '');

      assert.strictEqual(mapToWealthfolioActivityType('BUY'), 'BUY');
      assert.strictEqual(mapToWealthfolioActivityType('SELL'), 'SELL');
      assert.strictEqual(mapToWealthfolioActivityType('DIVIDEND'), 'DIVIDEND');
      assert.strictEqual(mapToWealthfolioActivityType('INTEREST'), 'INTEREST');
      assert.strictEqual(mapToWealthfolioActivityType('DEPOSIT'), 'DEPOSIT');
      assert.strictEqual(mapToWealthfolioActivityType('WITHDRAWAL'), 'WITHDRAWAL');
    });

    test('exportWealthfolioCsv produces valid CSV with expected columns and escaping', () => {
      const mockTxs = [
        {
          date: '2024-01-10',
          assetTicker: 'AAPL',
          type: 'BUY',
          quantity: 10,
          price: 185.5,
          commission: 2.5,
          tax: 0,
          amount: 1857.5,
          exchangeRate: 1.08,
          notes: 'Purchase with notes, commas, and "quotes"'
        },
        {
          date: '2024-01-15',
          assetTicker: null,
          type: 'DEPOSIT',
          quantity: 0,
          price: 0,
          commission: 0,
          tax: 0,
          amount: 1000,
          exchangeRate: 1.0,
          notes: 'Deposit'
        }
      ];

      const assetsMap = {
        AAPL: { ticker: 'AAPL', type: 'EQUITY', currency: 'USD' }
      };

      const csv = exportWealthfolioCsv(mockTxs, assetsMap, 'EUR');
      const lines = csv.trim().split('\n');

      assert.strictEqual(lines.length, 3);
      assert.strictEqual(
        lines[0],
        'date,symbol,instrumentType,quantity,activityType,unitPrice,currency,fee,tax,amount,fxRate,subtype'
      );

      // Verify row 1
      assert.ok(lines[1].includes('2024-01-10'));
      assert.ok(lines[1].includes('AAPL'));
      assert.ok(lines[1].includes('EQUITY'));
      assert.ok(lines[1].includes('BUY'));
      assert.ok(lines[1].includes('USD'));
      assert.ok(lines[1].includes('""quotes""')); // escaped quotes

      // Verify row 2 (deposit with empty symbol and instrumentType)
      assert.ok(lines[2].includes('2024-01-15'));
      assert.ok(lines[2].includes('DEPOSIT'));
      assert.ok(lines[2].includes('1000'));
    });
  });

  describe('5. Full API Endpoints: Preview, Import & Export', () => {
    const csvContent = `Data operazione;Tipo operazione;Riferimento ordine;Descrizione;Quantità;Prezzo;Commissioni;Importo
2024-02-01;Acquisto;ORD100;CSSPX - ISHARES S&P 500;10;450,00;5,00;4505,00
2024-02-05;Incasso dividendi;DIV100;CSSPX;0;0;0;50,00
2024-02-10;Conferimento con bonifico;DEP100;Bonifico;0;0;0;2000,00`;

    test('POST /api/transactions/import-csv in preview mode returns parsed rows without DB modifications', async () => {
      const res = await fetch(`${baseUrl}/api/transactions/import-csv`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${adminToken}`
        },
        body: JSON.stringify({
          portfolioId,
          csvText: csvContent,
          preview: true
        })
      });

      assert.strictEqual(res.status, 200);
      const data = await res.json();

      assert.strictEqual(data.success, true);
      assert.strictEqual(data.preview, true);
      assert.strictEqual(data.detectedBroker, 'DIRECTA');
      assert.strictEqual(data.parsedCount, 3);
      assert.strictEqual(data.duplicateCount, 0);
      assert.strictEqual(data.newCount, 3);

      // Verify database was NOT changed
      const count = db.prepare('SELECT COUNT(*) as c FROM transactions WHERE portfolioId = ?').get(portfolioId).c;
      assert.strictEqual(count, 0);
    });

    test('POST /api/transactions/import-csv performs atomic commit and updates portfolio', async () => {
      const res = await fetch(`${baseUrl}/api/transactions/import-csv`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${adminToken}`
        },
        body: JSON.stringify({
          portfolioId,
          csvText: csvContent,
          preview: false
        })
      });

      assert.strictEqual(res.status, 201);
      const data = await res.json();

      assert.strictEqual(data.success, true);
      assert.strictEqual(data.preview, false);
      assert.strictEqual(data.insertedCount, 3);
      assert.strictEqual(data.duplicateCount, 0);

      // Verify transactions exist in DB
      const count = db.prepare('SELECT COUNT(*) as c FROM transactions WHERE portfolioId = ?').get(portfolioId).c;
      assert.strictEqual(count, 3);

      // Verify portfolio metrics recalculated
      assert.ok(data.portfolio);
      assert.strictEqual(data.portfolio.assetCount, 1);
    });

    test('POST /api/transactions/import-csv detects duplicates on subsequent imports', async () => {
      const res = await fetch(`${baseUrl}/api/transactions/import-csv`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${adminToken}`
        },
        body: JSON.stringify({
          portfolioId,
          csvText: csvContent,
          preview: false
        })
      });

      assert.strictEqual(res.status, 201);
      const data = await res.json();

      assert.strictEqual(data.success, true);
      assert.strictEqual(data.insertedCount, 0); // No new rows inserted!
      assert.strictEqual(data.duplicateCount, 3); // All 3 recognized as duplicates

      const count = db.prepare('SELECT COUNT(*) as c FROM transactions WHERE portfolioId = ?').get(portfolioId).c;
      assert.strictEqual(count, 3);
    });

    test('POST /api/transactions/import-csv handles multipart/form-data with file upload', async () => {
      const boundary = '----WebKitFormBoundary7MA4YWxkTrZu0gW';
      const fileData = 'Data contabile;Causale;Importo\n2024-03-01;Accredito interessi;75,50';

      const body = [
        `--${boundary}`,
        'Content-Disposition: form-data; name="portfolioId"',
        '',
        portfolioId.toString(),
        `--${boundary}`,
        'Content-Disposition: form-data; name="file"; filename="ifis.csv"',
        'Content-Type: text/csv',
        '',
        fileData,
        `--${boundary}--`
      ].join('\r\n');

      const res = await fetch(`${baseUrl}/api/transactions/import-csv`, {
        method: 'POST',
        headers: {
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          Authorization: `Bearer ${adminToken}`
        },
        body
      });

      assert.strictEqual(res.status, 201);
      const data = await res.json();
      assert.strictEqual(data.success, true);
      assert.strictEqual(data.detectedBroker, 'BANCA_IFIS');
      assert.strictEqual(data.insertedCount, 1);
    });

    test('GET /api/portfolios/:id/export/wealthfolio downloads Wealthfolio-compatible CSV', async () => {
      const res = await fetch(`${baseUrl}/api/portfolios/${portfolioId}/export/wealthfolio`, {
        headers: { Authorization: `Bearer ${adminToken}` }
      });

      assert.strictEqual(res.status, 200);
      assert.ok(res.headers.get('content-type').includes('text/csv'));
      assert.ok(res.headers.get('content-disposition').includes('attachment; filename='));

      const csvText = await res.text();
      const lines = csvText.trim().split('\n');

      assert.strictEqual(
        lines[0],
        'date,symbol,instrumentType,quantity,activityType,unitPrice,currency,fee,tax,amount,fxRate,subtype'
      );
      assert.ok(lines.length >= 4);
      assert.ok(csvText.includes('CSSPX'));
    });

    test('GET /api/transactions/export/wealthfolio accepts portfolioId query', async () => {
      const res = await fetch(`${baseUrl}/api/transactions/export/wealthfolio?portfolioId=${portfolioId}`, {
        headers: { Authorization: `Bearer ${adminToken}` }
      });

      assert.strictEqual(res.status, 200);
      assert.ok(res.headers.get('content-type').includes('text/csv'));
      const text = await res.text();
      assert.ok(text.includes('CSSPX'));
    });
  });
});

