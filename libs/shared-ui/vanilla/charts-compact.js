/*
 * Kyberion UI — chart layout: ui:donut, ui:sparkline, ui:heatmap, ui:meter and
 * ui:stat-list layouts.
 *
 * Part of the renderer-independent chart layout re-exported by `charts.js`
 * (see its header for the vnode / color / accessibility contract).
 */
import {
  FONT,
  KB_CHART_MESSAGE_KEYS,
  KB_TONE_GLYPHS,
  KB_VIZ_CATEGORICAL_SLOTS,
  KB_VIZ_DIVERGING_STEPS,
  KB_VIZ_SEQUENTIAL_STEPS,
  TICK_FONT,
  ariaLabel,
  chartFigure,
  dataTable,
  densityOf,
  emptyChart,
  fitText,
  fmtCoord,
  h,
  isNum,
  isRecord,
  legend,
  makeFormatter,
  makePercent,
  numberList,
  str,
  svgRoot,
  textWidth,
  titleOf,
  tooltip,
  withUnit,
} from './charts-core.js';
import { divergingLevel, linearScale, sequentialLevel } from './charts-scale.js';

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

export function layoutDonut(p, env) {
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

export function layoutSparkline(p, env) {
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

export function layoutHeatmap(p, env) {
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
              // Per-level/div ink (source CSS), not a halo: each ramp step
              // gets a text color that's actually >= 4.5:1 on it.
              [diverging ? 'data-div' : 'data-level']: level === null ? undefined : level,
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

const METER_GOAL_STATE_KEYS = {
  success: KB_CHART_MESSAGE_KEYS.meterGoalSuccess,
  warning: KB_CHART_MESSAGE_KEYS.meterGoalWarning,
  danger: KB_CHART_MESSAGE_KEYS.meterGoalDanger,
};

/** `ui:meter` direction: `higher_is_better` or the default `lower_is_better`. */
export function meterDirection(value) {
  return value === 'higher_is_better' ? 'higher_is_better' : 'lower_is_better';
}

/**
 * The tone of the highest threshold at or below `value`; null when none
 * applies. The same rule for both directions — a completion rate declares
 * e.g. `[{0, danger}, {50, warning}, {80, success}]`, a usage meter
 * `[{80, warning}, {95, danger}]`; `direction` only changes the state words.
 */
export function meterTone(value, thresholds) {
  const list = (Array.isArray(thresholds) ? thresholds : [])
    .filter((entry) => isRecord(entry) && isNum(entry.value) && METER_TONES.includes(entry.tone))
    .sort((a, b) => a.value - b.value);
  let tone = null;
  for (const entry of list) if (value >= entry.value) tone = entry.tone;
  return tone;
}

export function layoutMeter(p, env) {
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
  const direction = meterDirection(p.direction);
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
    {
      class: 'kb-meter',
      'data-tone': tone || undefined,
      'data-direction': direction === 'higher_is_better' ? direction : undefined,
    },
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
          h(
            'span',
            null,
            `${env.t((direction === 'higher_is_better' ? METER_GOAL_STATE_KEYS : METER_STATE_KEYS)[tone])} · ${pct(value / max)}`
          )
        )
      : null,
    typeof p.description === 'string' && p.description
      ? h('p', { class: 'kb-meter__description' }, p.description)
      : null
  );
}

// ---------------------------------------------------------------------------
// ui:stat-list
// ---------------------------------------------------------------------------

export function layoutStatList(p, env) {
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
