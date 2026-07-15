import { resolveEastAsianFontFamily } from '../../design-fonts.js';
import type { PptxDesignProtocol, PptxElement, PptxStyle } from '../types/pptx-protocol.js';

/**
 * LE-01: engine-side design-defaults cascade.
 *
 * Both authoring paths (hand-written builder scripts and snapshot/brief
 * protocols rendered via media:pptx_render) converge on generateNativePptx,
 * but only scripts historically injected consistent per-element defaults.
 * Elements arriving without explicit style keys fell through to builder
 * fallbacks nobody chose (18pt text, theme minor font, invisible lines).
 *
 * The cascade is opt-in via `protocol.designDefaults` so existing protocols
 * render byte-identically until they opt in. Explicit values always win;
 * only missing keys are filled.
 */
export interface PptxDesignDefaults {
  /** Applied to text and text-bearing shape elements missing style.fontFamily. */
  fontFamily: string;
  /** Applied to type 'text' elements missing style.fontSize (points). */
  textFontSize: number;
  /** Applied to text-bearing 'shape' elements missing style.fontSize (points). */
  shapeFontSize: number;
  /** Applied to text and text-bearing shape elements missing style.color. */
  textColor: string;
  /** Applied to 'line' elements missing style.line (stroke color). */
  lineColor: string;
  /** Applied to 'line' elements missing style.lineWidth (points). */
  lineWidth: number;
}

export type PptxDesignDefaultsInput = boolean | Partial<PptxDesignDefaults>;

const BUILT_IN_DEFAULTS: Omit<PptxDesignDefaults, 'fontFamily'> = {
  textFontSize: 14,
  shapeFontSize: 12,
  textColor: '#0f172a',
  lineColor: '#94a3b8',
  lineWidth: 1,
};

/**
 * Resolve the concrete defaults for a protocol. The font family follows the
 * protocol theme's minor/major font when present (same keys generateTheme
 * reads), falling back to the brand east-asian-capable family so Japanese
 * text never silently renders in a latin-only face.
 */
export function resolvePptxDesignDefaults(
  protocol: Pick<PptxDesignProtocol, 'theme'>,
  input: PptxDesignDefaultsInput
): PptxDesignDefaults | null {
  if (!input) return null;
  const overrides = typeof input === 'object' ? input : {};
  const theme = protocol.theme || {};
  const themeFont =
    typeof theme.minorFont === 'string'
      ? theme.minorFont
      : typeof theme.majorFont === 'string'
        ? theme.majorFont
        : undefined;
  return {
    fontFamily: overrides.fontFamily ?? resolveEastAsianFontFamily(themeFont),
    textFontSize: overrides.textFontSize ?? BUILT_IN_DEFAULTS.textFontSize,
    shapeFontSize: overrides.shapeFontSize ?? BUILT_IN_DEFAULTS.shapeFontSize,
    textColor: overrides.textColor ?? BUILT_IN_DEFAULTS.textColor,
    lineColor: overrides.lineColor ?? BUILT_IN_DEFAULTS.lineColor,
    lineWidth: overrides.lineWidth ?? BUILT_IN_DEFAULTS.lineWidth,
  };
}

/**
 * Project a themes.json / tenant MediaThemeRecord onto cascade defaults so
 * the brief-driven media-actuator path and tenant overrides feed the same
 * cascade as everything else (LE-02).
 */
export function designDefaultsFromMediaTheme(theme: {
  colors?: { text?: string; secondary?: string };
  fonts?: { body?: string; heading?: string };
}): Partial<PptxDesignDefaults> {
  return {
    fontFamily: resolveEastAsianFontFamily(theme.fonts?.body ?? theme.fonts?.heading),
    ...(theme.colors?.text ? { textColor: theme.colors.text } : {}),
    ...(theme.colors?.secondary ? { lineColor: theme.colors.secondary } : {}),
  };
}

function elementHasText(el: PptxElement): boolean {
  if (typeof el.text === 'string' && el.text.length > 0) return true;
  return Array.isArray(el.textRuns) && el.textRuns.length > 0;
}

function cascadeElement(el: PptxElement, defaults: PptxDesignDefaults): PptxElement {
  if (el.type === 'line') {
    const style: PptxStyle = { ...el.style };
    if (!style.line) style.line = defaults.lineColor;
    if (style.lineWidth === undefined) style.lineWidth = defaults.lineWidth;
    return { ...el, style };
  }
  if (el.type !== 'text' && el.type !== 'shape') return el;
  if (!elementHasText(el)) return el;

  const style: PptxStyle = { ...el.style };
  if (!style.fontFamily) style.fontFamily = defaults.fontFamily;
  if (style.fontSize === undefined) {
    style.fontSize = el.type === 'text' ? defaults.textFontSize : defaults.shapeFontSize;
  }
  // Only standalone text gets a default color; text inside shapes keeps
  // inheriting the theme text color (matches the historical helper behavior).
  if (el.type === 'text' && !style.color) style.color = defaults.textColor;
  return { ...el, style };
}

/**
 * Return a copy of the protocol with missing style keys filled from the
 * cascade. No-op (same reference) when designDefaults is absent/false or
 * when the protocol is in rawParts passthrough mode (raw XML is already
 * fully styled; patching semantics there would be meaningless).
 */
export function applyPptxDesignDefaults(protocol: PptxDesignProtocol): PptxDesignProtocol {
  if (!protocol.designDefaults) return protocol;
  if (protocol.rawParts && Object.keys(protocol.rawParts).length > 0) return protocol;
  const defaults = resolvePptxDesignDefaults(protocol, protocol.designDefaults);
  if (!defaults) return protocol;

  return {
    ...protocol,
    master: {
      ...protocol.master,
      elements: protocol.master.elements.map((el) => cascadeElement(el, defaults)),
    },
    slides: protocol.slides.map((slide) => ({
      ...slide,
      elements: slide.elements.map((el) => cascadeElement(el, defaults)),
    })),
  };
}
