import type { PptxElement, PptxPos, PptxStyle } from '../types/pptx-protocol.js';

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
export const PPTX_PALETTE = {
  navy: '#1E3A5F',
  navyDark: '#0F1F33',
  blue: '#3B82F6',
  blueLight: '#DBEAFE',
  green: '#10B981',
  greenLight: '#D1FAE5',
  orange: '#F59E0B',
  orangeLight: '#FEF3C7',
  purple: '#8B5CF6',
  purpleLight: '#EDE9FE',
  red: '#EF4444',
  redLight: '#FEE2E2',
  gray50: '#F9FAFB',
  gray100: '#F3F4F6',
  gray200: '#E5E7EB',
  gray400: '#9CA3AF',
  gray600: '#4B5563',
  gray700: '#374151',
  gray800: '#1F2937',
  white: '#FFFFFF',
  black: '#000000',
} as const;

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
}

/** Full-width section header: title bar + accent rule underneath. */
export function sectionHeaderElements(
  title: string,
  options: SectionHeaderOptions = {}
): PptxElement[] {
  const w = options.canvasWidth ?? 10;
  const barColor = options.barColor ?? PPTX_PALETTE.navy;
  const accentColor = options.accentColor ?? PPTX_PALETTE.blue;
  const titleColor = options.titleColor ?? PPTX_PALETTE.white;
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
}

/** Footer rule + label + page counter. */
export function footerElements(options: FooterOptions): PptxElement[] {
  const w = options.canvasWidth ?? 10;
  const y = options.y ?? 7.0;
  const ruleColor = options.ruleColor ?? PPTX_PALETTE.navy;
  const textColor = options.textColor ?? PPTX_PALETTE.gray400;
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
