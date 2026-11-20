/**
 * Wealthfolio-style Portfolio Target Allocation & Rebalancing Engine
 * 
 * Provides:
 * 1. Preset Allocation Models (60/40, All Weather, Golden Butterfly, 80/20 Growth, 100% Equity)
 * 2. Multi-Level Targets: Asset Class or Per-Holding / Single Asset
 * 3. Tolerance Bands: Absolute (e.g. ±2%) & Drift Tracking
 * 4. Two-Phase Rebalancing Algorithm:
 *    - CASH_FIRST (Buy-Only / PAC cash deployment without selling)
 *    - FULL_REBALANCE (Sell overweight to fund underweight positions)
 * 5. Interactive Rebalancing Worksheet with real-time projections
 * 6. Exportable CSV and 1-Click Clipboard Order formatting
 */

const PRESET_TARGET_MODELS = [
  {
    id: 'classic_60_40',
    name: 'Classico Bilanciato (60/40)',
    description: 'Il classico portafoglio bilanciato: 60% Azionario e 40% Obbligazionario.',
    type: 'ASSET_CLASS',
    toleranceBand: 2.0,
    rebalanceMode: 'CASH_FIRST',
    allocations: [
      { id: 'EQUITY', label: 'Azioni (Equity)', targetPercent: 60.0 },
      { id: 'BOND', label: 'Obbligazioni (Bond)', targetPercent: 40.0 }
    ]
  },
  {
    id: 'all_weather',
    name: 'All Weather (Ray Dalio)',
    description: 'Portafoglio All Weather progettato per performare in ogni ciclo economico.',
    type: 'ASSET_CLASS',
    toleranceBand: 2.0,
    rebalanceMode: 'CASH_FIRST',
    allocations: [
      { id: 'EQUITY', label: 'Azioni Globali', targetPercent: 30.0 },
      { id: 'BOND', label: 'Obbligazioni a Lungo Termine', targetPercent: 40.0 },
      { id: 'BOND_INTERMEDIATE', label: 'Obbligazioni a Medio Termine', targetPercent: 15.0 },
      { id: 'COMMODITY', label: 'Oro & Metalli Preziosi', targetPercent: 7.5 },
      { id: 'COMMODITY_BROAD', label: 'Materie Prime Diversificate', targetPercent: 7.5 }
    ]
  },
  {
    id: 'golden_butterfly',
    name: 'Golden Butterfly',
    description: 'Elevata resilienza con 5 asset equamente pesati al 20%.',
    type: 'ASSET_CLASS',
    toleranceBand: 2.5,
    rebalanceMode: 'CASH_FIRST',
    allocations: [
      { id: 'EQUITY_LARGE', label: 'Azioni Large Cap', targetPercent: 20.0 },
      { id: 'EQUITY_SMALL', label: 'Azioni Small Cap Value', targetPercent: 20.0 },
      { id: 'BOND_LONG', label: 'Obbligazioni Lungo Termine', targetPercent: 20.0 },
      { id: 'BOND_SHORT', label: 'Obbligazioni Breve Termine', targetPercent: 20.0 },
      { id: 'COMMODITY', label: 'Oro (Gold)', targetPercent: 20.0 }
    ]
  },
  {
    id: 'growth_80_20',
    name: 'Crescita 80/20',
    description: 'Forte orientamento alla crescita azionaria con cuscinetto protettivo.',
    type: 'ASSET_CLASS',
    toleranceBand: 2.0,
    rebalanceMode: 'CASH_FIRST',
    allocations: [
      { id: 'EQUITY', label: 'Azioni (Equity)', targetPercent: 80.0 },
      { id: 'BOND', label: 'Obbligazioni (Bond)', targetPercent: 20.0 }
    ]
  },
  {
    id: 'equity_100',
    name: '100% Azionario Mondiale',
    description: 'Esposizione total equity su mercati sviluppati ed emergenti.',
    type: 'ASSET_CLASS',
    toleranceBand: 2.0,
    rebalanceMode: 'CASH_FIRST',
    allocations: [
      { id: 'EQUITY', label: 'Azioni Mondiali', targetPercent: 100.0 }
    ]
  },
  {
    id: 'core_satellite_70_20_10',
    name: 'Core / Satellite (70/20/10)',
    description: '70% azionario core, 20% obbligazioni difensive e 10% satellite/crypto/liquidità.',
    type: 'ASSET_CLASS',
    toleranceBand: 2.0,
    rebalanceMode: 'CASH_FIRST',
    allocations: [
      { id: 'EQUITY', label: 'Azioni Core', targetPercent: 70.0 },
      { id: 'BOND', label: 'Obbligazioni', targetPercent: 20.0 },
      { id: 'CASH', label: 'Liquidità / Satellite', targetPercent: 10.0 }
    ]
  }
];

const DYNAMIC_PRESET_MODELS = [
  {
    id: 'all_holdings',
    name: 'Pesi Attuali Portafoglio (Tutti i Titoli)',
    description: 'Ribilanciamento analitico di ogni singolo titolo presente in portafoglio in base ai pesi attuali.',
    type: 'HOLDING',
    toleranceBand: 1.5,
    rebalanceMode: 'CASH_FIRST',
    isDynamic: true,
    allocations: []
  },
  {
    id: 'equal_weight_holdings',
    name: 'Equipesato su Tutti i Titoli (Equal Weight)',
    description: 'Distribuzione del capitale in parti uguali tra tutti i titoli attualmente detenuti.',
    type: 'HOLDING',
    toleranceBand: 1.5,
    rebalanceMode: 'CASH_FIRST',
    isDynamic: true,
    allocations: []
  }
];

const CATEGORY_FRIENDLY_LABELS = {
  EQUITY: 'Azioni (Equity)',
  BOND: 'Obbligazioni (Bond)',
  CASH: 'Liquidità (Cash)',
  COMMODITY: 'Materie Prime (Commodities)',
  CRYPTO: 'Criptovalute (Crypto)',
  REAL_ESTATE: 'Immobiliare (Real Estate)'
};

/**
 * Normalizes asset type or holding object to standard taxonomy for asset class rebalancing.
 */
function normalizeAssetClass(h) {
  if (!h) return 'EQUITY';
  if (typeof h === 'string') {
    const t = h.toUpperCase().trim();
    if (t.includes('BOND') || t.includes('BTP') || t.includes('BOT') || t.includes('TREASURY') || t === 'FIXED_INCOME') return 'BOND';
    if (t.includes('COMMODIT') || t.includes('GOLD') || t.includes('METAL') || t.includes('OIL')) return 'COMMODITY';
    if (t.includes('CRYPTO') || t.includes('BTC') || t.includes('ETH')) return 'CRYPTO';
    if (t.includes('CASH') || t.includes('LIQUID') || t.includes('CURRENCY') || t.includes('FOREX')) return 'CASH';
    if (t.includes('REAL_ESTATE') || t.includes('REIT')) return 'REAL_ESTATE';
    if (t === 'ETF' || t === 'STOCK' || t === 'EQUITY' || t === 'SHARE') return 'EQUITY';
    return 'EQUITY';
  }

  const ticker = String(h.ticker || '').toUpperCase().trim();
  const name = String(h.name || '').toUpperCase().trim();
  const type = String(h.type || 'EQUITY').toUpperCase().trim();
  const sector = String(h.sector || '').toUpperCase().trim();

  // Cash / Liquidity / Money Market / Currencies (e.g. XEON, C3M, SMART, overnight rate, conto deposito, EURUSD=X)
  if (
    type === 'CASH' || type === 'LIQUIDITY' || type === 'CURRENCY' || type === 'FOREX' ||
    ticker === 'XEON.DE' || ticker === 'XEON' || ticker === 'C3M.MI' || ticker === 'SMART.MI' ||
    ticker.endsWith('=X') ||
    name.includes('OVERNIGHT') || name.includes('OVER.RATE') || name.includes('MONEY MARKET') ||
    name.includes('LIQUIDIT') || name.includes('CONTO DEPOSITO')
  ) {
    return 'CASH';
  }

  // Bonds / Fixed Income (BTP, BOT, Government, Corporate bonds, Bond ETFs)
  if (
    type.includes('BOND') || type.includes('BTP') || type.includes('BOT') || type === 'FIXED_INCOME' ||
    sector === 'GOVERNMENT' || sector.includes('TREASURY') || sector.includes('FIXED INCOME') ||
    name.includes('BTP') || name.includes('BOT') || name.includes('BOND') || name.includes('GOVT') ||
    name.includes('TREASURY') || name.includes('OBBLIGAZION')
  ) {
    return 'BOND';
  }
  if (type !== 'EQUITY' && type !== 'STOCK' && (ticker.startsWith('IT000') || ticker.startsWith('XS'))) {
    return 'BOND';
  }

  // Commodities (Gold, Oil, Gas, Metals)
  if (
    type.includes('COMMODIT') || type === 'GOLD' ||
    name.includes('GOLD') || name.includes('NATURAL GAS') || name.includes('COMMODITY') || name.includes('METALS') || name.includes('OIL')
  ) {
    return 'COMMODITY';
  }

  // Cryptocurrencies
  if (type === 'CRYPTO' || ticker.includes('BTC') || ticker.includes('ETH')) {
    return 'CRYPTO';
  }

  // Real Estate / REITs
  if (type.includes('REAL_ESTATE') || sector.includes('REAL ESTATE') || type === 'REIT') {
    return 'REAL_ESTATE';
  }

  return 'EQUITY';
}

/**
 * Classifies any asset into one of 4 macro-categories:
 * - 'AZIONARIO' (Stocks, Equity ETFs, Risk Assets)
 * - 'OBBLIGAZIONARIO' (Bonds, Bond ETFs, BTP, BOT, Deposits, Postal Bonds, Pension/TFR)
 * - 'LIQUIDITA' (Uninvested Cash, Monetary / Overnight ETFs, Currencies)
 * - 'ORO' (Gold ETCs, Precious Metals, Physical Gold, Commodities)
 */
function classifyMacroCategory(h) {
  if (!h) return 'AZIONARIO';
  if (typeof h === 'string') {
    const t = h.toUpperCase().trim();
    if (t.includes('GOLD') || t.includes('COMMODIT') || t.includes('METAL') || t.includes('ORO') || t.includes('SILVER') || t.includes('OIL') || t.includes('GAS')) return 'ORO';
    if (t.includes('BOND') || t.includes('BTP') || t.includes('BOT') || t.includes('TREASURY') || t.includes('FIXED') || t.includes('DEPOSITO') || t.includes('BUONO') || t.includes('TFR') || t.includes('PENSIONE')) return 'OBBLIGAZIONARIO';
    if (t.includes('CASH') || t.includes('LIQUID') || t.includes('CURRENCY') || t.includes('FOREX') || t.includes('MONEY')) return 'LIQUIDITA';
    return 'AZIONARIO';
  }

  const ticker = String(h.ticker || '').toUpperCase().trim();
  const name = String(h.name || '').toUpperCase().trim();
  const type = String(h.type || 'EQUITY').toUpperCase().trim();
  const sector = String(h.sector || '').toUpperCase().trim();

  // 1. ORO & Metalli Preziosi / Materie Prime
  if (
    type === 'GOLD' || type === 'COMMODITY' ||
    ticker.startsWith('SGLD') || ticker.startsWith('4GLD') || ticker.startsWith('PHAU') || ticker.startsWith('IGLN') ||
    ticker.startsWith('XGDU') || ticker.startsWith('EGLN') || ticker === 'GLD' || ticker === 'IAU' || ticker === 'BAR' ||
    ticker === 'SGOL' || ticker === 'NGAS.MI' || ticker === 'NGAS' ||
    name.includes('GOLD') || name.includes('ORO') || name.includes('METALL') || name.includes('PRECIOUS') ||
    name.includes('COMMODIT') || name.includes('NATURAL GAS') || name.includes('OIL') || name.includes('SILVER')
  ) {
    return 'ORO';
  }

  // 2. LIQUIDITA (Cash, Conto Deposito libero, Monetary/Overnight ETFs, Valute)
  if (
    type === 'CASH' || type === 'LIQUIDITY' || type === 'CURRENCY' || type === 'FOREX' ||
    ticker === 'XEON.DE' || ticker === 'XEON' || ticker === 'XEON.MI' || ticker === 'C3M.MI' || ticker === 'SMART.MI' ||
    ticker.endsWith('=X') ||
    name.includes('OVERNIGHT') || name.includes('OVER.RATE') || name.includes('MONEY MARKET') ||
    name.includes('LIQUIDIT')
  ) {
    return 'LIQUIDITA';
  }

  // 3. OBBLIGAZIONARIO (BTP, BOT, Obbligazioni, Conti Deposito Vincolati, Buoni Postali, TFR, Fondi Pensione)
  if (
    type.includes('BOND') || type.includes('BTP') || type.includes('BOT') || type === 'FIXED_INCOME' ||
    type === 'DEPOSITO_VINCOLATO' || type === 'BUONO_POSTALE' || type === 'TFR' || type === 'FONDO_PENSIONE' ||
    sector === 'GOVERNMENT' || sector.includes('TREASURY') || sector.includes('FIXED INCOME') ||
    name.includes('BTP') || name.includes('BOT') || name.includes('BOND') || name.includes('GOVT') ||
    name.includes('TREASURY') || name.includes('OBBLIGAZION') || name.includes('CONTO DEPOSITO') || name.includes('BUONO POSTALE') ||
    name.includes('FONDO PENSIONE') || name.includes('TFR') ||
    (type !== 'EQUITY' && type !== 'STOCK' && (ticker.startsWith('IT000') || ticker.startsWith('XS')))
  ) {
    return 'OBBLIGAZIONARIO';
  }

  // 4. AZIONARIO (Azioni, ETF Azionari, Crypto / Risk Assets)
  return 'AZIONARIO';
}

/**
 * Computes portfolio-wide Macro Asset Allocation across 4 buckets:
 * Azionario, Obbligazionario, Liquidità, Oro.
 */
function computeMacroAllocation({ holdings = [], currentCash = 0.0, addedCash = 0.0 }) {
  const categories = {
    AZIONARIO: {
      key: 'AZIONARIO',
      label: 'Azionario',
      icon: '📈',
      color: '#3b82f6',
      bgClass: 'bg-blue-500',
      value: 0.0,
      weight: 0.0,
      holdingsCount: 0,
      holdings: []
    },
    OBBLIGAZIONARIO: {
      key: 'OBBLIGAZIONARIO',
      label: 'Obbligazionario',
      icon: '🏛️',
      color: '#10b981',
      bgClass: 'bg-emerald-500',
      value: 0.0,
      weight: 0.0,
      holdingsCount: 0,
      holdings: []
    },
    LIQUIDITA: {
      key: 'LIQUIDITA',
      label: 'Liquidità',
      icon: '💧',
      color: '#06b6d4',
      bgClass: 'bg-cyan-500',
      value: 0.0,
      weight: 0.0,
      holdingsCount: 0,
      holdings: []
    },
    ORO: {
      key: 'ORO',
      label: 'Oro & Metalli',
      icon: '🪙',
      color: '#f59e0b',
      bgClass: 'bg-amber-500',
      value: 0.0,
      weight: 0.0,
      holdingsCount: 0,
      holdings: []
    }
  };

  let totalHoldingsVal = 0.0;

  for (const h of holdings) {
    const val = Number(h.marketValue) || 0.0;
    totalHoldingsVal += val;
    const catKey = classifyMacroCategory(h);
    const cat = categories[catKey] || categories.AZIONARIO;
    cat.value += val;
    cat.holdingsCount += 1;
    cat.holdings.push(h);
  }

  // Include cash balances in Liquidità
  const totalCashPool = Math.max(0.0, (Number(currentCash) || 0.0) + (Number(addedCash) || 0.0));
  categories.LIQUIDITA.value += totalCashPool;
  if (totalCashPool > 0 && categories.LIQUIDITA.holdingsCount === 0) {
    categories.LIQUIDITA.holdingsCount = 1; // cash balance
  }

  const totalValue = totalHoldingsVal + totalCashPool;

  // Compute percentages
  for (const cat of Object.values(categories)) {
    cat.weight = totalValue > 0 ? Number(((cat.value / totalValue) * 100.0).toFixed(1)) : 0.0;
  }

  return {
    totalValue,
    totalHoldingsValue: totalHoldingsVal,
    totalCashPool,
    categories
  };
}

/**
 * Computes Sector Breakdown for Equity Holdings.
 */
function computeSectorAggregation(equityHoldings = [], totalPortfolioValue = 0.0) {
  const totalEquityValue = equityHoldings.reduce((sum, h) => sum + (Number(h.marketValue) || 0.0), 0.0);
  const sectorMap = new Map();

  for (const h of equityHoldings) {
    const rawSector = h.sector || 'Information Technology';
    const sector = rawSector.trim() || 'Information Technology';
    const val = Number(h.marketValue) || 0.0;

    if (!sectorMap.has(sector)) {
      sectorMap.set(sector, {
        name: sector,
        label: sector,
        value: 0.0,
        weightInEquity: 0.0,
        weightInPortfolio: 0.0,
        holdingsCount: 0,
        assets: []
      });
    }

    const item = sectorMap.get(sector);
    item.value += val;
    item.holdingsCount += 1;
    item.assets.push({
      ticker: h.ticker,
      name: h.name || h.ticker,
      marketValue: val,
      region: h.region || 'Globale',
      country: h.country || ''
    });
  }

  const sectors = Array.from(sectorMap.values()).map(s => {
    s.weightInEquity = totalEquityValue > 0 ? Number(((s.value / totalEquityValue) * 100.0).toFixed(1)) : 0.0;
    s.weightInPortfolio = totalPortfolioValue > 0 ? Number(((s.value / totalPortfolioValue) * 100.0).toFixed(1)) : 0.0;
    // Sort assets in this sector
    s.assets.sort((a, b) => b.marketValue - a.marketValue);
    s.assets.forEach(a => {
      a.weightInSector = s.value > 0 ? Number(((a.marketValue / s.value) * 100.0).toFixed(1)) : 0.0;
      a.weightInEquity = totalEquityValue > 0 ? Number(((a.marketValue / totalEquityValue) * 100.0).toFixed(1)) : 0.0;
      a.weightInPortfolio = totalPortfolioValue > 0 ? Number(((a.marketValue / totalPortfolioValue) * 100.0).toFixed(1)) : 0.0;
    });
    return s;
  });

  sectors.sort((a, b) => b.value - a.value);

  return {
    totalEquityValue,
    sectors
  };
}

/**
 * Computes Geographical Region Breakdown for Equity Holdings.
 */
function computeRegionAggregation(equityHoldings = [], totalPortfolioValue = 0.0) {
  const totalEquityValue = equityHoldings.reduce((sum, h) => sum + (Number(h.marketValue) || 0.0), 0.0);
  const regionMap = new Map();

  for (const h of equityHoldings) {
    const rawRegion = h.region || 'Globale';
    const region = rawRegion.trim() || 'Globale';
    const val = Number(h.marketValue) || 0.0;

    if (!regionMap.has(region)) {
      regionMap.set(region, {
        name: region,
        label: region,
        value: 0.0,
        weightInEquity: 0.0,
        weightInPortfolio: 0.0,
        holdingsCount: 0
      });
    }

    const item = regionMap.get(region);
    item.value += val;
    item.holdingsCount += 1;
  }

  const regions = Array.from(regionMap.values()).map(r => {
    r.weightInEquity = totalEquityValue > 0 ? Number(((r.value / totalEquityValue) * 100.0).toFixed(1)) : 0.0;
    r.weightInPortfolio = totalPortfolioValue > 0 ? Number(((r.value / totalPortfolioValue) * 100.0).toFixed(1)) : 0.0;
    return r;
  });

  regions.sort((a, b) => b.value - a.value);

  return {
    totalEquityValue,
    regions
  };
}

/**
 * Computes Wealthfolio-aligned Rebalancing Worksheet.
 *
 * @param {object} params
 * @param {Array<object>} params.holdings - Holdings array from calculateHoldingsAndMetrics
 * @param {number} params.currentCash - Available cash in portfolio
 * @param {number} [params.addedCash=0.0] - Planned new deposit/PAC cash injection
 * @param {Array<object>} params.targetAllocations - Target weights summing to 100%
 * @param {'ASSET_CLASS'|'HOLDING'} [params.targetType='ASSET_CLASS']
 * @param {'CASH_FIRST'|'FULL_REBALANCE'} [params.strategy='CASH_FIRST']
 * @param {object} [params.options]
 * @param {number} [params.options.toleranceBand=2.0] - Absolute tolerance band (e.g. ±2.0%)
 * @param {boolean} [params.options.allowFractional=false] - Whole shares vs fractional
 * @param {number} [params.options.minTradeSize=25.0] - Minimum trade order size in EUR
 * @param {number} [params.options.cashBuffer=0.0] - Reserve cash to keep untouched
 * @returns {object} Full rebalancing worksheet with proposed trades and projected metrics
 */
function calculateRebalanceWorksheet(params) {
  const {
    holdings = [],
    currentCash = 0.0,
    addedCash = 0.0,
    targetAllocations = [],
    targetType = 'ASSET_CLASS',
    strategy = 'CASH_FIRST',
    scope = 'all',
    options = {}
  } = params;

  const toleranceBand = Number(options.toleranceBand) >= 0 ? Number(options.toleranceBand) : 2.0;
  const allowFractional = Boolean(options.allowFractional);
  const minTradeSize = Number(options.minTradeSize) >= 0 ? Number(options.minTradeSize) : 25.0;
  const cashBuffer = Number(options.cashBuffer) >= 0 ? Number(options.cashBuffer) : 0.0;

  // Global macro allocation and breakdowns (always computed on full holdings)
  const macroAllocation = computeMacroAllocation({ holdings, currentCash, addedCash });
  const bySector = computeSectorAggregation(holdings.filter(h => classifyMacroCategory(h) === 'AZIONARIO'), macroAllocation.totalValue);
  const byRegion = computeRegionAggregation(holdings.filter(h => classifyMacroCategory(h) === 'AZIONARIO'), macroAllocation.totalValue);

  const cleanScope = String(scope || 'all').trim().toLowerCase();

  // Filter holdings if scope is limited to Azionario or Obbligazionario
  let activeHoldings = holdings;
  if (cleanScope === 'azionario') {
    activeHoldings = holdings.filter(h => classifyMacroCategory(h) === 'AZIONARIO');
  } else if (cleanScope === 'obbligazionario') {
    activeHoldings = holdings.filter(h => classifyMacroCategory(h) === 'OBBLIGAZIONARIO');
  }

  // Total current market value of assets in active scope
  const totalHoldingsValue = activeHoldings.reduce((sum, h) => sum + (Number(h.marketValue) || 0.0), 0.0);
  const scopeCash = cleanScope === 'all' ? (currentCash + addedCash) : 0.0;
  const availableCash = Math.max(0.0, scopeCash - cashBuffer);
  const totalPortfolioValue = cleanScope === 'all'
    ? (totalHoldingsValue + currentCash + addedCash)
    : totalHoldingsValue;

  // Validate allocations sum
  const sumTargetWeights = targetAllocations.reduce((sum, a) => sum + (Number(a.targetPercent) || 0.0), 0.0);

  // Group holdings either by Holding (Ticker) or by Asset Class
  let lines = [];

  if (targetType === 'HOLDING') {
    // 1. Target by single Holding / Ticker
    const targetMap = new Map();
    for (const t of targetAllocations) {
      targetMap.set(String(t.ticker || t.id).toUpperCase().trim(), t);
    }

    // Process all existing active holdings
    const processedTickers = new Set();
    for (const h of activeHoldings) {
      const sym = String(h.ticker).toUpperCase().trim();
      processedTickers.add(sym);
      const t = targetMap.get(sym);
      const targetWeight = t ? Number(t.targetPercent) || 0.0 : 0.0;
      const targetVal = totalPortfolioValue * (targetWeight / 100.0);
      const curVal = Number(h.marketValue) || 0.0;
      const curWeight = totalPortfolioValue > 0 ? (curVal / totalPortfolioValue) * 100.0 : 0.0;
      const curPrice = Number(h.currentPrice) || Number(h.rawPrice) || 1.0;
      const curQty = Number(h.quantity) || 0.0;

      const macroCat = classifyMacroCategory(h);
      const classTotalVal = macroAllocation.categories[macroCat]?.value || totalHoldingsValue;
      const weightInClass = classTotalVal > 0 ? Number(((curVal / classTotalVal) * 100.0).toFixed(1)) : 0.0;
      const weightInPortfolio = macroAllocation.totalValue > 0 ? Number(((curVal / macroAllocation.totalValue) * 100.0).toFixed(1)) : 0.0;

      lines.push({
        id: sym,
        ticker: sym,
        name: h.name || sym,
        type: h.type || 'EQUITY',
        macroCategory: macroCat,
        sector: h.sector || 'Information Technology',
        region: h.region || 'Globale',
        country: h.country || '',
        currency: h.currency || 'EUR',
        currentPrice: curPrice,
        currentQuantity: curQty,
        currentValue: curVal,
        currentPercent: curWeight,
        weightInPortfolio,
        weightInClass,
        targetPercent: targetWeight,
        targetValue: targetVal,
        driftPercent: curWeight - targetWeight,
        driftValue: curVal - targetVal,
        isTargeted: Boolean(t)
      });
    }

    // Also include any targeted securities not yet held in portfolio
    for (const [sym, t] of targetMap.entries()) {
      if (!processedTickers.has(sym)) {
        const targetWeight = Number(t.targetPercent) || 0.0;
        const targetVal = totalPortfolioValue * (targetWeight / 100.0);
        const curPrice = Number(t.price) || Number(t.currentPrice) || 100.0; // estimate if new

        lines.push({
          id: sym,
          ticker: sym,
          name: t.label || t.name || sym,
          type: t.type || 'EQUITY',
          macroCategory: classifyMacroCategory(t),
          sector: t.sector || 'Information Technology',
          region: t.region || 'Globale',
          country: t.country || '',
          currency: t.currency || 'EUR',
          currentPrice: curPrice,
          currentQuantity: 0.0,
          currentValue: 0.0,
          currentPercent: 0.0,
          weightInPortfolio: 0.0,
          weightInClass: 0.0,
          targetPercent: targetWeight,
          targetValue: targetVal,
          driftPercent: 0.0 - targetWeight,
          driftValue: 0.0 - targetVal,
          isTargeted: true
        });
      }
    }
  } else {
    // 2. Target by Asset Class (Default & Standard Wealthfolio workflow)
    const targetMap = new Map();
    for (const t of targetAllocations) {
      targetMap.set(String(t.id).toUpperCase().trim(), t);
    }

    // Build categories aggregation
    const catMap = new Map();

    // Initialize all target categories
    for (const [id, t] of targetMap.entries()) {
      catMap.set(id, {
        id,
        label: t.label || CATEGORY_FRIENDLY_LABELS[id] || id,
        currentValue: 0.0,
        targetPercent: Number(t.targetPercent) || 0.0,
        holdings: []
      });
    }

    // Aggregate holdings into categories
    for (const h of activeHoldings) {
      const cls = normalizeAssetClass(h);
      let cat = catMap.get(cls);
      if (!cat) {
        cat = {
          id: cls,
          label: CATEGORY_FRIENDLY_LABELS[cls] || cls,
          currentValue: 0.0,
          targetPercent: 0.0,
          holdings: []
        };
        catMap.set(cls, cat);
      }
      cat.currentValue += (Number(h.marketValue) || 0.0);
      cat.holdings.push(h);
    }

    // Include Cash if available or targeted (only if global scope or cash targeted)
    if (cleanScope === 'all' && (currentCash > 0 || catMap.has('CASH'))) {
      let cashCat = catMap.get('CASH');
      if (!cashCat) {
        cashCat = {
          id: 'CASH',
          label: CATEGORY_FRIENDLY_LABELS['CASH'],
          currentValue: 0.0,
          targetPercent: 0.0,
          holdings: []
        };
        catMap.set('CASH', cashCat);
      }
      cashCat.currentValue += currentCash;
    }

    for (const [id, cat] of catMap.entries()) {
      const curVal = cat.currentValue;
      const targetWeight = cat.targetPercent;
      const curWeight = totalPortfolioValue > 0 ? (curVal / totalPortfolioValue) * 100.0 : 0.0;
      const targetVal = totalPortfolioValue * (targetWeight / 100.0);

      // Choose representative price or holding for trading suggestions
      const firstHolding = cat.holdings[0];
      const curPrice = firstHolding ? (Number(firstHolding.currentPrice) || Number(firstHolding.rawPrice) || 1.0) : 1.0;
      const repTicker = firstHolding ? firstHolding.ticker : id;
      const repName = cat.label;

      lines.push({
        id,
        ticker: repTicker,
        name: repName,
        type: id,
        category: id,
        isAssetClass: true,
        holdingCount: cat.holdings.length,
        categoryHoldings: cat.holdings.map(h => {
          const hVal = Number(h.marketValue) || 0;
          return {
            ticker: h.ticker,
            name: h.name || h.ticker,
            macroCategory: classifyMacroCategory(h),
            sector: h.sector || 'Information Technology',
            region: h.region || 'Globale',
            country: h.country || '',
            quantity: Number(h.quantity) || 0,
            currentPrice: Number(h.currentPrice) || Number(h.rawPrice) || 0,
            marketValue: hVal,
            weight: totalPortfolioValue > 0 ? Number(((hVal / totalPortfolioValue) * 100).toFixed(1)) : 0,
            weightInPortfolio: macroAllocation.totalValue > 0 ? Number(((hVal / macroAllocation.totalValue) * 100).toFixed(1)) : 0,
            weightInClass: cat.currentValue > 0 ? Number(((hVal / cat.currentValue) * 100).toFixed(1)) : 0
          };
        }),
        currency: firstHolding?.currency || 'EUR',
        currentPrice: curPrice,
        currentQuantity: cat.holdings.length,
        currentValue: curVal,
        currentPercent: curWeight,
        targetPercent: targetWeight,
        targetValue: targetVal,
        driftPercent: curWeight - targetWeight,
        driftValue: curVal - targetVal,
        isTargeted: targetMap.has(id)
      });
    }
  }

  // Determine status (In band, Overweight, Underweight)
  for (const line of lines) {
    const absDrift = Math.abs(line.driftPercent);
    line.inBand = absDrift <= toleranceBand;
    if (line.inBand) {
      line.status = 'IN_BAND';
      line.statusLabel = 'In Tolleranza';
    } else if (line.driftPercent > toleranceBand) {
      line.status = 'OVERWEIGHT';
      line.statusLabel = 'Sovrappesato';
    } else {
      line.status = 'UNDERWEIGHT';
      line.statusLabel = 'Sottopesato';
    }
  }

  // --- REBALANCING CALCULATION LOGIC ---
  let totalSells = 0.0;
  let totalBuys = 0.0;
  let simulatedCash = availableCash;

  if (strategy === 'FULL_REBALANCE') {
    // 1. Full Rebalance Mode: Sell overweight positions first to generate cash
    for (const line of lines) {
      if (line.status === 'OVERWEIGHT' && line.driftValue > minTradeSize) {
        const excessValue = line.driftValue;
        const sellAmount = Math.min(excessValue, line.currentValue);
        let sellQty = line.currentPrice > 0 ? (sellAmount / line.currentPrice) : 0;
        if (!allowFractional) sellQty = Math.floor(sellQty);

        const realSellAmount = sellQty * line.currentPrice;
        if (realSellAmount >= minTradeSize && sellQty > 0) {
          line.action = 'SELL';
          line.suggestedQuantity = sellQty;
          line.suggestedAmount = realSellAmount;
          totalSells += realSellAmount;
          simulatedCash += realSellAmount;
        } else {
          line.action = 'HOLD';
          line.suggestedQuantity = 0;
          line.suggestedAmount = 0.0;
        }
      }
    }

    // Now buy underweight positions using available + generated cash
    // Sort underweight lines by largest gap first (Greedy deviation reduction)
    const underweights = lines.filter(l => l.status === 'UNDERWEIGHT' && l.driftValue < -minTradeSize);
    underweights.sort((a, b) => a.driftValue - b.driftValue); // most negative first

    for (const line of underweights) {
      const shortageValue = Math.abs(line.driftValue);
      const buyCap = Math.min(shortageValue, simulatedCash);
      let buyQty = line.currentPrice > 0 ? (buyCap / line.currentPrice) : 0;
      if (!allowFractional) buyQty = Math.floor(buyQty);

      const realBuyAmount = buyQty * line.currentPrice;
      if (realBuyAmount >= minTradeSize && buyQty > 0 && simulatedCash >= realBuyAmount) {
        line.action = 'BUY';
        line.suggestedQuantity = buyQty;
        line.suggestedAmount = realBuyAmount;
        totalBuys += realBuyAmount;
        simulatedCash -= realBuyAmount;
      } else if (!line.action) {
        line.action = 'HOLD';
        line.suggestedQuantity = 0;
        line.suggestedAmount = 0.0;
      }
    }
  } else {
    // 2. CASH_FIRST Mode (Wealthfolio standard: Buy-Only / PAC cash deployment without selling)
    for (const line of lines) {
      if (line.status === 'OVERWEIGHT') {
        line.action = 'HOLD';
        line.suggestedQuantity = 0;
        line.suggestedAmount = 0.0;
      }
    }

    // Identify underweight positions
    const underweights = lines.filter(l => l.status === 'UNDERWEIGHT' && l.driftValue < -minTradeSize);
    // Sort by largest negative gap first
    underweights.sort((a, b) => a.driftValue - b.driftValue);

    const totalShortage = underweights.reduce((sum, l) => sum + Math.abs(l.driftValue), 0.0);

    // Phase 1 (Greedy Deviation Reduction): allocate cash proportionally to close the largest gaps
    for (const line of underweights) {
      const shortage = Math.abs(line.driftValue);
      let allocatedCash = 0.0;

      if (totalShortage > 0) {
        const proportion = shortage / totalShortage;
        allocatedCash = Math.min(shortage, availableCash * proportion);
      } else {
        allocatedCash = shortage;
      }

      // Also ensure we don't exceed available cash pool
      allocatedCash = Math.min(allocatedCash, simulatedCash);

      let buyQty = line.currentPrice > 0 ? (allocatedCash / line.currentPrice) : 0;
      if (!allowFractional) buyQty = Math.floor(buyQty);

      const realBuyAmount = buyQty * line.currentPrice;
      if (realBuyAmount >= minTradeSize && buyQty > 0 && simulatedCash >= realBuyAmount) {
        line.action = 'BUY';
        line.suggestedQuantity = buyQty;
        line.suggestedAmount = realBuyAmount;
        totalBuys += realBuyAmount;
        simulatedCash -= realBuyAmount;
      } else {
        line.action = 'HOLD';
        line.suggestedQuantity = 0;
        line.suggestedAmount = 0.0;
      }
    }

    // Phase 2: If residual cash remains and can buy units of the most underweight, deploy residual cash
    if (simulatedCash >= minTradeSize) {
      for (const line of underweights) {
        if (simulatedCash < line.currentPrice) continue;
        const additionalQty = !allowFractional
          ? Math.floor(simulatedCash / line.currentPrice)
          : (simulatedCash / line.currentPrice);
        
        if (additionalQty > 0) {
          const addedVal = additionalQty * line.currentPrice;
          line.suggestedQuantity = (line.suggestedQuantity || 0) + additionalQty;
          line.suggestedAmount = (line.suggestedAmount || 0.0) + addedVal;
          line.action = 'BUY';
          totalBuys += addedVal;
          simulatedCash -= addedVal;
        }
        if (simulatedCash < minTradeSize) break;
      }
    }
  }

  // Ensure every line has an action defined
  for (const line of lines) {
    if (!line.action) {
      line.action = 'HOLD';
      line.suggestedQuantity = 0;
      line.suggestedAmount = 0.0;
    }
  }

  // --- PROJECTED STATE RECALCULATION ---
  const newTotalPortfolioValue = totalPortfolioValue; // asset value + net trades + funding

  for (const line of lines) {
    let projVal = 0.0;
    let projQty = line.currentQuantity;

    if (line.isAssetClass || targetType === 'ASSET_CLASS') {
      const orderAmount = Number(line.suggestedAmount) || 0.0;
      const amountChange = line.action === 'BUY'
        ? orderAmount
        : (line.action === 'SELL' ? -orderAmount : 0.0);
      projVal = Math.max(0.0, line.currentValue + amountChange);
      projQty = line.currentQuantity;
    } else {
      const qtyChange = line.action === 'BUY'
        ? line.suggestedQuantity
        : (line.action === 'SELL' ? -line.suggestedQuantity : 0.0);
      projQty = Math.max(0.0, line.currentQuantity + qtyChange);
      projVal = projQty * line.currentPrice;
    }

    const projWeight = newTotalPortfolioValue > 0 ? (projVal / newTotalPortfolioValue) * 100.0 : 0.0;
    const projDrift = projWeight - line.targetPercent;
    const projInBand = Math.abs(projDrift) <= toleranceBand;

    line.projectedQuantity = projQty;
    line.projectedValue = projVal;
    line.projectedPercent = projWeight;
    line.projectedDriftPercent = projDrift;
    line.projectedInBand = projInBand;
    line.projectedStatus = projInBand
      ? 'IN_BAND'
      : (projDrift > toleranceBand ? 'OVERWEIGHT' : 'UNDERWEIGHT');
  }

  // Compute summary metrics
  const fundingLeft = (currentCash + addedCash - totalBuys + totalSells);
  const maxDriftBefore = lines.reduce((max, l) => Math.max(max, Math.abs(l.driftPercent)), 0.0);
  const maxDriftAfter = lines.reduce((max, l) => Math.max(max, Math.abs(l.projectedDriftPercent)), 0.0);
  const inBandBefore = lines.filter(l => l.inBand).length;
  const inBandAfter = lines.filter(l => l.projectedInBand).length;
  const tradeCount = lines.filter(l => l.action === 'BUY' || l.action === 'SELL').length;

  return {
    strategy,
    targetType,
    scope: cleanScope,
    toleranceBand,
    allowFractional,
    minTradeSize,
    cashBuffer,
    totalPortfolioValue,
    currentCash,
    addedCash,
    availableCash,
    totalBuys,
    totalSells,
    fundingLeft,
    maxDriftBefore,
    maxDriftAfter,
    inBandBefore,
    inBandAfter,
    totalCategories: lines.length,
    tradeCount,
    sumTargetWeights,
    macroAllocation,
    bySector,
    byRegion,
    lines
  };
}

/**
 * Generates a Wealthfolio-compatible CSV export of the Rebalancing Worksheet.
 */
function generateRebalanceCsv(worksheet, portfolioName = 'Portfolio') {
  const dateStr = new Date().toISOString().split('T')[0];
  const headers = [
    'Ticker',
    'Nome / Categoria',
    'Prezzo Attuale',
    'Quantità Attuale',
    'Valore Attuale',
    'Peso Attuale (%)',
    'Peso Target (%)',
    'Drift (%)',
    'Azione',
    'Quantità Suggerita',
    'Importo Ordine (€)',
    'Quantità Prevista',
    'Valore Previsto (€)',
    'Peso Previsto (%)',
    'Drift Previsto (%)'
  ];

  const rows = [headers.join(',')];

  for (const l of worksheet.lines) {
    const escape = (v) => `"${String(v || '').replace(/"/g, '""')}"`;
    const row = [
      escape(l.ticker || l.id),
      escape(l.name),
      Number(l.currentPrice).toFixed(2),
      Number(l.currentQuantity).toFixed(4),
      Number(l.currentValue).toFixed(2),
      Number(l.currentPercent).toFixed(2),
      Number(l.targetPercent).toFixed(2),
      Number(l.driftPercent).toFixed(2),
      escape(l.action),
      Number(l.suggestedQuantity).toFixed(worksheet.allowFractional ? 4 : 0),
      Number(l.suggestedAmount).toFixed(2),
      Number(l.projectedQuantity).toFixed(worksheet.allowFractional ? 4 : 0),
      Number(l.projectedValue).toFixed(2),
      Number(l.projectedPercent).toFixed(2),
      Number(l.projectedDriftPercent).toFixed(2)
    ];
    rows.push(row.join(','));
  }

  return rows.join('\r\n');
}

/**
 * Generates clean formatted text for clipboard copying to broker order masks.
 */
function generateClipboardOrderText(worksheet, portfolioName = 'Portafoglio') {
  const dateStr = new Date().toLocaleDateString('it-IT');
  const trades = worksheet.lines.filter(l => l.action === 'BUY' || l.action === 'SELL');

  let text = `📋 PIANO DI RIBILANCIAMENTO FOLIOTRACK - ${portfolioName.toUpperCase()}\n`;
  text += `Data: ${dateStr} | Strategia: ${worksheet.strategy === 'CASH_FIRST' ? 'Solo Acquisti (Cash-First)' : 'Ribilanciamento Completo'}\n`;
  text += `------------------------------------------------------------\n`;

  if (trades.length === 0) {
    text += `✅ Nessun ordine necessario: il portafoglio è già all'interno delle bande di tolleranza (±${worksheet.toleranceBand}%).\n`;
  } else {
    trades.forEach((t, i) => {
      const verb = t.action === 'BUY' ? '🟢 COMPRA' : '🔴 VENDI';
      const label = t.isAssetClass ? `${t.name} (${t.ticker})` : t.ticker;
      text += `${i + 1}. ${verb} ${label}: ${t.suggestedQuantity} quote @ ~€${Number(t.currentPrice).toFixed(2)} (Totale: €${Number(t.suggestedAmount).toFixed(2)})\n`;
    });
  }

  text += `------------------------------------------------------------\n`;
  text += `Totale Acquisti: €${Number(worksheet.totalBuys).toFixed(2)} | Totale Vendite: €${Number(worksheet.totalSells).toFixed(2)}\n`;
  text += `Liquidità Residua Prevista: €${Number(worksheet.fundingLeft).toFixed(2)}\n`;
  text += `Max Drift: ${worksheet.maxDriftBefore.toFixed(2)}% ➔ ${worksheet.maxDriftAfter.toFixed(2)}%\n`;

  return text;
}

module.exports = {
  PRESET_TARGET_MODELS,
  DYNAMIC_PRESET_MODELS,
  CATEGORY_FRIENDLY_LABELS,
  normalizeAssetClass,
  classifyMacroCategory,
  computeMacroAllocation,
  computeSectorAggregation,
  computeRegionAggregation,
  calculateRebalanceWorksheet,
  generateRebalanceCsv,
  generateClipboardOrderText
};
