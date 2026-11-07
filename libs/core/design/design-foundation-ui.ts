import type { BrandUiPalette, BrandUiTokens } from './brand-tokens.js';
import {
  contrastRatio,
  type DesignFoundation,
  type DesignStyle,
  type FoundationMode,
} from './design-foundation.js';

/**
 * KDS v2 → Surface UI palette derivation.
 *
 * A style restyles the Surfaces by overriding the SAME semantic `--kb-ui-*`
 * tokens the components already read (canvas, surface, text, accent, radius,
 * shadow…), never by adding a parallel token set. The palette is derived, not
 * hand-written, so every value has a stated reason:
 *
 *   canvas / text / accent      ← the style's background / text / accent
 *   surface / sunken / border   ← the style's neutrals (or a fixed mix of text into background)
 *   text-muted / text-subtle    ← text mixed toward background, pushed back to ≥ 4.5:1
 *   border-strong / focus-ring  ← pushed to ≥ 3:1 (WCAG 1.4.11)
 *   accent-text / accent fill   ← pushed to ≥ 4.5:1 / ≥ 3:1 against every surface
 *   status / role / viz marks   ← same hue as the base palette, only pushed to the same contrast floors
 *
 * Status *meaning* (success / warning / danger / info) is never restyled; only
 * its lightness may move so it stays legible on the style's surfaces.
 */

const INK_LIGHT = '#ffffff';
const INK_DARK = '#0b1220';

type Rgb = [number, number, number];

function parse(hex: string): Rgb {
  const m = /^#([0-9a-f]{6})$/iu.exec(hex.trim());
  if (!m) throw new Error(`design-foundation-ui: expected #rrggbb, got "${hex}"`);
  return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16)) as Rgb;
}

function toHex(rgb: Rgb): string {
  return `#${rgb
    .map((v) =>
      Math.round(Math.min(255, Math.max(0, v)))
        .toString(16)
        .padStart(2, '0')
    )
    .join('')}`;
}

/** Mix `a` toward `b` by `t` (0 = a, 1 = b) in sRGB. */
export function mixHex(a: string, b: string, t: number): string {
  const [x, y] = [parse(a), parse(b)];
  return toHex([0, 1, 2].map((i) => x[i] + (y[i] - x[i]) * t) as Rgb);
}

function luminance(hex: string): number {
  const c = parse(hex).map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}

function ratio(a: string, b: string): number {
  return contrastRatio(a, b) ?? 1;
}

/**
 * Move `fg` toward black (against light backgrounds) or white (against dark
 * ones) until it reaches `min` against every background. Hue is preserved as
 * long as possible; the endpoint itself is the last resort.
 */
export function ensureContrast(fg: string, backgrounds: string[], min: number): string {
  const meanLum = backgrounds.reduce((sum, bg) => sum + luminance(bg), 0) / backgrounds.length;
  const target = meanLum > 0.4 ? '#000000' : '#ffffff';
  const ok = (candidate: string) => backgrounds.every((bg) => ratio(candidate, bg) >= min);
  if (ok(fg)) return fg;
  for (let step = 1; step <= 50; step += 1) {
    const candidate = mixHex(fg, target, step / 50);
    if (ok(candidate)) return candidate;
  }
  return target;
}

function bestInk(fill: string): string {
  return ratio(INK_LIGHT, fill) >= ratio(INK_DARK, fill) ? INK_LIGHT : INK_DARK;
}

/** Push `fill` away from mid-luminance until an ink reaches 4.5:1 on it. */
function fillForInk(fill: string, bg: string): { fill: string; ink: string } {
  for (let step = 0; step <= 40; step += 1) {
    for (const target of ['#000000', '#ffffff']) {
      const candidate = step === 0 ? fill : mixHex(fill, target, step / 40);
      const ink = bestInk(candidate);
      if (ratio(ink, candidate) >= 4.5 && ratio(candidate, bg) >= 3)
        return { fill: candidate, ink };
    }
  }
  return { fill, ink: bestInk(fill) };
}

/** Push `fill` away from `ink` (white ink → darker, dark ink → lighter) until ink:fill >= 4.5. */
function pushForInk(fill: string, ink: string): string {
  const target = luminance(ink) > 0.5 ? '#000000' : '#ffffff';
  for (let step = 0; step <= 50; step += 1) {
    const candidate = step === 0 ? fill : mixHex(fill, target, step / 50);
    if (ratio(ink, candidate) >= 4.5) return candidate;
  }
  return target;
}

const RADIUS_ORDER = ['none', 'xs', 'sm', 'md', 'lg', 'xl', '2xl'];
const ELEVATION_ORDER = ['xs', 'sm', 'md', 'lg', 'xl', '2xl'];

export interface StyleUiOverride {
  /** Full palette in the shape `uiPaletteDeclarations` consumes. */
  palette: BrandUiPalette;
  radius: { sm: string; md: string; lg: string };
  /** Heading face; components fall back to the UI sans when absent. */
  fontHeading?: string;
  /** Accent gradient for primary controls; `none` when the style declares no surface gradient. */
  gradientAccent: string;
}

function adaptMarks(marks: string[], surfaces: string[], min: number): string[] {
  return marks.map((mark) => ensureContrast(mark, surfaces, min));
}

/** Derive the Surface palette for one style and mode. Returns null for styles with no colors (`standard`). */
export function deriveStyleUiOverride(
  base: BrandUiTokens,
  foundation: DesignFoundation,
  style: DesignStyle,
  mode: FoundationMode
): StyleUiOverride | null {
  const colors = style.colors?.[mode];
  if (!colors) return null;
  const basePalette = base[mode];
  const white = '#ffffff';

  const canvas = colors.background;
  const surface = colors.surface ?? mixHex(canvas, colors.text, 0.04);
  const raised = mode === 'light' ? mixHex(surface, white, 0.6) : mixHex(surface, white, 0.04);
  const sunken = colors.muted ?? mixHex(canvas, colors.text, 0.08);
  const border = colors.border ?? mixHex(canvas, colors.text, 0.16);
  const surfaces = [canvas, surface, raised, sunken];

  const text = ensureContrast(colors.text, surfaces, 7);
  const textMuted = ensureContrast(mixHex(text, canvas, 0.3), surfaces, 4.5);
  const textSubtle = ensureContrast(mixHex(text, canvas, 0.42), surfaces, 4.5);
  const borderStrong = ensureContrast(mixHex(canvas, text, 0.5), surfaces, 3);

  // Accent: legible as text/boundary on every surface (>= 4.5 for text use),
  // and a fill that carries an ink at 4.5:1.
  const accentText = ensureContrast(
    colors.accent,
    [...surfaces, mixHex(canvas, colors.accent, 0.12)],
    4.5
  );
  const { fill: accent, ink: onAccent } = fillForInk(accentText, canvas);
  const hoverTarget =
    ratio(onAccent, accent) >= 4.5 && onAccent === INK_LIGHT ? '#000000' : '#ffffff';
  let accentHover = mixHex(accent, hoverTarget, 0.14);
  if (ratio(onAccent, accentHover) < 4.5) accentHover = accent;
  const accentSoft = mixHex(canvas, accent, mode === 'light' ? 0.1 : 0.16);

  const adaptTriple = (triple: { fg: string; bg: string; border: string }) => ({
    ...triple,
    fg: ensureContrast(triple.fg, [...surfaces, triple.bg], 4.5),
  });
  const status = Object.fromEntries(
    Object.entries(basePalette.status).map(([key, triple]) => [key, adaptTriple(triple)])
  ) as BrandUiPalette['status'];
  const role = Object.fromEntries(
    Object.entries(basePalette.role).map(([key, value]) => [
      key,
      ensureContrast(value, surfaces, 4.5),
    ])
  ) as BrandUiPalette['role'];

  const elevIdx = Math.max(0, ELEVATION_ORDER.indexOf(style.elevation));
  const elev = foundation.scales.elevation[mode];
  const shadow = {
    sm: elev[ELEVATION_ORDER[Math.max(0, elevIdx - 1)]] ?? basePalette.shadow.sm,
    md: elev[ELEVATION_ORDER[elevIdx]] ?? basePalette.shadow.md,
  };

  const viz = {
    ...basePalette.viz,
    categorical: adaptMarks(basePalette.viz.categorical, surfaces, 3),
    // The low end of the sequential ramp must stay visible (>= 2:1) on tinted surfaces.
    sequential: basePalette.viz.sequential.map((step, index) =>
      index === 0 ? ensureContrast(step, surfaces, 2.05) : step
    ),
  };

  const palette: BrandUiPalette = {
    canvas,
    surface,
    'surface-raised': raised,
    'surface-sunken': sunken,
    border,
    'border-strong': borderStrong,
    text,
    'text-muted': textMuted,
    'text-subtle': textSubtle,
    'text-on-accent': onAccent,
    accent,
    'accent-hover': accentHover,
    'accent-soft': accentSoft,
    'accent-text': accentText,
    'focus-ring': ensureContrast(accent, surfaces, 3),
    status,
    role,
    shadow,
    viz,
  };

  const radiusIdx = Math.max(0, RADIUS_ORDER.indexOf(style.radius));
  const radiusOf = (index: number) =>
    foundation.scales.radius[RADIUS_ORDER[Math.min(RADIUS_ORDER.length - 1, Math.max(0, index))]] ??
    '8px';
  const radius = {
    sm: radiusOf(radiusIdx - 1),
    md: radiusOf(radiusIdx),
    lg: radiusOf(radiusIdx + 1),
  };

  // Surface gradient: only when the style opts in (`surface_gradient`), built from the
  // derived accent so the primary-button ink contrast (>= 4.5) holds on every stop.
  let gradientAccent = 'none';
  if (style.surface_gradient) {
    const stops =
      foundation.gradients[style.gradient ?? '']?.[mode]?.match(/#[0-9a-f]{6}/giu) ?? [];
    const adapted = [accent, ...stops.slice(1)].map((stop) => pushForInk(stop, onAccent));
    const inkOk = adapted.every((stop) => ratio(onAccent, stop) >= 4.5);
    if (inkOk && adapted.length > 1)
      gradientAccent = `linear-gradient(135deg, ${adapted.join(', ')})`;
  }

  return {
    palette,
    radius,
    ...(style.fonts?.heading ? { fontHeading: style.fonts.heading } : {}),
    gradientAccent,
  };
}
