/*
 * ui-gallery.js — UI-04 component gallery (`GET /ui-gallery`).
 *
 * Renders every kyberion-base (`ui:*`) component from the per-locale fixtures
 * (`ui-gallery.fixtures.<locale>.json` plus every
 * `ui-gallery.fixtures.<part>.<locale>.json`, merged by the
 * `/ui-gallery/fixtures/<locale>.json` route) with the shared vanilla renderer
 * (`/shared-ui/kyberion-ui.js`, served from libs/shared-ui/vanilla). The
 * fixtures are validated against the catalog schema (and against each other:
 * identical shape across locales) in
 * `presence/displays/presence-studio/ui-gallery.test.ts`.
 *
 * UI-01d i18n: no user-facing text lives in this file. Gallery chrome is
 * `data-i18n` keys resolved from `/ui-gallery/vocabulary/<locale>.json`;
 * renderer defaults (status labels, empty/loading text, ...) come from the
 * `ui` vocabulary bundle at `/shared-ui/messages/<locale>.json`, handed to
 * `renderA2UI({ locale, messages })`. The locale is `?lang=`, else the
 * shared stored language (`kyberion.ui.locale`), else the browser language,
 * else the catalog default (en).
 *
 * Theme / density toggles set `data-theme` / `data-density` on <html>. The
 * initial theme is applied before paint by `ui-gallery-prefs.js`: `?theme=`,
 * else the shared stored theme (`kyberion.ui.theme`), else the system
 * preference. `?theme=dark&density=compact` are used for screenshot baselines.
 */
/* global document, window, fetch, navigator, URLSearchParams, Element */
// Resolved before paint by ui-gallery-prefs.js (absent if that script failed).
const prefs = window.KyberionGalleryPrefs || {};
import { KB_UI_DEFAULT_LOCALE, renderA2UI } from '/shared-ui/kyberion-ui.js';

const THEMES = ['light', 'dark'];
const DENSITIES = ['comfortable', 'compact'];
// Locales the vocabulary catalog supports; `qps-ploc` (pseudo-locale) has no
// sample data of its own and reuses the English fixtures (resolved by the
// `/ui-gallery/fixtures/<locale>.json` route).
const LOCALES = ['en', 'ja', 'qps-ploc'];
const html = document.documentElement;

const state = { locale: KB_UI_DEFAULT_LOCALE, texts: {}, messages: {}, loadId: 0 };

function setParam(name, value) {
  const params = new URLSearchParams(window.location.search);
  params.set(name, value);
  window.history.replaceState(null, '', `${window.location.pathname}?${params.toString()}`);
}

function setPressed(attribute, value) {
  for (const button of document.querySelectorAll(`[data-set-${attribute}]`)) {
    button.setAttribute(
      'aria-pressed',
      String(button.getAttribute(`data-set-${attribute}`) === value)
    );
  }
}

function setChoice(attribute, value) {
  html.setAttribute(`data-${attribute}`, value);
  setPressed(attribute, value);
  setParam(attribute, value);
}

/**
 * `?lang=` (exact supported locale), else the shared stored language (both
 * resolved by ui-gallery-prefs.js), else the browser language, else the default.
 */
function resolveLocale() {
  const requested = new URLSearchParams(window.location.search).get('lang');
  if (requested && LOCALES.includes(requested)) return requested;
  if (LOCALES.includes(prefs.locale)) return prefs.locale;
  const browser = (navigator.languages && navigator.languages[0]) || navigator.language || '';
  const primary = String(browser).toLowerCase().split('-')[0];
  return LOCALES.includes(primary) ? primary : KB_UI_DEFAULT_LOCALE;
}

/** Gallery chrome text for a vocabulary key; `{name}` params; the key when missing. */
function text(key, params) {
  const template =
    typeof state.texts[key] === 'string' && state.texts[key] ? state.texts[key] : key;
  return template.replace(/\{([A-Za-z0-9_]+)\}/g, (match, name) =>
    params && Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match
  );
}

function applyChromeTexts() {
  for (const node of document.querySelectorAll('[data-i18n]')) {
    const key = node.getAttribute('data-i18n');
    if (state.texts[key]) node.textContent = state.texts[key];
  }
  for (const node of document.querySelectorAll('[data-i18n-aria-label]')) {
    const key = node.getAttribute('data-i18n-aria-label');
    if (state.texts[key]) node.setAttribute('aria-label', state.texts[key]);
  }
}

function initToggles() {
  const params = new URLSearchParams(window.location.search);
  const theme = params.get('theme');
  const density = params.get('density');
  if (THEMES.includes(theme)) {
    setChoice('theme', theme);
  } else {
    // No `?theme=`: keep what ui-gallery-prefs.js applied before paint (the
    // stored theme, or none = follow the system) and only mark the toggle.
    const applied = html.getAttribute('data-theme');
    const systemDark =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-color-scheme: dark)').matches;
    setPressed('theme', THEMES.includes(applied) ? applied : systemDark ? 'dark' : 'light');
  }
  setChoice('density', DENSITIES.includes(density) ? density : 'comfortable');
  document.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target.closest('button') : null;
    if (!target) return;
    const theme = target.getAttribute('data-set-theme');
    if (theme && THEMES.includes(theme)) setChoice('theme', theme);
    const density = target.getAttribute('data-set-density');
    if (density && DENSITIES.includes(density)) setChoice('density', density);
    const lang = target.getAttribute('data-set-lang');
    if (lang && LOCALES.includes(lang) && lang !== state.locale) {
      setParam('lang', lang);
      load(lang);
    }
  });
}

function showStatus(message) {
  const status = document.getElementById('gallery-status');
  if (status) status.textContent = message;
}

// PA-09: `ui:talking-avatar` controllers by name (from `avatar.ready`), for
// the synthetic speech demo button (`gallery.avatar.speak { name }`).
const avatars = new Map();
const AVATAR_DEMO_MS = 4000;

function speakDemo(name) {
  const avatar = avatars.get(name);
  if (!avatar) return;
  avatar.setState('speaking');
  avatar.startSynthetic({ seed: 7 });
  window.setTimeout(() => {
    avatar.stopSynthetic();
    avatar.setState('idle');
  }, AVATAR_DEMO_MS);
}

function onAction(action) {
  const payload = action.payload || {};
  if (action.id === 'avatar.ready') {
    avatars.set(payload.name, payload.controller);
    return;
  }
  if (action.id === 'gallery.avatar.speak') speakDemo(payload.name);
  showStatus(text('presence_studio:ui_gallery_action', { id: action.id }));
  window.setTimeout(() => showStatus(''), 2400);
}

function renderOptions(extra) {
  return { locale: state.locale, messages: state.messages, onAction, ...extra };
}

function typesOf(components) {
  return [...new Set(components.map((component) => component.type))].sort();
}

/** Index label: the section title without its trailing `ui:*` type list. */
function shortTitle(title) {
  return String(title).replace(/\s+ui:.*$/u, '');
}

function renderSection(section, list) {
  const block = document.createElement('section');
  block.className = 'gallery-block';
  block.id = `g-${section.id}`;
  const titleId = `g-${section.id}-title`;
  block.setAttribute('aria-labelledby', titleId);

  const intro = document.createElement('div');
  intro.className = 'gallery-block__intro';
  const title = document.createElement('h2');
  title.className = 'gallery-block__title';
  title.id = titleId;
  title.textContent = section.title;
  intro.appendChild(title);
  if (section.description) {
    const description = document.createElement('p');
    description.className = 'gallery-block__description';
    description.textContent = section.description;
    intro.appendChild(description);
  }
  const types = document.createElement('p');
  types.className = 'gallery-block__types';
  types.textContent = typesOf(section.components).join(' · ');
  intro.appendChild(types);
  block.appendChild(intro);

  const demo = document.createElement('div');
  demo.className = 'gallery-demo kb-stack';
  renderA2UI(demo, section.components, renderOptions());
  block.appendChild(demo);

  const item = document.createElement('li');
  const link = document.createElement('a');
  link.href = `#${block.id}`;
  link.textContent = shortTitle(section.title);
  item.appendChild(link);
  list.appendChild(item);
  return block;
}

async function fetchJson(url) {
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

function clear(node) {
  while (node && node.firstChild) node.removeChild(node.firstChild);
}

async function load(locale) {
  const loadId = (state.loadId += 1);
  html.removeAttribute('data-gallery-ready');
  const [vocabulary, bundle, fixtures] = await Promise.allSettled([
    fetchJson(`/ui-gallery/vocabulary/${locale}.json`),
    fetchJson(`/shared-ui/messages/${locale}.json`),
    // Base fixtures + every ui-gallery.fixtures.<part>.<locale>.json, merged server-side.
    fetchJson(`/ui-gallery/fixtures/${locale}.json`),
  ]);
  if (loadId !== state.loadId) return; // a newer language switch won

  state.locale = locale;
  // A failed vocabulary fetch keeps the renderers on their English defaults.
  state.texts = vocabulary.status === 'fulfilled' ? vocabulary.value.texts || {} : {};
  state.messages = bundle.status === 'fulfilled' ? bundle.value.messages || {} : {};
  html.setAttribute('lang', locale);
  setPressed('lang', locale);
  applyChromeTexts();

  const sampleScreen = document.getElementById('sample-screen');
  const container = document.getElementById('gallery-sections');
  const index = document.getElementById('gallery-index');
  for (const node of [sampleScreen, container, index]) clear(node);
  showStatus('');

  if (fixtures.status !== 'fulfilled') {
    const reason = fixtures.reason;
    showStatus(
      text('presence_studio:ui_gallery_load_failed', {
        error: reason instanceof Error ? reason.message : String(reason),
      })
    );
    return;
  }

  const sample = fixtures.value.sample_screen;
  const description = document.getElementById('sample-description');
  if (description) description.textContent = sample.description || '';
  renderA2UI(sampleScreen, sample.components, renderOptions({ rootId: sample.root }));

  for (const section of fixtures.value.sections) {
    container.appendChild(renderSection(section, index));
  }
  html.setAttribute('data-gallery-ready', 'true');
}

initToggles();
load(resolveLocale());
