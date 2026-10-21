/**
 * The viewer app — wires the framework to the page.
 *
 * Everything the page does goes through the framework: messages enter the
 * `SurfaceStore`, the canvas is drawn by `renderSurface` with the standard
 * catalog, actions run through `runAction` against the host proxy. The app
 * itself only knows about sources (providers, paths, pasted text) and the
 * page chrome. No markup strings, no inline handlers — CSP `script-src
 * 'self'` stays intact.
 */
import {
  A2UI_OPERATIONS,
  collectActions,
  createBrowserAdapter,
  createComponentRegistry,
  createSurfaceStore,
  extractA2UIPayload,
  inputActionBody,
  registerStandardCatalog,
  renderSurface,
  runAction,
  type A2UIComponent,
  type ActionDescriptor,
  type FetchLike,
  type RenderReport,
  type SurfaceStore,
} from '../framework/index.js';
import { detectLocale, stringsFor, type ViewerStrings } from './strings.js';

interface ProviderInfo {
  id: string;
  base_url: string;
}
interface CatalogEntry {
  label: string;
  summary: string;
  path: string;
  session: boolean;
}
interface Source {
  providerId: string;
  path: string;
  label: string;
}

const REFRESH_MS = 4000;
const TENANT_KEY = 'a2ui-host.tenant';
const SESSION_KEY = 'a2ui-host.session';
const PATH_PATTERN = /^\/api\/[A-Za-z0-9/_\-.?=&%:]*$/u;

const adapter = createBrowserAdapter(document);
const registry = registerStandardCatalog(createComponentRegistry<HTMLElement>());
const locale = detectLocale(navigator.language);
const strings: ViewerStrings = stringsFor(locale);

const state: {
  store: SurfaceStore;
  providers: ProviderInfo[];
  source: Source | null;
  input: ActionDescriptor | null;
  extraActions: ActionDescriptor[];
  current: string | null;
  report: RenderReport | null;
  timer: number | null;
  busy: boolean;
} = {
  store: createSurfaceStore(),
  providers: [],
  source: null,
  input: null,
  extraActions: [],
  current: null,
  report: null,
  timer: null,
  busy: false,
};

// ------------------------------------------------------------------ helpers
function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing element #${id}`);
  return node as T;
}
function el(tag: string, className?: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function clear(node: HTMLElement): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}
function randomId(): string {
  return typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}
function stored(key: string): string {
  try {
    return localStorage.getItem(key) ?? '';
  } catch {
    return '';
  }
}
function remember(key: string, value: string): void {
  try {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch {
    // Storage may be unavailable; the viewer works without it.
  }
}
function sessionId(): string {
  const existing = stored(SESSION_KEY);
  if (existing) return existing;
  const next = randomId();
  remember(SESSION_KEY, next);
  return next;
}
function tenant(): string {
  return byId<HTMLInputElement>('tenant').value.trim();
}
const hostFetch: FetchLike = (url, init) => {
  const headers = new Headers(init?.headers ?? {});
  const slug = tenant();
  if (slug) headers.set('x-kyberion-tenant', slug);
  return fetch(url, { ...init, headers });
};
function proxyTarget(providerId: string): (path: string) => string {
  return (path) => `/api/providers/${encodeURIComponent(providerId)}/proxy${path}`;
}
function withParams(path: string, params: Record<string, string>): string {
  const url = new URL(path, 'http://host.invalid');
  for (const [key, value] of Object.entries(params))
    if (!url.searchParams.has(key)) url.searchParams.set(key, value);
  return `${url.pathname}${url.search}`;
}
function setStatus(text: string, tone: 'info' | 'error' | 'ok' = 'info'): void {
  const status = byId('status');
  status.textContent = text;
  status.dataset.tone = tone;
}

// ------------------------------------------------------------------- sources
async function loadProviders(): Promise<void> {
  const response = await hostFetch('/api/providers');
  const body = (await response.json()) as { providers?: ProviderInfo[] };
  state.providers = Array.isArray(body.providers) ? body.providers : [];
  const select = byId<HTMLSelectElement>('path-provider');
  clear(select);
  for (const provider of state.providers) {
    const option = document.createElement('option');
    option.value = provider.id;
    option.textContent = provider.id;
    select.appendChild(option);
  }
  await renderSources();
}

async function fetchCatalog(
  provider: ProviderInfo
): Promise<{ components: CatalogEntry[]; resources: CatalogEntry[] } | null> {
  try {
    const response = await hostFetch(
      `/api/providers/${encodeURIComponent(provider.id)}/catalog?locale=${encodeURIComponent(locale)}`
    );
    if (!response.ok) return null;
    const body = (await response.json()) as {
      components?: Array<{ id: string; title: string; summary: string; a2ui_path: string }>;
      resources?: Array<{ resource: string; description: string; a2ui_path: string }>;
    };
    return {
      components: (body.components ?? []).map((item) => ({
        label: item.title,
        summary: item.summary,
        path: item.a2ui_path,
        session: true,
      })),
      // Every catalog load carries the viewer session: session-scoped
      // producers (hearing) need it, the others ignore it.
      resources: (body.resources ?? []).map((item) => ({
        label: item.resource,
        summary: item.description,
        path: item.a2ui_path,
        session: true,
      })),
    };
  } catch {
    return null;
  }
}

function sourceButton(provider: ProviderInfo, entry: CatalogEntry): HTMLElement {
  const li = el('li', 'src-item');
  const button = el('button', 'src-button');
  button.setAttribute('type', 'button');
  button.appendChild(el('span', 'src-label', entry.label));
  if (entry.summary) button.appendChild(el('span', 'src-summary', entry.summary));
  button.addEventListener('click', () => {
    const path = entry.session ? withParams(entry.path, { session: sessionId() }) : entry.path;
    void loadSource({ providerId: provider.id, path, label: `${provider.id} · ${entry.label}` });
  });
  li.appendChild(button);
  return li;
}

async function renderSources(): Promise<void> {
  const root = byId('providers');
  clear(root);
  // Blocks are appended in provider order first, then filled as catalogs
  // arrive, so the list never reorders itself between loads.
  const blocks = state.providers.map((provider) => {
    const block = el('section', 'provider');
    const head = el('header', 'provider-head');
    head.appendChild(el('h3', 'provider-name', provider.id));
    head.appendChild(el('span', 'provider-base', provider.base_url));
    block.appendChild(head);
    block.appendChild(el('p', 'note note-muted', strings.loading));
    root.appendChild(block);
    return block;
  });
  await Promise.all(
    state.providers.map(async (provider, index) => {
      const block = blocks[index];
      const catalog = await fetchCatalog(provider);
      block.removeChild(block.lastChild as Node);
      if (!catalog) {
        block.appendChild(el('p', 'note note-muted', strings.catalogUnavailable));
        return;
      }
      if (catalog.components.length) {
        block.appendChild(el('h4', 'provider-group', strings.components));
        const list = el('ul', 'src-list');
        for (const entry of catalog.components) list.appendChild(sourceButton(provider, entry));
        block.appendChild(list);
      }
      if (catalog.resources.length) {
        block.appendChild(el('h4', 'provider-group', strings.resources));
        const list = el('ul', 'src-list');
        for (const entry of catalog.resources) list.appendChild(sourceButton(provider, entry));
        block.appendChild(list);
      }
      if (!catalog.components.length && !catalog.resources.length) {
        block.appendChild(el('p', 'note note-muted', strings.noResources));
      }
    })
  );
}

/** Human-readable reason for a failed load or action, from the host/proxy answer. */
function failureDetail(status: number, body: unknown): string {
  const record = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  const error = typeof record.error === 'string' ? record.error : '';
  const message = typeof record.message === 'string' ? record.message : '';
  return [status ? `HTTP ${status}` : '', error || message].filter(Boolean).join(' · ');
}

/** Wrap a non-A2UI JSON answer as a one-off surface (alert + code block). */
function rawJsonMessages(source: Source, body: object): unknown[] {
  const pathOnly = source.path.split('?')[0];
  const slug = `raw:${source.providerId}:${pathOnly.replace(/[^a-z0-9]+/giu, '-').toLowerCase()}`
    .replace(/-+$/u, '')
    .slice(0, 80);
  const surfaceId = /^[a-z0-9][a-z0-9:_-]*$/u.test(slug) ? slug : 'raw:json';
  return [
    { createSurface: { surfaceId, catalogId: 'raw-json', title: pathOnly } },
    {
      updateComponents: {
        surfaceId,
        components: [
          {
            id: 'raw-note',
            type: 'display:alert',
            props: { tone: 'info', title: strings.noA2UI, message: strings.rawJson },
          },
          {
            id: 'raw-body',
            type: 'display:code',
            props: { language: 'json', code: JSON.stringify(body, null, 2) },
          },
        ],
      },
    },
  ];
}

// ------------------------------------------------------------------- loading
function selectNewest(before: string[]): void {
  const after = state.store.list().map((surface) => surface.id);
  const created = after.filter((id) => !before.includes(id));
  if (created.length) state.current = created[created.length - 1];
  else if (!state.current || !after.includes(state.current))
    state.current = after[after.length - 1] ?? null;
}

async function loadSource(source: Source): Promise<void> {
  if (!PATH_PATTERN.test(source.path)) {
    setStatus(strings.pathNotAllowed, 'error');
    return;
  }
  state.source = source;
  byId<HTMLInputElement>('path-input').value = source.path;
  byId<HTMLSelectElement>('path-provider').value = source.providerId;
  setStatus(strings.loading);
  let response: Response;
  let body: unknown = null;
  try {
    const url = proxyTarget(source.providerId)(withParams(source.path, { locale }));
    response = await hostFetch(url);
    try {
      body = await response.json();
    } catch {
      body = null;
    }
  } catch (error) {
    setStatus(
      `${strings.loadFailed} · ${source.providerId} · ${error instanceof Error ? error.message : 'network'}`,
      'error'
    );
    return;
  }
  if (!response.ok) {
    setStatus(
      `${strings.loadFailed} · ${source.providerId} ${source.path} · ${failureDetail(response.status, body)}`,
      'error'
    );
    return;
  }
  let payload = extractA2UIPayload(body);
  let rawJson = false;
  if (!payload.messages.length) {
    // Not A2UI, but still an answer: show the JSON as a surface so the
    // viewer can inspect what the producer actually returned.
    if (!body || typeof body !== 'object') {
      setStatus(`${strings.noA2UI} · ${source.providerId} ${source.path}`, 'error');
      return;
    }
    rawJson = true;
    payload = { ...payload, messages: rawJsonMessages(source, body) };
  }
  const before = state.store.list().map((surface) => surface.id);
  const events = state.store.applyMany(payload.messages, source.label);
  state.input = payload.input;
  state.extraActions = payload.actions;
  selectNewest(before);
  const rejected = events.filter((event) => event.kind === 'rejected').length;
  if (rejected) setStatus(`${strings.rejected}: ${rejected}`, 'error');
  else if (rawJson) setStatus(`${strings.noA2UI} · ${strings.rawJson}`, 'info');
  else setStatus('');
  renderAll();
}

function applyPasted(): void {
  const area = byId<HTMLTextAreaElement>('paste-input');
  const error = byId('paste-error');
  let parsed: unknown;
  try {
    parsed = JSON.parse(area.value);
  } catch {
    error.textContent = strings.invalidJson;
    error.hidden = false;
    return;
  }
  error.hidden = true;
  let payload = extractA2UIPayload(parsed);
  if (
    payload.shape === 'none' &&
    parsed &&
    typeof parsed === 'object' &&
    A2UI_OPERATIONS.some((op) => op in (parsed as object))
  ) {
    payload = { ...payload, messages: [parsed] };
  }
  const before = state.store.list().map((surface) => surface.id);
  state.store.applyMany(payload.messages, strings.paste);
  state.input = payload.input;
  state.extraActions = payload.actions;
  state.source = null;
  selectNewest(before);
  renderAll();
}

// ------------------------------------------------------------------- actions
async function dispatch(
  action: ActionDescriptor,
  extra: Record<string, unknown> = {}
): Promise<void> {
  if (state.busy) return;
  const providerId = state.source?.providerId ?? state.providers[0]?.id;
  if (!providerId) {
    setStatus(strings.actionFailed, 'error');
    return;
  }
  state.busy = true;
  setStatus(strings.loading);
  const result = await runAction(hostFetch, proxyTarget(providerId), action, extra);
  state.busy = false;
  if (!result.ok) {
    setStatus(
      `${strings.actionFailed} · ${action.operation_id} · ${failureDetail(result.status, result.body)}`,
      'error'
    );
    return;
  }
  setStatus(strings.actionDone, 'ok');
  if (action.refresh !== false && state.source) await loadSource(state.source);
}

// ------------------------------------------------------------------- render
function renderTabs(): void {
  const tabs = byId('tabs');
  clear(tabs);
  const surfaces = state.store.list();
  if (!surfaces.length) {
    tabs.appendChild(el('span', 'note', strings.noSurface));
    return;
  }
  for (const surface of surfaces) {
    const tab = el(
      'button',
      `tab${surface.id === state.current ? ' tab-current' : ''}`,
      surface.title ?? surface.id
    );
    tab.setAttribute('type', 'button');
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-selected', surface.id === state.current ? 'true' : 'false');
    tab.title = `${surface.id} · ${surface.catalogId}`;
    tab.addEventListener('click', () => {
      state.current = surface.id;
      renderAll();
    });
    tabs.appendChild(tab);
  }
}

function renderCanvas(): void {
  const canvas = byId('canvas');
  if (!state.current) {
    clear(canvas);
    state.report = null;
  } else {
    state.report = renderSurface(canvas, state.store, state.current, {
      adapter,
      registry,
      onAction: (action) => void dispatch(action),
      strings: { unsupported: strings.unsupportedComponent, empty: strings.emptySurface },
    });
  }
  const form = byId<HTMLFormElement>('input-form');
  form.hidden = !state.input;
}

function renderInspector(): void {
  const surface = state.current ? state.store.get(state.current) : undefined;
  const report = byId('report');
  const actions = byId('actions');
  const data = byId('data');
  const tree = byId('tree');
  const history = byId('history');
  for (const node of [report, actions, data, tree, history]) clear(node);

  if (state.report) {
    const rows = el('dl', 'kv');
    const add = (key: string, value: string): void => {
      const row = el('div', 'kv-row');
      row.appendChild(el('dt', 'kv-key', key));
      row.appendChild(el('dd', 'kv-value', value));
      rows.appendChild(row);
    };
    add(strings.rendered, String(state.report.rendered));
    add(strings.unsupported, state.report.unsupported.join(', ') || strings.none);
    if (surface?.implicit) add(surface.id, strings.implicitSurface);
    report.appendChild(rows);
  }

  const found = surface ? collectActions(surface.order.map((id) => surface.components[id])) : [];
  const standalone = state.extraActions.filter(
    (action) => !found.some((item) => item.action.operation_id === action.operation_id)
  );
  for (const item of [
    ...found.map((entry) => ({ label: entry.label, action: entry.action })),
    ...standalone.map((action) => ({ label: action.operation_id, action })),
  ]) {
    const button = el('button', 'chip', item.label);
    button.setAttribute('type', 'button');
    button.title = `${item.action.method} ${item.action.path}`;
    button.addEventListener('click', () => void dispatch(item.action));
    actions.appendChild(button);
  }
  if (!found.length && !standalone.length)
    actions.appendChild(el('span', 'note note-muted', strings.none));

  if (surface) {
    const rows = el('dl', 'kv');
    for (const [key, value] of Object.entries(surface.data)) {
      const row = el('div', 'kv-row');
      row.appendChild(el('dt', 'kv-key', key));
      row.appendChild(
        el('dd', 'kv-value', typeof value === 'string' ? value : JSON.stringify(value))
      );
      rows.appendChild(row);
    }
    if (!Object.keys(surface.data).length)
      rows.appendChild(el('span', 'note note-muted', strings.none));
    data.appendChild(rows);

    const treeModel = state.store.tree(surface.id);
    const walk = (component: A2UIComponent, depth: number, seen: Set<string>): void => {
      const li = el('li', 'tree-item');
      li.style.setProperty('--depth', String(depth));
      const type = el(
        'code',
        `tree-type${registry.has(component.type) ? '' : ' tree-type-unsupported'}`,
        component.type
      );
      li.appendChild(type);
      li.appendChild(el('span', 'tree-id', component.id));
      tree.appendChild(li);
      if (seen.has(component.id) || depth > 12) return;
      seen.add(component.id);
      for (const child of treeModel.childrenOf(component.id)) walk(child, depth + 1, seen);
      const items = component.props.items;
      if (Array.isArray(items)) {
        items.forEach((item, index) => {
          if (
            item &&
            typeof item === 'object' &&
            typeof (item as { type?: unknown }).type === 'string'
          ) {
            walk(
              {
                id: `${component.id}:${index}`,
                type: (item as { type: A2UIComponent['type'] }).type,
                props: (item as { props?: Record<string, unknown> }).props ?? {},
              },
              depth + 1,
              seen
            );
          }
        });
      }
    };
    for (const root of treeModel.roots) walk(root, 0, new Set());
  }

  for (const event of [...state.store.history()].reverse().slice(0, 60)) {
    const li = el('li', `hist-item hist-${event.kind}`);
    li.appendChild(el('time', 'hist-time', event.at.slice(11, 19)));
    li.appendChild(
      el('code', 'hist-kind', event.kind === 'rejected' ? strings.rejected : event.kind)
    );
    li.appendChild(
      el(
        'span',
        'hist-detail',
        [event.surfaceId, event.detail, event.source ? `← ${event.source}` : '']
          .filter(Boolean)
          .join(' · ')
      )
    );
    history.appendChild(li);
  }
}

function renderAll(): void {
  renderTabs();
  renderCanvas();
  renderInspector();
}

// ------------------------------------------------------------------- chrome
function fillChrome(): void {
  document.title = strings.title;
  const labels: Record<string, string> = {
    'app-title': strings.title,
    'app-subtitle': strings.subtitle,
    'tenant-label': strings.tenant,
    'sources-title': strings.sources,
    'path-title': strings.loadByPath,
    'path-load': strings.load,
    'auto-refresh-label': strings.autoRefresh,
    'paste-title': strings.paste,
    'paste-apply': strings.apply,
    'clear-all': strings.clear,
    'input-send': strings.send,
    'inspector-title': strings.inspector,
    'report-title': strings.report,
    'actions-title': strings.actions,
    'data-title': strings.dataModel,
    'tree-title': strings.tree,
    'history-title': strings.history,
  };
  for (const [id, text] of Object.entries(labels)) byId(id).textContent = text;
  byId<HTMLInputElement>('tenant').placeholder = strings.tenantPlaceholder;
  byId<HTMLInputElement>('path-input').placeholder = strings.pathPlaceholder;
  byId<HTMLTextAreaElement>('paste-input').placeholder = strings.pastePlaceholder;
  byId<HTMLInputElement>('input-text').placeholder = strings.inputPlaceholder;
}

function wire(): void {
  const tenantInput = byId<HTMLInputElement>('tenant');
  tenantInput.value = stored(TENANT_KEY);
  tenantInput.addEventListener('change', () => {
    remember(TENANT_KEY, tenant());
    void renderSources();
  });

  byId<HTMLFormElement>('path-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const path = byId<HTMLInputElement>('path-input').value.trim();
    const providerId = byId<HTMLSelectElement>('path-provider').value;
    if (path && providerId) void loadSource({ providerId, path, label: `${providerId} · ${path}` });
  });

  byId<HTMLInputElement>('auto-refresh').addEventListener('change', (event) => {
    const checked = (event.target as HTMLInputElement).checked;
    if (state.timer !== null) {
      window.clearInterval(state.timer);
      state.timer = null;
    }
    if (checked) {
      state.timer = window.setInterval(() => {
        if (state.source && !state.busy) void loadSource(state.source);
      }, REFRESH_MS);
    }
  });

  byId('paste-apply').addEventListener('click', applyPasted);
  byId('clear-all').addEventListener('click', () => {
    state.store = createSurfaceStore();
    state.current = null;
    state.input = null;
    state.extraActions = [];
    state.source = null;
    setStatus('');
    renderAll();
  });

  byId<HTMLFormElement>('input-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const field = byId<HTMLInputElement>('input-text');
    const text = field.value.trim();
    if (!text || !state.input) return;
    field.value = '';
    void dispatch(state.input, inputActionBody(state.input, text, randomId()));
  });
}

async function boot(): Promise<void> {
  fillChrome();
  wire();
  renderAll();
  try {
    await loadProviders();
  } catch {
    setStatus(strings.catalogUnavailable, 'error');
  }
  const params = new URLSearchParams(location.search);
  const provider = params.get('provider');
  const path = params.get('path');
  if (provider && path)
    void loadSource({ providerId: provider, path, label: `${provider} · ${path}` });
}

if (document.readyState === 'loading')
  document.addEventListener('DOMContentLoaded', () => void boot());
else void boot();
