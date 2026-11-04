const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const {
  calculateXIRR,
  calculateROI,
  calculateHoldingsAndMetrics
} = require('../src/utils/finance');

describe('Financial Calculation Engine (src/utils/finance.js)', () => {
  test('calculateROI should calculate correct return on investment', () => {
    assert.equal(calculateROI(1200, 1000), 0.2); // +20%
    assert.equal(calculateROI(800, 1000), -0.2); // -20%
    assert.equal(calculateROI(1000, 0), 0.0);
  });

  test('calculateXIRR should calculate accurate annualized return for cash flows', () => {
    // 1-year investment of 1000 returned 1100 exactly 1 year later -> +10%
    const flows = [
      { date: '2023-01-01', amount: -1000 },
      { date: '2024-01-01', amount: 1100 }
    ];
    const xirr = calculateXIRR(flows);
    // Tolerance within 0.001 of 0.10
    assert.ok(Math.abs(xirr - 0.10) < 0.005, `Expected ~0.10, got ${xirr}`);
  });

  test('calculateHoldingsAndMetrics handles WAC (PMC) with purchases, sales, and dividends', () => {
    const transactions = [
      { id: 1, type: 'DEPOSIT', amount: 5000, date: '2023-01-01' },
      // Buy 10 shares of AAPL at 100 EUR, commission 5 EUR
      { id: 2, type: 'BUY', assetTicker: 'AAPL', quantity: 10, price: 100, commission: 5, tax: 0, date: '2023-01-05' },
      // Buy another 10 shares of AAPL at 120 EUR, commission 5 EUR
      { id: 3, type: 'BUY', assetTicker: 'AAPL', quantity: 10, price: 120, commission: 5, tax: 0, date: '2023-02-01' },
      // Sell 5 shares of AAPL at 150 EUR, commission 5 EUR
      { id: 4, type: 'SELL', assetTicker: 'AAPL', quantity: 5, price: 150, commission: 5, tax: 0, date: '2023-03-01' },
      // Receive 20 EUR dividend
      { id: 5, type: 'DIVIDEND', assetTicker: 'AAPL', amount: 20, date: '2023-03-15' }
    ];

    const assetsMap = {
      AAPL: {
        ticker: 'AAPL',
        name: 'Apple Inc.',
        type: 'EQUITY',
        currentPrice: 160,
        sector: 'Information Technology',
        region: 'Americas'
      }
    };

    const metrics = calculateHoldingsAndMetrics(transactions, assetsMap, 0, 'WAC');

    // Total bought: 20 shares.
    // Buy 1: 10 * 100 + 5 = 1005 EUR (PMC = 100.5)
    // Buy 2: 10 * 120 + 5 = 1205 EUR.
    // Combined PMC = (1005 + 1205) / 20 = 2210 / 20 = 110.5 EUR.
    // Sale of 5 shares at 150: proceeds = 5 * 150 - 5 = 745.
    // Cost basis of 5 sold = 5 * 110.5 = 552.5. Realized P&L = 745 - 552.5 = 192.5 EUR.
    // Remaining quantity = 15 shares. PMC remains 110.5 EUR!
    assert.equal(metrics.holdings.length, 1);
    const holding = metrics.holdings[0];
    assert.equal(holding.quantity, 15);
    assert.equal(holding.pmc, 110.5);
    assert.equal(holding.marketValue, 15 * 160); // 2400
    assert.equal(holding.unrealizedPnl, 2400 - (15 * 110.5)); // 742.5
    assert.equal(metrics.realizedPnl, 192.5);
    assert.equal(metrics.totalDividends, 20);
    assert.ok(Array.isArray(metrics.closedPositions));
    assert.equal(metrics.closedPositions.length, 1);
    assert.equal(metrics.closedPositions[0].ticker, 'AAPL');
    assert.equal(metrics.closedPositions[0].closeType, 'PARZIALE');
    assert.equal(metrics.closedPositions[0].quantity, 5);
    assert.equal(metrics.closedPositions[0].sellPrice, 150);
    assert.equal(metrics.closedPositions[0].realizedPnl, 192.5);

    // Cash check:
    // Initial: 0
    // +5000 (deposit) - 1005 (buy 1) - 1205 (buy 2) + 745 (sell) + 20 (dividend) = 3555 EUR
    assert.equal(metrics.currentCash, 3555);

    // Allocations check:
    assert.ok(metrics.allocations.bySector['Information Technology']);
    assert.ok(metrics.allocations.byAssetClass['CASH']);
    assert.ok(metrics.allocations.byAssetClass['EQUITY']);
  });

  test('calculateHoldingsAndMetrics handles FIFO cost basis accurately', () => {
    const transactions = [
      { id: 1, type: 'DEPOSIT', amount: 5000, date: '2023-01-01' },
      // Lot 1: 10 shares at 100 EUR
      { id: 2, type: 'BUY', assetTicker: 'MSFT', quantity: 10, price: 100, commission: 0, date: '2023-01-05' },
      // Lot 2: 10 shares at 150 EUR
      { id: 3, type: 'BUY', assetTicker: 'MSFT', quantity: 10, price: 150, commission: 0, date: '2023-02-01' },
      // Sell 10 shares at 200 EUR: Under FIFO, exactly Lot 1 is consumed (cost basis 1000)
      { id: 4, type: 'SELL', assetTicker: 'MSFT', quantity: 10, price: 200, commission: 0, date: '2023-03-01' }
    ];

    const assetsMap = {
      MSFT: { ticker: 'MSFT', name: 'Microsoft Corp.', type: 'EQUITY', currentPrice: 220 }
    };

    const metrics = calculateHoldingsAndMetrics(transactions, assetsMap, 0, 'FIFO');

    // Realized P&L: Sold 10 from Lot 1 @ 200 -> proceeds 2000, cost 1000 -> realized P&L = 1000
    assert.equal(metrics.realizedPnl, 1000);
    assert.equal(metrics.closedPositions.length, 1);
    assert.equal(metrics.closedPositions[0].ticker, 'MSFT');
    assert.equal(metrics.closedPositions[0].realizedPnl, 1000);

    // Remaining: exactly Lot 2 (10 shares at 150 EUR)
    assert.equal(metrics.holdings.length, 1);
    const holding = metrics.holdings[0];
    assert.equal(holding.quantity, 10);
    assert.equal(holding.pmc, 150);
  });
});

