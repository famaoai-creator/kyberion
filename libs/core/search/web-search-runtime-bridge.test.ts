import { afterEach, describe, expect, it, vi } from 'vitest';
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

  it('keeps its declared default when another offline provider is installed', () => {
    registerWebSearchRuntimeBridge(bridge('a-extension'));
    registerWebSearchRuntimeBridge(bridge('stub'));
    expect(resolveWebSearchRuntime().bridge_id).toBe('stub');
  });

  it('rejects ambiguous offline providers without a registered default', () => {
    registerWebSearchRuntimeBridge(bridge('z-provider'));
    registerWebSearchRuntimeBridge(bridge('a-provider'));
    expect(() => resolveWebSearchRuntime()).toThrowError(
      expect.objectContaining({ code: 'SEAM_PROVIDER_AMBIGUOUS' })
    );
    expect(resolveWebSearchRuntime('z-provider').bridge_id).toBe('z-provider');
  });

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

  describe('saved seam default', () => {
    afterEach(() => vi.unstubAllEnvs());

    it('honors a saved default (even service-backed) when no provider is given', () => {
      vi.stubEnv('KYBERION_SEAM_DEFAULTS', 'web-search-runtime=rustxng');
      registerWebSearchRuntimeBridge(bridge('stub'));
      registerWebSearchRuntimeBridge(bridge('rustxng', RESTRICTED));
      expect(resolveWebSearchRuntime().bridge_id).toBe('rustxng');
      expect(resolveWebSearchRuntime('auto').bridge_id).toBe('rustxng');
    });

    it('lets an explicit provider win over the saved default', () => {
      vi.stubEnv('KYBERION_SEAM_DEFAULTS', 'web-search-runtime=rustxng');
      registerWebSearchRuntimeBridge(bridge('stub'));
      registerWebSearchRuntimeBridge(bridge('rustxng', RESTRICTED));
      expect(resolveWebSearchRuntime('stub').bridge_id).toBe('stub');
    });

    it('falls back to the offline default when the saved default is not registered', () => {
      vi.stubEnv('KYBERION_SEAM_DEFAULTS', 'web-search-runtime=missing');
      registerWebSearchRuntimeBridge(bridge('a-extension'));
      registerWebSearchRuntimeBridge(bridge('stub'));
      expect(resolveWebSearchRuntime().bridge_id).toBe('stub');
    });
  });
});
