/*
 * front-desk-rail.js — the presence-studio front-desk shell (FD-00/FD-01,
 * restyled for UI-05/UI-06 of SURFACE_UI_UNIFICATION_PLAN_2026-09-23).
 *
 * ES module. Renders the shared "human verbs" rail as the kyberion-base
 * `ui:nav-rail` component through the shared vanilla renderer
 * (`/shared-ui/kyberion-ui.js`), so it is the same markup and CSS as the
 * concierge React `NavRail`. Menu items, labels, hrefs and role gates come
 * from the server (`/api/front-desk/nav`, `/api/me`; items the viewer's
 * role does not allow are not shown) — this file never hardcodes a surface
 * port or host, and cross-surface items stay same-tab links.
 *
 * It also wires the header's theme / language controls (server-rendered
 * from `front-desk-shell-controls.partial.html`) to `window.KyberionPrefs`
 * (`front-desk-prefs.js`), and exposes `FrontDeskRail.render(container,
 * components)` so the page scripts can draw kyberion-base components with
 * the viewer's locale and the shared `ui` message bundle.
 */
/* global window, document, fetch */
import { renderA2UI } from '/shared-ui/kyberion-ui.js';

const TENANT_STORAGE_KEY = 'front-desk.tenant';

/** Rail item id -> kyberion-base icon name (`KB_ICON_PATHS`). */
const NAV_ICONS = {
  home: 'home',
  ask: 'chat',
  decide: 'approval',
  progress: 'chart',
  settings: 'settings',
};

const prefs = window.KyberionPrefs || {
  locale: () => 'en',
  theme: () => 'system',
  setTheme: () => {},
  setLocale: () => {},
};
const locale = prefs.locale();

function fetchJson(url) {
  return fetch(url).then((response) => response.json());
}

let messagesPromise = null;
/** The renderer's `ui:*` bundle for the viewer's locale (`{}` on failure). */
function uiMessages() {
  if (!messagesPromise) {
    messagesPromise = fetchJson('/shared-ui/messages/' + encodeURIComponent(locale) + '.json')
      .then((body) => (body && body.ok && body.messages ? body.messages : {}))
      .catch(() => ({}));
  }
  return messagesPromise;
}

let navPromise = null;
/** `/api/front-desk/nav` for the viewer's locale (null on failure). */
function loadNav() {
  if (!navPromise) {
    navPromise = fetchJson('/api/front-desk/nav?locale=' + encodeURIComponent(locale))
      .then((body) => (body && body.ok ? body : null))
      .catch(() => null);
  }
  return navPromise;
}

function readStoredTenant() {
  try {
    return window.localStorage.getItem(TENANT_STORAGE_KEY) || null;
  } catch {
    return null;
  }
}

function storeTenant(slug) {
  try {
    window.localStorage.setItem(TENANT_STORAGE_KEY, slug);
  } catch {
    // Best-effort only — the rail still works without persistence.
  }
}

function loadMe(tenantSlug) {
  const url = tenantSlug ? '/api/me?tenant=' + encodeURIComponent(tenantSlug) : '/api/me';
  return fetchJson(url)
    .then((body) => (body && body.ok ? body : null))
    .catch(() => null);
}

function renderTemplate(template, params) {
  return String(template || '').replace(/\{(\w+)\}/g, (match, key) =>
    Object.prototype.hasOwnProperty.call(params, key) ? String(params[key]) : match
  );
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

/**
 * Render kyberion-base components into `container` with the viewer's locale
 * and the shared `ui` message bundle. Resolves to the container.
 */
function render(container, components, options) {
  return uiMessages().then((messages) =>
    renderA2UI(container, components, Object.assign({ locale, messages }, options || {}))
  );
}

function railComponents(nav, current) {
  const helpActive = window.location.pathname.indexOf('/help') === 0;
  const items = (nav.items || [])
    .filter((item) => item.allowed !== false)
    .map((item) => ({
      id: item.id,
      label: item.label,
      hint: item.sublabel,
      href: item.href,
      icon: NAV_ICONS[item.id],
      active: Boolean(current) && item.id === current,
    }));
  const footer = nav.help
    ? [{ id: 'help', label: nav.help.label, href: nav.help.href, icon: 'help', active: helpActive }]
    : [];
  return [
    {
      id: 'front-desk-rail',
      type: 'ui:nav-rail',
      props: { label: nav.aria_label, items, footer_items: footer },
    },
  ];
}

function brandBlock(nav) {
  const brand = element('div', 'ps-rail-brand');
  const mark = element('span', 'ps-rail-brand__mark');
  mark.setAttribute('aria-hidden', 'true');
  const text = element('span', 'ps-rail-brand__text');
  text.appendChild(element('strong', '', 'Kyberion'));
  text.appendChild(element('small', '', nav.brand_tagline || ''));
  brand.appendChild(mark);
  brand.appendChild(text);
  return brand;
}

function tenantSummaryText(nav, me) {
  const roleLabel = (nav.role_labels && nav.role_labels[me.viewing.role]) || me.viewing.role;
  if (me.can_switch) {
    return renderTemplate(nav.tenant_viewing_summary, {
      role: roleLabel,
      count: (me.tenants || []).length,
    });
  }
  return renderTemplate(nav.tenant_viewing_single, { role: roleLabel });
}

function tenantBlock(nav, me, onSwitch) {
  if (!me || !me.viewing) return null;
  const block = element('div', 'ps-rail-tenant');
  const button = element('button', 'ps-rail-tenant__button');
  button.type = 'button';
  button.setAttribute('aria-label', nav.tenant_switch_aria || '');
  button.setAttribute('aria-haspopup', 'listbox');
  button.setAttribute('aria-expanded', 'false');
  if (!me.can_switch) button.disabled = true;
  button.appendChild(element('span', 'ps-rail-tenant__name', me.viewing.display_name));
  button.appendChild(element('span', 'ps-rail-tenant__summary', tenantSummaryText(nav, me)));
  block.appendChild(button);
  if (!me.can_switch) return block;

  const list = element('ul', 'ps-rail-tenant__list');
  list.setAttribute('role', 'listbox');
  list.hidden = true;
  for (const tenant of me.tenants || []) {
    const selected = tenant.tenant_slug === me.viewing.tenant_slug;
    const option = element('li', 'ps-rail-tenant__option', tenant.display_name);
    option.setAttribute('role', 'option');
    option.setAttribute('aria-selected', selected ? 'true' : 'false');
    option.tabIndex = 0;
    const choose = () => {
      list.hidden = true;
      button.setAttribute('aria-expanded', 'false');
      onSwitch(tenant.tenant_slug);
    };
    option.addEventListener('click', choose);
    option.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        choose();
      }
    });
    list.appendChild(option);
  }
  button.addEventListener('click', () => {
    const expanded = button.getAttribute('aria-expanded') === 'true';
    button.setAttribute('aria-expanded', expanded ? 'false' : 'true');
    list.hidden = expanded;
  });
  block.appendChild(list);
  return block;
}

function switchTenant(rail, nav, slug) {
  storeTenant(slug);
  loadMe(slug).then((next) => {
    if (!next) return;
    const current = rail.querySelector('.ps-rail-tenant');
    const replacement = tenantBlock(nav, next, (other) => switchTenant(rail, nav, other));
    if (current && replacement) rail.replaceChild(replacement, current);
  });
}

function decorateRail(container, nav, me) {
  const rail = container.querySelector('.kb-nav-rail');
  if (!rail) return;
  const first = rail.firstChild;
  rail.insertBefore(brandBlock(nav), first);
  const tenant = tenantBlock(nav, me, (slug) => switchTenant(rail, nav, slug));
  if (tenant) rail.insertBefore(tenant, first);
}

function wireHeaderControls() {
  const themeSelect = document.querySelector('[data-front-desk-theme]');
  if (themeSelect) {
    themeSelect.value = prefs.theme();
    themeSelect.addEventListener('change', () => prefs.setTheme(themeSelect.value));
  }
  const localeSelect = document.querySelector('[data-front-desk-locale]');
  if (localeSelect) {
    localeSelect.value = locale;
    localeSelect.addEventListener('change', () => prefs.setLocale(localeSelect.value));
  }
}

/**
 * Mount the rail into `el` (the `.kb-app-shell__nav` slot) with the item
 * `options.current` marked as the current page. The server-rendered
 * placeholder stays until the menu has loaded; a fetch failure never blocks
 * the rest of the page.
 */
function mount(el, options) {
  wireHeaderControls();
  if (!el) return Promise.resolve(null);
  const current = (options && options.current) || null;
  return Promise.all([loadNav(), loadMe(readStoredTenant())])
    .then(([nav, me]) => {
      if (!nav) return null;
      return render(el, railComponents(nav, current)).then(() => {
        decorateRail(el, nav, me);
        return nav;
      });
    })
    .catch(() => null);
}

window.FrontDeskRail = { mount, render, nav: loadNav, locale: () => locale };
