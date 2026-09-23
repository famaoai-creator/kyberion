/*
 * ui-gallery.js — UI-04 component gallery (`GET /ui-gallery`).
 *
 * Renders every kyberion-base (`ui:*`) component from
 * `ui-gallery.fixtures.json` with the shared vanilla renderer
 * (`/shared-ui/kyberion-ui.js`, served from libs/shared-ui/vanilla). The
 * fixture is validated against the catalog schema in
 * `presence/displays/presence-studio/ui-gallery.test.ts`.
 *
 * Theme / density toggles set `data-theme` / `data-density` on <html>; the
 * initial values can come from `?theme=dark&density=compact` (used for
 * screenshot baselines).
 */
/* global document, window, fetch, URLSearchParams, Element */
import { renderA2UI } from '/shared-ui/kyberion-ui.js';

const THEMES = ['light', 'dark'];
const DENSITIES = ['comfortable', 'compact'];
const html = document.documentElement;

function setChoice(attribute, value) {
  html.setAttribute(`data-${attribute}`, value);
  for (const button of document.querySelectorAll(`[data-set-${attribute}]`)) {
    button.setAttribute(
      'aria-pressed',
      String(button.getAttribute(`data-set-${attribute}`) === value)
    );
  }
  const params = new URLSearchParams(window.location.search);
  params.set(attribute, value);
  window.history.replaceState(null, '', `${window.location.pathname}?${params.toString()}`);
}

function initToggles() {
  const params = new URLSearchParams(window.location.search);
  const theme = params.get('theme');
  const density = params.get('density');
  setChoice('theme', THEMES.includes(theme) ? theme : 'light');
  setChoice('density', DENSITIES.includes(density) ? density : 'comfortable');
  document.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target.closest('button') : null;
    if (!target) return;
    const theme = target.getAttribute('data-set-theme');
    if (theme && THEMES.includes(theme)) setChoice('theme', theme);
    const density = target.getAttribute('data-set-density');
    if (density && DENSITIES.includes(density)) setChoice('density', density);
  });
}

function showStatus(message) {
  const status = document.getElementById('gallery-status');
  if (status) status.textContent = message;
}

function onAction(action) {
  showStatus(`アクション: ${action.id}`);
  window.setTimeout(() => showStatus(''), 2400);
}

function typesOf(components) {
  return [...new Set(components.map((component) => component.type))].sort();
}

function renderSection(section, index, list) {
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
  renderA2UI(demo, section.components, { onAction });
  block.appendChild(demo);

  const item = document.createElement('li');
  const link = document.createElement('a');
  link.href = `#${block.id}`;
  link.textContent = section.title.split(' ')[0];
  item.appendChild(link);
  list.appendChild(item);
  return block;
}

async function main() {
  initToggles();
  let fixtures;
  try {
    const response = await fetch('/ui-gallery.fixtures.json', { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    fixtures = await response.json();
  } catch (error) {
    showStatus(
      `サンプルデータを読み込めませんでした (${error instanceof Error ? error.message : String(error)})`
    );
    return;
  }

  const sample = fixtures.sample_screen;
  const description = document.getElementById('sample-description');
  if (description) description.textContent = sample.description || '';
  renderA2UI(document.getElementById('sample-screen'), sample.components, {
    rootId: sample.root,
    onAction,
  });

  const container = document.getElementById('gallery-sections');
  const index = document.getElementById('gallery-index');
  fixtures.sections.forEach((section, i) => {
    container.appendChild(renderSection(section, i, index));
  });
  html.setAttribute('data-gallery-ready', 'true');
}

main();
