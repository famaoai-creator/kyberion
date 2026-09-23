// UI-04: vanilla DOM renderer for the A2UI `kyberion-base` catalog.
//
// Runs against `mini-dom.test-support.ts` (passed via the `document` option):
// the workspace jsdom cannot load under the root `undici` override, and the
// stand-in also makes any innerHTML-style write throw.
import { describe, expect, it, vi } from 'vitest';
import { getUiMessageBundle, pathResolver, safeReadFile } from '@agent/core';
import {
  KB_STATUS_TONES,
  KB_STATUS_VALUES,
  KYBERION_BASE_ALIASES,
  KYBERION_BASE_COMPONENT_TYPES,
} from '@agent/core/a2ui-catalog';
import {
  KB_ALIASES,
  KB_RENDERED_TYPES,
  KB_STATUS_DOMAIN_MESSAGE_KEYS,
  KB_STATUS_MESSAGE_KEYS,
  KB_UI_DEFAULT_MESSAGES,
  KB_UI_MESSAGE_KEYS,
  createTranslator,
  renderA2UI,
  renderComponent,
  safeHref,
  statusLabel,
} from './kyberion-ui.js';
import { MiniDocument, type MiniElement } from './mini-dom.test-support.js';

function setup() {
  const document = new MiniDocument();
  const root = document.createElement('div');
  return { document: document as unknown as Document, root };
}

function renderInto(root: MiniElement, components: unknown[], options: Record<string, unknown>) {
  renderA2UI(root as unknown as Element, components as never, options as never);
  return root;
}

const JA = getUiMessageBundle('ja');

function render(
  type: string,
  props: Record<string, unknown>,
  children?: string[],
  options: Record<string, unknown> = {}
) {
  const { document } = setup();
  return renderComponent(
    { id: 'c1', type, props, children },
    { document, ...options }
  ) as unknown as MiniElement | null;
}

function renderJa(type: string, props: Record<string, unknown>) {
  return render(type, props, undefined, { locale: JA.locale, messages: JA.messages });
}

/** Minimal valid props per type — the root class each must emit. */
const CASES: Record<string, { props: Record<string, unknown>; root: string; tag?: string }> = {
  'ui:app-shell': {
    props: { density: 'compact', theme: 'dark', role: 'presence-studio' },
    root: 'kb-app-shell',
  },
  'ui:page-header': { props: { title: '承認' }, root: 'kb-page-header', tag: 'HEADER' },
  'ui:nav-rail': {
    props: { items: [{ id: 'home', label: 'ホーム', href: '/' }] },
    root: 'kb-nav-rail',
    tag: 'NAV',
  },
  'ui:tabs': { props: { items: [{ id: 'a', label: 'A' }] }, root: 'kb-tabs' },
  'ui:stack': { props: {}, root: 'kb-stack' },
  'ui:grid': { props: { columns: 3 }, root: 'kb-grid' },
  'ui:section': { props: { title: '概要' }, root: 'kb-section', tag: 'SECTION' },
  'ui:next-action': {
    props: { title: '承認する', primary: { label: '開く', href: '/a' } },
    root: 'kb-next-action',
  },
  'ui:metric': { props: { label: '件数', value: 3 }, root: 'kb-metric' },
  'ui:kv': { props: { items: [{ label: 'ID', value: 'x' }] }, root: 'kb-kv', tag: 'DL' },
  'ui:table': { props: { columns: [{ key: 'a', label: 'A' }], rows: [] }, root: 'kb-table-wrap' },
  'ui:list': { props: { items: [{ title: 'x' }] }, root: 'kb-list', tag: 'UL' },
  'ui:text': { props: { text: 'hello' }, root: 'kb-text', tag: 'P' },
  'ui:status-pill': { props: { status: 'ready' }, root: 'kb-status-pill' },
  'ui:badge': { props: { label: 'β' }, root: 'kb-badge' },
  'ui:callout': { props: { tone: 'warning', title: '注意' }, root: 'kb-callout' },
  'ui:empty-state': { props: { title: 'なし' }, root: 'kb-empty-state' },
  'ui:skeleton': { props: { lines: 2 }, root: 'kb-skeleton' },
  'ui:button': { props: { label: '保存', action: { id: 'save' } }, root: 'kb-btn', tag: 'BUTTON' },
  'ui:disclosure': { props: { summary: '詳細' }, root: 'kb-disclosure', tag: 'DETAILS' },
};

describe('kyberion-ui vanilla renderer — catalog coverage', () => {
  it('renders exactly the kyberion-base catalog types and aliases', () => {
    expect([...KB_RENDERED_TYPES].sort()).toEqual([...KYBERION_BASE_COMPONENT_TYPES].sort());
    expect(KB_ALIASES).toEqual(KYBERION_BASE_ALIASES);
    expect(Object.keys(CASES).sort()).toEqual([...KYBERION_BASE_COMPONENT_TYPES].sort());
  });

  for (const [type, spec] of Object.entries(CASES)) {
    it(`${type} renders .${spec.root}`, () => {
      const node = render(type, spec.props);
      expect(node).not.toBeNull();
      expect(node!.classList.contains(spec.root)).toBe(true);
      if (spec.tag) expect(node!.tagName).toBe(spec.tag);
    });
  }

  it('has a vocabulary message key (with en + ja text) for every canonical status', () => {
    for (const status of KB_STATUS_VALUES) {
      const key = KB_STATUS_MESSAGE_KEYS[status];
      expect(key, status).toMatch(/^ui:status_/);
      expect(KB_UI_DEFAULT_MESSAGES[key], key).toMatch(/\S/);
      expect(JA.messages[key], key).toMatch(/\S/);
    }
    for (const byDomain of Object.values(KB_STATUS_DOMAIN_MESSAGE_KEYS)) {
      for (const key of Object.values(byDomain)) expect(JA.messages[key], key).toMatch(/\S/);
    }
    expect(Object.keys(KB_STATUS_MESSAGE_KEYS).sort()).toEqual([...KB_STATUS_VALUES].sort());
    expect(Object.keys(KB_STATUS_TONES).length).toBe(KB_STATUS_VALUES.length);
  });
});

describe('kyberion-ui vanilla renderer — markup contract', () => {
  it('app-shell puts the nav-rail in __nav and everything else in __main', () => {
    const { document, root } = setup();
    renderInto(
      root,
      [
        {
          id: 'shell',
          type: 'ui:app-shell',
          props: { density: 'compact' },
          children: ['nav', 'hdr', 'body'],
        },
        {
          id: 'nav',
          type: 'ui:nav-rail',
          props: { items: [{ id: 'h', label: 'ホーム', href: '/', active: true, icon: 'home' }] },
        },
        { id: 'hdr', type: 'ui:page-header', props: { title: 'T' } },
        { id: 'body', type: 'ui:text', props: { text: 'B' } },
      ],
      { document }
    );
    const shell = root.query('.kb-app-shell')!;
    expect(shell.getAttribute('data-density')).toBe('compact');
    expect(shell.query('> .kb-app-shell__nav > .kb-nav-rail')).not.toBeNull();
    const main = shell.query('> main.kb-app-shell__main')!;
    expect(main.children.map((c) => c.className)).toEqual([
      'kb-page-header',
      'kb-text kb-text--body',
    ]);
    const item = shell.query('.kb-nav-rail__item')!;
    expect(item.getAttribute('aria-current')).toBe('page');
    expect(item.getAttribute('data-active')).toBe('true');
    const svg = item.query('.kb-nav-rail__icon[aria-hidden="true"] svg');
    expect(svg?.namespaceURI).toBe('http://www.w3.org/2000/svg');
  });

  it('omits data-density when the app-shell prop is absent (page-level density wins)', () => {
    const node = render('ui:app-shell', {});
    expect(node!.hasAttribute('data-density')).toBe(false);
  });

  it('status-pill: data-status, aria-hidden icon element, localized default label', () => {
    const node = render('ui:status-pill', { status: 'blocked', domain: 'mission' })!;
    expect(node.getAttribute('data-status')).toBe('blocked');
    expect(node.getAttribute('data-domain')).toBe('mission');
    const glyph = node.query('.kb-status-pill__icon')!;
    expect(glyph.getAttribute('aria-hidden')).toBe('true');
    expect(glyph.textContent).toBe('');
    expect(node.query('.kb-status-pill__label')!.textContent).toBe('Stopped');
    const ja = renderJa('ui:status-pill', { status: 'blocked', domain: 'mission' })!;
    expect(ja.query('.kb-status-pill__label')!.textContent).toBe('停止中');
    expect(statusLabel('blocked')).toBe('Needs attention');
    expect(statusLabel('blocked', undefined, undefined, createTranslator(JA))).toBe('要対応');
    expect(statusLabel('ready', undefined, '独自')).toBe('独自');
    expect(statusLabel('mystery')).toBe('mystery');
  });

  it('page-header renders the role badge inside the title and action buttons', () => {
    const node = render('ui:page-header', {
      title: '承認待ち',
      subtitle: '今日の判断',
      role_badge: { label: '受付', role: 'presence-studio' },
      actions: [{ label: '更新', action: { id: 'refresh' } }],
    })!;
    const badge = node.query('.kb-page-header__title .kb-badge')!;
    expect(badge.getAttribute('data-role')).toBe('presence-studio');
    expect(node.query('.kb-page-header__subtitle')!.textContent).toBe('今日の判断');
    expect(node.query('.kb-page-header__actions .kb-btn--secondary')).not.toBeNull();
  });

  it('section renders header, heading and children in order', () => {
    const { document, root } = setup();
    renderInto(
      root,
      [
        {
          id: 's',
          type: 'ui:section',
          props: { title: 'A', description: 'd', tone: 'warning' },
          children: ['t2', 't1'],
        },
        { id: 't1', type: 'ui:text', props: { text: 'one' } },
        { id: 't2', type: 'ui:text', props: { text: 'two' } },
      ],
      { document }
    );
    const section = root.query('.kb-section')!;
    expect(section.getAttribute('data-tone')).toBe('warning');
    expect(
      section.query('.kb-section__header .kb-section__heading h2.kb-section__title')!.textContent
    ).toBe('A');
    expect(section.queryAll('.kb-text').map((n) => n.textContent)).toEqual(['two', 'one']);
    // Only the unreferenced component is a root.
    expect(root.children.length).toBe(1);
  });

  it('stack / grid / disclosure expose layout data attributes and nest children', () => {
    const { document, root } = setup();
    renderInto(
      root,
      [
        {
          id: 'g',
          type: 'ui:grid',
          props: { gap: 'sm', columns: 2, min_column_width: 'xs' },
          children: ['st'],
        },
        {
          id: 'st',
          type: 'ui:stack',
          props: { direction: 'horizontal', align: 'center', wrap: true, gap: 'lg' },
          children: ['d'],
        },
        { id: 'd', type: 'ui:disclosure', props: { summary: '詳細', open: true }, children: ['x'] },
        { id: 'x', type: 'ui:text', props: { text: 'inner', variant: 'mono' } },
      ],
      { document }
    );
    const grid = root.query('.kb-grid')!;
    expect(grid.getAttribute('data-columns')).toBe('2');
    expect(grid.getAttribute('data-gap')).toBe('sm');
    expect(grid.getAttribute('data-min-column-width')).toBe('xs');
    const stack = grid.query('.kb-stack')!;
    expect(stack.getAttribute('data-direction')).toBe('horizontal');
    expect(stack.getAttribute('data-wrap')).toBe('true');
    const details = stack.query('details.kb-disclosure')!;
    expect(details.open).toBe(true);
    expect(details.query('summary')!.textContent).toBe('詳細');
    expect(details.query('.kb-disclosure__body .kb-text--mono')!.textContent).toBe('inner');
  });

  it('table renders header, alignment, mono, row href and status-column pills', () => {
    const node = render('ui:table', {
      caption: '最近の監査',
      columns: [
        { key: 'id', label: 'ID', mono: true, width: '12ch' },
        { key: 'status', label: '状態' },
        { key: 'count', label: '件数', align: 'end' },
        { key: 'note', label: 'メモ', width: 'calc(1px)' },
      ],
      rows: [{ id: 'A-1', status: 'failed', count: 3, note: null, link: '/audit/A-1' }],
      row_href_key: 'link',
    })!;
    const table = node.query('table.kb-table')!;
    expect(table.query('caption')!.textContent).toBe('最近の監査');
    const ths = table.queryAll('thead th');
    expect(ths.map((th) => th.getAttribute('scope'))).toEqual(['col', 'col', 'col', 'col']);
    expect(ths[0].style.width).toBe('12ch');
    expect(ths[3].style.width).toBeUndefined();
    const tr = table.query('tbody tr')!;
    expect(tr.getAttribute('data-href')).toBe('/audit/A-1');
    const tds = tr.queryAll('td');
    expect(tds[0].getAttribute('data-mono')).toBe('true');
    expect(tds[1].query('.kb-status-pill')!.getAttribute('data-status')).toBe('failed');
    expect(tds[2].getAttribute('data-align')).toBe('end');
    expect(tds[3].textContent).toBe('—');
  });

  it('table shows the empty message across all columns', () => {
    const node = render('ui:table', {
      columns: [
        { key: 'a', label: 'A' },
        { key: 'b', label: 'B' },
      ],
      rows: [],
      empty: '該当なし',
    })!;
    const td = node.query('td.kb-table__empty')!;
    expect(td.textContent).toBe('該当なし');
    expect(td.getAttribute('colspan')).toBe('2');
  });

  it('list renders variant, linked titles, meta and status pills', () => {
    const node = render('ui:list', {
      variant: 'timeline',
      items: [
        { title: '起票', meta: '09:00', status: 'done', href: '/m/1' },
        { title: '確認', meta: '10:00' },
      ],
    })!;
    expect(node.getAttribute('data-variant')).toBe('timeline');
    const items = node.queryAll('li.kb-list__item');
    expect(items[0].query('a.kb-list__title')!.getAttribute('href')).toBe('/m/1');
    expect(items[0].query('.kb-status-pill')).not.toBeNull();
    expect(items[1].query('span.kb-list__title')!.textContent).toBe('確認');
  });

  it('metric, kv, callout, empty-state, skeleton, tabs emit their BEM elements', () => {
    const metric = render('ui:metric', {
      label: '承認待ち',
      value: 4,
      unit: '件',
      delta: '+2',
      trend: 'up',
      tone: 'warning',
    })!;
    expect(metric.getAttribute('data-tone')).toBe('warning');
    expect(metric.getAttribute('data-trend')).toBe('up');
    expect(metric.query('.kb-metric__value .kb-metric__unit')!.textContent).toBe('件');
    // The trend arrow carries the localized trend word as its accessible name.
    const trendSvg = metric.query('.kb-metric__delta svg')!;
    expect(trendSvg.getAttribute('aria-hidden')).toBeNull();
    expect(trendSvg.getAttribute('role')).toBe('img');
    expect(trendSvg.getAttribute('aria-label')).toBe('Up');
    const metricJa = renderJa('ui:metric', { label: 'x', value: 1, delta: '0', trend: 'flat' })!;
    expect(metricJa.query('.kb-metric__delta svg')!.getAttribute('aria-label')).toBe('横ばい');

    const kv = render('ui:kv', {
      items: [
        { label: 'ID', value: 'M-1', mono: true },
        { label: '有効', value: true },
      ],
    })!;
    expect(kv.query('dd.kb-kv__value')!.getAttribute('data-mono')).toBe('true');
    expect(kv.queryAll('dd')[1].textContent).toBe('Yes');
    const kvJa = renderJa('ui:kv', { items: [{ label: 'x', value: false }] })!;
    expect(kvJa.query('dd')!.textContent).toBe('いいえ');

    const callout = render('ui:callout', {
      tone: 'danger',
      title: '接続できません',
      body: '再試行してください',
      action: { label: '再試行', action: { id: 'retry' } },
    })!;
    expect(callout.getAttribute('data-tone')).toBe('danger');
    expect(callout.query('.kb-callout__icon')!.getAttribute('aria-hidden')).toBe('true');
    expect(callout.query('.kb-callout__content .kb-callout__action .kb-btn')).not.toBeNull();

    const empty = render('ui:empty-state', {
      title: 'なし',
      body: 'まだありません',
      action: { label: '作成', href: '/new' },
    })!;
    expect(empty.query('.kb-empty-state__action a.kb-btn--primary')!.getAttribute('href')).toBe(
      '/new'
    );

    const skeleton = render('ui:skeleton', { lines: 4, shape: 'table' })!;
    expect(skeleton.getAttribute('data-shape')).toBe('table');
    expect(skeleton.queryAll('.kb-skeleton__line').length).toBe(4);
    expect(skeleton.getAttribute('aria-label')).toBe('Loading');
    expect(renderJa('ui:skeleton', {})!.getAttribute('aria-label')).toBe('読み込み中');

    const tabs = render('ui:tabs', {
      items: [
        { id: 'a', label: 'A', count: 2 },
        { id: 'b', label: 'B' },
      ],
      active: 'a',
      overflow: 'menu',
    })!;
    expect(tabs.getAttribute('role')).toBe('tablist');
    expect(tabs.getAttribute('aria-label')).toBe('Views');
    expect(tabs.getAttribute('data-overflow')).toBe('menu');
    const tabButtons = tabs.queryAll('.kb-tabs__tab');
    expect(tabButtons[0].getAttribute('aria-selected')).toBe('true');
    expect(tabButtons[0].query('.kb-tabs__count')!.textContent).toBe('2');
  });

  it('next-action marks state and uses primary/secondary variants', () => {
    const node = render('ui:next-action', {
      eyebrow: '次にやること',
      title: '見積の承認',
      reason: '期限は今日です',
      primary: { label: '確認する', href: '/decide/1' },
      secondary: { label: 'あとで', action: { id: 'snooze' } },
    })!;
    expect(node.getAttribute('data-state')).toBe('ready');
    expect(node.query('.kb-next-action__actions a.kb-btn--primary')).not.toBeNull();
    expect(node.query('.kb-next-action__actions button.kb-btn--secondary')).not.toBeNull();
    const loading = render('ui:next-action', { title: '読み込み中', state: 'loading' })!;
    expect(loading.getAttribute('aria-busy')).toBe('true');
    expect(loading.query('.kb-next-action__actions')).toBeNull();
  });

  it('button actions go to onAction and are never evaluated', () => {
    const { document } = setup();
    const onAction = vi.fn();
    const component = {
      id: 'b',
      type: 'ui:button',
      props: {
        label: '承認',
        variant: 'primary',
        action: { id: 'approve', payload: { request: 'R-1' } },
      },
    };
    const node = renderComponent(component, { document, onAction }) as unknown as MiniElement;
    expect(node.className).toBe('kb-btn kb-btn--primary');
    expect(node.getAttribute('type')).toBe('button');
    node.click();
    expect(onAction).toHaveBeenCalledWith(
      { id: 'approve', payload: { request: 'R-1' } },
      component
    );
    const disabled = render('ui:button', { label: 'x', disabled: true, href: '/x' })!;
    expect(disabled.getAttribute('aria-disabled')).toBe('true');
    expect(disabled.hasAttribute('href')).toBe(false);
  });
});

describe('kyberion-ui vanilla renderer — safety', () => {
  const XSS = '<img src=x onerror="window.__pwned=1"><script>window.__pwned=1</script>';

  it('never builds DOM from HTML strings', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('libs/shared-ui/vanilla/kyberion-ui.js'), {
        encoding: 'utf8',
      })
    );
    // Strip comments so the safety notes in the header do not count.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(code).not.toMatch(
      /innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function/
    );
  });

  it('keeps markup-looking strings as text', () => {
    const { document, root } = setup();
    renderInto(
      root,
      [
        {
          id: 's',
          type: 'ui:section',
          props: { title: XSS, description: XSS },
          children: ['t', 'tb', 'l'],
        },
        { id: 't', type: 'ui:text', props: { text: XSS } },
        {
          id: 'tb',
          type: 'ui:table',
          props: { columns: [{ key: 'a', label: XSS }], rows: [{ a: XSS }] },
        },
        { id: 'l', type: 'ui:list', props: { items: [{ title: XSS, meta: XSS }] } },
      ],
      { document }
    );
    expect(root.query('img')).toBeNull();
    expect(root.query('script')).toBeNull();
    expect(root.query('.kb-text')!.textContent).toBe(XSS);
    expect(root.query('td')!.textContent).toBe(XSS);
  });

  it('drops unsafe hrefs', () => {
    for (const bad of [
      'javascript:alert(1)',
      ' JavaScript:alert(1)',
      'java\tscript:alert(1)',
      'data:text/html,x',
      'vbscript:x',
      '\\\\evil/x',
    ]) {
      expect(safeHref(bad), bad).toBeNull();
    }
    for (const good of [
      '/a',
      'b?c=1',
      '#x',
      'https://example.com',
      'mailto:a@example.com',
      'http://127.0.0.1:3031/',
    ]) {
      expect(safeHref(good), good).toBe(good);
    }
    const unsafeButton = render('ui:button', { label: 'x', href: 'javascript:alert(1)' })!;
    expect(unsafeButton.tagName).toBe('A');
    expect(unsafeButton.hasAttribute('href')).toBe(false);
    expect(unsafeButton.getAttribute('aria-disabled')).toBe('true');
    expect(unsafeButton.getAttribute('role')).toBe('link');
    const list = render('ui:list', { items: [{ title: 'x', href: 'data:text/html,hi' }] })!;
    expect(list.query('a')).toBeNull();
    const nav = render('ui:nav-rail', {
      items: [{ id: 'x', label: 'x', href: 'javascript:void 0' }],
    })!;
    expect(nav.query('a')).toBeNull();
    expect(nav.query('span.kb-nav-rail__item')).not.toBeNull();
    const table = render('ui:table', {
      columns: [{ key: 'a', label: 'A' }],
      rows: [{ a: 1, u: 'javascript:x' }],
      row_href_key: 'u',
    })!;
    expect(table.query('tbody tr')!.hasAttribute('data-href')).toBe(false);
  });

  it('resolves legacy aliases and ignores unknown types unless debug', () => {
    expect(render('text', { text: 'hi' })!.className).toBe('kb-text kb-text--body');
    expect(render('button', { label: 'go', action: 'go' })!.tagName).toBe('BUTTON');
    expect(render('card', { title: 'c' })!.classList.contains('kb-section')).toBe(true);
    expect(render('container', {})!.classList.contains('kb-stack')).toBe(true);
    expect(render('display:hero', {})).toBeNull();
    expect(render('toString', {})).toBeNull();
    const { document } = setup();
    const warn = renderComponent(
      { id: 'u', type: 'x:unknown', props: {} },
      { document, debug: true }
    ) as unknown as MiniElement;
    expect(warn.classList.contains('kb-callout')).toBe(true);
    expect(warn.getAttribute('data-unknown-type')).toBe('x:unknown');
  });

  it('survives child cycles and missing children', () => {
    const { document, root } = setup();
    renderInto(
      root,
      [
        { id: 'a', type: 'ui:stack', props: {}, children: ['b', 'missing'] },
        { id: 'b', type: 'ui:stack', props: {}, children: ['a'] },
      ],
      { document, rootId: 'a' }
    );
    expect(root.queryAll('.kb-stack').length).toBe(2);
  });
});

describe('kyberion-ui vanilla renderer — UI-01d i18n', () => {
  it('renders defaults from the given bundle, English without one', () => {
    const table = { columns: [{ key: 'a', label: 'A' }], rows: [] };
    expect(render('ui:table', table)!.query('.kb-table__empty')!.textContent).toBe('No data');
    expect(renderJa('ui:table', table)!.query('.kb-table__empty')!.textContent).toBe(
      'データがありません'
    );
    expect(render('ui:nav-rail', { items: [] })!.getAttribute('aria-label')).toBe('Navigation');
    expect(renderJa('ui:nav-rail', { items: [] })!.getAttribute('aria-label')).toBe(
      'ナビゲーション'
    );
    expect(render('ui:disclosure', { summary: '' })!.query('summary')!.textContent).toBe('Details');
    const { document, root } = setup();
    renderInto(root as unknown as MiniElement, [{ id: 'x', type: 'kb-mystery' }], {
      document,
      debug: true,
      locale: JA.locale,
      messages: JA.messages,
    });
    expect((root as unknown as MiniElement).query('.kb-callout__title')!.textContent).toBe(
      '未対応のコンポーネント: kb-mystery'
    );
  });

  it('missing key -> English default -> key; a throwing t never breaks rendering', () => {
    const translate = createTranslator({ messages: { 'ui:status_ready': 'PRÊT' } });
    expect(translate('ui:status_ready')).toBe('PRÊT');
    expect(translate('ui:status_failed')).toBe('Failed');
    expect(translate('ui:nope')).toBe('ui:nope');
    expect(translate(KB_UI_MESSAGE_KEYS.unknownComponent, { type: 'a' })).toBe(
      'Unsupported component: a'
    );
    const node = render('ui:skeleton', {}, undefined, {
      t: () => {
        throw new Error('boom');
      },
      messages: 'not-a-bundle',
    })!;
    expect(node.getAttribute('aria-label')).toBe('Loading');
    const custom = render('ui:skeleton', {}, undefined, { t: (key: string) => `<${key}>` })!;
    expect(custom.getAttribute('aria-label')).toBe('<ui:skeleton_loading>');
  });

  it('keeps no hardcoded Japanese in the renderer source (text lives in the vocabulary)', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('libs/shared-ui/vanilla/kyberion-ui.js'), {
        encoding: 'utf8',
      })
    );
    expect(source).not.toMatch(/[\u3040-\u30ff\u4e00-\u9fff]/u);
  });
});
