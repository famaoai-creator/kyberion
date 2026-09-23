/**
 * Type declarations for `kyberion-ui.js` (plain JS + JSDoc, no build step).
 *
 * This is the single source of truth for the message keys, icon paths, alias
 * map, `safeHref` and rendered-type list shared with the React renderer in
 * `libs/shared-ui/src` (see `catalog.ts`, `icons.tsx`, `safety.ts`). Kept
 * intentionally loose (`string` keys, not the branded `Kb*` types from
 * `@agent/core/a2ui-catalog`) so this file has no dependency on `@agent/core`;
 * the React side re-exports these values under its stronger public types.
 */

/** Catalog default locale — the language of `KB_UI_DEFAULT_MESSAGES` (generated). */
export declare const KB_UI_DEFAULT_LOCALE: string;

/**
 * Built-in fallback bundle: every `ui:*` vocabulary message in the default
 * locale (generated from user-facing-vocabulary.json; never hand-edited).
 */
export declare const KB_UI_DEFAULT_MESSAGES: Readonly<Record<string, string>>;

/** Vocabulary message key (`ui:status_*`) for every canonical status value. */
export declare const KB_STATUS_MESSAGE_KEYS: Readonly<Record<string, string>>;

/** Domain-specific status message keys, where the wording differs from the default. */
export declare const KB_STATUS_DOMAIN_MESSAGE_KEYS: Readonly<
  Record<string, Readonly<Record<string, string>>>
>;

/** Keys of the other renderer-default strings (empty table, loading, trend words, ...). */
export declare const KB_UI_MESSAGE_KEYS: Readonly<{
  tableEmpty: string;
  skeletonLoading: string;
  unknownComponent: string;
  valueYes: string;
  valueNo: string;
  disclosureSummary: string;
  navLabel: string;
  tabsLabel: string;
  trendUp: string;
  trendDown: string;
  trendFlat: string;
}>;

/** Translate a `ui:*` key (with `{name}` params) to display text. Never throws. */
export type KbTranslate = (key: string, params?: Record<string, unknown>) => string;

export interface KbTranslatorOptions {
  /** One locale's `{ 'ui:<key>': text }` bundle (e.g. `getUiMessageBundle(locale).messages`). */
  messages?: Readonly<Record<string, string>>;
  /** Custom lookup, tried first; a result equal to the key (or empty) falls through. */
  t?: KbTranslate;
}

/** caller `t` → `messages` → generated default-locale bundle → the key. */
export declare function createTranslator(options?: KbTranslatorOptions): KbTranslate;

/** Message key of a status label (domain wording first); null for non-canonical values. */
export declare function statusMessageKey(status: unknown, domain?: string): string | null;

/** Resolve the visible label of a status pill. */
export declare function statusLabel(
  status: unknown,
  domain?: string,
  label?: string,
  translate?: KbTranslate
): string;

/** Legacy protocol types rendered as catalog components. */
export declare const KB_ALIASES: Readonly<Record<string, string>>;

/** 24x24 stroke icon path data, keyed by icon name (nav-rail items, metric trend arrows). */
export declare const KB_ICON_PATHS: Readonly<Record<string, readonly string[]>>;

/**
 * Return a navigable href, or null when unsafe (see the JSDoc on the
 * implementation for the exact rules: allow-listed schemes, no
 * protocol-relative / backslash targets, no control characters).
 */
export declare function safeHref(value: unknown): string | null;

/** Resolve a component type (or legacy alias) to its `ui:*` type; null when unknown. */
export declare function resolveType(type: unknown): string | null;

/** Every `ui:*` type this renderer has a component for, in catalog order. */
export declare const KB_RENDERED_TYPES: readonly string[];

export interface KbAction {
  id: string;
  payload?: Record<string, unknown>;
}

export interface A2UIComponent {
  id: string;
  type: string;
  props?: Record<string, unknown>;
  children?: readonly string[];
}

export interface RenderOptions extends KbTranslatorOptions {
  /** Locale of `messages` (default: `KB_UI_DEFAULT_LOCALE`). */
  locale?: string;
  onAction?: (action: KbAction, component: A2UIComponent) => void;
  debug?: boolean;
  document?: Document;
  window?: Window;
  lookup?: Map<string, A2UIComponent>;
}

/**
 * Render one component (and, through `options.lookup`, its children) to a
 * DOM element. Returns null for unknown types (a warning callout when
 * `debug: true`).
 */
export declare function renderComponent(
  component: A2UIComponent,
  options?: RenderOptions
): Element | null;

/**
 * Replace `container`'s content with the rendered A2UI component list.
 */
export declare function renderA2UI(
  container: Element,
  components: A2UIComponent[],
  options?: RenderOptions & { rootId?: string }
): Element;
