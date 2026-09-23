// UI-01b: the renderer-independent chart layout (`charts.js`). Scales, ticks,
// stacking, DAG layering, sequence ordering, the vnode contract (no colors,
// role=img + localized aria-label, hidden data table, empty states) and the
// vanilla DOM build. React ↔ vanilla equality is covered by parity.test.tsx.
import { describe, expect, it } from 'vitest';
import { getUiMessageBundle } from '@agent/core';
import { KB_STATUS_TONES } from '@agent/core/a2ui-catalog';
import {
  KB_CHART_MESSAGE_KEYS,
  KB_CHART_STATUS_TONES,
  KB_CHART_TYPES,
  arcPath,
  barPath,
  divergingLevel,
  fitText,
  layerDag,
  layoutChart,
  linearScale,
  meterTone,
  niceStep,
  niceTicks,
  orderSequence,
  sequentialLevel,
  stackSeries,
  textWidth,
  type KbVElement,
  type KbVNode,
} from './charts.js';
import { createTranslator, renderComponent, statusLabel } from './kyberion-ui.js';
import { MiniDocument, type MiniElement } from './mini-dom.test-support.js';

const EN = getUiMessageBundle('en');
const JA = getUiMessageBundle('ja');

function envFor(bundle: { locale: string; messages: Record<string, string> }) {
  const t = createTranslator({ messages: bundle.messages });
  return {
    t,
    locale: bundle.locale,
    statusLabel: (status: string) => statusLabel(status, undefined, undefined, t),
  };
}

function layout(type: string, props: Record<string, unknown>, bundle = EN): KbVElement {
  const tree = layoutChart(type, props, envFor(bundle));
  expect(tree, type).not.toBeNull();
  return tree!;
}

function walk(node: KbVNode, visit: (node: KbVElement) => void): void {
  if ('text' in node) return;
  visit(node);
  for (const child of node.children) walk(child, visit);
}

function findAll(root: KbVNode, predicate: (node: KbVElement) => boolean): KbVElement[] {
  const out: KbVElement[] = [];
  walk(root, (node) => {
    if (predicate(node)) out.push(node);
  });
  return out;
}

const byClass = (name: string) => (node: KbVElement) =>
  (node.attrs.class || '').split(/\s+/).includes(name);

function textOf(node: KbVNode): string {
  if ('text' in node) return node.text;
  return node.children.map(textOf).join('');
}

// ---------------------------------------------------------------------------

describe('charts.js — scales and ticks', () => {
  it('niceStep picks 1 / 2 / 2.5 / 5 × 10^n', () => {
    expect(niceStep(100, 5)).toBe(20);
    expect(niceStep(10, 4)).toBe(2.5);
    expect(niceStep(0.9, 3)).toBeCloseTo(0.5);
    expect(niceStep(0)).toBe(1);
  });

  it('niceTicks covers the domain with round ticks (incl. negatives and flat data)', () => {
    expect(niceTicks(0, 87)).toEqual([0, 20, 40, 60, 80, 100]);
    expect(niceTicks(-3, 12)).toEqual([-5, 0, 5, 10, 15]);
    expect(niceTicks(0.1, 0.9, 4)).toEqual([0, 0.2, 0.4, 0.6, 0.8, 1]);
    expect(niceTicks(0, 9, 4)).toEqual([0, 2.5, 5, 7.5, 10]);
    expect(niceTicks(5, 5)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(niceTicks(0, 0)).toEqual([0, 0.2, 0.4, 0.6, 0.8, 1]);
    expect(niceTicks(-4, -4)[0]).toBeLessThanOrEqual(-4);
    expect(niceTicks(Number.NaN, 3)).toEqual([0, 1, 2, 3]);
  });

  it('linearScale maps linearly and a flat domain to the midpoint', () => {
    const y = linearScale([0, 10], [200, 0]);
    expect(y(0)).toBe(200);
    expect(y(5)).toBe(100);
    expect(linearScale([3, 3], [0, 100])(3)).toBe(50);
  });

  it('stacks positives up and negatives down, per series order', () => {
    expect(
      stackSeries([
        [3, -2, null],
        [4, 5, 1],
        [-1, -1, 2],
      ])
    ).toEqual([
      [[0, 3], [0, -2], null],
      [
        [3, 7],
        [0, 5],
        [0, 1],
      ],
      [
        [0, -1],
        [-2, -3],
        [1, 3],
      ],
    ]);
  });

  it('bins sequential (1..5) and diverging (1..5, 3 = midpoint) levels', () => {
    expect(sequentialLevel(0, 0, 10)).toBe(1);
    expect(sequentialLevel(10, 0, 10)).toBe(5);
    expect(sequentialLevel(5, 0, 10)).toBe(3);
    expect(sequentialLevel(null, 0, 10)).toBeNull();
    expect(divergingLevel(-10, 0, 10)).toBe(1);
    expect(divergingLevel(0, 0, 10)).toBe(3);
    expect(divergingLevel(10, 0, 10)).toBe(5);
    expect(divergingLevel(4, 0, 10)).toBe(4);
  });

  it('approximates text width (CJK = 1em) and truncates with an ellipsis', () => {
    expect(textWidth('ab', 10)).toBeCloseTo(12);
    expect(textWidth('承認', 10)).toBe(20);
    expect(fitText('Approvals waiting', 40, 10)).toMatch(/…$/u);
    expect(fitText('ok', 40, 10)).toBe('ok');
  });

  it('draws a 4px rounded data end and a square baseline', () => {
    expect(barPath(0, 0, 10, 50, 'top')).toBe('M0 50V4Q0 0 4 0H6Q10 0 10 4V50Z');
    expect(barPath(0, 0, 10, 50, 'none')).toBe('M0 0H10V50H0Z');
    expect(barPath(0, 0, 0, 50, 'top')).toBe('');
    expect(arcPath(100, 100, 96, 66, 0, Math.PI / 2)).toMatch(
      /^M100 4A96 96 0 0 1 196 100L166 100A66 66 0 0 0 100 34Z$/u
    );
  });

  it('meter tone is the highest threshold at or below the value', () => {
    const thresholds = [
      { value: 95, tone: 'danger' },
      { value: 80, tone: 'warning' },
    ];
    expect(meterTone(50, thresholds)).toBeNull();
    expect(meterTone(80, thresholds)).toBe('warning');
    expect(meterTone(99, thresholds)).toBe('danger');
    expect(meterTone(99, 'nope')).toBeNull();
  });
});

describe('charts.js — DAG layering (ui:flow)', () => {
  it('uses stages when every node has one (declared order first)', () => {
    const { layers, stageIds } = layerDag(
      [
        { id: 'a1', stage: 'agent' },
        { id: 'm', stage: 'mission' },
        { id: 't1', stage: 'task' },
      ],
      [],
      [{ id: 'mission' }, 'task']
    );
    expect(stageIds).toEqual(['mission', 'task', 'agent']);
    expect(layers).toEqual([['m'], ['t1'], ['a1']]);
  });

  it('otherwise layers by longest path, ignoring cycle-closing edges', () => {
    const { layers } = layerDag(
      [{ id: 'fetch' }, { id: 'parse' }, { id: 'validate' }, { id: 'enrich' }, { id: 'publish' }],
      [
        { from: 'fetch', to: 'parse' },
        { from: 'parse', to: 'validate' },
        { from: 'parse', to: 'enrich' },
        { from: 'validate', to: 'publish' },
        { from: 'enrich', to: 'publish' },
        { from: 'validate', to: 'fetch' },
        { from: 'fetch', to: 'publish' },
      ]
    );
    expect(layers).toEqual([['fetch'], ['parse'], ['validate', 'enrich'], ['publish']]);
    // A pure cycle still lays out (first node is the source).
    expect(
      layerDag(
        [{ id: 'a' }, { id: 'b' }],
        [
          { from: 'a', to: 'b' },
          { from: 'b', to: 'a' },
        ]
      ).layers
    ).toEqual([['a'], ['b']]);
  });

  it('orders a layer by barycenter (fewer crossings), deterministically', () => {
    const nodes = [{ id: 'p1' }, { id: 'p2' }, { id: 'c2' }, { id: 'c1' }];
    const edges = [
      { from: 'p1', to: 'c1' },
      { from: 'p2', to: 'c2' },
    ];
    const first = layerDag(nodes, edges).layers;
    expect(first).toEqual([
      ['p1', 'p2'],
      ['c1', 'c2'],
    ]);
    expect(layerDag(nodes, edges).layers).toEqual(first);
  });

  it('drops invalid nodes / edges and duplicate ids', () => {
    const { layers } = layerDag(
      [{ id: 'a' }, { id: 'a' }, { id: '' }, null as never, { id: 'b' }],
      [
        { from: 'a', to: 'missing' },
        { from: 'a', to: 'a' },
        { from: 'a', to: 'b' },
      ]
    );
    expect(layers).toEqual([['a'], ['b']]);
  });
});

describe('charts.js — sequence ordering (ui:sequence)', () => {
  it('keeps declared lanes first and appends referenced ids in first-appearance order', () => {
    const { lanes } = orderSequence(
      ['user', { id: 'agent', label: 'Claude' }],
      [
        { from: 'user', to: 'db', label: 'q' },
        { from: 'cache', to: 'agent', label: 'r' },
      ]
    );
    expect(lanes.map((lane) => lane.id)).toEqual(['user', 'agent', 'db', 'cache']);
    expect(lanes[1].label).toBe('Claude');
  });

  it('sorts by `at` only when every message has a comparable time (stable)', () => {
    const numeric = orderSequence(
      [],
      [
        { from: 'a', to: 'b', label: 'late', at: 30 },
        { from: 'a', to: 'b', label: 'early', at: 10 },
        { from: 'a', to: 'b', label: 'early-2', at: 10 },
      ]
    );
    expect(numeric.messages.map((m) => m.label)).toEqual(['early', 'early-2', 'late']);
    const iso = orderSequence(
      [],
      [
        { from: 'a', to: 'b', label: '2', at: '2026-09-23T10:00:00Z' },
        { from: 'a', to: 'b', label: '1', at: '2026-09-23T09:00:00Z' },
      ]
    );
    expect(iso.messages.map((m) => m.label)).toEqual(['1', '2']);
    // Clock strings are not comparable dates: input order is the timeline.
    const clock = orderSequence(
      [],
      [
        { from: 'a', to: 'b', label: 'x', at: '09:40' },
        { from: 'a', to: 'b', label: 'y', at: '09:02' },
        { from: 'a', to: '', label: 'dropped' },
      ]
    );
    expect(clock.messages.map((m) => m.label)).toEqual(['x', 'y']);
  });
});

// ---------------------------------------------------------------------------

const SAMPLES: Record<string, Record<string, unknown>> = {
  'ui:bar-chart': {
    title: 'Requests',
    categories: ['Mon', 'Tue', 'Wed'],
    series: [
      { name: 'Approved', values: [3, 5, null] },
      { name: 'Returned', values: [1, -2, 4] },
    ],
  },
  'ui:line-chart': {
    title: 'Active',
    series: [
      {
        name: 'This week',
        points: [
          { x: 'Mon', y: 1 },
          { x: 'Tue', y: 3 },
          { x: 'Wed', y: null },
        ],
      },
      {
        name: 'Last week',
        points: [
          { x: 'Mon', y: 2 },
          { x: 'Tue', y: 2 },
        ],
      },
    ],
    area: true,
  },
  'ui:donut': {
    title: 'Outcomes',
    segments: [
      { label: 'Done', value: 3 },
      { label: 'Failed', value: 1 },
    ],
  },
  'ui:sparkline': { label: 'Errors', points: [1, 2, null, 4] },
  'ui:heatmap': {
    title: 'Load',
    rows: ['Mon', 'Tue'],
    columns: ['9', '10'],
    values: [
      [1, 2],
      [null, 4],
    ],
  },
  'ui:meter': {
    label: 'Budget',
    value: 86,
    max: 100,
    thresholds: [{ value: 80, tone: 'warning' }],
  },
  'ui:sequence': {
    title: 'Hand-off',
    participants: ['user', 'agent'],
    messages: [
      { from: 'user', to: 'agent', label: 'Ask', status: 'done' },
      { from: 'agent', to: 'agent', label: 'Think', kind: 'note' },
      { from: 'agent', to: 'user', label: 'Answer', kind: 'reply' },
    ],
  },
  'ui:flow': {
    title: 'Mission',
    nodes: [
      { id: 'm', label: 'Mission', status: 'active' },
      { id: 't', label: 'Task', status: 'failed' },
    ],
    edges: [{ from: 'm', to: 't', label: 'plan' }],
  },
  'ui:stat-list': {
    title: 'Latency',
    items: [{ label: 'p95', value: 4.25, unit: 's', hint: 'fast' }],
  },
};

describe('charts.js — layout contract', () => {
  it('lays out exactly the chart catalog types', () => {
    expect([...KB_CHART_TYPES].sort()).toEqual(Object.keys(SAMPLES).sort());
    expect(layoutChart('ui:table', {}, envFor(EN))).toBeNull();
  });

  it('mirrors the catalog status → tone map', () => {
    expect(KB_CHART_STATUS_TONES).toEqual(KB_STATUS_TONES);
  });

  it('has en + ja text for every chart message key', () => {
    for (const key of Object.values(KB_CHART_MESSAGE_KEYS)) {
      expect(EN.messages[key], key).toMatch(/\S/u);
      expect(JA.messages[key], key).toMatch(/\S/u);
    }
  });

  for (const [type, props] of Object.entries(SAMPLES)) {
    it(`${type}: no inline colors, localized role=img label`, () => {
      const tree = layout(type, props);
      walk(tree, (node) => {
        for (const name of ['fill', 'stroke', 'color']) {
          expect(node.attrs[name], `${type} <${node.tag} ${name}>`).toBeUndefined();
        }
        // `style` is allowed only to carry non-color custom properties (e.g.
        // `--kb-chart-vbw`, which the charts CSS reads via a container query
        // so tick/label text stays readable however far the viewBox scales
        // down) — every visual/color property still comes from CSS classes.
        if (node.attrs.style !== undefined) {
          expect(node.attrs.style, `${type} <${node.tag} style>`).toMatch(/^--[\w-]+:[^;]+$/u);
        }
        for (const series of [node.attrs['data-series']].filter(Boolean)) {
          expect(Number(series)).toBeGreaterThanOrEqual(1);
          expect(Number(series)).toBeLessThanOrEqual(8);
        }
      });
      if (type === 'ui:stat-list') return;
      const img = findAll(tree, (node) => node.attrs.role === 'img');
      expect(img).toHaveLength(1);
      const label = img[0].attrs['aria-label'];
      expect(label).toMatch(/\S/u);
      expect(label).not.toMatch(/ui:chart_/u);
      const ja = findAll(layout(type, props, JA), (node) => node.attrs.role === 'img')[0];
      expect(ja.attrs['aria-label']).not.toBe(label);
    });
  }

  it('charts ship a hidden data table with every value', () => {
    const bar = layout('ui:bar-chart', SAMPLES['ui:bar-chart']);
    const table = findAll(bar, byClass('kb-chart__table'))[0];
    expect(table.tag).toBe('table');
    const rows = findAll(table, (node) => node.tag === 'tr');
    expect(rows).toHaveLength(4); // header + 3 categories
    expect(textOf(rows[0])).toBe('CategoryApprovedReturned');
    expect(textOf(rows[3])).toBe('Wed—4');
    for (const type of ['ui:line-chart', 'ui:donut', 'ui:heatmap', 'ui:sequence', 'ui:flow']) {
      expect(findAll(layout(type, SAMPLES[type]), byClass('kb-chart__table')), type).toHaveLength(
        1
      );
    }
  });

  it('legend only for >= 2 series; single series is named by the title', () => {
    expect(
      findAll(layout('ui:bar-chart', SAMPLES['ui:bar-chart']), byClass('kb-chart__legend'))
    ).toHaveLength(1);
    const single = layout('ui:bar-chart', { title: 'T', data: [{ label: 'a', value: 1 }] });
    expect(findAll(single, byClass('kb-chart__legend'))).toHaveLength(0);
    // Single series with few categories: direct value labels.
    expect(findAll(single, byClass('kb-chart__value')).map(textOf)).toEqual(['1']);
  });

  it('never cycles colors: more than 8 series draw 8, the table keeps all', () => {
    const series = Array.from({ length: 10 }, (_, i) => ({ name: `s${i + 1}`, values: [i + 1] }));
    const tree = layout('ui:bar-chart', { categories: ['a'], series });
    expect(findAll(tree, byClass('kb-chart__bar'))).toHaveLength(8);
    expect(findAll(tree, (node) => node.tag === 'th' && node.attrs.scope === 'col')).toHaveLength(
      11
    );
    const donut = layout('ui:donut', {
      segments: Array.from({ length: 11 }, (_, i) => ({ label: `p${i}`, value: 1 })),
    });
    const legendLabels = findAll(donut, byClass('kb-chart__legend-label')).map(textOf);
    expect(legendLabels).toHaveLength(8);
    expect(legendLabels[7]).toBe('Other');
  });

  it('stacked bars keep a 2px gap and round only the outer end', () => {
    const tree = layout('ui:bar-chart', {
      categories: ['a'],
      stacked: true,
      series: [
        { name: 'x', values: [2] },
        { name: 'y', values: [2] },
      ],
    });
    const [inner, outer] = findAll(tree, byClass('kb-chart__bar')).map((node) => node.attrs.d);
    expect(inner).not.toContain('Q');
    expect(outer).toContain('Q');
    // inner: M x top H .. V bottom (square); outer: M x bottom V .. (rounded top)
    const innerTop = Number(/^M[\d.]+ ([\d.]+)H/u.exec(inner)![1]);
    const outerBottom = Number(/^M[\d.]+ ([\d.]+)V/u.exec(outer)![1]);
    expect(innerTop - outerBottom).toBe(2);
  });

  it('sequence: replies dashed, self-message loop, status glyph + label', () => {
    const tree = layout('ui:sequence', SAMPLES['ui:sequence']);
    const kinds = findAll(tree, byClass('kb-chart__message')).map(
      (node) => node.attrs['data-kind']
    );
    expect(kinds).toEqual(['call', 'note', 'reply']);
    const self = findAll(tree, byClass('kb-chart__message'))[1];
    expect(self.tag).toBe('path');
    const status = findAll(tree, byClass('kb-chart__status'))[0];
    expect(status.attrs['data-tone']).toBe('success');
    expect(textOf(status)).toBe('✓ Done');
    const ja = findAll(
      layout('ui:sequence', SAMPLES['ui:sequence'], JA),
      byClass('kb-chart__status')
    )[0];
    expect(textOf(ja)).toBe(`✓ ${JA.messages['ui:status_done']}`);
  });

  it('sequence: rows with a status label get enough vertical room to not overlap the next row', () => {
    // Status text sits below the arrow (y+13, 11px, middle baseline) and the
    // next row's message label sits above its own arrow (y+rowH-9, 12px) —
    // at the base compact row height those two collide. Two consecutive
    // messages that both carry a status is the tightest case.
    const props = {
      participants: ['user', 'agent'],
      messages: [
        { from: 'user', to: 'agent', label: 'Ask', status: 'done' },
        { from: 'agent', to: 'user', label: 'Answer', status: 'failed' },
      ],
      density: 'compact',
    };
    const tree = layout('ui:sequence', props);
    const statuses = findAll(tree, byClass('kb-chart__status'));
    const labels = findAll(tree, byClass('kb-chart__message-label'));
    expect(statuses).toHaveLength(2);
    expect(labels).toHaveLength(2);
    const firstStatusY = Number(statuses[0].attrs.y);
    const secondLabelY = Number(labels[1].attrs.y);
    // 11px status (centered) needs its lower edge clear of the next row's
    // 12px label baseline; less than ~8px of raw y gap visually collides.
    expect(secondLabelY - firstStatusY).toBeGreaterThanOrEqual(8);
  });

  it('flow: node tone from the status vocabulary, never color alone', () => {
    const tree = layout('ui:flow', SAMPLES['ui:flow']);
    const nodes = findAll(tree, byClass('kb-chart__node'));
    expect(nodes.map((node) => node.attrs['data-tone'])).toEqual(['info', 'danger']);
    expect(findAll(nodes[1], byClass('kb-chart__node-status')).map(textOf)).toEqual(['✕ Failed']);
    expect(findAll(tree, byClass('kb-chart__edge-label')).map(textOf)).toEqual(['plan']);
  });

  it('flow: a back edge spanning layers routes below every node row it spans, not just its own ends', () => {
    // Publish pipeline (gallery sample): retry (validate -> fetch) spans the
    // "parse" layer and the 2-row "validate/enrich" layer. A back edge drawn
    // as a plain S-curve between the two ends can dip through "parse" before
    // it has descended — this asserts the routed path stays below every
    // spanned row instead.
    const tree = layout('ui:flow', {
      title: 'Publish pipeline',
      nodes: [
        { id: 'fetch', label: 'Fetch', status: 'done' },
        { id: 'parse', label: 'Parse', status: 'done' },
        { id: 'validate', label: 'Validate', status: 'failed' },
        { id: 'enrich', label: 'Enrich', meta: 'optional' },
        { id: 'publish', label: 'Publish', status: 'blocked' },
      ],
      edges: [
        { from: 'fetch', to: 'parse' },
        { from: 'parse', to: 'validate' },
        { from: 'parse', to: 'enrich' },
        { from: 'validate', to: 'publish' },
        { from: 'enrich', to: 'publish' },
        { from: 'validate', to: 'fetch', label: 'retry' },
      ],
    });
    const boxes = findAll(tree, byClass('kb-chart__node-box'));
    // Node order follows layer order: fetch, parse, validate, enrich, publish.
    const bottomOf = (box: KbVElement) => Number(box.attrs.y) + Number(box.attrs.height);
    const spannedBottoms = boxes.slice(0, 4).map(bottomOf); // fetch, parse, validate, enrich
    const maxSpannedBottom = Math.max(...spannedBottoms);

    const backEdge = findAll(tree, byClass('kb-chart__edge')).find(
      (edge) => edge.attrs['data-direction'] === 'back'
    )!;
    expect(backEdge).toBeDefined();
    const line = findAll(backEdge, byClass('kb-chart__edge-line'))[0];
    // Elbow routing (L/Q), not a smooth S-curve that only asymptotically dips.
    expect(line.attrs.d).not.toContain('C');
    const numbers = (line.attrs.d.match(/-?\d+(?:\.\d+)?/gu) || []).map(Number);
    // Coordinates alternate x, y for every M / L / Q command in this path.
    const ys = numbers.filter((_, i) => i % 2 === 1);
    // The routed path dips at least to `maxSpannedBottom + 18` — comfortably
    // below every node box the edge spans, never merely behind one.
    expect(Math.max(...ys)).toBeGreaterThanOrEqual(maxSpannedBottom + 18);
    // ...and it does not dip below "publish" (layer 3), which the edge never spans.
    const publishBottom = bottomOf(boxes[4]);
    expect(publishBottom).toBeLessThan(maxSpannedBottom + 18);
  });

  it('meter: glyph + state word when a threshold applies', () => {
    const tree = layout('ui:meter', SAMPLES['ui:meter']);
    expect(tree.attrs['data-tone']).toBe('warning');
    expect(textOf(findAll(tree, byClass('kb-meter__state'))[0])).toBe('!Near the limit · 86%');
    const fill = findAll(tree, byClass('kb-meter__fill'))[0];
    expect(fill.attrs.width).toBe('86%');
  });

  it('formats numbers for the locale and keeps units', () => {
    const tree = layout('ui:stat-list', { items: [{ label: 'n', value: 12345.678, unit: 'ms' }] });
    expect(textOf(findAll(tree, byClass('kb-stat-list__value'))[0])).toBe('12,345.68ms');
  });

  it('renders a localized empty state for empty or invalid data (never throws)', () => {
    const invalid: Record<string, unknown> = {
      'ui:bar-chart': { series: [] },
      'ui:line-chart': { series: [{ name: 'x', points: [{ x: 1, y: 'NaN' }] }] },
      'ui:donut': { segments: [{ label: 'x', value: -1 }] },
      'ui:sparkline': { points: 'nope' },
      'ui:heatmap': { rows: ['a'], columns: [], values: [] },
      'ui:meter': { value: null },
      'ui:sequence': { participants: [], messages: [] },
      'ui:flow': { nodes: [{ label: 'no id' }] },
      'ui:stat-list': { items: null },
    };
    for (const type of KB_CHART_TYPES) {
      for (const bundle of [EN, JA]) {
        const tree = layout(type, invalid[type] as Record<string, unknown>, bundle);
        expect(tree.attrs['data-empty'], type).toBe('true');
        const text = textOf(tree);
        expect(text, type).toContain(bundle.messages['ui:chart_empty']);
      }
    }
    expect(
      layout('ui:bar-chart', { series: [], empty: 'Nothing yet' }).children.map(textOf)
    ).toContain('Nothing yet');
    expect(() => layoutChart('ui:flow', null, envFor(EN))).not.toThrow();
  });
});

describe('charts.js — vanilla DOM build', () => {
  it('builds SVG in the SVG namespace and HTML elsewhere (no innerHTML)', () => {
    const document = new MiniDocument();
    const node = renderComponent(
      { id: 'c', type: 'ui:bar-chart', props: SAMPLES['ui:bar-chart'] },
      { document: document as unknown as Document, locale: JA.locale, messages: JA.messages }
    ) as unknown as MiniElement;
    expect(node.tagName).toBe('FIGURE');
    const svg = node.query('svg')!;
    expect(svg.namespaceURI).toBe('http://www.w3.org/2000/svg');
    expect(svg.getAttribute('role')).toBe('img');
    expect(svg.getAttribute('aria-label')).toContain('Requests');
    expect(svg.getAttribute('aria-label')).toContain('棒グラフ');
    const bar = svg.query('path.kb-chart__bar')!;
    expect(bar.namespaceURI).toBe('http://www.w3.org/2000/svg');
    expect(bar.query('title')!.namespaceURI).toBe('http://www.w3.org/2000/svg');
    const table = node.query('table.kb-chart__table')!;
    expect(table.namespaceURI).toBe('http://www.w3.org/1999/xhtml');
    expect(table.query('th')!.textContent).toBe(JA.messages['ui:chart_table_category']);
  });
});
