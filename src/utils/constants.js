/**
 * Financial & Taxonomic Constants for FolioTrack
 */

const GICS_SECTORS = [
  'Information Technology',
  'Financials',
  'Health Care',
  'Consumer Discretionary',
  'Consumer Staples',
  'Industrials',
  'Energy',
  'Utilities',
  'Materials',
  'Real Estate',
  'Communication Services'
];

const MANUAL_ASSET_TYPES = [
  'DEPOSITO_VINCOLATO',
  'BUONO_POSTALE',
  'TFR',
  'FONDO_PENSIONE'
];

const ASSET_TYPES = [
  'EQUITY',
  'ETF',
  'BOND',
  'CRYPTO',
  'COMMODITY',
  'MUTUAL_FUND',
  'CASH',
  ...MANUAL_ASSET_TYPES
];

/**
 * Normalizes an asset type string (handles space/underscore variants, ticker heuristics, and name heuristics).
 *
 * @param {string} [type]
 * @param {string} [ticker]
 * @param {string} [name]
 * @returns {string}
 */
function normalizeAssetType(type, ticker = '', name = '') {
  const tick = String(ticker || '').trim().toUpperCase();
  const nam = String(name || '').trim().toUpperCase();

  if (
    tick.startsWith('CD_') || tick.startsWith('CD-') || tick.includes('IFIS') || tick.includes('RENDIMAX') || tick.includes('DEPOSIT') ||
    nam.includes('CONTO DEPOSITO') || nam.includes('DEPOSITO VINCOLATO') || nam.includes('IFIS') || nam.includes('RENDIMAX')
  ) {
    return 'DEPOSITO_VINCOLATO';
  }
  if (
    tick.startsWith('BFP') || tick.includes('BUONO') || tick.includes('POSTAL') || tick.includes('POSTE') ||
    nam.includes('BUONO') || nam.includes('BFP') || nam.includes('POSTAL') || nam.includes('POSTE') || nam.includes('FRUTTIFER')
  ) {
    return 'BUONO_POSTALE';
  }
  if (
    tick === 'TFR' || tick.startsWith('TFR') || tick.includes('TFR') ||
    nam.includes('TFR') || nam.includes('TRATTAMENTO FINE RAPPORTO') || nam.includes('LIQUIDAZIONE')
  ) {
    return 'TFR';
  }
  if (
    tick.includes('PENSIONE') || tick.includes('FONDO_PENS') || tick.includes('PREVIDENZA') || tick.includes('COMETA') || tick.includes('FONTE') || tick.includes('FONDPOSTE') ||
    nam.includes('PENSIONE') || nam.includes('PREVIDENZA') || nam.includes('FONDO PENSIONE') || nam.includes('COMETA') || nam.includes('FONTE')
  ) {
    return 'FONDO_PENSIONE';
  }

  if (!type) return 'EQUITY';
  const clean = String(type).trim().toUpperCase().replace(/[\s-]+/g, '_');
  if (['DEPOSITO_VINCOLATO', 'DEPOSITO', 'CONTO_DEPOSITO', 'TIME_DEPOSIT', 'DEPOSITI_VINCOLATI', 'DEPOSITI'].includes(clean)) {
    return 'DEPOSITO_VINCOLATO';
  }
  if (['BUONO_POSTALE', 'BUONI_POSTALI', 'POSTAL_BOND', 'BFP', 'BUONO', 'BUONI'].includes(clean)) {
    return 'BUONO_POSTALE';
  }
  if (clean === 'TFR') {
    return 'TFR';
  }
  if (['FONDO_PENSIONE', 'FONDI_PENSIONE', 'PENSION_FUND', 'PREVIDENZA', 'PENSIONE'].includes(clean)) {
    return 'FONDO_PENSIONE';
  }
  return clean;
}

/**
 * Checks whether an asset type (or ticker/name) is a manual, non-realtime monitored type
 * (Deposito Vincolato, Buono Postale, TFR, Fondo Pensione).
 *
 * @param {string} [type]
 * @param {string} [ticker]
 * @param {string} [name]
 * @returns {boolean}
 */
function isManualAssetType(type, ticker = '', name = '') {
  const norm = normalizeAssetType(type, ticker, name);
  return MANUAL_ASSET_TYPES.includes(norm);
}

/**
 * Returns human-readable Italian label for an asset type.
 *
 * @param {string} [type]
 * @returns {string}
 */
function getAssetTypeLabel(type) {
  const norm = normalizeAssetType(type);
  switch (norm) {
    case 'DEPOSITO_VINCOLATO': return 'Deposito Vincolato';
    case 'BUONO_POSTALE': return 'Buono Postale';
    case 'TFR': return 'TFR';
    case 'FONDO_PENSIONE': return 'Fondo Pensione';
    case 'EQUITY': return 'Azioni';
    case 'ETF': return 'ETF';
    case 'BOND': return 'Obbligazioni';
    case 'COMMODITY': return 'Materie Prime';
    case 'CRYPTO': return 'Criptovalute';
    case 'CASH': return 'Liquidità';
    case 'MUTUAL_FUND': return 'Fondo Comune';
    default: return String(type);
  }
}

const PORTFOLIO_TYPES = [
  'Investimento',
  'Pensione',
  'Trading',
  'Liquidità'
];

const TRANSACTION_TYPES = [
  'BUY',
  'SELL',
  'DIVIDEND',
  'INTEREST',
  'DEPOSIT',
  'WITHDRAWAL',
  'TRANSFER',
  'SPLIT',
  'FEE',
  'TAX'
];

const RISK_CATEGORIES = ['LOW', 'MEDIUM', 'HIGH'];

const CURRENCIES = ['EUR', 'USD', 'CHF', 'GBP'];

const REGIONS = [
  'Europe',
  'Americas',
  'Asia',
  'Emerging Markets',
  'Global'
];

module.exports = {
  GICS_SECTORS,
  ASSET_TYPES,
  MANUAL_ASSET_TYPES,
  normalizeAssetType,
  isManualAssetType,
  getAssetTypeLabel,
  PORTFOLIO_TYPES,
  TRANSACTION_TYPES,
  RISK_CATEGORIES,
  CURRENCIES,
  REGIONS
};

