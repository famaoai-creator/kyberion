/*
 * pad-client.js — PA-03 browser glue for the localhost pads, served by
 * `scripts/lib/pad-ui.ts` at `/pad-ui/pad-client.js`.
 *
 * Reads the page bootstrap (`<script type="application/json" id="pad-bootstrap">`,
 * written by `renderPadPage`), renders A2UI with the page's locale and `ui`
 * messages, and mounts the shared `ui:display-controls`:
 *
 *   theme    — stored in the `kb-ui-theme` cookie (light | dark | system;
 *              shared by every pad on this host — each pad is its own
 *              origin, so localStorage alone would not be) and in
 *              localStorage `kyberion.ui.theme` (light | dark; 'system'
 *              removes it), and applied to <html data-theme> at once.
 *   language — stored in localStorage `kyberion.ui.locale` and the
 *              `kb-ui-locale` cookie (the server renders from it), then the
 *              page reloads without any `?lang=` override.
 *
 * No user-visible text lives here: everything comes from the bootstrap
 * (`texts` = pad vocabulary, `messages` = the `ui` bundle).
 */
/* global window, document */
import {
  renderA2UI,
  createTranslator,
  KB_DISPLAY_CONTROLS_ACTIONS,
} from '/shared-ui/kyberion-ui.js';

export const PAD_THEME_KEY = 'kyberion.ui.theme';
export const PAD_LOCALE_KEY = 'kyberion.ui.locale';
export const PAD_LOCALE_COOKIE = 'kb-ui-locale';
export const PAD_THEME_COOKIE = 'kb-ui-theme';
const THEMES = ['light', 'dark', 'system'];
const LOCALE_TAG = /^[a-z]{2,3}(?:-[a-z0-9]{2,8})?$/;

let cachedBootstrap = null;
let cachedTranslate = null;

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** The parsed `#pad-bootstrap` object (`{ locale, messages, texts, ... }`); cached. */
export function readBootstrap(doc = document) {
  if (cachedBootstrap && doc === document) return cachedBootstrap;
  let parsed = {};
  try {
    const node = doc.getElementById('pad-bootstrap');
    const value = node ? JSON.parse(node.textContent || '{}') : {};
    if (isRecord(value)) parsed = value;
  } catch {
    // malformed bootstrap: fall back to the renderer defaults
  }
  const bootstrap = Object.assign({}, parsed, {
    locale: typeof parsed.locale === 'string' ? parsed.locale : 'en',
    messages: isRecord(parsed.messages) ? parsed.messages : {},
    texts: isRecord(parsed.texts) ? parsed.texts : {},
  });
  if (doc === document) cachedBootstrap = bootstrap;
  return bootstrap;
}

/** Translate a pad (`texts`) or `ui` (`messages`) key; `{name}` params are interpolated. */
export function t(key, params) {
  if (!cachedTranslate) {
    const bootstrap = readBootstrap();
    cachedTranslate = createTranslator({
      messages: Object.assign({}, bootstrap.messages, bootstrap.texts),
    });
  }
  return cachedTranslate(key, params);
}

function readStorage(key) {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key, value) {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    // best effort: the choice still applies to this page view
  }
}

function readCookie(name) {
  try {
    for (const part of String(document.cookie || '').split(';')) {
      const eq = part.indexOf('=');
      if (eq !== -1 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
    }
  } catch {
    // cookies unavailable
  }
  return null;
}

/** The theme choice: the shared cookie, else this pad's storage — 'light' | 'dark' | 'system'. */
export function currentTheme() {
  const shared = readCookie(PAD_THEME_COOKIE);
  if (THEMES.includes(shared)) return shared;
  const value = readStorage(PAD_THEME_KEY);
  return value === 'light' || value === 'dark' ? value : 'system';
}

/** Apply and remember a theme without reloading (this pad and, via the cookie, every pad). */
export function setTheme(value) {
  const theme = value === 'light' || value === 'dark' ? value : 'system';
  writeStorage(PAD_THEME_KEY, theme === 'system' ? null : theme);
  try {
    document.cookie = `${PAD_THEME_COOKIE}=${theme}; path=/; max-age=31536000; SameSite=Lax`;
  } catch {
    // cookies blocked: this pad still remembers it
  }
  const root = document.documentElement;
  if (theme === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', theme);
  return theme;
}

/** Remember a language (storage + cookie) and reload the page in it. */
export function setLocale(value) {
  if (typeof value !== 'string' || !LOCALE_TAG.test(value)) return;
  writeStorage(PAD_LOCALE_KEY, value);
  try {
    document.cookie = `${PAD_LOCALE_COOKIE}=${value}; path=/; max-age=31536000; SameSite=Lax`;
  } catch {
    // cookies blocked: `?lang=` below still switches this view
  }
  const url = new URL(window.location.href);
  url.searchParams.delete('lang');
  if (!document.cookie.includes(`${PAD_LOCALE_COOKIE}=${value}`))
    url.searchParams.set('lang', value);
  window.location.replace(url.toString());
}

/** `renderA2UI` with the page's locale and messages bound. */
export function renderPadA2UI(container, components, options = {}) {
  const bootstrap = readBootstrap();
  return renderA2UI(
    container,
    components,
    Object.assign({ locale: bootstrap.locale, messages: bootstrap.messages }, options)
  );
}

/** Render `ui:display-controls` (theme + language) into `host`. */
export function mountDisplayControls(host) {
  if (!host) return;
  const draw = () =>
    renderPadA2UI(
      host,
      [
        {
          id: 'pad-display-controls',
          type: 'ui:display-controls',
          props: { theme: currentTheme(), locale: readBootstrap().locale },
        },
      ],
      {
        onAction(action) {
          const value = action && action.payload ? action.payload.value : undefined;
          if (action.id === KB_DISPLAY_CONTROLS_ACTIONS.theme) {
            setTheme(value);
            draw();
          } else if (action.id === KB_DISPLAY_CONTROLS_ACTIONS.locale) {
            if (value !== readBootstrap().locale) setLocale(value);
          }
        },
      }
    );
  draw();
}

/**
 * Boot a pad page: mount every `[data-pad-display-controls]` host and return
 * the bootstrap plus a `render` bound to the page locale and `onAction`.
 */
export function bootPad(options = {}) {
  const bootstrap = readBootstrap();
  for (const host of document.querySelectorAll('[data-pad-display-controls]')) {
    mountDisplayControls(host);
  }
  const onAction = typeof options.onAction === 'function' ? options.onAction : undefined;
  return {
    bootstrap,
    t,
    render(container, components, extra) {
      return renderPadA2UI(container, components, Object.assign({ onAction }, extra || {}));
    },
  };
}
