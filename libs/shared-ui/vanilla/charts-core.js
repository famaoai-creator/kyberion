/*
 * Kyberion UI — chart layout: constants, small helpers and the shared chart
 * building blocks (figure, legend, data table, svg root).
 *
 * Part of the renderer-independent chart layout re-exported by `charts.js`
 * (see its header for the vnode / color / accessibility contract).
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
  meterGoalSuccess: 'ui:meter_goal_state_success',
  meterGoalWarning: 'ui:meter_goal_state_warning',
  meterGoalDanger: 'ui:meter_goal_state_danger',
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

/**
 * Canonical status → glyph by status family (mirror of `KB_STATUS_FAMILIES` ×
 * `KB_STATUS_FAMILY_GLYPHS` in `@agent/core/a2ui-catalog`; pinned equal by
 * `charts.test.ts`): done \u2713, running \u25D0, waiting !, paused \u2016,
 * degraded \u25B2, failed \u2715, idle \u25CB. The same characters the status
 * pill draws via CSS, so a running item never wears the "done" check.
 */
export const KB_STATUS_GLYPHS = Object.freeze({
  ready: '\u2713',
  fully_automatable: '\u2713',
  connected: '\u2713',
  available: '\u2713',
  done: '\u2713',
  completed: '\u2713',
  recovered: '\u2713',
  running: '\u25D0',
  active: '\u25D0',
  connecting: '\u25D0',
  working: '\u25D0',
  busy: '\u25D0',
  distilling: '\u25D0',
  review: '!',
  needs_clarification: '!',
  needs_external_assets: '!',
  needs_assets: '!',
  needs_setup: '!',
  missing_runtime_prerequisites: '!',
  needs_runtime_prerequisites: '!',
  pending: '!',
  paused: '\u2016',
  degraded: '\u25B2',
  fallback: '\u25B2',
  stale: '\u25B2',
  blocked: '\u2715',
  missing: '\u2715',
  error: '\u2715',
  unavailable: '\u2715',
  failed: '\u2715',
  disconnected: '\u2715',
  offline: '\u2715',
  'n/a': '\u25CB',
  planned: '\u25CB',
  archived: '\u25CB',
  stopped: '\u25CB',
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

export const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
export const isRecord = (value) =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
export const isNum = (value) => typeof value === 'number' && Number.isFinite(value);

export function str(value) {
  if (value === null || value === undefined) return '';
  return String(value);
}

/** Round to 2 decimals and print without trailing zeros (stable across renderers). */
export function fmtCoord(value) {
  const rounded = Math.round(value * 100) / 100;
  return String(Object.is(rounded, -0) ? 0 : rounded);
}

/** Element vnode; `undefined` / `null` / `false` attrs and children are dropped. */
export function h(tag, attrs, ...children) {
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

export function makeFormatter(locale) {
  let format;
  try {
    format = new Intl.NumberFormat(locale || 'en', { maximumFractionDigits: 2 });
  } catch {
    format = new Intl.NumberFormat('en', { maximumFractionDigits: 2 });
  }
  return (value) => (isNum(value) ? format.format(value) : '');
}

export function makePercent(locale) {
  let format;
  try {
    format = new Intl.NumberFormat(locale || 'en', { style: 'percent', maximumFractionDigits: 0 });
  } catch {
    format = new Intl.NumberFormat('en', { style: 'percent', maximumFractionDigits: 0 });
  }
  return (ratio) => (isNum(ratio) ? format.format(ratio) : '');
}

export function withUnit(text, unit) {
  return unit ? `${text}${unit}` : text;
}

export function statusToneOf(status) {
  return typeof status === 'string' && hasOwn(KB_CHART_STATUS_TONES, status)
    ? KB_CHART_STATUS_TONES[status]
    : null;
}

// ---------------------------------------------------------------------------
// Shared building blocks
// ---------------------------------------------------------------------------

export const FONT = 12;
export const TICK_FONT = 11;

export function titleOf(p) {
  return typeof p.title === 'string' && p.title.trim() ? p.title.trim() : '';
}

export function ariaLabel(env, title, summary) {
  return title ? env.t(KB_CHART_MESSAGE_KEYS.labelled, { title, summary }) : summary;
}

export function densityOf(p) {
  return p.density === 'compact' ? 'compact' : undefined;
}

export function emptyChart(kind, p, env) {
  const title = titleOf(p);
  return h(
    'figure',
    { class: 'kb-chart', 'data-chart': kind, 'data-empty': 'true', 'data-density': densityOf(p) },
    title ? h('figcaption', { class: 'kb-chart__title' }, title) : null,
    h('p', { class: 'kb-chart__empty' }, str(p.empty) || env.t(KB_CHART_MESSAGE_KEYS.empty))
  );
}

export function legend(env, items) {
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
export function dataTable(caption, headers, rows) {
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

export function chartFigure(kind, p, env, { summary, legendNode, svg, table, variant }) {
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

export function svgRoot(width, height, label, className, ...children) {
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
      // Ticks / labels read this back (container-query font-size, see the
      // charts source CSS) so their *rendered* size stays readable even when
      // the viewBox scales the whole plot down to fit a narrow container.
      style: `--kb-chart-vbw:${fmtCoord(width)}`,
      role: 'img',
      'aria-label': label,
      focusable: 'false',
    },
    ...children
  );
}

export function tooltip(text) {
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

export function numberList(values) {
  return Array.isArray(values) ? values.map((value) => (isNum(value) ? value : null)) : [];
}
