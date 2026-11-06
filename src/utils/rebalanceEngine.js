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

/**
 * Normalizes asset type to standard taxonomy for asset class rebalancing.
 */
function normalizeAssetClass(type) {
  const t = (type || 'EQUITY').toUpperCase().trim();
  if (t.includes('BOND') || t.includes('BTP') || t.includes('BOT') || t.includes('TREASURY') || t === 'FIXED_INCOME') return 'BOND';
  if (t.includes('COMMODIT') || t.includes('GOLD') || t.includes('METAL') || t.includes('OIL')) return 'COMMODITY';
  if (t.includes('CRYPTO') || t.includes('BTC') || t.includes('ETH')) return 'CRYPTO';
  if (t.includes('CASH') || t.includes('LIQUID')) return 'CASH';
  if (t.includes('REAL_ESTATE') || t.includes('REIT')) return 'REAL_ESTATE';
  if (t === 'ETF' || t === 'STOCK' || t === 'EQUITY' || t === 'SHARE') return 'EQUITY';
  return 'EQUITY';
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
    options = {}
  } = params;

  const toleranceBand = Number(options.toleranceBand) >= 0 ? Number(options.toleranceBand) : 2.0;
  const allowFractional = Boolean(options.allowFractional);
  const minTradeSize = Number(options.minTradeSize) >= 0 ? Number(options.minTradeSize) : 25.0;
  const cashBuffer = Number(options.cashBuffer) >= 0 ? Number(options.cashBuffer) : 0.0;

  // Total current market value of assets
  const totalHoldingsValue = holdings.reduce((sum, h) => sum + (Number(h.marketValue) || 0.0), 0.0);
  const availableCash = Math.max(0.0, currentCash + addedCash - cashBuffer);
  const totalPortfolioValue = totalHoldingsValue + currentCash + addedCash;

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

    // Process all existing holdings
    const processedTickers = new Set();
    for (const h of holdings) {
      const sym = String(h.ticker).toUpperCase().trim();
      processedTickers.add(sym);
      const t = targetMap.get(sym);
      const targetWeight = t ? Number(t.targetPercent) || 0.0 : 0.0;
      const targetVal = totalPortfolioValue * (targetWeight / 100.0);
      const curVal = Number(h.marketValue) || 0.0;
      const curWeight = totalPortfolioValue > 0 ? (curVal / totalPortfolioValue) * 100.0 : 0.0;
      const curPrice = Number(h.currentPrice) || Number(h.rawPrice) || 1.0;
      const curQty = Number(h.quantity) || 0.0;

      lines.push({
        id: sym,
        ticker: sym,
        name: h.name || sym,
        type: h.type || 'EQUITY',
        currency: h.currency || 'EUR',
        currentPrice: curPrice,
        currentQuantity: curQty,
        currentValue: curVal,
        currentPercent: curWeight,
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
          currency: t.currency || 'EUR',
          currentPrice: curPrice,
          currentQuantity: 0.0,
          currentValue: 0.0,
          currentPercent: 0.0,
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
        label: t.label || id,
        currentValue: 0.0,
        targetPercent: Number(t.targetPercent) || 0.0,
        holdings: []
      });
    }

    // Aggregate holdings into categories
    for (const h of holdings) {
      const cls = normalizeAssetClass(h.type);
      let cat = catMap.get(cls);
      if (!cat) {
        cat = {
          id: cls,
          label: cls,
          currentValue: 0.0,
          targetPercent: 0.0,
          holdings: []
        };
        catMap.set(cls, cat);
      }
      cat.currentValue += (Number(h.marketValue) || 0.0);
      cat.holdings.push(h);
    }

    // Include Cash if targeted
    if (catMap.has('CASH')) {
      const cashCat = catMap.get('CASH');
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
      const curQty = cat.holdings.reduce((sum, h) => sum + (Number(h.quantity) || 0.0), 0.0);
      const repTicker = firstHolding ? firstHolding.ticker : id;
      const repName = firstHolding ? `${cat.label} (${firstHolding.ticker})` : cat.label;

      lines.push({
        id,
        ticker: repTicker,
        name: repName,
        type: id,
        category: id,
        categoryHoldings: cat.holdings,
        currency: firstHolding?.currency || 'EUR',
        currentPrice: curPrice,
        currentQuantity: curQty,
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
    const qtyChange = line.action === 'BUY'
      ? line.suggestedQuantity
      : (line.action === 'SELL' ? -line.suggestedQuantity : 0.0);

    const projQty = Math.max(0.0, line.currentQuantity + qtyChange);
    const projVal = projQty * line.currentPrice;
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
      text += `${i + 1}. ${verb} ${t.ticker}: ${t.suggestedQuantity} quote @ ~€${Number(t.currentPrice).toFixed(2)} (Totale: €${Number(t.suggestedAmount).toFixed(2)})\n`;
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
  normalizeAssetClass,
  calculateRebalanceWorksheet,
  generateRebalanceCsv,
  generateClipboardOrderText
};
