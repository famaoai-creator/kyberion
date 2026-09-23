/*
 * ui-gallery-prefs.js — viewer preferences for the UI gallery (`/ui-gallery`).
 *
 * Plain blocking <script> loaded first in <head>, before any stylesheet, so
 * the theme is on <html data-theme> before the first paint (no flash of the
 * wrong theme) — the same contract as `front-desk-prefs.js`, with the
 * gallery's URL overrides on top:
 *
 *   theme  — `?theme=light|dark`, else the shared stored choice
 *            (`kyberion.ui.theme`), else none: `data-theme` stays unset and
 *            the generated tokens follow `prefers-color-scheme`.
 *   locale — `?lang=<supported>`, else the shared stored choice
 *            (`kyberion.ui.locale`), else the browser language, else `en`.
 *
 * The gallery's own toggles only preview (they never write the shared
 * choice). Every storage access is wrapped in try/catch: storage can be
 * unavailable (private windows, blocked site data) and the page must still
 * render with the defaults. `ui-gallery.js` reads the result from
 * `window.KyberionGalleryPrefs`.
 */
/* global window, document, navigator, URLSearchParams */
(function () {
  'use strict';

  var THEME_KEY = 'kyberion.ui.theme';
  var LOCALE_KEY = 'kyberion.ui.locale';
  var THEMES = ['light', 'dark'];
  // Locales the gallery can load (`qps-ploc` only by explicit `?lang=`).
  var LOCALES = ['en', 'ja', 'qps-ploc'];
  var root = document.documentElement;

  function read(key) {
    try {
      return window.localStorage.getItem(key);
    } catch (err) {
      return null;
    }
  }

  function param(name) {
    try {
      return new URLSearchParams(window.location.search).get(name);
    } catch (err) {
      return null;
    }
  }

  function primaryLocale(value) {
    var raw = String(value || '').toLowerCase();
    if (raw.indexOf('ja') === 0) return 'ja';
    if (raw.indexOf('en') === 0) return 'en';
    return null;
  }

  var requestedTheme = param('theme');
  var storedTheme = read(THEME_KEY);
  var theme =
    THEMES.indexOf(requestedTheme) >= 0
      ? requestedTheme
      : THEMES.indexOf(storedTheme) >= 0
        ? storedTheme
        : null;

  var requestedLocale = param('lang');
  var browserLocale =
    (navigator && navigator.languages && navigator.languages[0]) ||
    (navigator && navigator.language) ||
    '';
  var locale =
    LOCALES.indexOf(requestedLocale) >= 0
      ? requestedLocale
      : primaryLocale(read(LOCALE_KEY)) || primaryLocale(browserLocale) || 'en';

  if (theme) root.setAttribute('data-theme', theme);
  else root.removeAttribute('data-theme');
  root.setAttribute('lang', locale);

  window.KyberionGalleryPrefs = { theme: theme, locale: locale };
})();
