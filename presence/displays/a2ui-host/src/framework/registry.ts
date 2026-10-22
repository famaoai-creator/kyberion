/**
 * Component registry — the catalog of types the host knows how to draw.
 *
 * A renderer is a plain function `(component, ctx) => node`. The context
 * hands it everything it may need (element factory, resolved props, child
 * rendering, action dispatch) so renderers stay declarative and never reach
 * for the document. Unknown types fall back to a visible placeholder — the
 * host degrades, it does not break.
 */
import type { ActionDescriptor } from './actions.js';
import type { DomAdapter } from './dom.js';
import type { A2UIComponent, A2UIDataModel } from './protocol.js';

export interface RendererStrings {
  unsupported: string;
  empty: string;
}

export const DEFAULT_RENDERER_STRINGS: RendererStrings = {
  unsupported: 'Unsupported component',
  empty: 'Nothing to show yet',
};

export interface RenderContext<N> {
  adapter: DomAdapter<N>;
  /** Element factory with optional text content. */
  h(tag: string, className?: string, text?: string): N;
  /** Coerce any prop value to display text (objects become JSON). */
  text(value: unknown): string;
  /** Resolved prop: `{ "$ref": "a.b" }` values are looked up in the data model. */
  prop(component: A2UIComponent, name: string): unknown;
  /** Render canonical `children` (id references) of a component. */
  renderChildren(component: A2UIComponent): N[];
  /** Render inline `props.items` (id-less nested components). */
  renderInline(component: A2UIComponent, items: unknown): N[];
  /** Ask the host to execute an action on behalf of a component. */
  dispatch(action: ActionDescriptor, component: A2UIComponent): void;
  data: A2UIDataModel;
  strings: RendererStrings;
}

export type ComponentRenderer<N> = (component: A2UIComponent, ctx: RenderContext<N>) => N;

export interface ComponentDefinition<N> {
  type: string;
  render: ComponentRenderer<N>;
  /** Short human description for inspectors and docs. */
  description: string;
  /** Prop names the renderer reads, for inspectors and docs. */
  props: readonly string[];
}

export class ComponentRegistry<N> {
  private readonly definitions = new Map<string, ComponentDefinition<N>>();
  private fallbackRenderer: ComponentRenderer<N>;

  constructor() {
    this.fallbackRenderer = (component, ctx) => {
      const box = ctx.h('div', 'a2ui-unsupported');
      ctx.adapter.setAttribute(box, 'data-type', component.type);
      ctx.adapter.append(box, ctx.h('span', 'a2ui-unsupported-label', ctx.strings.unsupported));
      ctx.adapter.append(box, ctx.h('code', 'a2ui-unsupported-type', component.type));
      return box;
    };
  }

  define(definition: ComponentDefinition<N>): this {
    this.definitions.set(definition.type, definition);
    return this;
  }

  /** Replace the placeholder used for unknown types. */
  setFallback(renderer: ComponentRenderer<N>): this {
    this.fallbackRenderer = renderer;
    return this;
  }

  has(type: string): boolean {
    return this.definitions.has(type);
  }

  get(type: string): ComponentDefinition<N> | undefined {
    return this.definitions.get(type);
  }

  /** Renderer for a type, or the fallback. */
  resolve(type: string): ComponentRenderer<N> {
    return this.definitions.get(type)?.render ?? this.fallbackRenderer;
  }

  types(): string[] {
    return [...this.definitions.keys()];
  }

  list(): ComponentDefinition<N>[] {
    return [...this.definitions.values()];
  }
}

export function createComponentRegistry<N>(): ComponentRegistry<N> {
  return new ComponentRegistry<N>();
}
