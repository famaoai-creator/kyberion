import type { PdfVectorElement } from '../../contracts/pdf-protocol.js';

/**
 * Graphic element emitted by `extractGraphicElements` (rect/border built from
 * content-stream `re`/`S`/`B`/`f` ops). Colors are hex strings at this stage.
 */
export interface PdfExtractedGraphicElement {
  type?: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  fillColor?: string;
  strokeColor?: string;
  lineWidth?: number;
  opacity?: number;
}

export function hexColorToRgb(hex?: string): [number, number, number] | undefined {
  if (!hex || !/^[0-9A-Fa-f]{6}$/.test(hex)) return undefined;
  return [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as [number, number, number];
}

/**
 * Graphic elements (`rect`/`border`) extracted from content-stream `re`/`S`/`B`/`f`
 * ops belong on the render path (`page.vectors`) — `buildAestheticContent`
 * only draws text/heading elements, so leaving them solely in `elements`
 * silently drops every box, rule and table fill on round-trip. Elements keep
 * their place in `page.elements`/`aesthetic.elements` for analysis; the
 * vectors are an additional render-ready projection.
 */
export function graphicElementsToPageVectors(
  elements: PdfExtractedGraphicElement[] | undefined
): PdfVectorElement[] {
  const vectors: PdfVectorElement[] = [];
  for (const el of elements ?? []) {
    if (el?.type !== 'rect' && el?.type !== 'border') continue;
    const fillColor = hexColorToRgb(el.fillColor);
    const strokeColor = hexColorToRgb(el.strokeColor);
    if (!fillColor && !strokeColor) continue;
    vectors.push({
      shape: {
        kind: 'rect',
        x: el.x ?? 0,
        y: el.y ?? 0,
        width: el.width ?? 0,
        height: el.height ?? 0,
      },
      ...(fillColor ? { fillColor } : {}),
      ...(strokeColor ? { strokeColor } : {}),
      ...(el.lineWidth !== undefined ? { lineWidth: el.lineWidth } : {}),
      ...(el.opacity !== undefined ? { fillOpacity: el.opacity } : {}),
    });
  }
  return vectors;
}
