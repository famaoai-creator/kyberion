import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { coreSeamCatalog } from './seam.js';
import {
  listWebSearchRuntimeBridges,
  registerWebSearchRuntimeBridge,
  resetWebSearchRuntimeBridges,
  resolveWebSearchRuntime,
} from './search/web-search-runtime-bridge.js';
import {
  listBrowserAutomationRuntimeBridges,
  registerBrowserAutomationRuntimeBridge,
  resetBrowserAutomationRuntimeBridges,
  resolveBrowserAutomationRuntime,
} from '@agent/shared-vision/browser-automation-runtime-bridge';
import {
  getStreamingSttBridge,
  listStreamingSttBridges,
  registerStreamingSttBridge,
  resetStreamingSttBridges,
} from './voice/streaming-stt-bridge.js';

interface LifecycleTarget {
  seam: string;
  builtins: string[];
  register(id: string): () => void;
  reset(): void;
  list(): string[];
  get(id: string): unknown;
}

const targets: LifecycleTarget[] = [
  {
    seam: 'web-search-runtime',
    builtins: [],
    register: (bridge_id) =>
      registerWebSearchRuntimeBridge({
        bridge_id,
        search: async (request) => ({ provider: bridge_id, ...request, results: [] }),
      }),
    reset: resetWebSearchRuntimeBridges,
    list: () => listWebSearchRuntimeBridges().map((bridge) => bridge.bridge_id),
    get: resolveWebSearchRuntime,
  },
  {
    seam: 'browser-automation-runtime',
    builtins: [],
    register: (bridge_id) =>
      registerBrowserAutomationRuntimeBridge({
        bridge_id,
        connectOverCDP: async () => ({}),
        launchPersistentContext: async () => ({}),
      }),
    reset: resetBrowserAutomationRuntimeBridges,
    list: () => listBrowserAutomationRuntimeBridges().map((bridge) => bridge.bridge_id),
    get: resolveBrowserAutomationRuntime,
  },
  {
    seam: 'streaming-stt-bridge',
    builtins: ['stub'],
    register: (bridge_id) =>
      registerStreamingSttBridge(bridge_id, () => ({
        bridge_id,
        async *transcribeStream() {},
      })),
    reset: resetStreamingSttBridges,
    list: listStreamingSttBridges,
    get: getStreamingSttBridge,
  },
];

describe.each(targets)('$seam lifecycle contract', (target) => {
  beforeEach(target.reset);
  afterEach(target.reset);

  it('keeps catalog, list and resolution consistent across disposal, reset and re-registration', () => {
    const id = 'lifecycle-extension';
    const assertCatalogMatches = () =>
      expect(
        coreSeamCatalog
          .get(target.seam)!
          .list()
          .map((provider) => provider.id)
          .sort()
      ).toEqual([...target.list()].sort());
    assertCatalogMatches();
    const stale = target.register(id);
    expect(target.get(id)).toBeDefined();
    assertCatalogMatches();
    expect(() => target.register(id)).toThrow(/already registered/);
    stale();
    expect(target.list()).not.toContain(id);
    expect(() => target.get(id)).toThrow();
    assertCatalogMatches();
    target.register(id);
    stale();
    expect(target.get(id)).toBeDefined();
    target.reset();
    expect(target.list()).toEqual(target.builtins);
    assertCatalogMatches();
    for (const builtin of target.builtins) expect(target.get(builtin)).toBeDefined();
    target.register(id);
    stale();
    expect(target.get(id)).toBeDefined();
    assertCatalogMatches();
  });
});
