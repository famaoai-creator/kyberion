/**
 * Surface store — the single place where A2UI messages become state.
 *
 * Pure TypeScript, no DOM: the same store runs in the browser (the viewer)
 * and in tests. Every message is validated, applied, and recorded in a
 * bounded history; invalid messages are recorded as `rejected` events instead
 * of throwing, so one bad message from a producer never breaks the host.
 */
import {
  A2UIProtocolError,
  operationOf,
  parseA2UIMessage,
  type A2UIComponent,
  type A2UIDataModel,
  type A2UIMessage,
} from './protocol.js';

export interface SurfaceState {
  id: string;
  catalogId: string;
  title: string | null;
  titleKey: string | null;
  /** Components by id, insertion order preserved in `order`. */
  components: Record<string, A2UIComponent>;
  order: string[];
  data: A2UIDataModel;
  /** Surface created by an update that arrived before its `createSurface`. */
  implicit: boolean;
  revision: number;
  updatedAt: string;
}

export type StoreEventKind =
  'createSurface' | 'updateComponents' | 'updateDataModel' | 'deleteSurface' | 'rejected';

export interface StoreEvent {
  kind: StoreEventKind;
  surfaceId: string | null;
  at: string;
  source: string | null;
  detail: string;
}

export interface SurfaceTree {
  roots: A2UIComponent[];
  childrenOf(id: string): A2UIComponent[];
}

export interface SurfaceStoreOptions {
  now?: () => string;
  maxHistory?: number;
}

export type StoreListener = (event: StoreEvent) => void;

export const DEFAULT_MAX_HISTORY = 200;

export class SurfaceStore {
  private readonly surfaces = new Map<string, SurfaceState>();
  private readonly events: StoreEvent[] = [];
  private readonly listeners = new Set<StoreListener>();
  private readonly now: () => string;
  private readonly maxHistory: number;

  constructor(options: SurfaceStoreOptions = {}) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.maxHistory = Math.max(1, options.maxHistory ?? DEFAULT_MAX_HISTORY);
  }

  /** Apply one raw message (validated here). Returns the recorded event. */
  apply(raw: unknown, source: string | null = null): StoreEvent {
    let message: A2UIMessage;
    try {
      message = parseA2UIMessage(raw);
    } catch (error) {
      const reason = error instanceof A2UIProtocolError ? error.message : 'invalid message';
      return this.record({
        kind: 'rejected',
        surfaceId: null,
        at: this.now(),
        source,
        detail: reason,
      });
    }
    const operation = operationOf(message);
    const at = this.now();
    if (operation === 'createSurface') {
      const payload = message.createSurface!;
      const existing = this.surfaces.get(payload.surfaceId);
      const next: SurfaceState = existing
        ? { ...existing, catalogId: payload.catalogId, implicit: false }
        : {
            id: payload.surfaceId,
            catalogId: payload.catalogId,
            title: null,
            titleKey: null,
            components: {},
            order: [],
            data: {},
            implicit: false,
            revision: 0,
            updatedAt: at,
          };
      next.title = payload.title ?? next.title;
      next.titleKey = payload.titleKey ?? next.titleKey;
      this.commit(next, at);
      return this.record({
        kind: 'createSurface',
        surfaceId: payload.surfaceId,
        at,
        source,
        detail: payload.title ?? payload.catalogId,
      });
    }
    if (operation === 'deleteSurface') {
      const payload = message.deleteSurface!;
      const existed = this.surfaces.delete(payload.surfaceId);
      return this.record({
        kind: 'deleteSurface',
        surfaceId: payload.surfaceId,
        at,
        source,
        detail: existed ? 'deleted' : 'not present',
      });
    }
    if (operation === 'updateComponents') {
      const payload = message.updateComponents!;
      const surface = this.ensure(payload.surfaceId, at);
      const components = { ...surface.components };
      const order = [...surface.order];
      for (const component of payload.components) {
        if (!components[component.id]) order.push(component.id);
        components[component.id] = component;
      }
      this.commit({ ...surface, components, order }, at);
      return this.record({
        kind: 'updateComponents',
        surfaceId: payload.surfaceId,
        at,
        source,
        detail: `${payload.components.length} component(s)`,
      });
    }
    const payload = message.updateDataModel!;
    const surface = this.ensure(payload.surfaceId, at);
    this.commit({ ...surface, data: { ...surface.data, ...payload.data } }, at);
    return this.record({
      kind: 'updateDataModel',
      surfaceId: payload.surfaceId,
      at,
      source,
      detail: `${Object.keys(payload.data).length} key(s)`,
    });
  }

  /** Apply a batch in order. Non-array input is recorded as one rejection. */
  applyMany(raw: unknown, source: string | null = null): StoreEvent[] {
    if (!Array.isArray(raw)) {
      return [
        this.record({
          kind: 'rejected',
          surfaceId: null,
          at: this.now(),
          source,
          detail: 'messages must be an array',
        }),
      ];
    }
    return raw.map((message) => this.apply(message, source));
  }

  get(surfaceId: string): SurfaceState | undefined {
    return this.surfaces.get(surfaceId);
  }

  /** Surfaces in creation order. */
  list(): SurfaceState[] {
    return [...this.surfaces.values()];
  }

  /** Newest event last. */
  history(): readonly StoreEvent[] {
    return this.events;
  }

  subscribe(listener: StoreListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Resolve the component tree of a surface: roots are components that no
   * other component names in `children`; unknown or cyclic references are
   * dropped rather than rendered twice or forever.
   */
  tree(surfaceId: string): SurfaceTree {
    const surface = this.surfaces.get(surfaceId);
    if (!surface) return { roots: [], childrenOf: () => [] };
    const referenced = new Set<string>();
    for (const id of surface.order) {
      for (const child of surface.components[id]?.children ?? []) referenced.add(child);
    }
    const roots = surface.order
      .filter((id) => !referenced.has(id))
      .map((id) => surface.components[id]);
    const childrenOf = (id: string, seen: Set<string> = new Set()): A2UIComponent[] => {
      const parent = surface.components[id];
      if (!parent?.children || seen.has(id)) return [];
      seen.add(id);
      return parent.children
        .filter((child) => child !== id && !seen.has(child))
        .map((child) => surface.components[child])
        .filter((child): child is A2UIComponent => Boolean(child));
    };
    return { roots, childrenOf: (id) => childrenOf(id) };
  }

  private ensure(surfaceId: string, at: string): SurfaceState {
    const existing = this.surfaces.get(surfaceId);
    if (existing) return existing;
    const created: SurfaceState = {
      id: surfaceId,
      catalogId: 'implicit',
      title: null,
      titleKey: null,
      components: {},
      order: [],
      data: {},
      implicit: true,
      revision: 0,
      updatedAt: at,
    };
    this.surfaces.set(surfaceId, created);
    return created;
  }

  private commit(next: SurfaceState, at: string): void {
    this.surfaces.set(next.id, { ...next, revision: next.revision + 1, updatedAt: at });
  }

  private record(event: StoreEvent): StoreEvent {
    this.events.push(event);
    if (this.events.length > this.maxHistory)
      this.events.splice(0, this.events.length - this.maxHistory);
    for (const listener of this.listeners) listener(event);
    return event;
  }
}

export function createSurfaceStore(options?: SurfaceStoreOptions): SurfaceStore {
  return new SurfaceStore(options);
}
