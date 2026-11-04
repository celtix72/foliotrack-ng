/**
 * FolioTrack Live Market Ticker Bar
 * Continuous automatic marquee banner with streaming quotes for world benchmarks & custom assets.
 * Configurable active indices, scroll speed, and refresh frequency from Settings.
 */

(function () {
  const DEFAULT_INDICES = [
    { symbol: '^GSPC', name: 'S&P 500', price: 5864.67, change: 24.34, changePercent: 0.42, currency: 'USD' },
    { symbol: 'FTSEMIB.MI', name: 'FTSE MIB', price: 34928.10, change: 182.40, changePercent: 0.52, currency: 'EUR' },
    { symbol: 'BTP10Y', name: 'BTP 10Y', price: 3.58, change: -0.04, changePercent: -1.10, currency: '%', isYield: true },
    { symbol: 'GC=F', name: 'Oro (Gold)', price: 2748.20, change: 12.80, changePercent: 0.47, currency: 'USD' },
    { symbol: 'BTC-EUR', name: 'Bitcoin', price: 63890.00, change: 1240.00, changePercent: 1.98, currency: 'EUR' },
    { symbol: 'EURUSD=X', name: 'EUR / USD', price: 1.0874, change: 0.0018, changePercent: 0.17, currency: '' }
  ];

  let currentRefreshTimer = null;
  let currentRefreshSeconds = 60;
  let currentScrollSpeed = 'normal';
  let isFetching = false;
  let lastData = DEFAULT_INDICES;

  function ensureStyles() {
    if (document.getElementById('ft-ticker-banner-styles')) return;

    const style = document.createElement('style');
    style.id = 'ft-ticker-banner-styles';
    style.textContent = `
      @keyframes ft-ticker-scroll {
        0% {
          transform: translate3d(0, 0, 0);
        }
        100% {
          transform: translate3d(-100%, 0, 0);
        }
      }

      .ft-ticker-container {
        position: relative;
        overflow: hidden;
        width: 100%;
        display: flex;
        align-items: center;
        background: rgba(255, 255, 255, 0.85);
        border-bottom: 1px solid rgba(229, 231, 235, 0.8);
        backdrop-filter: blur(8px);
        -webkit-backdrop-filter: blur(8px);
        user-select: none;
        -webkit-user-select: none;
      }

      .dark .ft-ticker-container {
        background: rgba(21, 21, 23, 0.85);
        border-bottom: 1px solid rgba(255, 255, 255, 0.06);
      }

      .ft-ticker-viewport {
        position: relative;
        overflow: hidden;
        flex: 1;
        display: flex;
        align-items: center;
        mask-image: linear-gradient(to right, transparent, black 24px, black calc(100% - 24px), transparent 100%);
        -webkit-mask-image: linear-gradient(to right, transparent, black 24px, black calc(100% - 24px), transparent 100%);
      }

      .ft-ticker-track {
        display: flex;
        width: max-content;
        will-change: transform;
        animation: ft-ticker-scroll var(--ft-ticker-speed, 35s) linear infinite;
      }

      .ft-ticker-track:hover,
      .ft-ticker-viewport:hover .ft-ticker-track {
        animation-play-state: paused;
      }

      .ft-ticker-group {
        display: flex;
        align-items: center;
        flex-shrink: 0;
      }

      .ft-ticker-item {
        display: inline-flex;
        align-items: center;
        gap: 0.5rem;
        padding: 0.35rem 0.85rem;
        font-size: 0.75rem;
        line-height: 1rem;
        flex-shrink: 0;
        transition: background-color 0.15s ease;
      }

      .ft-ticker-item:hover {
        background: rgba(0, 0, 0, 0.04);
      }
      .dark .ft-ticker-item:hover {
        background: rgba(255, 255, 255, 0.05);
      }

      .ft-spin {
        animation: ft-rotate 0.8s linear infinite;
      }
      @keyframes ft-rotate {
        from { transform: rotate(0deg); }
        to { transform: rotate(360deg); }
      }
    `;
    document.head.appendChild(style);
  }

  function formatPrice(item) {
    if (item.isYield) {
      return `${Number(item.price || 0).toFixed(2)}%`;
    }
    const prefix = item.currency === 'EUR' ? '€' : (item.currency === 'USD' ? '$' : (item.currency === 'GBP' ? '£' : ''));
    const val = Number(item.price) || 0;
    // For values > 999, display zero decimals (e.g. S&P 500, FTSE MIB, Bitcoin, Gold)
    const decimals = val > 999 ? 0 : (val < 10 ? 4 : 2);
    const formatted = val.toLocaleString('it-IT', {
      useGrouping: true,
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals
    });
    return `${prefix}${formatted}`;
  }

  function formatChange(item) {
    const chgVal = Number(item.change) || 0;
    const chgPct = Number(item.changePercent) || 0;
    const isPositive = chgPct >= 0;
    const sign = isPositive ? '+' : '';
    const pct = `${sign}${chgPct.toFixed(2)}%`;
    return {
      isPositive,
      text: pct
    };
  }

  function renderTicker(container, indices, options = {}) {
    if (!container) return;
    ensureStyles();

    const speed = options.scrollSpeed || currentScrollSpeed;
    const refreshSec = options.refreshSeconds || currentRefreshSeconds;
    const activeIndices = Array.isArray(indices) && indices.length > 0 ? indices : DEFAULT_INDICES;

    // Determine marquee duration based on number of items and speed preference:
    // Slowed down significantly for calm, easy readability.
    const baseSecondsPerItem = speed === 'very_slow' ? 35 : (speed === 'slow' ? 26 : (speed === 'fast' ? 12 : 18));
    const minDuration = speed === 'very_slow' ? 180 : (speed === 'slow' ? 130 : (speed === 'fast' ? 55 : 85));
    const duration = Math.max(minDuration, activeIndices.length * baseSecondsPerItem);

    // Build the items HTML
    const itemsHtml = activeIndices.map(item => {
      const chg = formatChange(item);
      const badgeClass = chg.isPositive ? 'badge-profit' : 'badge-loss';
      const arrow = chg.isPositive ? '▲' : '▼';

      return `
        <div class="ft-ticker-item border-r border-gray-200/50 dark:border-white/5" title="${item.symbol}">
          <span class="font-semibold text-gray-500 dark:text-gray-400 tracking-wide">${item.name || item.symbol}</span>
          <span class="font-mono font-medium text-gray-900 dark:text-gray-100 tabular-nums">${formatPrice(item)}</span>
          <span class="${badgeClass} tabular-nums text-[10px] px-1.5 py-0.2 rounded-full inline-flex items-center">
            <span class="mr-0.5 text-[8px]">${arrow}</span>${chg.text}
          </span>
        </div>
      `;
    }).join('');

    // Ensure enough repetitions so that one group comfortably exceeds ultra-wide screen width
    let groupHtml = itemsHtml;
    if (activeIndices.length < 5) {
      groupHtml = itemsHtml + itemsHtml; // duplicate once more if very few items
    }

    container.innerHTML = `
      <div class="ft-ticker-container">
        <!-- Live Ticker Indicator Badge -->
        <div class="flex items-center shrink-0 pl-3 pr-2.5 py-1 border-r border-gray-200/80 dark:border-white/10 z-20 bg-white/95 dark:bg-[#151517]/95 shadow-xs">
          <span class="relative flex h-2 w-2 mr-1.5">
            <span class="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
            <span class="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
          </span>
          <span class="font-mono text-[10px] font-bold text-gray-700 dark:text-gray-300 tracking-wider">LIVE</span>
          <span class="text-[9px] font-mono text-gray-400 ml-1.5 hidden sm:inline" title="Frequenza aggiornamento: ${refreshSec}s">${refreshSec}s</span>
          <button type="button" id="ft-ticker-force-btn" class="ml-1 text-gray-400 hover:text-emerald-500 transition p-0.5 rounded cursor-pointer" title="Ricarica quotazioni banner adesso">
            <span id="ft-ticker-spin-icon" class="text-[10px] block">🔄</span>
          </button>
        </div>

        <!-- Scrolling Ticker Viewport -->
        <div class="ft-ticker-viewport" style="--ft-ticker-speed: ${duration}s;">
          <div class="ft-ticker-track">
            <!-- Group 1 -->
            <div class="ft-ticker-group">
              ${groupHtml}
            </div>
            <!-- Group 2 (Exact replica for seamless infinite marquee loop) -->
            <div class="ft-ticker-group" aria-hidden="true">
              ${groupHtml}
            </div>
          </div>
        </div>
      </div>
    `;

    // Hook manual refresh button
    const forceBtn = container.querySelector('#ft-ticker-force-btn');
    if (forceBtn) {
      forceBtn.addEventListener('click', async (e) => {
        e.preventDefault();
        await refreshBanner(true);
      });
    }
  }

  async function fetchLiveIndices(force = false) {
    try {
      const url = force ? '/api/market/indices?force=true' : '/api/market/indices';
      const res = await fetch(url);
      if (res.ok) {
        const data = await res.json();
        if (data.success && Array.isArray(data.indices)) {
          if (data.refreshSeconds) currentRefreshSeconds = Number(data.refreshSeconds);
          if (data.scrollSpeed) currentScrollSpeed = data.scrollSpeed;
          lastData = data.indices;
          return {
            indices: data.indices,
            refreshSeconds: currentRefreshSeconds,
            scrollSpeed: currentScrollSpeed
          };
        }
      }
    } catch {
      // Offline or network error
    }
    return {
      indices: lastData || DEFAULT_INDICES,
      refreshSeconds: currentRefreshSeconds,
      scrollSpeed: currentScrollSpeed
    };
  }

  async function refreshBanner(force = false) {
    if (isFetching) return;
    isFetching = true;

    const icon = document.getElementById('ft-ticker-spin-icon');
    if (icon) icon.classList.add('ft-spin');

    try {
      const container = document.getElementById('live-ticker-container') || document.querySelector('[data-live-ticker]');
      if (!container) return;

      const payload = await fetchLiveIndices(force);
      renderTicker(container, payload.indices, {
        scrollSpeed: payload.scrollSpeed,
        refreshSeconds: payload.refreshSeconds
      });

      // Reset timer if frequency changed
      setupRefreshTimer(payload.refreshSeconds);
    } finally {
      if (icon) icon.classList.remove('ft-spin');
      isFetching = false;
    }
  }

  function setupRefreshTimer(seconds) {
    if (currentRefreshTimer) {
      clearInterval(currentRefreshTimer);
      currentRefreshTimer = null;
    }
    const intervalMs = Math.max(5000, (Number(seconds) || 60) * 1000);
    currentRefreshTimer = setInterval(() => {
      refreshBanner(false);
    }, intervalMs);
  }

  async function init() {
    ensureStyles();
    const container = document.getElementById('live-ticker-container') || document.querySelector('[data-live-ticker]');
    if (!container) return;

    // Initial render with default/cached data so banner shows immediately
    renderTicker(container, DEFAULT_INDICES, { refreshSeconds: currentRefreshSeconds, scrollSpeed: currentScrollSpeed });

    // Fetch live data & user configured preferences
    await refreshBanner(false);

    // Listen for custom event fired when Settings page updates ticker configuration
    window.addEventListener('foliotrack:ticker-config-updated', (e) => {
      if (e.detail) {
        if (e.detail.refreshSeconds) currentRefreshSeconds = Number(e.detail.refreshSeconds);
        if (e.detail.scrollSpeed) currentScrollSpeed = e.detail.scrollSpeed;
      }
      refreshBanner(true);
    });

    // Listen for cross-tab updates via localStorage
    window.addEventListener('storage', (e) => {
      if (e.key === 'foliotrack_ticker_updated') {
        refreshBanner(true);
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  window.FolioTrackTicker = {
    render: renderTicker,
    refresh: () => refreshBanner(true),
    DEFAULT_INDICES
  };
})();
