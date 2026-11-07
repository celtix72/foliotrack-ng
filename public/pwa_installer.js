/**
 * FolioTrack - PWA & Android Web App Installation Manager
 * Handles Service Worker registration, Android beforeinstallprompt lifecycle,
 * standalone mode detection, and in-app 1-click installation UI.
 */

(function () {
  'use strict';

  let deferredPrompt = null;
  const DISMISSED_KEY = 'foliotrack_pwa_prompt_dismissed_at';

  function isStandalone() {
    return (
      window.matchMedia('(display-mode: standalone)').matches ||
      window.matchMedia('(display-mode: fullscreen)').matches ||
      window.navigator.standalone === true ||
      document.referrer.includes('android-app://')
    );
  }

  function isMobileAndroid() {
    return /Android/i.test(navigator.userAgent);
  }

  // 1. Mark body if running as installed standalone app
  function updateStandaloneClass() {
    const standalone = isStandalone();
    if (standalone) {
      document.documentElement.classList.add('is-pwa-standalone');
      document.body && document.body.classList.add('is-pwa-standalone');
    }
  }

  // 2. Register Service Worker
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker
        .register('/sw.js')
        .then((reg) => {
          // Check for SW updates
          reg.addEventListener('updatefound', () => {
            const newWorker = reg.installing;
            if (newWorker) {
              newWorker.addEventListener('statechange', () => {
                if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
                  console.log('[PWA] Nuova versione di FolioTrack disponibile in background.');
                }
              });
            }
          });
        })
        .catch((err) => {
          console.warn('[PWA] Service Worker registration failed:', err);
        });
    });
  }

  // 3. Listen for Android Chrome / Chromium install prompt event
  window.addEventListener('beforeinstallprompt', (e) => {
    // Prevent default mini-infobar on mobile Chrome
    e.preventDefault();
    deferredPrompt = e;
    window.__deferredInstallPrompt = e;

    // Reveal any configured in-app install buttons
    document.querySelectorAll('[data-pwa-install-btn]').forEach((btn) => {
      btn.classList.remove('hidden');
    });

    // If on mobile and not running standalone, show mobile bottom install card
    if (!isStandalone()) {
      checkAndShowInstallBanner();
    }
  });

  // 4. Handle installation success
  window.addEventListener('appinstalled', () => {
    deferredPrompt = null;
    window.__deferredInstallPrompt = null;
    console.log('[PWA] FolioTrack installato con successo su Android/dispositivo.');

    const banner = document.getElementById('pwa-install-banner');
    if (banner) banner.remove();

    document.querySelectorAll('[data-pwa-install-btn]').forEach((btn) => {
      btn.classList.add('hidden');
    });

    showToast('FolioTrack installato con successo! Ora puoi avviarlo direttamente dalla schermata Home.');
  });

  /**
   * Triggers the native Android install prompt or shows guided dialog
   */
  async function promptInstall() {
    if (deferredPrompt) {
      try {
        deferredPrompt.prompt();
        const { outcome } = await deferredPrompt.userChoice;
        console.log('[PWA] Scelta installazione utente:', outcome);
        if (outcome === 'accepted') {
          deferredPrompt = null;
          const banner = document.getElementById('pwa-install-banner');
          if (banner) banner.remove();
        }
      } catch (err) {
        console.error('[PWA] Errore prompt installazione:', err);
      }
    } else {
      // Fallback: show instructions modal for Android browsers
      showInstallHelpModal();
    }
  }

  /**
   * Displays bottom mobile installation banner if not dismissed recently
   */
  function checkAndShowInstallBanner() {
    if (isStandalone()) return;
    if (document.getElementById('pwa-install-banner')) return;

    // Check if dismissed within last 7 days
    const dismissedAt = localStorage.getItem(DISMISSED_KEY);
    if (dismissedAt) {
      const daysSince = (Date.now() - parseInt(dismissedAt, 10)) / (1000 * 60 * 60 * 24);
      if (daysSince < 7) return;
    }

    const banner = document.createElement('div');
    banner.id = 'pwa-install-banner';
    banner.className = 'fixed bottom-4 left-3 right-3 sm:left-auto sm:right-4 sm:w-96 z-50 p-4 rounded-2xl bg-gray-900/95 dark:bg-[#18181b]/95 text-white shadow-2xl border border-emerald-500/40 backdrop-blur-md flex items-start space-x-3 transition-transform duration-300 animate-slide-up font-sans';
    banner.innerHTML = `
      <img src="/icons/icon-192.png" alt="FolioTrack Logo" class="w-12 h-12 rounded-xl shrink-0 shadow-md">
      <div class="flex-1 min-w-0 pr-1">
        <div class="flex items-center justify-between">
          <h4 class="font-bold text-sm text-white">Installa FolioTrack</h4>
          <button type="button" id="pwa-banner-dismiss" class="text-gray-400 hover:text-white p-1 -mr-1 -mt-1 text-lg leading-none" title="Chiudi">&times;</button>
        </div>
        <p class="text-xs text-gray-300 mt-0.5 leading-snug">
          Installala su Android come Web App autonoma: avviabile direttamente dalla Home senza barra del browser.
        </p>
        <div class="mt-2.5 flex items-center space-x-2">
          <button type="button" id="pwa-banner-install-btn" class="px-3.5 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-semibold text-xs transition shadow-sm flex items-center space-x-1.5">
            <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"/></svg>
            <span>Installa App</span>
          </button>
          <button type="button" id="pwa-banner-info-btn" class="text-[11px] text-gray-400 hover:text-gray-200 underline">
            Come funziona
          </button>
        </div>
      </div>
    `;

    document.body.appendChild(banner);

    // Event listeners
    document.getElementById('pwa-banner-install-btn')?.addEventListener('click', () => {
      promptInstall();
    });

    document.getElementById('pwa-banner-dismiss')?.addEventListener('click', () => {
      localStorage.setItem(DISMISSED_KEY, Date.now().toString());
      banner.remove();
    });

    document.getElementById('pwa-banner-info-btn')?.addEventListener('click', () => {
      showInstallHelpModal();
    });
  }

  function isOriginSecure() {
    return window.isSecureContext || window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
  }

  /**
   * Modal with illustrated instructions for Android Chrome / Samsung Internet
   */
  function showInstallHelpModal() {
    const existing = document.getElementById('pwa-help-modal');
    if (existing) existing.remove();

    const isSecure = isOriginSecure();
    const origin = window.location.origin;

    const modal = document.createElement('div');
    modal.id = 'pwa-help-modal';
    modal.className = 'fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm animate-fade-in font-sans';
    modal.innerHTML = `
      <div class="bg-white dark:bg-[#18181b] rounded-2xl max-w-md w-full p-6 shadow-2xl border border-gray-200 dark:border-white/10 text-gray-900 dark:text-gray-100 max-h-[90vh] overflow-y-auto">
        <div class="flex items-center space-x-3 mb-4">
          <img src="/icons/icon-192.png" alt="FolioTrack" class="w-10 h-10 rounded-xl">
          <div>
            <h3 class="font-bold text-base leading-tight">Installazione su Android</h3>
            <span class="text-xs text-emerald-600 dark:text-emerald-400 font-medium">Standalone Web App (Senza Browser)</span>
          </div>
        </div>

        ${!isSecure ? `
        <div class="mb-4 p-3.5 rounded-xl bg-amber-500/10 border border-amber-500/30 text-amber-800 dark:text-amber-200 text-xs">
          <div class="flex items-center space-x-2 font-bold mb-1.5">
            <svg class="w-4 h-4 text-amber-600 dark:text-amber-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"/></svg>
            <span>Risoluzione: "App non installabile" su Chrome</span>
          </div>
          <p class="leading-relaxed mb-2">
            Chrome su Android (ColorOS / Realme UI) blocca l'installazione su IP locali HTTP (es. <code>${origin}</code>) perché richiede una connessione sicura.
          </p>
          <div class="p-2.5 bg-black/5 dark:bg-black/30 rounded-lg space-y-1.5 font-sans text-[11px] leading-snug">
            <div><strong>1.</strong> In una nuova scheda di Chrome vai a:<br><code class="text-emerald-700 dark:text-emerald-300 font-mono text-[10px] break-all select-all">chrome://flags/#unsafely-treat-insecure-origin-as-secure</code></div>
            <div><strong>2.</strong> Imposta su <strong>Enabled</strong> e nel riquadro incolla:<br><code class="text-emerald-700 dark:text-emerald-300 font-mono text-[11px] select-all">${origin}</code></div>
            <div><strong>3.</strong> Premi <strong>Relaunch</strong> in basso su Chrome.</div>
          </div>
          <button type="button" id="pwa-copy-origin-btn" class="mt-2.5 w-full py-1.5 px-3 rounded-lg bg-amber-600/20 hover:bg-amber-600/30 text-amber-900 dark:text-amber-100 font-medium text-xs transition flex items-center justify-center space-x-1.5">
            <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 5H6a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2v-1M8 5a2 2 0 002 2h2a2 2 0 002-2M8 5a2 2 0 012-2h2a2 2 0 012 2m0 0h2a2 2 0 012 2v3m2 4H10m0 0l3-3m-3 3l3 3"/></svg>
            <span>Copia ${origin}</span>
          </button>
        </div>
        ` : ''}

        <p class="text-xs text-gray-600 dark:text-gray-300 leading-relaxed mb-3">
          Una volta installata, FolioTrack diventa un'applicazione indipendente:
          comparirà nella Home e nel drawer applicazioni, avviandosi a schermo intero senza barre del browser.
        </p>

        <div class="space-y-3 bg-gray-50 dark:bg-black/30 p-3.5 rounded-xl border border-gray-100 dark:border-white/5 text-xs">
          <div class="flex items-start space-x-2.5">
            <span class="flex-shrink-0 w-5 h-5 rounded-full bg-emerald-500 text-white font-bold flex items-center justify-center text-[11px]">1</span>
            <div>
              <span class="font-semibold text-gray-900 dark:text-white">Apri il menu di Chrome:</span>
              <p class="text-gray-500 dark:text-gray-400">Tocca l'icona con i tre puntini <strong class="text-gray-800 dark:text-gray-200">(⋮)</strong> in alto a destra.</p>
            </div>
          </div>
          <div class="flex items-start space-x-2.5">
            <span class="flex-shrink-0 w-5 h-5 rounded-full bg-emerald-500 text-white font-bold flex items-center justify-center text-[11px]">2</span>
            <div>
              <span class="font-semibold text-gray-900 dark:text-white">Seleziona "Installa app" o "Aggiungi a schermata Home":</span>
              <p class="text-gray-500 dark:text-gray-400">Tocca la voce con l'icona di download o di schermata Home.</p>
            </div>
          </div>
          <div class="flex items-start space-x-2.5">
            <span class="flex-shrink-0 w-5 h-5 rounded-full bg-emerald-500 text-white font-bold flex items-center justify-center text-[11px]">3</span>
            <div>
              <span class="font-semibold text-gray-900 dark:text-white">Conferma l'installazione:</span>
              <p class="text-gray-500 dark:text-gray-400">Android compilerà l'applicazione con la propria icona nativa. Potrai chiudere Chrome e usarla direttamente!</p>
            </div>
          </div>
        </div>

        <div class="mt-3 p-2.5 rounded-xl bg-gray-100 dark:bg-white/5 text-gray-600 dark:text-gray-400 text-[11px] leading-relaxed">
          <strong class="text-gray-800 dark:text-gray-200">Suggerimento ColorOS (Realme GT8 Pro):</strong> Se l'icona non compare sulla Home, controlla nelle <em>Impostazioni &gt; Schermata iniziale e Schermata di blocco</em> che l'opzione <em>"Blocca layout schermata iniziale"</em> non sia attiva.
        </div>

        <div class="mt-5 flex justify-end space-x-2">
          <button type="button" id="pwa-help-close-btn" class="px-4 py-2 rounded-xl bg-gray-200 hover:bg-gray-300 dark:bg-white/10 dark:hover:bg-white/20 text-gray-800 dark:text-white text-xs font-semibold transition">
            Ho capito
          </button>
        </div>
      </div>
    `;

    document.body.appendChild(modal);
    document.getElementById('pwa-help-close-btn')?.addEventListener('click', () => {
      modal.remove();
    });

    document.getElementById('pwa-copy-origin-btn')?.addEventListener('click', () => {
      if (navigator.clipboard) {
        navigator.clipboard.writeText(origin).then(() => {
          showToast('Indirizzo copiato negli appunti: ' + origin);
        }).catch(() => {
          prompt('Copia questo indirizzo:', origin);
        });
      } else {
        prompt('Copia questo indirizzo:', origin);
      }
    });
  }

  function showToast(msg) {
    const toast = document.createElement('div');
    toast.className = 'fixed top-5 left-1/2 -translate-x-1/2 z-50 px-4 py-2.5 rounded-xl bg-emerald-600 text-white text-xs font-semibold shadow-lg backdrop-blur animate-fade-in font-sans';
    toast.textContent = msg;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 4000);
  }

  // Initialize on DOM ready
  function init() {
    updateStandaloneClass();
    if (isMobileAndroid() && !isStandalone()) {
      setTimeout(checkAndShowInstallBanner, 1500);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // Global API
  window.PwaInstaller = {
    promptInstall,
    isStandalone,
    canInstall: () => Boolean(deferredPrompt),
    showHelp: showInstallHelpModal
  };
})();

