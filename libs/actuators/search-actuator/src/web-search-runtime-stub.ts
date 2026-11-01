/**
 * Offline-safe web-search-runtime provider. Selected by `auto` / omitted /
 * `unconfigured` so pipelines never hit the network without an explicit id.
 */

import {
  registerWebSearchRuntimeBridge,
  STUB_WEB_SEARCH_RUNTIME_ID,
  type WebSearchRuntimeBridge,
} from '@agent/core/search/web-search-runtime-bridge';

export const STUB_WEB_SEARCH_BRIDGE_ID = STUB_WEB_SEARCH_RUNTIME_ID;

const stubBridge: WebSearchRuntimeBridge = {
  bridge_id: STUB_WEB_SEARCH_BRIDGE_ID,
  async search(request) {
    return {
      provider: 'unconfigured',
      query: request.query,
      top_k: request.top_k,
      results: [],
      hint: 'configure service binding (set provider to a registered web-search-runtime id, e.g. rustxng)',
    };
  },
};

let registered = false;

export function registerStubWebSearchRuntime(): void {
  if (registered) return;
  registered = true;
  registerWebSearchRuntimeBridge(stubBridge, {
    provenance: 'builtin',
    source: 'web-search-runtime-stub',
  });
}

registerStubWebSearchRuntime();
