/**
 * Transaction Export Formatter for FolioTrack
 * Generates 100% Wealthfolio-compatible CSV exports and generic formats.
 */

const { ASSET_TYPES, TRANSACTION_TYPES } = require('./constants');

/**
 * Escapes a cell value for standard CSV compatibility.
 * If value contains commas, quotes or newlines, encloses in quotes and escapes internal quotes.
 *
 * @param {any} val
 * @returns {string}
 */
function escapeCsvCell(val) {
  if (val === null || val === undefined) return '';
  const str = String(val);
  if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/**
 * Maps internal FolioTrack asset type to Wealthfolio instrumentType.
 * Supported: EQUITY, ETF, CRYPTO, BOND, MUTUAL_FUND, COMMODITY.
 * Pure cash movements return an empty string.
 *
 * @param {string} [assetType]
 * @param {string} [transactionType]
 * @returns {string}
 */
function mapToWealthfolioInstrumentType(assetType, transactionType) {
  if (['DEPOSIT', 'WITHDRAWAL', 'TRANSFER'].includes(transactionType) && !assetType) {
    return '';
  }

  const clean = (assetType || '').toUpperCase().trim();
  switch (clean) {
    case 'EQUITY':
    case 'STOCK':
    case 'AZIONE':
      return 'EQUITY';
    case 'ETF':
    case 'ETC':
    case 'ETN':
      return 'ETF';
    case 'BOND':
    case 'BTP':
    case 'BOT':
    case 'OBBLIGAZIONE':
      return 'BOND';
    case 'CRYPTO':
    case 'CRIPTO':
      return 'CRYPTO';
    case 'COMMODITY':
    case 'MATERIE_PRIME':
      return 'COMMODITY';
    case 'MUTUAL_FUND':
    case 'FONDO':
    case 'FUND':
      return 'MUTUAL_FUND';
    case 'CASH':
      return '';
    default:
      return clean && ASSET_TYPES.includes(clean) ? clean : 'EQUITY';
  }
}

/**
 * Maps internal transaction type to Wealthfolio activityType.
 * Supported: BUY, SELL, DIVIDEND, INTEREST, DEPOSIT, WITHDRAWAL, FEE, TAX, SPLIT.
 *
 * @param {string} type
 * @returns {string}
 */
function mapToWealthfolioActivityType(type) {
  const clean = (type || '').toUpperCase().trim();
  switch (clean) {
    case 'BUY':
      return 'BUY';
    case 'SELL':
      return 'SELL';
    case 'DIVIDEND':
      return 'DIVIDEND';
    case 'INTEREST':
      return 'INTEREST';
    case 'DEPOSIT':
      return 'DEPOSIT';
    case 'WITHDRAWAL':
      return 'WITHDRAWAL';
    case 'TRANSFER':
      return 'DEPOSIT';
    case 'SPLIT':
      return 'SPLIT';
    case 'FEE':
      return 'FEE';
    case 'TAX':
      return 'TAX';
    default:
      return 'BUY';
  }
}

/**
 * Generates a Wealthfolio-compatible CSV string from a list of transactions.
 * Specification:
 *   date,symbol,instrumentType,quantity,activityType,unitPrice,currency,fee,tax,amount,fxRate,subtype
 *
 * @param {object[]} transactions Array of transaction records
 * @param {Record<string, object>} [assetsMap={}] Map of ticker -> asset object
 * @param {string} [defaultCurrency='EUR']
 * @returns {string} CSV string with header
 */
function exportWealthfolioCsv(transactions = [], assetsMap = {}, defaultCurrency = 'EUR') {
  const header = [
    'date',
    'symbol',
    'instrumentType',
    'quantity',
    'activityType',
    'unitPrice',
    'currency',
    'fee',
    'tax',
    'amount',
    'fxRate',
    'subtype'
  ].join(',');

  const rows = [header];

  for (const tx of transactions) {
    const ticker = tx.assetTicker ? tx.assetTicker.toUpperCase().trim() : '';
    const asset = ticker && assetsMap[ticker] ? assetsMap[ticker] : null;

    const date = tx.date ? tx.date.slice(0, 10) : new Date().toISOString().split('T')[0];
    const activityType = mapToWealthfolioActivityType(tx.type);
    const instrumentType = ticker ? mapToWealthfolioInstrumentType(asset ? asset.type : null, tx.type) : '';
    const quantity = Number(tx.quantity) || 0;
    const unitPrice = Number(tx.price) || 0;
    const currency = (asset && asset.currency) || tx.currency || defaultCurrency || 'EUR';
    const fee = Number(tx.commission) || 0;
    const tax = Number(tx.tax) || 0;
    const amount = Number(tx.amount) || 0;
    const fxRate = Number(tx.exchangeRate) || 1.0;
    const subtype = tx.notes ? tx.notes.slice(0, 50) : '';

    const row = [
      escapeCsvCell(date),
      escapeCsvCell(ticker),
      escapeCsvCell(instrumentType),
      quantity.toString(),
      escapeCsvCell(activityType),
      unitPrice.toString(),
      escapeCsvCell(currency),
      fee.toString(),
      tax.toString(),
      amount.toString(),
      fxRate.toString(),
      escapeCsvCell(subtype)
    ];

    rows.push(row.join(','));
  }

  return rows.join('\n') + '\n';
}

module.exports = {
  escapeCsvCell,
  mapToWealthfolioInstrumentType,
  mapToWealthfolioActivityType,
  exportWealthfolioCsv
};

