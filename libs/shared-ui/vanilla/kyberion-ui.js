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

// ---------------------------------------------------------------------------
// Vocabulary (single place)
// ---------------------------------------------------------------------------

/**
 * Default Japanese label for each canonical status (a2ui-catalog.ts
 * KB_STATUS_VALUES). Values follow `status:*` in
 * knowledge/product/orchestration/user-facing-vocabulary.json; statuses the
 * vocabulary names differently per domain get a domain override below.
 * @type {Readonly<Record<string, string>>}
 */
export const KB_STATUS_LABELS_JA = Object.freeze({
  active: '進行中',
  archived: '保管済み',
  available: '利用可能',
  blocked: '要対応',
  busy: '処理中',
  completed: '完了',
  connected: '接続済み',
  connecting: '接続中',
  degraded: '品質低下',
  disconnected: '未接続',
  distilling: '学習整理中',
  done: '完了',
  error: 'エラー',
  failed: '失敗',
  fallback: '代替',
  fully_automatable: 'そのまま実行可能',
  missing: '未設定',
  missing_runtime_prerequisites: '実行環境が不足',
  'n/a': '不要',
  needs_assets: '外部素材が必要',
  needs_clarification: '追加確認が必要',
  needs_external_assets: '外部素材が必要',
  needs_runtime_prerequisites: '実行環境が不足',
  needs_setup: '設定が必要',
  offline: '未接続',
  paused: '一時停止',
  pending: '確認待ち',
  planned: '予定',
  ready: '準備完了',
  recovered: '復旧',
  review: 'レビュー',
  running: '稼働中',
  stale: '応答遅延',
  stopped: '停止',
  unavailable: '利用不可',
  working: '処理中',
});

/**
 * Domain-specific wording (`ui:status-pill.domain`), where the vocabulary
 * catalog words a status differently from the default above.
 * @type {Readonly<Record<string, Readonly<Record<string, string>>>>}
 */
export const KB_STATUS_DOMAIN_LABELS_JA = Object.freeze({
  readiness: Object.freeze({ ready: 'そのまま実行可能' }),
  connection: Object.freeze({
    ready: '接続済み',
    degraded: '接続品質が低下',
    offline: '未接続',
  }),
  provider: Object.freeze({ ready: '利用可能', missing: '未導入', unavailable: 'エラー' }),
  mission: Object.freeze({ blocked: '停止中', done: '完了' }),
  progress: Object.freeze({}),
  runtime: Object.freeze({}),
});

/** Resolve the visible label of a status pill. */
export function statusLabel(status, domain, label) {
  if (typeof label === 'string' && label.trim()) return label;
  const byDomain = domain && KB_STATUS_DOMAIN_LABELS_JA[domain];
  if (byDomain && Object.prototype.hasOwnProperty.call(byDomain, status)) return byDomain[status];
  if (Object.prototype.hasOwnProperty.call(KB_STATUS_LABELS_JA, status)) {
    return KB_STATUS_LABELS_JA[status];
  }
  return String(status ?? '');
}

/** Legacy protocol types rendered as catalog components (a2ui-catalog.ts KYBERION_BASE_ALIASES). */
export const KB_ALIASES = Object.freeze({
  text: 'ui:text',
  button: 'ui:button',
  card: 'ui:section',
  container: 'ui:stack',
});

/**
 * 24x24 stroke icons for `ui:nav-rail` items (`icon` prop). Unknown names
 * render no icon. Path data only, so the React renderer can import it.
 * @type {Readonly<Record<string, readonly string[]>>}
 */
export const KB_ICON_PATHS = Object.freeze({
  home: ['M3 11l9-7 9 7', 'M5 10v10h14V10', 'M10 20v-6h4v6'],
  inbox: ['M3 13h5l2 3h4l2-3h5', 'M5 5h14l2 8v6H3v-6z'],
  check: ['M20 6L9 17l-5-5'],
  approval: ['M9 12l2 2 4-4', 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z'],
  mission: ['M4 20V4', 'M4 4h12l-2 4 2 4H4'],
  chart: ['M4 20V10', 'M10 20V4', 'M16 20v-7', 'M3 20h18'],
  list: ['M8 6h13', 'M8 12h13', 'M8 18h13', 'M3 6h.01', 'M3 12h.01', 'M3 18h.01'],
  clock: ['M12 7v5l3 2', 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z'],
  chat: ['M4 5h16v11H9l-5 4z'],
  search: ['M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14z', 'M20 20l-4-4'],
  folder: ['M3 6h6l2 2h10v11H3z'],
  user: ['M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8z', 'M4 21c1-4 4-6 8-6s7 2 8 6'],
  settings: [
    'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
    'M19 12l2-1-1-3-2 .2-1.4-1.4.2-2-3-1-1 2h-2l-1-2-3 1 .2 2L6.6 8.2 4.6 8l-1 3 2 1v0l-2 1 1 3 2-.2 1.4 1.4-.2 2 3 1 1-2h2l1 2 3-1-.2-2 1.4-1.4 2 .2 1-3z',
  ],
  help: [
    'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z',
    'M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6',
    'M12 17h.01',
  ],
  shield: ['M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z'],
  bell: ['M6 16V11a6 6 0 1 1 12 0v5l2 2H4z', 'M10 21h4'],
  book: ['M4 5a2 2 0 0 1 2-2h14v16H6a2 2 0 0 0-2 2z', 'M4 19V5'],
});

const SVG_NS = 'http://www.w3.org/2000/svg';
const SAFE_SCHEMES = new Set(['http:', 'https:', 'mailto:', 'tel:']);
const WIDTH_PATTERN = /^(auto|[0-9]{1,4}(px|rem|ch|%))$/;
const MAX_DEPTH = 32;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Return a navigable href, or null when it is empty or uses a scheme outside
 * the allow-list (javascript:, data:, vbscript:, file:, ...).
 * @param {unknown} value
 * @returns {string | null}
 */
export function safeHref(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  // Browsers ignore ASCII whitespace/control characters inside a scheme
  // (`java\tscript:`), so decide on the stripped form.
  // eslint-disable-next-line no-control-regex
  const probe = trimmed.replace(/[\u0000-\u0020\u007f]/g, '').toLowerCase();
  const scheme = /^([a-z][a-z0-9+.-]*):/.exec(probe);
  if (scheme) return SAFE_SCHEMES.has(`${scheme[1]}:`) ? trimmed : null;
  if (probe.startsWith('\\\\') || probe.startsWith('/\\')) return null;
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

function icon(ctx, name, className) {
  const paths =
    typeof name === 'string' && Object.prototype.hasOwnProperty.call(KB_ICON_PATHS, name)
      ? KB_ICON_PATHS[name]
      : null;
  if (!paths) return null;
  const wrap = el(ctx, 'span', className);
  wrap.setAttribute('aria-hidden', 'true');
  const svg = ctx.doc.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '18');
  svg.setAttribute('height', '18');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.8');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('focusable', 'false');
  for (const d of paths) {
    const path = ctx.doc.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    svg.appendChild(path);
  }
  wrap.appendChild(svg);
  return wrap;
}

/**
 * Render a `KbActionRef` / `ui:button` as `a.kb-btn` (href) or
 * `button.kb-btn` (action). Returns null when neither target is usable.
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
  const action = normalizeAction(ref.action);
  if (action) {
    const button = el(ctx, 'button', className, label);
    button.setAttribute('type', 'button');
    setData(button, 'action-id', action.id);
    if (disabled) button.disabled = true;
    button.addEventListener('click', () => {
      if (typeof ctx.onAction === 'function') ctx.onAction(action, source);
    });
    return button;
  }
  const href = safeHref(ref.href);
  if (ref.href !== undefined && !href && !disabled) return null;
  const link = el(ctx, 'a', className, label);
  if (disabled || !href) {
    link.setAttribute('aria-disabled', 'true');
  } else {
    link.setAttribute('href', href);
  }
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
  pill.appendChild(el(ctx, 'span', 'kb-status-pill__label', statusLabel(status, domain, label)));
  return pill;
}

function isStatusValue(value) {
  return (
    typeof value === 'string' && Object.prototype.hasOwnProperty.call(KB_STATUS_LABELS_JA, value)
  );
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

  'ui:nav-rail'(ctx, p) {
    const root = el(ctx, 'nav', 'kb-nav-rail');
    if (p.label) root.setAttribute('aria-label', str(p.label));
    const list = navList(ctx, p.items);
    if (list) root.appendChild(list);
    const footerList = navList(ctx, p.footer_items);
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
    if (!asLinks) root.setAttribute('role', 'tablist');
    for (const item of items) {
      const active = p.active !== undefined && item.id === p.active;
      let tab;
      if (asLinks) {
        tab = el(ctx, 'a', 'kb-tabs__tab');
        const href = safeHref(item.href);
        if (href) tab.setAttribute('href', href);
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
      tab.appendChild(el(ctx, 'span', 'kb-tabs__label', item.label));
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
      const header = el(ctx, 'div', 'kb-section__header');
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
    setData(root, 'trend', p.trend);
    root.appendChild(el(ctx, 'span', 'kb-metric__label', p.label));
    const value = el(ctx, 'span', 'kb-metric__value', p.value);
    if (p.unit) value.appendChild(el(ctx, 'span', 'kb-metric__unit', p.unit));
    root.appendChild(value);
    if (p.delta) {
      const delta = el(ctx, 'span', 'kb-metric__delta');
      const arrow =
        p.trend === 'up' ? '↑' : p.trend === 'down' ? '↓' : p.trend === 'flat' ? '→' : '';
      if (arrow) {
        const trend = el(ctx, 'span', 'kb-metric__trend', arrow);
        trend.setAttribute('aria-hidden', 'true');
        delta.appendChild(trend);
      }
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
      const value = el(ctx, 'dd', 'kb-kv__value', displayScalar(item.value));
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
      const td = el(ctx, 'td', 'kb-table__empty', p.empty || 'データがありません');
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
        tr.addEventListener('click', go);
        tr.addEventListener('keydown', (event) => {
          if (event.key === 'Enter') go();
        });
      }
      for (const col of columns) {
        const td = el(ctx, 'td');
        setData(td, 'align', col.align);
        if (col.mono === true) setData(td, 'mono', 'true');
        const value = row[col.key];
        // Convention: a `status` / `*_status` column holding a canonical
        // status value renders as a status pill (icon + text).
        if ((col.key === 'status' || col.key.endsWith('_status')) && isStatusValue(value)) {
          td.appendChild(statusPill(ctx, value));
        } else {
          td.textContent = displayScalar(value);
        }
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    wrap.appendChild(table);
    return wrap;
  },

  'ui:list'(ctx, p) {
    const root = el(ctx, 'ul', 'kb-list');
    setData(root, 'variant', p.variant === 'timeline' ? 'timeline' : 'plain');
    for (const item of Array.isArray(p.items) ? p.items : []) {
      if (!isRecord(item)) continue;
      const li = el(ctx, 'li', 'kb-list__item');
      setData(li, 'status', item.status);
      const body = el(ctx, 'div', 'kb-list__body');
      const href = safeHref(item.href);
      const title = el(ctx, href ? 'a' : 'span', 'kb-list__title', item.title);
      if (href) title.setAttribute('href', href);
      body.appendChild(title);
      if (item.meta) body.appendChild(el(ctx, 'span', 'kb-list__meta', item.meta));
      li.appendChild(body);
      if (isStatusValue(item.status)) li.appendChild(statusPill(ctx, item.status));
      root.appendChild(li);
    }
    return root;
  },

  'ui:text'(ctx, p) {
    const variant = ['body', 'muted', 'caption', 'mono', 'title'].includes(p.variant)
      ? p.variant
      : 'body';
    return el(ctx, 'p', `kb-text kb-text--${variant}`, p.text ?? p.value ?? p.content ?? p.label);
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
    root.setAttribute('aria-label', '読み込み中');
    const lines = Number.isInteger(p.lines) ? Math.min(Math.max(p.lines, 1), 12) : 3;
    for (let index = 0; index < lines; index += 1) {
      const line = el(ctx, 'div', 'kb-skeleton__line');
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
    root.appendChild(el(ctx, 'summary', '', p.summary));
    const body = el(ctx, 'div', 'kb-disclosure__body');
    appendChildren(ctx, body, c, depth);
    root.appendChild(body);
    return root;
  },
};

function badge(ctx, p) {
  const node = el(ctx, 'span', 'kb-badge', p.label);
  setData(node, 'tone', p.tone);
  setData(node, 'role', p.role);
  return node;
}

function navList(ctx, items) {
  if (!Array.isArray(items) || items.length === 0) return null;
  const list = el(ctx, 'ul', 'kb-nav-rail__list');
  for (const item of items) {
    if (!isRecord(item)) continue;
    const li = el(ctx, 'li');
    const link = el(ctx, 'a', 'kb-nav-rail__item');
    const href = safeHref(item.href);
    if (href) link.setAttribute('href', href);
    setData(link, 'nav-id', item.id);
    if (item.active === true) {
      link.setAttribute('aria-current', 'page');
      setData(link, 'active', 'true');
    }
    const glyph = icon(ctx, item.icon, 'kb-nav-rail__icon');
    if (glyph) link.appendChild(glyph);
    const text = el(ctx, 'span', 'kb-nav-rail__text');
    text.appendChild(el(ctx, 'span', 'kb-nav-rail__label', item.label));
    if (item.hint) text.appendChild(el(ctx, 'span', 'kb-nav-rail__hint', item.hint));
    link.appendChild(text);
    li.appendChild(link);
    list.appendChild(li);
  }
  return list;
}

function displayScalar(value) {
  if (value === null || value === undefined || value === '') return '—';
  if (value === true) return 'はい';
  if (value === false) return 'いいえ';
  return str(value);
}

function debugWarning(ctx, type) {
  const root = el(ctx, 'div', 'kb-callout');
  setData(root, 'tone', 'warning');
  setData(root, 'unknown-type', type);
  const glyph = el(ctx, 'span', 'kb-callout__icon');
  glyph.setAttribute('aria-hidden', 'true');
  root.appendChild(glyph);
  const content = el(ctx, 'div', 'kb-callout__content');
  content.appendChild(el(ctx, 'p', 'kb-callout__title', `未対応のコンポーネント: ${str(type)}`));
  root.appendChild(content);
  return root;
}

function renderWithDepth(component, ctx, depth) {
  if (!isRecord(component)) return null;
  const type = resolveType(component.type);
  if (!type) return ctx.debug ? debugWarning(ctx, component.type) : null;
  const props = isRecord(component.props) ? component.props : {};
  const node = RENDERERS[type](ctx, props, component, depth);
  if (node && typeof component.id === 'string' && component.id) {
    node.setAttribute('data-a2ui-id', component.id);
  }
  return node;
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
    lookup: options.lookup instanceof Map ? options.lookup : lookup,
    visiting: new Set(),
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
  while (container.firstChild) container.removeChild(container.firstChild);
  container.appendChild(fragment);
  return container;
}

export const KB_RENDERED_TYPES = Object.freeze(Object.keys(RENDERERS));
