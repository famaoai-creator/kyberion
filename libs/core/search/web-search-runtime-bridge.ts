/**
 * Web-search-runtime seam — query-origin search backends.
 *
 * Callers resolve by id; concrete providers (local engines, cloud APIs)
 * register from the search-actuator package so core never imports them.
 * Restricted providers declare capabilities and are opt-in only — `auto`
 * never silently picks a service-backed engine (same rule as lightpanda).
 */

import { coreSeamCatalog, createSeam, type SeamProviderMetadata } from '../seam.js';

export interface WebSearchHit {
  title: string;
  url: string;
  content: string;
  raw_content?: string;
  engine?: string;
  score?: number;
}

export interface WebSearchRequest {
  query: string;
  top_k: number;
}

export interface WebSearchResponse {
  provider: string;
  query: string;
  top_k: number;
  results: WebSearchHit[];
  hint?: string;
  unresponsive_engines?: Array<[string, string]>;
  base_url?: string;
  sidecar_started?: boolean;
}

/**
 * What a provider can do beyond returning ranked URL stubs.
 * Omitted capabilities = offline-safe default (the stub).
 */
export interface WebSearchRuntimeCapabilities {
  /** May return page text (`raw_content`) for grounding. */
  grounding_raw_content: boolean;
  /** Needs a reachable HTTP service (local or remote). */
  requires_service: boolean;
  /** May spawn a local loopback sidecar when the service is down. */
  can_autostart_sidecar: boolean;
  /** Needs an API key or cloud credential. */
  requires_credentials: boolean;
}

export interface WebSearchRuntimeBridge {
  readonly bridge_id: string;
  /** Omitted = offline stub capabilities (safe for `auto`). */
  readonly capabilities?: Readonly<WebSearchRuntimeCapabilities>;
  search(request: WebSearchRequest): Promise<WebSearchResponse>;
}

export const STUB_WEB_SEARCH_RUNTIME_ID = 'stub';

const webSearchRuntimeSeam = createSeam<WebSearchRuntimeBridge>({
  key: 'web-search-runtime',
  multiplicity: 'named',
  catalog: coreSeamCatalog,
  owner: 'libs/core/search/web-search-runtime-bridge.ts',
});

const registeredDisposers = new Map<string, () => void>();

export function registerWebSearchRuntimeBridge(
  bridge: WebSearchRuntimeBridge,
  metadata: SeamProviderMetadata = {
    provenance: 'plugin',
    source: 'web-search-runtime-extension',
  }
): () => void {
  const id = String(bridge.bridge_id || '').trim();
  if (!id) throw new Error('WebSearchRuntimeBridge.bridge_id is required');
  const disposeFromSeam = webSearchRuntimeSeam.register(id, bridge, metadata);
  const dispose = () => {
    disposeFromSeam();
    if (registeredDisposers.get(id) === dispose) registeredDisposers.delete(id);
  };
  registeredDisposers.set(id, dispose);
  return dispose;
}

export function listWebSearchRuntimeBridges(): WebSearchRuntimeBridge[] {
  return webSearchRuntimeSeam.list().map((entry) => entry.implementation);
}

export function resetWebSearchRuntimeBridges(): void {
  for (const dispose of registeredDisposers.values()) {
    try {
      dispose();
    } catch {
      /* noop */
    }
  }
  registeredDisposers.clear();
}

/**
 * Resolve a search backend.
 * - explicit id → that provider (must be registered)
 * - `auto` / empty → the offline-safe provider (no `capabilities`), typically `stub`
 */
export function resolveWebSearchRuntime(preference?: string): WebSearchRuntimeBridge {
  const bridges = listWebSearchRuntimeBridges();
  const wanted =
    String(preference || 'auto')
      .trim()
      .toLowerCase() || 'auto';
  if (wanted !== 'auto' && wanted !== 'unconfigured') {
    const exact = bridges.find((bridge) => bridge.bridge_id === wanted);
    if (!exact) {
      throw new Error(
        `[web-search-runtime] provider '${wanted}' is not registered (have: ${
          bridges.map((bridge) => bridge.bridge_id).join(', ') || 'none'
        })`
      );
    }
    return exact;
  }
  if (bridges.length === 0) {
    throw new Error('[web-search-runtime] no web search runtime providers registered');
  }
  const offline = bridges.find((bridge) => !bridge.capabilities);
  if (!offline) {
    throw new Error(
      '[web-search-runtime] no offline-safe provider is registered; ' +
        'select a service-backed provider explicitly by id'
    );
  }
  return offline;
}

export function getWebSearchRuntimeCapabilities(
  bridge: WebSearchRuntimeBridge
): Readonly<WebSearchRuntimeCapabilities> | null {
  return bridge.capabilities ?? null;
}
