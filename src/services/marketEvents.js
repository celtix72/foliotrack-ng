const EventEmitter = require('events');

class MarketEventsEmitter extends EventEmitter {}

// Singleton emitter instance for real-time market data lifecycle events
const marketEvents = new MarketEventsEmitter();

/**
 * Broadcasts an event to all subscribers when market quotes or data are updated/re-read.
 *
 * @param {object} [payload={}]
 * @returns {object}
 */
function broadcastMarketUpdate(payload = {}) {
  const event = {
    type: 'MARKET_UPDATED',
    timestamp: new Date().toISOString(),
    ...payload
  };

  try {
    marketEvents.emit('market-updated', event);
  } catch (err) {
    console.warn('[MarketEvents] Error emitting market update:', err.message);
  }

  return event;
}

module.exports = {
  marketEvents,
  broadcastMarketUpdate
};

