/**
 * Script to realign Portfolio DIRECTA (ID: 2) with authentic Directa SIM statement.
 */
const fs = require('fs');
const path = require('path');
const { getDb } = require('../src/db');
const { recalculatePortfolio } = require('../src/routes/portfolios');
const { recalculateAndReconstructHistoricalPerformance } = require('../src/routes/history');
const { recalculateDividendProjections } = require('../src/routes/dividends');
const { calculateHoldingsAndMetrics } = require('../src/utils/finance');

const rawPath = '/Users/mauro/.gemini/antigravity/brain/ea25591f-5f7a-4f34-9ece-4edaffb0380b/scratch/directa_parsed_raw.json';
const raw = JSON.parse(fs.readFileSync(rawPath, 'utf8'));
const db = getDb();

function normalizeTicker(rawTicker) {
  if (!rawTicker) return '';
  return rawTicker.replace(/^\./, '').replace(/^X\./, '').replace(/^I\./, '').replace(/^1/, '').replace(/\..*$/, '');
}

console.log('Starting realignment for DIRECTA (portfolioId = 2)...');

const runRealignment = db.transaction(() => {
  // 1. Remove invalid dividends
  const delDivs = db.prepare('DELETE FROM transactions WHERE portfolioId = 2 AND id IN (40, 70, 152)').run();
  console.log(`Removed ${delDivs.changes} invalid dividends (SRG.MI, NEXI.MI, ISP.MI).`);

  // 2. Remove fake withdrawals
  const delWithdrawals = db.prepare('DELETE FROM transactions WHERE portfolioId = 2 AND id IN (161, 175)').run();
  console.log(`Removed ${delWithdrawals.changes} fake withdrawals (528€, 37€).`);

  // 3. Remove single inaccurate TAX
  const delTax = db.prepare('DELETE FROM transactions WHERE portfolioId = 2 AND id = 150').run();
  console.log(`Removed ${delTax.changes} inaccurate TAX transaction (id: 150).`);

  // 4. Remove fake split
  const delSplit = db.prepare('DELETE FROM transactions WHERE portfolioId = 2 AND id = 163').run();
  console.log(`Removed ${delSplit.changes} fake split transaction (id: 163).`);

  // 5. Fix dates and tickers of trade quirks
  db.prepare(`UPDATE transactions SET assetTicker = '3NLV.MI', quantity = 110, price = 13.584, commission = 5, amount = 1499.24 WHERE id = 54`).run();
  db.prepare(`UPDATE transactions SET assetTicker = '3NLV.MI', quantity = 110, price = 8.445, commission = 5, amount = 923.95 WHERE id = 57`).run();
  db.prepare(`UPDATE transactions SET date = '2025-06-06' WHERE id = 13`).run();
  db.prepare(`UPDATE transactions SET date = '2025-06-17' WHERE id = 16`).run();

  // Fix TIT trades:
  db.prepare(`UPDATE transactions SET quantity = 21105, price = 0.2369, amount = 4999.77 WHERE id = 19`).run();
  db.prepare(`UPDATE transactions SET quantity = 21105, price = 0.2479, amount = 5226.93, commission = 5 WHERE id = 24`).run();
  db.prepare(`UPDATE transactions SET quantity = 20500, price = 0.244, amount = 5007, commission = 5 WHERE id = 26`).run();
  db.prepare(`UPDATE transactions SET quantity = 20500, price = 0.222, amount = 4546, commission = 5 WHERE id = 31`).run();
  db.prepare(`UPDATE transactions SET quantity = 20000, price = 0.220, amount = 4404.4, commission = 4.4 WHERE id = 33`).run();
  db.prepare(`UPDATE transactions SET quantity = 20000, price = 0.3522, amount = 7039, commission = 5 WHERE id = 64`).run();

  db.prepare(`UPDATE transactions SET amount = 4.40, tax = 1.54 WHERE id = 15`).run();
  db.prepare(`UPDATE transactions SET amount = 7.65, tax = 2.69 WHERE id = 46`).run();
  db.prepare(`UPDATE transactions SET amount = 18.12, tax = 6.36 WHERE id = 99`).run();
  db.prepare(`UPDATE transactions SET amount = 9.06, tax = 3.18 WHERE id = 120`).run();

  // 6. Insert 5 missing dividends
  const insertTx = db.prepare(`
    INSERT INTO transactions (portfolioId, type, assetTicker, date, quantity, price, commission, tax, exchangeRate, amount, notes, createdAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `);

  insertTx.run(2, 'DIVIDEND', '1ASML.MI', '2025-05-07', 9, 3.1278, 0, 7.32, 1, 20.83, 'Directa stacco dividendo ASML');
  insertTx.run(2, 'DIVIDEND', 'MSF.DE', '2026-06-12', 15, 0.5507, 0, 2.15, 1, 6.11, 'Directa stacco dividendo Microsoft');
  insertTx.run(2, 'DIVIDEND', 'MSF.DE', '2026-09-11', 15, 0.5493, 0, 2.14, 1, 6.10, 'Directa stacco dividendo Microsoft');
  insertTx.run(2, 'DIVIDEND', 'KSPI', '2026-09-18', 60, 1.894, 0, 29.55, 1, 84.09, 'Directa stacco dividendo Kaspi');
  insertTx.run(2, 'DIVIDEND', 'CRM', '2026-10-09', 35, 0.3334, 0, 3.03, 1, 8.64, 'Directa stacco dividendo Salesforce');
  console.log('Inserted 5 missing dividends.');

  // 7. Insert the 48 taxes and fees
  const nonOrders = raw.filter(r => !r.riferimentoOrdine);
  let insertedFees = 0;
  nonOrders.forEach(r => {
    const amt = Math.abs(r.importoEuro);
    switch (r.tipoOperazione) {
      case 'Ritenuta su plusvalenza':
        insertTx.run(2, 'TAX', null, r.dataOperazione, 1, 0, 0, amt, 1, amt, 'Ritenuta su plusvalenza Directa');
        insertedFees++;
        break;
      case 'Bollo portafoglio titoli*':
        insertTx.run(2, 'TAX', null, r.dataOperazione, 1, 0, 0, amt, 1, amt, 'Bollo portafoglio titoli Directa');
        insertedFees++;
        break;
      case 'Tobin tax italia':
        insertTx.run(2, 'TAX', null, r.dataOperazione, 1, 0, 0, amt, 1, amt, 'Tobin tax italia Directa');
        insertedFees++;
        break;
      case 'Prel.cash in lieu/adr fee':
        insertTx.run(2, 'FEE', r.ticker ? r.ticker.replace(/^\./, '') : null, r.dataOperazione, 1, 0, amt, 0, 1, amt, 'Commissione ADR fee / cash in lieu Directa');
        insertedFees++;
        break;
      case 'Int.passivi finanziamento':
        insertTx.run(2, 'FEE', null, r.dataOperazione, 1, 0, amt, 0, 1, amt, 'Interessi passivi finanziamento Directa');
        insertedFees++;
        break;
      case 'Addebito canone sms alert':
        insertTx.run(2, 'FEE', null, r.dataOperazione, 1, 0, amt, 0, 1, amt, 'Addebito canone SMS alert Directa');
        insertedFees++;
        break;
    }
  });
  console.log(`Inserted ${insertedFees} authentic taxes and fees.`);

  // 8. Align matched trades with exact Directa execution figures
  const ordersMap = new Map();
  raw.forEach(r => {
    if (r.riferimentoOrdine) {
      if (!ordersMap.has(r.riferimentoOrdine)) ordersMap.set(r.riferimentoOrdine, []);
      ordersMap.get(r.riferimentoOrdine).push(r);
    }
  });

  const rawOrders = [];
  ordersMap.forEach((items, ref) => {
    const main = items.find(i => i.tipoOperazione === 'Acquisto' || i.tipoOperazione === 'Vendita') || items[0];
    const type = main.tipoOperazione === 'Acquisto' ? 'BUY' : 'SELL';
    const totalQty = items.reduce((s, i) => (i.tipoOperazione === 'Acquisto' || i.tipoOperazione === 'Vendita' ? s + i.quantita : s), 0);
    const totalEur = items.reduce((s, i) => s + i.importoEuro, 0);
    const commEur = items.filter(i => i.tipoOperazione === 'Commissioni').reduce((s, i) => s + Math.abs(i.importoEuro), 0);
    const taxEur = items.filter(i => i.tipoOperazione === 'Rit. etf').reduce((s, i) => s + Math.abs(i.importoEuro), 0);

    rawOrders.push({
      orderRef: ref,
      dateOp: main.dataOperazione,
      type,
      ticker: main.ticker,
      totalQty,
      commEur,
      taxEur,
      netEur: totalEur
    });
  });

  const dbTrades = db.prepare(`SELECT * FROM transactions WHERE portfolioId = 2 AND (type = 'BUY' OR type = 'SELL')`).all();
  const remainingDb = [...dbTrades];
  const updateTradeStmt = db.prepare('UPDATE transactions SET amount = ?, commission = ?, tax = ? WHERE id = ?');
  let updatedTrades = 0;

  rawOrders.forEach(ord => {
    const normTicker = normalizeTicker(ord.ticker);
    let bestIdx = -1;
    let bestScore = 999999;

    for (let i = 0; i < remainingDb.length; i++) {
      const dbt = remainingDb[i];
      if (dbt.type !== ord.type) continue;
      const dbtNorm = normalizeTicker(dbt.assetTicker);
      const tickerMatch = (dbtNorm === normTicker) || (dbt.assetTicker && dbt.assetTicker.includes(normTicker)) || (normTicker && normTicker.includes(dbtNorm));
      const qtyMatch = (Math.abs(dbt.quantity - ord.totalQty) < 0.001);

      if (tickerMatch || qtyMatch) {
        const daysDiff = Math.abs(new Date(dbt.date) - new Date(ord.dateOp)) / (1000 * 3600 * 24);
        let score = daysDiff;
        if (!tickerMatch) score += 1000;
        if (!qtyMatch) score += 500;
        if (score < bestScore && daysDiff < 400) {
          bestScore = score;
          bestIdx = i;
        }
      }
    }

    if (bestIdx !== -1) {
      const dbt = remainingDb.splice(bestIdx, 1)[0];
      const exactNet = Math.abs(ord.netEur);
      updateTradeStmt.run(exactNet, ord.commEur, ord.taxEur, dbt.id);
      updatedTrades++;
    }
  });
  console.log(`Updated ${updatedTrades} trades with exact amounts.`);

  // 9. Align existing dividends to exact figures
  const divTypes = ['Incasso dividendi usa', 'Incasso dividendi esteri', 'Incasso dividendi xetra', 'Incasso dividendi italia', 'Provento etf'];
  const taxTypes = ['Rit.div.usa', 'Ritenuta dividendi esteri', 'Rit.div.xetra', 'Ritenuta dividendi italia', 'Rit.provento etf'];
  const rawDivs = raw.filter(r => divTypes.includes(r.tipoOperazione));
  const rawDivTaxes = raw.filter(r => taxTypes.includes(r.tipoOperazione));

  const pairedRawDivs = rawDivs.map(inc => {
    const taxIdx = rawDivTaxes.findIndex(t => t.dataOperazione === inc.dataOperazione && t.ticker === inc.ticker);
    let taxRow = null;
    if (taxIdx !== -1) taxRow = rawDivTaxes.splice(taxIdx, 1)[0];
    const grossEur = inc.importoEuro;
    const taxEur = taxRow ? Math.abs(taxRow.importoEuro) : 0;
    const netEur = grossEur - taxEur;
    return { date: inc.dataOperazione, ticker: inc.ticker, netEur, taxEur };
  });

  const updateDivStmt = db.prepare('UPDATE transactions SET amount = ?, tax = ? WHERE id = ?');
  const dbDivs = db.prepare(`SELECT * FROM transactions WHERE portfolioId = 2 AND type = 'DIVIDEND'`).all();
  const remDivs = [...dbDivs];
  let updatedDivs = 0;

  pairedRawDivs.forEach(rd => {
    const normTicker = normalizeTicker(rd.ticker);
    let bestIdx = -1;
    let bestScore = 999999;
    for (let i = 0; i < remDivs.length; i++) {
      const d = remDivs[i];
      const dNorm = normalizeTicker(d.assetTicker);
      const tickerMatch = (dNorm === normTicker);
      if (!tickerMatch) continue;
      const daysDiff = Math.abs(new Date(d.date) - new Date(rd.date)) / (1000 * 3600 * 24);
      if (daysDiff < bestScore && daysDiff <= 45) {
        bestScore = daysDiff;
        bestIdx = i;
      }
    }
    if (bestIdx !== -1) {
      const d = remDivs.splice(bestIdx, 1)[0];
      updateDivStmt.run(rd.netEur, rd.taxEur, d.id);
      updatedDivs++;
    }
  });
  console.log(`Updated ${updatedDivs} dividends with exact amounts.`);
});

runRealignment();

// Recalculate portfolio metrics
console.log('Recalculating portfolio metrics...');
const updated = recalculatePortfolio(2);
console.log('Realigned metrics for DIRECTA:');
console.log('  currentCash:    €', updated.metrics.currentCash.toFixed(2));
console.log('  totalValue:     €', updated.metrics.totalValue.toFixed(2));
console.log('  investedCapital:€', updated.metrics.investedCapital.toFixed(2));
console.log('  totalDividends: €', updated.metrics.totalDividends.toFixed(2));
console.log('  holdings count:  ', updated.metrics.holdings.length);

recalculateDividendProjections(2);
console.log('Dividend projections recalculated.');

async function rebuildHistory() {
  console.log('Reconstructing historical performance...');
  try {
    await recalculateAndReconstructHistoricalPerformance(2, {
      daysBack: 1825,
      syncQuotes: false,
      userId: 1,
      userRole: 'admin'
    });
    console.log('Historical performance reconstructed successfully.');
  } catch (err) {
    console.error('Error reconstructing history:', err);
  }
}

rebuildHistory().then(() => {
  console.log('=== REALIGNMENT FULLY COMPLETED ===');
  process.exit(0);
});
