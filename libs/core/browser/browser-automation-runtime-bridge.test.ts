import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  FULL_BROWSER_AUTOMATION_RUNTIME_CAPABILITIES,
  getBrowserAutomationRuntimeCapabilities,
  registerBrowserAutomationRuntimeBridge,
  resetBrowserAutomationRuntimeBridges,
  resolveBrowserAutomationRuntime,
  type BrowserAutomationRuntimeBridge,
} from './browser-automation-runtime-bridge.js';

function bridge(
  id: string,
  capabilities?: BrowserAutomationRuntimeBridge['capabilities']
): BrowserAutomationRuntimeBridge {
  return {
    bridge_id: id,
    capabilities,
    connectOverCDP: async () => ({}),
    launchPersistentContext: async () => ({}),
  };
}

const RESTRICTED = {
  ...FULL_BROWSER_AUTOMATION_RUNTIME_CAPABILITIES,
  multi_tab: false,
  pixel_screenshots: false,
};

describe('browser-automation-runtime bridge', () => {
  afterEach(() => resetBrowserAutomationRuntimeBridges());

  it('keeps the declared builtin default rather than choosing the alphabetically first extension', () => {
    registerBrowserAutomationRuntimeBridge(bridge('a-extension'));
    registerBrowserAutomationRuntimeBridge(bridge('playwright-chromium'));
    expect(resolveBrowserAutomationRuntime().bridge_id).toBe('playwright-chromium');
  });

  it('rejects multiple full providers without the declared default', () => {
    registerBrowserAutomationRuntimeBridge(bridge('z-provider'));
    registerBrowserAutomationRuntimeBridge(bridge('a-provider'));
    expect(() => resolveBrowserAutomationRuntime()).toThrowError(
      expect.objectContaining({ code: 'SEAM_PROVIDER_AMBIGUOUS' })
    );
    expect(resolveBrowserAutomationRuntime('z-provider').bridge_id).toBe('z-provider');
  });

  it('never auto-selects a capability-restricted provider', () => {
    registerBrowserAutomationRuntimeBridge(bridge('a-restricted', RESTRICTED));
    registerBrowserAutomationRuntimeBridge(bridge('z-full'));
    expect(resolveBrowserAutomationRuntime().bridge_id).toBe('z-full');
    expect(resolveBrowserAutomationRuntime('auto').bridge_id).toBe('z-full');
  });

  it('fails closed when auto has only capability-restricted providers', () => {
    registerBrowserAutomationRuntimeBridge(bridge('a-restricted', RESTRICTED));
    expect(() => resolveBrowserAutomationRuntime()).toThrow(/no full-capability provider/);
  });

  it('selects a restricted provider when requested by id', () => {
    registerBrowserAutomationRuntimeBridge(bridge('a-restricted', RESTRICTED));
    registerBrowserAutomationRuntimeBridge(bridge('z-full'));
    expect(resolveBrowserAutomationRuntime('a-restricted').bridge_id).toBe('a-restricted');
    expect(() => resolveBrowserAutomationRuntime('missing')).toThrow(/not registered/);
  });

  it('treats omitted capabilities as full Chromium-equivalent', () => {
    expect(getBrowserAutomationRuntimeCapabilities(bridge('full'))).toEqual(
      FULL_BROWSER_AUTOMATION_RUNTIME_CAPABILITIES
    );
    expect(getBrowserAutomationRuntimeCapabilities(bridge('r', RESTRICTED)).multi_tab).toBe(false);
  });

  describe('saved seam default', () => {
    afterEach(() => vi.unstubAllEnvs());

    it('picks the saved full-capability default when no provider is given', () => {
      vi.stubEnv('KYBERION_SEAM_DEFAULTS', 'browser-automation-runtime=a-extension');
      registerBrowserAutomationRuntimeBridge(bridge('a-extension'));
      registerBrowserAutomationRuntimeBridge(bridge('playwright-chromium'));
      expect(resolveBrowserAutomationRuntime().bridge_id).toBe('a-extension');
      expect(resolveBrowserAutomationRuntime('playwright-chromium').bridge_id).toBe(
        'playwright-chromium'
      );
    });

    it('ignores a saved restricted or unregistered default and keeps the policy default', () => {
      registerBrowserAutomationRuntimeBridge(bridge('lightpanda', RESTRICTED));
      registerBrowserAutomationRuntimeBridge(bridge('a-extension'));
      registerBrowserAutomationRuntimeBridge(bridge('playwright-chromium'));
      vi.stubEnv('KYBERION_SEAM_DEFAULTS', 'browser-automation-runtime=lightpanda');
      expect(resolveBrowserAutomationRuntime().bridge_id).toBe('playwright-chromium');
      vi.stubEnv('KYBERION_SEAM_DEFAULTS', 'browser-automation-runtime=missing');
      expect(resolveBrowserAutomationRuntime().bridge_id).toBe('playwright-chromium');
    });
  });
});
