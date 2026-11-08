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

  // ==========================================
  // WIDGET TYPOGRAPHY & APPEARANCE SYSTEM
  // ==========================================
  const WIDGET_FONT_FAMILY_KEY = 'foliotrack_widget_font_family';
  const WIDGET_FONT_SIZE_KEY = 'foliotrack_widget_font_size';
  const WIDGET_FONT_VARIANT_KEY = 'foliotrack_widget_font_variant';
  const WIDGET_FONT_WEIGHT_KEY = 'foliotrack_widget_font_weight';

  const WIDGET_FONTS = {
    'inter': "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
    'system': "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif",
    'plus-jakarta': "'Plus Jakarta Sans', 'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
    'roboto': "'Roboto', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
    'jetbrains': "'JetBrains Mono', monospace"
  };

  const WIDGET_SIZES = {
    'compact': 0.90,
    'standard': 1.0,
    'large': 1.10
  };

  const WIDGET_VARIANTS = {
    'tabular-mono': "'JetBrains Mono', monospace",
    'proportional': "inherit"
  };

  const WIDGET_WEIGHTS = {
    'balanced': { title: '600', val: '700' },
    'bold': { title: '700', val: '800' }
  };

  function getSavedWidgetTypography() {
    return {
      fontFamily: localStorage.getItem(WIDGET_FONT_FAMILY_KEY) || 'inter',
      fontSize: localStorage.getItem(WIDGET_FONT_SIZE_KEY) || 'standard',
      fontVariant: localStorage.getItem(WIDGET_FONT_VARIANT_KEY) || 'tabular-mono',
      fontWeight: localStorage.getItem(WIDGET_FONT_WEIGHT_KEY) || 'balanced'
    };
  }

  function applyWidgetTypography(cfg) {
    if (!cfg) cfg = getSavedWidgetTypography();
    const root = document.documentElement;

    const family = WIDGET_FONTS[cfg.fontFamily] || WIDGET_FONTS.inter;
    const scale = WIDGET_SIZES[cfg.fontSize] || 1.0;
    const numFamily = WIDGET_VARIANTS[cfg.fontVariant] || WIDGET_VARIANTS['tabular-mono'];
    const weights = WIDGET_WEIGHTS[cfg.fontWeight] || WIDGET_WEIGHTS.balanced;

    root.style.setProperty('--ft-widget-font-family', family);
    root.style.setProperty('--ft-widget-font-scale', scale);
    root.style.setProperty('--ft-widget-num-family', numFamily);
    root.style.setProperty('--ft-widget-font-weight-title', weights.title);
    root.style.setProperty('--ft-widget-font-weight-val', weights.val);

    // Apply numerical font-variant
    if (cfg.fontVariant === 'tabular-mono') {
      root.style.setProperty('--ft-widget-num-variant', 'tabular-nums');
    } else {
      root.style.setProperty('--ft-widget-num-variant', 'normal');
    }

    document.dispatchEvent(new CustomEvent('widgetTypographyChanged', {
      detail: {
        ...cfg,
        family,
        scale,
        numFamily,
        weights
      }
    }));
  }

  // Anti-FOUC immediate execution
  const initialTheme = getSavedTheme() || getSystemPreference();
  applyTheme(initialTheme);
  applyWidgetTypography(getSavedWidgetTypography());

  // Expose global methods
  window.getWidgetTypography = function () {
    return getSavedWidgetTypography();
  };

  window.setWidgetTypography = function (cfg, persistBackend = false) {
    if (!cfg) return;

    if (cfg.fontFamily) localStorage.setItem(WIDGET_FONT_FAMILY_KEY, cfg.fontFamily);
    if (cfg.fontSize) localStorage.setItem(WIDGET_FONT_SIZE_KEY, cfg.fontSize);
    if (cfg.fontVariant) localStorage.setItem(WIDGET_FONT_VARIANT_KEY, cfg.fontVariant);
    if (cfg.fontWeight) localStorage.setItem(WIDGET_FONT_WEIGHT_KEY, cfg.fontWeight);

    const updated = getSavedWidgetTypography();
    applyWidgetTypography(updated);

    if (persistBackend) {
      try {
        fetch('/api/settings', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            widget_font_family: updated.fontFamily,
            widget_font_size: updated.fontSize,
            widget_font_variant: updated.fontVariant,
            widget_font_weight: updated.fontWeight
          })
        }).catch(err => console.warn('Could not persist widget typography to backend:', err));
      } catch (e) {
        // Ignored in non-network environments
      }
    }

    return updated;
  };

  window.WIDGET_FONTS = WIDGET_FONTS;
  window.WIDGET_SIZES = WIDGET_SIZES;
  window.WIDGET_VARIANTS = WIDGET_VARIANTS;
  window.WIDGET_WEIGHTS = WIDGET_WEIGHTS;

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

