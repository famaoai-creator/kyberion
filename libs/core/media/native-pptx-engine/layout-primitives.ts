import { semanticToken, type ResolveSemanticTokensOptions } from '../../semantic-design-tokens.js';
import type { PptxElement, PptxPos, PptxStyle } from '../../contracts/pptx-protocol.js';

/**
 * LE-02: shared PPTX layout primitives.
 *
 * These used to live privately inside scripts/generate_all_objects_layout_sample.ts,
 * which made the hand-written script path the only path with consistent
 * building blocks. They are engine-side now so scripts, snapshot protocols,
 * and the media-actuator brief path can share one vocabulary.
 *
 * The factories deliberately do NOT inject font/size/color defaults — that is
 * the design-defaults cascade's job (design-cascade.ts). Set
 * `protocol.designDefaults` to get consistent fills for omitted keys.
 */

/** Neutral palette shared by the showcase deck and layout primitives. */
export interface PptxPalette {
  navy: string;
  navyDark: string;
  blue: string;
  blueLight: string;
  green: string;
  greenLight: string;
  orange: string;
  orangeLight: string;
  purple: string;
  purpleLight: string;
  red: string;
  redLight: string;
  gray50: string;
  gray100: string;
  gray200: string;
  gray400: string;
  gray600: string;
  gray700: string;
  gray800: string;
  white: string;
  black: string;
}

const PPTX_PALETTE_TOKENS: Readonly<Record<keyof PptxPalette, string>> = {
  navy: 'pptx.navy',
  navyDark: 'pptx.navyDark',
  blue: 'pptx.blue',
  blueLight: 'pptx.blueLight',
  green: 'status.success',
  greenLight: 'status.success.light',
  orange: 'status.warning',
  orangeLight: 'status.warning.light',
  purple: 'pptx.purple',
  purpleLight: 'pptx.purpleLight',
  red: 'status.danger',
  redLight: 'status.danger.light',
  gray50: 'pptx.gray50',
  gray100: 'pptx.gray100',
  gray200: 'pptx.gray200',
  gray400: 'pptx.gray400',
  gray600: 'pptx.gray600',
  gray700: 'pptx.gray700',
  gray800: 'pptx.gray800',
  white: 'pptx.white',
  black: 'pptx.black',
};

/**
 * Resolve the palette for one render. Semantic tokens are tenant-scoped, so this
 * runs per call with the tenant in scope (default: the process tenant) — a
 * multi-tenant process must never reuse the first tenant's palette.
 */
export function resolvePptxPalette(options?: ResolveSemanticTokensOptions): Readonly<PptxPalette> {
  const palette = {} as PptxPalette;
  for (const [key, token] of Object.entries(PPTX_PALETTE_TOKENS)) {
    palette[key as keyof PptxPalette] = semanticToken('pptx', token, options);
  }
  return palette;
}

/**
 * Back-compat view of the default (process-tenant) palette. Values resolve on
 * access, not at import; render paths take an explicit `tenantSlug` instead.
 */
export const PPTX_PALETTE: Readonly<PptxPalette> = Object.defineProperties(
  {} as PptxPalette,
  Object.fromEntries(
    Object.entries(PPTX_PALETTE_TOKENS).map(([key, token]) => [
      key,
      { enumerable: true, get: () => semanticToken('pptx', token) },
    ])
  )
);

export function textElement(text: string, pos: PptxPos, style: PptxStyle = {}): PptxElement {
  return { type: 'text', pos, text, style };
}

export function shapeElement(
  shapeType: string,
  pos: PptxPos,
  text: string,
  style: PptxStyle = {}
): PptxElement {
  return { type: 'shape', shapeType, pos, text, style };
}

export function lineElement(pos: PptxPos, style: PptxStyle = {}): PptxElement {
  return { type: 'line', pos, style };
}

export interface SectionHeaderOptions {
  /** Canvas width in inches (default 10 — standard 4:3 canvas). */
  canvasWidth?: number;
  barColor?: string;
  accentColor?: string;
  titleColor?: string;
  fontSize?: number;
  /** Tenant whose semantic-token overlay colours the defaults (default: process tenant). */
  tenantSlug?: string;
}

/** Full-width section header: title bar + accent rule underneath. */
export function sectionHeaderElements(
  title: string,
  options: SectionHeaderOptions = {}
): PptxElement[] {
  const w = options.canvasWidth ?? 10;
  const palette = resolvePptxPalette({ tenantSlug: options.tenantSlug });
  const barColor = options.barColor ?? palette.navy;
  const accentColor = options.accentColor ?? palette.blue;
  const titleColor = options.titleColor ?? palette.white;
  return [
    shapeElement('rect', { x: 0, y: 0, w, h: 0.9 }, '', { fill: barColor }),
    textElement(
      title,
      { x: 0.5, y: 0.15, w: w - 1, h: 0.6 },
      {
        fontSize: options.fontSize ?? 22,
        bold: true,
        color: titleColor,
        valign: 'middle',
      }
    ),
    shapeElement('rect', { x: 0, y: 0.9, w, h: 0.05 }, '', { fill: accentColor }),
  ];
}

export interface FooterOptions {
  pageNum: number;
  totalPages: number;
  label: string;
  /** Canvas width in inches (default 10). */
  canvasWidth?: number;
  /** Vertical position of the footer rule in inches (default 7.0). */
  y?: number;
  ruleColor?: string;
  textColor?: string;
  /** Tenant whose semantic-token overlay colours the defaults (default: process tenant). */
  tenantSlug?: string;
}

/** Footer rule + label + page counter. */
export function footerElements(options: FooterOptions): PptxElement[] {
  const w = options.canvasWidth ?? 10;
  const y = options.y ?? 7.0;
  const palette = resolvePptxPalette({ tenantSlug: options.tenantSlug });
  const ruleColor = options.ruleColor ?? palette.navy;
  const textColor = options.textColor ?? palette.gray400;
  return [
    lineElement({ x: 0.5, y, w: w - 1, h: 0 }, { line: ruleColor, lineWidth: 0.5 }),
    textElement(
      options.label,
      { x: 0.5, y: y + 0.05, w: 5, h: 0.35 },
      {
        fontSize: 8,
        color: textColor,
      }
    ),
    textElement(
      `Page ${options.pageNum} / ${options.totalPages}`,
      { x: w - 2.5, y: y + 0.05, w: 2.0, h: 0.35 },
      { fontSize: 8, color: textColor, align: 'right' }
    ),
  ];
}

export interface PptxLayoutKit {
  /** The tenant's resolved palette (resolved once for this kit). */
  palette: Readonly<PptxPalette>;
  sectionHeader(title: string, options?: Omit<SectionHeaderOptions, 'tenantSlug'>): PptxElement[];
  footer(options: Omit<FooterOptions, 'tenantSlug'>): PptxElement[];
}

/**
 * Layout helpers bound to one render's tenant. A render path that knows its
 * tenant (CLI `--tenant`, the pipeline context's tenant_slug) creates the kit
 * once and builds every slide from it, so the tenant's semantic-token overlay
 * colours the palette, header and footer consistently (no caller has to
 * remember to pass `tenantSlug` to each primitive).
 */
export function createPptxLayoutKit(options: { tenantSlug?: string } = {}): PptxLayoutKit {
  const { tenantSlug } = options;
  return {
    palette: resolvePptxPalette({ tenantSlug }),
    sectionHeader: (title, headerOptions) =>
      sectionHeaderElements(title, { ...headerOptions, tenantSlug }),
    footer: (footerOptions) => footerElements({ ...footerOptions, tenantSlug }),
  };
}
