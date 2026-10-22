/**
 * Renderer — turns one surface in the store into a node tree.
 *
 * The renderer is generic over the DOM adapter, so it is exercised in tests
 * with the fake adapter and in the browser with the real one. It resolves the
 * component tree (canonical `children` id references plus inline
 * `props.items`), resolves `{ "$ref": ... }` props against the surface data
 * model, and routes action clicks to `onAction`. Depth is bounded so a
 * malicious or looping producer cannot exhaust the stack.
 */
import { parseActionDescriptor, type ActionDescriptor } from './actions.js';
import type { DomAdapter } from './dom.js';
import { isInlineComponent, type A2UIComponent, type A2UIDataModel } from './protocol.js';
import {
  DEFAULT_RENDERER_STRINGS,
  type ComponentRegistry,
  type RenderContext,
  type RendererStrings,
} from './registry.js';
import type { SurfaceStore } from './store.js';

export const MAX_RENDER_DEPTH = 24;

export interface RenderOptions<N> {
  adapter: DomAdapter<N>;
  registry: ComponentRegistry<N>;
  onAction?: (action: ActionDescriptor, component: A2UIComponent) => void;
  strings?: Partial<RendererStrings>;
}

export interface RenderReport {
  rendered: number;
  unsupported: string[];
  depthExceeded: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** Look up a dot path in the data model; undefined when any step is missing. */
export function readDataPath(data: A2UIDataModel, path: string): unknown {
  let cursor: unknown = data;
  for (const step of path.split('.')) {
    if (!isRecord(cursor) || !(step in cursor)) return undefined;
    cursor = cursor[step];
  }
  return cursor;
}

/** Resolve `{ "$ref": "a.b" }` against the data model; other values pass through. */
export function resolveValue(value: unknown, data: A2UIDataModel): unknown {
  if (isRecord(value) && typeof value.$ref === 'string' && Object.keys(value).length === 1) {
    return readDataPath(data, value.$ref);
  }
  return value;
}

export function asText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return '';
  }
}

/**
 * Render `surfaceId` from `store` into `container` (cleared first).
 * Returns a report the host can show in an inspector.
 */
export function renderSurface<N>(
  container: N,
  store: SurfaceStore,
  surfaceId: string,
  options: RenderOptions<N>
): RenderReport {
  const { adapter, registry } = options;
  const strings: RendererStrings = { ...DEFAULT_RENDERER_STRINGS, ...(options.strings ?? {}) };
  const report: RenderReport = { rendered: 0, unsupported: [], depthExceeded: false };
  adapter.clear(container);

  const surface = store.get(surfaceId);
  const tree = store.tree(surfaceId);
  if (!surface || !tree.roots.length) {
    adapter.append(container, h('p', 'a2ui-empty', strings.empty));
    return report;
  }
  const data = surface.data;

  function h(tag: string, className?: string, text?: string): N {
    const node = adapter.create(tag, className);
    if (text !== undefined) adapter.setText(node, text);
    return node;
  }

  function renderOne(component: A2UIComponent, depth: number): N | null {
    if (depth > MAX_RENDER_DEPTH) {
      report.depthExceeded = true;
      return null;
    }
    if (!registry.has(component.type) && !report.unsupported.includes(component.type)) {
      report.unsupported.push(component.type);
    }
    const ctx: RenderContext<N> = {
      adapter,
      h,
      text: asText,
      prop: (target, name) => resolveValue(target.props[name], data),
      renderChildren: (parent) =>
        tree
          .childrenOf(parent.id)
          .map((child) => renderOne(child, depth + 1))
          .filter((node): node is N => node !== null),
      renderInline: (parent, items) =>
        (Array.isArray(items) ? items : [])
          .map((item, index) =>
            isInlineComponent(item)
              ? renderOne(
                  {
                    id: `${parent.id}:${index}`,
                    type: item.type as A2UIComponent['type'],
                    props: item.props,
                  },
                  depth + 1
                )
              : null
          )
          .filter((node): node is N => node !== null),
      dispatch: (action, source) => options.onAction?.(action, source),
      data,
      strings,
    };
    const node = registry.resolve(component.type)(component, ctx);
    adapter.setAttribute(node, 'data-a2ui-id', component.id);
    adapter.setAttribute(node, 'data-a2ui-type', component.type);
    report.rendered += 1;
    return node;
  }

  for (const root of tree.roots) {
    const node = renderOne(root, 0);
    if (node) adapter.append(container, node);
  }
  return report;
}

/** Collect every valid action descriptor found in a surface's components. */
export function collectActions(components: readonly A2UIComponent[]): Array<{
  component: A2UIComponent;
  label: string;
  action: ActionDescriptor;
}> {
  const found: Array<{ component: A2UIComponent; label: string; action: ActionDescriptor }> = [];
  const visit = (component: A2UIComponent): void => {
    const action = parseActionDescriptor(component.props.action);
    if (action)
      found.push({
        component,
        label: asText(component.props.label) || action.operation_id,
        action,
      });
    const items = component.props.items;
    if (Array.isArray(items)) {
      items.forEach((item, index) => {
        if (isInlineComponent(item)) {
          visit({
            id: `${component.id}:${index}`,
            type: item.type as A2UIComponent['type'],
            props: item.props,
          });
        }
      });
    }
  };
  components.forEach(visit);
  return found;
}
