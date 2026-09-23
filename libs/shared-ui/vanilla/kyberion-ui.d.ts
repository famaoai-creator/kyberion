/**
 * Type declarations for `kyberion-ui.js` (plain JS + JSDoc, no build step).
 *
 * This is the single source of truth for the label maps, icon paths, alias
 * map, `safeHref` and rendered-type list shared with the React renderer in
 * `libs/shared-ui/src` (see `catalog.ts`, `icons.tsx`, `safety.ts`). Kept
 * intentionally loose (`string` keys, not the branded `Kb*` types from
 * `@agent/core/a2ui-catalog`) so this file has no dependency on `@agent/core`;
 * the React side re-exports these values under its stronger public types.
 */

/** Default Japanese label for every canonical status value. */
export declare const KB_STATUS_LABELS_JA: Readonly<Record<string, string>>;

/** Domain-specific status wording, where it differs from `KB_STATUS_LABELS_JA`. */
export declare const KB_STATUS_DOMAIN_LABELS_JA: Readonly<
  Record<string, Readonly<Record<string, string>>>
>;

/** Resolve the visible label of a status pill. */
export declare function statusLabel(status: unknown, domain?: string, label?: string): string;

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

export interface RenderOptions {
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
