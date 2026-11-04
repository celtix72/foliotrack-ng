/**
 * Script to automatically classify all assets in the database with their
 * GICS Sector, Country of origin, and Geographic Region.
 */
const { getDb } = require('../src/db');

const ASSET_CLASSIFICATIONS = [
  {
    ticker: '1ASML.MI',
    name: 'ASML Holding N.V.',
    type: 'EQUITY',
    sector: 'Information Technology',
    country: 'Paesi Bassi',
    region: 'Europe'
  },
  {
    ticker: '3GOO.MI',
    name: 'Leverage Shares 3x Long Alphabet ETP',
    type: 'ETF',
    sector: 'Communication Services',
    country: 'Stati Uniti',
    region: 'Americas'
  },
  {
    ticker: '3NLV.MI',
    name: 'GraniteShares 3x Long NVIDIA Daily ETP',
    type: 'ETF',
    sector: 'Information Technology',
    country: 'Stati Uniti',
    region: 'Americas'
  },
  {
    ticker: 'ABNB',
    name: 'Airbnb, Inc.',
    type: 'EQUITY',
    sector: 'Consumer Discretionary',
    country: 'Stati Uniti',
    region: 'Americas'
  },
  {
    ticker: 'ADBE',
    name: 'Adobe Inc.',
    type: 'EQUITY',
    sector: 'Information Technology',
    country: 'Stati Uniti',
    region: 'Americas'
  },
  {
    ticker: 'AHLA.DE',
    name: 'Alibaba Group Holding Ltd.',
    type: 'EQUITY',
    sector: 'Consumer Discretionary',
    country: 'Cina',
    region: 'Emerging Markets'
  },
  {
    ticker: 'AMD.DE',
    name: 'Advanced Micro Devices Inc.',
    type: 'EQUITY',
    sector: 'Information Technology',
    country: 'Stati Uniti',
    region: 'Americas'
  },
  {
    ticker: 'ASPN',
    name: 'Aspen Aerogels, Inc.',
    type: 'EQUITY',
    sector: 'Industrials',
    country: 'Stati Uniti',
    region: 'Americas'
  },
  {
    ticker: 'BABA',
    name: 'Alibaba Group Holding Limited ADR',
    type: 'EQUITY',
    sector: 'Consumer Discretionary',
    country: 'Cina',
    region: 'Emerging Markets'
  },
  {
    ticker: 'CD_WID',
    name: 'Conto Deposito Widiba',
    type: 'CASH',
    sector: 'Financials',
    country: 'Italia',
    region: 'Europe'
  },
  {
    ticker: 'CRM',
    name: 'Salesforce, Inc.',
    type: 'EQUITY',
    sector: 'Information Technology',
    country: 'Stati Uniti',
    region: 'Americas'
  },
  {
    ticker: 'ELV',
    name: 'Elevance Health, Inc.',
    type: 'EQUITY',
    sector: 'Health Care',
    country: 'Stati Uniti',
    region: 'Americas'
  },
  {
    ticker: 'FCT.MI',
    name: 'Fincantieri S.p.A.',
    type: 'EQUITY',
    sector: 'Industrials',
    country: 'Italia',
    region: 'Europe'
  },
  {
    ticker: 'FISV',
    name: 'Fiserv, Inc.',
    type: 'EQUITY',
    sector: 'Financials',
    country: 'Stati Uniti',
    region: 'Americas'
  },
  {
    ticker: 'GOOGL',
    name: 'Alphabet Inc.',
    type: 'EQUITY',
    sector: 'Communication Services',
    country: 'Stati Uniti',
    region: 'Americas'
  },
  {
    ticker: 'HIMS',
    name: 'Hims & Hers Health, Inc.',
    type: 'EQUITY',
    sector: 'Health Care',
    country: 'Stati Uniti',
    region: 'Americas'
  },
  {
    ticker: 'IONQ',
    name: 'IonQ, Inc.',
    type: 'EQUITY',
    sector: 'Information Technology',
    country: 'Stati Uniti',
    region: 'Americas'
  },
  {
    ticker: 'ISP.MI',
    name: 'Intesa Sanpaolo S.p.A.',
    type: 'EQUITY',
    sector: 'Financials',
    country: 'Italia',
    region: 'Europe'
  },
  {
    ticker: 'IT0004532559',
    name: 'BTP 5% 01Set40',
    type: 'BOND',
    sector: 'Government',
    country: 'Italia',
    region: 'Europe'
  },
  {
    ticker: 'IT0005583486',
    name: 'BTP 2.50% 15Mz30',
    type: 'BOND',
    sector: 'Government',
    country: 'Italia',
    region: 'Europe'
  },
  {
    ticker: 'IT0005594483',
    name: 'BTP 3.35% 01Mg30',
    type: 'BOND',
    sector: 'Government',
    country: 'Italia',
    region: 'Europe'
  },
  {
    ticker: 'JD',
    name: 'JD.com, Inc. ADR',
    type: 'EQUITY',
    sector: 'Consumer Discretionary',
    country: 'Cina',
    region: 'Emerging Markets'
  },
  {
    ticker: 'KSPI',
    name: 'JSC Kaspi.kz ADR',
    type: 'EQUITY',
    sector: 'Financials',
    country: 'Kazakistan',
    region: 'Emerging Markets'
  },
  {
    ticker: 'LULU',
    name: 'Lululemon Athletica Inc.',
    type: 'EQUITY',
    sector: 'Consumer Discretionary',
    country: 'Canada',
    region: 'Americas'
  },
  {
    ticker: 'MARA',
    name: 'MARA Holdings, Inc.',
    type: 'EQUITY',
    sector: 'Financials',
    country: 'Stati Uniti',
    region: 'Americas'
  },
  {
    ticker: 'MELI',
    name: 'MercadoLibre, Inc.',
    type: 'EQUITY',
    sector: 'Consumer Discretionary',
    country: 'Brasile',
    region: 'Emerging Markets'
  },
  {
    ticker: 'META',
    name: 'Meta Platforms, Inc.',
    type: 'EQUITY',
    sector: 'Communication Services',
    country: 'Stati Uniti',
    region: 'Americas'
  },
  {
    ticker: 'MFEA.MI',
    name: 'MFE - MediaForEurope N.V. Cl A',
    type: 'EQUITY',
    sector: 'Communication Services',
    country: 'Italia',
    region: 'Europe'
  },
  {
    ticker: 'MSF.DE',
    name: 'Microsoft Corp. (Xetra)',
    type: 'EQUITY',
    sector: 'Information Technology',
    country: 'Stati Uniti',
    region: 'Americas'
  },
  {
    ticker: 'MSFT',
    name: 'Microsoft Corporation',
    type: 'EQUITY',
    sector: 'Information Technology',
    country: 'Stati Uniti',
    region: 'Americas'
  },
  {
    ticker: 'NEXI.MI',
    name: 'Nexi S.p.A.',
    type: 'EQUITY',
    sector: 'Financials',
    country: 'Italia',
    region: 'Europe'
  },
  {
    ticker: 'NGAS.MI',
    name: 'WisdomTree Natural Gas',
    type: 'ETF',
    sector: 'Energy',
    country: 'Globale',
    region: 'Global'
  },
  {
    ticker: 'NOMD',
    name: 'Nomad Foods Limited',
    type: 'EQUITY',
    sector: 'Consumer Staples',
    country: 'Regno Unito',
    region: 'Europe'
  },
  {
    ticker: 'NOV.DE',
    name: 'Novo Nordisk A/S (Xetra)',
    type: 'EQUITY',
    sector: 'Health Care',
    country: 'Danimarca',
    region: 'Europe'
  },
  {
    ticker: 'NU',
    name: 'Nu Holdings Ltd.',
    type: 'EQUITY',
    sector: 'Financials',
    country: 'Brasile',
    region: 'Emerging Markets'
  },
  {
    ticker: 'PLTR',
    name: 'Palantir Technologies Inc.',
    type: 'EQUITY',
    sector: 'Information Technology',
    country: 'Stati Uniti',
    region: 'Americas'
  },
  {
    ticker: 'PRX.AS',
    name: 'Prosus N.V.',
    type: 'EQUITY',
    sector: 'Consumer Discretionary',
    country: 'Paesi Bassi',
    region: 'Europe'
  },
  {
    ticker: 'PYPL',
    name: 'PayPal Holdings, Inc.',
    type: 'EQUITY',
    sector: 'Financials',
    country: 'Stati Uniti',
    region: 'Americas'
  },
  {
    ticker: 'RWAY.MI',
    name: 'Rai Way S.p.A.',
    type: 'EQUITY',
    sector: 'Communication Services',
    country: 'Italia',
    region: 'Europe'
  },
  {
    ticker: 'SE',
    name: 'Sea Limited ADR',
    type: 'EQUITY',
    sector: 'Consumer Discretionary',
    country: 'Singapore',
    region: 'Asia'
  },
  {
    ticker: 'SPM.MI',
    name: 'Saipem S.p.A.',
    type: 'EQUITY',
    sector: 'Energy',
    country: 'Italia',
    region: 'Europe'
  },
  {
    ticker: 'SRG.MI',
    name: 'Snam S.p.A.',
    type: 'EQUITY',
    sector: 'Utilities',
    country: 'Italia',
    region: 'Europe'
  },
  {
    ticker: 'STMMI.MI',
    name: 'STMicroelectronics N.V.',
    type: 'EQUITY',
    sector: 'Information Technology',
    country: 'Italia',
    region: 'Europe'
  },
  {
    ticker: 'TDIV.AS',
    name: 'VanEck Morningstar Developed Markets Dividend Leaders UCITS ETF',
    type: 'ETF',
    sector: 'Broad Market',
    country: 'Paesi Sviluppati',
    region: 'Global'
  },
  {
    ticker: 'TIT.MI',
    name: 'Telecom Italia S.p.A.',
    type: 'EQUITY',
    sector: 'Communication Services',
    country: 'Italia',
    region: 'Europe'
  },
  {
    ticker: 'TSLA',
    name: 'Tesla, Inc.',
    type: 'EQUITY',
    sector: 'Consumer Discretionary',
    country: 'Stati Uniti',
    region: 'Americas'
  },
  {
    ticker: 'UNH',
    name: 'UnitedHealth Group Incorporated',
    type: 'EQUITY',
    sector: 'Health Care',
    country: 'Stati Uniti',
    region: 'Americas'
  },
  {
    ticker: 'VERE.DE',
    name: 'Vanguard FTSE Developed Europe ex-UK UCITS ETF',
    type: 'ETF',
    sector: 'Broad Market',
    country: 'Europa',
    region: 'Europe'
  },
  {
    ticker: 'X25E.MI',
    name: 'Xtrackers II Eurozone Government Bond 25+ UCITS ETF',
    type: 'ETF',
    sector: 'Government',
    country: 'Eurozona',
    region: 'Europe'
  },
  {
    ticker: 'XCHA.DE',
    name: 'Xtrackers CSI300 Swap UCITS ETF',
    type: 'ETF',
    sector: 'Broad Market',
    country: 'Cina',
    region: 'Emerging Markets'
  },
  {
    ticker: 'XEON.DE',
    name: 'Xtrackers II EUR Overnight Rate Swap UCITS ETF',
    type: 'ETF',
    sector: 'Financials',
    country: 'Eurozona',
    region: 'Europe'
  },
  {
    ticker: 'XS3021378388',
    name: 'Romania 2039 5.25%',
    type: 'BOND',
    sector: 'Government',
    country: 'Romania',
    region: 'Europe'
  },
  {
    ticker: 'ZTS',
    name: 'Zoetis Inc.',
    type: 'EQUITY',
    sector: 'Health Care',
    country: 'Stati Uniti',
    region: 'Americas'
  }
];

function classifyAllAssets() {
  const db = getDb();
  console.log(`Starting classification for ${ASSET_CLASSIFICATIONS.length} assets...`);

  const updateStmt = db.prepare(`
    UPDATE assets
    SET 
      name = COALESCE(?, name),
      type = COALESCE(?, type),
      sector = ?,
      country = ?,
      region = ?,
      updatedAt = datetime('now')
    WHERE ticker = ?
  `);

  const tx = db.transaction(() => {
    let updatedCount = 0;
    for (const item of ASSET_CLASSIFICATIONS) {
      const res = updateStmt.run(
        item.name,
        item.type,
        item.sector,
        item.country,
        item.region,
        item.ticker
      );
      if (res.changes > 0) {
        updatedCount++;
      } else {
        console.warn(`Warning: ticker ${item.ticker} not found in database!`);
      }
    }
    return updatedCount;
  });

  const count = tx();
  console.log(`Successfully classified and updated ${count} assets in the database.`);

  // Recalculate all portfolios to update sector and regional allocations
  const portfolios = db.prepare('SELECT id, name FROM portfolios').all();
  console.log(`Recalculating allocations for ${portfolios.length} portfolios...`);
  const { recalculatePortfolio } = require('../src/routes/portfolios');

  for (const p of portfolios) {
    try {
      const res = recalculatePortfolio(p.id);
      console.log(`✓ Portfolio ${p.id} (${p.name}) recalculated. Sectors:`, Object.keys(res?.metrics?.allocations?.bySector || {}).join(', '));
    } catch (err) {
      console.error(`✗ Error recalculating portfolio ${p.id}:`, err.message);
    }
  }
}

if (require.main === module) {
  classifyAllAssets();
}

module.exports = { ASSET_CLASSIFICATIONS, classifyAllAssets };
