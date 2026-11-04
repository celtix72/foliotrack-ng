const fs = require('fs');
const path = require('path');

const VIEWS_DIR = path.join(__dirname, '..', '..', 'private_views');
const PARTIALS_DIR = path.join(VIEWS_DIR, 'partials');

// In-memory HTML cache with mtime invalidation
const htmlCache = new Map();

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
  const isMobileClient = isMobile(req);
  const viewsPath = path.join(__dirname, '..', '..', 'private_views');
  const mobileFile = path.join(viewsPath, `${viewName}_mobile.html`);
  const desktopFile = path.join(viewsPath, `${viewName}.html`);
  const sidebarFile = path.join(viewsPath, 'partials', 'sidebar_partial.html');

  try {
    // 1. Mobile Client
    if (isMobileClient && fs.existsSync(mobileFile)) {
      const mobileHtml = readFileCached(mobileFile);
      return res.type('html').send(mobileHtml);
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

    return res.type('html').send(desktopHtml);
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
