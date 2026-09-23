/*
 * Kyberion UI — chart & visualisation layout (UI-01b,
 * SURFACE_UI_UNIFICATION_PLAN_2026-09-23 §3.2).
 *
 * Renderer-independent: every `ui:*` chart type is laid out here ONCE, as a
 * virtual node tree
 *
 *     VNode = { tag, attrs?, children? } | { text }
 *
 * The vanilla renderer (`kyberion-ui.js`) turns it into DOM with
 * createElement / createElementNS (never innerHTML); the React renderer
 * (`src/charts/ChartView.tsx`) maps it to React elements. So geometry,
 * scales, ticks, stacking, DAG layering and sequence ordering exist in one
 * place and both renderers emit the same SVG by construction.
 *
 * Contract:
 *   - No colors here. Marks carry `data-series` (categorical slot 1..8),
 *     `data-level` (sequential step 1..5), `data-div` (diverging step 1..5)
 *     or `data-tone`; `kyberion-ui.charts.source.css` maps those to the
 *     `--kb-ui-viz-*` / status tokens (tokens.ui in brand-tokens/kyberion.json).
 *   - Categorical slots are assigned in fixed order and never cycled: at most
 *     8 series are drawn (a donut folds the rest into "Other"); the data
 *     table always lists everything.
 *   - Every chart is an `svg[role=img]` with a localized aria-label summary
 *     plus a visually hidden data `<table>`; identity is never color-only
 *     (legend with >= 2 series, direct labels, status glyph + label).
 *   - All default text goes through `env.t` (`ui:*` vocabulary keys).
 *   - Empty or invalid data renders a graceful empty state; never throws.
 */

// ---------------------------------------------------------------------------
// Public constants
// ---------------------------------------------------------------------------

/** Chart / visualisation catalog types laid out by this module (catalog order). */
export const KB_CHART_TYPES = Object.freeze([
  'ui:bar-chart',
  'ui:line-chart',
  'ui:donut',
  'ui:sparkline',
  'ui:heatmap',
  'ui:meter',
  'ui:sequence',
  'ui:flow',
  'ui:stat-list',
]);

/** Categorical slots (`--kb-ui-viz-cat-1..8`), sequential / diverging steps (`-seq-1..5`, `-div-1..5`). */
export const KB_VIZ_CATEGORICAL_SLOTS = 8;
export const KB_VIZ_SEQUENTIAL_STEPS = 5;
export const KB_VIZ_DIVERGING_STEPS = 5;

/** `ui:*` vocabulary keys of every chart default string. */
export const KB_CHART_MESSAGE_KEYS = Object.freeze({
  empty: 'ui:chart_empty',
  labelled: 'ui:chart_labelled',
  legend: 'ui:chart_legend',
  other: 'ui:chart_other',
  total: 'ui:chart_total',
  noValue: 'ui:chart_no_value',
  scaleLow: 'ui:chart_scale_low',
  scaleHigh: 'ui:chart_scale_high',
  summaryBar: 'ui:chart_summary_bar',
  summaryLine: 'ui:chart_summary_line',
  summaryDonut: 'ui:chart_summary_donut',
  summarySparkline: 'ui:chart_summary_sparkline',
  summaryHeatmap: 'ui:chart_summary_heatmap',
  summaryMeter: 'ui:chart_summary_meter',
  summarySequence: 'ui:chart_summary_sequence',
  summaryFlow: 'ui:chart_summary_flow',
  tableCategory: 'ui:chart_table_category',
  tableSeries: 'ui:chart_table_series',
  tableValue: 'ui:chart_table_value',
  tableShare: 'ui:chart_table_share',
  tablePoint: 'ui:chart_table_point',
  tableTime: 'ui:chart_table_time',
  tableFrom: 'ui:chart_table_from',
  tableTo: 'ui:chart_table_to',
  tableMessage: 'ui:chart_table_message',
  tableStatus: 'ui:chart_table_status',
  tableStep: 'ui:chart_table_step',
  tableStage: 'ui:chart_table_stage',
  tableNext: 'ui:chart_table_next',
  meterSuccess: 'ui:meter_state_success',
  meterWarning: 'ui:meter_state_warning',
  meterDanger: 'ui:meter_state_danger',
});

/**
 * Canonical status → tone (mirror of `KB_STATUS_TONES` in
 * `@agent/core/a2ui-catalog`; pinned equal by `charts.test.ts`). Used for the
 * status marks in `ui:sequence` / `ui:flow`, which are SVG, not pills.
 */
export const KB_CHART_STATUS_TONES = Object.freeze({
  ready: 'success',
  fully_automatable: 'success',
  connected: 'success',
  available: 'success',
  done: 'success',
  completed: 'success',
  recovered: 'success',
  running: 'success',
  active: 'info',
  connecting: 'info',
  working: 'info',
  busy: 'info',
  review: 'info',
  distilling: 'info',
  needs_clarification: 'warning',
  needs_external_assets: 'warning',
  needs_assets: 'warning',
  needs_setup: 'warning',
  missing_runtime_prerequisites: 'warning',
  needs_runtime_prerequisites: 'warning',
  pending: 'warning',
  degraded: 'warning',
  fallback: 'warning',
  paused: 'warning',
  stale: 'warning',
  blocked: 'danger',
  missing: 'danger',
  error: 'danger',
  unavailable: 'danger',
  failed: 'danger',
  disconnected: 'danger',
  offline: 'danger',
  'n/a': 'neutral',
  planned: 'neutral',
  archived: 'neutral',
  stopped: 'neutral',
});

/** Glyph per tone — the same characters the status pill draws via CSS. */
export const KB_TONE_GLYPHS = Object.freeze({
  success: '✓',
  info: '●',
  warning: '!',
  danger: '✕',
  neutral: '○',
});

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const isNum = (value) => typeof value === 'number' && Number.isFinite(value);

function str(value) {
  if (value === null || value === undefined) return '';
  return String(value);
}

/** Round to 2 decimals and print without trailing zeros (stable across renderers). */
export function fmtCoord(value) {
  const rounded = Math.round(value * 100) / 100;
  return String(Object.is(rounded, -0) ? 0 : rounded);
}

/** Element vnode; `undefined` / `null` / `false` attrs and children are dropped. */
function h(tag, attrs, ...children) {
  const clean = {};
  if (attrs) {
    for (const [key, value] of Object.entries(attrs)) {
      if (value === undefined || value === null || value === false) continue;
      clean[key] = typeof value === 'number' ? fmtCoord(value) : String(value);
    }
  }
  const kids = [];
  const push = (child) => {
    if (child === undefined || child === null || child === false || child === '') return;
    if (Array.isArray(child)) child.forEach(push);
    else if (typeof child === 'string' || typeof child === 'number')
      kids.push({ text: String(child) });
    else kids.push(child);
  };
  children.forEach(push);
  return { tag, attrs: clean, children: kids };
}

/**
 * Approximate rendered text width (no DOM measuring, so layout is identical
 * everywhere): wide (CJK / fullwidth) characters count 1em, others ~0.6em.
 */
export function textWidth(text, size = 12) {
  let width = 0;
  for (const ch of str(text)) {
    const code = ch.codePointAt(0) || 0;
    const wide =
      (code >= 0x1100 && code <= 0x115f) ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe30 && code <= 0xfe4f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6);
    width += wide ? size : size * 0.6;
  }
  return width;
}

/** Truncate `text` with an ellipsis so it fits `maxWidth` (approximate). */
export function fitText(text, maxWidth, size = 12) {
  const value = str(text);
  if (textWidth(value, size) <= maxWidth) return value;
  let out = '';
  for (const ch of value) {
    if (textWidth(`${out}${ch}…`, size) > maxWidth) break;
    out += ch;
  }
  return out ? `${out}…` : '';
}

function makeFormatter(locale) {
  let format;
  try {
    format = new Intl.NumberFormat(locale || 'en', { maximumFractionDigits: 2 });
  } catch {
    format = new Intl.NumberFormat('en', { maximumFractionDigits: 2 });
  }
  return (value) => (isNum(value) ? format.format(value) : '');
}

function makePercent(locale) {
  let format;
  try {
    format = new Intl.NumberFormat(locale || 'en', { style: 'percent', maximumFractionDigits: 0 });
  } catch {
    format = new Intl.NumberFormat('en', { style: 'percent', maximumFractionDigits: 0 });
  }
  return (ratio) => (isNum(ratio) ? format.format(ratio) : '');
}

function withUnit(text, unit) {
  return unit ? `${text}${unit}` : text;
}

function statusToneOf(status) {
  return typeof status === 'string' && hasOwn(KB_CHART_STATUS_TONES, status)
    ? KB_CHART_STATUS_TONES[status]
    : null;
}

// ---------------------------------------------------------------------------
// Scales, ticks, stacking (exported for tests)
// ---------------------------------------------------------------------------

/** A "nice" step (1, 2, 2.5, 5 × 10^n) splitting `span` into about `count` parts. */
export function niceStep(span, count = 5, integer = false) {
  if (!isNum(span) || span <= 0) return 1;
  const raw = span / Math.max(1, count);
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / magnitude;
  // Integer data (day numbers, counts) never gets 2.5-steps or fractions.
  const quarter = !(integer && magnitude < 10);
  const step = norm <= 1 ? 1 : norm <= 2 ? 2 : quarter && norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10;
  return integer ? Math.max(1, step * magnitude) : step * magnitude;
}

/**
 * Nice axis ticks covering [min, max]; the first / last tick are the domain.
 * A zero-width domain is widened to include 0 (or to [0, 1] at zero).
 */
export function niceTicks(min, max, count = 5, integer = false) {
  let lo = isNum(min) ? min : 0;
  let hi = isNum(max) ? max : 0;
  if (lo > hi) [lo, hi] = [hi, lo];
  if (lo === hi) {
    if (lo === 0) hi = 1;
    else if (lo > 0) lo = 0;
    else hi = 0;
  }
  const step = niceStep(hi - lo, count, integer);
  const start = Math.floor(lo / step + 1e-9) * step;
  const end = Math.ceil(hi / step - 1e-9) * step;
  const ticks = [];
  for (let index = 0; index <= 1000; index += 1) {
    const value = Number((start + index * step).toPrecision(12));
    if (value > end + step / 2) break;
    ticks.push(value);
  }
  return ticks;
}

/** Linear map from `domain` to `range`; a zero-width domain maps to the range midpoint. */
export function linearScale(domain, range) {
  const [d0, d1] = domain;
  const [r0, r1] = range;
  const span = d1 - d0;
  return (value) => (span === 0 ? (r0 + r1) / 2 : r0 + ((value - d0) / span) * (r1 - r0));
}

/**
 * Stack `values[series][category]`: positives grow up from 0, negatives down,
 * each in series order. Returns `[series][category] = [start, end]` (null for
 * a missing value).
 */
export function stackSeries(values) {
  const categories = Math.max(0, ...values.map((row) => row.length));
  const out = values.map(() => []);
  for (let c = 0; c < categories; c += 1) {
    let up = 0;
    let down = 0;
    values.forEach((row, s) => {
      const value = row[c];
      if (!isNum(value)) {
        out[s][c] = null;
      } else if (value >= 0) {
        out[s][c] = [up, up + value];
        up += value;
      } else {
        out[s][c] = [down, down + value];
        down += value;
      }
    });
  }
  return out;
}

/** Sequential step 1..5 for `value` within [min, max]. */
export function sequentialLevel(value, min, max) {
  if (!isNum(value)) return null;
  if (max <= min) return 3;
  const ratio = (value - min) / (max - min);
  return Math.min(KB_VIZ_SEQUENTIAL_STEPS, Math.max(1, Math.floor(ratio * 5) + 1));
}

/** Diverging step 1..5 (3 = neutral midpoint) for `value` around `mid`, scaled by `extent`. */
export function divergingLevel(value, mid, extent) {
  if (!isNum(value)) return null;
  if (!(extent > 0)) return 3;
  const ratio = (value - mid) / extent;
  if (ratio < -0.6) return 1;
  if (ratio < -0.2) return 2;
  if (ratio <= 0.2) return 3;
  if (ratio <= 0.6) return 4;
  return 5;
}

// ---------------------------------------------------------------------------
// DAG layering & sequence ordering (exported for tests)
// ---------------------------------------------------------------------------

/**
 * Layer a (possibly cyclic) graph left-to-right, deterministically.
 *   - When every node names a `stage`, layers are stages: the `stages` order
 *     first, then stages in first-appearance order.
 *   - Otherwise a node's layer is its longest path from a source; edges that
 *     close a cycle (back edges in input-order DFS) are ignored.
 * Within a layer, nodes start in input order and are then ordered by one
 * down-sweep and one up-sweep of the barycenter heuristic (ties keep input
 * order), which reduces edge crossings without any randomness.
 * @returns {{ layers: string[][], layerOf: Map<string, number>, stageIds: string[] }}
 */
export function layerDag(nodes, edges, stages = []) {
  const ids = [];
  const seen = new Set();
  const stageOf = new Map();
  for (const node of nodes) {
    if (!isRecord(node) || typeof node.id !== 'string' || !node.id || seen.has(node.id)) continue;
    seen.add(node.id);
    ids.push(node.id);
    if (typeof node.stage === 'string' && node.stage) stageOf.set(node.id, node.stage);
  }
  const order = new Map(ids.map((id, index) => [id, index]));
  const validEdges = edges.filter(
    (edge) => isRecord(edge) && seen.has(edge.from) && seen.has(edge.to) && edge.from !== edge.to
  );
  const preds = new Map(ids.map((id) => [id, []]));
  const succs = new Map(ids.map((id) => [id, []]));
  for (const edge of validEdges) {
    preds.get(edge.to).push(edge.from);
    succs.get(edge.from).push(edge.to);
  }

  const layerOf = new Map();
  let stageIds = [];
  if (ids.length > 0 && ids.every((id) => stageOf.has(id))) {
    const declared = stages
      .map((stage) => (typeof stage === 'string' ? stage : isRecord(stage) ? stage.id : null))
      .filter((stage) => typeof stage === 'string' && stage);
    stageIds = [...new Set([...declared, ...ids.map((id) => stageOf.get(id))])];
    const used = new Set(ids.map((id) => stageOf.get(id)));
    stageIds = stageIds.filter((stage) => used.has(stage));
    const stageIndex = new Map(stageIds.map((stage, index) => [stage, index]));
    for (const id of ids) layerOf.set(id, stageIndex.get(stageOf.get(id)));
  } else {
    // Back edges: found by an input-order DFS; ignored for layering.
    const state = new Map();
    const back = new Set();
    const visit = (id) => {
      state.set(id, 1);
      for (const next of succs.get(id)) {
        if (state.get(next) === 1) back.add(`${id}\u0000${next}`);
        else if (!state.has(next)) visit(next);
      }
      state.set(id, 2);
    };
    for (const id of ids) if (!state.has(id)) visit(id);
    const depth = new Map();
    const resolve = (id) => {
      if (depth.has(id)) return depth.get(id);
      depth.set(id, 0);
      let value = 0;
      for (const from of preds.get(id)) {
        if (back.has(`${from}\u0000${id}`)) continue;
        value = Math.max(value, resolve(from) + 1);
      }
      depth.set(id, value);
      return value;
    };
    for (const id of ids) layerOf.set(id, resolve(id));
  }

  const count = ids.length ? Math.max(...ids.map((id) => layerOf.get(id))) + 1 : 0;
  const layers = Array.from({ length: count }, () => []);
  for (const id of ids) layers[layerOf.get(id)].push(id);

  const position = new Map();
  const index = () => layers.forEach((layer) => layer.forEach((id, i) => position.set(id, i)));
  index();
  const sweep = (layer, neighbours) => {
    const keyed = layer.map((id) => {
      const refs = neighbours.get(id).filter((other) => position.has(other));
      const center = refs.length
        ? refs.reduce((sum, other) => sum + position.get(other), 0) / refs.length
        : position.get(id);
      return { id, center };
    });
    keyed.sort((a, b) => a.center - b.center || order.get(a.id) - order.get(b.id));
    return keyed.map((entry) => entry.id);
  };
  for (let l = 1; l < layers.length; l += 1) {
    layers[l] = sweep(layers[l], preds);
    index();
  }
  for (let l = layers.length - 2; l >= 0; l -= 1) {
    layers[l] = sweep(layers[l], succs);
    index();
  }
  return { layers, layerOf, stageIds };
}

function timeKey(value) {
  if (isNum(value)) return value;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed) && /\d{4}-\d{2}-\d{2}/.test(value)) return parsed;
  }
  return null;
}

/**
 * Resolve lanes and message order for a sequence diagram.
 *   - Lanes: declared participants in order, then any id a message references
 *     that was not declared, in first-appearance order.
 *   - Messages: input order, unless every message has a comparable `at`
 *     (all numbers or all ISO dates), then a stable sort by `at`. Messages
 *     with an empty `from` / `to` are dropped.
 */
export function orderSequence(participants, messages) {
  const lanes = [];
  const laneIndex = new Map();
  const addLane = (id, label) => {
    if (typeof id !== 'string' || !id || laneIndex.has(id)) return;
    laneIndex.set(id, lanes.length);
    lanes.push({ id, label: label || id });
  };
  for (const participant of participants) {
    if (typeof participant === 'string') addLane(participant, participant);
    else if (isRecord(participant)) addLane(participant.id, str(participant.label));
  }
  const rows = messages.filter(
    (message) =>
      isRecord(message) &&
      typeof message.from === 'string' &&
      message.from &&
      typeof message.to === 'string' &&
      message.to
  );
  for (const message of rows) {
    addLane(message.from, message.from);
    addLane(message.to, message.to);
  }
  const keys = rows.map((message) => timeKey(message.at));
  let ordered = rows.map((message, index) => ({ message, index }));
  if (rows.length > 1 && keys.every((key) => key !== null)) {
    ordered = ordered
      .map((entry) => ({ ...entry, key: keys[entry.index] }))
      .sort((a, b) => a.key - b.key || a.index - b.index);
  }
  return { lanes, laneIndex, messages: ordered.map((entry) => entry.message) };
}

// ---------------------------------------------------------------------------
// Shared building blocks
// ---------------------------------------------------------------------------

const FONT = 12;
const TICK_FONT = 11;

function titleOf(p) {
  return typeof p.title === 'string' && p.title.trim() ? p.title.trim() : '';
}

function ariaLabel(env, title, summary) {
  return title ? env.t(KB_CHART_MESSAGE_KEYS.labelled, { title, summary }) : summary;
}

function densityOf(p) {
  return p.density === 'compact' ? 'compact' : undefined;
}

function emptyChart(kind, p, env) {
  const title = titleOf(p);
  return h(
    'figure',
    { class: 'kb-chart', 'data-chart': kind, 'data-empty': 'true', 'data-density': densityOf(p) },
    title ? h('figcaption', { class: 'kb-chart__title' }, title) : null,
    h('p', { class: 'kb-chart__empty' }, str(p.empty) || env.t(KB_CHART_MESSAGE_KEYS.empty))
  );
}

function legend(env, items) {
  return h(
    'ul',
    { class: 'kb-chart__legend', 'aria-label': env.t(KB_CHART_MESSAGE_KEYS.legend) },
    items.map((item) =>
      h(
        'li',
        { class: 'kb-chart__legend-item' },
        h('span', {
          class: 'kb-chart__swatch',
          'data-series': item.slot,
          'data-level': item.level,
          'aria-hidden': 'true',
        }),
        h('span', { class: 'kb-chart__legend-label' }, item.label),
        item.value ? h('span', { class: 'kb-chart__legend-value' }, item.value) : null
      )
    )
  );
}

/** Visually hidden data table: `headers` + rows whose first cell is a row header. */
function dataTable(caption, headers, rows) {
  // Wrapped in a visually hidden block: a <table> box itself cannot be
  // clipped reliably (it grows to its content and can cause page scroll).
  return h(
    'div',
    { class: 'kb-chart__data' },
    h(
      'table',
      { class: 'kb-chart__table' },
      caption ? h('caption', null, caption) : null,
      h(
        'thead',
        null,
        h(
          'tr',
          null,
          headers.map((header) => h('th', { scope: 'col' }, header))
        )
      ),
      h(
        'tbody',
        null,
        rows.map((row) =>
          h(
            'tr',
            null,
            row.map((cell, index) =>
              index === 0 ? h('th', { scope: 'row' }, cell) : h('td', null, cell)
            )
          )
        )
      )
    )
  );
}

function chartFigure(kind, p, env, { summary, legendNode, svg, table, variant }) {
  const title = titleOf(p);
  return h(
    'figure',
    {
      class: 'kb-chart',
      'data-chart': kind,
      'data-variant': variant,
      'data-density': densityOf(p),
    },
    title ? h('figcaption', { class: 'kb-chart__title' }, title) : null,
    typeof p.description === 'string' && p.description
      ? h('p', { class: 'kb-chart__description' }, p.description)
      : null,
    legendNode,
    svg,
    table || null
  );
}

function svgRoot(width, height, label, className, ...children) {
  // Diagrams render at their natural size (1 viewBox unit = 1px) and scroll
  // sideways when wider than the container; plots scale with their viewBox.
  const natural = className === 'kb-chart__svg--diagram';
  return h(
    'svg',
    {
      class: className ? `kb-chart__svg ${className}` : 'kb-chart__svg',
      viewBox: `0 0 ${fmtCoord(width)} ${fmtCoord(height)}`,
      width: natural ? width : undefined,
      height: natural ? height : undefined,
      role: 'img',
      'aria-label': label,
      focusable: 'false',
    },
    ...children
  );
}

function tooltip(text) {
  return h('title', null, text);
}

/** Bar path with a 4px rounded data end (`top` / `bottom` / `left` / `right`), square at the baseline. */
export function barPath(x0, y0, x1, y1, end, radius = 4) {
  const w = x1 - x0;
  const hgt = y1 - y0;
  if (!(w > 0) || !(hgt > 0)) return '';
  const r = end === 'none' ? 0 : Math.min(radius, w / 2, hgt / 2);
  const c = fmtCoord;
  if (r <= 0) return `M${c(x0)} ${c(y0)}H${c(x1)}V${c(y1)}H${c(x0)}Z`;
  switch (end) {
    case 'top':
      return `M${c(x0)} ${c(y1)}V${c(y0 + r)}Q${c(x0)} ${c(y0)} ${c(x0 + r)} ${c(y0)}H${c(x1 - r)}Q${c(x1)} ${c(y0)} ${c(x1)} ${c(y0 + r)}V${c(y1)}Z`;
    case 'bottom':
      return `M${c(x0)} ${c(y0)}H${c(x1)}V${c(y1 - r)}Q${c(x1)} ${c(y1)} ${c(x1 - r)} ${c(y1)}H${c(x0 + r)}Q${c(x0)} ${c(y1)} ${c(x0)} ${c(y1 - r)}Z`;
    case 'right':
      return `M${c(x0)} ${c(y0)}H${c(x1 - r)}Q${c(x1)} ${c(y0)} ${c(x1)} ${c(y0 + r)}V${c(y1 - r)}Q${c(x1)} ${c(y1)} ${c(x1 - r)} ${c(y1)}H${c(x0)}Z`;
    case 'left':
      return `M${c(x1)} ${c(y0)}V${c(y1)}H${c(x0 + r)}Q${c(x0)} ${c(y1)} ${c(x0)} ${c(y1 - r)}V${c(y0 + r)}Q${c(x0)} ${c(y0)} ${c(x0 + r)} ${c(y0)}Z`;
    default:
      return `M${c(x0)} ${c(y0)}H${c(x1)}V${c(y1)}H${c(x0)}Z`;
  }
}

function numberList(values) {
  return Array.isArray(values) ? values.map((value) => (isNum(value) ? value : null)) : [];
}

// ---------------------------------------------------------------------------
// ui:bar-chart
// ---------------------------------------------------------------------------

/** Normalise bar props: `series[{name, values}]` + `categories`, or the `data[{label,value}]` shorthand. */
export function normalizeBarData(p) {
  if (Array.isArray(p.series) && p.series.some(isRecord)) {
    const series = p.series.filter(isRecord).map((entry, index) => ({
      name: str(entry.name) || `#${index + 1}`,
      values: numberList(entry.values),
    }));
    const length = Math.max(0, ...series.map((entry) => entry.values.length));
    const declared = Array.isArray(p.categories) ? p.categories.map(str) : [];
    const categories = Array.from({ length: Math.max(length, declared.length) }, (_, i) =>
      declared[i] !== undefined ? declared[i] : String(i + 1)
    );
    return { categories, series };
  }
  const data = Array.isArray(p.data) ? p.data.filter(isRecord) : [];
  return {
    categories: data.map((d) => str(d.label)),
    series: data.length
      ? [{ name: titleOf(p), values: data.map((d) => (isNum(d.value) ? d.value : null)) }]
      : [],
  };
}

function layoutBarChart(p, env) {
  const { categories, series } = normalizeBarData(p);
  const all = series.flatMap((entry) => entry.values.filter(isNum));
  if (categories.length === 0 || all.length === 0) return emptyChart('bar', p, env);
  const fmt = makeFormatter(env.locale);
  const unit = str(p.unit);
  const drawn = series.slice(0, KB_VIZ_CATEGORICAL_SLOTS);
  const stacked = p.stacked === true && drawn.length > 1;
  const horizontal = p.orientation === 'horizontal';
  const compact = p.density === 'compact';

  let lo = Math.min(0, ...all);
  let hi = Math.max(0, ...all);
  let stacks = null;
  if (stacked) {
    stacks = stackSeries(drawn.map((entry) => categories.map((_, c) => entry.values[c])));
    const ends = stacks.flatMap((row) => row.filter(Boolean).flatMap((pair) => pair));
    lo = Math.min(0, ...ends);
    hi = Math.max(0, ...ends);
  }
  const ticks = niceTicks(lo, hi, horizontal ? 4 : 5);
  const domain = [ticks[0], ticks[ticks.length - 1]];
  const tickLabels = ticks.map((tick) => withUnit(fmt(tick), unit));
  const showValues =
    p.show_values === true ||
    (p.show_values !== false && !stacked && drawn.length === 1 && categories.length <= 12);

  const marks = [];
  const grid = [];
  const labels = [];
  const valueLabels = [];
  const W = 560;
  let H;

  if (!horizontal) {
    H = compact ? 200 : 240;
    const left = Math.min(96, Math.max(...tickLabels.map((l) => textWidth(l, TICK_FONT)))) + 12;
    const top = showValues ? 20 : 12;
    const bottom = 28;
    const right = 8;
    const y = linearScale(domain, [H - bottom, top]);
    const x0 = left;
    const band = (W - left - right) / categories.length;
    const pad = Math.max(4, band * 0.2);
    const inner = Math.max(2, band - pad);
    const groups = stacked ? 1 : drawn.length;
    const barW = Math.min(48, Math.max(1, (inner - 2 * (groups - 1)) / groups));
    const groupW = barW * groups + 2 * (groups - 1);
    ticks.forEach((tick, i) => {
      const ty = y(tick);
      grid.push(
        h('line', {
          class: tick === 0 ? 'kb-chart__baseline' : 'kb-chart__grid',
          x1: left,
          x2: W - right,
          y1: ty,
          y2: ty,
        })
      );
      labels.push(
        h(
          'text',
          {
            class: 'kb-chart__tick',
            x: left - 6,
            y: ty,
            'text-anchor': 'end',
            'dominant-baseline': 'middle',
          },
          tickLabels[i]
        )
      );
    });
    if (!ticks.includes(0)) {
      grid.push(
        h('line', { class: 'kb-chart__baseline', x1: left, x2: W - right, y1: y(0), y2: y(0) })
      );
    }
    const every = Math.max(
      1,
      Math.ceil(categories.length / Math.max(1, Math.floor((W - left - right) / 44)))
    );
    categories.forEach((category, c) => {
      const cx = x0 + band * c + band / 2;
      if (c % every === 0) {
        labels.push(
          h(
            'text',
            {
              class: 'kb-chart__tick kb-chart__tick--category',
              x: cx,
              y: H - bottom + 16,
              'text-anchor': 'middle',
            },
            fitText(category, band * every - 4, TICK_FONT)
          )
        );
      }
      const gx = cx - groupW / 2;
      drawn.forEach((entry, s) => {
        const value = entry.values[c];
        if (!isNum(value)) return;
        const tip = `${drawn.length > 1 ? `${entry.name} · ` : ''}${category}: ${withUnit(fmt(value), unit)}`;
        let a;
        let b;
        let end;
        let bx;
        if (stacked) {
          const [s0, s1] = stacks[s][c];
          const isOuter = drawn.slice(s + 1).every((other) => {
            const v = other.values[c];
            return !isNum(v) || v === 0 || Math.sign(v) !== Math.sign(value);
          });
          const isInner = drawn.slice(0, s).every((other) => {
            const v = other.values[c];
            return !isNum(v) || v === 0 || Math.sign(v) !== Math.sign(value);
          });
          a = y(s0);
          b = y(s1);
          // 2px surface gap between stacked segments.
          if (!isInner) a += value >= 0 ? -2 : 2;
          end = isOuter ? (value >= 0 ? 'top' : 'bottom') : 'none';
          bx = gx;
        } else {
          a = y(0);
          b = y(value);
          end = value >= 0 ? 'top' : 'bottom';
          bx = gx + s * (barW + 2);
        }
        const d = barPath(bx, Math.min(a, b), bx + barW, Math.max(a, b), end);
        if (!d) return;
        marks.push(h('path', { class: 'kb-chart__bar', 'data-series': s + 1, d }, tooltip(tip)));
        if (showValues) {
          valueLabels.push(
            h(
              'text',
              {
                class: 'kb-chart__value',
                x: bx + barW / 2,
                y: value >= 0 ? b - 5 : b + 12,
                'text-anchor': 'middle',
              },
              withUnit(fmt(value), unit)
            )
          );
        }
      });
    });
  } else {
    const groups = stacked ? 1 : drawn.length;
    const rowH = compact ? Math.max(20, groups * 10 + 10) : Math.max(28, groups * 12 + 14);
    const top = 8;
    const bottom = 24;
    H = top + rowH * categories.length + bottom;
    const left = Math.min(160, Math.max(...categories.map((l) => textWidth(l, TICK_FONT)))) + 14;
    const right = showValues ? 56 : 16;
    const x = linearScale(domain, [left, W - right]);
    const pad = Math.max(4, rowH * 0.25);
    const inner = rowH - pad;
    const barH = Math.min(28, Math.max(2, (inner - 2 * (groups - 1)) / groups));
    const groupH = barH * groups + 2 * (groups - 1);
    ticks.forEach((tick, i) => {
      const tx = x(tick);
      grid.push(
        h('line', {
          class: tick === 0 ? 'kb-chart__baseline' : 'kb-chart__grid',
          x1: tx,
          x2: tx,
          y1: top,
          y2: H - bottom,
        })
      );
      labels.push(
        h(
          'text',
          { class: 'kb-chart__tick', x: tx, y: H - bottom + 16, 'text-anchor': 'middle' },
          tickLabels[i]
        )
      );
    });
    categories.forEach((category, c) => {
      const cy = top + rowH * c + rowH / 2;
      labels.push(
        h(
          'text',
          {
            class: 'kb-chart__tick kb-chart__tick--category',
            x: left - 8,
            y: cy,
            'text-anchor': 'end',
            'dominant-baseline': 'middle',
          },
          fitText(category, left - 14, TICK_FONT)
        )
      );
      const gy = cy - groupH / 2;
      drawn.forEach((entry, s) => {
        const value = entry.values[c];
        if (!isNum(value)) return;
        const tip = `${drawn.length > 1 ? `${entry.name} · ` : ''}${category}: ${withUnit(fmt(value), unit)}`;
        let a;
        let b;
        let end;
        let by;
        if (stacked) {
          const [s0, s1] = stacks[s][c];
          const isOuter = drawn.slice(s + 1).every((other) => {
            const v = other.values[c];
            return !isNum(v) || v === 0 || Math.sign(v) !== Math.sign(value);
          });
          const isInner = drawn.slice(0, s).every((other) => {
            const v = other.values[c];
            return !isNum(v) || v === 0 || Math.sign(v) !== Math.sign(value);
          });
          a = x(s0);
          b = x(s1);
          if (!isInner) a += value >= 0 ? 2 : -2;
          end = isOuter ? (value >= 0 ? 'right' : 'left') : 'none';
          by = gy;
        } else {
          a = x(0);
          b = x(value);
          end = value >= 0 ? 'right' : 'left';
          by = gy + s * (barH + 2);
        }
        const d = barPath(Math.min(a, b), by, Math.max(a, b), by + barH, end);
        if (!d) return;
        marks.push(h('path', { class: 'kb-chart__bar', 'data-series': s + 1, d }, tooltip(tip)));
        if (showValues) {
          valueLabels.push(
            h(
              'text',
              {
                class: 'kb-chart__value',
                x: value >= 0 ? b + 5 : b - 5,
                y: by + barH / 2,
                'text-anchor': value >= 0 ? 'start' : 'end',
                'dominant-baseline': 'middle',
              },
              withUnit(fmt(value), unit)
            )
          );
        }
      });
    });
  }

  const summary = env.t(KB_CHART_MESSAGE_KEYS.summaryBar, {
    categories: categories.length,
    series: series.length,
    min: withUnit(fmt(Math.min(...all)), unit),
    max: withUnit(fmt(Math.max(...all)), unit),
  });
  const title = titleOf(p);
  const headers = [
    env.t(KB_CHART_MESSAGE_KEYS.tableCategory),
    ...series.map((entry) => entry.name || env.t(KB_CHART_MESSAGE_KEYS.tableValue)),
  ];
  const rows = categories.map((category, c) => [
    category,
    ...series.map((entry) => (isNum(entry.values[c]) ? withUnit(fmt(entry.values[c]), unit) : '—')),
  ]);
  return chartFigure('bar', p, env, {
    summary,
    variant: [horizontal ? 'horizontal' : 'vertical', stacked ? 'stacked' : null]
      .filter(Boolean)
      .join(' '),
    legendNode:
      series.length > 1
        ? legend(
            env,
            drawn.map((entry, s) => ({ slot: s + 1, label: entry.name }))
          )
        : null,
    svg: svgRoot(
      W,
      H,
      ariaLabel(env, title, summary),
      null,
      h('g', { class: 'kb-chart__axes', 'aria-hidden': 'true' }, grid, labels),
      h('g', { class: 'kb-chart__marks' }, marks),
      valueLabels.length
        ? h('g', { class: 'kb-chart__labels', 'aria-hidden': 'true' }, valueLabels)
        : null
    ),
    table: dataTable(title, headers, rows),
  });
}

// ---------------------------------------------------------------------------
// ui:line-chart
// ---------------------------------------------------------------------------

function normalizeLineSeries(p) {
  const series = Array.isArray(p.series) ? p.series.filter(isRecord) : [];
  return series.map((entry, index) => ({
    name: str(entry.name) || `#${index + 1}`,
    points: (Array.isArray(entry.points) ? entry.points : [])
      .map((point, i) =>
        isRecord(point)
          ? {
              x: typeof point.x === 'number' || typeof point.x === 'string' ? point.x : i,
              y: isNum(point.y) ? point.y : null,
            }
          : isNum(point)
            ? { x: i, y: point }
            : null
      )
      .filter(Boolean),
  }));
}

function layoutLineChart(p, env) {
  const series = normalizeLineSeries(p);
  const all = series.flatMap((entry) => entry.points.map((point) => point.y).filter(isNum));
  if (all.length === 0) return emptyChart('line', p, env);
  const fmt = makeFormatter(env.locale);
  const unit = str(p.y_unit ?? p.unit);
  const drawn = series.slice(0, KB_VIZ_CATEGORICAL_SLOTS);
  const compact = p.density === 'compact';
  const area = p.area === true;
  const W = 560;
  const H = compact ? 200 : 240;

  const numericX = drawn.every((entry) => entry.points.every((point) => isNum(point.x)));
  const xKeys = [];
  if (!numericX) {
    const seen = new Set();
    for (const entry of drawn) {
      for (const point of entry.points) {
        const key = str(point.x);
        if (!seen.has(key)) {
          seen.add(key);
          xKeys.push(key);
        }
      }
    }
  }
  const xs = numericX ? drawn.flatMap((entry) => entry.points.map((point) => point.x)) : [];

  const lo = Math.min(...all);
  const hi = Math.max(...all);
  const ticks = niceTicks(area || lo >= 0 ? Math.min(0, lo) : lo, Math.max(area ? 0 : hi, hi), 5);
  const domain = [ticks[0], ticks[ticks.length - 1]];
  const tickLabels = ticks.map((tick) => withUnit(fmt(tick), unit));
  const direct = drawn.length > 1 && drawn.length <= 4;
  const left = Math.min(96, Math.max(...tickLabels.map((l) => textWidth(l, TICK_FONT)))) + 12;
  const right = direct
    ? Math.min(120, Math.max(...drawn.map((entry) => textWidth(entry.name, TICK_FONT)))) + 14
    : 16;
  const top = 12;
  const bottom = 28;
  const y = linearScale(domain, [H - bottom, top]);
  let x;
  let xTicks;
  if (numericX) {
    const xt = niceTicks(Math.min(...xs), Math.max(...xs), 6, xs.every(Number.isInteger));
    const exact = [Math.min(...xs), Math.max(...xs)];
    x = linearScale(exact[0] === exact[1] ? [exact[0] - 1, exact[0] + 1] : exact, [
      left,
      W - right,
    ]);
    xTicks = xt
      .filter((tick) => tick >= exact[0] && tick <= exact[1])
      .map((tick) => ({ at: x(tick), label: fmt(tick) }));
  } else {
    const step = xKeys.length > 1 ? (W - left - right) / (xKeys.length - 1) : 0;
    const pos = new Map(
      xKeys.map((key, i) => [key, xKeys.length > 1 ? left + step * i : (left + W - right) / 2])
    );
    x = (value) => pos.get(str(value));
    const maxLabel = Math.max(...xKeys.map((key) => textWidth(key, TICK_FONT)));
    const every = Math.max(
      1,
      Math.ceil((xKeys.length * (maxLabel + 10)) / Math.max(1, W - left - right))
    );
    xTicks = xKeys
      .map((key, i) => ({ key, i }))
      .filter(({ i }) => i % every === 0)
      .map(({ key }) => ({
        at: x(key),
        label: fitText(key, Math.max(24, step * every - 4), TICK_FONT),
      }));
  }

  const grid = [];
  const labels = [];
  ticks.forEach((tick, i) => {
    const ty = y(tick);
    grid.push(
      h('line', {
        class: tick === 0 ? 'kb-chart__baseline' : 'kb-chart__grid',
        x1: left,
        x2: W - right,
        y1: ty,
        y2: ty,
      })
    );
    labels.push(
      h(
        'text',
        {
          class: 'kb-chart__tick',
          x: left - 6,
          y: ty,
          'text-anchor': 'end',
          'dominant-baseline': 'middle',
        },
        tickLabels[i]
      )
    );
  });
  for (const tick of xTicks) {
    labels.push(
      h(
        'text',
        { class: 'kb-chart__tick', x: tick.at, y: H - bottom + 16, 'text-anchor': 'middle' },
        tick.label
      )
    );
  }

  const areas = [];
  const lines = [];
  const points = [];
  const ends = [];
  const baseY = y(Math.max(domain[0], Math.min(0, domain[1])));
  drawn.forEach((entry, s) => {
    const segments = [];
    let current = [];
    for (const point of entry.points) {
      if (!isNum(point.y)) {
        if (current.length) segments.push(current);
        current = [];
        continue;
      }
      current.push({ px: x(point.x), py: y(point.y), point });
    }
    if (current.length) segments.push(current);
    const d = segments
      .map((segment) =>
        segment
          .map((pt, i) => `${i === 0 ? 'M' : 'L'}${fmtCoord(pt.px)} ${fmtCoord(pt.py)}`)
          .join('')
      )
      .join('');
    if (area) {
      for (const segment of segments) {
        const first = segment[0];
        const last = segment[segment.length - 1];
        const path = `${segment.map((pt, i) => `${i === 0 ? 'M' : 'L'}${fmtCoord(pt.px)} ${fmtCoord(pt.py)}`).join('')}L${fmtCoord(last.px)} ${fmtCoord(baseY)}L${fmtCoord(first.px)} ${fmtCoord(baseY)}Z`;
        areas.push(h('path', { class: 'kb-chart__area', 'data-series': s + 1, d: path }));
      }
    }
    if (d) lines.push(h('path', { class: 'kb-chart__line', 'data-series': s + 1, d }));
    const flat = segments.flat();
    const markerAll = flat.length <= 16;
    flat.forEach((pt, i) => {
      if (!markerAll && i !== flat.length - 1) return;
      points.push(
        h(
          'circle',
          { class: 'kb-chart__point', 'data-series': s + 1, cx: pt.px, cy: pt.py, r: 4 },
          tooltip(
            `${drawn.length > 1 ? `${entry.name} · ` : ''}${str(pt.point.x)}: ${withUnit(fmt(pt.point.y), unit)}`
          )
        )
      );
    });
    if (direct && flat.length) {
      const last = flat[flat.length - 1];
      ends.push({ name: entry.name, slot: s + 1, x: last.px, y: last.py });
    }
  });
  // Direct end labels: sorted by y, pushed apart to >= 13px, kept in the plot.
  ends.sort((a, b) => a.y - b.y || a.slot - b.slot);
  for (let i = 1; i < ends.length; i += 1) ends[i].y = Math.max(ends[i].y, ends[i - 1].y + 13);
  const overflow = ends.length ? ends[ends.length - 1].y - (H - bottom) : 0;
  if (overflow > 0) ends.forEach((end) => (end.y -= overflow));
  const endLabels = ends.map((end) =>
    h(
      'text',
      {
        class: 'kb-chart__direct-label',
        'data-series': end.slot,
        x: W - right + 8,
        y: end.y,
        'dominant-baseline': 'middle',
      },
      fitText(end.name, right - 10, TICK_FONT)
    )
  );

  const pointCount = Math.max(...series.map((entry) => entry.points.length));
  const summary = env.t(KB_CHART_MESSAGE_KEYS.summaryLine, {
    series: series.length,
    points: pointCount,
    min: withUnit(fmt(lo), unit),
    max: withUnit(fmt(hi), unit),
  });
  const title = titleOf(p);
  const rowKeys = numericX
    ? [...new Set(series.flatMap((entry) => entry.points.map((point) => point.x)))].sort(
        (a, b) => a - b
      )
    : [...new Set(series.flatMap((entry) => entry.points.map((point) => str(point.x))))];
  const rows = rowKeys.map((key) => [
    numericX ? fmt(key) : key,
    ...series.map((entry) => {
      const point = entry.points.find((pt) => (numericX ? pt.x === key : str(pt.x) === key));
      return point && isNum(point.y) ? withUnit(fmt(point.y), unit) : '—';
    }),
  ]);
  return chartFigure('line', p, env, {
    summary,
    variant: area ? 'area' : undefined,
    legendNode:
      series.length > 1
        ? legend(
            env,
            drawn.map((entry, s) => ({ slot: s + 1, label: entry.name }))
          )
        : null,
    svg: svgRoot(
      W,
      H,
      ariaLabel(env, title, summary),
      null,
      h('g', { class: 'kb-chart__axes', 'aria-hidden': 'true' }, grid, labels),
      h('g', { class: 'kb-chart__marks' }, areas, lines, points),
      endLabels.length
        ? h('g', { class: 'kb-chart__labels', 'aria-hidden': 'true' }, endLabels)
        : null
    ),
    table: dataTable(
      title,
      [env.t(KB_CHART_MESSAGE_KEYS.tablePoint), ...series.map((entry) => entry.name)],
      rows
    ),
  });
}

// ---------------------------------------------------------------------------
// ui:donut
// ---------------------------------------------------------------------------

function polar(cx, cy, r, angle) {
  return [cx + r * Math.sin(angle), cy - r * Math.cos(angle)];
}

/** Ring segment path between angles a0..a1 (radians, clockwise from 12 o'clock). */
export function arcPath(cx, cy, outer, inner, a0, a1) {
  const c = fmtCoord;
  const large = a1 - a0 > Math.PI ? 1 : 0;
  const [ox0, oy0] = polar(cx, cy, outer, a0);
  const [ox1, oy1] = polar(cx, cy, outer, a1);
  const [ix1, iy1] = polar(cx, cy, inner, a1);
  const [ix0, iy0] = polar(cx, cy, inner, a0);
  return `M${c(ox0)} ${c(oy0)}A${c(outer)} ${c(outer)} 0 ${large} 1 ${c(ox1)} ${c(oy1)}L${c(ix1)} ${c(iy1)}A${c(inner)} ${c(inner)} 0 ${large} 0 ${c(ix0)} ${c(iy0)}Z`;
}

function layoutDonut(p, env) {
  const source = Array.isArray(p.segments) ? p.segments : Array.isArray(p.data) ? p.data : [];
  const entries = source
    .filter((d) => isRecord(d) && isNum(d.value) && d.value > 0)
    .map((d) => ({ label: str(d.label), value: d.value }));
  if (entries.length === 0) return emptyChart('donut', p, env);
  const fmt = makeFormatter(env.locale);
  const pct = makePercent(env.locale);
  const unit = str(p.unit);
  const total = entries.reduce((sum, d) => sum + d.value, 0);
  let segments = entries;
  if (entries.length > KB_VIZ_CATEGORICAL_SLOTS) {
    const kept = entries.slice(0, KB_VIZ_CATEGORICAL_SLOTS - 1);
    const rest = entries.slice(KB_VIZ_CATEGORICAL_SLOTS - 1).reduce((sum, d) => sum + d.value, 0);
    segments = [...kept, { label: env.t(KB_CHART_MESSAGE_KEYS.other), value: rest }];
  }
  const size = 200;
  const cx = size / 2;
  const outer = 96;
  const inner = 66;
  const arcs = [];
  let angle = 0;
  segments.forEach((segment, i) => {
    const sweep = (segment.value / total) * Math.PI * 2;
    const tip = `${segment.label}: ${withUnit(fmt(segment.value), unit)} (${pct(segment.value / total)})`;
    if (segments.length === 1) {
      arcs.push(
        h(
          'path',
          {
            class: 'kb-chart__arc',
            'data-series': 1,
            d: `${arcPath(cx, cx, outer, inner, 0, Math.PI)}${arcPath(cx, cx, outer, inner, Math.PI, Math.PI * 2)}`,
          },
          tooltip(tip)
        )
      );
    } else {
      arcs.push(
        h(
          'path',
          {
            class: 'kb-chart__arc',
            'data-series': i + 1,
            d: arcPath(cx, cx, outer, inner, angle, angle + sweep),
          },
          tooltip(tip)
        )
      );
    }
    angle += sweep;
  });
  const top = segments.reduce((best, d) => (d.value > best.value ? d : best), segments[0]);
  const summary = env.t(KB_CHART_MESSAGE_KEYS.summaryDonut, {
    count: entries.length,
    total: withUnit(fmt(total), unit),
    top: top.label,
    share: pct(top.value / total),
  });
  const title = titleOf(p);
  const centerValue =
    p.center_value !== undefined ? str(p.center_value) : withUnit(fmt(total), unit);
  const centerLabel =
    p.center_label !== undefined ? str(p.center_label) : env.t(KB_CHART_MESSAGE_KEYS.total);
  return chartFigure('donut', p, env, {
    summary,
    legendNode: legend(
      env,
      segments.map((segment, i) => ({
        slot: i + 1,
        label: segment.label,
        value: `${withUnit(fmt(segment.value), unit)} · ${pct(segment.value / total)}`,
      }))
    ),
    svg: svgRoot(
      size,
      size,
      ariaLabel(env, title, summary),
      'kb-chart__svg--donut',
      h('g', { class: 'kb-chart__marks' }, arcs),
      h(
        'g',
        { class: 'kb-chart__center', 'aria-hidden': 'true' },
        h(
          'text',
          {
            class: 'kb-chart__center-value',
            x: cx,
            y: centerLabel ? cx - 2 : cx,
            'text-anchor': 'middle',
            'dominant-baseline': centerLabel ? 'auto' : 'middle',
          },
          fitText(centerValue, inner * 1.7, 24)
        ),
        centerLabel
          ? h(
              'text',
              { class: 'kb-chart__center-label', x: cx, y: cx + 18, 'text-anchor': 'middle' },
              fitText(centerLabel, inner * 1.6, FONT)
            )
          : null
      )
    ),
    table: dataTable(
      title,
      [
        env.t(KB_CHART_MESSAGE_KEYS.tableCategory),
        env.t(KB_CHART_MESSAGE_KEYS.tableValue),
        env.t(KB_CHART_MESSAGE_KEYS.tableShare),
      ],
      entries.map((d) => [d.label, withUnit(fmt(d.value), unit), pct(d.value / total)])
    ),
  });
}

// ---------------------------------------------------------------------------
// ui:sparkline
// ---------------------------------------------------------------------------

const TONES = ['neutral', 'accent', 'info', 'success', 'warning', 'danger'];

function layoutSparkline(p, env) {
  const values = (Array.isArray(p.points) ? p.points : []).map((point) =>
    isNum(point) ? point : isRecord(point) && isNum(point.y) ? point.y : null
  );
  const numeric = values.filter(isNum);
  const tone = TONES.includes(p.tone) ? p.tone : 'accent';
  const label = str(p.label);
  if (numeric.length === 0) {
    return h(
      'span',
      { class: 'kb-sparkline', 'data-empty': 'true', 'data-tone': tone },
      h(
        'span',
        { class: 'kb-sparkline__empty' },
        str(p.empty) || env.t(KB_CHART_MESSAGE_KEYS.empty)
      )
    );
  }
  const fmt = makeFormatter(env.locale);
  const unit = str(p.unit);
  const W = 120;
  const H = 32;
  const pad = 4;
  const lo = Math.min(...numeric);
  const hi = Math.max(...numeric);
  const x = linearScale([0, Math.max(1, values.length - 1)], [pad, W - pad]);
  const y = linearScale(lo === hi ? [lo - 1, hi + 1] : [lo, hi], [H - pad, pad]);
  let d = '';
  let pen = false;
  values.forEach((value, i) => {
    if (!isNum(value)) {
      pen = false;
      return;
    }
    d += `${pen ? 'L' : 'M'}${fmtCoord(x(i))} ${fmtCoord(y(value))}`;
    pen = true;
  });
  const lastIndex = values
    .map((v, i) => (isNum(v) ? i : -1))
    .filter((i) => i >= 0)
    .pop();
  const last = values[lastIndex];
  const summary = env.t(KB_CHART_MESSAGE_KEYS.summarySparkline, {
    count: numeric.length,
    first: withUnit(fmt(numeric[0]), unit),
    last: withUnit(fmt(last), unit),
    min: withUnit(fmt(lo), unit),
    max: withUnit(fmt(hi), unit),
  });
  return h(
    'span',
    { class: 'kb-sparkline', 'data-tone': tone },
    h(
      'svg',
      {
        class: 'kb-sparkline__svg',
        viewBox: `0 0 ${W} ${H}`,
        role: 'img',
        'aria-label': label
          ? env.t(KB_CHART_MESSAGE_KEYS.labelled, { title: label, summary })
          : summary,
        focusable: 'false',
      },
      h('path', { class: 'kb-sparkline__line', d }),
      h('circle', { class: 'kb-sparkline__point', cx: x(lastIndex), cy: y(last), r: 3 })
    ),
    p.show_value === true
      ? h('span', { class: 'kb-sparkline__value' }, withUnit(fmt(last), unit))
      : null
  );
}

// ---------------------------------------------------------------------------
// ui:heatmap
// ---------------------------------------------------------------------------

function layoutHeatmap(p, env) {
  const rows = Array.isArray(p.rows) ? p.rows.map(str) : [];
  const columns = Array.isArray(p.columns) ? p.columns.map(str) : [];
  const values = Array.isArray(p.values) ? p.values.map((row) => numberList(row)) : [];
  const all = values.flat().filter(isNum);
  if (rows.length === 0 || columns.length === 0 || all.length === 0)
    return emptyChart('heatmap', p, env);
  const fmt = makeFormatter(env.locale);
  const unit = str(p.unit);
  const diverging = p.scale === 'diverging';
  const lo = Math.min(...all);
  const hi = Math.max(...all);
  const mid = isNum(p.midpoint) ? p.midpoint : 0;
  const extent = Math.max(Math.abs(lo - mid), Math.abs(hi - mid));
  const seqMin = Math.min(0, lo);
  const levelOf = (value) =>
    diverging ? divergingLevel(value, mid, extent) : sequentialLevel(value, seqMin, hi);
  const compact = p.density === 'compact';
  const W = 560;
  const left = Math.min(120, Math.max(...rows.map((r) => textWidth(r, TICK_FONT)))) + 16;
  const top = 22;
  const cellW = Math.min(56, (W - left - 4) / columns.length);
  const cellH = compact ? 20 : 26;
  const H = top + cellH * rows.length + 4;
  const every = Math.max(
    1,
    Math.ceil(Math.max(...columns.map((c) => textWidth(c, TICK_FONT))) / Math.max(1, cellW - 4))
  );
  const labels = [];
  columns.forEach((column, c) => {
    if (c % every !== 0) return;
    labels.push(
      h(
        'text',
        {
          class: 'kb-chart__tick',
          x: left + cellW * c + cellW / 2,
          y: top - 8,
          'text-anchor': 'middle',
        },
        fitText(column, cellW * every - 2, TICK_FONT)
      )
    );
  });
  const cells = [];
  const cellLabels = [];
  const showValues = p.show_values === true && cellW >= 28;
  rows.forEach((row, r) => {
    const cy = top + cellH * r;
    labels.push(
      h(
        'text',
        {
          class: 'kb-chart__tick kb-chart__tick--category',
          x: left - 8,
          y: cy + cellH / 2,
          'text-anchor': 'end',
          'dominant-baseline': 'middle',
        },
        fitText(row, left - 8, TICK_FONT)
      )
    );
    columns.forEach((column, c) => {
      const value = values[r] ? values[r][c] : null;
      const level = levelOf(value);
      const cx = left + cellW * c;
      cells.push(
        h(
          'rect',
          {
            class: 'kb-chart__cell',
            [diverging ? 'data-div' : 'data-level']: level === null ? undefined : level,
            'data-empty': level === null ? 'true' : undefined,
            x: cx + 1,
            y: cy + 1,
            width: Math.max(1, cellW - 2),
            height: cellH - 2,
            rx: 2,
          },
          tooltip(
            `${row} · ${column}: ${isNum(value) ? withUnit(fmt(value), unit) : env.t(KB_CHART_MESSAGE_KEYS.noValue)}`
          )
        )
      );
      if (showValues && isNum(value)) {
        cellLabels.push(
          h(
            'text',
            {
              class: 'kb-chart__cell-value',
              x: cx + cellW / 2,
              y: cy + cellH / 2,
              'text-anchor': 'middle',
              'dominant-baseline': 'middle',
            },
            fmt(value)
          )
        );
      }
    });
  });
  const summary = env.t(KB_CHART_MESSAGE_KEYS.summaryHeatmap, {
    rows: rows.length,
    columns: columns.length,
    min: withUnit(fmt(lo), unit),
    max: withUnit(fmt(hi), unit),
  });
  const title = titleOf(p);
  const steps = diverging ? KB_VIZ_DIVERGING_STEPS : KB_VIZ_SEQUENTIAL_STEPS;
  const scaleLow = diverging ? withUnit(fmt(mid - extent), unit) : withUnit(fmt(seqMin), unit);
  const scaleHigh = diverging ? withUnit(fmt(mid + extent), unit) : withUnit(fmt(hi), unit);
  const scale = h(
    'div',
    { class: 'kb-chart__scale', 'data-scale': diverging ? 'diverging' : 'sequential' },
    h(
      'span',
      { class: 'kb-chart__scale-label' },
      `${env.t(KB_CHART_MESSAGE_KEYS.scaleLow)} ${scaleLow}`
    ),
    h(
      'span',
      { class: 'kb-chart__scale-ramp', 'aria-hidden': 'true' },
      Array.from({ length: steps }, (_, i) =>
        h('span', { class: 'kb-chart__scale-step', [diverging ? 'data-div' : 'data-level']: i + 1 })
      )
    ),
    h(
      'span',
      { class: 'kb-chart__scale-label' },
      `${env.t(KB_CHART_MESSAGE_KEYS.scaleHigh)} ${scaleHigh}`
    )
  );
  return chartFigure('heatmap', p, env, {
    summary,
    variant: diverging ? 'diverging' : undefined,
    legendNode: scale,
    svg: svgRoot(
      W,
      H,
      ariaLabel(env, title, summary),
      'kb-chart__svg--heatmap',
      h('g', { class: 'kb-chart__axes', 'aria-hidden': 'true' }, labels),
      h('g', { class: 'kb-chart__marks' }, cells),
      cellLabels.length
        ? h('g', { class: 'kb-chart__labels', 'aria-hidden': 'true' }, cellLabels)
        : null
    ),
    table: dataTable(
      title,
      [env.t(KB_CHART_MESSAGE_KEYS.tableCategory), ...columns],
      rows.map((row, r) => [
        row,
        ...columns.map((_, c) => {
          const value = values[r] ? values[r][c] : null;
          return isNum(value) ? withUnit(fmt(value), unit) : '—';
        }),
      ])
    ),
  });
}

// ---------------------------------------------------------------------------
// ui:meter
// ---------------------------------------------------------------------------

const METER_TONES = ['success', 'warning', 'danger'];
const METER_STATE_KEYS = {
  success: KB_CHART_MESSAGE_KEYS.meterSuccess,
  warning: KB_CHART_MESSAGE_KEYS.meterWarning,
  danger: KB_CHART_MESSAGE_KEYS.meterDanger,
};

/** The tone of the highest threshold at or below `value`; null when none applies. */
export function meterTone(value, thresholds) {
  const list = (Array.isArray(thresholds) ? thresholds : [])
    .filter((entry) => isRecord(entry) && isNum(entry.value) && METER_TONES.includes(entry.tone))
    .sort((a, b) => a.value - b.value);
  let tone = null;
  for (const entry of list) if (value >= entry.value) tone = entry.tone;
  return tone;
}

function layoutMeter(p, env) {
  const fmt = makeFormatter(env.locale);
  const pct = makePercent(env.locale);
  const unit = str(p.unit);
  const label = str(p.label);
  const max = isNum(p.max) && p.max > 0 ? p.max : 100;
  if (!isNum(p.value)) {
    return h(
      'div',
      { class: 'kb-meter', 'data-empty': 'true' },
      label
        ? h('div', { class: 'kb-meter__header' }, h('span', { class: 'kb-meter__label' }, label))
        : null,
      h('p', { class: 'kb-chart__empty' }, str(p.empty) || env.t(KB_CHART_MESSAGE_KEYS.empty))
    );
  }
  const value = p.value;
  const ratio = Math.max(0, Math.min(1, value / max));
  const tone = meterTone(value, p.thresholds);
  const thresholds = (Array.isArray(p.thresholds) ? p.thresholds : []).filter(
    (entry) =>
      isRecord(entry) &&
      isNum(entry.value) &&
      entry.value > 0 &&
      entry.value < max &&
      METER_TONES.includes(entry.tone)
  );
  const summary = env.t(KB_CHART_MESSAGE_KEYS.summaryMeter, {
    value: withUnit(fmt(value), unit),
    max: withUnit(fmt(max), unit),
    percent: pct(value / max),
  });
  const percent = (fraction) => `${fmtCoord(fraction * 100)}%`;
  return h(
    'div',
    { class: 'kb-meter', 'data-tone': tone || undefined },
    h(
      'div',
      { class: 'kb-meter__header' },
      label ? h('span', { class: 'kb-meter__label' }, label) : null,
      h(
        'span',
        { class: 'kb-meter__value' },
        withUnit(fmt(value), unit),
        h('span', { class: 'kb-meter__max' }, ` / ${withUnit(fmt(max), unit)}`)
      )
    ),
    h(
      'svg',
      {
        class: 'kb-meter__svg',
        role: 'img',
        'aria-label': label
          ? env.t(KB_CHART_MESSAGE_KEYS.labelled, { title: label, summary })
          : summary,
        focusable: 'false',
      },
      h('rect', { class: 'kb-meter__track', x: '0', y: '0', width: '100%', height: '100%', rx: 4 }),
      ratio > 0
        ? h('rect', {
            class: 'kb-meter__fill',
            x: '0',
            y: '0',
            width: percent(ratio),
            height: '100%',
            rx: 4,
          })
        : null,
      thresholds.map((entry) =>
        h('line', {
          class: 'kb-meter__threshold',
          'data-tone': entry.tone,
          x1: percent(entry.value / max),
          x2: percent(entry.value / max),
          y1: '0',
          y2: '100%',
        })
      )
    ),
    tone
      ? h(
          'p',
          { class: 'kb-meter__state', 'data-tone': tone },
          h('span', { class: 'kb-meter__glyph', 'aria-hidden': 'true' }, KB_TONE_GLYPHS[tone]),
          h('span', null, `${env.t(METER_STATE_KEYS[tone])} · ${pct(value / max)}`)
        )
      : null,
    typeof p.description === 'string' && p.description
      ? h('p', { class: 'kb-meter__description' }, p.description)
      : null
  );
}

// ---------------------------------------------------------------------------
// ui:sequence
// ---------------------------------------------------------------------------

function statusMark(env, status, x, y, anchor) {
  const tone = statusToneOf(status);
  if (!tone) return null;
  return h(
    'text',
    {
      class: 'kb-chart__status',
      'data-tone': tone,
      'data-status': status,
      x,
      y,
      'text-anchor': anchor,
      'dominant-baseline': 'middle',
    },
    `${KB_TONE_GLYPHS[tone]} ${env.statusLabel(status)}`
  );
}

function arrowHead(x, y, direction) {
  const c = fmtCoord;
  const dx = direction * 7;
  return h('path', {
    class: 'kb-chart__arrowhead',
    d: `M${c(x)} ${c(y)}L${c(x - dx)} ${c(y - 4)}L${c(x - dx)} ${c(y + 4)}Z`,
  });
}

function layoutSequence(p, env) {
  const { lanes, laneIndex, messages } = orderSequence(
    Array.isArray(p.participants) ? p.participants : [],
    Array.isArray(p.messages) ? p.messages : []
  );
  if (lanes.length === 0 || messages.length === 0) return emptyChart('sequence', p, env);
  const compact = p.density === 'compact';
  const hasAt = messages.some((m) => m.at !== undefined && m.at !== null && m.at !== '');
  const gutter = hasAt
    ? Math.min(96, Math.max(...messages.map((m) => textWidth(str(m.at), TICK_FONT)))) + 16
    : 8;
  const laneW = 160;
  const headH = 30;
  const rowH = compact ? 36 : 46;
  const top = 8;
  const W = gutter + laneW * lanes.length + 8;
  const firstRow = top + headH + 30;
  const H = firstRow + rowH * (messages.length - 1) + 24;
  const laneX = (id) => gutter + laneW * laneIndex.get(id) + laneW / 2;

  const heads = [];
  const lifelines = [];
  lanes.forEach((lane, i) => {
    const cx = gutter + laneW * i + laneW / 2;
    lifelines.push(
      h('line', { class: 'kb-chart__lifeline', x1: cx, x2: cx, y1: top + headH, y2: H - 4 })
    );
    heads.push(
      h(
        'g',
        { class: 'kb-chart__participant' },
        h('rect', {
          class: 'kb-chart__participant-box',
          x: cx - (laneW - 20) / 2,
          y: top,
          width: laneW - 20,
          height: headH,
          rx: 6,
        }),
        h(
          'text',
          {
            class: 'kb-chart__participant-label',
            x: cx,
            y: top + headH / 2,
            'text-anchor': 'middle',
            'dominant-baseline': 'middle',
          },
          fitText(lane.label, laneW - 32, FONT)
        )
      )
    );
  });

  const rows = [];
  messages.forEach((message, i) => {
    const y = firstRow + rowH * i;
    const x1 = laneX(message.from);
    const x2 = laneX(message.to);
    const kind = message.kind === 'reply' || message.kind === 'note' ? message.kind : 'call';
    const label = str(message.label);
    const tone = statusToneOf(message.status);
    const statusText = tone ? `${KB_TONE_GLYPHS[tone]} ${env.statusLabel(message.status)}` : '';
    const parts = [];
    if (hasAt && message.at !== undefined && message.at !== null && message.at !== '') {
      parts.push(
        h(
          'text',
          {
            class: 'kb-chart__tick kb-chart__time',
            x: gutter - 10,
            y,
            'text-anchor': 'end',
            'dominant-baseline': 'middle',
          },
          str(message.at)
        )
      );
    }
    if (x1 === x2) {
      // Self-message: a loop to the right of the lifeline, label beside it.
      const loop = 28;
      const d = `M${fmtCoord(x1)} ${fmtCoord(y - 10)}H${fmtCoord(x1 + loop)}V${fmtCoord(y + 8)}H${fmtCoord(x1 + 8)}`;
      parts.push(h('path', { class: 'kb-chart__message', 'data-kind': kind, d }));
      parts.push(arrowHead(x1 + 1, y + 8, -1));
      const room = laneW - loop - 12;
      parts.push(
        h(
          'text',
          {
            class: 'kb-chart__message-label',
            x: x1 + loop + 6,
            y: y - 10,
            'dominant-baseline': 'middle',
          },
          fitText(label, room, FONT)
        )
      );
      if (statusText) {
        parts.push(statusMark(env, message.status, x1 + loop + 6, y + 6, 'start'));
      }
    } else {
      const dir = x2 > x1 ? 1 : -1;
      const tipX = x2 - dir * 2;
      parts.push(
        h('line', {
          class: 'kb-chart__message',
          'data-kind': kind,
          x1,
          x2: tipX - dir * 6,
          y1: y,
          y2: y,
        })
      );
      parts.push(arrowHead(tipX, y, dir));
      const span = Math.abs(x2 - x1) - 16;
      const midX = (x1 + x2) / 2;
      const labelText = fitText(label, Math.max(24, span), FONT);
      parts.push(
        h(
          'text',
          { class: 'kb-chart__message-label', x: midX, y: y - 9, 'text-anchor': 'middle' },
          labelText
        )
      );
      // Status sits under the arrow so the label keeps the full span.
      if (statusText) parts.push(statusMark(env, message.status, midX, y + 13, 'middle'));
    }
    const tip = `${laneLabel(lanes, laneIndex, message.from)} → ${laneLabel(lanes, laneIndex, message.to)}: ${label}${statusText ? ` (${env.statusLabel(message.status)})` : ''}`;
    rows.push(
      h(
        'g',
        {
          class: 'kb-chart__message-row',
          'data-kind': kind,
          'data-status': message.status || undefined,
        },
        tooltip(tip),
        parts
      )
    );
  });

  const summary = env.t(KB_CHART_MESSAGE_KEYS.summarySequence, {
    messages: messages.length,
    participants: lanes.length,
  });
  const title = titleOf(p);
  const hasStatus = messages.some((m) => statusToneOf(m.status));
  const headers = [
    ...(hasAt ? [env.t(KB_CHART_MESSAGE_KEYS.tableTime)] : []),
    env.t(KB_CHART_MESSAGE_KEYS.tableFrom),
    env.t(KB_CHART_MESSAGE_KEYS.tableTo),
    env.t(KB_CHART_MESSAGE_KEYS.tableMessage),
    ...(hasStatus ? [env.t(KB_CHART_MESSAGE_KEYS.tableStatus)] : []),
  ];
  const tableRows = messages.map((m) => [
    ...(hasAt ? [str(m.at) || '—'] : []),
    laneLabel(lanes, laneIndex, m.from),
    laneLabel(lanes, laneIndex, m.to),
    str(m.label),
    ...(hasStatus ? [statusToneOf(m.status) ? env.statusLabel(m.status) : '—'] : []),
  ]);
  if (!hasAt) {
    // First column is a row header; keep it meaningful.
    headers.unshift('#');
    tableRows.forEach((row, i) => row.unshift(String(i + 1)));
  }
  return chartFigure('sequence', p, env, {
    summary,
    svg: svgRoot(
      W,
      H,
      ariaLabel(env, title, summary),
      'kb-chart__svg--diagram',
      h('g', { class: 'kb-chart__lanes', 'aria-hidden': 'true' }, lifelines, heads),
      h('g', { class: 'kb-chart__marks' }, rows)
    ),
    table: dataTable(title, headers, tableRows),
  });
}

function laneLabel(lanes, laneIndex, id) {
  return laneIndex.has(id) ? lanes[laneIndex.get(id)].label : id;
}

// ---------------------------------------------------------------------------
// ui:flow
// ---------------------------------------------------------------------------

function layoutFlow(p, env) {
  const nodes = (Array.isArray(p.nodes) ? p.nodes : []).filter(
    (node) => isRecord(node) && typeof node.id === 'string' && node.id
  );
  if (nodes.length === 0) return emptyChart('flow', p, env);
  const edges = (Array.isArray(p.edges) ? p.edges : []).filter(isRecord);
  const stages = Array.isArray(p.stages) ? p.stages : [];
  const { layers, layerOf, stageIds } = layerDag(nodes, edges, stages);
  const byId = new Map();
  for (const node of nodes) if (!byId.has(node.id)) byId.set(node.id, node);
  const stageLabel = new Map();
  for (const stage of stages) {
    if (isRecord(stage) && typeof stage.id === 'string')
      stageLabel.set(stage.id, str(stage.label) || stage.id);
  }
  const compact = p.density === 'compact';
  const nodeW = 168;
  const nodeH = compact ? 42 : 50;
  const colGap = 56;
  const rowGap = compact ? 12 : 18;
  const headH = stageIds.length ? 26 : 0;
  const top = 8 + headH;
  const pitch = nodeH + rowGap;
  const maxRows = Math.max(...layers.map((layer) => layer.length));
  const W = 8 + layers.length * nodeW + (layers.length - 1) * colGap + 8;
  const hasBack = edges.some(
    (edge) =>
      layerOf.has(edge.from) &&
      layerOf.has(edge.to) &&
      edge.from !== edge.to &&
      layerOf.get(edge.to) <= layerOf.get(edge.from)
  );
  const H = top + maxRows * pitch - rowGap + (hasBack ? 36 : 8);
  const pos = new Map();
  layers.forEach((layer, l) => {
    const offset = ((maxRows - layer.length) * pitch) / 2;
    layer.forEach((id, i) => {
      pos.set(id, { x: 8 + l * (nodeW + colGap), y: top + offset + i * pitch });
    });
  });

  const heads = stageIds.map((stage, l) =>
    h(
      'text',
      {
        class: 'kb-chart__stage-label',
        x: 8 + l * (nodeW + colGap) + nodeW / 2,
        y: 8 + headH / 2,
        'text-anchor': 'middle',
        'dominant-baseline': 'middle',
      },
      fitText(stageLabel.get(stage) || stage, nodeW + colGap - 12, FONT)
    )
  );

  const validEdges = edges.filter(
    (edge) => pos.has(edge.from) && pos.has(edge.to) && edge.from !== edge.to
  );
  const bottomY = top + maxRows * pitch - rowGap;
  const edgeNodes = [];
  const edgeLabels = [];
  const c = fmtCoord;
  validEdges.forEach((edge) => {
    const a = pos.get(edge.from);
    const b = pos.get(edge.to);
    const forward = layerOf.get(edge.to) > layerOf.get(edge.from);
    let d;
    let tip;
    let mid;
    if (forward) {
      const sx = a.x + nodeW;
      const sy = a.y + nodeH / 2;
      const tx = b.x - 2;
      const ty = b.y + nodeH / 2;
      const bend = Math.max(24, (tx - sx) / 2);
      d = `M${c(sx)} ${c(sy)}C${c(sx + bend)} ${c(sy)} ${c(tx - 8 - bend)} ${c(ty)} ${c(tx - 8)} ${c(ty)}`;
      tip = arrowHead(tx, ty, 1);
      mid = { x: (sx + tx) / 2, y: (sy + ty) / 2 };
    } else {
      // Back / same-stage edge: routed below the diagram.
      const sx = a.x + nodeW / 2;
      const sy = a.y + nodeH;
      const tx = b.x + nodeW / 2;
      const ty = b.y + nodeH + 2;
      const low = bottomY + 18;
      d = `M${c(sx)} ${c(sy)}C${c(sx)} ${c(low)} ${c(tx)} ${c(low)} ${c(tx)} ${c(ty + 8)}`;
      tip = h('path', {
        class: 'kb-chart__arrowhead',
        d: `M${c(tx)} ${c(ty)}L${c(tx - 4)} ${c(ty + 7)}L${c(tx + 4)} ${c(ty + 7)}Z`,
      });
      mid = { x: (sx + tx) / 2, y: low - 6 };
    }
    const label = str(edge.label);
    edgeNodes.push(
      h(
        'g',
        { class: 'kb-chart__edge', 'data-direction': forward ? undefined : 'back' },
        tooltip(
          `${str(byId.get(edge.from).label) || edge.from} → ${str(byId.get(edge.to).label) || edge.to}${label ? `: ${label}` : ''}`
        ),
        h('path', { class: 'kb-chart__edge-line', d }),
        tip
      )
    );
    if (label) {
      edgeLabels.push(
        h(
          'text',
          { class: 'kb-chart__edge-label', x: mid.x, y: mid.y - 6, 'text-anchor': 'middle' },
          fitText(label, colGap + 40, TICK_FONT)
        )
      );
    }
  });

  const nodeMarks = [];
  for (const layer of layers) {
    for (const id of layer) {
      const node = byId.get(id);
      const { x, y } = pos.get(id);
      const tone = statusToneOf(node.status);
      const label = str(node.label) || id;
      const sub = tone ? `${KB_TONE_GLYPHS[tone]} ${env.statusLabel(node.status)}` : str(node.meta);
      nodeMarks.push(
        h(
          'g',
          {
            class: 'kb-chart__node',
            'data-tone': tone || undefined,
            'data-status': tone ? node.status : undefined,
          },
          tooltip(
            `${label}${tone ? ` (${env.statusLabel(node.status)})` : ''}${node.meta && tone ? ` · ${str(node.meta)}` : ''}`
          ),
          h('rect', { class: 'kb-chart__node-box', x, y, width: nodeW, height: nodeH, rx: 6 }),
          h('rect', { class: 'kb-chart__node-bar', x, y, width: 4, height: nodeH, rx: 2 }),
          h(
            'text',
            {
              class: 'kb-chart__node-label',
              x: x + 14,
              y: sub ? y + nodeH / 2 - 8 : y + nodeH / 2,
              'dominant-baseline': 'middle',
            },
            fitText(label, nodeW - 22, FONT)
          ),
          sub
            ? h(
                'text',
                {
                  class: tone ? 'kb-chart__node-status' : 'kb-chart__node-meta',
                  x: x + 14,
                  y: y + nodeH / 2 + 10,
                  'dominant-baseline': 'middle',
                },
                fitText(sub, nodeW - 22, TICK_FONT)
              )
            : null
        )
      );
    }
  }

  const summary = env.t(KB_CHART_MESSAGE_KEYS.summaryFlow, {
    nodes: byId.size,
    stages: layers.length,
    edges: validEdges.length,
  });
  const title = titleOf(p);
  const hasStage = stageIds.length > 0;
  const headers = [
    env.t(KB_CHART_MESSAGE_KEYS.tableStep),
    ...(hasStage ? [env.t(KB_CHART_MESSAGE_KEYS.tableStage)] : []),
    env.t(KB_CHART_MESSAGE_KEYS.tableStatus),
    env.t(KB_CHART_MESSAGE_KEYS.tableNext),
  ];
  const tableRows = layers.flat().map((id) => {
    const node = byId.get(id);
    const next = validEdges
      .filter((edge) => edge.from === id)
      .map(
        (edge) =>
          `${str(byId.get(edge.to).label) || edge.to}${edge.label ? ` (${str(edge.label)})` : ''}`
      )
      .join(', ');
    return [
      str(node.label) || id,
      ...(hasStage ? [stageLabel.get(node.stage) || str(node.stage)] : []),
      statusToneOf(node.status) ? env.statusLabel(node.status) : str(node.meta) || '—',
      next || '—',
    ];
  });
  return chartFigure('flow', p, env, {
    summary,
    svg: svgRoot(
      W,
      H,
      ariaLabel(env, title, summary),
      'kb-chart__svg--diagram',
      heads.length ? h('g', { class: 'kb-chart__stages', 'aria-hidden': 'true' }, heads) : null,
      h('g', { class: 'kb-chart__edges' }, edgeNodes),
      h('g', { class: 'kb-chart__marks' }, nodeMarks),
      edgeLabels.length
        ? h('g', { class: 'kb-chart__labels', 'aria-hidden': 'true' }, edgeLabels)
        : null
    ),
    table: dataTable(title, headers, tableRows),
  });
}

// ---------------------------------------------------------------------------
// ui:stat-list
// ---------------------------------------------------------------------------

function layoutStatList(p, env) {
  const items = (Array.isArray(p.items) ? p.items : []).filter(isRecord);
  const title = titleOf(p);
  if (items.length === 0) {
    return h(
      'div',
      { class: 'kb-stat-list', 'data-empty': 'true' },
      title ? h('p', { class: 'kb-stat-list__title' }, title) : null,
      h('p', { class: 'kb-chart__empty' }, str(p.empty) || env.t(KB_CHART_MESSAGE_KEYS.empty))
    );
  }
  const fmt = makeFormatter(env.locale);
  return h(
    'div',
    { class: 'kb-stat-list', 'data-density': densityOf(p) },
    title ? h('p', { class: 'kb-stat-list__title' }, title) : null,
    h(
      'dl',
      { class: 'kb-stat-list__items' },
      items.map((item) =>
        h(
          'div',
          { class: 'kb-stat-list__item' },
          h('dt', { class: 'kb-stat-list__label' }, str(item.label)),
          h(
            'dd',
            { class: 'kb-stat-list__value' },
            isNum(item.value) ? fmt(item.value) : str(item.value) || '—',
            item.unit ? h('span', { class: 'kb-stat-list__unit' }, str(item.unit)) : null
          ),
          item.hint ? h('dd', { class: 'kb-stat-list__hint' }, str(item.hint)) : null
        )
      )
    )
  );
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const LAYOUTS = {
  'ui:bar-chart': layoutBarChart,
  'ui:line-chart': layoutLineChart,
  'ui:donut': layoutDonut,
  'ui:sparkline': layoutSparkline,
  'ui:heatmap': layoutHeatmap,
  'ui:meter': layoutMeter,
  'ui:sequence': layoutSequence,
  'ui:flow': layoutFlow,
  'ui:stat-list': layoutStatList,
};

export function isChartType(type) {
  return typeof type === 'string' && hasOwn(LAYOUTS, type);
}

/**
 * Lay out a chart type into a vnode tree. `env.t` translates `ui:*` keys,
 * `env.locale` drives number formatting, `env.statusLabel(status)` resolves a
 * canonical status label. Never throws: invalid input renders an empty state.
 * @param {string} type
 * @param {Record<string, unknown>} props
 * @param {{ t: (key: string, params?: Record<string, unknown>) => string, locale?: string, statusLabel?: (status: string) => string }} env
 */
export function layoutChart(type, props, env) {
  const safeEnv = {
    t: env && typeof env.t === 'function' ? env.t : (key) => key,
    locale: env && typeof env.locale === 'string' && env.locale ? env.locale : 'en',
    statusLabel:
      env && typeof env.statusLabel === 'function' ? env.statusLabel : (status) => str(status),
  };
  const p = isRecord(props) ? props : {};
  const layout = isChartType(type) ? LAYOUTS[type] : null;
  if (!layout) return null;
  try {
    return layout(p, safeEnv);
  } catch {
    return emptyChart(type.replace(/^ui:/, ''), p, safeEnv);
  }
}
