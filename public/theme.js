/**
 * FolioTrack Signature Theme Engine
 * Instant dark/light mode toggle with zero FOUC and persistence in localStorage.
 */

(function () {
  const THEME_STORAGE_KEY = 'foliotrack_theme';

  function getSystemPreference() {
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  function getSavedTheme() {
    return localStorage.getItem(THEME_STORAGE_KEY);
  }

  function applyTheme(theme) {
    const root = document.documentElement;
    const effectiveTheme = theme === 'system' || !theme ? getSystemPreference() : theme;

    if (effectiveTheme === 'dark') {
      root.classList.add('dark');
      root.classList.remove('light');
    } else {
      root.classList.remove('dark');
      root.classList.add('light');
    }

    // Update theme toggle icons across the page if present
    updateThemeIcons(effectiveTheme);

    // Dispatch custom event for widgets, charts, and GridStack
    document.dispatchEvent(new CustomEvent('themeChanged', {
      detail: {
        theme: effectiveTheme,
        isDark: effectiveTheme === 'dark'
      }
    }));
  }

  function updateThemeIcons(effectiveTheme) {
    const toggleBtns = document.querySelectorAll('[data-theme-toggle]');
    toggleBtns.forEach(btn => {
      const sunIcon = btn.querySelector('.theme-icon-sun');
      const moonIcon = btn.querySelector('.theme-icon-moon');
      const textLabel = btn.querySelector('.theme-label');

      if (effectiveTheme === 'dark') {
        if (sunIcon) sunIcon.classList.remove('hidden');
        if (moonIcon) moonIcon.classList.add('hidden');
        if (textLabel) textLabel.textContent = 'Tema Chiaro';
      } else {
        if (sunIcon) sunIcon.classList.add('hidden');
        if (moonIcon) moonIcon.classList.remove('hidden');
        if (textLabel) textLabel.textContent = 'Tema Scuro';
      }
    });
  }

  // Anti-FOUC immediate execution
  const initialTheme = getSavedTheme() || getSystemPreference();
  applyTheme(initialTheme);

  // Expose global methods
  window.toggleTheme = function () {
    const isCurrentlyDark = document.documentElement.classList.contains('dark');
    const newTheme = isCurrentlyDark ? 'light' : 'dark';
    localStorage.setItem(THEME_STORAGE_KEY, newTheme);
    applyTheme(newTheme);
    return newTheme;
  };

  window.setTheme = function (theme) {
    if (theme === 'system') {
      localStorage.removeItem(THEME_STORAGE_KEY);
    } else {
      localStorage.setItem(THEME_STORAGE_KEY, theme);
    }
    applyTheme(theme);
  };

  window.getCurrentTheme = function () {
    return document.documentElement.classList.contains('dark') ? 'dark' : 'light';
  };

  // Listen for OS system theme changes
  if (window.matchMedia) {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
      if (!getSavedTheme()) {
        applyTheme(e.matches ? 'dark' : 'light');
      }
    });
  }

  // Initialize button handlers once DOM is ready
  document.addEventListener('DOMContentLoaded', () => {
    const effective = window.getCurrentTheme();
    updateThemeIcons(effective);

    document.querySelectorAll('[data-theme-toggle]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        window.toggleTheme();
      });
    });
  });
})();

