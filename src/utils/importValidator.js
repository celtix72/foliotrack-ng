/**
 * Import Validation & Health Check Engine (Wealthfolio Philosophy)
 * Evaluates CSV activity rows, detects duplicates, performs chronological
 * simulation (negative cash, short selling, future dates), and produces
 * detailed diagnostics and financial impact metrics.
 */

const { TRANSACTION_TYPES } = require('./constants');

/**
 * Normalizes symbol for duplicate detection:
 * Pure cash movements and cash pseudo-symbols ($CASH-EUR, CASH) resolve to empty string
 * so duplicate detection matches reliably regardless of whether the symbol was null or $CASH.
 */
function normalizeSymbolForDup(sym, type) {
  if (!sym) return '';
  const clean = String(sym).trim().toUpperCase();
  if (clean === 'CASH' || clean.startsWith('$CASH')) return '';
  if (['DEPOSIT', 'WITHDRAWAL', 'TRANSFER'].includes(type)) return '';
  return clean;
}

/**
 * Validates an array of parsed import activities following Wealthfolio's philosophy:
 * 1. Schema & Field Integrity: required fields, dates, numeric ranges, symbol rules.
 * 2. Duplicate Detection: composite signature matching against existing DB transactions.
 * 3. Chronological Portfolio Health Check (Wealthfolio Health Center):
 *    - Running Cash Balance Check (negative cash warnings).
 *    - Running Holdings Position Check (short selling / overselling warnings).
 *    - Future Date detection.
 *    - High commission / fee ratio warnings.
 *    - Missing FX rate for foreign currency.
 * 4. Summary & Financial Impact Metrics.
 *
 * @param {Array<object>} activities - Array of parsed transaction objects from CSV
 * @param {object} portfolio - Destination portfolio DB record
 * @param {Array<object>} existingTransactions - Current transactions in the portfolio
 * @param {Record<string, object>} tickerResolutionMap - Resolved ticker metadata
 * @returns {object} Validation result with enriched transactions and summary
 */
function validateImportActivities(activities = [], portfolio = {}, existingTransactions = [], tickerResolutionMap = {}) {
  const todayStr = new Date().toISOString().split('T')[0];
  const portfolioCurrency = (portfolio.currency || 'EUR').toUpperCase();

  // 1. Build composite key set of existing transactions for duplicate detection
  // Composite schema: date + type + symbol + quantity + price + amount
  const existingDupSet = new Set();
  const existingIdMap = new Map();

  for (const et of existingTransactions) {
    const type = (et.type || '').trim().toUpperCase();
    const sym = normalizeSymbolForDup(et.assetTicker, type);
    const qty = Math.round((Number(et.quantity) || 0) * 1e4);
    const price = Math.round((Number(et.price) || 0) * 1e2);
    const amount = Math.round((Number(et.amount) || 0) * 1e2);
    const key = `${et.date}|${type}|${sym}|${qty}|${price}|${amount}`;
    existingDupSet.add(key);
    existingIdMap.set(key, et.id);
  }

  // 2. Build initial portfolio holding quantities and cash balance from existing transactions
  const hasInitialDeposit = existingTransactions.some(t => t.type === 'DEPOSIT' && t.notes === 'Deposito iniziale');
  let simulatedCash = hasInitialDeposit ? 0.0 : (Number(portfolio.initialCash) || 0.0);
  const simulatedHoldings = {};

  const sortedExisting = [...existingTransactions].sort((a, b) => {
    const dDiff = new Date(a.date).getTime() - new Date(b.date).getTime();
    if (dDiff !== 0) return dDiff;
    return (a.id || 0) - (b.id || 0);
  });

  for (const tx of sortedExisting) {
    const t = (tx.assetTicker || '').toUpperCase().trim();
    const type = (tx.type || '').toUpperCase();
    const qty = Number(tx.quantity) || 0;
    const amount = Number(tx.amount) || 0;

    switch (type) {
      case 'DEPOSIT':
      case 'DIVIDEND':
      case 'INTEREST':
        simulatedCash += amount;
        break;
      case 'WITHDRAWAL':
      case 'FEE':
      case 'TAX':
        simulatedCash -= amount;
        break;
      case 'BUY':
        simulatedCash -= amount;
        if (t) simulatedHoldings[t] = (simulatedHoldings[t] || 0) + qty;
        break;
      case 'SELL':
        simulatedCash += amount;
        if (t) simulatedHoldings[t] = Math.max(0, (simulatedHoldings[t] || 0) - qty);
        break;
      case 'SPLIT':
        if (t && qty > 0) simulatedHoldings[t] = (simulatedHoldings[t] || 0) * qty;
        break;
      case 'TRANSFER':
        simulatedCash += amount;
        break;
    }
  }

  // 3. Process incoming activities chronologically for timeline consistency checks
  // Preserve original CSV row index for selective commit
  const indexedActivities = activities.map((act, originalIndex) => ({
    ...act,
    originalIndex
  }));

  const sortedIncoming = [...indexedActivities].sort((a, b) => {
    return new Date(a.date || '1970-01-01').getTime() - new Date(b.date || '1970-01-01').getTime();
  });

  const validatedTransactions = [];
  let validCount = 0;
  let warningCount = 0;
  let duplicateCount = 0;
  let errorCount = 0;
  let estimatedNetCashFlow = 0;
  let estimatedTotalInvestment = 0;
  const affectedTickersSet = new Set();
  const healthIssuesSummary = [];

  let negativeCashCount = 0;
  let oversellingCount = 0;
  let futureDateCount = 0;

  for (const item of sortedIncoming) {
    const issues = [];
    const rawType = (item.type || '').trim().toUpperCase();
    const type = TRANSACTION_TYPES.includes(rawType) ? rawType : null;
    const symbol = item.assetTicker ? item.assetTicker.trim().toUpperCase() : null;
    const qty = Number(item.quantity) || 0;
    const price = Number(item.price) || 0;
    const amount = Number(item.amount) || 0;
    const fee = Number(item.commission) || 0;
    const fxRate = Number(item.exchangeRate) || 1.0;
    const itemCurrency = (item.currency || portfolioCurrency).toUpperCase();

    if (symbol) affectedTickersSet.add(symbol);

    // --- Check 1: Date validity ---
    if (!item.date || !/^\d{4}-\d{2}-\d{2}$/.test(item.date)) {
      issues.push({
        severity: 'error',
        code: 'INVALID_DATE',
        message: `Data mancante o non valida: "${item.date || ''}"`
      });
    } else if (item.date > todayStr) {
      futureDateCount++;
      issues.push({
        severity: 'warning',
        code: 'FUTURE_DATE',
        message: `Data futura: ${item.date} (movimento registrato oltre la data odierna)`
      });
    }

    // --- Check 2: Transaction Type ---
    if (!type) {
      issues.push({
        severity: 'error',
        code: 'UNKNOWN_TYPE',
        message: `Tipo operazione non riconosciuto: "${item.type || ''}". Valori supportati: ${TRANSACTION_TYPES.join(', ')}`
      });
    }

    // --- Check 3: Symbol required for security transactions ---
    const isSecurityType = ['BUY', 'SELL', 'DIVIDEND', 'SPLIT'].includes(type);
    if (isSecurityType && (!symbol || symbol === 'UNKNOWN')) {
      issues.push({
        severity: 'error',
        code: 'MISSING_SYMBOL',
        message: `Ticker / simbolo obbligatorio per operazioni di tipo ${type || 'investimento'}`
      });
    }

    // --- Check 4: Quantity & Price sanity ---
    if (['BUY', 'SELL'].includes(type)) {
      if (qty <= 0) {
        issues.push({
          severity: 'error',
          code: 'INVALID_QUANTITY',
          message: `Quantità obbligatoria e maggiore di zero per operazione ${type} (trovato: ${qty})`
        });
      }
      if (price <= 0) {
        issues.push({
          severity: 'warning',
          code: 'ZERO_PRICE',
          message: `Prezzo unitario registrato pari a zero per operazione ${type}`
        });
      }
    }

    // --- Check 5: Duplicate Detection ---
    const testQty = Math.round(qty * 1e4);
    const testPrice = Math.round(price * 1e2);
    const testAmount = Math.round(amount * 1e2);
    const testSym = normalizeSymbolForDup(symbol, type);
    const dupKey = `${item.date}|${type}|${testSym}|${testQty}|${testPrice}|${testAmount}`;
    const isDuplicate = existingDupSet.has(dupKey);
    const duplicateId = isDuplicate ? existingIdMap.get(dupKey) : null;

    if (isDuplicate) {
      issues.push({
        severity: 'duplicate',
        code: 'DUPLICATE_ROW',
        message: `Transazione identica già presente nel portafoglio (ID #${duplicateId})`
      });
    }

    // --- Check 6: Chronological Timeline Health (Wealthfolio Health Center) ---
    if (!isDuplicate && type) {
      if (type === 'BUY') {
        const gross = (fxRate !== 1.0 && fxRate > 0) ? ((qty * price + fee) / fxRate) : (qty * price + fee);
        const cashImpact = amount > 0 ? amount : (gross + (Number(item.tax) || 0));
        if (simulatedCash - cashImpact < -1.0) {
          negativeCashCount++;
          issues.push({
            severity: 'warning',
            code: 'NEGATIVE_CASH',
            message: `Rischio cassa negativa: il saldo cassa stimato scenderebbe a €${(simulatedCash - cashImpact).toFixed(2)} (potrebbe mancare un deposito preventivo)`
          });
        }
        simulatedCash -= cashImpact;
        if (symbol) {
          simulatedHoldings[symbol] = (simulatedHoldings[symbol] || 0) + qty;
        }
      } else if (type === 'SELL') {
        const gross = (fxRate !== 1.0 && fxRate > 0) ? ((qty * price - fee) / fxRate) : (qty * price - fee);
        const cashImpact = amount > 0 ? amount : Math.max(0, gross - (Number(item.tax) || 0));
        const availableQty = symbol ? (simulatedHoldings[symbol] || 0) : 0;
        if (qty > availableQty + 1e-5) {
          oversellingCount++;
          issues.push({
            severity: 'warning',
            code: 'INSUFFICIENT_HOLDINGS',
            message: `Vendita allo scoperto / quantità insufficiente: vendute ${qty} quote ma disponibili in portafoglio solo ${availableQty.toFixed(4)}`
          });
        }
        if (symbol) {
          simulatedHoldings[symbol] = Math.max(0, availableQty - qty);
        }
        simulatedCash += cashImpact;
      } else if (type === 'WITHDRAWAL') {
        if (simulatedCash - amount < -1.0) {
          negativeCashCount++;
          issues.push({
            severity: 'warning',
            code: 'NEGATIVE_CASH',
            message: `Rischio cassa negativa: prelievo di €${amount.toFixed(2)} a fronte di cassa stimata €${simulatedCash.toFixed(2)}`
          });
        }
        simulatedCash -= amount;
      } else if (['DEPOSIT', 'DIVIDEND', 'INTEREST'].includes(type)) {
        simulatedCash += amount;
      } else if (['FEE', 'TAX'].includes(type)) {
        simulatedCash -= amount;
      }
    }

    // --- Check 7: Excessive Commission Warning (> 15% of trade) ---
    if (fee > 0 && amount > 50 && fee > (amount * 0.15)) {
      issues.push({
        severity: 'warning',
        code: 'HIGH_COMMISSION',
        message: `Commissioni elevate: €${fee.toFixed(2)} (${((fee / amount) * 100).toFixed(1)}% del controvalore di €${amount.toFixed(2)})`
      });
    }

    // --- Check 8: Foreign Currency without explicit FX rate ---
    if (itemCurrency && itemCurrency !== portfolioCurrency && (!fxRate || fxRate === 1.0)) {
      issues.push({
        severity: 'warning',
        code: 'MISSING_FX_RATE',
        message: `Valuta operazione (${itemCurrency}) diversa da valuta portafoglio (${portfolioCurrency}) con cambio non specificato (assunto 1.0)`
      });
    }

    // Determine Final Status
    const hasErrors = issues.some(i => i.severity === 'error');
    const hasWarnings = issues.some(i => i.severity === 'warning');

    let validationStatus = 'VALID';
    if (hasErrors) {
      validationStatus = 'ERROR';
      errorCount++;
    } else if (isDuplicate) {
      validationStatus = 'DUPLICATE';
      duplicateCount++;
    } else if (hasWarnings) {
      validationStatus = 'WARNING';
      warningCount++;
      validCount++;
    } else {
      validationStatus = 'VALID';
      validCount++;
    }

    const canImport = validationStatus !== 'ERROR' && !isDuplicate;
    const selected = canImport; // Default selected if valid or warning

    // Track financial impact for importable rows
    if (canImport) {
      if (['DEPOSIT', 'DIVIDEND', 'INTEREST', 'SELL'].includes(type)) {
        estimatedNetCashFlow += amount;
      } else if (['WITHDRAWAL', 'BUY', 'FEE', 'TAX'].includes(type)) {
        estimatedNetCashFlow -= amount;
      }

      if (type === 'BUY') estimatedTotalInvestment += amount;
      if (type === 'SELL') estimatedTotalInvestment -= amount;
    }

    const resAsset = symbol ? tickerResolutionMap[symbol] : null;

    validatedTransactions.push({
      ...item,
      assetTicker: symbol,
      type: type || rawType,
      currency: itemCurrency,
      validationStatus,
      issues,
      isDuplicate,
      duplicateId,
      canImport,
      selected,
      assetMatch: resAsset ? {
        source: resAsset.source,
        name: resAsset.name,
        matched: resAsset.matched,
        provider: resAsset.provider || null
      } : null
    });
  }

  // Restore original order as presented in CSV
  validatedTransactions.sort((a, b) => a.originalIndex - b.originalIndex);

  // Health Issues Summary
  if (negativeCashCount > 0) {
    healthIssuesSummary.push(`${negativeCashCount} movimento/i causerebbero un saldo cassa negativo nel portafoglio`);
  }
  if (oversellingCount > 0) {
    healthIssuesSummary.push(`${oversellingCount} vendita/e superano la quantità di quote effettivamente disponibile`);
  }
  if (futureDateCount > 0) {
    healthIssuesSummary.push(`${futureDateCount} movimento/i riportano una data futura rispetto ad oggi`);
  }
  if (duplicateCount > 0) {
    healthIssuesSummary.push(`${duplicateCount} movimento/i sono già presenti nel portafoglio (duplicati)`);
  }

  const dates = validatedTransactions.map(t => t.date).filter(Boolean).sort();
  const dateRange = dates.length > 0 ? { start: dates[0], end: dates[dates.length - 1] } : null;

  return {
    transactions: validatedTransactions,
    summary: {
      totalRows: activities.length,
      validCount,
      warningCount,
      duplicateCount,
      errorCount,
      newCount: validCount, // rows that are not duplicates and not errors
      importableCount: validatedTransactions.filter(t => t.canImport).length,
      estimatedNetCashFlow,
      estimatedTotalInvestment,
      affectedTickers: Array.from(affectedTickersSet),
      dateRange,
      healthIssues: healthIssuesSummary
    }
  };
}

module.exports = {
  validateImportActivities
};
