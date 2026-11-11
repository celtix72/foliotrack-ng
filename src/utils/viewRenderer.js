const fs = require('fs');
const path = require('path');

const VIEWS_DIR = path.join(__dirname, '..', '..', 'private_views');
const PARTIALS_DIR = path.join(VIEWS_DIR, 'partials');

// In-memory HTML cache with mtime invalidation
const htmlCache = new Map();

const PWA_TAGS = `
  <!-- Progressive Web App (PWA) & Mobile Meta -->
  <link rel="manifest" href="/manifest.webmanifest">
  <meta name="mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
  <meta name="apple-mobile-web-app-title" content="FolioTrack">
  <meta name="application-name" content="FolioTrack">
  <meta name="theme-color" content="#059669">
  <meta name="msapplication-TileColor" content="#0B0F19">
  <link rel="icon" type="image/svg+xml" href="/favicon.svg">
  <link rel="icon" type="image/png" sizes="192x192" href="/icons/icon-192.png">
  <link rel="apple-touch-icon" sizes="180x180" href="/icons/icon-192.png">
  <script src="/pwa_installer.js" defer></script>
`;

function injectPwaTags(html) {
  if (!html) return html;
  if (html.includes('manifest.webmanifest')) {
    return html;
  }
  if (html.includes('</head>')) {
    return html.replace('</head>', `${PWA_TAGS}\n</head>`);
  }
  return html;
}

/**
 * Checks whether a request should be served the mobile view.
 * Detects ?view=mobile query override or mobile User-Agent.
 *
 * @param {import('express').Request} req
 * @returns {boolean}
 */
function isMobile(req) {
  if (req.query) {
    if (req.query.view === 'mobile') return true;
    if (req.query.view === 'desktop') return false;
  }

  const ua = req.get('user-agent') || '';
  return /Mobile|Android|iP(hone|od)|IEMobile|BlackBerry|Kindle|Opera M(obi|ini)/i.test(ua);
}

/**
 * Reads a file from disk using an in-memory cache that invalidates on mtime change.
 *
 * @param {string} filePath
 * @returns {string}
 */
function readFileCached(filePath) {
  const stats = fs.statSync(filePath);
  const cached = htmlCache.get(filePath);

  if (cached && cached.mtime === stats.mtimeMs) {
    return cached.content;
  }

  const content = fs.readFileSync(filePath, 'utf8');
  htmlCache.set(filePath, { content, mtime: stats.mtimeMs });
  return content;
}

/**
 * Serves an HTML page, dynamically switching between mobile and desktop views,
 * injecting the sidebar partial on desktop.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {string} viewName - Name of the view (e.g. 'dashboard', 'portfolios')
 */
function serveWithSidebar(req, res, viewName) {
  // Prevent browser caching of dynamic views across releases
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');

  const isMobileClient = isMobile(req);
  const viewsPath = path.join(__dirname, '..', '..', 'private_views');
  const mobileFile = path.join(viewsPath, `${viewName}_mobile.html`);
  const desktopFile = path.join(viewsPath, `${viewName}.html`);
  const sidebarFile = path.join(viewsPath, 'partials', 'sidebar_partial.html');
  const mobileNavFile = path.join(viewsPath, 'partials', 'mobile_nav_partial.html');

  try {
    // 1. Mobile Client
    if (isMobileClient && fs.existsSync(mobileFile)) {
      let mobileHtml = readFileCached(mobileFile);

      // Inject mobile bottom nav partial if present
      if (fs.existsSync(mobileNavFile)) {
        const mobileNavHtml = readFileCached(mobileNavFile);
        if (mobileHtml.includes('<!-- MOBILE_NAV_PARTIAL -->')) {
          mobileHtml = mobileHtml.replace('<!-- MOBILE_NAV_PARTIAL -->', mobileNavHtml);
        } else if (mobileHtml.includes('<!-- {{MOBILE_NAV}} -->')) {
          mobileHtml = mobileHtml.replace('<!-- {{MOBILE_NAV}} -->', mobileNavHtml);
        }
      }

      return res.type('html').send(injectPwaTags(mobileHtml));
    }

    // 2. Desktop Client (or mobile fallback)
    if (!fs.existsSync(desktopFile)) {
      return res.status(404).send(`Vista '${viewName}' non trovata.`);
    }

    let desktopHtml = readFileCached(desktopFile);

    // Read and inject sidebar partial if exists
    if (fs.existsSync(sidebarFile)) {
      const sidebarHtml = readFileCached(sidebarFile);

      // Support multiple placeholder formats
      if (desktopHtml.includes('<!-- SIDEBAR_PARTIAL -->')) {
        desktopHtml = desktopHtml.replace('<!-- SIDEBAR_PARTIAL -->', sidebarHtml);
      } else if (desktopHtml.includes('<!-- {{SIDEBAR}} -->')) {
        desktopHtml = desktopHtml.replace('<!-- {{SIDEBAR}} -->', sidebarHtml);
      } else if (desktopHtml.includes('<div id="sidebar-container"></div>')) {
        desktopHtml = desktopHtml.replace('<div id="sidebar-container"></div>', sidebarHtml);
      }
    }

    return res.type('html').send(injectPwaTags(desktopHtml));
  } catch (err) {
    console.error(`[ViewRenderer Error] Error rendering view ${viewName}:`, err);
    return res.status(500).send('Errore nel rendering della pagina.');
  }
}

/**
 * Clears the in-memory HTML cache (useful for testing).
 */
function clearCache() {
  htmlCache.clear();
}

module.exports = {
  isMobile,
  readFileCached,
  serveWithSidebar,
  clearCache,
  htmlCache
};
