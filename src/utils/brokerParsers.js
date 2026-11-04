/**
 * Broker CSV Parser with Auto-Detection for FolioTrack
 * Supports Directa SIM, Banca IFIS, Wealthfolio, and Generic broker exports.
 */

const { TRANSACTION_TYPES, ASSET_TYPES } = require('./constants');

/**
 * Normalizes a header or string by trimming, converting to lower case,
 * removing accents and replacing non-alphanumeric characters with underscores.
 *
 * @param {string} str
 * @returns {string}
 */
function normalizeString(str) {
  if (!str) return '';
  return str
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
}

/**
 * Detects whether the delimiter is semicolon (;), comma (,), or tab (\t).
 *
 * @param {string} csvText
 * @returns {string}
 */
function detectDelimiter(csvText) {
  const firstLines = csvText.split(/\r?\n/).slice(0, 5).filter(l => l.trim().length > 0);
  if (firstLines.length === 0) return ',';

  let semicolonCount = 0;
  let commaCount = 0;
  let tabCount = 0;

  for (const line of firstLines) {
    semicolonCount += (line.match(/;/g) || []).length;
    commaCount += (line.match(/,/g) || []).length;
    tabCount += (line.match(/\t/g) || []).length;
  }

  if (tabCount > semicolonCount && tabCount > commaCount) return '\t';
  if (semicolonCount >= commaCount) return ';';
  return ',';
}

/**
 * Parses CSV text into an array of string arrays, handling quotes and multiline fields.
 *
 * @param {string} csvText
 * @param {string} [delimiter]
 * @returns {string[][]}
 */
function parseCsvRows(csvText, delimiter = null) {
  if (!csvText || typeof csvText !== 'string') return [];
  const delim = delimiter || detectDelimiter(csvText);

  const rows = [];
  let currentRow = [];
  let currentField = '';
  let insideQuotes = false;

  for (let i = 0; i < csvText.length; i++) {
    const char = csvText[i];
    const nextChar = csvText[i + 1];

    if (char === '"') {
      if (insideQuotes && nextChar === '"') {
        // Escaped quote: ""
        currentField += '"';
        i++;
      } else {
        // Toggle quote state
        insideQuotes = !insideQuotes;
      }
    } else if (char === delim && !insideQuotes) {
      currentRow.push(currentField.trim());
      currentField = '';
    } else if ((char === '\r' || char === '\n') && !insideQuotes) {
      if (char === '\r' && nextChar === '\n') {
        i++;
      }
      currentRow.push(currentField.trim());
      if (currentRow.some(col => col.length > 0)) {
        rows.push(currentRow);
      }
      currentRow = [];
      currentField = '';
    } else {
      currentField += char;
    }
  }

  if (currentField.length > 0 || currentRow.length > 0) {
    currentRow.push(currentField.trim());
    if (currentRow.some(col => col.length > 0)) {
      rows.push(currentRow);
    }
  }

  return rows;
}

/**
 * Parses an Italian or international formatted number string into a clean float.
 * Handles thousands separators (dots in IT, commas in US/UK) and decimals.
 * Examples:
 *   "1.234,56" -> 1234.56
 *   "1,234.56" -> 1234.56
 *   "-50,00"   -> -50
 *   "€ 120,50" -> 120.5
 *
 * @param {string|number} value
 * @returns {number}
 */
function parseItalianNumber(value) {
  if (value === null || value === undefined || value === '') return 0;
  if (typeof value === 'number') return isNaN(value) ? 0 : value;

  let clean = String(value)
    .replace(/[€$£\s\u00A0]/g, '')
    .trim();

  if (!clean) return 0;

  // Handle trailing minus (e.g., "120,50-")
  let isNegative = false;
  if (clean.endsWith('-')) {
    isNegative = true;
    clean = clean.slice(0, -1).trim();
  } else if (clean.startsWith('-')) {
    isNegative = true;
    clean = clean.slice(1).trim();
  } else if (clean.startsWith('(') && clean.endsWith(')')) {
    isNegative = true;
    clean = clean.slice(1, -1).trim();
  }

  const hasComma = clean.includes(',');
  const hasDot = clean.includes('.');

  if (hasComma && hasDot) {
    const lastComma = clean.lastIndexOf(',');
    const lastDot = clean.lastIndexOf('.');
    if (lastComma > lastDot) {
      // Italian format: 1.234,56
      clean = clean.replace(/\./g, '').replace(',', '.');
    } else {
      // English format: 1,234.56
      clean = clean.replace(/,/g, '');
    }
  } else if (hasComma) {
    // Italian decimal: 1234,56
    clean = clean.replace(',', '.');
  } else if (hasDot) {
    // Check if dot might be a thousands separator without decimals (e.g. 1.000)
    const parts = clean.split('.');
    if (parts.length > 2) {
      // Multiple dots: 1.000.000
      clean = parts.join('');
    }
  }

  const result = parseFloat(clean);
  if (isNaN(result)) return 0;
  return isNegative ? -Math.abs(result) : result;
}

/**
 * Parses dates in Italian (DD/MM/YYYY, DD-MM-YYYY, DD.MM.YYYY) or ISO (YYYY-MM-DD) format.
 * Returns ISO string 'YYYY-MM-DD' or null if invalid.
 *
 * @param {string} str
 * @returns {string|null}
 */
function parseItalianDate(str) {
  if (!str) return null;
  const clean = String(str).trim();

  // YYYY-MM-DD or YYYY/MM/DD
  const isoMatch = clean.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (isoMatch) {
    const year = parseInt(isoMatch[1], 10);
    const month = String(parseInt(isoMatch[2], 10)).padStart(2, '0');
    const day = String(parseInt(isoMatch[3], 10)).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  // DD/MM/YYYY or DD-MM-YYYY or DD.MM.YYYY (optional time suffix)
  const itMatch = clean.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})/);
  if (itMatch) {
    const day = String(parseInt(itMatch[1], 10)).padStart(2, '0');
    const month = String(parseInt(itMatch[2], 10)).padStart(2, '0');
    let year = parseInt(itMatch[3], 10);
    if (year < 100) {
      year += year >= 70 ? 1900 : 2000;
    }
    return `${year}-${month}-${day}`;
  }

  return null;
}

/**
 * Identifies the broker format by analyzing header columns and content signatures.
 *
 * @param {string} csvText
 * @returns {'DIRECTA' | 'BANCA_IFIS' | 'WEALTHFOLIO' | 'GENERIC'}
 */
function detectBroker(csvText) {
  if (!csvText || typeof csvText !== 'string') return 'GENERIC';

  const rows = parseCsvRows(csvText);
  if (rows.length === 0) return 'GENERIC';

  // Find header row (usually the first row with several columns)
  let headerRow = rows[0];
  let normalizedHeaders = headerRow.map(normalizeString);

  // Look up to 5 rows in case of top metadata banners
  for (let r = 0; r < Math.min(rows.length, 5); r++) {
    const candidate = rows[r].map(normalizeString);
    if (
      candidate.includes('tipo_operazione') ||
      candidate.includes('data_contabile') ||
      candidate.includes('activitytype')
    ) {
      normalizedHeaders = candidate;
      break;
    }
  }

  const headerStr = normalizedHeaders.join(' ');

  // 1. Directa detection:
  // Directa columns: "tipo operazione", "riferimento ordine", "data operazione", "descrizione"
  const isDirecta =
    (headerStr.includes('tipo_operazione') || headerStr.includes('riferimento_ordine')) &&
    (headerStr.includes('data') || headerStr.includes('descrizione') || headerStr.includes('quantita'));

  if (isDirecta) {
    return 'DIRECTA';
  }

  // 2. Banca IFIS detection:
  // "data contabile", "causale", "importo"
  const isIfis =
    headerStr.includes('data_contabile') &&
    headerStr.includes('causale') &&
    headerStr.includes('importo');

  if (isIfis) {
    return 'BANCA_IFIS';
  }

  // 3. Wealthfolio detection:
  // "date,symbol,instrumentType,quantity,activityType,unitPrice,currency..."
  const isWealthfolio =
    headerStr.includes('activitytype') &&
    (headerStr.includes('symbol') || headerStr.includes('instrumenttype'));

  if (isWealthfolio) {
    return 'WEALTHFOLIO';
  }

  return 'GENERIC';
}

/**
 * Extracts a ticker or ISIN from description or code strings.
 *
 * @param {string} text
 * @returns {string|null}
 */
function extractTickerFromText(text) {
  if (!text) return null;
  const clean = text.trim();

  // If text is already a single ticker/token 1-15 chars (e.g. "SWDA.MI", "BTC-EUR", "BRK-B", "NVDA")
  if (/^[A-Z0-9\.\^\-]{1,15}$/i.test(clean)) {
    return clean.toUpperCase();
  }

  // Search for ISIN (2 letters + 9 alphanumeric + 1 check digit)
  const isinMatch = clean.match(/\b([A-Z]{2}[A-Z0-9]{9}[0-9])\b/);
  if (isinMatch) return isinMatch[1].toUpperCase();

  // Pattern "TICKER - NAME" (e.g., "SWDA - ISHARES MSCI WORLD" or "AAPL - APPLE")
  const dashMatch = clean.match(/^([A-Z0-9\.\^\-]{1,10})\s+[-–]\s+(.+)$/i);
  if (dashMatch) return dashMatch[1].toUpperCase();

  // Pattern "NAME (TICKER)" (e.g., "Apple Inc (AAPL)")
  const parenMatch = clean.match(/\(([A-Z0-9\.\^\-]{1,10})\)/i);
  if (parenMatch) return parenMatch[1].toUpperCase();

  return null;
}

/**
 * Maps Directa causale string to standard TRANSACTION_TYPE.
 * Directa causali:
 *   "acquisto" -> BUY
 *   "vendita" -> SELL
 *   "incasso dividendi*" -> DIVIDEND
 *   "conferimento con bonifico" -> DEPOSIT
 *   "prelievo" -> WITHDRAWAL
 *   "cedola" -> INTEREST
 *   "ritenuta" / "imposta" -> TAX
 *   "spese" / "commissioni" -> FEE
 *
 * @param {string} causale
 * @param {string} [descrizione]
 * @returns {string}
 */
function mapDirectaActivity(causale, descrizione = '') {
  const norm = normalizeString(causale);
  const normDesc = normalizeString(descrizione);

  if (norm.includes('acquisto') || norm.includes('buy')) {
    return 'BUY';
  }
  if (norm.includes('vendita') || norm.includes('sell')) {
    return 'SELL';
  }
  if (norm.includes('dividendo') || norm.includes('dividendi') || norm.includes('incasso_dividendi')) {
    return 'DIVIDEND';
  }
  if (norm.includes('cedola') || norm.includes('interessi')) {
    return 'INTEREST';
  }
  if (
    norm.includes('conferimento') ||
    norm.includes('bonifico_in_entrata') ||
    norm.includes('versamento') ||
    norm.includes('deposito')
  ) {
    return 'DEPOSIT';
  }
  if (
    norm.includes('prelievo') ||
    norm.includes('bonifico_in_uscita')
  ) {
    return 'WITHDRAWAL';
  }
  if (norm.includes('ritenuta') || norm.includes('capital_gain') || norm.includes('imposta')) {
    return 'TAX';
  }
  if (norm.includes('commissioni') || norm.includes('spese') || norm.includes('canone')) {
    return 'FEE';
  }
  if (norm.includes('split') || norm.includes('frazionamento')) {
    return 'SPLIT';
  }

  // Fallback checks on description
  if (normDesc.includes('cedola') || normDesc.includes('btp') || normDesc.includes('bot')) {
    return 'INTEREST';
  }
  if (normDesc.includes('dividendo')) {
    return 'DIVIDEND';
  }

  return 'BUY';
}

/**
 * Parses Directa SIM CSV format.
 *
 * @param {string[][]} rows
 * @param {string} defaultCurrency
 * @returns {{ transactions: object[], errors: object[] }}
 */
function parseDirectaRows(rows, defaultCurrency = 'EUR') {
  if (rows.length < 2) return { transactions: [], errors: [] };

  // Find header index
  let headerIndex = -1;
  for (let i = 0; i < Math.min(rows.length, 6); i++) {
    const rowNorm = rows[i].map(normalizeString);
    if (rowNorm.includes('tipo_operazione') || rowNorm.includes('data_operazione')) {
      headerIndex = i;
      break;
    }
  }

  if (headerIndex === -1) headerIndex = 0;

  const headers = rows[headerIndex].map(normalizeString);
  const colMap = {};
  headers.forEach((h, idx) => {
    colMap[h] = idx;
  });

  const getCol = (row, ...names) => {
    for (const n of names) {
      if (colMap[n] !== undefined && row[colMap[n]] !== undefined) {
        return row[colMap[n]];
      }
    }
    return '';
  };

  const transactions = [];
  const errors = [];

  for (let r = headerIndex + 1; r < rows.length; r++) {
    const row = rows[r];
    if (row.length < 2 || row.every(cell => !cell.trim())) continue;

    const rawDate = getCol(row, 'data_operazione', 'data', 'data_valuta');
    const parsedDate = parseItalianDate(rawDate);
    if (!parsedDate) {
      continue; // Skip non-data rows / footers
    }

    const rawTipo = getCol(row, 'tipo_operazione', 'operazione', 'tipo');
    const rawDesc = getCol(row, 'descrizione', 'titolo', 'note');
    const rawSimbolo = getCol(row, 'simbolo', 'ticker', 'codice', 'isin');
    const rawQty = getCol(row, 'quantita', 'qta', 'numero_titoli');
    const rawPrice = getCol(row, 'prezzo', 'prezzo_eseguito', 'prezzo_unitario');
    const rawImporto = getCol(row, 'importo', 'controvalore', 'totale', 'importo_euro');
    const rawComm = getCol(row, 'commissioni', 'commissioni_euro', 'spese');
    const rawTax = getCol(row, 'ritenute', 'tasse', 'imposta');
    const rawCurrency = getCol(row, 'divisa', 'valuta') || defaultCurrency;

    const type = mapDirectaActivity(rawTipo, rawDesc);
    let ticker = rawSimbolo ? rawSimbolo.trim().toUpperCase() : extractTickerFromText(rawDesc);
    const qty = Math.abs(parseItalianNumber(rawQty));
    const price = Math.abs(parseItalianNumber(rawPrice));
    const commission = Math.abs(parseItalianNumber(rawComm));
    const tax = Math.abs(parseItalianNumber(rawTax));
    let amount = Math.abs(parseItalianNumber(rawImporto));

    if (amount === 0 && qty > 0 && price > 0) {
      amount = (type === 'SELL')
        ? Math.max(0, (qty * price) - commission - tax)
        : (qty * price) + commission + tax;
    }

    // For pure cash movements (DEPOSIT, WITHDRAWAL), ticker is null
    if (['DEPOSIT', 'WITHDRAWAL'].includes(type)) {
      ticker = null;
    }

    // Validation
    if (['BUY', 'SELL'].includes(type) && (!ticker || ticker.length === 0)) {
      // If we couldn't parse ticker, record error or use description
      ticker = rawDesc.slice(0, 15).trim().toUpperCase() || 'UNKNOWN';
    }

    transactions.push({
      date: parsedDate,
      type,
      assetTicker: ticker,
      quantity: qty,
      price,
      commission,
      tax,
      exchangeRate: 1.0,
      amount,
      currency: rawCurrency.toUpperCase(),
      notes: rawDesc ? `Directa: ${rawDesc}` : 'Directa import',
      rawRow: row
    });
  }

  return { transactions, errors };
}

/**
 * Maps Banca IFIS causale to standard TRANSACTION_TYPE.
 *
 * @param {string} causale
 * @param {number} amount
 * @returns {string}
 */
function mapIfisActivity(causale, amount) {
  const norm = normalizeString(causale);

  if (norm.includes('interessi') || norm.includes('cedola')) {
    return 'INTEREST';
  }
  if (norm.includes('ritenuta') || norm.includes('imposta') || norm.includes('bollo')) {
    return 'TAX';
  }
  if (norm.includes('spese') || norm.includes('canone') || norm.includes('commissioni')) {
    return 'FEE';
  }
  if (norm.includes('acquisto') || norm.includes('compravendita')) {
    return 'BUY';
  }
  if (norm.includes('vendita')) {
    return 'SELL';
  }
  if (norm.includes('bonifico') || norm.includes('accredito') || norm.includes('giroconto')) {
    return amount >= 0 ? 'DEPOSIT' : 'WITHDRAWAL';
  }

  return amount >= 0 ? 'DEPOSIT' : 'WITHDRAWAL';
}

/**
 * Parses Banca IFIS CSV format.
 *
 * @param {string[][]} rows
 * @param {string} defaultCurrency
 * @returns {{ transactions: object[], errors: object[] }}
 */
function parseBancaIfisRows(rows, defaultCurrency = 'EUR') {
  if (rows.length < 2) return { transactions: [], errors: [] };

  let headerIndex = -1;
  for (let i = 0; i < Math.min(rows.length, 6); i++) {
    const rowNorm = rows[i].map(normalizeString);
    if (rowNorm.includes('data_contabile') || rowNorm.includes('causale')) {
      headerIndex = i;
      break;
    }
  }

  if (headerIndex === -1) headerIndex = 0;

  const headers = rows[headerIndex].map(normalizeString);
  const colMap = {};
  headers.forEach((h, idx) => {
    colMap[h] = idx;
  });

  const getCol = (row, ...names) => {
    for (const n of names) {
      if (colMap[n] !== undefined && row[colMap[n]] !== undefined) {
        return row[colMap[n]];
      }
    }
    return '';
  };

  const transactions = [];
  const errors = [];

  for (let r = headerIndex + 1; r < rows.length; r++) {
    const row = rows[r];
    if (row.length < 2 || row.every(cell => !cell.trim())) continue;

    const rawDate = getCol(row, 'data_contabile', 'data_valuta', 'data');
    const parsedDate = parseItalianDate(rawDate);
    if (!parsedDate) continue;

    const rawCausale = getCol(row, 'causale', 'descrizione_operazione', 'tipo');
    const rawDesc = getCol(row, 'descrizione', 'dettaglio', 'note');
    const rawImporto = getCol(row, 'importo', 'valore', 'saldo');
    const numImporto = parseItalianNumber(rawImporto);
    const rawCurrency = getCol(row, 'divisa', 'valuta') || defaultCurrency;

    const type = mapIfisActivity(rawCausale, numImporto);
    const amount = Math.abs(numImporto);

    transactions.push({
      date: parsedDate,
      type,
      assetTicker: null,
      quantity: 0,
      price: 0,
      commission: 0,
      tax: 0,
      exchangeRate: 1.0,
      amount,
      currency: rawCurrency.toUpperCase(),
      notes: `IFIS: ${rawCausale}${rawDesc ? ' - ' + rawDesc : ''}`,
      rawRow: row
    });
  }

  return { transactions, errors };
}

/**
 * Parses Wealthfolio compatible CSV format.
 * Header: date,symbol,instrumentType,quantity,activityType,unitPrice,currency,fee,tax,amount,fxRate,subtype
 *
 * @param {string[][]} rows
 * @param {string} defaultCurrency
 * @returns {{ transactions: object[], errors: object[] }}
 */
function parseWealthfolioRows(rows, defaultCurrency = 'EUR') {
  if (rows.length < 2) return { transactions: [], errors: [] };

  const headers = rows[0].map(normalizeString);
  const colMap = {};
  headers.forEach((h, idx) => {
    colMap[h] = idx;
  });

  const getCol = (row, name) => {
    const idx = colMap[name];
    return idx !== undefined && row[idx] !== undefined ? row[idx] : '';
  };

  const transactions = [];
  const errors = [];

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    if (row.length === 0 || row.every(cell => !cell.trim())) continue;

    const rawDate = getCol(row, 'date');
    const parsedDate = parseItalianDate(rawDate);
    if (!parsedDate) continue;

    const rawSymbol = getCol(row, 'symbol').trim();
    let symbol = rawSymbol.toUpperCase() || null;
    let activityType = getCol(row, 'activitytype').trim().toUpperCase();
    let currency = getCol(row, 'currency').trim().toUpperCase() || defaultCurrency;

    // Handle Wealthfolio cash pseudo-symbols (e.g. $CASH-USD, $CASH-EUR, CASH)
    if (symbol && (symbol.startsWith('$CASH') || symbol === 'CASH')) {
      const match = symbol.match(/\$CASH-([A-Z]{3})/);
      if (match) {
        currency = match[1];
      }
      symbol = null;
    }

    const WEALTHFOLIO_ACTIVITY_MAP = {
      'BUY': 'BUY',
      'SELL': 'SELL',
      'DIVIDEND': 'DIVIDEND',
      'INTEREST': 'INTEREST',
      'DEPOSIT': 'DEPOSIT',
      'WITHDRAWAL': 'WITHDRAWAL',
      'FEE': 'FEE',
      'TAX': 'TAX',
      'SPLIT': 'SPLIT',
      'TRANSFER_IN': 'TRANSFER',
      'TRANSFER_OUT': 'TRANSFER',
      'TRANSFER': 'TRANSFER',
      'CONVERSION_IN': 'TRANSFER',
      'CONVERSION_OUT': 'TRANSFER'
    };

    if (WEALTHFOLIO_ACTIVITY_MAP[activityType]) {
      activityType = WEALTHFOLIO_ACTIVITY_MAP[activityType];
    } else if (!TRANSACTION_TYPES.includes(activityType)) {
      activityType = symbol ? 'BUY' : 'DEPOSIT';
    }

    const quantity = Math.abs(parseItalianNumber(getCol(row, 'quantity')));
    const unitPrice = Math.abs(parseItalianNumber(getCol(row, 'unitprice')));
    const fee = Math.abs(parseItalianNumber(getCol(row, 'fee')));
    const tax = Math.abs(parseItalianNumber(getCol(row, 'tax')));
    let amount = Math.abs(parseItalianNumber(getCol(row, 'amount')));
    const fxRate = parseItalianNumber(getCol(row, 'fxrate')) || 1.0;
    const subtype = getCol(row, 'subtype');

    if (amount === 0 && quantity > 0 && unitPrice > 0) {
      const gross = (fxRate !== 1.0 && fxRate > 0) ? ((quantity * unitPrice) / fxRate) : (quantity * unitPrice);
      const feeConv = (fxRate !== 1.0 && fxRate > 0 && fee > 0) ? (fee / fxRate) : fee;
      amount = (activityType === 'SELL')
        ? Math.max(0, gross - feeConv - tax)
        : gross + feeConv + tax;
    }

    transactions.push({
      date: parsedDate,
      type: activityType,
      assetTicker: symbol,
      quantity,
      price: unitPrice,
      commission: fee,
      tax,
      exchangeRate: fxRate,
      amount,
      currency,
      notes: subtype ? `Wealthfolio (${subtype})` : 'Wealthfolio import',
      rawRow: row
    });
  }

  return { transactions, errors };
}

/**
 * Parses generic / custom format CSV.
 *
 * @param {string[][]} rows
 * @param {string} defaultCurrency
 * @returns {{ transactions: object[], errors: object[] }}
 */
function parseGenericRows(rows, defaultCurrency = 'EUR') {
  if (rows.length < 2) return { transactions: [], errors: [] };

  const headers = rows[0].map(normalizeString);
  const colMap = {};
  headers.forEach((h, idx) => {
    colMap[h] = idx;
  });

  const getCol = (row, ...names) => {
    for (const n of names) {
      if (colMap[n] !== undefined && row[colMap[n]] !== undefined) {
        return row[colMap[n]];
      }
    }
    // Also try finding a header that contains the keyword
    for (const n of names) {
      for (const h of headers) {
        if (h.includes(n) && colMap[h] !== undefined && row[colMap[h]] !== undefined) {
          return row[colMap[h]];
        }
      }
    }
    return '';
  };

  const transactions = [];
  const errors = [];

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    if (row.length === 0 || row.every(cell => !cell.trim())) continue;

    const rawDate = getCol(row, 'date', 'data', 'timestamp', 'giorno', 'data_operazione', 'data_valuta', 'data_movimento');
    const parsedDate = parseItalianDate(rawDate);
    if (!parsedDate) continue;

    const rawType = getCol(row, 'type', 'tipo', 'activity', 'operazione', 'causale', 'tipo_operazione', 'tipo_movimento', 'movimento');
    let type = rawType.trim().toUpperCase();
    if (!TRANSACTION_TYPES.includes(type)) {
      type = mapDirectaActivity(rawType);
    }

    const rawTicker = getCol(row, 'ticker', 'symbol', 'simbolo', 'asset', 'isin', 'titolo', 'codice_titolo');
    const ticker = rawTicker ? rawTicker.trim().toUpperCase() : null;

    const quantity = Math.abs(parseItalianNumber(getCol(row, 'quantity', 'quantita', 'qta', 'shares', 'quote', 'pezzi')));
    const price = Math.abs(parseItalianNumber(getCol(row, 'price', 'prezzo', 'unitprice', 'prezzo_eseguito', 'costo')));
    const commission = Math.abs(parseItalianNumber(getCol(row, 'commission', 'commissioni', 'fee', 'spese')));
    const tax = Math.abs(parseItalianNumber(getCol(row, 'tax', 'tasse', 'ritenuta', 'imposta', 'tobin')));
    const fxRate = parseItalianNumber(getCol(row, 'exchange_rate', 'fx', 'cambio')) || 1.0;
    const currency = (getCol(row, 'currency', 'valuta', 'divisa') || defaultCurrency).toUpperCase();
    const notes = getCol(row, 'notes', 'note', 'descrizione', 'commento');

    let amount = Math.abs(parseItalianNumber(getCol(row, 'amount', 'importo', 'controvalore', 'totale', 'netto')));
    if (amount === 0 && quantity > 0 && price > 0) {
      const gross = (fxRate !== 1.0 && fxRate > 0) ? ((quantity * price) / fxRate) : (quantity * price);
      const commConv = (fxRate !== 1.0 && fxRate > 0 && commission > 0) ? (commission / fxRate) : commission;
      amount = (type === 'SELL')
        ? Math.max(0, gross - commConv - tax)
        : gross + commConv + tax;
    }

    transactions.push({
      date: parsedDate,
      type,
      assetTicker: ticker,
      quantity,
      price,
      commission,
      tax,
      exchangeRate: fxRate,
      amount,
      currency,
      notes: notes || 'Generic CSV import',
      rawRow: row
    });
  }

  return { transactions, errors };
}

/**
 * Parses CSV rows using user-defined custom column mappings.
 *
 * @param {string[][]} rows
 * @param {object} columnMapping - Mapping object matching FolioTrack fields to CSV header names or indices
 * @param {string} [defaultCurrency='EUR']
 * @returns {{ transactions: object[], errors: string[] }}
 */
function parseCustomMappingRows(rows, columnMapping = {}, defaultCurrency = 'EUR') {
  if (!rows || rows.length < 2) {
    return { transactions: [], errors: ['Nessuna riga di dati presente nel CSV per la mappatura custom.'] };
  }

  const rawHeaders = rows[0];
  const headerToIndex = {};
  rawHeaders.forEach((h, idx) => {
    headerToIndex[String(h).trim()] = idx;
    headerToIndex[normalizeString(h)] = idx;
    headerToIndex[String(idx)] = idx;
  });

  // Resolve mapped index for each target field
  const resolveIndex = (targetField) => {
    const mapped = columnMapping ? columnMapping[targetField] : undefined;
    if (mapped === undefined || mapped === null || mapped === '' || mapped === '__none__' || mapped === 'none') {
      return -1;
    }
    if (typeof mapped === 'number') return mapped;
    const str = String(mapped).trim();
    if (headerToIndex[str] !== undefined) return headerToIndex[str];
    if (headerToIndex[normalizeString(str)] !== undefined) return headerToIndex[normalizeString(str)];
    const num = parseInt(str, 10);
    if (!isNaN(num) && num >= 0 && num < rawHeaders.length) return num;
    return -1;
  };

  const dateIdx = resolveIndex('date');
  const typeIdx = resolveIndex('type');
  const tickerIdx = resolveIndex('ticker');
  const qtyIdx = resolveIndex('quantity');
  const priceIdx = resolveIndex('price');
  const amountIdx = resolveIndex('amount');
  const commIdx = resolveIndex('commission');
  const taxIdx = resolveIndex('tax');
  const portIdx = resolveIndex('portfolio');
  const notesIdx = resolveIndex('notes');
  const fxIdx = resolveIndex('exchangeRate');
  const currIdx = resolveIndex('currency');

  const transactions = [];
  const errors = [];

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    if (!row || row.length === 0 || row.every(cell => !cell.trim())) continue;

    // Date (mandatory)
    const rawDate = dateIdx >= 0 && row[dateIdx] !== undefined ? row[dateIdx] : '';
    const parsedDate = parseItalianDate(rawDate);
    if (!parsedDate) {
      errors.push(`Riga ${r}: data operazione non valida o mancante ("${rawDate}").`);
      continue;
    }

    // Type
    let type = 'BUY';
    if (typeIdx >= 0 && row[typeIdx]) {
      const rawType = String(row[typeIdx]).trim().toUpperCase();
      if (TRANSACTION_TYPES.includes(rawType)) {
        type = rawType;
      } else {
        type = mapDirectaActivity(rawType);
      }
    }

    // Ticker / ISIN
    let ticker = null;
    if (tickerIdx >= 0 && row[tickerIdx]) {
      const rawTicker = String(row[tickerIdx]).trim();
      ticker = extractTickerFromText(rawTicker) || rawTicker.toUpperCase();
    }

    // Numbers
    const quantity = qtyIdx >= 0 && row[qtyIdx] ? Math.abs(parseItalianNumber(row[qtyIdx])) : 0.0;
    const price = priceIdx >= 0 && row[priceIdx] ? Math.abs(parseItalianNumber(row[priceIdx])) : 0.0;
    const commission = commIdx >= 0 && row[commIdx] ? Math.abs(parseItalianNumber(row[commIdx])) : 0.0;
    const tax = taxIdx >= 0 && row[taxIdx] ? Math.abs(parseItalianNumber(row[taxIdx])) : 0.0;
    const fxRate = fxIdx >= 0 && row[fxIdx] ? (parseItalianNumber(row[fxIdx]) || 1.0) : 1.0;
    const currency = (currIdx >= 0 && row[currIdx] ? String(row[currIdx]).trim().toUpperCase() : defaultCurrency) || defaultCurrency;
    const portfolioName = portIdx >= 0 && row[portIdx] ? String(row[portIdx]).trim() : null;
    const notes = notesIdx >= 0 && row[notesIdx] ? String(row[notesIdx]).trim() : 'Importazione CSV personalizzata';

    let amount = amountIdx >= 0 && row[amountIdx] ? Math.abs(parseItalianNumber(row[amountIdx])) : 0.0;
    if (amount === 0 && quantity > 0 && price > 0) {
      const gross = (fxRate !== 1.0 && fxRate > 0) ? ((quantity * price) / fxRate) : (quantity * price);
      const commConv = (fxRate !== 1.0 && fxRate > 0 && commission > 0) ? (commission / fxRate) : commission;
      amount = (type === 'SELL')
        ? Math.max(0, gross - commConv - tax)
        : gross + commConv + tax;
    }

    transactions.push({
      date: parsedDate,
      type,
      assetTicker: ticker,
      quantity,
      price,
      commission,
      tax,
      exchangeRate: fxRate,
      amount,
      currency,
      portfolioName,
      notes,
      rawRow: row
    });
  }

  return { transactions, errors };
}

/**
 * Main CSV parser entrypoint with auto-detection and custom column mapping support.
 *
 * @param {string} csvText
 * @param {string} [defaultCurrency='EUR']
 * @param {string} [forcedBroker=null]
 * @param {object} [customMapping=null]
 * @returns {{ broker: string, totalRows: number, headers: string[], hasPortfolioColumn: boolean, sampleRows: string[][], transactions: object[], errors: object[] }}
 */
function parseBrokerCsv(csvText, defaultCurrency = 'EUR', forcedBroker = null, customMapping = null) {
  if (!csvText || typeof csvText !== 'string' || !csvText.trim()) {
    return {
      broker: 'UNKNOWN',
      totalRows: 0,
      headers: [],
      hasPortfolioColumn: false,
      sampleRows: [],
      transactions: [],
      errors: ['File CSV vuoto o non valido.']
    };
  }

  const rows = parseCsvRows(csvText);
  const headers = rows.length > 0 ? rows[0] : [];
  const normHeaders = headers.map(normalizeString);
  const hasPortfolioColumn = normHeaders.some(h =>
    ['portfolio', 'portafoglio', 'conto', 'deposito', 'account', 'deposito_titoli', 'portafoglio_di_destinazione'].includes(h)
  );
  const sampleRows = rows.slice(1, 4);

  let broker = forcedBroker || detectBroker(csvText);
  let result;

  if (customMapping && Object.keys(customMapping).length > 0) {
    broker = 'CUSTOM';
    result = parseCustomMappingRows(rows, customMapping, defaultCurrency);
  } else {
    switch (broker) {
      case 'DIRECTA':
        result = parseDirectaRows(rows, defaultCurrency);
        break;
      case 'BANCA_IFIS':
        result = parseBancaIfisRows(rows, defaultCurrency);
        break;
      case 'WEALTHFOLIO':
        result = parseWealthfolioRows(rows, defaultCurrency);
        break;
      case 'CUSTOM':
        result = parseCustomMappingRows(rows, customMapping || {}, defaultCurrency);
        break;
      default:
        result = parseGenericRows(rows, defaultCurrency);
        break;
    }
  }

  return {
    broker,
    totalRows: rows.length > 0 ? rows.length - 1 : 0,
    headers,
    hasPortfolioColumn,
    sampleRows,
    transactions: result.transactions,
    errors: result.errors
  };
}

module.exports = {
  detectBroker,
  detectDelimiter,
  parseCsvRows,
  parseItalianNumber,
  parseItalianDate,
  parseBrokerCsv,
  parseCustomMappingRows,
  extractTickerFromText
};

