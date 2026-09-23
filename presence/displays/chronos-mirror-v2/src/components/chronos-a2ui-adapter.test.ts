import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { A2UIRenderer, KB_COMPONENT_TYPES } from '@agent/shared-ui';
import { buildOperatorHomeA2UI } from '../lib/headless-a2ui';
import {
  CHRONOS_ADAPTED_TYPES,
  CHRONOS_CODE_TYPE,
  expandChronosComponents,
  toCanonicalStatus,
  type ChronosA2UIComponent,
} from './chronos-a2ui-adapter';
import { CHRONOS_A2UI_FALLBACK, ChronosA2UIRenderer } from './A2UIComponentLibrary';

const one = (type: string, props: Record<string, unknown>, children?: string[]) =>
  expandChronosComponents([{ id: 'x', type, props, ...(children ? { children } : {}) }]);
const byId = (list: ChronosA2UIComponent[], id: string) => list.find((c) => c.id === id);
const root = (list: ChronosA2UIComponent[]) => byId(list, 'x')!;
const kids = (list: ChronosA2UIComponent[], id: string) =>
  (byId(list, id)?.children ?? []).map((childId) => byId(list, childId)!);

const LOCAL_TYPES = new Set([CHRONOS_CODE_TYPE, 'kb-artifact-tile', 'kb-intervention-panel']);

/** Every emitted component is a catalog type or a registered chronos-local fallback. */
function expectRenderable(list: ChronosA2UIComponent[]) {
  const known = new Set<string>(KB_COMPONENT_TYPES);
  for (const component of list) {
    expect(
      known.has(component.type) || LOCAL_TYPES.has(component.type),
      `${component.type} is renderable`
    ).toBe(true);
  }
  // Every child reference resolves.
  const ids = new Set(list.map((c) => c.id));
  for (const component of list)
    for (const child of component.children ?? []) expect(ids.has(child)).toBe(true);
}

const renderList = (components: ChronosA2UIComponent[]) =>
  renderToStaticMarkup(
    createElement(A2UIRenderer, {
      components: expandChronosComponents(components) as never,
      fallback: CHRONOS_A2UI_FALLBACK,
      showUnknown: true,
    })
  );

describe('expandChronosComponents: display:* → kyberion-base', () => {
  it('display:hero → ui:next-action (+ status pill for canonical statuses, badge otherwise)', () => {
    const plain = one('display:hero', { eyebrow: 'Mission Control', title: 'Visible Missions' });
    expect(root(plain)).toMatchObject({
      type: 'ui:next-action',
      props: { eyebrow: 'Mission Control', title: 'Visible Missions', state: 'ready' },
    });

    const healthy = one('display:hero', {
      title: 'System Vital Signs',
      description: 'Mission load',
      status: 'healthy',
    });
    expect(root(healthy).type).toBe('ui:stack');
    expect(kids(healthy, 'x').map((c) => c.type)).toEqual(['ui:next-action', 'ui:status-pill']);
    expect(kids(healthy, 'x')[0].props).toMatchObject({ reason: 'Mission load' });
    expect(kids(healthy, 'x')[1].props).toEqual({ status: 'ready' });

    const count = one('display:hero', { title: 'Dashboard', status: '12 missions' });
    expect(kids(count, 'x')[1]).toMatchObject({
      type: 'ui:badge',
      props: { label: '12 missions', tone: 'neutral' },
    });
    expectRenderable(count);
  });

  it('display:table → ui:table with a Status column keyed for status pills', () => {
    const list = one('display:table', {
      title: 'Active Missions',
      headers: ['Mission', 'Status', 'Tier'],
      rows: [
        ['MSN-1', 'active', 'public'],
        ['MSN-2', 'ok', { nested: true }],
      ],
    });
    expect(root(list)).toMatchObject({
      type: 'ui:table',
      props: {
        caption: 'Active Missions',
        columns: [
          { key: 'c0', label: 'Mission' },
          { key: 'status', label: 'Status' },
          { key: 'c2', label: 'Tier' },
        ],
        rows: [
          { c0: 'MSN-1', status: 'active', c2: 'public' },
          { c0: 'MSN-2', status: 'ready', c2: '{"nested":true}' },
        ],
      },
    });
    // Row objects and rows wider than the headers still render.
    const wide = one('display:table', { headers: ['A'], rows: [{ a: 1, b: 2 }] });
    expect((root(wide).props as any).columns).toHaveLength(2);
    expect((root(wide).props as any).rows[0]).toEqual({ c0: 1, c1: 2 });
  });

  it('display:kv → ui:kv (titled blocks become a caption + block stack)', () => {
    const list = one('display:kv', {
      title: 'Readiness',
      entries: [
        { key: 'Tier', value: 'public' },
        { key: 'count', value: 3 },
      ],
    });
    expect(root(list).type).toBe('ui:stack');
    const [title, kv] = kids(list, 'x');
    expect(title).toMatchObject({
      type: 'ui:text',
      props: { text: 'Readiness', variant: 'caption' },
    });
    expect(kv).toMatchObject({
      type: 'ui:kv',
      props: {
        items: [
          { label: 'Tier', value: 'public', mono: true },
          { label: 'count', value: 3, mono: true },
        ],
      },
    });
    // Untitled → the kv itself keeps the id.
    expect(root(one('display:kv', { entries: [] })).type).toBe('ui:kv');
  });

  it('display:metric and display:metrics-row → ui:metric / ui:grid', () => {
    expect(
      root(one('display:metric', { label: 'missions', value: 4, unit: 'x', trend: 'up', extra: 1 }))
    ).toEqual({
      id: 'x',
      type: 'ui:metric',
      props: { label: 'missions', value: 4, unit: 'x', trend: 'up' },
    });
    const row = one('display:metrics-row', {
      metrics: [
        { label: 'a', value: 1 },
        { label: 'b', value: 2, trend: 'sideways' },
      ],
    });
    expect(root(row)).toMatchObject({ type: 'ui:grid', props: { columns: 2, gap: 'md' } });
    expect(kids(row, 'x').map((c) => c.props)).toEqual([
      { label: 'a', value: 1 },
      { label: 'b', value: 2 },
    ]);
  });

  it('display:status → ui:list item with a canonical status pill', () => {
    expect(
      root(one('display:status', { label: 'Next action', status: 'ok', detail: 'Go' }))
    ).toEqual({
      id: 'x',
      type: 'ui:list',
      props: { variant: 'plain', items: [{ title: 'Next action', meta: 'Go', status: 'ready' }] },
    });
    // Non-canonical status keeps its text in the meta line.
    expect(
      (root(one('display:status', { label: 'L', status: 'weird' })).props as any).items[0]
    ).toEqual({ title: 'L', meta: 'weird' });
  });

  it('display:alert → ui:callout (error → danger)', () => {
    expect(root(one('display:alert', { severity: 'error', title: 'T', message: 'M' }))).toEqual({
      id: 'x',
      type: 'ui:callout',
      props: { tone: 'danger', title: 'T', body: 'M' },
    });
    expect((root(one('display:alert', { severity: 'bogus', title: 'T' })).props as any).tone).toBe(
      'info'
    );
  });

  it('display:list and display:timeline → ui:list (plain / timeline)', () => {
    const list = one('display:list', {
      items: [{ label: 'a.md', detail: 'public', icon: '▸' }, { label: 'b.md' }],
    });
    expect(root(list)).toEqual({
      id: 'x',
      type: 'ui:list',
      props: { variant: 'plain', items: [{ title: 'a.md', meta: 'public' }, { title: 'b.md' }] },
    });
    const timeline = one('display:timeline', {
      title: 'Recent Audit Events',
      events: [
        { time: '10:00:00', label: 'approved', detail: 'MSN-1', status: 'ok' },
        { time: '10:01:00', label: 'failed', status: 'error' },
      ],
    });
    const [, body] = kids(timeline, 'x');
    expect(body).toMatchObject({
      type: 'ui:list',
      props: {
        variant: 'timeline',
        items: [
          { title: 'approved', meta: '10:00:00 · MSN-1', status: 'ready' },
          { title: 'failed', meta: '10:01:00', status: 'error' },
        ],
      },
    });
  });

  it('display:progress and display:gauge → ui:meter', () => {
    const progress = one('display:progress', {
      title: 'Pipeline',
      steps: [
        { label: 'a', status: 'done' },
        { label: 'b', status: 'active' },
        { label: 'c', status: 'pending' },
      ],
    });
    const [meter, steps] = kids(progress, 'x');
    expect(meter).toMatchObject({
      type: 'ui:meter',
      props: { label: 'Pipeline', value: 1, max: 3 },
    });
    expect((steps.props as any).items.map((i: any) => i.status)).toEqual([
      'done',
      'active',
      'pending',
    ]);
    const gauge = root(one('display:gauge', { label: 'CPU', value: 140, unit: '%' }));
    expect(gauge).toMatchObject({
      type: 'ui:meter',
      props: { label: 'CPU', value: 100, max: 100 },
    });
    expect((gauge.props as any).thresholds.map((t: any) => t.tone)).toEqual([
      'danger',
      'warning',
      'success',
    ]);
  });

  it('display:badges → ui:badge list with normalized tones', () => {
    const list = one('display:badges', {
      items: [
        { label: 'public/', tone: 'info' },
        { label: 'x', tone: 'neon' },
      ],
    });
    expect(root(list)).toMatchObject({
      type: 'ui:stack',
      props: { direction: 'horizontal', wrap: true },
    });
    expect(kids(list, 'x').map((c) => c.props)).toEqual([
      { label: 'public/', tone: 'info' },
      { label: 'x', tone: 'neutral' },
    ]);
  });

  it('display:section / display:card / display:grid nest their items as ui:* children', () => {
    const section = one('display:section', {
      title: 'Runtime Diagnostics',
      description: 'd',
      items: [
        { type: 'display:log', props: { title: 'Recent Events', lines: ['a', 'b'] } },
        { type: 'display:kv', props: { entries: [{ key: 'k', value: 'v' }] } },
      ],
    });
    expect(root(section)).toMatchObject({
      type: 'ui:section',
      props: { title: 'Runtime Diagnostics', description: 'd' },
    });
    const [log, kv] = kids(section, 'x');
    expect(log.type).toBe('ui:stack');
    expect(kids(section, log.id)[1]).toMatchObject({
      type: CHRONOS_CODE_TYPE,
      props: { code: 'a\nb', variant: 'log' },
    });
    expect(kv.type).toBe('ui:kv');
    expectRenderable(section);

    const card = one('display:card', { title: 'T', description: 'D', footer: 'F', icon: '📦' });
    expect(root(card)).toMatchObject({
      type: 'ui:section',
      props: { title: 'T', description: 'D' },
    });
    expect(kids(card, 'x')[0]).toMatchObject({
      type: 'ui:text',
      props: { text: 'F', variant: 'caption' },
    });

    const grid = one('display:grid', {
      cols: 3,
      children: [{ type: 'display:metric', props: { label: 'a', value: 1 } }, { nope: true }],
    });
    expect(root(grid)).toMatchObject({ type: 'ui:grid', props: { columns: 3 } });
    expect(kids(grid, 'x').map((c) => c.type)).toEqual(['ui:metric']);
  });

  it('display:code / display:log → chronos:code', () => {
    expect(root(one('display:code', { code: 'x = 1', language: 'ts' }))).toEqual({
      id: 'x',
      type: CHRONOS_CODE_TYPE,
      props: { code: 'x = 1', language: 'ts', variant: 'code' },
    });
    expect(root(one('display:log', { lines: ['l1', 2] })).props).toEqual({
      code: 'l1\n2',
      variant: 'log',
    });
  });

  it('chart types → shared ui:* charts', () => {
    expect(
      root(
        one('display:donut', {
          title: 'Agent Health',
          centerLabel: 'Agents',
          data: [
            { label: 'Ready', value: 3, color: '#34D399' },
            { label: 'Busy', value: '2' },
          ],
        })
      )
    ).toEqual({
      id: 'x',
      type: 'ui:donut',
      props: {
        title: 'Agent Health',
        center_label: 'Agents',
        segments: [
          { label: 'Ready', value: 3 },
          { label: 'Busy', value: 2 },
        ],
      },
    });
    expect(
      root(one('display:bar-chart', { data: [{ label: 'a', value: 1 }], unit: 'ms' }))
    ).toEqual({
      id: 'x',
      type: 'ui:bar-chart',
      props: { data: [{ label: 'a', value: 1 }], unit: 'ms', orientation: 'horizontal' },
    });
    expect(
      root(
        one('display:stacked-bar', {
          title: 'Board',
          data: [
            { label: 'done', value: 2 },
            { label: 'blocked', value: 0 },
            { label: 'review', value: 1 },
          ],
        })
      ).props
    ).toEqual({
      title: 'Board',
      categories: [''],
      series: [
        { name: 'done', values: [2] },
        { name: 'review', values: [1] },
      ],
      stacked: true,
      orientation: 'horizontal',
    });
    expect(root(one('display:sparkline', { title: 'Latency', points: [1, 'x', 3] }))).toEqual({
      id: 'x',
      type: 'ui:sparkline',
      props: { label: 'Latency', points: [1, null, 3], show_value: true },
    });
  });

  it('kb-layout-grid / kb-status-orbit / kb-mission-card → ui:grid / ui:flow / ui:section', () => {
    const grid = one('kb-layout-grid', {
      columns: 9,
      children: [{ type: 'kb-mission-card', props: { missionId: 'M', title: 'T', progress: 40 } }],
    });
    expect(root(grid)).toMatchObject({ type: 'ui:grid', props: { columns: 6 } });

    const orbit = root(
      one('kb-status-orbit', { currentPhase: 'state', status: 'running', label: 'Go' })
    );
    expect(orbit.type).toBe('ui:flow');
    expect((orbit.props as any).nodes.map((n: any) => n.status)).toEqual([
      'done',
      'done',
      'running',
      'planned',
    ]);

    const card = one('kb-mission-card', {
      missionId: 'MSN-1',
      title: 'Ship it',
      owner: 'agent-a',
      progress: 55,
      priority: 'critical',
    });
    expect(root(card)).toMatchObject({
      type: 'ui:section',
      props: { title: 'Ship it', description: 'agent-a' },
    });
    const [meta, meter] = kids(card, 'x');
    expect(kids(card, meta.id).map((c) => [c.type, c.props])).toEqual([
      ['ui:text', { text: 'MSN-1', variant: 'mono' }],
      ['ui:badge', { label: 'critical', tone: 'danger' }],
    ]);
    expect(meter).toMatchObject({ type: 'ui:meter', props: { value: 55, max: 100, unit: '%' } });
    expectRenderable(card);
  });

  it('covers every chronos type listed by surface-response-blocks', () => {
    const producerTypes = [
      'display:hero',
      'display:badges',
      'display:section',
      'display:gauge',
      'display:log',
      'display:table',
      'display:status',
      'display:kv',
      'display:metric',
      'display:metrics-row',
      'display:timeline',
      'display:progress',
      'display:alert',
      'display:code',
      'display:list',
      'display:card',
      'display:grid',
      'display:donut',
      'display:bar-chart',
      'display:stacked-bar',
      'display:sparkline',
      'kb-layout-grid',
      'kb-status-orbit',
      'kb-mission-card',
    ];
    expect([...CHRONOS_ADAPTED_TYPES].sort()).toEqual([...producerTypes].sort());
    for (const type of producerTypes) {
      // Empty props never throw and always yield renderable output.
      const list = one(type, {});
      expect(root(list)).toBeDefined();
      expectRenderable(list);
      expect(() => renderList([{ id: 'x', type, props: {} }])).not.toThrow();
    }
  });

  it('keeps A2UI child ids, passes catalog / unknown types through, and sanitizes props', () => {
    const list = expandChronosComponents([
      { id: 'sec', type: 'display:section', props: { title: 'S' }, children: ['t'] },
      { id: 't', type: 'ui:text', props: { text: 'hi<script>alert(1)</script>' } },
      { id: 'u', type: 'display:hologram', props: { onclick: 'x' } },
      { id: 'bad' } as never,
    ]);
    expect(byId(list, 'sec')!.children).toEqual(['t']);
    expect(byId(list, 't')!.props).toEqual({ text: 'hi' });
    expect(byId(list, 'u')).toEqual({ id: 'u', type: 'display:hologram', props: { onclick: 'x' } });
    expect(byId(list, 'bad')).toBeUndefined();
  });

  it('expanded ids never collide with caller ids', () => {
    const list = expandChronosComponents([
      { id: 'x/hero', type: 'ui:text', props: { text: 'mine' } },
      { id: 'x', type: 'display:hero', props: { title: 'T', status: 'ok' } },
    ]);
    const ids = list.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(byId(list, 'x/hero')!.props).toEqual({ text: 'mine' });
  });

  it('bounds nesting depth', () => {
    let item: Record<string, unknown> = {
      type: 'display:metric',
      props: { label: 'leaf', value: 1 },
    };
    for (let i = 0; i < 40; i += 1) item = { type: 'display:section', props: { items: [item] } };
    const list = one('display:section', { items: [item] });
    expect(list.length).toBeLessThan(40);
    expectRenderable(list);
  });

  it('maps chronos status words onto canonical statuses', () => {
    expect(toCanonicalStatus('ok')).toBe('ready');
    expect(toCanonicalStatus('warning')).toBe('degraded');
    expect(toCanonicalStatus('In Progress')).toBe('active');
    expect(toCanonicalStatus('blocked')).toBe('blocked');
    expect(toCanonicalStatus('12 missions')).toBeUndefined();
    expect(toCanonicalStatus(3)).toBeUndefined();
  });
});

describe('rendering through the shared renderer', () => {
  it('draws the headless operator-home projection with kb classes only', () => {
    const message = buildOperatorHomeA2UI({
      status: 'blocked',
      statusLabel: 'Needs attention',
      statusDetail: '1 blocked mission',
      counts: { activeMissions: 2, blockedMissions: 1, pendingApprovals: 0, unreadInbox: 3 },
      activeMissions: [
        { missionId: 'MSN-1', status: 'active', tier: 'public', tenantSlug: 'acme' },
      ],
      actionQueue: [{ title: 'Review', kind: 'approval', nextAction: 'open' }],
      nextAction: { title: 'Unblock MSN-1' },
    } as never);
    const components = (message as any).updateComponents.components;
    const html = renderList(components);
    for (const cls of ['kb-next-action', 'kb-metric', 'kb-list', 'kb-table', 'kb-status-pill'])
      expect(html).toContain(cls);
    expect(html).not.toMatch(/data-unknown-type/);
    expect(html).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(/i);
  });

  it('ChronosA2UIRenderer renders chronos-local leaves and degrades unknown types', () => {
    const html = renderToStaticMarkup(
      createElement(ChronosA2UIRenderer, {
        components: [
          { id: 'c', type: 'display:code', props: { code: 'const a = 1;' } },
          {
            id: 'p',
            type: 'kb-intervention-panel',
            props: {
              reason: 'Approve?',
              isBlocking: true,
              options: [{ label: 'Yes', variant: 'primary' }],
            },
          },
          {
            id: 'a',
            type: 'kb-artifact-tile',
            props: { type: 'md', path: 'out/report.md', previewContent: '# hi', missing: true },
          },
          { id: 'u', type: 'display:hologram', props: {} },
        ],
      })
    );
    expect(html).toContain('const a = 1;');
    expect(html).toContain('kb-callout');
    expect(html).toContain('kb-btn--primary');
    expect(html).toContain('report.md');
    expect(html).toContain('data-density="compact"');
    // Unknown types degrade to the shared notice (dev) instead of throwing.
    expect(html).toContain('data-unknown-type="display:hologram"');
  });
});
