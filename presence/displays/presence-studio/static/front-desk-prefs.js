/*
 * front-desk-prefs.js — UI-05/UI-06 viewer preferences for the presence-studio
 * front-desk pages (SURFACE_UI_UNIFICATION_PLAN_2026-09-23 §2.5).
 *
 * Plain blocking <script> loaded first in <head>, before any stylesheet, so
 * the stored theme is on <html data-theme> before the first paint (no flash
 * of the wrong theme). Exposes `window.KyberionPrefs` for the rail/header
 * module and the page scripts.
 *
 *   theme  — 'system' | 'light' | 'dark'; 'system' leaves `data-theme` unset
 *            so the generated tokens follow `prefers-color-scheme`.
 *   locale — 'ja' | 'en'; stored choice, else the browser language.
 *
 * Storage keys are the ones the concierge shell uses
 * (`presence/displays/concierge/src/lib/concierge-theme.ts`:
 * `kyberion.ui.theme`, `kyberion.ui.locale`; 'system' is stored as no key);
 * every access is wrapped in try/catch because storage can
 * be unavailable (private windows, blocked site data) — the page must still
 * render with the defaults. The locale is mirrored into a `kb-ui-locale`
 * cookie so the server renders the page chrome in the same language.
 */
/* global window, document, navigator */
(function () {
  'use strict';

  var THEME_KEY = 'kyberion.ui.theme';
  var LOCALE_KEY = 'kyberion.ui.locale';
  // Server-side mirror of the language choice (front-desk-pages.ts).
  var LOCALE_COOKIE = 'kb-ui-locale';
  var RELOAD_GUARD_KEY = 'kyberion.ui.locale-sync';
  var root = document.documentElement;

  function read(key) {
    try {
      return window.localStorage.getItem(key);
    } catch (err) {
      return null;
    }
  }

  function write(key, value) {
    try {
      if (value === null) window.localStorage.removeItem(key);
      else window.localStorage.setItem(key, value);
    } catch (err) {
      // Best effort: the choice still applies to this page view.
    }
  }

  function normalizeTheme(value) {
    return value === 'light' || value === 'dark' ? value : 'system';
  }

  function normalizeLocale(value) {
    var raw = String(value || '').toLowerCase();
    if (raw.indexOf('ja') === 0) return 'ja';
    if (raw.indexOf('en') === 0) return 'en';
    return null;
  }

  function applyTheme(theme) {
    if (theme === 'light' || theme === 'dark') root.setAttribute('data-theme', theme);
    else root.removeAttribute('data-theme');
  }

  function writeLocaleCookie(locale) {
    try {
      document.cookie = LOCALE_COOKIE + '=' + locale + '; path=/; max-age=31536000; SameSite=Lax';
    } catch (err) {
      // Cookies blocked: the page scripts still re-label from the vocabulary.
    }
  }

  var theme = normalizeTheme(read(THEME_KEY));
  var locale =
    normalizeLocale(read(LOCALE_KEY)) || normalizeLocale(navigator && navigator.language) || 'en';

  applyTheme(theme);
  writeLocaleCookie(locale);

  // The server rendered the page chrome for the language it could see (the
  // cookie, else Accept-Language). When that differs from the viewer's
  // choice, reload once with the cookie now set — guarded so a browser that
  // drops cookies never loops.
  var served = normalizeLocale(root.getAttribute('lang'));
  if (served && served !== locale) {
    var guarded = false;
    try {
      guarded = window.sessionStorage.getItem(RELOAD_GUARD_KEY) === locale;
      window.sessionStorage.setItem(RELOAD_GUARD_KEY, locale);
    } catch (err) {
      guarded = true;
    }
    if (!guarded) {
      window.location.reload();
      return;
    }
  } else {
    try {
      window.sessionStorage.removeItem(RELOAD_GUARD_KEY);
    } catch (err) {
      // nothing to clear
    }
  }
  root.setAttribute('lang', locale);

  window.KyberionPrefs = {
    THEME_KEY: THEME_KEY,
    LOCALE_KEY: LOCALE_KEY,
    theme: function () {
      return theme;
    },
    locale: function () {
      return locale;
    },
    setTheme: function (next) {
      theme = normalizeTheme(next);
      write(THEME_KEY, theme === 'system' ? null : theme);
      applyTheme(theme);
    },
    setLocale: function (next) {
      var value = normalizeLocale(next);
      if (!value || value === locale) return;
      write(LOCALE_KEY, value);
      writeLocaleCookie(value);
      window.location.reload();
    },
  };
})();
