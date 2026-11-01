/**
 * RustXNG adapter for the web-search-runtime seam.
 * Opt-in only (`provider=rustxng`); never selected by `auto`.
 */

import {
  registerWebSearchRuntimeBridge,
  type WebSearchRuntimeBridge,
  type WebSearchRuntimeCapabilities,
} from '@agent/core/search/web-search-runtime-bridge';
import { rustxngWebSearch } from './rustxng-client.js';

export const RUSTXNG_WEB_SEARCH_BRIDGE_ID = 'rustxng';

export const RUSTXNG_WEB_SEARCH_CAPABILITIES: Readonly<WebSearchRuntimeCapabilities> =
  Object.freeze({
    grounding_raw_content: true,
    requires_service: true,
    can_autostart_sidecar: true,
    requires_credentials: false,
  });

const rustxngBridge: WebSearchRuntimeBridge = {
  bridge_id: RUSTXNG_WEB_SEARCH_BRIDGE_ID,
  capabilities: RUSTXNG_WEB_SEARCH_CAPABILITIES,
  async search(request) {
    return rustxngWebSearch({ query: request.query, top_k: request.top_k });
  },
};

let registered = false;

export function registerRustxngWebSearchRuntime(): void {
  if (registered) return;
  registered = true;
  registerWebSearchRuntimeBridge(rustxngBridge, {
    provenance: 'builtin',
    source: 'web-search-runtime-rustxng',
  });
}

registerRustxngWebSearchRuntime();
