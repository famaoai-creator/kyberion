import { pathResolver } from './path-resolver.js';
import { readJson } from './foundation/json.js';
import { assertSafeRepositoryPath, safeLstat } from './secure-io.js';

/**
 * KDS v2 — the extended design foundation.
 *
 * `kyberion.json` remains the canonical brand/semantic token file. This module
 * loads `kyberion-foundation.json`, which adds:
 *   - palette ramps and primitive scales (space, radius, elevation, motion, type, layout)
 *   - named STYLES that restyle the fixed media/web scenarios (no scenario edits)
 *   - COMPOSITIONS: 12-column region recipes so a scenario can pick its layout
 *     freely (or pass a custom spec) instead of a single fixed preset.
 *
 * Everything is resolved through here; surfaces never read the JSON directly.
 */

export type FoundationMode = 'light' | 'dark';
export type PaletteRamp = Record<string, string>;

export interface StyleColors {
  primary: string;
  secondary: string;
  accent: string;
  background: string;
  text: string;
  warning: string;
}

export interface StyleTypeRole {
  size_pt?: number;
  min_size_pt?: number;
  weight?: number;
  line_spacing_pct?: number;
}

export interface DesignStyle {
  id: string;
  label: string;
  description: string;
  intent: string;
  colors?: Record<FoundationMode, StyleColors>;
  fonts?: { heading?: string; body?: string };
  typography?: { scale_ratio?: number; roles?: Record<string, StyleTypeRole> };
  radius: string;
  elevation: string;
  density: 'comfortable' | 'compact';
  gradient: string | null;
  preferred_compositions: string[];
}

export type CompositionRole =
  'title' | 'subtitle' | 'kicker' | 'body' | 'visual' | 'kpi' | 'card' | 'caption' | 'side';

export interface CompositionRegion {
  id: string;
  role: CompositionRole;
  /** 1-based [start, span] in grid columns. */
  col: [number, number];
  /** 1-based [start, span] in grid rows. */
  row: [number, number];
  align?: 'start' | 'center' | 'end';
  valign?: 'start' | 'center' | 'end';
  emphasis?: 'low' | 'normal' | 'high';
  bleed?: 'left' | 'right' | 'top' | 'bottom';
  /** Allows this region to overlap others (e.g. a background visual). */
  layer?: boolean;
}

export interface CompositionSpec {
  label?: string;
  description?: string;
  rows: number;
  regions: CompositionRegion[];
}

export interface DesignFoundation {
  version: string;
  name: string;
  palettes: Record<string, PaletteRamp>;
  scales: {
    space: Record<string, string>;
    radius: Record<string, string>;
    border_width: Record<string, string>;
    elevation: Record<FoundationMode, Record<string, string>>;
    opacity: Record<string, string>;
    blur: Record<string, string>;
    z: Record<string, string>;
    motion: { duration: Record<string, string>; easing: Record<string, string> };
    type: {
      size_px: Record<string, string>;
      weight: Record<string, string>;
      tracking: Record<string, string>;
      leading: Record<string, string>;
      measure: Record<string, string>;
    };
    layout: {
      breakpoints: Record<string, string>;
      containers: Record<string, string>;
      grid: { columns: number; gutter: string; margin: string };
      aspect: Record<string, string>;
    };
  };
  gradients: Record<string, Record<FoundationMode, string>>;
  styles: Record<string, DesignStyle>;
  compositions: Record<string, CompositionSpec>;
}

const FOUNDATION_PATH = 'public/design-patterns/brand-tokens/kyberion-foundation.json';
const CSS_VALUE_FORBIDDEN = /[<>{};\u0000\r\n]/u;
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/u;
const ROLES: ReadonlySet<string> = new Set([
  'title',
  'subtitle',
  'kicker',
  'body',
  'visual',
  'kpi',
  'card',
  'caption',
  'side',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** Copy only entries whose keys are token ids and whose values are CSS-safe strings. */
function safeStringMap(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!isRecord(value)) return out;
  for (const [key, raw] of Object.entries(value)) {
    if (key.startsWith('_')) continue;
    if (!/^[a-z0-9][a-z0-9.-]{0,31}$/u.test(key)) continue;
    if (typeof raw !== 'string') continue;
    const trimmed = raw.trim();
    if (!trimmed || trimmed.length > 256 || CSS_VALUE_FORBIDDEN.test(trimmed)) continue;
    out[key] = trimmed;
  }
  return out;
}

function safeCssValue(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 256 || CSS_VALUE_FORBIDDEN.test(trimmed)) return fallback;
  return trimmed;
}

function parseStyleColors(value: unknown): Record<FoundationMode, StyleColors> | undefined {
  if (!isRecord(value)) return undefined;
  const out = {} as Record<FoundationMode, StyleColors>;
  for (const mode of ['light', 'dark'] as const) {
    const raw = value[mode];
    if (!isRecord(raw)) return undefined;
    const keys: Array<keyof StyleColors> = [
      'primary',
      'secondary',
      'accent',
      'background',
      'text',
      'warning',
    ];
    const colors = {} as StyleColors;
    for (const key of keys) {
      const safe = safeCssValue(raw[key], '');
      if (!safe) return undefined;
      colors[key] = safe;
    }
    out[mode] = colors;
  }
  return out;
}

function parseStyles(
  value: unknown,
  scales: DesignFoundation['scales'],
  gradients: DesignFoundation['gradients'],
  compositions: DesignFoundation['compositions']
): Record<string, DesignStyle> {
  const out: Record<string, DesignStyle> = {};
  if (!isRecord(value)) return out;
  for (const [id, raw] of Object.entries(value)) {
    if (!ID_PATTERN.test(id) || !isRecord(raw)) continue;
    const radius =
      typeof raw.radius === 'string' && raw.radius in scales.radius ? raw.radius : 'md';
    const elevation =
      typeof raw.elevation === 'string' && raw.elevation in scales.elevation.light
        ? raw.elevation
        : 'sm';
    const gradient =
      typeof raw.gradient === 'string' && raw.gradient in gradients ? raw.gradient : null;
    const fonts = isRecord(raw.fonts)
      ? {
          ...(safeCssValue(raw.fonts.heading, '')
            ? { heading: safeCssValue(raw.fonts.heading, '') }
            : {}),
          ...(safeCssValue(raw.fonts.body, '') ? { body: safeCssValue(raw.fonts.body, '') } : {}),
        }
      : undefined;
    out[id] = {
      id,
      label: typeof raw.label === 'string' ? raw.label : id,
      description: typeof raw.description === 'string' ? raw.description : '',
      intent: typeof raw.intent === 'string' ? raw.intent : '',
      ...(parseStyleColors(raw.colors) ? { colors: parseStyleColors(raw.colors) } : {}),
      ...(fonts && Object.keys(fonts).length > 0 ? { fonts } : {}),
      ...(isRecord(raw.typography)
        ? { typography: raw.typography as DesignStyle['typography'] }
        : {}),
      radius,
      elevation,
      density: raw.density === 'compact' ? 'compact' : 'comfortable',
      gradient,
      preferred_compositions: Array.isArray(raw.preferred_compositions)
        ? raw.preferred_compositions.filter(
            (entry): entry is string => typeof entry === 'string' && entry in compositions
          )
        : [],
    };
  }
  return out;
}

function parseComposition(value: unknown): CompositionSpec | null {
  if (!isRecord(value)) return null;
  const rows = Number(value.rows);
  if (!Number.isInteger(rows) || rows < 1 || rows > 24 || !Array.isArray(value.regions)) {
    return null;
  }
  const regions: CompositionRegion[] = [];
  for (const raw of value.regions) {
    if (!isRecord(raw) || typeof raw.id !== 'string' || !ROLES.has(String(raw.role))) return null;
    const col = raw.col as unknown;
    const row = raw.row as unknown;
    if (!Array.isArray(col) || !Array.isArray(row)) return null;
    regions.push(raw as unknown as CompositionRegion);
  }
  return {
    ...(typeof value.label === 'string' ? { label: value.label } : {}),
    ...(typeof value.description === 'string' ? { description: value.description } : {}),
    rows,
    regions,
  };
}

function parseFoundation(raw: unknown): DesignFoundation | null {
  if (!isRecord(raw)) return null;
  const palettes: Record<string, PaletteRamp> = {};
  if (isRecord(raw.palettes)) {
    for (const [name, ramp] of Object.entries(raw.palettes)) {
      if (!ID_PATTERN.test(name)) continue;
      const parsed = safeStringMap(ramp);
      if (Object.keys(parsed).length > 0) palettes[name] = parsed;
    }
  }
  const scales = isRecord(raw.scales) ? raw.scales : {};
  const type = isRecord(scales.type) ? scales.type : {};
  const layout = isRecord(scales.layout) ? scales.layout : {};
  const motion = isRecord(scales.motion) ? scales.motion : {};
  const grid = isRecord(layout.grid) ? layout.grid : {};
  const elevation = isRecord(scales.elevation) ? scales.elevation : {};
  const parsedScales: DesignFoundation['scales'] = {
    space: safeStringMap(scales.space),
    radius: safeStringMap(scales.radius),
    border_width: safeStringMap(scales.border_width),
    elevation: { light: safeStringMap(elevation.light), dark: safeStringMap(elevation.dark) },
    opacity: safeStringMap(scales.opacity),
    blur: safeStringMap(scales.blur),
    z: safeStringMap(scales.z),
    motion: {
      duration: safeStringMap(motion.duration),
      easing: safeStringMap(motion.easing),
    },
    type: {
      size_px: safeStringMap(type.size_px),
      weight: safeStringMap(type.weight),
      tracking: safeStringMap(type.tracking),
      leading: safeStringMap(type.leading),
      measure: safeStringMap(type.measure),
    },
    layout: {
      breakpoints: safeStringMap(layout.breakpoints),
      containers: safeStringMap(layout.containers),
      grid: {
        columns: Number.isInteger(grid.columns) ? (grid.columns as number) : 12,
        gutter: safeCssValue(grid.gutter, '24px'),
        margin: safeCssValue(grid.margin, '32px'),
      },
      aspect: safeStringMap(layout.aspect),
    },
  };
  const gradients: DesignFoundation['gradients'] = {};
  if (isRecord(raw.gradients)) {
    for (const [name, value] of Object.entries(raw.gradients)) {
      if (!ID_PATTERN.test(name) || !isRecord(value)) continue;
      const light = safeCssValue(value.light, '');
      const dark = safeCssValue(value.dark, '');
      if (light && dark) gradients[name] = { light, dark };
    }
  }
  const compositions: DesignFoundation['compositions'] = {};
  if (isRecord(raw.compositions)) {
    for (const [id, value] of Object.entries(raw.compositions)) {
      if (!ID_PATTERN.test(id)) continue;
      const spec = parseComposition(value);
      if (spec && validateComposition(spec, parsedScales.layout.grid.columns).length === 0) {
        compositions[id] = spec;
      }
    }
  }
  return {
    version: typeof raw.version === 'string' ? raw.version : '0.0.0',
    name: typeof raw.name === 'string' ? raw.name : 'Kyberion Design Foundation',
    palettes,
    scales: parsedScales,
    gradients,
    styles: parseStyles(raw.styles, parsedScales, gradients, compositions),
    compositions,
  };
}

/** Load and sanitize the foundation. Returns null when the file is absent or unreadable. */
export function loadDesignFoundation(): DesignFoundation | null {
  try {
    const filePath = assertSafeRepositoryPath(pathResolver.knowledge(FOUNDATION_PATH), {
      allowMissingLeaf: false,
    });
    if (!safeLstat(filePath).isFile()) return null;
    return parseFoundation(readJson<unknown>(filePath));
  } catch {
    return null;
  }
}

export function listDesignStyles(foundation = loadDesignFoundation()): DesignStyle[] {
  return foundation ? Object.values(foundation.styles) : [];
}

/** Unknown / empty ids resolve to undefined (= baseline look). */
export function findDesignStyle(
  styleId: string | undefined,
  foundation = loadDesignFoundation()
): DesignStyle | undefined {
  if (!styleId || !foundation) return undefined;
  const style = foundation.styles[styleId.trim()];
  if (!style || style.id === 'standard') return undefined;
  return style;
}

// ---------------------------------------------------------------------------
// CSS variable emission (--kds-*)
// ---------------------------------------------------------------------------

function emitMap(vars: Record<string, string>, prefix: string, map: Record<string, string>): void {
  for (const [key, value] of Object.entries(map)) {
    vars[`--kds-${prefix}-${key.replace('.', '_')}`] = value;
  }
}

/** Mode-independent primitives (palettes, scales, layout). */
export function buildFoundationPrimitiveVars(foundation: DesignFoundation): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const [name, ramp] of Object.entries(foundation.palettes)) {
    emitMap(vars, `color-${name}`, ramp);
  }
  const s = foundation.scales;
  emitMap(vars, 'space', s.space);
  emitMap(vars, 'radius', s.radius);
  emitMap(vars, 'border', s.border_width);
  emitMap(vars, 'opacity', s.opacity);
  emitMap(vars, 'blur', s.blur);
  emitMap(vars, 'z', s.z);
  emitMap(vars, 'duration', s.motion.duration);
  emitMap(vars, 'ease', s.motion.easing);
  emitMap(vars, 'font-size', s.type.size_px);
  emitMap(vars, 'font-weight', s.type.weight);
  emitMap(vars, 'tracking', s.type.tracking);
  emitMap(vars, 'leading', s.type.leading);
  emitMap(vars, 'measure', s.type.measure);
  emitMap(vars, 'breakpoint', s.layout.breakpoints);
  emitMap(vars, 'container', s.layout.containers);
  emitMap(vars, 'aspect', s.layout.aspect);
  vars['--kds-grid-columns'] = String(s.layout.grid.columns);
  vars['--kds-grid-gutter'] = s.layout.grid.gutter;
  vars['--kds-grid-margin'] = s.layout.grid.margin;
  return vars;
}

/** Mode-dependent values: elevation ramp + gradients. */
export function buildFoundationModeVars(
  foundation: DesignFoundation,
  mode: FoundationMode
): Record<string, string> {
  const vars: Record<string, string> = {};
  emitMap(vars, 'shadow', foundation.scales.elevation[mode]);
  for (const [name, value] of Object.entries(foundation.gradients)) {
    vars[`--kds-gradient-${name}`] = value[mode];
  }
  return vars;
}

/** The variables a style pins for one mode (`--kds-style-*`). */
export function buildStyleVars(
  foundation: DesignFoundation,
  style: DesignStyle,
  mode: FoundationMode
): Record<string, string> {
  const vars: Record<string, string> = {
    '--kds-style-radius': foundation.scales.radius[style.radius] ?? '8px',
    '--kds-style-shadow': foundation.scales.elevation[mode][style.elevation] ?? 'none',
    '--kds-style-gradient': style.gradient ? `var(--kds-gradient-${style.gradient})` : 'none',
  };
  if (style.colors) {
    const c = style.colors[mode];
    vars['--kds-style-primary'] = c.primary;
    vars['--kds-style-secondary'] = c.secondary;
    vars['--kds-style-accent'] = c.accent;
    vars['--kds-style-background'] = c.background;
    vars['--kds-style-text'] = c.text;
    vars['--kds-style-warning'] = c.warning;
  }
  if (style.fonts?.heading) vars['--kds-style-font-heading'] = style.fonts.heading;
  if (style.fonts?.body) vars['--kds-style-font-body'] = style.fonts.body;
  return vars;
}

function block(selector: string, vars: Record<string, string>): string {
  const lines = Object.entries(vars).map(([key, value]) => `  ${key}: ${value};`);
  return `${selector} {\n${lines.join('\n')}\n}`;
}

/**
 * Render the standalone `kyberion-ds.css`. Structure mirrors the existing
 * `--kb-ui-*` convention: light is the `:root` default, dark applies under
 * prefers-color-scheme (unless `data-theme="light"`) and under
 * `data-theme="dark"`. Each style is scoped by `[data-kds-style="<id>"]`.
 */
export function renderFoundationStylesheet(foundation: DesignFoundation): string {
  const parts: string[] = [
    '/* GENERATED by scripts/generate_design_foundation.ts from',
    '   knowledge/public/design-patterns/brand-tokens/kyberion-foundation.json.',
    '   Do not edit by hand. Usage: <html data-kds-style="editorial" data-theme="dark"> */',
    block(':root', {
      ...buildFoundationPrimitiveVars(foundation),
      ...buildFoundationModeVars(foundation, 'light'),
    }),
  ];
  const darkVars = buildFoundationModeVars(foundation, 'dark');
  parts.push(
    `@media (prefers-color-scheme: dark) {\n${indent(block(':root:not([data-theme="light"])', darkVars))}\n}`
  );
  parts.push(block(':root[data-theme="dark"]', darkVars));

  for (const style of Object.values(foundation.styles)) {
    if (style.id === 'standard') continue;
    const sel = `[data-kds-style="${style.id}"]`;
    parts.push(block(`:root${sel}, ${sel}`, buildStyleVars(foundation, style, 'light')));
    const dark = buildStyleVars(foundation, style, 'dark');
    parts.push(
      `@media (prefers-color-scheme: dark) {\n${indent(block(`:root:not([data-theme="light"])${sel}, :root:not([data-theme="light"]) ${sel}`, dark))}\n}`
    );
    parts.push(block(`:root[data-theme="dark"]${sel}, :root[data-theme="dark"] ${sel}`, dark));
  }
  for (const [id, spec] of Object.entries(foundation.compositions)) {
    parts.push(renderCompositionCss(id, spec, foundation.scales.layout.grid.columns));
  }
  return `${parts.join('\n\n')}\n`;
}

function indent(text: string): string {
  return text
    .split('\n')
    .map((line) => `  ${line}`)
    .join('\n');
}

// ---------------------------------------------------------------------------
// Compositions
// ---------------------------------------------------------------------------

export interface CompositionIssue {
  region?: string;
  message: string;
}

/**
 * Validate a (possibly user-authored) composition. Used both when loading the
 * catalog and as an ADF preflight for custom layouts.
 */
export function validateComposition(spec: CompositionSpec, columns = 12): CompositionIssue[] {
  const issues: CompositionIssue[] = [];
  const seen = new Set<string>();
  const placed: CompositionRegion[] = [];
  if (!Number.isInteger(spec.rows) || spec.rows < 1) {
    issues.push({ message: `rows must be a positive integer (got ${spec.rows})` });
  }
  for (const region of spec.regions) {
    if (!ID_PATTERN.test(region.id)) {
      issues.push({ region: region.id, message: 'region id must be kebab-case' });
    }
    if (seen.has(region.id)) issues.push({ region: region.id, message: 'duplicate region id' });
    seen.add(region.id);
    const [c, cs] = region.col;
    const [r, rs] = region.row;
    if (![c, cs, r, rs].every((n) => Number.isInteger(n) && n >= 1)) {
      issues.push({ region: region.id, message: 'col/row must be 1-based positive integers' });
      continue;
    }
    if (c + cs - 1 > columns) {
      issues.push({ region: region.id, message: `spills past column ${columns}` });
    }
    if (r + rs - 1 > spec.rows) {
      issues.push({ region: region.id, message: `spills past row ${spec.rows}` });
    }
    if (!region.layer) {
      for (const other of placed) {
        if (other.layer) continue;
        const colOverlap = c < other.col[0] + other.col[1] && other.col[0] < c + cs;
        const rowOverlap = r < other.row[0] + other.row[1] && other.row[0] < r + rs;
        if (colOverlap && rowOverlap) {
          issues.push({
            region: region.id,
            message: `overlaps "${other.id}" (set layer:true to allow)`,
          });
        }
      }
    }
    placed.push(region);
  }
  return issues;
}

export interface CompositionCanvas {
  width: number;
  height: number;
  /** [top, right, bottom, left], same unit as width/height. Default 0. */
  margins?: [number, number, number, number];
  /** Gap between tracks, same unit. Default 0. */
  gutter?: number;
  columns?: number;
}

export interface ResolvedRegion extends CompositionRegion {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Resolve a composition (catalog id or custom spec) to absolute rectangles on
 * a canvas. Unit-agnostic: pass inches for pptx, px for web/video. `bleed`
 * regions extend to the canvas edge instead of stopping at the margin.
 */
export function resolveComposition(
  composition: string | CompositionSpec,
  canvas: CompositionCanvas,
  foundation = loadDesignFoundation()
): ResolvedRegion[] {
  const spec =
    typeof composition === 'string' ? foundation?.compositions[composition] : composition;
  if (!spec) throw new Error(`Unknown composition: ${String(composition)}`);
  const columns = canvas.columns ?? foundation?.scales.layout.grid.columns ?? 12;
  const issues = validateComposition(spec, columns);
  if (issues.length > 0) {
    throw new Error(
      `Invalid composition: ${issues.map((i) => `${i.region ?? 'spec'}: ${i.message}`).join('; ')}`
    );
  }
  const [mt, mr, mb, ml] = canvas.margins ?? [0, 0, 0, 0];
  const gutter = canvas.gutter ?? 0;
  const innerW = canvas.width - ml - mr;
  const innerH = canvas.height - mt - mb;
  const colW = (innerW - gutter * (columns - 1)) / columns;
  const rowH = (innerH - gutter * (spec.rows - 1)) / spec.rows;
  return spec.regions.map((region) => {
    const [c, cs] = region.col;
    const [r, rs] = region.row;
    let x = ml + (c - 1) * (colW + gutter);
    let y = mt + (r - 1) * (rowH + gutter);
    let w = cs * colW + (cs - 1) * gutter;
    let h = rs * rowH + (rs - 1) * gutter;
    if (region.bleed === 'right') w = canvas.width - x;
    if (region.bleed === 'left') {
      w += x;
      x = 0;
    }
    if (region.bleed === 'bottom') h = canvas.height - y;
    if (region.bleed === 'top') {
      h += y;
      y = 0;
    }
    return { ...region, x: round(x), y: round(y), w: round(w), h: round(h) };
  });
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/** CSS grid recipe for the same composition (`.kds-comp-<id>` + `[data-region]` children). */
export function renderCompositionCss(id: string, spec: CompositionSpec, columns = 12): string {
  const lines = [
    `.kds-comp-${id} {`,
    '  display: grid;',
    `  grid-template-columns: repeat(${columns}, minmax(0, 1fr));`,
    `  grid-template-rows: repeat(${spec.rows}, minmax(0, 1fr));`,
    '  gap: var(--kds-grid-gutter);',
    '}',
  ];
  for (const region of spec.regions) {
    const decl = [
      `grid-column: ${region.col[0]} / span ${region.col[1]}`,
      `grid-row: ${region.row[0]} / span ${region.row[1]}`,
      ...(region.align
        ? [`justify-self: ${region.align === 'center' ? 'center' : region.align}`]
        : []),
      ...(region.valign ? [`align-self: ${region.valign}`] : []),
    ];
    lines.push(`.kds-comp-${id} > [data-region="${region.id}"] { ${decl.join('; ')}; }`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// WCAG contrast (used by tests and the style gate)
// ---------------------------------------------------------------------------

function channel(value: number): number {
  const v = value / 255;
  return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

export function contrastRatio(foreground: string, background: string): number | null {
  const parse = (hex: string): number[] | null => {
    const m = /^#([0-9a-f]{6})$/iu.exec(hex.trim());
    if (!m) return null;
    return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16));
  };
  const a = parse(foreground);
  const b = parse(background);
  if (!a || !b) return null;
  const lum = (rgb: number[]) =>
    0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2]);
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
