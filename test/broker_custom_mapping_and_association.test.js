const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const http = require('http');

const TEST_DB = path.join(__dirname, 'test_custom_import.db');
process.env.DB_PATH = TEST_DB;
process.env.JWT_SECRET = 'test-secret-jwt-very-long-and-secure-import-test';
process.env.ADMIN_PASSWORD = 'adminImportPassword123!';

const { initDb, closeDb, getDb } = require('../src/db');
const app = require('../src/app');

let server;
let baseUrl;
let authToken;
let defaultPortfolioId;

describe('CSV Movement Import with Custom Column Mapping & 3-Tier Ticker Resolution', () => {
  before(async () => {
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    initDb(TEST_DB);
    const db = getDb();

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
      body: JSON.stringify({ username: 'admin', password: 'adminImportPassword123!' })
    });
    const loginData = await loginRes.json();
    authToken = loginData.token;

    // Create a default portfolio for the admin
    const portRes = await fetch(`${baseUrl}/api/portfolios`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`
      },
      body: JSON.stringify({
        name: 'Portafoglio Principale',
        currency: 'EUR',
        initialCash: 10000,
        is_default: 1
      })
    });
    const portData = await portRes.json();
    defaultPortfolioId = portData.portfolio.id;

    // Seed one internal asset into assets table to test tier 1 lookup
    db.prepare(`
      INSERT INTO assets (ticker, name, type, currency, currentPrice, dataSource)
      VALUES ('INTERNAL_TEST', 'Internal Test Asset Inc.', 'EQUITY', 'EUR', 42.50, 'MANUAL')
    `).run();
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    closeDb();
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    const walFile = `${TEST_DB}-wal`;
    const shmFile = `${TEST_DB}-shm`;
    if (fs.existsSync(walFile)) fs.unlinkSync(walFile);
    if (fs.existsSync(shmFile)) fs.unlinkSync(shmFile);
  });

  test('Preview with missing portfolio proposes user default portfolio', async () => {
    const csvContent = `Data Operazione;Causale;Simbolo;Qta;Prezzo Eseguito;Controvalore
15/03/2024;Acquisto;INTERNAL_TEST;10;42,50;425,00`;

    const res = await fetch(`${baseUrl}/api/transactions/import-csv`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`
      },
      body: JSON.stringify({
        csvText: csvContent,
        preview: true
        // portfolioId omitted!
      })
    });

    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.equal(body.preview, true);
    assert.equal(body.defaultPortfolioProposed, true);
    assert.equal(body.defaultPortfolio.id, defaultPortfolioId);
    assert.equal(body.hasPortfolioColumn, false);
    assert.equal(body.transactions.length, 1);
  });

  test('3-Tier Ticker lookup associates INTERNAL catalog asset correctly in preview', async () => {
    const csvContent = `Data;Tipo;Ticker;Quantita;Prezzo;Totale
10/01/2024;BUY;INTERNAL_TEST;5;42,50;212,50`;

    const res = await fetch(`${baseUrl}/api/transactions/import-csv`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`
      },
      body: JSON.stringify({
        csvText: csvContent,
        preview: true,
        portfolioId: defaultPortfolioId
      })
    });

    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    const tx = body.transactions[0];
    assert.equal(tx.assetTicker, 'INTERNAL_TEST');
    assert.ok(tx.assetMatch);
    assert.equal(tx.assetMatch.source, 'INTERNAL');
    assert.equal(tx.assetMatch.name, 'Internal Test Asset Inc.');
  });

  test('3-Tier Ticker lookup queries online provider for unknown internal ticker (e.g. AAPL)', async () => {
    const csvContent = `Data;Tipo;Ticker;Quantita;Prezzo;Totale
10/01/2024;BUY;AAPL;2;180,00;360,00`;

    const res = await fetch(`${baseUrl}/api/transactions/import-csv`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`
      },
      body: JSON.stringify({
        csvText: csvContent,
        preview: true,
        portfolioId: defaultPortfolioId
      })
    });

    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    const tx = body.transactions[0];
    assert.equal(tx.assetTicker, 'AAPL');
    assert.ok(tx.assetMatch);
    assert.equal(tx.assetMatch.source, 'PROVIDER');
    assert.ok(tx.assetMatch.name.includes('Apple'));
  });

  test('Custom column mapping associates non-standard headers to required fields', async () => {
    const nonStandardCsv = `Mio_Giorno,Codice_Strumento,Operazione_Effettuata,Numero_Pezzi,Costo_Singolo,Controvalore_Netto,Commissione_Banca
20/02/2024,INTERNAL_TEST,Acquisto Azioni,20,42.50,850.00,5.00`;

    const customMapping = {
      date: 'Mio_Giorno',
      ticker: 'Codice_Strumento',
      type: 'Operazione_Effettuata',
      quantity: 'Numero_Pezzi',
      price: 'Costo_Singolo',
      amount: 'Controvalore_Netto',
      commission: 'Commissione_Banca'
    };

    const res = await fetch(`${baseUrl}/api/transactions/import-csv`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`
      },
      body: JSON.stringify({
        csvText: nonStandardCsv,
        portfolioId: defaultPortfolioId,
        preview: true,
        customMapping
      })
    });

    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.equal(body.detectedBroker, 'CUSTOM');
    assert.equal(body.transactions.length, 1);

    const tx = body.transactions[0];
    assert.equal(tx.date, '2024-02-20');
    assert.equal(tx.type, 'BUY');
    assert.equal(tx.assetTicker, 'INTERNAL_TEST');
    assert.equal(tx.quantity, 20);
    assert.equal(tx.price, 42.5);
    assert.equal(tx.amount, 850);
    assert.equal(tx.commission, 5);
  });

  test('Commit import persists mapped transactions and recalculates portfolio', async () => {
    const csvContent = `Data,Tipo,Ticker,Quantita,Prezzo,Importo
2024-03-01,BUY,INTERNAL_TEST,10,42.50,425.00`;

    const res = await fetch(`${baseUrl}/api/transactions/import-csv`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`
      },
      body: JSON.stringify({
        csvText: csvContent,
        portfolioId: defaultPortfolioId,
        preview: false
      })
    });

    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.equal(body.preview, false);
    assert.equal(body.insertedCount, 1);
    assert.ok(body.portfolio);
    assert.equal(body.portfolio.id, defaultPortfolioId);
  });
});

