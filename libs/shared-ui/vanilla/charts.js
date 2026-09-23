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
 * Modules (all served next to this entry, fixed allow-list): `charts-core.js`
 * (constants, helpers, shared building blocks), `charts-scale.js` (scales,
 * ticks, stacking, DAG layering, sequence ordering), `charts-cartesian.js`
 * (bar, line), `charts-compact.js` (donut, sparkline, heatmap, meter,
 * stat-list) and `charts-diagram.js` (sequence, flow).
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

import { layoutBarChart, layoutLineChart } from './charts-cartesian.js';
import {
  layoutDonut,
  layoutHeatmap,
  layoutMeter,
  layoutSparkline,
  layoutStatList,
} from './charts-compact.js';
import { emptyChart, hasOwn, isRecord, str } from './charts-core.js';
import { layoutFlow, layoutSequence } from './charts-diagram.js';

// Public surface: the layout lives in sibling modules (each served next to
// this one from a fixed allow-list) and is re-exported unchanged.
export {
  KB_CHART_TYPES,
  KB_VIZ_CATEGORICAL_SLOTS,
  KB_VIZ_SEQUENTIAL_STEPS,
  KB_VIZ_DIVERGING_STEPS,
  KB_CHART_MESSAGE_KEYS,
  KB_CHART_STATUS_TONES,
  KB_STATUS_GLYPHS,
  KB_TONE_GLYPHS,
  fmtCoord,
  textWidth,
  fitText,
  barPath,
} from './charts-core.js';
export {
  niceStep,
  niceTicks,
  linearScale,
  stackSeries,
  sequentialLevel,
  divergingLevel,
  layerDag,
  orderSequence,
} from './charts-scale.js';
export { normalizeBarData } from './charts-cartesian.js';
export { arcPath, meterDirection, meterTone } from './charts-compact.js';

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
