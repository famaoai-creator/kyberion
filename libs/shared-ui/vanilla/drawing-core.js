/*
 * Kyberion UI — drawing constants and pure helpers (PA-01,
 * PADS_A2UI_AND_AVATAR_PLAN_2026-09-23 §3) shared by `ui:drawing-palette`
 * and `ui:sketch-board` in BOTH renderers (vanilla `drawing.js`, React
 * `src/pads/drawing.tsx`). Nothing here touches the DOM.
 *
 * The default swatch set lives here once: mid-luminance hues that stay
 * readable on the dark AND the light canvas background (no pure black /
 * white — `allow_custom_color` covers those).
 */

/** Mirrors `KB_DRAWING_ACTIONS` in libs/core/a2ui-catalog.ts (pinned by tests). */
export const KB_DRAWING_ACTIONS = Object.freeze({
  change: 'drawing.change',
  undo: 'drawing.undo',
  clear: 'drawing.clear',
  ready: 'drawing.ready',
  background: 'drawing.background',
});

/** Every drawing tool, in palette order. */
export const KB_DRAWING_TOOLS = Object.freeze([
  'pen',
  'highlighter',
  'rect',
  'ellipse',
  'line',
  'arrow',
  'text',
  'eraser',
]);

/** Tools shown when the props give none. */
export const KB_DRAWING_DEFAULT_TOOLS = Object.freeze([
  'pen',
  'rect',
  'ellipse',
  'line',
  'arrow',
  'text',
  'eraser',
]);

/** Default swatches (lowercase `#rrggbb`); readable on both canvas backgrounds. */
export const KB_DRAWING_DEFAULT_COLORS = Object.freeze([
  '#e5484d',
  '#f76b15',
  '#30a46c',
  '#12a594',
  '#0090ff',
  '#8e4ec6',
  '#d6409f',
  '#8b8d98',
]);

/** Canvas fill per `background` (null = transparent). Painted into the PNG export too. */
export const KB_DRAWING_BACKGROUNDS = Object.freeze({
  dark: '#15171c',
  light: '#ffffff',
  transparent: null,
});

export const KB_DRAWING_DEFAULT_WIDTH = 4;
export const KB_DRAWING_MIN_WIDTH = 1;
export const KB_DRAWING_MAX_WIDTH = 48;
export const KB_SKETCH_DEFAULT_SIZE = Object.freeze({ width: 1280, height: 720 });
export const KB_SKETCH_DEFAULT_MAX_UNDO = 40;

/** Vocabulary keys (`ui:*`) of every drawing default string. */
export const KB_DRAWING_MESSAGE_KEYS = Object.freeze({
  tools: 'ui:drawing_tools',
  colors: 'ui:drawing_colors',
  color: 'ui:drawing_color',
  customColor: 'ui:drawing_custom_color',
  width: 'ui:drawing_width',
  widthValue: 'ui:drawing_width_value',
  undo: 'ui:drawing_undo',
  clear: 'ui:drawing_clear',
  sketchCanvas: 'ui:sketch_canvas',
  sketchTextInput: 'ui:sketch_text_input',
  sketchDownload: 'ui:sketch_download',
  sketchClearTitle: 'ui:sketch_clear_title',
  sketchClearMessage: 'ui:sketch_clear_message',
  sketchClearConfirm: 'ui:sketch_clear_confirm',
  sketchDropHint: 'ui:sketch_drop_hint',
  sketchBackgroundAdded: 'ui:sketch_background_added',
  sketchBackgroundRejected: 'ui:sketch_background_rejected',
});

/** Tool name → vocabulary key of its accessible label. */
export const KB_DRAWING_TOOL_MESSAGE_KEYS = Object.freeze({
  pen: 'ui:drawing_tool_pen',
  highlighter: 'ui:drawing_tool_highlighter',
  rect: 'ui:drawing_tool_rect',
  ellipse: 'ui:drawing_tool_ellipse',
  line: 'ui:drawing_tool_line',
  arrow: 'ui:drawing_tool_arrow',
  text: 'ui:drawing_tool_text',
  eraser: 'ui:drawing_tool_eraser',
});

/** Shared glyphs (24px grid, stroke = currentColor) for tools and palette actions. */
export const KB_DRAWING_ICON_PATHS = Object.freeze({
  pen: ['M4 20l4-1 11-11-3-3L5 16z', 'M14 6l3 3'],
  highlighter: ['M15 4l5 5-8 8H7v-5z', 'M7 17l-3 3h5'],
  rect: ['M5 6h14v12H5z'],
  ellipse: ['M12 18c4.4 0 8-2.7 8-6s-3.6-6-8-6-8 2.7-8 6 3.6 6 8 6z'],
  line: ['M5 19L19 5'],
  arrow: ['M5 19L19 5', 'M10 5h9v9'],
  text: ['M5 7V5h14v2', 'M12 5v14', 'M9 19h6'],
  eraser: ['M8 20h12', 'M4 15l9-9 6 6-7 7H8z', 'M9 10l6 6'],
  undo: ['M9 14L4 9l5-5', 'M4 9h10a6 6 0 0 1 0 12h-3'],
  clear: ['M4 7h16', 'M9 7V4h6v3', 'M6 7l1 13h10l1-13'],
  download: ['M12 4v12', 'M6 10l6 6 6-6', 'M4 20h16'],
});

const HEX6 = /^#[0-9a-f]{6}$/i;
const HEX3 = /^#[0-9a-f]{3}$/i;

/** `#rgb` / `#rrggbb` → lowercase `#rrggbb`; null for anything else. */
export function normalizeHexColor(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (HEX6.test(trimmed)) return trimmed.toLowerCase();
  if (HEX3.test(trimmed)) {
    const [, r, g, b] = trimmed.toLowerCase();
    return `#${r}${r}${g}${g}${b}${b}`;
  }
  return null;
}

/** Valid, de-duplicated tool list in the caller's order (default set when none survive). */
export function drawingTools(value) {
  if (!Array.isArray(value)) return [...KB_DRAWING_DEFAULT_TOOLS];
  const out = [];
  for (const tool of value) {
    if (KB_DRAWING_TOOLS.includes(tool) && !out.includes(tool)) out.push(tool);
  }
  return out.length > 0 ? out : [...KB_DRAWING_DEFAULT_TOOLS];
}

/** Valid, de-duplicated swatch list (max 24; default set when none survive). */
export function drawingColors(value) {
  if (!Array.isArray(value)) return [...KB_DRAWING_DEFAULT_COLORS];
  const out = [];
  for (const color of value) {
    const hex = normalizeHexColor(color);
    if (hex && !out.includes(hex)) out.push(hex);
    if (out.length >= 24) break;
  }
  return out.length > 0 ? out : [...KB_DRAWING_DEFAULT_COLORS];
}

/** `{ min, max }` stroke-width range from `min_width` / `max_width`. */
export function drawingWidthRange(p) {
  const record = p && typeof p === 'object' ? p : {};
  const min =
    Number.isFinite(record.min_width) && record.min_width >= KB_DRAWING_MIN_WIDTH
      ? Math.round(record.min_width)
      : KB_DRAWING_MIN_WIDTH;
  const rawMax =
    Number.isFinite(record.max_width) && record.max_width <= KB_DRAWING_MAX_WIDTH
      ? Math.round(record.max_width)
      : 24;
  return { min, max: Math.max(min, rawMax) };
}

/** Clamp a width into `range` (rounded); `fallback` when not a number. */
export function clampDrawingWidth(value, range, fallback = KB_DRAWING_DEFAULT_WIDTH) {
  const base = Number.isFinite(value) ? value : fallback;
  return Math.min(range.max, Math.max(range.min, Math.round(base)));
}

/**
 * Resolved palette state from props: `{ tools, tool, colors, color, width,
 * min, max }`. `keys` names the props to read (`tool`/`color`/`width` for the
 * controlled palette, `default_*` for the sketch board).
 */
export function drawingPaletteState(p, keys = { tool: 'tool', color: 'color', width: 'width' }) {
  const record = p && typeof p === 'object' ? p : {};
  const tools = drawingTools(record.tools);
  const colors = drawingColors(record.colors);
  const range = drawingWidthRange(record);
  const tool = tools.includes(record[keys.tool]) ? record[keys.tool] : tools[0];
  const color = normalizeHexColor(record[keys.color]) || colors[0];
  const width = clampDrawingWidth(record[keys.width], range);
  return { tools, tool, colors, color, width, min: range.min, max: range.max };
}

/**
 * Roving-focus target for a key in a one-dimensional group of `count` items
 * (ArrowLeft/Up = previous, ArrowRight/Down = next, both wrapping; Home /
 * End). Returns the new index, or -1 when the key does not move focus.
 */
export function rovingIndex(key, current, count) {
  if (count <= 0) return -1;
  const from = current >= 0 && current < count ? current : 0;
  switch (key) {
    case 'ArrowLeft':
    case 'ArrowUp':
      return (from - 1 + count) % count;
    case 'ArrowRight':
    case 'ArrowDown':
      return (from + 1) % count;
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
    default:
      return -1;
  }
}

/** File name for the PNG export (`<name>.png`, filesystem-safe). */
export function sketchFileName(name) {
  const base = typeof name === 'string' ? name.replace(/[^A-Za-z0-9._-]+/g, '-') : '';
  const trimmed = base.replace(/^[.-]+|[.-]+$/g, '');
  return `${trimmed || 'sketch'}.png`;
}

/** Deterministic DOM ids of a palette / sketch board (from the component id, else `name`). */
export function drawingIds(componentId, name) {
  const raw =
    typeof componentId === 'string' && componentId
      ? componentId
      : typeof name === 'string' && name
        ? name
        : 'drawing';
  const base = `kbd-${raw.replace(/[^A-Za-z0-9_-]/g, '-')}`;
  return { root: base, width: `${base}-width`, hint: `${base}-hint`, dialog: `${base}-clear` };
}
