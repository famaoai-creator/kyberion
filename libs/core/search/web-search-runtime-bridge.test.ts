import { afterEach, describe, expect, it } from 'vitest';
import {
  listWebSearchRuntimeBridges,
  registerWebSearchRuntimeBridge,
  resetWebSearchRuntimeBridges,
  resolveWebSearchRuntime,
  type WebSearchRuntimeBridge,
  type WebSearchRuntimeCapabilities,
} from './web-search-runtime-bridge.js';

const RESTRICTED: WebSearchRuntimeCapabilities = {
  grounding_raw_content: true,
  requires_service: true,
  can_autostart_sidecar: true,
  requires_credentials: false,
};

function bridge(
  id: string,
  capabilities?: WebSearchRuntimeBridge['capabilities']
): WebSearchRuntimeBridge {
  return {
    bridge_id: id,
    ...(capabilities ? { capabilities } : {}),
    async search(request) {
      return {
        provider: id,
        query: request.query,
        top_k: request.top_k,
        results: [],
      };
    },
  };
}

describe('web-search-runtime seam', () => {
  afterEach(() => resetWebSearchRuntimeBridges());

  it('auto-selects the offline-safe provider, never a restricted one', () => {
    registerWebSearchRuntimeBridge(bridge('rustxng', RESTRICTED));
    registerWebSearchRuntimeBridge(bridge('stub'));
    expect(resolveWebSearchRuntime().bridge_id).toBe('stub');
    expect(resolveWebSearchRuntime('auto').bridge_id).toBe('stub');
    expect(resolveWebSearchRuntime('unconfigured').bridge_id).toBe('stub');
  });

  it('fails auto when only restricted providers are registered', () => {
    registerWebSearchRuntimeBridge(bridge('rustxng', RESTRICTED));
    expect(() => resolveWebSearchRuntime()).toThrow(/no offline-safe provider/);
  });

  it('resolves an explicit restricted provider by id', () => {
    registerWebSearchRuntimeBridge(bridge('stub'));
    registerWebSearchRuntimeBridge(bridge('rustxng', RESTRICTED));
    expect(resolveWebSearchRuntime('rustxng').bridge_id).toBe('rustxng');
    expect(() => resolveWebSearchRuntime('missing')).toThrow(/not registered/);
  });

  it('lists registered bridges', () => {
    registerWebSearchRuntimeBridge(bridge('stub'));
    registerWebSearchRuntimeBridge(bridge('rustxng', RESTRICTED));
    expect(
      listWebSearchRuntimeBridges()
        .map((b) => b.bridge_id)
        .sort()
    ).toEqual(['rustxng', 'stub']);
  });
});
