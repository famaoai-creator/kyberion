/**
 * Type declarations for `charts.js` — the renderer-independent chart layout
 * (UI-01b). Both renderers consume the same virtual node tree.
 */

/** A virtual element: tag, string attributes (DOM attribute names), children. */
export interface KbVElement {
  tag: string;
  attrs: Readonly<Record<string, string>>;
  children: readonly KbVNode[];
}
/** A virtual text node. */
export interface KbVText {
  text: string;
}
export type KbVNode = KbVElement | KbVText;

export interface KbChartEnv {
  /** Translate a `ui:*` vocabulary key (with `{name}` params). */
  t: (key: string, params?: Record<string, unknown>) => string;
  /** Locale for number formatting (default `en`). */
  locale?: string;
  /** Localized label of a canonical status value. */
  statusLabel?: (status: string) => string;
}

export declare const KB_CHART_TYPES: readonly string[];
export declare const KB_VIZ_CATEGORICAL_SLOTS: number;
export declare const KB_VIZ_SEQUENTIAL_STEPS: number;
export declare const KB_VIZ_DIVERGING_STEPS: number;
export declare const KB_CHART_MESSAGE_KEYS: Readonly<Record<string, string>>;
export declare const KB_CHART_STATUS_TONES: Readonly<Record<string, string>>;
export declare const KB_TONE_GLYPHS: Readonly<Record<string, string>>;

export declare function isChartType(type: unknown): boolean;
/** Lay out a chart type; null for a type this module does not own. Never throws. */
export declare function layoutChart(
  type: string,
  props: unknown,
  env: KbChartEnv
): KbVElement | null;

// Layout primitives (exported for tests and reuse).
export declare function fmtCoord(value: number): string;
export declare function textWidth(text: unknown, size?: number): number;
export declare function fitText(text: unknown, maxWidth: number, size?: number): string;
/** `integer`: no 2.5-steps or fractional steps (integer-valued data). */
export declare function niceStep(span: number, count?: number, integer?: boolean): number;
export declare function niceTicks(
  min: number,
  max: number,
  count?: number,
  integer?: boolean
): number[];
export declare function linearScale(
  domain: readonly [number, number],
  range: readonly [number, number]
): (value: number) => number;
export declare function stackSeries(
  values: ReadonlyArray<ReadonlyArray<number | null | undefined>>
): Array<Array<[number, number] | null>>;
export declare function sequentialLevel(value: unknown, min: number, max: number): number | null;
export declare function divergingLevel(value: unknown, mid: number, extent: number): number | null;
export declare function layerDag(
  nodes: ReadonlyArray<{ id: string; stage?: string }>,
  edges: ReadonlyArray<{ from: string; to: string }>,
  stages?: ReadonlyArray<string | { id: string }>
): { layers: string[][]; layerOf: Map<string, number>; stageIds: string[] };
export declare function orderSequence(
  participants: ReadonlyArray<string | { id: string; label?: string }>,
  messages: ReadonlyArray<Record<string, unknown>>
): {
  lanes: Array<{ id: string; label: string }>;
  laneIndex: Map<string, number>;
  messages: Array<Record<string, unknown>>;
};
export declare function barPath(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  end: 'top' | 'bottom' | 'left' | 'right' | 'none',
  radius?: number
): string;
export declare function arcPath(
  cx: number,
  cy: number,
  outer: number,
  inner: number,
  a0: number,
  a1: number
): string;
export declare function meterTone(value: number, thresholds: unknown): string | null;
export declare function normalizeBarData(props: Record<string, unknown>): {
  categories: string[];
  series: Array<{ name: string; values: Array<number | null> }>;
};
