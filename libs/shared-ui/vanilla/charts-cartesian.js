/*
 * Kyberion UI — chart layout: ui:bar-chart and ui:line-chart layouts.
 *
 * Part of the renderer-independent chart layout re-exported by `charts.js`
 * (see its header for the vnode / color / accessibility contract).
 */
import {
  KB_CHART_MESSAGE_KEYS,
  KB_VIZ_CATEGORICAL_SLOTS,
  TICK_FONT,
  ariaLabel,
  barPath,
  chartFigure,
  dataTable,
  emptyChart,
  fitText,
  fmtCoord,
  h,
  isNum,
  isRecord,
  legend,
  makeFormatter,
  numberList,
  str,
  svgRoot,
  textWidth,
  titleOf,
  tooltip,
  withUnit,
} from './charts-core.js';
import { linearScale, niceTicks, stackSeries } from './charts-scale.js';

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

export function layoutBarChart(p, env) {
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

export function layoutLineChart(p, env) {
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
