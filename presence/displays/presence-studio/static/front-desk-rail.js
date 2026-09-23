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
 * It also renders the header's theme / language controls (the shared
 * `ui:display-controls`, into `front-desk-shell-controls.partial.html`'s
 * slot) and persists their actions through `window.KyberionPrefs`
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

/**
 * Render kyberion-base components into `container` with the viewer's locale
 * and the shared `ui` message bundle. Resolves to the container.
 */
function render(container, components, options) {
  return uiMessages().then((messages) =>
    renderA2UI(container, components, Object.assign({ locale, messages }, options || {}))
  );
}

/** `ui:nav-rail` context switcher action (payload `{ value: tenant_slug }`). */
const TENANT_SWITCH_ACTION = 'tenant.switch';

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

/**
 * The `ui:nav-rail` context slot for the tenant being viewed — only once a
 * tenant is actually viewed (an empty name/role block reads as broken). With
 * more than one tenant it is a switcher (`tenant.switch`).
 */
function tenantContext(nav, me) {
  if (!me || !me.viewing) return undefined;
  const context = {
    label: me.viewing.display_name || me.viewing.tenant_slug,
    detail: tenantSummaryText(nav, me),
    switch_label: nav.tenant_switch_aria || undefined,
  };
  if (me.can_switch) {
    context.action = { id: TENANT_SWITCH_ACTION };
    context.options = (me.tenants || []).map((tenant) => ({
      value: tenant.tenant_slug,
      label: tenant.display_name,
      selected: tenant.tenant_slug === me.viewing.tenant_slug,
    }));
  }
  return context;
}

/**
 * The whole rail as one `ui:nav-rail`: brand + tenant context slots, the
 * role-gated verb items and help in the footer — same component (and so the
 * same markup / CSS) as the concierge React rail.
 */
function railComponents(nav, me, current) {
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
  const props = {
    label: nav.aria_label,
    brand: { name: 'Kyberion', subtitle: nav.brand_tagline || undefined },
    items,
    footer_items: footer,
  };
  const context = tenantContext(nav, me);
  if (context) props.context = context;
  return [{ id: 'front-desk-rail', type: 'ui:nav-rail', props }];
}

function drawRail(el, nav, me, current) {
  return render(el, railComponents(nav, me, current), {
    onAction(action) {
      if (!action || action.id !== TENANT_SWITCH_ACTION) return;
      const slug = action.payload && action.payload.value;
      if (typeof slug !== 'string' || !slug) return;
      storeTenant(slug);
      loadMe(slug).then((next) => {
        if (next) drawRail(el, nav, next, current);
      });
    },
  });
}

/**
 * The header's theme / language controls: the shared `ui:display-controls`
 * (same component as the concierge header). It only emits `display.*`
 * actions; `window.KyberionPrefs` persists them (`kyberion.ui.theme` /
 * `kyberion.ui.locale` + the `kb-ui-locale` cookie).
 */
function mountDisplayControls() {
  const host = document.querySelector('[data-front-desk-display-controls]');
  if (!host) return Promise.resolve(null);
  const draw = () =>
    render(
      host,
      [
        {
          id: 'display-controls',
          type: 'ui:display-controls',
          props: { theme: prefs.theme(), locale },
        },
      ],
      {
        onAction(action) {
          const value = action && action.payload ? action.payload.value : undefined;
          if (action.id === 'display.theme') {
            prefs.setTheme(value);
            draw();
          } else if (action.id === 'display.locale') {
            prefs.setLocale(value);
          }
        },
      }
    );
  return draw();
}

/**
 * Mount the rail into `el` (the `.kb-app-shell__nav` slot) with the item
 * `options.current` marked as the current page. The server-rendered
 * placeholder stays until the menu has loaded; a fetch failure never blocks
 * the rest of the page.
 */
function mount(el, options) {
  mountDisplayControls().catch(() => null);
  if (!el) return Promise.resolve(null);
  const current = (options && options.current) || null;
  return Promise.all([loadNav(), loadMe(readStoredTenant())])
    .then(([nav, me]) => {
      if (!nav) return null;
      return drawRail(el, nav, me, current).then(() => nav);
    })
    .catch(() => null);
}

window.FrontDeskRail = { mount, render, nav: loadNav, locale: () => locale };
