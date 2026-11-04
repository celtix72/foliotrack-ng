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

const ASSET_TYPES = [
  'EQUITY',
  'ETF',
  'BOND',
  'CRYPTO',
  'COMMODITY',
  'MUTUAL_FUND',
  'CASH'
];

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
  PORTFOLIO_TYPES,
  TRANSACTION_TYPES,
  RISK_CATEGORIES,
  CURRENCIES,
  REGIONS
};

