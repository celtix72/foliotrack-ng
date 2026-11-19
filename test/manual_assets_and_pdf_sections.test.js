const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');

const TEST_DB = path.join(__dirname, 'test_manual_assets.db');
process.env.DB_PATH = TEST_DB;
process.env.JWT_SECRET = 'test-jwt-secret-manual-assets-2026';
process.env.ADMIN_PASSWORD = 'adminManualAssetsPassword123!';
process.env.NODE_ENV = 'test';

const { initDb, closeDb, db } = require('../src/db');
const app = require('../src/app');

let server;
let baseUrl;
let authToken;
let testPortfolioId;

describe('Manual Assets (Depositi Vincolati, Buoni Postali, TFR, Fondi Pensione) & PDF Reports', () => {
  before(async () => {
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    initDb(TEST_DB);

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
      body: JSON.stringify({ username: 'admin', password: 'adminManualAssetsPassword123!' })
    });
    const loginData = await loginRes.json();
    authToken = loginData.token;

    // Create a portfolio
    const pRes = await fetch(`${baseUrl}/api/portfolios`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`
      },
      body: JSON.stringify({
        name: 'Portafoglio Amministrato & Previdenza',
        type: 'Investimento',
        currency: 'EUR',
        initialCash: 50000
      })
    });
    const pData = await pRes.json();
    testPortfolioId = pData.portfolio.id;
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    closeDb();
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  });

  test('1. GET /api/assets/taxonomy includes DEPOSITO_VINCOLATO, BUONO_POSTALE, TFR, and FONDO_PENSIONE', async () => {
    const res = await fetch(`${baseUrl}/api/assets/taxonomy`, {
      headers: { Authorization: `Bearer ${authToken}` }
    });
    const data = await res.json();
    assert.strictEqual(res.status, 200);
    assert.strictEqual(data.success, true);
    assert.ok(data.taxonomy.assetTypes.includes('DEPOSITO_VINCOLATO'));
    assert.ok(data.taxonomy.assetTypes.includes('BUONO_POSTALE'));
    assert.ok(data.taxonomy.assetTypes.includes('TFR'));
    assert.ok(data.taxonomy.assetTypes.includes('FONDO_PENSIONE'));
  });

  test('2. POST /api/assets inserts manual assets and forces dataSource=MANUAL without external scraping', async () => {
    // A) Deposito Vincolato
    const resDep = await fetch(`${baseUrl}/api/assets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
      body: JSON.stringify({
        ticker: 'DEP-ILLIMITY-4PCT',
        name: 'Conto Deposito Vincolato Illimity 36M',
        type: 'DEPOSITO_VINCOLATO',
        currency: 'EUR',
        currentPrice: 10000.00
      })
    });
    const dataDep = await resDep.json();
    assert.strictEqual(resDep.status, 200);
    assert.strictEqual(dataDep.asset.ticker, 'DEP-ILLIMITY-4PCT');
    assert.strictEqual(dataDep.asset.type, 'DEPOSITO_VINCOLATO');
    assert.strictEqual(dataDep.asset.dataSource, 'MANUAL');
    assert.strictEqual(dataDep.asset.currentPrice, 10000.00);

    // B) Buono Postale
    const resBfp = await fetch(`${baseUrl}/api/assets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
      body: JSON.stringify({
        ticker: 'BFP-RINNOVA-3X4',
        name: 'Buono Fruttifero Postale 3x4 CDP',
        type: 'BUONO_POSTALE',
        currency: 'EUR',
        currentPrice: 5000.00
      })
    });
    const dataBfp = await resBfp.json();
    assert.strictEqual(resBfp.status, 200);
    assert.strictEqual(dataBfp.asset.type, 'BUONO_POSTALE');
    assert.strictEqual(dataBfp.asset.dataSource, 'MANUAL');

    // C) TFR
    const resTfr = await fetch(`${baseUrl}/api/assets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
      body: JSON.stringify({
        ticker: 'TFR-AZIENDALE',
        name: 'Trattamento Fine Rapporto Maturato',
        type: 'TFR',
        currency: 'EUR',
        currentPrice: 25000.00
      })
    });
    const dataTfr = await resTfr.json();
    assert.strictEqual(resTfr.status, 200);
    assert.strictEqual(dataTfr.asset.type, 'TFR');
    assert.strictEqual(dataTfr.asset.dataSource, 'MANUAL');

    // D) Fondo Pensione
    const resFp = await fetch(`${baseUrl}/api/assets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
      body: JSON.stringify({
        ticker: 'FONDO-COMETA-CRESCITA',
        name: 'Fondo Pensione Nazionale Cometa Comparto Crescita',
        type: 'FONDO_PENSIONE',
        currency: 'EUR',
        currentPrice: 150.00
      })
    });
    const dataFp = await resFp.json();
    assert.strictEqual(resFp.status, 200);
    assert.strictEqual(dataFp.asset.type, 'FONDO_PENSIONE');
    assert.strictEqual(dataFp.asset.dataSource, 'MANUAL');
  });

  test('3. Live quote sync is disabled for manual assets (can only be updated manually)', async () => {
    const res = await fetch(`${baseUrl}/api/assets/DEP-ILLIMITY-4PCT/sync-quote`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${authToken}` }
    });
    const data = await res.json();
    assert.strictEqual(res.status, 200);
    assert.strictEqual(data.success, true);
    assert.strictEqual(data.quote.isManual, true);
    assert.match(data.message, /aggiornamento quotazioni live disattivato/i);

    // Verify GET /api/market/quote/:ticker preserves manual price
    const mRes = await fetch(`${baseUrl}/api/market/quote/DEP-ILLIMITY-4PCT`, {
      headers: { Authorization: `Bearer ${authToken}` }
    });
    const mData = await mRes.json();
    assert.strictEqual(mRes.status, 200);
    assert.strictEqual(mData.quote.currentPrice, 10000.00);
    assert.strictEqual(mData.quote.isManual, true);
  });

  test('4. Manual asset price and type can be updated via PUT /api/assets/:ticker', async () => {
    // Update price of TFR manually
    const resUpdate = await fetch(`${baseUrl}/api/assets/TFR-AZIENDALE`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
      body: JSON.stringify({
        currentPrice: 26500.00
      })
    });
    const dataUpdate = await resUpdate.json();
    assert.strictEqual(resUpdate.status, 200);
    assert.strictEqual(dataUpdate.success, true);
    assert.strictEqual(dataUpdate.asset.currentPrice, 26500.00);
    assert.strictEqual(dataUpdate.asset.dataSource, 'MANUAL');
  });

  test('5. Transactions with manual assets and market assets in portfolio', async () => {
    // 1. BUY Deposito Vincolato (1 x 10000, currentPrice = 10000, gain = 0)
    await fetch(`${baseUrl}/api/transactions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
      body: JSON.stringify({
        portfolioId: testPortfolioId,
        type: 'BUY',
        assetTicker: 'DEP-ILLIMITY-4PCT',
        date: '2026-01-10',
        quantity: 1,
        price: 10000.00
      })
    });

    // 2. BUY Buono Postale (1 x 5000, currentPrice = 5200, gain = +200)
    await fetch(`${baseUrl}/api/transactions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
      body: JSON.stringify({
        portfolioId: testPortfolioId,
        type: 'BUY',
        assetTicker: 'BFP-RINNOVA-3X4',
        date: '2026-01-15',
        quantity: 1,
        price: 5000.00
      })
    });
    // Update current price of BFP to 5200
    await fetch(`${baseUrl}/api/assets/BFP-RINNOVA-3X4`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
      body: JSON.stringify({ currentPrice: 5200.00 })
    });

    // 3. BUY TFR (1 x 25000, currentPrice = 26500, gain = +1500)
    await fetch(`${baseUrl}/api/transactions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
      body: JSON.stringify({
        portfolioId: testPortfolioId,
        type: 'BUY',
        assetTicker: 'TFR-AZIENDALE',
        date: '2026-01-01',
        quantity: 1,
        price: 25000.00
      })
    });

    // 4. BUY a standard Market Asset (e.g. ETF SWDA, 10 x 90 = 900, currentPrice = 100 -> gain = +100)
    await fetch(`${baseUrl}/api/assets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
      body: JSON.stringify({
        ticker: 'SWDA.MI',
        name: 'iShares Core MSCI World UCITS ETF',
        type: 'ETF',
        currency: 'EUR',
        currentPrice: 100.00
      })
    });
    await fetch(`${baseUrl}/api/transactions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
      body: JSON.stringify({
        portfolioId: testPortfolioId,
        type: 'BUY',
        assetTicker: 'SWDA.MI',
        date: '2026-02-01',
        quantity: 10,
        price: 90.00
      })
    });
  });

  test('6. GET /api/reports/portfolio-data partitions holdings into marketHoldings and manualHoldings with dedicated categories and gross/tax/net detail', async () => {
    const res = await fetch(`${baseUrl}/api/reports/portfolio-data?portfolioId=${testPortfolioId}`, {
      headers: { Authorization: `Bearer ${authToken}` }
    });
    const data = await res.json();
    assert.strictEqual(res.status, 200);
    assert.strictEqual(data.success, true);

    const port = data.portfolios[0];
    assert.ok(port);
    assert.strictEqual(port.hasManualHoldings, true);
    assert.strictEqual(port.hasMarketHoldings, true);

    // Verify marketHoldings
    assert.strictEqual(port.marketHoldings.length, 1);
    assert.strictEqual(port.marketHoldings[0].ticker, 'SWDA.MI');
    assert.strictEqual(port.marketHoldings[0].isManualType, false);

    // Verify manualHoldings
    assert.strictEqual(port.manualHoldings.length, 3);
    const tickers = port.manualHoldings.map(h => h.ticker);
    assert.ok(tickers.includes('DEP-ILLIMITY-4PCT'));
    assert.ok(tickers.includes('BFP-RINNOVA-3X4'));
    assert.ok(tickers.includes('TFR-AZIENDALE'));

    // Verify manual holding metrics
    const bfp = port.manualHoldings.find(h => h.ticker === 'BFP-RINNOVA-3X4');
    assert.strictEqual(bfp.isManualType, true);
    assert.strictEqual(bfp.manualCategory, 'Buono Postale');
    assert.strictEqual(bfp.taxCategory, 'BOND'); // 12.5% taxation
    assert.strictEqual(bfp.taxRate, 0.125);
    assert.strictEqual(bfp.gain, 200.00);
    assert.strictEqual(bfp.estimatedTax, 25.00); // 200 * 0.125
    assert.strictEqual(bfp.netGain, 175.00);
    assert.strictEqual(bfp.netValue, 5175.00); // 5200 - 25

    const tfr = port.manualHoldings.find(h => h.ticker === 'TFR-AZIENDALE');
    assert.strictEqual(tfr.isManualType, true);
    assert.strictEqual(tfr.manualCategory, 'TFR');
    assert.strictEqual(tfr.gain, 1500.00);
    assert.strictEqual(tfr.taxRate, 0.17);
    assert.strictEqual(tfr.estimatedTax, 255.00); // 1500 * 0.17
    assert.strictEqual(tfr.netGain, 1245.00);
    assert.strictEqual(tfr.netValue, 26245.00); // 26500 - 255

    // Verify manualCategories on portfolio object
    assert.ok(port.manualCategories, 'manualCategories object must exist');
    assert.strictEqual(port.hasContiDeposito, true);
    assert.strictEqual(port.hasBuoniPostali, true);
    assert.strictEqual(port.hasTfr, true);
    assert.strictEqual(port.hasFondiPensione, false);

    // Conti Deposito details
    assert.strictEqual(port.manualCategories.contiDeposito.count, 1);
    assert.strictEqual(port.manualCategories.contiDeposito.grossValue, 10000.00);
    assert.strictEqual(port.manualCategories.contiDeposito.taxRate, 0.26);
    assert.strictEqual(port.manualCategories.contiDeposito.taxRateFormatted, '26%');
    assert.strictEqual(port.manualCategories.contiDeposito.estimatedTax, 0.00);
    assert.strictEqual(port.manualCategories.contiDeposito.netValue, 10000.00);

    // Buoni Postali details
    assert.strictEqual(port.manualCategories.buoniPostali.count, 1);
    assert.strictEqual(port.manualCategories.buoniPostali.grossValue, 5200.00);
    assert.strictEqual(port.manualCategories.buoniPostali.investedCapital, 5000.00);
    assert.strictEqual(port.manualCategories.buoniPostali.grossGain, 200.00);
    assert.strictEqual(port.manualCategories.buoniPostali.taxRate, 0.125);
    assert.strictEqual(port.manualCategories.buoniPostali.taxRateFormatted, '12,5%');
    assert.strictEqual(port.manualCategories.buoniPostali.estimatedTax, 25.00);
    assert.strictEqual(port.manualCategories.buoniPostali.netGain, 175.00);
    assert.strictEqual(port.manualCategories.buoniPostali.netValue, 5175.00);

    // TFR details
    assert.strictEqual(port.manualCategories.tfr.count, 1);
    assert.strictEqual(port.manualCategories.tfr.grossValue, 26500.00);
    assert.strictEqual(port.manualCategories.tfr.investedCapital, 25000.00);
    assert.strictEqual(port.manualCategories.tfr.grossGain, 1500.00);
    assert.strictEqual(port.manualCategories.tfr.taxRate, 0.17);
    assert.strictEqual(port.manualCategories.tfr.taxRateFormatted, '17%');
    assert.strictEqual(port.manualCategories.tfr.estimatedTax, 255.00);
    assert.strictEqual(port.manualCategories.tfr.netGain, 1245.00);
    assert.strictEqual(port.manualCategories.tfr.netValue, 26245.00);

    // Verify portfolio-level manual totals
    assert.strictEqual(port.manualHoldingsTotalValue, 10000 + 5200 + 26500); // 41700
    assert.strictEqual(port.manualHoldingsTotalGain, 0 + 200 + 1500); // 1700

    // Verify global totals
    assert.strictEqual(data.totals.manualAssetsCount, 3);
    assert.strictEqual(data.totals.manualAssetsValue, 41700);
    assert.strictEqual(data.totals.manualAssetsGain, 1700);
    assert.strictEqual(data.totals.manualAssetsEstimatedTax, 280); // 25 + 255
    assert.strictEqual(data.totals.manualAssetsNetGain, 1420); // 175 + 1245
    assert.strictEqual(data.totals.manualAssetsNetValue, 41420); // 41700 - 280
    assert.ok(data.totals.manualCategories);
    assert.strictEqual(data.totals.manualCategories.contiDeposito.count, 1);
    assert.strictEqual(data.totals.manualCategories.buoniPostali.count, 1);
    assert.strictEqual(data.totals.manualCategories.tfr.count, 1);
    assert.strictEqual(data.totals.manualCategories.fondiPensione.count, 0);

    assert.strictEqual(data.totals.marketAssetsCount, 1);
    assert.strictEqual(data.totals.marketAssetsValue, 1000); // 10 * 100
  });

  test('7. Desktop Reports view (/reports) includes dedicated PDF sections for each manual category with LORDO, Tassazione and NETTO', async () => {
    const res = await fetch(`${baseUrl}/reports`, {
      headers: { Cookie: `token=${authToken}` }
    });
    assert.strictEqual(res.status, 200);
    const html = await res.text();
    assert.ok(html.includes('Prospetto Depositi Vincolati, Buoni Postali, TFR & Fondi Pensione'));
    assert.ok(html.includes('Non Quotati Live'));
    assert.ok(html.includes('Aggiornamento Manuale'));
    assert.ok(html.includes('Conti Deposito Vincolati'));
    assert.ok(html.includes('Buoni Fruttiferi Postali'));
    assert.ok(html.includes('Trattamento Fine Rapporto (TFR)'));
    assert.ok(html.includes('Fondi Pensione & Previdenza'));
    assert.ok(html.includes('Capitale Versato'));
    assert.ok(html.includes('Valore LORDO'));
    assert.ok(html.includes('Rendimento LORDO'));
    assert.ok(html.includes('TASSAZIONE Prevista'));
    assert.ok(html.includes('NETTO Previsto'));
  });

  test('8. Mobile Reports view (/reports?view=mobile) includes dedicated mobile section with LORDO, Tassazione and NETTO', async () => {
    const res = await fetch(`${baseUrl}/reports?view=mobile`, {
      headers: { Cookie: `token=${authToken}` }
    });
    assert.strictEqual(res.status, 200);
    const html = await res.text();
    assert.ok(html.includes('Depositi, Buoni, TFR & Pensione'));
    assert.ok(html.includes('DEP. VINCOLATO'));
    assert.ok(html.includes('BUONO POSTALE'));
    assert.ok(html.includes('TFR'));
    assert.ok(html.includes('Valore NETTO:'));
    assert.ok(html.includes('Tassazione:'));
  });

  test('9. Settings desktop and mobile views include select options for manual asset types', async () => {
    const resDesktop = await fetch(`${baseUrl}/settings`, {
      headers: { Cookie: `token=${authToken}` }
    });
    const htmlDesktop = await resDesktop.text();
    assert.ok(htmlDesktop.includes('value="DEPOSITO_VINCOLATO"'));
    assert.ok(htmlDesktop.includes('value="BUONO_POSTALE"'));
    assert.ok(htmlDesktop.includes('value="TFR"'));
    assert.ok(htmlDesktop.includes('value="FONDO_PENSIONE"'));

    const resMobile = await fetch(`${baseUrl}/settings?view=mobile`, {
      headers: { Cookie: `token=${authToken}` }
    });
    const htmlMobile = await resMobile.text();
    assert.ok(htmlMobile.includes('value="DEPOSITO_VINCOLATO"'));
    assert.ok(htmlMobile.includes('value="BUONO_POSTALE"'));
    assert.ok(htmlMobile.includes('value="TFR"'));
    assert.ok(htmlMobile.includes('value="FONDO_PENSIONE"'));
  });

  test('10. ensureAssetExists and transactions creation auto-classifies CD_IFIS as DEPOSITO_VINCOLATO with MANUAL source', async () => {
    // Add transaction with assetTicker CD_IFIS
    const resTx = await fetch(`${baseUrl}/api/transactions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
      body: JSON.stringify({
        portfolioId: testPortfolioId,
        type: 'BUY',
        assetTicker: 'CD_IFIS',
        date: '2026-11-18',
        quantity: 1,
        price: 95000,
        amount: 95000
      })
    });
    const dataTx = await resTx.json();
    assert.strictEqual(resTx.status, 201);
    assert.strictEqual(dataTx.success, true);

    const assetRow = db.prepare('SELECT * FROM assets WHERE ticker = ?').get('CD_IFIS');
    assert.ok(assetRow, 'Asset CD_IFIS must exist in DB');
    assert.strictEqual(assetRow.type, 'DEPOSITO_VINCOLATO', 'CD_IFIS must be classified as DEPOSITO_VINCOLATO');
    assert.strictEqual(assetRow.dataSource, 'MANUAL', 'CD_IFIS must have dataSource MANUAL');
  });

  test('11. Frontend dashboard.js classifies CD_IFIS into DEPOSITI VINCOLATI and preserves equities in AZIONI EUR', () => {
    const vm = require('vm');
    const code = fs.readFileSync(path.join(__dirname, '../public/dashboard.js'), 'utf8');

    const evalEnv = vm.createContext({
      localStorage: { getItem: () => null, setItem: () => {} },
      document: { getElementById: () => null, querySelector: () => ({}), addEventListener: () => {} },
      window: {}
    });

    vm.runInContext(code, evalEnv);
    const d = evalEnv.window.FolioTrackDashboard;

    // CD_IFIS must go to DEPOSITI VINCOLATI even if type is erroneously passed as EQUITY or omitted
    const catCdIfis = d.getAssetCategoryInfo('EQUITY', 'EUR', 'CD_IFIS');
    assert.strictEqual(catCdIfis.key, 'DEPOSITI VINCOLATI');

    const catIsp = d.getAssetCategoryInfo('EQUITY', 'EUR', 'ISP.MI');
    assert.strictEqual(catIsp.key, 'AZIONI EUR');

    const mixedHoldings = [
      { ticker: 'ISP.MI', type: 'EQUITY', currency: 'EUR', quantity: 50, marketValue: 200, dayPnlEur: 5, changePercent: 1.5 },
      { ticker: 'CD_IFIS', type: 'DEPOSITO_VINCOLATO', currency: 'EUR', quantity: 1, marketValue: 95000, dayPnlEur: 0, changePercent: 0 }
    ];

    const grouped = d.groupHoldingsByCategory(mixedHoldings);
    const catAzioni = grouped.find(g => g.key === 'AZIONI EUR');
    const catDep = grouped.find(g => g.key === 'DEPOSITI VINCOLATI');

    assert.ok(catAzioni, 'AZIONI EUR category must be present');
    assert.strictEqual(catAzioni.holdings.length, 1);
    assert.strictEqual(catAzioni.holdings[0].ticker, 'ISP.MI');

    assert.ok(catDep, 'DEPOSITI VINCOLATI category must be present');
    assert.strictEqual(catDep.holdings.length, 1);
    assert.strictEqual(catDep.holdings[0].ticker, 'CD_IFIS');
  });

  test('12. Fondo Pensione position is partitioned into fondiPensione with 20% taxRate and gross/tax/net detail', async () => {
    // Buy Fondo Pensione units (100 units at 150 = 15000, currentPrice = 160 -> value = 16000, gain = +1000)
    await fetch(`${baseUrl}/api/transactions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
      body: JSON.stringify({
        portfolioId: testPortfolioId,
        type: 'BUY',
        assetTicker: 'FONDO-COMETA-CRESCITA',
        date: '2026-03-01',
        quantity: 100,
        price: 150.00
      })
    });

    // Update current price of Fondo Pensione to 160
    await fetch(`${baseUrl}/api/assets/FONDO-COMETA-CRESCITA`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
      body: JSON.stringify({ currentPrice: 160.00 })
    });

    const res = await fetch(`${baseUrl}/api/reports/portfolio-data?portfolioId=${testPortfolioId}`, {
      headers: { Authorization: `Bearer ${authToken}` }
    });
    const data = await res.json();
    assert.strictEqual(res.status, 200);

    const port = data.portfolios[0];
    assert.strictEqual(port.hasFondiPensione, true);
    assert.ok(port.manualCategories.fondiPensione);
    const fp = port.manualCategories.fondiPensione;
    assert.strictEqual(fp.count, 1);
    assert.strictEqual(fp.investedCapital, 15000.00);
    assert.strictEqual(fp.grossValue, 16000.00);
    assert.strictEqual(fp.grossGain, 1000.00);
    assert.strictEqual(fp.taxRate, 0.20);
    assert.strictEqual(fp.taxRateFormatted, '20%');
    assert.strictEqual(fp.estimatedTax, 200.00); // 1000 * 0.20
    assert.strictEqual(fp.netGain, 800.00); // 1000 - 200
    assert.strictEqual(fp.netValue, 15800.00); // 16000 - 200

    // All 4 categories are now active in the report
    assert.strictEqual(port.hasContiDeposito, true);
    assert.strictEqual(port.hasBuoniPostali, true);
    assert.strictEqual(port.hasTfr, true);
    assert.strictEqual(port.hasFondiPensione, true);
  });

  test('13. Reports API and PDF export value all portfolios and manual categories regardless of include_in_totals switch', async () => {
    // 1. Create a dedicated portfolio for Buoni Postali with include_in_totals = 0
    const pRes = await fetch(`${baseUrl}/api/portfolios`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`
      },
      body: JSON.stringify({
        name: 'Portafoglio Buoni Postali Dedicato',
        type: 'Investimento',
        currency: 'EUR',
        initialCash: 20000,
        include_in_totals: 0
      })
    });
    const pData = await pRes.json();
    assert.strictEqual(pData.success, true);
    const dedicatedPId = pData.portfolio.id;
    assert.strictEqual(pData.portfolio.include_in_totals, 0);

    // 2. Add a Buono Postale in this dedicated portfolio
    await fetch(`${baseUrl}/api/assets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
      body: JSON.stringify({
        ticker: 'BFP-RINNOVO-2026',
        name: 'Buono Fruttifero Postale Rinnovo',
        type: 'BUONO_POSTALE',
        currency: 'EUR',
        currentPrice: 15000.00
      })
    });

    await fetch(`${baseUrl}/api/transactions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
      body: JSON.stringify({
        portfolioId: dedicatedPId,
        type: 'BUY',
        assetTicker: 'BFP-RINNOVO-2026',
        date: '2026-01-15',
        quantity: 1,
        price: 15000.00
      })
    });

    // 3. Query consolidated GET /api/reports/portfolio-data (portfolioId=all)
    const repRes = await fetch(`${baseUrl}/api/reports/portfolio-data`, {
      headers: { Authorization: `Bearer ${authToken}` }
    });
    const repData = await repRes.json();
    assert.strictEqual(repRes.status, 200);
    assert.strictEqual(repData.success, true);

    // Verify dedicated portfolio with include_in_totals = 0 IS included in reports
    const foundDedicated = repData.portfolios.find(p => p.id === dedicatedPId);
    assert.ok(foundDedicated, 'Dedicated portfolio with include_in_totals = 0 must be included in reports');
    assert.strictEqual(foundDedicated.includeInTotals, false);
    assert.strictEqual(foundDedicated.hasBuoniPostali, true);

    // Verify consolidated totals.manualCategories.buoniPostali includes the asset
    assert.ok(repData.totals.manualCategories.buoniPostali);
    assert.ok(repData.totals.manualCategories.buoniPostali.count >= 2, 'Must include buoni postali across all portfolios');
    assert.ok(repData.totals.manualCategories.buoniPostali.grossValue >= 20000, 'Must include value from all portfolios');

    // Verify grand totals include this portfolio
    assert.ok(repData.totals.totalValue >= 20000, 'Consolidated report total value must include portfolios with include_in_totals=0');
  });
});
