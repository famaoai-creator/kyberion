/**
 * Type declarations for `pads.js` (PA-01 pad components: `ui:toolbar`,
 * `ui:dialog`, `ui:drawing-palette`, `ui:sketch-board`; plain JS + JSDoc, no
 * build step) and the sibling modules it re-exports (`toolbar.js`,
 * `dialog.js`, `drawing-core.js`, `drawing-engine.js`, `drawing.js`). The
 * React renderer (`src/pads/*`) imports the pure helpers and the drawing
 * engine from here. Kept loose (no `@agent/core` types) like
 * `kyberion-ui.d.ts`.
 */

type Translate = (key: string, params?: Record<string, unknown>) => string;
type ActionRef = { id: string; payload?: Record<string, unknown> } | string | undefined;

export interface KbResolvedPadAction {
  id: string;
  payload: Record<string, unknown> | undefined;
}

// -- toolbar -----------------------------------------------------------------

export declare const KB_TOOLBAR_ACTIONS: Readonly<{ click: string; toggle: string; files: string }>;
export declare const KB_TOOLBAR_ITEM_TYPES: readonly string[];

export interface KbToolbarItemModel {
  key: string;
  type: 'button' | 'toggle' | 'file' | 'separator' | 'spacer' | 'status';
  id: string;
  label: string;
  icon: string;
  hideLabel: boolean;
  variant: 'primary' | 'secondary' | 'danger' | 'ghost';
  pressed: boolean;
  disabled: boolean;
  action: unknown;
  accept: string;
  multiple: boolean;
  text: string;
  /** Tooltip + `aria-describedby` text (controls only; '' when unset). */
  description: string;
  tone: string;
  control: boolean;
  focusable: boolean;
}

export declare function toolbarItems(p: unknown): KbToolbarItemModel[];
export declare function toolbarInitialFocus(items: readonly KbToolbarItemModel[]): number;
export declare function toolbarRovingTarget(
  items: readonly KbToolbarItemModel[],
  current: number,
  key: string | undefined
): number;
export declare function toolbarItemAction(item: KbToolbarItemModel): KbResolvedPadAction;
export declare function toolbarDescriptionId(
  componentId: unknown,
  item: KbToolbarItemModel
): string;
export declare function toolbarItemTitle(item: KbToolbarItemModel): string;
export declare function toolbarPayload(
  item: KbToolbarItemModel,
  runtime: Record<string, unknown>
): Record<string, unknown>;

// -- dialog ------------------------------------------------------------------

export declare const KB_DIALOG_ACTIONS: Readonly<{ confirm: string; cancel: string }>;
export declare const KB_DIALOG_MESSAGE_KEYS: Readonly<{ confirm: string; cancel: string }>;

export interface KbDialogIds {
  root: string;
  title: string;
  message: string;
  input: string;
}

export interface KbDialogButtonModel {
  kind: 'choice' | 'confirm' | 'cancel';
  choice: string;
  label: string;
  variant: 'primary' | 'secondary' | 'danger' | 'ghost';
  primary: boolean;
}

export interface KbDialogModel {
  open: boolean;
  title: string;
  message: string;
  danger: boolean;
  role: 'dialog' | 'alertdialog';
  input: {
    name: string;
    label: string;
    placeholder: string;
    value: string;
    multiline: boolean;
  } | null;
  buttons: KbDialogButtonModel[];
}

export declare function dialogIds(componentId: unknown): KbDialogIds;
export declare function dialogModel(p: unknown, t: Translate): KbDialogModel;
export declare function dialogAction(action: ActionRef, fallback: string): KbResolvedPadAction;
export declare function dialogResult(
  p: unknown,
  model: KbDialogModel,
  button: KbDialogButtonModel,
  value: string
): { id: string; payload: Record<string, unknown> };
export declare function dialogCancelResult(p: unknown): {
  id: string;
  payload: Record<string, unknown>;
};
export declare function dialogTrapTarget<T>(
  focusables: ReadonlyArray<T | null | undefined>,
  active: unknown,
  shiftKey: boolean
): T | null;
export declare function dialogFocusables<T = HTMLElement>(panel: unknown): T[];
export declare function focusRootOf(node: unknown, doc: unknown): unknown;
export declare function activeElementFor(node: unknown, doc: unknown): Element | null;
export declare function isConnected(node: unknown): boolean;

// -- drawing -----------------------------------------------------------------

export type KbDrawingToolName =
  'pen' | 'highlighter' | 'rect' | 'ellipse' | 'line' | 'arrow' | 'text' | 'eraser';

export declare const KB_DRAWING_ACTIONS: Readonly<{
  change: string;
  undo: string;
  clear: string;
  ready: string;
  background: string;
}>;
export declare const KB_DRAWING_TOOLS: readonly KbDrawingToolName[];
export declare const KB_DRAWING_DEFAULT_TOOLS: readonly KbDrawingToolName[];
export declare const KB_DRAWING_DEFAULT_COLORS: readonly string[];
export declare const KB_DRAWING_BACKGROUNDS: Readonly<Record<string, string | null>>;
export declare const KB_DRAWING_DEFAULT_WIDTH: number;
export declare const KB_SKETCH_DEFAULT_SIZE: Readonly<{ width: number; height: number }>;
export declare const KB_SKETCH_DEFAULT_MAX_UNDO: number;
export declare const KB_DRAWING_MESSAGE_KEYS: Readonly<{
  tools: string;
  colors: string;
  color: string;
  customColor: string;
  width: string;
  widthValue: string;
  undo: string;
  clear: string;
  sketchCanvas: string;
  sketchTextInput: string;
  sketchDownload: string;
  sketchClearTitle: string;
  sketchClearMessage: string;
  sketchClearConfirm: string;
  sketchDropHint: string;
  sketchBackgroundAdded: string;
  sketchBackgroundRejected: string;
}>;
export declare const KB_DRAWING_TOOL_MESSAGE_KEYS: Readonly<Record<KbDrawingToolName, string>>;
export declare const KB_DRAWING_ICON_PATHS: Readonly<Record<string, readonly string[]>>;

export interface KbDrawingPaletteState {
  tools: KbDrawingToolName[];
  tool: KbDrawingToolName;
  colors: string[];
  color: string;
  width: number;
  min: number;
  max: number;
}

export declare function normalizeHexColor(value: unknown): string | null;
export declare function customColorView(state: unknown): { active: boolean; color: string };
export declare function drawingTools(value: unknown): KbDrawingToolName[];
export declare function drawingColors(value: unknown): string[];
export declare function drawingWidthRange(p: unknown): { min: number; max: number };
export declare function clampDrawingWidth(
  value: unknown,
  range: { min: number; max: number },
  fallback?: number
): number;
export declare function drawingPaletteState(
  p: unknown,
  keys?: { tool: string; color: string; width: string }
): KbDrawingPaletteState;
export declare function rovingIndex(
  key: string | undefined,
  current: number,
  count: number
): number;
export declare function sketchFileName(name: unknown): string;
export declare function sketchDownloadName(p: unknown): string;
export declare function sketchPasteScope(p: unknown): 'board' | 'document';
export declare function isEditablePasteTarget(event: unknown): boolean;
export declare function drawingIds(
  componentId: unknown,
  name: unknown
): { root: string; width: string; hint: string; dialog: string };

export interface KbDrawingPoint {
  x: number;
  y: number;
}

export interface KbDrawingTextRequest extends KbDrawingPoint {
  /** Position in % of the canvas box (for the inline text input). */
  left: number;
  top: number;
}

export interface KbDrawingEngineOptions {
  canvas: unknown;
  doc?: unknown;
  win?: unknown;
  width?: number;
  height?: number;
  background?: string;
  maxUndo?: number;
  tool?: string;
  color?: string;
  size?: number;
  onCommit?: (count: number) => void;
  onTextRequest?: (request: KbDrawingTextRequest) => void;
}

export interface KbDrawingEngine {
  readonly width: number;
  readonly height: number;
  setTool(tool: string): void;
  setColor(color: string): void;
  setWidth(size: number): void;
  getState(): { tool: KbDrawingToolName; color: string; size: number };
  strokeCount(): number;
  canUndo(): boolean;
  isEmpty(): boolean;
  hasBackground(): boolean;
  undo(): boolean;
  clear(): void;
  addText(at: KbDrawingPoint, value: string): boolean;
  setBackgroundImage(source: Blob | string | null): Promise<boolean>;
  /** Place an image into the undoable / clearable drawing layer. */
  addImage(source: Blob | string): Promise<boolean>;
  toBlob(): Promise<Blob>;
  render(): void;
  dispose(): void;
}

/** What `drawing.ready` hands the host. */
export interface KbSketchControllerRuntime {
  toBlob(): Promise<Blob>;
  isEmpty(): boolean;
  clear(): void;
  undo(): void;
  /** File/Blob, `blob:` / `data:image/*` URL, http(s) / same-origin URL; null removes. */
  setBackgroundImage(source: Blob | string | null): Promise<boolean>;
  loadImage(
    source: Blob | string,
    options?: { layer?: 'background' | 'drawing' }
  ): Promise<boolean>;
}

export declare function sketchImageSource(
  source: unknown,
  safeHref: (value: unknown) => string | null
): { kind: 'blob'; blob: Blob } | { kind: 'url'; url: string; crossOrigin: boolean } | null;
export declare function createSketchController(
  engine: KbDrawingEngine,
  options: {
    safeHref: (value: unknown) => string | null;
    onChange?: () => void;
    live?: () => boolean;
  }
): KbSketchControllerRuntime;

export declare function createDrawingEngine(options: KbDrawingEngineOptions): KbDrawingEngine;
export declare function paintStroke(g: unknown, stroke: unknown): void;
export declare function isVisibleStroke(stroke: unknown): boolean;
export declare function containFit(
  imageWidth: number,
  imageHeight: number,
  width: number,
  height: number
): { x: number; y: number; w: number; h: number };
export declare function sketchTextSize(width: number): number;
export declare function sketchCanvasSize(p: unknown): { width: number; height: number };
export declare function sketchBackground(value: unknown): 'dark' | 'light' | 'transparent';
export declare function isImageFile(file: unknown): boolean;
export declare function sketchClearDialogProps(
  t: Translate,
  open: boolean
): { open: boolean; title: string; message: string; tone: 'danger'; confirm_label: string };

// -- renderer factory --------------------------------------------------------

export declare const KB_PAD_TYPES: readonly string[];
export declare function createPadRenderers(h: {
  el: (...args: never[]) => unknown;
  setData: (...args: never[]) => unknown;
  safeHref: (value: unknown) => string | null;
  appendChildren?: (...args: never[]) => unknown;
}): Record<string, (ctx: unknown, props: Record<string, unknown>, component: unknown) => unknown>;
