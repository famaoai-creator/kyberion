/*
 * Kyberion UI — pad components (PA-01, PADS_A2UI_AND_AVATAR_PLAN_2026-09-23
 * §3): `ui:toolbar`, `ui:dialog`, `ui:drawing-palette`, `ui:sketch-board`.
 *
 * `kyberion-ui.js` merges `createPadRenderers(...)` into its renderer table;
 * the React renderer (`libs/shared-ui/src/pads/*`) imports the pure helpers
 * and the drawing engine re-exported here, so both renderers behave the
 * same. Sibling modules (`toolbar.js`, `dialog.js`, `drawing*.js`) are served
 * next to this one (fixed allow-list).
 */
import { createToolbarRenderer } from './toolbar.js';
import { createDialogRenderer } from './dialog.js';
import { createDrawingRenderers } from './drawing.js';

export {
  KB_TOOLBAR_ACTIONS,
  KB_TOOLBAR_ITEM_TYPES,
  toolbarItems,
  toolbarInitialFocus,
  toolbarRovingTarget,
  toolbarItemAction,
  toolbarPayload,
} from './toolbar.js';
export {
  KB_DIALOG_ACTIONS,
  KB_DIALOG_MESSAGE_KEYS,
  dialogIds,
  dialogModel,
  dialogAction,
  dialogResult,
  dialogCancelResult,
  dialogTrapTarget,
  isConnected,
} from './dialog.js';
export {
  KB_DRAWING_ACTIONS,
  KB_DRAWING_TOOLS,
  KB_DRAWING_DEFAULT_TOOLS,
  KB_DRAWING_DEFAULT_COLORS,
  KB_DRAWING_BACKGROUNDS,
  KB_DRAWING_DEFAULT_WIDTH,
  KB_SKETCH_DEFAULT_SIZE,
  KB_SKETCH_DEFAULT_MAX_UNDO,
  KB_DRAWING_MESSAGE_KEYS,
  KB_DRAWING_TOOL_MESSAGE_KEYS,
  KB_DRAWING_ICON_PATHS,
  normalizeHexColor,
  drawingTools,
  drawingColors,
  drawingWidthRange,
  clampDrawingWidth,
  drawingPaletteState,
  rovingIndex,
  sketchFileName,
  drawingIds,
} from './drawing-core.js';
export {
  createDrawingEngine,
  paintStroke,
  isVisibleStroke,
  containFit,
  sketchTextSize,
} from './drawing-engine.js';
export {
  sketchCanvasSize,
  sketchBackground,
  isImageFile,
  sketchClearDialogProps,
} from './drawing.js';

/** Catalog types this module renders (catalog order). */
export const KB_PAD_TYPES = Object.freeze([
  'ui:toolbar',
  'ui:dialog',
  'ui:drawing-palette',
  'ui:sketch-board',
]);

/**
 * Build the pad renderers on top of `kyberion-ui.js`'s helpers (passed in to
 * keep this module free of a circular import).
 * @param {{ el: Function, setData: Function, safeHref: (value: unknown) => string | null }} h
 */
export function createPadRenderers(h) {
  return {
    ...createToolbarRenderer(h),
    ...createDialogRenderer(h),
    ...createDrawingRenderers(h),
  };
}
