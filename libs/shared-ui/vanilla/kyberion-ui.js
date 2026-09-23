/*
 * Kyberion UI — vanilla DOM renderer for the A2UI `kyberion-base` catalog
 * (UI-04, SURFACE_UI_UNIFICATION_PLAN_2026-09-23 §5).
 *
 * Dependency-free ES module (plain JS + JSDoc, no build step). Static
 * surfaces (presence-studio, computer-surface) serve this file as-is and
 * import it with `<script type="module">`.
 *
 * Contract: it emits exactly the markup `kyberion-ui.css` styles
 * (knowledge/public/design-patterns/web/kyberion-ui.source.css is the source
 * of truth). The React renderer in `libs/shared-ui/src` must emit the same
 * classes, BEM elements and data attributes.
 *
 * Safety rules:
 *   - DOM is built with createElement / textContent only — never innerHTML.
 *   - hrefs are allow-listed (relative, http, https, mailto, tel); anything
 *     else (javascript:, data:, vbscript:, ...) is dropped.
 *   - Actions are never evaluated; they are handed to `onAction`.
 */
/* global document, window */
// UI-01b charts & visualisation: geometry lives in ./charts.js (shared with React).
import { KB_CHART_TYPES, layoutChart } from './charts.js';
// UI-01c settings & forms: renderers + pure helpers live in ./forms.js (shared with React).
import { createFormRenderers } from './forms.js';
// PA-02 voice: renderers + microphone controller live in ./voice.js (shared with React).
import { createVoiceRenderers } from './voice.js';
// PA-01 pads: toolbar / dialog / drawing renderers live in ./pads.js (shared with React).
import { createPadRenderers } from './pads.js';
// UI-01d vocabulary (generated default messages, key tables, translator,
// status labels, aliases, icons) lives in ./kyberion-ui-vocabulary.js.
import {
  KB_UI_DEFAULT_LOCALE,
  KB_STATUS_MESSAGE_KEYS,
  KB_UI_MESSAGE_KEYS,
  KB_DISPLAY_CONTROLS_ACTIONS,
  DISPLAY_THEMES,
  LOCALE_TAG,
  hasOwn,
  createTranslator,
  statusLabel,
  KB_ALIASES,
  KB_ICON_PATHS,
} from './kyberion-ui-vocabulary.js';

export {
  KB_UI_DEFAULT_LOCALE,
  KB_UI_DEFAULT_MESSAGES,
  KB_STATUS_MESSAGE_KEYS,
  KB_STATUS_DOMAIN_MESSAGE_KEYS,
  KB_UI_MESSAGE_KEYS,
  KB_DISPLAY_CONTROLS_ACTIONS,
  createTranslator,
  statusMessageKey,
  statusLabel,
  KB_ALIASES,
  KB_ICON_PATHS,
} from './kyberion-ui-vocabulary.js';

/** `ui:metric` trend arrow icon and its accessible word per `trend` value. */
const TREND_ICONS = Object.freeze({ up: 'arrow-up', down: 'arrow-down', flat: 'arrow-right' });
const TREND_MESSAGE_KEYS = Object.freeze({
  up: KB_UI_MESSAGE_KEYS.trendUp,
  down: KB_UI_MESSAGE_KEYS.trendDown,
  flat: KB_UI_MESSAGE_KEYS.trendFlat,
});

const SVG_NS = 'http://www.w3.org/2000/svg';
// Single source for `safeHref` — the React renderer re-exports this
// implementation (`safety.ts`) instead of keeping its own copy.
const SAFE_SCHEMES = new Set(['http:', 'https:', 'mailto:', 'tel:']);
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const SCHEME_PREFIX = /^([a-z][a-z0-9+.-]*):/i;
const WIDTH_PATTERN = /^(auto|[0-9]{1,4}(px|rem|ch|%))$/;
const MAX_DEPTH = 32;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Return a navigable href, or null when it is empty, contains a control
 * character, is protocol-relative (`//host`, backslash tricks) or uses a
 * scheme outside the allow-list (javascript:, data:, vbscript:, file:, ...).
 * Allowed schemes: http(s), mailto, tel; same-origin paths / fragments /
 * queries pass through unchanged.
 * @param {unknown} value
 * @returns {string | null}
 */
export function safeHref(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 2048 || CONTROL_CHARS.test(trimmed)) return null;
  const lower = trimmed.toLowerCase();
  if (lower.startsWith('//') || lower.startsWith('/\\') || lower.startsWith('\\')) return null;
  const scheme = SCHEME_PREFIX.exec(lower);
  if (scheme) return SAFE_SCHEMES.has(`${scheme[1]}:`) ? trimmed : null;
  return trimmed;
}

function str(value) {
  if (value === null || value === undefined) return '';
  return String(value);
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function el(ctx, tag, className, text) {
  const node = ctx.doc.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null && text !== '') node.textContent = str(text);
  return node;
}

function setData(node, name, value) {
  if (value === undefined || value === null || value === '') return;
  node.setAttribute(`data-${name}`, str(value));
}

/** Resolve a component type (or legacy alias) to its `ui:*` type; null when unknown. */
export function resolveType(type) {
  if (typeof type !== 'string') return null;
  if (type.startsWith('ui:') && Object.prototype.hasOwnProperty.call(RENDERERS, type)) return type;
  return Object.prototype.hasOwnProperty.call(KB_ALIASES, type) ? KB_ALIASES[type] : null;
}

function normalizeAction(action) {
  if (typeof action === 'string' && action) return { id: action };
  if (isRecord(action) && typeof action.id === 'string' && action.id) {
    return isRecord(action.payload)
      ? { id: action.id, payload: action.payload }
      : { id: action.id };
  }
  return null;
}

/**
 * `true` for an activation the page should handle itself (plain primary
 * click, or keyboard Enter which fires `click` without modifiers); `false`
 * for modified / middle clicks, which a link with an `href` leaves to the
 * browser (open in a new tab, ...). Shared with the React renderer.
 */
export function isPlainActivation(event) {
  if (!event) return true;
  if (typeof event.button === 'number' && event.button !== 0) return false;
  return !(event.metaKey || event.ctrlKey || event.shiftKey || event.altKey);
}

/** DOM id of a `ui:list` row title (the description of the row's `actions`). */
export function listItemTitleId(componentId, index) {
  const raw = typeof componentId === 'string' && componentId ? componentId : 'list';
  return `kbl-${raw.replace(/[^A-Za-z0-9_-]/g, '-')}-${index}-title`;
}

/**
 * Wire an item `action` (nav-rail / list item) onto its element: a click
 * (or Enter / Space on a button, Enter on a link) dispatches it; on a link
 * with an `href`, a plain click prevents the navigation, modified clicks
 * keep the browser behaviour.
 */
function bindItemAction(ctx, node, action, hasHref, source) {
  setData(node, 'action-id', action.id);
  node.addEventListener('click', (event) => {
    if (hasHref) {
      if (!isPlainActivation(event)) return;
      if (event && typeof event.preventDefault === 'function') event.preventDefault();
    }
    if (typeof ctx.onAction === 'function') ctx.onAction(action, source);
  });
}

/**
 * Bare `<svg>` for an icon name (no wrapper element); null for unknown names.
 * Callers that need a wrapper (e.g. `.kb-nav-rail__icon`) add it themselves.
 * Decorative (`aria-hidden`) unless `label` is given, which makes it an
 * `role="img"` with that accessible name.
 */
function icon(ctx, name, size, label) {
  const paths =
    typeof name === 'string' && Object.prototype.hasOwnProperty.call(KB_ICON_PATHS, name)
      ? KB_ICON_PATHS[name]
      : null;
  if (!paths) return null;
  const svg = ctx.doc.createElementNS(SVG_NS, 'svg');
  const dimension = String(size || 18);
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', dimension);
  svg.setAttribute('height', dimension);
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.8');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  if (label) {
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', str(label));
  } else {
    svg.setAttribute('aria-hidden', 'true');
  }
  svg.setAttribute('focusable', 'false');
  for (const d of paths) {
    const path = ctx.doc.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    svg.appendChild(path);
  }
  return svg;
}

/**
 * Render a `KbActionRef` / `ui:button` as `a.kb-btn` (href) or
 * `button.kb-btn` (action). Returns null when neither target is given.
 * An unsafe or disabled href keeps the visual as a non-navigating
 * `a[aria-disabled][role=link]` rather than disappearing.
 */
function actionButton(ctx, ref, defaultVariant, source) {
  if (!isRecord(ref)) return null;
  const label = str(ref.label ?? ref.text);
  if (!label) return null;
  const variant = ['primary', 'secondary', 'danger', 'ghost'].includes(ref.variant)
    ? ref.variant
    : defaultVariant;
  const className = `kb-btn kb-btn--${variant}`;
  const disabled = ref.disabled === true;
  const title = str(ref.title);
  const action = normalizeAction(ref.action);
  if (action) {
    const button = el(ctx, 'button', className, label);
    button.setAttribute('type', 'button');
    if (title) button.setAttribute('title', title);
    setData(button, 'action-id', action.id);
    if (disabled) button.disabled = true;
    button.addEventListener('click', () => {
      if (typeof ctx.onAction === 'function') ctx.onAction(action, source);
    });
    return button;
  }
  if (ref.href === undefined) return null;
  const href = safeHref(ref.href);
  const link = el(ctx, 'a', className, label);
  if (title) link.setAttribute('title', title);
  if (href && !disabled) {
    link.setAttribute('href', href);
    const target = ref.target === '_blank' || ref.target === '_self' ? ref.target : undefined;
    if (target) {
      link.setAttribute('target', target);
      if (target === '_blank') link.setAttribute('rel', 'noopener');
    }
    return link;
  }
  // Unsafe or disabled link: keep the visual, drop the navigation target.
  link.setAttribute('aria-disabled', 'true');
  link.setAttribute('role', 'link');
  link.setAttribute('aria-label', label);
  return link;
}

function appendActions(ctx, container, refs, defaultVariant, source) {
  if (!Array.isArray(refs)) return 0;
  let count = 0;
  for (const ref of refs) {
    const node = actionButton(ctx, ref, defaultVariant, source);
    if (node) {
      container.appendChild(node);
      count += 1;
    }
  }
  return count;
}

function statusPill(ctx, status, domain, label) {
  const pill = el(ctx, 'span', 'kb-status-pill');
  setData(pill, 'status', status);
  setData(pill, 'domain', domain);
  const glyph = el(ctx, 'span', 'kb-status-pill__icon');
  glyph.setAttribute('aria-hidden', 'true');
  pill.appendChild(glyph);
  pill.appendChild(
    el(ctx, 'span', 'kb-status-pill__label', statusLabel(status, domain, label, ctx.t))
  );
  return pill;
}

function isStatusValue(value) {
  return typeof value === 'string' && hasOwn(KB_STATUS_MESSAGE_KEYS, value);
}

function appendChildren(ctx, parent, component, depth) {
  const ids = Array.isArray(component.children) ? component.children : [];
  for (const id of ids) {
    const child = renderById(ctx, id, depth + 1);
    if (child) parent.appendChild(child);
  }
}

function renderById(ctx, id, depth) {
  if (typeof id !== 'string' || !ctx.lookup || depth > MAX_DEPTH) return null;
  if (ctx.visiting.has(id)) return null; // cycle guard
  const component = ctx.lookup.get(id);
  if (!component) return null;
  ctx.visiting.add(id);
  try {
    return renderWithDepth(component, ctx, depth);
  } finally {
    ctx.visiting.delete(id);
  }
}

// ---------------------------------------------------------------------------
// Per-type renderers: (ctx, props, component, depth) => Element | null
// ---------------------------------------------------------------------------

const RENDERERS = {
  'ui:app-shell'(ctx, p, c, depth) {
    const root = el(ctx, 'div', 'kb-app-shell');
    if (p.density === 'comfortable' || p.density === 'compact') setData(root, 'density', p.density);
    if (p.theme === 'light' || p.theme === 'dark') setData(root, 'theme', p.theme);
    setData(root, 'role', p.role);
    let nav = null;
    const main = el(ctx, 'main', 'kb-app-shell__main');
    const ids = Array.isArray(c.children) ? c.children : [];
    for (const id of ids) {
      const child = ctx.lookup && ctx.lookup.get(id);
      const node = renderById(ctx, id, depth + 1);
      if (!node) continue;
      if (child && resolveType(child.type) === 'ui:nav-rail' && !nav) {
        nav = el(ctx, 'div', 'kb-app-shell__nav');
        nav.appendChild(node);
      } else {
        main.appendChild(node);
      }
    }
    if (nav) root.appendChild(nav);
    root.appendChild(main);
    return root;
  },

  'ui:page-header'(ctx, p, c) {
    const root = el(ctx, 'header', 'kb-page-header');
    const titles = el(ctx, 'div', 'kb-page-header__titles');
    const title = el(ctx, 'h1', 'kb-page-header__title');
    title.appendChild(ctx.doc.createTextNode(str(p.title)));
    if (isRecord(p.role_badge) && p.role_badge.label) {
      title.appendChild(badge(ctx, p.role_badge));
    }
    titles.appendChild(title);
    if (p.subtitle) titles.appendChild(el(ctx, 'p', 'kb-page-header__subtitle', p.subtitle));
    root.appendChild(titles);
    const actions = el(ctx, 'div', 'kb-page-header__actions');
    if (appendActions(ctx, actions, p.actions, 'secondary', c) > 0) root.appendChild(actions);
    return root;
  },

  'ui:nav-rail'(ctx, p, c) {
    const root = el(ctx, 'nav', 'kb-nav-rail');
    root.setAttribute('aria-label', str(p.label) || ctx.t(KB_UI_MESSAGE_KEYS.navLabel));
    const brand = navBrand(ctx, p.brand);
    if (brand) root.appendChild(brand);
    const context = navContext(ctx, p.context, c);
    if (context) root.appendChild(context);
    const list = navList(ctx, p.items, c);
    if (list) root.appendChild(list);
    const footerList = navList(ctx, p.footer_items, c);
    if (footerList) {
      const footer = el(ctx, 'div', 'kb-nav-rail__footer');
      footer.appendChild(footerList);
      root.appendChild(footer);
    }
    return root;
  },

  'ui:tabs'(ctx, p, c) {
    const items = Array.isArray(p.items) ? p.items.filter(isRecord) : [];
    const asLinks = items.some((item) => typeof item.href === 'string');
    const root = el(ctx, asLinks ? 'nav' : 'div', 'kb-tabs');
    setData(root, 'overflow', p.overflow === 'menu' ? 'menu' : 'wrap');
    setData(root, 'variant', tabsVariant(p.variant));
    if (!asLinks) root.setAttribute('role', 'tablist');
    root.setAttribute('aria-label', str(p.label) || ctx.t(KB_UI_MESSAGE_KEYS.tabsLabel));
    for (const item of items) {
      const active = p.active !== undefined && item.id === p.active;
      let tab;
      if (asLinks) {
        const href = safeHref(item.href);
        if (href) {
          tab = el(ctx, 'a', 'kb-tabs__tab');
          tab.setAttribute('href', href);
        } else {
          tab = el(ctx, 'span', 'kb-tabs__tab');
          tab.setAttribute('aria-disabled', 'true');
        }
        if (active) tab.setAttribute('aria-current', 'page');
      } else {
        tab = el(ctx, 'button', 'kb-tabs__tab');
        tab.setAttribute('type', 'button');
        tab.setAttribute('role', 'tab');
        tab.setAttribute('aria-selected', active ? 'true' : 'false');
        tab.addEventListener('click', () => {
          if (typeof ctx.onAction === 'function') {
            ctx.onAction({ id: 'tabs.select', payload: { tab: str(item.id) } }, c);
          }
        });
      }
      setData(tab, 'tab-id', item.id);
      tab.appendChild(ctx.doc.createTextNode(str(item.label)));
      if (typeof item.count === 'number')
        tab.appendChild(el(ctx, 'span', 'kb-tabs__count', item.count));
      root.appendChild(tab);
    }
    return root;
  },

  'ui:stack'(ctx, p, c, depth) {
    const root = el(ctx, 'div', 'kb-stack');
    setData(root, 'gap', p.gap);
    setData(root, 'direction', p.direction === 'horizontal' ? 'horizontal' : undefined);
    setData(root, 'align', p.align);
    if (p.wrap === true) setData(root, 'wrap', 'true');
    appendChildren(ctx, root, c, depth);
    return root;
  },

  'ui:grid'(ctx, p, c, depth) {
    const root = el(ctx, 'div', 'kb-grid');
    setData(root, 'gap', p.gap);
    if (Number.isInteger(p.columns) && p.columns >= 1 && p.columns <= 6)
      setData(root, 'columns', p.columns);
    setData(root, 'min-column-width', p.min_column_width);
    appendChildren(ctx, root, c, depth);
    return root;
  },

  'ui:section'(ctx, p, c, depth) {
    const root = el(ctx, 'section', 'kb-section');
    setData(root, 'tone', p.tone);
    const title = p.title ?? p.heading;
    const heading = el(ctx, 'div', 'kb-section__heading');
    if (title) heading.appendChild(el(ctx, 'h2', 'kb-section__title', title));
    if (p.description) heading.appendChild(el(ctx, 'p', 'kb-section__description', p.description));
    const actions = el(ctx, 'div', 'kb-section__actions');
    const actionCount = appendActions(ctx, actions, p.actions, 'secondary', c);
    if (heading.childNodes.length > 0 || actionCount > 0) {
      const header = el(ctx, 'header', 'kb-section__header');
      if (heading.childNodes.length > 0) header.appendChild(heading);
      if (actionCount > 0) header.appendChild(actions);
      root.appendChild(header);
    }
    appendChildren(ctx, root, c, depth);
    return root;
  },

  'ui:next-action'(ctx, p, c) {
    const state = p.state === 'loading' || p.state === 'empty' ? p.state : 'ready';
    const root = el(ctx, 'section', 'kb-next-action');
    setData(root, 'state', state);
    if (state === 'loading') root.setAttribute('aria-busy', 'true');
    const body = el(ctx, 'div', 'kb-next-action__body');
    if (p.eyebrow) body.appendChild(el(ctx, 'p', 'kb-next-action__eyebrow', p.eyebrow));
    body.appendChild(el(ctx, 'h2', 'kb-next-action__title', p.title));
    if (p.reason) body.appendChild(el(ctx, 'p', 'kb-next-action__reason', p.reason));
    root.appendChild(body);
    const actions = el(ctx, 'div', 'kb-next-action__actions');
    let count = 0;
    const primary = actionButton(ctx, p.primary, 'primary', c);
    if (primary) {
      actions.appendChild(primary);
      count += 1;
    }
    const secondary = actionButton(ctx, p.secondary, 'secondary', c);
    if (secondary) {
      actions.appendChild(secondary);
      count += 1;
    }
    if (count > 0) root.appendChild(actions);
    return root;
  },

  'ui:metric'(ctx, p) {
    const root = el(ctx, 'div', 'kb-metric');
    setData(root, 'tone', p.tone);
    const trendIcon = Object.prototype.hasOwnProperty.call(TREND_ICONS, p.trend)
      ? TREND_ICONS[p.trend]
      : undefined;
    setData(root, 'trend', trendIcon ? p.trend : undefined);
    root.appendChild(el(ctx, 'span', 'kb-metric__label', p.label));
    const value = el(ctx, 'span', 'kb-metric__value', p.value);
    if (p.unit) value.appendChild(el(ctx, 'span', 'kb-metric__unit', p.unit));
    root.appendChild(value);
    if (p.delta) {
      const delta = el(ctx, 'span', 'kb-metric__delta');
      const svg = trendIcon ? icon(ctx, trendIcon, 12, ctx.t(TREND_MESSAGE_KEYS[p.trend])) : null;
      if (svg) delta.appendChild(svg);
      delta.appendChild(ctx.doc.createTextNode(str(p.delta)));
      root.appendChild(delta);
    }
    if (p.description) root.appendChild(el(ctx, 'span', 'kb-metric__description', p.description));
    return root;
  },

  'ui:kv'(ctx, p) {
    const root = el(ctx, 'dl', 'kb-kv');
    for (const item of Array.isArray(p.items) ? p.items : []) {
      if (!isRecord(item)) continue;
      root.appendChild(el(ctx, 'dt', 'kb-kv__label', item.label));
      const value = el(ctx, 'dd', 'kb-kv__value', displayScalar(ctx, item.value));
      if (item.mono === true) setData(value, 'mono', 'true');
      root.appendChild(value);
    }
    return root;
  },

  'ui:table'(ctx, p) {
    const wrap = el(ctx, 'div', 'kb-table-wrap');
    const table = el(ctx, 'table', 'kb-table');
    if (p.caption) table.appendChild(el(ctx, 'caption', '', p.caption));
    const columns = (Array.isArray(p.columns) ? p.columns : []).filter(
      (col) => isRecord(col) && typeof col.key === 'string'
    );
    const thead = el(ctx, 'thead');
    const headRow = el(ctx, 'tr');
    for (const col of columns) {
      const th = el(ctx, 'th', '', col.label);
      th.setAttribute('scope', 'col');
      setData(th, 'align', col.align);
      if (typeof col.width === 'string' && WIDTH_PATTERN.test(col.width))
        th.style.width = col.width;
      headRow.appendChild(th);
    }
    thead.appendChild(headRow);
    table.appendChild(thead);
    const tbody = el(ctx, 'tbody');
    const rows = Array.isArray(p.rows) ? p.rows.filter(isRecord) : [];
    if (rows.length === 0) {
      const tr = el(ctx, 'tr');
      const td = el(ctx, 'td', 'kb-table__empty', p.empty || ctx.t(KB_UI_MESSAGE_KEYS.tableEmpty));
      td.setAttribute('colspan', String(Math.max(columns.length, 1)));
      tr.appendChild(td);
      tbody.appendChild(tr);
    }
    for (const row of rows) {
      const tr = el(ctx, 'tr');
      const href = p.row_href_key ? safeHref(row[p.row_href_key]) : null;
      if (href) {
        setData(tr, 'href', href);
        tr.tabIndex = 0;
        const go = () => {
          if (ctx.win && ctx.win.location) ctx.win.location.assign(href);
        };
        tr.addEventListener('click', (event) => {
          // Links / controls inside the row act on their own.
          if (isInteractiveTarget(event.target, tr)) return;
          go();
        });
        tr.addEventListener('keydown', (event) => {
          if (event.key === 'Enter' && event.target === tr) go();
        });
      }
      for (const col of columns) {
        const td = el(ctx, 'td');
        setData(td, 'align', col.align);
        if (col.mono === true) setData(td, 'mono', 'true');
        const value = row[col.key];
        const kind = tableCellKind(value);
        const isStatusColumn = col.key === 'status' || col.key.endsWith('_status');
        if (kind === 'title') {
          td.appendChild(tableTitleCell(ctx, value));
        } else if (kind === 'status') {
          td.appendChild(statusPill(ctx, value.status, value.domain, value.label));
        } else if (kind === 'badge') {
          td.appendChild(badge(ctx, { label: value.badge, tone: value.tone }));
        } else if (isStatusColumn && isStatusValue(value)) {
          // Convention: a `status` / `*_status` column holding a canonical
          // status value renders as a status pill (icon + text).
          td.appendChild(statusPill(ctx, value));
        } else {
          const text = displayScalar(ctx, value);
          td.textContent = text;
          // Mono columns (ids, hashes) never wrap mid-token (see the source
          // CSS); the title gives the full value back when the column stays
          // narrower than it.
          if (col.mono === true && text) td.title = text;
        }
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    wrap.appendChild(table);
    return wrap;
  },

  'ui:list'(ctx, p, c) {
    const root = el(ctx, 'ul', 'kb-list');
    setData(root, 'variant', p.variant === 'timeline' ? 'timeline' : 'plain');
    (Array.isArray(p.items) ? p.items : []).forEach((item, index) => {
      if (!isRecord(item)) return;
      const li = el(ctx, 'li', 'kb-list__item');
      setData(li, 'status', item.status);
      const body = el(ctx, 'div', 'kb-list__body');
      const href = safeHref(item.href);
      const action = normalizeAction(item.action);
      const title = el(ctx, href ? 'a' : action ? 'button' : 'span', 'kb-list__title', item.title);
      if (href) title.setAttribute('href', href);
      else if (action) title.setAttribute('type', 'button');
      if (action) bindItemAction(ctx, title, action, Boolean(href), c);
      body.appendChild(title);
      if (item.meta) body.appendChild(el(ctx, 'span', 'kb-list__meta', item.meta));
      const progress = listProgress(ctx, item.progress);
      if (progress) body.appendChild(progress);
      li.appendChild(body);
      if (isStatusValue(item.status))
        li.appendChild(statusPill(ctx, item.status, undefined, item.status_label));
      const actions = el(ctx, 'div', 'kb-list__actions');
      if (appendActions(ctx, actions, item.actions, 'ghost', c) > 0) {
        // Row actions ("Delete") are described by their row's title.
        const titleId = listItemTitleId(c && c.id, index);
        title.setAttribute('id', titleId);
        for (const child of actions.children || []) {
          if (String(child.tagName).toUpperCase() === 'BUTTON') {
            child.setAttribute('aria-describedby', titleId);
          }
        }
        li.appendChild(actions);
      }
      root.appendChild(li);
    });
    return root;
  },

  'ui:text'(ctx, p) {
    const variant = ['body', 'muted', 'caption', 'mono', 'title'].includes(p.variant)
      ? p.variant
      : 'body';
    return el(ctx, 'p', `kb-text kb-text--${variant}`, p.text ?? p.value ?? p.content ?? p.label);
  },

  'ui:code'(ctx, p) {
    const root = el(ctx, 'figure', 'kb-code');
    const language = codeLanguage(p.language);
    setData(root, 'language', language);
    if (p.title || language) {
      const header = el(ctx, 'figcaption', 'kb-code__header');
      if (p.title) header.appendChild(el(ctx, 'span', 'kb-code__title', p.title));
      if (language) header.appendChild(el(ctx, 'span', 'kb-code__language', language));
      root.appendChild(header);
    }
    const pre = el(ctx, 'pre', 'kb-code__body');
    pre.appendChild(el(ctx, 'code', '', typeof p.code === 'string' ? p.code : ''));
    root.appendChild(pre);
    return root;
  },

  'ui:status-pill'(ctx, p) {
    return statusPill(ctx, str(p.status), p.domain, p.label);
  },

  'ui:badge'(ctx, p) {
    return badge(ctx, p);
  },

  'ui:callout'(ctx, p, c) {
    const tone = ['info', 'success', 'warning', 'danger'].includes(p.tone) ? p.tone : 'info';
    const root = el(ctx, 'div', 'kb-callout');
    setData(root, 'tone', tone);
    root.setAttribute('role', tone === 'danger' ? 'alert' : 'note');
    const glyph = el(ctx, 'span', 'kb-callout__icon');
    glyph.setAttribute('aria-hidden', 'true');
    root.appendChild(glyph);
    const content = el(ctx, 'div', 'kb-callout__content');
    content.appendChild(el(ctx, 'p', 'kb-callout__title', p.title));
    if (p.body) content.appendChild(el(ctx, 'p', 'kb-callout__body', p.body));
    const action = actionButton(ctx, p.action, 'secondary', c);
    if (action) {
      const holder = el(ctx, 'div', 'kb-callout__action');
      holder.appendChild(action);
      content.appendChild(holder);
    }
    root.appendChild(content);
    return root;
  },

  'ui:empty-state'(ctx, p, c) {
    const root = el(ctx, 'div', 'kb-empty-state');
    root.appendChild(el(ctx, 'p', 'kb-empty-state__title', p.title));
    if (p.body) root.appendChild(el(ctx, 'p', 'kb-empty-state__body', p.body));
    const action = actionButton(ctx, p.action, 'primary', c);
    if (action) {
      const holder = el(ctx, 'div', 'kb-empty-state__action');
      holder.appendChild(action);
      root.appendChild(holder);
    }
    return root;
  },

  'ui:skeleton'(ctx, p) {
    const shape = p.shape === 'card' || p.shape === 'table' ? p.shape : 'text';
    const root = el(ctx, 'div', 'kb-skeleton');
    setData(root, 'shape', shape);
    root.setAttribute('role', 'status');
    root.setAttribute('aria-busy', 'true');
    root.setAttribute('aria-label', ctx.t(KB_UI_MESSAGE_KEYS.skeletonLoading));
    const lines = Number.isInteger(p.lines) ? Math.min(Math.max(p.lines, 1), 12) : 3;
    for (let index = 0; index < lines; index += 1) {
      const line = el(ctx, 'span', 'kb-skeleton__line');
      line.setAttribute('aria-hidden', 'true');
      root.appendChild(line);
    }
    return root;
  },

  'ui:button'(ctx, p, c) {
    return actionButton(ctx, p, 'secondary', c);
  },

  'ui:disclosure'(ctx, p, c, depth) {
    const root = el(ctx, 'details', 'kb-disclosure');
    if (p.open === true) root.open = true;
    root.appendChild(
      el(ctx, 'summary', '', p.summary || ctx.t(KB_UI_MESSAGE_KEYS.disclosureSummary))
    );
    const body = el(ctx, 'div', 'kb-disclosure__body');
    appendChildren(ctx, body, c, depth);
    root.appendChild(body);
    return root;
  },

  'ui:display-controls'(ctx, p, c) {
    const root = el(ctx, 'div', 'kb-display-controls');
    root.setAttribute('role', 'group');
    root.setAttribute('aria-label', ctx.t(KB_UI_MESSAGE_KEYS.displayLabel));
    // The inner segmented / select report `field.change`; re-emit it as the
    // display action (payload `{ value }`) so hosts need no field names.
    const inner = Object.assign({}, ctx, {
      onAction(action) {
        const payload = action && isRecord(action.payload) ? action.payload : null;
        if (!payload || typeof ctx.onAction !== 'function') return;
        const id =
          payload.name === 'theme'
            ? KB_DISPLAY_CONTROLS_ACTIONS.theme
            : payload.name === 'locale'
              ? KB_DISPLAY_CONTROLS_ACTIONS.locale
              : null;
        if (id) ctx.onAction({ id, payload: { value: payload.value } }, c);
      },
    });
    const baseId = typeof c.id === 'string' && c.id ? c.id : 'display-controls';
    const themeProps = displayThemeProps(ctx, p);
    const localeProps = displayLocaleProps(ctx, p);
    root.appendChild(
      RENDERERS['ui:segmented'](inner, themeProps, {
        id: `${baseId}-theme`,
        type: 'ui:segmented',
        props: themeProps,
      })
    );
    root.appendChild(
      RENDERERS['ui:select'](inner, localeProps, {
        id: `${baseId}-locale`,
        type: 'ui:select',
        props: localeProps,
      })
    );
    return root;
  },
};

/**
 * `ui:display-controls` → the inner `ui:segmented` props (theme). Shared
 * with the React renderer so both build the same control.
 */
export function displayThemeProps(ctx, p) {
  const t = typeof ctx === 'function' ? ctx : ctx.t;
  const value = DISPLAY_THEMES.some(([theme]) => theme === p.theme) ? p.theme : 'system';
  return {
    name: 'theme',
    label: t(KB_UI_MESSAGE_KEYS.displayTheme),
    hide_label: true,
    value,
    options: DISPLAY_THEMES.map(([theme, key]) => ({
      value: theme,
      label: t(KB_UI_MESSAGE_KEYS[key]),
    })),
  };
}

/**
 * A language's own name (endonym: "English", the Japanese name in Japanese,
 * ...) independent of the UI locale, from `Intl.DisplayNames` in that
 * language; `fallback` (the vocabulary label) when the runtime lacks it.
 */
export function localeEndonym(code, fallback) {
  try {
    if (typeof Intl !== 'undefined' && typeof Intl.DisplayNames === 'function') {
      const name = new Intl.DisplayNames([code], { type: 'language' }).of(code);
      if (typeof name === 'string' && name && name !== code) {
        return name.charAt(0).toLocaleUpperCase(code) + name.slice(1);
      }
    }
  } catch {
    // unsupported locale / runtime: use the vocabulary label
  }
  return fallback;
}

/** `ui:display-controls` → the inner `ui:select` props (language). */
export function displayLocaleProps(ctx, p) {
  const t = typeof ctx === 'function' ? ctx : ctx.t;
  const given = Array.isArray(p.locales)
    ? p.locales.filter(
        (option) =>
          isRecord(option) &&
          typeof option.value === 'string' &&
          LOCALE_TAG.test(option.value) &&
          typeof option.label === 'string' &&
          option.label
      )
    : [];
  const options = given.length
    ? given.map((option) => ({ value: option.value, label: option.label }))
    : [
        { value: 'ja', label: localeEndonym('ja', t(KB_UI_MESSAGE_KEYS.localeNameJa)) },
        { value: 'en', label: localeEndonym('en', t(KB_UI_MESSAGE_KEYS.localeNameEn)) },
      ];
  return {
    name: 'locale',
    label: t(KB_UI_MESSAGE_KEYS.displayLanguage),
    hide_label: true,
    value: typeof p.locale === 'string' ? p.locale : undefined,
    options,
  };
}

/** `ui:code` language hint: a short token (`shell`, `c++`, `json`); null otherwise. */
export function codeLanguage(value) {
  return typeof value === 'string' && /^[A-Za-z0-9+#._-]{1,40}$/.test(value) ? value : null;
}

/** Clamp a `ui:list` item's `progress` to an integer 0–100; null when absent / not finite. */
export function listProgressPercent(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.round(Math.min(100, Math.max(0, value)));
}

/** `ui:nav-rail` brand logo: same-origin paths and http(s) images only. */
export function navBrandLogo(value) {
  const href = safeHref(value);
  if (!href) return null;
  const scheme = SCHEME_PREFIX.exec(href.toLowerCase());
  return scheme && scheme[1] !== 'http' && scheme[1] !== 'https' ? null : href;
}

/** Options of a `ui:nav-rail` context switcher (valid entries only). */
export function navContextOptions(context) {
  return Array.isArray(context.options)
    ? context.options.filter(
        (option) =>
          isRecord(option) &&
          typeof option.value === 'string' &&
          option.value &&
          typeof option.label === 'string'
      )
    : [];
}

/** Payload a context-switch option dispatches: the declared payload plus `{ value }`. */
export function navContextPayload(action, value) {
  return Object.assign({}, isRecord(action.payload) ? action.payload : {}, { value });
}

// UI-01b: chart / visualisation types — `charts.js` lays out a vnode tree,
// built here with createElement / createElementNS (never innerHTML).
const SVG_TAGS = new Set(['svg', 'g', 'path', 'line', 'rect', 'circle', 'text', 'tspan', 'title']);

function buildVNode(ctx, node, inSvg) {
  if (!node) return null;
  if (typeof node.text === 'string') return ctx.doc.createTextNode(node.text);
  const svg = inSvg || node.tag === 'svg';
  const element =
    svg && SVG_TAGS.has(node.tag)
      ? ctx.doc.createElementNS(SVG_NS, node.tag)
      : ctx.doc.createElement(node.tag);
  for (const [name, value] of Object.entries(node.attrs || {})) element.setAttribute(name, value);
  for (const child of node.children || []) {
    const built = buildVNode(ctx, child, svg);
    if (built) element.appendChild(built);
  }
  return element;
}

// UI-01c settings & forms (catalog order: base types → forms → charts).
Object.assign(
  RENDERERS,
  createFormRenderers({
    el,
    setData,
    actionButton,
    statusPill,
    appendChildren,
    safeHref,
    iconPaths: KB_ICON_PATHS,
  })
);

for (const type of KB_CHART_TYPES) {
  RENDERERS[type] = (ctx, p) =>
    buildVNode(
      ctx,
      layoutChart(type, p, {
        t: ctx.t,
        locale: ctx.locale,
        statusLabel: (status) => statusLabel(status, undefined, undefined, ctx.t),
      }),
      false
    );
}

// PA-02 voice (ui:voice-input / ui:voice-state): renderers + controller live in ./voice.js.
Object.assign(RENDERERS, createVoiceRenderers({ el, setData }));

// PA-01 pads (ui:toolbar / ui:dialog / ui:drawing-palette / ui:sketch-board): ./pads.js.
Object.assign(RENDERERS, createPadRenderers({ el, setData, safeHref, appendChildren }));

/**
 * `ui:table` rich cell kind: `title` ({title, id?, href?}), `status`
 * ({status, label?, domain?} with a canonical status), `badge`
 * ({badge, tone?}); anything else is a `scalar` (shown via displayScalar).
 * Shared with the React `Table`.
 */
export function tableCellKind(value) {
  if (!isRecord(value)) return 'scalar';
  if (typeof value.title === 'string' && value.title) return 'title';
  if (isStatusValue(value.status)) return 'status';
  if (typeof value.badge === 'string' && value.badge) return 'badge';
  return 'scalar';
}

/** `.kb-table__cell` > `a|span.kb-table__title` + optional `span.kb-table__id` (mono). */
function tableTitleCell(ctx, value) {
  const root = el(ctx, 'span', 'kb-table__cell');
  const href = safeHref(value.href);
  const title = el(ctx, href ? 'a' : 'span', 'kb-table__title', value.title);
  if (href) title.setAttribute('href', href);
  root.appendChild(title);
  if (typeof value.id === 'string' && value.id) {
    root.appendChild(el(ctx, 'span', 'kb-table__id', value.id));
  }
  return root;
}

const INTERACTIVE_SELECTOR = 'a, button, input, select, textarea, label, summary, form';

/** True when a row click started on a link / control inside the row. */
export function isInteractiveTarget(target, row) {
  let node = target;
  while (node && node !== row) {
    if (typeof node.matches === 'function' && node.matches(INTERACTIVE_SELECTOR)) return true;
    node = node.parentNode;
  }
  return false;
}

/** `ui:tabs` variant attribute: `secondary` (pill sub-navigation) or nothing (primary). */
export function tabsVariant(value) {
  return value === 'secondary' ? 'secondary' : undefined;
}

function badge(ctx, p) {
  const node = el(ctx, 'span', 'kb-badge', p.label);
  setData(node, 'tone', p.tone);
  setData(node, 'role', p.role);
  return node;
}

function navBrand(ctx, brand) {
  if (!isRecord(brand) || typeof brand.name !== 'string' || !brand.name) return null;
  const root = el(ctx, 'div', 'kb-nav-rail__brand');
  const logo = navBrandLogo(brand.logo_url);
  if (logo) {
    const img = el(ctx, 'img', 'kb-nav-rail__brand-logo');
    img.setAttribute('src', logo);
    img.setAttribute('alt', '');
    root.appendChild(img);
  } else {
    const mark = el(ctx, 'span', 'kb-nav-rail__brand-mark');
    mark.setAttribute('aria-hidden', 'true');
    root.appendChild(mark);
  }
  const text = el(ctx, 'span', 'kb-nav-rail__brand-text');
  text.appendChild(el(ctx, 'strong', 'kb-nav-rail__brand-name', brand.name));
  if (brand.subtitle)
    text.appendChild(el(ctx, 'span', 'kb-nav-rail__brand-subtitle', brand.subtitle));
  root.appendChild(text);
  return root;
}

function navContextBody(ctx, node, context, hiddenLabel) {
  if (hiddenLabel) node.appendChild(el(ctx, 'span', 'kb-visually-hidden', hiddenLabel));
  node.appendChild(el(ctx, 'span', 'kb-nav-rail__context-label', context.label));
  if (context.detail)
    node.appendChild(el(ctx, 'span', 'kb-nav-rail__context-detail', context.detail));
  return node;
}

/**
 * `ui:nav-rail` context block. options + action → a button that opens an
 * option list (choosing dispatches `action` with `{ value }`); action alone
 * → a button; href alone → a link; otherwise static text.
 */
function navContext(ctx, context, source) {
  if (!isRecord(context) || typeof context.label !== 'string' || !context.label) return null;
  const root = el(ctx, 'div', 'kb-nav-rail__context');
  const action = normalizeAction(context.action);
  const options = navContextOptions(context);
  const switchLabel = str(context.switch_label) || ctx.t(KB_UI_MESSAGE_KEYS.navContextSwitch);
  const dispatch = (next) => {
    if (typeof ctx.onAction === 'function') ctx.onAction(next, source);
  };
  if (action && options.length > 0) {
    const button = navContextBody(
      ctx,
      el(ctx, 'button', 'kb-nav-rail__context-button'),
      context,
      switchLabel
    );
    button.setAttribute('type', 'button');
    button.setAttribute('aria-haspopup', 'listbox');
    button.setAttribute('aria-expanded', 'false');
    const menu = el(ctx, 'ul', 'kb-nav-rail__context-menu');
    menu.setAttribute('role', 'listbox');
    menu.setAttribute('aria-label', switchLabel);
    menu.hidden = true;
    // A pointer press outside the block closes the open list (like Escape).
    const doc = ctx.doc;
    const onOutside = (event) => {
      if (typeof root.contains === 'function' && root.contains(event.target)) return;
      setOpen(false);
    };
    const canListen = doc && typeof doc.addEventListener === 'function';
    const setOpen = (open) => {
      button.setAttribute('aria-expanded', open ? 'true' : 'false');
      menu.hidden = !open;
      if (!canListen) return;
      if (open) doc.addEventListener('pointerdown', onOutside);
      else doc.removeEventListener('pointerdown', onOutside);
    };
    if (canListen && Array.isArray(ctx.cleanups)) {
      ctx.cleanups.push(() => doc.removeEventListener('pointerdown', onOutside));
    }
    for (const option of options) {
      const li = el(ctx, 'li');
      li.setAttribute('role', 'presentation');
      const item = el(ctx, 'button', 'kb-nav-rail__context-option', option.label);
      item.setAttribute('type', 'button');
      item.setAttribute('role', 'option');
      item.setAttribute('aria-selected', option.selected === true ? 'true' : 'false');
      setData(item, 'value', option.value);
      item.addEventListener('click', () => {
        setOpen(false);
        dispatch({ id: action.id, payload: navContextPayload(action, option.value) });
      });
      li.appendChild(item);
      menu.appendChild(li);
    }
    button.addEventListener('click', () => setOpen(menu.hidden === true));
    root.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && menu.hidden !== true) {
        setOpen(false);
        if (typeof button.focus === 'function') button.focus();
      }
    });
    root.appendChild(button);
    root.appendChild(menu);
    return root;
  }
  if (action) {
    const button = navContextBody(
      ctx,
      el(ctx, 'button', 'kb-nav-rail__context-button'),
      context,
      switchLabel
    );
    button.setAttribute('type', 'button');
    setData(button, 'action-id', action.id);
    button.addEventListener('click', () => dispatch(action));
    root.appendChild(button);
    return root;
  }
  const href = safeHref(context.href);
  if (href) {
    const link = navContextBody(
      ctx,
      el(ctx, 'a', 'kb-nav-rail__context-button'),
      context,
      switchLabel
    );
    link.setAttribute('href', href);
    root.appendChild(link);
    return root;
  }
  const text = navContextBody(ctx, el(ctx, 'div', 'kb-nav-rail__context-button'), context);
  setData(text, 'static', 'true');
  root.appendChild(text);
  return root;
}

function listProgress(ctx, value) {
  const percent = listProgressPercent(value);
  if (percent === null) return null;
  const root = el(ctx, 'div', 'kb-list__progress');
  const track = el(ctx, 'span', 'kb-list__progress-track');
  track.setAttribute('role', 'progressbar');
  track.setAttribute('aria-label', ctx.t(KB_UI_MESSAGE_KEYS.listProgress));
  track.setAttribute('aria-valuemin', '0');
  track.setAttribute('aria-valuemax', '100');
  track.setAttribute('aria-valuenow', String(percent));
  track.setAttribute('aria-valuetext', ctx.t(KB_UI_MESSAGE_KEYS.listProgressValue, { percent }));
  const fill = el(ctx, 'span', 'kb-list__progress-fill');
  fill.style.width = `${percent}%`;
  track.appendChild(fill);
  root.appendChild(track);
  const text = el(ctx, 'span', 'kb-list__progress-value', `${percent}%`);
  text.setAttribute('aria-hidden', 'true');
  root.appendChild(text);
  return root;
}

function navList(ctx, items, source) {
  if (!Array.isArray(items) || items.length === 0) return null;
  const list = el(ctx, 'ul', 'kb-nav-rail__list');
  for (const item of items) {
    if (!isRecord(item)) continue;
    const li = el(ctx, 'li');
    const href = safeHref(item.href);
    const action = normalizeAction(item.action);
    // A safe href is a real link; an action alone is a button; otherwise a
    // non-interactive span (never an `<a>` without a navigable target).
    const link = el(ctx, href ? 'a' : action ? 'button' : 'span', 'kb-nav-rail__item');
    if (href) link.setAttribute('href', href);
    else if (action) link.setAttribute('type', 'button');
    if (action) bindItemAction(ctx, link, action, Boolean(href), source);
    setData(link, 'nav-id', item.id);
    if (item.active === true) {
      link.setAttribute('aria-current', 'page');
      setData(link, 'active', 'true');
    }
    const svg = icon(ctx, item.icon);
    if (svg) {
      const wrap = el(ctx, 'span', 'kb-nav-rail__icon');
      wrap.setAttribute('aria-hidden', 'true');
      wrap.appendChild(svg);
      link.appendChild(wrap);
    }
    const text = el(ctx, 'span', 'kb-nav-rail__text');
    text.appendChild(el(ctx, 'span', 'kb-nav-rail__label', item.label));
    if (item.hint) text.appendChild(el(ctx, 'span', 'kb-nav-rail__hint', item.hint));
    link.appendChild(text);
    li.appendChild(link);
    list.appendChild(li);
  }
  return list;
}

function displayScalar(ctx, value) {
  if (value === null || value === undefined || value === '') return '—';
  if (value === true) return ctx.t(KB_UI_MESSAGE_KEYS.valueYes);
  if (value === false) return ctx.t(KB_UI_MESSAGE_KEYS.valueNo);
  return str(value);
}

function debugWarning(ctx, type) {
  const root = el(ctx, 'div', 'kb-callout');
  setData(root, 'tone', 'warning');
  root.setAttribute('role', 'note');
  setData(root, 'unknown-type', type);
  const glyph = el(ctx, 'span', 'kb-callout__icon');
  glyph.setAttribute('aria-hidden', 'true');
  root.appendChild(glyph);
  const content = el(ctx, 'div', 'kb-callout__content');
  content.appendChild(
    el(
      ctx,
      'p',
      'kb-callout__title',
      ctx.t(KB_UI_MESSAGE_KEYS.unknownComponent, { type: str(type) })
    )
  );
  root.appendChild(content);
  return root;
}

function renderWithDepth(component, ctx, depth) {
  if (!isRecord(component)) return null;
  const type = resolveType(component.type);
  if (!type) return ctx.debug ? debugWarning(ctx, component.type) : null;
  const props = isRecord(component.props) ? component.props : {};
  return RENDERERS[type](ctx, props, component, depth);
}

function makeContext(options, doc, components) {
  const lookup = new Map();
  for (const component of Array.isArray(components) ? components : []) {
    if (isRecord(component) && typeof component.id === 'string')
      lookup.set(component.id, component);
  }
  return {
    doc,
    win: options.window ?? (typeof window !== 'undefined' ? window : undefined),
    onAction: options.onAction,
    debug: options.debug === true,
    locale:
      typeof options.locale === 'string' && options.locale ? options.locale : KB_UI_DEFAULT_LOCALE,
    t: createTranslator(options),
    lookup: options.lookup instanceof Map ? options.lookup : lookup,
    visiting: new Set(),
    // UI-01c: disposers (camera streams, object URLs) run on the next render / disposeA2UI.
    cleanups: [],
  };
}

function resolveDocument(options, container) {
  if (options && options.document) return options.document;
  if (container && container.ownerDocument) return container.ownerDocument;
  if (typeof document !== 'undefined') return document;
  throw new Error('kyberion-ui: no document available');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * @typedef {{ id: string, payload?: Record<string, unknown> }} KbAction
 * @typedef {{ id: string, type: string, props?: Record<string, unknown>, children?: string[] }} A2UIComponent
 * @typedef {{
 *   onAction?: (action: KbAction, component: A2UIComponent) => void,
 *   debug?: boolean,
 *   document?: Document,
 *   window?: Window,
 *   lookup?: Map<string, A2UIComponent>,
 *   locale?: string,
 *   messages?: Record<string, string>,
 *   t?: (key: string, params?: Record<string, unknown>) => string,
 * }} RenderOptions
 */

/**
 * Render one component (and, through `options.lookup`, its children) to a
 * DOM element. Returns null for unknown types (a warning callout when
 * `debug: true`).
 * @param {A2UIComponent} component
 * @param {RenderOptions} [options]
 * @returns {Element | null}
 */
export function renderComponent(component, options = {}) {
  const ctx = makeContext(options, resolveDocument(options, null), []);
  return renderWithDepth(component, ctx, 0);
}

/**
 * Replace `container`'s content with the rendered A2UI component list. The
 * list is flat (children reference ids). With `rootId`, only that subtree is
 * rendered; otherwise every component no other component references, in
 * list order.
 * @param {Element} container
 * @param {A2UIComponent[]} components
 * @param {RenderOptions & { rootId?: string }} [options]
 * @returns {Element}
 */
export function renderA2UI(container, components, options = {}) {
  const ctx = makeContext(options, resolveDocument(options, container), components);
  // The render target: components that track focus (ui:dialog) read the
  // focused element from its root node (a shadow root when rendered into one).
  ctx.container = container;
  const list = Array.isArray(components) ? components.filter(isRecord) : [];
  let roots;
  if (typeof options.rootId === 'string') {
    roots = [options.rootId];
  } else {
    const referenced = new Set();
    for (const component of list) {
      if (Array.isArray(component.children))
        for (const id of component.children) referenced.add(id);
    }
    roots = list
      .filter((component) => !referenced.has(component.id))
      .map((component) => component.id);
  }
  const fragment = ctx.doc.createDocumentFragment();
  for (const id of roots) {
    const node = renderById(ctx, id, 0);
    if (node) fragment.appendChild(node);
  }
  disposeA2UI(container);
  while (container.firstChild) container.removeChild(container.firstChild);
  container.appendChild(fragment);
  if (ctx.cleanups.length > 0) RENDER_CLEANUPS.set(container, ctx.cleanups);
  return container;
}

const RENDER_CLEANUPS = new WeakMap();

/**
 * UI-01c: release what the last `renderA2UI` into `container` holds (stop
 * camera tracks, revoke object URLs). Runs automatically before a re-render;
 * call it when removing the container. Never throws.
 * @param {Element} container
 */
export function disposeA2UI(container) {
  const cleanups = container ? RENDER_CLEANUPS.get(container) : undefined;
  if (!cleanups) return;
  RENDER_CLEANUPS.delete(container);
  for (const cleanup of cleanups) {
    try {
      cleanup();
    } catch {
      // best effort
    }
  }
}

export const KB_RENDERED_TYPES = Object.freeze(Object.keys(RENDERERS));
