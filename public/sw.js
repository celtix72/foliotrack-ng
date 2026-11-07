/**
 * FolioTrack - Progressive Web App (PWA) Service Worker
 * Handles offline caching, PWA installability criteria, and native Web Push Notifications.
 */

const CACHE_NAME = 'foliotrack-pwa-v2';

// Core static assets to pre-cache on install
const PRECACHE_ASSETS = [
  '/',
  '/?source=pwa',
  '/login.html',
  '/manifest.webmanifest',
  '/manifest.json',
  '/dist/style.css',
  '/theme.js',
  '/pwa_installer.js',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-maskable-192.png',
  '/icons/icon-maskable-512.png',
  '/icons/icon.svg',
  '/favicon.svg',
  '/favicon.ico',
  '/vendor/gridstack/gridstack-all.js',
  '/vendor/gridstack/gridstack.min.css',
  '/vendor/chartjs/chart.umd.min.js'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      // Gracefully attempt caching without failing install if a single asset is 404
      return Promise.allSettled(
        PRECACHE_ASSETS.map((url) =>
          cache.add(url).catch((err) => {
            console.warn('[PWA SW] Precache warning for', url, err.message);
          })
        )
      );
    }).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            console.log('[PWA SW] Removing obsolete cache:', key);
            return caches.delete(key);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

/**
 * Fetch event listener required by Google Chrome for PWA installability criteria & WebAPK.
 */
self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Only handle GET requests originating from same-origin
  if (req.method !== 'GET' || url.origin !== self.location.origin) {
    return;
  }

  // Never cache API calls, SSE event streams, or auth endpoints
  if (url.pathname.startsWith('/api/') || url.pathname.includes('/sse')) {
    return;
  }

  // 1. Navigation requests (HTML pages): Network-first with cache fallback
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((networkRes) => {
          if (networkRes && networkRes.status === 200) {
            const resClone = networkRes.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, resClone));
          }
          return networkRes;
        })
        .catch(async () => {
          const cached = await caches.match(req);
          if (cached) return cached;
          const pwaCached = await caches.match('/?source=pwa');
          if (pwaCached) return pwaCached;
          const rootCached = await caches.match('/');
          if (rootCached) return rootCached;
          const loginCached = await caches.match('/login.html');
          if (loginCached) return loginCached;
          return new Response('Offline - FolioTrack non raggiungibile al momento.', {
            status: 503,
            statusText: 'Service Unavailable',
            headers: { 'Content-Type': 'text/plain; charset=utf-8' }
          });
        })
    );
    return;
  }

  // 2. Static assets (JS, CSS, images, fonts): Stale-while-revalidate / Cache-first
  event.respondWith(
    caches.match(req).then((cachedRes) => {
      if (cachedRes) {
        // Fetch in background to keep cache fresh
        fetch(req).then((networkRes) => {
          if (networkRes && networkRes.status === 200) {
            caches.open(CACHE_NAME).then((cache) => cache.put(req, networkRes));
          }
        }).catch(() => {});
        return cachedRes;
      }

      return fetch(req).then((networkRes) => {
        if (!networkRes || networkRes.status !== 200 || networkRes.type !== 'basic') {
          return networkRes;
        }
        const resClone = networkRes.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(req, resClone));
        return networkRes;
      });
    })
  );
});

/**
 * Native Web Push Notifications
 */
self.addEventListener('push', (event) => {
  let data = {};
  if (event.data) {
    try {
      data = event.data.json();
    } catch (e) {
      data = { title: 'FolioTrack', body: event.data.text() };
    }
  }

  const title = data.title || 'FolioTrack Aggiornamento';
  const options = {
    body: data.body || 'Nuova notifica disponibile.',
    icon: data.icon || '/icons/icon-192.png',
    badge: data.badge || '/favicon.svg',
    tag: data.tag || 'foliotrack-notification',
    data: {
      url: data.url || '/'
    },
    vibrate: [100, 50, 100],
    renotify: true
  };

  event.waitUntil(
    self.registration.showNotification(title, options)
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) ? event.notification.data.url : '/';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      // Focus existing tab if open
      for (const client of clientList) {
        if (client.url.includes(targetUrl) && 'focus' in client) {
          return client.focus();
        }
      }
      // Otherwise open new window
      if (self.clients.openWindow) {
        return self.clients.openWindow(targetUrl);
      }
    })
  );
});
