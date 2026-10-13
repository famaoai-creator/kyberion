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

const prefs = window.KyberionPrefs || {
  locale: () => 'en',
  theme: () => 'system',
  setTheme: () => {},
  setLocale: () => {},
};
const locale = prefs.locale();

function readError(reason = 'unavailable') {
  return Object.assign(new Error('Front-desk read unavailable'), { reason });
}

// Bound both headers and body. Only GET reads use this helper, never mutations.
function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const controller = window.AbortController ? new window.AbortController() : null;
    const timer = window.setTimeout(() => {
      reject(readError());
      if (controller) controller.abort();
    }, 20000);
    Promise.resolve()
      .then(() => fetch(url, { cache: 'no-store', signal: controller?.signal }))
      .then((response) => {
        if (response.status === 401) throw readError('authentication');
        if (response.status === 403) throw readError('permission');
        if (!response.ok) throw readError();
        return response.json();
      })
      .then(
        (body) => {
          window.clearTimeout(timer);
          resolve(body);
        },
        (error) => {
          window.clearTimeout(timer);
          if (controller) controller.abort();
          reject(error);
        }
      );
  });
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
/** `/api/front-desk/nav` for the viewer's locale (rejects failed reads). */
function loadNav(pinnedUrl) {
  if (!navPromise) {
    const url = '/api/front-desk/nav?locale=' + encodeURIComponent(locale);
    navPromise = fetchJson(pinnedUrl || (prefs.scopedUrl ? prefs.scopedUrl(url) : url)).then(
      (body) => {
        if (!body || body.ok !== true || !Array.isArray(body.items)) throw readError();
        return body;
      }
    );
  }
  return navPromise;
}

function readStoredTenant() {
  try {
    return prefs.tenant ? prefs.tenant() : window.localStorage.getItem(TENANT_STORAGE_KEY) || null;
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
  return fetchJson(url).then((body) => {
    if (
      !body ||
      body.ok !== true ||
      !Array.isArray(body.tenants) ||
      (body.viewing !== null &&
        (!body.viewing ||
          typeof body.viewing.tenant_slug !== 'string' ||
          !body.viewing.tenant_slug ||
          typeof body.viewing.role !== 'string'))
    )
      throw readError();
    return body;
  });
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
  return uiMessages().then((messages) => {
    if (options && options.isCurrent && !options.isCurrent()) return container;
    return renderA2UI(container, components, Object.assign({ locale, messages }, options || {}));
  });
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
  const pathname = window.location.pathname;
  const actualCurrent =
    pathname === '/work'
      ? 'workspace'
      : pathname === '/first-job'
        ? 'first-job'
        : pathname === '/help' || pathname.startsWith('/help/')
          ? 'help'
          : current;
  const items = (nav.items || [])
    .filter((item) => item.allowed === true)
    .map((item) => ({
      id: item.id,
      label: item.label,
      hint: item.sublabel,
      href: prefs.scopedUrl ? prefs.scopedUrl(item.href, item.scope_query_style) : item.href,
      icon: item.icon,
      group_label: item.group_label,
      active: Boolean(actualCurrent) && item.id === actualCurrent,
    }));
  const props = {
    label: nav.aria_label,
    brand: { name: 'Kyberion', subtitle: nav.brand_tagline || undefined },
    items,
  };
  const context = tenantContext(nav, me);
  if (context) props.context = context;
  return [{ id: 'front-desk-rail', type: 'ui:nav-rail', props }];
}

function drawRail(el, nav, me, current, isCurrent) {
  let tenantGeneration = 0;
  return render(el, railComponents(nav, me, current), {
    isCurrent,
    onAction(action) {
      if (!isCurrent() || !action || action.id !== TENANT_SWITCH_ACTION) return;
      const slug = action.payload && action.payload.value;
      if (typeof slug !== 'string' || !slug) return;
      const generation = ++tenantGeneration;
      loadMe(slug)
        .then((next) => {
          if (generation !== tenantGeneration || !isCurrent()) return;
          if (!next || !next.viewing || next.viewing.tenant_slug !== slug) return;
          storeTenant(slug);
          if (prefs.setTenant) prefs.setTenant(slug);
          // Reload every panel together; durable drafts/history remain scoped.
          window.location.reload();
        })
        .catch(() => null);
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
 * placeholder is replaced by explicit recovery when reads fail. Dependent
 * page initialization waits for validated scope; optional chrome stays additive.
 */
let mountGeneration = 0;
let retryCurrent = () => Promise.resolve(null);
let shellState = { phase: 'loading', reason: null, message: '' };
const listeners = new Set();

function subscribe(listener) {
  listeners.add(listener);
  listener(shellState);
  return () => listeners.delete(listener);
}

function scopeFingerprint() {
  const query = new URLSearchParams(window.location.search || '');
  return JSON.stringify([
    readStoredTenant(),
    ...['tenant', 'organizationId', 'organization_id', 'projectId', 'project_id'].map((key) =>
      query.getAll(key)
    ),
  ]);
}

function mount(el, options) {
  const generation = ++mountGeneration;
  mountDisplayControls().catch(() => null);
  if (!el) return Promise.resolve(null);
  const current = (options && options.current) || null;
  const content = (el.querySelector && el.querySelector('[data-front-desk-content]')) || el;
  const recovery = el.querySelector && el.querySelector('[data-front-desk-recovery]');
  const retry = recovery && recovery.querySelector('button');
  let resolveReady;
  // Failure does not release dependent pages. Manual retry resumes this same waiter.
  // A superseded mount owns a different waiter and can never release the old one.
  window.FrontDeskRail.ready = new Promise((resolve) => {
    resolveReady = resolve;
  });
  let attempt = 0;
  let pending = false;
  function present(phase, reason = null) {
    const key = reason || phase;
    const message = recovery ? recovery.getAttribute('data-shell-' + key) || '' : '';
    if (recovery) {
      recovery.hidden = phase === 'ready';
      const status = recovery.querySelector('[data-shell-status]');
      if (status) status.textContent = message;
      if (retry) {
        retry.hidden = phase !== 'blocked';
        retry.disabled = pending;
      }
      content.hidden = phase !== 'ready';
    }
    shellState = { phase, reason, message };
    listeners.forEach((listener) => {
      try {
        listener(shellState);
      } catch {
        /* additive presentation */
      }
    });
  }
  function run() {
    if (pending || generation !== mountGeneration) return Promise.resolve(null);
    pending = true;
    const token = ++attempt;
    let expectedScope = scopeFingerprint();
    const isCurrent = () =>
      generation === mountGeneration && token === attempt && expectedScope === scopeFingerprint();
    function assertCurrent() {
      if (!isCurrent()) throw readError('changed');
    }
    present('loading');
    const query = new URLSearchParams(window.location.search || '');
    const requestedTenant = query.get('tenant') || readStoredTenant();
    return loadMe(requestedTenant)
      .then((me) => {
        assertCurrent();
        if (prefs.setTenant) prefs.setTenant(me.viewing ? me.viewing.tenant_slug : null);
        expectedScope = scopeFingerprint();
        navPromise = null;
        const url = '/api/front-desk/nav?locale=' + encodeURIComponent(locale);
        return loadNav(prefs.scopedUrl ? prefs.scopedUrl(url) : url).then((nav) => {
          assertCurrent();
          return drawRail(content, nav, me, current, isCurrent).then(() => {
            assertCurrent();
            pending = false;
            present('ready');
            resolveReady([nav, me]);
            return nav;
          });
        });
      })
      .catch((error) => {
        if (generation !== mountGeneration || token !== attempt) return null;
        pending = false;
        present('blocked', error.reason || 'unavailable');
        return null;
      });
  }
  retryCurrent = () => (shellState.phase === 'blocked' ? run() : Promise.resolve(null));
  if (retry) retry.onclick = () => retryCurrent();
  return run();
}

window.FrontDeskRail = {
  mount,
  render,
  nav: loadNav,
  subscribe,
  retry: () => retryCurrent(),
  locale: () => locale,
};
