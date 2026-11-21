/**
 * Responsive layout: pure function of terminal size and view, so it is
 * unit-testable and every component receives explicit widths (Ink flexbox
 * with long unwrapped lines otherwise overflows and reflows on each frame).
 */

export type ViewId = 'conversation' | 'missions' | 'terminals';

export const VIEW_ORDER: readonly ViewId[] = ['conversation', 'missions', 'terminals'];

export interface DeckLayout {
  columns: number;
  rows: number;
  /** One column at a time below the breakpoint. */
  compact: boolean;
  railWidth: number;
  mainWidth: number;
  agentsWidth: number;
  /** Rows available between header and composer/footer. */
  bodyRows: number;
  /** Grid shape for the terminals view. */
  grid: { cols: number; tileWidth: number; tileRows: number };
}

export const COMPACT_BELOW = 100;
const HEADER_ROWS = 2;
const FOOTER_ROWS = 4;

export function computeLayout(
  columns: number,
  rows: number,
  view: ViewId,
  agentCount: number
): DeckLayout {
  const safeColumns = Math.max(40, columns || 80);
  const safeRows = Math.max(12, rows || 24);
  const compact = safeColumns < COMPACT_BELOW;
  const bodyRows = Math.max(6, safeRows - HEADER_ROWS - FOOTER_ROWS);

  let railWidth = 0;
  let agentsWidth = 0;
  if (!compact) {
    railWidth = Math.min(38, Math.max(26, Math.floor(safeColumns * 0.24)));
    if (view === 'conversation') {
      agentsWidth = Math.min(48, Math.max(30, Math.floor(safeColumns * 0.28)));
    }
    if (view === 'terminals') railWidth = 0;
  }
  const mainWidth = Math.max(20, safeColumns - railWidth - agentsWidth);

  const tiles = Math.max(1, agentCount);
  const gridCols = compact ? 1 : Math.min(3, tiles, Math.max(1, Math.floor(mainWidth / 40)));
  const gridRowsOfTiles = Math.ceil(tiles / gridCols);
  const tileRows = Math.max(5, Math.floor(bodyRows / Math.max(1, Math.min(gridRowsOfTiles, 3))));

  return {
    columns: safeColumns,
    rows: safeRows,
    compact,
    railWidth,
    mainWidth,
    agentsWidth,
    bodyRows,
    grid: { cols: gridCols, tileWidth: Math.floor(mainWidth / gridCols), tileRows },
  };
}

/** Truncate to a display width, counting East Asian wide characters as 2. */
export function fitWidth(text: string, width: number): string {
  if (width <= 0) return '';
  if (displayWidth(text) <= width) return text;
  let used = 0;
  let out = '';
  for (const ch of text) {
    const w = charWidth(ch);
    if (used + w > width - 1) break;
    out += ch;
    used += w;
  }
  return out + '…';
}

export function displayWidth(text: string): number {
  let used = 0;
  for (const ch of text) used += charWidth(ch);
  return used;
}

function charWidth(ch: string): number {
  const code = ch.codePointAt(0) ?? 0;
  if (code === 0) return 0;
  if (code < 0x1100) return 1;
  if (
    code <= 0x115f ||
    (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe4f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1faff) ||
    (code >= 0x20000 && code <= 0x3fffd)
  ) {
    return 2;
  }
  return 1;
}
